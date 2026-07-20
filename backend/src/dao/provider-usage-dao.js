/**
 * Provider Usage DAO - 用量明细数据访问层
 */

import { getPool } from '../config/database.js';

let providerUsageColumnsCache = null;
let providerUsageColumnsLoaded = false;
let providerUsageColumnsEnsured = false;

const PROVIDER_USAGE_OPTIONAL_COLUMNS = [
    {
        name: 'image_usage_json',
        ddl: `ALTER TABLE provider_usage_details ADD COLUMN image_usage_json JSON DEFAULT NULL COMMENT '图片额度归一化数据' AFTER raw_usage_json`
    },
    {
        name: 'image_usage_summary_json',
        ddl: `ALTER TABLE provider_usage_details ADD COLUMN image_usage_summary_json JSON DEFAULT NULL COMMENT '图片额度汇总' AFTER image_usage_json`
    },
    {
        name: 'raw_image_usage_json',
        ddl: `ALTER TABLE provider_usage_details ADD COLUMN raw_image_usage_json JSON DEFAULT NULL COMMENT '图片额度原始数据' AFTER image_usage_summary_json`
    }
];

function toJsonValue(value) {
    if (value === undefined) {
        return null;
    }
    return value === null ? null : JSON.stringify(value);
}

function parseJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

async function loadProviderUsageColumns() {
    if (providerUsageColumnsLoaded) {
        return providerUsageColumnsCache;
    }
    providerUsageColumnsLoaded = true;
    try {
        const pool = getPool();
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'provider_usage_details'`
        );
        providerUsageColumnsCache = new Set(rows.map(row => row.COLUMN_NAME));
    } catch (error) {
        providerUsageColumnsLoaded = false;
        providerUsageColumnsCache = null;
        throw error;
    }
    return providerUsageColumnsCache;
}

async function ensureProviderUsageColumns() {
    if (providerUsageColumnsEnsured) {
        return providerUsageColumnsCache;
    }
    providerUsageColumnsEnsured = true;

    let columns = null;
    try {
        columns = await loadProviderUsageColumns();
    } catch (error) {
        console.warn('[ProviderUsageDao] Failed to load provider_usage_details columns for ensure:', error.message);
        return null;
    }
    if (!columns) return null;

    const pool = getPool();
    let altered = false;
    let allSuccess = true;
    for (const column of PROVIDER_USAGE_OPTIONAL_COLUMNS) {
        if (columns.has(column.name)) continue;
        try {
            await pool.execute(column.ddl);
            altered = true;
            console.log(`[ProviderUsageDao] Added missing provider_usage_details column: ${column.name}`);
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || error.message?.includes('Duplicate column')) {
                console.log(`[ProviderUsageDao] Column ${column.name} already exists`);
            } else {
                console.warn(`[ProviderUsageDao] Failed to add provider_usage_details column ${column.name}:`, error.message);
                allSuccess = false;
            }
        }
    }

    if (altered || !allSuccess) {
        providerUsageColumnsLoaded = false;
        providerUsageColumnsCache = null;
        try {
            columns = await loadProviderUsageColumns();
        } catch (error) {
            console.warn('[ProviderUsageDao] Failed to reload provider_usage_details columns after ensure:', error.message);
            return providerUsageColumnsCache;
        }
    }

    return columns;
}

function buildSelectColumns(columns) {
    const hasColumn = (name) => !columns || columns.has(name);
    return [
        'provider_uuid',
        'provider_type',
        'usage_json',
        'usage_summary_json',
        'raw_usage_json',
        hasColumn('image_usage_json') ? 'image_usage_json' : 'NULL AS image_usage_json',
        hasColumn('image_usage_summary_json') ? 'image_usage_summary_json' : 'NULL AS image_usage_summary_json',
        hasColumn('raw_image_usage_json') ? 'raw_image_usage_json' : 'NULL AS raw_image_usage_json',
        'updated_at'
    ].join(', ');
}

function buildRecordPayload(columns, values) {
    const record = {};
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (!columns || columns.has(key) || key === 'provider_uuid' || key === 'provider_type') {
            record[key] = value;
        }
    }
    return record;
}

function mapUsageRow(row) {
    return {
        provider_uuid: row.provider_uuid,
        provider_type: row.provider_type,
        usage: parseJson(row.usage_json),
        usageSummary: parseJson(row.usage_summary_json),
        rawUsage: parseJson(row.raw_usage_json),
        imageUsage: parseJson(row.image_usage_json),
        imageUsageSummary: parseJson(row.image_usage_summary_json),
        rawImageUsage: parseJson(row.raw_image_usage_json),
        updated_at: row.updated_at
    };
}

export async function upsertUsageDetail({
    providerUuid,
    providerType,
    usage,
    usageSummary,
    rawUsage,
    imageUsage,
    imageUsageSummary,
    rawImageUsage
}) {
    const pool = getPool();
    if (!providerUuid || !providerType) {
        throw new Error('providerUuid and providerType are required');
    }

    const columns = await ensureProviderUsageColumns();
    const record = buildRecordPayload(columns, {
        provider_uuid: providerUuid,
        provider_type: providerType,
        usage_json: toJsonValue(usage),
        usage_summary_json: toJsonValue(usageSummary),
        raw_usage_json: toJsonValue(rawUsage),
        image_usage_json: toJsonValue(imageUsage),
        image_usage_summary_json: toJsonValue(imageUsageSummary),
        raw_image_usage_json: toJsonValue(rawImageUsage)
    });
    const fieldNames = Object.keys(record);
    const sql = `
        INSERT INTO provider_usage_details (
            ${fieldNames.join(', ')}
        ) VALUES (${fieldNames.map(() => '?').join(', ')})
        ON DUPLICATE KEY UPDATE
            ${fieldNames
                .filter(name => name !== 'provider_uuid')
                .map(name => `${name} = VALUES(${name})`)
                .concat('updated_at = CURRENT_TIMESTAMP')
                .join(',\n            ')}
    `;
    const params = fieldNames.map(name => record[name]);

    await pool.execute(sql, params);
}

export async function findByProviderType(providerType) {
    const pool = getPool();
    if (!providerType) return [];
    const columns = await ensureProviderUsageColumns();
    const sql = `
        SELECT
            ${buildSelectColumns(columns)}
        FROM provider_usage_details
        WHERE provider_type = ?
    `;
    const [rows] = await pool.execute(sql, [providerType]);
    return rows.map(mapUsageRow);
}

export async function findByProviderUuid(providerUuid) {
    const pool = getPool();
    if (!providerUuid) return null;
    const columns = await ensureProviderUsageColumns();
    const sql = `
        SELECT
            ${buildSelectColumns(columns)}
        FROM provider_usage_details
        WHERE provider_uuid = ?
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [providerUuid]);
    if (!rows.length) return null;
    return mapUsageRow(rows[0]);
}

export async function deleteByProviderUuid(providerUuid) {
    const pool = getPool();
    if (!providerUuid) return 0;
    const sql = 'DELETE FROM provider_usage_details WHERE provider_uuid = ?';
    const [result] = await pool.execute(sql, [providerUuid]);
    return result.affectedRows || 0;
}
