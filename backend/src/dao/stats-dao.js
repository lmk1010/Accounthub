/**
 * Stats DAO - 全局统计数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 获取全局统计
 * @returns {Promise<Object>}
 */
export async function getGlobalStats() {
    const pool = getPool();
    try {
        const sql = 'SELECT * FROM global_stats WHERE id = 1';
        const [rows] = await pool.execute(sql);

        if (rows.length === 0) {
            // 如果不存在，返回默认值
            return {
                total_requests: 0,
                successful_requests: 0,
                failed_requests: 0,
                switch_count: 0,
                last_reset_time: 0
            };
        }

        return {
            total_requests: Number(rows[0].total_requests) || 0,
            successful_requests: Number(rows[0].successful_requests) || 0,
            failed_requests: Number(rows[0].failed_requests) || 0,
            switch_count: Number(rows[0].switch_count) || 0,
            last_reset_time: Number(rows[0].last_reset_time) || 0
        };
    } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            return {
                total_requests: 0,
                successful_requests: 0,
                failed_requests: 0,
                switch_count: 0,
                last_reset_time: 0
            };
        }
        throw error;
    }
}

/**
 * 更新全局统计
 * @param {Object} stats - 统计数据
 * @returns {Promise<void>}
 */
export async function updateGlobalStats(stats) {
    const pool = getPool();
    const sql = `
        INSERT INTO global_stats (id, total_requests, successful_requests, failed_requests, switch_count, last_reset_time)
        VALUES (1, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            total_requests = VALUES(total_requests),
            successful_requests = VALUES(successful_requests),
            failed_requests = VALUES(failed_requests),
            switch_count = VALUES(switch_count),
            last_reset_time = VALUES(last_reset_time)
    `;

    await pool.execute(sql, [
        stats.total_requests || 0,
        stats.successful_requests || 0,
        stats.failed_requests || 0,
        stats.switch_count || 0,
        stats.last_reset_time || Date.now()
    ]);
}

/**
 * 增量更新统计字段
 * @param {string} field - 字段名
 * @param {number} increment - 增量值
 * @returns {Promise<void>}
 */
export async function incrementStats(field, increment = 1) {
    const pool = getPool();
    const validFields = ['total_requests', 'successful_requests', 'failed_requests', 'switch_count'];

    if (!validFields.includes(field)) {
        throw new Error(`Invalid field: ${field}`);
    }

    const sql = `
        INSERT INTO global_stats (id, ${field})
        VALUES (1, ?)
        ON DUPLICATE KEY UPDATE ${field} = ${field} + ?
    `;

    await pool.execute(sql, [increment, increment]);
}

/**
 * 重置全局统计
 * @returns {Promise<void>}
 */
export async function resetStats() {
    const pool = getPool();
    const sql = `
        UPDATE global_stats
        SET total_requests = 0,
            successful_requests = 0,
            failed_requests = 0,
            switch_count = 0,
            last_reset_time = ?
        WHERE id = 1
    `;

    await pool.execute(sql, [Date.now()]);
}
