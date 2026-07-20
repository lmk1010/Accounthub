/**
 * Request Logs DAO - 请求日志数据访问层
 */

import { getPool } from '../config/database.js';

let requestLogsColumnsCache = null;
let requestLogsColumnsLoaded = false;
let requestLogsColumnsEnsured = false;

const REQUEST_LOGS_OPTIONAL_COLUMNS = [
    {
        name: 'error_stack',
        ddl: `ALTER TABLE request_logs ADD COLUMN error_stack TEXT DEFAULT NULL COMMENT '错误堆栈' AFTER error_message`
    },
    {
        name: 'error_detail',
        ddl: `ALTER TABLE request_logs ADD COLUMN error_detail TEXT DEFAULT NULL COMMENT '错误详情' AFTER error_stack`
    },
    {
        name: 'curl_command',
        ddl: `ALTER TABLE request_logs ADD COLUMN curl_command MEDIUMTEXT DEFAULT NULL COMMENT '完整curl命令' AFTER error_detail`
    },
    {
        name: 'user_id',
        ddl: `ALTER TABLE request_logs ADD COLUMN user_id VARCHAR(64) DEFAULT NULL COMMENT '调用端User ID'`
    },
    {
        name: 'user_email',
        ddl: `ALTER TABLE request_logs ADD COLUMN user_email VARCHAR(128) DEFAULT NULL COMMENT '调用端User Email'`
    },
    {
        name: 'username',
        ddl: `ALTER TABLE request_logs ADD COLUMN username VARCHAR(128) DEFAULT NULL COMMENT '调用端Username'`
    },
    {
        name: 'ttft_ms',
        ddl: `ALTER TABLE request_logs ADD COLUMN ttft_ms INT DEFAULT NULL COMMENT '首字耗时(ms)' AFTER duration_ms`
    },
    {
        name: 'cache_creation_tokens',
        ddl: `ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INT DEFAULT 0 COMMENT '缓存创建tokens' AFTER output_tokens`
    },
    {
        name: 'cache_read_tokens',
        ddl: `ALTER TABLE request_logs ADD COLUMN cache_read_tokens INT DEFAULT 0 COMMENT '缓存读取tokens' AFTER cache_creation_tokens`
    },
    {
        name: 'proxy_node_id',
        ddl: `ALTER TABLE request_logs ADD COLUMN proxy_node_id INT DEFAULT NULL COMMENT '代理节点ID' AFTER username`
    },
    {
        name: 'proxy_node_name',
        ddl: `ALTER TABLE request_logs ADD COLUMN proxy_node_name VARCHAR(128) DEFAULT NULL COMMENT '代理节点名称' AFTER proxy_node_id`
    },
    {
        name: 'proxy_node_host',
        ddl: `ALTER TABLE request_logs ADD COLUMN proxy_node_host VARCHAR(255) DEFAULT NULL COMMENT '代理节点主机' AFTER proxy_node_name`
    },
    {
        name: 'proxy_node_port',
        ddl: `ALTER TABLE request_logs ADD COLUMN proxy_node_port INT DEFAULT NULL COMMENT '代理节点端口' AFTER proxy_node_host`
    },
    {
        name: 'proxy_node_protocol',
        ddl: `ALTER TABLE request_logs ADD COLUMN proxy_node_protocol VARCHAR(16) DEFAULT NULL COMMENT '代理节点协议' AFTER proxy_node_port`
    }
];

async function loadRequestLogsColumns() {
    if (requestLogsColumnsLoaded) {
        return requestLogsColumnsCache;
    }
    requestLogsColumnsLoaded = true;
    try {
        const pool = getPool();
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'request_logs'`
        );
        requestLogsColumnsCache = new Set(rows.map(row => row.COLUMN_NAME));
    } catch (error) {
        requestLogsColumnsLoaded = false;
        requestLogsColumnsCache = null;
        throw error;
    }
    return requestLogsColumnsCache;
}

async function ensureRequestLogsColumns() {
    if (requestLogsColumnsEnsured) {
        return requestLogsColumnsCache;
    }

    let columns = null;
    try {
        columns = await loadRequestLogsColumns();
    } catch (error) {
        console.warn('[RequestLogsDao] Failed to load request_logs columns for ensure:', error.message);
        return null;
    }
    if (!columns) return null;

    const pool = getPool();
    let altered = false;
    let allSuccess = true;

    for (const column of REQUEST_LOGS_OPTIONAL_COLUMNS) {
        if (columns.has(column.name)) continue;
        try {
            await pool.execute(column.ddl);
            altered = true;
            console.log(`[RequestLogsDao] Added missing request_logs column: ${column.name}`);
        } catch (error) {
            // 如果是"列已存在"错误，忽略
            if (error.code === 'ER_DUP_FIELDNAME' || error.message?.includes('Duplicate column')) {
                console.log(`[RequestLogsDao] Column ${column.name} already exists`);
            } else {
                console.warn(`[RequestLogsDao] Failed to add request_logs column ${column.name}:`, error.message);
                allSuccess = false;
            }
        }
    }

    if (altered) {
        requestLogsColumnsLoaded = false;
        requestLogsColumnsCache = null;
        columns = await loadRequestLogsColumns();
    }

    // 只有全部成功才标记为已完成，否则下次还会重试
    if (allSuccess) {
        requestLogsColumnsEnsured = true;
    }

    return columns;
}

export function buildInsertPayload(record, columns) {
    const columnValues = {
        provider_uuid: record.provider_uuid ?? record.providerUuid,
        provider_type: record.provider_type ?? record.providerType,
        pool_id: record.pool_id ?? record.poolId ?? 0,
        request_model: record.request_model ?? record.requestModel ?? null,
        status_code: normalizeStatusCodeValue(record.status_code ?? record.statusCode ?? null),
        is_success: record.is_success ?? record.isSuccess ?? true,
        error_type: record.error_type ?? record.errorType ?? null,
        error_message: record.error_message ?? record.errorMessage ?? null,
        error_stack: record.error_stack ?? record.errorStack ?? null,
        error_detail: record.error_detail ?? record.errorDetail ?? null,
        curl_command: record.curl_command ?? record.curlCommand ?? null,
        request_id: record.request_id ?? record.requestId ?? null,
        input_tokens: record.input_tokens ?? record.inputTokens ?? 0,
        output_tokens: record.output_tokens ?? record.outputTokens ?? 0,
        cache_creation_tokens: record.cache_creation_tokens ?? record.cacheCreationTokens ?? 0,
        cache_read_tokens: record.cache_read_tokens ?? record.cacheReadTokens ?? 0,
        credit_usage: record.credit_usage ?? record.creditUsage ?? null,
        duration_ms: record.duration_ms ?? record.durationMs ?? 0,
        ttft_ms: record.ttft_ms ?? record.ttftMs ?? null,
        client_ip: record.client_ip ?? record.clientIp ?? null,
        user_agent: record.user_agent ?? record.userAgent ?? null,
        client_token_id: record.client_token_id ?? record.clientTokenId ?? null,
        user_id: record.user_id ?? record.userId ?? null,
        user_email: record.user_email ?? record.userEmail ?? null,
        username: record.username ?? record.userName ?? record.user_name ?? null,
        proxy_node_id: record.proxy_node_id ?? record.proxyNodeId ?? null,
        proxy_node_name: record.proxy_node_name ?? record.proxyNodeName ?? null,
        proxy_node_host: record.proxy_node_host ?? record.proxyNodeHost ?? null,
        proxy_node_port: record.proxy_node_port ?? record.proxyNodePort ?? null,
        proxy_node_protocol: record.proxy_node_protocol ?? record.proxyNodeProtocol ?? null
    };

    if (!columns || columns.size === 0) {
        return {
            columns: Object.keys(columnValues),
            params: Object.values(columnValues).map(normalizeBindParam)
        };
    }

    const filteredColumns = [];
    const filteredParams = [];
    for (const [column, value] of Object.entries(columnValues)) {
        if (columns.has(column)) {
            filteredColumns.push(column);
            filteredParams.push(normalizeBindParam(value));
        }
    }

    return { columns: filteredColumns, params: filteredParams };
}

function normalizeBindParam(value) {
    return value === undefined ? null : value;
}

function normalizeStatusCodeValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
}

/**
 * 创建请求日志
 */
export async function create(record) {
    const pool = getPool();
    let columns = null;
    try {
        columns = await ensureRequestLogsColumns();
    } catch (error) {
        console.warn('[RequestLogsDao] Failed to load request_logs columns, using default insert:', error.message);
    }

    const { columns: insertColumns, params } = buildInsertPayload(record, columns);

    // 调试：检查 curl_command 和 error_stack 是否被正确传入
    if (record.curlCommand || record.curl_command) {
        const hasCurlColumn = columns?.has('curl_command');
        const curlInInsert = insertColumns.includes('curl_command');
        if (!curlInInsert) {
            console.warn(`[RequestLogsDao] curl_command not in insert! hasColumn=${hasCurlColumn}, columns=${columns ? Array.from(columns).join(',') : 'null'}`);
        }
    }

    const placeholders = insertColumns.map(() => '?').join(', ');
    const sql = `INSERT INTO request_logs (${insertColumns.join(', ')}) VALUES (${placeholders})`;

    const [result] = await pool.execute(sql, params);
    const insertId = result.insertId;

    // 异步更新 token 统计（不阻塞主流程）
    const inputTokens = record.input_tokens ?? record.inputTokens ?? 0;
    const outputTokens = record.output_tokens ?? record.outputTokens ?? 0;
    const cacheCreationTokens = record.cache_creation_tokens ?? record.cacheCreationTokens ?? 0;
    const cacheReadTokens = record.cache_read_tokens ?? record.cacheReadTokens ?? 0;
    const providerUuid = record.provider_uuid ?? record.providerUuid;
    const providerType = record.provider_type ?? record.providerType;
    const requestModel = record.request_model ?? record.requestModel;

    const hasAnyTokenUsage = inputTokens > 0 || outputTokens > 0 || cacheCreationTokens > 0 || cacheReadTokens > 0;

    // 调试日志
    if (hasAnyTokenUsage) {
        console.log('[RequestLogsDao] Token data detected:', {
            providerUuid,
            providerType,
            requestModel,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            hasUuid: !!providerUuid,
            hasModel: !!requestModel
        });
    }

    if (hasAnyTokenUsage && providerUuid && requestModel) {
        console.log('[RequestLogsDao] Attempting to update token stats...');
        import('./provider-token-stats-dao.js').then(({ incrementStats }) => {
            console.log('[RequestLogsDao] Token stats DAO imported successfully');
            return incrementStats(
                providerUuid,
                providerType,
                requestModel,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens
            );
        }).then(() => {
            console.log('[RequestLogsDao] ✅ Token stats updated successfully');
        }).catch(err => {
            console.error('[RequestLogsDao] ❌ Failed to update token stats:', err.message);
            console.error('[RequestLogsDao] Error stack:', err.stack);
        });
    } else if (hasAnyTokenUsage) {
        console.warn('[RequestLogsDao] ⚠️  Token data exists but missing required fields:', {
            hasUuid: !!providerUuid,
            hasModel: !!requestModel
        });
    }

    return insertId;
}

/**
 * 强制刷新列缓存（用于手动添加列后）
 */
export function refreshColumnsCache() {
    requestLogsColumnsLoaded = false;
    requestLogsColumnsCache = null;
    requestLogsColumnsEnsured = false;
    console.log('[RequestLogsDao] Columns cache cleared, will reload on next query');
}

/**
 * 更新请求日志中的账号UUID
 */
export async function updateProviderUuid(oldUuid, newUuid) {
    const pool = getPool();
    let columns = null;
    try {
        columns = await loadRequestLogsColumns();
    } catch (error) {
        console.warn('[RequestLogsDao] Failed to load request_logs columns for update:', error.message);
    }

    if (columns && !columns.has('provider_uuid')) {
        console.warn('[RequestLogsDao] request_logs missing provider_uuid column, skipping update');
        return 0;
    }

    const sql = 'UPDATE request_logs SET provider_uuid = ? WHERE provider_uuid = ?';
    const [result] = await pool.execute(sql, [newUuid, oldUuid]);
    return result.affectedRows;
}

/**
 * 按ID查询单条请求日志（包含大字段）
 */
export async function findById(id) {
    const pool = getPool();
    const sql = 'SELECT * FROM request_logs WHERE id = ?';
    const [rows] = await pool.execute(sql, [id]);
    return rows[0] ? normalizeRecord(rows[0]) : null;
}

/**
 * 按ID查询错误详情（只返回大字段）
 */
export async function findErrorDetailById(id) {
    const pool = getPool();
    const sql = 'SELECT id, error_stack, error_detail, curl_command FROM request_logs WHERE id = ?';
    const [rows] = await pool.execute(sql, [id]);
    if (!rows[0]) return null;
    return {
        id: rows[0].id,
        errorStack: rows[0].error_stack,
        errorDetail: rows[0].error_detail,
        curlCommand: rows[0].curl_command
    };
}

/**
 * 按账号UUID查询请求日志
 */
export async function findByProviderUuid(uuid, options = {}) {
    const pool = getPool();
    const {
        page = 1,
        pageSize = 20,
        isSuccess,
        startDate,
        endDate
    } = options;

    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 20;

    // 排除大字段 curl_command, error_stack, error_detail 以提升查询性能
    let sql = `SELECT
        id, provider_uuid, provider_type, pool_id, request_model,
        status_code, is_success, error_type, error_message, request_id,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        credit_usage, duration_ms, ttft_ms, client_ip, user_agent,
        client_token_id, user_id, user_email, username,
        proxy_node_id, proxy_node_name, proxy_node_host, proxy_node_port, proxy_node_protocol,
        created_at
    FROM request_logs WHERE provider_uuid = ?`;
    const params = [uuid];

    if (isSuccess !== undefined) {
        sql += ' AND is_success = ?';
        params.push(isSuccess ? 1 : 0);
    }

    if (startDate) {
        sql += ' AND created_at >= ?';
        params.push(startDate);
    }

    if (endDate) {
        sql += ' AND created_at <= ?';
        params.push(endDate);
    }

    sql += ' ORDER BY created_at DESC';

    const offset = (pageNum - 1) * pageSizeNum;
    sql += ` LIMIT ${pageSizeNum} OFFSET ${offset}`;

    const [rows] = await pool.query(sql, params);
    return rows.map(normalizeRecord);
}

/**
 * 按池子ID查询请求日志
 */
export async function findByPoolId(providerType, poolId, options = {}) {
    const pool = getPool();
    const {
        page = 1,
        pageSize = 20,
        isSuccess,
        startDate,
        endDate
    } = options;

    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 20;

    // 排除大字段 curl_command, error_stack, error_detail 以提升查询性能
    let sql = `SELECT
        id, provider_uuid, provider_type, pool_id, request_model,
        status_code, is_success, error_type, error_message, request_id,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        credit_usage, duration_ms, ttft_ms, client_ip, user_agent,
        client_token_id, user_id, user_email, username,
        proxy_node_id, proxy_node_name, proxy_node_host, proxy_node_port, proxy_node_protocol,
        created_at
    FROM request_logs WHERE provider_type = ?`;
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

    if (isSuccess !== undefined) {
        sql += ' AND is_success = ?';
        params.push(isSuccess ? 1 : 0);
    }

    if (startDate) {
        sql += ' AND created_at >= ?';
        params.push(startDate);
    }

    if (endDate) {
        sql += ' AND created_at <= ?';
        params.push(endDate);
    }

    sql += ' ORDER BY created_at DESC';

    const offset = (pageNum - 1) * pageSizeNum;
    sql += ` LIMIT ${pageSizeNum} OFFSET ${offset}`;

    const [rows] = await pool.query(sql, params);
    return rows.map(normalizeRecord);
}

/**
 * 按账号UUID统计请求数
 */
export async function countByProviderUuid(uuid, options = {}) {
    const pool = getPool();
    const { isSuccess, startDate, endDate } = options;

    let sql = 'SELECT COUNT(*) as total FROM request_logs WHERE provider_uuid = ?';
    const params = [uuid];

    if (isSuccess !== undefined) {
        sql += ' AND is_success = ?';
        params.push(isSuccess ? 1 : 0);
    }

    if (startDate) {
        sql += ' AND created_at >= ?';
        params.push(startDate);
    }

    if (endDate) {
        sql += ' AND created_at <= ?';
        params.push(endDate);
    }

    const [rows] = await pool.execute(sql, params);
    return rows[0]?.total || 0;
}

/**
 * 按池子ID统计请求数
 */
export async function countByPoolId(providerType, poolId, options = {}) {
    const pool = getPool();
    const { isSuccess, startDate, endDate } = options;

    let sql = 'SELECT COUNT(*) as total FROM request_logs WHERE provider_type = ?';
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

    if (isSuccess !== undefined) {
        sql += ' AND is_success = ?';
        params.push(isSuccess ? 1 : 0);
    }

    if (startDate) {
        sql += ' AND created_at >= ?';
        params.push(startDate);
    }

    if (endDate) {
        sql += ' AND created_at <= ?';
        params.push(endDate);
    }

    const [rows] = await pool.execute(sql, params);
    return rows[0]?.total || 0;
}

/**
 * 获取账号请求统计摘要
 */
export async function getProviderSummary(uuid) {
    const pool = getPool();
    const sql = `
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) as fail_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            AVG(duration_ms) as avg_duration
        FROM request_logs
        WHERE provider_uuid = ?
    `;
    const [rows] = await pool.execute(sql, [uuid]);
    const row = rows[0];
    return {
        total: row?.total || 0,
        successCount: row?.success_count || 0,
        failCount: row?.fail_count || 0,
        totalInputTokens: row?.total_input_tokens || 0,
        totalOutputTokens: row?.total_output_tokens || 0,
        avgDuration: Math.round(row?.avg_duration || 0)
    };
}

/**
 * 获取池子请求统计摘要
 */
export async function getPoolSummary(providerType, poolId) {
    const pool = getPool();
    let sql = `
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) as fail_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            AVG(duration_ms) as avg_duration
        FROM request_logs
        WHERE provider_type = ?
    `;
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

    const [rows] = await pool.execute(sql, params);
    const row = rows[0];
    return {
        total: row?.total || 0,
        successCount: row?.success_count || 0,
        failCount: row?.fail_count || 0,
        totalInputTokens: row?.total_input_tokens || 0,
        totalOutputTokens: row?.total_output_tokens || 0,
        avgDuration: Math.round(row?.avg_duration || 0)
    };
}

/**
 * 清空账号的请求日志
 */
export async function clearByProviderUuid(uuid) {
    const pool = getPool();
    const sql = 'DELETE FROM request_logs WHERE provider_uuid = ?';
    const [result] = await pool.execute(sql, [uuid]);
    return result.affectedRows;
}

/**
 * 清空池子的请求日志
 */
export async function clearByPoolId(providerType, poolId) {
    const pool = getPool();
    let sql = 'DELETE FROM request_logs WHERE provider_type = ?';
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
 * 清理过期日志（保留最近N天）
 */
export async function cleanupOldLogs(days = 30) {
    const pool = getPool();
    const sql = 'DELETE FROM request_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)';
    const [result] = await pool.execute(sql, [days]);
    return result.affectedRows;
}

/**
 * 按日期清理日志
 * @param {string} mode - 'before_date' 删除指定日期之前 | 'before_today' 删除今天之前
 * @param {string} [date] - 当 mode='before_date' 时，删除该日期(含)之前的日志，格式 YYYY-MM-DD
 * @returns {Promise<number>} 删除行数
 */
export async function cleanupByDate(mode, date) {
    const pool = getPool();
    let sql, params;
    if (mode === 'before_today') {
        sql = 'DELETE FROM request_logs WHERE created_at < CURDATE()';
        params = [];
    } else if (mode === 'before_date' && date) {
        // 删除 date 当天结束之前的所有记录（即 < date+1天）
        sql = 'DELETE FROM request_logs WHERE created_at < DATE_ADD(?, INTERVAL 1 DAY)';
        params = [date];
    } else {
        throw new Error('Invalid cleanup mode or missing date');
    }
    const [result] = await pool.execute(sql, params);
    return result.affectedRows;
}

/**
 * 标准化记录格式
 */
function normalizeRecord(row) {
    if (!row) return null;
    return {
        id: row.id,
        providerUuid: row.provider_uuid,
        providerType: row.provider_type,
        poolId: row.pool_id,
        requestModel: row.request_model,
        statusCode: row.status_code,
        isSuccess: Boolean(row.is_success),
        errorType: row.error_type,
        errorMessage: row.error_message,
        errorStack: row.error_stack,
        errorDetail: row.error_detail,
        curlCommand: row.curl_command,
        requestId: row.request_id,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        cacheReadTokens: row.cache_read_tokens,
        creditUsage: row.credit_usage,
        durationMs: row.duration_ms,
        ttftMs: row.ttft_ms,
        clientIp: row.client_ip,
        userAgent: row.user_agent,
        clientTokenId: row.client_token_id,
        userId: row.user_id,
        userEmail: row.user_email,
        username: row.username,
        proxyNodeId: row.proxy_node_id,
        proxyNodeName: row.proxy_node_name,
        proxyNodeHost: row.proxy_node_host,
        proxyNodePort: row.proxy_node_port,
        proxyNodeProtocol: row.proxy_node_protocol,
        createdAt: row.created_at
    };
}

/**
 * 统计某个账号的累计credit usage
 * @param {string} providerUuid - 账号UUID
 * @returns {Promise<number>} 累计credit usage
 */
export async function getTotalCreditUsage(providerUuid) {
    const pool = getPool();
    const sql = `
        SELECT SUM(credit_usage) as total_credit_usage
        FROM request_logs
        WHERE provider_uuid = ?
        AND credit_usage IS NOT NULL
    `;

    const [rows] = await pool.execute(sql, [providerUuid]);
    const total = rows[0]?.total_credit_usage;

    // 如果没有记录或总和为null，返回0
    return total ? Number(total) : 0;
}
