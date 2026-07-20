import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { DroidAuthManager } from './droid-auth-manager.js';
import { DroidProxyManager } from './droid-proxy-manager.js';
import {
    resolveDroidProfile,
    getEndpoint,
    getRedirectedModelId,
    getModelById,
    getModelProvider,
    getModelReasoning,
    getSystemPrompt,
    listModels
} from './droid-profile.js';
import { getAnthropicHeaders } from './transformers/request-anthropic.js';

export class DroidClaudeService {
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

        this.axiosInstance = axios.create({
            timeout: 120000,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent
        });
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
        if (model.type !== 'anthropic') {
            throw new Error(`[Droid] /v1/messages only supports anthropic models, got ${model.type}`);
        }
        return {
            modelId: redirectedModelId,
            provider: getModelProvider(this.profile, redirectedModelId) || 'anthropic'
        };
    }

    _applySystemPrompt(requestBody) {
        const systemPrompt = getSystemPrompt(this.profile);
        if (!systemPrompt) {
            return requestBody;
        }
        const updated = { ...requestBody };
        if (updated.system && Array.isArray(updated.system)) {
            updated.system = [
                { type: 'text', text: systemPrompt },
                ...updated.system
            ];
        } else {
            updated.system = [{ type: 'text', text: systemPrompt }];
        }
        return updated;
    }

    _applyThinking(requestBody, modelId) {
        const updated = { ...requestBody };
        const reasoningLevel = getModelReasoning(this.profile, modelId);
        if (reasoningLevel === 'auto') {
            // preserve
        } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
            const budgetTokens = {
                low: 4096,
                medium: 12288,
                high: 24576,
                xhigh: 40960
            };
            updated.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens[reasoningLevel]
            };
        } else {
            delete updated.thinking;
        }
        return updated;
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
        const { modelId, provider } = this._resolveModel(requestBody);
        const endpoint = getEndpoint(this.profile, 'anthropic');
        const clientHeaders = this._getClientHeaders();
        const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId, provider, this.profile);
        let payload = { ...requestBody, model: modelId };
        payload = this._applySystemPrompt(payload);
        payload = this._applyThinking(payload, modelId);

        const response = await this._post(endpoint, payload, headers, false);
        return response.data;
    }

    async *generateContentStream(model, requestBody) {
        const authHeader = await this._getAuthHeader();
        const { modelId, provider } = this._resolveModel(requestBody);
        const endpoint = getEndpoint(this.profile, 'anthropic');
        const clientHeaders = this._getClientHeaders();
        const headers = getAnthropicHeaders(authHeader, clientHeaders, true, modelId, provider, this.profile);
        let payload = { ...requestBody, model: modelId };
        payload = this._applySystemPrompt(payload);
        payload = this._applyThinking(payload, modelId);

        const response = await this._post(endpoint, payload, headers, true);
        yield* streamAnthropicChunks(response.data);
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

async function *streamAnthropicChunks(stream) {
    let buffer = '';
    let currentEvent = null;

    for await (const chunk of stream) {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
                continue;
            }
            if (!line.startsWith('data:')) {
                continue;
            }
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') {
                return;
            }
            let data;
            try {
                data = JSON.parse(dataStr);
            } catch (_error) {
                data = null;
            }
            if (!data) {
                continue;
            }
            if (!data.type && currentEvent) {
                data.type = currentEvent;
            }
            yield data;
        }
    }
}
