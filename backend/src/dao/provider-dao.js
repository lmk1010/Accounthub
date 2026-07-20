/**
 * Provider DAO - 账号数据访问层
 */

import { EventEmitter } from 'events';
import { getPool } from '../config/database.js';

/**
 * Phase 1:provider 删除事件总线
 *
 * 任何一次 markDeleted / deleteProvider 被调用后,无论是由 UI、pool manager 的
 * 自动下线,还是 kiro 的业务层删除,都会发 'deleted' 事件,形状:
 *   { uuid, providerType, hard: boolean, reason?: string }
 *
 * 上层(service-manager.js init 时)统一注册一个 listener,完成:
 *   - 本地 deleteServiceInstancesByUuid (dispose + 释放 agent/credentials)
 *   - 跨 worker 广播 provider_removed 事件
 *
 * 这样所有删除路径只需要改一个地方(DAO),不用在 20+ 个调用点都记得手工清理。
 * EventEmitter 本身没有并发限制,listener 内部吞异常以免单个 handler 错误阻塞后续。
 */
export const providerDaoEvents = new EventEmitter();
providerDaoEvents.setMaxListeners(20);

function emitProviderDeleted(payload) {
    try {
        providerDaoEvents.emit('deleted', payload);
    } catch (error) {
        console.warn('[ProviderDAO] providerDaoEvents emit failed:', error?.message || error);
    }
}

const CREDENTIAL_RECOVERY_TIME_SQL = `COALESCE(
    CAST(REPLACE(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.relayStateRecoverAt')), 'T', ' '), 'Z', '') AS DATETIME),
    CAST(REPLACE(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.relay_state_recover_at')), 'T', ' '), 'Z', '') AS DATETIME)
)`;

const EFFECTIVE_RECOVERY_TIME_SQL = `CASE
    WHEN scheduled_recovery_time IS NULL THEN ${CREDENTIAL_RECOVERY_TIME_SQL}
    WHEN ${CREDENTIAL_RECOVERY_TIME_SQL} IS NULL THEN scheduled_recovery_time
    ELSE GREATEST(scheduled_recovery_time, ${CREDENTIAL_RECOVERY_TIME_SQL})
END`;

function normalizePoolId(poolId) {
    if (poolId === null || poolId === undefined || poolId === '') {
        return null;
    }
    const parsed = Number.parseInt(poolId, 10);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return parsed;
}

function appendPoolCondition(sql, poolId, params) {
    const normalizedPoolId = normalizePoolId(poolId);
    if (normalizedPoolId === null) {
        return sql;
    }
    if (normalizedPoolId === 0) {
        sql += ' AND (pool_id = 0 OR pool_id IS NULL)';
        return sql;
    }
    sql += ' AND pool_id = ?';
    params.push(normalizedPoolId);
    return sql;
}

/**
 * 查询所有账号
 * @param {string} providerType - 提供商类型（可选）
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>}
 */
export async function findAll(providerType = null, options = {}) {
    const pool = getPool();
    const { includeDeleted = false, poolId = null } = options;

    let sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            last_health_check_time, scheduled_recovery_time,
            check_health, check_model_name, last_health_check_model,
            not_supported_models, available_models, max_devices,
            subscription_title, usage_limit, current_usage, next_reset_time,
            free_trial_expiry, usage_info_updated_at,
            created_at, updated_at
        FROM providers
        WHERE 1=1
    `;

    const params = [];

    if (!includeDeleted) {
        sql += ' AND (is_deleted = FALSE OR is_deleted IS NULL)';
    }

    if (providerType) {
        sql += ' AND provider_type = ?';
        params.push(providerType);
    }

    sql = appendPoolCondition(sql, poolId, params);

    sql += ' ORDER BY provider_type, created_at DESC';

    const [rows] = await pool.execute(sql, params);

    // 解析 JSON 字段
    return rows.map(row => ({
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        not_supported_models: row.not_supported_models ?
            (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) :
            null,
        available_models: row.available_models ?
            (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models) :
            null,
        is_healthy: Boolean(row.is_healthy),
        is_disabled: Boolean(row.is_disabled),
        is_deleted: Boolean(row.is_deleted),
        // 用量字段映射为 camelCase
        subscriptionTitle: row.subscription_title,
        usageLimit: row.usage_limit,
        currentUsage: row.current_usage,
        nextResetTime: row.next_reset_time,
        freeTrialExpiry: row.free_trial_expiry,
        usageInfoUpdatedAt: row.usage_info_updated_at
    }));
}

/**
 * 获取所有提供商类型（去重）
 * @param {Object} options - 查询选项
 * @returns {Promise<string[]>}
 */
export async function getProviderTypes(options = {}) {
    const pool = getPool();
    const { includeDeleted = true } = options;

    let sql = 'SELECT DISTINCT provider_type FROM providers';
    if (!includeDeleted) {
        sql += ' WHERE (is_deleted = FALSE OR is_deleted IS NULL)';
    }

    const [rows] = await pool.execute(sql);
    return rows.map(row => row.provider_type).filter(Boolean);
}

/**
 * 根据类型查询账号
 * @param {string} providerType - 提供商类型
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>}
 */
export async function findByType(providerType, options = {}) {
    if (!providerType) {
        return [];
    }
    return await findAll(providerType, options);
}

/**
 * 分页查询账号
 * @param {string} providerType - 提供商类型
 * @param {Object} options - 分页选项
 * @returns {Promise<Array>}
 */
export async function findPaged(providerType, { limit, offset, includeDeleted = false, filter = 'all', poolId = null, sortBy = 'created_at', sortOrder = 'DESC', createdAfter = null, createdBefore = null } = {}) {
    const pool = getPool();
    if (!providerType) {
        throw new Error('providerType is required for paged query');
    }

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

    let whereClause = 'WHERE provider_type = ?';
    if (filter === 'deleted') {
        whereClause += ' AND is_deleted = TRUE';
    } else if (filter === 'problem') {
        whereClause += ' AND (is_deleted = TRUE OR ((is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL)))';
    } else if (filter === 'active') {
        whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL)';
    } else {
        if (!includeDeleted) {
            whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL)';
        }
        // 添加筛选条件
        if (filter === 'healthy') {
            whereClause += ' AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL)';
        } else if (filter === 'unhealthy') {
            whereClause += ` AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW())`;
        } else if (filter === 'cooldown') {
            whereClause += ` AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW()`;
        } else if (filter === 'disabled') {
            whereClause += ' AND is_disabled = TRUE';
        }
    }

    const params = [providerType];
    whereClause = appendPoolCondition(whereClause, poolId, params);

    // 日期范围过滤
    if (createdAfter) {
        whereClause += ' AND created_at >= ?';
        params.push(createdAfter);
    }
    if (createdBefore) {
        whereClause += ' AND created_at <= ?';
        params.push(createdBefore);
    }

    // 构建排序子句 - 支持多种排序字段
    const allowedSortFields = {
        'created_at': 'created_at',
        'updated_at': 'updated_at',
        'usage_count': 'usage_count',
        'error_count': 'error_count',
        'last_used': 'last_used',
        'current_usage': 'current_usage',
        'usage_limit': 'usage_limit',
        'is_healthy': 'is_healthy',
        'is_disabled': 'is_disabled',
        'custom_name': 'custom_name'
    };

    const sortField = allowedSortFields[sortBy] || 'created_at';
    const sortDirection = (sortOrder && sortOrder.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

    // 对于用量百分比排序，使用计算字段
    let orderByClause;
    if (sortBy === 'usage_percent') {
        orderByClause = `ORDER BY CASE
            WHEN usage_limit > 0 THEN (current_usage / usage_limit)
            ELSE 0
        END ${sortDirection}, created_at DESC`;
    } else {
        orderByClause = `ORDER BY ${sortField} ${sortDirection}, created_at DESC`;
    }

    const sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            last_health_check_time, scheduled_recovery_time,
            check_health, check_model_name, last_health_check_model,
            not_supported_models, available_models, max_devices,
            subscription_title, usage_limit, current_usage, next_reset_time,
            free_trial_expiry, usage_info_updated_at,
            created_at, updated_at
        FROM providers
        ${whereClause}
        ${orderByClause}
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;

    const [rows] = await pool.execute(sql, params);

    return rows.map(row => ({
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        not_supported_models: row.not_supported_models ?
            (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) :
            null,
        available_models: row.available_models ?
            (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models) :
            null,
        is_healthy: Boolean(row.is_healthy),
        is_disabled: Boolean(row.is_disabled),
        is_deleted: Boolean(row.is_deleted),
        // 用量字段映射为 camelCase
        subscriptionTitle: row.subscription_title,
        usageLimit: row.usage_limit,
        currentUsage: row.current_usage,
        nextResetTime: row.next_reset_time,
        freeTrialExpiry: row.free_trial_expiry,
        usageInfoUpdatedAt: row.usage_info_updated_at
    }));
}

/**
 * 分页查询所有账号
 * @param {Object} options - 分页选项
 * @returns {Promise<Array>}
 */
export async function findPagedAll({ limit, offset, includeDeleted = false, filter = 'all', poolId = null } = {}) {
    const pool = getPool();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

    let whereClause = 'WHERE 1=1';
    if (filter === 'deleted') {
        whereClause += ' AND is_deleted = TRUE';
    } else if (filter === 'problem') {
        whereClause += ' AND (is_deleted = TRUE OR ((is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL)))';
    } else if (filter === 'active') {
        whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL)';
    } else {
        if (!includeDeleted) {
            whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL)';
        }
        if (filter === 'healthy') {
            whereClause += ' AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL)';
        } else if (filter === 'unhealthy') {
            whereClause += ` AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW())`;
        } else if (filter === 'cooldown') {
            whereClause += ` AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW()`;
        } else if (filter === 'disabled') {
            whereClause += ' AND is_disabled = TRUE';
        }
    }

    const params = [];
    whereClause = appendPoolCondition(whereClause, poolId, params);

    const sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            last_health_check_time, scheduled_recovery_time,
            check_health, check_model_name, last_health_check_model,
            not_supported_models, available_models, max_devices,
            subscription_title, usage_limit, current_usage, next_reset_time,
            free_trial_expiry, usage_info_updated_at,
            created_at, updated_at
        FROM providers
        ${whereClause}
        ORDER BY provider_type, created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;

    const [rows] = await pool.execute(sql, params);

    return rows.map(row => ({
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        not_supported_models: row.not_supported_models ?
            (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) :
            null,
        available_models: row.available_models ?
            (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models) :
            null,
        is_healthy: Boolean(row.is_healthy),
        is_disabled: Boolean(row.is_disabled),
        is_deleted: Boolean(row.is_deleted),
        // 用量字段映射为 camelCase
        subscriptionTitle: row.subscription_title,
        usageLimit: row.usage_limit,
        currentUsage: row.current_usage,
        nextResetTime: row.next_reset_time,
        freeTrialExpiry: row.free_trial_expiry,
        usageInfoUpdatedAt: row.usage_info_updated_at
    }));
}

/**
 * 获取全量账号统计
 * @param {string} filter - 筛选条件
 * @returns {Promise<Object>}
 */
export async function getAllCounts(filter = 'all', poolId = null) {
    const pool = getPool();
    let summarySql = `
        SELECT
            COUNT(*) AS totalWithDeleted,
            SUM(CASE WHEN is_deleted = FALSE OR is_deleted IS NULL THEN 1 ELSE 0 END) AS totalActive,
            SUM(CASE WHEN is_deleted = TRUE THEN 1 ELSE 0 END) AS deletedCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL) THEN 1 ELSE 0 END) AS healthyCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_disabled = TRUE THEN 1 ELSE 0 END) AS disabledCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW() THEN 1 ELSE 0 END) AS cooldownCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW()) THEN 1 ELSE 0 END) AS unhealthyCount
        FROM providers
        WHERE 1=1
    `;
    const params = [];
    summarySql = appendPoolCondition(summarySql, poolId, params);
    const [summaryRows] = await pool.execute(summarySql, params);
    if (!summaryRows.length) {
        return {
            totalCount: 0,
            totalWithDeleted: 0,
            totalActive: 0,
            healthyCount: 0,
            disabledCount: 0,
            deletedCount: 0,
            cooldownCount: 0,
            unhealthyCount: 0
        };
    }

    const summary = summaryRows[0];
    const totalWithDeleted = Number(summary.totalWithDeleted) || 0;
    const totalActive = Number(summary.totalActive) || 0;
    const healthyCount = Number(summary.healthyCount) || 0;
    const disabledCount = Number(summary.disabledCount) || 0;
    const deletedCount = Number(summary.deletedCount) || 0;
    const cooldownCount = Number(summary.cooldownCount) || 0;
    const unhealthyCount = Number(summary.unhealthyCount) || 0;

    let totalCount = totalActive;
    if (filter === 'healthy') {
        totalCount = healthyCount;
    } else if (filter === 'disabled') {
        totalCount = disabledCount;
    } else if (filter === 'deleted') {
        totalCount = deletedCount;
    } else if (filter === 'problem') {
        totalCount = deletedCount + unhealthyCount + cooldownCount;
    } else if (filter === 'active') {
        totalCount = Math.max(totalActive - disabledCount, 0);
    } else if (filter === 'unhealthy') {
        totalCount = unhealthyCount;
    } else if (filter === 'cooldown') {
        totalCount = cooldownCount;
    } else if (filter === 'all') {
        totalCount = totalWithDeleted;
    }

    return {
        totalCount,
        totalWithDeleted,
        totalActive,
        healthyCount,
        disabledCount,
        deletedCount,
        cooldownCount,
        unhealthyCount
    };
}

/**
 * 获取提供商类型的统计数量
 * @param {string} providerType - 提供商类型
 * @returns {Promise<{totalCount: number, healthyCount: number}>}
 */
export async function getTypeCounts(providerType, filter = 'all', poolId = null, { createdAfter = null, createdBefore = null } = {}) {
    const pool = getPool();

    let summarySql = `
        SELECT
            COUNT(*) AS totalWithDeleted,
            SUM(CASE WHEN is_deleted = FALSE OR is_deleted IS NULL THEN 1 ELSE 0 END) AS totalActive,
            SUM(CASE WHEN is_deleted = TRUE THEN 1 ELSE 0 END) AS deletedCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL) THEN 1 ELSE 0 END) AS healthyCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_disabled = TRUE THEN 1 ELSE 0 END) AS disabledCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW() THEN 1 ELSE 0 END) AS cooldownCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW()) THEN 1 ELSE 0 END) AS unhealthyCount
        FROM providers
        WHERE provider_type = ?
    `;
    const params = [providerType];
    summarySql = appendPoolCondition(summarySql, poolId, params);
    if (createdAfter) {
        summarySql += ' AND created_at >= ?';
        params.push(createdAfter);
    }
    if (createdBefore) {
        summarySql += ' AND created_at <= ?';
        params.push(createdBefore);
    }
    const [summaryRows] = await pool.execute(summarySql, params);
    if (!summaryRows.length) {
        return {
            totalCount: 0,
            totalWithDeleted: 0,
            totalActive: 0,
            healthyCount: 0,
            disabledCount: 0,
            deletedCount: 0,
            cooldownCount: 0,
            unhealthyCount: 0
        };
    }

    const summary = summaryRows[0];
    const totalWithDeleted = Number(summary.totalWithDeleted) || 0;
    const totalActive = Number(summary.totalActive) || 0;
    const healthyCount = Number(summary.healthyCount) || 0;
    const disabledCount = Number(summary.disabledCount) || 0;
    const deletedCount = Number(summary.deletedCount) || 0;
    const cooldownCount = Number(summary.cooldownCount) || 0;
    const unhealthyCount = Number(summary.unhealthyCount) || 0;

    let totalCount = totalActive;
    if (filter === 'healthy') {
        totalCount = healthyCount;
    } else if (filter === 'disabled') {
        totalCount = disabledCount;
    } else if (filter === 'deleted') {
        totalCount = deletedCount;
    } else if (filter === 'problem') {
        totalCount = deletedCount + unhealthyCount + cooldownCount;
    } else if (filter === 'active') {
        totalCount = Math.max(totalActive - disabledCount, 0);
    } else if (filter === 'unhealthy') {
        totalCount = unhealthyCount;
    } else if (filter === 'cooldown') {
        totalCount = cooldownCount;
    } else if (filter === 'all') {
        totalCount = totalWithDeleted;
    }

    return {
        totalCount,
        totalWithDeleted,
        totalActive,
        healthyCount,
        disabledCount,
        deletedCount,
        cooldownCount,
        unhealthyCount
    };
}

/**
 * 按筛选条件查询所有匹配的 provider UUID（用于批量删除）
 * @param {string} providerType - 提供商类型
 * @param {Object} options - 筛选选项
 * @returns {Promise<Array<{uuid: string, oauth_credential_id: number|null}>>}
 */
export async function findUuidsByFilter(providerType, { filter = 'all', poolId = null, createdAfter = null, createdBefore = null, search = '' } = {}) {
    const pool = getPool();
    if (!providerType) return [];

    let whereClause = 'WHERE provider_type = ?';
    if (filter === 'deleted') {
        whereClause += ' AND is_deleted = TRUE';
    } else if (filter === 'problem') {
        whereClause += ' AND (is_deleted = TRUE OR ((is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL)))';
    } else if (filter === 'active') {
        whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL)';
    } else if (filter === 'healthy') {
        whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL) AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL)';
    } else if (filter === 'unhealthy') {
        whereClause += ` AND (is_deleted = FALSE OR is_deleted IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW())`;
    } else if (filter === 'cooldown') {
        whereClause += ` AND (is_deleted = FALSE OR is_deleted IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW()`;
    } else if (filter === 'disabled') {
        whereClause += ' AND (is_deleted = FALSE OR is_deleted IS NULL) AND is_disabled = TRUE';
    } else {
        // 'all' - include everything
    }

    const params = [providerType];
    whereClause = appendPoolCondition(whereClause, poolId, params);

    if (createdAfter) {
        whereClause += ' AND created_at >= ?';
        params.push(createdAfter);
    }
    if (createdBefore) {
        whereClause += ' AND created_at <= ?';
        params.push(createdBefore);
    }

    if (typeof search === 'string' && search.trim()) {
        const searchLike = `%${search.trim().toLowerCase()}%`;
        whereClause += ` AND (
            LOWER(uuid) LIKE ?
            OR LOWER(COALESCE(custom_name, JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.customName')), JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.custom_name')), '')) LIKE ?
            OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.email')), '')) LIKE ?
            OR LOWER(COALESCE(last_error_message, JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.lastErrorMessage')), JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.last_error_message')), '')) LIKE ?
        )`;
        params.push(searchLike, searchLike, searchLike, searchLike);
    }

    const sql = `SELECT uuid, oauth_credential_id FROM providers ${whereClause}`;
    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * 根据 UUID 查询单个账号
 * @param {string} uuid - 账号 UUID
 * @returns {Promise<Object|null>}
 */
export async function findByUuid(uuid) {
    const pool = getPool();

    const sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            last_health_check_time, scheduled_recovery_time,
            check_health, check_model_name, last_health_check_model,
            not_supported_models, available_models, max_devices,
            subscription_title, usage_limit, current_usage, next_reset_time,
            free_trial_expiry, usage_info_updated_at,
            created_at, updated_at
        FROM providers
        WHERE uuid = ?
    `;

    const [rows] = await pool.execute(sql, [uuid]);

    if (rows.length === 0) {
        return null;
    }

    const row = rows[0];
    return {
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        not_supported_models: row.not_supported_models ?
            (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) :
            null,
        available_models: row.available_models ?
            (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models) :
            null,
        is_healthy: Boolean(row.is_healthy),
        is_disabled: Boolean(row.is_disabled),
        // 用量字段映射为 camelCase
        subscriptionTitle: row.subscription_title,
        usageLimit: row.usage_limit,
        currentUsage: row.current_usage,
        nextResetTime: row.next_reset_time,
        freeTrialExpiry: row.free_trial_expiry,
        usageInfoUpdatedAt: row.usage_info_updated_at
    };
}

/**
 * 获取指定提供商类型的池子统计
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Array>}
 */
export async function getPoolCounts(providerType) {
    const pool = getPool();
    const sql = `
        SELECT
            COALESCE(pool_id, 0) AS pool_id,
            COUNT(*) AS totalWithDeleted,
            SUM(CASE WHEN is_deleted = FALSE OR is_deleted IS NULL THEN 1 ELSE 0 END) AS totalActive,
            SUM(CASE WHEN is_deleted = TRUE THEN 1 ELSE 0 END) AS deletedCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_healthy = TRUE AND (is_disabled = FALSE OR is_disabled IS NULL) THEN 1 ELSE 0 END) AS healthyCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND is_disabled = TRUE THEN 1 ELSE 0 END) AS disabledCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND ${EFFECTIVE_RECOVERY_TIME_SQL} IS NOT NULL AND ${EFFECTIVE_RECOVERY_TIME_SQL} > NOW() THEN 1 ELSE 0 END) AS cooldownCount,
            SUM(CASE WHEN (is_deleted = FALSE OR is_deleted IS NULL) AND (is_disabled = FALSE OR is_disabled IS NULL) AND (is_healthy = FALSE OR is_healthy IS NULL) AND (${EFFECTIVE_RECOVERY_TIME_SQL} IS NULL OR ${EFFECTIVE_RECOVERY_TIME_SQL} <= NOW()) THEN 1 ELSE 0 END) AS unhealthyCount
        FROM providers
        WHERE provider_type = ?
        GROUP BY COALESCE(pool_id, 0)
    `;
    const [rows] = await pool.execute(sql, [providerType]);
    return rows.map(row => ({
        poolId: Number(row.pool_id) || 0,
        totalWithDeleted: Number(row.totalWithDeleted) || 0,
        totalActive: Number(row.totalActive) || 0,
        deletedCount: Number(row.deletedCount) || 0,
        healthyCount: Number(row.healthyCount) || 0,
        disabledCount: Number(row.disabledCount) || 0,
        cooldownCount: Number(row.cooldownCount) || 0,
        unhealthyCount: Number(row.unhealthyCount) || 0
    }));
}

/**
 * 将未绑定池子的账号绑定到默认池
 * @param {string} providerType - 提供商类型
 * @param {number} defaultPoolId - 默认池ID
 * @returns {Promise<number>} 影响行数
 */
export async function assignDefaultPoolId(providerType, defaultPoolId) {
    const pool = getPool();
    if (!providerType || !Number.isFinite(Number(defaultPoolId))) {
        return 0;
    }
    const sql = `
        UPDATE providers
        SET pool_id = ?
        WHERE provider_type = ?
          AND (pool_id IS NULL OR pool_id = 0)
    `;
    const [result] = await pool.execute(sql, [defaultPoolId, providerType]);
    return result.affectedRows || 0;
}

/**
 * 批量查询账号（按UUID）
 * @param {string[]} uuids - 账号UUID列表
 * @returns {Promise<Array>}
 */
export async function findByUuids(uuids = []) {
    if (!Array.isArray(uuids) || uuids.length === 0) {
        return [];
    }

    const pool = getPool();
    const placeholders = uuids.map(() => '?').join(', ');
    const sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            last_health_check_time, scheduled_recovery_time,
            check_health, check_model_name, last_health_check_model,
            not_supported_models, available_models, max_devices,
            subscription_title, usage_limit, current_usage, next_reset_time,
            free_trial_expiry, usage_info_updated_at,
            created_at, updated_at
        FROM providers
        WHERE uuid IN (${placeholders})
    `;

    const [rows] = await pool.execute(sql, uuids);
    return rows.map(row => ({
        ...row,
        credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
        not_supported_models: row.not_supported_models ?
            (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models) :
            null,
        available_models: row.available_models ?
            (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models) :
            null,
        is_healthy: Boolean(row.is_healthy),
        is_disabled: Boolean(row.is_disabled),
        subscriptionTitle: row.subscription_title,
        usageLimit: row.usage_limit,
        currentUsage: row.current_usage,
        nextResetTime: row.next_reset_time,
        freeTrialExpiry: row.free_trial_expiry,
        usageInfoUpdatedAt: row.usage_info_updated_at
    }));
}

/**
 * 创建账号
 * @param {Object} provider - 账号对象
 * @returns {Promise<Object>}
 */
export async function create(provider) {
    const pool = getPool();

    const sql = `
        INSERT INTO providers (
            uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, usage_count, error_count,
            check_health, check_model_name, not_supported_models
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        provider.uuid,
        provider.provider_type,
        provider.pool_id ?? null,
        provider.custom_name || null,
        provider.oauth_credential_id || null,
        JSON.stringify(provider.credentials),
        provider.is_healthy !== undefined ? provider.is_healthy : true,
        provider.is_disabled !== undefined ? provider.is_disabled : false,
        provider.usage_count || 0,
        provider.error_count || 0,
        provider.check_health !== undefined ? provider.check_health : false,
        provider.check_model_name || null,
        provider.not_supported_models ? JSON.stringify(provider.not_supported_models) : null
    ];

    await pool.execute(sql, params);

    return findByUuid(provider.uuid);
}

/**
 * 转换 Date 对象或 ISO 字符串为 MySQL datetime 格式
 */
function toMySQLDatetime(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 更新账号
 * @param {string} uuid - 账号 UUID
 * @param {Object} updates - 更新字段
 * @returns {Promise<Object>}
 */
export async function update(uuid, updates) {
    const pool = getPool();

    // 白名单：只允许更新这些字段
    const ALLOWED_FIELDS = [
        'provider_type', 'pool_id', 'credentials', 'is_healthy', 'is_disabled', 'is_deleted',
        'custom_name', 'usage_count', 'last_used', 'error_count', 'last_error', 'last_error_time',
        'last_error_message', 'available_models', 'not_supported_models', 'max_devices', 'oauth_credential_id',
        'scheduled_recovery_time', 'recovery_time', 'notes', 'check_health', 'check_model_name',
        'last_health_check_model', 'last_health_check_time'
    ];

    const DATETIME_FIELDS = ['last_used', 'last_error_time', 'scheduled_recovery_time', 'recovery_time'];

    const fields = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
        if (!ALLOWED_FIELDS.includes(key)) {
            console.warn(`[ProviderDAO] Ignoring unknown field in update: ${key}`);
            continue;
        }
        if (key === 'credentials' || key === 'not_supported_models' || key === 'available_models') {
            fields.push(`${key} = ?`);
            params.push(JSON.stringify(value));
        } else if (DATETIME_FIELDS.includes(key)) {
            fields.push(`${key} = ?`);
            params.push(toMySQLDatetime(value));
        } else {
            fields.push(`${key} = ?`);
            params.push(value);
        }
    }

    if (fields.length === 0) {
        return findByUuid(uuid);
    }

    params.push(uuid);

    const sql = `UPDATE providers SET ${fields.join(', ')} WHERE uuid = ?`;

    await pool.execute(sql, params);

    const updated = await findByUuid(uuid);

    // Phase 1: update() 也可能是一次软删(pool manager 内部会直接 update({is_deleted: true}))
    // 这种路径没有走 markDeleted,需要在这里补发 deleted 事件,触发 adapter 清理 + 广播
    if (updates && (updates.is_deleted === true || updates.is_deleted === 1)) {
        emitProviderDeleted({
            uuid,
            providerType: updated?.provider_type || null,
            hard: false,
            reason: updates.last_error_message || null
        });
    }

    return updated;
}

/**
 * 删除账号
 * @param {string} uuid - 账号 UUID
 * @returns {Promise<boolean>}
 */
export async function deleteProvider(uuid) {
    const pool = getPool();
    // 先拿到 provider 类型用于事件,再执行物理删除
    let providerType = null;
    try {
        const [rows] = await pool.execute('SELECT provider_type FROM providers WHERE uuid = ? LIMIT 1', [uuid]);
        if (Array.isArray(rows) && rows.length > 0) {
            providerType = rows[0]?.provider_type || null;
        }
    } catch (_error) { /* swallow,不影响删除主流程 */ }

    const sql = 'DELETE FROM providers WHERE uuid = ?';
    const [result] = await pool.execute(sql, [uuid]);
    const ok = result.affectedRows > 0;
    if (ok) {
        emitProviderDeleted({ uuid, providerType, hard: true });
    }
    return ok;
}

/**
 * 更新使用计数
 * @param {string} uuid - 账号 UUID
 * @param {number} usageCount - 使用次数
 * @returns {Promise<void>}
 */
export async function updateUsage(uuid, usageCount) {
    const pool = getPool();
    const sql = 'UPDATE providers SET usage_count = ?, last_used = NOW() WHERE uuid = ?';
    await pool.execute(sql, [usageCount, uuid]);
}

/**
 * 标记账号为不健康
 * @param {string} uuid - 账号 UUID
 * @param {Object} errorInfo - 错误信息
 * @returns {Promise<void>}
 */
export async function markUnhealthy(uuid, errorInfo) {
    const pool = getPool();
    const sql = `
        UPDATE providers
        SET is_healthy = ?,
            error_count = ?,
            last_error_time = NOW(),
            last_error_message = ?,
            scheduled_recovery_time = NULL
        WHERE uuid = ?
    `;
    await pool.execute(sql, [
        errorInfo?.isHealthy === true,
        errorInfo.errorCount || 0,
        errorInfo.errorMessage || null,
        uuid
    ]);
}

/**
 * 标记账号为健康
 * @param {string} uuid - 账号 UUID
 * @returns {Promise<void>}
 */
export async function markHealthy(uuid) {
    const pool = getPool();
    const sql = `
        UPDATE providers
        SET is_healthy = TRUE,
            error_count = 0,
            last_error_time = NULL,
            last_error_message = NULL,
            scheduled_recovery_time = NULL
        WHERE uuid = ?
    `;
    await pool.execute(sql, [uuid]);
}

/**
 * 标记账号为已删除（软删除）
 * @param {string} uuid - 账号 UUID
 * @param {string} reason - 删除原因
 * @returns {Promise<void>}
 */
export async function markDeleted(uuid, reason = null) {
    const pool = getPool();
    let providerType = null;
    try {
        const [rows] = await pool.execute('SELECT provider_type FROM providers WHERE uuid = ? LIMIT 1', [uuid]);
        if (Array.isArray(rows) && rows.length > 0) {
            providerType = rows[0]?.provider_type || null;
        }
    } catch (_error) { /* swallow */ }

    const sql = `
        UPDATE providers
        SET is_deleted = TRUE,
            is_healthy = FALSE,
            last_error_message = ?
        WHERE uuid = ?
    `;
    await pool.execute(sql, [reason || '403 Forbidden - Account deleted', uuid]);
    emitProviderDeleted({ uuid, providerType, hard: false, reason });
}

/**
 * 恢复已删除账号
 * @param {string} uuid - 账号 UUID
 * @returns {Promise<void>}
 */
export async function recoverDeleted(uuid) {
    const pool = getPool();
    const sql = `
        UPDATE providers
        SET is_deleted = FALSE,
            is_healthy = TRUE,
            error_count = 0,
            last_error_time = NULL,
            last_error_message = NULL,
            scheduled_recovery_time = NULL
        WHERE uuid = ?
    `;
    await pool.execute(sql, [uuid]);
}

/**
 * 获取提供商摘要统计
 * @returns {Promise<Object>}
 */
export async function getSummary() {
    const pool = getPool();
    const sql = `
        SELECT
            provider_type,
            COUNT(*) as total,
            SUM(CASE WHEN (is_disabled = FALSE OR is_disabled IS NULL) THEN 1 ELSE 0 END) as enabled,
            SUM(CASE WHEN is_disabled = TRUE THEN 1 ELSE 0 END) as disabled
        FROM providers
        GROUP BY provider_type
    `;
    const [rows] = await pool.execute(sql);

    const summary = {};
    rows.forEach(row => {
        summary[row.provider_type] = {
            total: Number(row.total),
            enabled: Number(row.enabled),
            disabled: Number(row.disabled)
        };
    });

    return summary;
}

/**
 * 更新用量摘要信息
 */
export async function updateUsageInfo(uuid, usageInfo) {
    const pool = getPool();
    const sql = `
        UPDATE providers
        SET subscription_title = COALESCE(?, subscription_title),
            usage_limit = COALESCE(?, usage_limit),
            current_usage = COALESCE(?, current_usage),
            next_reset_time = COALESCE(?, next_reset_time),
            free_trial_expiry = COALESCE(?, free_trial_expiry),
            usage_info_updated_at = NOW()
        WHERE uuid = ?
    `;
    const params = [
        usageInfo.subscriptionTitle ?? null,
        usageInfo.usageLimit ?? null,
        usageInfo.currentUsage ?? null,
        usageInfo.nextResetTime ?? null,
        usageInfo.freeTrialExpiry ?? null,
        uuid
    ];
    const [result] = await pool.execute(sql, params);
    return result.affectedRows > 0;
}

/**
 * 按提供商类型汇总用量统计（用于首页/汇总视图）
 * @param {string[]|null} providerTypes
 * @param {Object} thresholds
 * @returns {Promise<Object<string, Object>>}
 */
export async function getUsageSummaryByTypes(providerTypes = null, thresholds = {}) {
    const pool = getPool();
    const warn = Number.isFinite(Number(thresholds.warn)) ? Number(thresholds.warn) : 80;
    const disable = Number.isFinite(Number(thresholds.disable)) ? Number(thresholds.disable) : 95;

    const params = [warn, disable, disable];
    let whereClause = 'WHERE (is_deleted = FALSE OR is_deleted IS NULL)';
    if (Array.isArray(providerTypes) && providerTypes.length > 0) {
        const placeholders = providerTypes.map(() => '?').join(', ');
        whereClause += ` AND provider_type IN (${placeholders})`;
        params.push(...providerTypes);
    }

    const sql = `
        SELECT
            provider_type,
            COUNT(*) AS total,
            SUM(has_usage) AS with_usage,
            AVG(CASE WHEN has_usage = 1 THEN percent END) AS avg_percent,
            MAX(CASE WHEN has_usage = 1 THEN percent ELSE 0 END) AS max_percent,
            MIN(CASE WHEN has_usage = 1 THEN remaining_percent END) AS min_remaining_percent,
            SUM(CASE WHEN has_usage = 1 AND percent >= ? AND percent < ? THEN 1 ELSE 0 END) AS warning_count,
            SUM(CASE WHEN has_usage = 1 AND percent >= ? THEN 1 ELSE 0 END) AS critical_count
        FROM (
            SELECT
                provider_type,
                CASE WHEN current_usage IS NOT NULL OR usage_limit IS NOT NULL THEN 1 ELSE 0 END AS has_usage,
                CASE WHEN usage_limit > 0 THEN (COALESCE(current_usage, 0) / usage_limit) * 100 ELSE 0 END AS percent,
                CASE WHEN usage_limit > 0 THEN (1 - (COALESCE(current_usage, 0) / usage_limit)) * 100 ELSE NULL END AS remaining_percent
            FROM providers
            ${whereClause}
        ) AS usage_rows
        GROUP BY provider_type
    `;

    const [rows] = await pool.execute(sql, params);
    const summaryMap = {};
    for (const row of rows) {
        summaryMap[row.provider_type] = {
            total: Number(row.total) || 0,
            withUsage: Number(row.with_usage) || 0,
            avgPercent: row.avg_percent !== null ? Number(row.avg_percent) : 0,
            maxPercent: row.max_percent !== null ? Number(row.max_percent) : 0,
            minRemainingPercent: row.min_remaining_percent !== null ? Number(row.min_remaining_percent) : null,
            warningCount: Number(row.warning_count) || 0,
            criticalCount: Number(row.critical_count) || 0
        };
    }
    return summaryMap;
}

/**
 * 查询可用账号（用于 selectProvider 优化）
 * 直接在 SQL 层面过滤：健康、未禁用、未删除
 * @param {string} providerType - 提供商类型
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>}
 */
export async function findAvailable(providerType, options = {}) {
    const pool = getPool();
    const { poolId = null, requestedModel = null } = options;

    let sql = `
        SELECT
            id, uuid, provider_type, pool_id, custom_name, oauth_credential_id, credentials,
            is_healthy, is_disabled, is_deleted, usage_count, error_count,
            last_used, last_error_time, last_error_message,
            not_supported_models, available_models, max_devices
        FROM providers
        WHERE provider_type = ?
          AND is_healthy = TRUE
          AND (is_disabled = FALSE OR is_disabled IS NULL)
          AND (is_deleted = FALSE OR is_deleted IS NULL)
    `;

    const params = [providerType];

    // 池子过滤
    sql = appendPoolCondition(sql, poolId, params);

    sql += ' ORDER BY uuid';

    const [rows] = await pool.execute(sql, params);

    // 解析 JSON 字段并过滤模型支持
    const results = [];
    for (const row of rows) {
        const notSupportedModels = row.not_supported_models
            ? (typeof row.not_supported_models === 'string' ? JSON.parse(row.not_supported_models) : row.not_supported_models)
            : null;
        const availableModels = row.available_models
            ? (typeof row.available_models === 'string' ? JSON.parse(row.available_models) : row.available_models)
            : null;

        // 如果指定了模型，检查模型支持（方案B：白名单优先）
        if (requestedModel) {
            // 1. 如果有白名单(available_models)，模型必须在白名单中
            if (availableModels && availableModels.length > 0) {
                if (!availableModels.includes(requestedModel)) {
                    continue;
                }
            } else {
                // 2. 没有白名单，检查黑名单
                if (notSupportedModels && notSupportedModels.includes(requestedModel)) {
                    continue;
                }
            }
            // 3. 都没配置，默认支持
        }

        results.push({
            ...row,
            credentials: typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials,
            not_supported_models: notSupportedModels,
            available_models: availableModels,
            is_healthy: Boolean(row.is_healthy),
            is_disabled: Boolean(row.is_disabled),
            is_deleted: Boolean(row.is_deleted)
        });
    }

    return results;
}

/**
 * 查询需要恢复检查的账号
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Array>}
 */
export async function findScheduledRecovery(providerType) {
    const pool = getPool();

    let sql = `
        SELECT uuid, scheduled_recovery_time, credentials
        FROM providers
        WHERE (is_deleted = FALSE OR is_deleted IS NULL)
          AND (is_disabled = FALSE OR is_disabled IS NULL)
          AND scheduled_recovery_time IS NOT NULL
          AND scheduled_recovery_time <= NOW()
    `;

    const params = [];
    if (providerType) {
        sql += ' AND provider_type = ?';
        params.push(providerType);
    }

    const [rows] = await pool.execute(sql, params);
    return rows.map((row) => ({
        ...row,
        credentials: typeof row.credentials === 'string'
            ? (() => {
                try { return JSON.parse(row.credentials); } catch { return {}; }
            })()
            : (row.credentials || {})
    }));
}

/**
 * 更新账号可用模型列表
 * @param {string} uuid - 账号 UUID
 * @param {Array<string>} availableModels - 可用模型列表
 * @returns {Promise<boolean>}
 */
export async function updateAvailableModels(uuid, availableModels) {
    const pool = getPool();
    const sql = `
        UPDATE providers
        SET available_models = ?
        WHERE uuid = ?
    `;
    const params = [
        JSON.stringify(availableModels || []),
        uuid
    ];
    const [result] = await pool.execute(sql, params);
    return result.affectedRows > 0;
}
