/**
 * OAuth Credentials DAO
 */

import { getPool } from '../config/database.js';

let oauthCredentialsColumnsCache = null;
let oauthCredentialsColumnsLoaded = false;
let oauthCredentialsColumnsEnsured = false;

const OAUTH_CREDENTIALS_OPTIONAL_COLUMNS = [
    {
        name: 'subscription_tier',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN subscription_tier VARCHAR(20) DEFAULT NULL COMMENT 'Subscription tier'`
    },
    {
        name: 'pool_id',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN pool_id INT DEFAULT NULL COMMENT 'Pool ID'`
    },
    {
        name: 'source',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN source VARCHAR(50) DEFAULT NULL COMMENT 'Source'`
    },
    {
        name: 'metadata',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN metadata JSON DEFAULT NULL COMMENT 'Metadata'`
    },
    {
        name: 'is_used',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN is_used BOOLEAN DEFAULT FALSE COMMENT 'Used flag'`
    },
    {
        name: 'used_by_uuid',
        ddl: `ALTER TABLE oauth_credentials ADD COLUMN used_by_uuid VARCHAR(64) DEFAULT NULL COMMENT 'Used by UUID'`
    }
];

async function loadOAuthCredentialsColumns() {
    if (oauthCredentialsColumnsLoaded) {
        return oauthCredentialsColumnsCache;
    }
    oauthCredentialsColumnsLoaded = true;
    try {
        const pool = getPool();
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oauth_credentials'`
        );
        oauthCredentialsColumnsCache = new Set(rows.map(row => row.COLUMN_NAME));
    } catch (error) {
        oauthCredentialsColumnsLoaded = false;
        oauthCredentialsColumnsCache = null;
        throw error;
    }
    return oauthCredentialsColumnsCache;
}

async function ensureOAuthCredentialsColumns() {
    if (oauthCredentialsColumnsEnsured) {
        return oauthCredentialsColumnsCache;
    }
    oauthCredentialsColumnsEnsured = true;
    let columns = null;
    try {
        columns = await loadOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for ensure:', error.message);
        return null;
    }
    if (!columns) return null;

    const pool = getPool();
    let altered = false;
    for (const column of OAUTH_CREDENTIALS_OPTIONAL_COLUMNS) {
        if (columns.has(column.name)) continue;
        try {
            await pool.execute(column.ddl);
            altered = true;
            console.log(`[OAuthCredentialsDao] Added missing oauth_credentials column: ${column.name}`);
        } catch (error) {
            console.warn(`[OAuthCredentialsDao] Failed to add oauth_credentials column ${column.name}:`, error.message);
        }
    }

    if (altered) {
        oauthCredentialsColumnsLoaded = false;
        oauthCredentialsColumnsCache = null;
        columns = await loadOAuthCredentialsColumns();
    }
    return columns;
}

function buildInsertPayload(record, columns) {
    const columnValues = {
        provider_type: record.provider_type,
        credential_type: record.credential_type,
        credentials: JSON.stringify(record.credentials),
        display_name: record.display_name ?? null,
        email: record.email ?? null,
        subscription_tier: record.subscription_tier ?? null,
        pool_id: record.pool_id ?? null,
        source: record.source ?? null,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        is_used: record.is_used ? 1 : 0,
        used_by_uuid: record.used_by_uuid ?? null
    };

    if (!columns || columns.size === 0) {
        return {
            columns: Object.keys(columnValues),
            params: Object.values(columnValues)
        };
    }

    const filteredColumns = [];
    const filteredParams = [];
    for (const [column, value] of Object.entries(columnValues)) {
        if (columns.has(column)) {
            filteredColumns.push(column);
            filteredParams.push(value);
        }
    }

    return { columns: filteredColumns, params: filteredParams };
}

function normalizeRow(row) {
    if (!row) return null;
    return {
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
        is_used: Boolean(row.is_used)
    };
}

function buildWhereClause({ providerType, isUsed, search, excludeProviders } = {}) {
    const where = [];
    const params = [];

    if (providerType) {
        where.push('provider_type = ?');
        params.push(providerType);
    }

    if (excludeProviders && Array.isArray(excludeProviders) && excludeProviders.length > 0) {
        const placeholders = excludeProviders.map(() => '?').join(', ');
        where.push(`provider_type NOT IN (${placeholders})`);
        params.push(...excludeProviders);
    }

    if (isUsed !== null && isUsed !== undefined) {
        where.push('is_used = ?');
        params.push(isUsed ? 1 : 0);
    }

    if (search) {
        const term = `%${search}%`;
        where.push('(display_name LIKE ? OR provider_type LIKE ? OR CAST(credentials AS CHAR) LIKE ?)');
        params.push(term, term, term);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return { clause, params };
}

export async function create({
    provider_type,
    credential_type = 'oauth',
    credentials,
    display_name = null,
    email = null,
    subscription_tier = null,
    pool_id = null,
    source = null,
    metadata = null,
    is_used = false,
    used_by_uuid = null
}) {
    const pool = getPool();
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns, using default insert:', error.message);
    }

    const { columns: insertColumns, params } = buildInsertPayload(
        {
            provider_type,
            credential_type,
            credentials,
            display_name,
            email,
            subscription_tier,
            pool_id,
            source,
            metadata,
            is_used,
            used_by_uuid
        },
        columns
    );
    const placeholders = insertColumns.map(() => '?').join(', ');
    const sql = `INSERT INTO oauth_credentials (${insertColumns.join(', ')}) VALUES (${placeholders})`;
    const [result] = await pool.execute(sql, params);
    return findById(result.insertId);
}

export async function findById(id) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT * FROM oauth_credentials WHERE id = ?`,
        [id]
    );
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function findByEmail(providerType, email) {
    if (!email) return null;
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT * FROM oauth_credentials WHERE provider_type = ? AND email = ?`,
        [providerType, email]
    );
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function findAll({ providerType = null, isUsed = null, search = '', excludeProviders = null } = {}) {
    const pool = getPool();
    const { clause, params } = buildWhereClause({ providerType, isUsed, search, excludeProviders });
    const sql = `SELECT * FROM oauth_credentials ${clause} ORDER BY created_at DESC`;

    const [rows] = await pool.execute(sql, params);
    return rows.map(normalizeRow);
}

export async function findPaged({ providerType = null, isUsed = null, search = '', excludeProviders = null, limit = 20, offset = 0 } = {}) {
    const pool = getPool();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const { clause, params } = buildWhereClause({ providerType, isUsed, search, excludeProviders });
    const sql = `
        SELECT *
        FROM oauth_credentials
        ${clause}
        ORDER BY created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;

    const [rows] = await pool.execute(sql, params);
    return rows.map(normalizeRow);
}

export async function countFiltered({ providerType = null, isUsed = null, search = '', excludeProviders = null } = {}) {
    const pool = getPool();
    const { clause, params } = buildWhereClause({ providerType, isUsed, search, excludeProviders });
    const sql = `
        SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN is_used = TRUE THEN 1 ELSE 0 END) AS usedCount,
            SUM(CASE WHEN is_used = FALSE THEN 1 ELSE 0 END) AS unusedCount
        FROM oauth_credentials
        ${clause}
    `;
    const [rows] = await pool.execute(sql, params);
    if (!rows.length) {
        return { totalCount: 0, usedCount: 0, unusedCount: 0 };
    }
    return {
        totalCount: Number(rows[0].totalCount) || 0,
        usedCount: Number(rows[0].usedCount) || 0,
        unusedCount: Number(rows[0].unusedCount) || 0
    };
}

export async function findLatestByProviderType(providerType, sinceTime = null) {
    const pool = getPool();
    let sql = `
        SELECT * FROM oauth_credentials
        WHERE provider_type = ?
    `;
    const params = [providerType];
    if (sinceTime) {
        sql += ' AND created_at >= ?';
        params.push(sinceTime);
    }
    sql += ' ORDER BY created_at DESC LIMIT 1';
    const [rows] = await pool.execute(sql, params);
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function findByRefreshToken(providerType, refreshToken) {
    const pool = getPool();
    const sql = `
        SELECT * FROM oauth_credentials
        WHERE provider_type = ?
          AND (
            JSON_EXTRACT(credentials, '$.refreshToken') = ?
            OR JSON_EXTRACT(credentials, '$.refresh_token') = ?
            OR JSON_EXTRACT(metadata, '$.originalRefreshToken') = ?
          )
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [providerType, refreshToken, refreshToken, refreshToken]);
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function findBySourcePath(providerType, sourcePath) {
    if (!providerType || !sourcePath) return null;
    const pool = getPool();
    const sql = `
        SELECT * FROM oauth_credentials
        WHERE provider_type = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.sourcePath')) = ?
        ORDER BY created_at DESC
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [providerType, sourcePath]);
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function findByDisplayName(providerType, displayName) {
    if (!providerType || !displayName) return null;
    const pool = getPool();
    const sql = `
        SELECT * FROM oauth_credentials
        WHERE provider_type = ?
          AND display_name = ?
        ORDER BY created_at DESC
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [providerType, displayName]);
    if (!rows.length) return null;
    return normalizeRow(rows[0]);
}

export async function updateCredentials(id, credentials) {
    const pool = getPool();
    const sql = `
        UPDATE oauth_credentials
        SET credentials = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `;
    await pool.execute(sql, [JSON.stringify(credentials), id]);
    return findById(id);
}

export async function updateSubscriptionTier(id, tier) {
    if (!id || !tier) return;
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for update:', error.message);
    }
    if (columns && !columns.has('subscription_tier')) {
        console.warn('[OAuthCredentialsDao] oauth_credentials missing subscription_tier column, skipping update');
        return;
    }
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET subscription_tier = ? WHERE id = ?`,
        [tier, id]
    );
}

export async function updateEmail(id, email) {
    if (!id || !email) return;
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET email = ? WHERE id = ?`,
        [email, id]
    );
}

export async function updatePoolId(id, poolId) {
    if (!id) return;
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET pool_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [poolId ?? null, id]
    );
}

export async function markUsed(id, providerUuid) {
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for update:', error.message);
    }
    if (columns && (!columns.has('is_used') || !columns.has('used_by_uuid'))) {
        console.warn('[OAuthCredentialsDao] oauth_credentials missing is_used or used_by_uuid column, skipping update');
        return;
    }
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET is_used = 1, used_by_uuid = ? WHERE id = ?`,
        [providerUuid, id]
    );
}

export async function markUnused(id) {
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for update:', error.message);
    }
    if (columns && (!columns.has('is_used') || !columns.has('used_by_uuid'))) {
        console.warn('[OAuthCredentialsDao] oauth_credentials missing is_used or used_by_uuid column, skipping update');
        return;
    }
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET is_used = 0, used_by_uuid = NULL WHERE id = ?`,
        [id]
    );
}

export async function markUnusedByProvider(providerUuid) {
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for update:', error.message);
    }
    if (columns && (!columns.has('is_used') || !columns.has('used_by_uuid'))) {
        console.warn('[OAuthCredentialsDao] oauth_credentials missing is_used or used_by_uuid column, skipping update');
        return;
    }
    const pool = getPool();
    await pool.execute(
        `UPDATE oauth_credentials SET is_used = 0, used_by_uuid = NULL WHERE used_by_uuid = ?`,
        [providerUuid]
    );
}

export async function deleteByProviderUuid(providerUuid) {
    let columns = null;
    try {
        columns = await ensureOAuthCredentialsColumns();
    } catch (error) {
        console.warn('[OAuthCredentialsDao] Failed to load oauth_credentials columns for delete:', error.message);
    }
    if (columns && !columns.has('used_by_uuid')) {
        console.warn('[OAuthCredentialsDao] oauth_credentials missing used_by_uuid column, skipping delete');
        return 0;
    }
    const pool = getPool();
    const [result] = await pool.execute(
        `DELETE FROM oauth_credentials WHERE used_by_uuid = ?`,
        [providerUuid]
    );
    return result.affectedRows || 0;
}

export async function deleteById(id) {
    const pool = getPool();
    const [result] = await pool.execute(
        `DELETE FROM oauth_credentials WHERE id = ?`,
        [id]
    );
    return result.affectedRows > 0;
}
