/**
 * API Potluck DAO
 * 管理 API Potluck 相关的数据库操作
 */

import { getPool } from '../config/database.js';

// ============ 配置管理 ============

/**
 * 获取 API Potluck 配置
 * @returns {Promise<Object>}
 */
export async function getConfig() {
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT * FROM api_potluck_config WHERE id = 1'
    );

    if (rows.length === 0) {
        // 返回默认配置
        return {
            default_daily_limit: 500,
            bonus_per_credential: 300,
            bonus_validity_days: 30,
            persist_interval: 5000
        };
    }

    return rows[0];
}

/**
 * 更新 API Potluck 配置
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>}
 */
export async function updateConfig(config) {
    const pool = getPool();
    const updates = [];
    const params = [];

    if (config.defaultDailyLimit !== undefined) {
        updates.push('default_daily_limit = ?');
        params.push(config.defaultDailyLimit);
    }
    if (config.bonusPerCredential !== undefined) {
        updates.push('bonus_per_credential = ?');
        params.push(config.bonusPerCredential);
    }
    if (config.bonusValidityDays !== undefined) {
        updates.push('bonus_validity_days = ?');
        params.push(config.bonusValidityDays);
    }
    if (config.persistInterval !== undefined) {
        updates.push('persist_interval = ?');
        params.push(config.persistInterval);
    }

    if (updates.length === 0) {
        return await getConfig();
    }

    await pool.query(
        `UPDATE api_potluck_config SET ${updates.join(', ')} WHERE id = 1`,
        params
    );

    return await getConfig();
}

// ============ 用户管理 ============

/**
 * 确保用户存在
 * @param {string} apiKey - 用户的 API Key
 * @returns {Promise<void>}
 */
export async function ensureUser(apiKey) {
    const pool = getPool();
    await pool.query(
        `INSERT IGNORE INTO api_potluck_users (api_key, created_at) VALUES (?, NOW())`,
        [apiKey]
    );
}

/**
 * 获取用户信息
 * @param {string} apiKey - 用户的 API Key
 * @returns {Promise<Object|null>}
 */
export async function getUser(apiKey) {
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT * FROM api_potluck_users WHERE api_key = ?',
        [apiKey]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * 获取所有用户的 API Key 列表
 * @returns {Promise<string[]>}
 */
export async function getAllUserApiKeys() {
    const pool = getPool();
    const [rows] = await pool.query('SELECT api_key FROM api_potluck_users');
    return rows.map(row => row.api_key);
}

// ============ 凭据管理 ============

/**
 * 添加用户凭据
 * @param {string} apiKey - 用户的 API Key
 * @param {Object} credentialInfo - 凭据信息
 * @returns {Promise<Object>}
 */
export async function addUserCredential(apiKey, credentialInfo) {
    const pool = getPool();
    await ensureUser(apiKey);

    const credential = {
        credential_id: credentialInfo.id || `cred_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        api_key: apiKey,
        credential_path: credentialInfo.path,
        provider: credentialInfo.provider || 'claude-kiro-oauth',
        auth_method: credentialInfo.authMethod || 'unknown',
        added_at: credentialInfo.addedAt || new Date()
    };

    await pool.query(
        `INSERT INTO api_potluck_user_credentials
        (credential_id, api_key, credential_path, provider, auth_method, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        provider = VALUES(provider),
        auth_method = VALUES(auth_method)`,
        [credential.credential_id, credential.api_key, credential.credential_path,
         credential.provider, credential.auth_method, credential.added_at]
    );

    return credential;
}

/**
 * 获取用户的所有凭据
 * @param {string} apiKey - 用户的 API Key
 * @returns {Promise<Array>}
 */
export async function getUserCredentials(apiKey) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT credential_id as id, credential_path as path, provider,
         auth_method as authMethod, added_at as addedAt
         FROM api_potluck_user_credentials
         WHERE api_key = ?`,
        [apiKey]
    );
    return rows;
}

/**
 * 移除用户凭据
 * @param {string} apiKey - 用户的 API Key
 * @param {string} credentialId - 凭据 ID
 * @returns {Promise<boolean>}
 */
export async function removeUserCredential(apiKey, credentialId) {
    const pool = getPool();
    const [result] = await pool.query(
        'DELETE FROM api_potluck_user_credentials WHERE api_key = ? AND credential_id = ?',
        [apiKey, credentialId]
    );
    return result.affectedRows > 0;
}

/**
 * 通过路径查找凭据
 * @param {string} apiKey - 用户的 API Key
 * @param {string} credPath - 凭据文件路径
 * @returns {Promise<Object|null>}
 */
export async function findCredentialByPath(apiKey, credPath) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT credential_id as id, credential_path as path, provider,
         auth_method as authMethod, added_at as addedAt
         FROM api_potluck_user_credentials
         WHERE api_key = ? AND credential_path = ?`,
        [apiKey, credPath]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * 检查凭据路径是否已被任何用户使用
 * @param {string} credPath - 凭据文件路径
 * @returns {Promise<{exists: boolean, apiKey?: string}>}
 */
export async function isCredentialPathUsed(credPath) {
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT api_key FROM api_potluck_user_credentials WHERE credential_path = ? LIMIT 1',
        [credPath]
    );
    if (rows.length > 0) {
        return { exists: true, apiKey: rows[0].api_key };
    }
    return { exists: false };
}

/**
 * 获取所有用户及其凭据（用于批量健康检查）
 * @returns {Promise<Array<{apiKey: string, credentials: Array}>>}
 */
export async function getAllUsersCredentials() {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT api_key, credential_id as id, credential_path as path,
         provider, auth_method as authMethod, added_at as addedAt
         FROM api_potluck_user_credentials
         ORDER BY api_key`
    );

    // 按 apiKey 分组
    const result = [];
    let currentApiKey = null;
    let currentCredentials = [];

    for (const row of rows) {
        if (row.api_key !== currentApiKey) {
            if (currentApiKey !== null) {
                result.push({
                    apiKey: currentApiKey,
                    credentials: currentCredentials
                });
            }
            currentApiKey = row.api_key;
            currentCredentials = [];
        }
        currentCredentials.push({
            id: row.id,
            path: row.path,
            provider: row.provider,
            authMethod: row.authMethod,
            addedAt: row.addedAt
        });
    }

    if (currentApiKey !== null) {
        result.push({
            apiKey: currentApiKey,
            credentials: currentCredentials
        });
    }

    return result;
}

// ============ 资源包管理 ============

/**
 * 添加凭据资源包
 * @param {string} apiKey - 用户的 API Key
 * @param {string} credentialId - 凭据 ID
 * @param {string} grantedAt - 授予时间
 * @returns {Promise<Object>}
 */
export async function addCredentialBonus(apiKey, credentialId, grantedAt) {
    const pool = getPool();
    await ensureUser(apiKey);

    await pool.query(
        `INSERT INTO api_potluck_credential_bonuses
        (api_key, credential_id, granted_at, used_count)
        VALUES (?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE granted_at = granted_at`,
        [apiKey, credentialId, grantedAt]
    );

    const [rows] = await pool.query(
        'SELECT * FROM api_potluck_credential_bonuses WHERE api_key = ? AND credential_id = ?',
        [apiKey, credentialId]
    );

    return rows[0];
}

/**
 * 移除凭据资源包
 * @param {string} apiKey - 用户的 API Key
 * @param {string} credentialId - 凭据 ID
 * @returns {Promise<boolean>}
 */
export async function removeCredentialBonus(apiKey, credentialId) {
    const pool = getPool();
    const [result] = await pool.query(
        'DELETE FROM api_potluck_credential_bonuses WHERE api_key = ? AND credential_id = ?',
        [apiKey, credentialId]
    );
    return result.affectedRows > 0;
}

/**
 * 获取用户的所有资源包
 * @param {string} apiKey - 用户的 API Key
 * @returns {Promise<Array>}
 */
export async function getUserBonuses(apiKey) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT credential_id as credentialId, granted_at as grantedAt, used_count as usedCount
         FROM api_potluck_credential_bonuses
         WHERE api_key = ?`,
        [apiKey]
    );
    return rows;
}

/**
 * 消耗资源包次数（FIFO 顺序）
 * @param {string} apiKey - 用户的 API Key
 * @param {number} bonusPerCredential - 每个凭据的资源包次数
 * @param {number} bonusValidityDays - 资源包有效期（天）
 * @returns {Promise<boolean>}
 */
export async function consumeBonus(apiKey, bonusPerCredential, bonusValidityDays) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 计算过期时间
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() - bonusValidityDays);

        // 查找第一个有剩余次数且未过期的资源包（FIFO）
        const [rows] = await connection.query(
            `SELECT id, used_count
             FROM api_potluck_credential_bonuses
             WHERE api_key = ? AND granted_at > ? AND used_count < ?
             ORDER BY granted_at ASC
             LIMIT 1
             FOR UPDATE`,
            [apiKey, expiryDate, bonusPerCredential]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return false;
        }

        // 增加使用次数
        await connection.query(
            'UPDATE api_potluck_credential_bonuses SET used_count = used_count + 1 WHERE id = ?',
            [rows[0].id]
        );

        await connection.commit();
        return true;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * 计算用户的剩余资源包总次数
 * @param {string} apiKey - 用户的 API Key
 * @param {number} bonusPerCredential - 每个凭据的资源包次数
 * @param {number} bonusValidityDays - 资源包有效期（天）
 * @param {Set<string>} healthyCredentialIds - 健康凭证 ID 集合（可选）
 * @returns {Promise<number>}
 */
export async function calculateBonusRemaining(apiKey, bonusPerCredential, bonusValidityDays, healthyCredentialIds = null) {
    const pool = getPool();

    // 计算过期时间
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - bonusValidityDays);

    let query = `
        SELECT SUM(? - used_count) as total
        FROM api_potluck_credential_bonuses
        WHERE api_key = ? AND granted_at > ? AND used_count < ?
    `;
    const params = [bonusPerCredential, apiKey, expiryDate, bonusPerCredential];

    // 如果提供了健康凭证集合，添加过滤条件
    if (healthyCredentialIds && healthyCredentialIds.size > 0) {
        const ids = Array.from(healthyCredentialIds);
        const placeholders = ids.map(() => '?').join(',');
        query += ` AND credential_id IN (${placeholders})`;
        params.push(...ids);
    }

    const [rows] = await pool.query(query, params);
    return rows[0].total || 0;
}

/**
 * 同步资源包状态（根据健康凭证列表）
 * @param {string} apiKey - 用户的 API Key
 * @param {Array<{id: string, isHealthy: boolean, addedAt?: string}>} credentialsWithHealth - 带健康状态的凭证列表
 * @param {number} bonusPerCredential - 每个凭据的资源包次数
 * @param {number} bonusValidityDays - 资源包有效期（天）
 * @returns {Promise<{added: number, removed: number, bonusRemaining: number}>}
 */
export async function syncCredentialBonuses(apiKey, credentialsWithHealth, bonusPerCredential, bonusValidityDays) {
    const pool = getPool();
    await ensureUser(apiKey);

    let added = 0, removed = 0;

    // 获取健康凭证 ID 集合
    const healthyIds = new Set(
        credentialsWithHealth
            .filter(c => c.isHealthy === true)
            .map(c => c.id)
    );

    // 为新的健康凭证添加资源包
    for (const cred of credentialsWithHealth) {
        if (cred.isHealthy !== true) continue;

        const grantedAt = cred.addedAt || new Date();
        const [result] = await pool.query(
            `INSERT INTO api_potluck_credential_bonuses
            (api_key, credential_id, granted_at, used_count)
            VALUES (?, ?, ?, 0)
            ON DUPLICATE KEY UPDATE id = id`,
            [apiKey, cred.id, grantedAt]
        );

        if (result.affectedRows > 0) {
            added++;
        }
    }

    // 移除失效凭证的资源包
    if (healthyIds.size > 0) {
        const ids = Array.from(healthyIds);
        const placeholders = ids.map(() => '?').join(',');
        const [result] = await pool.query(
            `DELETE FROM api_potluck_credential_bonuses
             WHERE api_key = ? AND credential_id NOT IN (${placeholders})`,
            [apiKey, ...ids]
        );
        removed = result.affectedRows;
    } else {
        // 如果没有健康凭证，删除所有资源包
        const [result] = await pool.query(
            'DELETE FROM api_potluck_credential_bonuses WHERE api_key = ?',
            [apiKey]
        );
        removed = result.affectedRows;
    }

    // 清理过期资源包
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - bonusValidityDays);
    await pool.query(
        'DELETE FROM api_potluck_credential_bonuses WHERE api_key = ? AND granted_at <= ?',
        [apiKey, expiryDate]
    );

    // 计算剩余资源包次数
    const bonusRemaining = await calculateBonusRemaining(apiKey, bonusPerCredential, bonusValidityDays, healthyIds);

    return { added, removed, bonusRemaining };
}
