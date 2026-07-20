import { getPool } from '../config/database.js';

const CACHE_KEY_ALL = 'all';

/**
 * 读取消耗统计缓存文件
 * @returns {Promise<Object|null>} 缓存的消耗数据，如果不存在或读取失败则返回 null
 */
export async function readConsumptionCache() {
    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT cache_json FROM consumption_cache WHERE cache_key = ?',
            [CACHE_KEY_ALL]
        );
        if (rows.length === 0) {
            return null;
        }
        const payload = rows[0].cache_json;
        return typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (error) {
        console.warn('[Consumption Cache] Failed to read consumption cache from MySQL:', error.message);
        return null;
    }
}

/**
 * 写入消耗统计缓存文件
 * @param {Object} consumptionData - 消耗数据
 */
export async function writeConsumptionCache(consumptionData) {
    try {
        const pool = getPool();
        await pool.execute(
            `INSERT INTO consumption_cache (cache_key, cache_json, updated_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                 cache_json = VALUES(cache_json),
                 updated_at = NOW()`,
            [CACHE_KEY_ALL, JSON.stringify(consumptionData)]
        );
        console.log('[Consumption Cache] Consumption data cached to MySQL');
    } catch (error) {
        console.error('[Consumption Cache] Failed to write consumption cache to MySQL:', error.message);
    }
}
