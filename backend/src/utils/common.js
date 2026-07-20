import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing
import { convertData, getOpenAIStreamChunkStop } from '../convert/convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';
import { incrementUsage } from '../plugins/api-potluck/key-manager.js';
import { requestTracer, TRACE_PHASE } from '../monitoring/request-tracer.js';
import { concurrencyLimiter } from '../services/concurrency-limiter.js';
import { getXaiChannelDefaults } from '../services/xai-channel-config-cache.js';
import { sanitize } from './safe-logger.js';
import { extractTokenUsage } from './token-usage.js';
import {
    XAI_DEFAULT_VIDEO_MODEL,
    buildOpenAIVideoCreateResponse,
    buildOpenAIVideoRetrieveResponse,
    buildXaiVideoCreateRequest,
    buildXaiVideoRemixRequest,
    extractXaiVideoId,
    extractXaiVideoUrl,
    normalizeXaiVideoNativeRequest
} from '../providers/openai/xai-media.js';

// ==================== 用户可见错误消息清洗 ====================

/**
 * 我们系统自身产生的中文错误关键词，命中则直接透传
 */
const _OUR_ERROR_KEYWORDS = [
    '无可用账号', '并发请求超限', '并发数量超出限制', '会话数超限', '排队超时',
    '渠道', '池子', '账号状态机', '粘性会话', '策略选择失败',
    '模型不支持', '并发已满', '配额', '冷却中', '算力紧张',
];

/**
 * 需要从用户可见消息中过滤掉的系统内部信息模式
 */
const _SENSITIVE_PATTERNS = [
    /https?:\/\/[^\s"')]+/gi,                    // 内部 URL / 上游端点
    /\/[a-z_\-\/]+\.(js|ts|json|py|rs)[\s:]/gi,  // 文件路径
    /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,          // Bearer token
    /sk-[A-Za-z0-9]{20,}/g,                       // API key
    /ya29\.[A-Za-z0-9\-._]+/g,                    // Google OAuth token
    /projects\/[a-z0-9\-]+/gi,                    // GCP project path
    /eyJ[A-Za-z0-9\-_]{20,}/g,                    // JWT token
];

/**
 * 按 HTTP 状态码给出简洁的中文默认提示
 */
function _defaultMessageByStatus(statusCode) {
    if (statusCode === 401) return '认证失败，请检查凭证';
    if (statusCode === 403) return '权限不足，访问被拒绝';
    if (statusCode === 429) return '请求过于频繁，请稍后重试';
    if (statusCode === 402) return '配额已用尽';
    if (statusCode === 404) return '请求的资源不存在';
    if (statusCode >= 500) return '上游服务暂时不可用，请稍后重试';
    if (statusCode >= 400) return '请求参数有误';
    return '请求处理失败，请稍后重试';
}

/**
 * 清洗错误消息：保留我们自己的中文提示，过滤上游原始错误中的敏感/无关信息
 * @param {string} message - 原始错误消息
 * @param {number} [statusCode=500] - HTTP 状态码
 * @returns {string} 清洗后的用户可见消息
 */
function sanitizeErrorMessage(message, statusCode = 500) {
    if (!message || typeof message !== 'string' || !message.trim()) {
        return _defaultMessageByStatus(statusCode);
    }

    // 我们系统自身的中文错误 → 直接透传
    if (_OUR_ERROR_KEYWORDS.some(kw => message.includes(kw))) {
        return message;
    }

    // 过滤敏感信息
    let cleaned = message;
    for (const pattern of _SENSITIVE_PATTERNS) {
        cleaned = cleaned.replace(pattern, '[已隐藏]');
    }

    // 如果清洗后内容过短或全是占位符，用默认提示
    const meaningful = cleaned.replace(/\[已隐藏\]/g, '').trim();
    if (meaningful.length < 5) {
        return _defaultMessageByStatus(statusCode);
    }

    // 截断过长的消息（上游可能返回巨大 HTML/JSON）
    if (cleaned.length > 300) {
        cleaned = cleaned.slice(0, 300) + '...';
    }

    return cleaned;
}

// ==================== 网络错误处理 ====================

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',      // 连接被重置
    'ETIMEDOUT',       // 连接超时
    'ECONNREFUSED',    // 连接被拒绝
    'ENOTFOUND',       // DNS 解析失败
    'ENETUNREACH',     // 网络不可达
    'EHOSTUNREACH',    // 主机不可达
    'EPIPE',           // 管道破裂
    'EAI_AGAIN',       // DNS 临时失败
    'ECONNABORTED',    // 连接中止
    'ESOCKETTIMEDOUT', // Socket 超时
    'HostUnreachable', // SOCKS5 代理返回的主机不可达
    'Socks5 proxy rejected connection', // SOCKS5 代理拒绝连接
];

/**
 * 检查是否为可重试的网络错误
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;

    const errorCode = String(error.code || '').toUpperCase();
    const errorMessage = String(error.message || '').toUpperCase();

    return RETRYABLE_NETWORK_ERRORS.some(errId =>
        errorCode === String(errId).toUpperCase() || errorMessage.includes(String(errId).toUpperCase())
    );
}

function getTransientNetworkRetryConfig(config = {}) {
    const retries = Number(
        config?.NETWORK_TOLERANCE_RETRIES
        ?? config?.TRANSIENT_NETWORK_RETRIES
        ?? config?.networkToleranceRetries
        ?? 2
    );
    const baseDelayMs = Number(
        config?.NETWORK_TOLERANCE_DELAY_MS
        ?? config?.TRANSIENT_NETWORK_RETRY_DELAY_MS
        ?? config?.networkToleranceDelayMs
        ?? 2000
    );

    return {
        maxRetries: Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 2,
        baseDelayMs: Number.isFinite(baseDelayMs) ? Math.max(500, Math.trunc(baseDelayMs)) : 2000
    };
}

// ==================== API 常量 ====================

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const MODEL_PROTOCOL_PREFIX = {
    // Model provider constants
    GEMINI: 'gemini',
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openaiResponses',
    CLAUDE: 'claude',
    OLLAMA: 'ollama',
    WARP: 'warp',
}

export const MODEL_PROVIDER = {
    // Model provider constants
    GEMINI_CLI: 'gemini-cli-oauth',
    ANTIGRAVITY: 'gemini-antigravity',
    CLAUDE_ANTIGRAVITY: 'claude-antigravity',
    OPENAI_CUSTOM: 'openai-custom',
    OPENAI_CUSTOM_RESPONSES: 'openaiResponses-custom',
    OPENAI_DROID: 'openai-droid',
    OPENAI_RESPONSES_DROID: 'openaiResponses-droid',
    CLAUDE_CUSTOM: 'claude-custom',
    CLAUDE_OFFICAL: 'claude-offical',
    CLAUDE_DROID: 'claude-droid',
    KIRO_API: 'claude-kiro-oauth',
    AMI_API: 'claude-ami-oauth',
    ORCHIDS_API: 'claude-orchids-oauth',
    QWEN_API: 'openai-qwen-oauth',
    IFLOW_API: 'openai-iflow',
    WARP_API: 'claude-warp-oauth',
    OPENAI_CODEX: 'openai-codex',
    OPENAI_XAI: 'openai-xai-oauth',
    WINDSURF_API: 'openai-windsurf',
    WINDSURF_CLAUDE: 'claude-windsurf'
}

export const MODEL_PROVIDER_ALIASES = {
    'openai-xai': MODEL_PROVIDER.OPENAI_XAI
};

export function normalizeModelProvider(provider) {
    if (typeof provider !== 'string') return null;
    const trimmed = provider.trim();
    if (!trimmed) return null;
    const alias = MODEL_PROVIDER_ALIASES[trimmed.toLowerCase()];
    if (alias) return alias;
    return Object.values(MODEL_PROVIDER).find(
        value => value.toLowerCase() === trimmed.toLowerCase()
    ) || null;
}

function getClientTokenId(req) {
    return getHeaderValue(req, [
        'x-accounthub-tokenid',
        'x-accounthub-token-id',
        'x-account-hub-token-id',
        'x-token-id'
    ]);
}

function normalizeHeaderValue(headerValue) {
    if (!headerValue) return null;
    if (Array.isArray(headerValue)) {
        return headerValue.length > 0 ? String(headerValue[0]).trim() : null;
    }
    return String(headerValue).trim();
}

function getHeaderValue(req, keys = []) {
    for (const key of keys) {
        const value = normalizeHeaderValue(req?.headers?.[key]);
        if (value) return value;
    }
    return null;
}

function getClientUserId(req) {
    return getHeaderValue(req, [
        'x-accounthub-userid',
        'x-accounthub-user-id',
        'x-account-hub-user-id',
        'x-newapi-userid',
        'x-newapi-user-id',
        'x-user-id',
        'x-uid'
    ]);
}

function getClientUserEmail(req) {
    return getHeaderValue(req, [
        'x-accounthub-useremail',
        'x-accounthub-user-email',
        'x-account-hub-user-email',
        'x-user-email',
        'x-email'
    ]);
}

function getClientUsername(req) {
    return getHeaderValue(req, [
        'x-accounthub-username',
        'x-accounthub-user-name',
        'x-account-hub-user-name',
        'x-user-name',
        'x-username'
    ]);
}

function getClientUserType(req) {
    return getHeaderValue(req, [
        'x-accounthub-user-type',
        'x-accounthub-usertype',
        'x-account-hub-user-type',
        'x-user-type'
    ]);
}

function isProviderUser(req) {
    const userType = getClientUserType(req);
    return userType && userType.toLowerCase() === 'provider';
}

function getClientIp(req) {
    const direct = getHeaderValue(req, [
        'x-accounthub-clientip',
        'x-accounthub-client-ip',
        'x-account-hub-client-ip',
        'x-client-ip'
    ]);
    if (direct) return direct;

    const forwarded = normalizeHeaderValue(req?.headers?.['x-forwarded-for']);
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
        return forwarded;
    }

    const realIp = normalizeHeaderValue(req?.headers?.['x-real-ip'] || req?.headers?.['cf-connecting-ip']);
    if (realIp) return realIp;

    return normalizeHeaderValue(req?.socket?.remoteAddress);
}

function buildServiceRequestContext(req, fallbackConfig = {}) {
    const incomingHeaders = req?.headers && typeof req.headers === 'object'
        ? req.headers
        : {};
    const authorization = getHeaderValue(req, ['authorization']);
    const xApiKey = getHeaderValue(req, ['x-api-key']);

    return {
        headers: incomingHeaders,
        path: req?.url || fallbackConfig?.REQUEST_PATH || '',
        method: req?.method || fallbackConfig?.REQUEST_METHOD || '',
        clientIp: getClientIp(req),
        clientTokenId: getClientTokenId(req),
        userId: getClientUserId(req),
        userEmail: getClientUserEmail(req),
        username: getClientUsername(req),
        authorization,
        xApiKey,
        // 对齐 CRS：传递原始 req 对象，用于 client disconnect 中断上游请求
        req: req || null
    };
}


function toNullableString(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

function toNullableInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
}

function resolveProxyNodeLogFields(service, retryContext = null) {
    const proxyNode = retryContext?.CONFIG?.proxyNode
        || service?.config?.proxyNode
        || service?.proxyNode
        || null;

    return {
        proxyNodeId: toNullableInteger(proxyNode?.id),
        proxyNodeName: toNullableString(proxyNode?.name),
        proxyNodeHost: toNullableString(proxyNode?.host),
        proxyNodePort: toNullableInteger(proxyNode?.port),
        proxyNodeProtocol: toNullableString(proxyNode?.protocol)
    };
}

function parseBooleanLike(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function resolveAccountQueueLockOptions(providerType, runtimeConfig = {}, channelDefaults = {}) {
    const providerSpecificEnabled = parseBooleanLike(
        runtimeConfig?.accountQueueLockEnabled ?? runtimeConfig?.ACCOUNT_QUEUE_LOCK_ENABLED,
        false
    );

    const lockTtlMs = Number(
        runtimeConfig?.accountQueueLockTtlMs ??
        runtimeConfig?.ACCOUNT_QUEUE_LOCK_TTL_MS ??
        120000
    );
    const waitTimeoutMs = Number(
        runtimeConfig?.accountQueueWaitTimeoutMs ??
        runtimeConfig?.ACCOUNT_QUEUE_WAIT_TIMEOUT_MS ??
        30000
    );
    const pollIntervalMs = Number(
        runtimeConfig?.accountQueuePollIntervalMs ??
        runtimeConfig?.ACCOUNT_QUEUE_POLL_INTERVAL_MS ??
        150
    );

    return {
        enabled: providerSpecificEnabled,
        lockTtlMs: Number.isFinite(lockTtlMs) ? lockTtlMs : 120000,
        waitTimeoutMs: Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : 30000,
        pollIntervalMs: Number.isFinite(pollIntervalMs) ? pollIntervalMs : 150
    };
}

function normalizeStatusCode(status) {
    const value = Number(status);
    return Number.isFinite(value) ? value : null;
}

function inferStatusCodeFromMessage(message) {
    if (!message) return null;
    const match = String(message).match(/(?:status code|http)\s*:?\s*(\d{3})/i);
    if (!match) return null;
    return normalizeStatusCode(match[1]);
}

function getErrorStatusCode(error, fallback = 500) {
    const candidates = [
        error?.response?.status,
        error?.statusCode,
        error?.status,
        error?.code
    ];
    for (const candidate of candidates) {
        const statusCode = normalizeStatusCode(candidate);
        if (statusCode !== null && statusCode >= 100 && statusCode < 600) {
            return statusCode;
        }
    }
    const inferredStatus = inferStatusCodeFromMessage(error?.message);
    if (inferredStatus !== null && inferredStatus >= 100 && inferredStatus < 600) {
        return inferredStatus;
    }
    return fallback;
}

function shouldUseClaudeCustomTimedRecovery(providerType, status, errorMessage) {
    if (providerType !== MODEL_PROVIDER.CLAUDE_CUSTOM) return false;
    const statusCode = normalizeStatusCode(status);
    if (statusCode !== null && statusCode >= 400 && statusCode < 600) {
        return true;
    }
    const message = String(errorMessage || '').toLowerCase();
    if (!message) return false;
    return /\b(400|401|402|403|429|5\d\d)\b/.test(message) ||
        /bad request|forbidden|unauthorized|rate.?limit|server error/.test(message);
}

const REQUEST_LOG_ERROR_DETAIL_MAX_LENGTH = 8000;
const REQUEST_LOG_ERROR_STACK_MAX_LENGTH = 20000;
const REQUEST_LOG_ERROR_HEADER_ALLOWLIST = new Set([
    'x-request-id',
    'request-id',
    'x-amzn-requestid',
    'x-amz-request-id',
    'x-trace-id',
    'x-b3-traceid',
    'x-b3-spanid',
    'traceparent',
    'cf-ray'
]);

function truncateLogString(value, maxLength) {
    if (!value || typeof value !== 'string') return value;
    if (value.length <= maxLength) return value;
    const trimmed = value.slice(0, maxLength);
    return `${trimmed}... [truncated ${value.length - maxLength} chars]`;
}

function extractErrorMessageFromData(data) {
    if (!data) return null;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (typeof data !== 'object') return null;
    return (
        data?.error?.message ||
        data?.error?.error?.message ||
        data?.message ||
        data?.msg ||
        null
    );
}

function buildRequestLogErrorMessage(error) {
    const fallback = error?.message || '';
    const responseMessage = extractErrorMessageFromData(error?.response?.data);
    if (!responseMessage) return fallback ? sanitize(fallback) : null;
    if (!fallback) return sanitize(responseMessage);
    const normalizedFallback = fallback.toLowerCase();
    if (normalizedFallback.startsWith('request failed with status code') || normalizedFallback === 'network error') {
        return sanitize(responseMessage);
    }
    if (responseMessage.length > fallback.length && !fallback.includes(responseMessage)) {
        return sanitize(responseMessage);
    }
    return sanitize(fallback);
}

function pickResponseHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const picked = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalizedKey = String(key).toLowerCase();
        if (REQUEST_LOG_ERROR_HEADER_ALLOWLIST.has(normalizedKey)) {
            picked[normalizedKey] = value;
        }
    }
    return Object.keys(picked).length > 0 ? picked : null;
}

function buildRequestLogErrorDetail(error, extraDetail = null) {
    if (!error) return null;
    const details = {
        name: error?.name || null,
        message: error?.message ? sanitize(error.message) : null,
        code: error?.code || null,
        status: error?.status || error?.statusCode || error?.response?.status || null,
        responseStatus: error?.response?.status || null,
        responseHeaders: pickResponseHeaders(error?.response?.headers)
    };
    if (extraDetail && typeof extraDetail === 'object') {
        Object.assign(details, sanitize(extraDetail));
    }
    const filtered = Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== '')
    );
    if (Object.keys(filtered).length === 0) return null;
    try {
        return JSON.stringify(filtered);
    } catch (stringifyError) {
        return String(filtered);
    }
}

function buildRequestLogErrorStack(error) {
    if (!error?.stack) return null;
    return truncateLogString(sanitize(error.stack), REQUEST_LOG_ERROR_STACK_MAX_LENGTH);
}

function buildRequestLogErrorType(error) {
    return error?.type || error?.name || error?.response?.data?.error?.type || null;
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol.
 * @param {string} provider - The model provider string (e.g., 'openai-custom', 'claude-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    if (provider === MODEL_PROVIDER.OPENAI_CODEX || provider === MODEL_PROVIDER.OPENAI_XAI) {
        return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    }
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    OPENAI_RESPONSES_COMPACT: 'openai_responses_compact',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

const DEFAULT_XAI_CLAUDE_MESSAGES_MODEL = 'grok-4.5';
const DEFAULT_XAI_CLAUDE_MESSAGES_MODEL_MAPPING = {
    'claude-3-5-haiku-20241022': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-3-5-haiku-latest': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-3-5-sonnet-20241022': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-3-5-sonnet-latest': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-3-7-sonnet-20250219': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-3-7-sonnet-latest': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-haiku-4-5': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-haiku-4-5-20251001': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4-20250514': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4-5': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4-5-20250929': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4-6': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-sonnet-4-6-20260217': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-20250514': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-1': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-1-20250805': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-5': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-5-20251101': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-6': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL,
    'claude-opus-4-6-20260101': DEFAULT_XAI_CLAUDE_MESSAGES_MODEL
};

function looksLikeClaudeModelName(model) {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) return false;
    const withoutProvider = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
    return withoutProvider.startsWith('claude-') || normalized.includes('.claude-');
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return '';
}

function mapXaiClaudeCompatModel(requestedModel, channelDefaults = {}) {
    if (!requestedModel || typeof requestedModel !== 'string') return requestedModel;
    const normalizedModel = requestedModel.trim();
    const mapping = {
        ...DEFAULT_XAI_CLAUDE_MESSAGES_MODEL_MAPPING,
        ...(channelDefaults?.xaiClaudeMessagesModelMapping && typeof channelDefaults.xaiClaudeMessagesModelMapping === 'object'
            ? channelDefaults.xaiClaudeMessagesModelMapping
            : {})
    };
    const mapped = mapping[normalizedModel] || mapping[normalizedModel.toLowerCase()];
    if (typeof mapped === 'string' && mapped.trim()) {
        return mapped.trim();
    }
    if (looksLikeClaudeModelName(normalizedModel)) {
        return firstNonEmptyString(
            channelDefaults?.xaiClaudeMessagesDefaultModel,
            channelDefaults?.defaultModel,
            DEFAULT_XAI_CLAUDE_MESSAGES_MODEL
        );
    }
    return requestedModel;
}

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        };
        const onData = chunk => { body += chunk.toString(); };
        const onEnd = () => finish();
        const onError = err => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        // Sticky TCP dispatcher 场景:'end' 可能已在挂 listener 之前发射过(极少见)。
        // 只在 readableEnded 真正为 true 时用 read() 主动排,避免和 flowing 模式竞争。
        // 注意:req.complete=true 但 readableEnded=false 是正常状态(parser 收满但消费者
        // 还没 attach),这时挂 'data' listener 会自动 flush buffered chunks,不要干预。
        if (req.readableEnded) {
            try {
                let chunk;
                while (typeof req.read === 'function' && (chunk = req.read()) !== null) {
                    body += chunk.toString();
                }
            } catch (_e) { /* ignore */ }
            finish();
            return;
        }

        // close 事件保护：loopback proxy destroy() 只触发 close 不触发 end
        // close 在 end 之前触发 = 连接异常断开，必须 reject 而非用空 body 继续
        const onClose = () => {
            if (settled) return;
            settled = true;
            console.warn('[getRequestBody] connection closed before body completed');
            reject(new Error('Connection closed before request body was fully received'));
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
    });
}

function getRequestContentType(req) {
    return String(req?.headers?.['content-type'] || '').trim().toLowerCase();
}

function readRequestBodyBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        };
        const onData = chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const onEnd = () => finish();
        const onError = err => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        if (req.readableEnded) {
            try {
                let chunk;
                while (typeof req.read === 'function' && (chunk = req.read()) !== null) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
            } catch (_e) { /* ignore */ }
            finish();
            return;
        }

        const onClose = () => {
            if (settled) return;
            settled = true;
            reject(new Error('Connection closed before request body was fully received'));
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
    });
}

function parseMultipartParam(headerValue, key) {
    const match = new RegExp(`${key}=(?:"([^"]*)"|([^;]*))`, 'i').exec(String(headerValue || ''));
    return match ? (match[1] || match[2] || '').trim() : '';
}

function parseMultipartHeaders(rawHeaders) {
    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) continue;
        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        if (key) headers[key] = value;
    }
    return headers;
}

function appendRepeatedField(target, key, value) {
    if (!key) return;
    if (target[key] === undefined) {
        target[key] = value;
        return;
    }
    target[key] = Array.isArray(target[key]) ? [...target[key], value] : [target[key], value];
}

function appendImageInput(target, value) {
    const current = target.image;
    if (Array.isArray(current)) {
        target.image = [...current, value];
    } else if (current) {
        target.image = [current, value];
    } else {
        target.image = [value];
    }
}

function tryParseJsonField(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed || !/^[\[{"]/.test(trimmed)) return value;
    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return value;
    }
}

async function parseMultipartImageRequestBody(req, contentType) {
    const boundary = parseMultipartParam(contentType, 'boundary');
    if (!boundary) throw new Error('Missing multipart boundary.');

    const bodyBuffer = await readRequestBodyBuffer(req);
    const delimiter = Buffer.from(`--${boundary}`);
    const headerSeparator = Buffer.from('\r\n\r\n');
    const result = {};
    let offset = 0;

    while (offset < bodyBuffer.length) {
        let partStart = bodyBuffer.indexOf(delimiter, offset);
        if (partStart === -1) break;
        partStart += delimiter.length;
        if (bodyBuffer[partStart] === 45 && bodyBuffer[partStart + 1] === 45) break;
        if (bodyBuffer[partStart] === 13 && bodyBuffer[partStart + 1] === 10) partStart += 2;

        const nextPart = bodyBuffer.indexOf(delimiter, partStart);
        if (nextPart === -1) break;
        let part = bodyBuffer.subarray(partStart, nextPart);
        if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
            part = part.subarray(0, part.length - 2);
        }

        const headerEnd = part.indexOf(headerSeparator);
        if (headerEnd === -1) {
            offset = nextPart;
            continue;
        }

        const headers = parseMultipartHeaders(part.subarray(0, headerEnd).toString('latin1'));
        const content = part.subarray(headerEnd + headerSeparator.length);
        const disposition = headers['content-disposition'] || '';
        const fieldName = parseMultipartParam(disposition, 'name');
        const filename = parseMultipartParam(disposition, 'filename');
        if (!fieldName) {
            offset = nextPart;
            continue;
        }

        const mimeType = String(headers['content-type'] || 'application/octet-stream').trim();
        const isImageFilePart = filename || mimeType.toLowerCase().startsWith('image/');
        if ((fieldName === 'image' || fieldName === 'images' || fieldName === 'mask') && isImageFilePart) {
            const dataUrl = `data:${mimeType};base64,${content.toString('base64')}`;
            const imagePart = { type: 'input_image', image_url: dataUrl };
            if (fieldName === 'image' || fieldName === 'images') {
                appendImageInput(result, imagePart);
            } else {
                result[fieldName] = imagePart;
            }
        } else {
            appendRepeatedField(result, fieldName, tryParseJsonField(content.toString('utf8')));
        }

        offset = nextPart;
    }

    return result;
}

async function getImageRequestBody(req) {
    const contentType = getRequestContentType(req);
    if (contentType.startsWith('multipart/form-data')) {
        return parseMultipartImageRequestBody(req, contentType);
    }
    return getRequestBody(req);
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        console.log(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            console.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    console.log(`[Auth] Unauthorized request denied. Bearer=${authHeader ? 'present' : 'missing'}, queryKey=${queryKey ? 'present' : 'missing'}, x-goog-api-key=${googApiKey ? 'present' : 'missing'}, x-api-key=${claudeApiKey ? 'present' : 'missing'}`);
    return false;
}

/**
 * Copies only non-sensitive rate-limit and request-correlation headers.
 */
const UPSTREAM_PASSTHROUGH_PREFIXES = [
    'anthropic-ratelimit-',
    'anthropic-organization',
    'openai-',
    'x-codex-',
    'x-openai-',
    'retry-after',
    'x-ratelimit-',
];
const UPSTREAM_PASSTHROUGH_EXACT = new Set([
    'request-id', 'x-request-id', 'cf-ray', 'server',
    'x-models-etag', 'x-reasoning-included',
]);

function pickUpstreamHeaders(upstreamHeaders) {
    if (!upstreamHeaders || typeof upstreamHeaders !== 'object') return {};
    const picked = {};
    for (const [key, value] of Object.entries(upstreamHeaders)) {
        const kl = key.toLowerCase();
        if (UPSTREAM_PASSTHROUGH_EXACT.has(kl) ||
            UPSTREAM_PASSTHROUGH_PREFIXES.some(p => kl.startsWith(p))) {
            picked[kl] = value;
        }
    }
    return picked;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 * @param {Object} [upstreamHeaders] - Optional upstream headers filtered through a safe allowlist.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream, upstreamHeaders, statusCode = 200) {
    const responseHeaders = pickUpstreamHeaders(upstreamHeaders);

    if (isStream) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
            "X-Accel-Buffering": "no",
            ...responseHeaders,
        });
    } else {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            ...responseHeaders,
        });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null, req = null, poolId = 0) {
    let fullResponseText = '';
    const LOG_TEXT_MAX = 10 * 1024; // 日志文本最大 10KB，超出截断
    let responseBytesWritten = 0; // 用于判断是否已发送内容（重试判断）
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    const requestStartTime = Date.now();
    const clientTokenId = getClientTokenId(req);
    const clientUserId = getClientUserId(req);
    const clientUserEmail = getClientUserEmail(req);
    const clientUsername = getClientUsername(req);
    const clientIp = getClientIp(req);
    const userAgent = req?.headers?.['user-agent'];

    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const networkRetryCount = retryContext?.networkRetryCount ?? 0;
    const CONFIG = retryContext?.CONFIG;
    const { maxRetries: maxNetworkRetryRetries, baseDelayMs: networkRetryBaseDelayMs } = getTransientNetworkRetryConfig(CONFIG);
    const isRetry = currentRetry > 0 || networkRetryCount > 0;
    const proxyNodeLogFields = resolveProxyNodeLogFields(service, retryContext);

    if (!isRetry) {
        const requestPath = req?.url ? new URL(req.url, 'http://localhost').pathname : '';
        const hasIdentity = Boolean(clientTokenId || clientUserId || clientUsername || clientUserEmail);
        console.log(`[Request In] ${req?.method || 'UNKNOWN'} ${requestPath} identity=${hasIdentity ? 'present' : 'anonymous'}`);
    }

    // The service returns a stream in its native format (toProvider).
    const requestBodyForUpstream = requestBody && typeof requestBody === 'object'
        ? { ...requestBody }
        : requestBody;
    if (requestBodyForUpstream && typeof requestBodyForUpstream === 'object') {
        delete requestBodyForUpstream.__request_log_compat_summary;
        requestBodyForUpstream.model = model;
    }

    const fromProtocol = getProtocolPrefix(fromProvider);
    const toProtocol = getProtocolPrefix(toProvider);
    const needsConversion = fromProtocol !== toProtocol;

    console.log('[handleStreamRequest] fromProvider:', fromProvider, 'fromProtocol:', fromProtocol);
    console.log('[handleStreamRequest] toProvider:', toProvider, 'toProtocol:', toProtocol);
    console.log('[handleStreamRequest] needsConversion:', needsConversion);

    const forwardedRequestContext = retryContext?.requestContext || { headers: req?.headers || {} };
    const nativeStream = await service.generateContentStream(
        model,
        requestBodyForUpstream,
        forwardedRequestContext
    );

    const addEvent = fromProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE || fromProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    const openStop = fromProtocol === MODEL_PROTOCOL_PREFIX.OPENAI;

    // 用于捕获返回的 credit 消耗
    let creditUsage = null;
    let ttftMs = null; // 首字耗时
    let inputTokens = 0;
    let outputTokens = 0;

    // 获取 traceId 用于记录追踪阶段
    const traceId = requestBody?.metadata?.traceId;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let firstContentReceived = false; // 用于 TTFT 检测

    let actualModelUsed = model;
    let openAIFinishChunkSeen = false;
    let responseHeadersWritten = res.headersSent === true;
    // DiagUsage: middle-layer event tracking
    let _diagMidChunkCount = 0;
    let _diagMidCompletedSeen = false;
    let _diagMidTypes = {};
    try {
        for await (const nativeChunk of nativeStream) {
            const upstreamHeaders = nativeChunk && typeof nativeChunk === 'object'
                ? nativeChunk.__upstreamHeaders
                : null;
            if (nativeChunk && typeof nativeChunk === 'object' && '__upstreamHeaders' in nativeChunk) {
                delete nativeChunk.__upstreamHeaders;
            }
            if (!responseHeadersWritten) {
                await handleUnifiedResponse(res, '', true, upstreamHeaders);
                responseHeadersWritten = true;
            }

            // DiagUsage: track chunk types
            _diagMidChunkCount++;
            const _ctype = nativeChunk?.type || 'unknown';
            _diagMidTypes[_ctype] = (_diagMidTypes[_ctype] || 0) + 1;
            if (_ctype === 'response.completed') _diagMidCompletedSeen = true;
            if (nativeChunk && typeof nativeChunk === 'object' && nativeChunk.__actualModel) {
                actualModelUsed = nativeChunk.__actualModel;
                delete nativeChunk.__actualModel;
            }
            // Capture optional credit usage reported by upstream providers.
            if (nativeChunk.type === 'message_delta' && nativeChunk.usage?.credit_usage !== undefined) {
                creditUsage = nativeChunk.usage.credit_usage;
            }
            // Capture token statistics and timing from Claude-compatible streams.
            if (nativeChunk.type === 'message_delta') {
                if (nativeChunk.__ttftMs !== undefined) {
                    ttftMs = nativeChunk.__ttftMs;
                    // 记录 TTFT 阶段
                    if (traceId && ttftMs) {
                        requestTracer.recordPhase(traceId, TRACE_PHASE.TTFT, ttftMs);
                    }
                    delete nativeChunk.__ttftMs;
                }
                if (nativeChunk.__requestDurationMs !== undefined) {
                    delete nativeChunk.__requestDurationMs;
                }
                if (nativeChunk.usage) {
                    const usage = extractTokenUsage(nativeChunk.usage);
                    inputTokens = usage.uncachedInputTokens;
                    outputTokens = usage.outputTokens;
                    cacheCreationTokens = usage.cacheCreationTokens;
                    cacheReadTokens = usage.cacheReadTokens;
                }
            }

            // OpenAI Responses format: detect the first output item for TTFT.
            if (!firstContentReceived && nativeChunk.type === 'response.output_item.added') {
                firstContentReceived = true;
                ttftMs = Date.now() - requestStartTime;
                if (traceId) {
                    requestTracer.recordPhase(traceId, TRACE_PHASE.TTFT, ttftMs);
                }
            }

            // OpenAI Responses format: collect usage from response.completed.
            if (nativeChunk.type === 'response.completed') {
                if (nativeChunk.response?.usage) {
                    const usage = extractTokenUsage(nativeChunk.response.usage);
                    inputTokens = usage.uncachedInputTokens;
                    outputTokens = usage.outputTokens;
                    cacheCreationTokens = usage.cacheCreationTokens;
                    cacheReadTokens = usage.cacheReadTokens;
                    console.log(`[DiagUsage-AH] response.completed FOUND usage: model=${model} input=${inputTokens} output=${outputTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
                } else {
                    // 关键诊断：response.completed 但没有 usage
                    const responseKeys = nativeChunk.response ? Object.keys(nativeChunk.response) : [];
                    console.error(`[DiagUsage-AH] response.completed but NO usage! model=${model} responseKeys=[${responseKeys.join(',')}]`);
                }
            }

            // Extract text for logging purposes (only accumulate when logging enabled, with cap)
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                if (PROMPT_LOG_MODE !== 'none' && fullResponseText.length < LOG_TEXT_MAX) {
                    fullResponseText += chunkText;
                }
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model)
                : nativeChunk;

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                if (
                    openStop
                    && needsConversion
                    && Array.isArray(chunk?.choices)
                    && chunk.choices.some(choice => choice?.finish_reason !== null && choice?.finish_reason !== undefined)
                ) {
                    openAIFinishChunkSeen = true;
                }
                if (addEvent) {
                    // fullOldResponseJson += chunk.type+"\n";
                    // fullResponseJson += chunk.type+"\n";
                    const eventPayload = `event: ${chunk.type}\n`;
                    res.write(eventPayload);
                    responseBytesWritten += Buffer.byteLength(eventPayload);
                    // console.log(`event: ${chunk.type}\n`);
                }

                // fullOldResponseJson += JSON.stringify(chunk)+"\n";
                // fullResponseJson += JSON.stringify(chunk)+"\n\n";
                const dataPayload = `data: ${JSON.stringify(chunk)}\n\n`;
                res.write(dataPayload);
                responseBytesWritten += Buffer.byteLength(dataPayload);
                // console.log(`data: ${JSON.stringify(chunk)}\n`);
            }
        }
        if (toProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES && !_diagMidCompletedSeen) {
            const incompleteError = new Error('OpenAI Responses stream ended before response.completed');
            incompleteError.code = 'ERR_RESPONSES_STREAM_INCOMPLETE';
            incompleteError.status = 502;
            incompleteError.statusCode = 502;
            throw incompleteError;
        }

        if (openStop && needsConversion && !openAIFinishChunkSeen) {
            const stopPayload = `data: ${JSON.stringify(getOpenAIStreamChunkStop(actualModelUsed || model))}\n\n`;
            res.write(stopPayload);
            responseBytesWritten += Buffer.byteLength(stopPayload);
            // console.log(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n`);
        }

        // End the SSE stream explicitly so clients do not wait on keep-alive connections.
        if (fromProtocol !== MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            const donePayload = `data: [DONE]\n\n`;
            res.write(donePayload);
            responseBytesWritten += Buffer.byteLength(donePayload);
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Stream request completed successfully for ${toProvider}`);
            console.log(`[DiagUsage-AH] Stream completed: model=${actualModelUsed || model} inputTokens=${inputTokens} outputTokens=${outputTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens} ttft=${ttftMs}ms from=${fromProvider} to=${toProvider}`);
            console.log(`[DiagUsage-Mid] chunks=${_diagMidChunkCount} completedSeen=${_diagMidCompletedSeen} types=${JSON.stringify(_diagMidTypes)}`);
            if (inputTokens === 0 && outputTokens === 0) {
                console.error(`[DiagUsage-Mid] WARNING: in=0 out=0 after stream! model=${actualModelUsed || model} completedSeen=${_diagMidCompletedSeen} chunkTypes=${JSON.stringify(_diagMidTypes)}`);
            }
            providerPoolManager.markProviderHealthy(toProvider, pooluuid);
            // 记录请求成功
            providerPoolManager.recordRequestSuccess();
            // 记录请求日志
            const requestDuration = Date.now() - requestStartTime;
            // 记录 COMPLETE 阶段（总生成时间）
            if (traceId) {
                requestTracer.recordPhase(traceId, TRACE_PHASE.COMPLETE, requestDuration);
            }
            providerPoolManager.recordRequestLog({
                providerType: toProvider,
                providerUuid: pooluuid,
                poolId,
                model: actualModelUsed || model,
                statusCode: 200,
                isSuccess: true,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                creditUsage,
                durationMs: requestDuration,
                ttftMs,
                clientIp,
                userAgent,
                clientTokenId,
                userId: clientUserId,
                userEmail: clientUserEmail,
                username: clientUsername,
                ...proxyNodeLogFields
            });
        } else if (traceId) {
            // 没有 providerPoolManager 时也记录 COMPLETE
            const requestDuration = Date.now() - requestStartTime;
            requestTracer.recordPhase(traceId, TRACE_PHASE.COMPLETE, requestDuration);
        }

    } catch (error) {
        console.error('[Server] Stream processing failed:', {
            name: error?.name,
            code: error?.code,
            status: getErrorStatusCode(error, null)
        });
        // 获取状态码
        const status = getErrorStatusCode(error, null);
        const requestErrorMessage = buildRequestLogErrorMessage(error);
        const requestErrorType = buildRequestLogErrorType(error);
        const requestErrorStack = buildRequestLogErrorStack(error);
        const requestErrorDetail = buildRequestLogErrorDetail(error);

        if (!status && responseBytesWritten === 0 && isRetryableNetworkError(error) && networkRetryCount < maxNetworkRetryRetries) {
            const delayMs = networkRetryBaseDelayMs * Math.pow(2, networkRetryCount);
            console.warn(`[Stream Retry] Transient network error (${error.code || 'unknown'}). Retrying same request ${networkRetryCount + 1}/${maxNetworkRetryRetries} after ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return await handleStreamRequest(
                res,
                service,
                actualModelUsed || model,
                requestBody,
                fromProvider,
                toProvider,
                PROMPT_LOG_MODE,
                PROMPT_LOG_FILENAME,
                providerPoolManager,
                pooluuid,
                customName,
                {
                    ...retryContext,
                    CONFIG,
                    networkRetryCount: networkRetryCount + 1
                },
                req,
                poolId
            );
        }

        // 记录错误到历史记录
        if (providerPoolManager && pooluuid) {
            providerPoolManager.recordError(
                toProvider,
                pooluuid,
                error.message,
                status,
                actualModelUsed || model,
                customName
            );
            // 记录失败请求日志
            const requestDuration = Date.now() - requestStartTime;
            providerPoolManager.recordRequestLog({
                providerType: toProvider,
                providerUuid: pooluuid,
                poolId,
                model: actualModelUsed || model,
                statusCode: status,
                isSuccess: false,
                errorType: requestErrorType,
                errorMessage: requestErrorMessage,
                errorStack: requestErrorStack,
                errorDetail: requestErrorDetail,
                durationMs: requestDuration,
                clientIp,
                userAgent,
                clientTokenId,
                userId: clientUserId,
                userEmail: clientUserEmail,
                username: clientUsername,
                ...proxyNodeLogFields
            });
        }

        // 如果已经发送了内容，不进行重试（避免响应数据损坏）
        if (responseBytesWritten > 0) {
            console.log(`[Stream Retry] Cannot retry: ${responseBytesWritten} bytes already sent to client`);
            // 直接发送错误并结束
            const errorPayload = createStreamErrorResponse(error, fromProvider);
            res.write(errorPayload);
            res.end();
            responseClosed = true;
            // 返回失败状态供链路追踪使用
            return { inputTokens, outputTokens, ttftMs, pooluuid, cacheCreationTokens, cacheReadTokens, creditUsage, success: false, error, statusCode: status };
        }

        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;

        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        if (error.shouldDeleteCredential && providerPoolManager && pooluuid && typeof providerPoolManager.markProviderDeleted === 'function') {
            console.log(`[Provider Pool] Deleting failed credential for ${toProvider}`);
            await providerPoolManager.markProviderDeleted(toProvider, pooluuid, error.message, {
                action: 'mark_deleted_runtime',
                source: 'request_error',
                metadata: {
                    model: error.model,
                    statusCode: normalizeStatusCode(status)
                }
            });
            credentialMarkedUnhealthy = true;
        }
        // 模型级不可用：原样返回，不标记账号异常，也不写模型保护
        else if (error.isModelUnavailableScoped && providerPoolManager && pooluuid) {
            const blockedModel = error.rateLimitedModel || error.model || actualModelUsed || model || originalRequestBody?.model || null;
            console.log(`[Provider Pool] Model-scoped unavailable for ${blockedModel}; account state unchanged`);
        }
        // 配额冷却：用精确恢复时间标记账号，跳过累计错误计数
        else if (error.isQuotaCooldown && providerPoolManager && pooluuid) {
            const recoveryTime = error.quotaResetTime
                ? new Date(error.quotaResetTime)
                : new Date(Date.now() + (error.quotaResetDelayMs || 3600000));
            const rateLimitedModel = error.rateLimitedModel || error.model || actualModelUsed || model || originalRequestBody?.model || null;
            // Opus-only rate limit: 仅标记模型级保护，不标记整个账号不健康
            if (error.opusOnlyRateLimit) {
                console.log(`[Provider Pool] Model quota cooldown for ${rateLimitedModel}, recovery at ${recoveryTime.toISOString()}`);
                if (rateLimitedModel && typeof providerPoolManager.markModelQuotaProtected === 'function') {
                    providerPoolManager.markModelQuotaProtected(pooluuid, rateLimitedModel, recoveryTime);
                }
            } else {
                console.log(`[Provider Pool] Credential quota cooldown until ${recoveryTime.toISOString()}`);
                await providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                    toProvider, pooluuid, recoveryTime, error.message, {
                    action: 'mark_unhealthy_quota_cooldown',
                    source: 'quota_exhausted',
                    metadata: {
                        model: error.model,
                        quotaResetFormatted: error.quotaResetFormatted,
                        quotaResetDelayMs: error.quotaResetDelayMs
                    }
                }
                );
                // Model-Level Quota Protection: 记录被限流的具体模型
                if (rateLimitedModel && typeof providerPoolManager.markModelQuotaProtected === 'function') {
                    providerPoolManager.markModelQuotaProtected(pooluuid, rateLimitedModel, recoveryTime);
                }
            }
            credentialMarkedUnhealthy = true;
        }
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        else if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${status || 'unknown'})`);
            if (shouldUseClaudeCustomTimedRecovery(toProvider, status, error.message) && typeof providerPoolManager.markProviderUnhealthyWithRecoveryTime === 'function') {
                const recoveryMinutes = Math.max(1, Number(CONFIG?.CLAUDE_CUSTOM_ERROR_RECOVERY_MINUTES) || 3);
                const recoveryTime = new Date(Date.now() + recoveryMinutes * 60 * 1000);
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                    toProvider,
                    pooluuid,
                    recoveryTime,
                    error.message,
                    {
                        source: 'request_error_stream',
                        action: 'mark_unhealthy_recovery',
                        metadata: { statusCode: normalizeStatusCode(status) }
                    }
                );
            } else {
                providerPoolManager.markProviderUnhealthy(toProvider, pooluuid, error.message);
            }
            credentialMarkedUnhealthy = true;
        } else if (credentialMarkedUnhealthy) {
            console.log('[Provider Pool] Credential already marked unhealthy; skipping duplicate update');
        } else if (skipErrorCount) {
            console.log(`[Provider Pool] Skipping error count for ${toProvider}; switching credential`);
        }

        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }

        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            console.log(`[Stream Retry] Credential marked unhealthy. Attempting retry ${currentRetry + 1}/${maxRetries} with different credential...`);

            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                const retryRequestContext = retryContext?.requestContext || buildServiceRequestContext(req, CONFIG);
                // 方案 B:重试路径禁用 sticky,失败的 uuid 正是 sticky 指向的那个,继续 sticky 会反复命中;
                // 同时把已失败的 uuid 加到 excludeUuids
                const result = await getApiServiceWithFallback(CONFIG, model, {
                    isProviderUser: retryContext?.isProviderUser === true,
                    sessionId: null,  // 禁 sticky
                    requestContext: retryRequestContext,
                    poolId: retryContext?.poolId ?? CONFIG?.POOL_ID,
                    excludeUuids: pooluuid ? [pooluuid] : []
                });

                if (result && result.service && result.uuid !== pooluuid) {
                    if (typeof result.service.setRequestContext === 'function') {
                        result.service.setRequestContext(retryRequestContext);
                    }
                    console.log(`[Stream Retry] Switched credential for provider ${result.actualProviderType}`);

                    // 记录切号和失败
                    providerPoolManager.recordCredentialSwitch();
                    providerPoolManager.recordRequestFailure();

                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG: result.serviceConfig || CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries
                    };

                    // 递归调用，使用新的服务
                    return await handleStreamRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext,
                        req,
                        result.poolId ?? retryContext?.poolId ?? poolId
                    );
                } else if (result && result.uuid === pooluuid) {
                    console.log(`[Stream Retry] No different healthy credential available. Same credential selected.`);
                } else {
                    console.log(`[Stream Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                console.error('[Stream Retry] Failed to get alternative service:', {
                    code: retryError?.code,
                    status: getErrorStatusCode(retryError, null)
                });
            }
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        if (!responseHeadersWritten) {
            await handleUnifiedResponse(res, '', true, error?.response?.headers);
            responseHeadersWritten = true;
        }
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        res.write(errorPayload);
        res.end();
        responseClosed = true;
        // 返回失败状态供链路追踪使用
        return { inputTokens, outputTokens, ttftMs, pooluuid, cacheCreationTokens, cacheReadTokens, creditUsage, success: false, error, statusCode: status };
    } finally {
        if (!responseClosed) {
            res.end();
        }
        await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    }
    // 返回统计数据供链路追踪使用
    return { inputTokens, outputTokens, ttftMs, pooluuid, cacheCreationTokens, cacheReadTokens, creditUsage, success: true };
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null, req = null, poolId = 0) {
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const networkRetryCount = retryContext?.networkRetryCount ?? 0;
    const CONFIG = retryContext?.CONFIG;
    const { maxRetries: maxNetworkRetryRetries, baseDelayMs: networkRetryBaseDelayMs } = getTransientNetworkRetryConfig(CONFIG);
    const requestStartTime = Date.now();
    const clientTokenId = getClientTokenId(req);
    const clientUserId = getClientUserId(req);
    const clientUserEmail = getClientUserEmail(req);
    const clientUsername = getClientUsername(req);
    const clientIp = getClientIp(req);
    const userAgent = req?.headers?.['user-agent'];
    const isRetry = currentRetry > 0 || networkRetryCount > 0;
    const proxyNodeLogFields = resolveProxyNodeLogFields(service, retryContext);

    let actualModelUsed = model;
    try {
        if (!isRetry) {
            const requestPath = req?.url ? new URL(req.url, 'http://localhost').pathname : '';
            const hasIdentity = Boolean(clientTokenId || clientUserId || clientUsername || clientUserEmail);
            console.log(`[Request In] ${req?.method || 'UNKNOWN'} ${requestPath} identity=${hasIdentity ? 'present' : 'anonymous'}`);
        }

        // The service returns the response in its native format (toProvider).
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);
        const needsConversion = fromProtocol !== toProtocol;
        const requestBodyForUpstream = requestBody && typeof requestBody === 'object'
            ? { ...requestBody }
            : requestBody;
        if (requestBodyForUpstream && typeof requestBodyForUpstream === 'object') {
            delete requestBodyForUpstream.__request_log_compat_summary;
            requestBodyForUpstream.model = model;
        }

        const forwardedRequestContext = retryContext?.requestContext || { headers: req?.headers || {} };
        let nativeResponse = await service.generateContent(
            model,
            requestBodyForUpstream,
            forwardedRequestContext
        );
        const upstreamHeaders = nativeResponse && typeof nativeResponse === 'object'
            ? nativeResponse.__upstreamHeaders
            : null;
        if (nativeResponse && typeof nativeResponse === 'object' && '__upstreamHeaders' in nativeResponse) {
            delete nativeResponse.__upstreamHeaders;
        }
        if (nativeResponse && typeof nativeResponse === 'object' && nativeResponse.__actualModel) {
            actualModelUsed = nativeResponse.__actualModel;
            delete nativeResponse.__actualModel;
        }
        // Responses providers may return the final stream event wrapper from unary calls.
        if (toProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
            && nativeResponse?.type === 'response.completed'
            && nativeResponse.response
            && typeof nativeResponse.response === 'object') {
            nativeResponse = nativeResponse.response;
        }
        const responseText = extractResponseText(nativeResponse, toProvider);
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;
        const usagePayload = nativeResponse?.usage;
        if (usagePayload && typeof usagePayload === 'object') {
            const usage = extractTokenUsage(usagePayload);
            inputTokens = usage.uncachedInputTokens;
            outputTokens = usage.outputTokens;
            cacheCreationTokens = usage.cacheCreationTokens;
            cacheReadTokens = usage.cacheReadTokens;
        }

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            console.log(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        //console.log(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false, upstreamHeaders);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Unary request completed successfully for ${toProvider}`);
            providerPoolManager.markProviderHealthy(toProvider, pooluuid);
            // 记录请求成功
            providerPoolManager.recordRequestSuccess();
            // 记录请求日志
            const requestDuration = Date.now() - requestStartTime;
            providerPoolManager.recordRequestLog({
                providerType: toProvider,
                providerUuid: pooluuid,
                poolId,
                model: actualModelUsed || model,
                statusCode: 200,
                isSuccess: true,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                durationMs: requestDuration,
                clientIp,
                userAgent,
                clientTokenId,
                userId: clientUserId,
                userEmail: clientUserEmail,
                username: clientUsername,
                ...proxyNodeLogFields
            });
        }
    } catch (error) {
        console.error('[Server] Unary processing failed:', {
            name: error?.name,
            code: error?.code,
            status: getErrorStatusCode(error, null)
        });
        // 获取状态码
        const status = getErrorStatusCode(error, null);
        const requestErrorMessage = buildRequestLogErrorMessage(error);
        const requestErrorType = buildRequestLogErrorType(error);
        const requestErrorStack = buildRequestLogErrorStack(error);
        const requestErrorDetail = buildRequestLogErrorDetail(error);

        if (!status && isRetryableNetworkError(error) && networkRetryCount < maxNetworkRetryRetries) {
            const delayMs = networkRetryBaseDelayMs * Math.pow(2, networkRetryCount);
            console.warn(`[Unary Retry] Transient network error (${error.code || 'unknown'}). Retrying same request ${networkRetryCount + 1}/${maxNetworkRetryRetries} after ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return await handleUnaryRequest(
                res,
                service,
                actualModelUsed || model,
                requestBody,
                fromProvider,
                toProvider,
                PROMPT_LOG_MODE,
                PROMPT_LOG_FILENAME,
                providerPoolManager,
                pooluuid,
                customName,
                {
                    ...retryContext,
                    CONFIG,
                    networkRetryCount: networkRetryCount + 1
                },
                req,
                poolId
            );
        }

        // 记录错误到历史记录
        if (providerPoolManager && pooluuid) {
            providerPoolManager.recordError(
                toProvider,
                pooluuid,
                error.message,
                status,
                actualModelUsed || model,
                customName
            );
            // 记录失败请求日志
            const requestDuration = Date.now() - requestStartTime;
            providerPoolManager.recordRequestLog({
                providerType: toProvider,
                providerUuid: pooluuid,
                poolId,
                model: actualModelUsed || model,
                statusCode: status,
                isSuccess: false,
                errorType: requestErrorType,
                errorMessage: requestErrorMessage,
                errorStack: requestErrorStack,
                errorDetail: requestErrorDetail,
                durationMs: requestDuration,
                clientIp,
                userAgent,
                clientTokenId,
                userId: clientUserId,
                userEmail: clientUserEmail,
                username: clientUsername,
                ...proxyNodeLogFields
            });
        }

        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;

        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        if (error.shouldDeleteCredential && providerPoolManager && pooluuid && typeof providerPoolManager.markProviderDeleted === 'function') {
            console.log(`[Provider Pool] Deleting failed credential for ${toProvider}`);
            await providerPoolManager.markProviderDeleted(toProvider, pooluuid, error.message, {
                action: 'mark_deleted_runtime',
                source: 'request_error',
                metadata: {
                    model: error.model,
                    statusCode: normalizeStatusCode(status)
                }
            });
            credentialMarkedUnhealthy = true;
        }
        // 模型级不可用：原样返回，不标记账号异常，也不写模型保护
        else if (error.isModelUnavailableScoped && providerPoolManager && pooluuid) {
            const blockedModel = error.rateLimitedModel || error.model || actualModelUsed || model || originalRequestBody?.model || null;
            console.log(`[Provider Pool] Model-scoped unavailable for ${blockedModel}; account state unchanged`);
        }
        // 配额冷却：用精确恢复时间标记账号，跳过累计错误计数
        else if (error.isQuotaCooldown && providerPoolManager && pooluuid) {
            const recoveryTime = error.quotaResetTime
                ? new Date(error.quotaResetTime)
                : new Date(Date.now() + (error.quotaResetDelayMs || 3600000));
            const rateLimitedModel = error.rateLimitedModel || error.model || actualModelUsed || model || originalRequestBody?.model || null;
            // Opus-only rate limit: 仅标记模型级保护，不标记整个账号不健康
            if (error.opusOnlyRateLimit) {
                console.log(`[Provider Pool] Model quota cooldown for ${rateLimitedModel}, recovery at ${recoveryTime.toISOString()}`);
                if (rateLimitedModel && typeof providerPoolManager.markModelQuotaProtected === 'function') {
                    providerPoolManager.markModelQuotaProtected(pooluuid, rateLimitedModel, recoveryTime);
                }
            } else {
                console.log(`[Provider Pool] Credential quota cooldown until ${recoveryTime.toISOString()}`);
                await providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                    toProvider, pooluuid, recoveryTime, error.message, {
                    action: 'mark_unhealthy_quota_cooldown',
                    source: 'quota_exhausted',
                    metadata: {
                        model: error.model,
                        quotaResetFormatted: error.quotaResetFormatted,
                        quotaResetDelayMs: error.quotaResetDelayMs
                    }
                }
                );
                // Model-Level Quota Protection: 记录被限流的具体模型
                if (rateLimitedModel && typeof providerPoolManager.markModelQuotaProtected === 'function') {
                    providerPoolManager.markModelQuotaProtected(pooluuid, rateLimitedModel, recoveryTime);
                }
            }
            credentialMarkedUnhealthy = true;
        }
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        else if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${status || 'unknown'})`);
            if (shouldUseClaudeCustomTimedRecovery(toProvider, status, error.message) && typeof providerPoolManager.markProviderUnhealthyWithRecoveryTime === 'function') {
                const recoveryMinutes = Math.max(1, Number(CONFIG?.CLAUDE_CUSTOM_ERROR_RECOVERY_MINUTES) || 3);
                const recoveryTime = new Date(Date.now() + recoveryMinutes * 60 * 1000);
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                    toProvider,
                    pooluuid,
                    recoveryTime,
                    error.message,
                    {
                        source: 'request_error_unary',
                        action: 'mark_unhealthy_recovery',
                        metadata: { statusCode: normalizeStatusCode(status) }
                    }
                );
            } else {
                providerPoolManager.markProviderUnhealthy(toProvider, pooluuid, error.message);
            }
            credentialMarkedUnhealthy = true;
        } else if (credentialMarkedUnhealthy) {
            console.log('[Provider Pool] Credential already marked unhealthy; skipping duplicate update');
        } else if (skipErrorCount) {
            console.log(`[Provider Pool] Skipping error count for ${toProvider}; switching credential`);
        }

        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }

        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            console.log(`[Unary Retry] Credential marked unhealthy. Attempting retry ${currentRetry + 1}/${maxRetries} with different credential...`);

            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                const retryRequestContext = retryContext?.requestContext || buildServiceRequestContext(req, CONFIG);
                // 方案 B:重试禁 sticky,防止反复命中失败 uuid
                const result = await getApiServiceWithFallback(CONFIG, model, {
                    isProviderUser: retryContext?.isProviderUser === true,
                    sessionId: null,
                    requestContext: retryRequestContext,
                    poolId: retryContext?.poolId ?? CONFIG?.POOL_ID,
                    excludeUuids: pooluuid ? [pooluuid] : []
                });

                if (result && result.service && result.uuid !== pooluuid) {
                    if (typeof result.service.setRequestContext === 'function') {
                        result.service.setRequestContext(retryRequestContext);
                    }
                    console.log(`[Unary Retry] Switched credential for provider ${result.actualProviderType}`);

                    // 记录切号和失败
                    providerPoolManager.recordCredentialSwitch();
                    providerPoolManager.recordRequestFailure();

                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG: result.serviceConfig || CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries
                    };

                    // 递归调用，使用新的服务
                    return await handleUnaryRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext,
                        req,
                        result.poolId ?? retryContext?.poolId ?? poolId
                    );
                } else if (result && result.uuid === pooluuid) {
                    console.log(`[Unary Retry] No different healthy credential available. Same credential selected.`);
                } else {
                    console.log(`[Unary Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                console.error('[Unary Retry] Failed to get alternative service:', {
                    code: retryError?.code,
                    status: getErrorStatusCode(retryError, null)
                });
            }
        }

        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        await handleUnifiedResponse(
            res,
            JSON.stringify(errorResponse),
            false,
            undefined,
            getErrorStatusCode(error, 500)
        );
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid, retryState = {}) {
    let toProvider; // 声明在外部，以便 catch 块可以访问
    const currentRetry = Number(retryState.currentRetry) || 0;
    const maxRetries = Number(retryState.maxRetries) || 1;
    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };
    const fromProvider = clientProviderMap[endpointType];

    try {
        toProvider = CONFIG.MODEL_PROVIDER;

        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        // 1. Get the model list in the backend's native format.
        const nativeModelList = await service.listModels();

        // 2. Convert the model list to the client's expected format, if necessary.
        let clientModelList = nativeModelList;
        if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
            console.log(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
            clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
        } else {
            console.log(`[ModelList Convert] Model list format matches. No conversion needed.`);
        }

        console.log('[ModelList Response] Sending model list to client');
        await handleUnifiedResponse(
            res,
            JSON.stringify(clientModelList),
            false
        );
    } catch (error) {
        console.error('[Server] Model list processing failed:', {
            name: error?.name,
            code: error?.code,
            status: getErrorStatusCode(error, null)
        });

        if (providerPoolManager && toProvider && pooluuid) {
            if (error.shouldDeleteCredential && typeof providerPoolManager.markProviderDeleted === 'function') {
                await providerPoolManager.markProviderDeleted(toProvider, pooluuid, error.message, {
                    action: 'mark_deleted_model_list',
                    source: 'request_error',
                    metadata: { statusCode: normalizeStatusCode(error.status || error.response?.status) }
                });
            } else if (error.skipErrorCount !== true) {
                providerPoolManager.markProviderUnhealthy(toProvider, pooluuid, error.message);
            }

            if (currentRetry < maxRetries) {
                try {
                    const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                    const retryRequestContext = buildServiceRequestContext(req, CONFIG);
                    const result = await getApiServiceWithFallback(CONFIG, null, {
                        requestContext: retryRequestContext,
                        poolId: CONFIG?.POOL_ID
                    });

                    if (result?.service && result.uuid && result.uuid !== pooluuid) {
                        if (typeof result.service.setRequestContext === 'function') {
                            result.service.setRequestContext(retryRequestContext);
                        }
                        console.log(`[ModelList Retry] Switched credential for provider ${result.actualProviderType}`);
                        providerPoolManager.recordCredentialSwitch();
                        providerPoolManager.recordRequestFailure();
                        return handleModelListRequest(
                            req,
                            res,
                            result.service,
                            endpointType,
                            result.serviceConfig || CONFIG,
                            providerPoolManager,
                            result.uuid,
                            { currentRetry: currentRetry + 1, maxRetries }
                        );
                    }
                } catch (retryError) {
                    console.error('[ModelList Retry] Failed to get alternative service:', {
                        code: retryError?.code,
                        status: getErrorStatusCode(retryError, null)
                    });
                }
            }
        }

        const errorResponse = createErrorResponse(error, fromProvider || MODEL_PROTOCOL_PREFIX.OPENAI);
        await handleUnifiedResponse(
            res,
            JSON.stringify(errorResponse),
            false,
            undefined,
            getErrorStatusCode(error, 500)
        );
    }
}

function normalizeImageRequestCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(1, Math.min(4, Math.trunc(parsed)));
}

function hasImageEditInputs(requestBody) {
    return Boolean(
        requestBody?.image
        || requestBody?.images
        || requestBody?.input_image
        || requestBody?.image_url
    );
}

async function markMediaErrorState(providerPoolManager, providerUuid, providerType, requestedModel, error, status, mediaType = 'media') {
    if (!providerPoolManager || !providerUuid) return;

    if (error.shouldDeleteCredential && typeof providerPoolManager.markProviderDeleted === 'function') {
        await providerPoolManager.markProviderDeleted(providerType, providerUuid, error.message, {
            action: `mark_deleted_${mediaType}_runtime`,
            source: 'request_error',
            metadata: { statusCode: normalizeStatusCode(status), model: requestedModel }
        });
        return;
    }

    if (error.isAuthCredentialIssue) {
        await providerPoolManager.markProviderUnhealthy(providerType, providerUuid, error.message, {
            action: `mark_unhealthy_${mediaType}_auth_issue`,
            source: 'request_error',
            metadata: { statusCode: normalizeStatusCode(status), model: requestedModel }
        });
        return;
    }

    if (error.isQuotaCooldown) {
        const recoveryTime = error.quotaResetTime
            ? new Date(error.quotaResetTime)
            : new Date(Date.now() + (error.quotaResetDelayMs || 3600000));
        if (typeof providerPoolManager.markProviderUnhealthyWithRecoveryTime === 'function') {
            await providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                providerType,
                providerUuid,
                recoveryTime,
                error.message,
                {
                    action: `mark_unhealthy_${mediaType}_quota_cooldown`,
                    source: `${mediaType}_request_error`,
                    metadata: {
                        statusCode: normalizeStatusCode(status),
                        model: requestedModel,
                        quotaResetDelayMs: error.quotaResetDelayMs,
                        quotaResetFormatted: error.quotaResetFormatted
                    }
                }
            );
        }
        if (typeof providerPoolManager.markModelQuotaProtected === 'function') {
            providerPoolManager.markModelQuotaProtected(providerUuid, error.rateLimitedModel || requestedModel, recoveryTime);
        }
    }
}

export async function handleImageGenerationRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    return handleImageRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, {
        action: 'generate',
        endpointPath: '/v1/images/generations'
    });
}

export async function handleImageEditRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    return handleImageRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, {
        action: 'edit',
        endpointPath: '/v1/images/edits'
    });
}

async function handleImageRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, options = {}) {
    const imageAction = options.action === 'edit' ? 'edit' : 'generate';
    const endpointPath = options.endpointPath || '/v1/images/generations';
    const originalRequestBody = await getImageRequestBody(req);
    const prompt = String(originalRequestBody?.prompt || '').trim();
    const model = String(originalRequestBody?.model || 'gpt-image-2').trim() || 'gpt-image-2';
    const n = normalizeImageRequestCount(originalRequestBody?.n);

    if (!prompt) {
        const error = new Error('prompt is required');
        error.status = 400;
        const errorResponse = createErrorResponse(error, MODEL_PROTOCOL_PREFIX.OPENAI);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, undefined, 400);
        return;
    }

    if (imageAction === 'edit' && !hasImageEditInputs(originalRequestBody)) {
        const error = new Error('image is required');
        error.status = 400;
        const errorResponse = createErrorResponse(error, MODEL_PROTOCOL_PREFIX.OPENAI);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, undefined, 400);
        return;
    }

    const requestContext = buildServiceRequestContext(req, CONFIG);
    const clientTokenId = getClientTokenId(req);
    const clientUserId = getClientUserId(req);
    const clientUserEmail = getClientUserEmail(req);
    const clientUsername = getClientUsername(req);
    const clientIp = getClientIp(req);
    const userAgent = req?.headers?.['user-agent'];
    const requestStartTime = Date.now();
    const imageItems = [];
    let created = 0;
    let lastError = null;
    let selection = {
        service,
        serviceConfig: CONFIG,
        actualProviderType: CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER,
        uuid: pooluuid,
        poolId: CONFIG.POOL_ID ?? 0
    };

    const ensureSelection = async (excludeUuids = []) => {
        if (selection.service && !providerPoolManager && excludeUuids.length === 0) return selection;
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        selection = await getApiServiceWithFallback(CONFIG, model, {
            requestContext,
            poolId: CONFIG?.POOL_ID,
            excludeUuids
        });
        if (selection?.service && typeof selection.service.setRequestContext === 'function') {
            selection.service.setRequestContext(requestContext);
        }
        return selection;
    };

    await logConversation('input', imageAction === 'edit' ? `${prompt}\n[image edit request]` : prompt, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

    for (let index = 0; index < n; index += 1) {
        let excludeUuids = [];
        let completed = false;

        while (!completed) {
            const current = await ensureSelection(excludeUuids);
            const activeService = current?.service;
            const activeProviderType = current?.actualProviderType || CONFIG.MODEL_PROVIDER;
            const activeUuid = current?.uuid || null;
            const activePoolId = current?.poolId ?? CONFIG.POOL_ID ?? 0;

            if (!activeService || typeof activeService.generateImage !== 'function') {
                const unsupportedError = new Error(`${activeProviderType} does not support ${endpointPath}`);
                unsupportedError.status = 400;
                lastError = unsupportedError;
                completed = true;
                continue;
            }

            try {
                const result = await activeService.generateImage(model, { ...originalRequestBody, prompt, model, n: 1, __image_action: imageAction }, requestContext);
                if (!created) {
                    created = Number(result?.created) || Math.floor(Date.now() / 1000);
                }
                if (Array.isArray(result?.data)) {
                    imageItems.push(...result.data.filter(item => item && typeof item === 'object'));
                }
                if (providerPoolManager && activeUuid) {
                    providerPoolManager.markProviderHealthy(activeProviderType, activeUuid);
                    providerPoolManager.recordRequestSuccess();
                    providerPoolManager.recordRequestLog({
                        providerType: activeProviderType,
                        providerUuid: activeUuid,
                        poolId: activePoolId,
                        model,
                        statusCode: 200,
                        isSuccess: true,
                        durationMs: Date.now() - requestStartTime,
                        clientIp,
                        userAgent,
                        clientTokenId,
                        userId: clientUserId,
                        userEmail: clientUserEmail,
                        username: clientUsername
                    });
                }
                completed = true;
            } catch (error) {
                lastError = error;
                const status = error.response?.status || error.status || error.statusCode || 500;
                if (providerPoolManager && activeUuid) {
                    if (error.skipErrorCount !== true) {
                        providerPoolManager.recordError(activeProviderType, activeUuid, error.message, status, model);
                    }
                    providerPoolManager.recordRequestFailure();
                    providerPoolManager.recordRequestLog({
                        providerType: activeProviderType,
                        providerUuid: activeUuid,
                        poolId: activePoolId,
                        model,
                        statusCode: status,
                        isSuccess: false,
                        errorType: buildRequestLogErrorType(error),
                        errorMessage: buildRequestLogErrorMessage(error),
                        errorStack: buildRequestLogErrorStack(error),
                        errorDetail: buildRequestLogErrorDetail(error),
                        durationMs: Date.now() - requestStartTime,
                        clientIp,
                        userAgent,
                        clientTokenId,
                        userId: clientUserId,
                        userEmail: clientUserEmail,
                        username: clientUsername
                    });
                    await markMediaErrorState(providerPoolManager, activeUuid, activeProviderType, model, error, status, 'image');
                }

                if (error.shouldSwitchCredential === true && providerPoolManager && activeUuid) {
                    excludeUuids = [...excludeUuids, activeUuid];
                    continue;
                }
                completed = true;
            }
        }
    }

    if (imageItems.length === 0) {
        const finalError = lastError || new Error('image generation failed');
        const statusCode = finalError.response?.status || finalError.status || finalError.statusCode || 500;
        const errorResponse = createErrorResponse(finalError, MODEL_PROTOCOL_PREFIX.OPENAI);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, undefined, statusCode);
        return;
    }

    await logConversation('output', `[generated ${imageItems.length} image(s)]`, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    await handleUnifiedResponse(res, JSON.stringify({
        created: created || Math.floor(Date.now() / 1000),
        data: imageItems
    }), false);
}

const XAI_VIDEO_BINDING_TTL_MS = 3 * 60 * 60 * 1000;
const xaiVideoBindings = new Map();

function pruneXaiVideoBindings(now = Date.now()) {
    for (const [videoId, binding] of xaiVideoBindings) {
        if (!binding || binding.expiresAt <= now) xaiVideoBindings.delete(videoId);
    }
}

function getXaiVideoBinding(videoId) {
    const normalized = String(videoId || '').trim();
    if (!normalized) return null;
    const binding = xaiVideoBindings.get(normalized);
    if (!binding) return null;
    if (binding.expiresAt <= Date.now()) {
        xaiVideoBindings.delete(normalized);
        return null;
    }
    return binding;
}

function bindXaiVideo(videoId, selection, model) {
    const normalized = String(videoId || '').trim();
    if (!normalized || !selection?.serviceConfig) return;
    pruneXaiVideoBindings();
    xaiVideoBindings.set(normalized, {
        serviceConfig: selection.serviceConfig,
        actualProviderType: selection.actualProviderType,
        uuid: selection.uuid,
        poolId: selection.poolId,
        model: String(model || XAI_DEFAULT_VIDEO_MODEL).trim() || XAI_DEFAULT_VIDEO_MODEL,
        expiresAt: Date.now() + XAI_VIDEO_BINDING_TTL_MS
    });
}

async function selectionFromXaiVideoBinding(binding, requestContext) {
    if (!binding?.serviceConfig) return null;
    const { getServiceAdapter } = await import('../providers/adapter.js');
    const service = getServiceAdapter(binding.serviceConfig);
    if (service && typeof service.setRequestContext === 'function') {
        service.setRequestContext(requestContext);
    }
    return {
        service,
        serviceConfig: binding.serviceConfig,
        actualProviderType: binding.actualProviderType,
        uuid: binding.uuid,
        poolId: binding.poolId,
        isBoundVideoAccount: true
    };
}

function mediaRequestLogContext(req) {
    return {
        clientTokenId: getClientTokenId(req),
        clientUserId: getClientUserId(req),
        clientUserEmail: getClientUserEmail(req),
        clientUsername: getClientUsername(req),
        clientIp: getClientIp(req),
        userAgent: req?.headers?.['user-agent']
    };
}

function recordMediaRequest(providerPoolManager, selection, model, requestStartTime, req, error = null) {
    if (!providerPoolManager || !selection?.uuid) return;
    const status = error
        ? (error.response?.status || error.status || error.statusCode || 500)
        : 200;
    const context = mediaRequestLogContext(req);
    providerPoolManager.recordRequestLog({
        providerType: selection.actualProviderType,
        providerUuid: selection.uuid,
        poolId: selection.poolId,
        model,
        statusCode: status,
        isSuccess: !error,
        errorType: error ? buildRequestLogErrorType(error) : null,
        errorMessage: error ? buildRequestLogErrorMessage(error) : null,
        errorStack: error ? buildRequestLogErrorStack(error) : null,
        errorDetail: error ? buildRequestLogErrorDetail(error) : null,
        durationMs: Date.now() - requestStartTime,
        clientIp: context.clientIp,
        userAgent: context.userAgent,
        clientTokenId: context.clientTokenId,
        userId: context.clientUserId,
        userEmail: context.clientUserEmail,
        username: context.clientUsername
    });
}

async function executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, options = {}) {
    const action = options.action || 'generate';
    const requestId = String(options.requestId || '').trim();
    const requestBody = options.requestBody && typeof options.requestBody === 'object'
        ? options.requestBody
        : {};
    const model = String(options.model || requestBody.model || XAI_DEFAULT_VIDEO_MODEL).trim() || XAI_DEFAULT_VIDEO_MODEL;
    const requestContext = buildServiceRequestContext(req, CONFIG);
    const requestStartTime = Date.now();
    const binding = requestId ? getXaiVideoBinding(requestId) : null;
    let selection = options.selection || (binding
        ? await selectionFromXaiVideoBinding(binding, requestContext)
        : {
            service: await Promise.resolve(service),
            serviceConfig: CONFIG,
            actualProviderType: CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER,
            uuid: pooluuid,
            poolId: CONFIG.POOL_ID ?? 0
        });
    let excludeUuids = [];

    const ensureSelection = async () => {
        if (selection?.isBoundVideoAccount) return selection;
        if (selection?.service && !providerPoolManager && excludeUuids.length === 0) return selection;
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        selection = await getApiServiceWithFallback(CONFIG, model, {
            requestContext,
            poolId: CONFIG?.POOL_ID,
            excludeUuids
        });
        if (selection?.service && typeof selection.service.setRequestContext === 'function') {
            selection.service.setRequestContext(requestContext);
        }
        return selection;
    };

    while (true) {
        const current = await ensureSelection();
        const activeService = current?.service;
        if (!activeService || typeof activeService.generateVideo !== 'function') {
            const error = new Error(`${current?.actualProviderType || CONFIG.MODEL_PROVIDER} does not support xAI video requests`);
            error.status = 400;
            throw error;
        }

        try {
            const result = await activeService.generateVideo(model, {
                ...requestBody,
                __video_action: action,
                __video_request_id: requestId || undefined
            }, requestContext);
            if (providerPoolManager && current.uuid) {
                providerPoolManager.markProviderHealthy(current.actualProviderType, current.uuid);
                providerPoolManager.recordRequestSuccess();
                recordMediaRequest(providerPoolManager, current, model, requestStartTime, req);
            }
            const resultVideoId = extractXaiVideoId(result) || requestId;
            if (resultVideoId) bindXaiVideo(resultVideoId, current, model);
            return { result, selection: current, model, requestContext };
        } catch (error) {
            const status = error.response?.status || error.status || error.statusCode || 500;
            if (providerPoolManager && current.uuid) {
                if (error.skipErrorCount !== true) {
                    providerPoolManager.recordError(current.actualProviderType, current.uuid, error.message, status, model);
                }
                providerPoolManager.recordRequestFailure();
                recordMediaRequest(providerPoolManager, current, model, requestStartTime, req, error);
                await markMediaErrorState(
                    providerPoolManager,
                    current.uuid,
                    current.actualProviderType,
                    model,
                    error,
                    status,
                    'video'
                );
            }

            if (
                error.shouldSwitchCredential === true
                && providerPoolManager
                && current.uuid
                && !current.isBoundVideoAccount
            ) {
                excludeUuids = [...excludeUuids, current.uuid];
                selection = null;
                continue;
            }
            throw error;
        }
    }
}

function writeOpenAIError(res, error, fallbackStatus = 500) {
    const status = error.response?.status || error.status || error.statusCode || fallbackStatus;
    const errorResponse = createErrorResponse(error, MODEL_PROTOCOL_PREFIX.OPENAI);
    return handleUnifiedResponse(res, JSON.stringify(errorResponse), false, undefined, status);
}

export async function handleVideoCreateRequest(req, res, service, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    let prepared;
    try {
        const originalRequestBody = await getImageRequestBody(req);
        prepared = buildXaiVideoCreateRequest(originalRequestBody);
    } catch (error) {
        error.status = error.status || 400;
        await writeOpenAIError(res, error, 400);
        return;
    }

    await logConversation('input', `${prepared.metadata.prompt}\n[video generation request]`, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    try {
        const { result } = await executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, {
            action: 'generate',
            model: prepared.metadata.model,
            requestBody: prepared.body
        });
        const response = buildOpenAIVideoCreateResponse(result, prepared.metadata);
        await logConversation('output', `[video task ${response.id}: ${response.status}]`, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        await handleUnifiedResponse(res, JSON.stringify(response), false);
    } catch (error) {
        await writeOpenAIError(res, error);
    }
}

export async function handleVideoRemixRequest(req, res, service, CONFIG, providerPoolManager, pooluuid, requestId) {
    let requestBody;
    try {
        requestBody = await getImageRequestBody(req);
        if (!String(requestBody.prompt || '').trim()) throw new Error('prompt is required');
    } catch (error) {
        error.status = error.status || 400;
        await writeOpenAIError(res, error, 400);
        return;
    }

    const binding = getXaiVideoBinding(requestId);
    const fallbackModel = binding?.model || XAI_DEFAULT_VIDEO_MODEL;
    try {
        const source = await executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, {
            action: 'retrieve',
            requestId,
            model: fallbackModel
        });
        const prepared = buildXaiVideoRemixRequest(requestBody, source.result, requestId, fallbackModel);
        const remix = await executeXaiVideoRequest(req, source.selection.service, CONFIG, providerPoolManager, pooluuid, {
            action: 'edit',
            requestId,
            model: prepared.metadata.model,
            requestBody: prepared.body,
            selection: {
                ...source.selection,
                isBoundVideoAccount: true
            }
        });
        const response = buildOpenAIVideoCreateResponse(remix.result, prepared.metadata);
        response.remixed_from_video_id = requestId;
        await handleUnifiedResponse(res, JSON.stringify(response), false);
    } catch (error) {
        await writeOpenAIError(res, error);
    }
}

export async function handleXaiVideoNativeRequest(req, res, service, CONFIG, providerPoolManager, pooluuid, action = 'generate') {
    let requestBody;
    try {
        requestBody = normalizeXaiVideoNativeRequest(await getImageRequestBody(req));
    } catch (error) {
        error.status = error.status || 400;
        await writeOpenAIError(res, error, 400);
        return;
    }

    try {
        const { result } = await executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, {
            action,
            model: requestBody.model,
            requestBody
        });
        await handleUnifiedResponse(res, JSON.stringify(result), false);
    } catch (error) {
        await writeOpenAIError(res, error);
    }
}

export async function handleVideoRetrieveRequest(req, res, service, CONFIG, providerPoolManager, pooluuid, requestId) {
    const binding = getXaiVideoBinding(requestId);
    const model = binding?.model || XAI_DEFAULT_VIDEO_MODEL;
    try {
        const { result } = await executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, {
            action: 'retrieve',
            requestId,
            model
        });
        const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const output = requestUrl.searchParams.get('format') === 'xai'
            ? result
            : buildOpenAIVideoRetrieveResponse(requestId, result, model);
        await handleUnifiedResponse(res, JSON.stringify(output), false);
    } catch (error) {
        await writeOpenAIError(res, error);
    }
}

function videoDownloadHeaders(headers = {}) {
    const allowed = new Set([
        'content-type',
        'content-length',
        'content-disposition',
        'cache-control',
        'etag',
        'last-modified',
        'accept-ranges'
    ]);
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        if (allowed.has(String(name).toLowerCase()) && value !== undefined && value !== null) {
            result[name] = value;
        }
    }
    if (!Object.keys(result).some(name => name.toLowerCase() === 'content-type')) {
        result['Content-Type'] = 'application/octet-stream';
    }
    return result;
}

export async function handleVideoContentRequest(req, res, service, CONFIG, providerPoolManager, pooluuid, requestId) {
    const binding = getXaiVideoBinding(requestId);
    const model = binding?.model || XAI_DEFAULT_VIDEO_MODEL;
    try {
        const execution = await executeXaiVideoRequest(req, service, CONFIG, providerPoolManager, pooluuid, {
            action: 'retrieve',
            requestId,
            model
        });
        const videoUrl = extractXaiVideoUrl(execution.result);
        if (typeof execution.selection?.service?.downloadVideo !== 'function') {
            const error = new Error('Selected provider does not support video downloads');
            error.status = 400;
            throw error;
        }
        const download = await execution.selection.service.downloadVideo(videoUrl);
        res.writeHead(download.status || 200, videoDownloadHeaders(download.headers));
        await new Promise((resolve, reject) => {
            download.stream.once('error', reject);
            res.once('finish', resolve);
            res.once('close', resolve);
            download.stream.pipe(res);
        });
    } catch (error) {
        if (res.headersSent) {
            res.destroy(error);
            return;
        }
        await writeOpenAIError(res, error, 502);
    }
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    // 开始请求追踪
    const traceId = requestTracer.startTrace(req, {
        provider: CONFIG.MODEL_PROVIDER,
        poolId: CONFIG.POOL_ID,
        endpointType
    });

    // 请求解析阶段
    requestTracer.startPhase(traceId, TRACE_PHASE.REQUEST_PARSE);
    const originalRequestBody = await getRequestBody(req);
    if (!originalRequestBody) {
        requestTracer.endPhase(traceId, TRACE_PHASE.REQUEST_PARSE, 'missing body');
        requestTracer.endTrace(traceId, { success: false, statusCode: 400, error: 'missing body' });
        throw new Error("Request body is missing for content generation.");
    }
    requestTracer.endPhase(traceId, TRACE_PHASE.REQUEST_PARSE);

    // 记录 tool_use 相关的请求（用于调试 Claude Code Write 工具问题）
    if (global.DEBUG_TOOL_USE) {
        let toolUseCount = 0;
        let toolResultCount = 0;
        let toolErrorCount = 0;
        for (const message of originalRequestBody.messages || []) {
            for (const content of Array.isArray(message.content) ? message.content : []) {
                if (content.type === 'tool_use') toolUseCount++;
                if (content.type === 'tool_result') {
                    toolResultCount++;
                    if (content.is_error) toolErrorCount++;
                }
            }
        }
        if (toolUseCount || toolResultCount) {
            console.log(`[Tool Debug] toolUses=${toolUseCount}, toolResults=${toolResultCount}, errors=${toolErrorCount}`);
        }
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.OPENAI_RESPONSES_COMPACT]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    let actualPoolId = CONFIG.POOL_ID ?? 0;  // 声明 poolId 变量

    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    console.log(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;
    let runtimeConfig = CONFIG;
    const requestContext = buildServiceRequestContext(req, CONFIG);
    const sessionIdForSelection = concurrencyLimiter.extractSessionId(originalRequestBody, req);
    if (sessionIdForSelection) {
        requestContext.sessionId = sessionIdForSelection;
    }
    const isProviderUserForPool = isProviderUser(req);

    if (getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE && toProvider === MODEL_PROVIDER.OPENAI_XAI) {
        const xaiChannelDefaults = await getXaiChannelDefaults();
        const mappedModel = mapXaiClaudeCompatModel(model, xaiChannelDefaults);
        console.log('[xAI Claude Compat] Decision:', JSON.stringify({
            requestedModel: model,
            mappedModel,
            fromProvider,
            toProvider,
            path: req?.url || null
        }));
        if (mappedModel !== model) {
            console.log(`[xAI Claude Compat] Model mapping: ${model} -> ${mappedModel}`);
            model = mappedModel;
        }
    }

    // 2.5. 如果使用了提供商池,根据模型严格选择配置内的提供商
    if (!service || providerPoolManager) {
        // 号池选择阶段追踪
        requestTracer.startPhase(traceId, TRACE_PHASE.POOL_SELECT);
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, {
            isProviderUser: isProviderUserForPool,
            sessionId: sessionIdForSelection,
            requestContext
        });
        requestTracer.endPhase(traceId, TRACE_PHASE.POOL_SELECT);

        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;
        runtimeConfig = result.serviceConfig || CONFIG;
        actualPoolId = result.poolId ?? CONFIG.POOL_ID ?? 0;  // 获取 poolId

        // 更新追踪元数据
        requestTracer.updateMetadata(traceId, {
            model,
            provider: toProvider
        });

        // 正常情况下 AccountHub 不做模型 fallback；保留兼容字段处理旧 adapter 返回。
        if (result.actualModel && result.actualModel !== model) {
            console.log(`[Content Generation] Adapter returned actual model: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
            requestTracer.updateMetadata(traceId, { model });
        }

        console.log(`[Content Generation] Selected service adapter based on model: ${model}`);

        // 获取并发控制配置
        const poolConcurrencyConfig = result.poolConcurrencyConfig || {};
        const _isProviderUser = isProviderUser(req);

        // 根据用户类型选择对应的并发限制配置
        const enableConcurrencyCheck = _isProviderUser
            ? poolConcurrencyConfig.enableProviderConcurrencyLimit
            : poolConcurrencyConfig.enableUserConcurrencyLimit;
        const maxConcurrency = _isProviderUser
            ? poolConcurrencyConfig.providerMaxConcurrency
            : poolConcurrencyConfig.userMaxConcurrency;

        // 用户/代理商 key 级别并发检查
        if (enableConcurrencyCheck && maxConcurrency > 0) {
            const clientTokenId = getClientTokenId(req);
            const clientIp = getClientIp(req);
            const userKey = concurrencyLimiter.getUserKey(clientTokenId, clientIp);

            if (userKey) {
                const currentUserConcurrency = await concurrencyLimiter.getUserConcurrency(userKey);
                if (currentUserConcurrency >= maxConcurrency) {
                    const userTypeLabel = _isProviderUser ? 'Provider' : 'User';
                    console.log(`[Concurrency] ${userTypeLabel} limit exceeded (${currentUserConcurrency}/${maxConcurrency})`);
                    requestTracer.endTrace(traceId, { success: false, statusCode: 429, error: `${userTypeLabel} concurrency limit exceeded` });
                    const error = new Error(`并发请求超限，当前最多允许 ${maxConcurrency} 个并发请求`);
                    error.statusCode = 429;
                    error.type = 'concurrency_limit';
                    throw error;
                }
            }
        }

        // Session 级别并发检查（基于 metadata.user_id 中的 sessionId）
        if (poolConcurrencyConfig.enableSessionLimit && poolConcurrencyConfig.maxSessionsPerAccount > 0 && actualUuid) {
            const sessionId = concurrencyLimiter.extractSessionId(originalRequestBody, req);
            if (sessionId) {
                const { allowed, current } = await concurrencyLimiter.checkAndTrackSession(
                    actualUuid, sessionId, poolConcurrencyConfig.maxSessionsPerAccount
                );
                if (!allowed) {
                    console.log(`[Session] Account session limit exceeded (${current}/${poolConcurrencyConfig.maxSessionsPerAccount})`);
                    requestTracer.endTrace(traceId, { success: false, statusCode: 429, error: 'Session limit exceeded' });
                    const error = new Error(`会话数超限，单账号最多允许 ${poolConcurrencyConfig.maxSessionsPerAccount} 个并发会话`);
                    error.statusCode = 429;
                    error.type = 'session_limit';
                    throw error;
                }
            }
        }
    }

    if (service && typeof service.setRequestContext === 'function') {
        service.setRequestContext(requestContext);
    }

    // 1. Convert request body from client format to backend format, if necessary.
    // 请求构建阶段追踪
    requestTracer.startPhase(traceId, TRACE_PHASE.REQUEST_BUILD);
    let processedRequestBody = originalRequestBody;
    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
        console.log(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        processedRequestBody = convertData(originalRequestBody, 'request', fromProvider, toProvider);
    } else {
        console.log(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);
    // Internal routing flag for providers that need a dedicated compact endpoint.
    if (endpointType === ENDPOINT_TYPE.OPENAI_RESPONSES_COMPACT) {
        processedRequestBody.__remote_compact = true;
    }

    // 将 traceId 注入到请求的 metadata 中，供下游追踪使用
    if (!processedRequestBody.metadata) {
        processedRequestBody.metadata = {};
    }
    processedRequestBody.metadata.traceId = traceId;

    requestTracer.endPhase(traceId, TRACE_PHASE.REQUEST_BUILD);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

    // 5. Call the appropriate stream or unary handler, passing the provider info.
    // 创建重试上下文，包含 CONFIG 以便在认证错误时切换凭证重试
    // 凭证切换重试次数（默认 5），可在配置中自定义更大的值
    // 注意：这与底层的 429/5xx 重试（REQUEST_MAX_RETRIES）是不同层次的重试机制
    // - 底层重试：同一凭证遇到 429/5xx 时的重试
    // - 凭证切换重试：凭证被标记不健康后切换到其他凭证
    // 当没有不同的健康凭证可用时，重试会自动停止
    const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
    const retryContext = providerPoolManager
        ? {
            CONFIG: runtimeConfig,
            currentRetry: 0,
            maxRetries: credentialSwitchMaxRetries,
            traceId,
            requestContext,
            sessionId: sessionIdForSelection,
            isProviderUser: isProviderUserForPool,
            poolId: actualPoolId,
            queueLockOptions: resolveAccountQueueLockOptions(toProvider, runtimeConfig)
        }
        : null;

    // 并发计数：获取用户和账号的并发槽位
    const clientTokenId = getClientTokenId(req);
    const clientIp = getClientIp(req);
    const clientUsername = getClientUsername(req);
    const userKey = concurrencyLimiter.getUserKey(clientTokenId, clientIp);
    const requestId = traceId; // 使用 traceId 作为请求唯一标识
    let trackingReady = false;
    let queueLockToken = null;

    const queueLockOptions = resolveAccountQueueLockOptions(toProvider, runtimeConfig);
    if (queueLockOptions.enabled && actualUuid) {
        const queueLockResult = await concurrencyLimiter.acquireAccountQueueLock(actualUuid, requestId, queueLockOptions);
        if (!queueLockResult?.acquired) {
            const queueError = new Error(`账号请求排队超时（${queueLockResult?.waitMs || queueLockOptions.waitTimeoutMs}ms）`);
            queueError.statusCode = 429;
            queueError.type = 'account_queue_timeout';
            throw queueError;
        }
        queueLockToken = queueLockResult.token || null;
    }

    try {
        // 增加并发计数
        if (userKey) {
            await concurrencyLimiter.incrementUserConcurrency(userKey);
        }
        if (actualUuid) {
            await concurrencyLimiter.incrementAccountConcurrency(actualUuid);
        }
        // 记录追踪信息，用于请求结束时释放
        const sessionId = concurrencyLimiter.extractSessionId(originalRequestBody, req);
        await concurrencyLimiter.startTracking(requestId, userKey, actualUuid, {
            tokenId: clientTokenId,
            username: clientUsername,
            clientIp: clientIp,
            model: model,
            sessionId: sessionId || null,
            queueLockToken
        });
        trackingReady = true;
    } catch (setupError) {
        if (queueLockToken && actualUuid) {
            await concurrencyLimiter.releaseAccountQueueLock(actualUuid, queueLockToken);
        }
        throw setupError;
    }

    try {
        let streamStats = null;
        if (isStream) {
            streamStats = await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext, req, actualPoolId);
        } else {
            await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext, req, actualPoolId);
        }
        // 检查流式请求是否在内部处理了错误（没有抛出但返回了失败状态）
        if (streamStats && streamStats.success === false) {
            // 请求失败完成追踪
            requestTracer.endTrace(traceId, {
                success: false,
                statusCode: streamStats.statusCode || 500,
                error: 'stream_request_failed',
                inputTokens: streamStats.inputTokens || 0,
                outputTokens: streamStats.outputTokens || 0
            });
        } else {
            // 请求成功完成追踪，包含 token 统计、缓存和 credit 信息
            requestTracer.endTrace(traceId, {
                success: true,
                statusCode: 200,
                inputTokens: streamStats?.inputTokens || 0,
                outputTokens: streamStats?.outputTokens || 0,
                cacheCreationTokens: streamStats?.cacheCreationTokens || 0,
                cacheReadTokens: streamStats?.cacheReadTokens || 0,
                creditUsage: streamStats?.creditUsage || null
            });
        }
    } catch (error) {
        // 请求失败完成追踪
        requestTracer.endTrace(traceId, { success: false, statusCode: getErrorStatusCode(error, 500), error: 'request_failed' });
        // 释放并发槽位
        if (trackingReady) {
            await concurrencyLimiter.releaseSlots(requestId);
        }
        throw error;
    }

    // 释放并发槽位（正常完成）
    if (trackingReady) {
        await concurrencyLimiter.releaseSlots(requestId);
    }

    // 记录 Potluck 用量（如果使用 Potluck Key）
    if (CONFIG.potluckApiKey) {
        try {
            await incrementUsage(CONFIG.potluckApiKey);
        } catch (e) {
            console.error('[Potluck] Failed to record usage:', e.message);
        }
    }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(_config, requestBody, _toProvider) {
    return requestBody;
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

export function handleError(res, error, provider = null) {
    const statusCode = getErrorStatusCode(error, 500);
    let errorMessage = sanitizeErrorMessage(error.message, statusCode);
    let suggestions = [];

    // 仅在没有传入错误信息时，才使用默认消息；否则只添加建议
    const hasOriginalMessage = error.message && error.message.trim() !== '';

    // 根据提供商获取适配的错误信息和建议
    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);

    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            if (!hasOriginalMessage) errorMessage = '认证失败，请检查凭证';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            if (!hasOriginalMessage) errorMessage = '权限不足，访问被拒绝';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            if (!hasOriginalMessage) errorMessage = '请求过于频繁，请稍后重试';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            if (!hasOriginalMessage) errorMessage = '上游服务暂时不可用，请稍后重试';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (!hasOriginalMessage) {
                if (statusCode >= 400 && statusCode < 500) {
                    errorMessage = `客户端请求错误（${statusCode}）`;
                    suggestions = providerSuggestions.clientError;
                } else if (statusCode >= 500) {
                    errorMessage = `服务端错误（${statusCode}）`;
                    suggestions = providerSuggestions.serverError;
                }
            }
    }

    console.error(`[Server] Request failed (${statusCode})`, {
        name: error?.name,
        code: error?.code
    });
    if (suggestions.length > 0) {
        console.error('[Server] Suggestions:');
        suggestions.forEach((suggestion, index) => {
            console.error(`  ${index + 1}. ${suggestion}`);
        });
    }

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    const errorPayload = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions
        }
    };
    res.end(JSON.stringify(errorPayload));
}

/**
 * 根据提供商类型获取适配的错误建议
 * @param {number} statusCode - HTTP 状态码
 * @param {string|null} provider - 提供商类型
 * @returns {Object} 包含各类错误建议的对象
 */
function _getProviderSpecificSuggestions(statusCode, provider) {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;

    // 默认/通用建议
    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };

    // 根据提供商返回特定建议
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };

        case MODEL_PROTOCOL_PREFIX.OLLAMA:
            return {
                auth: [
                    'Ollama typically does not require authentication',
                    'If using a custom setup, verify your credentials',
                    'Check if the Ollama server requires authentication'
                ],
                permission: [
                    'Verify the Ollama server is accessible',
                    'Check if the requested model is available locally',
                    'Ensure the Ollama server allows the requested operation'
                ],
                rateLimit: [
                    'The local Ollama server may be overloaded',
                    'Try reducing concurrent requests',
                    'Consider increasing server resources if running locally'
                ],
                serverError: [
                    'Check if the Ollama server is running',
                    'Verify the server address and port are correct',
                    'Check Ollama server logs for detailed error information'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is available in your Ollama installation',
                    'Try pulling the model first with: ollama pull <model-name>'
                ]
            };

        default:
            return defaultSuggestions;
    }
}

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        default:
            console.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}

function _firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function _parseJsonObject(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (Buffer.isBuffer(value)) {
        try {
            value = value.toString('utf8');
        } catch {
            return null;
        }
    }
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function _normalizeResponsesError(error, statusCode, fallbackMessage) {
    const numericStatus = Number(statusCode);
    const resolvedStatus = Number.isFinite(numericStatus) ? numericStatus : 500;
    const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';

    const payload = _parseJsonObject(error?.response?.data)
        || _parseJsonObject(error?.data)
        || _parseJsonObject(error?.rawData);

    const payloadCode = _firstNonEmptyString(
        payload?.error?.code,
        payload?.response?.error?.code,
        payload?.response?.status_details?.error?.code,
        payload?.response?.status_details?.type
    );

    const payloadMessage = _firstNonEmptyString(
        payload?.error?.message,
        payload?.response?.error?.message,
        payload?.response?.status_details?.error?.message,
        payload?.message
    );

    const extractedCode = _firstNonEmptyString(
        error?.upstreamCode,
        payloadCode
    );

    const extractedMessage = _firstNonEmptyString(
        error?.upstreamMessage,
        payloadMessage
    );

    const textForInference = `${rawMessage} ${extractedMessage}`.toLowerCase();

    const normalizeCode = (value) => {
        const normalized = (value || '')
            .toLowerCase()
            .replace(/[^\w.-]+/g, '_')
            .replace(/^_+|_+$/g, '');

        const alias = {
            overloaded_error: 'rate_limit_exceeded',
            server_error: 'rate_limit_exceeded',
            internal_error: 'rate_limit_exceeded',
            context_window_exceeded: 'context_length_exceeded',
            quota_exceeded: 'insufficient_quota',
            usage_limit_reached: 'insufficient_quota',
            billing_hard_limit_reached: 'insufficient_quota',
            rate_limited: 'rate_limit_exceeded',
            rate_limit: 'rate_limit_exceeded',
            too_many_requests: 'rate_limit_exceeded',
            bad_request: 'invalid_prompt',
            invalid_request_error: 'invalid_prompt',
            token_invalidated: 'invalid_prompt',
            invalid_api_key: 'invalid_prompt',
            authentication_error: 'invalid_prompt',
            permission_error: 'invalid_prompt',
            unauthorized: 'invalid_prompt',
            forbidden: 'invalid_prompt',
            slow_down: 'rate_limit_exceeded'
        };

        return alias[normalized] || normalized;
    };

    let canonicalCode = normalizeCode(extractedCode);

    if (
        /context window|context length|max(?:imum)? context|token limit|too many tokens|input exceeds/.test(textForInference)
    ) {
        canonicalCode = 'context_length_exceeded';
    } else if (
        /usage not included|not included in your plan|upgrade to plus|upgrade your plan/.test(textForInference)
    ) {
        canonicalCode = 'usage_not_included';
    } else if (
        /insufficient quota|quota|billing|credit|hard limit/.test(textForInference)
    ) {
        canonicalCode = 'insufficient_quota';
    } else if (
        /rate limit|too many requests|try again in|tpm|rpm/.test(textForInference)
    ) {
        canonicalCode = 'rate_limit_exceeded';
    } else if (
        /overloaded|high demand|slow down|at capacity|temporarily unavailable/.test(textForInference)
    ) {
        canonicalCode = 'rate_limit_exceeded';
    } else if (
        /invalid prompt|invalid request|safety reasons|unsupported|bad request/.test(textForInference)
    ) {
        canonicalCode = 'invalid_prompt';
    }

    if (!canonicalCode) {
        if (resolvedStatus === 402) {
            canonicalCode = 'insufficient_quota';
        } else if (resolvedStatus === 429) {
            canonicalCode = 'rate_limit_exceeded';
        } else if (resolvedStatus >= 500) {
            canonicalCode = 'rate_limit_exceeded';
        } else {
            canonicalCode = 'invalid_prompt';
        }
    }

    const finalMessage = (extractedMessage || fallbackMessage || '').slice(0, 1000);

    // Include a bounded retry hint for clients that surface only the SSE message.
    const isRetryableCode = canonicalCode === 'rate_limit_exceeded';
    const alreadyHasRetryHint = /try again in/i.test(finalMessage);
    const retryHint = (isRetryableCode && !alreadyHasRetryHint) ? '. Try again in 5s' : '';

    const resultMessage = (finalMessage || 'Request failed.') + retryHint;

    return {
        code: canonicalCode,
        message: resultMessage
    };
}


/**
 * 创建符合 fromProvider 格式的错误响应（非流式）
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {Object} 格式化的错误响应对象
 */
function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = getErrorStatusCode(error, 500);
    const errorMessage = sanitizeErrorMessage(error.message, statusCode);

    // 根据 HTTP 状态码映射错误类型
    // 对于可重试的错误（402/429/5xx），返回 overloaded_error 让 Claude Code 自动重试
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        // 402 配额耗尽、429 限流、5xx 服务器错误 -> overloaded_error（触发客户端自动重试）
        if (code === 402 || code === 429 || code === 529) return 'overloaded_error';
        if (code >= 500 && code < 600) return 'overloaded_error';
        return 'invalid_request_error';
    };

    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 非流式错误格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI 使用 code 字段作为核心判断
                }
            };

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            const responsesError = _normalizeResponsesError(error, statusCode, errorMessage);
            // OpenAI Responses API 非流式错误格式
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: responsesError.message,
                    code: responsesError.code
                }
            };

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 非流式错误格式（外层有 type 标记）
            return {
                type: "error",  // 核心区分标记
                error: {
                    type: getErrorType(statusCode),  // Claude 使用 error.type 作为核心判断
                    message: errorMessage
                }
            };

        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 非流式错误格式（遵循 Google Cloud 标准）
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)  // Gemini 使用 status 作为核心判断
                }
            };

        default:
            // 默认使用 OpenAI 格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * 创建符合 fromProvider 格式的流式错误响应
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {string} 格式化的流式错误响应字符串
 */
function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = getErrorStatusCode(error, 500);
    const errorMessage = sanitizeErrorMessage(error.message, statusCode);

    // 根据 HTTP 状态码映射错误类型
    // 对于可重试的错误（402/429/5xx），返回 overloaded_error 让 Claude Code 自动重试
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        // 402 配额耗尽、429 限流、5xx 服务器错误 -> overloaded_error（触发客户端自动重试）
        if (code === 402 || code === 429 || code === 529) return 'overloaded_error';
        if (code >= 500 && code < 600) return 'overloaded_error';
        return 'invalid_request_error';
    };

    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 流式错误格式（SSE data 块）
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // Emit the standard Responses API failure event.
            const responsesStreamError = _normalizeResponsesError(error, statusCode, errorMessage);
            const responseId = `resp_${Date.now()}`;
            const responsesError = {
                type: 'response.failed',
                sequence_number: 1,
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'failed',
                    background: false,
                    error: {
                        code: responsesStreamError.code,
                        message: responsesStreamError.message
                    },
                    usage: null,
                    user: null,
                    metadata: {}
                }
            };
            return `event: response.failed\ndata: ${JSON.stringify(responsesError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 流式错误格式（SSE event + data）
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 流式错误格式
            // 注意：虽然 Gemini 原生使用 JSON 数组，但在我们的实现中已经转换为 SSE 格式
            // 所以这里也需要使用 data: 前缀，保持与正常流式响应一致
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;

        default:
            // 默认使用 OpenAI SSE 格式
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}
