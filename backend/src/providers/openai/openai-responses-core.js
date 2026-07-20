import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const CODEX_REQUEST_HEADER_ALIASES = new Map([
    ['session-id', ['session-id', 'session_id', 'x-session-id', 'x-stainless-session-id']],
    ['thread-id', ['thread-id', 'thread_id', 'x-thread-id']]
]);
const CODEX_REQUEST_HEADER_NAMES = [
    'openai-beta',
    'originator',
    'x-client-request-id',
    'x-codex-beta-features',
    'x-codex-installation-id',
    'x-codex-parent-thread-id',
    'x-codex-turn-metadata',
    'x-codex-turn-state',
    'x-codex-window-id',
    'x-oai-attestation',
    'x-openai-internal-codex-residency',
    'x-openai-internal-codex-responses-lite',
    'x-openai-memgen-request',
    'x-openai-subagent',
    'x-responsesapi-include-timing-metrics'
];

function toNonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.trunc(parsed));
}

function getRetryDelayMs(error, baseDelayMs, retryCount) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (retryAfter !== undefined && retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, 60000);
        }

        const retryAt = Date.parse(String(retryAfter));
        if (Number.isFinite(retryAt)) {
            return Math.min(Math.max(0, retryAt - Date.now()), 60000);
        }
    }
    return Math.min(baseDelayMs * (2 ** retryCount), 60000);
}

function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

function normalizeHeaderValue(value) {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (candidate === undefined || candidate === null) return '';
    const normalized = String(candidate).trim();
    if (!normalized || /[\r\n]/.test(normalized)) return '';
    return normalized;
}

function readHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return '';
    const target = String(name || '').toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target) {
            return normalizeHeaderValue(value);
        }
    }
    return '';
}

function pickCodexRequestHeaders(requestContext) {
    const requestHeaders = requestContext?.headers;
    if (!requestHeaders || typeof requestHeaders !== 'object') return {};

    const picked = {};
    for (const [canonicalName, aliases] of CODEX_REQUEST_HEADER_ALIASES) {
        for (const alias of aliases) {
            const value = readHeader(requestHeaders, alias);
            if (value) {
                picked[canonicalName] = value;
                break;
            }
        }
    }
    for (const name of CODEX_REQUEST_HEADER_NAMES) {
        const value = readHeader(requestHeaders, name);
        if (value) picked[name] = value;
    }
    return picked;
}

function normalizeAxiosHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    if (typeof headers.toJSON === 'function') {
        return headers.toJSON();
    }
    return { ...headers };
}

function attachUpstreamHeaders(payload, headers) {
    if (!payload || typeof payload !== 'object') return payload;
    Object.defineProperty(payload, '__upstreamHeaders', {
        value: normalizeAxiosHeaders(headers),
        enumerable: false,
        configurable: true
    });
    return payload;
}

function normalizeCompactResponse(response) {
    if (
        response
        && typeof response === 'object'
        && !Array.isArray(response.output)
        && Array.isArray(response.response?.output)
    ) {
        const normalized = { output: response.response.output };
        return attachUpstreamHeaders(normalized, response.__upstreamHeaders);
    }
    return response;
}

function parseSseData(data) {
    const text = data.trim();
    if (!text || text === '[DONE]') return null;
    return JSON.parse(text);
}

async function* parseSseStream(stream) {
    let buffer = '';
    let eventData = [];

    const flushEvent = () => {
        if (eventData.length === 0) return null;
        const data = eventData.join('\n');
        eventData = [];
        return data;
    };

    for await (const chunk of stream) {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line === '') {
                const data = flushEvent();
                if (data === null || data.trim() === '[DONE]') continue;
                yield parseSseData(data);
                continue;
            }
            if (line.startsWith('data:')) {
                eventData.push(line.slice(5).replace(/^ /, ''));
            }
        }
    }

    if (buffer.startsWith('data:')) {
        eventData.push(buffer.slice(5).replace(/^ /, ''));
    }
    const trailingData = flushEvent();
    if (trailingData !== null && trailingData.trim() !== '[DONE]') {
        yield parseSseData(trailingData);
    }
}

export class OpenAIResponsesApiService {
    constructor(config) {
        if (!config?.OPENAI_API_KEY) {
            throw new Error('OpenAI API Key is required for OpenAIResponsesApiService.');
        }

        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.openaiOrganization = config.OPENAI_ORGANIZATION || process.env.OPENAI_ORGANIZATION || null;
        this.openaiProject = config.OPENAI_PROJECT || process.env.OPENAI_PROJECT || null;
        this.userAgent = config.OPENAI_RESPONSES_USER_AGENT || 'AccountHub/1.0';
        this.maxRetries = toNonNegativeInteger(config.REQUEST_MAX_RETRIES, DEFAULT_MAX_RETRIES);
        this.baseRetryDelayMs = toNonNegativeInteger(config.REQUEST_BASE_DELAY, DEFAULT_RETRY_DELAY_MS);
        this.requestTimeoutMs = toNonNegativeInteger(config.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
        this.requestContext = {};
        this.useSystemProxy = config.USE_SYSTEM_PROXY_OPENAI ?? false;

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: this.requestTimeoutMs
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: this.requestTimeoutMs
        });
        const axiosConfig = {
            baseURL: this.baseUrl,
            timeout: this.requestTimeoutMs,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        configureAxiosProxy(axiosConfig, config, 'openai-custom');
        this.axiosInstance = axios.create(axiosConfig);
    }

    setRequestContext(context = {}) {
        this.requestContext = context && typeof context === 'object' ? context : {};
    }

    buildHeaders(_cacheId = null, isStream = false, requestContext = null) {
        const context = requestContext && typeof requestContext === 'object'
            ? requestContext
            : this.requestContext;
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: isStream ? 'text/event-stream' : 'application/json',
            'User-Agent': readHeader(context?.headers, 'user-agent') || this.userAgent,
            ...pickCodexRequestHeaders(context)
        };
        if (this.openaiOrganization) {
            headers['OpenAI-Organization'] = this.openaiOrganization;
        }
        if (this.openaiProject) {
            headers['OpenAI-Project'] = this.openaiProject;
        }
        return headers;
    }

    normalizeRequestBody(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return body;
        }
        const normalized = { ...body };
        delete normalized.__remote_compact;
        return normalized;
    }

    getPromptCacheKey(requestBody, options = {}) {
        if (options.isCompact || !requestBody || typeof requestBody !== 'object') {
            return null;
        }
        if (typeof requestBody.prompt_cache_key === 'string' && requestBody.prompt_cache_key.trim()) {
            return requestBody.prompt_cache_key.trim();
        }
        return null;
    }

    prepareRequestBody(body, stream, options = {}) {
        const isCompact = options.isCompact === true;
        const normalized = this.normalizeRequestBody(body);
        const requestBody = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
            ? { ...normalized }
            : normalized;
        if (requestBody && typeof requestBody === 'object' && !isCompact) {
            requestBody.stream = Boolean(stream);
        }
        return {
            requestBody,
            cacheId: this.getPromptCacheKey(requestBody, { isCompact }),
            conversationId: null,
            isCompact
        };
    }

    async _waitBeforeRetry(error, retryCount, operation) {
        const delayMs = getRetryDelayMs(error, this.baseRetryDelayMs, retryCount);
        console.warn(`[OpenAIResponses] ${operation} failed; retrying in ${delayMs}ms (${retryCount + 1}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    async callApi(endpoint, body, _isRetry = false, retryCount = 0, requestContext = null) {
        const isCompact = String(endpoint || '').includes('/responses/compact');
        const { requestBody } = this.prepareRequestBody(body, false, { isCompact });

        try {
            const response = await this.axiosInstance.post(endpoint, requestBody, {
                headers: this.buildHeaders(null, false, requestContext)
            });
            return attachUpstreamHeaders(response.data, response.headers);
        } catch (error) {
            const status = Number(error?.response?.status);
            if (isRetryableStatus(status) && retryCount < this.maxRetries) {
                await this._waitBeforeRetry(error, retryCount, 'request');
                return this.callApi(endpoint, body, true, retryCount + 1, requestContext);
            }
            console.error('[OpenAIResponses] Request failed:', {
                status: Number.isFinite(status) ? status : null,
                code: error?.code || null
            });
            throw error;
        }
    }

    async *streamApi(endpoint, body, _isRetry = false, retryCount = 0, requestContext = null) {
        const { requestBody } = this.prepareRequestBody(body, true, { isCompact: false });
        let emittedEvent = false;

        try {
            const response = await this.axiosInstance.post(endpoint, requestBody, {
                responseType: 'stream',
                headers: this.buildHeaders(null, true, requestContext)
            });
            let firstEvent = true;
            for await (const event of parseSseStream(response.data)) {
                if (event?.type === 'response.failed' || event?.type === 'response.incomplete' || event?.type === 'error') {
                    const message = event?.response?.error?.message
                        || event?.error?.message
                        || `OpenAI Responses stream returned ${event.type}`;
                    const streamError = new Error(message);
                    streamError.code = 'ERR_RESPONSES_STREAM_TERMINAL';
                    streamError.isTerminalResponsesEvent = true;
                    streamError.response = {
                        status: Number(event?.response?.error?.status || event?.error?.status) || 500,
                        data: event,
                        headers: response.headers
                    };
                    throw streamError;
                }
                if (firstEvent) {
                    attachUpstreamHeaders(event, response.headers);
                    firstEvent = false;
                }
                emittedEvent = true;
                yield event;
                if (event?.type === 'response.completed') {
                    return;
                }
            }

            const incompleteError = new Error('OpenAI Responses stream ended before response.completed');
            incompleteError.code = 'ERR_RESPONSES_STREAM_INCOMPLETE';
            incompleteError.status = 502;
            incompleteError.statusCode = 502;
            incompleteError.response = {
                status: 502,
                data: { error: { message: incompleteError.message } },
                headers: response.headers
            };
            throw incompleteError;
        } catch (error) {
            const status = Number(error?.response?.status);
            if (
                !emittedEvent
                && error?.isTerminalResponsesEvent !== true
                && isRetryableStatus(status)
                && retryCount < this.maxRetries
            ) {
                await this._waitBeforeRetry(error, retryCount, 'stream request');
                yield* this.streamApi(endpoint, body, true, retryCount + 1, requestContext);
                return;
            }
            console.error('[OpenAIResponses] Stream request failed:', {
                status: Number.isFinite(status) ? status : null,
                code: error?.code || null,
                emittedEvent
            });
            throw error;
        }
    }

    async generateContent(_model, requestBody, requestContext = null) {
        const isCompact = requestBody?.__remote_compact === true;
        const endpoint = isCompact ? '/responses/compact' : '/responses';
        const response = await this.callApi(endpoint, requestBody, false, 0, requestContext);
        return isCompact ? normalizeCompactResponse(response) : response;
    }

    async *generateContentStream(_model, requestBody, requestContext = null) {
        const isCompact = requestBody?.__remote_compact === true;
        if (isCompact) {
            const response = await this.callApi('/responses/compact', requestBody, false, 0, requestContext);
            yield normalizeCompactResponse(response);
            return;
        }
        yield* this.streamApi('/responses', requestBody, false, 0, requestContext);
    }

    async listModels() {
        try {
            const response = await this.axiosInstance.get('/models', {
                headers: this.buildHeaders(null, false)
            });
            return response.data;
        } catch (error) {
            const status = Number(error?.response?.status);
            console.error('[OpenAIResponses] Model list request failed:', {
                status: Number.isFinite(status) ? status : null,
                code: error?.code || null
            });
            throw error;
        }
    }
}
