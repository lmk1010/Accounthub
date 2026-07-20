/**
 * Provider Error Logs DAO - 账号错误历史数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 创建错误记录
 */
export async function create(data) {
    const pool = getPool();
    const {
        providerUuid, providerType, poolId = 0,
        requestModel, errorCode, errorType, errorMessage, requestId
    } = data;

    const sql = `
        INSERT INTO provider_error_logs
        (provider_uuid, provider_type, pool_id, request_model, error_code, error_type, error_message, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        providerUuid, providerType, poolId || 0,
        requestModel || null, errorCode || null, errorType || null,
        errorMessage || null, requestId || null
    ];

    const [result] = await pool.query(sql, params);
    return result.insertId;
}

/**
 * 查询账号错误历史
 */
export async function findByUuid(providerUuid, options = {}) {
    const pool = getPool();
    const { page = 1, pageSize = 20 } = options;
    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 20;
    const offset = (pageNum - 1) * pageSizeNum;

    const sql = `
        SELECT * FROM provider_error_logs
        WHERE provider_uuid = ?
        ORDER BY created_at DESC
        LIMIT ${pageSizeNum} OFFSET ${offset}
    `;
    const [rows] = await pool.query(sql, [providerUuid]);
    return rows;
}

/**
 * 统计账号错误数量
 */
export async function countByUuid(providerUuid) {
    const pool = getPool();
    const sql = 'SELECT COUNT(*) as total FROM provider_error_logs WHERE provider_uuid = ?';
    const [rows] = await pool.query(sql, [providerUuid]);
    return rows[0]?.total || 0;
}

/**
 * 删除账号的所有错误记录
 */
export async function deleteByUuid(providerUuid) {
    const pool = getPool();
    const sql = 'DELETE FROM provider_error_logs WHERE provider_uuid = ?';
    const [result] = await pool.query(sql, [providerUuid]);
    return result.affectedRows;
}

/**
 * 更新请求日志中的账号UUID
 */
export async function updateProviderUuid(oldUuid, newUuid) {
    const pool = getPool();
    const sql = 'UPDATE provider_error_logs SET provider_uuid = ? WHERE provider_uuid = ?';
    const [result] = await pool.query(sql, [newUuid, oldUuid]);
    return result.affectedRows;
}

/**
 * 清理过期记录（保留最近N天）
 */
export async function cleanOldRecords(days = 30) {
    const pool = getPool();
    const sql = 'DELETE FROM provider_error_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)';
    const [result] = await pool.query(sql, [days]);
    return result.affectedRows;
}

/**
 * 查询最近错误记录
 */
export async function findRecent(options = {}) {
    const pool = getPool();
    const { limit = 20, startDate } = options;
    const whereClauses = [];
    const params = [];

    if (startDate) {
        whereClauses.push('created_at >= ?');
        params.push(startDate);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;

    const sql = `
        SELECT id, provider_uuid, provider_type, pool_id, request_model,
               error_code, error_type, error_message, request_id, created_at
        FROM provider_error_logs
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ?
    `;
    params.push(safeLimit);
    const [rows] = await pool.query(sql, params);
    return rows;
}
