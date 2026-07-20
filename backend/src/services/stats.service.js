/**
 * 统计服务层
 * 处理统计数据的业务逻辑
 */

import * as statsDao from '../dao/stats-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as errorDao from '../dao/error-dao.js';
import { getConsumptionStats as getConsumptionStatsDb, updateConsumptionStats as updateConsumptionStatsDb, resetConsumptionStats as resetConsumptionStatsDb } from './consumption-stats-db.js';

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

/**
 * 获取号池统计
 */
export async function getPoolStats(poolManager, options = {}) {
    const providerType = options.providerType || 'all';

    try {
        const providerTypes = {};
        const totals = {
            totalActive: 0,
            totalWithDeleted: 0,
            healthy: 0,
            unhealthy: 0,
            disabled: 0,
            deleted: 0
        };

        const types = await providerDao.getProviderTypes({ includeDeleted: true });
        for (const type of types) {
            const counts = await providerDao.getTypeCounts(type, 'all');
            const totalActive = counts.totalActive ?? 0;
            const totalWithDeleted = counts.totalWithDeleted ?? totalActive;
            const healthy = counts.healthyCount ?? 0;
            const disabled = counts.disabledCount ?? 0;
            const unhealthy = counts.unhealthyCount ?? 0;
            const deleted = counts.deletedCount ?? 0;

            providerTypes[type] = {
                total: totalActive,
                totalActive,
                totalWithDeleted,
                healthy,
                disabled,
                unhealthy,
                deleted
            };

            totals.totalActive += totalActive;
            totals.totalWithDeleted += totalWithDeleted;
            totals.healthy += healthy;
            totals.disabled += disabled;
            totals.unhealthy += unhealthy;
            totals.deleted += deleted;
        }

        const selectedStats = providerType === 'all'
            ? totals
            : (providerTypes[providerType] || {
                totalActive: 0,
                totalWithDeleted: 0,
                healthy: 0,
                disabled: 0,
                unhealthy: 0,
                deleted: 0
            });

        const activeBase = selectedStats.totalActive || 0;
        const healthRatio = activeBase > 0 ? selectedStats.healthy / activeBase : 1;
        let healthStatus = 'healthy';
        if (healthRatio < 0.5) {
            healthStatus = 'error';
        } else if (healthRatio < 0.8) {
            healthStatus = 'warning';
        }

        const dbStats = await statsDao.getGlobalStats();
        const globalStats = normalizeGlobalStats(dbStats);

        return {
            enabled: true,
            providerType,
            providerTypes,
            totalAccounts: selectedStats.totalWithDeleted,
            totalWithDeleted: selectedStats.totalWithDeleted,
            totalActive: selectedStats.totalActive,
            totalHealthy: selectedStats.healthy,
            totalUnhealthy: selectedStats.unhealthy,
            totalDisabled: selectedStats.disabled,
            totalDeleted: selectedStats.deleted,
            healthStatus,
            globalStats,
            totalRequests: globalStats.totalRequests,
            successRequests: globalStats.successfulRequests,
            failedRequests: globalStats.failedRequests,
            switchCount: globalStats.switchCount
        };
    } catch (error) {
        if (poolManager) {
            return poolManager.getPoolStats();
        }
        throw error;
    }
}

/**
 * 获取错误历史
 */
export async function getErrorHistory(poolManager, options = {}) {
    const {
        providerType,
        statusCode,
        statusCodeMin,
        statusCodeMax,
        page = 1,
        pageSize = 50,
        limit
    } = options;

    try {
        if (limit) {
            const errors = await errorDao.findAll({
                providerType,
                statusCode,
                statusCodeMin,
                statusCodeMax,
                limit
            });
            return {
                enabled: true,
                total: errors.length,
                errors
            };
        }

        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 50;
        const offset = (safePage - 1) * safePageSize;

        const [total, errors] = await Promise.all([
            errorDao.count({ providerType, statusCode, statusCodeMin, statusCodeMax }),
            errorDao.findPaged({
                providerType,
                statusCode,
                statusCodeMin,
                statusCodeMax,
                limit: safePageSize,
                offset
            })
        ]);

        return {
            enabled: true,
            total,
            page: safePage,
            pageSize: safePageSize,
            errors
        };
    } catch (error) {
        if (poolManager) {
            const errors = await poolManager.getErrorHistory();
            return {
                enabled: true,
                total: errors.length,
                errors
            };
        }
        throw error;
    }
}

/**
 * 清空错误历史
 */
export async function clearErrorHistory(poolManager) {
    try {
        await errorDao.clear();
    } catch (error) {
        if (poolManager) {
            await poolManager.clearErrorHistory();
            return;
        }
        throw error;
    }
}

/**
 * 获取消费统计
 */
export async function getConsumptionStats() {
    return await getConsumptionStatsDb();
}

/**
 * 更新消费统计
 */
export async function updateConsumptionStats() {
    return await updateConsumptionStatsDb();
}

/**
 * 重置消费统计
 */
export async function resetConsumptionStats() {
    await resetConsumptionStatsDb();
}
