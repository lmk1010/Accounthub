/**
 * Outlook Email DAO
 * 邮箱管理数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 初始化邮箱表
 */
export async function initTable() {
    const pool = getPool();
    const sql = `
        CREATE TABLE IF NOT EXISTS outlook_emails (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) DEFAULT NULL,
            auth_type ENUM('oauth2', 'password') DEFAULT 'oauth2' COMMENT '认证方式',
            client_id VARCHAR(255) DEFAULT NULL,
            refresh_token TEXT DEFAULT NULL,
            access_token TEXT DEFAULT NULL,
            token_expires_at DATETIME DEFAULT NULL,
            display_name VARCHAR(255) DEFAULT NULL,
            status ENUM('active', 'disabled', 'error') DEFAULT 'active',
            last_error TEXT DEFAULT NULL,
            last_used_at DATETIME DEFAULT NULL,
            usage_count INT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
    await pool.execute(sql);

    // 添加 auth_type 列（如果不存在）
    try {
        await pool.execute(`
            ALTER TABLE outlook_emails
            ADD COLUMN auth_type ENUM('oauth2', 'password') DEFAULT 'oauth2' AFTER password
        `);
    } catch (e) {
        // 列已存在，忽略
    }

    // 添加 batch_id 列
    try {
        await pool.execute(`ALTER TABLE outlook_emails ADD COLUMN batch_id VARCHAR(50) DEFAULT NULL`);
        await pool.execute(`ALTER TABLE outlook_emails ADD INDEX idx_batch_id (batch_id)`);
    } catch (e) { /* 已存在 */ }

    // 添加 link_role 列
    try {
        await pool.execute(`ALTER TABLE outlook_emails ADD COLUMN link_role VARCHAR(20) DEFAULT NULL`);
    } catch (e) { /* 已存在 */ }
}

function normalizeRow(row) {
    if (!row) return null;
    return {
        ...row,
        authType: row.auth_type,
        tokenExpiresAt: row.token_expires_at,
        lastUsedAt: row.last_used_at,
        usageCount: row.usage_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        displayName: row.display_name,
        clientId: row.client_id,
        refreshToken: row.refresh_token,
        accessToken: row.access_token,
        lastError: row.last_error,
        linkedProviderType: row.linked_provider_type,
        linkedProviderUuid: row.linked_provider_uuid,
        linkedCredentialId: row.linked_credential_id,
        batchId: row.batch_id,
        linkRole: row.link_role
    };
}

/**
 * 创建邮箱记录
 */
export async function create({ email, password, auth_type = 'oauth2', client_id, refresh_token, display_name, batch_id }) {
    const pool = getPool();
    const sql = `
        INSERT INTO outlook_emails (email, password, auth_type, client_id, refresh_token, display_name, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.execute(sql, [
        email,
        password,
        auth_type,
        client_id || null,
        refresh_token || null,
        display_name || email,
        batch_id || null
    ]);
    return findById(result.insertId);
}

/**
 * 批量创建邮箱
 */
export async function createBatch(emails, batchId) {
    const pool = getPool();
    const results = [];
    for (const item of emails) {
        try {
            const existing = await findByEmail(item.email);
            if (existing) {
                results.push({ email: item.email, success: false, error: '邮箱已存在' });
                continue;
            }
            const created = await create({ ...item, batch_id: batchId });
            results.push({ email: item.email, success: true, id: created.id });
        } catch (err) {
            results.push({ email: item.email, success: false, error: err.message });
        }
    }
    return results;
}

/**
 * 根据ID查找
 */
export async function findById(id) {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM outlook_emails WHERE id = ?', [id]);
    return rows.length ? normalizeRow(rows[0]) : null;
}

/**
 * 根据邮箱查找
 */
export async function findByEmail(email) {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM outlook_emails WHERE email = ?', [email]);
    return rows.length ? normalizeRow(rows[0]) : null;
}

/**
 * 查询所有邮箱
 */
export async function findAll({ status, search, linked, batchId, linkRole, limit = 100, offset = 0 } = {}) {
    const pool = getPool();
    const where = [];
    const params = [];

    if (status) {
        where.push('status = ?');
        params.push(status);
    }
    if (search) {
        where.push('(email LIKE ? OR display_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (linked === 'linked') {
        where.push('linked_provider_type IS NOT NULL');
    } else if (linked === 'unlinked') {
        where.push('linked_provider_type IS NULL');
    } else if (linked) {
        where.push('linked_provider_type = ?');
        params.push(linked);
    }
    if (batchId) {
        where.push('batch_id = ?');
        params.push(batchId);
    }
    if (linkRole) {
        where.push('link_role = ?');
        params.push(linkRole);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const safeLimit = parseInt(limit) || 100;
    const safeOffset = parseInt(offset) || 0;
    const sql = `
        SELECT * FROM outlook_emails
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
    const [rows] = await pool.execute(sql, params);
    return rows.map(normalizeRow);
}

/**
 * 统计数量
 */
export async function count({ status, search, linked, batchId, linkRole } = {}) {
    const pool = getPool();
    const where = [];
    const params = [];

    if (status) {
        where.push('status = ?');
        params.push(status);
    }
    if (search) {
        where.push('(email LIKE ? OR display_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (linked === 'linked') {
        where.push('linked_provider_type IS NOT NULL');
    } else if (linked === 'unlinked') {
        where.push('linked_provider_type IS NULL');
    } else if (linked) {
        where.push('linked_provider_type = ?');
        params.push(linked);
    }
    if (batchId) {
        where.push('batch_id = ?');
        params.push(batchId);
    }
    if (linkRole) {
        where.push('link_role = ?');
        params.push(linkRole);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as total FROM outlook_emails ${whereClause}`;
    const [rows] = await pool.execute(sql, params);
    return rows[0].total;
}

/**
 * 获取统计信息
 */
export async function getStats() {
    const pool = getPool();
    const sql = `
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
        FROM outlook_emails
    `;
    const [rows] = await pool.execute(sql);
    return {
        total: Number(rows[0].total) || 0,
        active: Number(rows[0].active) || 0,
        disabled: Number(rows[0].disabled) || 0,
        error: Number(rows[0].error) || 0
    };
}

/**
 * 更新邮箱信息
 */
export async function update(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    if (data.password !== undefined) {
        fields.push('password = ?');
        params.push(data.password);
    }
    if (data.auth_type !== undefined) {
        fields.push('auth_type = ?');
        params.push(data.auth_type);
    }
    if (data.client_id !== undefined) {
        fields.push('client_id = ?');
        params.push(data.client_id);
    }
    if (data.refresh_token !== undefined) {
        fields.push('refresh_token = ?');
        params.push(data.refresh_token);
    }
    if (data.access_token !== undefined) {
        fields.push('access_token = ?');
        params.push(data.access_token);
    }
    if (data.token_expires_at !== undefined) {
        fields.push('token_expires_at = ?');
        params.push(data.token_expires_at);
    }
    if (data.display_name !== undefined) {
        fields.push('display_name = ?');
        params.push(data.display_name);
    }
    if (data.status !== undefined) {
        fields.push('status = ?');
        params.push(data.status);
    }
    if (data.last_error !== undefined) {
        fields.push('last_error = ?');
        params.push(data.last_error);
    }
    if (data.linked_provider_type !== undefined) {
        fields.push('linked_provider_type = ?');
        params.push(data.linked_provider_type);
    }
    if (data.linked_provider_uuid !== undefined) {
        fields.push('linked_provider_uuid = ?');
        params.push(data.linked_provider_uuid);
    }
    if (data.linked_credential_id !== undefined) {
        fields.push('linked_credential_id = ?');
        params.push(data.linked_credential_id);
    }

    if (!fields.length) return findById(id);

    params.push(id);
    const sql = `UPDATE outlook_emails SET ${fields.join(', ')} WHERE id = ?`;
    await pool.execute(sql, params);
    return findById(id);
}

/**
 * 更新Token
 */
export async function updateToken(id, accessToken, expiresAt) {
    const pool = getPool();
    await pool.execute(
        'UPDATE outlook_emails SET access_token = ?, token_expires_at = ? WHERE id = ?',
        [accessToken, expiresAt, id]
    );
}

/**
 * 记录使用
 */
export async function recordUsage(id) {
    const pool = getPool();
    await pool.execute(
        'UPDATE outlook_emails SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?',
        [id]
    );
}

/**
 * 设置错误状态
 */
export async function setError(id, errorMessage) {
    const pool = getPool();
    await pool.execute(
        'UPDATE outlook_emails SET status = ?, last_error = ? WHERE id = ?',
        ['error', errorMessage, id]
    );
}

/**
 * 启用邮箱
 */
export async function enable(id) {
    return update(id, { status: 'active', last_error: null });
}

/**
 * 禁用邮箱
 */
export async function disable(id) {
    return update(id, { status: 'disabled' });
}

/**
 * 删除邮箱
 */
export async function deleteById(id) {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM outlook_emails WHERE id = ?', [id]);
    return result.affectedRows > 0;
}

/**
 * 获取可用邮箱（用于轮询）
 */
export async function getAvailable() {
    const pool = getPool();
    const [rows] = await pool.execute(`
        SELECT * FROM outlook_emails
        WHERE status = 'active'
        ORDER BY last_used_at ASC, usage_count ASC
        LIMIT 1
    `);
    return rows.length ? normalizeRow(rows[0]) : null;
}

/**
 * 关联邮箱到提供商
 */
export async function linkToProvider(id, { providerType, providerUuid, credentialId, linkRole }) {
    const pool = getPool();
    await pool.execute(
        `UPDATE outlook_emails
         SET linked_provider_type = ?, linked_provider_uuid = ?, linked_credential_id = ?, link_role = ?
         WHERE id = ?`,
        [providerType || null, providerUuid || null, credentialId || null, linkRole || null, id]
    );
    return findById(id);
}

/**
 * 解除邮箱关联
 */
export async function unlinkProvider(id) {
    return linkToProvider(id, { providerType: null, providerUuid: null, credentialId: null, linkRole: null });
}

/**
 * 根据提供商查找关联的邮箱
 */
export async function findByLinkedProvider(providerType, providerUuid = null) {
    const pool = getPool();
    let sql = 'SELECT * FROM outlook_emails WHERE linked_provider_type = ?';
    const params = [providerType];
    if (providerUuid) {
        sql += ' AND linked_provider_uuid = ?';
        params.push(providerUuid);
    }
    const [rows] = await pool.execute(sql, params);
    return rows.map(normalizeRow);
}

/**
 * 获取所有批次ID列表
 */
export async function getDistinctBatchIds() {
    const pool = getPool();
    const [rows] = await pool.execute(`
        SELECT batch_id, MIN(created_at) as first_import, COUNT(*) as cnt
        FROM outlook_emails
        WHERE batch_id IS NOT NULL
        GROUP BY batch_id
        ORDER BY first_import DESC
    `);
    return rows.map(r => ({
        batchId: r.batch_id,
        firstImport: r.first_import,
        count: Number(r.cnt)
    }));
}

/**
 * 按批次删除邮箱
 */
export async function deleteByBatchId(batchId) {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM outlook_emails WHERE batch_id = ?', [batchId]);
    return result.affectedRows;
}

/**
 * 按批次批量设置角色
 */
export async function batchSetLinkRole(batchId, linkRole) {
    const pool = getPool();
    const [result] = await pool.execute(
        'UPDATE outlook_emails SET link_role = ? WHERE batch_id = ?',
        [linkRole || null, batchId]
    );
    return result.affectedRows;
}
