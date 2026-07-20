/**
 * Claude Antigravity Core
 * Claude API → Antigravity (Gemini v1internal) 转换层
 * 参考: demo/Antigravity-Manager-4.1.5/src-tauri/src/proxy/mappers/claude/
 */

import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import * as https from 'https';
import { createHash } from 'crypto';
import { getProviderModels } from '../provider-models.js';
import { cleanJsonSchemaProperties } from '../../converters/utils.js';
import * as channelConfigDao from '../../dao/channel-config-dao.js';
import { applyContextCompression } from './context-manager.js';

// ==================== 常量定义 ====================

const ANTIGRAVITY_BASE_URL_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_BASE_URL_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_BASE_URL_PROD = 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_API_VERSION = 'v1internal';
// User-Agent: 动态拉取最新版本号，fallback 到固定版本
let _cachedUserAgent = null;
const DEFAULT_USER_AGENT_VERSION = '1.19.6';
async function fetchLatestUserAgent() {
    if (_cachedUserAgent) return _cachedUserAgent;
    try {
        const resp = await fetch('https://antigravity-auto-updater-974169037036.us-central1.run.app', { signal: AbortSignal.timeout(5000) });
        const text = await resp.text();
        const match = text.match(/\d+\.\d+\.\d+/);
        if (match) {
            _cachedUserAgent = `antigravity/${match[0]} ${process.platform}/${process.arch}`;
            console.log(`[ClaudeAntigravity] User-Agent fetched: ${_cachedUserAgent}`);
            return _cachedUserAgent;
        }
    } catch {}
    _cachedUserAgent = `antigravity/${DEFAULT_USER_AGENT_VERSION} ${process.platform}/${process.arch}`;
    return _cachedUserAgent;
}
async function getResolvedUserAgent() {
    if (_cachedUserAgent) return _cachedUserAgent;
    return fetchLatestUserAgent();
}
// 启动时预拉取
fetchLatestUserAgent().catch(() => {});
const DEFAULT_USER_AGENT = `antigravity/${DEFAULT_USER_AGENT_VERSION} ${process.platform}/${process.arch}`;

// HTTP Agent 配置
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

// ==================== 请求限流器 (参考 Antigravity-Manager rate_limiter.rs) ====================

class RateLimiter {
    constructor(minIntervalMs = 500) {
        this.minIntervalMs = minIntervalMs;
        this.lastCallTime = null;
        this._lock = Promise.resolve();
    }

    async wait() {
        // 串行化：确保并发请求也按顺序排队
        const prev = this._lock;
        let resolve;
        this._lock = new Promise(r => { resolve = r; });
        await prev;

        try {
            if (this.lastCallTime !== null) {
                const elapsed = Date.now() - this.lastCallTime;
                if (elapsed < this.minIntervalMs) {
                    await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
                }
            }
            this.lastCallTime = Date.now();
        } finally {
            resolve();
        }
    }
}

// 全局限流器：500ms 最小请求间隔，防止触发 429
const globalRateLimiter = new RateLimiter(500);

// ==================== 重试延迟解析 (参考 Antigravity-Manager retry.rs) ====================

/**
 * 解析持续时间字符串为毫秒
 * 支持格式: "1.5s", "200ms", "1h16m0.667s", "42s", "2h1m1s", "510.790006ms"
 */
function parseDurationMs(durationStr) {
    if (!durationStr || typeof durationStr !== 'string') return null;

    const pattern = /([\d.]+)\s*(ms|s|m|h)/gi;
    let totalMs = 0;
    let matched = false;
    let match;

    while ((match = pattern.exec(durationStr)) !== null) {
        matched = true;
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        switch (unit) {
            case 'ms': totalMs += value; break;
            case 's':  totalMs += value * 1000; break;
            case 'm':  totalMs += value * 60 * 1000; break;
            case 'h':  totalMs += value * 3600 * 1000; break;
        }
    }

    return matched ? Math.ceil(totalMs) : null;
}

/**
 * 从 429 响应体中提取重试延迟（毫秒）
 * 优先级 (完全对齐 Antigravity-Manager retry.rs):
 *   1. error.details[].metadata.retryDelay (RetryInfo)
 *   2. error.details[].metadata.quotaResetDelay
 *   3. error.error.retry_after (秒数)
 *   4. 正则匹配文本: "Try again in 2m 30s", "backoff for 42s", "quota will reset in 60 seconds", "(wait 5s)"
 *   5. Retry-After header (秒数)
 */
function parseRetryDelay(errorText, retryAfterHeader) {
    if (errorText) {
        try {
            const json = JSON.parse(errorText);
            const details = json?.error?.details;
            if (Array.isArray(details)) {
                for (const detail of details) {
                    const retryDelay = detail?.metadata?.retryDelay;
                    if (retryDelay) {
                        const ms = parseDurationMs(retryDelay);
                        if (ms !== null) return ms;
                    }
                    const quotaDelay = detail?.metadata?.quotaResetDelay;
                    if (quotaDelay) {
                        const ms = parseDurationMs(quotaDelay);
                        if (ms !== null) return ms;
                    }
                }
            }
            // 方法3: error.error.retry_after (秒数)
            const retryAfterField = json?.error?.retry_after ?? json?.error?.error?.retry_after;
            if (typeof retryAfterField === 'number') {
                return Math.ceil(retryAfterField * 1000);
            }
        } catch {
            // 非 JSON，走正则
        }

        // 方法4: 正则匹配多种文本格式 (对齐 Rust 的 5 种 pattern)
        const patterns = [
            /(?:try again|retry|backoff)\s+(?:after|in|for)\s+([\d.]+\s*(?:ms|s|m|h)[\s\d.msh]*)/i,
            /quota\s+will\s+reset\s+in\s+([\d.]+)\s*(seconds?|s|minutes?|m|hours?|h)/i,
            /\(wait\s+([\d.]+\s*(?:ms|s|m|h)[\s\d.msh]*)\)/i,
        ];
        for (const pat of patterns) {
            const m = errorText.match(pat);
            if (m) {
                const ms = parseDurationMs(m[1] || `${m[1]}${m[2] || 's'}`);
                if (ms !== null) return ms;
            }
        }
    }

    // 方法5: Retry-After header
    if (retryAfterHeader) {
        const seconds = parseFloat(retryAfterHeader);
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }

    return null;
}

/**
 * 从 429 QUOTA_EXHAUSTED 响应体中提取配额重置信息
 * 返回 { resetTimestamp, resetDelay, resetDelayMs, resetFormatted } 或 null
 */
function parseQuotaResetInfo(errorText) {
    if (!errorText) return null;
    try {
        const json = JSON.parse(errorText);
        const details = json?.error?.details;
        if (!Array.isArray(details)) return null;

        let resetTimestamp = null;
        let resetDelay = null;
        let resetDelayMs = null;

        for (const detail of details) {
            const meta = detail?.metadata;
            if (!meta) continue;
            if (meta.quotaResetTimeStamp && !resetTimestamp) {
                resetTimestamp = meta.quotaResetTimeStamp;
            }
            if (meta.quotaResetDelay && !resetDelay) {
                resetDelay = meta.quotaResetDelay;
                resetDelayMs = parseDurationMs(resetDelay);
            }
        }

        if (!resetTimestamp && !resetDelayMs) return null;

        // 如果有 timestamp 但没 delay，从 timestamp 算
        if (resetTimestamp && !resetDelayMs) {
            resetDelayMs = Math.max(0, new Date(resetTimestamp).getTime() - Date.now());
        }
        // 如果有 delay 但没 timestamp，从 delay 算
        if (resetDelayMs && !resetTimestamp) {
            resetTimestamp = new Date(Date.now() + resetDelayMs).toISOString();
        }

        // 格式化剩余时间
        const totalSec = Math.ceil(resetDelayMs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const parts = [];
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        if (s > 0 || parts.length === 0) parts.push(`${s}s`);
        const resetFormatted = parts.join(' ');

        return { resetTimestamp, resetDelay, resetDelayMs, resetFormatted };
    } catch {
        return null;
    }
}

// ==================== 429 错误分类 (参考 Antigravity-Manager rate_limit.rs) ====================

/**
 * 429 错误原因分类
 * 不同原因对应完全不同的退避策略，这是 demo 的核心精髓
 */
const RateLimitReason = {
    QUOTA_EXHAUSTED: 'QuotaExhausted',           // 日配额耗尽 → 长时间退避
    RATE_LIMIT_EXCEEDED: 'RateLimitExceeded',     // TPM/RPM 限流 → 短暂等待
    MODEL_CAPACITY_EXHAUSTED: 'ModelCapacity',    // 模型过载 → 中等等待
    SERVER_ERROR: 'ServerError',                  // 5xx → 固定等待，不累计失败
    UNKNOWN: 'Unknown',
};

/**
 * 从 429 响应体解析错误原因
 * 关键: "per minute" 优先于 "exhausted"，防止 TPM 被误判为 Quota
 */
function parseRateLimitReason(errorText) {
    if (!errorText) return RateLimitReason.UNKNOWN;

    // 1. 尝试 JSON 结构化解析: error.details[].reason
    try {
        const json = JSON.parse(errorText);
        const details = json?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                const reason = (detail?.reason || '').toUpperCase();
                if (reason === 'RATE_LIMIT_EXCEEDED') return RateLimitReason.RATE_LIMIT_EXCEEDED;
                if (reason === 'QUOTA_EXHAUSTED') return RateLimitReason.QUOTA_EXHAUSTED;
                if (reason === 'MODEL_CAPACITY_EXHAUSTED') return RateLimitReason.MODEL_CAPACITY_EXHAUSTED;
            }
        }
    } catch {
        // 非 JSON
    }

    // 2. 文本匹配 (优先级: TPM > Quota > ModelCapacity)
    const lower = errorText.toLowerCase();
    if (lower.includes('per minute') || lower.includes('rate limit')) {
        return RateLimitReason.RATE_LIMIT_EXCEEDED;
    }
    if (lower.includes('exhausted') || lower.includes('quota')) {
        return RateLimitReason.QUOTA_EXHAUSTED;
    }
    if (lower.includes('capacity') || lower.includes('overloaded')) {
        return RateLimitReason.MODEL_CAPACITY_EXHAUSTED;
    }

    return RateLimitReason.UNKNOWN;
}

// ==================== 限流追踪器 (参考 Antigravity-Manager rate_limit.rs) ====================

const FAILURE_COUNT_EXPIRY_MS = 3600 * 1000; // 1小时无失败自动清零
const DEFAULT_BACKOFF_STEPS_SEC = [60, 300, 1800, 7200]; // 1m → 5m → 30m → 2h

/**
 * RateLimitTracker - 账号/模型级限流追踪器
 *
 * 核心机制 (完全对齐 demo rate_limit.rs):
 *   - 按 accountId 或 accountId:modelId 追踪锁定状态
 *   - 连续失败计数 + 指数退避步进
 *   - 5xx 错误不累计失败计数（防止污染）
 *   - QuotaExhausted 锁定到模型级别
 *   - RateLimitExceeded 固定 5s
 *   - ModelCapacity 5s→10s→15s
 *   - 成功请求自动清零
 */
class RateLimitTracker {
    constructor(backoffSteps = DEFAULT_BACKOFF_STEPS_SEC) {
        this.limits = new Map();        // key → { resetTime, retryAfterSec, reason, model }
        this.failureCounts = new Map(); // accountId → { count, lastTime }
        this.backoffSteps = backoffSteps;
    }

    /**
     * 检查账号/模型是否被锁定
     */
    isRateLimited(accountId, model) {
        return this.getRemainingWaitMs(accountId, model) > 0;
    }

    /**
     * 获取剩余等待时间（毫秒）
     * 同时检查账号级和模型级锁定
     */
    getRemainingWaitMs(accountId, model) {
        const now = Date.now();
        // 1. 检查账号级锁定
        const accountLock = this.limits.get(accountId);
        if (accountLock && accountLock.resetTime > now) {
            return accountLock.resetTime - now;
        }
        // 2. 检查模型级锁定
        if (model) {
            const modelKey = `${accountId}:${model}`;
            const modelLock = this.limits.get(modelKey);
            if (modelLock && modelLock.resetTime > now) {
                return modelLock.resetTime - now;
            }
        }
        return 0;
    }

    /**
     * 记录限流事件，计算锁定时长
     * 完全对齐 demo rate_limit.rs record_rate_limit()
     */
    recordRateLimit(accountId, statusCode, errorText, retryAfterHeader, model) {
        const now = Date.now();

        // 分类错误原因
        const reason = statusCode === 429
            ? parseRateLimitReason(errorText)
            : RateLimitReason.SERVER_ERROR;

        // 5xx 不累计失败计数（防止污染）
        let failureCount;
        if (reason !== RateLimitReason.SERVER_ERROR) {
            const entry = this.failureCounts.get(accountId) || { count: 0, lastTime: now };
            // 超过1小时无失败，重置
            if (now - entry.lastTime > FAILURE_COUNT_EXPIRY_MS) {
                entry.count = 0;
            }
            entry.count += 1;
            entry.lastTime = now;
            this.failureCounts.set(accountId, entry);
            failureCount = entry.count;
        } else {
            failureCount = 1; // 5xx 固定用 1
        }

        // 尝试从响应解析精确延迟
        const parsedDelayMs = parseRetryDelay(errorText, retryAfterHeader);

        // 根据原因计算锁定时长（秒）
        let lockoutSec;
        switch (reason) {
            case RateLimitReason.QUOTA_EXHAUSTED: {
                // 如果服务器给了精确延迟，直接用
                if (parsedDelayMs !== null) {
                    lockoutSec = Math.max(2, Math.ceil(parsedDelayMs / 1000));
                } else {
                    // 指数退避步进: [60, 300, 1800, 7200]
                    const idx = Math.min(failureCount - 1, this.backoffSteps.length - 1);
                    lockoutSec = this.backoffSteps[idx];
                }
                break;
            }
            case RateLimitReason.RATE_LIMIT_EXCEEDED:
                // TPM/RPM: 固定 5 秒
                lockoutSec = parsedDelayMs !== null ? Math.max(2, Math.ceil(parsedDelayMs / 1000)) : 5;
                break;
            case RateLimitReason.MODEL_CAPACITY_EXHAUSTED:
                // 模型过载: 5s → 10s → 15s
                lockoutSec = Math.min(5 * failureCount, 15);
                break;
            case RateLimitReason.SERVER_ERROR:
                // 5xx: 固定 8 秒
                lockoutSec = 8;
                break;
            default:
                lockoutSec = parsedDelayMs !== null ? Math.max(2, Math.ceil(parsedDelayMs / 1000)) : 10;
        }

        // 最小 2 秒保护
        lockoutSec = Math.max(2, lockoutSec);

        const resetTime = now + lockoutSec * 1000;

        // QuotaExhausted → 模型级锁定; 其他 → 账号级锁定
        const key = (reason === RateLimitReason.QUOTA_EXHAUSTED && model)
            ? `${accountId}:${model}`
            : accountId;

        this.limits.set(key, { resetTime, retryAfterSec: lockoutSec, reason, model: model || null });

        console.warn(`[RateLimitTracker] 🔒 ${key} locked for ${lockoutSec}s (reason=${reason}, failures=${failureCount})`);

        return { lockoutSec, reason, failureCount };
    }

    /**
     * 标记成功请求 → 清零失败计数 + 解除锁定
     */
    markSuccess(accountId) {
        this.failureCounts.delete(accountId);
        this.limits.delete(accountId);
    }

    /**
     * 清理过期记录（可定期调用）
     */
    cleanup() {
        const now = Date.now();
        for (const [key, info] of this.limits) {
            if (info.resetTime <= now) this.limits.delete(key);
        }
        for (const [key, entry] of this.failureCounts) {
            if (now - entry.lastTime > FAILURE_COUNT_EXPIRY_MS) this.failureCounts.delete(key);
        }
    }
}

// 全局限流追踪器实例
const globalRateLimitTracker = new RateLimitTracker();

// 每 15 秒清理过期记录
setInterval(() => globalRateLimitTracker.cleanup(), 15000).unref();

// ==================== 重试策略引擎 (参考 Antigravity-Manager handlers/common.rs) ====================

const RetryStrategy = {
    NoRetry: { type: 'none' },
    FixedDelay: (ms) => ({ type: 'fixed', delayMs: ms }),
    LinearBackoff: (baseMs) => ({ type: 'linear', baseMs }),
    ExponentialBackoff: (baseMs, maxMs) => ({ type: 'exponential', baseMs, maxMs }),
};

/**
 * 根据 HTTP 状态码和错误内容确定重试策略
 */
function determineRetryStrategy(statusCode, errorText, retryAfterHeader) {
    switch (statusCode) {
        case 400:
            if (errorText && (errorText.includes('Invalid `signature`') || errorText.includes('thinking.signature'))) {
                return RetryStrategy.FixedDelay(200);
            }
            return RetryStrategy.NoRetry;

        case 429: {
            const delayMs = parseRetryDelay(errorText, retryAfterHeader);
            if (delayMs !== null) {
                const actualDelay = Math.min(delayMs + 200, 30000);
                return RetryStrategy.FixedDelay(actualDelay);
            }
            return RetryStrategy.LinearBackoff(5000);
        }

        case 503:
        case 529:
            return RetryStrategy.ExponentialBackoff(10000, 60000);

        case 500:
            return RetryStrategy.LinearBackoff(3000);

        case 401:
        case 403:
            return RetryStrategy.FixedDelay(200);

        default:
            return RetryStrategy.NoRetry;
    }
}

/**
 * 计算重试延迟（毫秒）
 */
function calculateRetryDelay(strategy, attempt) {
    switch (strategy.type) {
        case 'none':    return 0;
        case 'fixed':   return strategy.delayMs;
        case 'linear':  return strategy.baseMs * (attempt + 1);
        case 'exponential': return Math.min(strategy.baseMs * Math.pow(2, attempt), strategy.maxMs);
        default:        return 0;
    }
}

/**
 * 判断是否应该切换到下一个 upstream endpoint
 */
function shouldTryNextEndpoint(statusCode) {
    return statusCode === 429 || statusCode === 408 || statusCode === 404
        || (statusCode >= 500 && statusCode < 600);
}

/**
 * 判断是否应该轮换账号 (对齐 demo common.rs should_rotate_account)
 * 429/401/403/500 → 轮换 (账号级问题)
 * 400/503/529 → 不轮换 (全局/协议问题)
 */
function shouldRotateAccount(statusCode) {
    return statusCode === 429 || statusCode === 401 || statusCode === 403 || statusCode === 500;
}

// ==================== 背景任务检测 & 自动降级 (参考 Antigravity-Manager handlers/claude.rs) ====================

/**
 * 背景任务类型关键词 (对齐 demo claude.rs lines 1258-1317)
 * 检测到这些任务后自动降级到 Flash 模型，省额度防 429
 */
const BACKGROUND_TASK_KEYWORDS = {
    TitleGeneration: ['generate a title', 'create a title', 'suggest a title', 'write a title', 'come up with a title',
        'give this conversation a title', 'short title', 'concise title', 'brief title'],
    SimpleSummary: ['summarize this', 'brief summary', 'short summary', 'tldr', 'tl;dr',
        'summarize the above', 'summarize our conversation', 'quick summary'],
    ContextCompression: ['compress the context', 'compress this context', 'context compression',
        'summarize the conversation so far', 'condense the conversation'],
    PromptSuggestion: ['suggest follow-up', 'suggest next', 'what should i ask',
        'suggest some prompts', 'follow-up questions', 'suggested prompts'],
    SystemMessage: ['you are a helpful', 'you are an ai', 'system prompt', 'instructions:'],
    EnvironmentProbe: ['what model are you', 'which model', 'what version', 'are you gpt', 'are you claude',
        'what is your name', 'who are you', 'identify yourself'],
};

const FLASH_MODEL = 'gemini-2.5-flash';
const BACKGROUND_TASK_MAX_LENGTH = 800;

/**
 * 检测是否为背景任务
 * 只检查最后一条 user 消息，长度 < 800 字符
 * 返回 { isBackground: boolean, taskType: string|null }
 */
function detectBackgroundTask(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { isBackground: false, taskType: null };
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== 'user') return { isBackground: false, taskType: null };

    const content = Array.isArray(lastMsg.content)
        ? lastMsg.content.map(b => b.text || '').join('')
        : String(lastMsg.content || '');

    if (content.length > BACKGROUND_TASK_MAX_LENGTH) {
        return { isBackground: false, taskType: null };
    }

    const lower = content.toLowerCase();
    for (const [taskType, keywords] of Object.entries(BACKGROUND_TASK_KEYWORDS)) {
        for (const kw of keywords) {
            if (lower.includes(kw)) {
                return { isBackground: true, taskType };
            }
        }
    }

    return { isBackground: false, taskType: null };
}

/**
 * 对 Antigravity 请求体执行背景任务降级
 * - 模型切换到 Flash
 * - 移除 tools / toolConfig
 * - 移除 thinkingConfig
 * - 精简历史（只保留最后 4 条消息）
 */
function downgradeForBackgroundTask(antigravityRequest, taskType) {
    antigravityRequest.model = FLASH_MODEL;

    // 移除 tools
    if (antigravityRequest.request) {
        delete antigravityRequest.request.tools;
        delete antigravityRequest.request.toolConfig;
        // 移除 thinking
        if (antigravityRequest.request.generationConfig) {
            delete antigravityRequest.request.generationConfig.thinkingConfig;
        }
        // 精简历史：只保留最后 4 条
        if (Array.isArray(antigravityRequest.request.contents) && antigravityRequest.request.contents.length > 4) {
            antigravityRequest.request.contents = antigravityRequest.request.contents.slice(-4);
        }
    }

    console.log(`[ClaudeAntigravity] 🔽 Background task detected (${taskType}), downgraded to ${FLASH_MODEL}`);
    return antigravityRequest;
}

// ==================== Thinking Block 清理 (参考 Antigravity-Manager handlers/claude.rs) ====================

/**
 * 从消息历史中剥离损坏的 thinking blocks
 * 用于 400 thinking signature 错误后的重试
 *
 * 对齐 demo claude.rs lines 1040-1062:
 *   - 遍历所有 assistant 消息
 *   - 将 thinking block 转为普通 text（保留上下文）
 *   - 删除 redacted_thinking
 *   - 清除所有 signature 字段
 */
function stripThinkingBlocksFromMessages(messages) {
    if (!Array.isArray(messages)) return messages;

    for (const msg of messages) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

        const cleaned = [];
        for (const block of msg.content) {
            if (block.type === 'thinking') {
                // 转为普通文本保留上下文
                if (block.thinking && block.thinking.trim()) {
                    cleaned.push({ type: 'text', text: `[previous reasoning: ${block.thinking.slice(0, 200)}...]` });
                }
                continue;
            }
            if (block.type === 'redacted_thinking') {
                // 直接丢弃
                continue;
            }
            // 清除 signature 字段
            if (block.signature) {
                delete block.signature;
            }
            cleaned.push(block);
        }

        // 确保 assistant 消息至少有一个 content block
        if (cleaned.length === 0) {
            cleaned.push({ type: 'text', text: '(content omitted)' });
        }

        msg.content = cleaned;
    }

    return messages;
}

/**
 * 从 Antigravity 请求体中剥离 thinking 配置
 * 用于 400 thinking signature 错误后的重试
 */
function stripThinkingFromRequest(antigravityRequest) {
    if (antigravityRequest.request?.generationConfig?.thinkingConfig) {
        delete antigravityRequest.request.generationConfig.thinkingConfig;
    }
    // 清理 contents 中的 thought parts
    if (Array.isArray(antigravityRequest.request?.contents)) {
        for (const content of antigravityRequest.request.contents) {
            if (!Array.isArray(content.parts)) continue;
            content.parts = content.parts.filter(part => {
                if (part.thought === true) {
                    // 转为普通文本
                    if (part.text && part.text.trim()) {
                        part.thought = undefined;
                        part.thoughtSignature = undefined;
                        return true;
                    }
                    return false;
                }
                // 清除 thoughtSignature
                if (part.thoughtSignature) {
                    delete part.thoughtSignature;
                }
                return true;
            });
            if (content.parts.length === 0) {
                content.parts = [{ text: '(content omitted)' }];
            }
        }
    }
    return antigravityRequest;
}

// ==================== Warmup 请求拦截 (参考 Antigravity-Manager handlers/claude.rs) ====================

/**
 * 检测是否为 warmup 请求
 * 只检查最后一条消息，不检查历史
 */
function isWarmupRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== 'user') return false;

    const content = Array.isArray(lastMsg.content)
        ? lastMsg.content.map(b => b.text || '').join('')
        : String(lastMsg.content || '');

    if (content.startsWith('Warmup')) return true;

    // tool_result 中包含 error 的也可能是 warmup
    if (Array.isArray(lastMsg.content)) {
        for (const block of lastMsg.content) {
            if (block.type === 'tool_result' && block.is_error === true) {
                const text = typeof block.content === 'string' ? block.content : '';
                if (text.includes('Warmup') || text.includes('warmup')) return true;
            }
        }
    }
    return false;
}

/**
 * 生成 warmup 的合成 SSE 响应（不调用上游，省额度）
 */
function generateWarmupSSEResponse(originalModel) {
    const msgId = 'msg_' + uuidv4();
    let output = '';
    output += `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: originalModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })}\n\n`;
    output += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`;
    output += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Warmup complete.' } })}\n\n`;
    output += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`;
    output += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`;
    output += `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    return output;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== Project ID 动态获取 (参考 demo project_resolver.rs) ====================

/**
 * 通过 loadCodeAssist API 获取正确的 cloudaicompanionProject
 *
 * 这是 429 的根因！demo 用的是 cloudaicompanionProject（如 "bamboo-precept-lgxtn"），
 * 而我们之前用的是 OAuth 凭证里的 GCP project_id，这是完全不同的东西。
 * 用错 project 会走错误的配额桶，导致 429。
 */
async function fetchCloudAICompanionProject(accessToken) {
    const baseURLs = [
        ANTIGRAVITY_BASE_URL_PROD,
        ANTIGRAVITY_BASE_URL_DAILY,
        ANTIGRAVITY_BASE_URL_SANDBOX
    ];
    const userAgent = await getResolvedUserAgent();

    for (const baseURL of baseURLs) {
        const url = `${baseURL}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': userAgent,
                },
                body: JSON.stringify({
                    metadata: { ideType: 'ANTIGRAVITY' }
                })
            });

            if (!response.ok) {
                const text = await response.text();
                console.warn(`[ClaudeAntigravity] loadCodeAssist HTTP ${response.status} (${baseURL}): ${text}`);
                continue;
            }

            const data = await response.json();
            const projectId = data?.cloudaicompanionProject;
            if (projectId) {
                console.log(`[ClaudeAntigravity] ✅ Got cloudaicompanionProject: ${projectId} (${baseURL})`);
                return projectId;
            }

            console.warn(`[ClaudeAntigravity] loadCodeAssist OK but missing cloudaicompanionProject (${baseURL})`);
        } catch (err) {
            console.warn(`[ClaudeAntigravity] loadCodeAssist request failed (${baseURL}): ${err.message}`);
        }
    }

    return null;
}

// Safety Settings 阈值配置
const SAFETY_THRESHOLD_MAP = {
    'OFF': 'OFF',
    'LOW': 'BLOCK_LOW_AND_ABOVE',
    'MEDIUM': 'BLOCK_MEDIUM_AND_ABOVE',
    'HIGH': 'BLOCK_ONLY_HIGH',
    'NONE': 'BLOCK_NONE'
};

// Claude → Antigravity 模型映射
// 全部从 DB (channel_configs.config.modelMapping) 读取，不再硬编码

// DB 模型映射缓存
let _dbModelMappingCache = null;
let _dbModelMappingLoadedAt = 0;
const DB_MODEL_MAPPING_TTL_MS = 60_000; // 1分钟缓存

/**
 * 从 DB 加载模型映射配置（带缓存）
 */
async function getDbModelMapping() {
    const now = Date.now();
    if (_dbModelMappingCache !== null && (now - _dbModelMappingLoadedAt) < DB_MODEL_MAPPING_TTL_MS) {
        return _dbModelMappingCache;
    }
    try {
        const config = await channelConfigDao.getByProviderType('claude-antigravity');
        const mapping = config?.config?.modelMapping;
        _dbModelMappingCache = (mapping && typeof mapping === 'object') ? mapping : {};
        _dbModelMappingLoadedAt = now;
    } catch (err) {
        console.warn('[Antigravity] Failed to load model mapping from DB:', err.message);
        if (_dbModelMappingCache === null) _dbModelMappingCache = {};
    }
    return _dbModelMappingCache;
}

/**
 * 清除 DB 模型映射缓存（配置更新时调用）
 */
export function clearModelMappingCache() {
    _dbModelMappingCache = null;
    _dbModelMappingLoadedAt = 0;
    console.log('[Antigravity] Model mapping cache cleared');
}

// ==================== 辅助函数 ====================

/**
 * 构建 Safety Settings
 */
function buildSafetySettings() {
    const envThreshold = process.env.GEMINI_SAFETY_THRESHOLD?.toUpperCase() || 'OFF';
    const threshold = SAFETY_THRESHOLD_MAP[envThreshold] || 'OFF';
    return [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold },
        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold }
    ];
}

/**
 * 深度清理 cache_control 字段
 */
function deepCleanCacheControl(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) {
            deepCleanCacheControl(item);
        }
    } else {
        delete value.cache_control;
        for (const key of Object.keys(value)) {
            if (typeof value[key] === 'object') {
                deepCleanCacheControl(value[key]);
            }
        }
    }
}

/**
 * 深度清理 undefined 字符串
 */
function deepCleanUndefined(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
            if (value[i] === '[undefined]' || value[i] === 'undefined') {
                value.splice(i, 1);
            } else if (typeof value[i] === 'object') {
                deepCleanUndefined(value[i]);
            }
        }
    } else {
        for (const key of Object.keys(value)) {
            if (value[key] === '[undefined]' || value[key] === 'undefined') {
                delete value[key];
            } else if (typeof value[key] === 'object') {
                deepCleanUndefined(value[key]);
            }
        }
    }
}

/**
 * 生成请求 ID
 */
function generateRequestID(accountFingerprint = '') {
    const id = uuidv4().replace(/-/g, '');
    if (accountFingerprint) {
        return `agent-${accountFingerprint.slice(0, 8)}-${id.slice(0, 24)}`;
    }
    return 'agent-' + id;
}

function buildAccountFingerprint(config = {}) {
    const parts = [
        config?.uuid,
        config?.oauthCredentialId,
        config?.oauth_credential_id,
        config?.sharedCredentialsId,
        config?.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH,
        config?.customName
    ].filter(value => typeof value === 'string' && value.trim());

    const seed = parts.join('|') || 'claude-antigravity-default';
    return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function generateScopedSessionId(accountFingerprint, clientSessionId = null) {
    const rawSession = typeof clientSessionId === 'string' ? clientSessionId.trim() : '';

    if (!accountFingerprint) {
        return rawSession || null;
    }

    const hashBase = rawSession || 'anonymous';
    const hash = createHash('sha256')
        .update(`${accountFingerprint}|${hashBase}`)
        .digest('hex')
        .slice(0, 20);

    return `-${hash}`;
}

function normalizeProjectId(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;
    return raw;
}

/**
 * 映射 Claude 模型到 Gemini 模型（从 DB 读取映射）
 */
async function mapClaudeModelToGeminiAsync(model) {
    if (!model || typeof model !== 'string') {
        return 'claude-sonnet-4-5';
    }
    const modelLower = model.toLowerCase();
    if (modelLower.includes('haiku')) {
        return 'claude-sonnet-4-5';
    }

    // 从 DB 读取映射
    const dbMapping = await getDbModelMapping();
    if (dbMapping[model]) return dbMapping[model];

    // DB 无匹配：智能 fallback
    if (modelLower.startsWith('claude-')) {
        if (modelLower.includes('opus')) {
            return 'claude-opus-4-5-thinking';
        }
        return 'claude-sonnet-4-5';
    }

    if (modelLower.startsWith('gemini-')) {
        return model;
    }

    return 'claude-sonnet-4-5';
}

// 同步版本（用于不支持 async 的调用点，仅使用缓存）
function mapClaudeModelToGemini(model) {
    if (!model || typeof model !== 'string') {
        return 'claude-sonnet-4-5';
    }
    const modelLower = model.toLowerCase();
    if (modelLower.includes('haiku')) {
        return 'claude-sonnet-4-5';
    }

    // 使用已缓存的 DB 映射
    if (_dbModelMappingCache && _dbModelMappingCache[model]) return _dbModelMappingCache[model];

    // DB 无匹配：智能 fallback
    if (modelLower.startsWith('claude-')) {
        if (modelLower.includes('opus')) {
            return 'claude-opus-4-5-thinking';
        }
        return 'claude-sonnet-4-5';
    }

    if (modelLower.startsWith('gemini-')) {
        return model;
    }

    return 'claude-sonnet-4-5';
}

/**
 * 检查是否应该默认启用 thinking
 */
function shouldEnableThinkingByDefault(model) {
    if (!model || typeof model !== 'string') return false;
    const modelLower = model.toLowerCase();
    if (modelLower.includes('opus-4-5') || modelLower.includes('opus-4.5')) {
        return true;
    }
    if (modelLower.includes('-thinking')) {
        return true;
    }
    return false;
}

function targetModelSupportsThinking(model) {
    if (!model || typeof model !== 'string') return false;
    const modelLower = model.toLowerCase();
    return modelLower.includes('-thinking')
        || modelLower.startsWith('claude-')
        || modelLower.includes('gemini-2.0-pro')
        || modelLower.includes('gemini-3-pro');
}

function hasWebSearchTool(tools) {
    if (!Array.isArray(tools)) return false;
    return tools.some(tool =>
        tool?.type?.startsWith('web_search') ||
        tool?.name === 'google_search' ||
        tool?.type === 'web_search_20250305'
    );
}

function shouldDisableThinkingDueToHistory(messages) {
    if (!Array.isArray(messages)) return false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== 'assistant' || !Array.isArray(message?.content)) {
            continue;
        }

        const hasToolUse = message.content.some(block => block?.type === 'tool_use');
        const hasThinking = message.content.some(block => block?.type === 'thinking');
        return hasToolUse && !hasThinking;
    }

    return false;
}

/**
 * 合并连续同角色消息
 */
function mergeConsecutiveMessages(messages) {
    if (!messages || messages.length <= 1) return messages;

    const merged = [];
    let current = JSON.parse(JSON.stringify(messages[0]));

    for (let i = 1; i < messages.length; i++) {
        const next = messages[i];
        if (current.role === next.role) {
            // 合并 content
            const currentContent = Array.isArray(current.content) ? current.content : [{ type: 'text', text: current.content }];
            const nextContent = Array.isArray(next.content) ? next.content : [{ type: 'text', text: next.content }];
            current.content = [...currentContent, ...nextContent];
        } else {
            merged.push(current);
            current = JSON.parse(JSON.stringify(next));
        }
    }
    merged.push(current);
    return merged;
}

/**
 * 清理消息中的 cache_control
 */
function cleanCacheControlFromMessages(messages) {
    for (const msg of messages) {
        if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                delete block.cache_control;
            }
        }
    }
}

/**
 * 排序 thinking 块到最前面
 */
function sortThinkingBlocksFirst(messages) {
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const thinkingBlocks = [];
            const otherBlocks = [];
            for (const block of msg.content) {
                if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                    thinkingBlocks.push(block);
                } else {
                    otherBlocks.push(block);
                }
            }
            msg.content = [...thinkingBlocks, ...otherBlocks];
        }
    }
}

// ==================== Claude → Gemini 请求转换 ====================

/**
 * 构建 System Instruction
 */
function buildSystemInstruction(system) {
    const parts = [];

    // [对齐 demo request.rs build_system_instruction] Antigravity 身份注入
    const ANTIGRAVITY_IDENTITY = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\nYou are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n**Absolute paths only**\n**Proactiveness**';

    // 提取用户 system prompt 文本
    let userTexts = [];
    if (typeof system === 'string') {
        // Claude API 的 system 可能是:
        // 1. JSON array: '[{"type":"text","text":"..."}]'
        // 2. JSON array + 纯文本拼接: '[{"type":"text","text":"..."}]\nYou are Claude Code...'
        // 3. 纯文本字符串
        const trimmed = system.trim();
        if (trimmed.startsWith('[')) {
            // 尝试找到 JSON array 的结束位置并分别解析
            let bracketDepth = 0;
            let inString = false;
            let escape = false;
            let arrayEnd = -1;
            for (let i = 0; i < trimmed.length; i++) {
                const c = trimmed[i];
                if (escape) { escape = false; continue; }
                if (c === '\\') { escape = true; continue; }
                if (c === '"' && !escape) { inString = !inString; continue; }
                if (inString) continue;
                if (c === '[') bracketDepth++;
                else if (c === ']') { bracketDepth--; if (bracketDepth === 0) { arrayEnd = i; break; } }
            }
            if (arrayEnd > 0) {
                try {
                    const jsonPart = trimmed.substring(0, arrayEnd + 1);
                    const parsed = JSON.parse(jsonPart);
                    if (Array.isArray(parsed)) {
                        for (const block of parsed) {
                            if (block.text) userTexts.push(block.text);
                        }
                    }
                } catch { /* ignore parse error, fall through */ }
                // JSON array 后面可能还有纯文本
                const remainder = trimmed.substring(arrayEnd + 1).trim();
                if (remainder) {
                    userTexts.push(remainder);
                }
            } else {
                if (system) userTexts.push(system);
            }
        } else {
            if (system) userTexts.push(system);
        }
    } else if (Array.isArray(system)) {
        for (const block of system) {
            if (typeof block === 'string') {
                userTexts.push(block);
            } else if (block.text) {
                userTexts.push(block.text);
            }
        }
    }

    // 检查用户 system prompt 的第一个 part 是否就是 Antigravity 身份指令
    // 注意：不能用 includes('You are Antigravity') 因为 MEMORY.md 等引用会误判
    const IDENTITY_SIGNATURE = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind';
    const userHasAntigravity = userTexts.length > 0 && userTexts[0].startsWith(IDENTITY_SIGNATURE);

    // 如果用户没有提供 Antigravity 身份，则注入
    if (!userHasAntigravity) {
        parts.push({ text: ANTIGRAVITY_IDENTITY });
    }

    // 添加用户的系统提示词
    for (const t of userTexts) {
        parts.push({ text: t });
    }

    // 结束标记
    if (!userHasAntigravity) {
        parts.push({ text: '\n--- [SYSTEM_PROMPT_END] ---' });
    }

    if (parts.length === 0) {
        // 即使没有用户 system prompt，也注入身份
        parts.push({ text: ANTIGRAVITY_IDENTITY });
        parts.push({ text: '\n--- [SYSTEM_PROMPT_END] ---' });
    }

    return {
        role: 'user',
        parts
    };
}

/**
 * 转换 Claude Content Block 到 Gemini Part
 */
function convertContentBlockToPart(block, isThinkingEnabled) {
    if (!block) return null;

    switch (block.type) {
        case 'text':
            return { text: block.text || '' };

        case 'thinking':
            if (!isThinkingEnabled) {
                // thinking 禁用时降级为普通文本
                return block.thinking ? { text: block.thinking } : null;
            }
            return {
                text: block.thinking || '',
                thought: true,
                thoughtSignature: block.signature || undefined
            };

        case 'redacted_thinking':
            // redacted_thinking 降级为文本
            return { text: '[redacted]' };

        case 'image':
            if (block.source?.type === 'base64') {
                return {
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                };
            }
            return null;

        case 'tool_use':
            return {
                functionCall: {
                    name: block.name,
                    args: block.input || {},
                    id: block.id || undefined
                },
                thoughtSignature: block.signature || undefined
            };

        case 'tool_result':
            // tool_result 需要特殊处理
            let resultContent = '';
            if (typeof block.content === 'string') {
                resultContent = block.content;
            } else if (Array.isArray(block.content)) {
                resultContent = block.content.map(c => c.text || '').join('\n');
            }
            return {
                functionResponse: {
                    name: block.tool_use_id || 'tool_result',
                    id: block.tool_use_id || undefined,
                    response: { result: resultContent }
                },
                thoughtSignature: block.signature || undefined
            };

        default:
            return null;
    }
}

/**
 * 转换 Claude Message 到 Gemini Content
 */
function convertMessageToContent(msg, toolIdToMeta, isThinkingEnabled) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content }];

    for (const block of content) {
        // 记录 tool_use id -> name 映射
        if (block.type === 'tool_use' && block.id && block.name) {
            toolIdToMeta[block.id] = {
                name: block.name,
                signature: block.signature || null
            };
        }

        // tool_result 需要查找对应的 tool name
        if (block.type === 'tool_result') {
            const toolMeta = toolIdToMeta[block.tool_use_id] || {};
            const toolName = toolMeta.name || block.tool_use_id || 'tool_result';
            let resultContent = '';
            if (typeof block.content === 'string') {
                resultContent = block.content;
            } else if (Array.isArray(block.content)) {
                resultContent = block.content
                    .map(item => {
                        if (typeof item === 'string') return item;
                        if (item?.text) return item.text;
                        if (item?.type === 'image') return '[image omitted to save context]';
                        return '';
                    })
                    .filter(Boolean)
                    .join('\n');
            }
            const functionResponsePart = {
                functionResponse: {
                    name: toolName,
                    id: block.tool_use_id || undefined,
                    response: { result: resultContent }
                }
            };

            const signature = block.signature || toolMeta.signature;
            if (signature) {
                functionResponsePart.thoughtSignature = signature;
            }

            parts.push(functionResponsePart);
            continue;
        }

        const part = convertContentBlockToPart(block, isThinkingEnabled);
        if (part) {
            parts.push(part);
        }
    }

    return { role, parts };
}

/**
 * 构建 Gemini Contents
 */
function buildGeminiContents(messages, isThinkingEnabled) {
    const toolIdToMeta = {};
    const contents = [];

    for (const msg of messages) {
        const content = convertMessageToContent(msg, toolIdToMeta, isThinkingEnabled);
        if (content.parts.length > 0) {
            contents.push(content);
        }
    }

    return mergeAdjacentRoles(contents);
}

/**
 * 合并连续同角色的 Gemini contents
 */
function mergeAdjacentRoles(contents) {
    if (!contents || contents.length <= 1) return contents;

    const merged = [];
    let current = { ...contents[0], parts: [...(contents[0].parts || [])] };

    for (let i = 1; i < contents.length; i++) {
        const next = contents[i];
        if (current.role === next.role) {
            if (next.parts) {
                current.parts = [...current.parts, ...next.parts];
            }
        } else {
            // 对 model 消息重排序 parts
            if (current.role === 'model') {
                current.parts = reorderGeminiParts(current.parts);
            }
            merged.push(current);
            current = { ...next, parts: [...(next.parts || [])] };
        }
    }
    if (current.role === 'model') {
        current.parts = reorderGeminiParts(current.parts);
    }
    merged.push(current);

    return merged;
}

/**
 * 重排序 Gemini parts (thinking 在前)
 */
function reorderGeminiParts(parts) {
    if (!parts || parts.length <= 1) return parts;

    const thinkingParts = [];
    const textParts = [];
    const toolParts = [];
    const otherParts = [];

    for (const part of parts) {
        if (part.thought === true) {
            thinkingParts.push(part);
        } else if (part.functionCall) {
            toolParts.push(part);
        } else if (part.text !== undefined) {
            if (part.text.trim() && part.text !== '(no content)') {
                textParts.push(part);
            }
        } else {
            otherParts.push(part);
        }
    }

    return [...thinkingParts, ...textParts, ...otherParts, ...toolParts];
}

/**
 * 构建 Tools (Claude → Gemini)
 */
function buildTools(tools) {
    if (!tools || tools.length === 0) return null;

    let hasGoogleSearch = false;
    const functionDeclarations = [];
    for (const tool of tools) {
        // 跳过 server tools (web_search)
        if (tool.type?.startsWith('web_search') || tool.name === 'google_search') {
            hasGoogleSearch = true;
            continue;
        }
        if (!tool.name) continue;

        const funcDecl = {
            name: tool.name,
            description: tool.description || ''
        };

        if (tool.input_schema) {
            funcDecl.parameters = cleanJsonSchemaProperties(tool.input_schema);
            delete funcDecl.parameters.$schema;
        }

        functionDeclarations.push(funcDecl);
    }

    if (functionDeclarations.length > 0) {
        return [{ functionDeclarations }];
    }

    if (hasGoogleSearch) {
        return [{ googleSearch: {} }];
    }

    return null;
}

/**
 * 构建 Generation Config
 */
function buildGenerationConfig(claudeReq, isThinkingEnabled, mappedModel) {
    const config = {};

    if (claudeReq.max_tokens) {
        config.maxOutputTokens = claudeReq.max_tokens;
    }
    if (claudeReq.temperature !== undefined) {
        config.temperature = claudeReq.temperature;
    }
    if (claudeReq.top_p !== undefined) {
        config.topP = claudeReq.top_p;
    }
    if (claudeReq.top_k !== undefined) {
        config.topK = claudeReq.top_k;
    }

    if (claudeReq.output_config?.effort) {
        const effort = String(claudeReq.output_config.effort).toLowerCase();
        config.effortLevel = effort === 'low'
            ? 'LOW'
            : effort === 'medium'
                ? 'MEDIUM'
                : 'HIGH';
    }

    // Thinking 配置
    if (isThinkingEnabled) {
        let budgetTokens = claudeReq.thinking?.budget_tokens || 16000;

        // [对齐 demo request.rs line 1728-1741] -thinking 后缀模型强制 cap 到 24576
        const modelLower = (mappedModel || '').toLowerCase();
        const isGeminiLimited = modelLower.includes('gemini')
            || modelLower.includes('flash')
            || modelLower.endsWith('-thinking');
        if (isGeminiLimited && budgetTokens > 24576) {
            console.warn(`[ClaudeAntigravity] Capping thinking_budget from ${budgetTokens} to 24576 for model ${mappedModel}`);
            budgetTokens = 24576;
        }

        config.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: budgetTokens
        };

        // 确保 maxOutputTokens > thinkingBudget
        if (!config.maxOutputTokens || config.maxOutputTokens <= budgetTokens) {
            config.maxOutputTokens = budgetTokens + 8192;
        }
    }

    config.stopSequences = ['<|user|>', '<|end_of_turn|>', '\n\nHuman:'];

    return Object.keys(config).length > 0 ? config : null;
}

/**
 * 主转换函数: Claude Request → Antigravity Request
 */
function transformClaudeRequestIn(claudeReq, projectId = null, accountFingerprint = '') {
    // 1. 预处理消息
    let messages = JSON.parse(JSON.stringify(claudeReq.messages || []));
    messages = mergeConsecutiveMessages(messages);
    cleanCacheControlFromMessages(messages);
    sortThinkingBlocksFirst(messages);

    // 2. 确定是否启用 thinking
    let isThinkingEnabled = claudeReq.thinking?.type === 'enabled';
    if (!isThinkingEnabled) {
        isThinkingEnabled = shouldEnableThinkingByDefault(claudeReq.model);
    }

    const hasWebSearch = hasWebSearchTool(claudeReq.tools);

    // 3. 映射模型
    const mappedModel = hasWebSearch
        ? 'gemini-2.5-flash'
        : mapClaudeModelToGemini(claudeReq.model);

    if (isThinkingEnabled && !targetModelSupportsThinking(mappedModel)) {
        isThinkingEnabled = false;
    }

    if (isThinkingEnabled && shouldDisableThinkingDueToHistory(messages)) {
        isThinkingEnabled = false;
    }

    // 4. 构建 System Instruction
    const systemInstruction = buildSystemInstruction(claudeReq.system);

    // 5. 构建 Contents
    const contents = buildGeminiContents(messages, isThinkingEnabled);

    // 6. 构建 Tools
    const tools = buildTools(claudeReq.tools);

    // 7. 构建 Generation Config
    const generationConfig = buildGenerationConfig(claudeReq, isThinkingEnabled, mappedModel);

    // 8. 构建 inner request
    const innerRequest = {
        contents,
        safetySettings: buildSafetySettings()
    };

    if (systemInstruction) {
        innerRequest.systemInstruction = systemInstruction;
    }
    if (generationConfig) {
        innerRequest.generationConfig = generationConfig;
    }
    if (tools) {
        innerRequest.tools = tools;
        innerRequest.toolConfig = {
            functionCallingConfig: { mode: 'VALIDATED' }
        };
    }

    deepCleanUndefined(innerRequest);

    // 9. 构建最终请求体
    const requestId = generateRequestID(accountFingerprint);
    const body = {
        requestId,
        request: innerRequest,
        model: mappedModel,
        userAgent: 'antigravity',
        requestType: 'agent'
    };
    if (projectId) {
        body.project = projectId;
    }

    // 10. 设置 sessionId
    const scopedSessionId = generateScopedSessionId(accountFingerprint, claudeReq.metadata?.user_id);
    if (scopedSessionId) {
        body.request.sessionId = scopedSessionId;
    }

    // 11. 最终清理
    deepCleanUndefined(body);
    deepCleanCacheControl(body);

    return body;
}

// ==================== Gemini → Claude 响应转换 ====================

/**
 * 将 Gemini usageMetadata 转换为 Claude usage
 * 参考: demo/.../claude/utils.rs to_claude_usage
 */
function toClaudeUsage(usageMetadata, scalingEnabled = true, contextLimit = 1048576) {
    const promptTokens = usageMetadata?.promptTokenCount || 0;
    const cachedTokens = usageMetadata?.cachedContentTokenCount || 0;
    const outputTokens = usageMetadata?.candidatesTokenCount || 0;

    const SCALING_THRESHOLD = 30000;
    const TARGET_MAX = 195000;

    let scaledTotal = promptTokens;

    if (scalingEnabled && promptTokens > SCALING_THRESHOLD) {
        const ratio = promptTokens / contextLimit;

        if (ratio <= 0.5) {
            // 阶段1: 激进压缩
            const displayRatio = ratio * 0.6;
            scaledTotal = Math.floor(displayRatio * TARGET_MAX);
        } else if (ratio <= 0.7) {
            // 阶段2: 开始回升
            const progress = (ratio - 0.5) / 0.2;
            const displayRatio = 0.3 + progress * 0.2;
            scaledTotal = Math.floor(displayRatio * TARGET_MAX);
        } else if (ratio <= 0.85) {
            // 阶段3: 快速回升
            const progress = (ratio - 0.7) / 0.15;
            const displayRatio = 0.5 + progress * 0.2;
            scaledTotal = Math.floor(displayRatio * TARGET_MAX);
        } else {
            // 阶段4: 接近 1:1
            const progress = (ratio - 0.85) / 0.15;
            const displayRatio = Math.min(0.7 + progress * 0.27, 0.97);
            scaledTotal = Math.floor(displayRatio * TARGET_MAX);
        }
    }

    // 按比例分配
    let reportedInput = scaledTotal;
    let reportedCache = null;
    if (promptTokens > 0 && cachedTokens > 0) {
        const cacheRatio = cachedTokens / promptTokens;
        reportedCache = Math.floor(scaledTotal * cacheRatio);
        reportedInput = scaledTotal - reportedCache;
    }

    return {
        input_tokens: reportedInput,
        output_tokens: outputTokens,
        cache_read_input_tokens: reportedCache || 0,
        cache_creation_input_tokens: 0
    };
}

/**
 * 重映射工具调用参数 (Gemini → Claude)
 * 参考: demo/.../claude/streaming.rs remap_function_call_args
 */
function remapFunctionCallArgs(toolName, args) {
    if (!args || typeof args !== 'object') return args;

    const name = toolName.toLowerCase();

    // EnterPlanMode 不允许参数
    if (toolName === 'EnterPlanMode') {
        return {};
    }

    if (['grep', 'search', 'search_code_definitions', 'search_code_snippets'].includes(name)) {
        // description → pattern
        if (args.description && !args.pattern) {
            args.pattern = args.description;
            delete args.description;
        }
        // query → pattern
        if (args.query && !args.pattern) {
            args.pattern = args.query;
            delete args.query;
        }
        // paths → path
        if (!args.path && args.paths) {
            if (Array.isArray(args.paths)) {
                args.path = args.paths[0] || '.';
            } else {
                args.path = args.paths;
            }
            delete args.paths;
        }
        if (!args.path) {
            args.path = '.';
        }
    }

    if (name === 'glob') {
        if (args.description && !args.pattern) {
            args.pattern = args.description;
            delete args.description;
        }
        if (args.query && !args.pattern) {
            args.pattern = args.query;
            delete args.query;
        }
        if (!args.path && args.paths) {
            if (Array.isArray(args.paths)) {
                args.path = args.paths[0] || '.';
            } else {
                args.path = args.paths;
            }
            delete args.paths;
        }
    }

    if (name === 'read') {
        if (args.path && !args.file_path) {
            args.file_path = args.path;
            delete args.path;
        }
    }

    if (name === 'bash') {
        if (args.cmd && !args.command) {
            args.command = args.cmd;
            delete args.cmd;
        }
    }

    return args;
}

/**
 * 转换 Gemini Part 到 Claude Content Block
 */
/**
 * 转换 Gemini Response 到 Claude Response (非流式)
 * 对齐 demo response.rs 的 NonStreamingProcessor
 */
function transformGeminiResponseOut(geminiResponse, originalModel) {
    const response = geminiResponse.response || geminiResponse;
    const candidate = response.candidates?.[0];

    if (!candidate) {
        return {
            id: 'msg_' + uuidv4(),
            type: 'message',
            role: 'assistant',
            model: originalModel,
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        };
    }

    // 对齐 demo NonStreamingProcessor — 使用 builder 模式处理 parts
    const content = [];
    let textBuilder = '';
    let thinkingBuilder = '';
    let thinkingSignature = null;
    let trailingSignature = null;
    let hasToolCall = false;

    const flushThinking = () => {
        if (!thinkingBuilder && !thinkingSignature) return;
        content.push({
            type: 'thinking',
            thinking: thinkingBuilder,
            signature: thinkingSignature || undefined
        });
        thinkingBuilder = '';
        thinkingSignature = null;
    };

    const flushText = () => {
        if (!textBuilder) return;
        content.push({ type: 'text', text: textBuilder });
        textBuilder = '';
    };

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
        // 解码 base64 签名
        const signature = decodeSignature(part.thoughtSignature);

        // 1. FunctionCall
        if (part.functionCall) {
            flushThinking();
            flushText();

            // 处理 trailingSignature
            if (trailingSignature) {
                content.push({ type: 'thinking', thinking: '', signature: trailingSignature });
                trailingSignature = null;
            }

            hasToolCall = true;
            const toolId = part.functionCall.id || ('toolu_' + uuidv4().replace(/-/g, '').slice(0, 24));
            const args = remapFunctionCallArgs(part.functionCall.name, part.functionCall.args || {});
            content.push({
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: args
            });
            continue;
        }

        // 2. Text / Thinking
        if (part.text !== undefined) {
            if (part.thought === true) {
                // Thinking part
                flushText();
                if (trailingSignature) {
                    flushThinking();
                    content.push({ type: 'thinking', thinking: '', signature: trailingSignature });
                    trailingSignature = null;
                }
                thinkingBuilder += part.text;
                if (signature) thinkingSignature = signature;
            } else {
                // Text part
                if (!part.text && part.text !== 0) {
                    // 空 text 带签名 → trailingSignature
                    if (signature) trailingSignature = signature;
                    continue;
                }
                flushThinking();
                if (trailingSignature) {
                    flushText();
                    content.push({ type: 'thinking', thinking: '', signature: trailingSignature });
                    trailingSignature = null;
                }
                textBuilder += part.text;
                // 非空 text 带签名 → 立即 flush 并输出空 thinking 块
                if (signature) {
                    flushText();
                    content.push({ type: 'thinking', thinking: '', signature });
                }
            }
            continue;
        }

        // 3. InlineData → image
        if (part.inlineData) {
            flushThinking();
            const markdown = `![image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})`;
            textBuilder += markdown;
            flushText();
        }
    }

    // 刷新剩余内容
    flushThinking();
    flushText();

    // 处理末尾 trailingSignature
    if (trailingSignature) {
        content.push({ type: 'thinking', thinking: '', signature: trailingSignature });
    }

    // 映射 stop_reason
    let stopReason = 'end_turn';
    const finishReason = candidate.finishReason;
    if (hasToolCall || finishReason === 'TOOL_USE') {
        stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    }

    const usage = toClaudeUsage(response.usageMetadata);

    return {
        id: 'msg_' + uuidv4(),
        type: 'message',
        role: 'assistant',
        model: originalModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage
    };
}

// ==================== 流式响应转换 (对齐 demo streaming.rs) ====================

/**
 * 创建 Claude SSE 事件
 */
function createClaudeSSEEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 流式状态管理器 — 完全对齐 demo streaming.rs 的 StreamingState
 *
 * 核心设计:
 * - blockType: 'none' | 'thinking' | 'text' | 'function'
 * - startBlock() 自动关闭上一个 block (调用 endBlock)
 * - endBlock() 在 thinking block 结束时发送 pendingSignature
 * - trailingSignature: 空 text + signature 暂存，下一个 part 到来时作为独立 thinking block 发送
 */
class StreamingState {
    constructor(originalModel) {
        this.originalModel = originalModel;
        this.messageId = 'msg_' + uuidv4();
        this.blockIndex = 0;
        this.blockType = 'none'; // 'none' | 'thinking' | 'text' | 'function'
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.cacheReadTokens = 0;          // cache_read_input_tokens
        this.cacheCreationTokens = 0;      // cache_creation_input_tokens
        this.messageStartSent = false;
        this.messageStopSent = false;
        this.usedTool = false;
        this.pendingSignature = null;      // signature 暂存，thinking block end 时发送
        this.trailingSignature = null;     // 空 text + signature 暂存
    }

    /** 发送单个 SSE 事件 */
    emit(eventType, data) {
        return createClaudeSSEEvent(eventType, data);
    }

    /** 发送 delta 事件 */
    emitDelta(deltaType, deltaContent) {
        const delta = { type: deltaType, ...deltaContent };
        return this.emit('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta
        });
    }

    /** 发送 message_start (仅一次) */
    emitMessageStart(usageMetadata) {
        if (this.messageStartSent) return '';
        this.messageStartSent = true;

        if (usageMetadata) {
            const usage = toClaudeUsage(usageMetadata);
            this.inputTokens = usage.input_tokens;
            this.cacheReadTokens = usage.cache_read_input_tokens || 0;
            this.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        }

        return this.emit('message_start', {
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.originalModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: this.inputTokens,
                    output_tokens: 0,
                    cache_read_input_tokens: this.cacheReadTokens,
                    cache_creation_input_tokens: this.cacheCreationTokens
                }
            }
        });
    }

    /**
     * 开始新的内容块 — 对齐 demo start_block()
     * 自动关闭上一个 block
     */
    startBlock(newBlockType, contentBlock) {
        let output = '';
        if (this.blockType !== 'none') {
            output += this.endBlock();
        }
        this.blockType = newBlockType;
        output += this.emit('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: contentBlock
        });
        return output;
    }

    /**
     * 结束当前内容块 — 对齐 demo end_block()
     * thinking block 结束时发送 pendingSignature
     */
    endBlock() {
        if (this.blockType === 'none') return '';

        let output = '';

        // Thinking 块结束时发送暂存的签名
        if (this.blockType === 'thinking' && this.pendingSignature) {
            output += this.emitDelta('signature_delta', { signature: this.pendingSignature });
            this.pendingSignature = null;
        }

        output += this.emit('content_block_stop', {
            type: 'content_block_stop',
            index: this.blockIndex
        });

        this.blockIndex++;
        this.blockType = 'none';
        return output;
    }

    /**
     * 发送结束事件 — 对齐 demo emit_finish()
     * 防止重复调用 (finishReason + [DONE] 都可能触发)
     */
    emitFinish(finishReason) {
        if (this.messageStopSent) return '';
        let output = '';

        // 关闭最后一个块
        output += this.endBlock();

        // 处理 trailingSignature — 对齐 demo: 缓存签名，不再追加非法末尾 thinking 块
        // (Claude 协议要求 thinking 在 text 之前，末尾追加会导致客户端断开)
        if (this.trailingSignature) {
            // 如果还没有发送过任何内容块，可以安全地发送一个 thinking 块
            // 否则只能丢弃（demo 也是这样处理的）
            if (this.blockIndex === 0) {
                output += this.startBlock('thinking', { type: 'thinking', thinking: '' });
                output += this.emitDelta('thinking_delta', { thinking: '' });
                this.pendingSignature = this.trailingSignature;
                output += this.endBlock();
            }
            this.trailingSignature = null;
        }

        // 确定 stop_reason
        let stopReason = 'end_turn';
        if (this.usedTool) {
            stopReason = 'tool_use';
        } else if (finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
        }

        output += this.emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
                input_tokens: this.inputTokens,
                output_tokens: this.outputTokens,
                cache_read_input_tokens: this.cacheReadTokens,
                cache_creation_input_tokens: this.cacheCreationTokens
            }
        });

        if (!this.messageStopSent) {
            output += this.emit('message_stop', { type: 'message_stop' });
            this.messageStopSent = true;
        }

        return output;
    }
}

/**
 * 解码 base64 签名 — Gemini 发送 base64，Claude 期望原始字符串
 */
function decodeSignature(sig) {
    if (!sig) return null;
    try {
        const decoded = Buffer.from(sig, 'base64').toString('utf-8');
        if (decoded && decoded.length > 0) return decoded;
    } catch {}
    return sig; // 非 base64，原样返回
}

/**
 * 发送 trailingSignature 作为独立 thinking 块 — 对齐 demo 的 trailing signature 处理
 * 在 process_thinking / process_text / process_function_call 开头调用
 */
function flushTrailingSignature(state) {
    if (!state.trailingSignature) return '';
    const sig = state.trailingSignature;
    state.trailingSignature = null;

    let output = '';
    // 关闭当前块
    output += state.endBlock();
    // 发送一个空 thinking 块 + signature
    output += state.startBlock('thinking', { type: 'thinking', thinking: '' });
    output += state.emitDelta('thinking_delta', { thinking: '' });
    state.pendingSignature = sig;
    output += state.endBlock();
    return output;
}

/**
 * 处理 Thinking part — 对齐 demo process_thinking()
 */
function processThinkingPart(state, text, signature) {
    let output = '';

    // 先处理 trailingSignature
    output += flushTrailingSignature(state);

    // 开始或继续 thinking 块
    if (state.blockType !== 'thinking') {
        output += state.startBlock('thinking', { type: 'thinking', thinking: '' });
    }

    if (text) {
        output += state.emitDelta('thinking_delta', { thinking: text });
    }

    // 暂存签名 (在 endBlock 时发送)
    if (signature) {
        state.pendingSignature = signature;
    }

    return output;
}

/**
 * 处理 Text part — 对齐 demo process_text()
 */
function processTextPart(state, text, signature) {
    let output = '';

    // 空 text 带签名 → 暂存为 trailingSignature
    if (!text || text === '') {
        if (signature) {
            state.trailingSignature = signature;
        }
        return output;
    }

    // 先处理 trailingSignature
    output += flushTrailingSignature(state);

    // 非空 text 带签名 — 对齐 demo: store signature (仅缓存，不在流中发送)
    // 立即发送 text 并关闭块
    if (signature) {
        // 注意: signature 存到 pendingSignature 是为了让 startBlock 时如果前一个块是 thinking 能发出去
        // 但 text 块自身不发送 signature，所以发完 text 后要清除
        state.pendingSignature = signature;
        output += state.startBlock('text', { type: 'text', text: '' });
        output += state.emitDelta('text_delta', { text });
        output += state.endBlock();
        // 清除残留的 pendingSignature (text 块不发送 signature)
        state.pendingSignature = null;
        return output;
    }

    // 普通 text (无签名)
    if (state.blockType !== 'text') {
        output += state.startBlock('text', { type: 'text', text: '' });
    }
    output += state.emitDelta('text_delta', { text });

    return output;
}

/**
 * 处理 FunctionCall part — 对齐 demo process_function_call()
 */
function processFunctionCallPart(state, fc, signature) {
    let output = '';

    // 先处理 trailingSignature
    output += flushTrailingSignature(state);

    state.usedTool = true;

    const toolId = fc.id || ('toolu_' + uuidv4().replace(/-/g, '').slice(0, 24));
    const toolName = fc.name;
    const args = remapFunctionCallArgs(fc.name, fc.args || {});

    // content_block_start (input 为空对象，参数通过 delta 发送)
    const toolUseBlock = {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: {}
    };

    output += state.startBlock('function', toolUseBlock);

    // input_json_delta
    output += state.emitDelta('input_json_delta', { partial_json: JSON.stringify(args) });

    // 结束块
    output += state.endBlock();

    return output;
}

/**
 * 处理单个 part — 对齐 demo PartProcessor.process()
 */
function processPart(state, part) {
    // 解码 base64 签名
    const signature = decodeSignature(part.thoughtSignature);

    // 1. FunctionCall
    if (part.functionCall) {
        return processFunctionCallPart(state, part.functionCall, signature);
    }

    // 2. Text / Thinking
    if (part.text !== undefined) {
        if (part.thought === true) {
            return processThinkingPart(state, part.text, signature);
        } else {
            return processTextPart(state, part.text, signature);
        }
    }

    return '';
}

/**
 * 转换 Gemini SSE 行到 Claude SSE 事件 — 对齐 demo streaming.rs 主循环
 */
function transformGeminiSSELine(line, state) {
    if (!line || !line.startsWith('data: ')) return '';

    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]') {
        return state.emitFinish(null);
    }

    let data;
    try {
        data = JSON.parse(jsonStr);
    } catch (e) {
        return '';
    }

    // 解包 v1internal 响应
    const response = data.response || data;
    const candidate = response.candidates?.[0];
    if (!candidate) return '';

    let output = '';

    // 首次响应，发送 message_start
    if (!state.messageStartSent) {
        output += state.emitMessageStart(response.usageMetadata);
    }

    // 处理 parts
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
        output += processPart(state, part);
    }

    // 更新 usage
    if (response.usageMetadata) {
        state.outputTokens = response.usageMetadata.candidatesTokenCount || 0;
    }

    // 检查是否结束 (finishReason)
    if (candidate.finishReason) {
        output += state.emitFinish(candidate.finishReason);
    }

    return output;
}

/**
 * 把 SSE 字符串拆成 JSON 对象数组
 * 输入: "event: message_start\ndata: {...}\n\nevent: content_block_delta\ndata: {...}\n\n"
 * 输出: [{type: 'message_start', ...}, {type: 'content_block_delta', ...}]
 *
 * handleStreamRequest 期望 yield 的是 JSON 对象，它自己负责加 event:/data: 前缀
 */
function parseSSEStringToObjects(sseString) {
    if (!sseString) return [];
    const results = [];
    // 按双换行分割成独立事件
    const events = sseString.split('\n\n');
    for (const event of events) {
        const trimmed = event.trim();
        if (!trimmed) continue;
        // 找 data: 行
        const lines = trimmed.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const obj = JSON.parse(line.slice(6));
                    results.push(obj);
                } catch {}
            }
        }
    }
    return results;
}

// ==================== 导出 ====================

// ==================== API Service 类 ====================

/**
 * Claude Antigravity API Service
 * 提供 Claude API 格式的接口，内部转换为 Antigravity 调用
 * 支持复用 gemini-antigravity 的凭证或独立授权
 */
class ClaudeAntigravityApiService {
    constructor(config) {
        this.config = config;
        this.accountFingerprint = buildAccountFingerprint(config);
        this.accessToken = null;
        this.projectId = null;
        this._cloudaiProject = null; // [关键] 缓存 cloudaicompanionProject，独立于 GCP project_id，token 刷新不会覆盖
        this._initPromise = null;    // [关键] 初始化锁，防止并发请求重复初始化
        this.tokenExpiry = null;
        this.isInitialized = false;
        this.baseURLs = this.getBaseURLFallbackOrder(config);
        this.baseUrl = this.baseURLs[0] || ANTIGRAVITY_BASE_URL_PROD;
        // 是否复用 gemini-antigravity 凭证 (从 config.reuseGeminiCredentials 读取)
        this.reuseGeminiCredentials = config.reuseGeminiCredentials || false;
        this.sharedCredentialsId = config.sharedCredentialsId || null;
    }

    normalizeBaseURL(rawBaseUrl) {
        if (!rawBaseUrl || typeof rawBaseUrl !== 'string') return '';

        try {
            const url = new URL(rawBaseUrl.trim());
            let pathname = url.pathname || '';

            pathname = pathname.replace(/\/(v1internal)\/models\/[^/?#]+:(generateContent|streamGenerateContent|fetchAvailableModels|loadCodeAssist)$/i, '');
            pathname = pathname.replace(/\/(v1internal)\/models\/[^/?#]+$/i, '');
            pathname = pathname.replace(/\/(v1internal)\/?$/i, '');
            pathname = pathname.replace(/\/(v1internal):(generateContent|streamGenerateContent|fetchAvailableModels|loadCodeAssist)$/i, '');
            pathname = pathname.replace(/\/+$/, '');

            return `${url.origin}${pathname}`;
        } catch {
            return rawBaseUrl.trim()
                .replace(/\/+$/, '')
                .replace(/\/v1internal\/models\/[^/?#]+:(generateContent|streamGenerateContent|fetchAvailableModels|loadCodeAssist)$/i, '')
                .replace(/\/v1internal\/models\/[^/?#]+$/i, '')
                .replace(/\/v1internal$/i, '');
        }
    }

    getBaseURLFallbackOrder(config) {
        const configuredCandidates = [
            config?.ANTIGRAVITY_BASE_URL,
            config?.ANTIGRAVITY_BASE_URL_DAILY,
            config?.ANTIGRAVITY_BASE_URL_AUTOPUSH,
            config?.baseUrl
        ]
            .filter(value => typeof value === 'string' && value.trim())
            .map(value => this.normalizeBaseURL(value));

        const defaults = [
            this.normalizeBaseURL(ANTIGRAVITY_BASE_URL_SANDBOX),
            this.normalizeBaseURL(ANTIGRAVITY_BASE_URL_DAILY),
            this.normalizeBaseURL(ANTIGRAVITY_BASE_URL_PROD)
        ];

        const merged = [...configuredCandidates, ...defaults];
        const unique = [];
        for (const baseURL of merged) {
            if (!baseURL) continue;
            if (!unique.includes(baseURL)) {
                unique.push(baseURL);
            }
        }

        return unique;
    }

    buildRequestUrls(baseURL, model, method = 'streamGenerateContent', query = 'alt=sse') {
        const normalizedBase = String(baseURL || '').replace(/\/$/, '');
        const querySuffix = query ? `?${query}` : '';

        return [
            `${normalizedBase}/${ANTIGRAVITY_API_VERSION}:${method}${querySuffix}`
        ];
    }

    /**
     * 内层: 纯 endpoint fallback (对齐 demo upstream/client.rs)
     * 只处理网络错误和 404 的 endpoint 切换，不处理业务错误重试
     * 返回 response 对象（无论成功还是 4xx/5xx）
     */
    async _callUpstreamWithFallback(accessToken, requestBody, requestModel) {
        let lastError = null;
        const attempts = [];

        // 动态 User-Agent (对齐 demo constants.rs: 启动时拉最新版本)
        const userAgent = await getResolvedUserAgent();

        // 构建 headers (对齐 demo client.rs + claude.rs)
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': userAgent,
        };
        // [关键] Claude 模型必须带 anthropic-beta header (对齐 demo claude.rs line 712-713)
        // 这个 header 让上游识别为 Claude Code 客户端，给予更高配额
        if (requestModel && requestModel.toLowerCase().includes('claude')) {
            headers['anthropic-beta'] = 'claude-code-20250219';
        }

        for (const baseURL of this.baseURLs) {
            const candidateUrls = this.buildRequestUrls(baseURL, requestModel, 'streamGenerateContent', 'alt=sse');

            for (const url of candidateUrls) {
                const hasNextEndpoint = this.baseURLs.indexOf(baseURL) < this.baseURLs.length - 1
                    || candidateUrls.indexOf(url) < candidateUrls.length - 1;

                try {
                    await globalRateLimiter.wait();

                    // [DEBUG] 首次请求时 dump 完整请求信息
                    if (attempts.length === 0) {
                        try {
                            const parsed = JSON.parse(requestBody);
                            // 写完整请求体到文件，方便对比 demo
                            const fs = await import('fs');
                            fs.writeFileSync('/tmp/antigravity-last-request.json', JSON.stringify(parsed, null, 2));
                            console.log(`[ClaudeAntigravity] 🔍 Full request body written to /tmp/antigravity-last-request.json`);
                            console.log(`[ClaudeAntigravity] 🔍 REQUEST DUMP:
  URL: ${url}
  Headers: ${JSON.stringify(headers, null, 2)}
  Body.project: ${parsed.project}
  Body.model: ${parsed.model}
  Body.requestType: ${parsed.requestType}
  Body.userAgent: ${parsed.userAgent}
  Body.requestId: ${parsed.requestId}
  Body.request.contents.length: ${parsed.request?.contents?.length}
  Body.request.generationConfig: ${JSON.stringify(parsed.request?.generationConfig)}
  Body.request.systemInstruction: ${parsed.request?.systemInstruction ? 'present' : 'absent'}
  Body.request.tools: ${parsed.request?.tools ? parsed.request.tools.length + ' tools' : 'none'}
  Body.request.safetySettings: ${parsed.request?.safetySettings?.length || 0} settings`);
                        } catch {}
                    }

                    const response = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: requestBody
                    });

                    const status = response.status;

                    // 成功 → peek 验证
                    if (response.ok) {
                        const peekResult = await this._peekStream(response);
                        if (!peekResult.ok) {
                            attempts.push(`[PEEK_FAIL] ${url} -> ${peekResult.reason}`);
                            console.warn(`[ClaudeAntigravity] 👁️ Peek failed on ${url}: ${peekResult.reason}`);
                            if (hasNextEndpoint) continue;
                            throw new Error(`Antigravity API error: ${peekResult.reason}`);
                        }
                        if (attempts.length > 0) {
                            console.log(`[ClaudeAntigravity] ✅ Upstream succeeded on ${url} (after ${attempts.length} endpoint fallbacks)`);
                        }
                        return { response: peekResult.wrappedResponse, url, attempts };
                    }

                    // 网络层/配额层可切换的错误 → 换 endpoint
                    // [关键] 429 也要切换！不同 endpoint (sandbox/daily/prod) 配额可能独立
                    // 对齐 demo client.rs should_try_next_endpoint: 429/408/404/5xx
                    if (hasNextEndpoint && (status === 429 || status === 408 || status === 404 || status >= 500)) {
                        const errBody = await response.text().catch(() => '');
                        attempts.push(`[${status}] ${url}`);
                        console.warn(`[ClaudeAntigravity] 🔄 ${status} on ${url}, trying next endpoint... body=${errBody.slice(0, 500)}`);
                        continue;
                    }

                    // 没有下一个 endpoint 了，或者是 401/403 等不可切换的错误 → 返回给外层处理
                    const errorText = await response.text();
                    const retryAfterHeader = response.headers.get('retry-after');
                    return {
                        response: null,
                        status,
                        errorText,
                        retryAfterHeader,
                        url,
                        attempts
                    };
                } catch (error) {
                    const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']
                        .some(code => (error?.code === code) || String(error?.cause?.code || '').includes(code) || String(error?.message || '').includes(code));

                    if (isNetworkError && hasNextEndpoint) {
                        attempts.push(`[NETWORK] ${url} -> ${error?.code || error?.cause?.code || 'unknown'}`);
                        console.warn(`[ClaudeAntigravity] 🌐 Network error on ${url}, trying next endpoint...`);
                        lastError = error;
                        continue;
                    }

                    throw error;
                }
            }
        }

        throw lastError || new Error('Antigravity API error: no reachable upstream endpoint');
    }

    /**
     * 外层: 业务重试循环 (对齐 demo handlers/claude.rs + common.rs)
     *
     * [关键对齐] demo 的注释: "[REMOVED] 不再特殊处理 QUOTA_EXHAUSTED，允许账号轮换"
     * 意思是: 429 不管什么原因，都统一走 determine_retry_strategy → sleep → continue
     * demo 有多账号可以轮换，我们单账号但也要给重试机会（配额可能是临时的 TPM 限制）
     *
     * demo 的 max_attempts = min(MAX_RETRY_ATTEMPTS, pool_size + 1).max(2)
     * 我们单账号: max_attempts = 3 (给足重试空间，对齐 demo 的 MAX_RETRY_ATTEMPTS=3)
     *
     * 429 → 解析 retry-after → sleep → 重试 (不区分 QuotaExhausted/RateLimitExceeded)
     * 5xx → 线性退避 → 重试
     * 401/403 → 刷新 token → 重试
     * 400 (thinking) → strip thinking → 重试
     */
    async postSSEWithFallback(accessToken, antigravityRequest, originalModel) {
        const MAX_ATTEMPTS = 3; // 对齐 demo MAX_RETRY_ATTEMPTS=3
        const requestModel = antigravityRequest?.model || originalModel || 'claude-sonnet-4-5';
        let requestBody = JSON.stringify(antigravityRequest);
        const accountId = this.config?.uuid || this.config?.oauthCredentialId || 'default';
        let currentAccessToken = accessToken;
        let retriedWithoutThinking = false;
        let tokenRefreshed = false;
        let lastStatus = 0;
        let lastError = '';
        const allAttempts = [];

        // [DEBUG] 打印请求中的 project 字段，确认不是 undefined
        console.log(`[ClaudeAntigravity] 📤 Request project=${antigravityRequest?.project || 'MISSING!'}, model=${requestModel}, cloudaiProject=${this._cloudaiProject || 'none'}`);

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            // 调用内层 endpoint fallback
            const result = await this._callUpstreamWithFallback(currentAccessToken, requestBody, requestModel);
            allAttempts.push(...(result.attempts || []));

            // 成功
            if (result.response) {
                globalRateLimitTracker.markSuccess(accountId);
                return result.response;
            }

            // 业务错误
            const { status, errorText, retryAfterHeader, url } = result;
            allAttempts.push(`[${status}] ${url} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
            lastStatus = status;
            lastError = errorText;

            // ===== 429 处理 (对齐 demo common.rs determine_retry_strategy) =====
            // 429 处理: 区分 QUOTA_EXHAUSTED（长时间冷却）和 TPM/RPM（短暂重试）
            if (status === 429) {
                globalRateLimitTracker.recordRateLimit(
                    accountId, status, errorText, retryAfterHeader, requestModel
                );

                const reason = parseRateLimitReason(errorText);
                const quotaInfo = parseQuotaResetInfo(errorText);

                // QUOTA_EXHAUSTED 且重置时间 > 60s → 配额冷却，标记账号切号，不做无意义重试
                if (reason === RateLimitReason.QUOTA_EXHAUSTED && quotaInfo && quotaInfo.resetDelayMs > 60000) {
                    console.warn(`[ClaudeAntigravity] 🧊 QUOTA_EXHAUSTED for ${requestModel}, reset in ${quotaInfo.resetFormatted} — switch credential`);
                    const err = new Error(
                        `模型 ${requestModel} 配额已耗尽，将在 ${quotaInfo.resetFormatted} 后恢复，正在切换账号...`
                    );
                    err.statusCode = 429;
                    err.isQuotaCooldown = true;
                    err.quotaResetTime = quotaInfo.resetTimestamp;
                    err.quotaResetDelayMs = quotaInfo.resetDelayMs;
                    err.quotaResetFormatted = quotaInfo.resetFormatted;
                    err.model = requestModel;
                    // 切号标志：跳过累计错误计数，直接切号
                    err.shouldSwitchCredential = true;
                    err.skipErrorCount = true;
                    if (allAttempts.length > 0) {
                        err.message += `\nAttempted:\n- ${allAttempts.join('\n- ')}`;
                    }
                    throw err;
                }

                // TPM/RPM 或短时间配额 → 正常重试
                const delayMs = parseRetryDelay(errorText, retryAfterHeader);
                let waitTime;
                if (delayMs) {
                    waitTime = Math.min(delayMs + 200, 30000);
                } else {
                    waitTime = 5000 * (attempt + 1);
                }

                console.warn(`[ClaudeAntigravity] ⏱️ 429 (${reason}), attempt ${attempt + 1}/${MAX_ATTEMPTS}, waiting ${waitTime}ms before retry...`);
                await sleep(waitTime);
                continue;
            }

            // ===== 5xx 处理 =====
            if (status >= 500) {
                globalRateLimitTracker.recordRateLimit(accountId, status, errorText, retryAfterHeader, requestModel);
                // 线性退避: 5s * (attempt + 1)
                const waitTime = 5000 * (attempt + 1);
                console.warn(`[ClaudeAntigravity] ⏱️ ${status}, waiting ${waitTime}ms before retry...`);
                await sleep(waitTime);
                continue;
            }

            // ===== 401/403 → 刷新 token =====
            if ((status === 401 || status === 403) && !tokenRefreshed) {
                tokenRefreshed = true;
                try {
                    console.log(`[ClaudeAntigravity] 🔑 ${status}, refreshing token...`);
                    currentAccessToken = await this._getValidAccessToken(true);
                    await sleep(200);
                    continue;
                } catch (refreshErr) {
                    console.error(`[ClaudeAntigravity] Token refresh failed:`, refreshErr.message);
                    break;
                }
            }

            // ===== 400 thinking signature → strip thinking =====
            if (status === 400 && !retriedWithoutThinking
                && errorText && (errorText.includes('Invalid `signature`') || errorText.includes('thinking.signature'))) {
                retriedWithoutThinking = true;
                const parsed = JSON.parse(requestBody);
                stripThinkingFromRequest(parsed);
                requestBody = JSON.stringify(parsed);
                console.warn(`[ClaudeAntigravity] 🧠 400 thinking error, stripped thinking and retrying...`);
                await sleep(200);
                continue;
            }

            // ===== 400 prompt too long → friendly error =====
            if (status === 400 && errorText &&
                (errorText.includes('too long') || errorText.includes('exceeds'))) {
                console.error(`[ClaudeAntigravity] ❌ Prompt too long after compression. Consider reducing conversation history.`);
                const err = new Error(
                    'Prompt is too long even after context compression. ' +
                    'Please start a new conversation or reduce the context window.'
                );
                err.statusCode = 400;
                throw err;
            }

            // 其他错误 → 不重试
            break;
        }

        // 所有 attempt 用完或 break 出来
        const error = new Error(`Antigravity API error: ${lastStatus} - ${lastError}`);
        error.statusCode = lastStatus;
        if (allAttempts.length > 0) {
            error.message += `\nAttempted:\n- ${allAttempts.join('\n- ')}`;
        }
        throw error;
    }

    /**
     * 流式 Peek 验证 (参考 demo claude.rs lines 794-832)
     * 预读流的前几个 chunk，跳过心跳，检测空响应
     * 返回 { ok, reason, wrappedResponse }
     * wrappedResponse 是一个包装后的 Response，body 包含 peeked data + 剩余流
     */
    async _peekStream(response) {
        const PEEK_TIMEOUT_MS = 60000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const peekedChunks = [];
        let foundMeaningfulData = false;

        try {
            const peekStart = Date.now();

            while (!foundMeaningfulData) {
                if (Date.now() - peekStart > PEEK_TIMEOUT_MS) {
                    reader.releaseLock();
                    return { ok: false, reason: 'stream peek timeout (60s)' };
                }

                const readPromise = reader.read();
                const timeoutPromise = sleep(PEEK_TIMEOUT_MS - (Date.now() - peekStart)).then(() => ({ done: false, value: null, timeout: true }));
                const result = await Promise.race([readPromise, timeoutPromise]);

                if (result.timeout) {
                    reader.releaseLock();
                    return { ok: false, reason: 'stream peek timeout (60s)' };
                }

                const { done, value } = result;
                if (done) {
                    if (!foundMeaningfulData) {
                        return { ok: false, reason: 'empty stream response' };
                    }
                    break;
                }

                peekedChunks.push(value);
                const text = decoder.decode(value, { stream: true });
                const lines = text.split('\n');

                for (const line of lines) {
                    const trimmed = line.trim();
                    // 跳过空行和 SSE 心跳
                    if (!trimmed || trimmed.startsWith(':')) continue;
                    if (trimmed.startsWith('data: ')) {
                        foundMeaningfulData = true;
                        break;
                    }
                }
            }

            // Peek 成功：构造包装流 = peeked chunks + 剩余原始流
            const peekedStream = new ReadableStream({
                start(controller) {
                    for (const chunk of peekedChunks) {
                        controller.enqueue(chunk);
                    }
                },
                async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                    } else {
                        controller.enqueue(value);
                    }
                },
                cancel() {
                    reader.releaseLock();
                }
            });

            const wrappedResponse = new Response(peekedStream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });

            return { ok: true, wrappedResponse };
        } catch (err) {
            try { reader.releaseLock(); } catch {}
            return { ok: false, reason: `peek error: ${err.message}` };
        }
    }

    async initialize() {
        if (this.isInitialized) return;
        // [关键] 初始化锁：防止并发请求同时触发 initialize，导致竞态条件
        // 第一个请求创建 promise，后续请求等待同一个 promise
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInitialize();
        try {
            await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    async _doInitialize() {
        await this.initializeAuth();

        // 预加载 DB 模型映射缓存
        getDbModelMapping().catch(() => {});

        // [关键] 通过 loadCodeAssist API 获取正确的 cloudaicompanionProject
        if (this.accessToken) {
            const companionProject = await fetchCloudAICompanionProject(this.accessToken);
            const normalizedProject = normalizeProjectId(companionProject);
            if (normalizedProject) {
                console.log(`[ClaudeAntigravity] 🔑 Using cloudaicompanionProject: ${normalizedProject}`);
                this._cloudaiProject = normalizedProject;
                this.projectId = normalizedProject;
            } else {
                console.warn('[ClaudeAntigravity] ⚠️ cloudaicompanionProject unavailable at init');
            }
        }

        this.isInitialized = true;
    }

    /**
     * 获取有效的 projectId（对齐 quotio：拿不到则返回 null，不使用 mock）
     */
    _getEffectiveProjectId() {
        return normalizeProjectId(this._cloudaiProject);
    }

    async _ensureCloudAIProjectId() {
        const cachedProjectId = this._getEffectiveProjectId();
        if (cachedProjectId) return cachedProjectId;

        if (!this.accessToken) {
            this.accessToken = await this._getValidAccessToken();
        }

        let resolved = normalizeProjectId(await fetchCloudAICompanionProject(this.accessToken));

        // token 可能过期，刷新后重试一次
        if (!resolved) {
            try {
                this.accessToken = await this._getValidAccessToken(true);
                resolved = normalizeProjectId(await fetchCloudAICompanionProject(this.accessToken));
            } catch (_error) {
            }
        }

        if (resolved) {
            this._cloudaiProject = resolved;
            this.projectId = resolved;
            return resolved;
        }

        return null;
    }

    async initializeAuth(forceRefresh = false) {
        const { loadCredentialsFromConfig, loadCredentialsById, updateCredentialsById } = await import('../../services/oauth-credentials-store.js');
        const { OAuth2Client } = await import('google-auth-library');

        // 方案1: 复用 gemini-antigravity 凭证
        if (this.reuseGeminiCredentials && this.sharedCredentialsId) {
            const sharedCredentials = await loadCredentialsById(this.sharedCredentialsId);
            if (sharedCredentials?.access_token) {
                console.log(`[ClaudeAntigravity] Reusing credentials from gemini-antigravity (id: ${this.sharedCredentialsId})`);
                this.accessToken = sharedCredentials.access_token;
                // [关键] 只在没有 _cloudaiProject 缓存时才用 GCP project_id
                // token 刷新时不能覆盖已获取的 cloudaicompanionProject
                if (!this._cloudaiProject) {
                    this.projectId = sharedCredentials.project_id || this.config.projectId;
                }
                this.tokenExpiry = sharedCredentials.expiry_date;
                return;
            }
            console.warn(`[ClaudeAntigravity] Shared credentials not found, falling back to own credentials`);
        }

        // 方案2: 使用自己的凭证
        const { credentialId, credentials } = await loadCredentialsFromConfig(
            this.config,
            'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
            'ClaudeAntigravity'
        );
        this.oauthCredentialId = credentialId;
        const creds = credentials;

        if (creds?.access_token && !forceRefresh) {
            // [FIX] 检查 token 是否过期，过期则走刷新逻辑
            const isExpired = creds.expiry_date && Date.now() > creds.expiry_date - 5 * 60 * 1000;
            if (!isExpired) {
                this.accessToken = creds.access_token;
                if (!this._cloudaiProject) {
                    this.projectId = creds.project_id || this.config.projectId;
                }
                this.tokenExpiry = creds.expiry_date;
                return;
            }
            console.log('[ClaudeAntigravity] Token expired, refreshing...');
        }

        // forceRefresh 或 token 缺失：尝试用 refresh_token 刷新
        if (creds?.refresh_token) {
            console.log('[ClaudeAntigravity] Refreshing token via OAuth2Client...');
            const OAUTH_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_ID || '';
            const OAUTH_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_SECRET || '';
            const authClient = new OAuth2Client({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET });
            authClient.setCredentials(creds);
            const { credentials: newCreds } = await authClient.refreshAccessToken();
            // 回写到数据库
            await updateCredentialsById(credentialId, newCreds);
            this.accessToken = newCreds.access_token;
            if (!this._cloudaiProject) {
                this.projectId = newCreds.project_id || creds.project_id || this.config.projectId;
            }
            this.tokenExpiry = newCreds.expiry_date;
            console.log('[ClaudeAntigravity] Token refreshed and saved successfully.');
            return;
        }

        throw new Error('[ClaudeAntigravity] 未找到有效凭证且无 refresh_token，请通过前端 UI 重新进行 OAuth 授权');
    }

    isExpiryDateNear() {
        if (!this.tokenExpiry) return true;
        const now = Date.now();
        const skew = 3000 * 1000; // 50分钟
        return (this.tokenExpiry - now) < skew;
    }

    /**
     * 非流式生成内容
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // Warmup 拦截：不调用上游，直接返回合成响应
        if (isWarmupRequest(requestBody.messages)) {
            console.log('[ClaudeAntigravity] 🔥 Warmup request intercepted, returning synthetic response');
            return {
                id: 'msg_' + uuidv4(),
                type: 'message',
                role: 'assistant',
                model,
                content: [{ type: 'text', text: 'Warmup complete.' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 3 }
            };
        }

        // Context compression — prevent 400 "prompt is too long"
        const compressionResult = applyContextCompression(requestBody);
        if (compressionResult.layersApplied.length > 0) {
            console.log(`[ContextManager] Compressed: [${compressionResult.layersApplied}] ${compressionResult.tokensBefore} → ${compressionResult.tokensAfter}`);
        }

        const accessToken = await this._getValidAccessToken();
        const projectId = await this._ensureCloudAIProjectId();
        if (!projectId) {
            const err = new Error('无法解析 cloudaicompanionProject，账号不可用，正在切换账号...');
            err.statusCode = 400;
            err.shouldSwitchCredential = true;
            err.skipErrorCount = true;
            err.isProjectUnavailable = true;
            throw err;
        }

        let antigravityRequest = transformClaudeRequestIn(requestBody, projectId, this.accountFingerprint);

        // 背景任务检测 → 自动降级到 Flash，省额度防 429
        const { isBackground, taskType } = detectBackgroundTask(requestBody.messages);
        if (isBackground) {
            antigravityRequest = downgradeForBackgroundTask(antigravityRequest, taskType);
        }

        const response = await this.postSSEWithFallback(accessToken, antigravityRequest, model);

        const text = await response.text();
        const geminiResponse = this._collectSSEToResponse(text);
        return transformGeminiResponseOut(geminiResponse, model);
    }

    /**
     * 流式生成内容
     * 集成: warmup 拦截 + 背景任务降级 + 流式 peek (跳过心跳、检测空响应、60s 超时)
     */
    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // Warmup 拦截：不调用上游，直接返回合成 SSE
        if (isWarmupRequest(requestBody.messages)) {
            console.log('[ClaudeAntigravity] 🔥 Warmup request intercepted (stream), returning synthetic SSE');
            yield generateWarmupSSEResponse(model);
            return;
        }

        // Context compression — prevent 400 "prompt is too long"
        const compressionResult = applyContextCompression(requestBody);
        if (compressionResult.layersApplied.length > 0) {
            console.log(`[ContextManager] Compressed: [${compressionResult.layersApplied}] ${compressionResult.tokensBefore} → ${compressionResult.tokensAfter}`);
        }

        const accessToken = await this._getValidAccessToken();
        const projectId = await this._ensureCloudAIProjectId();
        if (!projectId) {
            const err = new Error('无法解析 cloudaicompanionProject，账号不可用，正在切换账号...');
            err.statusCode = 400;
            err.shouldSwitchCredential = true;
            err.skipErrorCount = true;
            err.isProjectUnavailable = true;
            throw err;
        }

        let antigravityRequest = transformClaudeRequestIn(requestBody, projectId, this.accountFingerprint);

        // 背景任务检测 → 自动降级到 Flash，省额度防 429
        const { isBackground, taskType } = detectBackgroundTask(requestBody.messages);
        if (isBackground) {
            antigravityRequest = downgradeForBackgroundTask(antigravityRequest, taskType);
        }

        const response = await this.postSSEWithFallback(accessToken, antigravityRequest, model);

        // postSSEWithFallback 内部已做 peek 验证，这里直接读流
        const state = new StreamingState(model);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // 增量写调试文件，避免内存累积
        let _debugFd = null;
        try {
            const fs = await import('fs');
            _debugFd = fs.openSync('/tmp/antigravity-last-sse.txt', 'w');
        } catch {}

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':')) continue;

                    const claudeEvents = transformGeminiSSELine(trimmed, state);
                    if (claudeEvents) {
                        if (_debugFd !== null) try { const fs = await import('fs'); fs.writeSync(_debugFd, claudeEvents); } catch {}
                        // handleStreamRequest 期望 yield JSON 对象（不是 SSE 字符串）
                        // 把 SSE 字符串拆成独立事件对象逐个 yield
                        const eventObjects = parseSSEStringToObjects(claudeEvents);
                        for (const obj of eventObjects) {
                            yield obj;
                        }
                    }
                }
            }

            // 处理剩余 buffer
            if (buffer.trim()) {
                const trimmed = buffer.trim();
                if (!trimmed.startsWith(':')) {
                    const claudeEvents = transformGeminiSSELine(trimmed, state);
                    if (claudeEvents) {
                        if (_debugFd !== null) try { const fs = await import('fs'); fs.writeSync(_debugFd, claudeEvents); } catch {}
                        const eventObjects = parseSSEStringToObjects(claudeEvents);
                        for (const obj of eventObjects) {
                            yield obj;
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
            if (_debugFd !== null) try { const fs = await import('fs'); fs.closeSync(_debugFd); } catch {}
        }
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        const { getProviderModels } = await import('../provider-models.js');
        const models = getProviderModels('claude-antigravity');
        return {
            data: models.map(id => ({
                id,
                object: 'model',
                created: Date.now(),
                owned_by: 'anthropic'
            }))
        };
    }

    /**
     * 收集 SSE 响应为单个响应对象
     */
    _collectSSEToResponse(sseText) {
        const lines = sseText.split('\n');
        let lastResponse = null;

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;

            try {
                const data = JSON.parse(jsonStr);
                const response = data.response || data;
                if (response.candidates) {
                    lastResponse = response;
                }
            } catch (e) {
                // 忽略解析错误
            }
        }

        return lastResponse || { candidates: [] };
    }

    // ==================== 额度查询 ====================

    /**
     * 获取有效的 access_token（自动刷新）
     * 用 OAuth2Client + refresh_token 确保 token 有效
     */
    async _getValidAccessToken(forceRefresh = false) {
        const { OAuth2Client } = await import('google-auth-library');
        const oauthCredentialsDao = (await import('../../dao/oauth-credentials-dao.js'));
        const { extractCredentialId } = await import('../../utils/oauth-credentials.js');

        // 获取凭证 ID
        const credentialId = this.config.oauthCredentialId
            || this.config.oauth_credential_id
            || extractCredentialId(this.config, 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH');

        if (!credentialId) {
            throw new Error('[ClaudeAntigravity] No credential ID found for usage query');
        }

        const record = await oauthCredentialsDao.findById(credentialId);
        if (!record?.credentials) {
            throw new Error(`[ClaudeAntigravity] Credential ${credentialId} not found`);
        }

        const creds = record.credentials;
        const OAUTH_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_ID || '';
        const OAUTH_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_SECRET || '';

        const authClient = new OAuth2Client({ clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET });
        authClient.setCredentials(creds);

        // 检查是否需要刷新
        const expiryDate = creds.expiry_date || 0;
        const needsRefresh = forceRefresh || Date.now() > expiryDate - 5 * 60 * 1000;

        if (needsRefresh && creds.refresh_token) {
            console.log(`[ClaudeAntigravity] Token ${forceRefresh ? 'force-' : ''}refreshing via OAuth2Client...`);
            try {
                const { credentials: newCreds } = await authClient.refreshAccessToken();
                authClient.setCredentials(newCreds);
                await oauthCredentialsDao.updateCredentials(credentialId, newCreds);
                return newCreds.access_token;
            } catch (refreshErr) {
                // 检测 invalid_grant (需要用户重新授权)
                if (String(refreshErr?.message || '').includes('invalid_grant')) {
                    throw new Error('[ClaudeAntigravity] OAuth refresh_token 已失效 (invalid_grant)，请通过前端 UI 重新进行 OAuth 授权');
                }
                throw refreshErr;
            }
        }

        return creds.access_token;
    }

    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();

        try {
            const accessToken = await this._getValidAccessToken();
            return await this._getModelsWithQuotas(accessToken);
        } catch (error) {
            console.error('[ClaudeAntigravity] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    async _fetchSubscriptionTier(accessToken) {
        const userAgent = await getResolvedUserAgent();
        const baseURLs = this.baseURLs?.length ? this.baseURLs : [ANTIGRAVITY_BASE_URL_SANDBOX, ANTIGRAVITY_BASE_URL_DAILY, ANTIGRAVITY_BASE_URL_PROD];
        for (const baseURL of baseURLs) {
            try {
                const url = `${baseURL}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
                        'User-Agent': userAgent
                    },
                    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
                });
                if (!res.ok) continue;
                const data = await res.json();
                if (data) {
                    const tier = data.paidTier || data.currentTier;
                    if (tier && tier.id) {
                        const tierId = tier.id.toLowerCase();
                        if (tierId.includes('ultra')) return 'ULTRA';
                        if (tierId.includes('pro')) return 'PRO';
                    }
                }
                return 'FREE';
            } catch (error) {
                console.error(`[ClaudeAntigravity] fetchSubscriptionTier failed (${baseURL}):`, error.message);
            }
        }
        return 'FREE';
    }

    async _getModelsWithQuotas(accessToken) {
        const userAgent = await getResolvedUserAgent();
        const subscriptionTier = await this._fetchSubscriptionTier(accessToken);
        const result = { lastUpdated: Date.now(), subscriptionTier, models: {} };

        const baseURLs = this.baseURLs?.length ? this.baseURLs : [ANTIGRAVITY_BASE_URL_SANDBOX, ANTIGRAVITY_BASE_URL_DAILY, ANTIGRAVITY_BASE_URL_PROD];
        for (const baseURL of baseURLs) {
            try {
                const url = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                const projectId = this._getEffectiveProjectId();
                const payload = projectId ? { project: projectId } : {};
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`,
                        'User-Agent': userAgent
                    },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) continue;
                const data = await res.json();
                if (data && data.models) {
                    for (const [modelId, modelData] of Object.entries(data.models)) {
                        // 只保留 Claude 模型
                        if (!modelId.toLowerCase().includes('claude')) continue;

                        const displayName = modelId.replace(/^gemini-/, '');
                        const modelInfo = {
                            name: modelId,
                            displayName,
                            remaining: 0,
                            percentage: 0,
                            usedPercentage: 100,
                            resetTime: null,
                            resetTimeFormatted: null
                        };
                        if (modelData.quotaInfo) {
                            const fraction = Math.min(1, Math.max(0, modelData.quotaInfo.remainingFraction || 0));
                            modelInfo.remaining = fraction;
                            modelInfo.percentage = Math.round(fraction * 100 * 100) / 100;
                            modelInfo.usedPercentage = Math.round((1 - fraction) * 100 * 100) / 100;
                            const resetTimeRaw = modelData.quotaInfo.resetTime || null;
                            modelInfo.resetTime = resetTimeRaw;
                            if (resetTimeRaw) {
                                modelInfo.resetTimeFormatted = this._formatResetTime(resetTimeRaw);
                            }
                        }
                        result.models[modelId] = modelInfo;
                    }
                    const sortedModels = {};
                    Object.keys(result.models).sort().forEach(key => {
                        sortedModels[key] = result.models[key];
                    });
                    result.models = sortedModels;
                    console.log(`[ClaudeAntigravity] Fetched quotas for ${Object.keys(result.models).length} Claude models (tier: ${subscriptionTier})`);
                    break;
                }
            } catch (error) {
                console.error(`[ClaudeAntigravity] fetchAvailableModels failed (${baseURL}):`, error.message);
            }
        }
        return result;
    }

    _formatResetTime(resetTimeISO) {
        if (!resetTimeISO) return null;
        try {
            const diffMs = new Date(resetTimeISO).getTime() - Date.now();
            if (diffMs <= 0) return 'now';
            const totalMinutes = Math.floor(diffMs / 60000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            const days = Math.floor(hours / 24);
            const remainingHours = hours % 24;
            if (days > 0) return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
            if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
            return `${Math.max(1, minutes)}m`;
        } catch (e) {
            return null;
        }
    }
}

export {
    ClaudeAntigravityApiService,
    transformClaudeRequestIn,
    transformGeminiResponseOut,
    StreamingState,
    transformGeminiSSELine,
    toClaudeUsage,
    mapClaudeModelToGemini,
    ANTIGRAVITY_BASE_URL_DAILY,
    ANTIGRAVITY_BASE_URL_PROD,
    ANTIGRAVITY_API_VERSION,
    DEFAULT_USER_AGENT,
    httpAgent,
    httpsAgent,
    // 重试 & 限流工具
    RateLimiter,
    RateLimitTracker,
    RateLimitReason,
    globalRateLimitTracker,
    parseDurationMs,
    parseRetryDelay,
    parseQuotaResetInfo,
    parseRateLimitReason,
    determineRetryStrategy,
    calculateRetryDelay,
    shouldRotateAccount,
    isWarmupRequest,
    // 背景任务 & thinking 清理
    detectBackgroundTask,
    downgradeForBackgroundTask,
    stripThinkingBlocksFromMessages,
    stripThinkingFromRequest,
    // Project ID
    fetchCloudAICompanionProject,
};
