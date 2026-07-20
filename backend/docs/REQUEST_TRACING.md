# 请求链路追踪集成指南

## 概述

追踪模块 (`src/monitoring/request-tracer.js`) 用于追踪从 Claude Code 到后端 API 的完整请求链路，帮助定位性能瓶颈。支持多种渠道（Kiro、Codex 等）。

## 链路图

```
Claude Code (IDE)
    │
    │  x-request-id: abc123 (Claude Code 自带)
    ▼
NewAPI (转发层)
    │
    ▼
你的反代服务 (AccountHub)
    │
    ├─ [request_parse]   请求解析
    ├─ [auth_check]      认证检查
    ├─ [pool_select]     号池选择
    ├─ [token_refresh]   Token 刷新
    ├─ [request_build]   请求构建
    │      ▼
    │   后端 API (Kiro/Codex/...)
    ├─ [ttft]            首字节时间
    ├─ [complete]        生成完成
    ├─ [mcp_call]        MCP 调用 (WebSearch)
    ├─ [response_convert] 响应转换
    │
    ▼
Claude Code 收到响应
```

## API 端点

追踪数据可通过以下 API 查询：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/trace/stats` | GET | 各阶段耗时统计 |
| `/api/trace/recent?limit=100` | GET | 最近追踪记录 |
| `/api/trace/slow?threshold=10000` | GET | 慢请求列表 |
| `/api/trace/bottlenecks` | GET | 瓶颈分析及建议 |
| `/api/trace/active` | GET | 当前活跃请求 |
| `/api/trace/reset` | POST | 重置统计 |

## 集成步骤

### 1. 在 common.js 中集成

在 `handleContentGenerationRequest` 函数开头添加：

```javascript
import { requestTracer, TRACE_PHASE, createPhaseTimer } from '../monitoring/request-tracer.js';

export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, ...) {
    // 开始追踪
    const traceId = requestTracer.startTrace(req, {
        provider: CONFIG.MODEL_PROVIDER,
        poolId: CONFIG.POOL_ID
    });

    // 请求解析阶段
    requestTracer.startPhase(traceId, TRACE_PHASE.REQUEST_PARSE);
    const originalRequestBody = await getRequestBody(req);
    requestTracer.endPhase(traceId, TRACE_PHASE.REQUEST_PARSE);

    // ... 后续代码

    // 号池选择阶段
    requestTracer.startPhase(traceId, TRACE_PHASE.POOL_SELECT);
    const result = await getApiServiceWithFallback(CONFIG, model);
    requestTracer.endPhase(traceId, TRACE_PHASE.POOL_SELECT);

    // 更新追踪元数据
    requestTracer.updateMetadata(traceId, { model, provider: result.actualProviderType });

    // ... 请求处理

    // 在响应完成后结束追踪
    requestTracer.endTrace(traceId, { success: true, statusCode: 200 });
}
```

### 2. 在 Provider 中集成 (以 claude-kiro.js 为例)

在 `generateContentStream` 函数中添加 TTFT 追踪：

```javascript
import { requestTracer, TRACE_PHASE } from '../../monitoring/request-tracer.js';

async * generateContentStream(model, requestBody) {
    // 从 requestBody.metadata 获取 traceId（需要上层传递）
    const traceId = requestBody.metadata?.traceId;

    // ... 现有代码

    for await (const event of this.streamApiReal('', finalModel, requestBody)) {
        if (event.type === 'content' && event.content) {
            // 记录首字时间
            if (!streamState.firstContentReceived) {
                streamState.firstContentReceived = true;
                ttftMs = Date.now() - requestStartTime;

                // 记录到追踪系统
                if (traceId) {
                    requestTracer.recordPhase(traceId, TRACE_PHASE.TTFT, ttftMs);
                }
            }
            // ...
        }
    }

    // 记录生成完成时间
    if (traceId) {
        requestTracer.recordPhase(traceId, TRACE_PHASE.COMPLETE, Date.now() - requestStartTime);
    }
}
```

### 3. 在 request-handler.js 中集成路由

```javascript
import { traceMonitorRouter } from '../routes/trace.routes.js';

// 在路由处理中添加
const traceHandled = await traceMonitorRouter(method, path, req, res);
if (traceHandled) return;
```

## 使用示例

### 查看统计数据

```bash
curl http://localhost:3000/api/trace/stats
```

响应：
```json
{
  "success": true,
  "data": {
    "request_parse": { "count": 150, "avgMs": 5, "maxMs": 25, "minMs": 1 },
    "pool_select": { "count": 150, "avgMs": 120, "maxMs": 500, "minMs": 50 },
    "ttft": { "count": 150, "avgMs": 2500, "maxMs": 8000, "minMs": 800 }
  }
}
```

### 分析瓶颈

```bash
curl http://localhost:3000/api/trace/bottlenecks
```

响应：
```json
{
  "success": true,
  "data": {
    "topBottlenecks": [
      { "phase": "ttft", "avgMs": 2500, "maxMs": 8000, "count": 150 },
      { "phase": "pool_select", "avgMs": 120, "maxMs": 500, "count": 150 }
    ],
    "recommendation": [
      "TTFT 平均 2500ms 较慢，建议: 检查网络延迟、考虑使用更近的 Region"
    ]
  }
}
```

### 查看慢请求

```bash
curl "http://localhost:3000/api/trace/slow?threshold=5000&limit=10"
```

响应：
```json
{
  "success": true,
  "threshold": 5000,
  "count": 3,
  "data": [
    {
      "traceId": "abc123",
      "totalMs": 12500,
      "slowestPhase": "ttft",
      "slowestPhaseMs": 8000,
      "metadata": { "model": "claude-sonnet-4.5", "userId": "user1" }
    }
  ]
}
```

## 日志输出格式

追踪完成后会输出结构化日志：

```
[Trace:abc123] OK total=5200ms model=claude-sonnet-4.5 slowest=ttft(3500ms) [request_parse=5ms, pool_select=120ms, ttft=3500ms, complete=5000ms]
```

如果有慢阶段（>5s）会输出警告：

```
[Trace:abc123] SLOW: ttft took 8000ms
```

## 性能影响

- 追踪模块设计为低开销，每次追踪仅增加约 0.1-0.5ms
- 历史记录限制为 1000 条，避免内存泄漏
- 统计数据实时计算，无持久化开销

## 后续优化建议

根据追踪数据，常见瓶颈及优化方向：

| 瓶颈阶段 | 可能原因 | 优化建议 |
|---------|---------|---------|
| `ttft` > 3s | 网络延迟、Region 远 | 选择更近的 Region、优化网络路由 |
| `token_refresh` > 1s | Token 过期频繁 | 提前刷新、增加缓存时间 |
| `pool_select` > 500ms | 选号算法慢、健康凭证少 | 优化算法、增加凭证池 |
| `mcp_call` > 2s | WebSearch 网络慢 | 可接受，外部 API 限制 |
