/**
 * 代理池 DAO - 代理节点和厂商数据访问层
 */

import { getPool } from '../config/database.js';

let nodeColumnsCache = null;

async function ensureProxyTables() {
    const pool = getPool();
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS proxy_providers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            type VARCHAR(32) NOT NULL,
            api_url VARCHAR(512) DEFAULT NULL,
            api_key VARCHAR(512) DEFAULT NULL,
            username VARCHAR(255) DEFAULT NULL,
            password VARCHAR(255) DEFAULT NULL,
            config JSON DEFAULT NULL,
            is_enabled BOOLEAN DEFAULT TRUE,
            fetch_interval INT DEFAULT 300,
            last_fetch_time DATETIME DEFAULT NULL,
            last_fetch_error TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS proxy_nodes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            provider_id INT DEFAULT NULL,
            name VARCHAR(128) NOT NULL,
            protocol VARCHAR(32) NOT NULL,
            host VARCHAR(255) NOT NULL,
            port INT NOT NULL,
            username VARCHAR(255) DEFAULT NULL,
            password VARCHAR(512) DEFAULT NULL,
            config JSON DEFAULT NULL,
            is_enabled BOOLEAN DEFAULT TRUE,
            is_healthy BOOLEAN DEFAULT TRUE,
            priority INT DEFAULT 0,
            success_count INT DEFAULT 0,
            fail_count INT DEFAULT 0,
            avg_latency INT DEFAULT NULL,
            last_used DATETIME DEFAULT NULL,
            last_check_time DATETIME DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function getNodeColumns() {
    if (nodeColumnsCache) {
        return nodeColumnsCache;
    }
    const pool = getPool();
    const [rows] = await pool.execute(`SHOW COLUMNS FROM proxy_nodes`);
    nodeColumnsCache = new Set(rows.map(row => row.Field));
    return nodeColumnsCache;
}

function hasColumn(columns, columnName) {
    return columns instanceof Set && columns.has(columnName);
}

function normalizeConfigValue(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

function normalizeSqlValue(value) {
    return value === undefined ? null : value;
}

// ============================================
// 代理厂商相关
// ============================================

export async function findAllProviders() {
    const pool = getPool();
    await ensureProxyTables();
    const [rows] = await pool.execute(`
        SELECT * FROM proxy_providers ORDER BY created_at DESC
    `);
    return rows;
}

export async function findProviderById(id) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM proxy_providers WHERE id = ?',
        [id]
    );
    return rows[0] || null;
}

export async function createProvider(data) {
    const pool = getPool();
    const [result] = await pool.execute(`
        INSERT INTO proxy_providers (name, type, api_url, api_key, username, password, config, is_enabled, fetch_interval)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        data.name,
        data.type,
        data.apiUrl || null,
        data.apiKey || null,
        data.username || null,
        data.password || null,
        data.config ? JSON.stringify(data.config) : null,
        data.isEnabled !== false,
        data.fetchInterval || 300
    ]);
    return result.insertId;
}

export async function updateProvider(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
    if (data.apiUrl !== undefined) { fields.push('api_url = ?'); values.push(data.apiUrl); }
    if (data.apiKey !== undefined) { fields.push('api_key = ?'); values.push(data.apiKey); }
    if (data.username !== undefined) { fields.push('username = ?'); values.push(data.username); }
    if (data.password !== undefined) { fields.push('password = ?'); values.push(data.password); }
    if (data.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(data.config)); }
    if (data.isEnabled !== undefined) { fields.push('is_enabled = ?'); values.push(data.isEnabled); }
    if (data.fetchInterval !== undefined) { fields.push('fetch_interval = ?'); values.push(data.fetchInterval); }

    if (fields.length === 0) return;
    values.push(id);
    await pool.execute(`UPDATE proxy_providers SET ${fields.join(', ')} WHERE id = ?`, values);
}

export async function deleteProvider(id) {
    const pool = getPool();
    await pool.execute('DELETE FROM proxy_providers WHERE id = ?', [id]);
}

// ============================================
// 代理节点相关
// ============================================

export async function findAllNodes(options = {}) {
    const pool = getPool();
    await ensureProxyTables();
    const columns = await getNodeColumns();
    const { providerId, enabledOnly = false, healthyOnly = false } = options;

    let sql = 'SELECT * FROM proxy_nodes WHERE 1=1';
    const params = [];

    const hasProviderFilter = providerId !== undefined && providerId !== null && providerId !== '';
    if (hasProviderFilter && hasColumn(columns, 'provider_id')) {
        sql += ' AND provider_id = ?';
        params.push(providerId);
    }
    if (enabledOnly && hasColumn(columns, 'is_enabled')) {
        sql += ' AND is_enabled = TRUE';
    }
    if (healthyOnly && hasColumn(columns, 'is_healthy')) {
        sql += ' AND is_healthy = TRUE';
    }

    if (hasColumn(columns, 'priority') && hasColumn(columns, 'created_at')) {
        sql += ' ORDER BY priority DESC, created_at DESC';
    } else if (hasColumn(columns, 'created_at')) {
        sql += ' ORDER BY created_at DESC';
    } else {
        sql += ' ORDER BY id DESC';
    }
    const [rows] = await pool.execute(sql, params);
    return rows;
}

export async function findNodeById(id) {
    const pool = getPool();
    await ensureProxyTables();
    const [rows] = await pool.execute('SELECT * FROM proxy_nodes WHERE id = ?', [id]);
    return rows[0] || null;
}

export async function createNode(data) {
    const pool = getPool();
    await ensureProxyTables();
    const columns = await getNodeColumns();

    const fieldMappings = [
        ['provider_id', data.providerId || null],
        ['name', data.name],
        ['protocol', data.protocol],
        ['host', data.host],
        ['port', data.port],
        ['username', data.username || null],
        ['password', data.password || null],
        ['config', normalizeConfigValue(data.config)],
        ['is_enabled', data.isEnabled !== false],
        ['priority', data.priority || 0]
    ];

    const fields = [];
    const values = [];
    for (const [field, value] of fieldMappings) {
        if (hasColumn(columns, field)) {
            fields.push(field);
            values.push(normalizeSqlValue(value));
        }
    }

    const requiredFields = ['name', 'protocol', 'host', 'port'];
    const missingRequired = requiredFields.filter(field => !fields.includes(field));
    if (missingRequired.length > 0) {
        throw new Error(`proxy_nodes 表结构缺失必要字段: ${missingRequired.join(', ')}`);
    }

    const placeholders = fields.map(() => '?').join(', ');
    const [result] = await pool.execute(
        `INSERT INTO proxy_nodes (${fields.join(', ')}) VALUES (${placeholders})`,
        values
    );
    return result.insertId;
}

export async function updateNode(id, data) {
    const pool = getPool();
    await ensureProxyTables();
    const columns = await getNodeColumns();
    const fields = [];
    const values = [];

    if (data.name !== undefined && hasColumn(columns, 'name')) { fields.push('name = ?'); values.push(data.name); }
    if (data.protocol !== undefined && hasColumn(columns, 'protocol')) { fields.push('protocol = ?'); values.push(data.protocol); }
    if (data.host !== undefined && hasColumn(columns, 'host')) { fields.push('host = ?'); values.push(data.host); }
    if (data.port !== undefined && hasColumn(columns, 'port')) { fields.push('port = ?'); values.push(data.port); }
    if (data.username !== undefined && hasColumn(columns, 'username')) { fields.push('username = ?'); values.push(data.username); }
    if (data.password !== undefined && hasColumn(columns, 'password')) { fields.push('password = ?'); values.push(data.password); }
    if (data.config !== undefined && hasColumn(columns, 'config')) { fields.push('config = ?'); values.push(normalizeConfigValue(data.config)); }
    if (data.isEnabled !== undefined && hasColumn(columns, 'is_enabled')) { fields.push('is_enabled = ?'); values.push(data.isEnabled); }
    if (data.isHealthy !== undefined && hasColumn(columns, 'is_healthy')) { fields.push('is_healthy = ?'); values.push(data.isHealthy); }
    if (data.priority !== undefined && hasColumn(columns, 'priority')) { fields.push('priority = ?'); values.push(data.priority); }

    if (fields.length === 0) return;
    values.push(id);
    await pool.execute(`UPDATE proxy_nodes SET ${fields.join(', ')} WHERE id = ?`, values);
}

export async function deleteNode(id) {
    const pool = getPool();
    await ensureProxyTables();
    await pool.execute('DELETE FROM proxy_nodes WHERE id = ?', [id]);
}

export async function deleteNodesByProviderId(providerId) {
    const pool = getPool();
    await ensureProxyTables();
    const columns = await getNodeColumns();
    if (!hasColumn(columns, 'provider_id')) {
        return;
    }
    await pool.execute('DELETE FROM proxy_nodes WHERE provider_id = ?', [providerId]);
}

export async function recordNodeUsage(nodeId, success, latency = null, error = null) {
    const pool = getPool();
    await ensureProxyTables();
    const columns = await getNodeColumns();
    const updates = [];
    const params = [];

    const countField = success ? 'success_count' : 'fail_count';
    if (hasColumn(columns, countField)) {
        updates.push(`${countField} = ${countField} + 1`);
    }
    if (hasColumn(columns, 'last_used')) {
        updates.push('last_used = NOW()');
    }
    if (hasColumn(columns, 'is_healthy')) {
        updates.push('is_healthy = ?');
        params.push(success);
    }
    if (hasColumn(columns, 'avg_latency')) {
        updates.push('avg_latency = CASE WHEN ? IS NOT NULL THEN COALESCE((avg_latency + ?) / 2, ?) ELSE avg_latency END');
        params.push(latency, latency, latency);
    }
    if (hasColumn(columns, 'last_error')) {
        updates.push('last_error = ?');
        params.push(error);
    }

    if (updates.length === 0) {
        return;
    }

    params.push(nodeId);
    await pool.execute(`UPDATE proxy_nodes SET ${updates.join(', ')} WHERE id = ?`, params);
}
