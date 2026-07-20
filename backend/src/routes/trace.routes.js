/**
 * 追踪监控 API 路由
 * 提供请求链路追踪的查询和分析接口
 */

import { requestTracer, TRACE_PHASE } from '../monitoring/request-tracer.js';

/**
 * 追踪监控路由处理器
 */
export async function traceMonitorRouter(method, path, req, res) {
    // GET /api/trace/stats - 获取阶段统计
    if (method === 'GET' && path === '/api/trace/stats') {
        const stats = await requestTracer.getPhaseStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            data: stats,
            phases: Object.values(TRACE_PHASE)
        }));
        return true;
    }

    // GET /api/trace/recent - 获取最近的追踪
    if (method === 'GET' && path === '/api/trace/recent') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const traces = await requestTracer.getRecentTraces(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            count: traces.length,
            data: traces
        }));
        return true;
    }

    // GET /api/trace/slow - 获取慢请求
    if (method === 'GET' && path === '/api/trace/slow') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const threshold = parseInt(url.searchParams.get('threshold') || '10000', 10);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const traces = await requestTracer.getSlowTraces(threshold, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            threshold,
            count: traces.length,
            data: traces
        }));
        return true;
    }

    // GET /api/trace/bottlenecks - 分析瓶颈
    if (method === 'GET' && path === '/api/trace/bottlenecks') {
        const analysis = await requestTracer.analyzeBottlenecks();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            data: analysis
        }));
        return true;
    }

    // POST /api/trace/reset - 重置统计
    if (method === 'POST' && path === '/api/trace/reset') {
        await requestTracer.resetStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Trace statistics reset'
        }));
        return true;
    }

    // GET /api/trace/active - 获取当前活跃的追踪
    if (method === 'GET' && path === '/api/trace/active') {
        const active = [];
        for (const [traceId, context] of requestTracer.activeTraces) {
            active.push({
                traceId,
                startTime: new Date(context.startTime).toISOString(),
                elapsedMs: Date.now() - context.startTime,
                currentPhase: context.currentPhase,
                metadata: context.metadata
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            count: active.length,
            data: active
        }));
        return true;
    }

    return false;
}
