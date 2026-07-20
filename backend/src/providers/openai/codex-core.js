import axios from 'axios';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { getProviderModels } from '../provider-models.js';
import { loadCredentialsFromConfig, updateCredentialsById, loadCredentialsById } from '../../services/oauth-credentials-store.js';
import { withDeduplication } from '../../utils/file-lock.js';
import { withDbLock } from '../../utils/db-lock.js';
import { isDatabaseInitialized } from '../../config/database.js';
import { isRetryableNetworkError } from '../../utils/common.js';
import { getRedisClient, isRedisAvailable } from '../../services/redis-client.js';
import { generateCodexWebImage, resolveCodexImageGenerationConfig } from './codex-image-web.js';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com';
const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CODEX_BROWSER_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

function resolveTerminalUserAgentToken() {
    const termProgram = String(process.env.TERM_PROGRAM || '').trim();
    const termVersion = String(process.env.TERM_PROGRAM_VERSION || '').trim();
    if (!termProgram) return 'unknown_terminal';
    if (!termVersion) return termProgram;
    return `${termProgram}/${termVersion}`;
}

function buildDefaultCodexUserAgent(version) {
    const osName = process.platform === 'darwin'
        ? 'Mac OS'
        : process.platform === 'win32'
            ? 'Windows'
            : 'Linux';
    return `codex_cli_rs/${version} (${osName} ${os.release()}; ${process.arch}) ${resolveTerminalUserAgentToken()}`;
}

const CODEX_DEFAULT_VERSION = '0.144.0';
const CODEX_DEFAULT_USER_AGENT = buildDefaultCodexUserAgent(CODEX_DEFAULT_VERSION);

const CODEX_MODEL_ALIASES = {
    'gpt-5': 'gpt-5-codex',
    'gpt-5.1': 'gpt-5.1-codex',
    'gpt-5.2': 'gpt-5.2-codex',
    'gpt-5.3': 'gpt-5.3-codex',
    'gpt-5.4-codex': 'gpt-5.4-codex'
};
const CODEX_FUTURE_MODEL_PATTERN = /^gpt-\d+(?:\.\d+)?(?:-(?:mini|nano|codex|codex-mini|codex-max|codex-compact|codex-spark|openai-compact|sol|terra|luna))?$/i;

const CODEX_MODELS = getProviderModels('openai-codex');
const CODEX_IMAGE_MODEL_IDS = new Set(['gpt-image-1', 'gpt-image-2']);
const CODEX_MODEL_LIST = CODEX_MODELS.map(id => ({
    id,
    object: 'model',
    created: 1770307200,
    owned_by: 'openai'
}));

const CODEX_REFRESH_REDIS_WAIT_MS = 200;
const CODEX_REFRESH_REDIS_POLL_MS = 40;
const CODEX_REFRESH_REDIS_TTL_MS = 15000;

function decodeJwtClaims(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    try {
        const raw = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

function parseBooleanLike(rawValue, defaultValue = false) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return defaultValue;
    }
    if (typeof rawValue === 'boolean') {
        return rawValue;
    }
    if (typeof rawValue === 'number') {
        return rawValue !== 0;
    }
    if (typeof rawValue === 'string') {
        const normalized = rawValue.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function extractAccountId(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const authClaims = claims['https://api.openai.com/auth'];
    if (!authClaims || typeof authClaims !== 'object') return null;
    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

function extractEmail(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const email = claims.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
}

/**
 * 从响应头解析 retry-after，返回恢复时间戳 (ms)
 * 支持秒数 (retry-after: 120) 和日期 (retry-after: Thu, 01 Jan 2026 00:00:00 GMT)
 * 同时检查 x-ratelimit-reset-requests / x-ratelimit-reset-tokens
 */
function parseRetryAfterMs(headers) {
    if (!headers) return 0;

    const now = Date.now();
    const SKEW_MS = 5000;

    const parseResetAt = (value, allowDelaySeconds = false) => {
        if (value === undefined || value === null || value === '') return 0;
        const raw = String(value).trim();
        if (!raw) return 0;

        let resetAt = 0;
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) {
            if (numeric > 1e12) {
                resetAt = Math.trunc(numeric); // epoch ms
            } else if (numeric > 1e9) {
                resetAt = Math.trunc(numeric * 1000); // epoch s
            } else if (allowDelaySeconds) {
                resetAt = now + Math.trunc(numeric * 1000); // delay s
            }
        }

        if (!resetAt) {
            const date = new Date(raw);
            if (!isNaN(date.getTime())) {
                resetAt = date.getTime();
            }
        }

        if (!resetAt) return 0;
        if (resetAt <= now + SKEW_MS) return 0;
        return resetAt;
    };

    const retryAfterResetAt = parseResetAt(headers['retry-after'], true);
    if (retryAfterResetAt > 0) {
        return retryAfterResetAt;
    }

    const candidates = [];
    for (const key of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
        const resetAt = parseResetAt(headers[key], false);
        if (resetAt > 0) candidates.push(resetAt);
    }

    if (candidates.length > 0) {
        return Math.max(...candidates);
    }

    return 0;
}

function stringifyErrorPayload(payload) {
    if (payload === null || payload === undefined) return '';
    if (typeof payload === 'string') return payload;
    if (Buffer.isBuffer(payload)) return payload.toString('utf8');
    try {
        return JSON.stringify(payload);
    } catch (error) {
        return String(payload);
    }
}

function isQuotaExhaustedStatus(status, headers, data, message) {
    if (status === 402) {
        return true;
    }

    const text = `${message || ''}\n${stringifyErrorPayload(data)}`.toLowerCase();
    const explicitQuotaPatterns = [
        /insufficient[_\s-]?quota/,
        /quota\s*(exceeded|exhausted|depleted|reached)/,
        /usage\s*limit\s*(exceeded|reached|hit)/,
        /credit\s*(exhausted|insufficient|depleted)/,
        /payment\s*required/,
        /billing\s*(required|limit|quota|exceeded)/,
        /额度\s*(耗尽|不足|用完)/
    ];
    if (explicitQuotaPatterns.some((pattern) => pattern.test(text))) {
        return true;
    }

    if (status === 429) {
        const resetAtMs = parseRetryAfterMs(headers);
        return resetAtMs > 0;
    }

    return false;
}

function isExplicitUnauthorizedStatus(status, headers, data, message) {
    if (status !== 401) {
        return false;
    }

    const authHeader = String(headers?.['www-authenticate'] || headers?.['WWW-Authenticate'] || '').toLowerCase();
    if (/invalid[_\s-]?token/.test(authHeader)) {
        return true;
    }

    const text = `${message || ''}\n${stringifyErrorPayload(data)}`.toLowerCase();
    const quotaPatterns = [
        /insufficient[_\s-]?quota/,
        /quota\s*(exceeded|exhausted|depleted|reached)/,
        /payment\s*required/,
        /billing\s*(required|quota|limit|exceeded)/,
        /额度\s*(耗尽|不足|用完)/
    ];
    if (quotaPatterns.some((pattern) => pattern.test(text))) {
        return false;
    }

    const unauthorizedPatterns = [
        /invalid[_\s-]?token/,
        /invalid[_\s-]?api[_\s-]?key/,
        /token\s*(is\s*)?(invalid|expired|revoked|missing|malformed)/,
        /unauthorized/,
        /authentication\s*(failed|invalid|required)/
    ];
    return unauthorizedPatterns.some((pattern) => pattern.test(text));
}

function markQuotaCooldownError(error, status, headers, defaultDelayMs) {
    const resetAtMs = parseRetryAfterMs(headers) || (Date.now() + defaultDelayMs);
    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.isQuotaCooldown = true;
    error.quotaResetTime = new Date(resetAtMs).toISOString();
    error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
    error.quotaResetFormatted = new Date(resetAtMs).toISOString();
    error.message = `Codex 账号额度耗尽(${status})，预计 ${new Date(resetAtMs).toISOString()} 恢复`;
    return resetAtMs;
}

function markPermanentCredentialError(error, status, data, message) {
    const detail = `${message || ''} ${stringifyErrorPayload(data)}`
        .replace(/\s+/g, ' ')
        .trim();
    const suffix = detail ? ` | ${detail.slice(0, 240)}` : '';

    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.shouldDeleteCredential = true;
    error.isAuthCredentialIssue = true;
    error.isQuotaCooldown = false;
    delete error.quotaResetTime;
    delete error.quotaResetDelayMs;
    delete error.quotaResetFormatted;
    error.message = `Codex 账号已失效(${status})，已标记删除并切换账号${suffix}`;
}

function isModelScopedUnavailableStatus(status, data, message) {
    if (![400, 403, 404].includes(Number(status))) {
        return false;
    }

    const text = `${message || ''}\n${stringifyErrorPayload(data)}`.toLowerCase();
    const patterns = [
        /model[_\s-]?not[_\s-]?found/,
        /unsupported[_\s-]?model/,
        /invalid[_\s-]?model/,
        /unknown[_\s-]?model/,
        /model.*does not exist/,
        /model.*not found/,
        /model.*not available/,
        /model.*not supported/,
        /not have access to model/,
        /access to model.*denied/,
        /该模型.*不存在/,
        /模型.*不存在/,
        /模型.*不可用/,
        /模型.*不支持/
    ];
    return patterns.some((pattern) => pattern.test(text));
}

function isProviderScopeMissingStatus(data, message) {
    const text = `${message || ''}\n${stringifyErrorPayload(data)}`;
    return /provider\s+[0-9a-f-]{36}\s+not\s+found\s+in\s+selected\s+scope/i.test(text);
}

function markScopeMissingCredentialError(error, status, data, message) {
    const detail = `${message || ''} ${stringifyErrorPayload(data)}`
        .replace(/\s+/g, ' ')
        .trim();
    const suffix = detail ? ` | ${detail.slice(0, 240)}` : '';

    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.shouldDeleteCredential = true;
    error.isAuthCredentialIssue = true;
    error.isQuotaCooldown = false;
    delete error.quotaResetTime;
    delete error.quotaResetDelayMs;
    delete error.quotaResetFormatted;
    error.message = `Codex 账号作用域失效(${status || 500})，已标记删除并切换账号${suffix}`;
}

function markModelScopedUnavailableError(error, status, data, message, model, defaultDelayMs = 3600000) {
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    error.isModelUnavailableScoped = true;
    error.rateLimitedModel = model || error.rateLimitedModel || null;
    delete error.quotaResetTime;
    delete error.quotaResetDelayMs;
    delete error.quotaResetFormatted;
}

function markAuthCredentialIssue(error, status, message) {
    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.isAuthCredentialIssue = true;
    if (!error.message && message) {
        error.message = message;
    }
}

async function tryAcquireRedisLock(lockKey, { waitTimeoutMs = CODEX_REFRESH_REDIS_WAIT_MS, pollMs = CODEX_REFRESH_REDIS_POLL_MS, ttlMs = CODEX_REFRESH_REDIS_TTL_MS } = {}) {
    if (!isRedisAvailable()) {
        return { mode: 'none', acquired: false, token: null };
    }
    const redis = getRedisClient();
    if (!redis) {
        return { mode: 'none', acquired: false, token: null };
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const start = Date.now();

    while (Date.now() - start <= waitTimeoutMs) {
        try {
            const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
            if (result === 'OK') {
                return { mode: 'redis', acquired: true, token };
            }
        } catch (error) {
            return { mode: 'redis', acquired: false, token: null, error };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return { mode: 'redis', acquired: false, token: null };
}

async function releaseRedisLock(lockKey, token) {
    if (!lockKey || !token || !isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;
    const lua = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
    `;
    try {
        await redis.eval(lua, 1, lockKey, token);
    } catch {
        // ignore
    }
}

/**
 * 检测 refresh token 是否已被使用（reused）
 * axios error.message 不包含 response body，必须同时检查 response.data
 */
function isRefreshTokenReused(err) {
    const pattern = /refresh_token_reused|already been used/i;
    // 检查 error.message
    if (pattern.test(err.message || '')) return true;
    // 检查 axios response body（关键！axios error.message 只有 "Request failed with status code 400"）
    const data = err.response?.data;
    if (data) {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        if (pattern.test(text)) return true;
    }
    return false;
}

function normalizeCredentials(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            accessToken: '',
            refreshToken: '',
            accountId: '',
            email: '',
            expiresAt: '',
            lastRefresh: ''
        };
    }
    return {
        accessToken: raw.accessToken || raw.access_token || '',
        refreshToken: raw.refreshToken || raw.refresh_token || '',
        accountId: raw.accountId || raw.account_id || '',
        email: raw.email || '',
        expiresAt: raw.expiresAt || raw.expires_at || raw.expired || '',
        lastRefresh: raw.lastRefresh || raw.last_refresh || ''
    };
}

function parseExpiry(expiresAt) {
    if (!expiresAt) return null;
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.getTime();
}

function normalizeCodexModel(model) {
    if (!model || typeof model !== 'string') return model;
    const trimmedModel = model.trim();
    return CODEX_MODEL_ALIASES[trimmedModel] || trimmedModel;
}

function isKnownCodexModel(model) {
    if (typeof model !== 'string') return false;
    const trimmedModel = model.trim();
    if (!trimmedModel) return false;
    return CODEX_MODELS.includes(trimmedModel) || CODEX_FUTURE_MODEL_PATTERN.test(trimmedModel);
}

function createInvalidCodexModelError(model) {
    const error = new Error(`Codex 渠道不支持模型 ${model}`);
    error.status = 400;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = false;
    error.isUserModelValidationError = true;
    return error;
}

function normalizeCodexServiceTier(serviceTier) {
    if (serviceTier === undefined || serviceTier === null) return undefined;
    if (typeof serviceTier === 'boolean') {
        return serviceTier ? 'priority' : undefined;
    }
    if (typeof serviceTier !== 'string') return undefined;

    const normalized = serviceTier.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'fast' || normalized === 'priority') return 'priority';
    if (normalized === 'flex') return 'flex';
    // Forward unknown future tier values without forcing local adaptation.
    return serviceTier.trim();
}

function isRemoteCompactRequest(body) {
    return Boolean(body && typeof body === 'object' && body.__remote_compact === true);
}

function normalizeCompactResponseShape(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (Array.isArray(payload.output)) return payload;
    if (payload.response && typeof payload.response === 'object' && Array.isArray(payload.response.output)) {
        return { output: payload.response.output };
    }
    if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.output)) {
        return { output: payload.data.output };
    }
    return payload;
}

function safeCodexEventText(value) {
    return typeof value === 'string' ? value : '';
}

function collectCodexReasoningTextFromOutput(output) {
    const texts = [];
    for (const item of Array.isArray(output) ? output : []) {
        if (!item || typeof item !== 'object' || item.type !== 'reasoning') continue;
        if (Array.isArray(item.summary)) {
            const summaryText = item.summary
                .map(part => safeCodexEventText(part?.text))
                .filter(Boolean)
                .join('');
            if (summaryText) texts.push(summaryText);
            continue;
        }
        if (Array.isArray(item.content)) {
            const contentText = item.content
                .map(part => safeCodexEventText(part?.text ?? part?.delta))
                .filter(Boolean)
                .join('');
            if (contentText) texts.push(contentText);
            continue;
        }
        const directText = safeCodexEventText(item.text ?? item.reasoning_content ?? item.reasoning);
        if (directText) texts.push(directText);
    }
    return texts.join('\n\n');
}

function reasoningSummaryAccumulatorKey(event) {
    return [
        event.item_id || `output_${event.output_index ?? 0}`,
        event.summary_index ?? 0
    ].join(':');
}

function updateReasoningSummaryAccumulator(accumulators, event, value, mode = 'delta') {
    const text = safeCodexEventText(value);
    if (!text) return;
    const key = reasoningSummaryAccumulatorKey(event);
    const current = accumulators.get(key) || { deltas: '', doneText: '' };
    if (mode === 'done') {
        current.doneText = text;
    } else {
        current.deltas += text;
    }
    accumulators.set(key, current);
}

function collectReasoningSummaryAccumulatorText(accumulators) {
    return Array.from(accumulators.values())
        .map(item => item.doneText || item.deltas)
        .filter(Boolean)
        .join('\n\n');
}

export function reconstructCodexResponseFromEvents(events, fallbackModel = '') {
    const normalizedEvents = Array.isArray(events)
        ? events.filter(event => event && typeof event === 'object')
        : [];
    if (normalizedEvents.length === 0) return null;

    let createdResponse = null;
    let completedResponse = null;
    const outputItems = [];
    const outputTextParts = [];
    const reasoningSummaryAccumulators = new Map();

    for (const event of normalizedEvents) {
        if (event.type === 'response.created' && event.response && typeof event.response === 'object') {
            createdResponse = event.response;
            continue;
        }
        if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
            outputItems.push(event.item);
            continue;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
            outputTextParts.push(event.delta);
            continue;
        }
        if (event.type === 'response.reasoning_summary_text.delta') {
            updateReasoningSummaryAccumulator(reasoningSummaryAccumulators, event, event.delta, 'delta');
            continue;
        }
        if (event.type === 'response.reasoning_summary_text.done') {
            updateReasoningSummaryAccumulator(reasoningSummaryAccumulators, event, event.text, 'done');
            continue;
        }
        if ((event.type === 'response.reasoning_summary_part.added' || event.type === 'response.reasoning_summary_part.done') && event.part) {
            updateReasoningSummaryAccumulator(reasoningSummaryAccumulators, event, event.part.text, 'done');
            continue;
        }
        if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
            completedResponse = event.response;
        }
    }

    if (!createdResponse && !completedResponse && outputItems.length === 0 && outputTextParts.length === 0) {
        return null;
    }

    const response = completedResponse && typeof completedResponse === 'object'
        ? { ...completedResponse }
        : {};
    const createdAt = createdResponse?.created_at || createdResponse?.created || Math.floor(Date.now() / 1000);

    response.id = response.id || createdResponse?.id || `resp_${Date.now()}`;
    response.object = 'response';
    response.model = response.model || createdResponse?.model || fallbackModel || '';
    response.created_at = response.created_at || createdAt;
    response.status = response.status || createdResponse?.status || 'completed';

    if (!Array.isArray(response.output) || response.output.length === 0) {
        if (outputItems.length > 0) {
            response.output = outputItems;
        } else if (outputTextParts.length > 0) {
            response.output = [{
                type: 'message',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text: outputTextParts.join('')
                }]
            }];
        } else {
            response.output = [];
        }
    }

    const collectedReasoningText = collectReasoningSummaryAccumulatorText(reasoningSummaryAccumulators);
    if (collectedReasoningText) {
        const output = Array.isArray(response.output) ? [...response.output] : [];
        const existingReasoningIndex = output.findIndex(item => item && typeof item === 'object' && item.type === 'reasoning');
        const existingReasoningText = collectCodexReasoningTextFromOutput(output);
        if (!existingReasoningText) {
            const summary = [{ type: 'summary_text', text: collectedReasoningText }];
            if (existingReasoningIndex >= 0) {
                output[existingReasoningIndex] = {
                    ...output[existingReasoningIndex],
                    summary
                };
            } else {
                output.unshift({
                    type: 'reasoning',
                    summary
                });
            }
            response.output = output;
        }
    }

    return response;
}

function safeJsonStringify(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
}

function normalizeCodexMessageContent(content, role) {
    const parts = [];
    const isAssistant = role === 'assistant';
    const textType = isAssistant ? 'output_text' : 'input_text';

    const pushText = (text) => {
        if (typeof text === 'string' && text !== '') {
            parts.push({ type: textType, text });
        }
    };

    if (typeof content === 'string') {
        pushText(content);
        return parts;
    }

    if (Array.isArray(content)) {
        for (const item of content) {
            if (!item) continue;
            if (typeof item === 'string') {
                pushText(item);
                continue;
            }
            if (item.type === 'text') {
                pushText(item.text);
                continue;
            }
            if (item.type === 'input_text' || item.type === 'output_text') {
                const text = item.text ?? item.content;
                if (typeof text === 'string' && text !== '') {
                    parts.push({ ...item, type: textType, text });
                }
                continue;
            }
            if (item.type === 'image_url') {
                if (role === 'user') {
                    const imageUrl = typeof item.image_url === 'string'
                        ? item.image_url
                        : item.image_url?.url;
                    if (imageUrl) {
                        parts.push({ type: 'input_image', image_url: imageUrl });
                    }
                }
                continue;
            }
            if (item.type === 'input_image') {
                if (role === 'user') {
                    parts.push(item);
                }
                continue;
            }
            if (typeof item.text === 'string') {
                pushText(item.text);
            }
        }
        return parts;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        pushText(content.text);
    }

    return parts;
}

function normalizeCodexReasoningItem(item) {
    if (!item) return null;
    if (typeof item === 'string') {
        return {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: item }]
        };
    }
    if (typeof item !== 'object') return null;

    const normalized = {
        ...item,
        type: 'reasoning'
    };
    if (!Array.isArray(normalized.summary)) {
        const summaryText = safeCodexEventText(item.text ?? item.reasoning_content ?? item.reasoning_text ?? item.content);
        if (summaryText) {
            normalized.summary = [{ type: 'summary_text', text: summaryText }];
        }
    }

    if (
        typeof normalized.encrypted_content === 'string'
        || typeof normalized.id === 'string'
        || Array.isArray(normalized.summary)
    ) {
        return normalized;
    }
    return null;
}

function collectCodexReasoningItemsFromMessage(message) {
    if (!message || typeof message !== 'object') return [];
    const items = [];
    const add = (candidate) => {
        if (Array.isArray(candidate)) {
            for (const item of candidate) add(item);
            return;
        }
        const normalized = normalizeCodexReasoningItem(candidate);
        if (normalized) items.push(normalized);
    };

    add(message.reasoning_details);
    add(message.reasoning_items);
    if (message.reasoning && typeof message.reasoning === 'object') {
        add(message.reasoning);
    }
    if (items.length === 0 && typeof message.reasoning_encrypted_content === 'string') {
        add({
            type: 'reasoning',
            encrypted_content: message.reasoning_encrypted_content,
            summary: typeof message.reasoning_content === 'string'
                ? [{ type: 'summary_text', text: message.reasoning_content }]
                : []
        });
    }
    if (items.length === 0 && typeof message.reasoning_content === 'string' && message.reasoning_content) {
        add(message.reasoning_content);
    }

    const seen = new Set();
    return items.filter(item => {
        const key = item.id || item.encrypted_content || safeJsonStringify(item.summary || []);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeCodexMessage(message) {
    if (!message || typeof message !== 'object') return [];

    if (message.role === 'tool') {
        const output = message.content == null ? '' : safeJsonStringify(message.content);
        return [{
            type: 'function_call_output',
            call_id: message.tool_call_id || message.id || crypto.randomUUID(),
            output
        }];
    }

    const role = message.role === 'system' ? 'developer' : (message.role || 'user');
    const items = [];
    if (role === 'assistant') {
        items.push(...collectCodexReasoningItemsFromMessage(message));
    }
    items.push({
        type: 'message',
        role,
        content: normalizeCodexMessageContent(message.content, role)
    });

    const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : (Array.isArray(message.function_calls) ? message.function_calls : []);
    if (role === 'assistant' && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
            if (!toolCall || toolCall.type !== 'function') continue;
            const name = toolCall.function?.name || toolCall.name;
            if (!name) continue;
            const args = toolCall.function?.arguments ?? toolCall.arguments ?? '';
            items.push({
                type: 'function_call',
                call_id: toolCall.id || crypto.randomUUID(),
                name,
                arguments: typeof args === 'string' ? args : safeJsonStringify(args)
            });
        }
    }

    return items;
}

function normalizeCodexInput(input) {
    if (typeof input === 'string') {
        return [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: input }]
        }];
    }

    if (!Array.isArray(input)) return input;

    const normalized = [];
    for (const item of input) {
        if (typeof item === 'string') {
            normalized.push(...normalizeCodexMessage({ role: 'user', content: item }));
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        if (item.type) {
            if (item.type === 'message') {
                const role = item.role === 'system' ? 'developer' : (item.role || 'user');
                normalized.push({
                    ...item,
                    type: 'message',
                    role,
                    content: normalizeCodexMessageContent(item.content, role)
                });
            } else {
                normalized.push(item);
            }
            continue;
        }
        if (item.role) {
            normalized.push(...normalizeCodexMessage(item));
            continue;
        }
        normalized.push(item);
    }

    return normalized;
}

function normalizeCodexTools(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.map(tool => {
        if (!tool || typeof tool !== 'object') return tool;
        if (tool.type === 'function' && tool.function && !tool.name) {
            const normalized = { type: 'function' };
            if (tool.function.name) normalized.name = tool.function.name;
            if (tool.function.description) normalized.description = tool.function.description;
            if (tool.function.parameters) normalized.parameters = tool.function.parameters;
            if (tool.function.strict !== undefined) normalized.strict = tool.function.strict;
            return normalized;
        }
        return tool;
    });
}

function normalizeCodexToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
        return { type: 'function', name: toolChoice.function.name };
    }
    return toolChoice;
}

async function formatAxiosErrorData(data) {
    if (!data) return null;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (typeof data === 'string') return data;
    // 如果是流，尝试读取内容
    if (typeof data === 'object' && typeof data.on === 'function') {
        try {
            const chunks = [];
            for await (const chunk of data) {
                chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString('utf8');
        } catch (e) {
            return '[stream read error]';
        }
    }
    try {
        return JSON.stringify(data);
    } catch (error) {
        return '[unserializable error data]';
    }
}

function normalizeAxiosHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    if (typeof headers.toJSON === 'function') {
        return headers.toJSON();
    }
    return { ...headers };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        const text = await response.text();
        let payload = text;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch {
                payload = text;
            }
        } else {
            payload = null;
        }

        if (!response.ok) {
            const error = new Error(`Request failed with status code ${response.status}`);
            error.status = response.status;
            error.response = {
                status: response.status,
                data: payload,
                headers: Object.fromEntries(response.headers.entries())
            };
            throw error;
        }

        return payload;
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error(`fetch timeout after ${timeoutMs}ms`);
            timeoutError.code = 'FETCH_TIMEOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function toOpenAIModelItem(model) {
    if (!model || typeof model !== 'object') return null;
    const id = model.slug || model.id || model.model;
    if (!id || typeof id !== 'string') return null;

    return {
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'openai',
        display_name: model.display_name || id,
        description: model.description || ''
    };
}

function normalizeModelListPayload(payload) {
    if (payload && Array.isArray(payload.models)) {
        const data = payload.models
            .map(toOpenAIModelItem)
            .filter(Boolean);

        return {
            ...payload,
            object: payload.object || 'list',
            data
        };
    }

    if (payload && Array.isArray(payload.data)) {
        return payload;
    }

    return null;
}

function fallbackCodexModelList() {
    return {
        object: 'list',
        data: CODEX_MODEL_LIST
    };
}

function filterCodexImageModels(payload) {
    if (!payload || !Array.isArray(payload.data)) return payload;
    return {
        ...payload,
        data: payload.data.filter(item => !CODEX_IMAGE_MODEL_IDS.has(String(item?.id || '').trim()))
    };
}

export class CodexApiService {
    constructor(config) {
        this.config = config;
        this.isInitialized = false;
        this.baseUrl = config.CODEX_BASE_URL || DEFAULT_CODEX_BASE_URL;
        const configuredConversationId = (typeof config.CODEX_CONVERSATION_ID === 'string' && config.CODEX_CONVERSATION_ID.trim())
            ? config.CODEX_CONVERSATION_ID.trim()
            : '';
        this.conversationId = configuredConversationId || crypto.randomUUID();
        this.hasConfiguredConversationId = Boolean(configuredConversationId);
        this.strictRequestAlignment = parseBooleanLike(
            config?.CODEX_STRICT_REQUEST_ALIGNMENT ?? config?.CODEX_STRICT_FINGERPRINT_MODE,
            false
        );
        this.oauthCredentialId = null;
        this.credentials = null;
        this.requestContext = {};
        this._lastUpstreamHeaders = {};
        this.refreshInFlight = null;
        this.backgroundRefreshInFlight = null;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_CODEX ?? false;
    }

    async initialize() {
        if (this.isInitialized) return;
        await this.loadCredentials();

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });

        const axiosConfig = {
            baseURL: this.baseUrl,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }

        configureAxiosProxy(axiosConfig, this.config, 'openai-codex');
        this.axiosInstance = axios.create(axiosConfig);

        const tokenAxiosConfig = {
            baseURL: CODEX_OAUTH_TOKEN_ENDPOINT,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            httpAgent,
            httpsAgent
        };
        if (!this.useSystemProxy) {
            tokenAxiosConfig.proxy = false;
        }
        configureAxiosProxy(tokenAxiosConfig, this.config, 'openai-codex');
        this.tokenClient = axios.create(tokenAxiosConfig);

        this.isInitialized = true;
    }

    async loadCredentials() {
        const { credentialId, credentials } = await loadCredentialsFromConfig(
            this.config,
            'CODEX_OAUTH_CREDS_FILE_PATH',
            'openai-codex'
        );

        const normalized = normalizeCredentials(credentials);
        if (!normalized.accessToken) {
            throw new Error('[Codex] access_token is required');
        }

        let accountId = normalized.accountId || extractAccountId(normalized.accessToken);
        let email = normalized.email || extractEmail(normalized.accessToken);
        const expiresAt = normalized.expiresAt;

        if (!accountId) {
            throw new Error('[Codex] account_id is required');
        }

        const merged = {
            ...credentials,
            accessToken: normalized.accessToken,
            refreshToken: normalized.refreshToken,
            accountId,
            email,
            expiresAt,
            lastRefresh: normalized.lastRefresh || new Date().toISOString(),
            type: 'codex'
        };

        if (
            accountId !== normalized.accountId ||
            email !== normalized.email ||
            merged.accessToken !== credentials.accessToken ||
            merged.refreshToken !== credentials.refreshToken ||
            merged.expiresAt !== credentials.expiresAt
        ) {
            await updateCredentialsById(credentialId, merged);
        }

        this.oauthCredentialId = credentialId;
        this.credentials = merged;
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
            if (String(key).toLowerCase() !== lower) continue;
            if (value === undefined || value === null) return '';
            return Array.isArray(value) ? String(value[0]) : String(value);
        }
        return '';
    }

    _getHeaderFromMap(headers, name) {
        if (!headers || typeof headers !== 'object') return '';
        const lower = String(name || '').toLowerCase();
        if (!lower) return '';
        for (const [key, value] of Object.entries(headers)) {
            if (String(key).toLowerCase() !== lower) continue;
            if (value === undefined || value === null) return '';
            return Array.isArray(value) ? String(value[0]) : String(value);
        }
        return '';
    }

    _getContextValue(context, key) {
        if (!context || typeof context !== 'object') return '';
        const value = context[key];
        if (value === undefined || value === null) return '';
        const normalized = String(value).trim();
        return normalized.length > 0 ? normalized : '';
    }

    _getSessionIdFromRequestHeaders(requestHeaders) {
        const candidates = [
            'session_id',
            'x-session-id',
            'x-stainless-session-id'
        ];
        for (const key of candidates) {
            const value = this._getHeaderFromMap(requestHeaders, key);
            if (value) return value;
        }
        return '';
    }

    _extractSessionFromMetadata(requestBody) {
        const metadataUserId = requestBody?.metadata?.user_id;
        if (!metadataUserId || typeof metadataUserId !== 'string') return '';
        const match = metadataUserId.match(/session_([a-f0-9-]+)$/i);
        if (match && match[1]) return String(match[1]).trim();
        return '';
    }

    _buildStableSessionKey(requestBody, requestHeaders = null, requestContext = null) {
        const explicitSession = this._getSessionIdFromRequestHeaders(requestHeaders);
        if (explicitSession) return explicitSession;

        const contextSession = this._getContextValue(requestContext, 'sessionId');
        if (contextSession) return contextSession;

        const metadataSession = this._extractSessionFromMetadata(requestBody);
        if (metadataSession) return metadataSession;

        const modelName = typeof requestBody?.model === 'string' ? requestBody.model.trim() : '';
        const hashIdentity = (scope, value) => {
            const normalized = String(value || '').trim();
            if (!normalized) return '';
            const digest = crypto
                .createHash('sha256')
                .update(`${scope}|${normalized}|${modelName}`)
                .digest('hex')
                .slice(0, 24);
            return `ahs_${digest}`;
        };
        const normalizeAuthorization = (value) => String(value || '').replace(/^Bearer\s+/i, '').trim();

        const headerIdentityCandidates = [
            'x-accounthub-tokenid',
            'x-accounthub-token-id',
            'x-account-hub-token-id',
            'x-token-id',
            'x-accounthub-userid',
            'x-accounthub-user-id',
            'x-account-hub-user-id',
            'x-user-id',
            'x-uid',
            'x-accounthub-useremail',
            'x-accounthub-user-email',
            'x-account-hub-user-email',
            'x-user-email',
            'x-email',
            'x-accounthub-username',
            'x-accounthub-user-name',
            'x-account-hub-user-name',
            'x-user-name',
            'x-username',
            'x-api-key',
            'authorization'
        ];
        for (const key of headerIdentityCandidates) {
            const value = this._getHeaderFromMap(requestHeaders, key);
            if (value) {
                const normalizedValue = key === 'authorization' ? normalizeAuthorization(value) : value;
                const hashed = hashIdentity(key, normalizedValue);
                if (hashed) return hashed;
            }
        }

        const contextIdentity = this._getContextValue(requestContext, 'clientTokenId')
            || this._getContextValue(requestContext, 'xApiKey')
            || normalizeAuthorization(this._getContextValue(requestContext, 'authorization'))
            || this._getContextValue(requestContext, 'userId')
            || this._getContextValue(requestContext, 'userEmail')
            || this._getContextValue(requestContext, 'username');
        if (!contextIdentity) return '';

        return hashIdentity('ctx', contextIdentity);
    }

    buildHeaders(cacheId = null, isStream = false, requestHeaders = null, options = {}) {
        const isCompact = options && options.isCompact === true;
        const conversationId = options && typeof options.conversationId === 'string' && options.conversationId.trim()
            ? options.conversationId.trim()
            : null;
        const readHeader = (name) => this._getHeaderFromMap(requestHeaders, name);
        const requestVersion = readHeader('version');
        const requestOriginator = readHeader('originator');
        const requestUserAgent = readHeader('user-agent');
        const requestOpenAIBeta = readHeader('openai-beta');
        const requestXClientRequestId = readHeader('x-client-request-id');
        const requestSessionId = this._getSessionIdFromRequestHeaders(requestHeaders);
        const requestTurnMetadata = readHeader('x-codex-turn-metadata');
        const requestTurnState = readHeader('x-codex-turn-state');
        const requestCodexBetaFeatures = readHeader('x-codex-beta-features');
        const requestTimingMetrics = readHeader('x-responsesapi-include-timing-metrics');
        const requestAccountId = readHeader('chatgpt-account-id');
        const requestSubagent = readHeader('x-openai-subagent');
        const requestResidency = readHeader('x-openai-internal-codex-residency');
        const headers = {
            Authorization: `Bearer ${this.credentials.accessToken}`,
            'ChatGPT-Account-ID': requestAccountId || this.credentials.accountId,
            originator: requestOriginator || 'codex_cli_rs',
            version: requestVersion || this.config.CODEX_VERSION || CODEX_DEFAULT_VERSION,
            'User-Agent': requestUserAgent || this.config.CODEX_USER_AGENT || CODEX_DEFAULT_USER_AGENT
        };
        const betaHeader = requestOpenAIBeta || this.config.CODEX_OPENAI_BETA;
        if (typeof betaHeader === 'string' && betaHeader.trim()) {
            headers['OpenAI-Beta'] = betaHeader.trim();
        }
        if (requestTurnMetadata) {
            headers['X-Codex-Turn-Metadata'] = requestTurnMetadata;
        }
        if (requestTurnState) {
            headers['X-Codex-Turn-State'] = requestTurnState;
        }
        if (requestCodexBetaFeatures) {
            headers['X-Codex-Beta-Features'] = requestCodexBetaFeatures;
        }
        if (requestTimingMetrics) {
            headers['X-Responsesapi-Include-Timing-Metrics'] = requestTimingMetrics;
        }
        if (requestSubagent) {
            headers['X-OpenAI-Subagent'] = requestSubagent;
        }
        if (requestResidency) {
            headers['X-OpenAI-Internal-Codex-Residency'] = requestResidency;
        }
        if (isStream) {
            headers.Accept = 'text/event-stream';
        } else {
            headers.Accept = 'application/json';
        }
        headers.Connection = 'Keep-Alive';
        if (requestXClientRequestId) {
            headers['x-client-request-id'] = requestXClientRequestId;
        }
        if (requestSessionId) {
            headers.session_id = requestSessionId;
        } else if (cacheId) {
            headers.session_id = cacheId;
        } else if (conversationId) {
            headers.session_id = conversationId;
        }
        return headers;
    }

    buildCurlCommand(endpoint, headers = {}, requestBody = null) {
        const url = new URL(endpoint, this.baseUrl).toString();
        const sanitizedHeaders = { ...headers };
        if (sanitizedHeaders.Authorization) {
            sanitizedHeaders.Authorization = 'Bearer [REDACTED]';
        }

        const parts = [`curl -X POST '${url}'`];
        for (const [key, value] of Object.entries(sanitizedHeaders)) {
            if (value === undefined || value === null || value === '') continue;
            const safeValue = String(value).replace(/'/g, `'\''`);
            parts.push(`-H '${key}: ${safeValue}'`);
        }
        if (requestBody !== null && requestBody !== undefined) {
            let payload;
            try {
                payload = JSON.stringify(requestBody);
            } catch (error) {
                payload = '[unserializable request body]';
            }
            const safePayload = String(payload).replace(/'/g, `'\''`);
            parts.push(`--data-raw '${safePayload}'`);
        }
        return parts.join(' ');
    }

    normalizeRequestBody(body) {
        if (!body || typeof body !== 'object') return body;
        const normalized = { ...body };
        const isCompactRequest = normalized.__remote_compact === true;

        normalized.model = normalizeCodexModel(normalized.model);

        // Codex Responses endpoint expects `input` (messages) instead of `messages`
        if (!normalized.input && Array.isArray(normalized.messages)) {
            normalized.input = normalized.messages;
            delete normalized.messages;
        }

        if (normalized.input !== undefined) {
            normalized.input = normalizeCodexInput(normalized.input);
        }

        delete normalized.max_output_tokens;
        delete normalized.max_completion_tokens;
        delete normalized.max_tokens;
        delete normalized.temperature;
        delete normalized.top_p;
        if (this.strictRequestAlignment) {
            delete normalized.truncation;
            delete normalized.context_management;
            delete normalized.user;
        }

        // Forward most fields as-is to reduce coupling with upstream schema changes.
        const hasExplicitServiceTier = normalized.service_tier !== undefined && normalized.service_tier !== null;

        // Keep codex fast/flex tier if provided by client.
        const serviceTierCandidate = hasExplicitServiceTier
            ? normalized.service_tier
            : (normalized.fast_mode ?? normalized.fast);
        const serviceTier = normalizeCodexServiceTier(serviceTierCandidate);
        if (serviceTier) {
            normalized.service_tier = serviceTier;
        } else if (!hasExplicitServiceTier) {
            delete normalized.service_tier;
        }
        delete normalized.fast_mode;
        delete normalized.fast;

        // Remove internal trace marker but keep user-provided metadata.
        if (normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)) {
            const metadata = { ...normalized.metadata };
            delete metadata.traceId;
            if (Object.keys(metadata).length > 0) {
                normalized.metadata = metadata;
            } else {
                delete normalized.metadata;
            }
        }
        delete normalized.__remote_compact;

        // Compact endpoint should keep body minimal and avoid responses-only defaults.
        if (isCompactRequest) {
            delete normalized.stream;
            return normalized;
        }

        if (!Array.isArray(normalized.input)) {
            normalized.input = [];
        }
        if (!Array.isArray(normalized.tools)) {
            normalized.tools = [];
        }

        // Normalize tools/tool_choice to Responses shape if needed
        if (normalized.tools) {
            normalized.tools = normalizeCodexTools(normalized.tools);
        }
        if (normalized.tool_choice !== undefined && normalized.tool_choice !== null) {
            normalized.tool_choice = normalizeCodexToolChoice(normalized.tool_choice);
        } else {
            normalized.tool_choice = 'auto';
        }

        // Map response_format to text.format (Responses API)
        if (normalized.response_format && typeof normalized.response_format === 'object') {
            const rf = normalized.response_format;
            normalized.text = normalized.text && typeof normalized.text === 'object' ? normalized.text : {};
            if (rf.type === 'text') {
                normalized.text.format = { type: 'text' };
            } else if (rf.type === 'json_schema' && rf.json_schema) {
                const schema = rf.json_schema;
                normalized.text.format = { type: 'json_schema' };
                if (schema.name) normalized.text.format.name = schema.name;
                if (schema.strict !== undefined) normalized.text.format.strict = schema.strict;
                if (schema.schema) normalized.text.format.schema = schema.schema;
            }
            delete normalized.response_format;
        }

        // Ensure instructions exists (codex executor does this)
        if (normalized.instructions === undefined) {
            normalized.instructions = '';
        }

        if (normalized.store === undefined) {
            normalized.store = false;
        }

        if (normalized.parallel_tool_calls === undefined) {
            normalized.parallel_tool_calls = true;
        }
        const requestedReasoningEffort = normalized.reasoning_effort ?? normalized.reasoningEffort;
        if (requestedReasoningEffort !== undefined && requestedReasoningEffort !== null && requestedReasoningEffort !== '') {
            normalized.reasoning = normalized.reasoning && typeof normalized.reasoning === 'object' && !Array.isArray(normalized.reasoning)
                ? { ...normalized.reasoning, effort: String(requestedReasoningEffort).trim().toLowerCase() }
                : { effort: String(requestedReasoningEffort).trim().toLowerCase() };
        }
        delete normalized.reasoning_effort;
        delete normalized.reasoningEffort;
        if (normalized.reasoning === undefined) {
            const modelName = typeof normalized.model === 'string' ? normalized.model.toLowerCase() : '';
            normalized.reasoning = /^gpt-\d/.test(modelName) ? { effort: 'medium' } : null;
        }
        if (normalized.reasoning && typeof normalized.reasoning === 'object') {
            if (normalized.reasoning.effort === undefined) {
                normalized.reasoning.effort = 'medium';
            }
            // gpt-5.3-codex 不接受 summary 字段，按模型移除
            if (typeof normalized.model === 'string' && normalized.model.includes('gpt-5.3-codex')) {
                delete normalized.reasoning.summary;
            }
            // gpt-5.5 仅接受 low/medium/high/xhigh，兜底把 none/minimal 抬到 low
            if (typeof normalized.model === 'string' && normalized.model.toLowerCase().startsWith('gpt-5.5')) {
                const eff = String(normalized.reasoning.effort || '').toLowerCase();
                if (eff === 'none' || eff === 'minimal' || eff === '') {
                    normalized.reasoning.effort = 'low';
                }
            }
        }
        if (normalized.include === undefined || normalized.include === null) {
            normalized.include = normalized.reasoning ? ['reasoning.encrypted_content'] : [];
        }
        return normalized;
    }

    isExpiryDateNear() {
        const expiryTime = parseExpiry(this.credentials?.expiresAt);
        if (!expiryTime) return false;
        const currentTime = Date.now();
        const nearMs = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
        return expiryTime <= (currentTime + nearMs);
    }

    getPromptCacheKey(requestBody, options = {}) {
        const isCompact = options && options.isCompact === true;
        if (!requestBody || typeof requestBody !== 'object') {
            return !isCompact && this.hasConfiguredConversationId ? this.conversationId : null;
        }
        if (typeof requestBody.prompt_cache_key === 'string' && requestBody.prompt_cache_key.trim()) {
            return requestBody.prompt_cache_key.trim();
        }
        if (typeof requestBody.conversation_id === 'string' && requestBody.conversation_id.trim()) {
            return requestBody.conversation_id.trim();
        }
        return !isCompact && this.hasConfiguredConversationId ? this.conversationId : null;
    }

    getConversationId(requestBody, options = {}) {
        const isCompact = options && options.isCompact === true;
        if (!requestBody || typeof requestBody !== 'object') {
            return !isCompact && this.hasConfiguredConversationId ? this.conversationId : null;
        }
        if (typeof requestBody.prompt_cache_key === 'string' && requestBody.prompt_cache_key.trim()) {
            return requestBody.prompt_cache_key.trim();
        }
        if (typeof requestBody.conversation_id === 'string' && requestBody.conversation_id.trim()) {
            return requestBody.conversation_id.trim();
        }
        return !isCompact && this.hasConfiguredConversationId ? this.conversationId : null;
    }

    prepareRequestBody(body, stream, options = {}) {
        const isCompact = options && options.isCompact === true;
        const requestHeaders = options && options.requestHeaders ? options.requestHeaders : null;
        const requestContext = options && options.requestContext ? options.requestContext : null;
        const normalized = this.normalizeRequestBody(body);
        if (typeof normalized?.model === 'string' && normalized.model.trim() && !isKnownCodexModel(normalized.model)) {
            console.warn(`[CodexApiService] Unknown codex model requested, forwarding upstream directly: ${normalized.model}`);
        }
        const cacheId = this.getPromptCacheKey(normalized, { isCompact, requestHeaders, requestContext });
        const conversationId = this.getConversationId(normalized, { isCompact, requestHeaders, requestContext });
        const requestBody = { ...normalized };
        if (!isCompact) {
            requestBody.stream = Boolean(stream);
        }
        if (cacheId) {
            requestBody.prompt_cache_key = cacheId;
        }
        return { requestBody, cacheId, conversationId, isCompact };
    }

    async ensureValidCredentials(forceRefresh = false) {
        if (!this.credentials) {
            await this.loadCredentials();
        }

        if (!forceRefresh && !this.isExpiryDateNear()) {
            return;
        }

        if (!this.credentials.refreshToken) {
            return;
        }

        await this.refreshAccessToken();
    }

    async refreshAccessToken(forceRefresh = false) {
        if (!this.isInitialized || !this.axiosInstance || !this.tokenClient) {
            this.isInitialized = false;
            await this.initialize();
        }

        if (!this.credentials?.refreshToken) {
            const missingRefreshErr = new Error('[Codex] refresh_token is required to refresh');
            missingRefreshErr.code = 'CODEX_REFRESH_TOKEN_MISSING';
            missingRefreshErr.status = 401;
            markAuthCredentialIssue(missingRefreshErr, 401, missingRefreshErr.message);
            throw missingRefreshErr;
        }

        const dedupeKey = `codex-refresh:${this.oauthCredentialId || 'unknown'}`;
        if (this.refreshInFlight) {
            await this.refreshInFlight;
            // deduplication 命中：另一个实例已完成刷新，从 DB 加载最新 credentials
            await this._reloadCredentialsFromDb();
            return;
        }

        this.refreshInFlight = withDeduplication(dedupeKey, async () => {
            const refreshOperation = async () => {
                // 拿到锁后，从 DB 重新加载最新 token（可能已被另一个 worker 刷新过）
                const oldRefreshToken = this.credentials.refreshToken;
                await this._reloadCredentialsFromDb();

                // 如果 DB 中的 refresh_token 已经变了，说明另一个 worker 已完成刷新，无需再刷
                if (this.credentials.refreshToken !== oldRefreshToken) {
                    console.log(`[Codex] refresh_token already rotated by another worker, skipping refresh`);
                    return;
                }

                // 如果 DB 中的 token 尚未过期，也无需刷新
                const expiryTime = parseExpiry(this.credentials.expiresAt);
                const nearMs = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
                if (!forceRefresh && expiryTime && expiryTime > Date.now() + nearMs) {
                    console.log(`[Codex] access_token still valid after DB reload, skipping refresh`);
                    return;
                }

                const form = new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.credentials.refreshToken,
                    client_id: CODEX_OAUTH_CLIENT_ID
                });

                let response;
                try {
                    response = await this.tokenClient.post('', form.toString());
                } catch (tokenErr) {
                    // refresh_token_reused: 可能另一个 worker 已轮换，从 DB 加载最新
                    if (isRefreshTokenReused(tokenErr)) {
                        const oldRT = this.credentials.refreshToken;
                        console.warn(`[Codex] refresh_token_reused in refreshAccessToken, reloading from DB`);
                        await this._reloadCredentialsFromDb();
                        if (this.credentials.refreshToken !== oldRT) {
                            // DB 中已有新 token，reload 成功
                            return;
                        }
                        // DB 中 refreshToken 未变 → token 已被消费但新 token 未持久化，credential 不可用
                        console.error(`[Codex] refresh_token_reused but DB has same token — credential is stale`);
                        const deadErr = new Error('[Codex] refresh_token permanently consumed, needs re-authorization');
                        deadErr.code = 'CODEX_REFRESH_TOKEN_DEAD';
                        throw deadErr;
                    }

                    const errMessage = String(tokenErr?.message || '');
                    const isNullPostError = errMessage.includes("Cannot read properties of null (reading 'post')");
                    if (isNullPostError) {
                        console.warn('[Codex] tokenClient became invalid, rebuilding axios clients and retrying once');
                        this.axiosInstance = null;
                        this.tokenClient = null;
                        this.isInitialized = false;
                        await this.initialize();
                        response = await this.tokenClient.post('', form.toString());
                    } else {
                        throw tokenErr;
                    }
                }
                const data = response.data || {};

                if (!data.access_token || !data.refresh_token || !data.expires_in) {
                    throw new Error('[Codex] token refresh response missing fields');
                }

                const accountId = extractAccountId(data.access_token) || this.credentials.accountId;
                const email = extractEmail(data.access_token) || this.credentials.email;
                const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

                const updated = {
                    ...this.credentials,
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    accountId,
                    email,
                    expiresAt,
                    lastRefresh: new Date().toISOString(),
                    type: 'codex'
                };

                if (!accountId) {
                    throw new Error('[Codex] account_id missing after refresh');
                }

                await updateCredentialsById(this.oauthCredentialId, updated, dedupeKey);
                this.credentials = updated;
            };

            // 优先 Redis 分布式锁：最多等待 200ms，拿不到立即回退（不阻塞请求）
            const lockKey = `lock:codex:refresh:${this.oauthCredentialId}`;
            const redisLock = await tryAcquireRedisLock(lockKey);
            if (redisLock.mode === 'redis') {
                if (!redisLock.acquired) {
                    const lockBusyError = new Error(`[Codex] Redis lock busy (${lockKey})`);
                    lockBusyError.code = 'CODEX_REFRESH_LOCK_BUSY';
                    throw lockBusyError;
                }
                try {
                    await refreshOperation();
                } finally {
                    await releaseRedisLock(lockKey, redisLock.token);
                }
                return;
            }

            // Redis 不可用时，DB 锁降级为短等待（最多 1s）
            if (isDatabaseInitialized()) {
                const dbLockKey = `codex-refresh:${this.oauthCredentialId}`;
                try {
                    await withDbLock(dbLockKey, 0, refreshOperation);
                    return;
                } catch (lockErr) {
                    if ((lockErr?.message || '').includes('Failed to acquire DB lock')) {
                        const lockBusyError = new Error(`[Codex] DB lock busy (${dbLockKey})`);
                        lockBusyError.code = 'CODEX_REFRESH_LOCK_BUSY';
                        throw lockBusyError;
                    }
                    throw lockErr;
                }
            }

            await refreshOperation();
        }).finally(() => {
            this.refreshInFlight = null;
        });

        return this.refreshInFlight;
    }

    startBackgroundRefresh(reason = 'unspecified') {
        if (this.backgroundRefreshInFlight || this.refreshInFlight) {
            return;
        }

        const shortUuid = (this.config.uuid || '').slice(0, 8) || 'unknown';
        this.backgroundRefreshInFlight = (async () => {
            try {
                console.log(`[Codex] Background refresh started for ${shortUuid}, reason: ${reason}`);
                await this.refreshAccessToken(true);
                console.log(`[Codex] Background refresh finished for ${shortUuid}`);
            } catch (error) {
                if (error?.code === 'CODEX_REFRESH_LOCK_BUSY') {
                    console.log(`[Codex] Background refresh skipped (lock busy) for ${shortUuid}`);
                } else {
                    console.warn(`[Codex] Background refresh failed for ${shortUuid}: ${error?.message || error}`);
                }
            } finally {
                this.backgroundRefreshInFlight = null;
            }
        })();
    }

    /**
     * 从 DB 重新加载最新 credentials，防止并发刷新时使用过期的 refresh_token
     */
    async _reloadCredentialsFromDb() {
        if (!this.oauthCredentialId) return;
        try {
            const latest = await loadCredentialsById(this.oauthCredentialId);
            if (latest && latest.refreshToken && latest.refreshToken !== this.credentials.refreshToken) {
                console.log(`[Codex] Reloaded credentials from DB (refresh_token rotated by another instance)`);
                this.credentials = { ...this.credentials, ...latest };
            }
        } catch (err) {
            console.warn(`[Codex] Failed to reload credentials from DB:`, err.message);
        }
    }

    async callApi(endpoint, body, retryCount = 0, authRetried = false, requestHeaders = null, requestContext = null) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        await this.ensureValidCredentials();
        const isCompact = String(endpoint || '').includes('/responses/compact');
        const { requestBody, cacheId, conversationId } = this.prepareRequestBody(body, false, { isCompact, requestHeaders, requestContext });
        const headers = this.buildHeaders(cacheId, false, requestHeaders, { isCompact, conversationId });

        try {
            const response = await this.axiosInstance.post(endpoint, requestBody, {
                headers
            });
            this._lastUpstreamHeaders = normalizeAxiosHeaders(response.headers);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = await formatAxiosErrorData(error.response?.data);
            const isScopeMissing = isProviderScopeMissingStatus(data, error.message);

            if (isScopeMissing) {
                markScopeMissingCredentialError(error, status, data, error.message);
                console.log(`[Codex] Provider scope missing for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
                throw error;
            }

            if (status === 401 && !authRetried && isExplicitUnauthorizedStatus(status, error.response?.headers, data, error.message)) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Unauthorized 401 for ${(this.config.uuid || '').slice(0,8)}, marking credential for deletion`);
                throw error;
            }

            if ((status === 401 || status === 403) && !authRetried) {
                try {
                    await this.refreshAccessToken();
                } catch (refreshErr) {
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_MISSING') {
                        if (status === 401) {
                            markPermanentCredentialError(error, status, data, refreshErr.message || error.message);
                        } else {
                            markAuthCredentialIssue(error, status, refreshErr.message || error.message);
                        }
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_DEAD') {
                        markAuthCredentialIssue(error, status, refreshErr.message || error.message);
                        error.shouldDeleteCredential = true;
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    if (refreshErr?.code === 'CODEX_REFRESH_LOCK_BUSY') {
                        error.skipErrorCount = true;
                        error.shouldSwitchCredential = true;
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    throw refreshErr;
                }
                return this.callApi(endpoint, body, retryCount, true, requestHeaders, requestContext);
            }

            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries && !error.shouldDeleteCredential) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
            }

            if (!status && isRetryableNetworkError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
            }

            error.curlCommand = this.buildCurlCommand(endpoint, headers, requestBody);
            console.error(`[Codex] Request failed (Status: ${status}):`, data || error.message);

            const requestedModel = requestBody?.model || body?.model || null;

            if (isModelScopedUnavailableStatus(status, data, error.message)) {
                markModelScopedUnavailableError(error, status, data, error.message, requestedModel);
            }

            // 400 错误是客户端请求参数问题（如 verbosity 不支持），不是账号问题，不应标记账号异常
            if (status === 400) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = false;
            }

            if (error.isModelUnavailableScoped) {
                error.shouldSwitchCredential = false;
            }

            // 429 Rate Limit：重试耗尽后切号，标记短暂 cooldown 防止无限轮转
            if (status === 429) {
                const resetAtMs = parseRetryAfterMs(error.response?.headers) || (Date.now() + 15000);
                const retryAfterMs = Math.max(1000, resetAtMs - Date.now());
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                error.isQuotaCooldown = true;
                error.quotaResetTime = new Date(resetAtMs).toISOString();
                error.quotaResetDelayMs = retryAfterMs;
                error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                console.log(`[Codex] 429 Rate Limit for ${(this.config.uuid || '').slice(0,8)}, cooldown ${retryAfterMs}ms until ${error.quotaResetTime}`);
            }

            if (status >= 500 && status < 600) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                console.log(`[Codex] ${status} server error for ${(this.config.uuid || '').slice(0,8)}, switching credential`);
            }

            if (!status && isRetryableNetworkError(error)) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                console.log(`[Codex] Network error for ${(this.config.uuid || '').slice(0,8)}, switching credential`);
            }

            if (status === 402) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Permanent 402 for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
            }

            if ((status === 401 || status === 403) && authRetried && !error.isModelUnavailableScoped && !error.isQuotaCooldown && !error.shouldDeleteCredential) {
                markPermanentCredentialError(error, status, data, error.message);
            }


            // 401 (token refresh 已失败且明确额度信号)：按短暂冷却处理，避免误删
            if (status === 401 && authRetried && !error.shouldDeleteCredential && isQuotaExhaustedStatus(status, error.response?.headers, data, error.message)) {
                const resetAtMs = markQuotaCooldownError(error, status, error.response?.headers, 3600000);
                console.log(`[Codex] Quota exhausted (${status}) for ${(this.config.uuid || '').slice(0,8)}, recovery at ${new Date(resetAtMs).toISOString()}`);
            }

            throw error;
        }
    }

    async *streamApi(endpoint, body, retryCount = 0, authRetried = false, requestHeaders = null, requestContext = null) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        await this.ensureValidCredentials();
        const isCompact = String(endpoint || '').includes('/responses/compact');
        const { requestBody, cacheId, conversationId } = this.prepareRequestBody(body, true, { isCompact, requestHeaders, requestContext });
        const headers = this.buildHeaders(cacheId, true, requestHeaders, { isCompact, conversationId });

        try {
            const response = await this.axiosInstance.post(endpoint, requestBody, {
                responseType: 'stream',
                headers
            });

            this._lastUpstreamHeaders = normalizeAxiosHeaders(response.headers);
            const stream = response.data;
            let buffer = '';
            // DiagUsage: track raw OpenAI stream events
            let _diagChunkCount = 0;
            let _diagCompletedSeen = false;
            let _diagLastType = '';
            const _diagUuid = (this.config.uuid || '').slice(0, 8);
            const _diagModel = body?.model || requestBody?.model || '?';
            // 跟踪是否已 yield 了真实内容（text/function_call 等）
            // 只有 response.created / response.in_progress 这种元事件不算"真实内容"
            let _hasYieldedContent = false;
            const CONTENT_EVENT_TYPES = new Set([
                'response.output_text.delta', 'response.output_text.done',
                'response.content_part.added', 'response.content_part.done',
                'response.function_call_arguments.delta', 'response.function_call_arguments.done',
                'response.output_item.added', 'response.output_item.done',
                'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
                'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
            ]);

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            // DiagUsage: log stream end summary
                            if (!_diagCompletedSeen) {
                                console.error(`[DiagUsage-Raw] [DONE] received WITHOUT response.completed! model=${_diagModel} uuid=${_diagUuid} chunks=${_diagChunkCount} lastType=${_diagLastType}`);
                            } else {
                                console.log(`[DiagUsage-Raw] Stream OK: model=${_diagModel} uuid=${_diagUuid} chunks=${_diagChunkCount} completedSeen=true`);
                            }
                            return;
                        }
                        try {
                            const parsed = JSON.parse(jsonData);
                            _diagChunkCount++;
                            _diagLastType = parsed.type || '';

                            // 检测流式错误事件
                            if (parsed.type === 'error' || parsed.type === 'response.failed') {
                                // 提取错误信息
                                const errCode = parsed.error?.code || parsed.response?.status_details?.error?.code || parsed.response?.status_details?.type || '';
                                const errMsg = parsed.error?.message || parsed.response?.status_details?.error?.message || '';
                                const fullRaw = jsonData.substring(0, 2000);
                                console.error(`[Codex] Stream ${parsed.type}: code=${errCode} msg=${errMsg} model=${_diagModel} uuid=${_diagUuid} hasContent=${_hasYieldedContent}`);
                                console.error(`[Codex] Stream ${parsed.type} RAW: ${fullRaw}`);

                                // 尚未输出任何真实内容 → 可以重试，throw 触发 catch 块的重试/换号逻辑
                                if (!_hasYieldedContent) {
                                    const streamError = new Error(`Codex stream ${parsed.type}: [${errCode}] ${errMsg}`);
                                    streamError.isStreamError = true;
                                    const normalizedErrCode = String(errCode || '').toLowerCase();
                                    // 映射错误码到 HTTP status，让 catch 块的重试逻辑正确处理
                                    if (normalizedErrCode === 'token_invalidated' || normalizedErrCode === 'invalid_api_key') {
                                        streamError.response = { status: 401 };
                                        streamError.shouldSwitchCredential = true;
                                        streamError.shouldDeleteCredential = true;
                                        streamError.isAuthCredentialIssue = true;
                                        streamError.skipErrorCount = true;
                                    } else if (normalizedErrCode === 'context_length_exceeded'
                                        || normalizedErrCode === 'invalid_prompt'
                                        || normalizedErrCode === 'usage_not_included') {
                                        streamError.response = { status: 400 };
                                        streamError.skipErrorCount = true;
                                        streamError.shouldSwitchCredential = false;
                                    } else if (normalizedErrCode === 'rate_limit_exceeded') {
                                        streamError.response = { status: 429 };
                                    } else if (normalizedErrCode === 'server_error'
                                        || normalizedErrCode === 'internal_error'
                                        || normalizedErrCode === 'server_is_overloaded'
                                        || normalizedErrCode === 'slow_down') {
                                        streamError.response = { status: 500 };
                                        streamError.skipErrorCount = true;
                                        streamError.shouldSwitchCredential = true;
                                    } else {
                                        // 其他未知错误也走 500 的重试路径
                                        streamError.response = { status: 500 };
                                    }
                                    throw streamError;
                                }
                                // 已有真实内容输出了，无法重试，继续 yield 让客户端看到错误
                                yield parsed;
                                continue;
                            }

                            // 跟踪是否产生了真实内容
                            if (CONTENT_EVENT_TYPES.has(parsed.type)) {
                                _hasYieldedContent = true;
                            }

                            // DiagUsage: log response.completed raw data from OpenAI
                            if (parsed.type === 'response.completed') {
                                try {
                                    _diagCompletedSeen = true;
                                    const hasUsage = !!parsed.response?.usage;
                                    const usageSummary = hasUsage
                                        ? `input=${parsed.response.usage.input_tokens} output=${parsed.response.usage.output_tokens} total=${parsed.response.usage.total_tokens}`
                                        : `MISSING! responseKeys=[${parsed.response ? Object.keys(parsed.response).join(',') : 'null'}]`;
                                    console.log(`[DiagUsage-Raw] response.completed from OpenAI: model=${_diagModel} uuid=${_diagUuid} usage=${usageSummary}`);
                                    if (!hasUsage) {
                                        console.error(`[DiagUsage-Raw] FULL response.completed raw: ${jsonData.substring(0, 1000)}`);
                                    }
                                } catch (_logErr) { /* 日志不能影响正常流 */ }
                            }

                            yield parsed;
                        } catch (e) {
                            // isStreamError 是我们故意抛出的，需要向上传播给 catch 块处理重试
                            if (e.isStreamError) throw e;
                            console.warn('[Codex] Failed to parse stream chunk:', jsonData);
                        }
                    }
                }
            }

            // DiagUsage: stream ended without [DONE]
            if (!_diagCompletedSeen) {
                console.error(`[DiagUsage-Raw] Stream ended without [DONE] and without response.completed! model=${_diagModel} uuid=${_diagUuid} chunks=${_diagChunkCount} lastType=${_diagLastType}`);
            }
        } catch (error) {
            const status = error.response?.status;
            const data = await formatAxiosErrorData(error.response?.data);
            const isScopeMissing = isProviderScopeMissingStatus(data, error.message);

            if (isScopeMissing) {
                markScopeMissingCredentialError(error, status, data, error.message);
                console.log(`[Codex] Provider scope missing (stream) for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
                throw error;
            }

            if (status === 401 && !authRetried && isExplicitUnauthorizedStatus(status, error.response?.headers, data, error.message)) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Unauthorized 401 (stream) for ${(this.config.uuid || '').slice(0,8)}, marking credential for deletion`);
                throw error;
            }

            if ((status === 401 || status === 403) && !authRetried) {
                try {
                    await this.refreshAccessToken();
                } catch (refreshErr) {
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_MISSING') {
                        if (status === 401) {
                            markPermanentCredentialError(error, status, data, refreshErr.message || error.message);
                        } else {
                            markAuthCredentialIssue(error, status, refreshErr.message || error.message);
                        }
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_DEAD') {
                        markAuthCredentialIssue(error, status, refreshErr.message || error.message);
                        error.shouldDeleteCredential = true;
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    if (refreshErr?.code === 'CODEX_REFRESH_LOCK_BUSY') {
                        error.skipErrorCount = true;
                        error.shouldSwitchCredential = true;
                        error.message = refreshErr.message || error.message;
                        throw error;
                    }
                    throw refreshErr;
                }
                yield* this.streamApi(endpoint, body, retryCount, true, requestHeaders, requestContext);
                return;
            }

            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
                return;
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries && !error.shouldDeleteCredential) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
                return;
            }

            if (!status && isRetryableNetworkError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, retryCount + 1, authRetried, requestHeaders, requestContext);
                return;
            }

            error.curlCommand = this.buildCurlCommand(endpoint, headers, requestBody);
            console.error(`[Codex] Stream request failed (Status: ${status}):`, data || error.message);

            const requestedModel = requestBody?.model || body?.model || null;

            if (isModelScopedUnavailableStatus(status, data, error.message)) {
                markModelScopedUnavailableError(error, status, data, error.message, requestedModel);
            }

            // 400 错误是客户端请求参数问题（如 verbosity 不支持），不是账号问题，不应标记账号异常
            if (status === 400) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = false;
            }

            if (error.isModelUnavailableScoped) {
                error.shouldSwitchCredential = false;
            }

            // 429 Rate Limit：重试耗尽后切号，标记短暂 cooldown 防止无限轮转
            if (status === 429) {
                const resetAtMs = parseRetryAfterMs(error.response?.headers) || (Date.now() + 15000);
                const retryAfterMs = Math.max(1000, resetAtMs - Date.now());
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                error.isQuotaCooldown = true;
                error.quotaResetTime = new Date(resetAtMs).toISOString();
                error.quotaResetDelayMs = retryAfterMs;
                error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                console.log(`[Codex] 429 Rate Limit (stream) for ${(this.config.uuid || '').slice(0,8)}, cooldown ${retryAfterMs}ms until ${error.quotaResetTime}`);
            }

            if (status >= 500 && status < 600) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                console.log(`[Codex] ${status} server error (stream) for ${(this.config.uuid || '').slice(0,8)}, switching credential`);
            }

            if (!status && isRetryableNetworkError(error)) {
                error.skipErrorCount = true;
                error.shouldSwitchCredential = true;
                console.log(`[Codex] Network error (stream) for ${(this.config.uuid || '').slice(0,8)}, switching credential`);
            }

            if (status === 402) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Permanent 402 (stream) for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
            }

            if ((status === 401 || status === 403) && authRetried && !error.isModelUnavailableScoped && !error.isQuotaCooldown && !error.shouldDeleteCredential) {
                markPermanentCredentialError(error, status, data, error.message);
            }


            // 401 (token refresh 已失败且明确额度信号)：按短暂冷却处理，避免误删
            if (status === 401 && authRetried && !error.shouldDeleteCredential && isQuotaExhaustedStatus(status, error.response?.headers, data, error.message)) {
                const resetAtMs = markQuotaCooldownError(error, status, error.response?.headers, 3600000);
                console.log(`[Codex] Quota exhausted (${status}) for ${(this.config.uuid || '').slice(0,8)}, recovery at ${new Date(resetAtMs).toISOString()}`);
            }

            throw error;
        }
    }

    async generateContent(model, requestBody, requestContext = null) {
        const context = requestContext && typeof requestContext === 'object' ? requestContext : null;
        const requestHeaders = context?.headers && typeof context.headers === 'object'
            ? requestContext.headers
            : null;
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (isRemoteCompactRequest(requestBody)) {
            const compactBody = { ...requestBody };
            delete compactBody.__remote_compact;
            const compactResponse = await this.callApi('/backend-api/codex/responses/compact', compactBody, 0, false, requestHeaders, context);
            return normalizeCompactResponseShape(compactResponse);
        }
        // Codex API 强制要求 stream: true，所以使用流式请求并收集完整响应
        const responseEvents = [];
        for await (const chunk of this.streamApi('/backend-api/codex/responses', requestBody, 0, false, requestHeaders, context)) {
            if (chunk && typeof chunk === 'object') {
                responseEvents.push(chunk);
            }
        }
        return reconstructCodexResponseFromEvents(responseEvents, model);
    }

    async *generateContentStream(model, requestBody, requestContext = null) {
        const context = requestContext && typeof requestContext === 'object' ? requestContext : null;
        const requestHeaders = context?.headers && typeof context.headers === 'object'
            ? requestContext.headers
            : null;
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (isRemoteCompactRequest(requestBody)) {
            const compactBody = { ...requestBody };
            delete compactBody.__remote_compact;
            const compactResponse = await this.callApi('/backend-api/codex/responses/compact', compactBody, 0, false, requestHeaders, context);
            yield normalizeCompactResponseShape(compactResponse);
            return;
        }
        yield* this.streamApi('/backend-api/codex/responses', requestBody, 0, false, requestHeaders, context);
    }

    async generateImage(model, requestBody, requestContext = null) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        const body = requestBody && typeof requestBody === 'object'
            ? { ...requestBody, model: model || requestBody.model }
            : { model };
        return generateCodexWebImage(this, body, requestContext && typeof requestContext === 'object' ? requestContext : null);
    }

    async getUsageLimits(retryCount = 0, authRetried = false) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (!this.isInitialized) {
            await this.initialize();
        }
        await this.ensureValidCredentials();

        try {
            const response = await this.axiosInstance.get('/backend-api/wham/usage', {
                headers: {
                    ...this.buildHeaders(),
                    Accept: 'application/json'
                }
            });
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;

            if ((status === 401 || status === 403) && !authRetried) {
                try {
                    await this.refreshAccessToken();
                } catch (refreshErr) {
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_DEAD') {
                        throw refreshErr;
                    }
                    throw refreshErr;
                }
                return this.getUsageLimits(retryCount, true);
            }

            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getUsageLimits(retryCount + 1, authRetried);
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getUsageLimits(retryCount + 1, authRetried);
            }

            if (!status && isRetryableNetworkError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getUsageLimits(retryCount + 1, authRetried);
            }

            if (status === 402) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Permanent 402 in usage check for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
            }

            console.error(`[Codex] Usage request failed (Status: ${status}):`, data || error.message);
            throw error;
        }
    }

    async getImageUsageLimits(retryCount = 0, authRetried = false) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        const timeoutMs = 30000;

        if (!this.isInitialized) {
            await this.initialize();
        }
        await this.ensureValidCredentials();

        const deviceId = crypto.randomUUID();
        const headers = {
            Authorization: `Bearer ${this.credentials.accessToken}`,
            'ChatGPT-Account-ID': this.credentials.accountId,
            'User-Agent': CODEX_BROWSER_USER_AGENT,
            Accept: 'application/json',
            'Accept-Language': CODEX_BROWSER_ACCEPT_LANGUAGE,
            'Content-Type': 'application/json',
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/`,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'oai-device-id': deviceId,
            Cookie: `oai-did=${deviceId}`,
            'x-openai-target-path': '/backend-api/conversation/init',
            'x-openai-target-route': '/backend-api/conversation/init'
        };

        try {
            // Native fetch avoids the Cloudflare 403 challenge that axios/http(s).Agent
            // can trigger for this browser-style quota endpoint inside containerized envs.
            return await fetchJsonWithTimeout(`${this.baseUrl}/backend-api/conversation/init`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    gizmo_id: null,
                    requested_default_model: null,
                    conversation_id: null,
                    timezone_offset_min: -480
                })
            }, timeoutMs);
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;

            if ((status === 401 || status === 403) && !authRetried) {
                try {
                    await this.refreshAccessToken();
                } catch (refreshErr) {
                    if (refreshErr?.code === 'CODEX_REFRESH_TOKEN_DEAD') {
                        throw refreshErr;
                    }
                    throw refreshErr;
                }
                return this.getImageUsageLimits(retryCount, true);
            }

            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getImageUsageLimits(retryCount + 1, authRetried);
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getImageUsageLimits(retryCount + 1, authRetried);
            }

            if (!status && (isRetryableNetworkError(error) || error?.code === 'FETCH_TIMEOUT') && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.getImageUsageLimits(retryCount + 1, authRetried);
            }

            console.error(`[Codex] Image usage request failed (Status: ${status}):`, data || error.message);
            throw error;
        }
    }

    async listModels(retryCount = 0, authRetried = false) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (!this.isInitialized) {
            await this.initialize();
        }
        await this.ensureValidCredentials();

        const clientVersion = encodeURIComponent(this.config.CODEX_VERSION || CODEX_DEFAULT_VERSION);
        const endpoint = `/backend-api/codex/models?client_version=${clientVersion}`;

        try {
            const response = await this.axiosInstance.get(endpoint, {
                headers: this.buildHeaders()
            });
            this._lastUpstreamHeaders = normalizeAxiosHeaders(response.headers);
            const normalized = normalizeModelListPayload(response.data);
            const imageConfig = await resolveCodexImageGenerationConfig();
            if (!normalized || !Array.isArray(normalized.data)) {
                console.warn('[Codex] Invalid or empty model list payload, using fallback list');
                const fallbackList = fallbackCodexModelList();
                return imageConfig.enabled ? fallbackList : filterCodexImageModels(fallbackList);
            }
            return imageConfig.enabled ? normalized : filterCodexImageModels(normalized);
        } catch (error) {
            const status = error.response?.status;
            const data = await formatAxiosErrorData(error.response?.data);

            if ((status === 401 || status === 403) && !authRetried) {
                try {
                    await this.refreshAccessToken();
                } catch (refreshErr) {
                    throw refreshErr;
                }
                return this.listModels(retryCount, true);
            }

            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.listModels(retryCount + 1, authRetried);
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.listModels(retryCount + 1, authRetried);
            }

            if (!status && isRetryableNetworkError(error) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.listModels(retryCount + 1, authRetried);
            }

            if (status === 402) {
                markPermanentCredentialError(error, status, data, error.message);
                console.log(`[Codex] Permanent 402 in model list for ${(this.config.uuid || '').slice(0,8)}, deleting credential`);
            }

            console.error(`[Codex] Failed to fetch remote model list (Status: ${status}):`, data || error.message);
            const fallbackList = fallbackCodexModelList();
            const imageConfig = await resolveCodexImageGenerationConfig();
            return imageConfig.enabled ? fallbackList : filterCodexImageModels(fallbackList);
        }
    }

    async refreshToken(force = false) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (force || this.isExpiryDateNear()) {
            await this.refreshAccessToken();
        }
    }

}
