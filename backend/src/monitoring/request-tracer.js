/**
 * 请求链路追踪模块
 * 追踪从 Claude Code 到 Kiro API 的完整请求链路
 * 使用 Redis 存储追踪数据，支持跨进程共享
 */

import { v4 as uuidv4 } from 'uuid';
import { getRedisClient, isRedisAvailable } from '../services/redis-client.js';

// Redis 键前缀
const REDIS_KEYS = {
    TRACE_HISTORY: 'trace:history',      // List: 追踪历史
    TRACE_STATS: 'trace:stats',          // Hash: 阶段统计
    TRACE_ACTIVE: 'trace:active:',       // Hash: 活跃追踪 (per traceId)
};

// 追踪历史最大条数
const MAX_HISTORY_SIZE = 1000;
// 追踪数据过期时间 (24小时)
const TRACE_TTL = 86400;

/**
 * 追踪阶段枚举
 */
export const TRACE_PHASE = {
    REQUEST_PARSE: 'request_parse',      // 请求解析
    AUTH_CHECK: 'auth_check',            // 认证检查
    POOL_SELECT: 'pool_select',          // 号池选择
    TOKEN_REFRESH: 'token_refresh',      // Token 刷新
    REQUEST_BUILD: 'request_build',      // 请求构建
    TTFT: 'ttft',                        // 首字节时间 (Time To First Token)
    COMPLETE: 'complete',                // 完成生成
    MCP_CALL: 'mcp_call',               // MCP 调用 (WebSearch)
    RESPONSE_CONVERT: 'response_convert' // 响应转换
};

/**
 * 请求追踪器 (Redis 版本)
 */
class RequestTracer {
    constructor() {
        // 内存缓存 (活跃追踪仍用内存，完成后写入 Redis)
        this.activeTraces = new Map();

        // 本地统计缓存 (定期同步到 Redis)
        this.localPhaseStats = {};
        for (const phase of Object.values(TRACE_PHASE)) {
            this.localPhaseStats[phase] = {
                count: 0,
                totalMs: 0,
                maxMs: 0,
                minMs: Infinity
            };
        }

        // 定时兜底清理：防止错误路径未调 endTrace 导致泄漏
        this._cleanupTimer = setInterval(() => this._cleanupStale(), 60000);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    /**
     * 兜底清理：移除超过 30 分钟的活跃 trace（说明 endTrace 未被调用）
     * 正常流式请求（含 Opus thinking、agentic 多轮）一般不超过 15 分钟
     * 30 分钟阈值足够安全，不会误杀活跃请求
     */
    _cleanupStale() {
        const now = Date.now();
        const staleThreshold = now - 30 * 60 * 1000; // 30 分钟
        let cleaned = 0;

        for (const [traceId, context] of this.activeTraces) {
            if (context.startTime < staleThreshold) {
                this.activeTraces.delete(traceId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[RequestTracer] Cleaned ${cleaned} stale traces, active=${this.activeTraces.size}`);
        }
    }

    /**
     * 获取 Redis 客户端
     */
    _getRedis() {
        return isRedisAvailable() ? getRedisClient() : null;
    }

    /**
     * 从请求中提取或生成 traceId
     * Claude Code 会发送 x-request-id header
     */
    extractTraceId(req) {
        const headers = req?.headers || {};
        return headers['x-request-id'] ||
               headers['x-trace-id'] ||
               headers['x-b3-traceid'] ||
               headers['traceparent']?.split('-')?.[1] ||
               `trace_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    }

    /**
     * 开始追踪一个请求
     */
    startTrace(req, metadata = {}) {
        const traceId = this.extractTraceId(req);
        const now = Date.now();

        const context = {
            traceId,
            startTime: now,
            phases: {},
            metadata: {
                method: req?.method,
                path: req?.url?.split('?')[0],
                model: metadata.model || null,
                provider: metadata.provider || null,
                userId: metadata.userId || null,
                poolId: metadata.poolId || null,
                ...metadata
            },
            currentPhase: null,
            completed: false
        };

        this.activeTraces.set(traceId, context);
        console.log(`[Trace:${traceId}] Started - ${context.metadata.method} ${context.metadata.path}`);

        return traceId;
    }

    /**
     * 开始一个阶段
     */
    startPhase(traceId, phase) {
        const context = this.activeTraces.get(traceId);
        if (!context) return;

        context.currentPhase = phase;
        context.phases[phase] = {
            startTime: Date.now(),
            endTime: null,
            durationMs: null,
            error: null
        };
    }

    /**
     * 结束一个阶段
     */
    endPhase(traceId, phase, error = null) {
        const context = this.activeTraces.get(traceId);
        if (!context || !context.phases[phase]) return;

        const phaseData = context.phases[phase];
        phaseData.endTime = Date.now();
        phaseData.durationMs = phaseData.endTime - phaseData.startTime;
        phaseData.error = error;

        // 更新统计
        const stats = this.localPhaseStats[phase];
        if (stats) {
            stats.count++;
            stats.totalMs += phaseData.durationMs;
            stats.maxMs = Math.max(stats.maxMs, phaseData.durationMs);
            stats.minMs = Math.min(stats.minMs, phaseData.durationMs);
        }

        context.currentPhase = null;
    }

    /**
     * 记录阶段耗时 (一次性记录，无需 start/end)
     */
    recordPhase(traceId, phase, durationMs, error = null) {
        const context = this.activeTraces.get(traceId);
        if (!context) return;

        const now = Date.now();
        context.phases[phase] = {
            startTime: now - durationMs,
            endTime: now,
            durationMs,
            error
        };

        // 更新统计
        const stats = this.localPhaseStats[phase];
        if (stats) {
            stats.count++;
            stats.totalMs += durationMs;
            stats.maxMs = Math.max(stats.maxMs, durationMs);
            stats.minMs = Math.min(stats.minMs, durationMs);
        }
    }

    /**
     * 更新追踪元数据
     */
    updateMetadata(traceId, metadata) {
        const context = this.activeTraces.get(traceId);
        if (!context) return;

        Object.assign(context.metadata, metadata);
    }

    /**
     * 完成追踪 - 写入 Redis
     */
    async endTrace(traceId, result = {}) {
        const context = this.activeTraces.get(traceId);
        if (!context) return null;

        context.endTime = Date.now();
        context.totalMs = context.endTime - context.startTime;
        context.completed = true;
        context.result = {
            success: result.success !== false,
            statusCode: result.statusCode || 200,
            error: result.error || null,
            outputTokens: result.outputTokens || 0,
            inputTokens: result.inputTokens || 0,
            // 缓存 token 统计
            cacheCreationTokens: result.cacheCreationTokens || 0,
            cacheReadTokens: result.cacheReadTokens || 0,
            // Kiro credit 使用
            creditUsage: result.creditUsage || null
        };

        // 生成追踪报告
        const report = this._generateReport(context);

        // 写入 Redis
        await this._saveToRedis(report);

        // 从活跃追踪中移除
        this.activeTraces.delete(traceId);

        // 输出追踪日志
        this._logTrace(report);

        return report;
    }

    /**
     * 保存追踪报告到 Redis
     */
    async _saveToRedis(report) {
        const redis = this._getRedis();
        if (!redis) return;

        try {
            // 1. 添加到历史列表 (LPUSH + LTRIM 保持最大条数)
            await redis.lpush(REDIS_KEYS.TRACE_HISTORY, JSON.stringify(report));
            await redis.ltrim(REDIS_KEYS.TRACE_HISTORY, 0, MAX_HISTORY_SIZE - 1);

            // 2. 更新阶段统计
            for (const [phase, data] of Object.entries(report.phases)) {
                if (data.durationMs != null) {
                    const statsKey = `${REDIS_KEYS.TRACE_STATS}:${phase}`;
                    await redis.hincrby(statsKey, 'count', 1);
                    await redis.hincrbyfloat(statsKey, 'totalMs', data.durationMs);

                    // 更新 max/min
                    const currentMax = await redis.hget(statsKey, 'maxMs');
                    if (!currentMax || data.durationMs > parseFloat(currentMax)) {
                        await redis.hset(statsKey, 'maxMs', data.durationMs);
                    }
                    const currentMin = await redis.hget(statsKey, 'minMs');
                    if (!currentMin || data.durationMs < parseFloat(currentMin)) {
                        await redis.hset(statsKey, 'minMs', data.durationMs);
                    }
                }
            }
        } catch (error) {
            console.error('[Trace] Failed to save to Redis:', error.message);
        }
    }

    /**
     * 生成追踪报告
     */
    _generateReport(context) {
        const phases = {};
        let slowestPhase = null;
        let slowestTime = 0;

        for (const [phase, data] of Object.entries(context.phases)) {
            phases[phase] = {
                durationMs: data.durationMs,
                error: data.error
            };
            if (data.durationMs > slowestTime) {
                slowestTime = data.durationMs;
                slowestPhase = phase;
            }
        }

        return {
            traceId: context.traceId,
            timestamp: new Date(context.startTime).toISOString(),
            totalMs: context.totalMs,
            phases,
            slowestPhase,
            slowestPhaseMs: slowestTime,
            metadata: context.metadata,
            result: context.result
        };
    }

    /**
     * 输出追踪日志
     */
    _logTrace(report) {
        const phases = Object.entries(report.phases)
            .map(([phase, data]) => `${phase}=${data.durationMs}ms`)
            .join(', ');

        const status = report.result.success ? 'OK' : 'FAIL';
        const model = report.metadata.model || 'unknown';
        const r = report.result;

        // 缓存信息
        const cacheInfo = (r.cacheReadTokens || r.cacheCreationTokens)
            ? ` cache[read=${r.cacheReadTokens},create=${r.cacheCreationTokens}]`
            : '';

        // Credit 信息
        const creditInfo = r.creditUsage
            ? ` credit[used=${r.creditUsage.used},remain=${r.creditUsage.remaining}]`
            : '';

        console.log(`[Trace:${report.traceId}] ${status} total=${report.totalMs}ms model=${model} in=${r.inputTokens} out=${r.outputTokens}${cacheInfo}${creditInfo} slowest=${report.slowestPhase}(${report.slowestPhaseMs}ms) [${phases}]`);

        // 如果有明显的慢阶段，输出警告
        if (report.slowestPhaseMs > 5000) {
            console.warn(`[Trace:${report.traceId}] SLOW: ${report.slowestPhase} took ${report.slowestPhaseMs}ms`);
        }
    }

    /**
     * 获取追踪上下文
     */
    getContext(traceId) {
        return this.activeTraces.get(traceId);
    }

    /**
     * 获取阶段统计 - 从 Redis 读取
     */
    async getPhaseStats() {
        const redis = this._getRedis();
        const result = {};

        for (const phase of Object.values(TRACE_PHASE)) {
            result[phase] = { count: 0, avgMs: 0, maxMs: 0, minMs: 0 };

            if (redis) {
                try {
                    const statsKey = `${REDIS_KEYS.TRACE_STATS}:${phase}`;
                    const stats = await redis.hgetall(statsKey);
                    if (stats && stats.count) {
                        const count = parseInt(stats.count) || 0;
                        const totalMs = parseFloat(stats.totalMs) || 0;
                        result[phase] = {
                            count,
                            avgMs: count > 0 ? Math.round(totalMs / count) : 0,
                            maxMs: parseFloat(stats.maxMs) || 0,
                            minMs: parseFloat(stats.minMs) || 0
                        };
                    }
                } catch (e) {
                    console.error(`[Trace] Failed to get stats for ${phase}:`, e.message);
                }
            }
        }
        return result;
    }

    /**
     * 获取最近的追踪历史 - 从 Redis 读取
     */
    async getRecentTraces(limit = 100) {
        const redis = this._getRedis();
        if (!redis) return [];

        try {
            const items = await redis.lrange(REDIS_KEYS.TRACE_HISTORY, 0, limit - 1);
            return items.map(item => JSON.parse(item));
        } catch (error) {
            console.error('[Trace] Failed to get recent traces:', error.message);
            return [];
        }
    }

    /**
     * 获取慢请求 - 从 Redis 读取
     */
    async getSlowTraces(thresholdMs = 10000, limit = 50) {
        const traces = await this.getRecentTraces(MAX_HISTORY_SIZE);
        return traces
            .filter(t => t.totalMs > thresholdMs)
            .slice(0, limit);
    }

    /**
     * 分析瓶颈 - 从 Redis 读取
     */
    async analyzeBottlenecks() {
        const stats = await this.getPhaseStats();
        const bottlenecks = [];

        for (const [phase, data] of Object.entries(stats)) {
            if (data.count === 0) continue;
            bottlenecks.push({
                phase,
                avgMs: data.avgMs,
                maxMs: data.maxMs,
                count: data.count
            });
        }

        bottlenecks.sort((a, b) => b.avgMs - a.avgMs);

        return {
            topBottlenecks: bottlenecks.slice(0, 5),
            allPhases: stats,
            recommendation: this._generateRecommendation(bottlenecks)
        };
    }

    /**
     * 生成优化建议
     */
    _generateRecommendation(bottlenecks) {
        const recommendations = [];

        for (const b of bottlenecks.slice(0, 3)) {
            if (b.phase === TRACE_PHASE.TTFT && b.avgMs > 3000) {
                recommendations.push(`TTFT 平均 ${b.avgMs}ms 较慢，建议: 检查网络延迟、考虑使用更近的 Region`);
            }
            if (b.phase === TRACE_PHASE.TOKEN_REFRESH && b.avgMs > 1000) {
                recommendations.push(`Token 刷新平均 ${b.avgMs}ms，建议: 提前刷新 Token、增加 Token 缓存时间`);
            }
            if (b.phase === TRACE_PHASE.POOL_SELECT && b.avgMs > 500) {
                recommendations.push(`号池选择平均 ${b.avgMs}ms，建议: 优化选号算法、增加缓存`);
            }
            if (b.phase === TRACE_PHASE.MCP_CALL && b.avgMs > 2000) {
                recommendations.push(`MCP 调用平均 ${b.avgMs}ms，建议: WebSearch 请求可能受网络影响`);
            }
        }

        return recommendations;
    }

    /**
     * 重置统计 - 清空 Redis
     */
    async resetStats() {
        const redis = this._getRedis();
        if (redis) {
            try {
                // 删除历史
                await redis.del(REDIS_KEYS.TRACE_HISTORY);
                // 删除所有阶段统计
                for (const phase of Object.values(TRACE_PHASE)) {
                    await redis.del(`${REDIS_KEYS.TRACE_STATS}:${phase}`);
                }
            } catch (error) {
                console.error('[Trace] Failed to reset stats:', error.message);
            }
        }
    }
}

// 全局单例
export const requestTracer = new RequestTracer();

/**
 * 便捷的追踪装饰器 (用于 async 函数)
 */
export function withTracing(traceId, phase, fn) {
    return async (...args) => {
        requestTracer.startPhase(traceId, phase);
        try {
            const result = await fn(...args);
            requestTracer.endPhase(traceId, phase);
            return result;
        } catch (error) {
            requestTracer.endPhase(traceId, phase, error.message);
            throw error;
        }
    };
}

/**
 * 计时器辅助函数
 */
export function createPhaseTimer(traceId, phase) {
    const startTime = Date.now();
    return {
        end: (error = null) => {
            const durationMs = Date.now() - startTime;
            requestTracer.recordPhase(traceId, phase, durationMs, error);
            return durationMs;
        }
    };
}
