/**
 * 监控路由模块
 * 处理性能监控相关 API
 */

import { sendJson, sendError } from './index.js';
import * as monitorApi from '../ui-modules/monitor-api.js';

/**
 * 监控路由处理器
 */
export async function monitorRouter(method, path, req, res, context) {
    // GET /api/monitor/overview - 获取综合监控数据
    if (method === 'GET' && path === '/api/monitor/overview') {
        return await monitorApi.handleGetMonitorOverview(req, res);
    }

    // GET /api/monitor/pool-health - 获取号池健康状态
    if (method === 'GET' && path === '/api/monitor/pool-health') {
        return await monitorApi.handleGetPoolHealth(req, res);
    }

    // GET /api/monitor/redis - 获取 Redis 详细状态
    if (method === 'GET' && path === '/api/monitor/redis') {
        return await monitorApi.handleGetRedisStatus(req, res);
    }

    // GET /api/monitor/mysql - 获取 MySQL 详细状态
    if (method === 'GET' && path === '/api/monitor/mysql') {
        return await monitorApi.handleGetMySQLStatus(req, res);
    }

    // GET /api/monitor/disk - 获取磁盘占用
    if (method === 'GET' && path === '/api/monitor/disk') {
        return await monitorApi.handleGetDiskUsage(req, res);
    }

    // GET /api/monitor/mysql/tables - 获取表大小
    if (method === 'GET' && path === '/api/monitor/mysql/tables') {
        return await monitorApi.handleGetTableSizes(req, res);
    }

    // GET /api/monitor/mysql/slow-queries - 获取慢查询
    if (method === 'GET' && path === '/api/monitor/mysql/slow-queries') {
        return await monitorApi.handleGetSlowQueries(req, res);
    }

    // POST /api/monitor/cleanup-request-logs - 清理请求日志
    if (method === 'POST' && path === '/api/monitor/cleanup-request-logs') {
        return await monitorApi.handleCleanupRequestLogs(req, res);
    }

    return false;
}
