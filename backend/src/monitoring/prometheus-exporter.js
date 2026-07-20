/**
 * Prometheus 指标导出器
 * 将收集的指标转换为 Prometheus 格式
 */

import { metricsCollector } from './metrics-collector.js';
import os from 'os';
import cluster from 'cluster';

/**
 * 生成 Prometheus 格式的指标
 */
export function generatePrometheusMetrics() {
    const lines = [];
    const now = Date.now();

    // ========== HTTP 请求指标 ==========
    lines.push('# HELP http_requests_total Total number of HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    lines.push(`http_requests_total ${metricsCollector.httpRequests.total}`);
    lines.push('');

    // 按方法统计
    lines.push('# HELP http_requests_by_method HTTP requests by method');
    lines.push('# TYPE http_requests_by_method counter');
    for (const [method, count] of Object.entries(metricsCollector.httpRequests.byMethod)) {
        lines.push(`http_requests_by_method{method="${method}"} ${count}`);
    }
    lines.push('');

    // 按状态码统计
    lines.push('# HELP http_requests_by_status HTTP requests by status code');
    lines.push('# TYPE http_requests_by_status counter');
    for (const [status, count] of Object.entries(metricsCollector.httpRequests.byStatus)) {
        lines.push(`http_requests_by_status{status="${status}"} ${count}`);
    }
    lines.push('');

    // 按路径统计
    lines.push('# HELP http_requests_by_path HTTP requests by path');
    lines.push('# TYPE http_requests_by_path counter');
    for (const [path, count] of Object.entries(metricsCollector.httpRequests.byPath)) {
        lines.push(`http_requests_by_path{path="${path}"} ${count}`);
    }
    lines.push('');

    // ========== 响应时间指标 ==========
    lines.push('# HELP http_response_time_ms HTTP response time in milliseconds');
    lines.push('# TYPE http_response_time_ms summary');
    lines.push(`http_response_time_ms{quantile="0.5"} ${metricsCollector.getResponseTimePercentile(50)}`);
    lines.push(`http_response_time_ms{quantile="0.9"} ${metricsCollector.getResponseTimePercentile(90)}`);
    lines.push(`http_response_time_ms{quantile="0.95"} ${metricsCollector.getResponseTimePercentile(95)}`);
    lines.push(`http_response_time_ms{quantile="0.99"} ${metricsCollector.getResponseTimePercentile(99)}`);
    lines.push('');

    // ========== 提供商请求指标 ==========
    lines.push('# HELP provider_requests_total Total provider requests');
    lines.push('# TYPE provider_requests_total counter');
    lines.push(`provider_requests_total ${metricsCollector.providerRequests.total}`);
    lines.push('');

    lines.push('# HELP provider_requests_by_type Provider requests by type');
    lines.push('# TYPE provider_requests_by_type counter');
    for (const [provider, stats] of Object.entries(metricsCollector.providerRequests.byProvider)) {
        lines.push(`provider_requests_by_type{provider="${provider}",status="success"} ${stats.success}`);
        lines.push(`provider_requests_by_type{provider="${provider}",status="failed"} ${stats.failed}`);
    }
    lines.push('');

    // ========== 系统资源指标 ==========
    const uptime = (now - metricsCollector.systemMetrics.startTime) / 1000;
    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${uptime.toFixed(2)}`);
    lines.push('');

    const memUsage = process.memoryUsage();
    lines.push('# HELP process_memory_bytes Process memory usage in bytes');
    lines.push('# TYPE process_memory_bytes gauge');
    lines.push(`process_memory_bytes{type="rss"} ${memUsage.rss}`);
    lines.push(`process_memory_bytes{type="heapTotal"} ${memUsage.heapTotal}`);
    lines.push(`process_memory_bytes{type="heapUsed"} ${memUsage.heapUsed}`);
    lines.push('');

    const cpuUsage = process.cpuUsage();
    lines.push('# HELP process_cpu_usage_microseconds Process CPU usage');
    lines.push('# TYPE process_cpu_usage_microseconds counter');
    lines.push(`process_cpu_usage_microseconds{type="user"} ${cpuUsage.user}`);
    lines.push(`process_cpu_usage_microseconds{type="system"} ${cpuUsage.system}`);
    lines.push('');

    // 系统信息
    lines.push('# HELP system_cpu_cores Number of CPU cores');
    lines.push('# TYPE system_cpu_cores gauge');
    lines.push(`system_cpu_cores ${os.cpus().length}`);
    lines.push('');

    lines.push('# HELP system_memory_total_bytes Total system memory');
    lines.push('# TYPE system_memory_total_bytes gauge');
    lines.push(`system_memory_total_bytes ${os.totalmem()}`);
    lines.push('');

    lines.push('# HELP system_memory_free_bytes Free system memory');
    lines.push('# TYPE system_memory_free_bytes gauge');
    lines.push(`system_memory_free_bytes ${os.freemem()}`);
    lines.push('');

    // ========== 号池管理指标 ==========
    lines.push('# HELP pool_select_provider_total Total provider selections');
    lines.push('# TYPE pool_select_provider_total counter');
    lines.push(`pool_select_provider_total ${metricsCollector.poolMetrics.selectProvider.count}`);
    lines.push('');

    lines.push('# HELP pool_select_provider_duration_ms Average provider selection duration');
    lines.push('# TYPE pool_select_provider_duration_ms gauge');
    lines.push(`pool_select_provider_duration_ms ${metricsCollector.poolMetrics.selectProvider.avgTime || 0}`);
    lines.push('');

    return lines.join('\n');
}
