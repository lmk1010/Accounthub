/**
 * Worker 运行时指标采集器
 *
 * 单一入口,返回上报给 master 的完整统计形状。形状在此处定义并跨阶段保持稳定,
 * 各阶段逐步把占位字段替换为真实值:
 *   Phase 0: 建立形状,memory/concurrency/adapters.live 已真实,其余占位
 *   Phase 1: adapters.hot / adapters.disposed 接入 idle sweeper
 *   Phase 2+3 (方案 B): shard.* 接入 utils/shard.js;forward.* 已移除(sticky 由 master TCP dispatcher 保证)
 *
 * 使用方(api-server.js)只需 import 此模块,不关心底层子系统是否就位。
 */

import { getLocalConcurrencyStats } from '../handlers/request-handler.js';
import { getServiceInstanceMetrics } from '../providers/adapter.js';
import { getSocketStats } from '../services/api-server.js';

// 轻量懒加载:避免启动期循环依赖
let shardModulePromise = null;
async function loadShardModule() {
    if (!shardModulePromise) {
        shardModulePromise = import('../utils/shard.js').catch(() => null);
    }
    return shardModulePromise;
}

/**
 * 采集当前进程的运行时指标快照
 * @returns {Promise<Object>} 统一形状的 stats 对象,可直接 send 给 master
 */
export async function collectWorkerRuntimeStats() {
    const memory = process.memoryUsage();
    const concurrency = safeGetLocalConcurrencyStats();
    const connections = safeGetSocketStats();
    const adapters = collectAdapterStats();
    const shard = await collectShardStats();

    return {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            rss: memory.rss,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers ?? 0
        },
        concurrency: {
            active: concurrency?.activeConnections ?? 0,
            peak: concurrency?.peakConnections ?? 0,
            total: concurrency?.totalConnections ?? 0
        },
        connections: {
            active: connections?.activeConnections ?? 0,
            peak: connections?.peakConnections ?? 0,
            total: connections?.totalConnections ?? 0,
            lastPeakTime: connections?.lastPeakTime ?? null
        },
        adapters,
        shard
    };
}

function safeGetLocalConcurrencyStats() {
    try {
        return getLocalConcurrencyStats();
    } catch (_error) {
        return null;
    }
}

function safeGetSocketStats() {
    try {
        return getSocketStats();
    } catch (_error) {
        return null;
    }
}

/**
 * adapter 缓存指标
 * - live: 当前驻留的 adapter 数
 * - hot:  最近 10 分钟被 getServiceAdapter 触达过的 adapter 数
 * - disposedSinceStart: 启动至今被 dispose 的 adapter 数(含 idle sweeper + 主动删除)
 */
function collectAdapterStats() {
    try {
        return getServiceInstanceMetrics();
    } catch (_error) {
        return { live: 0, hot: 0, disposedSinceStart: 0 };
    }
}

/**
 * shard 归属指标。真实值由 utils/shard.js 提供,ownedProviders 由 pool manager
 * 在 init 阶段挂到 providerPoolManager._ownedProviderCount 上,这里读取。
 */
async function collectShardStats() {
    const mod = await loadShardModule();
    let base = { id: -1, count: 1, ownedProviders: null, enabled: false };
    if (mod && typeof mod.getShardInfo === 'function') {
        try {
            base = { ...base, ...mod.getShardInfo() };
        } catch (_error) { /* keep default */ }
    }

    // 尝试从 service-manager 拿 providerPoolManager 上的 owned count
    try {
        const svc = await import('../services/service-manager.js').catch(() => null);
        const mgr = svc?.getProviderPoolManager?.();
        if (mgr && Number.isFinite(mgr._ownedProviderCount)) {
            base.ownedProviders = mgr._ownedProviderCount;
        }
    } catch (_error) { /* keep null */ }

    return base;
}

// 方案 B:内部 HTTP forward 已移除,sticky 由 master 的 TCP dispatcher 保证;
// 该文件不再有 forward 相关统计。dispatcher 的指标由 master 自己维护并在
// /master/status.dispatcher 暴露。
