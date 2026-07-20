/**
 * Admin auth token DAO
 */

import { getPool } from '../config/database.js';

export async function getToken(token) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT token, username, login_time, expiry_time FROM auth_tokens WHERE token = ?',
        [token]
    );
    if (!rows.length) return null;
    return rows[0];
}

export async function saveToken(token, tokenInfo) {
    const pool = getPool();
    const sql = `
        INSERT INTO auth_tokens (token, username, login_time, expiry_time)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            username = VALUES(username),
            login_time = VALUES(login_time),
            expiry_time = VALUES(expiry_time)
    `;
    await pool.execute(sql, [
        token,
        tokenInfo.username,
        tokenInfo.loginTime,
        tokenInfo.expiryTime
    ]);
}

export async function deleteToken(token) {
    const pool = getPool();
    await pool.execute('DELETE FROM auth_tokens WHERE token = ?', [token]);
}

export async function deleteExpiredTokens(nowMs) {
    const pool = getPool();
    const [result] = await pool.execute(
        'DELETE FROM auth_tokens WHERE expiry_time < ?',
        [nowMs]
    );
    return result.affectedRows || 0;
}
