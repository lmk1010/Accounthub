/**
 * Provider Status Logs DAO - 账号状态流转记录
 */

import { getPool } from '../config/database.js';

/**
 * 创建状态记录
 */
export async function create(data) {
    const pool = getPool();
    const {
        providerUuid,
        providerType,
        poolId = 0,
        action,
        fromStatus,
        toStatus,
        reason,
        source,
        metadata
    } = data;

    const sql = `
        INSERT INTO provider_status_logs
        (provider_uuid, provider_type, pool_id, action, from_status, to_status, reason, source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        providerUuid,
        providerType,
        poolId || 0,
        action,
        fromStatus || null,
        toStatus || null,
        reason || null,
        source || null,
        metadata ? JSON.stringify(metadata) : null
    ];

    const [result] = await pool.query(sql, params);
    return result.insertId;
}

/**
 * 查询账号状态记录
 */
export async function findByUuid(providerUuid, options = {}) {
    const pool = getPool();
    const { page = 1, pageSize = 20 } = options;
    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 20;
    const offset = (pageNum - 1) * pageSizeNum;

    const sql = `
        SELECT * FROM provider_status_logs
        WHERE provider_uuid = ?
        ORDER BY created_at DESC
        LIMIT ${pageSizeNum} OFFSET ${offset}
    `;
    const [rows] = await pool.query(sql, [providerUuid]);
    return rows.map(row => {
        let metadata = row.metadata;
        if (metadata && typeof metadata === 'string') {
            try {
                metadata = JSON.parse(metadata);
            } catch (error) {
                metadata = row.metadata;
            }
        }
        return {
            ...row,
            metadata
        };
    });
}

/**
 * 统计账号状态记录数量
 */
export async function countByUuid(providerUuid) {
    const pool = getPool();
    const sql = 'SELECT COUNT(*) as total FROM provider_status_logs WHERE provider_uuid = ?';
    const [rows] = await pool.query(sql, [providerUuid]);
    return rows[0]?.total || 0;
}

/**
 * 删除账号的所有状态记录
 */
export async function deleteByUuid(providerUuid) {
    const pool = getPool();
    const sql = 'DELETE FROM provider_status_logs WHERE provider_uuid = ?';
    const [result] = await pool.query(sql, [providerUuid]);
    return result.affectedRows || 0;
}
