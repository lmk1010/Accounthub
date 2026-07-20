/**
 * 性能监控 API
 * 提供系统性能、Redis、MySQL、网络带宽等实时监控数据
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { getMySQLStatus, query } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { getRedisStatus, isRedisAvailable, getRedisClient } from '../services/redis-client.js';
import { getQueueLength } from '../services/request-log-queue.js';
import { getSocketStats } from '../services/api-server.js';
import { getConcurrencyStats } from '../handlers/request-handler.js';
import * as providerErrorLogsDao from '../dao/provider-error-logs-dao.js';
import * as statsDao from '../dao/stats-dao.js';
import * as requestLogsDao from '../dao/request-logs-dao.js';

// 网络流量采样数据
let lastNetworkSample = null;
let lastSampleTime = 0;

/**
 * 获取网络接口流量
 */
function getNetworkStats() {
    const interfaces = os.networkInterfaces();
    let totalRx = 0;
    let totalTx = 0;

    // 注意：Node.js 的 os.networkInterfaces() 不提供流量统计
    // 需要从 /proc/net/dev (Linux) 或其他方式获取
    // 这里我们使用 MySQL 的流量作为参考
    return { rx: totalRx, tx: totalTx };
}

/**
 * 计算网络速率
 */
function calculateNetworkRate(currentRx, currentTx) {
    const now = Date.now();
    const result = {
        rxRate: 0,
        txRate: 0,
        totalRx: currentRx,
        totalTx: currentTx
    };

    if (lastNetworkSample && lastSampleTime) {
        const timeDiff = (now - lastSampleTime) / 1000; // 秒
        if (timeDiff > 0) {
            result.rxRate = Math.max(0, (currentRx - lastNetworkSample.rx) / timeDiff);
            result.txRate = Math.max(0, (currentTx - lastNetworkSample.tx) / timeDiff);
        }
    }

    lastNetworkSample = { rx: currentRx, tx: currentTx };
    lastSampleTime = now;

    return result;
}

async function getMasterStatusSnapshot() {
    const masterPort = parseInt(process.env.MASTER_PORT, 10) || 3100;
    return await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${masterPort}/master/status`, (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (_error) {
                    reject(new Error('Invalid JSON from master'));
                }
            });
        });

        request.on('error', reject);
        request.setTimeout(3000, () => {
            request.destroy();
            reject(new Error('Master request timeout'));
        });
    });
}

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 获取综合监控数据
 */
export async function handleGetMonitorOverview(req, res) {
    try {
        const [mysqlStatus, redisStatus, requestConcurrency, masterStatus] = await Promise.all([
            getMySQLStatus().catch(err => ({ error: err.message })),
            getRedisStatus().catch(err => ({ connected: false, error: err.message })),
            getConcurrencyStats().catch(err => ({ activeConnections: 0, peakConnections: 0, totalConnections: 0, lastPeakTime: null })),
            getMasterStatusSnapshot().catch(() => null)
        ]);

        // 获取日志队列长度
        let logQueueLength = 0;
        if (isRedisAvailable()) {
            try {
                logQueueLength = await getQueueLength();
            } catch (e) {
                // ignore
            }
        }

        // 计算 MySQL QPS (基于流量变化)
        const networkRate = calculateNetworkRate(
            mysqlStatus.traffic?.bytesReceived || 0,
            mysqlStatus.traffic?.bytesSent || 0
        );

        // 系统负载
        const loadAvg = os.loadavg();
        const cpuCount = os.cpus().length;
        const memInfo = process.memoryUsage();

        // 服务状态判断
        const services = {
            api: { status: 'healthy', message: 'Running' },
            mysql: mysqlStatus.error
                ? { status: 'error', message: mysqlStatus.error }
                : { status: 'healthy', message: `v${mysqlStatus.version}` },
            redis: redisStatus.connected
                ? { status: 'healthy', message: `v${redisStatus.version}` }
                : { status: 'error', message: redisStatus.error || 'Not connected' }
        };

        const socketStats = getSocketStats();
        const hasClusterConnectionStats = Array.isArray(masterStatus?.workers)
            && masterStatus.workers.some(worker => worker?.connections);
        const clusterConnections = hasClusterConnectionStats ? (masterStatus?.cluster || null) : null;
        const currentConnections = clusterConnections?.currentConnections ?? socketStats.activeConnections;
        const peakConnections = clusterConnections?.peakSocketConnections ?? socketStats.peakConnections;
        const peakConnections10m = clusterConnections?.peakConnections10m ?? peakConnections;
        const lastPeakTime = clusterConnections?.peakConnectionTime ?? socketStats.lastPeakTime ?? requestConcurrency.lastPeakTime;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            timestamp: Date.now(),
            services,
            concurrency: {
                active: currentConnections,
                peak: peakConnections,
                peak10m: peakConnections10m,
                total: requestConcurrency.totalConnections,
                lastPeakTime
            },
            system: {
                load: {
                    avg1m: loadAvg[0].toFixed(2),
                    avg5m: loadAvg[1].toFixed(2),
                    avg15m: loadAvg[2].toFixed(2),
                    percent: ((loadAvg[0] / cpuCount) * 100).toFixed(1)
                },
                cpuCount,
                memory: {
                    heapUsed: memInfo.heapUsed,
                    heapTotal: memInfo.heapTotal,
                    rss: memInfo.rss,
                    external: memInfo.external
                },
                uptime: process.uptime()
            },
            mysql: mysqlStatus.error ? null : {
                connections: mysqlStatus.connections,
                queries: mysqlStatus.queries,
                localPool: mysqlStatus.localPool,
                uptime: mysqlStatus.uptime
            },
            redis: redisStatus.connected ? {
                clients: redisStatus.clients,
                memory: redisStatus.memory,
                stats: redisStatus.stats,
                logQueueLength,
                uptime: redisStatus.uptime
            } : null,
            network: {
                mysql: {
                    rxRate: networkRate.rxRate,
                    txRate: networkRate.txRate,
                    totalRx: networkRate.totalRx,
                    totalTx: networkRate.totalTx
                }
            }
        }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get overview:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取号池健康状态
 */
export async function handleGetPoolHealth(req, res) {
    try {
        // 获取最近 5 分钟的统计
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

        // 获取全局统计
        const globalStats = await statsDao.getGlobalStats().catch(() => null);

        // 获取最近错误
        const recentErrors = await providerErrorLogsDao.findRecent({
            limit: 20,
            startDate: fiveMinutesAgo.toISOString()
        }).catch(() => []);

        // 计算错误率和切号频率
        const totalRequests = globalStats?.total_requests || 0;
        const failedRequests = globalStats?.failed_requests || 0;
        const switchCount = globalStats?.switch_count || 0;
        const errorRate = totalRequests > 0 ? (failedRequests / totalRequests * 100) : 0;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            timestamp: Date.now(),
            stats: {
                totalRequests,
                successRequests: globalStats?.successful_requests || 0,
                failedRequests,
                switchCount,
                errorRate: errorRate.toFixed(2),
                successRate: (100 - errorRate).toFixed(2)
            },
            recentErrors: recentErrors.map(err => ({
                time: err.created_at,
                providerType: err.provider_type,
                statusCode: err.error_code ?? 0,
                message: err.error_message,
                model: err.request_model
            }))
        }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get pool health:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 Redis 详细状态
 */
export async function handleGetRedisStatus(req, res) {
    try {
        const status = await getRedisStatus();

        // 获取日志队列长度
        let logQueueLength = 0;
        if (status.connected) {
            try {
                logQueueLength = await getQueueLength();
            } catch (e) {
                // ignore
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...status,
            logQueueLength
        }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get Redis status:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 MySQL 详细状态
 */
export async function handleGetMySQLStatus(req, res) {
    try {
        const status = await getMySQLStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get MySQL status:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取磁盘占用信息
 */
export async function handleGetDiskUsage(req, res) {
    try {
        // 获取项目根目录
        const projectRoot = path.resolve(__dirname, '../../..');
        const logsDir = path.join(projectRoot, 'backend/logs');
        const uploadsDir = path.join(projectRoot, 'backend/uploads');

        const getDirSize = (dirPath) => {
            let size = 0;
            try {
                if (!fs.existsSync(dirPath)) return 0;
                const files = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const file of files) {
                    const filePath = path.join(dirPath, file.name);
                    if (file.isDirectory()) {
                        size += getDirSize(filePath);
                    } else {
                        try {
                            size += fs.statSync(filePath).size;
                        } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) { /* ignore */ }
            return size;
        };

        const result = {
            logs: { path: logsDir, size: getDirSize(logsDir) },
            uploads: { path: uploadsDir, size: getDirSize(uploadsDir) },
            project: { path: projectRoot, size: getDirSize(projectRoot) }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get disk usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 MySQL 表大小信息
 */
export async function handleGetTableSizes(req, res) {
    try {
        const rows = await query(`
            SELECT
                table_name AS tableName,
                table_rows AS rowCount,
                ROUND(data_length / 1024 / 1024, 2) AS dataSizeMB,
                ROUND(index_length / 1024 / 1024, 2) AS indexSizeMB,
                ROUND((data_length + index_length) / 1024 / 1024, 2) AS totalSizeMB
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
            ORDER BY (data_length + index_length) DESC
        `);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tables: rows }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get table sizes:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 MySQL 慢查询列表
 */
export async function handleGetSlowQueries(req, res) {
    try {
        // 先检查慢查询日志是否启用
        const [varRows] = await query(`SHOW VARIABLES LIKE 'slow_query_log'`);
        const slowLogEnabled = varRows?.Value === 'ON';

        // 尝试从 performance_schema 获取慢查询
        let slowQueries = [];
        try {
            slowQueries = await query(`
                SELECT
                    DIGEST_TEXT AS queryDigest,
                    COUNT_STAR AS execCount,
                    ROUND(SUM_TIMER_WAIT / 1000000000000, 3) AS totalTimeSec,
                    ROUND(AVG_TIMER_WAIT / 1000000000000, 3) AS avgTimeSec,
                    ROUND(MAX_TIMER_WAIT / 1000000000000, 3) AS maxTimeSec,
                    SUM_ROWS_EXAMINED AS rowsExamined,
                    SUM_ROWS_SENT AS rowsSent,
                    FIRST_SEEN AS firstSeen,
                    LAST_SEEN AS lastSeen
                FROM performance_schema.events_statements_summary_by_digest
                WHERE SCHEMA_NAME = DATABASE()
                  AND AVG_TIMER_WAIT > 1000000000
                ORDER BY AVG_TIMER_WAIT DESC
                LIMIT 50
            `);
        } catch (e) {
            // performance_schema 可能未启用
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            slowLogEnabled,
            queries: slowQueries
        }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to get slow queries:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 清理 request_logs 日志
 * body: { mode: 'before_today' | 'before_date', date?: 'YYYY-MM-DD' }
 */
export async function handleCleanupRequestLogs(req, res) {
    try {
        const { readRequestBody } = await import('../routes/index.js');
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw || '{}');
        const { mode, date } = body;

        if (!mode || !['before_today', 'before_date'].includes(mode)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '无效的清理模式，需要 before_today 或 before_date' } }));
            return true;
        }

        if (mode === 'before_date' && !date) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '缺少日期参数' } }));
            return true;
        }

        // 验证日期格式
        if (mode === 'before_date' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '日期格式无效，需要 YYYY-MM-DD' } }));
            return true;
        }

        const deleted = await requestLogsDao.cleanupByDate(mode, date);
        console.log(`[Monitor API] Cleaned up request_logs: mode=${mode}, date=${date || 'N/A'}, deleted=${deleted}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[Monitor API] Failed to cleanup request logs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
