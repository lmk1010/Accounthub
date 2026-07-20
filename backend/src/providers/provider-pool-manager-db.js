/**
 * ProviderPoolManager - 数据库版本
 * 使用 MySQL 存储账号池数据，替代 JSON 文件存储
 */

import * as providerDao from '../dao/provider-dao.js';
import * as statsDao from '../dao/stats-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as providerPoolDao from '../dao/provider-pool-dao.js';
import * as poolConfigDao from '../dao/pool-config-dao.js';
import * as channelConfigDao from '../dao/channel-config-dao.js';
import * as badAccountsDao from '../dao/bad-accounts-dao.js';
import * as providerErrorLogsDao from '../dao/provider-error-logs-dao.js';
import * as providerStatusLogsDao from '../dao/provider-status-logs-dao.js';
import * as requestLogsDao from '../dao/request-logs-dao.js';
import { pushLog as pushRequestLog, isRedisAvailable as isLogQueueAvailable, startWorker as startLogQueueWorker } from '../services/request-log-queue.js';
import proxyPoolManager from '../services/proxy-pool-manager.js';
import { generateUUID } from '../utils/provider-utils.js';
import { resolveProviderStatus } from '../utils/provider-status.js';
import { poolPerformanceLogger } from './pool-performance-logger.js';
import { resolveModel as resolveWindsurfModel } from './windsurf/windsurf-models.js';
import { logEvent } from '../ui-modules/event-broadcast.js';
import { initRedis, isRedisAvailable, incrAndMod, getRedisClient } from '../services/redis-client.js';
import { concurrencyLimiter } from '../services/concurrency-limiter.js';
import { createHash } from 'crypto';
import { ownsUuid, shardOfUuid, SHARD_ENABLED, SHARD_ID, SHARD_COUNT } from '../utils/shard.js';
import { getOfficialChannelDefaults, clearOfficialChannelConfigCache } from '../services/official-channel-config-cache.js';
import { getCodexChannelDefaults } from '../services/codex-channel-config-cache.js';
import { getXaiChannelDefaults } from '../services/xai-channel-config-cache.js';
import {
    XAI_IMAGE_MODELS,
    XAI_VIDEO_MODELS,
    extractXaiVideoId
} from './openai/xai-media.js';

const XAI_IMAGE_MODEL_SET = new Set(XAI_IMAGE_MODELS);
const XAI_VIDEO_MODEL_SET = new Set(XAI_VIDEO_MODELS);

function xaiModelBase(model) {
    const normalized = String(model || '').trim();
    const separator = normalized.lastIndexOf('/');
    return (separator >= 0 ? normalized.slice(separator + 1) : normalized).toLowerCase();
}

function normalizeStatusCode(statusCode, errorMessage) {
    if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
        return statusCode;
    }

    if (typeof statusCode === 'string') {
        const parsed = parseInt(statusCode, 10);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }

    if (typeof errorMessage === 'string') {
        const match = errorMessage.match(/\b(4\d{2}|5\d{2})\b/);
        if (match) {
            return parseInt(match[1], 10);
        }
    }

    return null;
}

const RELAY_STATES = {
    HEALTHY: 'healthy',
    COOLDOWN: 'cooldown',
    OVERLOADED: 'overloaded',
    AUTH_INVALID: 'auth_invalid',
    BLOCKED: 'blocked',
    UNHEALTHY: 'unhealthy',
    DISABLED: 'disabled',
    DELETED: 'deleted'
};

const GLOBAL_SELECTION_PROVIDER_TYPES = new Set(['openai-codex', 'claude-windsurf']);

function inferRelayState(provider, errorMessage = null, statusCode = null) {
    if (provider?.is_deleted) return RELAY_STATES.DELETED;
    if (provider?.is_disabled) return RELAY_STATES.DISABLED;

    const parsedStatus = normalizeStatusCode(statusCode, errorMessage);
    const message = String(errorMessage || '').toLowerCase();

    if (parsedStatus === 401 || /\b401\b/.test(message) || /unauthorized|invalid token|token expired/.test(message)) {
        return RELAY_STATES.AUTH_INVALID;
    }
    if (parsedStatus === 529 || /\b529\b/.test(message) || /overload|overloaded/.test(message)) {
        return RELAY_STATES.OVERLOADED;
    }
    if (parsedStatus === 403 || /\b403\b/.test(message) || /forbidden|suspended|blocked|organization disabled/.test(message)) {
        return RELAY_STATES.BLOCKED;
    }
    if (parsedStatus === 429 || /\b429\b/.test(message) || /rate.?limit|quota/.test(message)) {
        return RELAY_STATES.COOLDOWN;
    }
    if (parsedStatus !== null && parsedStatus >= 500) {
        return RELAY_STATES.OVERLOADED;
    }
    return RELAY_STATES.UNHEALTHY;
}

function formatHealthCheckErrorMessage(error) {
    const baseMessage = String(error?.message || 'Unknown error').trim();
    const payload = error?.response?.data;

    let detailMessage = '';
    if (typeof payload === 'string' && payload.trim()) {
        detailMessage = payload.trim();
    } else if (payload && typeof payload === 'object') {
        if (typeof payload.error === 'string' && payload.error.trim()) {
            detailMessage = payload.error.trim();
        } else if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
            detailMessage = payload.error.message.trim();
        } else if (typeof payload.message === 'string' && payload.message.trim()) {
            detailMessage = payload.message.trim();
        } else if (typeof payload.detail === 'string' && payload.detail.trim()) {
            detailMessage = payload.detail.trim();
        } else {
            try {
                detailMessage = JSON.stringify(payload);
            } catch (_error) {
                detailMessage = '';
            }
        }
    }

    if (!detailMessage || detailMessage === baseMessage) {
        return baseMessage;
    }

    const compactDetail = detailMessage.length > 360
        ? `${detailMessage.slice(0, 360)}...`
        : detailMessage;
    return `${baseMessage} | ${compactDetail}`;
}

/**
 * 提供商池管理器（数据库版本）
 */
export class ProviderPoolManagerDB {
    constructor(options = {}) {
        // 全局配置
        this.globalConfig = options.globalConfig || {};
        this.maxErrorCount = options.maxErrorCount || 3;
        this.providerFallbackChain = options.providerFallbackChain || {};
        this.modelFallbackMapping = options.modelFallbackMapping || {};

        // 内存缓存已禁用，统一走数据库
        this.providerPools = null;
        this.providerStatus = null;
        this.poolMap = null;
        this.defaultPoolByType = null;

        // 轮询计数器
        this._roundRobinCounters = {};
        this._stickySessionBindings = new Map();
        this._stickySessionMaxEntries = this._parsePositiveInteger(
            options.stickySessionMaxEntries ?? this.globalConfig.STICKY_SESSION_MAX_ENTRIES,
            20000
        );
        this._stickySessionCleanupIntervalMs = this._parsePositiveInteger(
            options.stickySessionCleanupIntervalMs ?? this.globalConfig.STICKY_SESSION_CLEANUP_INTERVAL_MS,
            60000
        );
        this._lastStickySessionCleanupAt = 0;
        this._channelRoutingCache = null;

        // Model-Level Quota Protection: Map<"uuid:model", { recoverAt: number }>
        this._modelQuotaProtection = new Map();

        // 全局统计
        this._globalStats = {
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            switchCount: 0,
            lastResetTime: Date.now()
        };

        // 刷新/预热配置
        this.refreshMaxCount = Number.isFinite(options.refreshMaxCount)
            ? options.refreshMaxCount
            : (this.globalConfig.PROVIDER_REFRESH_MAX_COUNT ?? 3);
        const refreshNearMinutes = Number.isFinite(options.refreshNearMinutes)
            ? options.refreshNearMinutes
            : (this.globalConfig.PROVIDER_REFRESH_NEAR_MINUTES ?? 10);
        this.refreshNearMs = Math.max(1, refreshNearMinutes) * 60 * 1000;
        this.warmupTarget = Number.isFinite(options.warmupTarget)
            ? options.warmupTarget
            : (this.globalConfig.PROVIDER_WARMUP_TARGET ?? 0);
        this.refreshingUuids = new Set();

        // 初始化标志
        this._initialized = false;

        this._cache = null;
        this._performanceLogger = poolPerformanceLogger;
    }

    _getProviderStatus(provider) {
        return resolveProviderStatus(provider);
    }

    _getProviderCredentials(provider) {
        if (!provider || typeof provider !== 'object') return {};
        if (provider.credentials && typeof provider.credentials === 'object') {
            return provider.credentials;
        }
        return {};
    }

    _buildRelayStatePatch(provider, state, context = {}) {
        const currentCredentials = this._getProviderCredentials(provider);
        const currentErrorCount = Number(currentCredentials.relayConsecutiveErrors) || 0;
        const nextErrorCount = state === RELAY_STATES.HEALTHY
            ? 0
            : Math.max(1, currentErrorCount + 1);
        const recoverAt = context.recoverAt
            ? new Date(context.recoverAt)
            : null;
        const recoverAtIso = recoverAt && Number.isFinite(recoverAt.getTime())
            ? recoverAt.toISOString()
            : null;

        const nextCredentials = {
            ...currentCredentials,
            relayState: state,
            relayStateReason: context.reason || null,
            relayStateSource: context.source || 'system',
            relayStateUpdatedAt: new Date().toISOString(),
            relayStateRecoverAt: recoverAtIso,
            relayStateStatusCode: context.statusCode ?? null,
            relayStateMetadata: context.metadata || null,
            relayConsecutiveErrors: nextErrorCount
        };

        return {
            credentials: nextCredentials,
            scheduled_recovery_time: recoverAtIso,
            is_healthy: state === RELAY_STATES.HEALTHY
        };
    }

    async _persistRelayState(providerType, provider, state, context = {}) {
        if (!provider?.uuid) return;

        const patch = this._buildRelayStatePatch(provider, state, context);
        await providerDao.update(provider.uuid, patch);

        // 优先使用 credentials 中已持久化的 relayState，避免从旧 provider 对象重新推断导致不准确
        const credentials = this._getProviderCredentials(provider);
        const storedRelayState = String(credentials?.relayState || '').trim().toLowerCase();
        let previous;
        if (storedRelayState) {
            previous = storedRelayState;
        } else if (provider?.is_healthy !== false && !provider?.is_deleted && !provider?.is_disabled) {
            previous = RELAY_STATES.HEALTHY;
        } else {
            previous = inferRelayState(provider, provider?.last_error_message, provider?.error_count);
        }
        if (previous !== state) {
            this._recordStatusLog({
                provider,
                providerType,
                action: context.action || 'relay_state_transition',
                fromStatus: previous,
                toStatus: state,
                reason: context.reason || null,
                source: context.source || 'system',
                metadata: context.metadata || null
            });
        }
    }

    _recordStatusLog({ provider, providerType, action, fromStatus, toStatus, reason, source, metadata }) {
        if (!provider?.uuid || !action) {
            return;
        }
        const payload = {
            providerUuid: provider.uuid,
            providerType: providerType || provider.provider_type || null,
            poolId: provider.pool_id ?? provider.poolId ?? 0,
            action,
            fromStatus,
            toStatus,
            reason,
            source,
            metadata
        };
        providerStatusLogsDao.create(payload).catch(err => {
            console.error('[ProviderPoolManagerDB] Failed to record status log:', err);
        });
    }

    _resolveProviderUuid(providerOrUuid) {
        if (!providerOrUuid) {
            return null;
        }
        if (typeof providerOrUuid === 'string') {
            return providerOrUuid;
        }
        if (typeof providerOrUuid === 'object' && providerOrUuid.uuid) {
            return providerOrUuid.uuid;
        }
        return null;
    }

    _normalizeTokenId(tokenId) {
        if (tokenId === null || tokenId === undefined || tokenId === '') {
            return null;
        }
        const parsed = Number.parseInt(tokenId, 10);
        if (!Number.isFinite(parsed)) {
            return null;
        }
        return parsed;
    }

    _normalizePoolId(poolId) {
        if (poolId === null || poolId === undefined || poolId === '') {
            return null;
        }
        const parsed = Number.parseInt(poolId, 10);
        if (!Number.isFinite(parsed)) {
            return null;
        }
        return parsed;
    }

    _getDefaultPoolId(providerType, pools = []) {
        const defaultPool = Array.isArray(pools) ? pools.find(pool => pool.is_default) : null;
        return defaultPool?.id ?? 0;
    }

    _getPoolStrategy(providerType, poolId, pools = []) {
        const matched = Array.isArray(pools) ? pools.find(pool => pool.id === poolId) : null;
        return matched?.strategy || 'round-robin';
    }

    _normalizeStickySessionId(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return null;
        const normalized = sessionId.trim();
        return normalized || null;
    }

    _resolveSelectionUserKey(options = {}) {
        const requestContext = options?.requestContext || {};
        const tokenRaw = requestContext.clientTokenId;
        const clientIp = typeof requestContext.clientIp === 'string'
            ? requestContext.clientIp.trim()
            : null;
        if (tokenRaw === undefined || tokenRaw === null) return null;
        const tokenId = String(tokenRaw).trim();
        if (!tokenId || tokenId.toLowerCase() === 'unknown') return null;
        return concurrencyLimiter.getUserKey(tokenId, clientIp);
    }

    async _preferAccountsWithoutForeignUsers(providerType, candidates = [], options = {}) {
        if (providerType !== 'openai-codex') return candidates;
        if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;

        const requesterUserKey = this._resolveSelectionUserKey(options);
        if (!requesterUserKey) return candidates;

        try {
            const occupancy = await Promise.all(candidates.map(async provider => {
                const accountUsers = await concurrencyLimiter.getAccountUsers(provider.uuid);
                let hasForeignUser = false;
                if (Array.isArray(accountUsers) && accountUsers.length > 0) {
                    for (const user of accountUsers) {
                        const userKey = typeof user?.userKey === 'string' ? user.userKey : '';
                        if (!userKey) continue;
                        if (userKey !== requesterUserKey) {
                            hasForeignUser = true;
                        }
                    }
                }
                return { provider, hasForeignUser };
            }));

            const preferredProviders = occupancy
                .filter(item => !item.hasForeignUser)
                .map(item => item.provider);

            if (preferredProviders.length > 0 && preferredProviders.length < candidates.length) {
                const crowdedCount = occupancy.filter(item => item.hasForeignUser).length;
                console.log(`[PoolRoute] Codex 用户分流: 过滤 ${crowdedCount} 个被其他用户占用账号，保留 ${preferredProviders.length}/${candidates.length}`);
                return preferredProviders;
            }
        } catch (error) {
            console.warn('[ProviderPoolManagerDB] Codex user spread filter failed:', error.message);
        }

        return candidates;
    }

    _extractSessionIdFromUserIdentity(userIdentity) {
        if (!userIdentity || typeof userIdentity !== 'string') return null;
        const match = userIdentity.match(/session_([a-f0-9-]+)$/i);
        return match ? this._normalizeStickySessionId(match[1]) : null;
    }

    _parseBoolean(value, defaultValue) {
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

    _parsePositiveInteger(value, defaultValue) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return defaultValue;
        }
        return parsed;
    }

    _getClaudeOfficialStickyConfig(provider, channelDefaults = {}) {
        const credentials = provider?.credentials && typeof provider.credentials === 'object'
            ? provider.credentials
            : (provider || {});
        const cd = channelDefaults || {};

        // 账号级优先，没有则 fallback 到渠道级默认值
        const _val = (key, fallback) => credentials[key] !== undefined ? credentials[key] : (cd[key] !== undefined ? cd[key] : fallback);

        const enabled = this._parseBoolean(_val('officialStickySessionEnabled', true), true);
        const strictBinding = this._parseBoolean(_val('officialSessionBindingStrict', false), false);
        const ttlMinutesRaw = Number(_val('officialStickySessionTtlMinutes', 60));
        const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : 60;
        const modeRaw = String(_val('officialStickyIdentityMode', 'session-or-fingerprint')).trim().toLowerCase();
        const identityMode = ['session', 'fingerprint', 'session-or-fingerprint'].includes(modeRaw)
            ? modeRaw
            : 'session-or-fingerprint';
        const includeUser = this._parseBoolean(_val('officialFingerprintIncludeUser', true), true);
        const includeToken = this._parseBoolean(_val('officialFingerprintIncludeToken', true), true);
        const includePath = this._parseBoolean(_val('officialFingerprintIncludePath', false), false);
        const fingerprintSalt = _val('officialFingerprintSalt', '') ? String(_val('officialFingerprintSalt', '')) : '';
        return {
            enabled,
            strictBinding,
            ttlSeconds: Math.round(ttlMinutes * 60),
            identityMode,
            includeUser,
            includeToken,
            includePath,
            fingerprintSalt
        };
    }

    _getClaudeAntigravityStickyConfig(provider, channelDefaults = {}) {
        const credentials = provider?.credentials && typeof provider.credentials === 'object'
            ? provider.credentials
            : (provider || {});
        const cd = channelDefaults || {};

        const _val = (key, fallback) => credentials[key] !== undefined ? credentials[key] : (cd[key] !== undefined ? cd[key] : fallback);

        const enabled = this._parseBoolean(_val('antigravityStickySessionEnabled', true), true);
        const strictBinding = this._parseBoolean(_val('antigravitySessionBindingStrict', false), false);
        const ttlMinutesRaw = Number(_val('antigravityStickySessionTtlMinutes', 60));
        const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : 60;
        const modeRaw = String(_val('antigravityStickyIdentityMode', 'session-or-fingerprint')).trim().toLowerCase();
        const identityMode = ['session', 'fingerprint', 'session-or-fingerprint'].includes(modeRaw)
            ? modeRaw
            : 'session-or-fingerprint';
        const includeUser = this._parseBoolean(_val('antigravityFingerprintIncludeUser', true), true);
        const includeToken = this._parseBoolean(_val('antigravityFingerprintIncludeToken', true), true);
        const includePath = this._parseBoolean(_val('antigravityFingerprintIncludePath', false), false);
        const fingerprintSalt = _val('antigravityFingerprintSalt', '') ? String(_val('antigravityFingerprintSalt', '')) : '';

        return {
            enabled,
            strictBinding,
            ttlSeconds: Math.round(ttlMinutes * 60),
            identityMode,
            includeUser,
            includeToken,
            includePath,
            fingerprintSalt
        };
    }

    _getCodexStickyConfig(provider, channelDefaults = {}) {
        const credentials = provider?.credentials && typeof provider.credentials === 'object'
            ? provider.credentials
            : (provider || {});
        const cd = channelDefaults || {};

        const _val = (key, fallback) => credentials[key] !== undefined ? credentials[key] : (cd[key] !== undefined ? cd[key] : fallback);

        const enabled = this._parseBoolean(_val('codexStickySessionEnabled', true), true);
        const strictBinding = this._parseBoolean(_val('codexSessionBindingStrict', false), false);
        const ttlMinutesRaw = Number(_val('codexStickySessionTtlMinutes', 60));
        const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : 60;
        const modeRaw = String(_val('codexStickyIdentityMode', 'session-or-fingerprint')).trim().toLowerCase();
        const identityMode = ['session', 'fingerprint', 'session-or-fingerprint'].includes(modeRaw)
            ? modeRaw
            : 'session-or-fingerprint';
        const includeUser = this._parseBoolean(_val('codexFingerprintIncludeUser', true), true);
        const includeToken = this._parseBoolean(_val('codexFingerprintIncludeToken', true), true);
        const includePath = this._parseBoolean(_val('codexFingerprintIncludePath', false), false);
        const fingerprintSalt = _val('codexFingerprintSalt', '') ? String(_val('codexFingerprintSalt', '')) : '';

        return {
            enabled,
            strictBinding,
            ttlSeconds: Math.round(ttlMinutes * 60),
            identityMode,
            includeUser,
            includeToken,
            includePath,
            fingerprintSalt
        };
    }

    _getXaiStickyConfig(provider, channelDefaults = {}) {
        const credentials = provider?.credentials && typeof provider.credentials === 'object'
            ? provider.credentials
            : (provider || {});
        const cd = channelDefaults || {};
        const value = (key, fallback) => (
            credentials[key] !== undefined
                ? credentials[key]
                : (cd[key] !== undefined ? cd[key] : fallback)
        );
        const enabled = this._parseBoolean(value('xaiStickySessionEnabled', true), true);
        const strictBinding = this._parseBoolean(value('xaiSessionBindingStrict', false), false);
        const ttlMinutesRaw = Number(value('xaiStickySessionTtlMinutes', 15));
        const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : 15;
        const modeRaw = String(value('xaiStickyIdentityMode', 'session')).trim().toLowerCase();
        const identityMode = ['session', 'fingerprint', 'session-or-fingerprint'].includes(modeRaw)
            ? modeRaw
            : 'session';

        return {
            enabled,
            strictBinding,
            ttlSeconds: Math.round(ttlMinutes * 60),
            identityMode,
            includeUser: false,
            includeToken: false,
            includePath: false,
            fingerprintSalt: ''
        };
    }

    _normalizeIdentityList(value) {
        if (Array.isArray(value)) {
            return value
                .map(item => String(item || '').trim().toLowerCase())
                .filter(Boolean);
        }
        if (typeof value === 'string') {
            return value
                .split(/[\s,;，；]+/)
                .map(item => item.trim().toLowerCase())
                .filter(Boolean);
        }
        return [];
    }

    _isCodexHighConcurrencyIdentity(options = {}, channelDefaults = {}) {
        const identities = this._normalizeIdentityList(
            channelDefaults.codexHighConcurrencyUserIds
                ?? channelDefaults.codexFingerprintBypassUserIds
                ?? channelDefaults.codexFingerprintBypassIdentities
        );
        if (identities.length === 0) return false;

        const ctx = options?.requestContext || {};
        const headers = ctx.headers && typeof ctx.headers === 'object' ? ctx.headers : {};
        const getHeader = (name) => headers[name] || headers[name.toLowerCase()] || '';
        const values = [
            ctx.userId,
            getHeader('x-accounthub-userid'),
            getHeader('x-accounthub-user-id'),
            getHeader('x-newapi-userid'),
            getHeader('x-newapi-user-id'),
            getHeader('x-user-id'),
            getHeader('x-uid'),
            ctx.userEmail,
            ctx.username,
            ctx.clientTokenId,
            ctx.clientIp
        ].map(item => String(item || '').trim()).filter(Boolean);

        const candidates = new Set();
        for (const value of values) {
            const normalized = value.toLowerCase();
            candidates.add(normalized);
        }
        if (ctx.userId) candidates.add(`user:${String(ctx.userId).trim().toLowerCase()}`);
        if (ctx.userEmail) candidates.add(`email:${String(ctx.userEmail).trim().toLowerCase()}`);
        if (ctx.username) candidates.add(`username:${String(ctx.username).trim().toLowerCase()}`);
        if (ctx.clientTokenId) candidates.add(`token:${String(ctx.clientTokenId).trim().toLowerCase()}`);
        if (ctx.clientIp) candidates.add(`ip:${String(ctx.clientIp).trim().toLowerCase()}`);

        return identities.some(identity => candidates.has(identity));
    }

    _supportsStickyIdentity(providerType) {
        return providerType === 'claude-offical'
            || providerType === 'claude-antigravity'
            || providerType === 'openai-codex'
            || providerType === 'openai-xai-oauth';
    }

    _getStickyConfigForProvider(providerType, provider, channelDefaults = {}) {
        if (providerType === 'claude-offical') {
            return this._getClaudeOfficialStickyConfig(provider, channelDefaults);
        }
        if (providerType === 'claude-antigravity') {
            return this._getClaudeAntigravityStickyConfig(provider, channelDefaults);
        }
        if (providerType === 'openai-codex') {
            return this._getCodexStickyConfig(provider, channelDefaults);
        }
        if (providerType === 'openai-xai-oauth') {
            return this._getXaiStickyConfig(provider, channelDefaults);
        }
        return {
            enabled: false,
            strictBinding: false,
            ttlSeconds: 3600,
            identityMode: 'session-or-fingerprint',
            includeUser: true,
            includeToken: true,
            includePath: false,
            fingerprintSalt: ''
        };
    }

    _buildOfficialFingerprint(options = {}, stickyConfig = {}) {
        const requestContext = options?.requestContext || {};
        const headers = requestContext?.headers && typeof requestContext.headers === 'object'
            ? requestContext.headers
            : {};
        const getHeader = (name) => headers[name] || headers[name?.toLowerCase()] || '';

        const forwardedIp = String(getHeader('x-forwarded-for') || '').split(',')[0].trim();
        const ip = String(requestContext.clientIp || getHeader('x-real-ip') || forwardedIp || '').trim();
        const userAgent = String(getHeader('user-agent') || '').trim();
        const userIdentity = String(
            requestContext.userId || requestContext.userEmail || requestContext.username || ''
        ).trim();
        const authToken = String(
            requestContext.clientTokenId || getHeader('authorization') || getHeader('x-api-key') || ''
        ).trim();
        const path = String(requestContext.path || '').trim();

        const parts = [`ip:${ip || 'none'}`, `ua:${userAgent || 'none'}`];
        if (stickyConfig.includeUser) {
            parts.push(`user:${userIdentity || 'none'}`);
        }
        if (stickyConfig.includeToken) {
            const tokenHash = authToken
                ? createHash('sha256').update(authToken).digest('hex').slice(0, 20)
                : 'none';
            parts.push(`token:${tokenHash}`);
        }
        if (stickyConfig.includePath) {
            parts.push(`path:${path || 'none'}`);
        }
        const hasFingerprintSignal = Boolean(
            ip || userAgent ||
            (stickyConfig.includeUser && userIdentity) ||
            (stickyConfig.includeToken && authToken) ||
            (stickyConfig.includePath && path)
        );
        if (!hasFingerprintSignal) {
            return null;
        }
        parts.push(`salt:${stickyConfig.fingerprintSalt || ''}`);

        return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
    }

    _resolveOfficialStickyIdentity(options = {}, provider, channelDefaults = {}) {
        const stickyConfig = this._getClaudeOfficialStickyConfig(provider, channelDefaults);
        const requestUserId = options?.requestContext?.userId || null;
        const sessionId = this._normalizeStickySessionId(options.sessionId)
            || this._extractSessionIdFromUserIdentity(requestUserId);

        if (stickyConfig.identityMode === 'session') {
            return sessionId ? { stickyKey: `session:${sessionId}`, stickyConfig } : { stickyKey: null, stickyConfig };
        }

        if (stickyConfig.identityMode === 'session-or-fingerprint' && sessionId) {
            return { stickyKey: `session:${sessionId}`, stickyConfig };
        }

        const fingerprint = this._buildOfficialFingerprint(options, stickyConfig);
        return fingerprint ? { stickyKey: `fingerprint:${fingerprint}`, stickyConfig } : { stickyKey: null, stickyConfig };
    }

    _resolveStickyIdentity(providerType, options = {}, provider, channelDefaults = {}) {
        const stickyConfig = this._getStickyConfigForProvider(providerType, provider, channelDefaults);
        const requestUserId = options?.requestContext?.userId || null;
        const sessionId = this._normalizeStickySessionId(options.sessionId)
            || this._extractSessionIdFromUserIdentity(requestUserId);
        const bypassFingerprint = providerType === 'openai-codex'
            && this._isCodexHighConcurrencyIdentity(options, channelDefaults);

        if (stickyConfig.identityMode === 'session') {
            return sessionId ? { stickyKey: `session:${sessionId}`, stickyConfig } : { stickyKey: null, stickyConfig };
        }

        if (stickyConfig.identityMode === 'session-or-fingerprint' && sessionId) {
            return { stickyKey: `session:${sessionId}`, stickyConfig };
        }

        if (bypassFingerprint) {
            console.log(`[PoolRoute] Codex 高并发用户绕过 fingerprint sticky: userId=${options?.requestContext?.userId || '-'} token=${options?.requestContext?.clientTokenId || '-'}`);
            return { stickyKey: null, stickyConfig };
        }

        const fingerprint = this._buildOfficialFingerprint(options, stickyConfig);
        return fingerprint ? { stickyKey: `fingerprint:${fingerprint}`, stickyConfig } : { stickyKey: null, stickyConfig };
    }

    _getStickyBindingKey(providerType, poolId, sessionId) {
        return `sticky:provider:${providerType}:pool:${poolId}:session:${sessionId}`;
    }

    async _getStickySessionBinding(providerType, poolId, sessionId) {
        const key = this._getStickyBindingKey(providerType, poolId, sessionId);
        if (isRedisAvailable()) {
            try {
                const redis = getRedisClient();
                return redis ? await redis.get(key) : null;
            } catch (error) {
                console.warn('[ProviderPoolManagerDB] Failed to read sticky session from redis:', error.message);
            }
        }
        const now = Date.now();
        if (now - this._lastStickySessionCleanupAt >= this._stickySessionCleanupIntervalMs) {
            this._cleanupStickySessionBindings(now);
            this._lastStickySessionCleanupAt = now;
        }
        const cached = this._stickySessionBindings.get(key);
        if (!cached) return null;
        if (cached.expiresAt <= now) {
            this._stickySessionBindings.delete(key);
            return null;
        }
        return cached.uuid;
    }

    async _setStickySessionBinding(providerType, poolId, sessionId, uuid, ttlSeconds) {
        const key = this._getStickyBindingKey(providerType, poolId, sessionId);
        if (isRedisAvailable()) {
            try {
                const redis = getRedisClient();
                if (redis) {
                    await redis.set(key, uuid, 'EX', Math.max(60, ttlSeconds));
                    return;
                }
            } catch (error) {
                console.warn('[ProviderPoolManagerDB] Failed to write sticky session to redis:', error.message);
            }
        }
        const now = Date.now();
        if (
            this._stickySessionBindings.size >= this._stickySessionMaxEntries
            || now - this._lastStickySessionCleanupAt >= this._stickySessionCleanupIntervalMs
        ) {
            this._cleanupStickySessionBindings(now);
            this._lastStickySessionCleanupAt = now;
        }
        this._stickySessionBindings.set(key, {
            uuid,
            expiresAt: now + Math.max(60, ttlSeconds) * 1000
        });
    }

    async _deleteStickySessionBinding(providerType, poolId, sessionId) {
        const key = this._getStickyBindingKey(providerType, poolId, sessionId);
        if (isRedisAvailable()) {
            try {
                const redis = getRedisClient();
                if (redis) {
                    await redis.del(key);
                }
            } catch (error) {
                console.warn('[ProviderPoolManagerDB] Failed to delete sticky session from redis:', error.message);
            }
        }
        this._stickySessionBindings.delete(key);
    }

    _cleanupStickySessionBindings(now = Date.now()) {
        if (this._stickySessionBindings.size === 0) return;

        let removedExpired = 0;
        for (const [key, entry] of this._stickySessionBindings) {
            if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
                this._stickySessionBindings.delete(key);
                removedExpired++;
            }
        }

        const maxEntries = Math.max(1000, this._stickySessionMaxEntries);
        let removedOverflow = 0;
        while (this._stickySessionBindings.size > maxEntries) {
            const oldestKey = this._stickySessionBindings.keys().next().value;
            if (oldestKey === undefined) break;
            this._stickySessionBindings.delete(oldestKey);
            removedOverflow++;
        }

        if (removedExpired > 0 || removedOverflow > 0) {
            console.log(`[ProviderPoolManagerDB] Sticky bindings cleanup: expired=${removedExpired}, overflow=${removedOverflow}, remaining=${this._stickySessionBindings.size}`);
        }
    }

    // ─── Model-Level Quota Protection ───

    /**
     * 标记某账号的某模型进入配额保护
     * @param {string} uuid - 账号 UUID
     * @param {string} model - 被限流的模型名
     * @param {Date|string} recoverAt - 恢复时间
     */
    markModelQuotaProtected(uuid, model, recoverAt) {
        if (!uuid || !model) return;
        const key = `${uuid}:${model}`;
        const recoverAtMs = recoverAt instanceof Date ? recoverAt.getTime() : new Date(recoverAt).getTime();
        if (!Number.isFinite(recoverAtMs)) return;
        this._modelQuotaProtection.set(key, { recoverAt: recoverAtMs });
        console.log(`[ModelQuota] 🛡️ Protected ${uuid.slice(0, 8)}:${model} until ${new Date(recoverAtMs).toISOString()}`);
    }

    /**
     * 检查某账号的某模型是否在配额保护中
     */
    isModelQuotaProtected(uuid, model) {
        if (!uuid || !model) return false;
        const key = `${uuid}:${model}`;
        const entry = this._modelQuotaProtection.get(key);
        if (!entry) return false;
        if (Date.now() >= entry.recoverAt) {
            this._modelQuotaProtection.delete(key);
            return false;
        }
        return true;
    }

    /**
     * 清理已过期的模型配额保护记录
     */
    _cleanExpiredModelQuotaProtections() {
        const now = Date.now();
        for (const [key, entry] of this._modelQuotaProtection) {
            if (now >= entry.recoverAt) this._modelQuotaProtection.delete(key);
        }
    }

    async _getChannelPoolRouting(providerType) {
        try {
            const config = await channelConfigDao.getByProviderType(providerType);
            const routing = config?.config?.poolRouting || null;
            return routing;
        } catch (error) {
            console.warn('[ProviderPoolManagerDB] Failed to load channel routing config:', error.message);
            return null;
        }
    }

    _normalizePoolIdList(poolIds = []) {
        if (!Array.isArray(poolIds)) return [];
        return poolIds
            .map(id => this._normalizePoolId(id))
            .filter(id => id !== null);
    }

    _resolveRoutingPoolIds(providerType, rule = {}, pools = []) {
        const poolIds = this._normalizePoolIdList(rule.poolIds);
        const poolNames = Array.isArray(rule.poolNames) ? rule.poolNames : [];
        if (poolNames.length > 0) {
            const nameMatches = pools
                .filter(pool => poolNames.includes(pool.name))
                .map(pool => pool.id);
            return [...new Set([...poolIds, ...nameMatches])];
        }
        return poolIds;
    }

    _hasExplicitRoutingTargets(rule = {}) {
        const poolIds = this._normalizePoolIdList(rule.poolIds);
        const poolNames = Array.isArray(rule.poolNames) ? rule.poolNames : [];
        return poolIds.length > 0 || poolNames.some(name => String(name || '').trim());
    }

    _formatRoutingTargets(rule = {}) {
        const parts = [];
        const poolIds = this._normalizePoolIdList(rule.poolIds);
        const poolNames = Array.isArray(rule.poolNames)
            ? rule.poolNames.map(name => String(name || '').trim()).filter(Boolean)
            : [];
        if (poolIds.length > 0) parts.push(`poolIds=[${poolIds.join(',')}]`);
        if (poolNames.length > 0) parts.push(`poolNames=[${poolNames.join(',')}]`);
        return parts.join(' ') || '未指定';
    }

    _matchModelPattern(model, pattern) {
        if (!model || !pattern) return false;
        if (pattern === '*') return true;
        if (!pattern.includes('*')) return pattern === model;
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp(`^${escaped}$`, 'i');
        return regex.test(model);
    }

    _resolvePoolRoutingRule(poolRouting, requestedModel) {
        if (!poolRouting) return null;
        const rules = Array.isArray(poolRouting.rules) ? poolRouting.rules : [];
        if (requestedModel) {
            for (let i = 0; i < rules.length; i++) {
                const rule = rules[i];
                const models = Array.isArray(rule.models) ? rule.models : [];
                if (models.some(pattern => this._matchModelPattern(requestedModel, pattern))) {
                    return { rule, key: `rule:${i}` };
                }
            }
        }
        if (poolRouting.default) {
            return { rule: poolRouting.default, key: 'default' };
        }
        return null;
    }

    _nextRoundRobinIndex(counterKey, length) {
        if (!this._roundRobinCounters[counterKey]) {
            this._roundRobinCounters[counterKey] = 0;
        }
        const counter = this._roundRobinCounters[counterKey];
        this._roundRobinCounters[counterKey]++;
        return counter % length;
    }

    async _nextRoundRobinIndexAsync(counterKey, length) {
        // 优先使用 Redis
        if (isRedisAvailable()) {
            const index = await incrAndMod(`rr:${counterKey}`, length);
            if (index !== null) {
                return index;
            }
        }
        // 降级到内存
        return this._nextRoundRobinIndex(counterKey, length);
    }

    async _selectPoolByStrategy(providerType, ruleKey, strategy, candidates, poolStatsById) {
        if (!candidates || candidates.length === 0) return null;
        const safeStrategy = strategy || 'priority';

        const pickLeastPressurePoolId = () => {
            let best = candidates[0];
            let bestStats = poolStatsById.get(best.id) || { usage: 0, lastUsed: 0 };
            let bestAvgUsage = (Number(bestStats.usage) || 0) / Math.max(1, Array.isArray(best.providers) ? best.providers.length : 1);

            for (let i = 1; i < candidates.length; i++) {
                const candidate = candidates[i];
                const stats = poolStatsById.get(candidate.id) || { usage: 0, lastUsed: 0 };
                const providerCount = Math.max(1, Array.isArray(candidate.providers) ? candidate.providers.length : 1);
                const avgUsage = (Number(stats.usage) || 0) / providerCount;

                const betterByAvg = avgUsage < bestAvgUsage;
                const betterByTotal = avgUsage === bestAvgUsage && (Number(stats.usage) || 0) < (Number(bestStats.usage) || 0);
                const betterByLastUsed = avgUsage === bestAvgUsage
                    && (Number(stats.usage) || 0) === (Number(bestStats.usage) || 0)
                    && (Number(stats.lastUsed) || 0) < (Number(bestStats.lastUsed) || 0);

                if (betterByAvg || betterByTotal || betterByLastUsed) {
                    best = candidate;
                    bestStats = stats;
                    bestAvgUsage = avgUsage;
                }
            }
            return best?.id ?? null;
        };

        // Codex 场景下，priority + 多池会导致首池被持续打满；自动退化为按池内账号数归一化后的 least-used。
        if (safeStrategy === 'priority') {
            if (providerType === 'openai-codex' && candidates.length > 1) {
                return pickLeastPressurePoolId();
            }
            return candidates[0]?.id ?? null;
        }

        if (safeStrategy === 'random') {
            return candidates[Math.floor(Math.random() * candidates.length)]?.id ?? null;
        }
        if (safeStrategy === 'least-used') {
            return pickLeastPressurePoolId();
        }
        if (safeStrategy === 'round-robin') {
            const counterKey = `pool-route:${providerType}:${ruleKey}`;
            const index = await this._nextRoundRobinIndexAsync(counterKey, candidates.length);
            return candidates[index]?.id ?? null;
        }
        return candidates[0]?.id ?? null;
    }

    _resolveProviderPoolId(provider, providerType, pools = []) {
        const poolId = this._normalizePoolId(provider.pool_id ?? provider.poolId);
        if (poolId !== null) {
            return poolId;
        }
        return this._getDefaultPoolId(providerType, pools);
    }

    _ensureRefreshFields(provider) {
        if (!provider) return;
        if (provider.refresh_count === undefined || provider.refresh_count === null) {
            provider.refresh_count = 0;
        }
        if (provider.needs_refresh === undefined || provider.needs_refresh === null) {
            provider.needs_refresh = false;
        }
    }

    _isHealthCheckEnabled(provider) {
        if (!provider) return true;
        const value = provider.check_health ?? provider.checkHealth;
        if (value === undefined || value === null) {
            return true;
        }
        return value !== false && value !== 0 && value !== '0';
    }

    _extractExpiryTime(credentials) {
        if (!credentials || typeof credentials !== 'object') {
            return null;
        }
        const raw =
            credentials.expiresAt ||
            credentials.expires_at ||
            credentials.expired ||
            credentials.expiry_date ||
            credentials.expiryDate ||
            credentials.expire ||
            credentials.expires;

        if (!raw) {
            return null;
        }
        if (typeof raw === 'number') {
            return raw < 1e12 ? raw * 1000 : raw;
        }
        if (typeof raw === 'string') {
            const parsed = Date.parse(raw);
            if (!Number.isNaN(parsed)) {
                return parsed;
            }
            const asNumber = Number(raw);
            if (Number.isFinite(asNumber)) {
                return asNumber < 1e12 ? asNumber * 1000 : asNumber;
            }
        }
        return null;
    }

    _shouldRefreshProvider(provider) {
        const expiry = this._extractExpiryTime(provider?.credentials);
        if (!expiry) {
            return false;
        }
        return expiry <= (Date.now() + this.refreshNearMs);
    }

    async _refreshProviderToken(providerType, provider, options = {}) {
        if (!provider) return;
        const uuid = provider.uuid;
        if (!uuid) return;
        if (this.refreshingUuids.has(uuid)) {
            return;
        }

        this._ensureRefreshFields(provider);
        if (provider.refresh_count >= this.refreshMaxCount && !options.force) {
            console.warn(`[ProviderPoolManagerDB] Refresh count exceeded for ${uuid}, marking unhealthy`);
            await this.markProviderUnhealthyImmediately(providerType, uuid, 'Maximum refresh count reached');
            return;
        }

        this.refreshingUuids.add(uuid);

        try {
            const { peekServiceAdapter, getServiceAdapter } = await import('./adapter.js');
            const { CONFIG } = await import('../core/config-manager.js');
            const providerKey = providerType + uuid;
            let adapter = peekServiceAdapter(providerKey);

            if (!adapter) {
                const credentials = provider.credentials || provider;
                const serviceConfig = {
                    ...CONFIG,
                    ...credentials,
                    uuid: uuid,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            }

            if (!adapter || typeof adapter.refreshToken !== 'function') {
                throw new Error(`refreshToken not supported for ${providerType}`);
            }

            provider.refresh_count = (provider.refresh_count || 0) + 1;
            await adapter.refreshToken();
            provider.refresh_count = 0;
            provider.needs_refresh = false;
        } catch (error) {
            provider.refresh_count = (provider.refresh_count || 0) + 1;
            console.warn(`[ProviderPoolManagerDB] Refresh failed for ${uuid}: ${error.message}`);
            if (provider.refresh_count >= this.refreshMaxCount) {
                await this.markProviderUnhealthyImmediately(providerType, uuid, `Refresh failed: ${error.message}`);
            } else {
                provider.needs_refresh = true;
            }
        } finally {
            this.refreshingUuids.delete(uuid);
        }
    }

    async refreshExpiringProviders() {
        const providers = await providerDao.findAll(null, { includeDeleted: false });
        const providersByType = new Map();
        for (const provider of providers) {
            // Phase 2+3: 只刷本 shard 的 provider,不刷其他 worker 负责的,避免重复 refresh
            if (SHARD_ENABLED && !ownsUuid(provider.uuid)) continue;
            const providerType = provider.provider_type;
            if (!providersByType.has(providerType)) {
                providersByType.set(providerType, []);
            }
            providersByType.get(providerType).push(provider);
        }

        for (const [providerType, typeProviders] of providersByType.entries()) {
            for (const provider of typeProviders) {
                if (provider.is_disabled) {
                    continue;
                }
                if (!this._isHealthCheckEnabled(provider)) {
                    continue;
                }
                if (!provider.is_healthy) {
                    continue;
                }
                if (this._shouldRefreshProvider(provider)) {
                    provider.needs_refresh = true;
                    await this._refreshProviderToken(providerType, provider);
                }
            }
        }
    }

    async warmupNodes() {
        if (!this.warmupTarget || this.warmupTarget <= 0) {
            return;
        }

        const providers = await providerDao.findAll(null, { includeDeleted: true });
        const providersByType = new Map();
        for (const provider of providers) {
            // Phase 2+3: 只 warmup 本 shard 的 provider
            if (SHARD_ENABLED && !ownsUuid(provider.uuid)) continue;
            const providerType = provider.provider_type;
            if (!providersByType.has(providerType)) {
                providersByType.set(providerType, []);
            }
            providersByType.get(providerType).push(provider);
        }

        for (const [providerType, typeProviders] of providersByType.entries()) {
            const candidates = typeProviders
                .filter(p => !p.is_deleted && !p.is_disabled && p.is_healthy)
                .sort((a, b) => {
                    const lastUsedA = a.last_used ? new Date(a.last_used).getTime() : 0;
                    const lastUsedB = b.last_used ? new Date(b.last_used).getTime() : 0;
                    const usageA = a.usage_count || 0;
                    const usageB = b.usage_count || 0;
                    return (lastUsedA + usageA * 60000) - (lastUsedB + usageB * 60000);
                })
                .slice(0, this.warmupTarget);

            for (const provider of candidates) {
                await this._refreshProviderToken(providerType, provider);
            }
        }
    }

    async _selectRoundRobinProvider(providerType, providers, poolId = null) {
        if (!providers || providers.length === 0) {
            return null;
        }

        const counterKey = poolId !== null ? `${providerType}:${poolId}` : providerType;
        const selectedIndex = await this._nextRoundRobinIndexAsync(counterKey, providers.length);
        return providers[selectedIndex];
    }

    _selectRandomProvider(providers) {
        if (!providers || providers.length === 0) {
            return null;
        }
        const selectedIndex = Math.floor(Math.random() * providers.length);
        return providers[selectedIndex];
    }

    _selectLeastUsedProvider(providers) {
        if (!providers || providers.length === 0) {
            return null;
        }
        let best = providers[0];
        let bestLastUsed = best.last_used ? new Date(best.last_used).getTime() : 0;
        let bestUsage = Number.isFinite(best.usage_count) ? best.usage_count : 0;

        for (let i = 1; i < providers.length; i++) {
            const candidate = providers[i];
            const lastUsed = candidate.last_used ? new Date(candidate.last_used).getTime() : 0;
            const usage = Number.isFinite(candidate.usage_count) ? candidate.usage_count : 0;
            // 优先选最久未使用的，相同时选使用次数最少的
            if (lastUsed < bestLastUsed || (lastUsed === bestLastUsed && usage < bestUsage)) {
                best = candidate;
                bestLastUsed = lastUsed;
                bestUsage = usage;
            }
        }
        return best;
    }

    /**
     * Power-of-Two-Choices (P2C) 选择算法
     * 从 top-5 候选中随机取 2 个，选健康分更高的那个
     * 健康分 = (1 - errorRate) * recencyBonus * usageBalance
     */
    _selectP2CProvider(providers, requestedModel = null) {
        if (!providers || providers.length === 0) return null;
        if (providers.length === 1) return providers[0];

        // 计算每个候选的健康分
        const scored = providers.map(p => {
            const errorCount = Number.isFinite(p.error_count) ? p.error_count : 0;
            const maxErrors = this.maxErrorCount || 3;
            // 错误率反转：0 错误 = 1.0，满错误 = 0.1
            const healthScore = Math.max(0.1, 1 - (errorCount / maxErrors));

            // 使用量均衡：使用次数越少越好
            const usage = Number.isFinite(p.usage_count) ? p.usage_count : 0;
            const usageScore = 1 / (1 + usage * 0.001);

            // 最近使用时间：越久未用越好（避免热点）
            const lastUsedMs = p.last_used ? new Date(p.last_used).getTime() : 0;
            const idleMs = lastUsedMs > 0 ? Date.now() - lastUsedMs : 3600000;
            const recencyScore = Math.min(1, idleMs / 300000); // 5分钟内线性增长

            // 模型配额保护惩罚
            let quotaPenalty = 1.0;
            if (requestedModel && this.isModelQuotaProtected(p.uuid, requestedModel)) {
                quotaPenalty = 0.05; // 严重惩罚但不完全排除
            }

            const totalScore = healthScore * usageScore * recencyScore * quotaPenalty;
            return { provider: p, score: totalScore };
        });

        // 按分数降序排列，取 top 5
        scored.sort((a, b) => b.score - a.score);
        const topN = scored.slice(0, Math.min(5, scored.length));

        // 从 top-N 中随机取 2 个，选分数更高的
        const idx1 = Math.floor(Math.random() * topN.length);
        let idx2 = Math.floor(Math.random() * (topN.length - 1));
        if (idx2 >= idx1) idx2 += 1;
        idx2 = Math.min(idx2, topN.length - 1);

        const pick = topN[idx1].score >= topN[idx2].score ? topN[idx1] : topN[idx2];
        return pick.provider;
    }

    async _selectRedisBalancedProvider(providerType, providers, poolId = null) {
        if (!providers || providers.length === 0) return null;
        if (providers.length === 1) return providers[0];
        if (!isRedisAvailable()) return null;

        try {
            const scored = await Promise.all(providers.map(async (provider) => {
                const concurrency = await concurrencyLimiter.getAccountConcurrency(provider.uuid);
                const usage = Number.isFinite(provider.usage_count) ? provider.usage_count : 0;
                const lastUsed = provider.last_used ? new Date(provider.last_used).getTime() : 0;
                return { provider, concurrency, usage, lastUsed };
            }));

            const minConcurrency = Math.min(...scored.map(item => item.concurrency));
            const candidates = scored
                .filter(item => item.concurrency === minConcurrency)
                .sort((a, b) => {
                    if (a.usage !== b.usage) return a.usage - b.usage;
                    return a.lastUsed - b.lastUsed;
                });

            if (candidates.length === 0) {
                return null;
            }

            const rrKey = `balance:${providerType}:${poolId ?? 'default'}:c${minConcurrency}`;
            const selectedIndex = await this._nextRoundRobinIndexAsync(rrKey, candidates.length);
            const selected = candidates[selectedIndex]?.provider || candidates[0]?.provider || null;

            if (selected) {
                console.log(`[PoolRoute] ⚖️ Redis平衡选择: uuid=${selected.uuid?.slice(0, 8)} concurrency=${minConcurrency} candidates=${candidates.length}`);
            }
            return selected;
        } catch (error) {
            console.warn(`[ProviderPoolManagerDB] Redis balanced selection failed for ${providerType}:`, error.message);
            return null;
        }
    }

    async _loadPools() {
        try {
            const pools = await providerPoolDao.findAll();
            this.poolMap = {};
            this.defaultPoolByType = {};
            for (const pool of pools) {
                if (!this.poolMap[pool.provider_type]) {
                    this.poolMap[pool.provider_type] = [];
                }
                this.poolMap[pool.provider_type].push(pool);
                if (pool.is_default) {
                    this.defaultPoolByType[pool.provider_type] = pool.id;
                }
            }
        } catch (error) {
            console.warn('[ProviderPoolManagerDB] Failed to load pools:', error.message);
            this.poolMap = {};
            this.defaultPoolByType = {};
        }
    }

    async _ensureDefaultPools() {
        // 不再自动创建默认池，让用户自己创建池子
        // 只处理已有默认池的情况，将未绑定池子的账号分配到默认池
        const providerTypes = await providerDao.getProviderTypes({ includeDeleted: true });
        if (!providerTypes.length) {
            return;
        }

        for (const providerType of providerTypes) {
            const pools = await providerPoolDao.findByType(providerType);
            const defaultPool = pools.find(pool => pool.is_default);

            // 只有存在默认池时才分配未绑定的账号
            if (defaultPool?.id) {
                const updated = await providerDao.assignDefaultPoolId(providerType, defaultPool.id);
                if (updated > 0) {
                    logEvent('pool.default.assign', { providerType, poolId: defaultPool.id, updated }, {
                        level: 'info',
                        message: `[ProviderPoolManagerDB] Default pool assigned: ${providerType} -> ${defaultPool.id} (${updated})`,
                        writeToFile: true,
                        emitConsole: true
                    });
                }
            }
        }
    }

    /**
     * 初始化 - 从数据库加载数据到内存缓存
     */
    async initialize() {
        if (this._initialized) {
            console.log('[ProviderPoolManagerDB] Already initialized');
            return;
        }

        console.log('[ProviderPoolManagerDB] Initializing from database...');

        try {
            // 0. 初始化 Redis 连接
            await initRedis();

            // 启动请求日志队列 Worker
            if (isRedisAvailable()) {
                startLogQueueWorker();
            }

            await this._ensureDefaultPools();

            // 1. 读取数据库以触发默认池处理（不缓存到内存）
            const allProviders = await providerDao.findAll(null, { includeDeleted: true });
            for (const provider of allProviders) {
                this._ensureRefreshFields(provider);
            }

            // 3. 加载全局统计（转换为驼峰格式）
            const dbStats = await statsDao.getGlobalStats();
            this._globalStats = {
                totalRequests: dbStats.total_requests || 0,
                successRequests: dbStats.successful_requests || 0,
                failedRequests: dbStats.failed_requests || 0,
                switchCount: dbStats.switch_count || 0,
                lastResetTime: dbStats.last_reset_time || Date.now()
            };

            this._initialized = true;

            // 预热 claude-offical 渠道级配置缓存
            getOfficialChannelDefaults().catch(() => {});

            console.log(`[ProviderPoolManagerDB] Initialized successfully`);
            console.log(`[ProviderPoolManagerDB] Loaded ${allProviders.length} providers`);
        } catch (error) {
            console.error('[ProviderPoolManagerDB] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * 选择提供商（轮询算法 - 优化版）
     * @param {string} providerType - 提供商类型
     * @param {string} requestedModel - 请求的模型（可选）
     * @param {Object} options - 选项
     * @returns {Object|null} 选中的提供商配置
     */
    async selectProvider(providerType, requestedModel = null, options = {}) {
        const startTime = Date.now();

        // === 调试日志：请求开始 ===
        console.log(`[PoolRoute] ========== 开始选择提供商 ==========`);
        console.log(`[PoolRoute] 请求模型: ${requestedModel || '未指定'}`);
        console.log(`[PoolRoute] 提供商类型: ${providerType}`);
        console.log(`[PoolRoute] 请求poolId: ${options.poolId ?? '未指定'}`);

        if (!this._initialized) {
            throw new Error('ProviderPoolManager not initialized. Call initialize() first.');
        }

        this._lastRejectReason = null; // 重置失败原因
        try {
            // 方案 B:sticky 依赖 TCP 层 master dispatcher 把同 token 用户稳定路由到同一 worker。
            // 默认本 worker 只从自己的 shard 选号,不再有跨 worker 转发概念(forcedUuid/_selectByForcedUuid 已移除)。

            // claude-windsurf: 在 provider 选择阶段提前解析 model alias，
            // 确保 findAvailable 的白名单检查与内部模型 key 匹配。
            let resolvedModel = requestedModel;
            if (providerType === 'claude-windsurf' && requestedModel) {
                resolvedModel = resolveWindsurfModel(requestedModel);
                if (resolvedModel !== requestedModel) {
                    console.log(`[PoolRoute] windsurf model alias: ${requestedModel} → ${resolvedModel}`);
                }
            }

            // 1. 检查并恢复已到恢复时间的提供商(只处理本 shard 的 provider,避免每个 worker 都扫全量)
            await this._checkAndRecoverScheduledProviders(providerType);

            // 2. 从数据库读取可用提供商（SQL层面已过滤：健康、未禁用、未删除）
            let availableProviders = await providerDao.findAvailable(providerType, { requestedModel: resolvedModel });

            // 部分渠道需要跨 worker 全局选号；其它渠道如果本 shard 完全没候选，
            // 也退回全量候选，避免少量账号被 hash 到其它 shard 后当前 worker 直接空池。
            const skipSelectionShardFilter = GLOBAL_SELECTION_PROVIDER_TYPES.has(providerType);
            const applySelectionShardFilter = (providers, phase) => {
                if (!SHARD_ENABLED || options.poolIdExplicit || skipSelectionShardFilter) {
                    return providers;
                }
                const ownedProviders = providers.filter(p => ownsUuid(p.uuid));
                if (ownedProviders.length > 0 || providers.length === 0) {
                    return ownedProviders;
                }
                console.warn(`[PoolRoute] shard sparse fallback (${phase}): ${providers.length} ${providerType} providers match globally, but shard ${SHARD_ID}/${SHARD_COUNT} owns 0; using all candidates`);
                return providers;
            };

            // Phase 2+3: shard 过滤 —— 优先只保留归属本 worker 的 provider。
            // Codex/Windsurf 例外: 需要跨 worker 全局选号。其它渠道在本 shard 没候选时也退回全量，
            // 避免少量账号被 hash 分片打散后出现 worker 级空池。
            if (SHARD_ENABLED && !options.poolIdExplicit && !skipSelectionShardFilter) {
                const beforeCount = availableProviders.length;
                availableProviders = applySelectionShardFilter(availableProviders, 'initial');
                if (beforeCount !== availableProviders.length) {
                    console.log(`[PoolRoute] shard filter: ${beforeCount} → ${availableProviders.length} (shard ${SHARD_ID}/${SHARD_COUNT})`);
                }
            } else if (SHARD_ENABLED && !options.poolIdExplicit && skipSelectionShardFilter) {
                console.log(`[PoolRoute] global selection: shard filter skipped for ${providerType}, using all ${availableProviders.length} providers`);
            } else if (SHARD_ENABLED && options.poolIdExplicit) {
                console.log(`[PoolRoute] shard filter skipped: explicit poolId=${options.poolId}, using all ${availableProviders.length} providers`);
            }

            if (availableProviders.length === 0) {
                console.log(`[ProviderPoolManagerDB] No available providers for type: ${providerType}, triggering auto health check...`);

                // 自动触发健康检测：检查所有不健康但未禁用、未删除的提供商
                const recoveredCount = await this._autoRecoverUnhealthyProviders(providerType);

                if (recoveredCount > 0) {
                    // 重新查询可用提供商(优先本 shard；本 shard 无候选时退回全量)
                    availableProviders = await providerDao.findAvailable(providerType, { requestedModel: resolvedModel });
                    if (SHARD_ENABLED && !skipSelectionShardFilter) {
                        availableProviders = applySelectionShardFilter(availableProviders, 'after-recovery');
                    }
                    console.log(`[ProviderPoolManagerDB] After auto recovery: ${availableProviders.length} providers available`);
                }

                if (availableProviders.length === 0) {
                    console.log(`[ProviderPoolManagerDB] Still no available providers after auto health check`);
                    this._lastRejectReason = `provider级别无可用账号（全部不健康/禁用/删除，或模型 ${requestedModel || '未指定'} 不在账号白名单中）`;
                    return null;
                }
            }

            const nowTs = Date.now();
            availableProviders = availableProviders.filter((provider) => {
                const credentials = this._getProviderCredentials(provider);
                const relayState = String(credentials?.relayState || '').trim().toLowerCase();
                if (!relayState || relayState === RELAY_STATES.HEALTHY) {
                    return true;
                }

                if (relayState === RELAY_STATES.AUTH_INVALID || relayState === RELAY_STATES.BLOCKED) {
                    return false;
                }

                if (relayState === RELAY_STATES.COOLDOWN || relayState === RELAY_STATES.OVERLOADED) {
                    const recoverAtRaw = credentials?.relayStateRecoverAt || provider?.scheduled_recovery_time;
                    const recoverAtMs = recoverAtRaw ? new Date(recoverAtRaw).getTime() : NaN;
                    if (Number.isFinite(recoverAtMs) && recoverAtMs > nowTs) {
                        return false;
                    }
                }

                return true;
            });

            if (availableProviders.length === 0) {
                // Optimistic Reset: 防死锁 — 所有账号都在 cooldown/overloaded 时尝试恢复
                // 同样优先本 shard；本 shard 没候选时退回全量，避免少量账号空池
                let allFromDb = await providerDao.findAvailable(providerType, { requestedModel: resolvedModel });
                if (SHARD_ENABLED && !skipSelectionShardFilter) {
                    allFromDb = applySelectionShardFilter(allFromDb, 'relay-state');
                }
                const cooldownProviders = allFromDb.filter((p) => {
                    const creds = this._getProviderCredentials(p);
                    const rs = String(creds?.relayState || '').trim().toLowerCase();
                    return rs === RELAY_STATES.COOLDOWN || rs === RELAY_STATES.OVERLOADED;
                });
                if (cooldownProviders.length > 0) {
                    // Layer 1: 最短恢复时间 <= 3s → 等一下再试
                    const soonest = cooldownProviders.reduce((min, p) => {
                        const creds = this._getProviderCredentials(p);
                        const rat = creds?.relayStateRecoverAt || p?.scheduled_recovery_time;
                        const ms = rat ? new Date(rat).getTime() : Infinity;
                        return ms < min ? ms : min;
                    }, Infinity);
                    const waitMs = Number.isFinite(soonest) ? Math.max(0, soonest - Date.now()) : 0;
                    if (waitMs > 0 && waitMs <= 3000) {
                        console.log(`[PoolRoute] ⏳ Optimistic wait ${waitMs}ms for soonest recovery`);
                        await new Promise(r => setTimeout(r, waitMs + 200));
                        // 重新过滤
                        const nowTs2 = Date.now();
                        availableProviders = allFromDb.filter((p) => {
                            const creds = this._getProviderCredentials(p);
                            const rs = String(creds?.relayState || '').trim().toLowerCase();
                            if (!rs || rs === RELAY_STATES.HEALTHY) return true;
                            if (rs === RELAY_STATES.AUTH_INVALID || rs === RELAY_STATES.BLOCKED) return false;
                            if (rs === RELAY_STATES.COOLDOWN || rs === RELAY_STATES.OVERLOADED) {
                                const rat = creds?.relayStateRecoverAt || p?.scheduled_recovery_time;
                                const ms = rat ? new Date(rat).getTime() : NaN;
                                return !(Number.isFinite(ms) && ms > nowTs2);
                            }
                            return true;
                        });
                    }
                    // Layer 2: 仍然为空 → 只重置短暂 cooldown，不重置长时间额度耗尽
                    if (availableProviders.length === 0) {
                        if (providerType === 'openai-codex') {
                            const soonestRecover = cooldownProviders.reduce((min, p) => {
                                const creds = this._getProviderCredentials(p);
                                const rat = creds?.relayStateRecoverAt || p?.scheduled_recovery_time;
                                const ms = rat ? new Date(rat).getTime() : Infinity;
                                return ms < min ? ms : min;
                            }, Infinity);
                            const waitInfo = Number.isFinite(soonestRecover) ? new Date(soonestRecover).toISOString() : 'unknown';
                            console.warn(`[PoolRoute] ❄️ Codex all ${cooldownProviders.length} providers cooling down, soonest recovery: ${waitInfo} — not resetting`);
                            this._lastRejectReason = `当前 Codex 池子账号都在冷却中，预计最早恢复时间: ${waitInfo}`;
                            return null;
                        }
                        const nowMs = Date.now();
                        const shortCooldownProviders = cooldownProviders.filter((p) => {
                            const creds = this._getProviderCredentials(p);
                            const rat = creds?.relayStateRecoverAt || p?.scheduled_recovery_time;
                            const ms = rat ? new Date(rat).getTime() : 0;
                            // 恢复时间 <= 60s 或无恢复时间 → 可以乐观重置
                            // 恢复时间 > 60s → 额度耗尽，不重置
                            return !ms || (ms - nowMs) <= 60000;
                        });
                        if (shortCooldownProviders.length > 0) {
                            console.warn(`[PoolRoute] 🔄 Optimistic reset: clearing ${shortCooldownProviders.length}/${cooldownProviders.length} short-cooldown providers (skipping long quota exhaustion)`);
                            for (const p of shortCooldownProviders) {
                                await this.markProviderHealthy(providerType, p.uuid, {
                                    action: 'optimistic_reset',
                                    source: 'anti_deadlock',
                                    reason: '短暂限流，乐观重置'
                                });
                            }
                            availableProviders = shortCooldownProviders;
                        } else {
                            // 所有账号都是长时间额度耗尽，不强制重置
                            const soonestRecover = cooldownProviders.reduce((min, p) => {
                                const creds = this._getProviderCredentials(p);
                                const rat = creds?.relayStateRecoverAt || p?.scheduled_recovery_time;
                                const ms = rat ? new Date(rat).getTime() : Infinity;
                                return ms < min ? ms : min;
                            }, Infinity);
                            const waitInfo = Number.isFinite(soonestRecover) ? new Date(soonestRecover).toISOString() : 'unknown';
                            console.warn(`[PoolRoute] ❄️ All ${cooldownProviders.length} providers quota exhausted, soonest recovery: ${waitInfo} — not resetting`);
                            this._lastRejectReason = `当前池子算力紧张，所有账号额度已耗尽，预计最早恢复时间: ${waitInfo}`;
                        }
                    }
                }
                if (availableProviders.length === 0) {
                    this._lastRejectReason = '账号状态机过滤后无可用账号（cooldown/blocked/auth_invalid）';
                    return null;
                }
            }

            const excludedUuids = new Set(
                (Array.isArray(options.excludeUuids) ? options.excludeUuids : [])
                    .map(uuid => String(uuid || '').trim())
                    .filter(Boolean)
            );
            if (excludedUuids.size > 0) {
                availableProviders = availableProviders.filter(provider => !excludedUuids.has(provider.uuid));
                if (availableProviders.length === 0) {
                    this._lastRejectReason = `排除已失败账号后无可用账号（excluded: ${[...excludedUuids].map(uuid => uuid.slice(0, 8)).join(', ')})`;
                    return null;
                }
            }

            // 3. 根据池子过滤
            const pools = await providerPoolDao.findByType(providerType);
            const resolvedPoolId = this._normalizePoolId(options.poolId);
            let poolId = resolvedPoolId === null ? this._getDefaultPoolId(providerType, pools) : resolvedPoolId;

            // === 调试日志：池子信息 ===
            console.log(`[PoolRoute] 可用池子: ${pools.map(p => `${p.id}(${p.name})`).join(', ')}`);
            console.log(`[PoolRoute] 初始poolId: ${poolId} (resolved: ${resolvedPoolId}, default: ${this._getDefaultPoolId(providerType, pools)})`);

            const providersByPoolId = new Map();
            for (const provider of availableProviders) {
                const providerPoolId = this._resolveProviderPoolId(provider, providerType, pools);
                if (!providersByPoolId.has(providerPoolId)) {
                    providersByPoolId.set(providerPoolId, []);
                }
                providersByPoolId.get(providerPoolId).push(provider);
            }

            const poolConfigs = requestedModel ? await poolConfigDao.getPoolConfigsByProviderType(providerType) : [];
            const poolConfigById = new Map(poolConfigs.map(pc => [pc.id, pc]));
            const isPoolModelSupported = (poolIdValue) => {
                if (!requestedModel) return true;
                const poolConfig = poolConfigById.get(poolIdValue);
                return poolConfigDao.isModelSupportedByPool(poolConfig, requestedModel);
            };

            let routingPoolIds = [];
            let hasStrictChannelRouting = false;
            if (resolvedPoolId === null) {
                const poolRouting = await this._getChannelPoolRouting(providerType);
                // === 调试日志：渠道路由配置 ===
                console.log(`[PoolRoute] 渠道路由配置: ${JSON.stringify(poolRouting)}`);

                const routingInfo = this._resolvePoolRoutingRule(poolRouting, requestedModel);
                console.log(`[PoolRoute] 路由规则匹配: ${routingInfo ? JSON.stringify(routingInfo) : '无匹配'}`);

                if (routingInfo?.rule) {
                    const { rule, key } = routingInfo;
                    routingPoolIds = this._resolveRoutingPoolIds(providerType, rule, pools);
                    hasStrictChannelRouting = this._hasExplicitRoutingTargets(rule);
                    const candidateIds = hasStrictChannelRouting
                        ? routingPoolIds
                        : Array.from(providersByPoolId.keys());

                    if (hasStrictChannelRouting && candidateIds.length === 0) {
                        const routeTargets = this._formatRoutingTargets(rule);
                        console.warn(`[PoolRoute] 渠道路由${key}指定池子未匹配: ${routeTargets}`);
                        this._lastRejectReason = `渠道路由 ${key} 指定池子未匹配或已不可用：${routeTargets}`;
                        return null;
                    }

                    const candidates = [];
                    const poolStatsById = new Map();
                    const poolsWithProviders = [];
                    const modelUnsupportedPools = [];
                    for (const id of candidateIds) {
                        const poolProviders = providersByPoolId.get(id) || [];
                        if (poolProviders.length === 0) continue;
                        poolsWithProviders.push(id);
                        if (!isPoolModelSupported(id)) {
                            modelUnsupportedPools.push(id);
                            continue;
                        }
                        candidates.push({ id, providers: poolProviders });

                        let usage = 0;
                        let lastUsed = 0;
                        for (const poolProvider of poolProviders) {
                            usage += poolProvider.usage_count || 0;
                            const lastUsedAt = poolProvider.last_used ? new Date(poolProvider.last_used).getTime() : 0;
                            if (lastUsed === 0) {
                                lastUsed = lastUsedAt;
                            } else if (lastUsedAt > 0) {
                                lastUsed = Math.min(lastUsed, lastUsedAt);
                            }
                        }
                        poolStatsById.set(id, { usage, lastUsed });
                    }

                    if (hasStrictChannelRouting && candidates.length === 0) {
                        const routeTargets = this._formatRoutingTargets(rule);
                        const reason = poolsWithProviders.length === 0
                            ? '指定池子内无可用账号'
                            : `指定池子不支持模型 ${requestedModel || '未指定'}（不支持池子: ${modelUnsupportedPools.join(',') || poolsWithProviders.join(',')}）`;
                        console.warn(`[PoolRoute] 渠道路由${key}无可用候选: ${routeTargets}, ${reason}`);
                        this._lastRejectReason = `渠道路由 ${key} ${reason}：${routeTargets}`;
                        return null;
                    }

                    const selectedPoolId = await this._selectPoolByStrategy(providerType, key, rule.strategy, candidates, poolStatsById);
                    console.log(`[PoolRoute] 策略选择池子: ${selectedPoolId} (策略: ${rule.strategy})`);
                    if (selectedPoolId !== null) {
                        poolId = selectedPoolId;
                    } else if (hasStrictChannelRouting) {
                        const routeTargets = this._formatRoutingTargets(rule);
                        this._lastRejectReason = `渠道路由 ${key} 未选中可用池子：${routeTargets}`;
                        return null;
                    }
                }
            }

            // 7.1 如果指定了模型，检查号池级别的模型路由
            if (requestedModel) {
                const poolSupported = isPoolModelSupported(poolId);
                // === 调试日志：池子模型支持检查 ===
                console.log(`[PoolRoute] 池子${poolId}是否支持模型${requestedModel}: ${poolSupported}`);
                const poolConfig = poolConfigById.get(poolId);
                console.log(`[PoolRoute] 池子${poolId}配置: supported=${JSON.stringify(poolConfig?.supportedModels)}, notSupported=${JSON.stringify(poolConfig?.notSupportedModels)}`);

                if (!poolSupported && poolConfigs.length > 0) {
                    console.log(`[ProviderPoolManagerDB] Pool ${poolId} doesn't support model ${requestedModel}; strict routing rejects instead of rerouting`);
                    this._lastRejectReason = `池子级别模型不支持：当前池子 ${poolId} 不支持模型 ${requestedModel}`;
                    return null;
                }
            }

            availableProviders = availableProviders.filter(p => this._resolveProviderPoolId(p, providerType, pools) === poolId);

            if (availableProviders.length === 0) {
                console.log(`[ProviderPoolManagerDB] No available providers for type: ${providerType} (pool: ${poolId})`);
                this._lastRejectReason = `池子 ${poolId} 内无可用账号（账号可能在其他池子中，或该池子为空）`;
                return null;
            }

            // 8. 按 UUID 排序确保顺序稳定
            const sortedProviders = availableProviders.sort((a, b) => a.uuid.localeCompare(b.uuid));

            // === 调试日志：最终池子和可用提供商 ===
            console.log(`[PoolRoute] 最终poolId: ${poolId}`);
            console.log(`[PoolRoute] 该池子可用提供商: ${sortedProviders.map(p => p.uuid?.slice(0,8) + '(' + (p.custom_name || 'unnamed') + ')').join(', ')}`);

            // 9. 获取池子并发配置（根据用户类型选择对应的账号并发限制）
            const poolConfig = poolConfigById.get(poolId);
            const _isProviderUser = options.isProviderUser === true;
            const enableAccountConcurrencyLimit = _isProviderUser
                ? (poolConfig?.enableProviderAccountConcurrencyLimit || false)
                : (poolConfig?.enableAccountConcurrencyLimit || false);
            const accountMaxConcurrency = _isProviderUser
                ? (poolConfig?.providerAccountMaxConcurrency || 0)
                : (poolConfig?.accountMaxConcurrency || 0);

            // 9.1 Codex 高并发用户识别：命中名单的用户跳过 account_max_concurrency 过滤
            // 与 _preferAccountsWithoutForeignUsers 过滤,让 Redis 平衡选择能在全量号上自由
            // 分散,而不是被挤到当前空闲的少数号上(否则 70 并发会扎堆到 1~3 个号)
            let codexChannelDefaults = null;
            let isCodexHighConcurrencyUser = false;
            if (providerType === 'openai-codex') {
                codexChannelDefaults = await getCodexChannelDefaults().catch(() => ({}));
                const activePool = pools.find(pool => Number(pool.id) === Number(poolId));
                const poolHighConcurrencyUserIds = this._normalizeIdentityList(activePool?.codex_high_concurrency_user_ids);
                if (poolHighConcurrencyUserIds.length > 0) {
                    codexChannelDefaults = {
                        ...codexChannelDefaults,
                        codexHighConcurrencyUserIds: poolHighConcurrencyUserIds
                    };
                }
                isCodexHighConcurrencyUser = this._isCodexHighConcurrencyIdentity(options, codexChannelDefaults);
                if (isCodexHighConcurrencyUser) {
                    console.log(`[PoolRoute] Codex 高并发用户绕过账号并发上限+用户分流过滤: userId=${options?.requestContext?.userId || '-'} token=${options?.requestContext?.clientTokenId || '-'} pool=${poolId}`);
                }
            }

            // 10. 按池子策略选择（带并发检查）
            let selectedProvider = null;
            const poolStrategy = this._getPoolStrategy(providerType, poolId, pools);

            // 如果启用了账号并发限制，需要过滤掉并发已满的账号
            // 高并发用户跳过此过滤(由 _selectRedisBalancedProvider 按当前并发最低优先选号实现分散)
            let candidateProviders = sortedProviders;
            if (enableAccountConcurrencyLimit && accountMaxConcurrency > 0 && !isCodexHighConcurrencyUser) {
                const availableCandidates = [];
                for (const provider of sortedProviders) {
                    const currentConcurrency = await concurrencyLimiter.getAccountConcurrency(provider.uuid);
                    if (currentConcurrency < accountMaxConcurrency) {
                        availableCandidates.push(provider);
                    } else {
                        console.log(`[PoolRoute] 账号 ${provider.uuid?.slice(0,8)} 并发已满 (${currentConcurrency}/${accountMaxConcurrency})，跳过`);
                    }
                }
                candidateProviders = availableCandidates;
                console.log(`[PoolRoute] 并发过滤后剩余 ${candidateProviders.length}/${sortedProviders.length} 个账号可用`);
            }

            // 10.1 Model-Level Quota Protection: 跳过该模型被限流的账号
            const enableModelQuotaProtection = requestedModel && (providerType === 'claude-offical' || providerType === 'openai-codex');
            let blockedByModelQuota = false;
            if (enableModelQuotaProtection) {
                this._cleanExpiredModelQuotaProtections();
                const beforeCount = candidateProviders.length;
                const modelFiltered = candidateProviders.filter(p => !this.isModelQuotaProtected(p.uuid, requestedModel));
                if (modelFiltered.length > 0) {
                    candidateProviders = modelFiltered;
                    if (modelFiltered.length < beforeCount) {
                        console.log(`[PoolRoute] 🛡️ 模型配额保护过滤: ${beforeCount - modelFiltered.length} 个账号的 ${requestedModel} 被保护，剩余 ${modelFiltered.length}`);
                    }
                } else if (beforeCount > 0) {
                    if (providerType === 'openai-codex') {
                        blockedByModelQuota = true;
                        candidateProviders = [];
                        this._lastRejectReason = `模型级冷却：池子 ${poolId} 内所有账号的 ${requestedModel} 当前均不可用，请切换其它模型或等待恢复`;
                        console.warn(`[PoolRoute] 🛡️ Codex 模型 ${requestedModel} 在池子 ${poolId} 的 ${beforeCount} 个账号上均被保护，本次不降级到全量候选`);
                    } else {
                        // 所有账号该模型都被保护，不过滤（降级为全量候选，避免死锁）
                        console.warn(`[PoolRoute] 🛡️ 所有 ${beforeCount} 个账号的 ${requestedModel} 均被保护，降级为全量候选`);
                    }
                }
            }

            // 高并发用户跳过 foreign-user 过滤:让他们能撞到正在被其他用户使用的号,
            // 避免候选集被削到 1~3 个号(指纹粘性已通过 _isCodexHighConcurrencyIdentity 单独 bypass)
            if (!isCodexHighConcurrencyUser) {
                candidateProviders = await this._preferAccountsWithoutForeignUsers(
                    providerType,
                    candidateProviders,
                    options
                );
            }

            if (candidateProviders.length === 0) {
                if (blockedByModelQuota) {
                    console.log(`[ProviderPoolManagerDB] All providers blocked by model quota protection for pool ${poolId}, model ${requestedModel}`);
                } else {
                    console.log(`[ProviderPoolManagerDB] All providers are at max concurrency for pool ${poolId}`);
                }
                if (!blockedByModelQuota) {
                    this._lastRejectReason = `并发限制：池子 ${poolId} 内所有 ${sortedProviders.length} 个账号并发已满（上限 ${accountMaxConcurrency}）`;
                }
                return null;
            }

            // 10.5 会话粘性优先（Claude / Codex / Grok）
            let stickyIdentityKey = null;
            let stickyConfigRef = null;
            let stickyChannelDefaults = null;
            if (this._supportsStickyIdentity(providerType)) {
                if (providerType === 'claude-offical') {
                    stickyChannelDefaults = await getOfficialChannelDefaults();
                } else if (providerType === 'claude-antigravity') {
                    const channelConfig = await channelConfigDao.getByProviderType('claude-antigravity').catch(() => null);
                    stickyChannelDefaults = channelConfig?.config || {};
                } else if (providerType === 'openai-codex') {
                    // 复用 9.1 已加载好的 channelDefaults,避免再次 IO + 重复合并 pool 级 ID 列表
                    stickyChannelDefaults = codexChannelDefaults || await getCodexChannelDefaults().catch(() => ({}));
                } else if (providerType === 'openai-xai-oauth') {
                    stickyChannelDefaults = await getXaiChannelDefaults().catch(() => ({}));
                }
                const stickyIdentity = this._resolveStickyIdentity(providerType, options, candidateProviders[0], stickyChannelDefaults);
                stickyIdentityKey = stickyIdentity?.stickyKey || null;
                stickyConfigRef = stickyIdentity?.stickyConfig || null;
            }
            if (stickyIdentityKey) {
                const stickyUuid = await this._getStickySessionBinding(providerType, poolId, stickyIdentityKey);
                if (stickyUuid) {
                    const stickyProvider = candidateProviders.find(p => p.uuid === stickyUuid);
                    if (stickyProvider) {
                        selectedProvider = stickyProvider;
                        console.log(`[PoolRoute] 🎯 命中粘性会话: key=${stickyIdentityKey.slice(0,20)} -> uuid=${stickyUuid.slice(0,8)}`);
                    } else {
                        // candidateProviders 没有这个 uuid:可能是
                        //   (a) 跨 shard(其他 worker 的分片):方案 B 里不应该发生 —— master 的 sticky dispatcher
                        //       会把同一 token 的连接稳定路由到同一个 worker。若出现,说明客户端的 token 变了
                        //       或者分片拓扑刚刚变化。处理方法:当作 sticky miss,走本地重选,新绑定会覆盖旧值。
                        //   (b) 在本 shard 但已被过滤掉(unhealthy / cooldown / disabled / deleted / 模型不匹配):
                        //       正常 sticky 失效。
                        // 两种情况统一处理:
                        //   - strictBinding 打开:返回 null,客户端会拿到 pool reject(客户端可能会重试)
                        //   - strictBinding 关闭:删掉失效的 sticky 绑定,继续往下走正常选号,选完会重新 set 新绑定
                        const mappedProvider = await providerDao.findByUuid(stickyUuid).catch(() => null);
                        const stickyConfig = this._getStickyConfigForProvider(providerType, mappedProvider, stickyChannelDefaults);
                        if (SHARD_ENABLED && mappedProvider && !mappedProvider.is_deleted && !mappedProvider.is_disabled && !ownsUuid(mappedProvider.uuid)) {
                            console.log(`[PoolRoute] ⚠ sticky cross-shard detected (dispatcher routing mismatch?): session=${stickyIdentityKey.slice(0,20)} uuid=${stickyUuid.slice(0,8)} owner shard=${shardOfUuid(mappedProvider.uuid)} local shard=${SHARD_ID}`);
                        }
                        if (stickyConfig.strictBinding) {
                            this._lastRejectReason = `粘性会话严格绑定：key ${stickyIdentityKey.slice(0,20)} 绑定账号 ${stickyUuid.slice(0,8)} 不可用`;
                            return null;
                        }
                        await this._deleteStickySessionBinding(providerType, poolId, stickyIdentityKey);
                    }
                }
            }

            switch (poolStrategy) {
                case 'random':
                    selectedProvider = selectedProvider || this._selectRandomProvider(candidateProviders);
                    break;
                case 'least-used':
                    selectedProvider = selectedProvider || this._selectLeastUsedProvider(candidateProviders);
                    break;
                case 'p2c':
                    selectedProvider = selectedProvider || this._selectP2CProvider(candidateProviders, requestedModel);
                    break;
                case 'round-robin':
                default:
                    // claude-offical 无显式策略时默认 P2C
                    if (providerType === 'claude-offical' && poolStrategy === 'round-robin') {
                        selectedProvider = selectedProvider || this._selectP2CProvider(candidateProviders, requestedModel);
                    } else if (providerType === 'openai-codex' && poolStrategy === 'round-robin') {
                        selectedProvider = selectedProvider || await this._selectRedisBalancedProvider(providerType, candidateProviders, poolId);
                        selectedProvider = selectedProvider || await this._selectRoundRobinProvider(providerType, candidateProviders, poolId);
                    } else {
                        selectedProvider = selectedProvider || await this._selectRoundRobinProvider(providerType, candidateProviders, poolId);
                    }
                    break;
            }
            if (!selectedProvider) {
                console.log(`[ProviderPoolManagerDB] No available providers for type: ${providerType}`);
                this._lastRejectReason = `策略选择失败：池子 ${poolId} 策略 ${poolStrategy} 未能选出账号（候选 ${candidateProviders.length} 个）`;
                return null;
            }

            if (stickyIdentityKey && this._supportsStickyIdentity(providerType)) {
                const stickyConfig = stickyConfigRef || this._getStickyConfigForProvider(providerType, selectedProvider, stickyChannelDefaults);
                if (stickyConfig.enabled) {
                    await this._setStickySessionBinding(
                        providerType,
                        poolId,
                        stickyIdentityKey,
                        selectedProvider.uuid,
                        stickyConfig.ttlSeconds
                    );
                } else {
                    await this._deleteStickySessionBinding(providerType, poolId, stickyIdentityKey);
                }
            }

            // === 调试日志：最终选择结果 ===
            console.log(`[PoolRoute] ✓ 选中提供商: ${selectedProvider.uuid?.slice(0,8)}(${selectedProvider.custom_name || 'unnamed'}) 池子: ${poolId} 模型: ${requestedModel}`);
            console.log(`[PoolRoute] ========== 选择完成 ==========`);

            if (!options.skipUsageCount) {
                // 11. 更新使用信息（异步写入数据库）
                const newUsageCount = (selectedProvider.usage_count || 0) + 1;
                selectedProvider.usage_count = newUsageCount;
                selectedProvider.last_used = new Date();

                // 异步更新数据库（不阻塞）
                providerDao.updateUsage(selectedProvider.uuid, newUsageCount).catch(err => {
                    console.error(`[ProviderPoolManagerDB] Failed to update usage for ${selectedProvider.uuid}:`, err);
                });
            }

        // 返回 credentials 对象（应用层格式）
        // 合并 oauth_credential_id 和 uuid 到 credentials 中，确保凭证加载逻辑能正确获取
        const credentials = selectedProvider.credentials || {};

        // 12. 记录性能日志
        const duration = Date.now() - startTime;
        this._performanceLogger.recordSelectProvider(duration);

        if (duration > 100) {
            console.warn(`[ProviderPoolManagerDB] selectProvider took ${duration}ms (slow)`);
        }

        // 13. 检查是否需要使用代理池
        let proxyAgent = null;
        let proxyNode = null;
        const globalProxyEnabled = this.globalConfig?.PROXY_POOL_ENABLED;
        const normalizeProxyPoolEnabled = (value) => {
            if (value === undefined || value === null || value === '') return true;
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
                if (['false', '0', 'no', 'off'].includes(normalized)) return false;
            }
            return Boolean(value);
        };
        const isProxyPoolEnabled = normalizeProxyPoolEnabled(globalProxyEnabled);
        if (isProxyPoolEnabled && poolId !== null) {
            const poolInfo = await providerPoolDao.findById(poolId);
            if (poolInfo?.use_proxy) {
                if (!proxyPoolManager.initialized) {
                    await proxyPoolManager.initialize();
                }
                // 兜底刷新：避免运行中新增/恢复节点后仍命中旧快照导致一直 direct。
                await proxyPoolManager.refreshNodes();
            }
            if (poolInfo?.use_proxy && proxyPoolManager.hasNodes()) {
                const allowedNodeIds = Array.isArray(poolInfo?.proxy_node_ids) ? poolInfo.proxy_node_ids : [];
                let proxyResult = proxyPoolManager.getProxyAgent({
                    allowedNodeIds
                });
                // 绑定节点失效时，回退到代理池内任意健康节点，避免无感降级为 direct。
                if (!proxyResult?.agent && allowedNodeIds.length > 0) {
                    console.warn(`[PoolRoute] Proxy fallback: pool ${poolId} configured nodeIds=[${allowedNodeIds.join(',')}], but no healthy match, fallback to any healthy node`);
                    proxyResult = proxyPoolManager.getProxyAgent();
                }
                proxyAgent = proxyResult.agent;
                proxyNode = proxyResult.node;
            }
        }

        return {
            ...credentials,
            uuid: selectedProvider.uuid,
            poolId,  // 添加 poolId，避免后续查询
            oauth_credential_id: selectedProvider.oauth_credential_id,
            oauthCredentialId: selectedProvider.oauth_credential_id,
            maxDevices: selectedProvider.max_devices ?? 3,
            proxyAgent,
            proxyNode,
            // 并发控制配置
            poolConcurrencyConfig: {
                enableUserConcurrencyLimit: poolConfig?.enableUserConcurrencyLimit || false,
                userMaxConcurrency: poolConfig?.userMaxConcurrency || 0,
                enableAccountConcurrencyLimit: poolConfig?.enableAccountConcurrencyLimit || false,
                accountMaxConcurrency: poolConfig?.accountMaxConcurrency || 0,
                // 代理商并发控制配置
                enableProviderConcurrencyLimit: poolConfig?.enableProviderConcurrencyLimit || false,
                providerMaxConcurrency: poolConfig?.providerMaxConcurrency || 0,
                enableProviderAccountConcurrencyLimit: poolConfig?.enableProviderAccountConcurrencyLimit || false,
                providerAccountMaxConcurrency: poolConfig?.providerAccountMaxConcurrency || 0,
                // Session 并发控制配置
                enableSessionLimit: poolConfig?.enableSessionLimit || false,
                maxSessionsPerAccount: poolConfig?.maxSessionsPerAccount || 0
            }
        };
    } catch (error) {
        const duration = Date.now() - startTime;
        this._performanceLogger.recordSelectProvider(duration);
        throw error;
    }
}

    /**
     * 检查并恢复已到恢复时间的提供商（优化版：只查询需要恢复的）
     */
    async _checkAndRecoverScheduledProviders(providerType) {
        const scheduledProviders = await providerDao.findScheduledRecovery(providerType);
        const nowMs = Date.now();

        for (const provider of scheduledProviders) {
            // Phase 2+3: 只恢复本 shard 的 provider,避免同一 provider 被多个 worker 同时 markHealthy
            if (SHARD_ENABLED && !ownsUuid(provider.uuid)) continue;

            const credentials = this._getProviderCredentials(provider);
            const recoverAtRaw = credentials?.relayStateRecoverAt || provider?.scheduled_recovery_time;
            const recoverAtMs = recoverAtRaw ? new Date(recoverAtRaw).getTime() : NaN;

            if (Number.isFinite(recoverAtMs) && recoverAtMs > nowMs) {
                continue;
            }

            console.log(`[ProviderPoolManagerDB] Recovering provider ${provider.uuid}`);
            await this.markProviderHealthy(providerType, provider.uuid, {
                source: 'scheduled_recovery',
                action: 'scheduled_recover'
            });
        }
    }

    /**
     * 检查并恢复已到恢复时间的提供商
     */
    async _checkAndRecoverScheduledProvidersLegacy(providerType, providers = null) {
        const list = Array.isArray(providers)
            ? providers
            : await providerDao.findAll(providerType, { includeDeleted: true });
        const now = new Date();

        for (const provider of list) {
            if (provider.is_deleted || provider.is_disabled) {
                continue;
            }
            if (provider.scheduled_recovery_time && new Date(provider.scheduled_recovery_time) <= now) {
                console.log(`[ProviderPoolManagerDB] Recovering provider ${provider.uuid}`);
                await this.markProviderHealthy(providerType, provider.uuid, {
                    source: 'scheduled_recovery',
                    action: 'scheduled_recover'
                });
            }
        }
    }

    /**
     * 自动恢复不健康的提供商（无可用提供商时触发）
     * 优先恢复临时性错误的账号，排除403等永久性错误
     * @param {string} providerType - 提供商类型
     * @returns {number} 恢复的提供商数量
     */
    async _autoRecoverUnhealthyProviders(providerType) {
        let recoveredCount = 0;

        try {
            // 查询所有不健康但未禁用、未删除的提供商
            const allProviders = await providerDao.findAll(providerType, { includeDeleted: false });
            const unhealthyProviders = allProviders.filter((provider) => {
                // Phase 2+3: 只恢复本 shard 的 provider,避免 worker-A 去恢复 worker-B 的号
                if (SHARD_ENABLED && !ownsUuid(provider.uuid)) return false;
                if (provider.is_healthy || provider.is_disabled || provider.is_deleted) {
                    return false;
                }

                const credentials = this._getProviderCredentials(provider);
                const recoverAtRaw = credentials?.relayStateRecoverAt || provider?.scheduled_recovery_time;
                const recoverAtMs = recoverAtRaw ? new Date(recoverAtRaw).getTime() : NaN;
                if (Number.isFinite(recoverAtMs) && recoverAtMs > Date.now()) {
                    return false;
                }

                const errorMessage = String(provider.last_error_message || '');
                if (/\b403\b/.test(errorMessage) &&
                    (/suspended/i.test(errorMessage) || /token\s*refresh\s*failed/i.test(errorMessage))) {
                    return false;
                }

                if (/\b401\b/.test(errorMessage)) {
                    return false;
                }

                return true;
            });

            if (unhealthyProviders.length === 0) {
                console.log(`[ProviderPoolManagerDB] No unhealthy providers to check for ${providerType}`);
                return 0;
            }

            console.log(`[ProviderPoolManagerDB] 🔄 Pool empty! Auto recovering ${unhealthyProviders.length} unhealthy providers for ${providerType}`);

            // 分类：临时性错误 vs 其他错误
            const temporaryErrorProviders = [];
            const otherErrorProviders = [];

            for (const provider of unhealthyProviders) {
                if (this._isTemporaryError(provider.last_error_message, providerType)) {
                    temporaryErrorProviders.push(provider);
                } else {
                    otherErrorProviders.push(provider);
                }
            }

            console.log(`[ProviderPoolManagerDB] - Temporary errors: ${temporaryErrorProviders.length}`);
            console.log(`[ProviderPoolManagerDB] - Other errors: ${otherErrorProviders.length}`);

            // 优先恢复临时性错误的账号（直接恢复，不做健康检查）
            for (const provider of temporaryErrorProviders) {
                try {
                    await this.markProviderHealthy(providerType, provider.uuid, {
                        source: 'auto_recovery',
                        action: 'auto_recover_temporary_error',
                        reason: `Temporary error recovered: ${provider.last_error_message}`
                    });
                    recoveredCount++;
                    console.log(`[ProviderPoolManagerDB] ✅ Provider ${provider.uuid} auto recovered (temporary error)`);
                } catch (error) {
                    console.error(`[ProviderPoolManagerDB] Failed to recover ${provider.uuid}:`, error.message);
                }
            }

            // 如果还没有恢复到足够的账号，再检查其他错误的账号
            if (recoveredCount === 0 && otherErrorProviders.length > 0) {
                console.log(`[ProviderPoolManagerDB] No temporary errors recovered, checking other errors...`);

                for (const provider of otherErrorProviders) {
                    try {
                        // 检查是否启用了健康检测
                        if (this._isHealthCheckEnabled(provider)) {
                            const result = await this._checkProviderHealth(providerType, provider, true, null, {
                                source: 'auto_recovery_on_empty_pool'
                            });
                            if (result && result.success) {
                                await this.markProviderHealthy(providerType, provider.uuid, {
                                    source: 'auto_recovery',
                                    action: 'auto_health_check_recover'
                                });
                                recoveredCount++;
                                console.log(`[ProviderPoolManagerDB] ✅ Provider ${provider.uuid} auto recovered (health check passed)`);
                            }
                        } else {
                            // 未启用健康检测的提供商，直接尝试恢复（让下次请求验证）
                            await this.markProviderHealthy(providerType, provider.uuid, {
                                source: 'auto_recovery',
                                action: 'auto_recover_without_check'
                            });
                            recoveredCount++;
                            console.log(`[ProviderPoolManagerDB] ✅ Provider ${provider.uuid} auto recovered (no health check)`);
                        }
                    } catch (error) {
                        console.error(`[ProviderPoolManagerDB] Auto recovery failed for ${provider.uuid}:`, error.message);
                    }
                }
            }

            console.log(`[ProviderPoolManagerDB] 🎉 Auto recovery completed: ${recoveredCount}/${unhealthyProviders.length} providers recovered`);
        } catch (error) {
            console.error(`[ProviderPoolManagerDB] Auto recovery error:`, error.message);
        }

        return recoveredCount;
    }

    /**
     * 判断错误是否为可忽略的临时性错误
     * @private
     */
    _isTemporaryError(errorMessage, providerType = null) {
        if (!errorMessage || typeof errorMessage !== 'string') {
            return false;
        }
        const msg = errorMessage.toLowerCase();

        if (providerType === 'claude-custom' || providerType === 'claude-offical') {
            const mustMarkPatterns = [
                /\b400\b/,
                /\b403\b/,
                /\b429\b/,
                /\b5\d\d\b/,
                /bad request/i,
                /forbidden/i,
                /rate.?limit/i,
                /server error/i
            ];
            if (mustMarkPatterns.some(pattern => pattern.test(msg))) {
                return false;
            }
        }

        // 可忽略的临时性错误（不计入错误次数或容忍度更高）
        const temporaryPatterns = [
            /\b400\b/,                          // 400 Bad Request（可能是格式问题）
            /\b429\b/,                          // 429 Rate Limit（临时限速，等待即可恢复）
            /improperly formed/i,               // 格式错误
            /\b500\b/,                          // 500 服务器错误
            /\b502\b/,                          // 502 网关错误
            /\b503\b/,                          // 503 服务不可用
            /\b504\b/,                          // 504 网关超时
            /timeout/i,                         // 超时
            /econnreset/i,                      // 连接重置
            /econnrefused/i,                    // 连接被拒绝
            /network/i,                         // 网络错误
            /socket hang up/i,                  // Socket 挂起
            /rate.?limit/i,                     // 速率限制（文字描述）
        ];

        return temporaryPatterns.some(pattern => pattern.test(errorMessage));
    }

    /**
     * 标记提供商为不健康（累积错误）
     */
    async markProviderUnhealthy(providerType, providerOrUuid, errorMessage = null, context = {}) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for markProviderUnhealthy');
            return;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return;
        }
        if (provider.is_deleted) {
            console.warn(`[ProviderPoolManagerDB] Provider already deleted: ${uuid}`);
            return;
        }

        // 判断是否为临时性错误
        const isTemporary = this._isTemporaryError(errorMessage, providerType);

        // 临时性错误：直接忽略，不做任何标记
        if (isTemporary) {
            console.log(`[ProviderPoolManagerDB] Provider ${uuid} temporary error (ignored, no action): ${errorMessage}`);
            return;
        }

        const now = Date.now();
        const lastErrorTime = provider.last_error_time ? new Date(provider.last_error_time).getTime() : 0;
        const timeSinceLastError = now - lastErrorTime;

        // 自动衰减机制：距离上次错误超过一定时间，降低错误计数
        // 1分钟后衰减1次，2分钟后衰减2次，以此类推
        const decayMinutes = Math.floor(timeSinceLastError / 60000); // 每分钟衰减1次
        const currentErrorCount = provider.error_count || 0;
        const decayedErrorCount = Math.max(0, currentErrorCount - decayMinutes);

        // 计算新的错误次数
        let errorCount;
        if (timeSinceLastError > 10000) {
            // 超过10秒：使用衰减后的计数 + 1
            errorCount = decayedErrorCount + 1;
        } else {
            // 10秒内：直接累加（不衰减）
            errorCount = currentErrorCount + 1;
        }

        // 如果衰减后错误次数降低了，记录日志
        if (decayedErrorCount < currentErrorCount) {
            console.log(`[ProviderPoolManagerDB] Provider ${uuid} error count decayed: ${currentErrorCount} → ${decayedErrorCount} (${decayMinutes} minutes passed)`);
        }

        const prevStatus = this._getProviderStatus(provider);

        // 达到阈值时标记为不健康
        const isHealthy = errorCount < this.maxErrorCount;
        if (!isHealthy) {
            console.log(`[ProviderPoolManagerDB] Marked provider ${uuid} as unhealthy (errorCount: ${errorCount})`);
        }

        const nextStatus = this._getProviderStatus({ ...provider, is_healthy: isHealthy });
        if (prevStatus !== nextStatus) {
            const action = context.action || (nextStatus === 'healthy' ? 'mark_healthy' : 'mark_unhealthy');
            this._recordStatusLog({
                provider,
                providerType,
                action,
                fromStatus: prevStatus,
                toStatus: nextStatus,
                reason: context.reason || errorMessage,
                source: context.source || 'system',
                metadata: {
                    ...(context.metadata || {}),
                    errorCount: errorCount
                }
            });
        }

        // 同步更新数据库，确保状态持久化
        await providerDao.markUnhealthy(uuid, {
            errorCount,
            errorMessage: errorMessage,
            isHealthy
        });

        if (!isHealthy) {
            const statusCode = normalizeStatusCode(context?.metadata?.statusCode, errorMessage);
            const relayState = inferRelayState(provider, errorMessage, statusCode);
            await this._persistRelayState(providerType, provider, relayState, {
                action: context.action || 'mark_unhealthy',
                source: context.source || 'system',
                reason: context.reason || errorMessage,
                statusCode,
                metadata: {
                    errorCount,
                    ...(context.metadata || {})
                }
            });
        }
    }

    /**
     * 直接标记提供商为已删除（用于永久失效账号）
     */
    async markProviderDeleted(providerType, providerOrUuid, errorMessage = null, context = {}) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for markProviderDeleted');
            return;
        }

        const provider = typeof providerOrUuid === 'object' && providerOrUuid?.uuid === uuid
            ? providerOrUuid
            : await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return;
        }
        if (provider.is_deleted) {
            console.warn(`[ProviderPoolManagerDB] Provider already deleted: ${uuid}`);
            return;
        }

        const prevStatus = this._getProviderStatus(provider);
        const statusCode = normalizeStatusCode(context?.metadata?.statusCode, errorMessage);
        const now = new Date();

        await providerDao.update(uuid, {
            is_deleted: true,
            is_healthy: false,
            error_count: this.maxErrorCount,
            last_error_time: now,
            last_error_message: errorMessage,
            scheduled_recovery_time: null
        });

        await this._persistRelayState(providerType, { ...provider, is_deleted: true, is_healthy: false }, RELAY_STATES.DELETED, {
            action: context.action || 'mark_deleted',
            source: context.source || 'system',
            reason: context.reason || errorMessage,
            statusCode,
            metadata: context.metadata || null
        });

        this._recordStatusLog({
            provider,
            providerType,
            action: context.action || 'mark_deleted',
            fromStatus: prevStatus,
            toStatus: 'deleted',
            reason: context.reason || errorMessage,
            source: context.source || 'system',
            metadata: context.metadata || null
        });

        this._recordBadAccount(providerType, provider, this._detectErrorType(errorMessage), errorMessage, statusCode);

        // Phase 1: adapter 清理与跨 worker 广播已移交 providerDao.update() 内部
        // 通过 providerDaoEvents 'deleted' 事件统一处理。上面的 providerDao.update({is_deleted: true})
        // 会自动触发 service-manager.js 注册的 listener,完成 dispose + broadcast。
        // 此处不再重复清理,避免双广播。

        if (providerType === 'openai-codex') {
            this.triggerCodexAutoReplenish('provider_deleted').catch((error) => {
                console.error('[ProviderPoolManagerDB] Codex auto replenish after delete failed:', error.message);
            });
        }
    }

    async triggerCodexAutoReplenish(reason = 'scheduled', options = {}) {
        if (process.env.IS_WORKER_PROCESS === 'true') {
            return { skipped: true, reason: 'worker_process' };
        }

        const { ensureCodexAutoReplenish } = await import('../services/codex-auto-replenish.service.js');
        return ensureCodexAutoReplenish(this.globalConfig, {
            reason,
            force: options.force === true
        });
    }

    /**
     * 立即标记提供商为不健康（用于认证错误）
     */
    async markProviderUnhealthyImmediately(providerType, providerOrUuid, errorMessage = null, context = {}) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for markProviderUnhealthyImmediately');
            return;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return;
        }
        if (provider.is_deleted) {
            console.warn(`[ProviderPoolManagerDB] Provider already deleted: ${uuid}`);
            return;
        }

        const prevStatus = this._getProviderStatus(provider);
        const isForbidden = typeof errorMessage === 'string' && /\b403\b/.test(errorMessage);
        if (isForbidden) {
            // 判断是否为永久性 403（账号被封禁/suspended）
            const isPermanent403 = typeof errorMessage === 'string' && (
                /suspended/i.test(errorMessage) ||
                /token\s*refresh\s*failed/i.test(errorMessage)
            );

            if (isPermanent403) {
                console.log(`[ProviderPoolManagerDB] Marked provider ${uuid} as deleted due to permanent 403: ${errorMessage}`);
                await this.markProviderDeleted(providerType, provider, errorMessage, {
                    ...context,
                    action: context.action || 'mark_deleted',
                    source: context.source || 'system',
                    metadata: {
                        ...(context.metadata || {}),
                        statusCode: 403
                    }
                });
                return;
            }

            // 可恢复 403：标记不健康，设置恢复时间（3 分钟后自动重试）
            const recoveryDelay = 3 * 60 * 1000; // 3 minutes
            const recoveryTime = new Date(Date.now() + recoveryDelay);
            console.log(`[ProviderPoolManagerDB] Provider ${uuid} got recoverable 403, scheduling recovery at ${recoveryTime.toISOString()}: ${errorMessage}`);

            await providerDao.update(uuid, {
                is_healthy: false,
                error_count: (provider.error_count || 0) + 1,
                last_error_time: new Date(),
                last_error_message: errorMessage,
                scheduled_recovery_time: recoveryTime
            });

            await this._persistRelayState(providerType, provider, RELAY_STATES.COOLDOWN, {
                action: context.action || 'mark_unhealthy_403_recoverable',
                source: context.source || 'system',
                reason: context.reason || errorMessage,
                statusCode: 403,
                recoverAt: recoveryTime,
                metadata: context.metadata || null
            });

            this._recordStatusLog({
                provider,
                providerType,
                action: context.action || 'mark_unhealthy_403_recoverable',
                fromStatus: prevStatus,
                toStatus: 'unhealthy',
                reason: context.reason || errorMessage,
                source: context.source || 'system',
                metadata: context.metadata || null
            });
            return;
        }

        console.log(`[ProviderPoolManagerDB] Immediately marked provider ${uuid} as unhealthy`);

        const nextStatus = this._getProviderStatus({ ...provider, is_healthy: false });
        if (prevStatus !== nextStatus) {
            this._recordStatusLog({
                provider,
                providerType,
                action: context.action || 'mark_unhealthy_immediate',
                fromStatus: prevStatus,
                toStatus: nextStatus,
                reason: context.reason || errorMessage,
                source: context.source || 'system',
                metadata: context.metadata || null
            });
        }

        // 同步更新数据库，确保后续 selectProvider 能读到最新状态
        await providerDao.markUnhealthy(uuid, {
            errorCount: this.maxErrorCount,
            errorMessage: errorMessage,
            isHealthy: false
        });

        const immediateStatusCode = normalizeStatusCode(context?.metadata?.statusCode, errorMessage);
        const immediateRelayState = inferRelayState(provider, errorMessage, immediateStatusCode);
        await this._persistRelayState(providerType, provider, immediateRelayState, {
            action: context.action || 'mark_unhealthy_immediate',
            source: context.source || 'system',
            reason: context.reason || errorMessage,
            statusCode: immediateStatusCode,
            metadata: context.metadata || null
        });
    }

    /**
     * 标记提供商为不健康并设置恢复时间（用于配额耗尽）
     */
    async markProviderUnhealthyWithRecoveryTime(providerType, providerOrUuid, recoveryTime, errorMessage = null, context = {}) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for markProviderUnhealthyWithRecoveryTime');
            return;
        }
        if (typeof recoveryTime === 'string' && errorMessage instanceof Date) {
            const swappedRecoveryTime = errorMessage;
            errorMessage = recoveryTime;
            recoveryTime = swappedRecoveryTime;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return;
        }
        if (provider.is_deleted) {
            console.warn(`[ProviderPoolManagerDB] Provider already deleted: ${uuid}`);
            return;
        }

        // 去重保护：已在 cooldown 且当前恢复时间 >= 新恢复时间时，跳过重复标记
        const credentials = this._getProviderCredentials(provider);
        const currentRelayState = String(credentials?.relayState || '').trim().toLowerCase();
        const currentRecoverRaw = credentials?.relayStateRecoverAt || provider?.scheduled_recovery_time;
        const currentRecoverMs = currentRecoverRaw ? new Date(currentRecoverRaw).getTime() : NaN;
        const nextRecoverMs = recoveryTime ? new Date(recoveryTime).getTime() : NaN;
        const alreadyCooling = !provider.is_healthy
            && (currentRelayState === RELAY_STATES.COOLDOWN || currentRelayState === RELAY_STATES.OVERLOADED);
        if (
            alreadyCooling
            && Number.isFinite(currentRecoverMs)
            && currentRecoverMs > Date.now()
            && Number.isFinite(nextRecoverMs)
            && currentRecoverMs >= nextRecoverMs
            && context?.force !== true
        ) {
            // 静默 return —— 每次 usage refresh 几乎所有 quota-exhausted 账号都会命中这里,
            // 原本每次打印一整行 ISO timestamp,×178 providers × 144 cycles = 20k/天,没诊断价值
            return;
        }

        console.log(`[ProviderPoolManagerDB] Marked provider ${uuid} as unhealthy with recovery time: ${recoveryTime}`);

        // 注意：状态日志由 _persistRelayState 统一记录，此处不再提前记录，
        // 避免产生 健康→异常→冷却 的重复日志（实际应直接 健康→冷却）

        // 更新数据库（同步等待，确保后续选号能读到最新状态）
        await providerDao.update(uuid, {
            is_healthy: false,
            error_count: this.maxErrorCount,
            last_error_time: new Date(),
            last_error_message: errorMessage,
            scheduled_recovery_time: recoveryTime
        });

        const statusCode = normalizeStatusCode(context?.metadata?.statusCode, errorMessage);
        const inferredState = inferRelayState(provider, errorMessage, statusCode);
        const relayState = inferredState === RELAY_STATES.UNHEALTHY
            ? RELAY_STATES.COOLDOWN
            : inferredState;
        await this._persistRelayState(providerType, provider, relayState, {
            action: context.action || 'mark_unhealthy_recovery',
            source: context.source || 'system',
            reason: context.reason || errorMessage,
            statusCode,
            recoverAt: recoveryTime,
            metadata: {
                recoveryTime: recoveryTime instanceof Date ? recoveryTime.toISOString() : recoveryTime,
                ...(context.metadata || {})
            }
        });

        // 记录坏号（带恢复时间的错误，如429、配额耗尽等）
        const errorType = this._detectErrorType(errorMessage);
        const errorCode = normalizeStatusCode(null, errorMessage);
        this._recordBadAccount(providerType, provider, errorType, errorMessage, errorCode);
    }

    /**
     * 标记提供商为健康
     */
    async markProviderHealthy(providerType, providerOrUuid, context = {}) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for markProviderHealthy');
            return;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return;
        }

        console.log(`[ProviderPoolManagerDB] Marked provider ${uuid} as healthy`);

        // 同步更新数据库，确保状态持久化
        if (provider.is_deleted) {
            await providerDao.recoverDeleted(uuid);
        } else {
            await providerDao.markHealthy(uuid);
        }

        const providerAfterRecover = {
            ...provider,
            is_deleted: false,
            is_healthy: true,
            error_count: 0,
            last_error_time: null,
            last_error_message: null,
            scheduled_recovery_time: null
        };

        await this._persistRelayState(providerType, providerAfterRecover, RELAY_STATES.HEALTHY, {
            action: context.action || 'mark_healthy',
            source: context.source || 'system',
            reason: context.reason || null,
            metadata: context.metadata || null
        });
    }

    /**
     * 记录请求成功
     */
    async recordRequestSuccess() {
        this._globalStats.totalRequests++;
        this._globalStats.successRequests++;

        // 异步更新数据库
        statsDao.incrementStats('total_requests', 1).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to increment total_requests:`, err);
        });
        statsDao.incrementStats('successful_requests', 1).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to increment successful_requests:`, err);
        });
    }

    /**
     * 记录请求失败
     */
    async recordRequestFailure() {
        this._globalStats.totalRequests++;
        this._globalStats.failedRequests++;

        // 异步更新数据库
        statsDao.incrementStats('total_requests', 1).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to increment total_requests:`, err);
        });
        statsDao.incrementStats('failed_requests', 1).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to increment failed_requests:`, err);
        });
    }

    /**
     * 记录切号事件
     */
    async recordCredentialSwitch() {
        this._globalStats.switchCount++;

        // 异步更新数据库
        statsDao.incrementStats('switch_count', 1).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to increment switch_count:`, err);
        });
    }

    /**
     * 记录请求日志（成功或失败）
     */
    async recordRequestLog(options = {}) {
        const {
            providerType,
            providerUuid,
            poolId = 0,  // 直接从调用方传入，避免每次查询数据库
            model,
            statusCode,
            isSuccess = true,
            errorType,
            errorMessage,
            errorStack,
            errorDetail,
            curlCommand,
            inputTokens = 0,
            outputTokens = 0,
            cacheCreationTokens = 0,
            cacheReadTokens = 0,
            creditUsage,
            durationMs = 0,
            ttftMs = null,
            clientIp,
            userAgent,
            clientTokenId,
            userId,
            userEmail,
            username,
            proxyNodeId,
            proxyNodeName,
            proxyNodeHost,
            proxyNodePort,
            proxyNodeProtocol
        } = options;

        const logRecord = {
            providerUuid,
            providerType,
            poolId,
            requestModel: model,
            statusCode,
            isSuccess,
            errorType,
            errorMessage,
            errorStack,
            errorDetail,
            curlCommand,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            creditUsage,
            durationMs,
            ttftMs,
            clientIp,
            userAgent,
            clientTokenId,
            userId,
            userEmail,
            username,
            proxyNodeId,
            proxyNodeName,
            proxyNodeHost,
            proxyNodePort,
            proxyNodeProtocol
        };

        // 优先使用 Redis 队列异步写入，降级时直接写数据库
        if (isLogQueueAvailable()) {
            pushRequestLog(logRecord).catch(err => {
                console.error(`[ProviderPoolManagerDB] Failed to push request log to queue:`, err);
            });
        } else {
            // Redis 不可用时降级为直接写入
            requestLogsDao.create(logRecord).catch(err => {
                console.error(`[ProviderPoolManagerDB] Failed to record request log:`, err);
            });
        }
    }

    /**
     * 记录错误
     */
    async recordError(providerType, uuid, errorMessage, statusCode = null, model = null, customName = null) {
        const normalizedStatusCode = normalizeStatusCode(statusCode, errorMessage);

        // 获取 provider 的 pool_id（数据库直读）
        let poolId = 0;
        let provider = null;
        try {
            provider = await providerDao.findByUuid(uuid);
            poolId = provider?.pool_id ?? 0;
        } catch (error) {
            console.warn(`[ProviderPoolManagerDB] Failed to resolve pool_id for error log:`, error.message);
        }

        // 更新 provider 的 last_error_message 和 last_error_time
        if (provider) {
            providerDao.update(uuid, {
                last_error_message: errorMessage,
                last_error_time: new Date()
            }).catch(err => {
                console.error(`[ProviderPoolManagerDB] Failed to update provider error info:`, err);
            });
        }

        // 异步写入 provider_error_logs 表
        providerErrorLogsDao.create({
            providerUuid: uuid,
            providerType,
            poolId,
            requestModel: model,
            errorCode: normalizedStatusCode,
            errorType: this._detectErrorType(errorMessage),
            errorMessage
        }).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to record error:`, err);
        });
    }

    /**
     * 获取号池统计
     */
    async getPoolStats() {
        const stats = {
            providerTypes: {},
            totalAccounts: 0,
            totalHealthy: 0,
            totalUnhealthy: 0
        };

        const providerTypes = await providerDao.getProviderTypes({ includeDeleted: true });
        for (const providerType of providerTypes) {
            const counts = await providerDao.getTypeCounts(providerType, 'all');
            const totalActive = counts.totalActive ?? 0;
            const healthy = counts.healthyCount ?? 0;
            const unhealthy = counts.unhealthyCount ?? 0;
            const disabled = counts.disabledCount ?? 0;

            stats.providerTypes[providerType] = {
                total: totalActive,
                healthy,
                unhealthy,
                disabled
            };

            stats.totalAccounts += totalActive;
            stats.totalHealthy += healthy;
            stats.totalUnhealthy += unhealthy;
        }

        const dbStats = await statsDao.getGlobalStats().catch(() => null);

        return {
            ...stats,
            globalStats: normalizeGlobalStats(dbStats)
        };
    }

    /**
     * 获取提供商池
     *
     * Phase 1 改动:includeDeleted 默认从 true 改为 false。
     * 旧行为会把墓碑 provider 也返回,导致上游 init 循环创建不必要的 adapter 实例。
     * 需要恢复/检测已删除节点的路径(如 performHealthChecks 的 kiro 恢复逻辑)应在调用时显式传
     * { includeDeleted: true }。
     *
     * @param {string|null} providerType
     * @param {Object} [options]
     * @param {boolean} [options.includeDeleted=false]
     */
    async getProviderPools(providerType = null, options = {}) {
        const includeDeleted = options?.includeDeleted === true;
        if (providerType) {
            return await providerDao.findAll(providerType, { includeDeleted });
        }
        const allProviders = await providerDao.findAll(null, { includeDeleted });
        const grouped = {};
        for (const provider of allProviders) {
            const type = provider.provider_type;
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(provider);
        }
        return grouped;
    }

    /**
     * 选择提供商（严格模式：不跨 provider fallback）
     * @param {string} providerType - 提供商类型
     * @param {string} requestedModel - 请求的模型（可选）
     * @param {Object} options - 选项
     * @returns {Object|null} 包含选中配置和元数据的对象
     */
    async selectProviderWithFallback(providerType, requestedModel = null, options = {}) {
        const selectedConfig = await this.selectProvider(providerType, requestedModel, options);

        if (selectedConfig) {
            return {
                config: selectedConfig,
                actualProviderType: providerType,
                isFallback: false,
                actualModel: requestedModel
            };
        }

        console.log(`[ProviderPoolManagerDB] Strict routing: no fallback provider for ${providerType}`);
        return null;
    }

    /**
     * 执行健康检查
     * 检测不健康的 provider，尝试恢复
     */
    async performHealthChecks(isInit = false) {
        console.log(`[ProviderPoolManagerDB] Starting health checks (isInit: ${isInit})...`);

        const providerTypes = await providerDao.getProviderTypes({ includeDeleted: true });
        let totalChecked = 0;
        let totalRecovered = 0;

        for (const providerType of providerTypes) {
            // 渠道级别健康检测开关
            const channelCfg = await channelConfigDao.getByProviderType(providerType);
            const channelHealthCheck = channelCfg?.config?.healthCheckEnabled;
            if (channelHealthCheck === false || channelHealthCheck === 'false') {
                console.log(`[ProviderPoolManagerDB] Health check disabled for channel ${providerType}, skipping`);
                continue;
            }

            // 加载池子配置，用于池子级别判断
            const pools = await providerPoolDao.findByType(providerType);
            const poolHealthCheckMap = new Map();
            for (const pool of pools) {
                poolHealthCheckMap.set(pool.id, pool.enable_health_check !== false);
            }

            // kiro 需要 includeDeleted 用于恢复逻辑；其他渠道不加载已删除记录，减少资源浪费
            const includeDeletedForRecovery = providerType === 'claude-kiro-oauth';
            const providers = await providerDao.findAll(providerType, { includeDeleted: includeDeletedForRecovery });
            const unhealthyProviders = providers.filter(p => {
                // Phase 2+3: 每个 worker 只对自己 shard 的 provider 做健康检查,避免 N 个 worker 重复检测同一 provider
                if (SHARD_ENABLED && !ownsUuid(p.uuid)) return false;
                if (!this._isHealthCheckEnabled(p)) return false;
                if (!p.is_healthy && !p.is_disabled && (includeDeletedForRecovery || !p.is_deleted)) {
                    // 池子级别开关：如果 provider 有 pool_id 且该池子禁用了健康检测，跳过
                    if (p.pool_id != null && poolHealthCheckMap.has(p.pool_id) && !poolHealthCheckMap.get(p.pool_id)) {
                        return false;
                    }
                    return true;
                }
                return false;
            });

            if (unhealthyProviders.length === 0) continue;

            console.log(`[ProviderPoolManagerDB] Checking ${unhealthyProviders.length} unhealthy providers for ${providerType}`);

            for (const provider of unhealthyProviders) {
                // 冷却中且恢复时间未到的 provider，跳过健康检查，避免反复 冷却→健康→冷却
                const credentials = this._getProviderCredentials(provider);
                const relayState = String(credentials?.relayState || '').trim().toLowerCase();
                if (relayState === RELAY_STATES.COOLDOWN || relayState === RELAY_STATES.OVERLOADED) {
                    const recoverAtRaw = credentials?.relayStateRecoverAt || provider?.scheduled_recovery_time;
                    const recoverAtMs = recoverAtRaw ? new Date(recoverAtRaw).getTime() : NaN;
                    if (Number.isFinite(recoverAtMs) && recoverAtMs > Date.now()) {
                        console.log(`[ProviderPoolManagerDB] Skip health check for ${provider.uuid} — still in ${relayState} until ${new Date(recoverAtMs).toISOString()}`);
                        continue;
                    }
                }

                totalChecked++;
                const maxRetries = 2; // 最多尝试 2 次（首次 + 1 次重试）
                let lastError = null;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        const result = await this._checkProviderHealth(providerType, provider, false, null, {
                            source: 'scheduled_health_check'
                        });
                        if (result && result.success) {
                            await this.markProviderHealthy(providerType, provider.uuid, {
                                source: 'scheduled_health_check',
                                action: 'health_check_recover'
                            });
                            totalRecovered++;
                            console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} recovered (attempt ${attempt})`);
                            lastError = null;
                            break;
                        }
                        // result 不为 null 但 success=false，说明是明确失败（如 403），不重试
                        if (result && !result.success) {
                            lastError = result.errorMessage;
                            break;
                        }
                        lastError = 'unsupported provider type';
                        break;
                    } catch (error) {
                        lastError = error.message;
                        if (attempt < maxRetries) {
                            const delay = attempt * 3000; // 3s 后重试
                            console.log(`[ProviderPoolManagerDB] Health check attempt ${attempt} failed for ${provider.uuid}, retrying in ${delay}ms...`);
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }
                }
                if (lastError) {
                    console.error(`[ProviderPoolManagerDB] Health check failed for ${provider.uuid} after ${maxRetries} attempts:`, lastError);
                }
            }
        }

        console.log(`[ProviderPoolManagerDB] Health checks completed: ${totalChecked} checked, ${totalRecovered} recovered`);
    }

    /**
     * 检查单个 provider 的健康状态
     * @param {string} providerType - 提供商类型
     * @param {Object} provider - 提供商配置
     * @param {boolean} forceCheck - 是否强制检查
     * @param {string} checkModelName - 指定检测模型名称
     */
    async _checkProviderHealth(providerType, provider, forceCheck = false, checkModelName = null, context = {}) {
        // 支持健康检测的 provider 类型
        const supportedTypes = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-custom', 'claude-offical', 'openai-codex', 'openai-xai-oauth'];

        if (!supportedTypes.includes(providerType)) {
            return null;
        }

        const startTime = Date.now();
        let requestLogId = null;

        try {
            const { peekServiceAdapter, getServiceAdapter } = await import('./adapter.js');
            const { CONFIG } = await import('../core/config-manager.js');

            const providerKey = providerType + (provider.uuid || '');
            let adapter = peekServiceAdapter(providerKey);

            // 如果没有 adapter，尝试初始化
            if (!adapter) {
                const credentials = provider.credentials || provider;
                const serviceConfig = {
                    ...CONFIG,
                    ...credentials,
                    uuid: provider.uuid,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            }

            if (!adapter) {
                return null;
            }

            // Kiro 健康检测要求：token 刷新成功才算健康
            // 否则会出现 refresh 失败（如 500）但被后续检测误判为健康的情况
            if (providerType === 'claude-kiro-oauth') {
                // 优先走 initializeAuth(true)：内部有最小刷新间隔保护，避免高频强刷导致 403 抖动
                if (adapter.kiroApiService && typeof adapter.kiroApiService.initializeAuth === 'function') {
                    await adapter.kiroApiService.initializeAuth(true, true);
                } else if (typeof adapter.initializeAuth === 'function') {
                    await adapter.initializeAuth(true, true);
                } else if (typeof adapter._refreshTokenWithDistributedLock === 'function') {
                    await adapter._refreshTokenWithDistributedLock(true);
                }
            }

            // 如果指定了检测模型，使用模型调用检测
            const resolvedCheckModel = checkModelName || (providerType === 'openai-xai-oauth' ? 'grok-4.5' : null);
            if (resolvedCheckModel) {
                const xaiMediaModel = xaiModelBase(resolvedCheckModel);
                if (
                    providerType === 'openai-xai-oauth'
                    && XAI_IMAGE_MODEL_SET.has(xaiMediaModel)
                    && typeof adapter.generateImage === 'function'
                ) {
                    const result = await adapter.generateImage(xaiMediaModel, {
                        model: xaiMediaModel,
                        prompt: 'A simple blue square on a white background',
                        n: 1,
                        response_format: 'url',
                        __image_action: 'generate'
                    });
                    const imageCount = Array.isArray(result?.data)
                        ? result.data.length
                        : (Array.isArray(result?.images) ? result.images.length : 0);
                    if (imageCount === 0) {
                        throw new Error('xAI image test returned no image');
                    }
                    return {
                        success: true,
                        modelName: resolvedCheckModel,
                        message: `Image generation succeeded (${imageCount})`
                    };
                }

                if (
                    providerType === 'openai-xai-oauth'
                    && XAI_VIDEO_MODEL_SET.has(xaiMediaModel)
                    && typeof adapter.generateVideo === 'function'
                ) {
                    const result = await adapter.generateVideo(xaiMediaModel, {
                        model: xaiMediaModel,
                        prompt: 'A blue square slowly rotates on a white background',
                        duration: 1,
                        aspect_ratio: '9:16',
                        resolution: '480p',
                        __video_action: 'generate'
                    });
                    const requestId = extractXaiVideoId(result);
                    if (!requestId) {
                        throw new Error('xAI video test returned no request_id');
                    }
                    return {
                        success: true,
                        modelName: resolvedCheckModel,
                        message: `Video task submitted (${requestId})`
                    };
                }

                if (typeof adapter.chat === 'function') {
                    const testMessages = [{ role: 'user', content: 'Hi' }];
                    await adapter.chat(testMessages, { model: resolvedCheckModel, max_tokens: 5 });
                    return { success: true, modelName: resolvedCheckModel };
                }

                if (
                    (providerType === 'openai-codex' || providerType === 'openai-xai-oauth')
                    && typeof adapter.generateContent === 'function'
                ) {
                    await adapter.generateContent(resolvedCheckModel, {
                        model: resolvedCheckModel,
                        input: [
                            {
                                role: 'user',
                                content: [{ type: 'input_text', text: 'hi' }]
                            }
                        ],
                        max_output_tokens: 8,
                        stream: true
                    });
                    return { success: true, modelName: resolvedCheckModel };
                }
            }

            if (typeof adapter.getUsageLimits !== 'function') {
                return null;
            }

            // 记录健康检查请求开始
            try {
                const logData = {
                    providerUuid: provider.uuid,
                    providerType: providerType,
                    model: 'health-check',
                    endpoint: '/getUsageLimits',
                    method: 'GET',
                    statusCode: null,
                    errorMessage: null,
                    requestTime: new Date(startTime),
                    responseTime: null,
                    duration: null,
                    source: context.source || 'health_check'
                };
                const result = await requestLogsDao.create(logData);
                requestLogId = result?.insertId || result?.id;
            } catch (logErr) {
                console.warn('[ProviderPoolManagerDB] Failed to create health check request log:', logErr.message);
            }

            // 默认调用 getUsageLimits 检测健康状态
            const usageData = await adapter.getUsageLimits();

            // 如果 adapter 有 parseUsageInfo 方法（Kiro），解析并保存用量信息
            if (usageData && typeof adapter.parseUsageInfo === 'function') {
                try {
                    const usageInfo = adapter.parseUsageInfo(usageData);
                    if (usageInfo) {
                        await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                        console.log(`[ProviderPoolManagerDB] Updated usage info for ${provider.uuid}: ${usageInfo.subscriptionTitle}, ${usageInfo.currentUsage}/${usageInfo.usageLimit}`);
                    }
                } catch (parseErr) {
                    console.warn(`[ProviderPoolManagerDB] Failed to parse/save usage info:`, parseErr.message);
                }
            }

            // 如果 adapter 有 listAvailableModels 方法（Kiro），获取并保存可用模型列表
            if (typeof adapter.listAvailableModels === 'function') {
                try {
                    const modelsData = await adapter.listAvailableModels();
                    if (modelsData && typeof adapter.parseAvailableModels === 'function') {
                        const availableModels = adapter.parseAvailableModels(modelsData);
                        if (availableModels && availableModels.length > 0) {
                            await providerDao.updateAvailableModels(provider.uuid, availableModels);
                            console.log(`[ProviderPoolManagerDB] Updated available models for ${provider.uuid}: ${availableModels.join(', ')}`);
                        }
                    }
                } catch (modelsErr) {
                    console.warn(`[ProviderPoolManagerDB] Failed to fetch/save available models:`, modelsErr.message);
                }
            }

            // 更新请求日志为成功
            if (requestLogId) {
                try {
                    const duration = Date.now() - startTime;
                    await requestLogsDao.update(requestLogId, {
                        statusCode: 200,
                        responseTime: new Date(),
                        duration: duration
                    });
                } catch (logErr) {
                    console.warn('[ProviderPoolManagerDB] Failed to update health check request log:', logErr.message);
                }
            }

            return { success: true };
        } catch (error) {
            const errorMsg = formatHealthCheckErrorMessage(error);
            const duration = Date.now() - startTime;

            // 提取状态码
            const statusCode = error.response?.status || error.status || (errorMsg.includes('400') ? 400 : (errorMsg.includes('403') ? 403 : null));

            // 更新请求日志为失败
            if (requestLogId) {
                try {
                    await requestLogsDao.update(requestLogId, {
                        statusCode: statusCode,
                        errorMessage: errorMsg,
                        responseTime: new Date(),
                        duration: duration
                    });
                } catch (logErr) {
                    console.warn('[ProviderPoolManagerDB] Failed to update health check error log:', logErr.message);
                }
            }

            // Codex 永久性认证失败检测（token_invalidated / invalid_api_key / suspended 等）
            const isCodexPermanentAuth = providerType === 'openai-codex'
                && statusCode === 401
                && /token[_\s-]?invalidated|invalid[_\s-]?api[_\s-]?key|account[_\s-]?(suspended|deactivated|banned|terminated)|token[_\s-]?(revoked|disabled)|authentication\s+token\s+has\s+been\s+invalidated/i.test(errorMsg);

            if (error?.shouldDeleteCredential === true || (providerType === 'openai-codex' && statusCode === 402) || isCodexPermanentAuth) {
                await this.markProviderDeleted(providerType, provider, errorMsg, {
                    action: context.action || (isCodexPermanentAuth ? 'mark_deleted_token_invalidated' : 'mark_deleted_health_check'),
                    source: context.source || 'health_check',
                    metadata: {
                        ...(context.metadata || {}),
                        statusCode,
                        ...(isCodexPermanentAuth ? { errorCode: 'token_invalidated' } : {})
                    }
                });
                console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} marked as deleted (${isCodexPermanentAuth ? 'token_invalidated' : 'permanent credential failure'})`);
                return { success: false, errorMessage: errorMsg };
            }

            // Kiro token 刷新失败（含 HTTP 500）统一进入删除池，避免误判健康
            if (providerType === 'claude-kiro-oauth' && /token\s*refresh\s*failed/i.test(errorMsg)) {
                const prevStatus = this._getProviderStatus(provider);
                await providerDao.markDeleted(provider.uuid, errorMsg);
                provider.is_deleted = true;
                provider.is_healthy = false;
                console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} marked as deleted (token refresh failed)`);
                this._recordStatusLog({
                    provider,
                    providerType,
                    action: context.action || 'mark_deleted',
                    fromStatus: prevStatus,
                    toStatus: 'deleted',
                    reason: context.reason || errorMsg,
                    source: context.source || 'system',
                    metadata: context.metadata || null
                });
                return { success: false, errorMessage: errorMsg };
            }

            // 403 错误：区分永久性和可恢复
            if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
                const isPermanent403 = /suspended/i.test(errorMsg) || /token\s*refresh\s*failed/i.test(errorMsg);
                const prevStatus = this._getProviderStatus(provider);

                if (isPermanent403) {
                    await providerDao.markDeleted(provider.uuid, errorMsg);
                    provider.is_deleted = true;
                    provider.is_healthy = false;
                    console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} marked as deleted (permanent 403)`);
                    this._recordStatusLog({
                        provider,
                        providerType,
                        action: context.action || 'mark_deleted',
                        fromStatus: prevStatus,
                        toStatus: 'deleted',
                        reason: context.reason || errorMsg,
                        source: context.source || 'system',
                        metadata: context.metadata || null
                    });
                    return { success: false, errorMessage: errorMsg };
                }

                // 可恢复 403：标记不健康，设置 3 分钟恢复
                const recoveryTime = new Date(Date.now() + 3 * 60 * 1000);
                await providerDao.update(provider.uuid, {
                    is_healthy: false,
                    error_count: (provider.error_count || 0) + 1,
                    last_error_time: new Date(),
                    last_error_message: errorMsg,
                    scheduled_recovery_time: recoveryTime
                });
                provider.is_healthy = false;
                console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} got recoverable 403 in health check, recovery at ${recoveryTime.toISOString()}`);
                this._recordStatusLog({
                    provider,
                    providerType,
                    action: context.action || 'mark_unhealthy_403_recoverable',
                    fromStatus: prevStatus,
                    toStatus: 'unhealthy',
                    reason: context.reason || errorMsg,
                    source: context.source || 'system',
                    metadata: context.metadata || null
                });
                return { success: false, errorMessage: errorMsg };
            }

            // 400 错误不影响健康状态（可能是健康检查接口问题，但实际使用正常）
            if (providerType !== 'claude-custom' && providerType !== 'claude-offical' && (errorMsg.includes('400') || errorMsg.includes('Bad request') || errorMsg.includes('Improperly formed'))) {
                console.log(`[ProviderPoolManagerDB] Provider ${provider.uuid} health check got 400, but treating as healthy (actual usage may be fine)`);
                return { success: true, ignored400: true, errorMessage: errorMsg };
            }

            return { success: false, errorMessage: errorMsg };
        }
    }

    /**
     * 刷新提供商 UUID
     */
    async refreshProviderUuid(providerType, providerOrUuid) {
        const uuid = this._resolveProviderUuid(providerOrUuid);
        if (!uuid) {
            console.warn('[ProviderPoolManagerDB] Provider uuid missing for refreshProviderUuid');
            return null;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            console.warn(`[ProviderPoolManagerDB] Provider not found: ${uuid}`);
            return null;
        }
        if (provider.is_deleted) {
            console.warn(`[ProviderPoolManagerDB] Provider already deleted: ${uuid}`);
            return null;
        }

        const newUuid = generateUUID();
        const providerTypeValue = provider.provider_type || providerType;
        const credentials = provider.credentials || {};
        const oauthCredentialId = provider.oauth_credential_id || credentials.oauthCredentialId || null;
        const updatedCredentials = { ...credentials, uuid: newUuid, oauthCredentialId };

        try {
            await providerDao.update(uuid, {
                uuid: newUuid,
                credentials: updatedCredentials
            });
            if (oauthCredentialId) {
                await oauthCredentialsDao.markUsed(oauthCredentialId, newUuid);
            }
        } catch (error) {
            console.error(`[ProviderPoolManagerDB] Failed to refresh UUID for ${uuid}:`, error.message);
            return null;
        }

        const logUpdateTasks = [
            requestLogsDao.updateProviderUuid(uuid, newUuid),
            providerErrorLogsDao.updateProviderUuid(uuid, newUuid)
        ];
        const logUpdateResults = await Promise.allSettled(logUpdateTasks);
        logUpdateResults.forEach((result) => {
            if (result.status === 'rejected') {
                console.warn('[ProviderPoolManagerDB] Failed to update logs for refreshed UUID:', result.reason?.message || result.reason);
            }
        });

        // Phase 1 改动:uuid 被刷新(旧 uuid 作废),清理所有绑定到旧 uuid 的 adapter 实例
        // 含所有 proxy 变体,并正确 dispose 底层资源
        try {
            const { deleteServiceInstancesByUuid } = await import('./adapter.js');
            const removed = deleteServiceInstancesByUuid(uuid);
            if (removed > 0) {
                console.log(`[ProviderPoolManagerDB] Disposed ${removed} adapter(s) for refreshed uuid ${uuid}`);
            }
            this._broadcastProviderRemovedToWorkers(providerTypeValue, uuid);
        } catch (error) {
            console.warn('[ProviderPoolManagerDB] Failed to cleanup old service instance:', error.message);
        }

        console.log(`[ProviderPoolManagerDB] Refreshed provider uuid: ${uuid} -> ${newUuid}`);
        return newUuid;
    }

    /**
     * 启动定时健康检测
     */
    startHealthCheckInterval(intervalMinutes = 5) {
        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
        }

        const intervalMs = intervalMinutes * 60 * 1000;
        console.log(`[ProviderPoolManagerDB] Starting health check interval: every ${intervalMinutes} minutes`);

        this.triggerCodexAutoReplenish('interval_start').catch((error) => {
            console.error('[ProviderPoolManagerDB] Initial codex auto replenish failed:', error.message);
        });

        this._healthCheckInterval = setInterval(async () => {
            try {
                this._cleanupStickySessionBindings();
                this._cleanExpiredModelQuotaProtections();
                await this.performHealthChecks(false);
                await this.refreshExpiringProviders();
                await this.triggerCodexAutoReplenish('scheduled_health_check');
            } catch (error) {
                console.error('[ProviderPoolManagerDB] Scheduled health check failed:', error);
            }
        }, intervalMs);
    }

    /**
     * 停止定时健康检测
     */
    stopHealthCheckInterval() {
        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
            this._healthCheckInterval = null;
            console.log('[ProviderPoolManagerDB] Health check interval stopped');
        }
    }

    /**
     * 重新加载提供商数据（用于配置重载）
     */
    async reload(options = {}) {
        console.log('[ProviderPoolManagerDB] Reloading provider data from database...');

        try {
            await this._ensureDefaultPools();
            const allProviders = await providerDao.findAll(null, { includeDeleted: true });
            for (const provider of allProviders) {
                this._ensureRefreshFields(provider);
            }

            console.log(`[ProviderPoolManagerDB] Reloaded ${allProviders.length} providers`);

            const shouldBroadcast = options.broadcast !== false;
            // Phase 2+3 补丁:admin 进程也可以广播 reload
            // admin 的 process.send 走 stdio IPC → master.js 的 adminProcess.on('message') 转发
            const canBroadcast = (process.env.IS_WORKER_PROCESS === 'true'
                || process.env.IS_ADMIN_PROCESS === 'true')
                && typeof process.send === 'function';
            if (shouldBroadcast && canBroadcast) {
                process.send({
                    type: 'provider_pool_reload',
                    originPid: process.pid
                });
            }
        } catch (error) {
            console.error('[ProviderPoolManagerDB] Reload failed:', error);
            throw error;
        }
    }

    /**
     * 广播 provider 删除事件给 master,由 master 再分发给所有 worker。
     *
     * Phase 1 改动:当某个 worker 因为 auto-delete / uuid 刷新等原因清理掉本地 adapter 时,
     * 其他 worker 本地也可能缓存了同一 uuid 的 adapter 副本,必须一并 dispose,否则:
     *   - 墓碑 adapter 持续占用内存
     *   - 若后续请求落到其他 worker 且复用了旧 adapter,会用到已失效的 credentials
     *
     * master.js 已有 `broadcast_event` 通道,这里直接复用,由各 worker 的
     * api-server.js 消息处理器识别 eventType === 'provider_removed' 后清理。
     *
     * 在 admin 进程或非 IPC 环境下静默跳过(不抛异常)。
     */
    _broadcastProviderRemovedToWorkers(providerType, uuid) {
        if (!uuid) return;
        // Phase 2+3 补丁:worker 和 admin 都可以广播
        const canBroadcast = (process.env.IS_WORKER_PROCESS === 'true'
            || process.env.IS_ADMIN_PROCESS === 'true')
            && typeof process.send === 'function';
        if (!canBroadcast) return;
        try {
            process.send({
                type: 'broadcast_event',
                originPid: process.pid,
                eventType: 'provider_removed',
                data: { providerType, uuid }
            });
        } catch (error) {
            console.warn('[ProviderPoolManagerDB] Failed to broadcast provider_removed:', error?.message || error);
        }
    }

    /**
     * 检测错误类型
     * @param {string} errorMessage - 错误信息
     * @returns {string} 错误类型
     * @private
     */
    _detectErrorType(errorMessage) {
        if (!errorMessage || typeof errorMessage !== 'string') {
            return 'unknown';
        }
        const msg = errorMessage.toLowerCase();
        if (msg.includes('organization has been disabled') || msg.includes('账号到期')) return 'account_expired';
        if (/\b403\b/.test(errorMessage)) return '403_forbidden';
        if (/\b429\b/.test(errorMessage)) return '429_rate_limit';
        if (/\b402\b/.test(errorMessage) || msg.includes('quota')) return 'quota_exceeded';
        if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('401')) return 'auth_failed';
        if (msg.includes('token') && msg.includes('expir')) return 'token_expired';
        if (/\b5\d{2}\b/.test(errorMessage)) return 'server_error';
        return 'unknown';
    }

    /**
     * 记录坏号到 bad_accounts 表
     * @param {string} providerType - 提供商类型
     * @param {Object} provider - 提供商对象
     * @param {string} errorType - 错误类型
     * @param {string} errorMessage - 错误信息
     * @param {number} errorCode - 错误状态码
     * @private
     */
    _recordBadAccount(providerType, provider, errorType, errorMessage, errorCode = null) {
        // 确定检测来源
        let detectionSource = 'manual';
        if (providerType === 'claude-kiro-oauth') {
            detectionSource = 'kiro';
        } else if (providerType?.includes('gemini')) {
            detectionSource = 'gemini';
        } else if (providerType === 'openai-codex') {
            detectionSource = 'codex';
        }

        // 获取显示名称
        const displayName = provider.custom_name ||
            provider.credentials?.email ||
            provider.credentials?.displayName ||
            provider.uuid;

        // 异步记录，不阻塞主流程
        badAccountsDao.create({
            providerType,
            poolId: provider.pool_id ?? 0,
            providerUuid: provider.uuid,
            oauthCredentialId: provider.oauth_credential_id,
            displayName,
            errorType,
            errorMessage,
            errorCode,
            detectionSource,
            isRecoverable: !['403_forbidden', 'account_expired'].includes(errorType)
        }).then(id => {
            console.log(`[ProviderPoolManagerDB] Bad account recorded: id=${id}, uuid=${provider.uuid}`);
        }).catch(err => {
            console.error(`[ProviderPoolManagerDB] Failed to record bad account:`, err);
        });
    }
}

function normalizeGlobalStats(stats) {
    if (!stats) {
        return {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            switchCount: 0,
            lastResetTime: 0
        };
    }
    return {
        totalRequests: stats.totalRequests ?? stats.total_requests ?? 0,
        successfulRequests: stats.successRequests ?? stats.successfulRequests ?? stats.successful_requests ?? 0,
        failedRequests: stats.failedRequests ?? stats.failed_requests ?? 0,
        switchCount: stats.switchCount ?? stats.switch_count ?? 0,
        lastResetTime: stats.lastResetTime ?? stats.last_reset_time ?? 0
    };
}
