/**
 * Channel Config DAO - 渠道配置数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 获取渠道配置
 */
export async function getByProviderType(providerType) {
    const pool = getPool();
    if (!pool) return null;

    const [rows] = await pool.query(
        `SELECT id, provider_type, default_model, config, created_at, updated_at
         FROM channel_configs WHERE provider_type = ?`,
        [providerType]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        id: row.id,
        providerType: row.provider_type,
        defaultModel: row.default_model,
        config: row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : {},
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * 保存或更新渠道配置
 */
export async function upsert(providerType, data) {
    const pool = getPool();
    if (!pool) return null;

    const { defaultModel, config } = data;
    const configJson = config ? JSON.stringify(config) : null;

    await pool.query(
        `INSERT INTO channel_configs (provider_type, default_model, config)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
         default_model = VALUES(default_model),
         config = VALUES(config),
         updated_at = NOW()`,
        [providerType, defaultModel || null, configJson]
    );

    return await getByProviderType(providerType);
}

/**
 * 获取所有渠道配置
 */
export async function getAll() {
    const pool = getPool();
    if (!pool) return [];

    const [rows] = await pool.query(
        `SELECT id, provider_type, default_model, config, created_at, updated_at
         FROM channel_configs ORDER BY provider_type`
    );

    return rows.map(row => ({
        id: row.id,
        providerType: row.provider_type,
        defaultModel: row.default_model,
        config: row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : {},
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}
