/**
 * Pool Config DAO - 号池配置数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 解析 JSON 字段
 */
function parseJsonField(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value;
}

/**
 * 获取所有号池配置
 */
export async function getAllPoolConfigs() {
    const pool = getPool();
    if (!pool) return [];

    const [rows] = await pool.query(
        `SELECT id, provider_type, name, is_default,
                supported_models, not_supported_models,
                user_max_concurrency, account_max_concurrency,
                enable_user_concurrency_limit, enable_account_concurrency_limit,
                provider_max_concurrency, provider_account_max_concurrency,
                enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
                enable_session_limit, max_sessions_per_account,
                created_at, updated_at
         FROM provider_pools
         ORDER BY provider_type, id`
    );

    return rows.map(row => ({
        id: row.id,
        providerType: row.provider_type,
        name: row.name,
        isDefault: !!row.is_default,
        supportedModels: parseJsonField(row.supported_models),
        notSupportedModels: parseJsonField(row.not_supported_models),
        userMaxConcurrency: row.user_max_concurrency || 0,
        accountMaxConcurrency: row.account_max_concurrency || 0,
        enableUserConcurrencyLimit: !!row.enable_user_concurrency_limit,
        enableAccountConcurrencyLimit: !!row.enable_account_concurrency_limit,
        providerMaxConcurrency: row.provider_max_concurrency || 0,
        providerAccountMaxConcurrency: row.provider_account_max_concurrency || 0,
        enableProviderConcurrencyLimit: !!row.enable_provider_concurrency_limit,
        enableProviderAccountConcurrencyLimit: !!row.enable_provider_account_concurrency_limit,
        enableSessionLimit: !!row.enable_session_limit,
        maxSessionsPerAccount: row.max_sessions_per_account || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

/**
 * 根据提供商类型获取号池配置
 */
export async function getPoolConfigsByProviderType(providerType) {
    const pool = getPool();
    if (!pool) return [];

    const [rows] = await pool.query(
        `SELECT id, provider_type, name, is_default,
                supported_models, not_supported_models,
                user_max_concurrency, account_max_concurrency,
                enable_user_concurrency_limit, enable_account_concurrency_limit,
                provider_max_concurrency, provider_account_max_concurrency,
                enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
                enable_session_limit, max_sessions_per_account,
                created_at, updated_at
         FROM provider_pools
         WHERE provider_type = ?
         ORDER BY id`,
        [providerType]
    );

    return rows.map(row => ({
        id: row.id,
        providerType: row.provider_type,
        name: row.name,
        isDefault: !!row.is_default,
        supportedModels: parseJsonField(row.supported_models),
        notSupportedModels: parseJsonField(row.not_supported_models),
        userMaxConcurrency: row.user_max_concurrency || 0,
        accountMaxConcurrency: row.account_max_concurrency || 0,
        enableUserConcurrencyLimit: !!row.enable_user_concurrency_limit,
        enableAccountConcurrencyLimit: !!row.enable_account_concurrency_limit,
        providerMaxConcurrency: row.provider_max_concurrency || 0,
        providerAccountMaxConcurrency: row.provider_account_max_concurrency || 0,
        enableProviderConcurrencyLimit: !!row.enable_provider_concurrency_limit,
        enableProviderAccountConcurrencyLimit: !!row.enable_provider_account_concurrency_limit,
        enableSessionLimit: !!row.enable_session_limit,
        maxSessionsPerAccount: row.max_sessions_per_account || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

/**
 * 根据 ID 获取号池配置
 */
export async function getPoolConfigById(id) {
    const pool = getPool();
    if (!pool) return null;

    const [rows] = await pool.query(
        `SELECT id, provider_type, name, is_default,
                supported_models, not_supported_models,
                user_max_concurrency, account_max_concurrency,
                enable_user_concurrency_limit, enable_account_concurrency_limit,
                provider_max_concurrency, provider_account_max_concurrency,
                enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
                enable_session_limit, max_sessions_per_account,
                created_at, updated_at
         FROM provider_pools
         WHERE id = ?`,
        [id]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        id: row.id,
        providerType: row.provider_type,
        name: row.name,
        isDefault: !!row.is_default,
        supportedModels: parseJsonField(row.supported_models),
        notSupportedModels: parseJsonField(row.not_supported_models),
        userMaxConcurrency: row.user_max_concurrency || 0,
        accountMaxConcurrency: row.account_max_concurrency || 0,
        enableUserConcurrencyLimit: !!row.enable_user_concurrency_limit,
        enableAccountConcurrencyLimit: !!row.enable_account_concurrency_limit,
        providerMaxConcurrency: row.provider_max_concurrency || 0,
        providerAccountMaxConcurrency: row.provider_account_max_concurrency || 0,
        enableProviderConcurrencyLimit: !!row.enable_provider_concurrency_limit,
        enableProviderAccountConcurrencyLimit: !!row.enable_provider_account_concurrency_limit,
        enableSessionLimit: !!row.enable_session_limit,
        maxSessionsPerAccount: row.max_sessions_per_account || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * 创建号池配置
 */
export async function createPoolConfig(config) {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const [result] = await pool.query(
        `INSERT INTO provider_pools
         (provider_type, name, is_default, supported_models, not_supported_models,
          user_max_concurrency, account_max_concurrency,
          enable_user_concurrency_limit, enable_account_concurrency_limit,
          provider_max_concurrency, provider_account_max_concurrency,
          enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
          enable_session_limit, max_sessions_per_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            config.providerType,
            config.name,
            config.isDefault || false,
            config.supportedModels ? JSON.stringify(config.supportedModels) : null,
            config.notSupportedModels ? JSON.stringify(config.notSupportedModels) : null,
            config.userMaxConcurrency || 0,
            config.accountMaxConcurrency || 0,
            config.enableUserConcurrencyLimit || false,
            config.enableAccountConcurrencyLimit || false,
            config.providerMaxConcurrency || 0,
            config.providerAccountMaxConcurrency || 0,
            config.enableProviderConcurrencyLimit || false,
            config.enableProviderAccountConcurrencyLimit || false,
            config.enableSessionLimit || false,
            config.maxSessionsPerAccount || 0
        ]
    );

    return result.insertId;
}

/**
 * 更新号池配置
 */
export async function updatePoolConfig(id, config) {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const updates = [];
    const params = [];

    if (config.name !== undefined) {
        updates.push('name = ?');
        params.push(config.name);
    }
    if (config.isDefault !== undefined) {
        updates.push('is_default = ?');
        params.push(config.isDefault);
    }
    if (config.supportedModels !== undefined) {
        updates.push('supported_models = ?');
        params.push(config.supportedModels ? JSON.stringify(config.supportedModels) : null);
    }
    if (config.notSupportedModels !== undefined) {
        updates.push('not_supported_models = ?');
        params.push(config.notSupportedModels ? JSON.stringify(config.notSupportedModels) : null);
    }
    if (config.userMaxConcurrency !== undefined) {
        updates.push('user_max_concurrency = ?');
        params.push(config.userMaxConcurrency);
    }
    if (config.accountMaxConcurrency !== undefined) {
        updates.push('account_max_concurrency = ?');
        params.push(config.accountMaxConcurrency);
    }
    if (config.enableUserConcurrencyLimit !== undefined) {
        updates.push('enable_user_concurrency_limit = ?');
        params.push(config.enableUserConcurrencyLimit);
    }
    if (config.enableAccountConcurrencyLimit !== undefined) {
        updates.push('enable_account_concurrency_limit = ?');
        params.push(config.enableAccountConcurrencyLimit);
    }
    // 代理商并发控制字段
    if (config.providerMaxConcurrency !== undefined) {
        updates.push('provider_max_concurrency = ?');
        params.push(config.providerMaxConcurrency);
    }
    if (config.providerAccountMaxConcurrency !== undefined) {
        updates.push('provider_account_max_concurrency = ?');
        params.push(config.providerAccountMaxConcurrency);
    }
    if (config.enableProviderConcurrencyLimit !== undefined) {
        updates.push('enable_provider_concurrency_limit = ?');
        params.push(config.enableProviderConcurrencyLimit);
    }
    if (config.enableProviderAccountConcurrencyLimit !== undefined) {
        updates.push('enable_provider_account_concurrency_limit = ?');
        params.push(config.enableProviderAccountConcurrencyLimit);
    }
    // Session 并发控制字段
    if (config.enableSessionLimit !== undefined) {
        updates.push('enable_session_limit = ?');
        params.push(config.enableSessionLimit);
    }
    if (config.maxSessionsPerAccount !== undefined) {
        updates.push('max_sessions_per_account = ?');
        params.push(config.maxSessionsPerAccount);
    }

    if (updates.length === 0) return false;

    params.push(id);
    const [result] = await pool.query(
        `UPDATE provider_pools SET ${updates.join(', ')} WHERE id = ?`,
        params
    );

    return result.affectedRows > 0;
}

/**
 * 删除号池配置
 */
export async function deletePoolConfig(id) {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const [result] = await pool.query(
        'DELETE FROM provider_pools WHERE id = ?',
        [id]
    );

    return result.affectedRows > 0;
}

/**
 * 检查模型是否被号池支持
 */
export function isModelSupportedByPool(poolConfig, model) {
    if (!poolConfig || !model) return true;

    // 黑名单优先：如果在不支持列表中，返回 false
    if (poolConfig.notSupportedModels?.length > 0) {
        if (poolConfig.notSupportedModels.includes(model)) {
            return false;
        }
    }

    // 白名单：如果设置了支持列表，必须在列表中
    if (poolConfig.supportedModels?.length > 0) {
        return poolConfig.supportedModels.includes(model);
    }

    // 默认支持所有模型
    return true;
}
