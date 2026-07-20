/**
 * 请求日志异步队列服务
 * 使用 Redis List 实现跨进程的异步日志写入
 */

import { getRedisClient, isRedisAvailable } from './redis-client.js';
import { getPool } from '../config/database.js';

const QUEUE_KEY = 'request_logs_queue';
const BATCH_SIZE = 50;  // 每次批量写入的数量
const FLUSH_INTERVAL = 5000;  // 刷新间隔 (ms)
const MAX_RETRY = 3;

let workerTimer = null;
let isProcessing = false;
let requestLogsTableColumnsCache = null;
let requestLogsTableColumnsCacheAt = 0;
const TABLE_COLUMNS_CACHE_TTL_MS = 30000;

function normalizeTokenNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.floor(num);
}

function normalizeStatusCodeValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
}

async function flushTokenStatsUpdates(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;

    const aggregated = new Map();
    for (const item of updates) {
        const providerUuid = String(item.providerUuid || '').trim();
        const providerType = String(item.providerType || '').trim();
        const model = String(item.model || '').trim();
        const inputTokens = normalizeTokenNumber(item.inputTokens);
        const outputTokens = normalizeTokenNumber(item.outputTokens);
        const cacheCreationTokens = normalizeTokenNumber(item.cacheCreationTokens);
        const cacheReadTokens = normalizeTokenNumber(item.cacheReadTokens);
        if (!providerUuid || !providerType || !model) continue;
        if (inputTokens <= 0 && outputTokens <= 0 && cacheCreationTokens <= 0 && cacheReadTokens <= 0) continue;

        const key = `${providerUuid}::${providerType}::${model}`;
        const current = aggregated.get(key) || {
            providerUuid,
            providerType,
            model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0
        };
        current.inputTokens += inputTokens;
        current.outputTokens += outputTokens;
        current.cacheCreationTokens += cacheCreationTokens;
        current.cacheReadTokens += cacheReadTokens;
        aggregated.set(key, current);
    }

    if (aggregated.size === 0) return;

    try {
        const { incrementStats } = await import('../dao/provider-token-stats-dao.js');
        for (const item of aggregated.values()) {
            await incrementStats(
                item.providerUuid,
                item.providerType,
                item.model,
                item.inputTokens,
                item.outputTokens,
                item.cacheCreationTokens,
                item.cacheReadTokens
            );
        }
        console.log(`[RequestLogQueue] Token stats updated for ${aggregated.size} provider-model entries`);
    } catch (error) {
        console.error('[RequestLogQueue] Failed to update token stats from queue:', error.message);
    }
}

/**
 * 推送日志到队列
 * @param {Object} record - 日志记录
 * @returns {Promise<boolean>} 是否成功
 */
export async function pushLog(record) {
    const client = getRedisClient();
    if (!client) {
        console.warn('[RequestLogQueue] Redis not available, log dropped');
        return false;
    }

    try {
        const data = JSON.stringify({
            ...record,
            _queuedAt: Date.now()
        });
        await client.lpush(QUEUE_KEY, data);
        return true;
    } catch (error) {
        console.error('[RequestLogQueue] Failed to push log:', error.message);
        return false;
    }
}

/**
 * 从队列批量获取日志
 * @param {number} count - 获取数量
 * @returns {Promise<Array>} 日志数组
 */
async function popLogs(count) {
    const client = getRedisClient();
    if (!client) return [];

    try {
        const logs = [];
        for (let i = 0; i < count; i++) {
            const data = await client.rpop(QUEUE_KEY);
            if (!data) break;
            try {
                logs.push(JSON.parse(data));
            } catch (e) {
                console.warn('[RequestLogQueue] Invalid log data:', data);
            }
        }
        return logs;
    } catch (error) {
        console.error('[RequestLogQueue] Failed to pop logs:', error.message);
        return [];
    }
}

/**
 * 获取队列长度
 * @returns {Promise<number>}
 */
export async function getQueueLength() {
    const client = getRedisClient();
    if (!client) return 0;

    try {
        return await client.llen(QUEUE_KEY);
    } catch (error) {
        return 0;
    }
}

async function getRequestLogsTableColumns(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && requestLogsTableColumnsCache && (now - requestLogsTableColumnsCacheAt) < TABLE_COLUMNS_CACHE_TTL_MS) {
        return requestLogsTableColumnsCache;
    }

    try {
        const pool = getPool();
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'request_logs'`
        );
        requestLogsTableColumnsCache = new Set(rows.map(row => row.COLUMN_NAME));
        requestLogsTableColumnsCacheAt = now;
    } catch (error) {
        console.warn('[RequestLogQueue] Failed to load request_logs columns:', error.message);
        requestLogsTableColumnsCache = null;
        requestLogsTableColumnsCacheAt = 0;
    }

    return requestLogsTableColumnsCache;
}

async function resolveInsertColumns(preferredColumns) {
    const tableColumns = await getRequestLogsTableColumns();
    if (!tableColumns || tableColumns.size === 0) {
        return preferredColumns;
    }
    return preferredColumns.filter(column => tableColumns.has(column));
}

/**
 * 批量写入数据库
 * @param {Array} logs - 日志数组
 * @returns {Promise<number>} 成功写入数量
 */
async function batchInsert(logs) {
    if (!logs || logs.length === 0) return 0;

    const pool = getPool();
    const preferredColumns = [
        'provider_uuid', 'provider_type', 'pool_id', 'request_model',
        'status_code', 'is_success', 'error_type', 'error_message',
        'error_stack', 'error_detail', 'curl_command',
        'request_id', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
        'cache_read_tokens', 'credit_usage', 'duration_ms', 'ttft_ms',
        'client_ip', 'user_agent', 'client_token_id',
        'user_id', 'user_email', 'username',
        'proxy_node_id', 'proxy_node_name', 'proxy_node_host', 'proxy_node_port', 'proxy_node_protocol'
    ];

    const columns = await resolveInsertColumns(preferredColumns);
    if (!columns || columns.length === 0) {
        console.warn('[RequestLogQueue] No available columns for request_logs insert');
        return 0;
    }

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO request_logs (${columns.join(', ')}) VALUES (${placeholders})`;

    let successCount = 0;
    const tokenStatsUpdates = [];
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        for (const log of logs) {
            try {
                const valuesByColumn = {
                    provider_uuid: log.provider_uuid ?? log.providerUuid ?? null,
                    provider_type: log.provider_type ?? log.providerType ?? null,
                    pool_id: log.pool_id ?? log.poolId ?? 0,
                    request_model: log.request_model ?? log.requestModel ?? null,
                    status_code: normalizeStatusCodeValue(log.status_code ?? log.statusCode ?? null),
                    is_success: log.is_success ?? log.isSuccess ?? true,
                    error_type: log.error_type ?? log.errorType ?? null,
                    error_message: log.error_message ?? log.errorMessage ?? null,
                    error_stack: log.error_stack ?? log.errorStack ?? null,
                    error_detail: log.error_detail ?? log.errorDetail ?? null,
                    curl_command: log.curl_command ?? log.curlCommand ?? null,
                    request_id: log.request_id ?? log.requestId ?? null,
                    input_tokens: log.input_tokens ?? log.inputTokens ?? 0,
                    output_tokens: log.output_tokens ?? log.outputTokens ?? 0,
                    cache_creation_tokens: log.cache_creation_tokens ?? log.cacheCreationTokens ?? 0,
                    cache_read_tokens: log.cache_read_tokens ?? log.cacheReadTokens ?? 0,
                    credit_usage: log.credit_usage ?? log.creditUsage ?? null,
                    duration_ms: log.duration_ms ?? log.durationMs ?? 0,
                    ttft_ms: log.ttft_ms ?? log.ttftMs ?? null,
                    client_ip: log.client_ip ?? log.clientIp ?? null,
                    user_agent: log.user_agent ?? log.userAgent ?? null,
                    client_token_id: log.client_token_id ?? log.clientTokenId ?? null,
                    user_id: log.user_id ?? log.userId ?? null,
                    user_email: log.user_email ?? log.userEmail ?? null,
                    username: log.username ?? log.userName ?? null,
                    proxy_node_id: log.proxy_node_id ?? log.proxyNodeId ?? null,
                    proxy_node_name: log.proxy_node_name ?? log.proxyNodeName ?? null,
                    proxy_node_host: log.proxy_node_host ?? log.proxyNodeHost ?? null,
                    proxy_node_port: log.proxy_node_port ?? log.proxyNodePort ?? null,
                    proxy_node_protocol: log.proxy_node_protocol ?? log.proxyNodeProtocol ?? null
                };
                const params = columns.map((column) => valuesByColumn[column] === undefined ? null : valuesByColumn[column]);
                await connection.execute(sql, params);
                successCount++;

                tokenStatsUpdates.push({
                    providerUuid: valuesByColumn.provider_uuid,
                    providerType: valuesByColumn.provider_type,
                    model: valuesByColumn.request_model,
                    inputTokens: valuesByColumn.input_tokens,
                    outputTokens: valuesByColumn.output_tokens,
                    cacheCreationTokens: valuesByColumn.cache_creation_tokens,
                    cacheReadTokens: valuesByColumn.cache_read_tokens
                });
            } catch (err) {
                console.warn('[RequestLogQueue] Insert single log failed:', err.message);
            }
        }

        await connection.commit();

        if (tokenStatsUpdates.length > 0) {
            await flushTokenStatsUpdates(tokenStatsUpdates);
        }
    } catch (error) {
        await connection.rollback();
        console.error('[RequestLogQueue] Batch insert failed:', error.message);
    } finally {
        connection.release();
    }

    return successCount;
}

/**
 * 处理队列中的日志
 */
async function processQueue() {
    if (isProcessing) return;
    if (!isRedisAvailable()) return;

    isProcessing = true;

    try {
        const logs = await popLogs(BATCH_SIZE);
        if (logs.length > 0) {
            const inserted = await batchInsert(logs);
            if (inserted > 0) {
                console.log(`[RequestLogQueue] Batch inserted ${inserted}/${logs.length} logs`);
            }
        }
    } catch (error) {
        console.error('[RequestLogQueue] Process queue error:', error.message);
    } finally {
        isProcessing = false;
    }
}

/**
 * 启动后台 Worker
 */
export function startWorker() {
    if (workerTimer) {
        console.warn('[RequestLogQueue] Worker already running');
        return;
    }

    console.log('[RequestLogQueue] Starting worker...');
    workerTimer = setInterval(processQueue, FLUSH_INTERVAL);

    // 立即执行一次
    processQueue();
}

/**
 * 停止后台 Worker
 */
export async function stopWorker() {
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }

    // 处理剩余日志
    console.log('[RequestLogQueue] Flushing remaining logs...');
    let remaining = await getQueueLength();
    while (remaining > 0) {
        await processQueue();
        remaining = await getQueueLength();
    }
    console.log('[RequestLogQueue] Worker stopped');
}

/**
 * 获取队列状态
 */
export async function getQueueStatus() {
    return {
        available: isRedisAvailable(),
        queueLength: await getQueueLength(),
        isProcessing,
        workerRunning: workerTimer !== null
    };
}

export { isRedisAvailable };

export default {
    pushLog,
    getQueueLength,
    getQueueStatus,
    startWorker,
    stopWorker,
    isRedisAvailable
};
