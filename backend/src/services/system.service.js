/**
 * 系统服务层
 * 处理系统信息和健康检查
 */

import os from 'os';
import { isDatabaseInitialized } from '../config/database.js';
import { getCpuUsagePercent } from '../ui-modules/system-monitor.js';
import { getSocketStats } from '../services/api-server.js';
import * as appMetaDao from '../dao/app-meta-dao.js';

/**
 * 获取健康状态
 */
export async function getHealthStatus() {
    const dbStatus = isDatabaseInitialized() ? 'healthy' : 'unhealthy';

    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: dbStatus
    };
}

/**
 * 获取系统信息
 */
export async function getSystemInfo() {
    let appVersion = 'unknown';
    try {
        appVersion = await appMetaDao.getValue('app_version');
        if (!appVersion) {
            appVersion = process.env.APP_VERSION || 'unknown';
        }
    } catch (error) {
        appVersion = process.env.APP_VERSION || 'unknown';
    }

    const memUsage = process.memoryUsage();
    const cpuUsage = getCpuUsagePercent();
    const concurrency = getSocketStats();
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    const loadPercent = ((loadAvg[0] / cpuCount) * 100).toFixed(1);
    const isWorker = process.env.IS_WORKER_PROCESS === 'true';

    return {
        appVersion,
        nodeVersion: process.version,
        serverTime: new Date().toLocaleString(),
        mode: isWorker ? 'worker' : 'standalone',
        pid: process.pid,
        platform: os.platform(),
        arch: os.arch(),
        cpus: cpuCount,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        uptime: process.uptime(),
        memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        memoryUsed: memUsage.heapUsed,
        memoryTotal: memUsage.heapTotal,
        cpuUsage,
        concurrency: {
            active: concurrency.activeConnections,
            peak: concurrency.peakConnections,
            total: concurrency.totalConnections,
            lastPeakTime: concurrency.lastPeakTime
        },
        load: {
            avg1m: loadAvg[0].toFixed(2),
            avg5m: loadAvg[1].toFixed(2),
            avg15m: loadAvg[2].toFixed(2),
            percent: loadPercent,
            cpuCount
        }
    };
}
