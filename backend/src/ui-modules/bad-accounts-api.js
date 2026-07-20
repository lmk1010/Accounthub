/**
 * Bad Accounts API - 坏号记录API模块
 */

import { getRequestBody } from '../utils/common.js';
import * as badAccountsDao from '../dao/bad-accounts-dao.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 获取坏号记录列表
 */
export async function handleGetBadAccounts(req, res) {
    try {
        const { providerType, poolId, errorType, detectionSource, page, pageSize } = req.query;

        const options = {
            providerType,
            poolId: poolId !== undefined ? poolId : undefined,
            errorType,
            detectionSource,
            page: parseInt(page, 10) || 1,
            pageSize: parseInt(pageSize, 10) || 20
        };

        const [records, total] = await Promise.all([
            badAccountsDao.findAll(options),
            badAccountsDao.count(options)
        ]);

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
            success: true,
            data: records,
            total,
            page: options.page,
            pageSize: options.pageSize,
            totalPages: Math.ceil(total / options.pageSize)
        }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to get bad accounts:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 获取坏号统计摘要
 */
export async function handleGetBadAccountsSummary(req, res) {
    try {
        const { providerType, poolId } = req.query;
        const summary = await badAccountsDao.getSummary({ providerType, poolId });

        const byErrorType = {};
        const bySource = {};
        let total = 0;

        for (const row of summary) {
            const { error_type, detection_source, count } = row;
            byErrorType[error_type] = (byErrorType[error_type] || 0) + count;
            bySource[detection_source] = (bySource[detection_source] || 0) + count;
            total += count;
        }

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
            success: true,
            data: { total, byErrorType, bySource, details: summary }
        }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to get summary:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 创建坏号记录
 */
export async function handleCreateBadAccount(req, res) {
    try {
        const body = await getRequestBody(req);

        if (!body.providerType && !body.provider_type) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'providerType is required' }));
            return true;
        }
        if (!body.errorType && !body.error_type) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'errorType is required' }));
            return true;
        }

        const id = await badAccountsDao.create(body);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, id }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to create bad account:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 删除坏号记录
 */
export async function handleDeleteBadAccount(req, res) {
    try {
        const { id } = req.params;
        const deleted = await badAccountsDao.deleteById(parseInt(id, 10));
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to delete bad account:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 批量删除坏号记录
 */
export async function handleBatchDeleteBadAccounts(req, res) {
    try {
        const body = await getRequestBody(req);
        const { ids } = body;

        if (!Array.isArray(ids) || ids.length === 0) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'ids array is required' }));
            return true;
        }

        const deleted = await badAccountsDao.deleteByIds(ids.map(id => parseInt(id, 10)));
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to batch delete:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 清空指定池子的坏号记录
 */
export async function handleClearBadAccounts(req, res) {
    try {
        const { providerType, poolId } = req.query;

        if (!providerType) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ success: false, error: 'providerType is required' }));
            return true;
        }

        const deleted = await badAccountsDao.clearByPool(providerType, poolId);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ success: true, deleted }));
        return true;
    } catch (error) {
        console.error('[BadAccountsAPI] Failed to clear bad accounts:', error);
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}
