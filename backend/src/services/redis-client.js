/**
 * Redis 客户端模块
 * 用于跨进程共享状态（如 Round-Robin 计数器）
 */

import Redis from 'ioredis';

let redisClient = null;
let isConnected = false;
let runtimeStateResetDone = false;

const RUNTIME_STATE_KEY_PATTERNS = [
    'monitor:active_connections',
    'monitor:peak_connections',
    'monitor:total_connections',
    'monitor:last_peak_time',
    'concurrency:user:*',
    'concurrency:account:*',
    'concurrency:account_user:*',
    'concurrency:account_peak:*',
    'concurrency:account_user_peak:*',
    'concurrency:account_users:*',
    'recent_users:*',
    'session:account:*',
    'queue:account:lock:*'
];


/**
 * 获取 Redis 配置
 */
function getRedisConfig() {
    return {
        host: process.env.REDIS_HOST || 'redis-core',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB, 10) || 0,
        // Prefer REDIS_KEY_PREFIX. New installs: accounthub:
        // Existing clusters can keep a legacy prefix via env without code changes.
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'accounthub:',
        retryStrategy: (times) => {
            if (times > 3) {
                console.warn('[RedisClient] Max retry attempts reached, giving up');
                return null;
            }
            return Math.min(times * 200, 2000);
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true
    };
}

/**
 * 初始化 Redis 客户端
 */
export async function initRedis() {
    if (redisClient && isConnected) {
        return redisClient;
    }

    const config = getRedisConfig();

    // 如果没有配置 Redis，返回 null（降级到内存模式）
    if (!process.env.REDIS_HOST && !process.env.REDIS_PASSWORD) {
        console.log('[RedisClient] Redis not configured, using memory fallback');
        return null;
    }

    try {
        redisClient = new Redis(config);

        redisClient.on('connect', () => {
            console.log('[RedisClient] Connected to Redis');
            isConnected = true;
        });

        redisClient.on('error', (err) => {
            console.error('[RedisClient] Redis error:', err.message);
            isConnected = false;
        });

        redisClient.on('close', () => {
            console.log('[RedisClient] Redis connection closed');
            isConnected = false;
        });

        await redisClient.connect();
        return redisClient;
    } catch (error) {
        console.error('[RedisClient] Failed to connect to Redis:', error.message);
        redisClient = null;
        isConnected = false;
        return null;
    }
}

/**
 * 获取 Redis 客户端实例
 */
export function getRedisClient() {
    return isConnected ? redisClient : null;
}

/**
 * 检查 Redis 是否可用
 */
export function isRedisAvailable() {
    return isConnected && redisClient !== null;
}

/**
 * 原子递增并返回索引（用于 Round-Robin）
 * @param {string} key - 计数器键名
 * @param {number} modulo - 取模值（候选数量）
 * @returns {Promise<number>} 当前索引
 */
export async function incrAndMod(key, modulo) {
    if (!isConnected || !redisClient) {
        return null;
    }

    try {
        // INCR 返回递增后的值，减1得到当前索引，再取模
        const value = await redisClient.incr(key);
        return (value - 1) % modulo;
    } catch (error) {
        console.error('[RedisClient] incrAndMod failed:', error.message);
        return null;
    }
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis() {
    if (redisClient) {
        try {
            await redisClient.quit();
        } catch (error) {
            console.warn('[RedisClient] Error closing Redis:', error.message);
        }
        redisClient = null;
        isConnected = false;
    }
}

export async function resetRuntimeStateKeys(force = false) {
    if ((!force && runtimeStateResetDone) || !isConnected || !redisClient) {
        return 0;
    }

    let deleted = 0;
    try {
        for (const pattern of RUNTIME_STATE_KEY_PATTERNS) {
            let cursor = '0';
            do {
                const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                cursor = nextCursor;
                if (Array.isArray(keys) && keys.length > 0) {
                    deleted += keys.length;
                    await redisClient.del(...keys);
                }
            } while (cursor !== '0');
        }
        runtimeStateResetDone = true;
        console.log(`[RedisClient] Cleared ${deleted} runtime state keys`);
        return deleted;
    } catch (error) {
        console.error('[RedisClient] Failed to clear runtime state keys:', error.message);
        return deleted;
    }
}

/**
 * 获取 Redis INFO 信息
 * @param {string} section - 可选的 section (server, clients, memory, stats, etc.)
 * @returns {Promise<Object>} 解析后的 INFO 对象
 */
export async function getRedisInfo(section = null) {
    if (!isConnected || !redisClient) {
        return null;
    }

    try {
        const infoStr = section ? await redisClient.info(section) : await redisClient.info();
        const info = {};

        // 解析 INFO 输出
        const lines = infoStr.split('\r\n');
        let currentSection = '';

        for (const line of lines) {
            if (line.startsWith('#')) {
                currentSection = line.substring(2).trim().toLowerCase();
                info[currentSection] = {};
            } else if (line.includes(':')) {
                const [key, value] = line.split(':');
                if (currentSection) {
                    info[currentSection][key] = value;
                } else {
                    info[key] = value;
                }
            }
        }

        return info;
    } catch (error) {
        console.error('[RedisClient] getRedisInfo failed:', error.message);
        return null;
    }
}

/**
 * 获取 Redis 状态摘要（用于监控）
 * @returns {Promise<Object>} Redis 状态
 */
export async function getRedisStatus() {
    if (!isConnected || !redisClient) {
        return {
            connected: false,
            error: 'Redis not connected'
        };
    }

    try {
        const info = await getRedisInfo();
        if (!info) {
            return { connected: false, error: 'Failed to get Redis info' };
        }

        // 计算命中率
        const hits = parseInt(info.stats?.keyspace_hits) || 0;
        const misses = parseInt(info.stats?.keyspace_misses) || 0;
        const hitRate = hits + misses > 0 ? (hits / (hits + misses) * 100) : 0;

        return {
            connected: true,
            // 服务器信息
            version: info.server?.redis_version || 'unknown',
            uptime: parseInt(info.server?.uptime_in_seconds) || 0,
            // 客户端连接
            clients: {
                connected: parseInt(info.clients?.connected_clients) || 0,
                blocked: parseInt(info.clients?.blocked_clients) || 0,
            },
            // 内存使用
            memory: {
                used: parseInt(info.memory?.used_memory) || 0,
                usedHuman: info.memory?.used_memory_human || '0B',
                peak: parseInt(info.memory?.used_memory_peak) || 0,
                peakHuman: info.memory?.used_memory_peak_human || '0B',
                fragmentation: parseFloat(info.memory?.mem_fragmentation_ratio) || 0,
            },
            // 统计信息
            stats: {
                totalConnections: parseInt(info.stats?.total_connections_received) || 0,
                totalCommands: parseInt(info.stats?.total_commands_processed) || 0,
                opsPerSec: parseInt(info.stats?.instantaneous_ops_per_sec) || 0,
                hitRate: hitRate.toFixed(2),
                keyspaceHits: hits,
                keyspaceMisses: misses,
                expiredKeys: parseInt(info.stats?.expired_keys) || 0,
                evictedKeys: parseInt(info.stats?.evicted_keys) || 0,
            },
            // 键空间
            keyspace: info.keyspace || {},
        };
    } catch (error) {
        console.error('[RedisClient] getRedisStatus failed:', error.message);
        return { connected: false, error: error.message };
    }
}

export default {
    initRedis,
    getRedisClient,
    isRedisAvailable,
    incrAndMod,
    closeRedis,
    getRedisInfo,
    getRedisStatus,
    resetRuntimeStateKeys
};
