/**
 * 主进程 (Master Process) - Cluster 模式
 *
 * 负责管理多个 Worker 进程，充分利用多核 CPU
 *
 * 功能：
 * - 启动多个 Worker 进程（根据 CPU 核心数）
 * - 启动独立的管理进程（端口 1456）
 * - 监控 Worker 状态
 * - 自动重启崩溃的 Worker
 * - 提供管理 API
 *
 * 使用方式：
 * node src/core/master.js [原有的命令行参数]
 *
 * 环境变量：
 * - WORKERS: Worker 进程数量（默认为 CPU 核心数）
 * - MASTER_PORT: 管理端口（默认 3100）
 * - ADMIN_PORT: 独立管理服务端口（默认 1456）
 */

import cluster from 'cluster';
import os from 'os';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { initRedis, resetRuntimeStateKeys } from '../services/redis-client.js';
import { startStickyDispatcher, stopStickyDispatcher, getStickyDispatcherStats } from './sticky-dispatcher-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const config = {
    workerScript: path.join(__dirname, '../services/api-server.js'),
    numWorkers: parseInt(process.env.WORKERS) || os.cpus().length,
    maxRestartAttempts: 10,
    restartDelay: 1000,
    masterPort: parseInt(process.env.MASTER_PORT) || 3100,
    adminPort: parseInt(process.env.ADMIN_PORT) || 1456,
    // 方案 B:master 监听对外 HTTP 端口,做 sticky TCP handoff
    publicPort: parseInt(process.env.PUBLIC_HTTP_PORT) || 1458,
    publicHost: process.env.PUBLIC_HTTP_HOST || '0.0.0.0',
    args: process.argv.slice(2)
};

// Worker 状态追踪
const workerStats = new Map();

// Worker 运行时状态（内存、并发等）
const workerRuntimeStats = new Map();

// Phase 5: shard 不均告警节流 —— 避免每 5 秒刷一次日志
let lastShardImbalanceWarnAt = 0;
const SHARD_IMBALANCE_WARN_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟最多一条
const CONNECTION_HISTORY_WINDOW_MS = 10 * 60 * 1000;
const connectionHistory = [];
let clusterPeakConnections = 0;
let clusterPeakConnectionTime = null;

function getCurrentClusterConnections() {
    let total = 0;
    for (const runtime of workerRuntimeStats.values()) {
        total += runtime?.connections?.active || 0;
    }
    return total;
}

function pruneConnectionHistory(now = Date.now()) {
    while (connectionHistory.length > 0 && now - connectionHistory[0].ts > CONNECTION_HISTORY_WINDOW_MS) {
        connectionHistory.shift();
    }
}

function recordConnectionSample(now = Date.now()) {
    const current = getCurrentClusterConnections();
    connectionHistory.push({ ts: now, value: current });
    pruneConnectionHistory(now);
    if (current > clusterPeakConnections) {
        clusterPeakConnections = current;
        clusterPeakConnectionTime = new Date(now).toISOString();
    }
    return current;
}

function getPeakConnections10m(now = Date.now()) {
    pruneConnectionHistory(now);
    let peak = 0;
    for (const item of connectionHistory) {
        if (item.value > peak) peak = item.value;
    }
    return peak;
}

function maybeWarnShardImbalance() {
    // 只有所有 worker 都至少上报过一次才开始判断
    const workerCount = Object.keys(cluster.workers || {}).length;
    if (workerCount < 2) return;
    if (workerRuntimeStats.size < workerCount) return;

    const now = Date.now();
    if (now - lastShardImbalanceWarnAt < SHARD_IMBALANCE_WARN_INTERVAL_MS) return;

    const ownedCounts = [];
    for (const runtime of workerRuntimeStats.values()) {
        const count = runtime?.shard?.ownedProviders;
        if (Number.isFinite(count)) ownedCounts.push(count);
    }
    if (ownedCounts.length < workerCount) return; // 有 worker 还没报 shard info

    const min = Math.min(...ownedCounts);
    const max = Math.max(...ownedCounts);
    if (min === 0 && max === 0) return; // 还没完成 init 或无 provider
    const avg = ownedCounts.reduce((a, b) => a + b, 0) / ownedCounts.length;
    const ratio = min === 0 ? Infinity : max / min;

    // 阈值:max 相对 min 超过 1.5 倍,或有某 shard 的 owned 低于平均的 50%
    if (ratio > 1.5 || min < avg * 0.5) {
        console.warn(`[ShardImbalance] ⚠ Owned provider distribution skewed: counts=[${ownedCounts.join(', ')}] min=${min} max=${max} avg=${avg.toFixed(1)} max/min=${ratio.toFixed(2)}`);
        console.warn('[ShardImbalance] ⚠ If this persists, consider redistributing providers or rehashing with different SHARD_COUNT');
        lastShardImbalanceWarnAt = now;
    }
}

// 管理进程引用
let adminProcess = null;
let adminRestartCount = 0;
const MAX_ADMIN_RESTART = 10;
const ADMIN_RESTART_RESET_TIME = 60000; // 60秒无崩溃则重置计数

/**
 * 启动一个 Worker 进程
 * @param {number} workerId - Worker ID
 * @param {number} restartCount - 重启次数
 */
function startWorker(workerId, restartCount = 0) {
    // 方案 B:master 负责监听对外 1458,worker 不再共享 cluster 端口。
    //   WORKER_SHARD_ID        = workerId(稳定,crash restart 不变,分片拓扑不漂移)
    //   WORKER_SHARD_COUNT     = config.numWorkers
    //   WORKER_LOCAL_PORT_BASE = 11558,worker N 的本地调试端口 = BASE + N(仅 loopback,测试用)
    //   PORT                   = 0 表示不用 cluster 默认共享端口,worker HTTP server 不 listen 对外,
    //                            只接收 master 的 IPC socket handoff
    const localPortBase = parseInt(process.env.WORKER_LOCAL_PORT_BASE, 10) || 11558;
    const worker = cluster.fork({
        WORKER_ID: workerId,
        WORKER_SHARD_ID: String(workerId),
        WORKER_SHARD_COUNT: String(config.numWorkers),
        WORKER_LOCAL_PORT_BASE: String(localPortBase),
        IS_WORKER_PROCESS: 'true',
        // worker 不再 bind 1458(由 master 的 sticky dispatcher 统一入口)
        // 设 PORT=0 明确告诉 api-server 不要 listen 对外端口
        PORT: '0'
    });

    workerStats.set(worker.id, {
        workerId,
        pid: worker.process.pid,
        startTime: new Date().toISOString(),
        restartCount
    });

    console.log(`[Master] Worker ${workerId} forked PID ${worker.process.pid}, shard ${workerId}/${config.numWorkers}, local debug port ${localPortBase + workerId} (loopback)`);
}

/**
 * 启动独立的管理进程
 * 管理进程运行在单独端口，不受 AI 请求影响
 */
function startAdminProcess() {
    console.log(`[Master] Starting admin process on port ${config.adminPort}...`);

    // Phase 2+3: 显式剔除 shard 相关 env,避免 admin 误以为自己是某个分片。
    // admin 的身份定位:IS_ADMIN_PROCESS=true、无 WORKER_SHARD_*、无 IS_WORKER_PROCESS
    // → shard.js 会识别为 SHARD_ID=-1, SHARD_ENABLED=false, ownsUuid 恒 true
    // → adapter idle sweeper 使用 5min 激进 TTL;concurrency watchdog 不启动
    const adminEnv = { ...process.env };
    delete adminEnv.WORKER_SHARD_ID;
    delete adminEnv.WORKER_SHARD_COUNT;
    delete adminEnv.WORKER_ID;
    delete adminEnv.IS_WORKER_PROCESS;
    adminEnv.IS_ADMIN_PROCESS = 'true';
    adminEnv.ADMIN_PORT = config.adminPort.toString();
    adminEnv.PORT = config.adminPort.toString();

    adminProcess = spawn('node', [config.workerScript], {
        env: adminEnv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    // 记录启动时间，用于重置重启计数
    const startTime = Date.now();

    adminProcess.on('exit', (code, signal) => {
        console.log(`[Master] Admin process exited (${signal || code})`);

        // 如果运行超过60秒才崩溃，重置重启计数
        if (Date.now() - startTime > ADMIN_RESTART_RESET_TIME) {
            adminRestartCount = 0;
        }

        // 检查是否超过最大重启次数
        if (adminRestartCount >= MAX_ADMIN_RESTART) {
            console.error(`[Master] Admin process exceeded max restart attempts (${MAX_ADMIN_RESTART}), giving up`);
            return;
        }

        // 指数退避重启
        adminRestartCount++;
        const delay = Math.min(2000 * Math.pow(2, adminRestartCount - 1), 60000);
        console.log(`[Master] Restarting admin process in ${delay}ms (attempt ${adminRestartCount}/${MAX_ADMIN_RESTART})...`);

        setTimeout(() => startAdminProcess(), delay);
    });

    adminProcess.on('error', (err) => {
        console.error('[Master] Admin process error:', err.message);
    });

    // Phase 2+3 补丁:admin 进程通过 IPC(stdio 第 4 路)可以向 master 发消息,
    // 之前没有 listener,所有 admin 发起的 process.send 都被静默丢弃。
    // 这里补上 —— 处理和 cluster workers 同样语义的几种消息类型:
    //   - broadcast_event(如 provider_removed): 转发给所有 cluster workers
    //   - provider_pool_reload: 转发给所有 cluster workers
    //   - config_reload: 转发给所有 cluster workers
    // 注意:admin 发起的消息会转给所有 workers,workers 自己不需要再收到一份
    // (originPid 机制过滤掉 worker 自己的回响,admin pid 不是 worker pid 所以不会被过滤)
    adminProcess.on('message', (message) => {
        if (!message || !message.type) return;

        if (message.type === 'broadcast_event'
            || message.type === 'provider_pool_reload'
            || message.type === 'config_reload') {
            const forwardMsg = {
                ...message,
                originPid: message.originPid || adminProcess.pid
            };
            let delivered = 0;
            for (const id in cluster.workers) {
                const target = cluster.workers[id];
                if (!target) continue;
                try {
                    target.send(forwardMsg);
                    delivered++;
                } catch (err) {
                    console.warn(`[Master] Failed to forward admin message to worker ${id}:`, err?.message || err);
                }
            }
            if (delivered > 0 && message.type === 'broadcast_event') {
                console.log(`[Master] Forwarded admin ${message.eventType || 'event'} to ${delivered} worker(s)`);
            }
        }
    });

    console.log(`[Master] Admin process started with PID: ${adminProcess.pid}`);
}

/**
 * 主进程逻辑
 */
if (cluster.isPrimary) {
    console.log('='.repeat(60));
    console.log('[Master] AccountHub Master Process (Cluster Mode)');
    console.log('[Master] PID:', process.pid);
    console.log('[Master] Node version:', process.version);
    console.log('[Master] CPU cores:', os.cpus().length);
    console.log('[Master] Workers to start:', config.numWorkers);
    console.log('[Master] Admin port:', config.adminPort);
    console.log('[Master] Working directory:', process.cwd());
    console.log('='.repeat(60));

    // 初始化 Redis 并清空运行时并发统计，确保重启后从 0 开始
    try {
        await initRedis();
        await resetRuntimeStateKeys(true);
    } catch (error) {
        console.warn('[Master] Failed to reset runtime state keys:', error.message);
    }

    // 启动独立的管理进程（端口 1456）
    startAdminProcess();

    // 启动所有 Worker(每个绑 loopback 调试端口,不再共享 1458)
    for (let i = 0; i < config.numWorkers; i++) {
        startWorker(i);
    }

    // 方案 C:master 启动 sticky TCP dispatcher 监听对外 1458,做 loopback TCP 代理。
    // 每条新 TCP 连接读完 header 后按 hash(token) % N 选中目标 shard,直接 net.connect
    // 到 127.0.0.1:11558+shardId(worker 侧本来就监听这个 loopback 端口作为调试入口),
    // 然后 pipe 双向转发。worker 看到的就是一条普通 TCP 连接,走标准 Node http 解析。
    //
    // 为什么不用 cluster IPC fd handoff:Node 20 下 http.Server 的 parser.consume(handle)
    // 会绕过 JS 层 socket buffer 直接从内核读字节,把 master 预读的 prefix 丢掉,
    // getRequestBody 永远 pending,trace 卡在 "Started"。loopback 代理没有这个问题。
    const workerLoopbackPortBase = parseInt(process.env.WORKER_LOCAL_PORT_BASE, 10) || 11558;
    startStickyDispatcher({
        port: config.publicPort,
        host: config.publicHost,
        getLiveShardPorts: () => {
            // 返回 {shardId, port} 数组,按 shardId 升序,只包含活 worker。
            // 这样 hash(token) % N 对同 shardId 稳定,crash restart 不会漂移。
            const list = [];
            for (const id in cluster.workers) {
                const w = cluster.workers[id];
                if (!w) continue;
                if (typeof w.isDead === 'function' && w.isDead()) continue;
                const shardId = workerStats.get(w.id)?.workerId;
                if (!Number.isFinite(shardId)) continue;
                list.push({ shardId, port: workerLoopbackPortBase + shardId });
            }
            list.sort((a, b) => a.shardId - b.shardId);
            return list;
        }
    });

    // 监听 Worker 退出事件
    cluster.on('exit', (worker, code, signal) => {
        const stats = workerStats.get(worker.id);
        console.log(`[Master] Worker ${worker.id} (PID: ${worker.process.pid}) died (${signal || code})`);

        // 从状态追踪中移除
        workerStats.delete(worker.id);
        workerRuntimeStats.delete(worker.id);
        recordConnectionSample();

        // 自动重启
        if (stats && stats.restartCount < config.maxRestartAttempts) {
            const delay = Math.min(config.restartDelay * Math.pow(2, stats.restartCount), 30000);
            console.log(`[Master] Restarting worker in ${delay}ms...`);

            setTimeout(() => {
                startWorker(stats.workerId, stats.restartCount + 1);
            }, delay);
        } else {
            console.error('[Master] Max restart attempts reached for worker', worker.id);
        }
    });

    // 监听 Worker 在线事件
    cluster.on('online', (worker) => {
        console.log(`[Master] Worker ${worker.id} (PID: ${worker.process.pid}) is online`);
    });

    // 监听 Worker 消息
    cluster.on('message', (worker, message) => {
        if (!message || !message.type) {
            return;
        }
        // Worker 上报运行时状态
        if (message.type === 'worker_stats') {
            workerRuntimeStats.set(worker.id, {
                ...message.data,
                lastUpdate: Date.now()
            });
            recordConnectionSample();
            // Phase 5: shard 不均告警 —— 每次有 worker 上报时,若所有 worker 都已上报过,
            // 就计算 owned provider 的分布,若 max/min > 1.5 就记一条 WARN
            // 不使用定时器,直接用现有的 stats 上报节奏(每 5s 一次),开销可以忽略
            maybeWarnShardImbalance();
            return;
        }
        if (message.type === 'restart-request') {
            console.log(`[Master] Restart requested by worker ${worker.id}`);
            worker.kill('SIGTERM');
            return;
        }
        if (message.type === 'provider_pool_reload') {
            for (const id in cluster.workers) {
                const target = cluster.workers[id];
                if (!target) continue;
                target.send({
                    type: 'provider_pool_reload',
                    originPid: message.originPid || worker.process.pid
                });
            }
        }
        if (message.type === 'config_reload') {
            for (const id in cluster.workers) {
                const target = cluster.workers[id];
                if (!target) continue;
                target.send({
                    type: 'config_reload',
                    originPid: message.originPid || worker.process.pid,
                    reason: message.reason || 'update'
                });
            }
        }
        if (message.type === 'broadcast_event') {
            for (const id in cluster.workers) {
                const target = cluster.workers[id];
                if (!target) continue;
                target.send({
                    type: 'broadcast_event',
                    originPid: message.originPid || worker.process.pid,
                    eventType: message.eventType,
                    data: message.data
                });
            }
        }
    });

    // 创建管理服务器
    createMasterServer();

    // 设置信号处理
    setupSignalHandlers();

} else {
    // Worker 进程逻辑
    console.log(`[Worker ${cluster.worker.id}] Starting... PID: ${process.pid}`);

    // 动态导入 API 服务器
    import('../services/api-server.js').catch(error => {
        console.error(`[Worker ${cluster.worker.id}] Failed to start:`, error);
        process.exit(1);
    });
}

/**
 * 创建主进程管理 HTTP 服务器
 */
function createMasterServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;

        // 设置 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // 状态端点
        if (method === 'GET' && pathname === '/master/status') {
            const status = getStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status, null, 2));
            return;
        }

        // Phase 5: Prometheus metrics 端点
        // 输出纯文本 prometheus exposition format,便于外部监控系统采集
        if (method === 'GET' && pathname === '/master/metrics') {
            const status = getStatus();
            const lines = [];
            const push = (name, value, labels = {}) => {
                const labelStr = Object.keys(labels).length > 0
                    ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',') + '}'
                    : '';
                if (Number.isFinite(value)) {
                    lines.push(`${name}${labelStr} ${value}`);
                }
            };

            // master 进程
            lines.push('# HELP accounthub_master_rss_bytes Master process RSS bytes');
            lines.push('# TYPE accounthub_master_rss_bytes gauge');
            push('accounthub_master_rss_bytes', status.master?.memoryUsage?.rss);
            lines.push('# HELP accounthub_master_heap_used_bytes Master process heap used bytes');
            lines.push('# TYPE accounthub_master_heap_used_bytes gauge');
            push('accounthub_master_heap_used_bytes', status.master?.memoryUsage?.heapUsed);
            lines.push('# HELP accounthub_master_uptime_seconds Master uptime seconds');
            lines.push('# TYPE accounthub_master_uptime_seconds gauge');
            push('accounthub_master_uptime_seconds', status.master?.uptime);

            // 每个 worker
            lines.push('# HELP accounthub_worker_rss_bytes Worker RSS bytes');
            lines.push('# TYPE accounthub_worker_rss_bytes gauge');
            lines.push('# HELP accounthub_worker_heap_used_bytes Worker heap used bytes');
            lines.push('# TYPE accounthub_worker_heap_used_bytes gauge');
            lines.push('# HELP accounthub_worker_adapters_live Number of live adapters');
            lines.push('# TYPE accounthub_worker_adapters_live gauge');
            lines.push('# HELP accounthub_worker_adapters_hot Number of hot adapters (last 10 min)');
            lines.push('# TYPE accounthub_worker_adapters_hot gauge');
            lines.push('# HELP accounthub_worker_owned_providers Number of providers owned by this shard');
            lines.push('# TYPE accounthub_worker_owned_providers gauge');
            lines.push('# HELP accounthub_worker_active_connections Active HTTP connections');
            lines.push('# TYPE accounthub_worker_active_connections gauge');

            for (const w of status.workers || []) {
                const labels = { worker_id: w.id, shard: w.shard?.id ?? -1 };
                push('accounthub_worker_rss_bytes', w.memory?.rss, labels);
                push('accounthub_worker_heap_used_bytes', w.memory?.heapUsed, labels);
                push('accounthub_worker_adapters_live', w.adapters?.live, labels);
                push('accounthub_worker_adapters_hot', w.adapters?.hot, labels);
                push('accounthub_worker_owned_providers', w.shard?.ownedProviders, labels);
                push('accounthub_worker_active_connections', w.concurrency?.active, labels);
            }

            // 方案 C:sticky dispatcher 指标(loopback TCP 代理)
            const dispatcher = status.dispatcher || {};
            lines.push('# HELP accounthub_dispatcher_accepted_total TCP connections accepted by sticky dispatcher');
            lines.push('# TYPE accounthub_dispatcher_accepted_total counter');
            push('accounthub_dispatcher_accepted_total', dispatcher.acceptedConnections);
            lines.push('# HELP accounthub_dispatcher_sticky_total Sticky proxied connections (identity-based routing)');
            lines.push('# TYPE accounthub_dispatcher_sticky_total counter');
            push('accounthub_dispatcher_sticky_total', dispatcher.stickyProxied);
            lines.push('# HELP accounthub_dispatcher_rr_fallback_total Round-robin fallback proxied connections');
            lines.push('# TYPE accounthub_dispatcher_rr_fallback_total counter');
            push('accounthub_dispatcher_rr_fallback_total', dispatcher.rrFallbackProxied);
            lines.push('# HELP accounthub_dispatcher_parse_errors_total Header parse errors');
            lines.push('# TYPE accounthub_dispatcher_parse_errors_total counter');
            push('accounthub_dispatcher_parse_errors_total', dispatcher.headerParseErrors);
            lines.push('# HELP accounthub_dispatcher_upstream_errors_total Upstream loopback connect errors');
            lines.push('# TYPE accounthub_dispatcher_upstream_errors_total counter');
            push('accounthub_dispatcher_upstream_errors_total', dispatcher.upstreamConnectErrors);

            // 集群汇总
            lines.push('# HELP accounthub_cluster_rss_bytes Total cluster RSS bytes');
            lines.push('# TYPE accounthub_cluster_rss_bytes gauge');
            push('accounthub_cluster_rss_bytes', (status.cluster?.totalRssMB ?? 0) * 1024 * 1024);
            lines.push('# HELP accounthub_cluster_adapters_live Total live adapters across cluster');
            lines.push('# TYPE accounthub_cluster_adapters_live gauge');
            push('accounthub_cluster_adapters_live', status.cluster?.adaptersLive);
            lines.push('# HELP accounthub_cluster_owned_providers Total owned providers (sum across shards)');
            lines.push('# TYPE accounthub_cluster_owned_providers gauge');
            push('accounthub_cluster_owned_providers', status.cluster?.ownedProviders);
            lines.push('# HELP accounthub_cluster_shard_count Configured shard count');
            lines.push('# TYPE accounthub_cluster_shard_count gauge');
            push('accounthub_cluster_shard_count', status.master?.configuredWorkers);

            // shard 分布直方图(每个 shard 一条)
            if (status.cluster?.shard?.distribution) {
                lines.push('# HELP accounthub_shard_owned_providers Providers owned by a specific shard');
                lines.push('# TYPE accounthub_shard_owned_providers gauge');
                for (const [shardId, count] of Object.entries(status.cluster.shard.distribution)) {
                    push('accounthub_shard_owned_providers', count, { shard: shardId });
                }
            }

            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(lines.join('\n') + '\n');
            return;
        }

        // 健康检查
        if (method === 'GET' && pathname === '/master/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                workers: Object.keys(cluster.workers).length,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        // 重启所有 Worker
        if (method === 'POST' && pathname === '/master/restart') {
            console.log('[Master] Restart all workers requested via API');
            restartAllWorkers();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Restarting all workers' }));
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.on('connection', (socket) => {
        const remoteAddress = socket?.remoteAddress || 'unknown';
        console.log(`[Master TCP CONNECT] ${remoteAddress}`);
    });

    server.listen(config.masterPort, () => {
        console.log(`[Master] Management server listening on port ${config.masterPort}`);
        console.log(`[Master] Available endpoints:`);
        console.log(`  GET  /master/status  - Get master and workers status`);
        console.log(`  GET  /master/health  - Health check`);
        console.log(`  POST /master/restart - Restart all workers`);
    });

    return server;
}

/**
 * 获取状态信息
 */
function getStatus() {
    const workers = [];
    let totalRssBytes = 0;
    let totalHeapUsedBytes = 0;
    let totalActiveConnections = 0;
    let totalPeakConnections = 0;
    let totalRequests = 0;
    let totalCurrentConnections = 0;
    let totalConnectionAccepts = 0;
    let totalAdaptersLive = 0;
    let totalAdaptersHot = 0;
    let hotKnown = false;
    let totalOwnedProviders = 0;
    let ownedKnown = false;
    const shardDistribution = {};
    let anyShardEnabled = false;

    for (const id in cluster.workers) {
        const worker = cluster.workers[id];
        const stats = workerStats.get(parseInt(id));
        const runtime = workerRuntimeStats.get(worker.id) || {};

        const workerInfo = {
            id: worker.id,
            pid: worker.process.pid,
            state: worker.state,
            startTime: stats?.startTime,
            restartCount: stats?.restartCount || 0,
            // 运行时状态
            memory: runtime.memory || null,
            concurrency: runtime.concurrency || null,
            connections: runtime.connections || null,
            adapters: runtime.adapters || null,
            shard: runtime.shard || null,
            lastUpdate: runtime.lastUpdate || null
        };

        workers.push(workerInfo);

        // 汇总统计
        if (runtime.memory) {
            totalRssBytes += runtime.memory.rss || 0;
            totalHeapUsedBytes += runtime.memory.heapUsed || 0;
        }
        if (runtime.concurrency) {
            totalActiveConnections += runtime.concurrency.active || 0;
            totalPeakConnections = Math.max(totalPeakConnections, runtime.concurrency.peak || 0);
            totalRequests += runtime.concurrency.total || 0;
        }
        if (runtime.connections) {
            totalCurrentConnections += runtime.connections.active || 0;
            totalConnectionAccepts += runtime.connections.total || 0;
        }
        if (runtime.adapters) {
            totalAdaptersLive += runtime.adapters.live || 0;
            if (Number.isFinite(runtime.adapters.hot)) {
                totalAdaptersHot += runtime.adapters.hot;
                hotKnown = true;
            }
        }
        if (runtime.shard) {
            if (runtime.shard.enabled) anyShardEnabled = true;
            if (Number.isFinite(runtime.shard.ownedProviders)) {
                totalOwnedProviders += runtime.shard.ownedProviders;
                ownedKnown = true;
                const sid = runtime.shard.id;
                if (Number.isFinite(sid) && sid >= 0) {
                    shardDistribution[sid] = runtime.shard.ownedProviders;
                }
            }
        }
    }

    const masterMemory = process.memoryUsage();
    const now = Date.now();
    recordConnectionSample(now);
    const currentConnections = totalCurrentConnections;
    const peakConnections10m = getPeakConnections10m(now);

    return {
        master: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: masterMemory,
            memoryMB: Math.round(masterMemory.heapUsed / 1024 / 1024),
            rssMB: Math.round(masterMemory.rss / 1024 / 1024),
            cpuCores: os.cpus().length,
            configuredWorkers: config.numWorkers,
            publicPort: config.publicPort,
            loadAvg: os.loadavg()
        },
        admin: adminProcess ? {
            pid: adminProcess.pid,
            status: 'running'
        } : null,
        workers: workers,
        totalWorkers: workers.length,
        // 集群汇总
        cluster: {
            totalRssMB: Math.round(totalRssBytes / 1024 / 1024),
            totalHeapUsedMB: Math.round(totalHeapUsedBytes / 1024 / 1024),
            // 兼容旧字段名
            totalMemoryMB: Math.round(totalHeapUsedBytes / 1024 / 1024),
            activeConnections: totalActiveConnections,
            peakConnections: totalPeakConnections,
            totalRequests: totalRequests,
            currentConnections,
            peakSocketConnections: clusterPeakConnections,
            peakConnections10m,
            peakConnectionTime: clusterPeakConnectionTime,
            totalConnections: totalConnectionAccepts,
            adaptersLive: totalAdaptersLive,
            adaptersHot: hotKnown ? totalAdaptersHot : null,
            ownedProviders: ownedKnown ? totalOwnedProviders : null,
            shard: {
                enabled: anyShardEnabled,
                distribution: shardDistribution
            }
        },
        // 方案 B:sticky TCP dispatcher 的统计(master 唯一的数据面触点)
        dispatcher: getStickyDispatcherStats(),
        system: {
            platform: os.platform(),
            arch: os.arch(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            usedMemoryPercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + '%'
        }
    };
}

/**
 * 重启所有 Worker
 */
function restartAllWorkers() {
    console.log('[Master] Restarting all workers...');
    for (const id in cluster.workers) {
        cluster.workers[id].kill('SIGTERM');
    }
}

/**
 * 处理进程信号
 */
function setupSignalHandlers() {
    const gracefulShutdown = async (signal) => {
        console.log(`[Master] Received ${signal}, shutting down gracefully...`);
        // 方案 B 两阶段:
        //   1) 先停 sticky dispatcher,不再接受新连接(已 handoff 的不受影响,在 worker 里继续)
        //   2) kill admin 和 workers
        //   3) 5 秒强制 exit
        try {
            await stopStickyDispatcher();
        } catch (e) {
            console.warn('[Master] stopStickyDispatcher error:', e?.message || e);
        }
        if (adminProcess) {
            try { adminProcess.kill('SIGTERM'); } catch (_e) {}
        }
        for (const id in cluster.workers) {
            try { cluster.workers[id].kill('SIGTERM'); } catch (_e) {}
        }
        setTimeout(() => process.exit(0), 5000).unref();
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // 未捕获的异常
    process.on('uncaughtException', (error) => {
        console.error('[Master] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Master] Unhandled rejection at:', promise, 'reason:', reason);
    });
}
