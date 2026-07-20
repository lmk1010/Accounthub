/**
 * API 大锅饭 - Key 管理模块
 * 使用 MySQL 存储 Key 元数据与用量
 */

import crypto from 'crypto';
import { getPool } from '../../config/database.js';

// 配置常量
const KEY_PREFIX = 'maki_';

// 默认配置（会被 user-data-manager 的配置覆盖）
const DEFAULT_CONFIG = {
    defaultDailyLimit: 500,
    persistInterval: 5000
};

// 配置获取函数（由外部注入）
let configGetter = null;

/**
 * 设置配置获取函数
 * @param {Function} getter - 返回配置对象的函数
 */
export function setConfigGetter(getter) {
    configGetter = getter;
}

/**
 * 获取当前配置
 */
async function getConfig() {
    if (configGetter) {
        const config = await configGetter();
        return {
            defaultDailyLimit: config?.defaultDailyLimit ?? DEFAULT_CONFIG.defaultDailyLimit,
            persistInterval: config?.persistInterval ?? DEFAULT_CONFIG.persistInterval
        };
    }
    return DEFAULT_CONFIG;
}

function getTodayDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function toDateOnly(value) {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function toDateTime(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function maskKey(keyId) {
    if (!keyId || keyId.length <= 16) return keyId || '';
    return `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`;
}

function normalizeKeyRow(row, today = getTodayDateString()) {
    const lastResetDate = toDateOnly(row.last_reset_date);
    const resetNeeded = !lastResetDate || lastResetDate !== today;
    const todayUsage = resetNeeded ? 0 : Number(row.today_usage || 0);

    return {
        id: row.api_key,
        name: row.name || null,
        createdAt: toDateTime(row.created_at),
        dailyLimit: Number(row.daily_limit || 0),
        todayUsage,
        totalUsage: Number(row.total_usage || 0),
        lastResetDate: resetNeeded ? today : lastResetDate,
        lastUsedAt: toDateTime(row.last_used_at),
        enabled: Boolean(row.enabled),
        bonusRemaining: Number(row.bonus_remaining || 0),
        regeneratedAt: toDateTime(row.regenerated_at),
        regeneratedFrom: row.regenerated_from || null
    };
}

async function resetDailyUsageIfNeeded(apiKey, lastResetDate) {
    const today = getTodayDateString();
    if (!lastResetDate || lastResetDate !== today) {
        const pool = getPool();
        await pool.query(
            'UPDATE api_potluck_users SET today_usage = 0, last_reset_date = ? WHERE api_key = ?',
            [today, apiKey]
        );
        return { todayUsage: 0, lastResetDate: today };
    }
    return { todayUsage: null, lastResetDate };
}

async function resetAllDailyUsage() {
    const pool = getPool();
    await pool.query(
        'UPDATE api_potluck_users SET today_usage = 0, last_reset_date = CURDATE() WHERE last_reset_date IS NULL OR last_reset_date <> CURDATE()'
    );
}

function generateRandomKey() {
    return `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

async function generateUniqueKey() {
    const pool = getPool();
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const apiKey = generateRandomKey();
        const [rows] = await pool.query('SELECT api_key FROM api_potluck_users WHERE api_key = ? LIMIT 1', [apiKey]);
        if (rows.length === 0) {
            return apiKey;
        }
    }

    throw new Error('Failed to generate unique API key after multiple attempts');
}

/**
 * 创建新的 API Key
 * @param {string} name - Key 名称
 * @param {number} [dailyLimit] - 每日限额，不传则使用配置的默认值
 */
export async function createKey(name = '', dailyLimit = null) {
    const config = await getConfig();
    const actualDailyLimit = dailyLimit ?? config.defaultDailyLimit ?? DEFAULT_CONFIG.defaultDailyLimit;
    const apiKey = await generateUniqueKey();
    const now = new Date();
    const today = getTodayDateString();
    const resolvedName = name || `Key-${Date.now()}`;

    const pool = getPool();
    await pool.query(
        `INSERT INTO api_potluck_users
        (api_key, name, created_at, daily_limit, today_usage, total_usage, last_reset_date, last_used_at, enabled, bonus_remaining)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ,
        [apiKey, resolvedName, now, actualDailyLimit, 0, 0, today, null, true, 0]
    );

    return {
        id: apiKey,
        name: resolvedName,
        createdAt: now.toISOString(),
        dailyLimit: actualDailyLimit,
        todayUsage: 0,
        totalUsage: 0,
        lastResetDate: today,
        lastUsedAt: null,
        enabled: true,
        bonusRemaining: 0
    };
}

/**
 * 获取所有 Key 列表
 */
export async function listKeys() {
    await resetAllDailyUsage();
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT api_key, name, created_at, daily_limit, today_usage, total_usage,
            last_reset_date, last_used_at, enabled, bonus_remaining, regenerated_at, regenerated_from
         FROM api_potluck_users
         ORDER BY created_at`
    );

    const today = getTodayDateString();
    return rows.map(row => ({
        ...normalizeKeyRow(row, today),
        maskedKey: maskKey(row.api_key)
    }));
}

/**
 * 获取单个 Key 详情
 */
export async function getKey(keyId) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT api_key, name, created_at, daily_limit, today_usage, total_usage,
            last_reset_date, last_used_at, enabled, bonus_remaining, regenerated_at, regenerated_from
         FROM api_potluck_users
         WHERE api_key = ? LIMIT 1`,
        [keyId]
    );
    if (rows.length === 0) return null;

    const today = getTodayDateString();
    const lastResetDate = toDateOnly(rows[0].last_reset_date);
    const resetResult = await resetDailyUsageIfNeeded(keyId, lastResetDate);
    const row = {
        ...rows[0],
        today_usage: resetResult.todayUsage !== null ? resetResult.todayUsage : rows[0].today_usage,
        last_reset_date: resetResult.lastResetDate || rows[0].last_reset_date
    };

    return normalizeKeyRow(row, today);
}

/**
 * 删除 Key
 */
export async function deleteKey(keyId) {
    const pool = getPool();
    const [result] = await pool.query('DELETE FROM api_potluck_users WHERE api_key = ?', [keyId]);
    if (result.affectedRows > 0) {
        console.log(`[API Potluck] Deleted key: ${keyId.substring(0, 12)}...`);
        return true;
    }
    return false;
}

/**
 * 更新 Key 的每日限额
 */
export async function updateKeyLimit(keyId, newLimit) {
    const pool = getPool();
    const [result] = await pool.query('UPDATE api_potluck_users SET daily_limit = ? WHERE api_key = ?', [newLimit, keyId]);
    if (result.affectedRows === 0) return null;
    return await getKey(keyId);
}

/**
 * 重置 Key 的当天调用次数
 */
export async function resetKeyUsage(keyId) {
    const today = getTodayDateString();
    const pool = getPool();
    const [result] = await pool.query(
        'UPDATE api_potluck_users SET today_usage = 0, last_reset_date = ? WHERE api_key = ?',
        [today, keyId]
    );
    if (result.affectedRows === 0) return null;
    return await getKey(keyId);
}

/**
 * 切换 Key 的启用/禁用状态
 */
export async function toggleKey(keyId) {
    const pool = getPool();
    const [result] = await pool.query(
        'UPDATE api_potluck_users SET enabled = NOT enabled WHERE api_key = ?',
        [keyId]
    );
    if (result.affectedRows === 0) return null;
    return await getKey(keyId);
}

/**
 * 更新 Key 名称
 */
export async function updateKeyName(keyId, newName) {
    const pool = getPool();
    const [result] = await pool.query(
        'UPDATE api_potluck_users SET name = ? WHERE api_key = ?',
        [newName, keyId]
    );
    if (result.affectedRows === 0) return null;
    return await getKey(keyId);
}

/**
 * 重新生成 API Key（保留原有数据，更换 Key ID）
 */
export async function regenerateKey(oldKeyId) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT api_key, name, created_at, daily_limit, today_usage, total_usage,
            last_reset_date, last_used_at, enabled, bonus_remaining
         FROM api_potluck_users
         WHERE api_key = ? LIMIT 1`,
        [oldKeyId]
    );
    if (rows.length === 0) return null;

    const oldRow = rows[0];
    const newKeyId = await generateUniqueKey();
    const now = new Date();
    const regeneratedFrom = `${oldKeyId.substring(0, 12)}...`;

    await pool.query(
        `INSERT INTO api_potluck_users
        (api_key, name, created_at, daily_limit, today_usage, total_usage,
         last_reset_date, last_used_at, enabled, bonus_remaining, regenerated_from, regenerated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            newKeyId,
            oldRow.name,
            oldRow.created_at,
            oldRow.daily_limit,
            oldRow.today_usage,
            oldRow.total_usage,
            oldRow.last_reset_date,
            oldRow.last_used_at,
            oldRow.enabled,
            oldRow.bonus_remaining,
            regeneratedFrom,
            now
        ]
    );

    await pool.query('DELETE FROM api_potluck_users WHERE api_key = ?', [oldKeyId]);

    const keyData = await getKey(newKeyId);
    if (keyData) {
        keyData.regeneratedFrom = regeneratedFrom;
        keyData.regeneratedAt = now.toISOString();
    }

    console.log(`[API Potluck] Regenerated key: ${oldKeyId.substring(0, 12)}... -> ${newKeyId.substring(0, 12)}...`);

    return {
        oldKey: oldKeyId,
        newKey: newKeyId,
        keyData
    };
}

/**
 * 验证 API Key 是否有效且有配额（每日限额 + 资源包）
 */
export async function validateKey(apiKey) {
    if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }

    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT api_key, name, created_at, daily_limit, today_usage, total_usage,
            last_reset_date, last_used_at, enabled, bonus_remaining
         FROM api_potluck_users
         WHERE api_key = ? LIMIT 1`,
        [apiKey]
    );
    if (rows.length === 0) return { valid: false, reason: 'not_found' };

    const today = getTodayDateString();
    const keyData = normalizeKeyRow(rows[0], today);

    if (!keyData.enabled) {
        return { valid: false, reason: 'disabled', keyData };
    }

    if (keyData.todayUsage < keyData.dailyLimit) {
        return { valid: true, keyData, useBonus: false };
    }

    if ((keyData.bonusRemaining || 0) > 0) {
        return { valid: true, keyData, useBonus: true, bonusRemaining: keyData.bonusRemaining };
    }

    return { valid: false, reason: 'quota_exceeded', keyData };
}

/**
 * 增加 Key 的使用次数（原子操作）
 * 优先消耗每日限额，用尽后消耗资源包
 */
export async function incrementUsage(apiKey, onBonusUsed = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(
            `SELECT api_key, name, created_at, daily_limit, today_usage, total_usage,
                last_reset_date, last_used_at, enabled, bonus_remaining
             FROM api_potluck_users
             WHERE api_key = ? LIMIT 1 FOR UPDATE`,
            [apiKey]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return null;
        }

        const row = rows[0];
        if (!row.enabled) {
            await connection.rollback();
            return null;
        }

        const today = getTodayDateString();
        let lastResetDate = toDateOnly(row.last_reset_date);
        let todayUsage = Number(row.today_usage || 0);
        if (!lastResetDate || lastResetDate !== today) {
            lastResetDate = today;
            todayUsage = 0;
        }

        let bonusRemaining = Number(row.bonus_remaining || 0);
        let usedBonus = false;

        if (todayUsage < Number(row.daily_limit || 0)) {
            todayUsage += 1;
        } else if (bonusRemaining > 0) {
            bonusRemaining -= 1;
            usedBonus = true;
        } else {
            await connection.rollback();
            return null;
        }

        const totalUsage = Number(row.total_usage || 0) + 1;
        const now = new Date();

        await connection.query(
            `UPDATE api_potluck_users
             SET today_usage = ?, total_usage = ?, last_used_at = ?, last_reset_date = ?, bonus_remaining = ?
             WHERE api_key = ?`,
            [todayUsage, totalUsage, now, lastResetDate, bonusRemaining, apiKey]
        );

        await connection.commit();

        if (usedBonus && onBonusUsed) {
            await onBonusUsed(apiKey);
        }

        const keyData = normalizeKeyRow({
            ...row,
            today_usage: todayUsage,
            total_usage: totalUsage,
            last_used_at: now,
            last_reset_date: lastResetDate,
            bonus_remaining: bonusRemaining
        }, today);

        return {
            ...keyData,
            usedBonus
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * 获取统计信息
 */
export async function getStats() {
    await resetAllDailyUsage();
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT
            COUNT(*) AS totalKeys,
            SUM(CASE WHEN enabled = TRUE THEN 1 ELSE 0 END) AS enabledKeys,
            SUM(CASE WHEN enabled = FALSE THEN 1 ELSE 0 END) AS disabledKeys,
            SUM(CASE WHEN last_reset_date = CURDATE() THEN today_usage ELSE 0 END) AS todayTotalUsage,
            SUM(total_usage) AS totalUsage
         FROM api_potluck_users`
    );

    const stats = rows[0] || {};
    return {
        totalKeys: Number(stats.totalKeys || 0),
        enabledKeys: Number(stats.enabledKeys || 0),
        disabledKeys: Number(stats.disabledKeys || 0),
        todayTotalUsage: Number(stats.todayTotalUsage || 0),
        totalUsage: Number(stats.totalUsage || 0)
    };
}

/**
 * 更新 Key 的剩余资源包次数（由同步检查调用）
 */
export async function updateBonusRemaining(keyId, bonusRemaining) {
    const pool = getPool();
    const [result] = await pool.query(
        'UPDATE api_potluck_users SET bonus_remaining = ? WHERE api_key = ?',
        [Math.max(0, bonusRemaining), keyId]
    );
    return result.affectedRows > 0;
}

/**
 * 获取 Key 的资源包信息
 */
export async function getBonusInfo(keyId, getConfigFn = null) {
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT bonus_remaining FROM api_potluck_users WHERE api_key = ? LIMIT 1',
        [keyId]
    );
    if (rows.length === 0) return null;

    const config = getConfigFn ? await getConfigFn() : { bonusPerCredential: 300, bonusValidityDays: 30 };

    return {
        bonusRemaining: Number(rows[0].bonus_remaining || 0),
        bonusPerCredential: config.bonusPerCredential,
        validityDays: config.bonusValidityDays
    };
}

/**
 * 批量更新所有 Key 的每日限额
 */
export async function applyDailyLimitToAllKeys(newLimit) {
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN daily_limit <> ? OR daily_limit IS NULL THEN 1 ELSE 0 END) AS updated FROM api_potluck_users',
        [newLimit]
    );
    await pool.query('UPDATE api_potluck_users SET daily_limit = ?', [newLimit]);

    const stats = rows[0] || {};
    return {
        total: Number(stats.total || 0),
        updated: Number(stats.updated || 0)
    };
}

/**
 * 获取所有 Key ID 列表
 */
export async function getAllKeyIds() {
    const pool = getPool();
    const [rows] = await pool.query('SELECT api_key FROM api_potluck_users');
    return rows.map(row => row.api_key);
}

// 导出常量
export { KEY_PREFIX };
