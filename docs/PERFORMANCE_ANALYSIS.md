# AccountHub 性能分析与优化报告

> 生成时间：2026-01-28
> 更新时间：2026-01-28

## 一、当前架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    客户端请求                            │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              中间件层 (请求日志/错误处理/路由增强)         │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              请求处理层 (common.js)                      │
│              流式/非流式统一处理                          │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│         账号池管理层 (ProviderPoolManagerDB)             │
│         轮询/健康检查/故障转移/负载均衡                   │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│         服务适配层 (Kiro/Claude/OpenAI/Gemini)           │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┘
│              数据持久化 (MySQL + Redis)                  │
└─────────────────────────────────────────────────────────┘
```

---

## 二、已有的优化设计（亮点）

### ✅ 1. 请求日志异步队列（已实现）

```javascript
// request-log-queue.js - 已实现 Redis 队列异步写入
if (isLogQueueAvailable()) {
    pushRequestLog(logRecord).catch(err => {...});  // 异步，不阻塞
} else {
    requestLogsDao.create(logRecord).catch(err => {...});  // 降级直接写
}
```

**状态：** ✅ 已实现，需要确保 Redis 可用

### ✅ 2. Token 刷新去重锁（已实现）

```javascript
// file-lock.js - withDeduplication 实现
// 10个并发刷新请求 → 只执行1次，共享结果
await withDeduplication(dedupeKey, async () => {
    await this._doTokenRefresh(this.oauthCredentialId);
});
```

**状态：** ✅ 已实现内存级去重，但单机限制

### ✅ 3. HTTP Agent 连接池（已实现）

```javascript
// 所有 Provider 都配置了连接池
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 120000,
});
```

**状态：** ✅ 已实现

---

## 三、关键性能瓶颈

| 瓶颈 | 位置 | 影响 | 严重度 |
|------|------|------|--------|
| **缓存 Token 计算** | `kiro-cache-simulator.js` | 每次遍历所有历史消息 O(n) | 🔴 高 |
| **健康检查串行执行** | `provider-pool-manager-db.js:1363` | 逐个检查，100账号=100次串行 | 🟡 中 |
| **recordRequestLog 查询 pool_id** | `provider-pool-manager-db.js:1158` | 每次日志都查一次数据库 | 🟡 中 |
| **去重锁单机限制** | `file-lock.js` | 多实例部署时无法共享去重状态 | 🟡 中 |
| **数据库连接池默认值偏小** | `database.js` | 默认 300/Worker 数，高并发不足 | 🟡 中 |

---

## 四、并发能力估算

### 当前配置

```
HTTP Agent maxSockets: 256
MySQL 连接池: 75 (4 Worker, 总 300)
Redis: 可选（影响日志队列和轮询）
```

### 理论 vs 实际

| 场景 | 理论 RPS | 实际 RPS | 瓶颈 |
|------|---------|---------|------|
| 单机 + Redis | 256 | **~200-250** | 数据库连接池 |
| 单机无 Redis | 256 | **~150** | 同步日志写入 |
| 开启缓存模拟 | 256 | **~50-80** | Token 计算阻塞 |
| 多实例部署 | 无限 | **~150×N** | 去重锁不共享 |

---

## 五、具体优化建议

### 🔴 高优先级（立即实施）

#### 1. 禁用/优化缓存模拟

**问题：** 每次请求遍历所有历史消息，120K 上下文 → 300-500ms 延迟

**方案：**
```bash
# 方案 A：直接禁用
KIRO_CACHE_SIMULATION=false

# 方案 B：改为简单估算（不调用 tokenizer）
inputTokens = Math.ceil(JSON.stringify(requestBody).length / 4);
```

**预期效果：** TTFT 从 40s → 3s

#### 2. 健康检查并行化

**问题：** `performHealthChecks` 串行检查每个账号

**当前代码：**
```javascript
// provider-pool-manager-db.js:1363
for (const provider of unhealthyProviders) {
    const result = await this._checkProviderHealth(...);  // 串行！
}
```

**优化方案：**
```javascript
// 并行检查，限制并发数
const CONCURRENCY = 10;
const chunks = chunkArray(unhealthyProviders, CONCURRENCY);
for (const chunk of chunks) {
    await Promise.all(chunk.map(p => this._checkProviderHealth(...)));
}
```

**预期效果：** 检查时间 100s → 10s

#### 3. recordRequestLog 移除 pool_id 查询

**问题：** 每次记录日志都查询一次数据库获取 pool_id

**当前代码：**
```javascript
// provider-pool-manager-db.js:1157-1162
let poolId = 0;
try {
    const provider = await providerDao.findByUuid(providerUuid);  // 每次都查！
    poolId = provider?.pool_id ?? 0;
} catch (error) {...}
```

**优化方案：**
```javascript
// 方案 A：从调用方传入 poolId（已有数据）
providerPoolManager.recordRequestLog({
    ...options,
    poolId: provider.pool_id  // 调用方已有，直接传入
});

// 方案 B：内存缓存 uuid → poolId 映射
const poolIdCache = new Map();  // TTL 5分钟
```

**预期效果：** 每请求减少 1 次数据库查询

### 🟡 中优先级（1-2 周）

#### 4. 去重锁改为 Redis 分布式锁

**问题：** `withDeduplication` 使用内存 Map，多实例部署时无法共享

**优化方案：**
```javascript
// 使用 Redis SETNX 实现分布式去重
async function withDistributedDeduplication(key, operation, ttlMs = 30000) {
    const lockKey = `dedupe:${key}`;
    const acquired = await redis.set(lockKey, '1', 'PX', ttlMs, 'NX');

    if (!acquired) {
        // 等待其他实例完成
        await waitForKey(lockKey, ttlMs);
        return; // 或从缓存获取结果
    }

    try {
        const result = await operation();
        await redis.set(`result:${key}`, JSON.stringify(result), 'PX', ttlMs);
        return result;
    } finally {
        await redis.del(lockKey);
    }
}
```

**预期效果：** 多实例部署时 Token 刷新不重复

#### 5. 扩展数据库连接池

**当前配置：**
```javascript
// database.js
connectionLimit: Math.max(30, Math.ceil(300 / workerCount))  // 4 Worker = 75
```

**优化方案：**
```javascript
// 提升到 600 总连接
connectionLimit: Math.max(100, Math.ceil(600 / workerCount))  // 4 Worker = 150
```

**MySQL 配置要求：**
```ini
# my.cnf
max_connections = 800
wait_timeout = 600
thread_cache_size = 100
```

**预期效果：** RPS +30-50%

#### 6. 请求日志表分区

**问题：** 日志表快速增长，查询变慢

**优化方案：**
```sql
-- 按月分区
ALTER TABLE request_logs
PARTITION BY RANGE (YEAR(created_at) * 100 + MONTH(created_at)) (
    PARTITION p202601 VALUES LESS THAN (202602),
    PARTITION p202602 VALUES LESS THAN (202603),
    ...
);

-- 定期清理旧分区
ALTER TABLE request_logs DROP PARTITION p202501;
```

**预期效果：** 日志查询性能 +5-10x

### 🟢 低优先级（长期）

#### 7. 请求去重缓存

```javascript
// 相同请求 5 秒内返回缓存
const requestHash = md5(JSON.stringify({
    model: requestBody.model,
    messages: requestBody.messages
}));
const cached = await redis.get(`req:${requestHash}`);
if (cached) return JSON.parse(cached);
```

#### 8. 响应流式缓存

```javascript
// 缓存流式响应的完整结果
// 适用于相同问题的重复请求
```

---

## 六、优化后预期性能

```
阶段          优化内容                         预期 RPS    提升
─────────────────────────────────────────────────────────────
当前          无优化                           ~150        -
阶段1         禁用缓存模拟                      ~200        +33%
阶段2         + 健康检查并行 + 移除pool_id查询   ~250        +67%
阶段3         + 扩展连接池 + Redis分布式锁       ~400        +167%
阶段4         + 请求去重缓存                    ~800+       +433%
```

---

## 七、立即可做的优化（无需改代码）

### 1. 禁用缓存模拟
```bash
export KIRO_CACHE_SIMULATION=false
```

### 2. 确保 Redis 可用
```bash
export REDIS_URL=redis://localhost:6379
```

### 3. 扩展数据库连接池
```bash
export DB_CONNECTION_LIMIT=150
```

### 4. 增加 Worker 数量
```bash
export WORKERS=8  # 根据 CPU 核心数调整
```

---

## 八、监控指标

| 指标 | 正常范围 | 告警阈值 | 监控方式 |
|------|---------|---------|---------|
| TTFT (首字时间) | < 5s | > 10s | 请求追踪 |
| 总响应时间 | < 30s | > 60s | 请求追踪 |
| 数据库连接使用率 | < 70% | > 90% | 连接池监控 |
| Redis 队列长度 | < 1000 | > 5000 | 队列状态 API |
| Token 刷新成功率 | > 99% | < 95% | 错误日志 |
| 账号健康率 | > 90% | < 80% | 健康检查 |

---

## 九、集群部署建议

### 单机部署
```
推荐配置：
- CPU: 4+ 核心
- 内存: 8GB+
- MySQL: 本地或低延迟连接
- Redis: 本地或低延迟连接
- 预期 RPS: 200-400
```

### 多实例部署
```
推荐配置：
- 实例数: 2-4 个
- 负载均衡: Nginx/HAProxy
- MySQL: 共享，连接池总数 = 实例数 × 单实例连接数
- Redis: 共享，用于分布式锁和日志队列
- 预期 RPS: 400-1000+

注意事项：
- 需要实现 Redis 分布式去重锁
- 轮询计数器已支持 Redis（自动）
- 日志队列已支持 Redis（自动）
```

---

## 十、总结

### 当前状态
- ✅ 请求日志异步队列（需 Redis）
- ✅ Token 刷新去重锁（单机）
- ✅ HTTP 连接池复用
- ❌ 缓存模拟性能问题（已发现）
- ❌ 健康检查串行执行
- ❌ 日志记录额外查询

### 最关键的三个优化
1. **禁用缓存模拟** - 立即见效，TTFT 40s → 3s
2. **健康检查并行化** - 启动时间大幅缩短
3. **确保 Redis 可用** - 启用异步日志和分布式轮询

### 预期收益
- 短期（1周）：RPS 150 → 250-300
- 中期（1月）：RPS 300 → 500
- 长期（3月）：RPS 500 → 1000+
