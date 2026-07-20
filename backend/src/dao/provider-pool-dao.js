/**
 * Provider Pool DAO - 池子数据访问层
 */

import { getPool } from '../config/database.js';

let hasProxyNodeIdsColumnCache = null;
let hasCodexHighConcurrencyUserIdsColumnCache = null;

function parseJsonArray(value) {
    if (!value) return null;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

function normalizeProxyNodeIds(value) {
    const parsed = parseJsonArray(value);
    if (!parsed || parsed.length === 0) return [];
    const normalized = parsed
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isFinite(item) && item > 0);
    return Array.from(new Set(normalized));
}

function normalizeIdentityList(value) {
    const parsed = parseJsonArray(value);
    const source = parsed || (typeof value === 'string' ? value.split(/[\s,;，；]+/) : []);
    return Array.from(new Set(
        source
            .map(item => String(item || '').trim())
            .filter(Boolean)
    ));
}

async function hasProxyNodeIdsColumn() {
    if (hasProxyNodeIdsColumnCache !== null) {
        return hasProxyNodeIdsColumnCache;
    }
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'provider_pools'
           AND COLUMN_NAME = 'proxy_node_ids'`
    );
    hasProxyNodeIdsColumnCache = Number(rows?.[0]?.count || 0) > 0;
    return hasProxyNodeIdsColumnCache;
}

async function ensureProxyNodeIdsColumn() {
    const exists = await hasProxyNodeIdsColumn();
    if (exists) return;
    const pool = getPool();
    await pool.execute(`
        ALTER TABLE provider_pools
        ADD COLUMN proxy_node_ids LONGTEXT NULL COMMENT '池子绑定的代理节点ID列表(JSON数组)'
    `);
    hasProxyNodeIdsColumnCache = true;
}

async function hasCodexHighConcurrencyUserIdsColumn() {
    if (hasCodexHighConcurrencyUserIdsColumnCache !== null) {
        return hasCodexHighConcurrencyUserIdsColumnCache;
    }
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'provider_pools'
           AND COLUMN_NAME = 'codex_high_concurrency_user_ids'`
    );
    hasCodexHighConcurrencyUserIdsColumnCache = Number(rows?.[0]?.count || 0) > 0;
    return hasCodexHighConcurrencyUserIdsColumnCache;
}

async function ensureCodexHighConcurrencyUserIdsColumn() {
    const exists = await hasCodexHighConcurrencyUserIdsColumn();
    if (exists) return;
    const pool = getPool();
    await pool.execute(`
        ALTER TABLE provider_pools
        ADD COLUMN codex_high_concurrency_user_ids LONGTEXT NULL COMMENT 'Codex池子高并发用户身份列表(JSON数组)'
    `);
    hasCodexHighConcurrencyUserIdsColumnCache = true;
}

function normalizePoolRow(row) {
    if (!row) return row;
    return {
        ...row,
        id: Number(row.id),
        is_default: Boolean(row.is_default),
        is_enabled: row.is_enabled === undefined ? true : Boolean(row.is_enabled),
        use_proxy: Boolean(row.use_proxy),
        proxy_node_ids: normalizeProxyNodeIds(row.proxy_node_ids),
        codex_high_concurrency_user_ids: normalizeIdentityList(row.codex_high_concurrency_user_ids),
        strategy: row.strategy || 'round-robin',
        supported_models: row.supported_models ? (typeof row.supported_models === 'string' ? JSON.parse(row.supported_models) : row.supported_models) : null,
        not_supported_models: row.not_supported_models ? (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) : null,
        // 并发控制字段
        user_max_concurrency: row.user_max_concurrency || 0,
        account_max_concurrency: row.account_max_concurrency || 0,
        enable_user_concurrency_limit: Boolean(row.enable_user_concurrency_limit),
        enable_account_concurrency_limit: Boolean(row.enable_account_concurrency_limit),
        // 代理商并发控制字段
        provider_max_concurrency: row.provider_max_concurrency || 0,
        provider_account_max_concurrency: row.provider_account_max_concurrency || 0,
        enable_provider_concurrency_limit: Boolean(row.enable_provider_concurrency_limit),
        enable_provider_account_concurrency_limit: Boolean(row.enable_provider_account_concurrency_limit),
        // Session 并发控制字段
        enable_session_limit: Boolean(row.enable_session_limit),
        max_sessions_per_account: row.max_sessions_per_account || 0,
        // 健康检测开关
        enable_health_check: row.enable_health_check === undefined ? true : Boolean(row.enable_health_check)
    };
}

export async function findByType(providerType) {
    const pool = getPool();
    const includeProxyNodeIds = await hasProxyNodeIdsColumn();
    const includeCodexHighConcurrencyUserIds = await hasCodexHighConcurrencyUserIdsColumn();
    const sql = `
        SELECT id, provider_type, name, is_default, is_enabled, use_proxy, strategy,
               ${includeProxyNodeIds ? 'proxy_node_ids,' : ''}
               ${includeCodexHighConcurrencyUserIds ? 'codex_high_concurrency_user_ids,' : ''}
               supported_models, not_supported_models, enable_health_check,
               user_max_concurrency, account_max_concurrency,
               enable_user_concurrency_limit, enable_account_concurrency_limit,
               provider_max_concurrency, provider_account_max_concurrency,
               enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
               enable_session_limit, max_sessions_per_account,
               created_at, updated_at
        FROM provider_pools
        WHERE provider_type = ?
        ORDER BY is_default DESC, id ASC
    `;
    const [rows] = await pool.execute(sql, [providerType]);
    return rows.map(normalizePoolRow);
}

export async function findAll() {
    const pool = getPool();
    const includeProxyNodeIds = await hasProxyNodeIdsColumn();
    const includeCodexHighConcurrencyUserIds = await hasCodexHighConcurrencyUserIdsColumn();
    const sql = `
        SELECT id, provider_type, name, is_default, is_enabled, use_proxy, strategy,
               ${includeProxyNodeIds ? 'proxy_node_ids,' : ''}
               ${includeCodexHighConcurrencyUserIds ? 'codex_high_concurrency_user_ids,' : ''}
               supported_models, not_supported_models, enable_health_check,
               user_max_concurrency, account_max_concurrency,
               enable_user_concurrency_limit, enable_account_concurrency_limit,
               provider_max_concurrency, provider_account_max_concurrency,
               enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
               enable_session_limit, max_sessions_per_account,
               created_at, updated_at
        FROM provider_pools
        ORDER BY provider_type, is_default DESC, id ASC
    `;
    const [rows] = await pool.execute(sql);
    return rows.map(normalizePoolRow);
}

export async function create({ providerType, name, isDefault = false, isEnabled = true, useProxy = false, strategy = 'round-robin' }) {
    const pool = getPool();
    const includeProxyNodeIds = await hasProxyNodeIdsColumn();
    const fields = ['provider_type', 'name', 'is_default', 'is_enabled', 'use_proxy', 'strategy'];
    const params = [providerType, name, isDefault ? 1 : 0, isEnabled ? 1 : 0, useProxy ? 1 : 0, strategy];
    if (includeProxyNodeIds) {
        fields.push('proxy_node_ids');
        params.push(null);
    }
    const sql = `
        INSERT INTO provider_pools (${fields.join(', ')})
        VALUES (${fields.map(() => '?').join(', ')})
    `;
    const [result] = await pool.execute(sql, params);
    return result.insertId;
}

export async function update(id, updates = {}) {
    const pool = getPool();
    const fields = [];
    const params = [];

    if (updates.name !== undefined) {
        fields.push('name = ?');
        params.push(updates.name);
    }
    if (updates.isDefault !== undefined) {
        fields.push('is_default = ?');
        params.push(updates.isDefault ? 1 : 0);
    }
    if (updates.isEnabled !== undefined) {
        fields.push('is_enabled = ?');
        params.push(updates.isEnabled ? 1 : 0);
    }
    if (updates.useProxy !== undefined) {
        fields.push('use_proxy = ?');
        params.push(updates.useProxy ? 1 : 0);
    }
    if (updates.proxyNodeIds !== undefined) {
        await ensureProxyNodeIdsColumn();
        fields.push('proxy_node_ids = ?');
        const proxyNodeIds = normalizeProxyNodeIds(updates.proxyNodeIds);
        params.push(proxyNodeIds.length > 0 ? JSON.stringify(proxyNodeIds) : null);
    }
    if (updates.codexHighConcurrencyUserIds !== undefined) {
        await ensureCodexHighConcurrencyUserIdsColumn();
        fields.push('codex_high_concurrency_user_ids = ?');
        const identities = normalizeIdentityList(updates.codexHighConcurrencyUserIds);
        params.push(identities.length > 0 ? JSON.stringify(identities) : null);
    }
    if (updates.strategy !== undefined) {
        fields.push('strategy = ?');
        params.push(updates.strategy);
    }
    if (updates.supportedModels !== undefined) {
        fields.push('supported_models = ?');
        params.push(updates.supportedModels ? JSON.stringify(updates.supportedModels) : null);
    }
    if (updates.notSupportedModels !== undefined) {
        fields.push('not_supported_models = ?');
        params.push(updates.notSupportedModels ? JSON.stringify(updates.notSupportedModels) : null);
    }
    // 并发控制字段
    if (updates.userMaxConcurrency !== undefined) {
        fields.push('user_max_concurrency = ?');
        params.push(updates.userMaxConcurrency);
    }
    if (updates.accountMaxConcurrency !== undefined) {
        fields.push('account_max_concurrency = ?');
        params.push(updates.accountMaxConcurrency);
    }
    if (updates.enableUserConcurrencyLimit !== undefined) {
        fields.push('enable_user_concurrency_limit = ?');
        params.push(updates.enableUserConcurrencyLimit ? 1 : 0);
    }
    if (updates.enableAccountConcurrencyLimit !== undefined) {
        fields.push('enable_account_concurrency_limit = ?');
        params.push(updates.enableAccountConcurrencyLimit ? 1 : 0);
    }
    // 代理商并发控制字段
    if (updates.providerMaxConcurrency !== undefined) {
        fields.push('provider_max_concurrency = ?');
        params.push(updates.providerMaxConcurrency);
    }
    if (updates.providerAccountMaxConcurrency !== undefined) {
        fields.push('provider_account_max_concurrency = ?');
        params.push(updates.providerAccountMaxConcurrency);
    }
    if (updates.enableProviderConcurrencyLimit !== undefined) {
        fields.push('enable_provider_concurrency_limit = ?');
        params.push(updates.enableProviderConcurrencyLimit ? 1 : 0);
    }
    if (updates.enableProviderAccountConcurrencyLimit !== undefined) {
        fields.push('enable_provider_account_concurrency_limit = ?');
        params.push(updates.enableProviderAccountConcurrencyLimit ? 1 : 0);
    }
    // Session 并发控制字段
    if (updates.enableSessionLimit !== undefined) {
        fields.push('enable_session_limit = ?');
        params.push(updates.enableSessionLimit ? 1 : 0);
    }
    if (updates.maxSessionsPerAccount !== undefined) {
        fields.push('max_sessions_per_account = ?');
        params.push(updates.maxSessionsPerAccount);
    }
    // 健康检测开关
    if (updates.enableHealthCheck !== undefined) {
        fields.push('enable_health_check = ?');
        params.push(updates.enableHealthCheck ? 1 : 0);
    }

    if (fields.length === 0) {
        return false;
    }

    params.push(id);
    const sql = `
        UPDATE provider_pools
        SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `;
    const [result] = await pool.execute(sql, params);
    return result.affectedRows > 0;
}

export async function clearDefault(providerType) {
    const pool = getPool();
    const sql = `
        UPDATE provider_pools
        SET is_default = 0, updated_at = CURRENT_TIMESTAMP
        WHERE provider_type = ? AND is_default = 1
    `;
    await pool.execute(sql, [providerType]);
}

export async function remove(id) {
    const pool = getPool();
    const sql = 'DELETE FROM provider_pools WHERE id = ?';
    const [result] = await pool.execute(sql, [id]);
    return result.affectedRows > 0;
}

export async function findById(id) {
    const pool = getPool();
    const includeProxyNodeIds = await hasProxyNodeIdsColumn();
    const includeCodexHighConcurrencyUserIds = await hasCodexHighConcurrencyUserIdsColumn();
    const sql = `
        SELECT id, provider_type, name, is_default, is_enabled, use_proxy, strategy,
               ${includeProxyNodeIds ? 'proxy_node_ids,' : ''}
               ${includeCodexHighConcurrencyUserIds ? 'codex_high_concurrency_user_ids,' : ''}
               supported_models, not_supported_models, enable_health_check,
               user_max_concurrency, account_max_concurrency,
               enable_user_concurrency_limit, enable_account_concurrency_limit,
               provider_max_concurrency, provider_account_max_concurrency,
               enable_provider_concurrency_limit, enable_provider_account_concurrency_limit,
               enable_session_limit, max_sessions_per_account,
               created_at, updated_at
        FROM provider_pools
        WHERE id = ?
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [id]);
    if (!rows.length) return null;
    return normalizePoolRow(rows[0]);
}
