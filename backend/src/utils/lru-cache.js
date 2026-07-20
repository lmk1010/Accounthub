/**
 * LRU (Least Recently Used) 缓存实现
 * 使用 Map 的有序特性实现 O(1) 的 get/set 操作
 *
 * 用于 Redis 不可用时的内存回退缓存，防止内存无限增长
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
