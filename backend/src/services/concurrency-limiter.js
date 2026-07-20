/**
 * 并发限制器服务
 * 1. 用户级并发限制：同一用户（tokenId/IP）最多N个并发
 * 2. 账号级并发限制：每个账号最多N个并发，超过不分配
 */

import { getRedisClient, isRedisAvailable } from './redis-client.js';

// Redis 键前缀
const REDIS_KEYS = {
    USER_CONCURRENCY: 'concurrency:user:',      // 用户并发计数
    ACCOUNT_CONCURRENCY: 'concurrency:account:', // 账号并发计数
    ACCOUNT_USER_CONCURRENCY: 'concurrency:account_user:', // 账号内用户并发计数
    ACCOUNT_PEAK_CONCURRENCY: 'concurrency:account_peak:', // 账号峰值并发
    ACCOUNT_USER_PEAK_CONCURRENCY: 'concurrency:account_user_peak:', // 账号内用户峰值并发 (Hash: userKey -> peak)
    ACCOUNT_USERS: 'concurrency:account_users:', // 账号当前用户列表 (Hash: requestId -> userInfo JSON)
    ACCOUNT_RECENT_USERS: 'recent_users:',       // 账号近期用户 (Sorted Set: score=timestamp, member=userKey:userInfo)
    ACCOUNT_SESSIONS: 'session:account:',        // 账号活跃 Session (Hash: sessionId -> lastSeen timestamp)
    ACCOUNT_QUEUE_LOCK: 'queue:account:lock:'    // 账号请求队列锁 (String: lockToken)
};

// 并发计数过期时间（秒）- 防止异常情况下计数不释放
const CONCURRENCY_TTL = 300; // 5分钟

// 近期用户记录保留时间（秒）
const RECENT_USERS_TTL = 300; // 5分钟窗口

// Session 活跃过期时间（秒）- 10分钟无活动视为 session 过期
const SESSION_TTL = 600;
const DEFAULT_QUEUE_LOCK_TTL_MS = 120000;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 150;

/**
 * 并发限制器类
 */
class ConcurrencyLimiter {
    constructor() {
        // 内存缓存（Redis 不可用时的降级方案）
        this.userConcurrency = new Map();    // key: tokenId/IP, value: count
        this.accountConcurrency = new Map(); // key: accountUuid, value: count
        this.accountUserConcurrency = new Map(); // key: accountUuid, value: Map<userKey, count>
        this.accountPeakConcurrency = new Map(); // key: accountUuid, value: { peak, updatedAt }
        this.accountUserPeakConcurrency = new Map(); // key: accountUuid, value: Map<userKey, { peak, updatedAt }>

        // 请求追踪（用于释放时找到对应的计数器）
        this.requestTracking = new Map();    // key: requestId, value: { userKey, accountUuid, startTime }

        // 内存模式：近期用户记录 Map<accountUuid, Map<userKey, {userData, timestamp}>>
        this.recentUsersMemory = new Map();

        // 内存模式：Session 追踪 Map<accountUuid, Map<sessionId, lastSeen>>
        this.accountSessions = new Map();
        // 内存模式：账号队列锁 Map<accountUuid, { token, expiresAt }>
        this.accountQueueLocks = new Map();

        // 定时兜底清理：防止错误路径未调 releaseSlots 导致泄漏
        this._cleanupTimer = setInterval(() => this._cleanupStale(), 60000);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    /**
     * 兜底清理：移除超过 30 分钟的 requestTracking 条目（说明 releaseSlots 未被调用）
     * 正常流式请求（含 Opus thinking、agentic 多轮）一般不超过 15 分钟
     * 30 分钟阈值足够安全，不会误杀活跃请求
     * 同时清理空的 recentUsersMemory 子 Map
     */
    _cleanupStale() {
        const now = Date.now();
        const staleThreshold = now - 30 * 60 * 1000; // 30 分钟
        let cleaned = 0;

        for (const [requestId, tracking] of this.requestTracking) {
            if (tracking.startTime && tracking.startTime < staleThreshold) {
                // 释放计数但不触发 Redis 操作（已过期）
                const { userKey, accountUuid } = tracking;
                if (userKey) {
                    const c = this.userConcurrency.get(userKey) || 0;
                    if (c <= 1) this.userConcurrency.delete(userKey);
                    else this.userConcurrency.set(userKey, c - 1);
                }
                if (accountUuid) {
                    const c = this.accountConcurrency.get(accountUuid) || 0;
                    if (c <= 1) this.accountConcurrency.delete(accountUuid);
                    else this.accountConcurrency.set(accountUuid, c - 1);

                    if (userKey) {
                        const byAccount = this.accountUserConcurrency.get(accountUuid);
                        if (byAccount) {
                            const cu = byAccount.get(userKey) || 0;
                            if (cu <= 1) byAccount.delete(userKey);
                            else byAccount.set(userKey, cu - 1);
                            if (byAccount.size === 0) this.accountUserConcurrency.delete(accountUuid);
                        }
                    }
                }
                this.requestTracking.delete(requestId);
                cleaned++;
            }
        }

        // 清理空的 recentUsersMemory 子 Map
        for (const [accountUuid, usersMap] of this.recentUsersMemory) {
            if (usersMap.size === 0) {
                this.recentUsersMemory.delete(accountUuid);
            }
        }

        // 清理过期的 session 记录
        const sessionExpireThreshold = now - SESSION_TTL * 1000;
        for (const [accountUuid, sessions] of this.accountSessions) {
            for (const [sessionId, lastSeen] of sessions) {
                if (lastSeen < sessionExpireThreshold) {
                    sessions.delete(sessionId);
                }
            }
            if (sessions.size === 0) {
                this.accountSessions.delete(accountUuid);
            }
        }

        const peakExpireThreshold = now - RECENT_USERS_TTL * 1000;
        for (const [accountUuid, peakInfo] of this.accountPeakConcurrency) {
            if (!peakInfo || (peakInfo.updatedAt || 0) < peakExpireThreshold) {
                this.accountPeakConcurrency.delete(accountUuid);
            }
        }
        for (const [accountUuid, userMap] of this.accountUserPeakConcurrency) {
            if (!userMap || userMap.size === 0) {
                this.accountUserPeakConcurrency.delete(accountUuid);
                continue;
            }
            for (const [userKey, peakInfo] of userMap) {
                if (!peakInfo || (peakInfo.updatedAt || 0) < peakExpireThreshold) {
                    userMap.delete(userKey);
                }
            }
            if (userMap.size === 0) {
                this.accountUserPeakConcurrency.delete(accountUuid);
            }
        }

        if (cleaned > 0) {
            console.log(`[ConcurrencyLimiter] Cleaned ${cleaned} stale tracked requests, tracking=${this.requestTracking.size}`);
        }
    }

    /**
     * 获取 Redis 客户端
     */
    _getRedis() {
        return isRedisAvailable() ? getRedisClient() : null;
    }

    /**
     * 生成用户标识键（优先使用 tokenId，其次使用 IP）
     */
    getUserKey(tokenId, clientIp) {
        if (tokenId && tokenId !== 'unknown') {
            return `token:${tokenId}`;
        }
        if (clientIp) {
            return `ip:${clientIp}`;
        }
        return null;
    }

    /**
     * 获取用户当前并发数
     */
    async getUserConcurrency(userKey) {
        if (!userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const count = await redis.get(`${REDIS_KEYS.USER_CONCURRENCY}${userKey}`);
                return parseInt(count) || 0;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get user concurrency error:', err.message);
            }
        }

        // 降级到内存
        return this.userConcurrency.get(userKey) || 0;
    }

    /**
     * 获取账号当前并发数
     */
    async getAccountConcurrency(accountUuid) {
        if (!accountUuid) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const count = await redis.get(`${REDIS_KEYS.ACCOUNT_CONCURRENCY}${accountUuid}`);
                return parseInt(count) || 0;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get account concurrency error:', err.message);
            }
        }

        // 降级到内存
        return this.accountConcurrency.get(accountUuid) || 0;
    }

    async getAccountPeakConcurrency(accountUuid) {
        if (!accountUuid) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const peak = await redis.get(`${REDIS_KEYS.ACCOUNT_PEAK_CONCURRENCY}${accountUuid}`);
                return parseInt(peak) || 0;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get account peak concurrency error:', err.message);
            }
        }

        const info = this.accountPeakConcurrency.get(accountUuid);
        return Number(info?.peak) || 0;
    }

    async getAccountUserConcurrency(accountUuid, userKey) {
        if (!accountUuid || !userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USER_CONCURRENCY}${accountUuid}:${userKey}`;
                const count = await redis.get(key);
                return parseInt(count) || 0;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get account user concurrency error:', err.message);
            }
        }

        const byAccount = this.accountUserConcurrency.get(accountUuid);
        return byAccount?.get(userKey) || 0;
    }

    async getAccountUserPeakConcurrencyMap(accountUuid) {
        if (!accountUuid) return {};

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USER_PEAK_CONCURRENCY}${accountUuid}`;
                const rows = await redis.hgetall(key);
                const result = {};
                for (const [userKey, value] of Object.entries(rows || {})) {
                    result[userKey] = parseInt(value) || 0;
                }
                return result;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get account user peak map error:', err.message);
            }
        }

        const byAccount = this.accountUserPeakConcurrency.get(accountUuid);
        if (!byAccount) return {};

        const result = {};
        for (const [userKey, info] of byAccount.entries()) {
            result[userKey] = Number(info?.peak) || 0;
        }
        return result;
    }

    async incrementAccountUserConcurrency(accountUuid, userKey) {
        if (!accountUuid || !userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USER_CONCURRENCY}${accountUuid}:${userKey}`;
                const count = await redis.incr(key);
                await redis.expire(key, CONCURRENCY_TTL);
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis incr account user concurrency error:', err.message);
            }
        }

        let byAccount = this.accountUserConcurrency.get(accountUuid);
        if (!byAccount) {
            byAccount = new Map();
            this.accountUserConcurrency.set(accountUuid, byAccount);
        }
        const current = byAccount.get(userKey) || 0;
        const next = current + 1;
        byAccount.set(userKey, next);
        return next;
    }

    async decrementAccountUserConcurrency(accountUuid, userKey) {
        if (!accountUuid || !userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USER_CONCURRENCY}${accountUuid}:${userKey}`;
                const count = await redis.decr(key);
                if (count <= 0) {
                    await redis.del(key);
                    return 0;
                }
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis decr account user concurrency error:', err.message);
            }
        }

        const byAccount = this.accountUserConcurrency.get(accountUuid);
        if (!byAccount) return 0;
        const current = byAccount.get(userKey) || 0;
        const next = Math.max(0, current - 1);
        if (next === 0) {
            byAccount.delete(userKey);
            if (byAccount.size === 0) {
                this.accountUserConcurrency.delete(accountUuid);
            }
        } else {
            byAccount.set(userKey, next);
        }
        return next;
    }

    async _recordAccountPeakConcurrency(accountUuid, currentConcurrency) {
        if (!accountUuid || !Number.isFinite(Number(currentConcurrency))) return;
        const current = Math.max(0, Number(currentConcurrency) || 0);

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_PEAK_CONCURRENCY}${accountUuid}`;
                const prev = parseInt(await redis.get(key)) || 0;
                if (current > prev) {
                    await redis.set(key, String(current), 'EX', RECENT_USERS_TTL);
                } else {
                    await redis.expire(key, RECENT_USERS_TTL);
                }
                return;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis record account peak concurrency error:', err.message);
            }
        }

        const prevInfo = this.accountPeakConcurrency.get(accountUuid);
        const prevPeak = Number(prevInfo?.peak) || 0;
        this.accountPeakConcurrency.set(accountUuid, {
            peak: Math.max(prevPeak, current),
            updatedAt: Date.now()
        });
    }

    async _recordAccountUserPeakConcurrency(accountUuid, userKey, currentConcurrency) {
        if (!accountUuid || !userKey || !Number.isFinite(Number(currentConcurrency))) return;
        const current = Math.max(0, Number(currentConcurrency) || 0);

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USER_PEAK_CONCURRENCY}${accountUuid}`;
                const prev = parseInt(await redis.hget(key, userKey)) || 0;
                if (current > prev) {
                    await redis.hset(key, userKey, String(current));
                }
                await redis.expire(key, RECENT_USERS_TTL);
                return;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis record account user peak concurrency error:', err.message);
            }
        }

        let byAccount = this.accountUserPeakConcurrency.get(accountUuid);
        if (!byAccount) {
            byAccount = new Map();
            this.accountUserPeakConcurrency.set(accountUuid, byAccount);
        }
        const prevInfo = byAccount.get(userKey);
        const prevPeak = Number(prevInfo?.peak) || 0;
        byAccount.set(userKey, {
            peak: Math.max(prevPeak, current),
            updatedAt: Date.now()
        });
    }

    /**
     * 增加用户并发计数
     */
    async incrementUserConcurrency(userKey) {
        if (!userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.USER_CONCURRENCY}${userKey}`;
                const count = await redis.incr(key);
                await redis.expire(key, CONCURRENCY_TTL);
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis incr user concurrency error:', err.message);
            }
        }

        // 降级到内存
        const current = this.userConcurrency.get(userKey) || 0;
        const newCount = current + 1;
        this.userConcurrency.set(userKey, newCount);
        return newCount;
    }

    /**
     * 减少用户并发计数
     */
    async decrementUserConcurrency(userKey) {
        if (!userKey) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.USER_CONCURRENCY}${userKey}`;
                const count = await redis.decr(key);
                if (count <= 0) {
                    await redis.del(key);
                    return 0;
                }
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis decr user concurrency error:', err.message);
            }
        }

        // 降级到内存
        const current = this.userConcurrency.get(userKey) || 0;
        const newCount = Math.max(0, current - 1);
        if (newCount === 0) {
            this.userConcurrency.delete(userKey);
        } else {
            this.userConcurrency.set(userKey, newCount);
        }
        return newCount;
    }

    /**
     * 增加账号并发计数
     */
    async incrementAccountConcurrency(accountUuid) {
        if (!accountUuid) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_CONCURRENCY}${accountUuid}`;
                const count = await redis.incr(key);
                await redis.expire(key, CONCURRENCY_TTL);
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis incr account concurrency error:', err.message);
            }
        }

        // 降级到内存
        const current = this.accountConcurrency.get(accountUuid) || 0;
        const newCount = current + 1;
        this.accountConcurrency.set(accountUuid, newCount);
        return newCount;
    }

    /**
     * 减少账号并发计数
     */
    async decrementAccountConcurrency(accountUuid) {
        if (!accountUuid) return 0;

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_CONCURRENCY}${accountUuid}`;
                const count = await redis.decr(key);
                if (count <= 0) {
                    await redis.del(key);
                    return 0;
                }
                return count;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis decr account concurrency error:', err.message);
            }
        }

        // 降级到内存
        const current = this.accountConcurrency.get(accountUuid) || 0;
        const newCount = Math.max(0, current - 1);
        if (newCount === 0) {
            this.accountConcurrency.delete(accountUuid);
        } else {
            this.accountConcurrency.set(accountUuid, newCount);
        }
        return newCount;
    }

    /**
     * 检查并获取用户并发槽位
     * @returns {boolean} true=获取成功，false=超过限制
     */
    async acquireUserSlot(userKey, maxConcurrency) {
        if (!userKey || maxConcurrency <= 0) return true; // 未配置限制

        const current = await this.getUserConcurrency(userKey);
        if (current >= maxConcurrency) {
            return false;
        }

        await this.incrementUserConcurrency(userKey);
        return true;
    }

    /**
     * 检查账号是否可用（并发数未超限）
     */
    async isAccountAvailable(accountUuid, maxConcurrency) {
        if (!accountUuid || maxConcurrency <= 0) return true; // 未配置限制

        const current = await this.getAccountConcurrency(accountUuid);
        return current < maxConcurrency;
    }

    /**
     * 获取账号并发槽位
     */
    async acquireAccountSlot(accountUuid) {
        if (!accountUuid) return;
        await this.incrementAccountConcurrency(accountUuid);
    }

    _normalizeQueueOptions(options = {}) {
        const ttlMsRaw = Number(options.lockTtlMs ?? options.ttlMs ?? DEFAULT_QUEUE_LOCK_TTL_MS);
        const waitTimeoutMsRaw = Number(options.waitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS);
        const pollIntervalMsRaw = Number(options.pollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS);

        return {
            lockTtlMs: Number.isFinite(ttlMsRaw) ? Math.max(1000, ttlMsRaw) : DEFAULT_QUEUE_LOCK_TTL_MS,
            waitTimeoutMs: Number.isFinite(waitTimeoutMsRaw) ? Math.max(0, waitTimeoutMsRaw) : DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
            pollIntervalMs: Number.isFinite(pollIntervalMsRaw) ? Math.max(20, pollIntervalMsRaw) : DEFAULT_QUEUE_POLL_INTERVAL_MS
        };
    }

    async _tryAcquireAccountQueueLock(accountUuid, lockToken, lockTtlMs) {
        if (!accountUuid || !lockToken) return false;
        const redis = this._getRedis();

        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_QUEUE_LOCK}${accountUuid}`;
                const result = await redis.set(key, lockToken, 'PX', lockTtlMs, 'NX');
                return result === 'OK';
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis acquire queue lock error:', err.message);
            }
        }

        const now = Date.now();
        const current = this.accountQueueLocks.get(accountUuid);
        if (current && current.expiresAt > now && current.token !== lockToken) {
            return false;
        }
        this.accountQueueLocks.set(accountUuid, { token: lockToken, expiresAt: now + lockTtlMs });
        return true;
    }

    async acquireAccountQueueLock(accountUuid, requestId, options = {}) {
        if (!accountUuid) {
            return { acquired: true, token: null, waitMs: 0, attempts: 0 };
        }

        const { lockTtlMs, waitTimeoutMs, pollIntervalMs } = this._normalizeQueueOptions(options);
        const lockToken = `${requestId || 'req'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();
        let attempts = 0;

        while (Date.now() - startedAt <= waitTimeoutMs) {
            attempts += 1;
            const acquired = await this._tryAcquireAccountQueueLock(accountUuid, lockToken, lockTtlMs);
            if (acquired) {
                return {
                    acquired: true,
                    token: lockToken,
                    waitMs: Date.now() - startedAt,
                    attempts
                };
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        return {
            acquired: false,
            token: lockToken,
            waitMs: Date.now() - startedAt,
            attempts
        };
    }

    async releaseAccountQueueLock(accountUuid, lockToken) {
        if (!accountUuid || !lockToken) return;
        const redis = this._getRedis();

        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_QUEUE_LOCK}${accountUuid}`;
                const lua = `
                    if redis.call('get', KEYS[1]) == ARGV[1] then
                        return redis.call('del', KEYS[1])
                    end
                    return 0
                `;
                await redis.eval(lua, 1, key, lockToken);
                return;
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis release queue lock error:', err.message);
            }
        }

        const current = this.accountQueueLocks.get(accountUuid);
        if (current && current.token === lockToken) {
            this.accountQueueLocks.delete(accountUuid);
        }
    }

    /**
     * 开始追踪请求（记录用户和账号关联）
     * @param {string} requestId - 请求ID
     * @param {string} userKey - 用户标识
     * @param {string} accountUuid - 账号UUID
     * @param {Object} userInfo - 用户信息 { tokenId, username, clientIp, model }
     */
    async startTracking(requestId, userKey, accountUuid, userInfo = {}) {
        const hasRedis = !!this._getRedis();
        console.log(`[ConcurrencyLimiter] startTracking: requestId=${requestId?.slice(0,8)}, userKey=${userKey}, accountUuid=${accountUuid?.slice(0,8)}, redis=${hasRedis}, model=${userInfo.model}`);
        this.requestTracking.set(requestId, {
            userKey,
            accountUuid,
            startTime: Date.now(),
            userInfo,
            queueLockToken: userInfo.queueLockToken || null
        });

        // 存储账号的当前用户
        if (accountUuid && userKey) {
            const now = Date.now();
            const userData = {
                userKey,
                tokenId: userInfo.tokenId || '',
                username: userInfo.username || '',
                clientIp: userInfo.clientIp || '',
                model: userInfo.model || '',
                sessionId: userInfo.sessionId || null,
                lastSeen: new Date().toISOString()
            };

            const redis = this._getRedis();
            if (redis) {
                try {
                    // 1. 存储当前活跃用户 (Hash)
                    const activeKey = `${REDIS_KEYS.ACCOUNT_USERS}${accountUuid}`;
                    await redis.hset(activeKey, requestId, JSON.stringify({ ...userData, startTime: userData.lastSeen }));
                    await redis.expire(activeKey, CONCURRENCY_TTL);

                    // 2. 存储近期用户记录 (Sorted Set)
                    const recentKey = `${REDIS_KEYS.ACCOUNT_RECENT_USERS}${accountUuid}`;
                    await redis.zadd(recentKey, now, `${userKey}::${JSON.stringify(userData)}`);
                    await redis.expire(recentKey, RECENT_USERS_TTL);

                    // 清理过期记录
                    const windowStart = now - RECENT_USERS_TTL * 1000;
                    await redis.zremrangebyscore(recentKey, 0, windowStart);
                } catch (err) {
                    console.error('[ConcurrencyLimiter] Redis store account user error:', err.message);
                }
            } else {
                // 内存模式：存储近期用户
                if (!this.recentUsersMemory.has(accountUuid)) {
                    this.recentUsersMemory.set(accountUuid, new Map());
                }
                const accountUsers = this.recentUsersMemory.get(accountUuid);
                accountUsers.set(userKey, { userData, timestamp: now });

                // 清理过期记录
                const windowStart = now - RECENT_USERS_TTL * 1000;
                for (const [key, value] of accountUsers.entries()) {
                    if (value.timestamp < windowStart) {
                        accountUsers.delete(key);
                    }
                }
            }

            const accountUserConcurrency = await this.incrementAccountUserConcurrency(accountUuid, userKey);
            const accountConcurrency = await this.getAccountConcurrency(accountUuid);
            await this._recordAccountPeakConcurrency(accountUuid, accountConcurrency);
            await this._recordAccountUserPeakConcurrency(accountUuid, userKey, accountUserConcurrency);
        }
    }

    /**
     * 释放请求占用的并发槽位
     */
    async releaseSlots(requestId) {
        const tracking = this.requestTracking.get(requestId);
        if (!tracking) return;

        const { userKey, accountUuid, queueLockToken } = tracking;

        if (userKey) {
            await this.decrementUserConcurrency(userKey);
        }
        if (accountUuid) {
            await this.decrementAccountConcurrency(accountUuid);
            if (userKey) {
                await this.decrementAccountUserConcurrency(accountUuid, userKey);
            }
            // 从 Redis 中移除用户信息
            const redis = this._getRedis();
            if (redis) {
                try {
                    await redis.hdel(`${REDIS_KEYS.ACCOUNT_USERS}${accountUuid}`, requestId);
                } catch (err) {
                    console.error('[ConcurrencyLimiter] Redis remove account user error:', err.message);
                }
            }

            if (queueLockToken) {
                await this.releaseAccountQueueLock(accountUuid, queueLockToken);
            }
        }

        this.requestTracking.delete(requestId);
    }

    /**
     * 获取账号当前用户列表（正在进行的请求）
     * @param {string} accountUuid - 账号UUID
     * @returns {Array} 用户列表
     */
    async getAccountUsers(accountUuid) {
        if (!accountUuid) return [];

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_USERS}${accountUuid}`;
                const users = await redis.hgetall(key);

                if (!users || Object.keys(users).length === 0) {
                    return [];
                }

                return Object.entries(users).map(([requestId, userData]) => {
                    try {
                        const parsed = JSON.parse(userData);
                        return { requestId, ...parsed };
                    } catch {
                        return { requestId, userKey: userData };
                    }
                });
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get account users error:', err.message);
                return [];
            }
        }

        // 内存降级：从 requestTracking 中筛选当前账号的活跃请求
        const results = [];
        for (const [requestId, tracking] of this.requestTracking.entries()) {
            if (tracking.accountUuid === accountUuid) {
                const info = tracking.userInfo || {};
                results.push({
                    requestId,
                    userKey: tracking.userKey,
                    tokenId: info.tokenId || '',
                    username: info.username || '',
                    clientIp: info.clientIp || '',
                    model: info.model || '',
                    startTime: new Date(tracking.startTime).toISOString()
                });
            }
        }
        return results;
    }

    /**
     * 获取账号近期用户列表（时间窗口内的去重用户）
     * @param {string} accountUuid - 账号UUID
     * @param {number} windowSeconds - 时间窗口（秒），默认5分钟
     * @returns {Array} 用户列表
     */
    async getRecentUsers(accountUuid, windowSeconds = RECENT_USERS_TTL) {
        if (!accountUuid) return [];

        const redis = this._getRedis();
        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_RECENT_USERS}${accountUuid}`;
                const now = Date.now();
                const windowStart = now - windowSeconds * 1000;

                // 获取时间窗口内的所有记录
                const members = await redis.zrangebyscore(key, windowStart, now);

                if (!members || members.length === 0) {
                    return [];
                }

                // 解析并去重（按 userKey）
                const userMap = new Map();
                for (const member of members) {
                    try {
                        const separatorIndex = member.indexOf('::');
                        if (separatorIndex === -1) continue;
                        const userKey = member.substring(0, separatorIndex);
                        const userData = JSON.parse(member.substring(separatorIndex + 2));
                        // 保留最新的记录
                        userMap.set(userKey, userData);
                    } catch {
                        // 忽略解析错误
                    }
                }

                return Array.from(userMap.values());
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get recent users error:', err.message);
                return [];
            }
        }

        // 内存降级：从 recentUsersMemory 中读取
        const accountUsers = this.recentUsersMemory.get(accountUuid);
        if (!accountUsers || accountUsers.size === 0) return [];

        const now = Date.now();
        const windowStart = now - windowSeconds * 1000;
        const results = [];
        for (const [, entry] of accountUsers.entries()) {
            if (entry.timestamp >= windowStart) {
                results.push(entry.userData);
            }
        }
        return results;
    }

    /**
     * 获取账号近期用户数量
     * @param {string} accountUuid - 账号UUID
     * @param {number} windowSeconds - 时间窗口（秒）
     * @returns {number} 用户数量
     */
    async getRecentUserCount(accountUuid, windowSeconds = RECENT_USERS_TTL) {
        const users = await this.getRecentUsers(accountUuid, windowSeconds);
        return users.length;
    }

    /**
     * 批量获取多个账号的近期用户数量
     * @param {Array<string>} accountUuids - 账号UUID列表
     * @param {number} windowSeconds - 时间窗口（秒）
     * @returns {Object} { uuid: count }
     */
    async getBatchRecentUserCounts(accountUuids, windowSeconds = RECENT_USERS_TTL) {
        if (!accountUuids || accountUuids.length === 0) return {};

        const result = {};
        const redis = this._getRedis();

        if (!redis) {
            for (const uuid of accountUuids) {
                result[uuid] = 0;
            }
            return result;
        }

        const now = Date.now();
        const windowStart = now - windowSeconds * 1000;

        for (const uuid of accountUuids) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_RECENT_USERS}${uuid}`;
                const members = await redis.zrangebyscore(key, windowStart, now);

                if (!members || members.length === 0) {
                    result[uuid] = 0;
                    continue;
                }

                // 去重计数
                const userKeys = new Set();
                for (const member of members) {
                    const separatorIndex = member.indexOf('::');
                    if (separatorIndex !== -1) {
                        userKeys.add(member.substring(0, separatorIndex));
                    }
                }
                result[uuid] = userKeys.size;
            } catch (err) {
                result[uuid] = 0;
            }
        }

        return result;
    }

    /**
     * 从请求中提取 sessionId
     * 1. Claude: metadata.user_id 格式 user_{hash}_account__session_{uuid}
     * 2. Codex/GPT: session_id / x-session-id / x-stainless-session-id header
     * 3. OpenAI Responses: request body 的 prompt_cache_key 或 conversation_id
     */
    extractSessionId(requestBody, req) {
        const promptCacheKey = requestBody?.prompt_cache_key;
        if (promptCacheKey && typeof promptCacheKey === 'string' && promptCacheKey.trim()) {
            return promptCacheKey.trim();
        }

        // Claude 格式: metadata.user_id → session_{uuid}
        const userId = requestBody?.metadata?.user_id;
        if (userId && typeof userId === 'string') {
            const match = userId.match(/session_([a-f0-9-]+)$/i);
            if (match) return match[1];
        }

        // Codex/GPT: session_id / x-session-id header
        const headers = req?.headers || {};
        const sessionIdHeader = headers['session_id'] || headers['x-session-id'] || headers['x-stainless-session-id'];
        if (sessionIdHeader && typeof sessionIdHeader === 'string' && sessionIdHeader.length > 0) {
            return sessionIdHeader;
        }

        // OpenAI conversation_id (from request body)
        const convId = requestBody?.conversation_id;
        if (convId && typeof convId === 'string') return convId;

        return null;
    }

    /**
     * 检查账号 session 数量是否超限，并记录/刷新 session
     * @param {string} accountUuid - 账号UUID
     * @param {string} sessionId - 会话ID
     * @param {number} maxSessions - 最大 session 数，0=不限制
     * @returns {{ allowed: boolean, current: number }} 是否允许 + 当前 session 数
     */
    async checkAndTrackSession(accountUuid, sessionId, maxSessions) {
        if (!accountUuid || !sessionId || maxSessions <= 0) {
            return { allowed: true, current: 0 };
        }

        const now = Date.now();
        const redis = this._getRedis();

        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_SESSIONS}${accountUuid}`;

                // 先清理过期 session
                const all = await redis.hgetall(key);
                const expireThreshold = now - SESSION_TTL * 1000;
                const expiredKeys = [];
                for (const [sid, ts] of Object.entries(all || {})) {
                    if (parseInt(ts) < expireThreshold) {
                        expiredKeys.push(sid);
                    }
                }
                if (expiredKeys.length > 0) {
                    await redis.hdel(key, ...expiredKeys);
                }

                // 检查当前 session 是否已存在
                const exists = await redis.hexists(key, sessionId);
                if (exists) {
                    // 已存在，刷新 lastSeen
                    await redis.hset(key, sessionId, String(now));
                    await redis.expire(key, SESSION_TTL);
                    const currentCount = await redis.hlen(key);
                    return { allowed: true, current: currentCount };
                }

                // 新 session，检查是否超限
                const currentCount = await redis.hlen(key);
                if (currentCount >= maxSessions) {
                    console.log(`[ConcurrencyLimiter] Session limit exceeded: account=${accountUuid.slice(0,8)}, sessions=${currentCount}/${maxSessions}, newSession=${sessionId.slice(0,8)}`);
                    return { allowed: false, current: currentCount };
                }

                // 记录新 session
                await redis.hset(key, sessionId, String(now));
                await redis.expire(key, SESSION_TTL);
                return { allowed: true, current: currentCount + 1 };
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis session check error:', err.message);
            }
        }

        // 内存降级
        if (!this.accountSessions.has(accountUuid)) {
            this.accountSessions.set(accountUuid, new Map());
        }
        const sessions = this.accountSessions.get(accountUuid);

        // 清理过期
        const expireThreshold = now - SESSION_TTL * 1000;
        for (const [sid, lastSeen] of sessions) {
            if (lastSeen < expireThreshold) sessions.delete(sid);
        }

        if (sessions.has(sessionId)) {
            sessions.set(sessionId, now);
            return { allowed: true, current: sessions.size };
        }

        if (sessions.size >= maxSessions) {
            console.log(`[ConcurrencyLimiter] Session limit exceeded (memory): account=${accountUuid.slice(0,8)}, sessions=${sessions.size}/${maxSessions}, newSession=${sessionId.slice(0,8)}`);
            return { allowed: false, current: sessions.size };
        }

        sessions.set(sessionId, now);
        return { allowed: true, current: sessions.size };
    }

    /**
     * 获取账号当前活跃 session 列表
     * @param {string} accountUuid - 账号UUID
     * @returns {Array<{sessionId: string, lastSeen: string}>}
     */
    async getAccountSessions(accountUuid) {
        if (!accountUuid) return [];

        const now = Date.now();
        const expireThreshold = now - SESSION_TTL * 1000;
        const redis = this._getRedis();

        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_SESSIONS}${accountUuid}`;
                const all = await redis.hgetall(key);
                if (!all) return [];
                return Object.entries(all)
                    .filter(([, ts]) => parseInt(ts) >= expireThreshold)
                    .map(([sessionId, ts]) => ({
                        sessionId,
                        lastSeen: new Date(parseInt(ts)).toISOString()
                    }));
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get sessions error:', err.message);
            }
        }

        const sessions = this.accountSessions.get(accountUuid);
        if (!sessions) return [];
        return [...sessions.entries()]
            .filter(([, lastSeen]) => lastSeen >= expireThreshold)
            .map(([sessionId, lastSeen]) => ({
                sessionId,
                lastSeen: new Date(lastSeen).toISOString()
            }));
    }

    /**
     * 获取账号下每个用户的 session 数量（从近期用户记录聚合）
     * @param {string} accountUuid - 账号UUID
     * @param {number} windowSeconds - 时间窗口（秒）
     * @returns {Object} { userKey: { count, sessionIds } }
     */
    async getUserSessionCounts(accountUuid, windowSeconds = RECENT_USERS_TTL) {
        if (!accountUuid) return {};

        const now = Date.now();
        const windowStart = now - windowSeconds * 1000;
        const redis = this._getRedis();

        // userKey → Set<sessionId>
        const userSessions = {};

        if (redis) {
            try {
                const key = `${REDIS_KEYS.ACCOUNT_RECENT_USERS}${accountUuid}`;
                const members = await redis.zrangebyscore(key, windowStart, now);
                if (members && members.length > 0) {
                    for (const member of members) {
                        const sep = member.indexOf('::');
                        if (sep === -1) continue;
                        const userKey = member.substring(0, sep);
                        try {
                            const data = JSON.parse(member.substring(sep + 2));
                            if (data.sessionId) {
                                if (!userSessions[userKey]) userSessions[userKey] = new Set();
                                userSessions[userKey].add(data.sessionId);
                            }
                        } catch { /* ignore */ }
                    }
                }
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis getUserSessionCounts error:', err.message);
            }
        } else {
            // 内存降级
            const accountUsers = this.recentUsersMemory.get(accountUuid);
            if (accountUsers) {
                for (const [userKey, entry] of accountUsers.entries()) {
                    if (entry.timestamp >= windowStart && entry.userData?.sessionId) {
                        if (!userSessions[userKey]) userSessions[userKey] = new Set();
                        userSessions[userKey].add(entry.userData.sessionId);
                    }
                }
            }
        }

        // Set → { count, sessionIds[] }
        const result = {};
        for (const [userKey, sessions] of Object.entries(userSessions)) {
            result[userKey] = { count: sessions.size, sessionIds: [...sessions] };
        }
        return result;
    }

    /**
     * 获取统计信息
     */
    async getStats() {
        const redis = this._getRedis();

        if (redis) {
            try {
                // 从 Redis 获取所有并发计数
                const userKeys = await redis.keys(`${REDIS_KEYS.USER_CONCURRENCY}*`);
                const accountKeys = await redis.keys(`${REDIS_KEYS.ACCOUNT_CONCURRENCY}*`);

                let totalUserConcurrency = 0;
                let totalAccountConcurrency = 0;

                for (const key of userKeys) {
                    const count = await redis.get(key);
                    totalUserConcurrency += parseInt(count) || 0;
                }

                for (const key of accountKeys) {
                    const count = await redis.get(key);
                    totalAccountConcurrency += parseInt(count) || 0;
                }

                return {
                    activeUsers: userKeys.length,
                    activeAccounts: accountKeys.length,
                    totalUserConcurrency,
                    totalAccountConcurrency,
                    trackedRequests: this.requestTracking.size
                };
            } catch (err) {
                console.error('[ConcurrencyLimiter] Redis get stats error:', err.message);
            }
        }

        // 降级到内存统计
        let totalUserConcurrency = 0;
        let totalAccountConcurrency = 0;

        for (const count of this.userConcurrency.values()) {
            totalUserConcurrency += count;
        }
        for (const count of this.accountConcurrency.values()) {
            totalAccountConcurrency += count;
        }

        return {
            activeUsers: this.userConcurrency.size,
            activeAccounts: this.accountConcurrency.size,
            totalUserConcurrency,
            totalAccountConcurrency,
            trackedRequests: this.requestTracking.size
        };
    }
}

// 全局单例
export const concurrencyLimiter = new ConcurrencyLimiter();
