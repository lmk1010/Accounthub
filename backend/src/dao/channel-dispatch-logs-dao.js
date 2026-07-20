/**
 * Channel Dispatch Logs DAO - 渠道调度日志数据访问层
 * 记录渠道级别的调度错误（如"No healthy provider found"）
 */

import { getPool } from '../config/database.js';

let tableEnsured = false;

/**
 * 确保表存在
 */
async function ensureTable() {
    if (tableEnsured) return;
    const pool = getPool();
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS channel_dispatch_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                provider_type VARCHAR(64) NOT NULL COMMENT '渠道类型',
                request_model VARCHAR(128) DEFAULT NULL COMMENT '请求模型',
                error_type VARCHAR(64) DEFAULT NULL COMMENT '错误类型: no_healthy_provider, pool_empty, model_not_supported, concurrency_limit等',
                error_message TEXT DEFAULT NULL COMMENT '错误信息',
                dispatch_detail JSON DEFAULT NULL COMMENT '调度详情(池子状态、路由信息等)',
                request_path VARCHAR(255) DEFAULT NULL COMMENT '请求路径',
                request_method VARCHAR(10) DEFAULT NULL COMMENT '请求方法',
                client_ip VARCHAR(64) DEFAULT NULL COMMENT '客户端IP',
                user_agent TEXT DEFAULT NULL COMMENT 'User-Agent',
                authorization_preview VARCHAR(128) DEFAULT NULL COMMENT 'Authorization头预览(脱敏)',
                client_token_id VARCHAR(128) DEFAULT NULL COMMENT '调用端Token ID',
                user_id VARCHAR(64) DEFAULT NULL COMMENT '调用端User ID',
                user_email VARCHAR(128) DEFAULT NULL COMMENT '调用端User Email',
                username VARCHAR(128) DEFAULT NULL COMMENT '调用端Username',
                request_headers JSON DEFAULT NULL COMMENT '请求头(脱敏后)',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
                INDEX idx_provider_type (provider_type),
                INDEX idx_error_type (error_type),
                INDEX idx_created_at (created_at),
                INDEX idx_type_created (provider_type, created_at DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='渠道调度日志表'
        `);
        tableEnsured = true;
    } catch (error) {
        console.warn('[ChannelDispatchLogsDao] Failed to ensure table:', error.message);
    }
}

/**
 * 创建调度日志
 */
export async function create(data) {
    await ensureTable();
    const pool = getPool();
    const {
        providerType, requestModel, errorType, errorMessage,
        dispatchDetail, requestPath, requestMethod,
        clientIp, userAgent, authorizationPreview,
        clientTokenId, userId, userEmail, username,
        requestHeaders
    } = data;

    const sql = `
        INSERT INTO channel_dispatch_logs
        (provider_type, request_model, error_type, error_message,
         dispatch_detail, request_path, request_method,
         client_ip, user_agent, authorization_preview,
         client_token_id, user_id, user_email, username,
         request_headers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        providerType || null,
        requestModel || null,
        errorType || null,
        errorMessage || null,
        dispatchDetail ? JSON.stringify(dispatchDetail) : null,
        requestPath || null,
        requestMethod || null,
        clientIp || null,
        userAgent || null,
        authorizationPreview || null,
        clientTokenId || null,
        userId || null,
        userEmail || null,
        username || null,
        requestHeaders ? JSON.stringify(requestHeaders) : null
    ];

    try {
        const [result] = await pool.query(sql, params);
        return result.insertId;
    } catch (error) {
        console.error('[ChannelDispatchLogsDao] Failed to create log:', error.message);
        return null;
    }
}

/**
 * 按渠道类型查询调度日志
 */
export async function findByProviderType(providerType, options = {}) {
    await ensureTable();
    const pool = getPool();
    const { page = 1, pageSize = 20, errorType } = options;
    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = Math.min(parseInt(pageSize, 10) || 20, 100);
    const offset = (pageNum - 1) * pageSizeNum;

    const whereClauses = ['provider_type = ?'];
    const params = [providerType];

    if (errorType) {
        whereClauses.push('error_type = ?');
        params.push(errorType);
    }

    const whereSql = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) as total FROM channel_dispatch_logs WHERE ${whereSql}`;
    const [countRows] = await pool.query(countSql, params);
    const total = countRows[0]?.total || 0;

    const sql = `
        SELECT * FROM channel_dispatch_logs
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT ${pageSizeNum} OFFSET ${offset}
    `;
    const [rows] = await pool.query(sql, [...params]);

    return {
        data: rows,
        total,
        page: pageNum,
        pageSize: pageSizeNum,
        totalPages: Math.ceil(total / pageSizeNum)
    };
}

/**
 * 按渠道类型统计调度日志
 */
export async function countByProviderType(providerType) {
    await ensureTable();
    const pool = getPool();
    const sql = 'SELECT COUNT(*) as total FROM channel_dispatch_logs WHERE provider_type = ?';
    const [rows] = await pool.query(sql, [providerType]);
    return rows[0]?.total || 0;
}

/**
 * 按渠道类型删除调度日志
 */
export async function deleteByProviderType(providerType) {
    await ensureTable();
    const pool = getPool();
    const sql = 'DELETE FROM channel_dispatch_logs WHERE provider_type = ?';
    const [result] = await pool.query(sql, [providerType]);
    return result.affectedRows;
}

/**
 * 清理过期记录
 */
export async function cleanOldRecords(days = 7) {
    await ensureTable();
    const pool = getPool();
    const sql = 'DELETE FROM channel_dispatch_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)';
    const [result] = await pool.query(sql, [days]);
    return result.affectedRows;
}
