import { CONFIG } from '../core/config-manager.js';
import { peekServiceAdapter, getServiceAdapter } from '../providers/adapter.js';
import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatCodexImageUsage, formatFoxcodeUsage, formatWindsurfUsage, formatXaiUsage } from '../services/usage-service.js';
import * as providerDao from '../dao/provider-dao.js';
import * as providerUsageDao from '../dao/provider-usage-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as providerStatusLogsDao from '../dao/provider-status-logs-dao.js';
import * as channelConfigDao from '../dao/channel-config-dao.js';
import path from 'path';
import { parseOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { resolveProviderStatus } from '../utils/provider-status.js';
import { selectBestCodexPlanTitle } from '../utils/codex-plan.js';

function getUsageThresholds(currentConfig = {}) {
    const warn = Number.isFinite(Number(currentConfig.USAGE_WARN_THRESHOLD))
        ? Number(currentConfig.USAGE_WARN_THRESHOLD)
        : 80;
    const disable = Number.isFinite(Number(currentConfig.USAGE_DISABLE_THRESHOLD))
        ? Number(currentConfig.USAGE_DISABLE_THRESHOLD)
        : 95;
    return {
        warn: Math.max(0, Math.min(100, warn)),
        disable: Math.max(0, Math.min(100, disable)),
        autoDisable: Boolean(currentConfig.USAGE_AUTO_DISABLE)
    };
}

function toNumber(value) {
    if (typeof value === 'string') {
        const cleaned = value.replace(/,/g, '').trim();
        if (!cleaned) return 0;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : 0;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function toOptionalNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function getErrorStatusCode(error) {
    const status = Number(error?.response?.status ?? error?.status);
    if (Number.isFinite(status) && status > 0) {
        return status;
    }
    const message = String(error?.message || '');
    if (/\b401\b/.test(message)) return 401;
    if (/\b403\b/.test(message)) return 403;
    return null;
}

function isUnauthorizedUsageError(error) {
    const statusCode = getErrorStatusCode(error);
    if (statusCode === 401) {
        return true;
    }

    const message = String(error?.message || '').toLowerCase();
    return (
        message.includes('unauthorized')
        || message.includes('invalid_token')
        || message.includes('invalid token')
        || message.includes('authentication failed')
    );
}

/**
 * 检测 Codex 401 错误是否为永久性认证失败（应直接删除账号）
 * token_invalidated / invalid_api_key / suspended / revoked / deactivated 等
 * 这些账号无法通过 refresh token 恢复，应直接标记为 deleted 而非 unhealthy
 */
function isPermanentCodexAuthFailure(error) {
    const message = String(error?.message || '').toLowerCase();
    const data = error?.response?.data;
    const combinedText = `${message} ${typeof data === 'string' ? data : JSON.stringify(data || '')}`.toLowerCase();

    const permanentPatterns = [
        /token[_\s-]?invalidated/,
        /token\s+(has\s+been\s+)?invalidated/,
        /invalid[_\s-]?api[_\s-]?key/,
        /account[_\s-]?(suspended|deactivated|banned|terminated)/,
        /token[_\s-]?(revoked|expired|disabled)/,
        /authentication\s+token\s+has\s+been\s+invalidated/
    ];

    return permanentPatterns.some(pattern => pattern.test(combinedText));
}

function resolveCodexCheckModelName(provider = {}) {
    const candidates = [
        provider.check_model_name,
        provider.checkModelName,
        provider.credentials?.checkModelName,
        provider.credentials?.check_model_name,
        'gpt-5.3-codex'
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return 'gpt-5.3-codex';
}

async function verifyCodexModelAvailability(providerType, provider, providerPoolManager) {
    if (!providerPoolManager || typeof providerPoolManager._checkProviderHealth !== 'function') {
        return {
            checked: false,
            success: false,
            errorMessage: 'Provider pool manager health check unavailable'
        };
    }

    const checkModelName = resolveCodexCheckModelName(provider);
    const healthResult = await providerPoolManager._checkProviderHealth(
        providerType,
        provider,
        true,
        checkModelName,
        {
            source: 'usage_refresh',
            action: 'usage_401_model_verify',
            reason: 'usage_401_model_verify',
            metadata: {
                statusCode: 401,
                checkModelName
            }
        }
    );

    return {
        checked: true,
        success: Boolean(healthResult?.success),
        checkModelName,
        errorMessage: healthResult?.errorMessage || null
    };
}

function computeUsageSummary(usage) {
    if (!usage || usage.error) {
        return null;
    }

    const breakdowns = Array.isArray(usage.usageBreakdown) ? usage.usageBreakdown : [];
    let used = 0;
    let limit = 0;
    let unit = '';
    let resetAt = null;
    let maxPercent = 0;
    let maxLabel = '';
    let minRemainingPercent = null;
    let hasPercentSignal = false;
    let preferredWindowPercent = null;
    let preferredWindowRemaining = null;
    let preferredWindowLabel = '';
    let preferredWindowResetAt = null;

    const isFiveHourWindow = (item = {}) => {
        const subscriptionId = String(item?.subscriptionId || '').trim().toLowerCase();
        const displayName = String(item?.displayName || item?.planName || '').trim().toLowerCase();
        if (subscriptionId === 'five_hour') return true;
        if (item?.resourceType === 'RATE_LIMIT' && item?.limitGroup === 'main' && item?.windowType === 'primary') return true;
        return displayName.includes('5小时') || displayName.includes('5h') || displayName.includes('five');
    };

    const toPercentSignal = (value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        return Math.max(0, Math.min(100, value));
    };

    for (const item of breakdowns) {
        const itemUsed = toNumber(item.currentUsage);
        const itemLimit = toNumber(item.usageLimit);
        used += itemUsed;
        limit += itemLimit;

        if (!unit && item.unit) {
            unit = String(item.unit);
        }
        if (!resetAt && item.nextDateReset) {
            resetAt = item.nextDateReset;
        }

        if (typeof item.remainingPercent === 'number') {
            hasPercentSignal = true;
            const remainingPercent = Math.max(0, Math.min(100, item.remainingPercent));
            const usedPercent = 100 - remainingPercent;
            if (usedPercent > maxPercent) {
                maxPercent = usedPercent;
                maxLabel = item.displayName || item.resourceType || '';
            }
            minRemainingPercent = minRemainingPercent === null
                ? remainingPercent
                : Math.min(minRemainingPercent, remainingPercent);
        } else if (itemLimit > 0) {
            const itemPercent = (itemUsed / itemLimit) * 100;
            if (itemPercent > maxPercent) {
                maxPercent = itemPercent;
                maxLabel = item.displayName || item.resourceType || '';
            }
        }

        if (isFiveHourWindow(item)) {
            const explicitUsedPercent = toPercentSignal(item.usedPercent);
            const explicitRemainingPercent = toPercentSignal(item.remainingPercent);
            const derivedUsedPercent = explicitUsedPercent !== null
                ? explicitUsedPercent
                : (explicitRemainingPercent !== null
                    ? Math.max(0, Math.min(100, 100 - explicitRemainingPercent))
                    : (itemLimit > 0 ? Math.max(0, Math.min(100, (itemUsed / itemLimit) * 100)) : null));

            if (derivedUsedPercent !== null) {
                preferredWindowPercent = derivedUsedPercent;
                preferredWindowRemaining = explicitRemainingPercent !== null
                    ? explicitRemainingPercent
                    : Math.max(0, Math.min(100, 100 - derivedUsedPercent));
                preferredWindowLabel = item.displayName || item.resourceType || preferredWindowLabel;
                preferredWindowResetAt = item.nextDateReset || preferredWindowResetAt;
            }
        }
    }

    let percent = 0;
    if (hasPercentSignal) {
        percent = Math.min(100, Math.max(0, maxPercent));
    } else if (limit > 0) {
        percent = Math.min(100, (used / limit) * 100);
    } else if (maxPercent > 0) {
        percent = Math.min(100, maxPercent);
    }

    let normalizedUsed = used;
    let normalizedLimit = limit;
    let normalizedUnit = unit;

    if (hasPercentSignal || (!limit && maxPercent > 0)) {
        normalizedUsed = percent;
        normalizedLimit = 100;
        normalizedUnit = '%';
    }

    if (preferredWindowPercent !== null) {
        percent = preferredWindowPercent;
        normalizedUsed = preferredWindowPercent;
        normalizedLimit = 100;
        normalizedUnit = '%';
        minRemainingPercent = preferredWindowRemaining;
        if (preferredWindowLabel) {
            maxLabel = preferredWindowLabel;
        }
        if (preferredWindowResetAt) {
            resetAt = preferredWindowResetAt;
        }
    }

    const remaining = normalizedLimit > 0
        ? Math.max(0, normalizedLimit - normalizedUsed)
        : null;

    return {
        used: normalizedUsed,
        limit: normalizedLimit,
        remaining,
        percent,
        unit: normalizedUnit || '',
        resetAt,
        modelCount: breakdowns.length,
        minRemainingPercent,
        peakLabel: maxLabel
    };
}

function classifyUsageLevel(percent, thresholds) {
    if (percent >= thresholds.disable) {
        return 'critical';
    }
    if (percent >= thresholds.warn) {
        return 'warning';
    }
    return 'normal';
}

function computeProviderSummary(instances, thresholds) {
    const summary = {
        total: instances.length,
        withUsage: 0,
        warningCount: 0,
        criticalCount: 0,
        avgPercent: 0,
        quotaUsagePercent: 0,
        totalUsed: 0,
        totalLimit: 0,
        maxPercent: 0,
        minRemainingPercent: null,
        updatedAt: new Date().toISOString()
    };

    let percentSum = 0;

    for (const instance of instances) {
        const usageSummary = instance.usageSummary;
        if (!usageSummary) {
            continue;
        }
        summary.withUsage += 1;
        percentSum += usageSummary.percent;
        summary.maxPercent = Math.max(summary.maxPercent, usageSummary.percent);

        const used = Number(usageSummary.used);
        const limit = Number(usageSummary.limit);
        if (Number.isFinite(limit) && limit > 0) {
            summary.totalUsed += Number.isFinite(used) ? Math.max(0, used) : 0;
            summary.totalLimit += limit;
        }

        if (usageSummary.minRemainingPercent !== null) {
            summary.minRemainingPercent = summary.minRemainingPercent === null
                ? usageSummary.minRemainingPercent
                : Math.min(summary.minRemainingPercent, usageSummary.minRemainingPercent);
        } else if (usageSummary.limit > 0 && usageSummary.remaining !== null) {
            const remainingPercent = (usageSummary.remaining / usageSummary.limit) * 100;
            summary.minRemainingPercent = summary.minRemainingPercent === null
                ? remainingPercent
                : Math.min(summary.minRemainingPercent, remainingPercent);
        }

        if (usageSummary.percent >= thresholds.disable) {
            summary.criticalCount += 1;
        } else if (usageSummary.percent >= thresholds.warn) {
            summary.warningCount += 1;
        }
    }

    if (summary.totalLimit > 0) {
        summary.avgPercent = Math.max(0, Math.min(100, (summary.totalUsed / summary.totalLimit) * 100));
    } else if (summary.withUsage > 0) {
        summary.avgPercent = percentSum / summary.withUsage;
    }

    summary.quotaUsagePercent = summary.avgPercent;

    return summary;
}

function computeImageUsageSummary(imageUsage) {
    if (!imageUsage || imageUsage.error) {
        return null;
    }

    const breakdowns = Array.isArray(imageUsage.usageBreakdown) ? imageUsage.usageBreakdown : [];
    const primary = breakdowns[0] || null;

    let remaining = toOptionalNumber(imageUsage.remaining);
    if (remaining === null) {
        remaining = toOptionalNumber(primary?.remaining);
    }

    let limit = toOptionalNumber(imageUsage.limit);
    if (limit === null) {
        limit = toOptionalNumber(primary?.usageLimit);
    }

    let used = toOptionalNumber(imageUsage.used);
    if (used === null) {
        used = toOptionalNumber(primary?.currentUsage);
    }

    if (used === null && limit !== null && remaining !== null) {
        used = Math.max(0, limit - remaining);
    }
    if (limit === null && used !== null && remaining !== null) {
        limit = Math.max(0, used + remaining);
    }

    let percent = null;
    if (limit !== null && limit > 0 && remaining !== null) {
        percent = Math.max(0, Math.min(100, 100 - (remaining / limit) * 100));
    }

    const rawStatus = String(imageUsage.status || '').trim().toLowerCase();
    let status = 'unknown';
    if (rawStatus === 'normal' || rawStatus === 'warning' || rawStatus === 'critical' || rawStatus === 'unknown') {
        status = rawStatus;
    } else if (remaining !== null) {
        if (remaining <= 0) status = 'critical';
        else if (remaining <= 2) status = 'warning';
        else status = 'normal';
    }

    return {
        remaining,
        used,
        limit,
        percent,
        unit: imageUsage.unit || primary?.unit || 'images',
        resetAt: imageUsage.resetAt || primary?.nextDateReset || null,
        status,
        featureName: imageUsage.featureName || primary?.featureName || 'image_gen',
        source: imageUsage.source || null,
        sourceStatus: rawStatus || null,
        peakLabel: 'Image Generation'
    };
}

function computeImageProviderSummary(instances) {
    const summary = {
        total: instances.length,
        withImageUsage: 0,
        knownRemainingCount: 0,
        zeroRemainingCount: 0,
        warningCount: 0,
        criticalCount: 0,
        totalRemaining: 0,
        totalUsed: 0,
        totalLimit: 0,
        minRemaining: null,
        updatedAt: new Date().toISOString()
    };

    for (const instance of instances) {
        const imageUsageSummary = instance.imageUsageSummary;
        if (!imageUsageSummary) continue;
        summary.withImageUsage += 1;

        const remaining = toOptionalNumber(imageUsageSummary.remaining);
        const used = toOptionalNumber(imageUsageSummary.used);
        const limit = toOptionalNumber(imageUsageSummary.limit);

        if (remaining !== null) {
            summary.knownRemainingCount += 1;
            summary.totalRemaining += Math.max(0, remaining);
            summary.minRemaining = summary.minRemaining === null
                ? remaining
                : Math.min(summary.minRemaining, remaining);
            if (remaining <= 0) {
                summary.zeroRemainingCount += 1;
            }
        }

        if (used !== null) {
            summary.totalUsed += Math.max(0, used);
        }

        if (limit !== null && limit > 0) {
            summary.totalLimit += limit;
        }

        if (imageUsageSummary.status === 'critical') {
            summary.criticalCount += 1;
        } else if (imageUsageSummary.status === 'warning') {
            summary.warningCount += 1;
        }
    }

    return summary;
}

function pickLatestTimestamp(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;
    return new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current;
}

function resolveUsageFetchConcurrency(providerType, options = {}) {
    const requested = Number(options?.concurrency);
    if (Number.isFinite(requested) && requested > 0) {
        return Math.max(1, Math.floor(requested));
    }
    if (options?.source === 'scheduler') {
        return providerType === 'openai-codex' ? 1 : 2;
    }
    return providerType === 'openai-codex' ? 2 : 3;
}

async function loadUsageProviders(providerType, options = {}) {
    const parsedPoolId = options?.poolId !== undefined && options?.poolId !== null && options?.poolId !== ''
        ? Number(options.poolId)
        : null;
    const poolId = Number.isFinite(parsedPoolId) ? parsedPoolId : null;
    const requestedUuid = typeof options?.uuid === 'string' && options.uuid.trim() ? options.uuid.trim() : null;

    if (requestedUuid) {
        const provider = await providerDao.findByUuid(requestedUuid);
        if (!provider) {
            return { providers: [], poolId, requestedUuid };
        }
        const normalized = normalizeProviderEntry(provider);
        const normalizedType = normalized.provider_type || normalized.providerType || null;
        const providerPoolId = normalized.poolId ?? normalized.pool_id ?? 0;
        if (normalizedType !== providerType) {
            return { providers: [], poolId, requestedUuid };
        }
        if (poolId !== null && Number(providerPoolId) !== poolId) {
            return { providers: [], poolId, requestedUuid };
        }
        return {
            providers: normalized.isDeleted ? [] : [normalized],
            poolId,
            requestedUuid
        };
    }

    let providers = await providerDao.findAll(providerType, { poolId });
    providers = providers.map(normalizeProviderEntry);
    providers = providers.filter(provider => !provider.isDeleted);
    return { providers, poolId, requestedUuid: null };
}

function normalizeUsageResult(result, thresholds) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    const normalized = { ...result };
    const instances = Array.isArray(normalized.instances) ? normalized.instances : [];
    let updated = false;

    for (const instance of instances) {
        if (!instance) continue;
        if (!instance.usageSummary && instance.usage) {
            instance.usageSummary = computeUsageSummary(instance.usage);
            updated = true;
        }
        if (!instance.imageUsageSummary && instance.imageUsage) {
            instance.imageUsageSummary = computeImageUsageSummary(instance.imageUsage);
            updated = true;
        }
        if (instance.usageSummary && !instance.usageSummary.status) {
            instance.usageSummary.status = classifyUsageLevel(instance.usageSummary.percent, thresholds);
            updated = true;
        }
    }

    if (!normalized.summary && instances.length) {
        normalized.summary = computeProviderSummary(instances, thresholds);
        updated = true;
    }

    if (!normalized.imageSummary && instances.length) {
        normalized.imageSummary = computeImageProviderSummary(instances);
        updated = true;
    }

    if (!normalized.thresholds) {
        normalized.thresholds = thresholds;
        updated = true;
    }

    if (updated) {
        normalized.instances = instances;
    }

    return normalized;
}

function pickKiroUsageBreakdown(usage) {
    const breakdowns = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    if (!breakdowns.length) {
        return null;
    }
    return breakdowns.find(item => item.resourceType === 'CREDIT') || breakdowns[0];
}

function pickCodexUsageBreakdown(usage) {
    const breakdowns = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    if (!breakdowns.length) {
        return null;
    }
    return breakdowns.find(item => item.resourceType === 'RATE_LIMIT' && item.limitGroup === 'main' && item.windowType === 'primary')
        || breakdowns.find(item => item.resourceType === 'RATE_LIMIT' && item.limitGroup === 'main')
        || breakdowns.find(item => item.resourceType === 'RATE_LIMIT')
        || breakdowns[0];
}

function resolveCodexCooldownFromUsage(usage) {
    const breakdowns = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    if (!breakdowns.length) {
        return null;
    }

    const nowMs = Date.now();
    const exhaustedResets = [];
    let exhaustedDetected = false;

    for (const item of breakdowns) {
        const remainingPercent = toOptionalNumber(item?.remainingPercent);
        const usedPercent = toOptionalNumber(item?.usedPercent);
        const currentUsage = toOptionalNumber(item?.currentUsage);
        const usageLimit = toOptionalNumber(item?.usageLimit);

        let exhausted = false;
        if (remainingPercent !== null) {
            exhausted = remainingPercent <= 0;
        } else if (usedPercent !== null) {
            exhausted = usedPercent >= 100;
        } else if (currentUsage !== null && usageLimit !== null && usageLimit > 0) {
            exhausted = currentUsage >= usageLimit;
        }

        if (!exhausted) {
            continue;
        }

        exhaustedDetected = true;
        const resetRaw = item?.nextDateReset || item?.resetAt || null;
        if (!resetRaw) {
            continue;
        }

        const resetMs = new Date(resetRaw).getTime();
        if (Number.isFinite(resetMs) && resetMs > nowMs) {
            exhaustedResets.push(resetMs);
        }
    }

    if (!exhaustedDetected) {
        return null;
    }

    let recoverAtMs = exhaustedResets.length > 0 ? Math.max(...exhaustedResets) : NaN;
    if (!Number.isFinite(recoverAtMs)) {
        const topResetMs = new Date(usage?.nextDateReset || usage?.resetAt || '').getTime();
        if (Number.isFinite(topResetMs) && topResetMs > nowMs) {
            recoverAtMs = topResetMs;
        }
    }

    if (!Number.isFinite(recoverAtMs)) {
        recoverAtMs = nowMs + 60 * 60 * 1000;
    }

    return {
        recoveryTime: new Date(recoverAtMs),
        reason: 'Codex 额度已耗尽，等待窗口重置'
    };
}

async function applyAutoDisable(providerType, instanceResult, thresholds, currentConfig, providerPoolManager) {
    if (!thresholds.autoDisable) {
        return;
    }
    if (!instanceResult?.usageSummary || !instanceResult?.uuid) {
        return;
    }
    if (instanceResult.isDisabled || instanceResult.isDeleted) {
        return;
    }
    if (instanceResult.usageSummary.percent < thresholds.disable) {
        return;
    }

    const reason = `Auto-disabled: usage ${instanceResult.usageSummary.percent.toFixed(2)}% >= ${thresholds.disable}%`;
    const now = new Date();

    try {
        await providerDao.update(instanceResult.uuid, {
            is_disabled: true,
            last_error_message: reason,
            last_error_time: now
        });
    } catch (error) {
        console.error(`[Usage API] Failed to auto-disable provider ${instanceResult.uuid}:`, error.message);
        return;
    }

    instanceResult.isDisabled = true;
    instanceResult.usageSummary.status = 'critical';
    instanceResult.usageSummary.autoDisabled = true;
    instanceResult.usageSummary.autoDisableReason = reason;
}

async function getProviderTypeUsageFromCache(providerType, currentConfig, providerPoolManager, options = {}) {
    const thresholds = getUsageThresholds(currentConfig);
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0,
        thresholds,
        fromCache: true
    };

    const { providers, requestedUuid } = await loadUsageProviders(providerType, options);

    result.totalCount = providers.length;
    const usageDetails = requestedUuid
        ? [await providerUsageDao.findByProviderUuid(requestedUuid)].filter(Boolean)
        : await providerUsageDao.findByProviderType(providerType);
    const usageDetailMap = new Map();
    let latestUpdatedAt = null;
    for (const detail of usageDetails) {
        if (detail?.provider_uuid) {
            usageDetailMap.set(detail.provider_uuid, detail);
        }
        latestUpdatedAt = pickLatestTimestamp(latestUpdatedAt, detail?.updated_at);
    }

    for (const provider of providers) {
        const detail = usageDetailMap.get(provider.uuid);
        let cached = { usage: null, usageSummary: null, imageUsage: null, imageUsageSummary: null };
        if (detail?.usage || detail?.usageSummary || detail?.imageUsage || detail?.imageUsageSummary) {
            const usageSummary = detail.usageSummary || computeUsageSummary(detail.usage);
            const imageUsageSummary = detail.imageUsageSummary || computeImageUsageSummary(detail.imageUsage);
            if (usageSummary && !usageSummary.status) {
                usageSummary.status = classifyUsageLevel(usageSummary.percent, thresholds);
            }
            cached = {
                usage: detail.usage,
                usageSummary,
                imageUsage: detail.imageUsage,
                imageUsageSummary
            };
        }
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            isDeleted: provider.isDeleted === true,
            success: Boolean(cached.usage || cached.usageSummary || cached.imageUsage || cached.imageUsageSummary),
            usage: cached.usage,
            usageSummary: cached.usageSummary,
            imageUsage: cached.imageUsage,
            imageUsageSummary: cached.imageUsageSummary,
            updatedAt: detail?.updated_at || null,
            error: null
        };

        if (instanceResult.success) {
            result.successCount++;
        } else {
            result.errorCount++;
        }

        result.instances.push(instanceResult);
    }

    result.summary = computeProviderSummary(result.instances, thresholds);
    result.imageSummary = computeImageProviderSummary(result.instances);
    if (latestUpdatedAt) {
        result.cachedAt = latestUpdatedAt;
        result.summary.updatedAt = latestUpdatedAt;
        result.imageSummary.updatedAt = latestUpdatedAt;
    }
    return result;
}

async function getAllProvidersUsageFromCache(currentConfig, providerPoolManager) {
    const thresholds = getUsageThresholds(currentConfig);
    const results = {
        timestamp: new Date().toISOString(),
        thresholds,
        providers: {}
    };
    let latestUpdatedAt = null;

    const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-antigravity', 'openai-codex', 'openai-xai-oauth', 'claude-custom', 'claude-offical', 'claude-windsurf'];
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsageFromCache(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    thresholds,
                    instances: []
                }
            };
        }
    });

    const usageResults = await Promise.all(usagePromises);
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
        latestUpdatedAt = pickLatestTimestamp(latestUpdatedAt, result.data?.cachedAt || result.data?.summary?.updatedAt);
    }

    if (latestUpdatedAt) {
        results.timestamp = latestUpdatedAt;
    }

    return results;
}

async function getAllProvidersUsageSummaryFromCache(currentConfig) {
    const thresholds = getUsageThresholds(currentConfig);
    const results = {
        timestamp: new Date().toISOString(),
        thresholds,
        providers: {}
    };
    let latestUpdatedAt = null;

    const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-antigravity', 'openai-codex', 'openai-xai-oauth', 'claude-custom', 'claude-offical', 'claude-windsurf'];
    const summaryResults = await Promise.all(supportedProviders.map(async (providerType) => {
        try {
            const details = await providerUsageDao.findByProviderType(providerType);
            const providerUpdatedAt = details.reduce((latest, detail) => pickLatestTimestamp(latest, detail?.updated_at), null);
            const instances = details.map(detail => {
                const usageSummary = detail?.usageSummary || computeUsageSummary(detail?.usage);
                const imageUsageSummary = detail?.imageUsageSummary || computeImageUsageSummary(detail?.imageUsage);
                return { usageSummary, imageUsageSummary };
            });
            const summary = computeProviderSummary(instances, thresholds);
            const imageSummary = computeImageProviderSummary(instances);
            if (providerUpdatedAt) {
                summary.updatedAt = providerUpdatedAt;
                imageSummary.updatedAt = providerUpdatedAt;
            }
            return { providerType, summary, imageSummary, cachedAt: providerUpdatedAt };
        } catch (error) {
            return { providerType, error: error.message };
        }
    }));

    for (const entry of summaryResults) {
        const summary = entry.summary || {
            total: 0,
            withUsage: 0,
            avgPercent: 0,
            maxPercent: 0,
            minRemainingPercent: null,
            warningCount: 0,
            criticalCount: 0,
            updatedAt: new Date().toISOString()
        };
        results.providers[entry.providerType] = {
            providerType: entry.providerType,
            summary,
            imageSummary: entry.imageSummary || computeImageProviderSummary([]),
            totalCount: summary.total || 0,
            successCount: summary.withUsage || 0,
            errorCount: Math.max(0, (summary.total || 0) - (summary.withUsage || 0)),
            thresholds,
            cachedAt: entry.cachedAt || null,
            fromCache: true
        };
        latestUpdatedAt = pickLatestTimestamp(latestUpdatedAt, entry.cachedAt || summary.updatedAt);
    }

    if (latestUpdatedAt) {
        results.timestamp = latestUpdatedAt;
    }

    return results;
}

function shouldUpdateCustomName(name) {
    if (name === null || name === undefined) return true;
    if (typeof name !== 'string') return false;
    return name.trim() === '';
}

/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
export async function getAllProvidersUsage(currentConfig, providerPoolManager, options = {}) {
    const thresholds = getUsageThresholds(currentConfig);
    const results = {
        timestamp: new Date().toISOString(),
        thresholds,
        providers: {}
    };

    // 支持用量查询的提供商列表
    const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-antigravity', 'openai-codex', 'openai-xai-oauth', 'claude-custom', 'claude-offical', 'claude-windsurf'];

    // 批量加载所有渠道配置，判断渠道级开关
    let allChannelConfigs = {};
    try {
        const rows = await channelConfigDao.getAll();
        for (const row of (rows || [])) {
            allChannelConfigs[row.providerType || row.provider_type] = row.config || {};
        }
    } catch (e) {
        console.warn('[Usage] Failed to load channel configs for filtering:', e.message);
    }

    const globalEnabled = currentConfig.USAGE_REFRESH_ENABLED !== false;

    // 按渠道级开关过滤
    const filteredProviders = supportedProviders.filter(pt => {
        const chCfg = allChannelConfigs[pt];
        if (!chCfg || chCfg.usageRefreshEnabled === undefined || chCfg.usageRefreshEnabled === 'global') {
            return globalEnabled; // 跟随全局
        }
        return chCfg.usageRefreshEnabled === true || chCfg.usageRefreshEnabled === 'true';
    });

    // 顺序刷新各渠道，避免一次性并发打满上游。
    for (const providerType of filteredProviders) {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options);
            results.providers[providerType] = providerUsage;
        } catch (error) {
            results.providers[providerType] = {
                error: error.message,
                thresholds,
                instances: []
            };
        }
    }

    return results;
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options = {}) {
    const thresholds = getUsageThresholds(currentConfig);
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0,
        thresholds
    };

    // 统一从数据库获取提供商列表，避免内存池与数据库不一致
    const includeRawUsage = options?.includeRaw === true;

    const { providers } = await loadUsageProviders(providerType, options);

    result.totalCount = providers.length;

    const concurrency = Math.min(resolveUsageFetchConcurrency(providerType, options), Math.max(1, providers.length));
    const instanceResults = await mapWithConcurrency(providers, concurrency, async (provider) => {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = peekServiceAdapter(providerKey);

        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            isDeleted: provider.isDeleted === true,
            success: false,
            usage: null,
            usageSummary: null,
            imageUsage: null,
            imageUsageSummary: null,
            error: null
        };

        // First check if disabled, skip initialization for disabled providers
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            return instanceResult;
        }

        if (!adapter) {
            // Phase 2+3 保护:在 sharded worker 进程,不要给非本 shard 的 uuid 懒创建 adapter
            // 这会导致 worker 持有非归属的 adapter 副本,破坏分片内存收益
            // 仅在 admin 进程(ownsUuid 恒真)或本 shard 内的 provider 才创建
            // UI 查询全量用量应通过 admin UI(1456)而非 worker(1458)
            let canCreate = true;
            try {
                const shard = await import('../utils/shard.js');
                if (shard.SHARD_ENABLED && !shard.ownsUuid(provider.uuid)) {
                    canCreate = false;
                }
            } catch (_shardErr) { /* 未启用分片时不限制 */ }

            if (!canCreate) {
                instanceResult.error = 'not_owned_by_this_shard (query via admin UI for cross-shard usage)';
                return instanceResult;
            }

            // Service instance not initialized, try auto-initialization
            try {
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                console.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                return instanceResult;
            }
        }

        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter) {
            try {
                const { usage, rawUsage, imageUsage, rawImageUsage, imageError } = await getAdapterUsage(adapter, providerType, {
                    includeRaw: includeRawUsage
                });
                instanceResult.success = true;
                instanceResult.usage = usage;
                instanceResult.imageUsage = imageUsage || null;
                if (includeRawUsage) {
                    instanceResult.rawUsage = rawUsage || null;
                    instanceResult.rawImageUsage = rawImageUsage || null;
                }
                instanceResult.usageSummary = computeUsageSummary(usage);
                instanceResult.imageUsageSummary = computeImageUsageSummary(imageUsage);
                if (imageError) {
                    instanceResult.imageError = imageError;
                }
                try {
                    await providerUsageDao.upsertUsageDetail({
                        providerUuid: provider.uuid,
                        providerType,
                        usage,
                        usageSummary: instanceResult.usageSummary,
                        ...(rawUsage !== undefined ? { rawUsage } : {}),
                        ...(imageUsage !== undefined ? { imageUsage } : {}),
                        ...(instanceResult.imageUsageSummary !== null ? { imageUsageSummary: instanceResult.imageUsageSummary } : {}),
                        ...(rawImageUsage !== undefined ? { rawImageUsage } : {})
                    });
                } catch (cacheError) {
                    console.error(`[Usage API] Failed to update usage detail cache for ${provider.uuid}:`, cacheError.message);
                }

                // 将用量信息写入数据库
                if (usage && providerType === 'claude-kiro-oauth') {
                    const email = usage?.user?.email ? String(usage.user.email).trim() : '';
                    const currentEmail = provider.credentials?.email ? String(provider.credentials.email).trim() : '';
                    const shouldSetName = shouldUpdateCustomName(provider.customName || provider.custom_name);

                    if (email && (email !== currentEmail || shouldSetName)) {
                        const nextCredentials = {
                            ...(provider.credentials || {}),
                            email
                        };
                        const updates = { credentials: nextCredentials };
                        if (shouldSetName) {
                            updates.custom_name = email;
                        }
                        await providerDao.update(provider.uuid, updates);
                        provider.credentials = nextCredentials;
                        if (shouldSetName) {
                            provider.customName = email;
                        }
                    }

                    const breakdown = pickKiroUsageBreakdown(usage);
                    const freeTrial = breakdown?.freeTrial;
                    const nextResetTime = breakdown?.nextDateReset ?? usage.nextDateReset ?? null;
                    const freeTrialExpiry = freeTrial?.expiresAt ?? null;
                    const usageInfo = {
                        subscriptionTitle: usage.subscription?.title ?? null,
                        usageLimit: freeTrial?.usageLimit ?? breakdown?.usageLimit ?? null,
                        currentUsage: freeTrial?.currentUsage ?? breakdown?.currentUsage ?? null,
                        nextResetTime: nextResetTime ? new Date(nextResetTime) : null,
                        freeTrialExpiry: freeTrialExpiry ? new Date(freeTrialExpiry) : null
                    };
                    await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                    console.log(`[Usage API] Updated usage info for ${provider.uuid}: ${usageInfo.subscriptionTitle}`);
                }

                if (usage && providerType === 'openai-codex') {
                    const providerTitle = provider.subscriptionTitle ?? provider.subscription_title ?? null;
                    const usageTitle = usage.subscription?.title ?? null;
                    const planTitle = selectBestCodexPlanTitle(
                        providerTitle,
                        usageTitle && usageTitle !== 'OpenAI Codex OAuth' ? usageTitle : null
                    );

                    if (planTitle) {
                        usage.subscription = {
                            ...(usage.subscription || {}),
                            title: planTitle
                        };
                    }

                    const breakdown = pickCodexUsageBreakdown(usage);
                    const nextResetTime = breakdown?.nextDateReset ?? usage.nextDateReset ?? null;
                    const usageInfo = {
                        subscriptionTitle: planTitle ?? null,
                        usageLimit: breakdown?.usageLimit ?? null,
                        currentUsage: breakdown?.currentUsage ?? null,
                        nextResetTime: nextResetTime ? new Date(nextResetTime) : null
                    };
                    await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                    console.log(`[Usage API] Updated Codex usage info for ${provider.uuid}`);

                    if (!provider.is_disabled && !provider.is_deleted && providerPoolManager && typeof providerPoolManager.markProviderUnhealthyWithRecoveryTime === 'function') {
                        const cooldownDecision = resolveCodexCooldownFromUsage(usage);
                        if (cooldownDecision) {
                            await providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                                providerType,
                                provider.uuid,
                                cooldownDecision.recoveryTime,
                                cooldownDecision.reason,
                                {
                                    source: 'usage_refresh',
                                    action: 'mark_unhealthy_quota_cooldown',
                                    reason: cooldownDecision.reason,
                                    metadata: {
                                        statusCode: 429,
                                        detectedBy: 'codex_usage_breakdown'
                                    }
                                }
                            );
                            instanceResult.isHealthy = false;
                            console.log(`[Usage API] Marked Codex provider ${provider.uuid} as cooldown until ${cooldownDecision.recoveryTime.toISOString()}`);
                        } else if (!provider.is_healthy && typeof providerPoolManager.markProviderHealthy === 'function') {
                            // 额度充足但当前不健康（冷却中）→ 恢复为 healthy
                            await providerPoolManager.markProviderHealthy(providerType, provider.uuid, {
                                source: 'usage_refresh',
                                action: 'recover_from_cooldown',
                                reason: 'Codex 额度充足，自动恢复'
                            });
                            instanceResult.isHealthy = true;
                            console.log(`[Usage API] Recovered Codex provider ${provider.uuid} from cooldown — quota available`);
                        }
                    }
                }

                if (usage && providerType === 'openai-xai-oauth') {
                    const breakdowns = Array.isArray(usage.usageBreakdown) ? usage.usageBreakdown : [];
                    const weeklyBreakdown = breakdowns.find(item => (
                        item?.resourceType === 'XAI_WEEKLY_CREDITS'
                        || item?.subscriptionId === 'weekly_pool'
                    )) || null;
                    const nextResetTime = weeklyBreakdown?.nextDateReset ?? usage.nextDateReset ?? null;
                    const usageInfo = {
                        subscriptionTitle: usage.subscription?.title ?? null,
                        usageLimit: weeklyBreakdown?.usageLimit ?? null,
                        currentUsage: weeklyBreakdown?.currentUsage ?? null,
                        nextResetTime: nextResetTime ? new Date(nextResetTime) : null
                    };
                    await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                    console.log(`[Usage API] Updated Grok usage info for ${provider.uuid}`);

                    if (
                        !provider.is_disabled
                        && !provider.is_deleted
                        && !provider.is_healthy
                        && providerPoolManager
                        && typeof providerPoolManager.markProviderHealthy === 'function'
                    ) {
                        await providerPoolManager.markProviderHealthy(providerType, provider.uuid, {
                            source: 'usage_refresh',
                            action: 'recover_after_api_verification',
                            reason: usage.apiAccessVerified
                                ? 'xAI API OAuth access verified'
                                : 'Grok usage refresh succeeded'
                        });
                        instanceResult.isHealthy = true;
                        console.log(`[Usage API] Recovered Grok provider ${provider.uuid} after successful API verification`);
                    }
                }

                if (usage && (providerType === 'claude-custom' || providerType === 'claude-offical')) {
                    const breakdownList = Array.isArray(usage.usageBreakdown) ? usage.usageBreakdown : [];
                    const subscriptionList = Array.isArray(usage.subscriptionBreakdown) ? usage.subscriptionBreakdown : [];

                    const isFiveHourWindow = (item = {}) => {
                        const subscriptionId = String(item?.subscriptionId || '').toLowerCase();
                        const planName = String(item?.planName || item?.displayName || '').toLowerCase();
                        if (subscriptionId === 'five_hour') return true;
                        return planName.includes('5小时') || planName.includes('5h') || planName.includes('five');
                    };

                    const selectedSubscription = providerType === 'claude-offical'
                        ? (subscriptionList.find(isFiveHourWindow) || subscriptionList[0] || null)
                        : (subscriptionList[0] || null);
                    const selectedBreakdown = providerType === 'claude-offical'
                        ? (breakdownList.find(isFiveHourWindow) || breakdownList[0] || null)
                        : (breakdownList[0] || null);

                    const usageInfo = {
                        subscriptionTitle: selectedSubscription?.planName
                            ?? selectedBreakdown?.displayName
                            ?? usage.subscription?.title
                            ?? null,
                        usageLimit: selectedSubscription?.limit ?? selectedBreakdown?.usageLimit ?? null,
                        currentUsage: selectedSubscription?.used ?? selectedBreakdown?.currentUsage ?? null,
                        nextResetTime: (selectedSubscription?.lastResetAt || selectedBreakdown?.nextDateReset)
                            ? new Date(selectedSubscription?.lastResetAt || selectedBreakdown?.nextDateReset)
                            : null
                    };
                    await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                    console.log(`[Usage API] Updated Claude usage info for ${provider.uuid}`);
                }

                if (usage && (providerType === 'gemini-cli-oauth' || providerType === 'gemini-antigravity' || providerType === 'claude-antigravity')) {
                    const summary = instanceResult.usageSummary;
                    const nextResetTime = summary?.resetAt ?? usage.nextDateReset ?? null;
                    // claude-antigravity 用 tier 作为 subscriptionTitle（PRO/ULTRA/FREE）
                    const subTitle = providerType === 'claude-antigravity'
                        ? (usage.subscription?.tier ?? usage.subscription?.title ?? null)
                        : (usage.subscription?.title ?? null);
                    const usageInfo = {
                        subscriptionTitle: subTitle,
                        usageLimit: summary?.limit ?? null,
                        currentUsage: summary?.used ?? null,
                        nextResetTime: nextResetTime ? new Date(nextResetTime) : null
                    };
                    await providerDao.updateUsageInfo(provider.uuid, usageInfo);
                    console.log(`[Usage API] Updated Gemini usage info for ${provider.uuid}`);
                }

                // 回写订阅等级到 oauth_credentials（仅 Antigravity）
                if ((providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') && usage?.subscription?.tier) {
                    const oauthCredentialId = provider.oauthCredentialId || provider.oauth_credential_id;
                    if (oauthCredentialId) {
                        await oauthCredentialsDao.updateSubscriptionTier(oauthCredentialId, usage.subscription.tier);
                    }
                }

                if (instanceResult.usageSummary) {
                    instanceResult.usageSummary.status = classifyUsageLevel(
                        instanceResult.usageSummary.percent,
                        thresholds
                    );
                }

                // claude-offical: 注入 5h 会话窗口状态和最近流式用量
                if (providerType === 'claude-offical' && adapter) {
                    const sessionWindow = {};
                    if (typeof adapter.sessionWindowStatus !== 'undefined') sessionWindow.status = adapter.sessionWindowStatus;
                    if (typeof adapter.sessionWindowStatusUpdatedAt !== 'undefined') sessionWindow.updatedAt = adapter.sessionWindowStatusUpdatedAt;
                    if (typeof adapter.fiveHourAutoStopped !== 'undefined') sessionWindow.autoStopped = adapter.fiveHourAutoStopped;
                    if (typeof adapter.fiveHourRecoveryAt !== 'undefined') sessionWindow.recoveryAt = adapter.fiveHourRecoveryAt;
                    if (Object.keys(sessionWindow).length > 0) instanceResult.sessionWindow = sessionWindow;
                    if (typeof adapter.lastStreamUsage !== 'undefined' && adapter.lastStreamUsage) {
                        instanceResult.lastStreamUsage = adapter.lastStreamUsage;
                    }
                }

                await applyAutoDisable(providerType, instanceResult, thresholds, currentConfig, providerPoolManager);
            } catch (error) {
                instanceResult.error = error.message;

                if (providerType === 'openai-codex' && isUnauthorizedUsageError(error)) {
                    // 先判断是否为永久性认证失败（token_invalidated 等），直接标记删除
                    const isPermanent = isPermanentCodexAuthFailure(error);

                    if (isPermanent) {
                        const permanentMessage = `Codex token permanently invalidated: ${error.message}`;
                        console.log(`[Usage API] 🗑️ Codex permanent auth failure for ${provider.uuid}: ${permanentMessage}`);

                        try {
                            if (providerPoolManager && typeof providerPoolManager.markProviderDeleted === 'function') {
                                await providerPoolManager.markProviderDeleted(providerType, provider.uuid, permanentMessage, {
                                    source: 'usage_refresh',
                                    action: 'mark_deleted_token_invalidated',
                                    reason: permanentMessage,
                                    metadata: {
                                        statusCode: 401,
                                        errorCode: 'token_invalidated'
                                    }
                                });
                            } else {
                                await providerDao.markDeleted(provider.uuid, permanentMessage);
                            }
                            const prevStatus = resolveProviderStatus(provider);
                            providerStatusLogsDao.create({
                                providerUuid: provider.uuid,
                                providerType,
                                poolId: provider.pool_id ?? provider.poolId ?? 0,
                                action: 'mark_deleted_token_invalidated',
                                fromStatus: prevStatus,
                                toStatus: 'deleted',
                                reason: permanentMessage,
                                source: 'usage_refresh'
                            }).catch(err => {
                                console.error('[Usage API] Failed to record status log:', err);
                            });
                            instanceResult.isHealthy = false;
                            instanceResult.isDeleted = true;
                            instanceResult.error = permanentMessage;
                            console.log(`[Usage API] Marked codex provider ${provider.uuid} as DELETED (token_invalidated)`);
                        } catch (deleteError) {
                            console.error(`[Usage API] Failed to delete codex provider ${provider.uuid}:`, deleteError.message);
                        }
                    } else {
                        // 非永久性 401：走原有的 model verify 检测流程
                        try {
                            const verifyResult = await verifyCodexModelAvailability(providerType, provider, providerPoolManager);
                            if (verifyResult.success) {
                                console.log(`[Usage API] Codex usage 401 for ${provider.uuid}, but model verify passed (${verifyResult.checkModelName})`);
                            } else {
                                const verifyMessage = verifyResult.errorMessage || 'model verify failed';
                                const finalErrorMessage = `Usage 401 and model verify failed (${verifyResult.checkModelName || 'unknown-model'}): ${verifyMessage}`;

                                // model verify 也失败了，再检测 verify 的错误是否为永久性
                                const verifyAlsoPermanent = /token[_\s-]?invalidated|invalid[_\s-]?api[_\s-]?key|account[_\s-]?(suspended|deactivated|banned)/i.test(verifyMessage);

                                if (verifyAlsoPermanent) {
                                    // verify 时也报永久错误 → 删除
                                    if (providerPoolManager && typeof providerPoolManager.markProviderDeleted === 'function') {
                                        await providerPoolManager.markProviderDeleted(providerType, provider.uuid, finalErrorMessage, {
                                            source: 'usage_refresh',
                                            action: 'mark_deleted_after_verify_permanent_failure',
                                            reason: finalErrorMessage,
                                            metadata: {
                                                statusCode: 401,
                                                checkModelName: verifyResult.checkModelName || null,
                                                verifyChecked: verifyResult.checked
                                            }
                                        });
                                    } else {
                                        await providerDao.markDeleted(provider.uuid, finalErrorMessage);
                                    }
                                    instanceResult.isHealthy = false;
                                    instanceResult.isDeleted = true;
                                    instanceResult.error = finalErrorMessage;
                                    console.log(`[Usage API] Marked codex provider ${provider.uuid} as DELETED after usage401 + verify permanent failure`);
                                } else {
                                    // verify 是临时错误 → 标记 unhealthy
                                    if (providerPoolManager && typeof providerPoolManager.markProviderUnhealthyImmediately === 'function') {
                                        await providerPoolManager.markProviderUnhealthyImmediately(providerType, provider.uuid, finalErrorMessage, {
                                            source: 'usage_refresh',
                                            action: 'mark_unhealthy_after_usage_401_model_verify_failed',
                                            reason: finalErrorMessage,
                                            metadata: {
                                                statusCode: 401,
                                                checkModelName: verifyResult.checkModelName || null,
                                                verifyChecked: verifyResult.checked
                                            }
                                        });
                                    } else {
                                        await providerDao.markUnhealthy(provider.uuid, {
                                            isHealthy: false,
                                            errorCount: 10,
                                            errorMessage: finalErrorMessage
                                        });
                                    }
                                    instanceResult.isHealthy = false;
                                    instanceResult.isDeleted = false;
                                    instanceResult.error = finalErrorMessage;
                                    console.log(`[Usage API] Marked codex provider ${provider.uuid} as unhealthy after usage401 + model verify failure`);
                                }
                            }
                        } catch (verifyError) {
                            console.error(`[Usage API] Codex usage401 model verify failed unexpectedly for ${provider.uuid}:`, verifyError.message);
                        }
                    }
                }

                // 检测 403 错误
                if (error.message && (error.message.includes('403') || error.message.includes('Forbidden'))) {
                    try {
                        if ((providerType === 'claude-custom' || providerType === 'claude-offical') && providerPoolManager && typeof providerPoolManager.markProviderUnhealthyWithRecoveryTime === 'function') {
                            const recoveryTime = new Date(Date.now() + 3 * 60 * 1000);
                            await providerPoolManager.markProviderUnhealthyWithRecoveryTime(
                                providerType,
                                provider.uuid,
                                recoveryTime,
                                error.message,
                                {
                                    source: 'usage_refresh',
                                    action: 'mark_unhealthy_recovery',
                                    reason: error.message,
                                    metadata: { statusCode: 403 }
                                }
                            );
                            instanceResult.isHealthy = false;
                            console.log(`[Usage API] Marked claude provider ${provider.uuid} as unhealthy due to 403, recovery at ${recoveryTime.toISOString()}`);
                        } else if (providerType === 'claude-kiro-oauth' || providerType === 'openai-xai-oauth') {
                            const prevStatus = resolveProviderStatus(provider);
                            if (providerPoolManager && typeof providerPoolManager.markProviderUnhealthy === 'function') {
                                await providerPoolManager.markProviderUnhealthy(providerType, provider.uuid, error.message, {
                                    source: 'usage_refresh',
                                    action: 'mark_unhealthy',
                                    reason: error.message,
                                    metadata: { statusCode: 403 }
                                });
                            } else {
                                await providerDao.markUnhealthy(provider.uuid, {
                                    isHealthy: false,
                                    errorCount: 10,
                                    errorMessage: error.message
                                });
                            }
                            providerStatusLogsDao.create({
                                providerUuid: provider.uuid,
                                providerType,
                                poolId: provider.pool_id ?? provider.poolId ?? 0,
                                action: 'mark_unhealthy',
                                fromStatus: prevStatus,
                                toStatus: 'unhealthy',
                                reason: error.message,
                                source: 'usage_refresh'
                            }).catch(err => {
                                console.error('[Usage API] Failed to record status log:', err);
                            });
                            instanceResult.isHealthy = false;
                            instanceResult.isDeleted = false;
                            console.log(`[Usage API] Marked ${providerType} provider ${provider.uuid} as unhealthy due to 403 (not deleted)`);
                        } else {
                            const prevStatus = resolveProviderStatus(provider);
                            await providerDao.markDeleted(provider.uuid, error.message);
                            console.log(`[Usage API] Marked provider ${provider.uuid} as deleted due to 403 error`);
                            providerStatusLogsDao.create({
                                providerUuid: provider.uuid,
                                providerType,
                                poolId: provider.pool_id ?? provider.poolId ?? 0,
                                action: 'mark_deleted',
                                fromStatus: prevStatus,
                                toStatus: 'deleted',
                                reason: error.message,
                                source: 'usage_refresh'
                            }).catch(err => {
                                console.error('[Usage API] Failed to record status log:', err);
                            });
                            instanceResult.isDeleted = true;
                        }
                    } catch (markError) {
                        console.error(`[Usage API] Failed to mark provider as deleted:`, markError);
                    }
                }
            }
        }

        return instanceResult;
    });

    for (const instanceResult of instanceResults) {
        if (instanceResult.success) {
            result.successCount++;
        } else {
            result.errorCount++;
        }
        result.instances.push(instanceResult);
    }

    result.summary = computeProviderSummary(result.instances, thresholds);
    result.imageSummary = computeImageProviderSummary(result.instances);
    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType, options = {}) {
    const includeRaw = options?.includeRaw === true;

    const buildUsageResponse = (rawUsage, formatter) => {
        const usage = formatter(rawUsage);
        if (includeRaw) {
            return { usage, rawUsage };
        }
        return { usage };
    };

    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return buildUsageResponse(rawUsage, formatKiroUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits();
            return buildUsageResponse(rawUsage, formatKiroUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return buildUsageResponse(rawUsage, formatGeminiUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits();
            return buildUsageResponse(rawUsage, formatGeminiUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return buildUsageResponse(rawUsage, formatAntigravityUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits();
            return buildUsageResponse(rawUsage, formatAntigravityUsage);
        } else if (adapter.claudeAntigravityApiService && typeof adapter.claudeAntigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.claudeAntigravityApiService.getUsageLimits();
            return buildUsageResponse(rawUsage, formatAntigravityUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'openai-codex') {
        const usageService = typeof adapter.getUsageLimits === 'function'
            ? adapter
            : (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function'
                ? adapter.codexApiService
                : null);
        if (!usageService) {
            throw new Error('This adapter does not support usage query');
        }

        const rawUsage = await usageService.getUsageLimits();
        const response = buildUsageResponse(rawUsage, formatCodexUsage);

        if (typeof usageService.getImageUsageLimits === 'function') {
            try {
                const rawImageUsage = await usageService.getImageUsageLimits();
                response.imageUsage = formatCodexImageUsage(rawImageUsage);
                if (includeRaw) {
                    response.rawImageUsage = rawImageUsage;
                }
            } catch (error) {
                console.warn('[Usage API] Codex image usage query failed:', error.message);
                response.imageError = error.message;
            }
        }

        return response;
    }

    if (providerType === 'openai-xai-oauth') {
        const usageService = typeof adapter.getUsageLimits === 'function'
            ? adapter
            : (adapter.xaiApiService && typeof adapter.xaiApiService.getUsageLimits === 'function'
                ? adapter.xaiApiService
                : null);
        if (!usageService) {
            throw new Error('This adapter does not support usage query');
        }
        const rawUsage = await usageService.getUsageLimits();
        return buildUsageResponse(rawUsage, formatXaiUsage);
    }

    if (providerType === 'claude-custom' || providerType === 'claude-offical') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return buildUsageResponse(rawUsage, formatFoxcodeUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'claude-windsurf') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return buildUsageResponse(rawUsage, formatWindsurfUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    // 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    // 尝试从凭据文件路径提取名称
    const credPathKey = {
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'claude-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
        'claude-warp-oauth': 'WARP_OAUTH_CREDS_FILE_PATH',
        'openai-codex': 'CODEX_OAUTH_CREDS_FILE_PATH',
        'openai-xai-oauth': 'XAI_OAUTH_CREDS_FILE_PATH'
    }[providerType];

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const parsedRef = parseOAuthCredentialRef(filePath);
        if (parsedRef) {
            return `${parsedRef.providerType}/${parsedRef.id}`;
        }
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return provider.uuid || 'Unnamed';
}

function normalizeProviderEntry(provider) {
    const credentials = provider && typeof provider.credentials === 'object' ? provider.credentials : {};
    return {
        ...credentials,
        ...provider,
        customName: provider?.custom_name ?? provider?.customName ?? credentials.customName ?? null,
        isDisabled: provider?.is_disabled ?? provider?.isDisabled ?? credentials.isDisabled ?? false,
        isHealthy: provider?.is_healthy ?? provider?.isHealthy ?? credentials.isHealthy ?? true,
        isDeleted: provider?.is_deleted ?? provider?.isDeleted ?? credentials.isDeleted ?? false,
        uuid: provider?.uuid ?? credentials.uuid ?? 'unknown'
    };
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let index = 0;
    const workerCount = Math.min(limit, items.length);

    const workers = Array.from({ length: workerCount }, async () => {
        while (index < items.length) {
            const current = index;
            index += 1;
            results[current] = await mapper(items[current], current);
        }
    });

    await Promise.all(workers);
    return results;
}

function shouldForwardRefreshToAdmin(refresh, cacheOnly) {
    return refresh === true
        && cacheOnly !== true
        && process.env.IS_WORKER_PROCESS === 'true'
        && process.env.IS_ADMIN_PROCESS !== 'true';
}

async function forwardUsageRefreshToAdmin(req, res) {
    const adminPort = Number.parseInt(process.env.ADMIN_PORT || '1456', 10) || 1456;
    const targetUrl = new URL(req.url, `http://127.0.0.1:${adminPort}`);
    targetUrl.protocol = 'http:';
    targetUrl.hostname = '127.0.0.1';
    targetUrl.port = String(adminPort);

    const headers = {};
    if (req.headers.authorization) {
        headers.authorization = req.headers.authorization;
    }
    if (req.headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = req.headers['x-forwarded-for'];
    }

    const timeoutMs = Number.parseInt(process.env.USAGE_ADMIN_FORWARD_TIMEOUT_MS || '120000', 10) || 120000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        console.log(`[Usage API] Forwarding refresh request from worker to admin: ${targetUrl.pathname}${targetUrl.search}`);
        const response = await fetch(targetUrl, {
            method: req.method || 'GET',
            headers,
            signal: controller.signal
        });
        const body = await response.text();
        res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'application/json'
        });
        res.end(body);
        return true;
    } catch (error) {
        const message = error?.name === 'AbortError'
            ? `Admin usage refresh timed out after ${timeoutMs}ms`
            : `Admin usage refresh forward failed: ${error.message}`;
        console.error('[Usage API] Failed to forward refresh request to admin:', error.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
        return true;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    try {
        // 解析查询参数
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const cacheOnly = url.searchParams.get('cacheOnly') === 'true';
        const includeInstances = url.searchParams.get('includeInstances') === 'true';
        const summaryOnly = url.searchParams.get('summaryOnly') === 'true';
        const thresholds = getUsageThresholds(currentConfig);

        if (shouldForwardRefreshToAdmin(refresh, cacheOnly)) {
            return await forwardUsageRefreshToAdmin(req, res);
        }

        let usageResults;

        if (cacheOnly || !refresh) {
            // 缓存模式：从数据库读取已存储的用量信息
            console.log('[Usage API] Returning cached usage data from providers table');
            if (!includeInstances || summaryOnly) {
                usageResults = await getAllProvidersUsageSummaryFromCache(currentConfig);
            } else {
                usageResults = await getAllProvidersUsageFromCache(currentConfig, providerPoolManager);
                usageResults.fromCache = true;
            }
        } else {
            // 刷新模式：获取最新用量数据
            console.log('[Usage API] Fetching usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
        }

        if (usageResults && typeof usageResults === 'object' && usageResults.providers) {
            const normalizedProviders = {};
            for (const [type, data] of Object.entries(usageResults.providers || {})) {
                const normalized = normalizeUsageResult(data, thresholds);
                if ((cacheOnly && !includeInstances) || summaryOnly) {
                    const compact = { ...normalized };
                    if (compact.instances) {
                        delete compact.instances;
                    }
                    normalizedProviders[type] = compact;
                } else {
                    normalizedProviders[type] = normalized;
                }
            }
            usageResults = {
                ...usageResults,
                providers: normalizedProviders,
                thresholds: usageResults.thresholds || thresholds
            };
        } else {
            usageResults = normalizeUsageResult(usageResults, thresholds);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(usageResults));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const cacheOnly = url.searchParams.get('cacheOnly') === 'true';
        const includeRaw = url.searchParams.get('includeRaw') === 'true';
        const uuid = url.searchParams.get('uuid');
        const poolIdParam = url.searchParams.get('poolId');
        const parsedPoolId = poolIdParam !== null && poolIdParam !== undefined && poolIdParam !== ''
            ? Number(poolIdParam)
            : null;
        const poolId = Number.isFinite(parsedPoolId) ? parsedPoolId : null;
        const thresholds = getUsageThresholds(currentConfig);

        if (shouldForwardRefreshToAdmin(refresh, cacheOnly)) {
            return await forwardUsageRefreshToAdmin(req, res);
        }

        let usageResults;
        if (cacheOnly || !refresh) {
            console.log(`[Usage API] Returning cached usage data for ${providerType}`);
            usageResults = await getProviderTypeUsageFromCache(providerType, currentConfig, providerPoolManager, {
                poolId,
                uuid
            });
            usageResults.fromCache = true;
        } else {
            console.log(`[Usage API] Fetching usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                poolId,
                uuid,
                includeRaw
            });
        }

        usageResults = normalizeUsageResult(usageResults, thresholds);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(usageResults));
        return true;
    } catch (error) {
        console.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}
