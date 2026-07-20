import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError } from '../../utils/common.js';

export function normalizeClaudeBaseUrl(baseUrl) {
    let normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/v1$/i.test(normalized)) {
        normalized = normalized.replace(/\/v1$/i, '');
    }
    return normalized;
}

export function pickFirstNonEmpty(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

export function parseJsonSafely(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function getHeaderValueCaseInsensitive(headers, headerName) {
    if (!headers || !headerName) return null;
    const target = String(headerName).toLowerCase();
    if (typeof headers.get === 'function') {
        const value = headers.get(headerName) ?? headers.get(target);
        return value === undefined || value === null ? null : String(value);
    }
    if (typeof headers !== 'object') return null;
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target && value !== undefined && value !== null) {
            return Array.isArray(value) ? String(value[0]) : String(value);
        }
    }
    return null;
}

/**
 * Claude API 共享基类
 * custom 和 official 都继承此类
 */
export class ClaudeBaseService {
    constructor(config) {
        this.config = config;
        this.providerType = String(config.MODEL_PROVIDER || '').trim().toLowerCase();
        this.baseUrl = normalizeClaudeBaseUrl(config.CLAUDE_BASE_URL || '');
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_CLAUDE ?? false;
        this.requestContext = {};
        console.log(`[Claude] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        this.client = this.createClient();
    }

    setRequestContext(context = {}) {
        this.requestContext = context && typeof context === 'object' ? context : {};
    }

    _getRequestHeader(name) {
        const headers = this.requestContext?.headers;
        if (!headers || typeof headers !== 'object') return '';
        const lower = String(name || '').toLowerCase();
        if (!lower) return '';
        for (const [key, value] of Object.entries(headers)) {
            if (String(key).toLowerCase() === lower && value !== undefined && value !== null) {
                return String(value);
            }
        }
        return '';
    }

    createClient() {
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
        const axiosConfig = {
            baseURL: this.baseUrl,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
        };
        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        configureAxiosProxy(axiosConfig, this.config, 'claude-custom');
        return axios.create(axiosConfig);
    }

    getClaudeRequestHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
        };
        headers['x-api-key'] = this.apiKey || '';
        return headers;
    }

    normalizeEndpoint(endpoint) {
        return String(endpoint || '').replace(/^\/+/, '');
    }

    getEndpointCandidates(endpoint) {
        const normalized = this.normalizeEndpoint(endpoint);
        if (normalized === 'messages' || normalized === 'v1/messages') {
            return ['v1/messages'];
        }
        return [normalized];
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        const candidates = this.getEndpointCandidates(endpoint);
        let lastError = null;
        let requestBody = body;

        for (let index = 0; index < candidates.length; index += 1) {
            const candidateEndpoint = candidates[index];
            try {
                const response = await this.client.post(candidateEndpoint, requestBody, {
                    headers: this.getClaudeRequestHeaders()
                });
                return response.data;
            } catch (error) {
                const status = error.response?.status;
                const errorCode = error.code;
                const errorMessage = error.message || '';

                if (status === 404 && index < candidates.length - 1 && !isRetry) {
                    lastError = error;
                    continue;
                }

                const isNetworkError = isRetryableNetworkError(error);

                if (status === 401 || status === 403) {
                    throw error;
                }

                if (status === 429 && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                }

                if (status >= 500 && status < 600 && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                }

                if (isNetworkError && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                }

                console.error(`[Claude API] Error calling API (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
                throw error;
            }
        }

        throw lastError || new Error('[Claude API] All endpoint candidates failed');
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        const candidates = this.getEndpointCandidates(endpoint);
        let lastError = null;
        let requestBody = body;

        for (let index = 0; index < candidates.length; index += 1) {
            const candidateEndpoint = candidates[index];
            try {
                const response = await this.client.post(
                    candidateEndpoint,
                    { ...requestBody, stream: true },
                    {
                        responseType: 'stream',
                        headers: this.getClaudeRequestHeaders()
                    }
                );
                const reader = response.data;
                let buffer = '';

                for await (const chunk of reader) {
                    buffer += chunk.toString('utf-8');
                    let boundary;
                    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                        const eventBlock = buffer.substring(0, boundary);
                        buffer = buffer.substring(boundary + 2);
                        const lines = eventBlock.split('\n');
                        let data = '';
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                data = line.substring(6).trim();
                            }
                        }
                        if (data) {
                            try {
                                const parsedChunk = JSON.parse(data);
                                yield parsedChunk;
                                if (parsedChunk.type === 'message_stop') {
                                    return;
                                }
                            } catch (e) {
                                console.warn("[ClaudeApiService] Failed to parse stream chunk JSON:", e.message);
                            }
                        }
                    }
                }
                return;
            } catch (error) {
                const status = error.response?.status;
                const errorCode = error.code;
                const errorMessage = error.message || '';

                if (status === 404 && index < candidates.length - 1 && !isRetry) {
                    lastError = error;
                    continue;
                }

                const isNetworkError = isRetryableNetworkError(error);

                if (status === 401 || status === 403) {
                    throw error;
                }

                if (status === 429 && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    return;
                }

                if (status >= 500 && status < 600 && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    return;
                }

                if (isNetworkError && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    return;
                }

                console.error(`[Claude API] Error generating content stream (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
                throw error;
            }
        }

        throw lastError || new Error('[Claude API] All stream endpoint candidates failed');
    }

    async generateContent(model, requestBody) {
        return await this.callApi('v1/messages', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        const stream = this.streamApi('v1/messages', requestBody);
        for await (const chunk of stream) {
            yield chunk;
        }
    }

    async listModels() {
        const models = [
            { id: 'claude-4-sonnet', name: 'claude-4-sonnet' },
            { id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514' },
            { id: 'claude-opus-4-20250514', name: 'claude-opus-4-20250514' },
            { id: 'claude-3-7-sonnet-20250219', name: 'claude-3-7-sonnet-20250219' },
            { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022' },
            { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022' },
            { id: 'claude-3-opus-20240229', name: 'claude-3-opus-20240229' },
            { id: 'claude-3-haiku-20240307', name: 'claude-3-haiku-20240307' }
        ];
        return { models: models.map((item) => ({ name: item.name })) };
    }

    async getUsageLimits() {
        return null;
    }
}
