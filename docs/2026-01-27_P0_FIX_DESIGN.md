# P0 问题修复设计方案

**日期**: 2026-01-27
**目标**: 支持 1000+ 用户并发请求
**状态**: 设计方案

---

## 修复概览

| 序号 | 问题 | 文件 | 修复方式 | 风险等级 |
|------|------|------|----------|----------|
| 1 | 数据库连接池过小 | `database.js` | 配置优化 + 监控 | 低 |
| 2 | 请求体无大小限制 | `request-handler.js` | 添加限制逻辑 | 低 |
| 3 | 最大连接数硬编码 | `master.js` | 动态配置 | 低 |
| 4 | 内存缓存无限增长 | `kiro-cache-simulator.js` | LRU 缓存 | 中 |

---

## 1. 数据库连接池优化

### 1.1 问题分析

**当前代码** (`backend/src/config/database.js:28-30`):
```javascript
connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || config.DATABASE?.CONNECTION_LIMIT || '50'),
waitForConnections: true,
queueLimit: 0, // 无限队列 - 危险！
```

**问题**:
- 默认连接数 50，生产环境配置 20，严重不足
- `queueLimit: 0` 表示无限队列，高并发时内存会无限增长
- 缺少获取连接超时配置
- 缺少连接池监控

### 1.2 修复方案

```javascript
// backend/src/config/database.js

export function getDatabaseConfig(config = {}) {
    // 根据 Worker 数量动态计算连接数
    const workerCount = parseInt(process.env.WORKERS) || os.cpus().length;
    const defaultConnectionLimit = Math.max(50, Math.ceil(300 / workerCount));

    return {
        host: process.env.DB_HOST || config.DATABASE?.HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || config.DATABASE?.PORT || '3306'),
        user: process.env.DB_USER || config.DATABASE?.USER || 'root',
        password: process.env.DB_PASSWORD || config.DATABASE?.PASSWORD || '',
        database: process.env.DB_DATABASE || config.DATABASE?.DATABASE || 'accounthub',

        // 连接池配置 - 高并发优化
        connectionLimit: parseInt(
            process.env.DB_CONNECTION_LIMIT ||
            config.DATABASE?.CONNECTION_LIMIT ||
            String(defaultConnectionLimit)
        ),
        waitForConnections: true,
        queueLimit: 1000,  // 限制等待队列，防止内存溢出

        // Keep-Alive 配置
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,  // 10秒后开始 keep-alive

        // 超时配置
        connectTimeout: 10000,         // 连接超时 10秒
        acquireTimeout: 30000,         // 获取连接超时 30秒（新增）

        // 字符集
        charset: 'utf8mb4',
        timezone: '+08:00',

        // 安全配置
        multipleStatements: false,
        namedPlaceholders: true
    };
}
```

### 1.3 添加查询超时包装

```javascript
// backend/src/config/database.js - 新增函数

/**
 * 执行带超时的查询
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @param {number} timeout - 超时时间（毫秒），默认 30 秒
 * @returns {Promise<Array>}
 */
export async function queryWithTimeout(sql, params = [], timeout = 30000) {
    const connection = await getPool().getConnection();

    // 创建超时 Promise
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(`Query timeout after ${timeout}ms`));
        }, timeout);
    });

    try {
        const queryPromise = connection.execute(sql, params);
        const [rows] = await Promise.race([queryPromise, timeoutPromise]);
        return rows;
    } finally {
        connection.release();
    }
}

/**
 * 获取连接池健康状态
 * @returns {Object}
 */
export function getPoolHealth() {
    if (!pool) return { status: 'not_initialized' };

    const poolInternal = pool.pool;
    const total = poolInternal?._allConnections?.length || 0;
    const free = poolInternal?._freeConnections?.length || 0;
    const queue = poolInternal?._connectionQueue?.length || 0;
    const acquiring = poolInternal?._acquiringConnections?.length || 0;

    const utilization = total > 0 ? ((total - free) / total) : 0;

    return {
        status: utilization > 0.9 ? 'critical' : utilization > 0.7 ? 'warning' : 'healthy',
        total,
        free,
        used: total - free,
        queue,
        acquiring,
        utilization: Math.round(utilization * 100) + '%'
    };
}
```

### 1.4 环境变量建议

```bash
# .env.production
DB_CONNECTION_LIMIT=300  # 总连接数，会被 Worker 数量分摊
```

---

## 2. 请求体大小限制

### 2.1 问题分析

**当前代码** (`backend/src/handlers/request-handler.js:39-52`):
```javascript
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });  // 无限制！
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
- 无请求体大小限制，恶意请求可导致内存溢出
- 字符串拼接效率低（应使用 Buffer）
- 无超时机制

### 2.2 修复方案

```javascript
// backend/src/handlers/request-handler.js

// 配置常量
const REQUEST_CONFIG = {
    MAX_BODY_SIZE: parseInt(process.env.MAX_REQUEST_SIZE) || 10 * 1024 * 1024,  // 10MB
    BODY_TIMEOUT: parseInt(process.env.REQUEST_BODY_TIMEOUT) || 30000  // 30秒
};

/**
 * Parse request body as JSON with size limit and timeout
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {number} maxSize - 最大请求体大小（字节）
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Object>}
 */
function parseRequestBody(req, maxSize = REQUEST_CONFIG.MAX_BODY_SIZE, timeout = REQUEST_CONFIG.BODY_TIMEOUT) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let finished = false;

        // 超时处理
        const timeoutId = setTimeout(() => {
            if (!finished) {
                finished = true;
                req.destroy();
                reject(new Error('Request body timeout'));
            }
        }, timeout);

        const cleanup = () => {
            clearTimeout(timeoutId);
        };

        req.on('data', chunk => {
            if (finished) return;

            size += chunk.length;

            // 检查大小限制
            if (size > maxSize) {
                finished = true;
                cleanup();
                req.destroy();
                reject(new Error(`Request body too large: ${size} bytes exceeds limit of ${maxSize} bytes`));
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();

            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON in request body'));
            }
        });

        req.on('error', (err) => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(err);
        });

        req.on('aborted', () => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(new Error('Request aborted'));
        });
    });
}
```

### 2.3 错误响应处理

在 `createRequestHandler` 中添加对大请求的友好错误响应：

```javascript
// 在调用 parseRequestBody 的地方添加错误处理
try {
    const body = await parseRequestBody(req);
    // ... 处理请求
} catch (error) {
    if (error.message.includes('too large')) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Request Entity Too Large',
                max_size: REQUEST_CONFIG.MAX_BODY_SIZE
            }
        }));
        return;
    }
    if (error.message.includes('timeout')) {
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request Timeout' } }));
        return;
    }
    throw error;
}
```

---

## 3. 最大连接数动态配置

### 3.1 问题分析

**当前代码** (`backend/src/core/master.js` - 需要查找 `maxConnections` 设置位置):

根据分析报告，`maxConnections` 被硬编码为 1000。

### 3.2 修复方案

需要在 `api-server.js` 中找到 HTTP 服务器创建的位置并修改：

```javascript
// backend/src/services/api-server.js 或相关文件

// 配置常量
const SERVER_CONFIG = {
    MAX_CONNECTIONS: parseInt(process.env.MAX_CONNECTIONS) || 10000,
    REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 120000,  // 120秒
    HEADERS_TIMEOUT: 60000,
    KEEP_ALIVE_TIMEOUT: 65000
};

// 创建服务器时使用
const server = http.createServer({
    requestTimeout: SERVER_CONFIG.REQUEST_TIMEOUT,  // 不要设为 0！
    headersTimeout: SERVER_CONFIG.HEADERS_TIMEOUT,
    keepAliveTimeout: SERVER_CONFIG.KEEP_ALIVE_TIMEOUT,
    maxHeaderSize: 16 * 1024  // 16KB 头部限制
}, requestHandler);

// 设置最大连接数
server.maxConnections = SERVER_CONFIG.MAX_CONNECTIONS;

// 添加连接监控
let activeConnections = 0;
server.on('connection', (socket) => {
    activeConnections++;
    socket.on('close', () => {
        activeConnections--;
    });
});

// 定期记录连接状态
setInterval(() => {
    if (activeConnections > SERVER_CONFIG.MAX_CONNECTIONS * 0.8) {
        console.warn(`[Server] High connection count: ${activeConnections}/${SERVER_CONFIG.MAX_CONNECTIONS}`);
    }
}, 30000);
```

---

## 4. 内存缓存 LRU 实现

### 4.1 问题分析

**当前代码** (`backend/src/services/kiro-cache-simulator.js:38`):
```javascript
const memoryCache = new Map();
```

**问题**:
- 使用普通 Map，无大小限制
- 虽然有定期清理过期条目，但在高并发下可能来不及清理
- 没有 LRU 淘汰机制

### 4.2 修复方案 - 实现 LRU 缓存类

```javascript
// backend/src/utils/lru-cache.js (新文件)

/**
 * LRU (Least Recently Used) 缓存实现
 * 使用 Map 的有序特性实现 O(1) 的 get/set 操作
 */
export class LRUCache {
    /**
     * @param {number} maxSize - 最大缓存条目数
     * @param {number} defaultTTL - 默认过期时间（毫秒）
     */
    constructor(maxSize = 10000, defaultTTL = 300000) {
        this.maxSize = maxSize;
        this.defaultTTL = defaultTTL;
        this.cache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }

    /**
     * 获取缓存值
     * @param {string} key
     * @returns {any|undefined}
     */
    get(key) {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return undefined;
        }

        // 检查是否过期
        if (entry.expireAt && entry.expireAt < Date.now()) {
            this.cache.delete(key);
            this.stats.misses++;
            return undefined;
        }

        // 移到末尾（最近使用）
        this.cache.delete(key);
        this.cache.set(key, entry);

        this.stats.hits++;
        return entry.value;
    }

    /**
     * 设置缓存值
     * @param {string} key
     * @param {any} value
     * @param {number} ttl - 过期时间（毫秒），可选
     */
    set(key, value, ttl = this.defaultTTL) {
        // 如果 key 已存在，先删除（确保移到末尾）
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 检查容量，淘汰最旧的条目
        while (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
            this.stats.evictions++;
        }

        this.cache.set(key, {
            value,
            expireAt: ttl > 0 ? Date.now() + ttl : null,
            createdAt: Date.now()
        });
    }

    /**
     * 删除缓存条目
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
        return this.cache.delete(key);
    }

    /**
     * 检查 key 是否存在（不更新访问顺序）
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        const entry = this.cache.get(key);
        if (!entry) return false;
        if (entry.expireAt && entry.expireAt < Date.now()) {
            this.cache.delete(key);
            return false;
        }
        return true;
    }

    /**
     * 清空缓存
     */
    clear() {
        this.cache.clear();
    }

    /**
     * 获取当前缓存大小
     * @returns {number}
     */
    get size() {
        return this.cache.size;
    }

    /**
     * 清理过期条目
     * @returns {number} 清理的条目数
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.expireAt && entry.expireAt < now) {
                this.cache.delete(key);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * 获取缓存统计信息
     * @returns {Object}
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions,
            hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
        };
    }

    /**
     * 重置统计信息
     */
    resetStats() {
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }
}

export default LRUCache;
```

### 4.3 修改 kiro-cache-simulator.js

```javascript
// backend/src/services/kiro-cache-simulator.js

import { LRUCache } from '../utils/lru-cache.js';

// 配置常量
const CACHE_CONFIG = {
    TTL: 300,  // 5分钟
    KEY_PREFIX: 'kiro:session:',
    ENABLED: process.env.KIRO_CACHE_SIMULATION !== 'false',
    MIN_CACHEABLE_TOKENS: 1024,
    MAX_TURNS: 50,
    // 新增：内存缓存最大条目数
    MAX_MEMORY_ENTRIES: parseInt(process.env.KIRO_CACHE_MAX_ENTRIES) || 10000
};

// 使用 LRU 缓存替代普通 Map
const memoryCache = new LRUCache(
    CACHE_CONFIG.MAX_MEMORY_ENTRIES,
    CACHE_CONFIG.TTL * 1000  // 转换为毫秒
);

// 修改 getSessionCache 函数
async function getSessionCache(sessionId) {
    const key = `${CACHE_CONFIG.KEY_PREFIX}${sessionId}`;

    if (isRedisAvailable()) {
        try {
            const client = getRedisClient();
            const data = await client.get(key);
            if (data) {
                return JSON.parse(data);
            }
        } catch (error) {
            console.warn('[KiroCacheSimulator] Redis get error:', error.message);
        }
    }

    // 内存回退 - 使用 LRU 缓存
    return memoryCache.get(key);
}

// 修改 setSessionCache 函数
async function setSessionCache(sessionId, data) {
    const key = `${CACHE_CONFIG.KEY_PREFIX}${sessionId}`;

    if (isRedisAvailable()) {
        try {
            const client = getRedisClient();
            await client.setex(key, CACHE_CONFIG.TTL, JSON.stringify(data));
            return;
        } catch (error) {
            console.warn('[KiroCacheSimulator] Redis set error:', error.message);
        }
    }

    // 内存回退 - 使用 LRU 缓存
    memoryCache.set(key, data, CACHE_CONFIG.TTL * 1000);
}

// 修改 cleanupMemoryCache 函数
function cleanupMemoryCache() {
    const cleaned = memoryCache.cleanup();
    if (cleaned > 0) {
        console.log(`[KiroCacheSimulator] Cleaned ${cleaned} expired entries`);
    }
}

// 修改 getCacheStats 函数
export async function getCacheStats() {
    const stats = {
        enabled: CACHE_CONFIG.ENABLED,
        ttl: CACHE_CONFIG.TTL,
        minTokens: CACHE_CONFIG.MIN_CACHEABLE_TOKENS,
        storage: 'memory',
        entries: 0,
        memoryStats: null
    };

    if (isRedisAvailable()) {
        stats.storage = 'redis';
        try {
            const client = getRedisClient();
            const keys = await client.keys(CACHE_CONFIG.KEY_PREFIX + '*');
            stats.entries = keys.length;
        } catch (error) {
            console.warn('[KiroCacheSimulator] Error getting Redis stats:', error.message);
        }
    } else {
        stats.entries = memoryCache.size;
        stats.memoryStats = memoryCache.getStats();
    }

    return stats;
}

// 修改 clearCache 函数
export async function clearCache() {
    if (isRedisAvailable()) {
        try {
            const client = getRedisClient();
            const keys = await client.keys(CACHE_CONFIG.KEY_PREFIX + '*');
            if (keys.length > 0) {
                await client.del(...keys);
            }
            console.log(`[KiroCacheSimulator] Cleared ${keys.length} Redis cache entries`);
        } catch (error) {
            console.warn('[KiroCacheSimulator] Error clearing Redis cache:', error.message);
        }
    }

    const memoryCount = memoryCache.size;
    memoryCache.clear();
    console.log(`[KiroCacheSimulator] Cleared ${memoryCount} memory cache entries`);
}
```

---

## 5. 环境变量汇总

```bash
# .env.production - 高并发优化配置

# ============ 数据库配置 ============
DB_HOST=paddyai-mysql
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=accounthub
DB_CONNECTION_LIMIT=300          # 总连接数（会被 Worker 分摊）

# ============ 服务器配置 ============
WORKERS=16                       # Worker 进程数（建议 CPU 核心数 × 2）
MASTER_PORT=3100
MAX_CONNECTIONS=10000            # HTTP 最大连接数
REQUEST_TIMEOUT=120000           # 请求超时（毫秒）

# ============ 请求限制 ============
MAX_REQUEST_SIZE=10485760        # 最大请求体 10MB
REQUEST_BODY_TIMEOUT=30000       # 请求体读取超时 30秒

# ============ 缓存配置 ============
KIRO_CACHE_SIMULATION=true
KIRO_CACHE_MAX_ENTRIES=10000     # 内存缓存最大条目数

# ============ Redis 配置 ============
REDIS_HOST=redis-core
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
REDIS_KEY_PREFIX=accounthub:
```

---

## 6. 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `backend/src/config/database.js` | 修改 | 优化连接池配置，添加监控函数 |
| `backend/src/handlers/request-handler.js` | 修改 | 添加请求体大小限制和超时 |
| `backend/src/services/api-server.js` | 修改 | 动态配置最大连接数和超时 |
| `backend/src/utils/lru-cache.js` | 新增 | LRU 缓存实现 |
| `backend/src/services/kiro-cache-simulator.js` | 修改 | 使用 LRU 缓存 |
| `.env.production` | 修改 | 添加新的环境变量 |

---

## 7. 测试验证

### 7.1 单元测试

```javascript
// tests/lru-cache.test.js
import { LRUCache } from '../src/utils/lru-cache.js';

describe('LRUCache', () => {
    test('should evict oldest entry when full', () => {
        const cache = new LRUCache(3);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('d', 4);  // 应该淘汰 'a'

        expect(cache.has('a')).toBe(false);
        expect(cache.has('d')).toBe(true);
    });

    test('should update access order on get', () => {
        const cache = new LRUCache(3);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.get('a');     // 'a' 变成最新
        cache.set('d', 4);  // 应该淘汰 'b'

        expect(cache.has('a')).toBe(true);
        expect(cache.has('b')).toBe(false);
    });

    test('should expire entries', async () => {
        const cache = new LRUCache(10, 100);  // 100ms TTL
        cache.set('a', 1);

        await new Promise(r => setTimeout(r, 150));

        expect(cache.get('a')).toBeUndefined();
    });
});
```

### 7.2 压力测试

```bash
# 安装 wrk
brew install wrk

# 测试健康检查端点（基准）
wrk -t 12 -c 1000 -d 30s http://localhost:3000/health

# 测试 POST 请求
wrk -t 12 -c 1000 -d 30s -s post.lua http://localhost:3000/v1/chat/completions
```

### 7.3 监控指标

修复后应监控以下指标：

1. **数据库连接池**: `getPoolHealth()` 返回的利用率
2. **内存缓存**: `memoryCache.getStats()` 返回的命中率和淘汰数
3. **请求错误率**: 413 (Too Large) 和 408 (Timeout) 错误数量
4. **活跃连接数**: 服务器当前连接数

---

## 8. 回滚方案

如果修复后出现问题，可以通过环境变量快速回滚：

```bash
# 回滚数据库连接池
DB_CONNECTION_LIMIT=50

# 回滚请求体限制（设置很大的值）
MAX_REQUEST_SIZE=1073741824  # 1GB

# 回滚最大连接数
MAX_CONNECTIONS=1000

# 回滚缓存限制
KIRO_CACHE_MAX_ENTRIES=999999999
```

---

*设计方案完成时间: 2026-01-27*
