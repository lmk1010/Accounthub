/**
 * Consumption DAO - 消耗统计数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 获取所有消耗统计
 * @returns {Promise<Array>}
 */
export async function getAll() {
    const pool = getPool();
    const sql = `
        SELECT
            id, provider_uuid, provider_type, custom_name,
            credits_used, cost, last_update
        FROM consumption_stats
        ORDER BY provider_type, custom_name
    `;
    const [rows] = await pool.execute(sql);
    return rows.map(row => ({
        ...row,
        credits_used: Number(row.credits_used),
        cost: Number(row.cost)
    }));
}

/**
 * 根据 UUID 获取消耗统计
 * @param {string} uuid - 账号 UUID
 * @returns {Promise<Object|null>}
 */
export async function getByUuid(uuid) {
    const pool = getPool();
    const sql = 'SELECT * FROM consumption_stats WHERE provider_uuid = ?';
    const [rows] = await pool.execute(sql, [uuid]);

    if (rows.length === 0) {
        return null;
    }

    return {
        ...rows[0],
        credits_used: Number(rows[0].credits_used),
        cost: Number(rows[0].cost)
    };
}

/**
 * 更新消耗统计
 * @param {string} uuid - 账号 UUID
 * @param {Object} stats - 统计数据
 * @returns {Promise<void>}
 */
export async function update(uuid, stats) {
    const pool = getPool();
    const sql = `
        INSERT INTO consumption_stats (
            provider_uuid, provider_type, custom_name, credits_used, cost
        ) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            provider_type = VALUES(provider_type),
            custom_name = VALUES(custom_name),
            credits_used = VALUES(credits_used),
            cost = VALUES(cost),
            last_update = NOW()
    `;

    await pool.execute(sql, [
        uuid,
        stats.provider_type,
        stats.custom_name || null,
        stats.credits_used || 0,
        stats.cost || 0
    ]);
}

/**
 * 获取元数据
 * @returns {Promise<Object>}
 */
export async function getMeta() {
    const pool = getPool();
    const sql = 'SELECT * FROM consumption_meta WHERE id = 1';
    const [rows] = await pool.execute(sql);

    if (rows.length === 0) {
        return {
            start_time: null,
            last_update_time: null,
            last_sync_time: null
        };
    }

    return rows[0];
}

/**
 * 更新元数据
 * @param {Object} meta - 元数据
 * @returns {Promise<void>}
 */
export async function updateMeta(meta) {
    const pool = getPool();
    const sql = `
        INSERT INTO consumption_meta (id, start_time, last_update_time, last_sync_time)
        VALUES (1, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            start_time = VALUES(start_time),
            last_update_time = VALUES(last_update_time),
            last_sync_time = VALUES(last_sync_time)
    `;

    await pool.execute(sql, [
        meta.start_time || null,
        meta.last_update_time || null,
        meta.last_sync_time || null
    ]);
}
