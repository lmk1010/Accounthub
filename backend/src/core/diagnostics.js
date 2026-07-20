/**
 * 运行时诊断工具
 *
 * Phase 5 引入。集中处理所有"按需触发"的诊断能力:
 *   - SIGUSR2 → 写 v8 heap snapshot 到 /app/logs
 *   - SIGUSR1 → 打印当前 adapter 池快照和 shard 信息到日志(轻量,不写文件)
 *
 * 信号保留策略:
 *   - SIGUSR1/SIGUSR2 是 POSIX 规定的"用户自定义"信号,不和 Node 运行时冲突
 *   - Node 默认会把 SIGUSR1 用于触发调试器(--inspect);为避免冲突,只在非调试模式注册
 *   - 信号发给 master 不会传给 worker,要给单个 worker dump 需要 kill -USR2 <worker-pid>
 *
 * 使用:
 *   docker exec accounthub-backend kill -SIGUSR2 <pid>
 *   → 在 /app/logs/heap-{pid}-{ts}.heapsnapshot 生成快照
 *   → Chrome DevTools → Memory → Load 即可离线分析
 */

import v8 from 'v8';
import fs from 'fs';
import path from 'path';

let installed = false;

export function installDiagnosticsSignals() {
    if (installed) return;
    installed = true;

    const logDir = process.env.LOG_DIR
        ? process.env.LOG_DIR
        : path.resolve(process.cwd(), 'logs');

    // SIGUSR2: heap snapshot
    try {
        process.on('SIGUSR2', () => {
            try {
                fs.mkdirSync(logDir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const filePath = path.join(logDir, `heap-${process.pid}-${ts}.heapsnapshot`);
                console.log(`[Diagnostics] Received SIGUSR2, writing heap snapshot to ${filePath}`);
                v8.writeHeapSnapshot(filePath);
                console.log(`[Diagnostics] Heap snapshot written: ${filePath}`);
            } catch (error) {
                console.error('[Diagnostics] heap snapshot failed:', error?.message || error);
            }
        });
    } catch (error) {
        console.warn('[Diagnostics] failed to install SIGUSR2 handler:', error?.message || error);
    }

    // SIGUSR1: 打印轻量快照(避免 node --inspect 冲突场景下也能诊断)
    // 条件:只在未启用 inspect 的场景注册
    const hasInspector = process.execArgv.some(a => /--inspect/.test(a));
    if (!hasInspector) {
        try {
            process.on('SIGUSR1', async () => {
                try {
                    const mem = process.memoryUsage();
                    console.log('[Diagnostics] === runtime snapshot ===');
                    console.log(`  pid=${process.pid} uptime=${Math.round(process.uptime())}s`);
                    console.log(`  rss=${Math.round(mem.rss / 1024 / 1024)}MB heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB heapTotal=${Math.round(mem.heapTotal / 1024 / 1024)}MB external=${Math.round(mem.external / 1024 / 1024)}MB`);

                    // 尝试读取 shard 信息
                    try {
                        const shard = await import('../utils/shard.js');
                        console.log(`  shard id=${shard.SHARD_ID} count=${shard.SHARD_COUNT} enabled=${shard.SHARD_ENABLED}`);
                    } catch (_err) { /* shard 模块加载失败 */ }

                    // 尝试读取 adapter 指标
                    try {
                        const adapter = await import('../providers/adapter.js');
                        const metrics = adapter.getServiceInstanceMetrics();
                        console.log(`  adapters live=${metrics.live} hot=${metrics.hot} disposed=${metrics.disposedSinceStart}`);
                    } catch (_err) { /* adapter 模块加载失败 */ }

                    // 方案 B:forward 指标已移除(master sticky dispatcher 维护 dispatcher 指标,
                    // 通过 /master/status.dispatcher 查看,不在 worker 本地)

                    console.log('[Diagnostics] === end snapshot ===');
                } catch (error) {
                    console.error('[Diagnostics] snapshot error:', error?.message || error);
                }
            });
        } catch (error) {
            console.warn('[Diagnostics] failed to install SIGUSR1 handler:', error?.message || error);
        }
    }
}
