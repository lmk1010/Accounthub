/**
 * Adapter Idle Sweeper
 *
 * Phase 1 引入。定时扫描 serviceInstances Map,将长时间未被 getServiceAdapter 触达过的
 * adapter 实例释放(调用 adapter.dispose() 关闭底层 http/https agent、清 credentials/sessions
 * 引用),然后从 Map 中移除。下一次该 provider 来请求时由 getServiceAdapter 懒重建,
 * 代价是一次额外的 axios 实例化,可接受。
 *
 * 与"删除广播"(provider_removed IPC)正交:
 *   - 删除广播 — 响应明确的 provider 生命周期事件,立即释放
 *   - idle sweeper — 兜底空转流量为 0 的 adapter,防止长期驻留
 *
 * 配置(环境变量):
 *   - ADAPTER_IDLE_TTL_MS       默认 30 * 60 * 1000 = 30 分钟
 *   - ADAPTER_IDLE_SWEEP_INTERVAL_MS  默认 2 * 60 * 1000 = 2 分钟
 *   - ADAPTER_IDLE_SWEEPER_DISABLED   设为 "true" 则禁用(测试用)
 */

import { sweepIdleServiceInstances, getServiceInstanceMetrics } from './adapter.js';

// 默认 60 分钟空闲才回收,给极少数长时间运行的流式请求留足余量
// 对于正常短流(几秒到几分钟),60 分钟不足以造成任何延迟副作用
const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

// admin 进程:之前 5 分钟 TTL + 每分钟扫,被动承接 UI 点击触发的一次性 adapter 创建。
// 但和 monitoring-scheduler 的 10 分钟 usage 刷新配合成了刚好错开的 churn:
//   T0     admin 刷用量,为所有 provider 建 adapter
//   T5+    TTL 到,全部扫掉
//   T10    下轮 usage 刷新,又全部重建
// 现在 usage 定时刷新已经挪到 worker 上了(monitoring-scheduler.js),admin 不再主动
// 拉用量,但 UI 查询/管理按钮仍会懒建。把 TTL 拉长到 15 分钟覆盖连续点击/快速轮询,
// 避免剩余手动操作还被 5 分钟窗口惩罚。
const ADMIN_IDLE_TTL_MS = 15 * 60 * 1000;
const ADMIN_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

let sweeperHandle = null;
let sweeperConfig = null;

function parsePositiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 启动 idle sweeper。幂等:重复调用会覆盖上一轮 handle。
 * 仅在 worker 进程启用(IS_WORKER_PROCESS=true),admin/master 进程不需要。
 */
export function startAdapterIdleSweeper(options = {}) {
    if (process.env.ADAPTER_IDLE_SWEEPER_DISABLED === 'true') {
        console.log('[AdapterIdleSweeper] disabled by env');
        return null;
    }

    const isAdmin = process.env.IS_ADMIN_PROCESS === 'true';
    const isWorker = process.env.IS_WORKER_PROCESS === 'true';
    if (!isAdmin && !isWorker) {
        // master 进程不需要 sweeper
        return null;
    }

    // admin 进程用激进 TTL(Phase 4):UI 触发创建 → 5 分钟后自动清理
    // worker 进程用常规 TTL(Phase 1):60 分钟兜底长尾
    const defaultIdle = isAdmin ? ADMIN_IDLE_TTL_MS : DEFAULT_IDLE_TTL_MS;
    const defaultInterval = isAdmin ? ADMIN_SWEEP_INTERVAL_MS : DEFAULT_SWEEP_INTERVAL_MS;

    const idleTtlMs = options.idleTtlMs
        ?? parsePositiveInt(process.env.ADAPTER_IDLE_TTL_MS, defaultIdle);
    const sweepIntervalMs = options.sweepIntervalMs
        ?? parsePositiveInt(process.env.ADAPTER_IDLE_SWEEP_INTERVAL_MS, defaultInterval);

    sweeperConfig = { idleTtlMs, sweepIntervalMs };

    if (sweeperHandle) {
        clearInterval(sweeperHandle);
        sweeperHandle = null;
    }

    console.log(`[AdapterIdleSweeper] started: idleTtl=${Math.round(idleTtlMs / 1000)}s, interval=${Math.round(sweepIntervalMs / 1000)}s`);

    sweeperHandle = setInterval(() => {
        try {
            const before = getServiceInstanceMetrics();
            const swept = sweepIdleServiceInstances(idleTtlMs);
            if (swept > 0) {
                const after = getServiceInstanceMetrics();
                console.log(`[AdapterIdleSweeper] swept ${swept} idle, live ${before.live}→${after.live} hot=${after.hot}`);
            }
        } catch (error) {
            console.warn('[AdapterIdleSweeper] sweep error:', error?.message || error);
        }
    }, sweepIntervalMs);

    // 让 sweeper 不阻止进程退出
    if (sweeperHandle && typeof sweeperHandle.unref === 'function') {
        sweeperHandle.unref();
    }

    return sweeperHandle;
}

/**
 * 停止 sweeper(优雅关闭时调用)
 */
export function stopAdapterIdleSweeper() {
    if (sweeperHandle) {
        clearInterval(sweeperHandle);
        sweeperHandle = null;
        console.log('[AdapterIdleSweeper] stopped');
    }
}

export function getAdapterIdleSweeperConfig() {
    return sweeperConfig ? { ...sweeperConfig } : null;
}
