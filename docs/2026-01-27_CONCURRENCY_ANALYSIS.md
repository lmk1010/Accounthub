# 并发性能分析报告

**日期**: 2026-01-27
**目标**: 支持 1000+ 用户并发请求
**项目**: AccountHub

---

## 1. 项目架构概览

- **架构类型**: 多进程集群模式 + HTTP 服务器 + MySQL + Redis
- **主进程**: `/backend/src/core/master.js` - 管理多个 Worker 进程
- **Worker 进程**: `/backend/src/services/api-server.js` - 处理 HTTP 请求
- **数据库**: MySQL（连接池）+ Redis（跨进程共享状态）
- **框架**: 原生 Node.js HTTP 模块（无 Express/Koa）

---

## 2. 关键问题清单

### P0 - 严重问题（必须立即修复）

| 问题 | 位置 | 当前值 | 建议值 |
|------|------|--------|--------|
| **数据库连接池过小** | `backend/src/config/database.js:28` | 20-50 | 200-300 |
| **请求体无大小限制** | `backend/src/handlers/request-handler.js:39-51` | 无限制 | 10MB |
| **内存缓存无限增长** | `backend/src/services/kiro-cache-simulator.js:38` | 无限制 Map | LRU 缓存 |
| **最大连接数硬编码** | `backend/src/core/master.js:366` | 1000 | 10000+ |

### P1 - 高优先级

| 问题 | 位置 | 说明 |
|------|------|------|
| **请求超时被禁用** | `backend/src/core/master.js:354` | `requestTimeout: 0` 会导致僵尸连接 |
| **缺少速率限制** | 全局 | 无防 DDoS 机制 |
| **Worker 进程数不足** | `backend/src/core/master.js:32` | 默认等于 CPU 核心数，I/O 密集型应用应为 2-4 倍 |

### P2 - 中优先级

| 问题 | 位置 | 说明 |
|------|------|------|
| **响应时间数组低效** | `backend/src/monitoring/metrics-collector.js:63-66` | `shift()` 操作 O(n) 复杂度 |
| **Redis 配置不优化** | `backend/src/services/redis-client.js:14-31` | 缺少连接池、离线队列未禁用 |
| **并发统计竞态条件** | `backend/src/handlers/request-handler.js:112-129` | 多 Worker 共享变量不准确 |
| **缺少内存监控** | 全局 | 无内存泄漏检测 |

---

## 3. 详细问题分析

### 3.1 数据库连接池配置不足

**文件**: `backend/src/config/database.js:28`

```javascript
connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || config.DATABASE?.CONNECTION_LIMIT || '50'),
```

**问题**:
- 默认连接池大小仅 50，对于 1000+ 并发严重不足
- 生产环境配置（`.env.production`）设置为 20，更加不足
- 无连接超时重试机制
- `queueLimit: 0` 可能导致内存无限增长

**计算**:
- 1000 并发用户 ÷ 多个 Worker 进程 = 每个 Worker 需要 100+ 连接
- 建议：`connectionLimit = 200-300`（取决于 Worker 数量）

**建议修复**:
```javascript
connectionLimit: Math.max(
    parseInt(process.env.DB_CONNECTION_LIMIT || '300'),
    Math.ceil(1000 / (process.env.WORKERS || os.cpus().length))
),
queueLimit: 1000,  // 限制队列大小
acquireTimeout: 30000,  // 获取连接超时
```

### 3.2 服务器最大连接数限制

**文件**: `backend/src/core/master.js:366`

```javascript
serverInstance.maxConnections = 1000;
```

**问题**:
- 硬编码最大连接数为 1000，对于 1000+ 并发用户不足
- 应该根据系统资源动态配置
- 没有考虑 ulimit 系统限制

**建议修复**:
```javascript
const maxConnections = Math.min(
    parseInt(process.env.MAX_CONNECTIONS) || 10000,
    os.cpus().length * 1000
);
serverInstance.maxConnections = maxConnections;
```

### 3.3 内存缓存无限增长风险

**文件**: `backend/src/services/kiro-cache-simulator.js:38`

```javascript
const memoryCache = new Map();
```

**问题**:
- 内存缓存使用 Map，无大小限制
- 当 Redis 不可用时，所有缓存数据存储在内存中
- 可能导致内存泄漏和 OOM

**建议修复**:
```javascript
class LRUCache {
    constructor(maxSize = 10000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    set(key, value) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    get(key) {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // 移到末尾（最近使用）
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }
}
```

### 3.4 请求体解析无大小限制

**文件**: `backend/src/handlers/request-handler.js:39-51`

```javascript
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON in request body'));
            }
        });
        req.on('error', reject);
    });
}
```

**问题**:
- 无请求体大小限制，可能导致内存溢出
- 字符串拼接低效（应使用 Buffer）
- 没有超时机制

**建议修复**:
```javascript
function parseRequestBody(req, maxSize = 10 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString();
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });

        req.on('error', reject);
    });
}
```

### 3.5 请求超时被禁用

**文件**: `backend/src/core/master.js:354-357`

```javascript
serverInstance = http.createServer({
    requestTimeout: 0,  // 禁用请求超时！
    headersTimeout: 60000,
    keepAliveTimeout: 65000
}, enhancedHandler);
```

**问题**:
- `requestTimeout: 0` 禁用了请求超时
- 可能导致僵尸连接占用资源
- 应该设置合理的超时时间

**建议修复**:
```javascript
serverInstance = http.createServer({
    requestTimeout: 120000,  // 120 秒
    headersTimeout: 60000,
    keepAliveTimeout: 65000,
    maxHeaderSize: 16 * 1024  // 限制头部大小
}, enhancedHandler);
```

### 3.6 响应时间数据收集低效

**文件**: `backend/src/monitoring/metrics-collector.js:63-66`

```javascript
this.responseTimes.push(duration);
if (this.responseTimes.length > 1000) {
    this.responseTimes.shift();  // 低效的数组操作
}
```

**问题**:
- 使用 `shift()` 移除数组首元素，时间复杂度 O(n)
- 每个请求都执行一次，高并发下性能差
- 应使用循环缓冲区

**建议修复**:
```javascript
class CircularBuffer {
    constructor(size = 1000) {
        this.buffer = new Array(size);
        this.size = size;
        this.index = 0;
        this.count = 0;
    }

    push(value) {
        this.buffer[this.index] = value;
        this.index = (this.index + 1) % this.size;
        if (this.count < this.size) this.count++;
    }

    getAll() {
        return this.buffer.slice(0, this.count);
    }
}
```

### 3.7 Redis 连接配置不优化

**文件**: `backend/src/services/redis-client.js:14-31`

**问题**:
- 没有连接池配置
- 重试策略过于保守（最多 3 次）
- 没有设置 `enableOfflineQueue: false`（可能导致内存溢出）

**建议修复**:
```javascript
function getRedisConfig() {
    return {
        host: process.env.REDIS_HOST || 'redis-core',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB, 10) || 0,
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'accounthub:',

        // 连接池配置
        maxRetriesPerRequest: 5,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        lazyConnect: false,

        // 重试策略
        retryStrategy: (times) => {
            if (times > 10) return null;
            return Math.min(times * 100, 3000);
        },

        // 连接超时
        connectTimeout: 10000,
        commandTimeout: 5000,

        // 保活
        keepAlive: 30000
    };
}
```

### 3.8 并发连接统计竞态条件

**文件**: `backend/src/handlers/request-handler.js:112-129`

```javascript
concurrencyStats.activeConnections++;
concurrencyStats.totalConnections++;
```

**问题**:
- 多个 Worker 进程共享全局变量，存在竞态条件
- 统计数据不准确
- 应使用 Redis 或原子操作

**建议修复**:
```javascript
// 使用 Redis 存储全局统计
export async function incrementActiveConnections() {
    const redis = getRedisClient();
    if (redis) {
        return await redis.incr('stats:active_connections');
    }
}

export async function decrementActiveConnections() {
    const redis = getRedisClient();
    if (redis) {
        return await redis.decr('stats:active_connections');
    }
}
```

---

## 4. 缺失的关键功能

### 4.1 速率限制

```javascript
class RateLimiter {
    constructor(maxRequests = 1000, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = new Map();
    }

    isAllowed(key) {
        const now = Date.now();
        const userRequests = this.requests.get(key) || [];
        const validRequests = userRequests.filter(t => now - t < this.windowMs);

        if (validRequests.length >= this.maxRequests) {
            return false;
        }

        validRequests.push(now);
        this.requests.set(key, validRequests);
        return true;
    }
}
```

### 4.2 内存监控

```javascript
setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log('[Memory] Heap used:', Math.round(memUsage.heapUsed / 1024 / 1024), 'MB');
    console.log('[Memory] Heap total:', Math.round(memUsage.heapTotal / 1024 / 1024), 'MB');
    console.log('[Memory] RSS:', Math.round(memUsage.rss / 1024 / 1024), 'MB');

    if (memUsage.heapUsed > 500 * 1024 * 1024) {
        if (global.gc) {
            console.log('[Memory] Triggering garbage collection');
            global.gc();
        }
    }
}, 30000);
```

### 4.3 数据库查询超时

```javascript
export async function queryWithTimeout(sql, params = [], timeout = 30000) {
    const connection = await getPool().getConnection();
    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Query timeout')), timeout)
        );
        const queryPromise = connection.execute(sql, params);
        return await Promise.race([queryPromise, timeoutPromise]);
    } finally {
        connection.release();
    }
}
```

---

## 5. 环境变量优化建议

**`.env.production` 优化**:

```bash
# 数据库配置
USE_DATABASE=true
DB_HOST=paddyai-mysql
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=accounthub
DB_CONNECTION_LIMIT=300  # 从 20 增加到 300

# Redis 配置
REDIS_HOST=redis-core
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
REDIS_KEY_PREFIX=accounthub:

# Worker 进程配置
WORKERS=16  # CPU 核心数 × 2
MASTER_PORT=3100

# 性能配置
MAX_CONNECTIONS=10000
REQUEST_TIMEOUT=120000
MAX_REQUEST_SIZE=10485760  # 10MB
RATE_LIMIT_REQUESTS=10000
RATE_LIMIT_WINDOW=60000
```

---

## 6. 优先级修复顺序

| 顺序 | 问题 | 影响 | 预计工作量 |
|------|------|------|-----------|
| 1 | DB 连接池过小 | 严重 | 小 |
| 2 | 请求体大小限制 | 严重 | 小 |
| 3 | 最大连接数配置 | 严重 | 小 |
| 4 | 请求超时配置 | 高 | 小 |
| 5 | 内存缓存 LRU | 严重 | 中 |
| 6 | 速率限制 | 高 | 中 |
| 7 | Redis 配置优化 | 中 | 小 |
| 8 | 响应时间收集优化 | 中 | 小 |
| 9 | 内存监控 | 中 | 中 |
| 10 | 并发统计修复 | 低 | 中 |

---

## 7. 压力测试建议

```bash
# 安装 wrk
brew install wrk

# 测试 1000 并发连接
wrk -t 12 -c 1000 -d 30s http://localhost:3000/health

# 测试 POST 请求
wrk -t 12 -c 1000 -d 30s -s post.lua http://localhost:3000/v1/chat/completions
```

**post.lua 示例**:
```lua
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body = '{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}'
```

---

## 8. 监控指标建议

需要添加以下监控指标：

1. **数据库连接池**: 使用率、等待队列长度、连接泄漏
2. **Redis**: 连接数、命中率、内存使用
3. **内存**: 堆内存、RSS、垃圾回收频率
4. **请求**: 吞吐量、延迟 P50/P95/P99、错误率、超时率
5. **Worker 进程**: CPU 使用率、内存使用、请求分布

---

*报告生成时间: 2026-01-27*
