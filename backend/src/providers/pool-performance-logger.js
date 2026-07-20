/**
 * 号池管理性能日志模块
 * 记录号池操作的性能指标
 */

export class PoolPerformanceLogger {
    constructor() {
        this.metrics = {
            selectProvider: {
                count: 0,
                totalTime: 0,
                avgTime: 0,
                maxTime: 0,
                minTime: Infinity
            },
            cacheHits: 0,
            cacheMisses: 0,
            dbQueries: 0
        };
    }

    /**
     * 记录选择提供商的性能
     */
    recordSelectProvider(duration) {
        const m = this.metrics.selectProvider;
        m.count++;
        m.totalTime += duration;
        m.avgTime = m.totalTime / m.count;
        m.maxTime = Math.max(m.maxTime, duration);
        m.minTime = Math.min(m.minTime, duration);
    }

    /**
     * 记录缓存命中
     */
    recordCacheHit() {
        this.metrics.cacheHits++;
    }

    /**
     * 记录缓存未命中
     */
    recordCacheMiss() {
        this.metrics.cacheMisses++;
    }

    /**
     * 记录数据库查询
     */
    recordDbQuery() {
        this.metrics.dbQueries++;
    }

    /**
     * 获取性能报告
     */
    getReport() {
        const cacheTotal = this.metrics.cacheHits + this.metrics.cacheMisses;
        const cacheHitRate = cacheTotal > 0
            ? (this.metrics.cacheHits / cacheTotal * 100).toFixed(2)
            : 0;

        return {
            selectProvider: {
                ...this.metrics.selectProvider,
                avgTime: this.metrics.selectProvider.avgTime.toFixed(2) + 'ms'
            },
            cache: {
                hits: this.metrics.cacheHits,
                misses: this.metrics.cacheMisses,
                hitRate: cacheHitRate + '%'
            },
            dbQueries: this.metrics.dbQueries
        };
    }

    /**
     * 打印性能报告
     */
    printReport() {
        const report = this.getReport();
        console.log('[PoolPerformance] Report:', JSON.stringify(report, null, 2));
    }
}

// 全局性能日志器
export const poolPerformanceLogger = new PoolPerformanceLogger();
