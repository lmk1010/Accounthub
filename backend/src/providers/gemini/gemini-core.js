import { OAuth2Client } from 'google-auth-library';
import * as http from 'http';
import * as https from 'https';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import * as readline from 'readline';
import open from 'open';
import { API_ACTIONS, formatExpiryTime, isRetryableNetworkError, MODEL_PROVIDER } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { handleGeminiCliOAuth } from '../../auth/oauth-handlers.js';
import { getProxyConfigForProvider, getGoogleAuthProxyConfig } from '../../utils/proxy-utils.js';
import { withDeduplication } from '../../utils/file-lock.js';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

// 配置 HTTP/HTTPS agent 限制连接池大小，优化高并发性能
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 120000,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 120000,
});

// --- Constants ---
const AUTH_REDIRECT_PORT = 8085;
const DEFAULT_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET || '';
const GEMINI_MODELS = getProviderModels('gemini-cli-oauth');
const ANTI_TRUNCATION_MODELS = GEMINI_MODELS.map(model => `anti-${model}`);

function is_anti_truncation_model(model) {
    return ANTI_TRUNCATION_MODELS.some(antiModel => model.includes(antiModel));
}

// 从防截断模型名中提取实际模型名
function extract_model_from_anti_model(model) {
    if (model.startsWith('anti-')) {
        const originalModel = model.substring(5); // 移除 'anti-' 前缀
        if (GEMINI_MODELS.includes(originalModel)) {
            return originalModel;
        }
    }
    return model; // 如果不是anti-前缀或不在原模型列表中，则返回原模型名
}

function toGeminiApiResponse(codeAssistResponse) {
    if (!codeAssistResponse) return null;
    const compliantResponse = { candidates: codeAssistResponse.candidates };
    if (codeAssistResponse.usageMetadata) compliantResponse.usageMetadata = codeAssistResponse.usageMetadata;
    if (codeAssistResponse.promptFeedback) compliantResponse.promptFeedback = codeAssistResponse.promptFeedback;
    if (codeAssistResponse.automaticFunctionCallingHistory) compliantResponse.automaticFunctionCallingHistory = codeAssistResponse.automaticFunctionCallingHistory;
    return compliantResponse;
}

/**
 * Ensures that all content parts in a request body have a 'role' property.
 * If 'systemInstruction' is present and lacks a role, it defaults to 'user'.
 * If any 'contents' entry lacks a role, it defaults to 'user'.
 * @param {Object} requestBody - The request body object.
 * @returns {Object} The modified request body with roles ensured.
 */
function ensureRolesInContents(requestBody) {
    delete requestBody.model;
    delete requestBody.metadata; // 清理上游传递的 metadata 字段

    // 处理 thinking_config 的 oneof 冲突
    if (requestBody.generationConfig?.thinkingConfig) {
        const tc = requestBody.generationConfig.thinkingConfig;
        // oneof 字段只能设置一个，优先保留 thinkingBudget
        if (tc.includeThoughts !== undefined && tc.thinkingBudget !== undefined) {
            delete tc.includeThoughts;
        }
    }

    // delete requestBody.system_instruction;
    // delete requestBody.systemInstruction;
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    if (requestBody.systemInstruction && !requestBody.systemInstruction.role) {
        requestBody.systemInstruction.role = 'user';
    }

    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
        });

        // 如果存在 systemInstruction，将其放在 contents 索引 0 的位置
        // if (requestBody.systemInstruction) {
        //     // 检查 contents[0] 是否与 systemInstruction 内容相同
        //     const firstContent = requestBody.contents[0];
        //     let isSame = false;

        //     if (firstContent && firstContent.parts && requestBody.systemInstruction.parts) {
        //         // 比较 parts 数组的内容
        //         const firstContentText = firstContent.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
        //         const systemInstructionText = requestBody.systemInstruction.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
                
        //         isSame = firstContentText === systemInstructionText;
        //     }

        //     // 如果内容不同，则将 systemInstruction 插入到索引 0 的位置
        //     if (!isSame) {
        //         requestBody.contents.unshift({
        //             role: requestBody.systemInstruction.role || 'user',
        //             parts: requestBody.systemInstruction.parts
        //         });
        //     }
        //     delete requestBody.systemInstruction;
        // }
    }
    return requestBody;
}

async function* apply_anti_truncation_to_stream(service, model, requestBody) {
    let currentRequest = { ...requestBody };
    let allGeneratedText = '';

    while (true) {
        // 发送请求并处理流式响应
        const apiRequest = {
            model: model,
            project: service.projectId,
            request: currentRequest
        };
        const stream = service.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest);

        let lastChunk = null;
        let hasContent = false;

        for await (const chunk of stream) {
            const response = toGeminiApiResponse(chunk.response);
            if (response && response.candidates && response.candidates[0]) {
                yield response;
                lastChunk = response;
                hasContent = true;
            }
        }

        // 检查是否因为达到token限制而截断
        if (lastChunk &&
            lastChunk.candidates &&
            lastChunk.candidates[0] &&
            lastChunk.candidates[0].finishReason === 'MAX_TOKENS') {

            // 提取已生成的文本内容
            if (lastChunk.candidates[0].content && lastChunk.candidates[0].content.parts) {
                const generatedParts = lastChunk.candidates[0].content.parts
                    .filter(part => part.text)
                    .map(part => part.text);

                if (generatedParts.length > 0) {
                    const currentGeneratedText = generatedParts.join('');
                    allGeneratedText += currentGeneratedText;

                    // 构建新的请求，包含之前的对话历史和继续指令
                    const newContents = [...requestBody.contents];

                    // 添加之前生成的内容作为模型响应
                    newContents.push({
                        role: 'model',
                        parts: [{ text: currentGeneratedText }]
                    });

                    // 添加继续生成的指令
                    newContents.push({
                        role: 'user',
                        parts: [{ text: 'Please continue from where you left off.' }]
                    });

                    currentRequest = {
                        ...requestBody,
                        contents: newContents
                    };

                    // 继续下一轮请求
                    continue;
                }
            }
        }

        // 如果没有截断或无法继续，则退出循环
        break;
    }
}

export class GeminiApiService {
    constructor(config) {
        // 检查是否需要使用代理
        const proxyConfig = getGoogleAuthProxyConfig(config, 'gemini-cli-oauth');
        
        // 配置 OAuth2Client 使用自定义的 HTTP agent
        const oauth2Options = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        };
        
        if (proxyConfig) {
            oauth2Options.transporterOptions = proxyConfig;
            console.log('[Gemini] Using proxy for OAuth2Client');
        } else {
            oauth2Options.transporterOptions = {
                agent: httpsAgent,
            };
        }
        
        this.authClient = new OAuth2Client(oauth2Options);
        this.availableModels = [];
        this.isInitialized = false;

        this.config = config;
        this.uuid = config?.uuid; // 获取多节点配置的 uuid
        this.host = config.HOST;
        this.oauthCredsBase64 = config.GEMINI_OAUTH_CREDS_BASE64;
        this.oauthCredsFilePath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
        this.oauthCredentialId = null;
        this.projectId = config.PROJECT_ID;

        this.codeAssistEndpoint = config.GEMINI_BASE_URL || DEFAULT_CODE_ASSIST_ENDPOINT;
        this.apiVersion = DEFAULT_CODE_ASSIST_API_VERSION;
        
        // 保存代理配置供后续使用
        this.proxyConfig = getProxyConfigForProvider(config, 'gemini-cli-oauth');
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[Gemini] Initializing Gemini API Service...');
        await this.initializeAuth();
        if (!this.projectId) {
            this.projectId = await this.discoverProjectAndModels();
        } else {
            console.log(`[Gemini] Using provided Project ID: ${this.projectId}`);
            this.availableModels = GEMINI_MODELS;
            console.log(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        }
        if (this.projectId === 'default') {
            throw new Error("Error: 'default' is not a valid project ID. Please provide a valid Google Cloud Project ID using the --project-id argument.");
        }
        this.isInitialized = true;
        console.log(`[Gemini] Initialization complete. Project ID: ${this.projectId}`);
    }

    async initializeAuth(forceRefresh = false) {
        if (this.authClient.credentials.access_token && !forceRefresh) return;

        if (this.oauthCredsBase64) {
            try {
                const decoded = Buffer.from(this.oauthCredsBase64, 'base64').toString('utf8');
                const credentials = JSON.parse(decoded);
                this.authClient.setCredentials(credentials);
                console.log('[Gemini Auth] Authentication configured successfully from base64 string.');
                return;
            } catch (error) {
                console.error('[Gemini Auth] Failed to parse base64 OAuth credentials:', error);
                throw new Error(`Failed to load OAuth credentials from base64 string.`);
            }
        }

        try {
            const { credentialId, credentials } = await loadCredentialsFromConfig(
                this.config,
                'GEMINI_OAUTH_CREDS_FILE_PATH',
                'Gemini'
            );
            this.oauthCredentialId = credentialId;
            this.authClient.setCredentials(credentials);
            console.log('[Gemini Auth] Authentication configured successfully from database.');
            
            if (forceRefresh) {
                console.log('[Gemini Auth] Forcing token refresh...');
                
                // 使用去重锁：多个并发刷新请求只执行一次，共享结果
                const dedupeKey = `gemini-token-refresh:${this.oauthCredentialId || 'unknown'}`;
                await withDeduplication(dedupeKey, async () => {
                    const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                    this.authClient.setCredentials(newCredentials);
                    if (this.oauthCredentialId) {
                        await this._saveCredentials(this.oauthCredentialId, newCredentials);
                    }
                    console.log('[Gemini Auth] Token refreshed and saved successfully.');
                });
                
                // 如果是等待其他请求完成的刷新，需要重新加载凭证
                if (this.isExpiryDateNear() && this.oauthCredentialId) {
                    const refreshedRecord = await oauthCredentialsDao.findById(this.oauthCredentialId);
                    if (refreshedRecord?.credentials) {
                        this.authClient.setCredentials(refreshedRecord.credentials);
                        console.log('[Gemini Auth] Credentials reloaded after concurrent refresh');
                    }
                }
            }
        } catch (error) {
            console.error('[Gemini Auth] Error initializing authentication:', error.message);
            if (!forceRefresh) {
                console.log('[Gemini Auth] Credentials not found. Starting new authentication flow...');
                const newTokens = await this.getNewToken();
                this.authClient.setCredentials(newTokens);
                console.log('[Gemini Auth] New token obtained and loaded into memory.');
            } else {
                console.error('[Gemini Auth] Failed to initialize authentication from database:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken() {
        // 使用统一的 OAuth 处理方法
        const { authUrl, authInfo } = await handleGeminiCliOAuth(this.config);
        
        console.log('\n[Gemini Auth] 正在自动打开浏览器进行授权...');
        console.log('[Gemini Auth] 授权链接:', authUrl, '\n');

        // 自动打开浏览器
        const showFallbackMessage = () => {
            console.log('[Gemini Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开');
        };

        if (this.config) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        const startTime = new Date();
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const record = await oauthCredentialsDao.findLatestByProviderType('gemini-cli-oauth', startTime);
                    if (record && record.credentials?.access_token) {
                        clearInterval(checkInterval);
                        this.oauthCredentialId = record.id;
                        console.log('[Gemini Auth] New token obtained successfully.');
                        resolve(record.credentials);
                    }
                } catch (_error) {
                    // 继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Gemini Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    async discoverProjectAndModels() {
        if (this.projectId) {
            console.log(`[Gemini] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        console.log('[Gemini] Discovering Project ID...');
        this.availableModels = GEMINI_MODELS;
        console.log(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        try {
            const initialProjectId = ""
            // Prepare client metadata
            const clientMetadata = {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                duetProject: initialProjectId,
            }

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            }

            const loadResponse = await this.callApi('loadCodeAssist', loadRequest);

            // Check if we already have a project ID from the response
            if (loadResponse.cloudaicompanionProject) {
                return loadResponse.cloudaicompanionProject;
            }

            // If no existing project, we need to onboard
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || 'free-tier';

            const onboardRequest = {
                tierId: tierId,
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            let lroResponse = await this.callApi('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30; // Maximum number of retries (60 seconds total)
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                lroResponse = await this.callApi('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            return discoveredProjectId;
        } catch (error) {
            console.error('[Gemini] Failed to discover Project ID:', error.response?.data || error.message);
            throw new Error('Could not discover a valid Google Cloud Project ID.');
        }
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();
        const formattedModels = this.availableModels.map(modelId => {
            const displayName = modelId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            return {
                name: `models/${modelId}`, version: "1.0.0", displayName: displayName,
                description: `A generative model for text and chat generation. ID: ${modelId}`,
                inputTokenLimit: 1024000, outputTokenLimit: 65535,
                supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
            };
        });
        return { models: formattedModels };
    }

    async callApi(method, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                responseType: "json",
                body: JSON.stringify(body),
            };
            const res = await this.authClient.request(requestOptions);
            return res.data;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            console.error(`[Gemini API] Error calling ${method}:`, status, error.message);

            // Handle 403 (Forbidden) - 权限错误，立即标记为坏号
            if (status === 403) {
                console.log('[Gemini API] Received 403 (Forbidden). Marking credential as unhealthy...');
                this._markCredentialUnhealthy(`403 Forbidden: ${errorMessage}`, error);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 401 (Unauthorized) - refresh auth and retry once
            if ((status === 400 || status === 401) && !isRetry) {
                // 检查是否为 invalid_grant 错误（OAuth刷新令牌已过期）
                if (errorMessage.includes('invalid_grant')) {
                    console.log('[Gemini API] Received invalid_grant. Marking credential as unhealthy...');
                    this._markCredentialUnhealthy(`invalid_grant: ${errorMessage}`, error);
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                }
                console.log('[Gemini API] Received 401/400. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                return this.callApi(method, body, true, retryCount);
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429) {
                // 检查是否为 QUOTA_EXHAUSTED（配额耗尽）
                if (errorMessage.includes('QUOTA_EXHAUSTED')) {
                    console.log('[Gemini API] Received 429 QUOTA_EXHAUSTED. Marking credential as unhealthy...');
                    // 配额耗尽，设置恢复时间为下月1日
                    const recoveryTime = this._getNextMonthFirstDay();
                    this._markCredentialUnhealthyWithRecovery(`429 QUOTA_EXHAUSTED: ${errorMessage}`, error, recoveryTime);
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                }
                // 普通限流，重试
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[Gemini API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Gemini API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                console.log(`[Gemini API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            throw error;
        }
    }

    async * streamApi(method, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                params: { alt: "sse" },
                headers: { "Content-Type": "application/json" },
                responseType: "stream",
                body: JSON.stringify(body),
            };
            const res = await this.authClient.request(requestOptions);
            if (res.status !== 200) {
                let errorBody = '';
                for await (const chunk of res.data) errorBody += chunk.toString();
                throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
            }
            yield* this.parseSSEStream(res.data);
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            console.error(`[Gemini API] Error during stream ${method}:`, status, error.message);

            // Handle 403 (Forbidden) - 权限错误，立即标记为坏号
            if (status === 403) {
                console.log('[Gemini API] Received 403 during stream. Marking credential as unhealthy...');
                this._markCredentialUnhealthy(`403 Forbidden: ${errorMessage}`, error);
                error.shouldSwitchCredential = true;
                throw error;
            }

            // Handle 401 (Unauthorized) - refresh auth and retry once
            if ((status === 400 || status === 401) && !isRetry) {
                // 检查是否为 invalid_grant 错误
                if (errorMessage.includes('invalid_grant')) {
                    console.log('[Gemini API] Received invalid_grant during stream. Marking credential as unhealthy...');
                    this._markCredentialUnhealthy(`invalid_grant: ${errorMessage}`, error);
                    error.shouldSwitchCredential = true;
                    throw error;
                }
                console.log('[Gemini API] Received 401/400 during stream. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                yield* this.streamApi(method, body, true, retryCount);
                return;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429) {
                // 检查是否为 QUOTA_EXHAUSTED
                if (errorMessage.includes('QUOTA_EXHAUSTED')) {
                    console.log('[Gemini API] Received 429 QUOTA_EXHAUSTED during stream. Marking credential as unhealthy...');
                    const recoveryTime = this._getNextMonthFirstDay();
                    this._markCredentialUnhealthyWithRecovery(`429 QUOTA_EXHAUSTED: ${errorMessage}`, error, recoveryTime);
                    error.shouldSwitchCredential = true;
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[Gemini API] Received 429 during stream. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(method, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Gemini API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                console.log(`[Gemini API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1);
                return;
            }

            throw error;
        }
    }

    async * parseSSEStream(stream) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let buffer = [];
        for await (const line of rl) {
            if (line.startsWith("data: ")) buffer.push(line.slice(6));
            else if (line === "" && buffer.length > 0) {
                try { yield JSON.parse(buffer.join('\n')); } catch (e) { console.error("[Stream] Failed to parse JSON chunk:", buffer.join('\n')); }
                buffer = [];
            }
        }
        if (buffer.length > 0) {
            try { yield JSON.parse(buffer.join('\n')); } catch (e) { console.error("[Stream] Failed to parse final JSON chunk:", buffer.join('\n')); }
        }
    }

    async generateContent(model, requestBody) {
        console.log(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
        let selectedModel = model;
        if (!GEMINI_MODELS.includes(model)) {
            console.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
            selectedModel = GEMINI_MODELS[0];
        }
        const processedRequestBody = ensureRolesInContents(requestBody);
        const apiRequest = { model: selectedModel, project: this.projectId, request: processedRequestBody };
        const response = await this.callApi(API_ACTIONS.GENERATE_CONTENT, apiRequest);
        return toGeminiApiResponse(response.response);
    }

    async * generateContentStream(model, requestBody) {
        console.log(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        // 检查是否为防截断模型
        if (is_anti_truncation_model(model)) {
            // 从防截断模型名中提取实际模型名
            const actualModel = extract_model_from_anti_model(model);
            // 使用防截断流处理
            const processedRequestBody = ensureRolesInContents(requestBody);
            yield* apply_anti_truncation_to_stream(this, actualModel, processedRequestBody);
        } else {
            // 正常流处理
            let selectedModel = model;
            if (!GEMINI_MODELS.includes(model)) {
                console.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
                selectedModel = GEMINI_MODELS[0];
            }
            const processedRequestBody = ensureRolesInContents(requestBody);
            const apiRequest = { model: selectedModel, project: this.projectId, request: processedRequestBody };
            const stream = this.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest);
            for await (const chunk of stream) {
                yield toGeminiApiResponse(chunk.response);
            }
        }
    }

     /**
     * Checks if the given expiry date is within the next 10 minutes from now.
     * @returns {boolean} True if the expiry date is within the next 10 minutes, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const currentTime = Date.now();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            console.log(`[Gemini] Expiry date: ${this.authClient.credentials.expiry_date}, Current time: ${currentTime}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${currentTime + cronNearMinutesInMillis}`);
            return this.authClient.credentials.expiry_date <= (currentTime + cronNearMinutesInMillis);
        } catch (error) {
            console.error(`[Gemini] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 保存凭证到数据库
     * @param {number} credentialId - 凭据记录ID
     * @param {Object} credentials - 凭证数据
     */
    async _saveCredentials(credentialId, credentials) {
        try {
            await updateCredentialsById(credentialId, credentials);
            console.log(`[Gemini Auth] Credentials saved to database (${credentialId})`);
        } catch (error) {
            console.error(`[Gemini Auth] Failed to save credentials: ${error.message}`);
        }
    }

    /**
     * 获取模型配额信息
     * @returns {Promise<Object>} 模型配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Gemini] Token is near expiry, refreshing before getUsageLimits request...');
            await this.initializeAuth(true);
        }

        try {
            const modelsWithQuotas = await this.getModelsWithQuotas();
            return modelsWithQuotas;
        } catch (error) {
            console.error('[Gemini] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 获取带配额信息的模型列表
     * @returns {Promise<Object>} 模型配额信息
     */
    async getModelsWithQuotas() {
        try {
            // 解析模型配额信息
            const result = {
                lastUpdated: Date.now(),
                models: {}
            };

            // 调用 retrieveUserQuota 接口获取用户配额信息
            try {
                const quotaURL = `${this.codeAssistEndpoint}/${this.apiVersion}:retrieveUserQuota`;
                const requestBody = {
                    project: `projects/${this.projectId}`
                };
                const requestOptions = {
                    url: quotaURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    responseType: 'json',
                    body: JSON.stringify(requestBody)
                };

                const res = await this.authClient.request(requestOptions);
                // console.log(`[Gemini] retrieveUserQuota success`, JSON.stringify(res.data));
                if (res.data && res.data.buckets) {
                    const buckets = res.data.buckets;
                    
                    // 遍历 buckets 数组，提取配额信息
                    for (const bucket of buckets) {
                        const modelId = bucket.modelId;
                        
                        // 检查模型是否在支持的模型列表中
                        if (!GEMINI_MODELS.includes(modelId)) continue;
                        
                        const modelInfo = {
                            remaining: bucket.remainingFraction || 0,
                            resetTime: bucket.resetTime || null,
                            resetTimeRaw: bucket.resetTime
                        };
                        
                        result.models[modelId] = modelInfo;
                    }

                    // 对模型按名称排序
                    const sortedModels = {};
                    Object.keys(result.models).sort().forEach(key => {
                        sortedModels[key] = result.models[key];
                    });
                    result.models = sortedModels;
                    // console.log(`[Gemini] Sorted Models:`, sortedModels);
                    console.log(`[Gemini] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
                }
            } catch (fetchError) {
                console.error(`[Gemini] Failed to fetch user quota:`, fetchError.message);
                
                // 如果 retrieveUserQuota 失败，回退到使用固定模型列表
                for (const modelId of GEMINI_MODELS) {
                    result.models[modelId] = {
                        remaining: 0,
                        resetTime: null,
                        resetTimeRaw: null
                    };
                }
            }

            return result;
        } catch (error) {
            console.error('[Gemini] Failed to get models with quotas:', error.message);
            throw error;
        }
    }

    /**
     * 标记凭证为不健康（用于403等严重错误）
     * @param {string} reason - 标记原因
     * @param {Error} [error] - 可选的错误对象
     * @private
     */
    _markCredentialUnhealthy(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            console.log(`[Gemini] Marking credential ${this.uuid} as unhealthy. Reason: ${reason}`);
            poolManager.markProviderUnhealthyImmediately(MODEL_PROVIDER.GEMINI_CLI, {
                uuid: this.uuid
            }, reason);
            if (error) {
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
            }
            return true;
        }
        return false;
    }

    /**
     * 标记凭证为不健康并设置恢复时间（用于429配额耗尽等）
     * @param {string} reason - 标记原因
     * @param {Error} [error] - 可选的错误对象
     * @param {Date} [recoveryTime] - 恢复时间
     * @private
     */
    _markCredentialUnhealthyWithRecovery(reason, error = null, recoveryTime = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            console.log(`[Gemini] Marking credential ${this.uuid} as unhealthy with recovery. Reason: ${reason}`);
            poolManager.markProviderUnhealthyWithRecoveryTime(MODEL_PROVIDER.GEMINI_CLI, {
                uuid: this.uuid
            }, recoveryTime, reason);
            if (error) {
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
            }
            return true;
        }
        return false;
    }

    /**
     * 计算下月1日 00:00:00 UTC 时间
     * @returns {Date} 下月1日的 Date 对象
     * @private
     */
    _getNextMonthFirstDay() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    }
}
