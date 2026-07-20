/**
 * Request Logs API - 请求日志API模块
 */

import { getRequestBody } from '../utils/common.js';
import * as requestLogsDao from '../dao/request-logs-dao.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 获取单条请求日志详情（包含大字段）
 */
export async function handleGetRequestLogDetail(req, res) {
    try {
        const { id } = req.params;
        const record = await requestLogsDao.findById(id);

        if (!record) {
            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'Request log not found' }));
            return true;
        }

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, data: record }));
        return true;
    } catch (error) {
        console.error('[RequestLogsAPI] Failed to get log detail:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 获取账号的请求日志
 */
export async function handleGetProviderRequestLogs(req, res) {
    try {
        const { uuid } = req.params;
        const { page, pageSize, isSuccess, startDate, endDate } = req.query;

        const options = {
            page: parseInt(page, 10) || 1,
            pageSize: parseInt(pageSize, 10) || 10,
            isSuccess: isSuccess !== undefined ? isSuccess === 'true' : undefined,
            startDate,
            endDate
        };

        const [records, total, summary] = await Promise.all([
            requestLogsDao.findByProviderUuid(uuid, options),
            requestLogsDao.countByProviderUuid(uuid, options),
            requestLogsDao.getProviderSummary(uuid)
        ]);

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
            success: true,
            data: records,
            total,
            page: options.page,
            pageSize: options.pageSize,
            totalPages: Math.ceil(total / options.pageSize),
            summary
        }));
        return true;
    } catch (error) {
        console.error('[RequestLogsAPI] Failed to get provider logs:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 获取池子的请求日志
 */
export async function handleGetPoolRequestLogs(req, res) {
    try {
        const { providerType, poolId } = req.query;

        if (!providerType) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'providerType is required' }));
            return true;
        }

        const { page, pageSize, isSuccess, startDate, endDate } = req.query;

        const options = {
            page: parseInt(page, 10) || 1,
            pageSize: parseInt(pageSize, 10) || 10,
            isSuccess: isSuccess !== undefined ? isSuccess === 'true' : undefined,
            startDate,
            endDate
        };

        const [records, total, summary] = await Promise.all([
            requestLogsDao.findByPoolId(providerType, poolId, options),
            requestLogsDao.countByPoolId(providerType, poolId, options),
            requestLogsDao.getPoolSummary(providerType, poolId)
        ]);

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
            success: true,
            data: records,
            total,
            page: options.page,
            pageSize: options.pageSize,
            totalPages: Math.ceil(total / options.pageSize),
            summary
        }));
        return true;
    } catch (error) {
        console.error('[RequestLogsAPI] Failed to get pool logs:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 清空账号的请求日志
 */
export async function handleClearProviderRequestLogs(req, res) {
    try {
        const { uuid } = req.params;
        const deleted = await requestLogsDao.clearByProviderUuid(uuid);

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[RequestLogsAPI] Failed to clear provider logs:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 清空池子的请求日志
 */
export async function handleClearPoolRequestLogs(req, res) {
    try {
        const { providerType, poolId } = req.query;

        if (!providerType) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'providerType is required' }));
            return true;
        }

        const deleted = await requestLogsDao.clearByPoolId(providerType, poolId);

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[RequestLogsAPI] Failed to clear pool logs:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}
