/**
 * 号池内存缓存模块
 * 减少数据库查询，提高性能
 *
 * 优化：
 * - 支持最大缓存大小限制（LRU淘汰）
 * - 主动清理过期项
 * - 内存泄漏防护
 */

export class PoolCache {
    constructor(options = {}) {
        this.ttl = Number.isFinite(options.ttl) ? options.ttl : 60000; // 默认缓存60秒
        this.maxSize = options.maxSize || 2000; // 默认最大2000条
        this.cleanupInterval = options.cleanupInterval || 60000; // 默认60秒清理一次
        this.cache = new Map();
        this.cleanupTimer = null;

        // 启动主动清理
        this._startCleanup();
    }

    /**
     * 设置缓存（LRU：删除旧的再插入实现访问顺序）
     */
    set(key, value) {
        if (this.ttl <= 0) {
            return;
        }

        // 如果key已存在，先删除（保证插入顺序为最新）
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 检查是否超过最大限制，淘汰最旧的
        while (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            value,
            expireAt: Date.now() + this.ttl
        });
    }

    /**
     * 获取缓存
     */
    get(key) {
        if (this.ttl <= 0) {
            return null;
        }
        const item = this.cache.get(key);
        if (!item) {
            return null;
        }

        // 检查是否过期
        if (Date.now() > item.expireAt) {
            this.cache.delete(key);
            return null;
        }

        // LRU：访问后移到末尾（最新）
        this.cache.delete(key);
        this.cache.set(key, item);

        return item.value;
    }

    /**
     * 删除缓存
     */
    delete(key) {
        this.cache.delete(key);
    }

    /**
     * 清空缓存
     */
    clear() {
        this.cache.clear();
    }

    /**
     * 获取缓存大小
     */
    size() {
        return this.cache.size;
    }

    /**
     * 主动清理过期项
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, item] of this.cache) {
            if (now > item.expireAt) {
                this.cache.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[PoolCache] Cleaned ${cleaned} expired items, remaining: ${this.cache.size}`);
        }

        return cleaned;
    }

    /**
     * 启动定时清理
     */
    _startCleanup() {
        if (this.cleanupTimer) {
            return;
        }

        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);

        // 允许进程正常退出
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * 停止定时清理
     */
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /**
     * 获取缓存统计信息
     */
    getStats() {
        const now = Date.now();
        let expired = 0;
        let valid = 0;

        for (const [, item] of this.cache) {
            if (now > item.expireAt) {
                expired++;
            } else {
                valid++;
            }
        }

        return {
            total: this.cache.size,
            valid,
            expired,
            maxSize: this.maxSize,
            ttl: this.ttl,
            utilization: ((this.cache.size / this.maxSize) * 100).toFixed(1) + '%'
        };
    }

    /**
     * 销毁缓存实例
     */
    destroy() {
        this.stopCleanup();
        this.cache.clear();
    }
}
