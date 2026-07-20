/**
 * 请求日志中间件
 * 记录所有 HTTP 请求的详细信息
 */

import { metricsCollector } from '../monitoring/metrics-collector.js';
import { logEvent } from '../ui-modules/event-broadcast.js';

/**
 * 创建请求日志中间件
 */
export function createRequestLogger() {
    return (req, res, startTime) => {
        const duration = Date.now() - startTime;
        const method = req.method;
        const url = req.url;
        const statusCode = res.statusCode;
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // 记录指标
        metricsCollector.recordHttpRequest(method, url, statusCode, duration);

        const logMessage = `${method} ${url} ${statusCode} ${duration}ms ${ip}`;
        const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

        logEvent('http.request', {
            method,
            url,
            statusCode,
            duration,
            ip,
            userAgent
        }, {
            level,
            message: logMessage,
            writeToFile: true,
            emitConsole: true
        });
    };
}

/**
 * 包装响应对象以记录日志
 */
export function wrapResponseForLogging(res, req, startTime) {
    const logger = createRequestLogger();
    const originalEnd = res.end;

    res.end = function(...args) {
        logger(req, res, startTime);
        originalEnd.apply(res, args);
    };

    return res;
}
