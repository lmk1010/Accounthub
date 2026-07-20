/**
 * 提供商服务层
 * 处理提供商管理的业务逻辑
 */

import * as providerDao from '../dao/provider-dao.js';
import * as statsDao from '../dao/stats-dao.js';
import { generateUUID } from '../utils/provider-utils.js';

const normalizePoolId = (poolId) => {
    if (poolId === null || poolId === undefined || poolId === '') {
        return null;
    }
    const parsed = Number.parseInt(poolId, 10);
    return Number.isFinite(parsed) ? parsed : null;
};

const normalizeProviderForCreate = (providerData = {}) => {
    if (!providerData || typeof providerData !== 'object') {
        throw new Error('Invalid provider payload');
    }

    const providerType = providerData.provider_type ?? providerData.providerType;
    const providerConfig = providerData.credentials ?? providerData.providerConfig;

    if (!providerType) {
        throw new Error('providerType is required');
    }
    if (!providerConfig || typeof providerConfig !== 'object') {
        throw new Error('providerConfig is required');
    }

    const uuid = providerData.uuid ?? providerConfig.uuid ?? generateUUID();
    const poolId = normalizePoolId(
        providerData.pool_id ?? providerData.poolId ?? providerConfig.pool_id ?? providerConfig.poolId
    );

    return {
        uuid,
        provider_type: providerType,
        pool_id: poolId,
        custom_name: providerData.custom_name ?? providerData.customName ?? providerConfig.customName ?? null,
        oauth_credential_id: providerData.oauth_credential_id ?? providerConfig.oauthCredentialId ?? null,
        credentials: providerConfig,
        is_healthy: providerData.is_healthy ?? providerConfig.isHealthy ?? true,
        is_disabled: providerData.is_disabled ?? providerConfig.isDisabled ?? false,
        usage_count: providerData.usage_count ?? providerConfig.usageCount ?? 0,
        error_count: providerData.error_count ?? providerConfig.errorCount ?? 0,
        check_health: providerData.check_health ?? providerConfig.checkHealth ?? false,
        check_model_name: providerData.check_model_name ?? providerConfig.checkModelName ?? null,
        not_supported_models: providerData.not_supported_models ?? providerConfig.notSupportedModels ?? null
    };
};

const normalizeGlobalStats = (stats) => {
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
};

const getRecoveryAtMs = (provider) => {
    const value = provider?.scheduled_recovery_time;
    if (!value) return null;
    const recoveryAt = new Date(value).getTime();
    return Number.isFinite(recoveryAt) ? recoveryAt : null;
};

const computeCountsFromProviders = (providers = []) => {
    const now = Date.now();
    const totalActive = providers.filter(p => !p.is_deleted).length;
    const healthyCount = providers.filter(p => p.is_healthy && !p.is_disabled && !p.is_deleted).length;
    const disabledCount = providers.filter(p => p.is_disabled && !p.is_deleted).length;
    const deletedCount = providers.filter(p => p.is_deleted).length;
    const cooldownCount = providers.filter(p => {
        if (p.is_deleted || p.is_disabled || p.is_healthy) return false;
        const recoveryAt = getRecoveryAtMs(p);
        return recoveryAt !== null && recoveryAt > now;
    }).length;
    const unhealthyCount = providers.filter(p => {
        if (p.is_deleted || p.is_disabled || p.is_healthy) return false;
        const recoveryAt = getRecoveryAtMs(p);
        return recoveryAt === null || recoveryAt <= now;
    }).length;

    return {
        totalActive,
        healthyCount,
        cooldownCount,
        unhealthyCount,
        disabledCount,
        deletedCount
    };
};

/**
 * 获取提供商摘要
 */
export async function getProvidersSummary(poolManager) {
    const summary = {
        providerTypes: {},
        totalAccounts: 0,
        totalHealthy: 0,
        totalUnhealthy: 0
    };

    try {
        const providerTypes = await providerDao.getProviderTypes({ includeDeleted: true });
        for (const providerType of providerTypes) {
            const counts = await providerDao.getTypeCounts(providerType, 'all');
            const totalActive = counts.totalActive ?? 0;
            const healthyCount = counts.healthyCount ?? 0;
            const unhealthyCount = counts.unhealthyCount ?? 0;
            const disabledCount = counts.disabledCount ?? 0;
            const deletedCount = counts.deletedCount ?? 0;

            summary.providerTypes[providerType] = {
                total: totalActive,
                healthy: healthyCount,
                unhealthy: unhealthyCount,
                disabled: disabledCount,
                deleted: deletedCount,
                totalWithDeleted: counts.totalWithDeleted ?? totalActive
            };

            summary.totalAccounts += totalActive;
            summary.totalHealthy += healthyCount;
            summary.totalUnhealthy += unhealthyCount;
        }
    } catch (error) {
        const providers = await providerDao.findAll(null, { includeDeleted: true });
        const grouped = new Map();
        for (const provider of providers) {
            const type = provider.provider_type;
            if (!grouped.has(type)) {
                grouped.set(type, []);
            }
            grouped.get(type).push(provider);
        }
        for (const [providerType, providers] of grouped.entries()) {
            const activeProviders = providers.filter(p => !p.is_deleted);
            const healthyCount = activeProviders.filter(p => p.is_healthy && !p.is_disabled).length;
            const disabledCount = activeProviders.filter(p => p.is_disabled).length;
            const unhealthyCount = activeProviders.filter(p => !p.is_healthy).length;
            const deletedCount = providers.filter(p => p.is_deleted).length;
            summary.providerTypes[providerType] = {
                total: activeProviders.length,
                healthy: healthyCount,
                unhealthy: unhealthyCount,
                disabled: disabledCount,
                deleted: deletedCount,
                totalWithDeleted: providers.length
            };
            summary.totalAccounts += activeProviders.length;
            summary.totalHealthy += healthyCount;
            summary.totalUnhealthy += unhealthyCount;
        }
    }

    try {
        const dbStats = await statsDao.getGlobalStats();
        summary.globalStats = normalizeGlobalStats(dbStats);
    } catch (_error) {
        summary.globalStats = normalizeGlobalStats(null);
    }

    return summary;
}

/**
 * 获取所有提供商
 */
export async function getAllProviders(poolManager, options = {}) {
    const filter = options.filter || 'all';
    const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : null;
    const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0 ? Math.floor(options.pageSize) : null;
    const poolId = options.poolId ?? null;

    if (page && pageSize) {
        const includeDeleted = filter === 'all' || filter === 'deleted' || filter === 'problem';
        const offset = Math.max(0, (page - 1) * pageSize);
        try {
            const [counts, providers] = await Promise.all([
                providerDao.getAllCounts(filter, poolId),
                providerDao.findPagedAll({ limit: pageSize, offset, filter, includeDeleted, poolId })
            ]);
            return {
                providers,
                totalCount: counts.totalCount,
                totalActive: counts.totalActive,
                healthyCount: counts.healthyCount,
                cooldownCount: counts.cooldownCount,
                unhealthyCount: counts.unhealthyCount,
                disabledCount: counts.disabledCount,
                deletedCount: counts.deletedCount,
                totalWithDeleted: counts.totalWithDeleted,
                page,
                pageSize
            };
        } catch (error) {
            const providers = await providerDao.findAll(null, { includeDeleted: true, poolId });
            const filtered = providers.filter(p => {
                if (filter === 'healthy') return p.is_healthy && !p.is_disabled && !p.is_deleted;
                if (filter === 'unhealthy') return !p.is_healthy && !p.is_disabled && !p.is_deleted;
                if (filter === 'problem') return p.is_deleted || (!p.is_deleted && !p.is_disabled && !p.is_healthy);
                if (filter === 'active') return !p.is_deleted && !p.is_disabled;
                if (filter === 'disabled') return p.is_disabled && !p.is_deleted;
                if (filter === 'deleted') return p.is_deleted;
                return true;
            });
            const paged = filtered.slice(offset, offset + pageSize);
            const counts = computeCountsFromProviders(providers);
            return {
                providers: paged,
                totalCount: filtered.length,
                totalActive: counts.totalActive,
                healthyCount: counts.healthyCount,
                cooldownCount: counts.cooldownCount,
                unhealthyCount: counts.unhealthyCount,
                disabledCount: counts.disabledCount,
                deletedCount: counts.deletedCount,
                totalWithDeleted: providers.length,
                page,
                pageSize
            };
        }
    }

    const includeDeleted = filter === 'all' || filter === 'deleted' || filter === 'problem';
    try {
        const [providers, counts] = await Promise.all([
            providerDao.findAll(null, { includeDeleted, poolId }),
            providerDao.getAllCounts(filter, poolId)
        ]);

        return {
            providers,
            totalCount: counts.totalCount,
            totalActive: counts.totalActive,
            healthyCount: counts.healthyCount,
            cooldownCount: counts.cooldownCount,
            unhealthyCount: counts.unhealthyCount,
            disabledCount: counts.disabledCount,
            deletedCount: counts.deletedCount,
            totalWithDeleted: counts.totalWithDeleted,
            page: page || 1,
            pageSize: pageSize || providers.length
        };
    } catch (error) {
        const providers = await providerDao.findAll(null, { includeDeleted: true, poolId });
        const filtered = providers.filter(p => {
            if (filter === 'healthy') return p.is_healthy && !p.is_disabled && !p.is_deleted;
            if (filter === 'unhealthy') return !p.is_healthy && !p.is_disabled && !p.is_deleted;
            if (filter === 'problem') return p.is_deleted || (!p.is_deleted && !p.is_disabled && !p.is_healthy);
            if (filter === 'active') return !p.is_deleted && !p.is_disabled;
            if (filter === 'disabled') return p.is_disabled && !p.is_deleted;
            if (filter === 'deleted') return p.is_deleted;
            return true;
        });
        const counts = computeCountsFromProviders(providers);
        return {
            providers: filtered,
            totalCount: filtered.length,
            totalActive: counts.totalActive,
            healthyCount: counts.healthyCount,
            cooldownCount: counts.cooldownCount,
            unhealthyCount: counts.unhealthyCount,
            disabledCount: counts.disabledCount,
            deletedCount: counts.deletedCount,
            totalWithDeleted: providers.length,
            page: page || 1,
            pageSize: pageSize || providers.length
        };
    }
}

/**
 * 获取指定类型的提供商
 */
export async function getProvidersByType(providerType, poolManager, options = {}) {
    const filter = options.filter || 'all';
    const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : null;
    const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0 ? Math.floor(options.pageSize) : null;
    const poolId = options.poolId ?? null;

    if (page && pageSize) {
        const includeDeleted = filter === 'all' || filter === 'deleted' || filter === 'problem';
        const offset = Math.max(0, (page - 1) * pageSize);
        const [counts, providers] = await Promise.all([
            providerDao.getTypeCounts(providerType, filter, poolId),
            providerDao.findPaged(providerType, { limit: pageSize, offset, filter, includeDeleted, poolId })
        ]);
        return {
            providerType,
            providers,
            totalCount: counts.totalCount,
            totalActive: counts.totalActive,
            healthyCount: counts.healthyCount,
            cooldownCount: counts.cooldownCount,
            unhealthyCount: counts.unhealthyCount,
            disabledCount: counts.disabledCount,
            deletedCount: counts.deletedCount,
            totalWithDeleted: counts.totalWithDeleted,
            page,
            pageSize
        };
    }

    const includeDeleted = filter === 'all' || filter === 'deleted' || filter === 'problem';
    const providers = await providerDao.findAll(providerType, { includeDeleted, poolId });
    const counts = await providerDao.getTypeCounts(providerType, filter, poolId);
    return {
        providerType,
        providers,
        totalCount: counts.totalCount,
        totalActive: counts.totalActive,
        healthyCount: counts.healthyCount,
        cooldownCount: counts.cooldownCount,
        unhealthyCount: counts.unhealthyCount,
        disabledCount: counts.disabledCount,
        deletedCount: counts.deletedCount,
        totalWithDeleted: counts.totalWithDeleted,
        page: page || 1,
        pageSize: pageSize || providers.length
    };
}

/**
 * 添加提供商
 */
export async function addProvider(providerData, poolManager) {
    try {
        const normalizedProvider = normalizeProviderForCreate(providerData);
        const result = await providerDao.create(normalizedProvider);

        // 重新加载号池数据
        if (poolManager) {
            await poolManager.reload();
        }

        return {
            success: true,
            message: 'Provider added successfully',
            data: result
        };
    } catch (error) {
        console.error('[Provider] Add provider error:', error);
        return {
            success: false,
            message: error.message || 'Failed to add provider'
        };
    }
}

/**
 * 更新提供商
 */
export async function updateProvider(uuid, updates, poolManager) {
    try {
        await providerDao.update(uuid, updates);

        // 重新加载号池数据
        if (poolManager) {
            await poolManager.reload();
        }

        return {
            success: true,
            message: 'Provider updated successfully'
        };
    } catch (error) {
        console.error('[Provider] Update provider error:', error);
        return {
            success: false,
            message: error.message || 'Failed to update provider'
        };
    }
}

/**
 * 删除提供商
 */
export async function deleteProvider(uuid, poolManager) {
    try {
        await providerDao.markDeleted(uuid, 'manual_delete');

        // 重新加载号池数据
        if (poolManager) {
            await poolManager.reload();
        }

        return {
            success: true,
            message: 'Provider deleted successfully'
        };
    } catch (error) {
        console.error('[Provider] Delete provider error:', error);
        return {
            success: false,
            message: error.message || 'Failed to delete provider'
        };
    }
}
