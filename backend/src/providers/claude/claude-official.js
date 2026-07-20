import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import crypto from 'crypto';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import * as providerDao from '../../dao/provider-dao.js';
import { getOfficialChannelDefaultsSync } from '../../services/official-channel-config-cache.js';
import {
    ClaudeBaseService, normalizeClaudeBaseUrl, pickFirstNonEmpty,
    parseJsonSafely, getHeaderValueCaseInsensitive
} from './claude-base.js';

const CLAUDE_OFFICIAL_PROVIDER_TYPE = 'claude-offical';
const CLAUDE_OFFICIAL_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const CLAUDE_OFFICIAL_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OFFICIAL_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_OFFICIAL_OAUTH_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OFFICIAL_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_OFFICIAL_BETA_FLAGS = {
    OAUTH: 'oauth-2025-04-20',
    CLAUDE_CODE: 'claude-code-20250219',
    INTERLEAVED_THINKING: 'interleaved-thinking-2025-05-14',
    TOOL_STREAMING: 'fine-grained-tool-streaming-2025-05-14'
};
const CLAUDE_OFFICIAL_HEADER_ALLOWLIST = [
    'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-lang',
    'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch',
    'x-stainless-runtime', 'x-stainless-runtime-version',
    'anthropic-dangerous-direct-browser-access', 'x-app',
    'accept-language', 'sec-fetch-mode'
];
const OFFICIAL_OAUTH_REFRESH_LOCKS = new Map();

// ─── Multi-Tier Rate Limit Tracker ───
const RATE_LIMIT_REASON = {
    QUOTA_EXHAUSTED: 'quota_exhausted',       // 配额耗尽（阶梯退避: 60s→300s→1800s→7200s）
    RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded', // TPM/RPM 限流（固定 5s）
    MODEL_CAPACITY: 'model_capacity',          // 模型容量不足（渐进: 5s→10s→15s）
    SERVER_ERROR: 'server_error',              // 5xx 服务端错误（固定 8s，不累计失败）
    UNKNOWN: 'unknown'                         // 未知限流（固定 60s）
};

const QUOTA_BACKOFF_STEPS = [60000, 300000, 1800000, 7200000]; // 1m, 5m, 30m, 2h
const CAPACITY_BACKOFF_STEPS = [5000, 10000, 15000];
const FAILURE_EXPIRY_MS = 3600000; // 1 hour

class MultiTierRateLimitTracker {
    constructor() {
        // Map<accountId, Map<reason, { count, lastFailure, cooldownUntil }>>
        this._entries = new Map();
    }

    _getEntry(accountId, reason) {
        let byAccount = this._entries.get(accountId);
        if (!byAccount) { byAccount = new Map(); this._entries.set(accountId, byAccount); }
        let entry = byAccount.get(reason);
        if (!entry) { entry = { count: 0, lastFailure: 0, cooldownUntil: 0 }; byAccount.set(reason, entry); }
        // auto-expire after 1 hour of no failures
        if (entry.lastFailure > 0 && Date.now() - entry.lastFailure > FAILURE_EXPIRY_MS) {
            entry.count = 0; entry.lastFailure = 0; entry.cooldownUntil = 0;
        }
        return entry;
    }

    /**
     * 从错误响应中分类限流原因
     */
    classifyReason(status, errorData) {
        if (status >= 500 && status < 600 && status !== 529) return RATE_LIMIT_REASON.SERVER_ERROR;
        if (status === 529) return RATE_LIMIT_REASON.MODEL_CAPACITY;
        if (status !== 429) return RATE_LIMIT_REASON.UNKNOWN;
        // 429: 从 body 区分 quota vs rpm vs capacity
        const msg = typeof errorData === 'string' ? errorData
            : (errorData?.error?.message || errorData?.message || '');
        if (/quota|daily|weekly|monthly|usage.?limit/i.test(msg)) return RATE_LIMIT_REASON.QUOTA_EXHAUSTED;
        if (/capacity|overloaded|model.*busy/i.test(msg)) return RATE_LIMIT_REASON.MODEL_CAPACITY;
        if (/rate.?limit|too.?many|requests?.?per/i.test(msg)) return RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED;
        return RATE_LIMIT_REASON.QUOTA_EXHAUSTED; // 429 default → quota
    }

    /**
     * 记录一次限流失败，返回建议的退避时间(ms)
     */
    recordFailure(accountId, reason, serverRetryMs = 0) {
        const entry = this._getEntry(accountId, reason);
        const now = Date.now();
        // SERVER_ERROR 不累计 count（防止 5xx 污染 429 退避阶梯）
        if (reason !== RATE_LIMIT_REASON.SERVER_ERROR) {
            entry.count += 1;
        }
        entry.lastFailure = now;

        let delayMs;
        switch (reason) {
            case RATE_LIMIT_REASON.QUOTA_EXHAUSTED: {
                const step = Math.min(entry.count - 1, QUOTA_BACKOFF_STEPS.length - 1);
                delayMs = serverRetryMs > 0 ? Math.max(serverRetryMs, QUOTA_BACKOFF_STEPS[Math.max(0, step)]) : QUOTA_BACKOFF_STEPS[Math.max(0, step)];
                break;
            }
            case RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED:
                delayMs = serverRetryMs > 0 ? Math.max(serverRetryMs, 5000) : 5000;
                break;
            case RATE_LIMIT_REASON.MODEL_CAPACITY: {
                const capStep = Math.min(entry.count - 1, CAPACITY_BACKOFF_STEPS.length - 1);
                delayMs = CAPACITY_BACKOFF_STEPS[Math.max(0, capStep)];
                break;
            }
            case RATE_LIMIT_REASON.SERVER_ERROR:
                delayMs = 8000;
                break;
            default:
                delayMs = 60000;
        }
        // minimum 2s safety buffer
        delayMs = Math.max(2000, delayMs);
        entry.cooldownUntil = now + delayMs;
        return delayMs;
    }

    /**
     * 成功后重置该账号的所有失败计数
     */
    recordSuccess(accountId) {
        this._entries.delete(accountId);
    }

    /**
     * 检查账号是否在冷却中
     */
    isCoolingDown(accountId, reason) {
        const entry = this._getEntry(accountId, reason);
        return Date.now() < entry.cooldownUntil;
    }

    getFailureCount(accountId, reason) {
        return this._getEntry(accountId, reason).count;
    }
}

// 全局单例
const officialRateLimitTracker = new MultiTierRateLimitTracker();

function parseOfficialRateLimitResetMs(headers, errorPayload = null) {
    const resetRaw = getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-unified-reset');
    const resetTs = Number.parseInt(String(resetRaw || ''), 10);
    if (Number.isFinite(resetTs) && resetTs > 0) return resetTs * 1000;

    const retryAfterRaw = getHeaderValueCaseInsensitive(headers, 'retry-after');
    if (retryAfterRaw !== undefined && retryAfterRaw !== null && retryAfterRaw !== '') {
        const retryAfterSec = Number.parseInt(String(retryAfterRaw).trim(), 10);
        if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
            return Date.now() + retryAfterSec * 1000;
        }
        const retryAfterAt = new Date(String(retryAfterRaw));
        if (Number.isFinite(retryAfterAt.getTime()) && retryAfterAt.getTime() > Date.now()) {
            return retryAfterAt.getTime();
        }
    }

    const message = typeof errorPayload === 'string'
        ? errorPayload
        : (errorPayload?.error?.message || errorPayload?.message || '');
    const msg = String(message || '');
    if (!msg) return null;

    const zh = msg.match(/(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分(?:钟)?)?\s*(?:(\d+)\s*秒)?\s*(?:后恢复|后重试|后可用|后再试)/i);
    if (zh && (zh[1] || zh[2] || zh[3])) {
        const h = Number.parseInt(zh[1] || '0', 10);
        const m = Number.parseInt(zh[2] || '0', 10);
        const sec = Number.parseInt(zh[3] || '0', 10);
        const delayMs = h * 3600000 + m * 60000 + sec * 1000;
        if (delayMs > 0) return Date.now() + delayMs;
    }

    const en = msg.match(/in\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i);
    if (en && (en[1] || en[2] || en[3])) {
        const h = Number.parseInt(en[1] || '0', 10);
        const m = Number.parseInt(en[2] || '0', 10);
        const sec = Number.parseInt(en[3] || '0', 10);
        const delayMs = h * 3600000 + m * 60000 + sec * 1000;
        if (delayMs > 0) return Date.now() + delayMs;
    }

    const iso = msg.match(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
    if (iso) {
        const at = new Date(iso[0]);
        if (Number.isFinite(at.getTime()) && at.getTime() > Date.now()) return at.getTime();
    }

    return null;
}

function isOrganizationDisabledMessage(message) {
    return /this organization has been disabled/i.test(String(message || ''));
}

function markOrganizationExpiredError(error, status, rawMessage) {
    const detail = String(rawMessage || error?.message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);

    error.isOrganizationDisabled = true;
    error.permanentBlock = true;
    error.skipErrorCount = true;
    error.shouldSwitchCredential = true;
    error.shouldDeleteCredential = true;
    error.message = `Claude Official 账号到期(${status || 'unknown'})，已标记删除并切换账号${detail ? ` | ${detail}` : ''}`;
    return error;
}

/**
 * Claude Official API Service
 * 处理 claude-offical 类型的提供商（OAuth/Setup-Token/API-Key 模式）
 * 包含所有 CRS 对齐逻辑
 */
export class ClaudeOfficialApiService extends ClaudeBaseService {
    constructor(config) {
        super(config);
        this.officialAuthMode = this.resolveOfficialAuthMode();
        this.apiKey = config.CLAUDE_API_KEY || '';
        // 重新计算 baseUrl（official 有默认值）
        this.baseUrl = normalizeClaudeBaseUrl(
            config.CLAUDE_BASE_URL ||
            (this.isOfficialBearerMode() ? CLAUDE_OFFICIAL_DEFAULT_BASE_URL : '')
        );
        this.claudeOauthAccessToken = pickFirstNonEmpty(config.claudeOauthAccessToken, config.CLAUDE_OAUTH_ACCESS_TOKEN);
        this.claudeOauthRefreshToken = pickFirstNonEmpty(config.claudeOauthRefreshToken, config.CLAUDE_OAUTH_REFRESH_TOKEN);
        this.claudeOauthExpiresAt = pickFirstNonEmpty(config.claudeOauthExpiresAt, config.CLAUDE_OAUTH_EXPIRES_AT);
        this.claudeOauthClientId = pickFirstNonEmpty(config.claudeOauthClientId, config.CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OFFICIAL_OAUTH_CLIENT_ID);
        this.claudeOauthBetaHeader = pickFirstNonEmpty(config.claudeOauthBetaHeader, config.CLAUDE_OAUTH_BETA_HEADER, CLAUDE_OFFICIAL_OAUTH_BETA_HEADER);
        this._oauthRefreshPromise = null;

        if (this.officialAuthMode === 'api-key' && !this.apiKey) {
            throw new Error('Claude Official API Key 模式缺少 API Key');
        }
        if (this.isOfficialBearerMode() && !this.claudeOauthAccessToken) {
            throw new Error('Claude Official Bearer 模式缺少 access_token');
        }
        if (this.isOfficialOAuthMode() && !this.claudeOauthRefreshToken) {
            throw new Error('Claude Official OAuth 模式缺少 refresh_token');
        }

        // CRS 对齐属性
        this._unauthorizedErrors = [];
        this._cachedUserAgent = null;
        this._lastStreamUsage = null;
        this._sessionWindowStatus = null;
        this._sessionWindowStatusUpdatedAt = null;
        this._fiveHourAutoStopped = false;
        this._fiveHourStoppedAt = null;
        this._fiveHourRecoveryAt = null;
        this._quotaExhausted = false;       // 额度耗尽标志
        this._quotaExhaustedRecoveryAt = null; // 额度恢复时间
        this._quotaExhaustedReason = null;  // 耗尽原因
        this._toolNameReverseMap = null;

        // 重建 client（需要 baseUrl 更新后）
        this.client = this.createClient();
    }

    /** 读取配置值：账号级 → 渠道级默认值 → fallback */
    _cfgVal(key, fallback) {
        const v = this.config[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const cd = getOfficialChannelDefaultsSync();
        const cv = cd[key];
        if (cv !== undefined && cv !== null && cv !== '') return cv;
        return fallback;
    }

    _isFiveHourAutoStopEnabled() {
        const autoStop = this._cfgVal('officialAutoStopOnWarning', false);
        if (typeof autoStop === 'boolean') return autoStop;
        if (typeof autoStop === 'number') return autoStop !== 0;
        if (typeof autoStop === 'string') {
            const normalized = autoStop.trim().toLowerCase();
            if (['false', '0', 'off', 'no'].includes(normalized)) return false;
            if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
        }
        return Boolean(autoStop);
    }

    // ─── Auth Mode ───
    resolveOfficialAuthMode() {
        const mode = pickFirstNonEmpty(
            this.config.officialAuthMode,
            this.config.CLAUDE_OFFICIAL_AUTH_MODE,
            this.config.authMode
        ).toLowerCase();
        if (mode === 'oauth') return 'oauth';
        if (mode === 'api-key') return 'api-key';
        if (mode === 'setup-token' || mode === 'setup_token' || mode === 'setup') return 'setup-token';
        if (pickFirstNonEmpty(this.config.claudeOauthRefreshToken, this.config.CLAUDE_OAUTH_REFRESH_TOKEN)) return 'oauth';
        if (pickFirstNonEmpty(this.config.claudeOauthAccessToken, this.config.CLAUDE_OAUTH_ACCESS_TOKEN)) return 'setup-token';
        return 'api-key';
    }

    isOfficialBearerMode() {
        return this.officialAuthMode === 'oauth' || this.officialAuthMode === 'setup-token';
    }

    isOfficialOAuthMode() {
        return this.officialAuthMode === 'oauth';
    }

    // ─── Header Forwarding ───
    getOfficialForwardHeaders() {
        const forwarded = {};
        for (const headerName of CLAUDE_OFFICIAL_HEADER_ALLOWLIST) {
            const value = this._getRequestHeader(headerName);
            if (value) forwarded[headerName] = value;
        }
        const requestUserAgent = this._getRequestHeader('user-agent');
        if (requestUserAgent && /^claude-cli\//i.test(requestUserAgent)) {
            forwarded['user-agent'] = requestUserAgent;
        }
        return forwarded;
    }

    _buildDynamicBetaHeader() {
        const flags = new Set();
        if (this.isOfficialBearerMode()) flags.add(CLAUDE_OFFICIAL_BETA_FLAGS.OAUTH);
        const isHaiku = this._isHaikuModel();
        if (!isHaiku) {
            flags.add(CLAUDE_OFFICIAL_BETA_FLAGS.CLAUDE_CODE);
            flags.add(CLAUDE_OFFICIAL_BETA_FLAGS.TOOL_STREAMING);
        }
        flags.add(CLAUDE_OFFICIAL_BETA_FLAGS.INTERLEAVED_THINKING);
        const clientBeta = this._getRequestHeader('anthropic-beta');
        if (clientBeta) {
            for (const flag of clientBeta.split(',')) {
                const trimmed = flag.trim();
                if (trimmed) flags.add(trimmed);
            }
        }
        return Array.from(flags).join(', ');
    }

    _isHaikuModel() {
        const model = String(this.requestContext?.model || this.config?.model || '').toLowerCase();
        return model.includes('haiku');
    }

    // ─── Request Processing ───
    _formatUuidFromSeed(seed) {
        const digest = crypto.createHash('sha256').update(String(seed)).digest();
        const bytes = Buffer.from(digest.subarray(0, 16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    normalizeOfficialUserId(body) {
        if (!body || typeof body !== 'object') return body;
        const metadata = body.metadata;
        if (!metadata || typeof metadata !== 'object') return body;
        const userId = metadata.user_id;
        if (typeof userId !== 'string' || !userId.includes('session_')) return body;
        const pivot = userId.lastIndexOf('session_');
        if (pivot < 0) return body;
        const prefix = userId.slice(0, pivot);
        const sessionTail = userId.slice(pivot + 'session_'.length);
        if (!sessionTail) return body;
        const schedulerId = this.config?.uuid || 'unknown-scheduler';
        const normalizedSessionId = this._formatUuidFromSeed(`${schedulerId}::${sessionTail}`);
        let normalizedPrefix = prefix;
        const accountMarker = '_account_';
        if (this.config?.uuid) {
            const markerIndex = normalizedPrefix.indexOf(accountMarker);
            if (markerIndex === -1) {
                const base = normalizedPrefix.replace(/_+$/, '');
                normalizedPrefix = `${base}_account_${this.config.uuid}_`;
            } else {
                const valueStart = markerIndex + accountMarker.length;
                let separatorIndex = normalizedPrefix.indexOf('_', valueStart);
                if (separatorIndex === -1) separatorIndex = normalizedPrefix.length;
                const head = normalizedPrefix.slice(0, valueStart);
                const tail = separatorIndex < normalizedPrefix.length ? normalizedPrefix.slice(separatorIndex) : '_';
                normalizedPrefix = `${head}${this.config.uuid}${tail}`;
            }
        }
        const nextUserId = `${normalizedPrefix}session_${normalizedSessionId}`;
        if (nextUserId === userId) return body;
        return { ...body, metadata: { ...metadata, user_id: nextUserId } };
    }

    _removeBillingHeaderFromSystem(body) {
        if (!body || !body.system) return body;
        if (typeof body.system === 'string') {
            if (body.system.trim().startsWith('x-anthropic-billing-header')) {
                const { system, ...rest } = body;
                return rest;
            }
            return body;
        }
        if (Array.isArray(body.system)) {
            const filtered = body.system.filter(
                item => !(item && item.type === 'text' && typeof item.text === 'string'
                    && item.text.trim().startsWith('x-anthropic-billing-header'))
            );
            if (filtered.length < body.system.length) {
                return { ...body, system: filtered.length > 0 ? filtered : undefined };
            }
        }
        return body;
    }

    _deepRemoveCacheControl(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(v => this._deepRemoveCacheControl(v));
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'cache_control') continue;
            result[k] = this._deepRemoveCacheControl(v);
        }
        // 清理 metadata 中的非标准字段
        if (result.metadata && typeof result.metadata === 'object') {
            const { traceId, ...cleanMeta } = result.metadata;
            result.metadata = Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined;
        }
        return result;
    }

    _cleanMetadata(body) {
        if (!body) return body;
        // 转换 output_config -> output_format（官方 API 字段）
        const { output_config, ...cleaned } = body;
        if (output_config?.format) {
            cleaned.output_format = output_config.format;
            console.log('[Claude Official] Converted output_config.format -> output_format');
        }
        if (!cleaned.metadata || typeof cleaned.metadata !== 'object') return cleaned;
        const { traceId, ...cleanedMetadata } = cleaned.metadata;
        if (!traceId) return cleaned;
        return { ...cleaned, metadata: Object.keys(cleanedMetadata).length > 0 ? cleanedMetadata : undefined };
    }

    _prepareOfficialRequestBody(body) {
        if (!body || typeof body !== 'object') return body;
        let processed = this._deepRemoveCacheControl(body);
        processed = this._cleanMetadata(processed);
        processed = this._removeBillingHeaderFromSystem(processed);
        processed = this.normalizeOfficialUserId(processed);

        if (processed?.messages && Array.isArray(processed.messages)) {
            processed = {
                ...processed,
                messages: this._patchOrphanedToolUse(processed.messages)
            };
        }

        // Claude API 对 temperature/top_p 组合较敏感，优先保留 temperature
        if (processed?.temperature !== undefined && processed?.top_p !== undefined) {
            const { top_p, ...rest } = processed;
            processed = rest;
        }

        return processed;
    }

    _patchOrphanedToolUse(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return messages;
        const SYNTHETIC_TEXT = '[tool_result missing; tool execution interrupted]';
        const makeSyntheticResult = (toolUseId) => ({
            type: 'tool_result', tool_use_id: toolUseId, is_error: true,
            content: [{ type: 'text', text: SYNTHETIC_TEXT }]
        });
        const pendingToolUseIds = [];
        const patched = [];
        for (const message of messages) {
            if (!message || !Array.isArray(message.content)) { patched.push(message); continue; }
            if (message.role === 'assistant') {
                if (pendingToolUseIds.length > 0) {
                    patched.push({ role: 'user', content: pendingToolUseIds.map(makeSyntheticResult) });
                    console.warn(`[Claude Official] Patched ${pendingToolUseIds.length} orphaned tool_use(s): ${pendingToolUseIds.join(', ')}`);
                    pendingToolUseIds.length = 0;
                }
                const toolUseIds = message.content.filter(part => part?.type === 'tool_use' && typeof part.id === 'string').map(part => part.id);
                if (toolUseIds.length > 0) pendingToolUseIds.push(...toolUseIds);
                patched.push(message);
                continue;
            }
            if (message.role === 'user' && pendingToolUseIds.length > 0) {
                const toolResultIds = new Set(message.content.filter(p => p?.type === 'tool_result' && typeof p.tool_use_id === 'string').map(p => p.tool_use_id));
                const missing = pendingToolUseIds.filter(id => !toolResultIds.has(id));
                if (missing.length > 0) {
                    const synthetic = missing.map(makeSyntheticResult);
                    console.warn(`[Claude Official] Patched ${missing.length} missing tool_result(s): ${missing.join(', ')}`);
                    message.content = [...synthetic, ...message.content];
                }
                pendingToolUseIds.length = 0;
            }
            patched.push(message);
        }
        if (pendingToolUseIds.length > 0) {
            patched.push({ role: 'user', content: pendingToolUseIds.map(makeSyntheticResult) });
            console.warn(`[Claude Official] Patched ${pendingToolUseIds.length} trailing orphaned tool_use(s)`);
        }
        return patched;
    }

    // ─── 3-Level Context Compression ───

    _estimateTokens(text) {
        if (!text || typeof text !== 'string') return 0;
        let tokens = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            // CJK ranges: ~1.5 chars/token; ASCII: ~4 chars/token
            if (code >= 0x4E00 && code <= 0x9FFF || code >= 0x3400 && code <= 0x4DBF || code >= 0xF900 && code <= 0xFAFF) {
                tokens += 1 / 1.5;
            } else {
                tokens += 1 / 4;
            }
        }
        return Math.ceil(tokens * 1.15); // 15% safety margin
    }

    _estimateMessagesTokens(messages) {
        if (!Array.isArray(messages)) return 0;
        let total = 0;
        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                total += this._estimateTokens(msg.content);
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (typeof block === 'string') total += this._estimateTokens(block);
                    else if (block?.text) total += this._estimateTokens(block.text);
                    else if (block?.content) total += this._estimateTokens(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
                    else if (block?.input) total += this._estimateTokens(typeof block.input === 'string' ? block.input : JSON.stringify(block.input));
                    else if (block?.thinking) total += this._estimateTokens(block.thinking);
                }
            }
        }
        return total;
    }

    /**
     * L1: 压缩大型 tool_result 内容（>2000字符截断）
     */
    _compressToolResults(messages, maxChars = 2000) {
        let compressed = false;
        const result = messages.map(msg => {
            if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
            const newContent = msg.content.map(block => {
                if (block?.type !== 'tool_result') return block;
                const text = typeof block.content === 'string' ? block.content : (block.content ? JSON.stringify(block.content) : '');
                if (text.length <= maxChars) return block;
                compressed = true;
                return { ...block, content: text.slice(0, maxChars) + `\n\n[... truncated ${text.length - maxChars} chars ...]` };
            });
            return { ...msg, content: newContent };
        });
        if (compressed) console.log('[ContextCompress] L1: Compressed large tool_result blocks');
        return result;
    }

    /**
     * L2: 移除旧的 thinking 块，只保留最近一轮
     */
    _stripOldThinkingBlocks(messages) {
        // 找到最后一个含 thinking 的 assistant 消息索引
        let lastThinkingIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' && Array.isArray(messages[i].content)) {
                if (messages[i].content.some(b => b?.type === 'thinking' && b?.thinking)) {
                    lastThinkingIdx = i;
                    break;
                }
            }
        }
        if (lastThinkingIdx <= 0) return messages;

        let stripped = false;
        const result = messages.map((msg, idx) => {
            if (idx >= lastThinkingIdx) return msg;
            if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
            const filtered = msg.content.filter(b => {
                if (b?.type === 'thinking' && b?.thinking) { stripped = true; return false; }
                return true;
            });
            if (filtered.length === msg.content.length) return msg;
            return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '[thinking removed]' }] };
        });
        if (stripped) console.log('[ContextCompress] L2: Stripped old thinking blocks');
        return result;
    }

    /**
     * L3: Fork + Summary — 生成 XML 状态摘要替换全部历史
     */
    _forkWithSummary(messages, systemPrompt) {
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const toolNames = new Set();
        for (const msg of messages) {
            if (!Array.isArray(msg.content)) continue;
            for (const b of msg.content) {
                if (b?.type === 'tool_use' && b?.name) toolNames.add(b.name);
            }
        }

        const summaryXml = [
            '<context_summary>',
            `<total_turns>${messages.length}</total_turns>`,
            toolNames.size > 0 ? `<tools_used>${[...toolNames].join(', ')}</tools_used>` : '',
            '<note>Previous conversation was compressed due to context length. Continue from the last exchange.</note>',
            '</context_summary>'
        ].filter(Boolean).join('\n');

        const compressed = [];
        compressed.push({ role: 'user', content: summaryXml });
        if (lastAssistant) compressed.push(lastAssistant);
        if (lastUser && lastUser !== compressed[0]) compressed.push(lastUser);
        // 确保消息交替正确（user → assistant → user）
        if (compressed.length > 0 && compressed[compressed.length - 1].role !== 'user') {
            compressed.push({ role: 'user', content: 'Please continue.' });
        }

        console.log(`[ContextCompress] L3: Forked conversation from ${messages.length} messages to ${compressed.length}`);
        return compressed;
    }

    /**
     * 应用 3 级上下文压缩
     */
    _applyContextCompression(requestBody) {
        if (!requestBody?.messages || !Array.isArray(requestBody.messages) || requestBody.messages.length === 0) return requestBody;
        const maxTokens = Number(requestBody.max_tokens) || 8192;
        // 模型上下文窗口估算（Claude 200k）
        const contextWindow = 200000;
        const l1Threshold = Number(this._cfgVal('officialContextL1Threshold', 0.40)) || 0.40;
        const l2Threshold = Number(this._cfgVal('officialContextL2Threshold', 0.55)) || 0.55;
        const l3Threshold = Number(this._cfgVal('officialContextL3Threshold', 0.70)) || 0.70;

        let messages = requestBody.messages;
        const estimatedTokens = this._estimateMessagesTokens(messages);
        const ratio = estimatedTokens / contextWindow;

        if (ratio < l1Threshold) return requestBody;

        // L1: 压缩大型 tool_result
        messages = this._compressToolResults(messages);
        let newRatio = this._estimateMessagesTokens(messages) / contextWindow;
        if (newRatio < l2Threshold) return { ...requestBody, messages };

        // L2: 移除旧 thinking 块
        messages = this._stripOldThinkingBlocks(messages);
        newRatio = this._estimateMessagesTokens(messages) / contextWindow;
        if (newRatio < l3Threshold) return { ...requestBody, messages };

        // L3: Fork + Summary
        messages = this._forkWithSummary(messages, requestBody.system);
        return { ...requestBody, messages };
    }

    // ─── CRS 对齐：错误追踪 & User-Agent ───
    _recordUnauthorizedError() {
        const now = Date.now();
        const WINDOW_MS = 5 * 60 * 1000;
        this._unauthorizedErrors.push(now);
        this._unauthorizedErrors = this._unauthorizedErrors.filter(t => now - t < WINDOW_MS);
        const count = this._unauthorizedErrors.length;
        console.warn(`[Claude Official] Account has ${count} consecutive 401 error(s) in the last 5 minutes`);
        return count;
    }

    _captureUserAgent() {
        const clientUA = this._getRequestHeader('user-agent');
        if (!clientUA || !/^claude-cli\//i.test(clientUA)) {
            return this._cachedUserAgent || 'claude-cli/2.0.53 (external, cli)';
        }
        if (!this._cachedUserAgent) { this._cachedUserAgent = clientUA; return clientUA; }
        const extractVersion = (ua) => { const m = ua.match(/^claude-cli\/([\d.]+)/i); return m ? m[1] : '0'; };
        const cached = extractVersion(this._cachedUserAgent);
        const incoming = extractVersion(clientUA);
        if (incoming.localeCompare(cached, undefined, { numeric: true }) > 0) this._cachedUserAgent = clientUA;
        return this._cachedUserAgent;
    }

    async _extractSessionWindowStatus(headers) {
        if (!headers) return;
        const status = getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-unified-5h-status');
        if (!status) return;
        const prev = this._sessionWindowStatus;
        this._sessionWindowStatus = status;
        this._sessionWindowStatusUpdatedAt = Date.now();
        console.log(`[Claude Official] 5h session window status: ${status}`);

        // allowed_warning → 自动停调度（防封号核心）
        if (!this._isFiveHourAutoStopEnabled()) return;
        if (status.toLowerCase() === 'allowed_warning' && prev !== 'allowed_warning') {
            // 5h 窗口剩余时间估算：从现在起最多 5 小时后恢复
            const recoveryMs = 5 * 60 * 60 * 1000 + 60 * 1000; // 5h + 1min buffer
            this._fiveHourAutoStopped = true;
            this._fiveHourStoppedAt = Date.now();
            this._fiveHourRecoveryAt = Date.now() + recoveryMs;
            console.warn(`[Claude Official] ⚠️ 5h warning auto-stop: account ${(this.config.uuid || '').slice(0, 8)} will recover at ${new Date(this._fiveHourRecoveryAt).toISOString()}`);
            // 通知 pool manager 标记账号 COOLDOWN，不再参与分配
            await this._notifyPoolManagerCooldown(new Date(this._fiveHourRecoveryAt), '5h window allowed_warning auto-stop');
        }
        if (status.toLowerCase() === 'allowed' && this._fiveHourAutoStopped) {
            this._fiveHourAutoStopped = false;
            this._fiveHourStoppedAt = null;
            this._fiveHourRecoveryAt = null;
            console.log(`[Claude Official] ✓ 5h window recovered for account ${(this.config.uuid || '').slice(0, 8)}`);
            // 恢复后通知 pool manager 标记健康
            await this._notifyPoolManagerHealthy();
        }
    }

    get sessionWindowStatus() { return this._sessionWindowStatus; }
    get sessionWindowStatusUpdatedAt() { return this._sessionWindowStatusUpdatedAt || null; }
    get fiveHourAutoStopped() { return this._fiveHourAutoStopped === true; }
    get fiveHourRecoveryAt() { return this._fiveHourRecoveryAt || null; }
    get lastStreamUsage() { return this._lastStreamUsage || null; }

    // ─── 额度耗尽主动标记 COOLDOWN ───

    /**
     * 通知 pool manager 将当前账号标记为 COOLDOWN（不参与分配，等待恢复）
     */
    async _notifyPoolManagerCooldown(recoveryTime, reason) {
        try {
            const poolManager = getProviderPoolManager();
            const uuid = this.config.uuid;
            if (!poolManager || !uuid) return;
            console.log(`[Claude Official] 🧊 Marking account ${uuid.slice(0, 8)} as cooldown: ${reason}, recovery at ${recoveryTime.toISOString()}`);
            await poolManager.markProviderUnhealthyWithRecoveryTime(
                CLAUDE_OFFICIAL_PROVIDER_TYPE, uuid, recoveryTime, reason, {
                    action: 'mark_unhealthy_quota_exhausted',
                    source: 'quota_exhausted',
                    metadata: { reason }
                }
            );
        } catch (e) {
            console.error('[Claude Official] Failed to notify pool manager cooldown:', e.message);
        }
    }

    /**
     * 通知 pool manager 将当前账号恢复为健康
     */
    async _notifyPoolManagerHealthy() {
        try {
            const poolManager = getProviderPoolManager();
            const uuid = this.config.uuid;
            if (!poolManager || !uuid) return;
            if (typeof poolManager.markProviderHealthy === 'function') {
                await poolManager.markProviderHealthy(CLAUDE_OFFICIAL_PROVIDER_TYPE, uuid, {
                    action: 'recover_from_cooldown', source: 'quota_recovered'
                });
                console.log(`[Claude Official] ✅ Account ${uuid.slice(0, 8)} marked healthy`);
            }
        } catch (e) {
            console.error('[Claude Official] Failed to notify pool manager healthy:', e.message);
        }
    }

    async _hasDbQuotaCooldownState() {
        try {
            const uuid = this.config.uuid;
            if (!uuid) return false;
            const provider = await providerDao.findByUuid(uuid);
            if (!provider || provider.is_deleted || provider.is_disabled || provider.is_healthy) return false;
            const credentials = provider.credentials && typeof provider.credentials === 'object'
                ? provider.credentials
                : {};
            const relayState = String(credentials.relayState || '').trim().toLowerCase();
            if (relayState !== 'cooldown' && relayState !== 'overloaded') return false;
            const source = String(credentials.relayStateSource || '').trim().toLowerCase();
            const reason = String(credentials.relayStateReason || provider.last_error_message || '').trim().toLowerCase();
            if (source === 'quota_exhausted') return true;
            return /quota|exhaust|rate.?limit|window exhausted|窗口/.test(reason);
        } catch (e) {
            console.error('[Claude Official] Failed to check DB quota cooldown state:', e.message);
            return false;
        }
    }

    /**
     * 从成功响应 headers 中检查剩余额度，额度为 0 时主动标记 COOLDOWN
     */
    async _checkQuotaRemaining(headers) {
        if (!headers) return;
        const tokensRemaining = Number(getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-tokens-remaining'));
        const requestsRemaining = Number(getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-requests-remaining'));
        const tokensReset = getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-tokens-reset');
        const requestsReset = getHeaderValueCaseInsensitive(headers, 'anthropic-ratelimit-requests-reset');
        const uuid = (this.config.uuid || '').slice(0, 8);

        // token 额度为 0
        if (Number.isFinite(tokensRemaining) && tokensRemaining <= 0 && tokensReset) {
            const resetAt = new Date(tokensReset);
            if (Number.isFinite(resetAt.getTime()) && resetAt.getTime() > Date.now()) {
                const reason = `tokens remaining = 0, reset at ${resetAt.toISOString()}`;
                console.warn(`[Claude Official] ⚠️ ${reason} for account ${uuid}`);
                this._setLocalQuotaExhausted(resetAt.getTime(), reason);
                await this._notifyPoolManagerCooldown(resetAt, reason);
                return;
            }
        }
        // 请求额度为 0
        if (Number.isFinite(requestsRemaining) && requestsRemaining <= 0 && requestsReset) {
            const resetAt = new Date(requestsReset);
            if (Number.isFinite(resetAt.getTime()) && resetAt.getTime() > Date.now()) {
                const reason = `requests remaining = 0, reset at ${resetAt.toISOString()}`;
                console.warn(`[Claude Official] ⚠️ ${reason} for account ${uuid}`);
                this._setLocalQuotaExhausted(resetAt.getTime(), reason);
                await this._notifyPoolManagerCooldown(resetAt, reason);
                return;
            }
        }
        // headers 显示有额度：立即清除本地额度耗尽，并同步恢复池状态
        const hasPositiveQuotaSignal =
            (Number.isFinite(tokensRemaining) && tokensRemaining > 0)
            || (Number.isFinite(requestsRemaining) && requestsRemaining > 0);
        if (hasPositiveQuotaSignal && this._quotaExhausted) {
            console.log(`[Claude Official] ✅ Quota recovered (from headers) for account ${uuid}`);
            this._quotaExhausted = false;
            this._quotaExhaustedRecoveryAt = null;
            this._quotaExhaustedReason = null;
            await this._notifyPoolManagerHealthy();
        }
    }

    /**
     * 入口检查：账号是否可用（5h auto-stop / 额度耗尽）
     * 不可用时直接抛错，带 shouldSwitchCredential 标志让外层切号
     */
    _ensureAccountAvailable() {
        if (!this._isFiveHourAutoStopEnabled() && this._fiveHourAutoStopped) {
            this._fiveHourAutoStopped = false;
            this._fiveHourStoppedAt = null;
            this._fiveHourRecoveryAt = null;
        }
        if (this._fiveHourAutoStopped) {
            const err = new Error(`此账号已触发 5h 窗口保护，将于 ${new Date(this._fiveHourRecoveryAt).toISOString()} 自动恢复。`);
            err.status = 429; err.statusCode = 429;
            err.isQuotaCooldown = true;
            err.shouldSwitchCredential = true;
            err.skipErrorCount = true;
            err.quotaResetTime = new Date(this._fiveHourRecoveryAt).toISOString();
            err.quotaResetDelayMs = Math.max(0, this._fiveHourRecoveryAt - Date.now());
            err.quotaResetFormatted = new Date(this._fiveHourRecoveryAt).toISOString();
            throw err;
        }
        // 额度耗尽检查（来自 response headers 或 usage API）
        if (this._quotaExhausted && this._quotaExhaustedRecoveryAt) {
            // 恢复时间已过 → 清除标志，允许请求
            if (Date.now() >= this._quotaExhaustedRecoveryAt) {
                this._quotaExhausted = false;
                this._quotaExhaustedRecoveryAt = null;
                this._quotaExhaustedReason = null;
                return;
            }
            const recoveryIso = new Date(this._quotaExhaustedRecoveryAt).toISOString();
            const err = new Error(`此账号额度已耗尽（${this._quotaExhaustedReason || 'unknown'}），将于 ${recoveryIso} 自动恢复。`);
            err.status = 429; err.statusCode = 429;
            err.isQuotaCooldown = true;
            err.shouldSwitchCredential = true;
            err.skipErrorCount = true;
            err.quotaResetTime = recoveryIso;
            err.quotaResetDelayMs = Math.max(0, this._quotaExhaustedRecoveryAt - Date.now());
            err.quotaResetFormatted = recoveryIso;
            throw err;
        }
    }

    /**
     * 从 OAuth usage API 响应中检查各窗口 utilization，额度耗尽时主动标记 COOLDOWN
     * 窗口: five_hour, seven_day, seven_day_sonnet, seven_day_opus
     */
    async _checkUsageWindowExhaustion(payload) {
        if (!payload || typeof payload !== 'object') return;
        const windows = [
            { key: 'five_hour', label: '5小时窗口', defaultRecoveryMs: 5 * 3600 * 1000 },
            { key: 'seven_day', label: '7天窗口', defaultRecoveryMs: 7 * 24 * 3600 * 1000 },
            { key: 'seven_day_sonnet', label: '7天Sonnet窗口', defaultRecoveryMs: 7 * 24 * 3600 * 1000 },
            { key: 'seven_day_opus', label: '7天Opus窗口', defaultRecoveryMs: 7 * 24 * 3600 * 1000 }
        ];
        const parseUtilization = (value) => {
            if (value === null || value === undefined || value === '') return null;
            if (typeof value === 'string') {
                const cleaned = value.trim().replace(/%$/, '');
                if (!cleaned) return null;
                const parsed = Number(cleaned);
                return Number.isFinite(parsed) ? parsed : null;
            }
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const utilizationSamples = windows
            .map(({ key }) => parseUtilization(payload?.[key]?.utilization))
            .filter((value) => Number.isFinite(value));
        const hasGtOne = utilizationSamples.some((value) => value > 1);
        const hasBetweenZeroAndOne = utilizationSamples.some((value) => value > 0 && value < 1);
        const toUsedPercent = (value) => {
            const num = parseUtilization(value);
            if (!Number.isFinite(num)) return null;
            if (num > 1) return Math.max(0, Math.min(100, num));
            if (num < 1) return Math.max(0, Math.min(100, num * 100));
            if (!hasGtOne && hasBetweenZeroAndOne) return 100;
            return 1;
        };
        const uuid = (this.config.uuid || '').slice(0, 8);
        let parsedWindowCount = 0;
        let anyExhausted = false;
        const exhaustedWindows = [];
        for (const { key, label, defaultRecoveryMs } of windows) {
            const windowData = payload[key];
            if (!windowData || typeof windowData !== 'object') continue;
            const usedPercent = toUsedPercent(windowData.utilization);
            if (usedPercent === null) continue;
            parsedWindowCount += 1;

            // 兼容两种格式：0~1（小数）或 0~100（百分比）
            const normalizedUtilization = usedPercent / 100;

            // normalizedUtilization >= 1.0 表示额度 100% 用尽
            if (normalizedUtilization >= 1.0) {
                let resetAt = windowData.resets_at
                    ? new Date(windowData.resets_at)
                    : null;
                if (!Number.isFinite(resetAt?.getTime()) || resetAt.getTime() <= Date.now()) {
                    resetAt = new Date(Date.now() + defaultRecoveryMs);
                }
                exhaustedWindows.push({ key, label, usedPercent, resetAt });
            }
        }
        if (exhaustedWindows.length > 0) {
            const targetWindow = exhaustedWindows.reduce((latest, item) => (
                item.resetAt.getTime() > latest.resetAt.getTime() ? item : latest
            ), exhaustedWindows[0]);
            const reason = exhaustedWindows.length === 1
                ? `${targetWindow.label} exhausted (utilization=${targetWindow.usedPercent.toFixed(2)}%)`
                : `multi-window exhausted: ${exhaustedWindows.map((item) => `${item.label}=${item.usedPercent.toFixed(2)}%`).join(', ')}`;
            console.warn(`[Claude Official] 🧊 ${reason} for account ${uuid}, reset at ${targetWindow.resetAt.toISOString()}`);
            this._setLocalQuotaExhausted(targetWindow.resetAt.getTime(), reason);
            await this._notifyPoolManagerCooldown(targetWindow.resetAt, reason);
            anyExhausted = true;
        }
        // 所有窗口都没耗尽 → 清除耗尽标志
        const hasCoreWindows = ['five_hour', 'seven_day'].every((key) => payload?.[key] && typeof payload[key] === 'object');
        const canRecoverByPayload = hasCoreWindows && parsedWindowCount > 0;
        const shouldRecoverFromDb = !this._fiveHourAutoStopped && await this._hasDbQuotaCooldownState();
        if (!anyExhausted && canRecoverByPayload && (this._quotaExhausted || shouldRecoverFromDb)) {
            console.log(`[Claude Official] ✅ Quota recovered for account ${(this.config.uuid || '').slice(0, 8)}`);
            this._quotaExhausted = false;
            this._quotaExhaustedRecoveryAt = null;
            this._quotaExhaustedReason = null;
            await this._notifyPoolManagerHealthy();
        } else if (!anyExhausted && !canRecoverByPayload && (this._quotaExhausted || shouldRecoverFromDb)) {
            console.log(`[Claude Official] ℹ️ Skip quota recovery due to incomplete window payload for account ${uuid}`);
        }
    }

    // ─── CRS 对齐：限流消息 ───
    _formatResetTime(isoString) {
        if (!isoString) return null;
        try {
            const d = new Date(isoString);
            if (!Number.isFinite(d.getTime())) return isoString;
            return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        } catch { return isoString; }
    }

    _buildRateLimitMessage(resetTime) {
        if (!resetTime) return '此账号已触发 Anthropic 限流控制。';
        return `此账号已触发 Anthropic 限流控制，将于 ${this._formatResetTime(resetTime)} 自动恢复。`;
    }

    _buildQuotaExhaustedMessage(resetTime) {
        if (!resetTime) return '此账号额度已耗尽，请稍后再试或切换账号。';
        return `此账号额度已耗尽，将于 ${this._formatResetTime(resetTime)} 自动恢复。`;
    }

    _setLocalQuotaExhausted(resetAtMs, reason = 'quota_exhausted') {
        const recoveryMs = Number(resetAtMs);
        if (!Number.isFinite(recoveryMs) || recoveryMs <= Date.now()) return false;
        if (Number.isFinite(this._quotaExhaustedRecoveryAt) && this._quotaExhaustedRecoveryAt > recoveryMs) {
            return true;
        }
        this._quotaExhausted = true;
        this._quotaExhaustedRecoveryAt = recoveryMs;
        this._quotaExhaustedReason = reason;
        return true;
    }

    _buildOpusLimitMessage(resetTime) {
        if (!resetTime) return '此账号的 Opus 模型已达到周使用限制，请尝试切换其他模型后再试。';
        return `此账号的 Opus 模型已达到周使用限制，将于 ${this._formatResetTime(resetTime)} 自动恢复，请尝试切换其他模型后再试。`;
    }

    _isOpusModelRequest(body) {
        return String(body?.model || '').toLowerCase().includes('opus');
    }

    _mapConnectionError(error) {
        switch (error.code) {
            case 'ECONNRESET': return 'Connection reset by Claude API server';
            case 'ENOTFOUND': return 'Unable to resolve Claude API hostname';
            case 'ECONNREFUSED': return 'Connection refused by Claude API server';
            case 'ETIMEDOUT': return 'Connection timed out to Claude API server';
            case 'EPIPE': return 'Broken pipe to Claude API server';
            default: return null;
        }
    }

    // ─── CRS 对齐：Tool Name 混淆 ───
    _isClaudeCodeCredentialError(error) {
        const errData = error.response?.data;
        const msg = typeof errData === 'string' ? errData : (errData?.error?.message || errData?.message || error.message || '');
        return /only authorized for use with claude code/i.test(msg) || /cannot be used for other api requests/i.test(msg);
    }

    _isActualClaudeCodeRequest(body) {
        const ua = this._getRequestHeader('user-agent');
        if (!ua || !/^claude-cli\/[^\s]+\s+\(/i.test(ua)) return false;
        const system = body?.system;
        if (typeof system === 'string') return /claude.code|claude_code|anthropic/i.test(system);
        if (Array.isArray(system)) return system.some(item => item?.type === 'text' && typeof item.text === 'string' && /claude.code|claude_code|anthropic/i.test(item.text));
        return true;
    }

    _randomizeToolName(name) {
        const pascal = name.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
        const suffix = crypto.randomBytes(3).toString('hex').slice(0, 4);
        return `${pascal}${suffix}`;
    }

    _transformToolNames(body) {
        if (!body?.tools || !Array.isArray(body.tools) || body.tools.length === 0) return { body, reverseMap: null };
        const forwardMap = new Map();
        const reverseMap = new Map();
        const transformedTools = body.tools.map(tool => {
            if (!tool?.name) return tool;
            const randomized = this._randomizeToolName(tool.name);
            forwardMap.set(tool.name, randomized);
            reverseMap.set(randomized, tool.name);
            return { ...tool, name: randomized };
        });
        const transformedMessages = (body.messages || []).map(msg => {
            if (!msg?.content || !Array.isArray(msg.content)) return msg;
            const newContent = msg.content.map(part => {
                if (part?.type === 'tool_use' && part.name && forwardMap.has(part.name)) return { ...part, name: forwardMap.get(part.name) };
                return part;
            });
            return { ...msg, content: newContent };
        });
        return { body: { ...body, tools: transformedTools, messages: transformedMessages }, reverseMap };
    }

    _restoreToolNames(chunk, reverseMap) {
        if (!reverseMap || !chunk) return chunk;
        if (chunk.content && Array.isArray(chunk.content)) {
            const restored = chunk.content.map(part => {
                if (part?.type === 'tool_use' && part.name && reverseMap.has(part.name)) return { ...part, name: reverseMap.get(part.name) };
                return part;
            });
            return { ...chunk, content: restored };
        }
        if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use'
            && chunk.content_block.name && reverseMap.has(chunk.content_block.name)) {
            return { ...chunk, content_block: { ...chunk.content_block, name: reverseMap.get(chunk.content_block.name) } };
        }
        return chunk;
    }

    // ─── OAuth 管理 ───
    oauthExpiresSoon() {
        if (!this.claudeOauthExpiresAt) return false;
        const expiresAtMs = new Date(this.claudeOauthExpiresAt).getTime();
        if (!Number.isFinite(expiresAtMs)) return false;
        return expiresAtMs <= (Date.now() + 2 * 60 * 1000);
    }

    getOfficialRefreshLockKey() {
        return String(this.config?.uuid || this.claudeOauthRefreshToken || this.claudeOauthAccessToken || 'claude-official-default');
    }

    async runWithOfficialRefreshLock(task) {
        const lockKey = this.getOfficialRefreshLockKey();
        const existing = OFFICIAL_OAUTH_REFRESH_LOCKS.get(lockKey);
        if (existing) return existing;
        const promise = (async () => {
            try { return await task(); }
            finally { if (OFFICIAL_OAUTH_REFRESH_LOCKS.get(lockKey) === promise) OFFICIAL_OAUTH_REFRESH_LOCKS.delete(lockKey); }
        })();
        OFFICIAL_OAUTH_REFRESH_LOCKS.set(lockKey, promise);
        return promise;
    }

    async persistOAuthCredentials() {
        if (!this.config?.uuid || !this.isOfficialBearerMode()) return;
        const latestProvider = await providerDao.findByUuid(this.config.uuid);
        if (!latestProvider) return;
        const latestCredentials = latestProvider.credentials && typeof latestProvider.credentials === 'object' ? latestProvider.credentials : {};
        await providerDao.update(this.config.uuid, {
            credentials: {
                ...latestCredentials,
                officialAuthMode: this.officialAuthMode,
                claudeOauthClientId: this.claudeOauthClientId,
                claudeOauthAccessToken: this.claudeOauthAccessToken,
                claudeOauthRefreshToken: this.claudeOauthRefreshToken,
                claudeOauthExpiresAt: this.claudeOauthExpiresAt,
                claudeOauthBetaHeader: this.claudeOauthBetaHeader || CLAUDE_OFFICIAL_OAUTH_BETA_HEADER
            }
        });
    }

    async refreshToken(force = false) {
        if (!this.isOfficialOAuthMode()) return;
        if (!force && !this.oauthExpiresSoon()) return;
        if (this._oauthRefreshPromise) return this._oauthRefreshPromise;
        const refreshPromise = this.runWithOfficialRefreshLock(async () => {
            const payload = {
                grant_type: 'refresh_token',
                refresh_token: this.claudeOauthRefreshToken,
                client_id: this.claudeOauthClientId || CLAUDE_OFFICIAL_OAUTH_CLIENT_ID
            };
            let response = null;
            try {
                response = await this.client.post(CLAUDE_OFFICIAL_OAUTH_TOKEN_ENDPOINT, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/plain, */*',
                        'User-Agent': 'claude-cli/2.0.53 (external, cli)',
                        'Accept-Language': 'en-US,en;q=0.9',
                        Referer: 'https://claude.ai/',
                        Origin: 'https://claude.ai'
                    }
                });
            } catch (error) {
                if (error?.response) response = error.response;
                else throw error;
            }
            const payloadData = response?.data && typeof response.data === 'object'
                ? response.data : parseJsonSafely(typeof response?.data === 'string' ? response.data : '');
            if (!response || response.status < 200 || response.status >= 300) {
                const errBody = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data || {});
                console.error(`[Claude Official] OAuth 刷新失败: HTTP ${response?.status || 'unknown'}, UUID: ${this.config?.uuid || 'unknown'}, body: ${errBody}`);
                // 尝试用 sessionKey 重新走 Cookie OAuth 授权
                const sessionKey = this.config?.claudeOauthSessionKey;
                if (sessionKey) {
                    console.log(`[Claude Official] refresh_token 失效，尝试用 sessionKey 重新授权...`);
                    try {
                        const { handleClaudeOfficialCookieReAuth } = await import('../../auth/oauth-handlers.js');
                        const newTokenData = await handleClaudeOfficialCookieReAuth(sessionKey, this.config?.officialAuthMode || 'oauth');
                        this.claudeOauthAccessToken = newTokenData.access_token;
                        this.claudeOauthRefreshToken = newTokenData.refresh_token || this.claudeOauthRefreshToken;
                        this.claudeOauthExpiresAt = new Date(Date.now() + Number(newTokenData.expires_in || 3600) * 1000).toISOString();
                        this.config.claudeOauthAccessToken = this.claudeOauthAccessToken;
                        this.config.claudeOauthRefreshToken = this.claudeOauthRefreshToken;
                        this.config.claudeOauthExpiresAt = this.claudeOauthExpiresAt;
                        await this.persistOAuthCredentials();
                        console.log(`[Claude Official] sessionKey 重新授权成功, UUID: ${this.config?.uuid || 'unknown'}`);
                        return;
                    } catch (reAuthError) {
                        console.error(`[Claude Official] sessionKey 重新授权也失败: ${reAuthError.message}`);
                    }
                }
                throw new Error(`Claude Official OAuth 刷新失败: HTTP ${response?.status || 'unknown'} ${errBody}`);
            }
            const accessToken = payloadData?.access_token;
            const refreshToken = payloadData?.refresh_token || this.claudeOauthRefreshToken;
            const expiresIn = Number(payloadData?.expires_in || 3600);
            if (!accessToken) throw new Error('Claude Official OAuth 刷新失败: 未返回 access_token');
            this.claudeOauthAccessToken = accessToken;
            this.claudeOauthRefreshToken = refreshToken;
            this.claudeOauthExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
            this.config.claudeOauthAccessToken = accessToken;
            this.config.claudeOauthRefreshToken = refreshToken;
            this.config.claudeOauthExpiresAt = this.claudeOauthExpiresAt;
            await this.persistOAuthCredentials();
        });
        this._oauthRefreshPromise = refreshPromise;
        try { await this._oauthRefreshPromise; }
        finally { if (this._oauthRefreshPromise === refreshPromise) this._oauthRefreshPromise = null; }
    }

    // ─── Usage Limits ───
    async _getClaudeOfficialUsageLimits(authRetried = false) {
        if (!this.isOfficialOAuthMode()) {
            return {
                success: false,
                message: this.isOfficialBearerMode()
                    ? 'Claude Official Setup-Token 模式暂不支持用量查询'
                    : 'Claude Official API Key 模式暂不支持用量查询'
            };
        }
        if (this.oauthExpiresSoon()) await this.refreshToken(true);
        let response = null;
        try {
            response = await this.client.get(CLAUDE_OFFICIAL_OAUTH_USAGE_ENDPOINT, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this.claudeOauthAccessToken}`,
                    'anthropic-beta': this.claudeOauthBetaHeader || CLAUDE_OFFICIAL_OAUTH_BETA_HEADER,
                    'User-Agent': 'claude-cli/2.0.53 (external, cli)'
                }
            });
        } catch (error) {
            if (error?.response) response = error.response;
            else throw error;
        }
        const statusCode = response?.status || 0;
        const payload = response?.data && typeof response.data === 'object'
            ? response.data : parseJsonSafely(typeof response?.data === 'string' ? response.data : '');
        if ((statusCode === 401 || statusCode === 403) && !authRetried) {
            await this.refreshToken(true);
            return this._getClaudeOfficialUsageLimits(true);
        }
        if (!response || statusCode < 200 || statusCode >= 300) {
            throw new Error(`Claude Official 用量查询失败: HTTP ${statusCode || 'unknown'}`);
        }
        console.log('[Claude Official] Raw usage API response:', JSON.stringify(payload, null, 2));

        // 检查各窗口 utilization，额度耗尽时主动标记 COOLDOWN
        await this._checkUsageWindowExhaustion(payload);

        return payload || {};
    }

    async getUsageLimits(authRetried = false) {
        return this._getClaudeOfficialUsageLimits(authRetried);
    }

    // ─── Override: createClient（双 agent） ───
    createClient() {
        const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 120000 });
        const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 120000 });
        const axiosConfig = {
            baseURL: this.baseUrl,
            httpAgent, httpsAgent,
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        };
        if (!this.useSystemProxy) axiosConfig.proxy = false;
        configureAxiosProxy(axiosConfig, this.config, 'claude-custom');
        // 流式 agent — 高 maxSockets，timeout=0
        const httpAgentStream = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 64, timeout: 0 });
        const httpsAgentStream = new https.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 64, timeout: 0 });
        this.streamClient = axios.create({ ...axiosConfig, httpAgent: httpAgentStream, httpsAgent: httpsAgentStream });
        return axios.create(axiosConfig);
    }

    // ─── Override: getClaudeRequestHeaders ───
    getClaudeRequestHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'connection': 'keep-alive',
            'accept-encoding': 'gzip, deflate, br',
        };
        Object.assign(headers, this.getOfficialForwardHeaders());
        headers['user-agent'] = this._captureUserAgent();
        if (this.isOfficialBearerMode()) {
            headers.Authorization = `Bearer ${this.claudeOauthAccessToken}`;
            headers['anthropic-beta'] = this._buildDynamicBetaHeader();
            return headers;
        }
        headers['x-api-key'] = this.apiKey;
        return headers;
    }

    // ─── Override: callApi（纯透传，仅清理 cache_control） ───
    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        this._ensureAccountAvailable();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        const candidates = this.getEndpointCandidates(endpoint);
        let lastError = null;
        let requestBody = this._prepareOfficialRequestBody(body);
        if (this.isOfficialOAuthMode() && this.oauthExpiresSoon()) await this.refreshToken(true);

        // 客户端断开中断上游请求
        const clientReq = this.requestContext?.req;
        const abortController = new AbortController();
        let clientDisconnected = false;
        const handleClientDisconnect = () => {
            if (!clientDisconnected) { clientDisconnected = true; console.log('[Claude Official] Client disconnected, aborting upstream unary request'); abortController.abort(); }
        };
        if (clientReq && !clientReq.destroyed) clientReq.once('close', handleClientDisconnect);

        try {
        for (let index = 0; index < candidates.length; index += 1) {
            const candidateEndpoint = candidates[index];
            try {
                const response = await this.client.post(candidateEndpoint, requestBody, {
                    headers: this.getClaudeRequestHeaders(),
                    signal: abortController.signal
                });
                await this._extractSessionWindowStatus(response.headers);
                await this._checkQuotaRemaining(response.headers);
                officialRateLimitTracker.recordSuccess(this.config.uuid || 'unknown');
                // 保存上游真实 headers 供透传
                this._lastUpstreamHeaders = response.headers || {};
                return response.data;
            } catch (error) {
                const status = error.response?.status;
                const errorCode = error.code;
                const errorMessage = error.message || '';
                if (status === 404 && index < candidates.length - 1 && !isRetry) { lastError = error; continue; }
                const isNetworkError = isRetryableNetworkError(error);

                // 400 org-disabled
                if (status === 400) {
                    const errData400 = error.response?.data;
                    const errMsg400 = typeof errData400 === 'string' ? errData400 : (errData400?.error?.message || errData400?.message || error.message || '');

                    // 安全提取 headers（避免循环引用）
                    const safeHeaders = {};
                    const rawHeaders = error.config?.headers || {};
                    for (const [k, v] of Object.entries(rawHeaders)) {
                        if (typeof v === 'string' || typeof v === 'number') safeHeaders[k] = v;
                    }
                    const safeRespHeaders = {};
                    const rawRespHeaders = error.response?.headers || {};
                    for (const [k, v] of Object.entries(rawRespHeaders)) {
                        if (typeof v === 'string' || typeof v === 'number') safeRespHeaders[k] = v;
                    }

                    console.error('[Claude Official] ========== 400 Bad Request Details ==========');
                    console.error('  Account UUID:', this.config.uuid || 'unknown');
                    console.error('  Auth Mode:', this.isOfficialOAuthMode() ? 'OAuth' : 'API Key');
                    console.error('  Request URL:', candidateEndpoint);
                    console.error('  Stream Mode: false');
                    console.error('  Retry Count:', retryCount);
                    console.error('  Request Body:', JSON.stringify(requestBody, null, 2));
                    console.error('  Request Headers:', JSON.stringify(safeHeaders, null, 2));
                    console.error('  Response Headers:', JSON.stringify(safeRespHeaders, null, 2));
                    console.error('  Response Data:', typeof errData400 === 'string' ? errData400 : JSON.stringify(errData400, null, 2));
                    console.error('  Error Message:', errMsg400);

                    // 生成 curl 命令
                    const curlHeaders = Object.entries(safeHeaders)
                        .filter(([k]) => !['content-length', 'host'].includes(k.toLowerCase()))
                        .map(([k, v]) => `-H '${k}: ${String(v).replace(/'/g, "\\'")}'`)
                        .join(' \\\n  ');
                    console.error('  Equivalent curl:\n', `curl -X POST '${candidateEndpoint}' \\\n  ${curlHeaders} \\\n  -d '${JSON.stringify(requestBody).replace(/'/g, "\\'")}'`);
                    console.error('========================================================');

                    if (isOrganizationDisabledMessage(errMsg400)) {
                        throw markOrganizationExpiredError(error, status, errMsg400);
                    }
                }

                if (status === 401 || status === 403) {
                    const errData = error.response?.data;
                    const errMsg = typeof errData === 'string' ? errData : (errData?.error?.message || errData?.message || error.message || '');
                    if (isOrganizationDisabledMessage(errMsg)) {
                        throw markOrganizationExpiredError(error, status, errMsg);
                    }
                    // Validation block: 403 + human verification / validation required
                    if (status === 403 && /validation.?required|human.?verif|captcha|challenge.?required/i.test(errMsg)) {
                        const blockMinutes = Math.max(5, Number(this._cfgVal('officialValidationBlockMinutes', 30)) || 30);
                        error.isValidationBlock = true;
                        error.shouldSwitchCredential = true;
                        error.skipErrorCount = true;
                        error.isQuotaCooldown = true;
                        error.quotaResetTime = new Date(Date.now() + blockMinutes * 60 * 1000).toISOString();
                        error.quotaResetDelayMs = blockMinutes * 60 * 1000;
                        error.message = `账号触发人机验证，自动隔离 ${blockMinutes} 分钟`;
                        console.warn(`[ClaudeOfficial] ⚠️ Validation block detected, quarantine ${blockMinutes}min: ${errMsg.slice(0, 100)}`);
                        throw error;
                    }
                    // 403 + rate limit / quota exceeded → 额度耗尽，标记 COOLDOWN 切号
                    if (status === 403 && /rate.?limit|quota|exceed.*limit|would exceed/i.test(errMsg)) {
                        const cooldownMs = 3600000; // 1h fallback
                        const resetAtMs = parseOfficialRateLimitResetMs(error.response?.headers, errData) || (Date.now() + cooldownMs);
                        error.isQuotaCooldown = true;
                        error.shouldSwitchCredential = true;
                        error.skipErrorCount = true;
                        error.quotaResetTime = new Date(resetAtMs).toISOString();
                        error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
                        error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                        const quotaReason = `403 quota limit: ${errMsg.slice(0, 180)}`;
                        this._setLocalQuotaExhausted(resetAtMs, quotaReason);
                        error.message = this._buildQuotaExhaustedMessage(error.quotaResetTime);
                        console.warn(`[ClaudeOfficial] ⚠️ 403 quota/rate limit detected, recovery ${error.quotaResetTime}: ${errMsg.slice(0, 100)}`);
                        throw error;
                    }
                    if (status === 401) {
                        const errCount = this._recordUnauthorizedError();
                        if (errCount >= 1) { error.shouldSwitchCredential = true; error.tempUnavailable = true; }
                    }
                    if (this.isOfficialOAuthMode() && !isRetry) {
                        await this.refreshToken(true);
                        return this.callApi(candidateEndpoint, requestBody, true, retryCount);
                    }
                    if (status === 403 && retryCount < 2) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    }
                    throw error;
                }

                // 429 处理 — Multi-Tier Rate Limit
                if (status === 429) {
                    error.skipErrorCount = true; error.shouldSwitchCredential = true;
                    error.rateLimitedModel = requestBody?.model || null;
                    const errData = error.response?.data;
                    const errMsg = typeof errData === 'string' ? errData : (errData?.error?.message || errData?.message || error.message || '');
                    const reason = officialRateLimitTracker.classifyReason(status, error.response?.data);
                    error.rateLimitReason = reason;
                    const serverRetryMs = (() => { const ms = parseOfficialRateLimitResetMs(error.response?.headers, errData); return ms ? Math.max(0, ms - Date.now()) : 0; })();
                    const tierDelayMs = officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', reason, serverRetryMs);
                    const fallbackDelayMs = Math.max(5000, Number(this._cfgVal('officialRateLimitCooldownMs', 30000)) || 30000);
                    const resetAtMs = parseOfficialRateLimitResetMs(error.response?.headers, errData) || (Date.now() + Math.max(fallbackDelayMs, tierDelayMs));
                    error.isQuotaCooldown = true;
                    error.quotaResetTime = new Date(resetAtMs).toISOString();
                    error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
                    error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                    const isOpus = this._isOpusModelRequest(requestBody);
                    if (reason === RATE_LIMIT_REASON.QUOTA_EXHAUSTED) {
                        this._setLocalQuotaExhausted(resetAtMs, `429 quota exhausted: ${errMsg.slice(0, 180)}`);
                        error.message = this._buildQuotaExhaustedMessage(error.quotaResetTime);
                    } else {
                        error.message = isOpus ? this._buildOpusLimitMessage(error.quotaResetTime) : this._buildRateLimitMessage(error.quotaResetTime);
                    }
                    if (isOpus) error.opusOnlyRateLimit = true;
                    if (error.response) error.response.status = 403;
                    error.status = 403; error.statusCode = 403;
                    console.log(`[RateLimit] ${reason} for ${(this.config.uuid || '').slice(0,8)}, tier delay ${tierDelayMs}ms, recovery ${error.quotaResetTime}${isOpus ? ' (opus-only)' : ''}`);
                }

                if (status === 529) {
                    const reason = officialRateLimitTracker.classifyReason(status, error.response?.data);
                    const tierDelayMs = officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', reason, 0);
                    const cooldownMs = Math.max(tierDelayMs, 15000, Number(this._cfgVal('officialOverloadCooldownMs', 60000)) || 60000);
                    const resetAtMs = Date.now() + cooldownMs;
                    error.isQuotaCooldown = true; error.quotaResetTime = new Date(resetAtMs).toISOString();
                    error.quotaResetDelayMs = cooldownMs; error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                    error.skipErrorCount = true; error.shouldSwitchCredential = true;
                }

                // 5xx (non-529) — SERVER_ERROR tier: 固定 8s，不累计失败
                if (status >= 500 && status < 600 && status !== 529 && retryCount < maxRetries) {
                    officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', RATE_LIMIT_REASON.SERVER_ERROR, 0);
                    await new Promise(resolve => setTimeout(resolve, 8000));
                    return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                }

                if (status === 429 && retryCount < maxRetries) {
                    const reason = error.rateLimitReason || RATE_LIMIT_REASON.QUOTA_EXHAUSTED;
                    // RPM/capacity 可以短暂重试，quota 直接切号
                    if (reason === RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED || reason === RATE_LIMIT_REASON.MODEL_CAPACITY) {
                        const delay = reason === RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED ? 5000 : CAPACITY_BACKOFF_STEPS[Math.min(retryCount, CAPACITY_BACKOFF_STEPS.length - 1)];
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    }
                    // quota_exhausted: 不在内层重试，直接抛出让外层切号
                }
                if (isNetworkError && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(candidateEndpoint, requestBody, true, retryCount + 1);
                }

                console.error(`[Claude Official] Error calling API (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
                const friendlyMsg = this._mapConnectionError(error);
                if (friendlyMsg) error.message = friendlyMsg;
                throw error;
            }
        }
        throw lastError || new Error('[Claude Official] All endpoint candidates failed');
        } catch (err) {
            if (clientDisconnected && err?.name === 'AbortError') {
                console.log('[Claude Official] Upstream unary request aborted due to client disconnect');
                throw Object.assign(new Error('Client disconnected'), { isClientDisconnect: true });
            }
            throw err;
        } finally {
            if (clientReq) clientReq.removeListener('close', handleClientDisconnect);
        }
    }

    // ─── Override: streamApi（含所有 CRS 对齐逻辑） ───
    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        this._ensureAccountAvailable();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        const candidates = this.getEndpointCandidates(endpoint);
        let lastError = null;
        let requestBody = this._prepareOfficialRequestBody(body);
        if (this.isOfficialOAuthMode() && this.oauthExpiresSoon()) await this.refreshToken(true);

        const clientReq = this.requestContext?.req;
        const abortController = new AbortController();
        let clientDisconnected = false;
        const handleClientDisconnect = () => {
            if (!clientDisconnected) { clientDisconnected = true; console.log('[Claude Official] Client disconnected, aborting upstream stream request'); abortController.abort(); }
        };
        if (clientReq && !clientReq.destroyed) clientReq.once('close', handleClientDisconnect);

        try {
        for (let index = 0; index < candidates.length; index += 1) {
            const candidateEndpoint = candidates[index];
            try {
                const response = await (this.streamClient || this.client).post(
                    candidateEndpoint,
                    { ...requestBody, stream: true },
                    { responseType: 'stream', headers: this.getClaudeRequestHeaders(), signal: abortController.signal }
                );
                await this._extractSessionWindowStatus(response.headers);
                await this._checkQuotaRemaining(response.headers);
                // 保存上游真实 headers 供透传
                this._lastUpstreamHeaders = response.headers || {};
                // 解压响应流
                let reader = response.data;
                const contentEncoding = (response.headers['content-encoding'] || '').toLowerCase();
                if (contentEncoding === 'gzip') reader = response.data.pipe(zlib.createGunzip());
                else if (contentEncoding === 'deflate') reader = response.data.pipe(zlib.createInflate());
                else if (contentEncoding === 'br') reader = response.data.pipe(zlib.createBrotliDecompress());

                let buffer = '';
                const usageData = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

                for await (const chunk of reader) {
                    buffer += chunk.toString('utf-8');
                    let boundary;
                    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                        const eventBlock = buffer.substring(0, boundary);
                        buffer = buffer.substring(boundary + 2);
                        const lines = eventBlock.split('\n');
                        let data = '';
                        for (const line of lines) {
                            if (line.startsWith('data: ')) data = line.substring(6).trim();
                        }
                        if (data) {
                            try {
                                const parsedChunk = JSON.parse(data);
                                if (parsedChunk.type === 'message_start' && parsedChunk.message?.usage) {
                                    const u = parsedChunk.message.usage;
                                    usageData.input_tokens = u.input_tokens || 0;
                                    usageData.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
                                    usageData.cache_read_input_tokens = u.cache_read_input_tokens || 0;
                                }
                                if (parsedChunk.type === 'message_delta' && parsedChunk.usage) {
                                    usageData.output_tokens = parsedChunk.usage.output_tokens || 0;
                                }
                                yield parsedChunk;
                                if (parsedChunk.type === 'message_stop') {
                                    officialRateLimitTracker.recordSuccess(this.config.uuid || 'unknown');
                                    if (usageData.input_tokens > 0 || usageData.output_tokens > 0) {
                                        console.log(`[Claude Official] Stream usage: in=${usageData.input_tokens}, out=${usageData.output_tokens}, cache_create=${usageData.cache_creation_input_tokens}, cache_read=${usageData.cache_read_input_tokens}`);
                                        this._lastStreamUsage = { ...usageData };
                                    }
                                    return;
                                }
                            } catch (e) {
                                console.warn("[Claude Official] Failed to parse stream chunk JSON:", e.message, "Data:", data);
                            }
                        }
                    }
                }
                return;
            } catch (error) {
                const status = error.response?.status;
                const errorCode = error.code;
                const errorMessage = error.message || '';
                if (status === 404 && index < candidates.length - 1 && !isRetry) { lastError = error; continue; }
                const isNetworkError = isRetryableNetworkError(error);

                if (status === 400) {
                    const errData400 = error.response?.data;
                    const errMsg400 = typeof errData400 === 'string' ? errData400 : (errData400?.error?.message || errData400?.message || error.message || '');

                    const safeH2 = {};
                    for (const [k, v] of Object.entries(error.config?.headers || {})) {
                        if (typeof v === 'string' || typeof v === 'number') safeH2[k] = v;
                    }
                    console.error('[Claude Official] 400 Bad Request Details:');
                    console.error('  Request URL:', candidateEndpoint);
                    console.error('  Request Body:', JSON.stringify(requestBody, null, 2));
                    console.error('  Request Headers:', JSON.stringify(safeH2, null, 2));
                    const safeStringify = (val) => {
                        try { return typeof val === 'string' ? val : JSON.stringify(val, null, 2); } catch { return String(val); }
                    };
                    console.error('  Response Data:', safeStringify(errData400));
                    console.error('  Error Message:', errMsg400);
                    const curlH2 = Object.entries(safeH2)
                        .filter(([k]) => !['content-length', 'host'].includes(k.toLowerCase()))
                        .map(([k, v]) => `-H '${k}: ${String(v).replace(/'/g, "\\'")}'`)
                        .join(' \\\n  ');
                    try { console.error('  Equivalent curl:\n', `curl -X POST '${candidateEndpoint}' \\\n  ${curlH2} \\\n  -d '${JSON.stringify(requestBody).replace(/'/g, "\\'")}'`); } catch { console.error('  Equivalent curl: (failed to serialize body)'); }

                    if (isOrganizationDisabledMessage(errMsg400)) {
                        throw markOrganizationExpiredError(error, status, errMsg400);
                    }
                }

                if (status === 401 || status === 403) {
                    const errData = error.response?.data;
                    const errMsg = typeof errData === 'string' ? errData : (errData?.error?.message || errData?.message || error.message || '');
                    if (isOrganizationDisabledMessage(errMsg)) {
                        throw markOrganizationExpiredError(error, status, errMsg);
                    }
                    // Validation block: 403 + human verification / validation required
                    if (status === 403 && /validation.?required|human.?verif|captcha|challenge.?required/i.test(errMsg)) {
                        const blockMinutes = Math.max(5, Number(this._cfgVal('officialValidationBlockMinutes', 30)) || 30);
                        error.isValidationBlock = true;
                        error.shouldSwitchCredential = true;
                        error.skipErrorCount = true;
                        error.isQuotaCooldown = true;
                        error.quotaResetTime = new Date(Date.now() + blockMinutes * 60 * 1000).toISOString();
                        error.quotaResetDelayMs = blockMinutes * 60 * 1000;
                        error.message = `账号触发人机验证，自动隔离 ${blockMinutes} 分钟`;
                        console.warn(`[ClaudeOfficial] ⚠️ Validation block detected, quarantine ${blockMinutes}min: ${errMsg.slice(0, 100)}`);
                        throw error;
                    }
                    // 403 + rate limit / quota exceeded → 额度耗尽，标记 COOLDOWN 切号
                    if (status === 403 && /rate.?limit|quota|exceed.*limit|would exceed/i.test(errMsg)) {
                        const cooldownMs = 3600000; // 1h fallback
                        const resetAtMs = parseOfficialRateLimitResetMs(error.response?.headers, errData) || (Date.now() + cooldownMs);
                        error.isQuotaCooldown = true;
                        error.shouldSwitchCredential = true;
                        error.skipErrorCount = true;
                        error.quotaResetTime = new Date(resetAtMs).toISOString();
                        error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
                        error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                        const quotaReason = `403 quota limit: ${errMsg.slice(0, 180)}`;
                        this._setLocalQuotaExhausted(resetAtMs, quotaReason);
                        error.message = this._buildQuotaExhaustedMessage(error.quotaResetTime);
                        console.warn(`[ClaudeOfficial] ⚠️ 403 quota/rate limit detected, recovery ${error.quotaResetTime}: ${errMsg.slice(0, 100)}`);
                        throw error;
                    }
                    if (status === 401) {
                        const errCount = this._recordUnauthorizedError();
                        if (errCount >= 1) { error.shouldSwitchCredential = true; error.tempUnavailable = true; }
                    }
                    if (this.isOfficialOAuthMode() && !isRetry) {
                        await this.refreshToken(true);
                        yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount);
                        return;
                    }
                    if (status === 403 && retryCount < 2) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                        return;
                    }
                    throw error;
                }

                // 429 处理 — Multi-Tier Rate Limit
                if (status === 429) {
                    error.skipErrorCount = true; error.shouldSwitchCredential = true;
                    error.rateLimitedModel = requestBody?.model || null;
                    const errData = error.response?.data;
                    const errMsg = typeof errData === 'string' ? errData : (errData?.error?.message || errData?.message || error.message || '');
                    const reason = officialRateLimitTracker.classifyReason(status, error.response?.data);
                    error.rateLimitReason = reason;
                    const serverRetryMs = (() => { const ms = parseOfficialRateLimitResetMs(error.response?.headers, errData); return ms ? Math.max(0, ms - Date.now()) : 0; })();
                    const tierDelayMs = officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', reason, serverRetryMs);
                    const fallbackDelayMs = Math.max(5000, Number(this._cfgVal('officialRateLimitCooldownMs', 30000)) || 30000);
                    const resetAtMs = parseOfficialRateLimitResetMs(error.response?.headers, errData) || (Date.now() + Math.max(fallbackDelayMs, tierDelayMs));
                    error.isQuotaCooldown = true;
                    error.quotaResetTime = new Date(resetAtMs).toISOString();
                    error.quotaResetDelayMs = Math.max(0, resetAtMs - Date.now());
                    error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                    const isOpus = this._isOpusModelRequest(requestBody);
                    if (reason === RATE_LIMIT_REASON.QUOTA_EXHAUSTED) {
                        this._setLocalQuotaExhausted(resetAtMs, `429 quota exhausted: ${errMsg.slice(0, 180)}`);
                        error.message = this._buildQuotaExhaustedMessage(error.quotaResetTime);
                    } else {
                        error.message = isOpus ? this._buildOpusLimitMessage(error.quotaResetTime) : this._buildRateLimitMessage(error.quotaResetTime);
                    }
                    if (isOpus) error.opusOnlyRateLimit = true;
                    if (error.response) error.response.status = 403;
                    error.status = 403; error.statusCode = 403;
                    console.log(`[RateLimit] ${reason} for ${(this.config.uuid || '').slice(0,8)}, tier delay ${tierDelayMs}ms, recovery ${error.quotaResetTime}${isOpus ? ' (opus-only)' : ''}`);
                }

                if (status === 529) {
                    const reason = officialRateLimitTracker.classifyReason(status, error.response?.data);
                    const tierDelayMs = officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', reason, 0);
                    const cooldownMs = Math.max(tierDelayMs, 15000, Number(this._cfgVal('officialOverloadCooldownMs', 60000)) || 60000);
                    const resetAtMs = Date.now() + cooldownMs;
                    error.isQuotaCooldown = true; error.quotaResetTime = new Date(resetAtMs).toISOString();
                    error.quotaResetDelayMs = cooldownMs; error.quotaResetFormatted = new Date(resetAtMs).toISOString();
                    error.skipErrorCount = true; error.shouldSwitchCredential = true;
                }

                // 5xx (non-529) — SERVER_ERROR tier: 固定 8s，不累计失败
                if (status >= 500 && status < 600 && status !== 529 && retryCount < maxRetries) {
                    officialRateLimitTracker.recordFailure(this.config.uuid || 'unknown', RATE_LIMIT_REASON.SERVER_ERROR, 0);
                    await new Promise(resolve => setTimeout(resolve, 8000));
                    yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    return;
                }

                if (status === 429 && retryCount < maxRetries) {
                    const reason = error.rateLimitReason || RATE_LIMIT_REASON.QUOTA_EXHAUSTED;
                    if (reason === RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED || reason === RATE_LIMIT_REASON.MODEL_CAPACITY) {
                        const delay = reason === RATE_LIMIT_REASON.RATE_LIMIT_EXCEEDED ? 5000 : CAPACITY_BACKOFF_STEPS[Math.min(retryCount, CAPACITY_BACKOFF_STEPS.length - 1)];
                        await new Promise(resolve => setTimeout(resolve, delay));
                        yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                        return;
                    }
                    // quota_exhausted: 不在内层重试，直接抛出让外层切号
                }
                if (isNetworkError && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(candidateEndpoint, requestBody, true, retryCount + 1);
                    return;
                }

                console.error(`[Claude Official] Error generating content stream (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
                const friendlyMsg = this._mapConnectionError(error);
                if (friendlyMsg) error.message = friendlyMsg;
                throw error;
            }
        }
        throw lastError || new Error('[Claude Official] All stream endpoint candidates failed');
        } catch (err) {
            if (clientDisconnected && err?.name === 'AbortError') {
                console.log('[Claude Official] Upstream stream aborted due to client disconnect');
                return;
            }
            throw err;
        } finally {
            if (clientReq) clientReq.removeListener('close', handleClientDisconnect);
        }
    }
}
