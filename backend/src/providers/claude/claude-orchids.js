
import { v4 as uuidv4 } from 'uuid';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import axios from 'axios';
import { getProviderModels } from '../provider-models.js';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { withDeduplication } from '../../utils/file-lock.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// 常量定义 — 参照 Go demo (Orchids-2api-main)
// ============================================================================

const ORCHIDS_CONSTANTS = {
    // HTTP SSE 端点（非 WebSocket）
    UPSTREAM_URL: 'https://orchids-server.calmstone-6964e08a.westeurope.azurecontainerapps.io/agent/coding-agent',
    API_VERSION: 2,
    // Clerk 认证
    CLERK_TOKEN_URL_TEMPLATE: 'https://clerk.orchids.app/v1/client/sessions/{sessionId}/tokens',
    CLERK_CLIENT_URL: 'https://clerk.orchids.app/v1/client',
    CLERK_JS_VERSION: '5.117.0',
    CLERK_API_VERSION: '2025-11-10',
    // 默认项目 ID（Go demo 硬编码值）
    DEFAULT_PROJECT_ID: '280b7bae-cd29-41e4-a0a6-7f603c43b607',
    DEFAULT_TIMEOUT: 300000,
    USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orchids/0.0.57 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36',
    ORIGIN: 'https://www.orchids.app',
    DEFAULT_MODEL: 'claude-sonnet-4-5',
};

let ORCHIDS_MODELS;
try {
    ORCHIDS_MODELS = getProviderModels('claude-orchids-oauth');
} catch (e) {
    ORCHIDS_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'];
}

// ============================================================================
// 模型映射 — 我们的模型名 → Orchids 上游接受的模型名
// ============================================================================

const ORCHIDS_MODEL_MAP = {
    // Claude 系列
    'claude-sonnet-4-6':          'claude-sonnet-4-6',
    'claude-sonnet-4-5':          'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
    'claude-opus-4-5':            'claude-opus-4.5',
    'claude-opus-4-5-20251101':   'claude-opus-4.5',
    'claude-haiku-4-5':           'claude-haiku-4-5',
    'claude-haiku-4-5-20251001':  'claude-haiku-4-5',
    // Gemini 系列
    'gemini-3':                   'gemini-3',
    'gemini-3-flash':             'gemini-3-flash',
    // OpenAI
    'gpt-5.2':                    'gpt-5.2',
};

function mapModel(requestModel) {
    if (!requestModel) return 'claude-sonnet-4-5';
    // 精确匹配
    if (ORCHIDS_MODEL_MAP[requestModel]) return ORCHIDS_MODEL_MAP[requestModel];
    // 大小写不敏感匹配
    const lower = requestModel.toLowerCase();
    for (const [key, value] of Object.entries(ORCHIDS_MODEL_MAP)) {
        if (key.toLowerCase() === lower) return value;
    }
    // 模糊匹配兜底
    if (lower.includes('opus')) return 'claude-opus-4.5';
    if (lower.includes('sonnet') && lower.includes('4-6')) return 'claude-sonnet-4-6';
    if (lower.includes('haiku')) return 'claude-haiku-4-5';
    if (lower.includes('gemini') && lower.includes('flash')) return 'gemini-3-flash';
    if (lower.includes('gemini')) return 'gemini-3';
    if (lower.includes('gpt')) return 'gpt-5.2';
    return 'claude-sonnet-4-5';
}

// ============================================================================
// Prompt 构建 — 参照 Go demo BuildPromptV2
// ============================================================================

const SYSTEM_PRESET = `你是 AI 编程助手，通过代理服务与用户交互。

## 对话历史结构
- <turn index="N" role="user|assistant"> 包含每轮对话
- <tool_use id="..." name="..."> 表示工具调用
- <tool_result tool_use_id="..."> 表示工具执行结果

## 规则
1. 仅依赖当前工具和历史上下文
2. 用户在本地环境工作
3. 回复简洁专业`;

function formatToolResultContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts = content
            .filter(item => item && typeof item === 'object' && item.text)
            .map(item => item.text);
        if (parts.length > 0) return parts.join('\n');
        return JSON.stringify(content);
    }
    return JSON.stringify(content);
}

function formatUserMessage(content) {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text) parts.push(text);
        } else if (block.type === 'image' && block.source) {
            parts.push(`[Image: ${block.source.media_type}]`);
        } else if (block.type === 'tool_result') {
            const resultStr = formatToolResultContent(block.content);
            const errorAttr = block.is_error ? ' is_error="true"' : '';
            parts.push(`<tool_result tool_use_id="${block.tool_use_id}"${errorAttr}>\n${resultStr}\n</tool_result>`);
        }
    }
    return parts.join('\n');
}

function formatAssistantMessage(content) {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text) parts.push(text);
        } else if (block.type === 'thinking') {
            // 跳过 thinking，不放入历史
            continue;
        } else if (block.type === 'tool_use') {
            const inputJSON = JSON.stringify(block.input || {});
            parts.push(`<tool_use id="${block.id}" name="${block.name}">\n${inputJSON}\n</tool_use>`);
        }
    }
    return parts.join('\n');
}

function buildPromptV2(claudeRequest) {
    const sections = [];

    // 1. 原始系统提示词
    const system = claudeRequest.system;
    const clientSystemParts = [];
    if (typeof system === 'string' && system) {
        clientSystemParts.push(system);
    } else if (Array.isArray(system)) {
        for (const s of system) {
            if (s.type === 'text' && s.text) clientSystemParts.push(s.text);
        }
    }
    if (clientSystemParts.length > 0) {
        sections.push(`<client_system>\n${clientSystemParts.join('\n\n')}\n</client_system>`);
    }

    // 2. 代理系统预设
    sections.push(`<proxy_instructions>\n${SYSTEM_PRESET}\n</proxy_instructions>`);

    // 3. 可用工具列表
    const tools = claudeRequest.tools || [];
    if (tools.length > 0) {
        const toolNames = tools.map(t => t.name).filter(Boolean);
        if (toolNames.length > 0) {
            sections.push(`<available_tools>\n${toolNames.join(', ')}\n</available_tools>`);
        }
    }

    // 4. 对话历史（排除最后一条 user 消息）
    const messages = claudeRequest.messages || [];
    let historyMessages = messages;
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        historyMessages = messages.slice(0, -1);
    }

    const historyParts = [];
    let turnIndex = 1;
    for (const msg of historyMessages) {
        if (msg.role === 'user') {
            const text = formatUserMessage(msg.content);
            if (text) {
                historyParts.push(`<turn index="${turnIndex}" role="user">\n${text}\n</turn>`);
                turnIndex++;
            }
        } else if (msg.role === 'assistant') {
            const text = formatAssistantMessage(msg.content);
            if (text) {
                historyParts.push(`<turn index="${turnIndex}" role="assistant">\n${text}\n</turn>`);
                turnIndex++;
            }
        }
    }
    if (historyParts.length > 0) {
        sections.push(`<conversation_history>\n${historyParts.join('\n\n')}\n</conversation_history>`);
    }

    // 5. 当前用户请求
    let currentRequest = '';
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        currentRequest = formatUserMessage(messages[messages.length - 1].content);
    }
    if (!currentRequest.trim()) currentRequest = '继续';
    sections.push(`<user_request>\n${currentRequest}\n</user_request>`);

    return sections.join('\n\n');
}

// ============================================================================
// 工具输入修复 — 参照 Go demo fixToolInput()
// ============================================================================

function fixToolInput(inputStr) {
    if (!inputStr) return '{}';
    let input;
    try {
        input = JSON.parse(inputStr);
    } catch {
        return inputStr;
    }
    if (typeof input !== 'object' || input === null) return inputStr;

    let fixed = false;
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed === 'true') { input[key] = true; fixed = true; continue; }
        if (trimmed === 'false') { input[key] = false; fixed = true; continue; }
        if (/^-?\d+$/.test(trimmed)) { input[key] = parseInt(trimmed, 10); fixed = true; continue; }
        if (/^-?\d+\.\d+$/.test(trimmed)) { input[key] = parseFloat(trimmed); fixed = true; continue; }
        // 尝试解析嵌套 JSON
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
            (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
            try { input[key] = JSON.parse(trimmed); fixed = true; } catch { /* ignore */ }
        }
    }
    return fixed ? JSON.stringify(input) : inputStr;
}

// ============================================================================
// OrchidsApiService — HTTP SSE 模式（参照 Go demo）
// ============================================================================

export class OrchidsApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.oauthCredentialId = null;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_ORCHIDS ?? false;
        this.uuid = config?.uuid;

        // 认证
        this.clientJwt = null;       // __client cookie JWT
        this.clerkSessionId = null;  // Clerk session ID
        this.userId = null;
        this.email = null;           // 账号邮箱（Go demo 用于上游请求）
        this.clerkToken = null;      // Bearer token for upstream
        this.tokenExpiresAt = null;
        this.lastTokenRefreshTime = 0;
        this.clientUat = null;       // __client_uat

        // axios
        this.axiosInstance = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Orchids] Initializing (HTTP SSE mode)...');

        await this.initializeAuth();

        const axiosConfig = {
            timeout: ORCHIDS_CONSTANTS.DEFAULT_TIMEOUT,
            headers: {
                'User-Agent': ORCHIDS_CONSTANTS.USER_AGENT,
                'Origin': ORCHIDS_CONSTANTS.ORIGIN,
            },
        };
        if (!this.useSystemProxy) axiosConfig.proxy = false;
        configureAxiosProxy(axiosConfig, this.config, 'claude-orchids-oauth');
        this.axiosInstance = axios.create(axiosConfig);

        this.isInitialized = true;
        logger.info('[Orchids] Initialization complete');
    }

    // ------------------------------------------------------------------
    // 认证：先 GET /v1/client 获取 sessionId，再 POST tokens 获取 JWT
    // ------------------------------------------------------------------

    async initializeAuth(forceRefresh = false) {
        const { credentialId, credentials } = await loadCredentialsFromConfig(
            this.config, 'ORCHIDS_CREDS_FILE_PATH', 'Orchids'
        );
        this.oauthCredentialId = credentialId;

        // 提取 clientJwt
        this.clientJwt = credentials.clientJwt || credentials.client_jwt;
        if (!this.clientJwt && credentials.cookies) {
            const match = credentials.cookies.match(/__client=([^;]+)/);
            if (match && match[1]?.split('.').length === 3) {
                this.clientJwt = match[1].trim();
            }
        }
        if (!this.clientJwt) throw new Error('[Orchids Auth] No __client JWT found');

        // 读取已存储的 email（导入时通过 Clerk API 获取的）
        this.email = credentials.email || null;

        // 获取 session 信息
        await this._fetchSessionInfo();

        // 获取 bearer token
        const token = await this._getToken();
        if (!token) throw new Error('[Orchids Auth] Failed to get bearer token');
        this.clerkToken = token;
        this.lastTokenRefreshTime = Date.now();

        logger.info(`[Orchids Auth] Ready: session=${this.clerkSessionId}, user=${this.userId}`);
    }

    async _fetchSessionInfo() {
        const url = `${ORCHIDS_CONSTANTS.CLERK_CLIENT_URL}?__clerk_api_version=${ORCHIDS_CONSTANTS.CLERK_API_VERSION}`;
        const resp = await axios.get(url, {
            headers: {
                'Cookie': `__client=${this.clientJwt}`,
                'Origin': ORCHIDS_CONSTANTS.ORIGIN,
                'User-Agent': ORCHIDS_CONSTANTS.USER_AGENT,
            },
            timeout: 15000,
        });

        const sessions = resp.data?.response?.sessions || [];
        if (sessions.length === 0) throw new Error('[Orchids Auth] No active sessions');

        const session = sessions[0];
        // Go demo 用 last_active_session_id，比 session.id 更准确
        this.clerkSessionId = resp.data?.response?.last_active_session_id || session.id;
        this.userId = session.user?.id;
        // 提取 email（Go demo: session.user.email_addresses[0].email_address）
        const emailAddresses = session.user?.email_addresses || [];
        if (emailAddresses.length > 0 && !this.email) {
            this.email = emailAddresses[0].email_address;
        }
        // clientUat = 当前时间戳（Go demo 用法）
        this.clientUat = Math.floor(Date.now() / 1000).toString();

        logger.info(`[Orchids Auth] Session: ${this.clerkSessionId}, User: ${this.userId}, Email: ${this.email}`);
    }

    /**
     * 获取 Bearer token — 参照 Go demo Client.GetToken()
     * POST /v1/client/sessions/{sessionId}/tokens
     */
    async _getToken() {
        if (!this.clerkSessionId) throw new Error('[Orchids Auth] No sessionId');

        const url = ORCHIDS_CONSTANTS.CLERK_TOKEN_URL_TEMPLATE
            .replace('{sessionId}', this.clerkSessionId)
            + `?__clerk_api_version=${ORCHIDS_CONSTANTS.CLERK_API_VERSION}&_clerk_js_version=${ORCHIDS_CONSTANTS.CLERK_JS_VERSION}`;

        const cookies = `__client=${this.clientJwt}; __client_uat=${this.clientUat || ''}`;

        const resp = await axios.post(url, 'organization_id=', {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies,
                'Origin': ORCHIDS_CONSTANTS.ORIGIN,
                'User-Agent': ORCHIDS_CONSTANTS.USER_AGENT,
            },
            timeout: 15000,
        });

        const jwt = resp.data?.jwt;
        if (!jwt) throw new Error('[Orchids Auth] No JWT in token response');

        // 解析过期时间
        try {
            const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
            if (payload.exp) {
                this.tokenExpiresAt = new Date(payload.exp * 1000);
            }
        } catch { /* ignore */ }

        // 更新凭据记录
        this._updateCredentialsFile().catch(() => {});

        return jwt;
    }

    async _updateCredentialsFile() {
        if (!this.oauthCredentialId) return;
        try {
            const existing = await oauthCredentialsDao.findById(this.oauthCredentialId);
            const merged = {
                ...(existing?.credentials || {}),
                clerkSessionId: this.clerkSessionId,
                userId: this.userId,
                expiresAt: this.tokenExpiresAt?.toISOString(),
            };
            await updateCredentialsById(this.oauthCredentialId, merged);
        } catch (e) {
            logger.warn(`[Orchids Auth] Failed to update credentials: ${e.message}`);
        }
    }

    async ensureValidToken() {
        const now = Date.now();
        if (now - this.lastTokenRefreshTime < 1000) return;
        // 50秒内过期才刷新（Clerk token 通常60秒有效）
        if (this.tokenExpiresAt && (this.tokenExpiresAt.getTime() - now) > 10000) return;

        logger.info('[Orchids Auth] Refreshing token...');
        this.lastTokenRefreshTime = now;
        const dedupeKey = `orchids-token-refresh:${this.oauthCredentialId || 'default'}`;
        await withDeduplication(dedupeKey, async () => {
            this.clerkToken = await this._getToken();
        });
    }

    isExpiryDateNear() {
        if (!this.tokenExpiresAt || !this.clerkToken) return true;
        const threshold = (this.config.CRON_NEAR_SECONDS || 30) * 1000;
        return this.tokenExpiresAt.getTime() <= Date.now() + threshold;
    }

    // ------------------------------------------------------------------
    // 核心：HTTP SSE 流式请求 — 参照 Go demo Client.SendRequest + Handler
    // ------------------------------------------------------------------

    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        const finalModel = ORCHIDS_MODELS.includes(model) ? model : ORCHIDS_CONSTANTS.DEFAULT_MODEL;
        const mappedModel = mapModel(finalModel);
        const requestId = uuidv4();
        const messageId = `msg_${requestId}`;

        // 构建 prompt（Go demo BuildPromptV2 格式）
        const builtPrompt = buildPromptV2(requestBody);
        const inputTokens = Math.ceil(builtPrompt.length / 3);

        logger.info(`[Orchids] Request: model=${finalModel} -> ${mappedModel}, prompt=${builtPrompt.length} chars`);

        // 1. message_start
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: model,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
                content: [],
            },
        };

        // 2. 确保 token 有效
        await this.ensureValidToken();

        // 3. 构建上游请求体（Go demo AgentRequest 格式）
        const payload = {
            prompt: builtPrompt,
            chatHistory: [],
            projectId: ORCHIDS_CONSTANTS.DEFAULT_PROJECT_ID,
            currentPage: {},
            agentMode: mappedModel,
            mode: 'agent',
            gitRepoUrl: '',
            email: this.email || 'user@orchids.app',
            chatSessionId: Math.floor(Math.random() * 90000000) + 10000000,
            userId: this.userId || 'user',
            apiVersion: ORCHIDS_CONSTANTS.API_VERSION,
            model: mappedModel,
        };

        // 4. 发送 HTTP POST，接收 SSE 流
        let response;
        try {
            response = await this.axiosInstance.post(
                ORCHIDS_CONSTANTS.UPSTREAM_URL,
                payload,
                {
                    headers: {
                        'Accept': 'text/event-stream',
                        'Authorization': `Bearer ${this.clerkToken}`,
                        'Content-Type': 'application/json',
                        'X-Orchids-Api-Version': String(ORCHIDS_CONSTANTS.API_VERSION),
                    },
                    responseType: 'stream',
                    timeout: ORCHIDS_CONSTANTS.DEFAULT_TIMEOUT,
                }
            );
        } catch (error) {
            const status = error.response?.status;
            const body = error.response?.data;
            logger.error(`[Orchids] Upstream error: ${status} ${body || error.message}`);
            // 发送错误文本后结束
            yield* this._emitTextAndFinish(0, `[Orchids Error] ${status || ''} ${error.message}`, inputTokens);
            return;
        }

        // 5. 解析 SSE 流，只处理 type:"model" 事件
        const state = {
            blockIndex: -1,
            outputTokens: 0,
            toolBlocks: {},  // toolID -> blockIndex
            hasFinished: false,
        };

        try {
            yield* this._processSSEStream(response.data, state);
        } catch (error) {
            logger.error(`[Orchids] Stream error: ${error.message}`);
        }

        // 6. 确保发送 finish
        if (!state.hasFinished) {
            yield* this._emitFinish('end_turn', state.outputTokens);
            state.hasFinished = true;
        }
    }

    /**
     * 解析 SSE 流并 yield Anthropic 格式事件
     * 参照 Go demo handler.go 的 switch eventKey 逻辑
     */
    async *_processSSEStream(stream, state) {
        let buffer = '';

        for await (const chunk of stream) {
            buffer += chunk.toString();

            // 按双换行分割 SSE 事件
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const eventBlock = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);

                // 提取 data: 行
                for (const line of eventBlock.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const rawData = line.slice(6);

                    let msg;
                    try { msg = JSON.parse(rawData); } catch { continue; }

                    // 只处理 type:"model" 事件（Go demo 核心过滤）
                    if (msg.type !== 'model') continue;

                    const event = msg.event || {};
                    const eventType = event.type || '';

                    yield* this._handleModelEvent(eventType, event, state);
                }
            }
        }
    }

    /**
     * 处理单个 model 事件 — 完全对齐 Go demo handler.go switch
     */
    *_handleModelEvent(eventType, event, state) {
        switch (eventType) {
            // ---- reasoning (thinking) ----
            case 'reasoning-start': {
                state.blockIndex++;
                yield {
                    type: 'content_block_start',
                    index: state.blockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                };
                break;
            }
            case 'reasoning-delta': {
                const delta = event.delta || '';
                if (delta) {
                    state.outputTokens += Math.ceil(delta.length / 3);
                    yield {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'thinking_delta', thinking: delta },
                    };
                }
                break;
            }
            case 'reasoning-end': {
                yield { type: 'content_block_stop', index: state.blockIndex };
                break;
            }

            // ---- text ----
            case 'text-start': {
                state.blockIndex++;
                yield {
                    type: 'content_block_start',
                    index: state.blockIndex,
                    content_block: { type: 'text', text: '' },
                };
                break;
            }
            case 'text-delta': {
                const delta = event.delta || '';
                if (delta) {
                    state.outputTokens += Math.ceil(delta.length / 3);
                    yield {
                        type: 'content_block_delta',
                        index: state.blockIndex,
                        delta: { type: 'text_delta', text: delta },
                    };
                }
                break;
            }
            case 'text-end': {
                yield { type: 'content_block_stop', index: state.blockIndex };
                break;
            }

            // ---- tool calls ----
            case 'tool-input-start': {
                const toolID = event.id || '';
                if (toolID) {
                    state.blockIndex++;
                    state.toolBlocks[toolID] = state.blockIndex;
                }
                break;
            }
            case 'tool-input-delta':
            case 'tool-input-end':
                // 忽略，等待 tool-call 一次性发送
                break;

            case 'tool-call': {
                const toolID = event.toolCallId || '';
                const toolName = event.toolName || '';
                const inputStr = event.input || '';
                if (!toolID) break;

                const idx = state.toolBlocks[toolID];
                if (idx === undefined) break;

                const fixedInput = fixToolInput(inputStr);
                state.outputTokens += Math.ceil((toolName.length + inputStr.length) / 3);

                yield {
                    type: 'content_block_start',
                    index: idx,
                    content_block: { type: 'tool_use', id: toolID, name: toolName, input: {} },
                };
                yield {
                    type: 'content_block_delta',
                    index: idx,
                    delta: { type: 'input_json_delta', partial_json: fixedInput },
                };
                yield { type: 'content_block_stop', index: idx };
                break;
            }

            // ---- finish ----
            case 'finish': {
                let stopReason = 'end_turn';
                const finishReason = event.finishReason || '';
                if (finishReason === 'tool-calls') stopReason = 'tool_use';

                yield* this._emitFinish(stopReason, state.outputTokens);
                state.hasFinished = true;
                break;
            }

            default:
                // stream-start 等其他事件忽略
                break;
        }
    }

    *_emitFinish(stopReason, outputTokens) {
        yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
        };
        yield { type: 'message_stop' };
    }

    *_emitTextAndFinish(startIndex, text, inputTokens) {
        yield {
            type: 'content_block_start',
            index: startIndex,
            content_block: { type: 'text', text: '' },
        };
        yield {
            type: 'content_block_delta',
            index: startIndex,
            delta: { type: 'text_delta', text },
        };
        yield { type: 'content_block_stop', index: startIndex };
        yield* this._emitFinish('end_turn', Math.ceil(text.length / 3));
    }

    // ------------------------------------------------------------------
    // 非流式
    // ------------------------------------------------------------------

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        let content = '';
        const toolCalls = [];

        for await (const event of this.generateContentStream(model, requestBody)) {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                content += event.delta.text || '';
            }
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                toolCalls.push({
                    type: 'tool_use',
                    id: event.content_block.id,
                    name: event.content_block.name,
                    input: event.content_block.input,
                });
            }
        }

        const contentArray = [];
        if (content) contentArray.push({ type: 'text', text: content });
        contentArray.push(...toolCalls);

        return {
            id: uuidv4(),
            type: 'message',
            role: 'assistant',
            model,
            stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 100 },
            content: contentArray,
        };
    }

    async listModels() {
        return { models: ORCHIDS_MODELS.map(id => ({ name: id })) };
    }

    async getUsageLimits() {
        return { remaining: null, total: null };
    }

    countTokens(requestBody) {
        const prompt = buildPromptV2(requestBody);
        return { input_tokens: Math.ceil(prompt.length / 3) };
    }
}
