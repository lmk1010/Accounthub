/**
 * App meta key/value DAO
 */

import { getPool } from '../config/database.js';

export async function getValue(key) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT meta_value FROM app_meta WHERE meta_key = ?',
        [key]
    );
    if (!rows.length) return null;
    return rows[0].meta_value;
}

export async function setValue(key, value) {
    const pool = getPool();
    const sql = `
        INSERT INTO app_meta (meta_key, meta_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)
    `;
    await pool.execute(sql, [key, value]);
}
