/**
 * Bad Accounts DAO - 坏号记录数据访问层
 */

import { getPool } from '../config/database.js';

/**
 * 错误类型常量
 */
export const ERROR_TYPES = {
    ACCOUNT_EXPIRED: 'account_expired',
    FORBIDDEN_403: '403_forbidden',
    RATE_LIMIT_429: '429_rate_limit',
    QUOTA_EXCEEDED: 'quota_exceeded',
    AUTH_FAILED: 'auth_failed',
    TOKEN_EXPIRED: 'token_expired',
    SERVER_ERROR: 'server_error',
    UNKNOWN: 'unknown'
};

/**
 * 检测来源常量
 */
export const DETECTION_SOURCES = {
    KIRO: 'kiro',
    GEMINI: 'gemini',
    CODEX: 'codex',
    MANUAL: 'manual'
};

/**
 * 创建坏号记录
 */
export async function create(record) {
    const pool = getPool();
    const sql = `
        INSERT INTO bad_accounts (
            provider_type, pool_id, provider_uuid, oauth_credential_id,
            display_name, error_type, error_message, error_code,
            detection_source, credentials_snapshot, metadata,
            is_recoverable, recovery_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        record.provider_type || record.providerType,
        record.pool_id ?? record.poolId ?? 0,
        record.provider_uuid || record.providerUuid || null,
        record.oauth_credential_id || record.oauthCredentialId || null,
        record.display_name || record.displayName || null,
        record.error_type || record.errorType || ERROR_TYPES.UNKNOWN,
        record.error_message || record.errorMessage || null,
        record.error_code || record.errorCode || null,
        record.detection_source || record.detectionSource || DETECTION_SOURCES.KIRO,
        record.credentials_snapshot ? JSON.stringify(record.credentials_snapshot) : null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.is_recoverable ?? record.isRecoverable ?? false,
        record.recovery_time || record.recoveryTime || null
    ];

    const [result] = await pool.execute(sql, params);
    return result.insertId;
}

/**
 * 根据ID查询
 */
export async function findById(id) {
    const pool = getPool();
    const sql = 'SELECT * FROM bad_accounts WHERE id = ?';
    const [rows] = await pool.execute(sql, [id]);
    return rows[0] ? normalizeRecord(rows[0]) : null;
}

/**
 * 查询坏号记录列表
 */
export async function findAll(options = {}) {
    const pool = getPool();
    const {
        providerType,
        poolId,
        errorType,
        detectionSource,
        page = 1,
        pageSize = 20,
        orderBy = 'created_at',
        orderDir = 'DESC'
    } = options;

    // 确保分页参数是整数
    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 20;

    let sql = 'SELECT * FROM bad_accounts WHERE 1=1';
    const params = [];

    if (providerType) {
        sql += ' AND provider_type = ?';
        params.push(providerType);
    }

    if (poolId !== undefined && poolId !== null) {
        const normalizedPoolId = Number.parseInt(poolId, 10);
        if (Number.isFinite(normalizedPoolId)) {
            if (normalizedPoolId === 0) {
                sql += ' AND (pool_id = 0 OR pool_id IS NULL)';
            } else {
                sql += ' AND pool_id = ?';
                params.push(normalizedPoolId);
            }
        }
    }

    if (errorType) {
        sql += ' AND error_type = ?';
        params.push(errorType);
    }

    if (detectionSource) {
        sql += ' AND detection_source = ?';
        params.push(detectionSource);
    }

    // 排序
    const validOrderBy = ['created_at', 'error_type', 'provider_type'].includes(orderBy) ? orderBy : 'created_at';
    const validOrderDir = orderDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${validOrderBy} ${validOrderDir}`;

    const offset = (pageNum - 1) * pageSizeNum;
    sql += ` LIMIT ${pageSizeNum} OFFSET ${offset}`;

    const [rows] = await pool.query(sql, params);
    return rows.map(normalizeRecord);
}

/**
 * 获取坏号记录总数
 */
export async function count(options = {}) {
    const pool = getPool();
    const { providerType, poolId, errorType, detectionSource } = options;

    let sql = 'SELECT COUNT(*) as total FROM bad_accounts WHERE 1=1';
    const params = [];

    if (providerType) {
        sql += ' AND provider_type = ?';
        params.push(providerType);
    }

    if (poolId !== undefined && poolId !== null) {
        const normalizedPoolId = Number.parseInt(poolId, 10);
        if (Number.isFinite(normalizedPoolId)) {
            if (normalizedPoolId === 0) {
                sql += ' AND (pool_id = 0 OR pool_id IS NULL)';
            } else {
                sql += ' AND pool_id = ?';
                params.push(normalizedPoolId);
            }
        }
    }

    if (errorType) {
        sql += ' AND error_type = ?';
        params.push(errorType);
    }

    if (detectionSource) {
        sql += ' AND detection_source = ?';
        params.push(detectionSource);
    }

    const [rows] = await pool.execute(sql, params);
    return rows[0]?.total || 0;
}

/**
 * 获取统计摘要
 */
export async function getSummary(options = {}) {
    const pool = getPool();
    const { providerType, poolId } = options;

    let sql = `
        SELECT
            error_type,
            detection_source,
            COUNT(*) as count
        FROM bad_accounts
        WHERE 1=1
    `;
    const params = [];

    if (providerType) {
        sql += ' AND provider_type = ?';
        params.push(providerType);
    }

    if (poolId !== undefined && poolId !== null) {
        const normalizedPoolId = Number.parseInt(poolId, 10);
        if (Number.isFinite(normalizedPoolId)) {
            if (normalizedPoolId === 0) {
                sql += ' AND (pool_id = 0 OR pool_id IS NULL)';
            } else {
                sql += ' AND pool_id = ?';
                params.push(normalizedPoolId);
            }
        }
    }

    sql += ' GROUP BY error_type, detection_source';

    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * 删除坏号记录
 */
export async function deleteById(id) {
    const pool = getPool();
    const sql = 'DELETE FROM bad_accounts WHERE id = ?';
    const [result] = await pool.execute(sql, [id]);
    return result.affectedRows > 0;
}

/**
 * 批量删除
 */
export async function deleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const pool = getPool();
    const placeholders = ids.map(() => '?').join(',');
    const sql = `DELETE FROM bad_accounts WHERE id IN (${placeholders})`;
    const [result] = await pool.execute(sql, ids);
    return result.affectedRows;
}

/**
 * 清空指定池子的坏号记录
 */
export async function clearByPool(providerType, poolId) {
    const pool = getPool();
    let sql = 'DELETE FROM bad_accounts WHERE provider_type = ?';
    const params = [providerType];

    if (poolId !== undefined && poolId !== null) {
        const normalizedPoolId = Number.parseInt(poolId, 10);
        if (Number.isFinite(normalizedPoolId)) {
            if (normalizedPoolId === 0) {
                sql += ' AND (pool_id = 0 OR pool_id IS NULL)';
            } else {
                sql += ' AND pool_id = ?';
                params.push(normalizedPoolId);
            }
        }
    }

    const [result] = await pool.execute(sql, params);
    return result.affectedRows;
}

/**
 * 检查是否已存在相同的坏号记录
 */
export async function exists(providerUuid, errorType) {
    const pool = getPool();
    const sql = `
        SELECT id FROM bad_accounts
        WHERE provider_uuid = ? AND error_type = ?
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [providerUuid, errorType]);
    return rows.length > 0;
}

/**
 * 标准化记录格式
 */
function normalizeRecord(row) {
    if (!row) return null;
    return {
        id: row.id,
        providerType: row.provider_type,
        poolId: row.pool_id,
        providerUuid: row.provider_uuid,
        oauthCredentialId: row.oauth_credential_id,
        displayName: row.display_name,
        errorType: row.error_type,
        errorMessage: row.error_message,
        errorCode: row.error_code,
        detectionSource: row.detection_source,
        credentialsSnapshot: row.credentials_snapshot
            ? (typeof row.credentials_snapshot === 'string'
                ? JSON.parse(row.credentials_snapshot)
                : row.credentials_snapshot)
            : null,
        metadata: row.metadata
            ? (typeof row.metadata === 'string'
                ? JSON.parse(row.metadata)
                : row.metadata)
            : null,
        isRecoverable: Boolean(row.is_recoverable),
        recoveryTime: row.recovery_time,
        createdAt: row.created_at
    };
}
