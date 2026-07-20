/**
 * Error DAO - 错误历史数据访问层
 */

import { getPool } from '../config/database.js';

const buildWhere = (options = {}) => {
    let where = 'WHERE 1=1';
    const params = [];

    if (options.providerType) {
        where += ' AND provider_type = ?';
        params.push(options.providerType);
    }

    if (options.statusCode !== undefined && options.statusCode !== null) {
        where += ' AND status_code = ?';
        params.push(options.statusCode);
    } else if (options.statusCodeMin !== undefined && options.statusCodeMin !== null) {
        where += ' AND status_code >= ?';
        params.push(options.statusCodeMin);
        if (options.statusCodeMax !== undefined && options.statusCodeMax !== null) {
            where += ' AND status_code <= ?';
            params.push(options.statusCodeMax);
        }
    }

    return { where, params };
};

/**
 * 创建错误记录
 * @param {Object} error - 错误对象
 * @returns {Promise<void>}
 */
export async function create(error) {
    const pool = getPool();
    const sql = `
        INSERT INTO error_history (
            error_id, provider_uuid, provider_type, custom_name,
            error_message, status_code, model_name, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    await pool.execute(sql, [
        error.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        error.uuid,
        error.providerType,
        error.customName || null,
        error.errorMessage || null,
        error.statusCode || null,
        error.model || null
    ]);
}

/**
 * 查询错误历史
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>}
 */
export async function findAll(options = {}) {
    const pool = getPool();
    const { where, params } = buildWhere(options);
    let sql = `
        SELECT
            id, error_id, provider_uuid, provider_type, custom_name,
            error_message, status_code, model_name, timestamp
        FROM error_history
        ${where}
        ORDER BY timestamp DESC
    `;

    if (options.limit) {
        sql += ' LIMIT ?';
        params.push(parseInt(options.limit));
    }

    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * 分页查询错误历史
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>}
 */
export async function findPaged(options = {}) {
    const pool = getPool();
    const safeLimit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50;
    const safeOffset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0;
    const { where, params } = buildWhere(options);

    const sql = `
        SELECT
            id, error_id, provider_uuid, provider_type, custom_name,
            error_message, status_code, model_name, timestamp
        FROM error_history
        ${where}
        ORDER BY timestamp DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;

    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * 统计错误历史数量
 * @param {Object} options - 查询选项
 * @returns {Promise<number>}
 */
export async function count(options = {}) {
    const pool = getPool();
    const { where, params } = buildWhere(options);
    const sql = `
        SELECT COUNT(*) AS total
        FROM error_history
        ${where}
    `;
    const [rows] = await pool.execute(sql, params);
    return Number(rows?.[0]?.total || 0);
}

/**
 * 清空错误历史
 * @returns {Promise<void>}
 */
export async function clear() {
    const pool = getPool();
    const sql = 'DELETE FROM error_history';
    await pool.execute(sql);
}

/**
 * 清理旧记录（保留最近N条）
 * @param {number} keepCount - 保留记录数（默认100）
 * @returns {Promise<void>}
 */
export async function cleanup(keepCount = 100) {
    const pool = getPool();
    const sql = `
        DELETE FROM error_history
        WHERE id NOT IN (
            SELECT id FROM (
                SELECT id FROM error_history
                ORDER BY timestamp DESC
                LIMIT ?
            ) AS keep_records
        )
    `;
    await pool.execute(sql, [keepCount]);
}
