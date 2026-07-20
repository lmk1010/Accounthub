import { getRequestBody } from '../utils/common.js';
import { peekServiceAdapter, deleteServiceInstancesByUuid, getServiceAdapter } from '../providers/adapter.js';
import * as providerDao from '../dao/provider-dao.js';
import * as providerBindingDao from '../dao/provider-binding-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as providerErrorLogsDao from '../dao/provider-error-logs-dao.js';
import * as providerStatusLogsDao from '../dao/provider-status-logs-dao.js';
import * as providerUsageDao from '../dao/provider-usage-dao.js';
import * as requestLogsDao from '../dao/request-logs-dao.js';
import { getAllProviderModels, getProviderModels } from '../providers/provider-models.js';
import { generateUUID, createProviderConfig, formatSystemPath, detectProviderFromPath, addToUsedPaths, isPathUsed, pathsEqual } from '../utils/provider-utils.js';
import { parseOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { broadcastEvent } from './event-broadcast.js';
import { resolveProviderStatus } from '../utils/provider-status.js';
import { concurrencyLimiter } from '../services/concurrency-limiter.js';

/**
 * 辅助函数：转换提供商配置为数据库格式
 */
function convertToDbFormat(provider, providerType) {
    return {
        uuid: provider.uuid,
        provider_type: providerType,
        pool_id: provider.poolId ?? provider.pool_id ?? null,
        custom_name: provider.customName || null,
        oauth_credential_id: provider.oauthCredentialId || provider.oauth_credential_id || null,
        credentials: provider,
        is_healthy: provider.isHealthy !== undefined ? provider.isHealthy : true,
        is_disabled: provider.isDisabled || false,
        usage_count: provider.usageCount || 0,
        error_count: provider.errorCount || 0,
        last_used: provider.lastUsed || null,
        last_error_time: provider.lastErrorTime || null,
        last_error_message: provider.lastErrorMessage || null,
        last_health_check_time: provider.lastHealthCheckTime || null,
        scheduled_recovery_time: provider.scheduledRecoveryTime || null,
        check_health: provider.checkHealth || false,
        check_model_name: provider.checkModelName || null,
        last_health_check_model: provider.lastHealthCheckModel || null,
        not_supported_models: provider.notSupportedModels || null
    };
}

function normalizeProviderEntry(provider) {
    if (!provider || typeof provider !== 'object') {
        return provider;
    }
    const credentials = provider.credentials && typeof provider.credentials === 'object' ? provider.credentials : {};
    const normalized = {
        ...credentials,
        ...provider,
        customName: provider.custom_name ?? provider.customName ?? credentials.customName ?? null,
        poolId: provider.pool_id ?? provider.poolId ?? credentials.poolId ?? null,
        isHealthy: provider.is_healthy ?? provider.isHealthy ?? credentials.isHealthy ?? true,
        isDisabled: provider.is_disabled ?? provider.isDisabled ?? credentials.isDisabled ?? false,
        isDeleted: provider.is_deleted ?? provider.isDeleted ?? credentials.isDeleted ?? false,
        usageCount: provider.usage_count ?? provider.usageCount ?? credentials.usageCount ?? 0,
        errorCount: provider.error_count ?? provider.errorCount ?? credentials.errorCount ?? 0,
        lastUsed: provider.last_used ?? provider.lastUsed ?? credentials.lastUsed ?? null,
        lastErrorTime: provider.last_error_time ?? provider.lastErrorTime ?? credentials.lastErrorTime ?? null,
        lastErrorMessage: provider.last_error_message ?? provider.lastErrorMessage ?? credentials.lastErrorMessage ?? null,
        lastHealthCheckTime: provider.last_health_check_time ?? provider.lastHealthCheckTime ?? credentials.lastHealthCheckTime ?? null,
        scheduledRecoveryTime: provider.scheduled_recovery_time ?? provider.scheduledRecoveryTime ?? credentials.scheduledRecoveryTime ?? null,
        checkHealth: Boolean(provider.check_health ?? provider.checkHealth ?? credentials.checkHealth ?? false),
        checkModelName: provider.check_model_name ?? provider.checkModelName ?? credentials.checkModelName ?? null,
        lastHealthCheckModel: provider.last_health_check_model ?? provider.lastHealthCheckModel ?? credentials.lastHealthCheckModel ?? null,
        notSupportedModels: provider.not_supported_models ?? provider.notSupportedModels ?? credentials.notSupportedModels ?? null,
        oauthCredentialId: provider.oauth_credential_id ?? provider.oauthCredentialId ?? credentials.oauthCredentialId ?? null
    };

    const status = resolveProviderStatus(normalized);
    normalized.status = status;
    normalized.isCooldown = status === 'cooldown';
    return normalized;
}

function normalizePoolIdValue(poolId) {
    if (poolId === null || poolId === undefined || poolId === '') {
        return null;
    }
    const parsed = Number.parseInt(poolId, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function syncProviderPoolAssociations(providerType, provider, nextPoolId, options = {}) {
    if (!provider?.uuid) {
        return false;
    }

    const currentPoolId = normalizePoolIdValue(
        provider.pool_id ?? provider.poolId ?? provider.credentials?.poolId ?? null
    );
    const normalizedNextPoolId = normalizePoolIdValue(nextPoolId);

    if (currentPoolId === normalizedNextPoolId) {
        return false;
    }

    if (provider.oauth_credential_id || provider.oauthCredentialId) {
        await oauthCredentialsDao.updatePoolId(
            provider.oauth_credential_id || provider.oauthCredentialId,
            normalizedNextPoolId
        );
    }

    await providerBindingDao.deleteBindingsByProviderUuid(provider.uuid);

    await recordProviderStatusLog(provider, providerType, {
        action: options.action || 'move_pool',
        fromStatus: resolveProviderStatus(provider),
        toStatus: resolveProviderStatus(provider),
        reason: options.reason || 'manual_move_pool',
        source: options.source || 'manual',
        metadata: {
            fromPoolId: currentPoolId ?? 0,
            toPoolId: normalizedNextPoolId ?? 0
        }
    });

    return true;
}

async function recordProviderStatusLog(provider, providerType, options) {
    if (!provider?.uuid || !options?.action) {
        return;
    }
    const fromStatus = options.fromStatus ?? resolveProviderStatus(provider);
    const toStatus = options.toStatus ?? fromStatus;
    try {
        await providerStatusLogsDao.create({
            providerUuid: provider.uuid,
            providerType: providerType || provider.provider_type || null,
            poolId: provider.pool_id ?? provider.poolId ?? 0,
            action: options.action,
            fromStatus,
            toStatus,
            reason: options.reason || null,
            source: options.source || null,
            metadata: options.metadata || null
        });
    } catch (error) {
        console.error('[ProviderAPI] Failed to record status log:', error);
    }
}

async function refreshPoolManager(providerPoolManager) {
    if (!providerPoolManager) {
        return;
    }
    if (typeof providerPoolManager.reload === 'function') {
        await providerPoolManager.reload();
        return;
    }
    if (typeof providerPoolManager.initialize === 'function') {
        await refreshPoolManager(providerPoolManager);
    }
}

function hasUnhealthyRelayState(provider) {
    const credentials = provider?.credentials && typeof provider.credentials === 'object'
        ? provider.credentials
        : {};
    const relayState = String(credentials?.relayState || '').trim().toLowerCase();
    return relayState && relayState !== 'healthy';
}

async function resetProviderToHealthy(providerType, provider, providerPoolManager) {
    if (!provider?.uuid) return;

    if (providerPoolManager && typeof providerPoolManager.markProviderHealthy === 'function') {
        await providerPoolManager.markProviderHealthy(providerType, provider.uuid, {
            action: 'reset_health',
            source: 'manual',
            reason: 'manual_reset'
        });
        return;
    }

    const credentials = provider?.credentials && typeof provider.credentials === 'object'
        ? provider.credentials
        : {};

    const nextCredentials = {
        ...credentials,
        relayState: 'healthy',
        relayStateReason: 'manual_reset',
        relayStateSource: 'manual',
        relayStateUpdatedAt: new Date().toISOString(),
        relayStateRecoverAt: null,
        relayStateStatusCode: null,
        relayStateMetadata: null,
        relayConsecutiveErrors: 0
    };

    await providerDao.update(provider.uuid, {
        is_healthy: true,
        is_deleted: false,
        error_count: 0,
        last_error_time: null,
        last_error_message: null,
        scheduled_recovery_time: null,
        credentials: nextCredentials
    });
}

/**
 * 获取提供商池摘要（轻量级，只返回统计信息）
 */
export async function handleGetProvidersSummary(req, res, currentConfig, providerPoolManager) {
    try {
        // 只返回统计信息，不返回完整的账号列表
        // 需要从数据库获取包含已删除账号的完整统计
        const summary = {};

        // 获取所有提供商类型（包括已删除的）
        const allProvidersIncludeDeleted = await providerDao.findAll(null, { includeDeleted: true });
        const providersByType = {};
        for (const provider of allProvidersIncludeDeleted) {
            const providerType = provider.provider_type;
            if (!providersByType[providerType]) {
                providersByType[providerType] = [];
            }
            providersByType[providerType].push(provider);
        }

        for (const [providerType, providers] of Object.entries(providersByType)) {
            const healthy = providers.filter(p => p.is_healthy && !p.is_disabled && !p.is_deleted).length;
            const disabled = providers.filter(p => p.is_disabled && !p.is_deleted).length;
            const unhealthy = providers.filter(p => !p.is_healthy && !p.is_deleted).length;
            const deleted = providers.filter(p => p.is_deleted).length;
            const activeProviders = providers.filter(p => !p.is_deleted);
            summary[providerType] = {
                total: activeProviders.length,
                totalWithDeleted: providers.length,
                enabled: activeProviders.filter(p => !p.is_disabled).length,
                healthy,
                unhealthy,
                disabled,
                deleted
            };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get provider summary:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取提供商池完整数据
 */
export async function handleGetProviders(req, res, currentConfig, providerPoolManager) {
    try {
        const providerPools = {};
        const allProviders = await providerDao.findAll();
        for (const provider of allProviders) {
            const providerType = provider.provider_type;
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }
            providerPools[providerType].push(provider);
        }

        const normalizedPools = {};
        for (const [providerType, providers] of Object.entries(providerPools)) {
            normalizedPools[providerType] = providers.map(normalizeProviderEntry);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(normalizedPools));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取特定提供商类型的详细信息
 */
export async function handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        let providers = [];
        let totalCount = 0;
        let healthyCount = 0;
        let disabledCount;
        let deletedCount;
        let cooldownCount;
        let unhealthyCount;
        let totalWithDeleted;

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pageParam = parseInt(requestUrl.searchParams.get('page'), 10);
    const pageSizeParam = parseInt(requestUrl.searchParams.get('pageSize'), 10);
    const limitParam = parseInt(requestUrl.searchParams.get('limit'), 10);
    const offsetParam = parseInt(requestUrl.searchParams.get('offset'), 10);
    const filterParam = requestUrl.searchParams.get('filter') || 'all';
    const poolIdParam = requestUrl.searchParams.get('poolId');
    const poolId = poolIdParam !== null && poolIdParam !== undefined ? poolIdParam : null;
    const sortBy = requestUrl.searchParams.get('sortBy') || 'created_at';
    const sortOrder = requestUrl.searchParams.get('sortOrder') || 'DESC';
    const createdAfter = requestUrl.searchParams.get('createdAfter') || null;
    const createdBefore = requestUrl.searchParams.get('createdBefore') || null;

        const hasPagination =
            Number.isFinite(pageParam) ||
            Number.isFinite(pageSizeParam) ||
            Number.isFinite(limitParam) ||
            Number.isFinite(offsetParam);

        let pageSize = 0;
        let page = 1;
        let offset = 0;

        if (hasPagination) {
            pageSize = Number.isFinite(pageSizeParam) ? pageSizeParam : (Number.isFinite(limitParam) ? limitParam : 20);
            if (!Number.isFinite(pageSize) || pageSize <= 0) {
                pageSize = 20;
            }
            pageSize = Math.min(Math.max(1, Math.floor(pageSize)), 500);

            if (Number.isFinite(pageParam) && pageParam > 0) {
                page = pageParam;
                offset = Math.max(0, Math.floor((page - 1) * pageSize));
            } else if (Number.isFinite(offsetParam) && offsetParam >= 0) {
                offset = Math.max(0, Math.floor(offsetParam));
                page = Math.floor(offset / pageSize) + 1;
            }

            const includeDeleted = filterParam === 'all' || filterParam === 'deleted' || filterParam === 'problem';
            const [counts, pageProviders] = await Promise.all([
                providerDao.getTypeCounts(providerType, filterParam, poolId, { createdAfter, createdBefore }),
                providerDao.findPaged(providerType, {
                    limit: pageSize,
                    offset,
                    filter: filterParam,
                    includeDeleted,
                    poolId,
                    sortBy,
                    sortOrder,
                    createdAfter,
                    createdBefore
                })
            ]);
            totalCount = counts.totalCount;
            healthyCount = counts.healthyCount;
            disabledCount = counts.disabledCount;
            deletedCount = counts.deletedCount;
            cooldownCount = counts.cooldownCount;
            unhealthyCount = counts.unhealthyCount;
            totalWithDeleted = counts.totalWithDeleted;
            providers = pageProviders;
        } else {
            const includeDeleted = filterParam === 'all' || filterParam === 'deleted' || filterParam === 'problem';
            providers = await providerDao.findAll(providerType, { poolId, includeDeleted });
            totalCount = providers.length;
            healthyCount = providers.filter(p => p.is_healthy && !p.is_disabled).length;
            disabledCount = providers.filter(p => p.is_disabled).length;
            deletedCount = providers.filter(p => p.is_deleted).length;
            totalWithDeleted = totalCount;
        }

        const normalizedProviders = providers.map(normalizeProviderEntry);
        if (totalWithDeleted === undefined || totalWithDeleted === null) {
            totalWithDeleted = totalCount;
        }
        if (disabledCount === undefined || disabledCount === null) {
            disabledCount = normalizedProviders.filter(p => p.isDisabled).length;
        }
        if (deletedCount === undefined || deletedCount === null) {
            deletedCount = normalizedProviders.filter(p => p.isDeleted).length;
        }
        if (cooldownCount === undefined || cooldownCount === null) {
            cooldownCount = normalizedProviders.filter(p => p.isCooldown).length;
        }
        if (unhealthyCount === undefined || unhealthyCount === null) {
            unhealthyCount = normalizedProviders.filter(p => !p.isDeleted && !p.isDisabled && !p.isHealthy && !p.isCooldown).length;
        }

        // 批量获取每个账号的近期用户数
        const uuids = normalizedProviders.map(p => p.uuid).filter(Boolean);
        const recentUserCounts = await concurrencyLimiter.getBatchRecentUserCounts(uuids);

        // 将用户数附加到每个 provider
        for (const provider of normalizedProviders) {
            provider.recentUserCount = recentUserCounts[provider.uuid] || 0;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            providerType,
            providers: normalizedProviders,
            totalCount,
            healthyCount,
            disabledCount,
            deletedCount,
            cooldownCount,
            unhealthyCount,
            totalWithDeleted,
            page: hasPagination ? page : undefined,
            pageSize: hasPagination ? pageSize : undefined
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get provider type:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取所有提供商的可用模型
 */
export async function handleGetProviderModels(req, res) {
    const allModels = getAllProviderModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allModels));
    return true;
}

/**
 * 获取特定提供商类型的可用模型
 */
export async function handleGetProviderTypeModels(req, res, providerType) {
    const models = getProviderModels(providerType);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        models
    }));
    return true;
}

/**
 * 添加新的提供商配置
 */
export async function handleAddProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { providerType, providerConfig, poolId } = body;

        if (!providerType || !providerConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerType and providerConfig are required' } }));
            return true;
        }

        // Generate UUID if not provided
        if (!providerConfig.uuid) {
            providerConfig.uuid = generateUUID();
        }

        // Set default values
        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        if (providerConfig.checkHealth === undefined) {
            providerConfig.checkHealth = providerType === 'claude-kiro-oauth';
        }
        providerConfig.lastUsed = providerConfig.lastUsed || null;
        providerConfig.usageCount = providerConfig.usageCount || 0;
        providerConfig.errorCount = providerConfig.errorCount || 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;
        if (poolId !== undefined) {
            providerConfig.poolId = poolId;
        }

        // 转换为数据库格式
        const dbProvider = {
            uuid: providerConfig.uuid,
            provider_type: providerType,
            pool_id: providerConfig.poolId ?? null,
            custom_name: providerConfig.customName || null,
            credentials: providerConfig,
            is_healthy: providerConfig.isHealthy,
            is_disabled: providerConfig.isDisabled || false,
            usage_count: providerConfig.usageCount || 0,
            error_count: providerConfig.errorCount || 0,
            last_used: providerConfig.lastUsed || null,
            last_error_time: providerConfig.lastErrorTime || null,
            last_error_message: providerConfig.lastErrorMessage || null,
            check_health: providerConfig.checkHealth || false,
            check_model_name: providerConfig.checkModelName || null,
            not_supported_models: providerConfig.notSupportedModels || null
        };

        // 保存到数据库
        await providerDao.create(dbProvider);
        console.log(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播提供商更新事件
        broadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider added successfully',
            provider: providerConfig,
            providerType
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 更新特定提供商配置
 */
export async function handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const body = await getRequestBody(req);
        const { providerConfig, poolId } = body;
        const hasExplicitPoolId = Object.prototype.hasOwnProperty.call(body || {}, 'poolId');

        if (!providerConfig && !hasExplicitPoolId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerConfig or poolId is required' } }));
            return true;
        }

        // 从数据库获取现有提供商
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const normalizedPoolId = hasExplicitPoolId ? normalizePoolIdValue(poolId) : null;
        if (hasExplicitPoolId && poolId !== null && poolId !== '' && normalizedPoolId === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid poolId' } }));
            return true;
        }

        // 合并配置（保留某些字段）
        const updatedProvider = {
            ...existingProvider.credentials,
            ...(providerConfig || {}),
            uuid: providerUuid,
            poolId: hasExplicitPoolId
                ? normalizedPoolId
                : (existingProvider.pool_id ?? existingProvider.credentials?.poolId ?? null),
            lastUsed: existingProvider.last_used,
            usageCount: existingProvider.usage_count,
            errorCount: existingProvider.error_count,
            lastErrorTime: existingProvider.last_error_time
        };

        // 更新数据库
        const dbProvider = convertToDbFormat(updatedProvider, providerType);
        await providerDao.update(providerUuid, dbProvider);
        await syncProviderPoolAssociations(providerType, existingProvider, updatedProvider.poolId, {
            reason: 'manual_move_pool',
            source: 'manual'
        });
        console.log(`[UI API] Updated provider ${providerUuid} in ${providerType}`);

        // 清除缓存的 service adapter(含 proxy 变体),使下次请求使用新配置
        // 使用 byUuid 版本,避免漏掉带 proxy 后缀的 key
        const removed = deleteServiceInstancesByUuid(providerUuid);
        if (removed > 0) {
            console.log(`[UI API] Invalidated ${removed} cached service adapter(s) for uuid ${providerUuid}`);
        }

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider updated successfully',
            provider: updatedProvider
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商配置
 */
export async function handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        // 从数据库获取提供商
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const deletedProvider = existingProvider.credentials;
        const prevStatus = resolveProviderStatus(existingProvider);
        await recordProviderStatusLog(existingProvider, providerType, {
            action: 'delete',
            fromStatus: prevStatus,
            toStatus: 'deleted',
            reason: 'manual_delete',
            source: 'manual'
        });

        // 软删除
        await providerDao.markDeleted(providerUuid, 'manual_delete');
        console.log(`[UI API] Soft-deleted provider ${providerUuid} from ${providerType}`);

        // 释放关联的凭据，使其可被重新关联
        if (existingProvider.oauth_credential_id) {
            await oauthCredentialsDao.markUnusedByProvider(providerUuid);
            console.log(`[UI API] Released credential for deleted provider ${providerUuid}`);
        }

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            providerType,
            providerConfig: deletedProvider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 彻底删除特定提供商配置
 */
export async function handleHardDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const deletedProvider = existingProvider.credentials;
        const oauthCredentialId = existingProvider.oauth_credential_id || existingProvider.oauthCredentialId || null;
        const cleanupTasks = [
            providerUsageDao.deleteByProviderUuid(providerUuid),
            providerErrorLogsDao.deleteByUuid(providerUuid),
            providerStatusLogsDao.deleteByUuid(providerUuid),
            requestLogsDao.clearByProviderUuid(providerUuid),
            oauthCredentialsDao.deleteByProviderUuid(providerUuid)
        ];
        if (oauthCredentialId) {
            cleanupTasks.push(oauthCredentialsDao.deleteById(oauthCredentialId));
        }

        const cleanupResults = await Promise.allSettled(cleanupTasks);
        cleanupResults.forEach((result, index) => {
            if (result.status === 'rejected') {
                console.warn(`[UI API] Hard delete cleanup failed (${index}) for ${providerUuid}:`, result.reason?.message || result.reason);
            }
        });

        await providerDao.deleteProvider(providerUuid);
        console.log(`[UI API] Hard-deleted provider ${providerUuid} from ${providerType}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'hard_delete',
            providerType,
            providerConfig: deletedProvider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider hard deleted successfully',
            deletedProvider
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 禁用/启用特定提供商配置
 */
export async function handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    try {
        // 从数据库获取提供商
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const nextDisabled = action === 'disable';
        const prevStatus = resolveProviderStatus(existingProvider);

        // 更新 is_disabled 字段
        await providerDao.update(providerUuid, {
            is_disabled: nextDisabled
        });
        console.log(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

        const nextStatus = resolveProviderStatus({ ...existingProvider, is_disabled: nextDisabled });
        if (prevStatus !== nextStatus) {
            await recordProviderStatusLog(existingProvider, providerType, {
                action: action === 'disable' ? 'disable' : 'enable',
                fromStatus: prevStatus,
                toStatus: nextStatus,
                reason: action === 'disable' ? 'manual_disable' : 'manual_enable',
                source: 'manual'
            });
        }

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: action,
            providerType,
            providerConfig: existingProvider.credentials,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Provider ${action}d successfully`,
            provider: existingProvider.credentials
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重置特定提供商类型的所有提供商健康状态
 */
export async function handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 从数据库获取该类型的所有提供商（包含已删除的，以便重置恢复）
        const providers = await providerDao.findAll(providerType, { includeDeleted: true });

        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 重置不健康提供商的健康状态
        let resetCount = 0;
        const updates = [];
        const logTasks = [];

        for (const provider of providers) {
            if (!provider.is_healthy || provider.is_deleted || hasUnhealthyRelayState(provider)) {
                const prevStatus = resolveProviderStatus(provider);
                const nextStatus = resolveProviderStatus({ ...provider, is_healthy: true, is_deleted: false });
                updates.push(resetProviderToHealthy(providerType, provider, providerPoolManager));
                if (prevStatus !== nextStatus) {
                    logTasks.push(
                        recordProviderStatusLog(provider, providerType, {
                            action: 'reset_health',
                            fromStatus: prevStatus,
                            toStatus: nextStatus,
                            reason: 'manual_reset',
                            source: 'manual'
                        })
                    );
                }
                resetCount++;
            }
        }

        // 批量执行更新
        await Promise.all(updates);
        await Promise.all(logTasks);
        console.log(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reset_health',
            providerType,
            resetCount,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully reset health status for ${resetCount} providers`,
            resetCount,
            totalCount: providers.length
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重置单个提供商的健康状态
 */
export async function handleResetSingleProviderHealth(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const prevStatus = resolveProviderStatus(existingProvider);
        await resetProviderToHealthy(providerType, existingProvider, providerPoolManager);

        const nextStatus = resolveProviderStatus({ ...existingProvider, is_healthy: true, is_deleted: false });
        if (prevStatus !== nextStatus) {
            await recordProviderStatusLog(existingProvider, providerType, {
                action: 'reset_health',
                fromStatus: prevStatus,
                toStatus: nextStatus,
                reason: 'manual_reset',
                source: 'manual'
            });
        }

        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        broadcastEvent('config_update', {
            action: 'reset_single_health',
            providerType,
            providerUuid,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Health status reset successfully',
            providerUuid
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商类型的所有不健康节点
 */
export async function handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 从数据库获取该类型的所有提供商
        const providers = await providerDao.findAll(providerType);

        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 筛选出不健康的提供商
        const unhealthyProviders = providers.filter(p => !p.is_healthy);
        const healthyProviders = providers.filter(p => p.is_healthy);

        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to delete',
                deletedCount: 0,
                remainingCount: providers.length
            }));
            return true;
        }

        // 批量删除不健康的提供商
        const logTasks = [];
        const deletions = unhealthyProviders.map(async (p) => {
            const prevStatus = resolveProviderStatus(p);
            logTasks.push(
                recordProviderStatusLog(p, providerType, {
                    action: 'delete',
                    fromStatus: prevStatus,
                    toStatus: 'deleted',
                    reason: 'delete_unhealthy',
                    source: 'manual'
                })
            );
            await providerDao.markDeleted(p.uuid, 'delete_unhealthy');
            if (p.oauth_credential_id) {
                await oauthCredentialsDao.markUnusedByProvider(p.uuid);
            }
        });
        await Promise.all(deletions);
        await Promise.all(logTasks);

        console.log(`[UI API] Deleted ${unhealthyProviders.length} unhealthy providers from ${providerType}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete_unhealthy',
            providerType,
            deletedCount: unhealthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => ({
                uuid: p.uuid,
                customName: p.custom_name
            })),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully deleted ${unhealthyProviders.length} unhealthy providers`,
            deletedCount: unhealthyProviders.length,
            remainingCount: healthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => ({
                uuid: p.uuid,
                customName: p.custom_name
            }))
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 按 UUID 批量转移账号到指定池子
 */
export async function handleBatchMoveProviders(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const body = await getRequestBody(req);
        const uuids = Array.isArray(body?.uuids)
            ? [...new Set(body.uuids.map((item) => String(item || '').trim()).filter(Boolean))]
            : [];
        const targetPoolIdRaw = body?.targetPoolId;
        const targetPoolId = normalizePoolIdValue(targetPoolIdRaw);

        if (!uuids.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'uuids is required' } }));
            return true;
        }

        if (targetPoolIdRaw === null || targetPoolIdRaw === undefined || targetPoolIdRaw === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'targetPoolId is required' } }));
            return true;
        }

        if (targetPoolIdRaw !== null && targetPoolIdRaw !== undefined && targetPoolIdRaw !== '' && targetPoolId === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid targetPoolId' } }));
            return true;
        }

        const providers = await Promise.all(uuids.map((uuid) => providerDao.findByUuid(uuid)));
        const existingProviders = providers.filter(Boolean);
        const missingUuids = uuids.filter((uuid, index) => !providers[index]);
        const mismatchedProviders = existingProviders.filter((provider) => provider.provider_type !== providerType);

        if (mismatchedProviders.length > 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Selected providers do not belong to the same provider type' } }));
            return true;
        }

        let movedCount = 0;
        let skippedCount = 0;

        for (const provider of existingProviders) {
            const currentPoolId = normalizePoolIdValue(
                provider.pool_id ?? provider.poolId ?? provider.credentials?.poolId ?? null
            );

            if (currentPoolId === targetPoolId) {
                skippedCount += 1;
                continue;
            }

            const nextCredentials = {
                ...(provider.credentials && typeof provider.credentials === 'object' ? provider.credentials : {}),
                poolId: targetPoolId
            };

            await providerDao.update(provider.uuid, {
                pool_id: targetPoolId,
                credentials: nextCredentials
            });
            await syncProviderPoolAssociations(providerType, provider, targetPoolId, {
                reason: 'batch_move_pool',
                source: 'manual_batch'
            });
            deleteServiceInstancesByUuid(provider.uuid);
            movedCount += 1;
        }

        if (movedCount > 0 && providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        if (movedCount > 0) {
            broadcastEvent('config_update', {
                action: 'batch_move_pool',
                providerType,
                movedCount,
                skippedCount,
                missingCount: missingUuids.length,
                targetPoolId: targetPoolId ?? 0,
                timestamp: new Date().toISOString()
            });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            movedCount,
            skippedCount,
            missingCount: missingUuids.length,
            targetPoolId: targetPoolId ?? 0,
            missingUuids,
            message: `成功转移 ${movedCount} 个账号`
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Batch move providers failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 按筛选条件返回全部 UUID（用于跨页全选）
 */
export async function handleGetProviderUuidsByFilter(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const filter = requestUrl.searchParams.get('filter') || 'all';
        const createdAfter = requestUrl.searchParams.get('createdAfter') || null;
        const createdBefore = requestUrl.searchParams.get('createdBefore') || null;
        const search = requestUrl.searchParams.get('search') || '';
        const poolIdRaw = requestUrl.searchParams.get('poolId');
        const poolId = normalizePoolIdValue(poolIdRaw);

        if (poolIdRaw !== null && poolIdRaw !== undefined && poolIdRaw !== '' && poolId === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid poolId' } }));
            return true;
        }

        const matched = await providerDao.findUuidsByFilter(providerType, {
            filter,
            poolId,
            createdAfter,
            createdBefore,
            search
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            uuids: matched.map((row) => row.uuid).filter(Boolean),
            totalCount: matched.length
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Get provider uuids by filter failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 按筛选条件批量删除（跨页）
 */
export async function handleBatchDeleteByFilter(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const body = await getRequestBody(req);
        const { filter = 'all', poolId = null, createdAfter = null, createdBefore = null, mode = 'soft' } = body || {};

        // 查出所有匹配的 provider
        const matched = await providerDao.findUuidsByFilter(providerType, { filter, poolId, createdAfter, createdBefore });

        if (matched.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, deletedCount: 0, message: '没有匹配的记录' }));
            return true;
        }

        // 逐条删除
        const deletions = matched.map(async (row) => {
            if (mode === 'hard') {
                // 硬删除：清理关联数据后物理删除
                await Promise.allSettled([
                    providerUsageDao.deleteByProviderUuid(row.uuid),
                    providerErrorLogsDao.deleteByUuid(row.uuid),
                    providerStatusLogsDao.deleteByUuid(row.uuid),
                    requestLogsDao.clearByProviderUuid(row.uuid),
                    oauthCredentialsDao.deleteByProviderUuid(row.uuid),
                    row.oauth_credential_id ? oauthCredentialsDao.deleteById(row.oauth_credential_id) : Promise.resolve()
                ]);
                await providerDao.deleteProvider(row.uuid);
            } else {
                // 软删除
                await providerDao.markDeleted(row.uuid, 'batch_delete_by_filter');
                if (row.oauth_credential_id) {
                    await oauthCredentialsDao.markUnusedByProvider(row.uuid);
                }
            }
        });
        await Promise.all(deletions);

        console.log(`[UI API] Batch ${mode}-deleted ${matched.length} providers from ${providerType} by filter`);

        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        broadcastEvent('config_update', {
            action: 'batch_delete_by_filter',
            providerType,
            deletedCount: matched.length,
            mode,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            deletedCount: matched.length,
            mode,
            message: `成功${mode === 'hard' ? '硬' : '软'}删除 ${matched.length} 个账号`
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Batch delete by filter failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 批量刷新特定提供商类型的所有不健康节点的 UUID
 */
export async function handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 从数据库获取该类型的所有提供商
        const providers = await providerDao.findAll(providerType);

        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 筛选不健康的提供商并刷新 UUID
        const refreshedProviders = [];
        const operations = [];

        for (const provider of providers) {
            if (!provider.is_healthy) {
                const oldUuid = provider.uuid;
                const newUuid = generateUUID();
                const oauthCredentialId = provider.oauth_credential_id || provider.credentials?.oauthCredentialId || null;

                // 更新 credentials 中的 uuid
                const updatedCredentials = {
                    ...provider.credentials,
                    uuid: newUuid,
                    oauthCredentialId: oauthCredentialId
                };

                // 删除旧记录并创建新记录
                operations.push(
                    providerDao.deleteProvider(oldUuid)
                        .then(() => oauthCredentialsDao.markUnusedByProvider(oldUuid))
                        .then(() => providerDao.create({
                            ...provider,
                            uuid: newUuid,
                            oauth_credential_id: oauthCredentialId,
                            credentials: updatedCredentials
                        }))
                        .then(() => {
                            if (oauthCredentialId) {
                                return oauthCredentialsDao.markUsed(oauthCredentialId, newUuid);
                            }
                        })
                );

                refreshedProviders.push({
                    oldUuid,
                    newUuid,
                    customName: provider.custom_name
                });
            }
        }

        if (refreshedProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to refresh',
                refreshedCount: 0,
                totalCount: providers.length
            }));
            return true;
        }

        // 批量执行操作
        await Promise.all(operations);
        console.log(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_unhealthy_uuids',
            providerType,
            refreshedCount: refreshedProviders.length,
            refreshedProviders,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
            refreshedCount: refreshedProviders.length,
            totalCount: providers.length,
            refreshedProviders
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 批量更新特定提供商类型的检测模型名称
 */
export async function handleBatchUpdateCheckModelName(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const body = await getRequestBody(req);
        const checkModelName = typeof body?.checkModelName === 'string' ? body.checkModelName.trim() : '';

        if (!checkModelName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'checkModelName is required' } }));
            return true;
        }

        const providers = await providerDao.findAll(providerType);
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        const updates = providers.map(provider => {
            const updatedCredentials = {
                ...(provider.credentials || {}),
                checkModelName
            };
            return providerDao.update(provider.uuid, {
                check_model_name: checkModelName,
                credentials: updatedCredentials
            });
        });

        await Promise.all(updates);
        console.log(`[UI API] Updated check model name for ${providers.length} providers in ${providerType}`);

        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        broadcastEvent('config_update', {
            action: 'batch_check_model_name',
            providerType,
            checkModelName,
            updatedCount: providers.length,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Check model name updated successfully',
            updatedCount: providers.length,
            checkModelName
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 对特定提供商类型的所有提供商执行健康检查
 */
export async function handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        // 读取请求体中的选项
        const body = await getRequestBody(req);
        const checkModelName = body?.checkModelName || null;
        const parsedPoolId = body?.poolId !== undefined && body?.poolId !== null && body?.poolId !== ''
            ? Number(body.poolId)
            : null;
        const poolId = Number.isFinite(parsedPoolId) ? parsedPoolId : null;
        const providerUuid = typeof body?.providerUuid === 'string' && body.providerUuid.trim()
            ? body.providerUuid.trim()
            : null;
        const checkAll = body?.checkAll === true; // 是否检测所有节点（包括健康的）
        const checkMode = typeof body?.checkMode === 'string'
            ? body.checkMode
            : (checkAll ? 'all' : 'unhealthy');
        const includeDeleted = body?.includeDeleted === true || checkMode === 'deleted' || checkMode === 'problem';

        const providers = await providerDao.findAll(providerType, { includeDeleted: true, poolId });

        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 根据 checkAll 选项决定检测范围
        let targetProviders;
        if (checkMode === 'all') {
            // 检测所有未禁用的节点
            targetProviders = providers.filter(p => !p.is_disabled && (includeDeleted || !p.is_deleted));
        } else if (checkMode === 'deleted') {
            // 只检测已删除节点
            targetProviders = providers.filter(p => p.is_deleted && !p.is_disabled);
        } else if (checkMode === 'problem') {
            // 检测异常 + 已删除
            targetProviders = providers.filter(p => !p.is_disabled && (p.is_deleted || !p.is_healthy));
        } else {
            // 只检测不健康的节点
            targetProviders = providers.filter(p => !p.is_healthy && !p.is_deleted && !p.is_disabled);
        }

        if (targetProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: checkMode === 'all'
                    ? 'No active providers to check'
                    : checkMode === 'deleted'
                        ? 'No deleted providers to check'
                        : checkMode === 'problem'
                            ? 'No unhealthy or deleted providers to check'
                            : 'No unhealthy providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            }));
            return true;
        }

        if (providerUuid) {
            targetProviders = targetProviders.filter(p => p.uuid === providerUuid);
        }

        if (targetProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: providerUuid
                    ? `Provider ${providerUuid} not found in selected scope`
                    : 'No providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            }));
            return true;
        }

        console.log(`[UI API] Starting health check for ${targetProviders.length} ${checkMode} providers in ${providerType} (total: ${providers.length}, poolId: ${poolId ?? 'all'})`);

        // 执行健康检测（强制检查，忽略 checkHealth 配置）
        const results = [];
        for (const provider of targetProviders) {
            // 转换为 providerConfig 格式
            const providerConfig = {
                uuid: provider.uuid,
                isHealthy: provider.is_healthy,
                isDisabled: provider.is_disabled,
                pool_id: provider.pool_id,
                ...provider.credentials
            };

            // 跳过已禁用的节点
            if (provider.is_disabled) {
                console.log(`[UI API] Skipping health check for disabled provider: ${provider.uuid}`);
                continue;
            }

            try {
                // 传递 forceCheck = true 强制执行健康检查，忽略 checkHealth 配置
                const healthResult = await providerPoolManager._checkProviderHealth(
                    providerType,
                    providerConfig,
                    true,
                    checkModelName,
                    { source: 'manual_health_check' }
                );

                if (healthResult === null) {
                    results.push({
                        uuid: provider.uuid,
                        success: null,
                        message: 'Health check not supported for this provider type'
                    });
                    continue;
                }

                if (healthResult.success) {
                    if (provider.is_deleted) {
                        const prevStatus = resolveProviderStatus(provider);
                        await providerDao.recoverDeleted(provider.uuid);
                        await recordProviderStatusLog(provider, providerType, {
                            action: 'recover_deleted',
                            fromStatus: prevStatus,
                            toStatus: 'healthy',
                            reason: healthResult.modelName ? `health_check:${healthResult.modelName}` : 'health_check',
                            source: 'manual_health_check'
                        });
                        results.push({
                            uuid: provider.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: healthResult.message || 'Recovered'
                        });
                    } else if (!provider.is_healthy) {
                        // 只有当账号不健康时才标记为健康
                        providerPoolManager.markProviderHealthy(providerType, provider.uuid, {
                            source: 'manual_health_check',
                            action: 'health_check_recover',
                            reason: healthResult.modelName ? `health_check:${healthResult.modelName}` : 'health_check'
                        });
                        results.push({
                            uuid: provider.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: healthResult.message || 'Recovered'
                        });
                    } else {
                        // 账号本来就健康，不记录日志
                        results.push({
                            uuid: provider.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: healthResult.message || 'Already healthy'
                        });
                    }
                } else {
                    // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                    const errorMessage = healthResult.errorMessage || 'Check failed';
                    const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                       /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);

                    if (isAuthError) {
                        providerPoolManager.markProviderUnhealthyImmediately(providerType, provider.uuid, errorMessage, {
                            source: 'manual_health_check',
                            action: 'health_check_fail',
                            reason: errorMessage
                        });
                        console.log(`[UI API] Auth error detected for ${provider.uuid}, immediately marked as unhealthy`);
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, provider.uuid, errorMessage, {
                            source: 'manual_health_check',
                            action: 'health_check_fail',
                            reason: errorMessage
                        });
                    }

                    results.push({
                        uuid: provider.uuid,
                        success: false,
                        modelName: healthResult.modelName,
                        message: errorMessage,
                        isAuthError: isAuthError
                    });
                }
            } catch (error) {
                const errorMessage = error.message || 'Unknown error';
                // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                   /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                
                if (isAuthError) {
                    providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig.uuid, errorMessage, {
                        source: 'manual_health_check',
                        action: 'health_check_fail',
                        reason: errorMessage
                    });
                    console.log(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                } else {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig.uuid, errorMessage, {
                        source: 'manual_health_check',
                        action: 'health_check_fail',
                        reason: errorMessage
                    });
                }
                
                results.push({
                    uuid: providerConfig.uuid,
                    success: false,
                    message: errorMessage,
                    isAuthError: isAuthError
                });
            }
        }

        // 健康检查完成后，providerPoolManager 已经自动更新了数据库
        // 不需要手动保存文件

        const successCount = results.filter(r => r.success === true).length;
        const failCount = results.filter(r => r.success === false).length;

        console.log(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${targetProviders.length} ${checkMode} nodes)`);

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'health_check',
            providerType,
            results,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
            successCount,
            failCount,
            totalCount: providers.length,
            results
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Health check error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 快速链接配置文件到对应的提供商
 */
export async function handleQuickLinkProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { filePath } = body;

        if (!filePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'filePath is required' } }));
            return true;
        }

        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        
        // 根据文件路径自动识别提供商类型
        const providerMapping = detectProviderFromPath(normalizedPath);
        
        if (!providerMapping) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Unable to identify provider type for config file, please ensure file is in configs/kiro/, configs/warp/, configs/gemini/, configs/qwen/, configs/antigravity/ or configs/droid/ directory'
                }
            }));
            return true;
        }

        const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;

        // 从数据库获取该类型的所有提供商
        const existingProviders = await providerDao.findAll(providerType);

        // Check if already linked - 使用标准化路径进行比较
        const normalizedForComparison = filePath.replace(/\\/g, '/');
        const isAlreadyLinked = existingProviders.some(p => {
            const existingPath = p.credentials[credPathKey];
            if (!existingPath) return false;
            const normalizedExistingPath = existingPath.replace(/\\/g, '/');
            return normalizedExistingPath === normalizedForComparison ||
                   normalizedExistingPath === './' + normalizedForComparison ||
                   './' + normalizedExistingPath === normalizedForComparison;
        });

        if (isAlreadyLinked) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'This config file is already linked' } }));
            return true;
        }

        const parsedRef = parseOAuthCredentialRef(filePath);
        const credentialId = parsedRef ? parsedRef.id : null;

        // Create new provider config based on provider type
        const newProvider = createProviderConfig({
            credPathKey,
            credPath: formatSystemPath(filePath),
            credentialId,
            defaultCheckModel,
            needsProjectId: providerMapping.needsProjectId
        });

        // 转换为数据库格式并保存
        const dbProvider = convertToDbFormat(newProvider, providerType);
        const createdProvider = await providerDao.create(dbProvider);
        if (credentialId) {
            await oauthCredentialsDao.markUsed(credentialId, createdProvider.uuid);
        }
        console.log(`[UI API] Quick linked config: ${filePath} -> ${providerType}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // Broadcast update event
        broadcastEvent('config_update', {
            action: 'quick_link',
            providerType,
            newProvider,
            timestamp: new Date().toISOString()
        });

        broadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig: newProvider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Config successfully linked to ${displayName}`,
            provider: newProvider,
            providerType: providerType
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Quick link failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Link failed: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 刷新特定提供商的UUID
 */
export async function handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        // 从数据库获取提供商
        const existingProvider = await providerDao.findByUuid(providerUuid);

        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Generate new UUID
        const oldUuid = providerUuid;
        const newUuid = generateUUID();
        const oauthCredentialId = existingProvider.oauth_credential_id || existingProvider.credentials?.oauthCredentialId || null;

        // 更新 credentials 中的 uuid
        const updatedCredentials = {
            ...existingProvider.credentials,
            uuid: newUuid,
            oauthCredentialId: oauthCredentialId
        };

        // 删除旧记录并创建新记录（因为 UUID 是主键）
        await providerDao.deleteProvider(oldUuid);
        await oauthCredentialsDao.markUnusedByProvider(oldUuid);
        await providerDao.create({
            ...existingProvider,
            uuid: newUuid,
            oauth_credential_id: oauthCredentialId,
            credentials: updatedCredentials
        });
        if (oauthCredentialId) {
            await oauthCredentialsDao.markUsed(oauthCredentialId, newUuid);
        }

        console.log(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);

        // 重新加载 provider pool manager
        if (providerPoolManager) {
            await refreshPoolManager(providerPoolManager);
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_uuid',
            providerType,
            oldUuid,
            newUuid,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'UUID refreshed successfully',
            oldUuid,
            newUuid,
            provider: updatedCredentials
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 刷新特定提供商的Token
 */
export async function handleRefreshProviderToken(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        // 只支持 OAuth 类型的提供商
        const supportedTypes = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-offical', 'openai-codex', 'openai-xai-oauth'];
        if (!supportedTypes.includes(providerType)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Token refresh not supported for provider type: ${providerType}` } }));
            return true;
        }

        // 从数据库获取提供商
        const existingProvider = await providerDao.findByUuid(providerUuid);
        if (!existingProvider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // 获取 adapter 实例(首选直接读缓存,缺失则懒创建)
        const { CONFIG } = await import('../core/config-manager.js');

        const providerKey = providerType + providerUuid;
        let adapter = peekServiceAdapter(providerKey);

        // 如果没有 adapter,尝试初始化
        if (!adapter) {
            // 方案 B 保护:sharded worker 中不要给非本 shard uuid 创建 adapter
            // 管理类 UI 操作(token refresh 等)正常路径:用户→master:1458→sticky dispatcher→owner worker;
            // 若路由到非 owner worker(极端情况),返回 409 引导客户端走 admin UI (1456) 或重试
            try {
                const shard = await import('../utils/shard.js');
                if (shard.SHARD_ENABLED && !shard.ownsUuid(providerUuid)) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: `Provider ${providerUuid.slice(0, 8)} not owned by this shard ${shard.SHARD_ID}/${shard.SHARD_COUNT}. Please use admin UI (port 1456) or target the owner worker shard ${shard.shardOfUuid(providerUuid)}.`
                        }
                    }));
                    return true;
                }
            } catch (_shardErr) { /* 未启用分片时不限制 */ }

            const credentials = existingProvider.credentials || {};
            const serviceConfig = {
                ...CONFIG,
                ...credentials,
                uuid: providerUuid,
                MODEL_PROVIDER: providerType
            };
            adapter = getServiceAdapter(serviceConfig);
        }

        if (!adapter || (typeof adapter.initializeAuth !== 'function' && typeof adapter.refreshToken !== 'function')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider does not support token refresh' } }));
            return true;
        }

        // 强制刷新 Token
        console.log(`[UI API] Refreshing token for provider ${providerUuid} (${providerType})`);
        if (typeof adapter.refreshToken === 'function') {
            await adapter.refreshToken(true);
        } else {
            await adapter.initializeAuth(true); // forceRefresh = true
        }

        console.log(`[UI API] Token refreshed successfully for provider ${providerUuid}`);

        // Kiro 手动刷新后执行一次用量查询验证，避免“刷新成功但仍 403”被误标健康
        if (providerType === 'claude-kiro-oauth' && typeof adapter.getUsageLimits === 'function') {
            try {
                await adapter.getUsageLimits();
            } catch (verifyError) {
                const verifyMessage = verifyError?.message || 'Token refresh verify failed';
                console.warn(`[UI API] Token refresh verify failed for ${providerUuid}: ${verifyMessage}`);

                if (providerPoolManager && typeof providerPoolManager.markProviderUnhealthyImmediately === 'function') {
                    await providerPoolManager.markProviderUnhealthyImmediately(providerType, providerUuid, verifyMessage, {
                        source: 'manual_token_refresh',
                        action: 'refresh_token_verify_fail',
                        reason: verifyMessage
                    });
                } else {
                    await providerDao.markUnhealthy(providerUuid, {
                        isHealthy: false,
                        errorCount: existingProvider.error_count || 1,
                        errorMessage: verifyMessage
                    });
                }

                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Token refreshed but usage verification failed',
                    error: verifyMessage,
                    uuid: providerUuid
                }));
                return true;
            }
        }

        if (providerType === 'claude-kiro-oauth' && !existingProvider.check_health) {
            const nextCredentials = {
                ...(existingProvider.credentials || {}),
                checkHealth: true
            };
            await providerDao.update(providerUuid, {
                check_health: true,
                credentials: nextCredentials
            });
            console.log(`[UI API] Enabled health check for Kiro provider ${providerUuid}`);
        }

        if (existingProvider.is_deleted) {
            await providerDao.recoverDeleted(providerUuid);
            await recordProviderStatusLog(existingProvider, providerType, {
                action: 'refresh_token_recover',
                fromStatus: 'deleted',
                toStatus: 'healthy',
                reason: 'Token refreshed successfully',
                source: 'manual_token_refresh'
            });
            console.log(`[UI API] Recovered deleted provider after token refresh: ${providerUuid}`);
        }

        if (!existingProvider.is_healthy && !existingProvider.is_deleted && providerPoolManager && typeof providerPoolManager.markProviderHealthy === 'function') {
            await providerPoolManager.markProviderHealthy(providerType, providerUuid, {
                source: 'manual_token_refresh',
                action: 'refresh_token_recover',
                reason: 'Token refreshed successfully'
            });
            console.log(`[UI API] Provider marked healthy after token refresh: ${providerUuid}`);
        } else if (!existingProvider.is_healthy && !existingProvider.is_deleted) {
            await providerDao.markHealthy(providerUuid);
            console.log(`[UI API] Provider marked healthy via DAO after token refresh: ${providerUuid}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Token refreshed successfully',
            uuid: providerUuid
        }));
        return true;
    } catch (error) {
        console.error(`[UI API] Failed to refresh token for provider ${providerUuid}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}


/**
 * 获取账号错误历史
 */
export async function handleGetProviderErrorLogs(req, res) {
    try {
        const { uuid } = req.params;
        const { page = 1, pageSize = 10 } = req.query;

        if (!uuid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "uuid is required" }));
            return true;
        }

        const [logs, total] = await Promise.all([
            providerErrorLogsDao.findByUuid(uuid, { page, pageSize }),
            providerErrorLogsDao.countByUuid(uuid)
        ]);

        const pageNum = parseInt(page, 10) || 1;
        const pageSizeNum = parseInt(pageSize, 10) || 10;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            success: true,
            data: logs,
            total,
            page: pageNum,
            pageSize: pageSizeNum,
            totalPages: Math.ceil(total / pageSizeNum)
        }));
        return true;
    } catch (error) {
        console.error("[ProviderAPI] Failed to get error logs:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 获取账号状态流转记录
 */
export async function handleGetProviderStatusLogs(req, res) {
    try {
        const { uuid } = req.params;
        const { page = 1, pageSize = 10 } = req.query;

        if (!uuid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "uuid is required" }));
            return true;
        }

        const [logs, total] = await Promise.all([
            providerStatusLogsDao.findByUuid(uuid, { page, pageSize }),
            providerStatusLogsDao.countByUuid(uuid)
        ]);

        const pageNum = parseInt(page, 10) || 1;
        const pageSizeNum = parseInt(pageSize, 10) || 10;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            success: true,
            data: logs,
            total,
            page: pageNum,
            pageSize: pageSizeNum,
            totalPages: Math.ceil(total / pageSizeNum)
        }));
        return true;
    } catch (error) {
        console.error("[ProviderAPI] Failed to get status logs:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 解析 JWT Token 获取 claims
 */
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

/**
 * 从 Codex accessToken 中提取邮箱
 */
function extractEmailFromCodexToken(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    // 优先从 https://api.openai.com/profile 中提取邮箱
    const profileClaims = claims['https://api.openai.com/profile'];
    if (profileClaims && typeof profileClaims === 'object') {
        const profileEmail = profileClaims.email;
        if (typeof profileEmail === 'string' && profileEmail.trim()) {
            return profileEmail.trim();
        }
    }
    // 回退到顶层 email 字段
    const email = claims.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
}

/**
 * 批量从 accessToken 提取邮箱并更新到 oauth_credentials
 */
export async function handleBatchExtractEmails(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 只支持 openai-codex 类型
        if (providerType !== 'openai-codex') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: '该功能仅支持 openai-codex 类型'
            }));
            return true;
        }

        // 获取所有该类型的 oauth_credentials
        const credentials = await oauthCredentialsDao.findAll({ providerType });

        if (!credentials || credentials.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '没有找到需要处理的凭据',
                total: 0,
                updated: 0,
                skipped: 0,
                failed: 0
            }));
            return true;
        }

        let updated = 0;
        let skipped = 0;
        let failed = 0;
        let providerUpdated = 0;
        const results = [];
        const providers = await providerDao.findAll(providerType, { includeDeleted: true });
        const providersByCredentialId = new Map();

        for (const provider of providers) {
            const credentialId = provider.oauth_credential_id;
            if (!credentialId) continue;
            if (!providersByCredentialId.has(credentialId)) {
                providersByCredentialId.set(credentialId, []);
            }
            providersByCredentialId.get(credentialId).push(provider);
        }

        for (const cred of credentials) {
            try {
                // 如果凭据已有邮箱，仍需同步到关联的 provider
                if (cred.email && cred.email.trim()) {
                    const existingEmail = cred.email.trim();
                    const linkedProviders = providersByCredentialId.get(cred.id) || [];
                    for (const provider of linkedProviders) {
                        const currentEmail = provider.credentials?.email || '';
                        if (currentEmail.trim() === existingEmail) continue;
                        const nextCredentials = { ...(provider.credentials || {}), email: existingEmail };
                        await providerDao.update(provider.uuid, { credentials: nextCredentials });
                        provider.credentials = nextCredentials;
                        providerUpdated++;
                    }
                    skipped++;
                    results.push({ id: cred.id, status: 'skipped', reason: '已有邮箱(已同步provider)' });
                    continue;
                }

                // 从 credentials JSON 中获取 accessToken
                const credData = typeof cred.credentials === 'string'
                    ? JSON.parse(cred.credentials)
                    : cred.credentials;

                const accessToken = credData?.accessToken;
                if (!accessToken) {
                    failed++;
                    results.push({ id: cred.id, status: 'failed', reason: '无 accessToken' });
                    continue;
                }

                // 提取邮箱
                const email = extractEmailFromCodexToken(accessToken);
                if (!email) {
                    failed++;
                    results.push({ id: cred.id, status: 'failed', reason: '无法从 token 提取邮箱' });
                    continue;
                }

                // 更新邮箱到数据库
                await oauthCredentialsDao.updateEmail(cred.id, email);

                const linkedProviders = providersByCredentialId.get(cred.id) || [];
                for (const provider of linkedProviders) {
                    const currentEmail = provider.credentials?.email || '';
                    if (currentEmail.trim() === email) {
                        continue;
                    }
                    const nextCredentials = { ...(provider.credentials || {}), email };
                    await providerDao.update(provider.uuid, { credentials: nextCredentials });
                    provider.credentials = nextCredentials;
                    providerUpdated++;
                }

                updated++;
                results.push({ id: cred.id, status: 'updated', email });

            } catch (err) {
                failed++;
                results.push({ id: cred.id, status: 'failed', reason: err.message });
            }
        }

        console.log(`[ProviderAPI] Batch extract emails: total=${credentials.length}, updated=${updated}, skipped=${skipped}, failed=${failed}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            total: credentials.length,
            updated,
            skipped,
            failed,
            providerUpdated,
            results
        }));
        return true;

    } catch (error) {
        console.error('[ProviderAPI] Batch extract emails failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 获取账号当前实时用户列表
 * GET /api/ui/providers/:providerType/:uuid/users
 */
export async function handleGetProviderActiveUsers(req, res, providerUuid) {
    try {
        // 获取近期用户（时间窗口内，去重）
        const recentUsers = await concurrencyLimiter.getRecentUsers(providerUuid);
        // 获取当前活跃用户（正在进行的请求）
        const activeUsers = await concurrencyLimiter.getAccountUsers(providerUuid);
        // 获取每个用户的 session 数量
        const userSessionCounts = await concurrencyLimiter.getUserSessionCounts(providerUuid);

        const accountCurrentConcurrency = await concurrencyLimiter.getAccountConcurrency(providerUuid);
        const accountPeakConcurrency = await concurrencyLimiter.getAccountPeakConcurrency(providerUuid);
        const userPeakConcurrencyMap = await concurrencyLimiter.getAccountUserPeakConcurrencyMap(providerUuid);

        const currentUserConcurrencyMap = {};
        for (const activeUser of activeUsers) {
            const userKey = String(activeUser?.userKey || '').trim();
            if (!userKey) continue;
            currentUserConcurrencyMap[userKey] = (currentUserConcurrencyMap[userKey] || 0) + 1;
        }

        const usersWithConcurrency = recentUsers.map((user) => {
            const userKey = String(user?.userKey || '').trim();
            const currentConcurrency = currentUserConcurrencyMap[userKey] || 0;
            const peakConcurrency = Number(userPeakConcurrencyMap[userKey]) || currentConcurrency;
            return {
                ...user,
                currentConcurrency,
                peakConcurrency
            };
        });

        const activeUserKeys = new Set(activeUsers.map((u) => String(u?.userKey || '').trim()).filter(Boolean));
        const recentUserKeys = new Set(recentUsers.map((u) => String(u?.userKey || '').trim()).filter(Boolean));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            users: usersWithConcurrency,   // 近期用户列表（附带并发）
            count: usersWithConcurrency.length,
            activeUsers: activeUsers,      // 当前活跃请求列表
            activeCount: activeUsers.length,
            activeUserCount: activeUserKeys.size,
            uniqueUserCount: recentUserKeys.size,
            accountCurrentConcurrency,
            accountPeakConcurrency,
            userSessionCounts,
            userConcurrencyMap: currentUserConcurrencyMap,
            userPeakConcurrencyMap
        }));
        return true;
    } catch (error) {
        console.error('[ProviderAPI] Get active users failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * GET /api/providers/shard-map
 * 返回所有 provider 按 shard 的归属分布。
 * 供 admin UI 展示"哪个 worker 负责哪些 provider"，便于运维排查分片均衡问题。
 *
 * admin 进程没有注入 WORKER_SHARD_COUNT，shard.js 里 SHARD_COUNT=1，
 * 所以这里内联 FNV-1a 32bit hash，从 master /master/status 拿 configuredWorkers 后自行计算。
 */
export async function handleGetShardMap(req, res) {
    const http = await import('http');
    const masterPort = parseInt(process.env.MASTER_PORT, 10) || 3100;

    // FNV-1a 32bit，与 utils/shard.js 保持完全一致
    function fnv1a32(input) {
        if (typeof input !== 'string' || input.length === 0) return 0;
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    try {
        // 1. 从 master 拿 worker 数量和 dispatcher 统计
        let workerCount = 1;
        let dispatcherStats = null;
        let workerDetails = [];
        try {
            const masterStatus = await new Promise((resolve, reject) => {
                const req2 = http.default.get(`http://127.0.0.1:${masterPort}/master/status`, (resp) => {
                    let body = '';
                    resp.on('data', c => body += c);
                    resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
                });
                req2.on('error', reject);
                req2.setTimeout(3000, () => { req2.destroy(); reject(new Error('timeout')); });
            });
            workerCount = masterStatus?.master?.configuredWorkers || 1;
            dispatcherStats = masterStatus?.dispatcher || null;
            workerDetails = (masterStatus?.workers || []).map(w => ({
                workerId: w.id,
                pid: w.pid,
                shardId: w.shard?.id ?? null,
                ownedProviders: w.shard?.ownedProviders ?? null,
                adaptersLive: w.adapters?.live ?? null,
                concurrencyActive: w.concurrency?.active ?? null,
                concurrencyPeak: w.concurrency?.peak ?? null,
            }));
        } catch (_) {
            // master 不可达时降级为 1 shard（单机模式）
        }

        // 2. 查所有未删除的 provider
        const allProviders = await providerDao.findAll(null, { includeDeleted: false });

        // 3. 按 shard 分桶
        const shards = {};
        for (let i = 0; i < workerCount; i++) shards[i] = [];

        for (const p of allProviders) {
            const uuid = p.uuid;
            const shardId = workerCount <= 1 ? 0 : fnv1a32(String(uuid || '')) % workerCount;
            const entry = {
                uuid,
                providerType: p.provider_type,
                name: p.credentials?.customName || p.custom_name || (uuid ? uuid.slice(0, 8) : 'unknown'),
                isHealthy: p.is_healthy !== false,
                isDisabled: p.is_disabled === true,
            };
            if (!shards[shardId]) shards[shardId] = [];
            shards[shardId].push(entry);
        }

        // 4. 汇总每 shard 的数量
        const counts = {};
        for (let i = 0; i < workerCount; i++) counts[i] = (shards[i] || []).length;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            workerCount,
            totalProviders: allProviders.length,
            counts,
            shards,
            workers: workerDetails,
            dispatcher: dispatcherStats,
        }));
        return true;
    } catch (error) {
        console.error('[ProviderAPI] Get shard map failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}
