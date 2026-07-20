/**
 * 性能监控模块 - Prometheus Metrics
 * 提供系统性能指标收集和导出
 */

/**
 * 指标存储
 */
class MetricsCollector {
    constructor() {
        // HTTP 请求指标
        this.httpRequests = {
            total: 0,
            byMethod: {},
            byStatus: {},
            byPath: {}
        };

        // 响应时间直方图
        this.responseTimes = [];

        // 提供商请求指标
        this.providerRequests = {
            total: 0,
            byProvider: {},
            byStatus: {}
        };

        // 系统资源指标
        this.systemMetrics = {
            startTime: Date.now(),
            lastUpdate: Date.now()
        };

        // 号池管理指标
        this.poolMetrics = {
            selectProvider: {
                count: 0,
                totalTime: 0,
                avgTime: 0
            },
            cacheHitRate: 0
        };
    }

    /**
     * 记录 HTTP 请求
     */
    recordHttpRequest(method, path, statusCode, duration) {
        this.httpRequests.total++;

        // 按方法统计
        this.httpRequests.byMethod[method] = (this.httpRequests.byMethod[method] || 0) + 1;

        // 按状态码统计
        this.httpRequests.byStatus[statusCode] = (this.httpRequests.byStatus[statusCode] || 0) + 1;

        // 按路径统计（简化路径）
        const simplePath = this.simplifyPath(path);
        this.httpRequests.byPath[simplePath] = (this.httpRequests.byPath[simplePath] || 0) + 1;

        // 记录响应时间
        this.responseTimes.push(duration);
        if (this.responseTimes.length > 1000) {
            this.responseTimes.shift(); // 保持最近1000条
        }
    }

    /**
     * 简化路径（移除动态参数）
     */
    simplifyPath(path) {
        return path
            .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
            .replace(/\/\d+/g, '/:id')
            .split('?')[0];
    }

    /**
     * 记录提供商请求
     */
    recordProviderRequest(providerType, status) {
        this.providerRequests.total++;

        // 按提供商统计
        if (!this.providerRequests.byProvider[providerType]) {
            this.providerRequests.byProvider[providerType] = { total: 0, success: 0, failed: 0 };
        }
        this.providerRequests.byProvider[providerType].total++;

        if (status === 'success') {
            this.providerRequests.byProvider[providerType].success++;
        } else {
            this.providerRequests.byProvider[providerType].failed++;
        }
    }

    /**
     * 获取响应时间百分位数
     */
    getResponseTimePercentile(percentile) {
        if (this.responseTimes.length === 0) return 0;

        const sorted = [...this.responseTimes].sort((a, b) => a - b);
        const index = Math.ceil((percentile / 100) * sorted.length) - 1;
        return sorted[index] || 0;
    }

    /**
     * 更新系统指标
     */
    updateSystemMetrics() {
        this.systemMetrics.lastUpdate = Date.now();
    }

    /**
     * 更新号池指标
     */
    updatePoolMetrics(poolPerformanceReport) {
        if (poolPerformanceReport && poolPerformanceReport.selectProvider) {
            this.poolMetrics.selectProvider = {
                count: poolPerformanceReport.selectProvider.count,
                totalTime: poolPerformanceReport.selectProvider.totalTime,
                avgTime: poolPerformanceReport.selectProvider.avgTime
            };
        }

        if (poolPerformanceReport && poolPerformanceReport.cache) {
            this.poolMetrics.cacheHitRate = poolPerformanceReport.cache.hitRate;
        }
    }
}

// 全局指标收集器
const metricsCollector = new MetricsCollector();

export { metricsCollector };
