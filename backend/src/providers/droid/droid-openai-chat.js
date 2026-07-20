import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { convertData } from '../../convert/convert.js';
import { DroidAuthManager } from './droid-auth-manager.js';
import { DroidProxyManager } from './droid-proxy-manager.js';
import {
    resolveDroidProfile,
    getEndpoint,
    getRedirectedModelId,
    getModelById,
    getModelType,
    getModelProvider,
    listModels
} from './droid-profile.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { DroidOpenAIResponseTransformer } from './transformers/response-openai.js';
import { DroidAnthropicResponseTransformer } from './transformers/response-anthropic.js';

export class DroidOpenAIChatService {
    constructor(config) {
        this.config = config;
        this.profile = resolveDroidProfile(config);
        this.proxyManager = new DroidProxyManager(this.profile);
        this.authManager = new DroidAuthManager(config, this.proxyManager);
        this.requestContext = {};

        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });

        // 添加 Agent 错误处理，防止连接泄漏
        this._setupAgentErrorHandlers();

        this.axiosInstance = axios.create({
            timeout: 120000,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent
        });
    }

    /**
     * 设置 Agent 错误处理器
     * 防止连接泄漏和未处理的错误
     */
    _setupAgentErrorHandlers() {
        const handleAgentError = (agentName) => (err) => {
            console.error(`[Droid] ${agentName} error:`, err.message);
        };

        this.httpAgent.on('error', handleAgentError('HTTP Agent'));
        this.httpsAgent.on('error', handleAgentError('HTTPS Agent'));

        // 监控空闲连接超时
        this.httpAgent.on('free', (socket) => {
            socket.on('error', (err) => {
                console.warn('[Droid] HTTP socket error on free:', err.message);
                socket.destroy();
            });
        });

        this.httpsAgent.on('free', (socket) => {
            socket.on('error', (err) => {
                console.warn('[Droid] HTTPS socket error on free:', err.message);
                socket.destroy();
            });
        });
    }

    /**
     * 销毁 Agent，释放所有连接
     */
    destroy() {
        if (this.httpAgent) {
            this.httpAgent.destroy();
        }
        if (this.httpsAgent) {
            this.httpsAgent.destroy();
        }
        console.log('[Droid] HTTP Agents destroyed');
    }

    setRequestContext(context) {
        this.requestContext = context || {};
    }

    _getClientHeaders() {
        return this.requestContext.headers || this.config.DROID_CLIENT_HEADERS || {};
    }

    _getClientAuthorization() {
        return this.requestContext.authorization || this.config.DROID_CLIENT_AUTHORIZATION || null;
    }

    _getClientXApiKey() {
        return this.requestContext.xApiKey || this.config.DROID_CLIENT_X_API_KEY || null;
    }

    async _getAuthHeader() {
        let clientAuth = this._getClientAuthorization();
        if (!clientAuth && this._getClientXApiKey()) {
            clientAuth = `Bearer ${this._getClientXApiKey()}`;
        }
        return await this.authManager.getAuthHeader(clientAuth);
    }

    _resolveModel(requestBody) {
        const rawModelId = requestBody?.model;
        if (!rawModelId) {
            throw new Error('[Droid] model is required');
        }
        const redirectedModelId = getRedirectedModelId(this.profile, rawModelId);
        const model = getModelById(this.profile, redirectedModelId);
        if (!model) {
            throw new Error(`[Droid] Model not found: ${redirectedModelId}`);
        }
        const modelType = getModelType(this.profile, redirectedModelId) || 'openai';
        return {
            modelId: redirectedModelId,
            modelType,
            provider: getModelProvider(this.profile, redirectedModelId) || modelType
        };
    }

    _buildRequestPayload(modelType, modelId, provider, requestBody, authHeader, isStreaming) {
        const clientHeaders = this._getClientHeaders();
        const requestWithModel = { ...requestBody, model: modelId };

        if (modelType === 'anthropic') {
            return {
                endpoint: getEndpoint(this.profile, 'anthropic'),
                headers: getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider, this.profile),
                body: transformToAnthropic(requestWithModel, this.profile),
                responseType: 'anthropic'
            };
        }

        if (modelType === 'common') {
            return {
                endpoint: getEndpoint(this.profile, 'common'),
                headers: getCommonHeaders(authHeader, clientHeaders, provider, this.profile),
                body: transformToCommon(requestWithModel, this.profile),
                responseType: 'openai'
            };
        }

        return {
            endpoint: getEndpoint(this.profile, 'openai'),
            headers: getOpenAIHeaders(authHeader, clientHeaders, provider, this.profile),
            body: transformToOpenAI(requestWithModel, this.profile),
            responseType: 'openaiResponses'
        };
    }

    async _post(endpoint, body, headers, isStream = false) {
        const proxyAgentInfo = this.proxyManager.getNextProxyAgent(endpoint);
        const requestConfig = {
            headers,
            responseType: isStream ? 'stream' : 'json'
        };

        if (proxyAgentInfo?.httpAgent || proxyAgentInfo?.httpsAgent) {
            requestConfig.httpAgent = proxyAgentInfo.httpAgent;
            requestConfig.httpsAgent = proxyAgentInfo.httpsAgent;
            requestConfig.proxy = false;
        }

        return await this.axiosInstance.post(endpoint, body, requestConfig);
    }

    async generateContent(model, requestBody) {
        const authHeader = await this._getAuthHeader();
        const { modelId, modelType, provider } = this._resolveModel(requestBody);
        const payload = this._buildRequestPayload(modelType, modelId, provider, requestBody, authHeader, false);
        const response = await this._post(payload.endpoint, payload.body, payload.headers, false);

        if (payload.responseType === 'openaiResponses') {
            return convertResponseToChatCompletion(response.data);
        }

        if (payload.responseType === 'anthropic') {
            return convertData(response.data, 'response', 'claude', 'openai', modelId);
        }

        return response.data;
    }

    async *generateContentStream(model, requestBody) {
        const authHeader = await this._getAuthHeader();
        const { modelId, modelType, provider } = this._resolveModel(requestBody);
        const payload = this._buildRequestPayload(modelType, modelId, provider, requestBody, authHeader, true);
        const response = await this._post(payload.endpoint, payload.body, payload.headers, true);

        if (payload.responseType === 'openaiResponses') {
            const transformer = new DroidOpenAIResponseTransformer(modelId);
            yield* transformer.transformStream(response.data);
            return;
        }

        if (payload.responseType === 'anthropic') {
            const transformer = new DroidAnthropicResponseTransformer(modelId);
            yield* transformer.transformStream(response.data);
            return;
        }

        yield* streamOpenAIChatChunks(response.data);
    }

    async listModels() {
        return listModels(this.profile);
    }

    async refreshToken() {
        await this.authManager.initialize();
        if (!this.authManager.factoryApiKey && this.authManager.refreshToken) {
            await this.authManager.refreshApiKey();
        }
    }
}

function convertResponseToChatCompletion(resp) {
    if (!resp || typeof resp !== 'object') {
        throw new Error('Invalid response object');
    }

    const outputMsg = (resp.output || []).find(o => o.type === 'message');
    const textBlocks = outputMsg?.content?.filter(c => c.type === 'output_text') || [];
    const content = textBlocks.map(c => c.text).join('');

    return {
        id: resp.id ? resp.id.replace(/^resp_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: resp.created_at || Math.floor(Date.now() / 1000),
        model: resp.model || 'unknown-model',
        choices: [
            {
                index: 0,
                message: {
                    role: outputMsg?.role || 'assistant',
                    content: content || ''
                },
                finish_reason: resp.status === 'completed' ? 'stop' : 'unknown'
            }
        ],
        usage: {
            prompt_tokens: resp.usage?.input_tokens ?? 0,
            completion_tokens: resp.usage?.output_tokens ?? 0,
            total_tokens: resp.usage?.total_tokens ?? 0
        }
    };
}

async function *streamOpenAIChatChunks(stream) {
    let buffer = '';

    for await (const chunk of stream) {
        buffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);

            if (!line.startsWith('data:')) {
                continue;
            }

            const dataStr = line.substring(5).trim();
            if (dataStr === '[DONE]') {
                return;
            }

            try {
                const parsedChunk = JSON.parse(dataStr);
                yield parsedChunk;
            } catch (_error) {
                // ignore malformed chunks
            }
        }
    }
}
