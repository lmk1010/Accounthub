/**
 * Token Stats API - Token 使用统计 API
 */

import * as providerTokenStatsDao from '../dao/provider-token-stats-dao.js';

function jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
}

/**
 * 获取账号的 Token 统计
 */
export async function getProviderTokenStats(req, res) {
    try {
        const { uuid } = req.params;

        if (!uuid) {
            return jsonResponse(res, 400, {
                success: false,
                error: { message: 'Provider UUID is required' }
            });
        }

        const stats = await providerTokenStatsDao.getStatsByProvider(uuid);

        return jsonResponse(res, 200, {
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('[TokenStatsAPI] Failed to get provider token stats:', error);
        return jsonResponse(res, 500, {
            success: false,
            error: { message: error.message }
        });
    }
}

/**
 * 获取 Token 使用排行榜
 */
export async function getTopProviders(req, res) {
    try {
        const {
            providerType = null,
            orderBy = 'total_tokens',
            limit = 50
        } = req.query;

        const stats = await providerTokenStatsDao.getTopProviders({
            providerType,
            orderBy,
            limit: parseInt(limit, 10)
        });

        return jsonResponse(res, 200, {
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('[TokenStatsAPI] Failed to get top providers:', error);
        return jsonResponse(res, 500, {
            success: false,
            error: { message: error.message }
        });
    }
}

/**
 * 重新计算统计（管理员功能）
 */
export async function rebuildStats(req, res) {
    try {
        const { uuid = null } = req.body || {};

        const result = await providerTokenStatsDao.rebuildStats(uuid);

        return jsonResponse(res, 200, {
            success: true,
            data: result,
            message: uuid
                ? `Rebuilt stats for provider ${uuid}`
                : 'Rebuilt stats for all providers'
        });
    } catch (error) {
        console.error('[TokenStatsAPI] Failed to rebuild stats:', error);
        return jsonResponse(res, 500, {
            success: false,
            error: { message: error.message }
        });
    }
}

/**
 * 初始化统计表
 */
export async function initializeTable(req, res) {
    try {
        await providerTokenStatsDao.ensureTable();

        return jsonResponse(res, 200, {
            success: true,
            message: 'Token stats table initialized'
        });
    } catch (error) {
        console.error('[TokenStatsAPI] Failed to initialize table:', error);
        return jsonResponse(res, 500, {
            success: false,
            error: { message: error.message }
        });
    }
}
