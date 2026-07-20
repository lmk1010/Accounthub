/**
 * 统计路由模块
 * 处理使用统计、错误历史等数据
 */

import { readRequestBody, sendJson, sendError } from './index.js';
import * as statsService from '../services/stats.service.js';

/**
 * 统计路由处理器
 */
export async function statsRouter(method, path, req, res, context) {
    // GET /api/stats/pool - 获取号池统计
    if (method === 'GET' && path === '/api/stats/pool') {
        return await handleGetPoolStats(req, res, context);
    }

    // GET /api/stats/errors - 获取错误历史
    if (method === 'GET' && path === '/api/stats/errors') {
        return await handleGetErrorHistory(req, res, context);
    }

    // DELETE /api/stats/errors - 清空错误历史
    if (method === 'DELETE' && path === '/api/stats/errors') {
        return await handleClearErrorHistory(req, res, context);
    }

    // GET /api/stats/consumption - 获取消费统计
    if (method === 'GET' && path === '/api/stats/consumption') {
        return await handleGetConsumptionStats(req, res);
    }

    // POST /api/stats/consumption/update - 更新消费统计
    if (method === 'POST' && path === '/api/stats/consumption/update') {
        return await handleUpdateConsumptionStats(req, res);
    }

    // POST /api/stats/consumption/reset - 重置消费统计
    if (method === 'POST' && path === '/api/stats/consumption/reset') {
        return await handleResetConsumptionStats(req, res);
    }

    return false;
}

/**
 * 获取号池统计
 */
async function handleGetPoolStats(req, res, context) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const providerType = url.searchParams.get('providerType') || 'all';
        const stats = await statsService.getPoolStats(context.poolManager, { providerType });
        sendJson(res, 200, { success: true, data: stats });
    } catch (error) {
        console.error('[Stats] Get pool stats error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取错误历史
 */
async function handleGetErrorHistory(req, res, context) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const providerType = url.searchParams.get('providerType') || null;
        const statusCodeParam = url.searchParams.get('statusCode');
        const limit = url.searchParams.get('limit');
        const page = Number(url.searchParams.get('page') || 1);
        const pageSize = Number(url.searchParams.get('pageSize') || 50);

        let statusCode = null;
        let statusCodeMin = null;
        let statusCodeMax = null;

        if (statusCodeParam) {
            if (statusCodeParam.toLowerCase() === '5xx') {
                statusCodeMin = 500;
                statusCodeMax = 599;
            } else {
                const parsed = parseInt(statusCodeParam, 10);
                if (!Number.isNaN(parsed)) {
                    statusCode = parsed;
                }
            }
        }

        const errors = await statsService.getErrorHistory(context.poolManager, {
            providerType,
            statusCode,
            statusCodeMin,
            statusCodeMax,
            page,
            pageSize,
            limit: limit ? parseInt(limit, 10) : undefined
        });

        sendJson(res, 200, { success: true, data: errors });
    } catch (error) {
        console.error('[Stats] Get error history error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 清空错误历史
 */
async function handleClearErrorHistory(req, res, context) {
    try {
        await statsService.clearErrorHistory(context.poolManager);
        sendJson(res, 200, { success: true, message: 'Error history cleared' });
    } catch (error) {
        console.error('[Stats] Clear error history error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取消费统计
 */
async function handleGetConsumptionStats(req, res) {
    try {
        const stats = await statsService.getConsumptionStats();
        sendJson(res, 200, { success: true, data: stats });
    } catch (error) {
        console.error('[Stats] Get consumption stats error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 更新消费统计
 */
async function handleUpdateConsumptionStats(req, res) {
    try {
        const result = await statsService.updateConsumptionStats();
        sendJson(res, 200, result);
    } catch (error) {
        console.error('[Stats] Update consumption stats error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 重置消费统计
 */
async function handleResetConsumptionStats(req, res) {
    try {
        await statsService.resetConsumptionStats();
        sendJson(res, 200, { success: true, message: 'Consumption stats reset' });
    } catch (error) {
        console.error('[Stats] Reset consumption stats error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}
