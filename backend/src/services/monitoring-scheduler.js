import { CONFIG } from '../core/config-manager.js';
import { initializeAPIManagement } from './api-manager.js';
import { startHealthCheckScheduler, stopHealthCheckScheduler } from '../plugins/api-potluck/api-routes.js';
import { startAuthCleanupScheduler, stopAuthCleanupScheduler } from './auth.service.js';

let oauthRefreshTimer = null;
let oauthRefreshHandler = null;
let usageRefreshTimer = null;
let usageRefreshRunning = false;

function startOAuthRefreshTimer(intervalMinutes = 15) {
    if (oauthRefreshTimer) {
        clearInterval(oauthRefreshTimer);
    }
    const safeMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15;
    const intervalMs = safeMinutes * 60 * 1000;
    oauthRefreshTimer = setInterval(async () => {
        if (oauthRefreshHandler) {
            await oauthRefreshHandler();
        }
    }, intervalMs);
}

function stopOAuthRefreshTimer() {
    if (oauthRefreshTimer) {
        clearInterval(oauthRefreshTimer);
        oauthRefreshTimer = null;
    }
}

function startUsageRefreshTimer(intervalMinutes = 10, currentConfig, providerPoolManager) {
    stopUsageRefreshTimer();
    const safeMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 10;
    const intervalMs = safeMinutes * 60 * 1000;
    console.log(`[Scheduler] Usage refresh timer started: every ${safeMinutes} minutes`);
    usageRefreshTimer = setInterval(async () => {
        if (usageRefreshRunning) {
            console.log('[Scheduler] Usage refresh already running, skipping');
            return;
        }
        usageRefreshRunning = true;
        try {
            const { getAllProvidersUsage } = await import('../ui-modules/usage-api.js');
            await getAllProvidersUsage(currentConfig, providerPoolManager, { source: 'scheduler' });
            console.log('[Scheduler] Usage refresh completed');
        } catch (error) {
            console.error('[Scheduler] Usage refresh failed:', error.message);
        } finally {
            usageRefreshRunning = false;
        }
    }, intervalMs);
}

function stopUsageRefreshTimer() {
    if (usageRefreshTimer) {
        clearInterval(usageRefreshTimer);
        usageRefreshTimer = null;
        console.log('[Scheduler] Usage refresh timer stopped');
    }
}

export function configureMonitoring(options = {}) {
    const config = options.config || CONFIG;
    const providerPoolManager = options.providerPoolManager || null;
    const services = options.services || null;

    if (services) {
        oauthRefreshHandler = initializeAPIManagement(services);
    }

    if (config.AUTH_TOKEN_CLEANUP_ENABLED === false) {
        stopAuthCleanupScheduler();
    } else {
        startAuthCleanupScheduler(config.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES ?? 5);
    }

    if (providerPoolManager && typeof providerPoolManager.startHealthCheckInterval === 'function') {
        if (config.PROVIDER_HEALTH_CHECK_ENABLED === false) {
            providerPoolManager.stopHealthCheckInterval();
        } else {
            providerPoolManager.startHealthCheckInterval(config.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES ?? 5);
        }
    }

    if (config.CRON_REFRESH_TOKEN && oauthRefreshHandler) {
        startOAuthRefreshTimer(config.CRON_NEAR_MINUTES ?? 15);
    } else {
        stopOAuthRefreshTimer();
    }

    if (config.POTLUCK_HEALTH_SYNC_ENABLED === false) {
        stopHealthCheckScheduler();
    } else {
        startHealthCheckScheduler({
            intervalMinutes: config.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES ?? 5,
        });
    }

    // admin 进程不再跑 usage 定时刷新 —— worker 进程每个 shard 各自刷自己那份 provider
    // 就够了。admin 跑等于把所有 178 个 provider 的 adapter 都冷建一遍,叠加 adapter-idle
    // -sweeper 的 5min admin TTL,每 10min 就是一轮 26000+ 次创建/天的无用 churn。
    // admin 只剩被动接 UI 查询;UI 要用量数据直接读 provider_usage_details DB 缓存。
    const IS_ADMIN_PROCESS = process.env.IS_ADMIN_PROCESS === 'true';
    if (config.USAGE_REFRESH_ENABLED && providerPoolManager && !IS_ADMIN_PROCESS) {
        startUsageRefreshTimer(config.USAGE_REFRESH_INTERVAL_MINUTES ?? 10, config, providerPoolManager);
    } else {
        stopUsageRefreshTimer();
    }
}

export function stopAllMonitoring(providerPoolManager = null) {
    stopAuthCleanupScheduler();
    stopOAuthRefreshTimer();
    stopHealthCheckScheduler();
    stopUsageRefreshTimer();
    if (providerPoolManager && typeof providerPoolManager.stopHealthCheckInterval === 'function') {
        providerPoolManager.stopHealthCheckInterval();
    }
}
