import os from 'os';
import { getCpuUsagePercent } from './system-monitor.js';
import { getSocketStats } from '../services/api-server.js';
import { getConsumptionStats, updateConsumptionStats, resetConsumptionStats } from '../services/consumption-stats-db.js';
import * as appMetaDao from '../dao/app-meta-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as statsDao from '../dao/stats-dao.js';

/**
 * 获取系统信息
 */
export async function handleGetSystem(req, res) {
    const memUsage = process.memoryUsage();

    let appVersion = 'unknown';
    try {
        appVersion = await appMetaDao.getValue('app_version');
        if (!appVersion) {
            appVersion = process.env.APP_VERSION || 'unknown';
        }
    } catch (error) {
        console.warn('[UI API] Failed to read app_version from MySQL:', error.message);
    }

    // 计算 CPU 使用率
    const cpuUsage = getCpuUsagePercent();

    // 获取并发统计
    const concurrency = getSocketStats();

    // 计算系统负载（1分钟平均）
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    const loadPercent = ((loadAvg[0] / cpuCount) * 100).toFixed(1);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        appVersion: appVersion,
        nodeVersion: process.version,
        serverTime: new Date().toLocaleString(),
        memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        cpuUsage: cpuUsage,
        uptime: process.uptime(),
        // 并发相关数据
        concurrency: {
            active: concurrency.activeConnections,
            peak: concurrency.peakConnections,
            total: concurrency.totalConnections,
            lastPeakTime: concurrency.lastPeakTime
        },
        // 系统负载
        load: {
            avg1m: loadAvg[0].toFixed(2),
            avg5m: loadAvg[1].toFixed(2),
            avg15m: loadAvg[2].toFixed(2),
            percent: loadPercent,
            cpuCount: cpuCount
        }
    }));
    return true;
}

/**
 * 健康检查接口（用于前端token验证）
 */
export async function handleHealthCheck(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return true;
}

/**
 * 获取服务模式信息
 */
export async function handleGetServiceMode(req, res) {
    const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
    const masterPort = process.env.MASTER_PORT || 3100;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        mode: IS_WORKER_PROCESS ? 'worker' : 'standalone',
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        canAutoRestart: IS_WORKER_PROCESS && !!process.send,
        masterPort: IS_WORKER_PROCESS ? masterPort : null,
        nodeVersion: process.version,
        platform: process.platform
    }));
    return true;
}

/**
 * 重启服务端点 - 支持主进程-子进程架构
 */
export async function handleRestartService(req, res) {
    try {
        const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
        
        if (IS_WORKER_PROCESS && process.send) {
            // 作为子进程运行，通知主进程重启
            console.log('[UI API] Requesting restart from master process...');
            process.send({ type: 'restart_request' });
            
            // 广播重启事件
            const { broadcastEvent } = await import('./event-broadcast.js');
            broadcastEvent('service_restart', {
                action: 'restart_requested',
                timestamp: new Date().toISOString(),
                message: 'Service restart requested, worker will be restarted by master process'
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Restart request sent to master process',
                mode: 'worker',
                details: {
                    workerPid: process.pid,
                    restartMethod: 'master_controlled'
                }
            }));
        } else {
            // 独立运行模式，无法自动重启
            console.log('[UI API] Service is running in standalone mode, cannot auto-restart');
            
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Service is running in standalone mode. Please use master.js to enable auto-restart feature.',
                mode: 'standalone',
                hint: 'Start the service with: node src/core/master.js [args]'
            }));
        }
        return true;
    } catch (error) {
        console.error('[UI API] Failed to restart service:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to restart service: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取号池统计数据（用于仪表盘）
 */
export async function handleGetPoolStats(req, res, providerPoolManager) {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const providerType = requestUrl.searchParams.get('providerType') || 'all';

        const allProviders = await providerDao.findAll(null, { includeDeleted: true });
        const providersByType = {};
        for (const provider of allProviders) {
            const type = provider.provider_type;
            if (!providersByType[type]) {
                providersByType[type] = [];
            }
            providersByType[type].push(provider);
        }

        const providerTypes = {};
        const totals = {
            totalActive: 0,
            totalWithDeleted: 0,
            healthy: 0,
            unhealthy: 0,
            disabled: 0,
            deleted: 0
        };

        for (const [type, providers] of Object.entries(providersByType)) {
            const activeProviders = providers.filter(p => !p.is_deleted);
            const totalActive = activeProviders.length;
            const totalWithDeleted = providers.length;
            const healthy = activeProviders.filter(p => p.is_healthy && !p.is_disabled).length;
            const disabled = activeProviders.filter(p => p.is_disabled).length;
            const unhealthy = activeProviders.filter(p => !p.is_healthy).length;
            const deleted = totalWithDeleted - totalActive;

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

        const dbStats = await statsDao.getGlobalStats().catch(() => null);
        const globalStats = dbStats ? {
            totalRequests: dbStats.total_requests || 0,
            successfulRequests: dbStats.successful_requests || 0,
            failedRequests: dbStats.failed_requests || 0,
            switchCount: dbStats.switch_count || 0,
            lastResetTime: dbStats.last_reset_time || 0
        } : null;
        const totalRequests = globalStats?.totalRequests ?? 0;
        const successRequests = globalStats?.successfulRequests ?? 0;
        const failedRequests = globalStats?.failedRequests ?? 0;
        const switchCount = globalStats?.switchCount ?? 0;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            enabled: Boolean(providerPoolManager),
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
            totalRequests,
            successRequests,
            failedRequests,
            switchCount
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get pool stats:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to get pool stats: ' + error.message }
        }));
        return true;
    }
}

/**
 * 获取错误历史记录
 */
export async function handleGetErrorHistory(req, res, providerPoolManager) {
    try {
        if (!providerPoolManager) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                enabled: false,
                errors: [],
                message: 'Provider pool not configured'
            }));
            return true;
        }

        // 解析查询参数
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const providerType = url.searchParams.get('providerType') || null;
        const statusCode = parseInt(url.searchParams.get('statusCode')) || null;

        // 从数据库获取错误历史
        const errors = await providerPoolManager.getErrorHistory({
            limit,
            providerType,
            statusCode: statusCode || undefined
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            enabled: true,
            total: errors.length,
            errors
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get error history:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to get error history: ' + error.message }
        }));
        return true;
    }
}

/**
 * 清空错误历史记录
 */
export async function handleClearErrorHistory(req, res, providerPoolManager) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Provider pool not configured'
            }));
            return true;
        }

        await providerPoolManager.clearErrorHistory();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Error history cleared'
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to clear error history:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to clear error history: ' + error.message }
        }));
        return true;
    }
}

/**
 * 获取消耗统计数据
 */
export async function handleGetConsumptionStats(req, res) {
    try {
        const stats = await getConsumptionStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to get consumption stats:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to get consumption stats: ' + error.message }
        }));
        return true;
    }
}

/**
 * 更新消耗统计数据（从 Kiro API 同步）
 */
export async function handleUpdateConsumptionStats(req, res) {
    try {
        const stats = await updateConsumptionStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to update consumption stats:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to update consumption stats: ' + error.message }
        }));
        return true;
    }
}

/**
 * 重置消耗统计数据
 */
export async function handleResetConsumptionStats(req, res) {
    try {
        const stats = await resetConsumptionStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Consumption stats reset successfully',
            stats: stats
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to reset consumption stats:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'Failed to reset consumption stats: ' + error.message }
        }));
        return true;
    }
}
