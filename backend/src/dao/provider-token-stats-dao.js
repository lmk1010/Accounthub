/**
 * Provider Token Stats DAO - 账号 Token 使用统计数据访问层
 */

import { getPool } from '../config/database.js';

const PROVIDER_TOKEN_STATS_REQUIRED_COLUMNS = [
    {
        name: 'cache_creation_tokens',
        ddl: `ALTER TABLE provider_token_stats ADD COLUMN cache_creation_tokens BIGINT DEFAULT 0 COMMENT '缓存创建Token总数' AFTER total_tokens`
    },
    {
        name: 'cache_read_tokens',
        ddl: `ALTER TABLE provider_token_stats ADD COLUMN cache_read_tokens BIGINT DEFAULT 0 COMMENT '缓存读取Token总数' AFTER cache_creation_tokens`
    },
    {
        name: 'cache_total_tokens',
        ddl: `ALTER TABLE provider_token_stats ADD COLUMN cache_total_tokens BIGINT DEFAULT 0 COMMENT '缓存Token总数（创建+读取）' AFTER cache_read_tokens`
    }
];

async function ensureColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'provider_token_stats'`
        );
        const existing = new Set((rows || []).map((row) => row.COLUMN_NAME));

        for (const column of PROVIDER_TOKEN_STATS_REQUIRED_COLUMNS) {
            if (existing.has(column.name)) continue;
            try {
                await pool.execute(column.ddl);
                console.log(`[ProviderTokenStatsDao] Added missing column: ${column.name}`);
            } catch (error) {
                if (error.code !== 'ER_DUP_FIELDNAME') {
                    console.error(`[ProviderTokenStatsDao] Failed to add column ${column.name}:`, error.message);
                }
            }
        }
    } catch (error) {
        console.warn('[ProviderTokenStatsDao] Failed to ensure columns:', error.message);
    }
}

/**
 * 确保统计表存在
 */
export async function ensureTable() {
    const pool = getPool();
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS provider_token_stats (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
            provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
            model VARCHAR(128) NOT NULL COMMENT '模型名称（"_total" 表示总计）',
            input_tokens BIGINT DEFAULT 0 COMMENT '输入Token总数',
            output_tokens BIGINT DEFAULT 0 COMMENT '输出Token总数',
            total_tokens BIGINT DEFAULT 0 COMMENT '总Token数（输入+输出）',
            cache_creation_tokens BIGINT DEFAULT 0 COMMENT '缓存创建Token总数',
            cache_read_tokens BIGINT DEFAULT 0 COMMENT '缓存读取Token总数',
            cache_total_tokens BIGINT DEFAULT 0 COMMENT '缓存Token总数（创建+读取）',
            request_count INT DEFAULT 0 COMMENT '请求次数',
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
            UNIQUE KEY uk_provider_model (provider_uuid, model),
            INDEX idx_provider_uuid (provider_uuid),
            INDEX idx_provider_type (provider_type),
            INDEX idx_model (model),
            INDEX idx_last_updated (last_updated)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号Token使用统计表'
    `;

    try {
        await pool.execute(createTableSQL);
        await ensureColumns(pool);
        console.log('[ProviderTokenStatsDao] Table ensured');
    } catch (error) {
        if (error.code !== 'ER_TABLE_EXISTS_ERROR') {
            console.error('[ProviderTokenStatsDao] Failed to ensure table:', error.message);
        }
    }
}

/**
 * 增量更新统计（用于实时记录）
 * @param {string} providerUuid - 提供商UUID
 * @param {string} providerType - 提供商类型
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入Token数
 * @param {number} outputTokens - 输出Token数
 * @param {number} cacheCreationTokens - 缓存创建Token数
 * @param {number} cacheReadTokens - 缓存读取Token数
 */
export async function incrementStats(
    providerUuid,
    providerType,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreationTokens = 0,
    cacheReadTokens = 0
) {
    const pool = getPool();
    const normalizedProviderUuid = String(providerUuid || '').trim();
    const normalizedProviderType = String(providerType || '').trim();
    const normalizedModel = String(model || '').trim();
    if (!normalizedProviderUuid || !normalizedProviderType || !normalizedModel) {
        console.warn('[ProviderTokenStatsDao] Skipping stats increment with missing dimensions');
        return;
    }

    const normalizedInputTokens = normalizeTokenCount(inputTokens);
    const normalizedOutputTokens = normalizeTokenCount(outputTokens);
    const normalizedCacheCreationTokens = normalizeTokenCount(cacheCreationTokens);
    const normalizedCacheReadTokens = normalizeTokenCount(cacheReadTokens);
    const totalTokens = normalizedInputTokens + normalizedOutputTokens;
    const cacheTotalTokens = normalizedCacheCreationTokens + normalizedCacheReadTokens;

    // 更新模型级别统计
    const modelSQL = `
        INSERT INTO provider_token_stats
            (provider_uuid, provider_type, model, input_tokens, output_tokens, total_tokens, cache_creation_tokens, cache_read_tokens, cache_total_tokens, request_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
            input_tokens = input_tokens + VALUES(input_tokens),
            output_tokens = output_tokens + VALUES(output_tokens),
            total_tokens = total_tokens + VALUES(total_tokens),
            cache_creation_tokens = cache_creation_tokens + VALUES(cache_creation_tokens),
            cache_read_tokens = cache_read_tokens + VALUES(cache_read_tokens),
            cache_total_tokens = cache_total_tokens + VALUES(cache_total_tokens),
            request_count = request_count + 1
    `;

    // 更新总计统计
    const totalSQL = `
        INSERT INTO provider_token_stats
            (provider_uuid, provider_type, model, input_tokens, output_tokens, total_tokens, cache_creation_tokens, cache_read_tokens, cache_total_tokens, request_count)
        VALUES (?, ?, '_total', ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
            input_tokens = input_tokens + VALUES(input_tokens),
            output_tokens = output_tokens + VALUES(output_tokens),
            total_tokens = total_tokens + VALUES(total_tokens),
            cache_creation_tokens = cache_creation_tokens + VALUES(cache_creation_tokens),
            cache_read_tokens = cache_read_tokens + VALUES(cache_read_tokens),
            cache_total_tokens = cache_total_tokens + VALUES(cache_total_tokens),
            request_count = request_count + 1
    `;

    try {
        await pool.execute(modelSQL, [
            normalizedProviderUuid,
            normalizedProviderType,
            normalizedModel,
            normalizedInputTokens,
            normalizedOutputTokens,
            totalTokens,
            normalizedCacheCreationTokens,
            normalizedCacheReadTokens,
            cacheTotalTokens
        ]);
        await pool.execute(totalSQL, [
            normalizedProviderUuid,
            normalizedProviderType,
            normalizedInputTokens,
            normalizedOutputTokens,
            totalTokens,
            normalizedCacheCreationTokens,
            normalizedCacheReadTokens,
            cacheTotalTokens
        ]);
    } catch (error) {
        console.error('[ProviderTokenStatsDao] Failed to increment stats:', error.message);
        throw error;
    }
}

function normalizeTokenCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
}

/**
 * 获取账号的 Token 统计（包含所有模型和总计）
 * @param {string} providerUuid - 提供商UUID
 * @returns {Promise<Object>} 统计数据
 */
export async function getStatsByProvider(providerUuid) {
    const pool = getPool();
    const sql = `
        SELECT
            model,
            input_tokens,
            output_tokens,
            total_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            cache_total_tokens,
            request_count,
            last_updated
        FROM provider_token_stats
        WHERE provider_uuid = ?
        ORDER BY
            CASE WHEN model = '_total' THEN 0 ELSE 1 END,
            model ASC
    `;

    try {
        const [rows] = await pool.execute(sql, [providerUuid]);

        // 转换为 M（百万）单位
        const stats = rows.map(row => ({
            model: row.model === '_total' ? '总计' : row.model,
            inputTokensM: (row.input_tokens / 1000000).toFixed(2),
            outputTokensM: (row.output_tokens / 1000000).toFixed(2),
            totalTokensM: (row.total_tokens / 1000000).toFixed(2),
            cacheCreationTokensM: (row.cache_creation_tokens / 1000000).toFixed(2),
            cacheReadTokensM: (row.cache_read_tokens / 1000000).toFixed(2),
            cacheTotalTokensM: (row.cache_total_tokens / 1000000).toFixed(2),
            requestCount: row.request_count,
            lastUpdated: row.last_updated
        }));

        return {
            providerUuid,
            stats
        };
    } catch (error) {
        console.error('[ProviderTokenStatsDao] Failed to get stats:', error.message);
        throw error;
    }
}

/**
 * 从 request_logs 重新计算统计（用于初始化或修复数据）
 * @param {string} providerUuid - 提供商UUID（可选，不传则重算所有）
 */
export async function rebuildStats(providerUuid = null) {
    const pool = getPool();

    // 清空现有统计
    if (providerUuid) {
        await pool.execute('DELETE FROM provider_token_stats WHERE provider_uuid = ?', [providerUuid]);
    } else {
        await pool.execute('TRUNCATE TABLE provider_token_stats');
    }

    // 从 request_logs 聚合统计
    const whereConditions = ['provider_uuid IS NOT NULL', "provider_uuid <> ''"];
    const params = [];
    if (providerUuid) {
        whereConditions.push('provider_uuid = ?');
        params.push(providerUuid);
    }
    const whereClause = whereConditions.length > 0
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';

    // 按模型聚合
    const modelSQL = `
        INSERT INTO provider_token_stats
            (provider_uuid, provider_type, model, input_tokens, output_tokens, total_tokens, cache_creation_tokens, cache_read_tokens, cache_total_tokens, request_count)
        SELECT
            provider_uuid,
            provider_type,
            COALESCE(request_model, 'unknown') as model,
            SUM(COALESCE(input_tokens, 0)) as input_tokens,
            SUM(COALESCE(output_tokens, 0)) as output_tokens,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
            SUM(COALESCE(cache_creation_tokens, 0)) as cache_creation_tokens,
            SUM(COALESCE(cache_read_tokens, 0)) as cache_read_tokens,
            SUM(COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)) as cache_total_tokens,
            COUNT(*) as request_count
        FROM request_logs
        ${whereClause}
        GROUP BY provider_uuid, provider_type, request_model
    `;

    // 总计聚合
    const totalSQL = `
        INSERT INTO provider_token_stats
            (provider_uuid, provider_type, model, input_tokens, output_tokens, total_tokens, cache_creation_tokens, cache_read_tokens, cache_total_tokens, request_count)
        SELECT
            provider_uuid,
            provider_type,
            '_total' as model,
            SUM(COALESCE(input_tokens, 0)) as input_tokens,
            SUM(COALESCE(output_tokens, 0)) as output_tokens,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
            SUM(COALESCE(cache_creation_tokens, 0)) as cache_creation_tokens,
            SUM(COALESCE(cache_read_tokens, 0)) as cache_read_tokens,
            SUM(COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)) as cache_total_tokens,
            COUNT(*) as request_count
        FROM request_logs
        ${whereClause}
        GROUP BY provider_uuid, provider_type
    `;

    try {
        const [modelResult] = await pool.execute(modelSQL, params);
        const [totalResult] = await pool.execute(totalSQL, params);

        console.log(`[ProviderTokenStatsDao] Rebuilt stats: ${modelResult.affectedRows} models, ${totalResult.affectedRows} totals`);

        return {
            modelsCount: modelResult.affectedRows,
            totalsCount: totalResult.affectedRows
        };
    } catch (error) {
        console.error('[ProviderTokenStatsDao] Failed to rebuild stats:', error.message);
        throw error;
    }
}

/**
 * 获取所有账号的 Token 统计排行
 * @param {Object} options - 查询选项
 * @returns {Promise<Array>} 统计列表
 */
export async function getTopProviders(options = {}) {
    const pool = getPool();
    const {
        providerType = null,
        orderBy = 'total_tokens', // total_tokens, input_tokens, output_tokens, request_count
        limit = 50
    } = options;

    // 白名单校验 orderBy，防止 SQL 注入
    const validOrderByFields = ['total_tokens', 'input_tokens', 'output_tokens', 'request_count', 'last_updated'];
    const safeOrderBy = validOrderByFields.includes(orderBy) ? orderBy : 'total_tokens';

    const whereClause = providerType ? "WHERE provider_type = ? AND model = '_total'" : "WHERE model = '_total'";
    const params = providerType ? [providerType] : [];

    const sql = `
        SELECT
            s.provider_uuid,
            s.provider_type,
            s.input_tokens,
            s.output_tokens,
            s.total_tokens,
            s.cache_creation_tokens,
            s.cache_read_tokens,
            s.cache_total_tokens,
            s.request_count,
            s.last_updated,
            p.custom_name,
            p.is_healthy,
            p.is_disabled
        FROM provider_token_stats s
        LEFT JOIN providers p ON s.provider_uuid = p.uuid
        ${whereClause}
        ORDER BY s.${safeOrderBy} DESC
        LIMIT ?
    `;

    try {
        const [rows] = await pool.execute(sql, [...params, limit]);

        return rows.map(row => ({
            providerUuid: row.provider_uuid,
            providerType: row.provider_type,
            customName: row.custom_name,
            isHealthy: row.is_healthy,
            isDisabled: row.is_disabled,
            inputTokensM: (row.input_tokens / 1000000).toFixed(2),
            outputTokensM: (row.output_tokens / 1000000).toFixed(2),
            totalTokensM: (row.total_tokens / 1000000).toFixed(2),
            cacheCreationTokensM: (row.cache_creation_tokens / 1000000).toFixed(2),
            cacheReadTokensM: (row.cache_read_tokens / 1000000).toFixed(2),
            cacheTotalTokensM: (row.cache_total_tokens / 1000000).toFixed(2),
            requestCount: row.request_count,
            lastUpdated: row.last_updated
        }));
    } catch (error) {
        console.error('[ProviderTokenStatsDao] Failed to get top providers:', error.message);
        throw error;
    }
}
