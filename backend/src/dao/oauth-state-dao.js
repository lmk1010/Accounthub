/**
 * OAuth State DAO
 * 存储 OAuth state/code_verifier，避免多进程内存不一致
 */

import { getPool } from '../config/database.js';

let oauthStateTableReady = false;

async function ensureTable() {
    if (oauthStateTableReady) return;
    const pool = getPool();
    const sql = `
        CREATE TABLE IF NOT EXISTS oauth_state (
            id INT AUTO_INCREMENT PRIMARY KEY,
            provider_type VARCHAR(64) NOT NULL,
            state VARCHAR(128) NOT NULL,
            code_verifier VARCHAR(255) NOT NULL,
            redirect_uri VARCHAR(512) NOT NULL,
            metadata TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME DEFAULT NULL,
            UNIQUE KEY uq_oauth_state (state),
            INDEX idx_provider_type (provider_type),
            INDEX idx_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
    await pool.execute(sql);
    oauthStateTableReady = true;
}

function normalizeRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        providerType: row.provider_type,
        state: row.state,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
        metadata: row.metadata ? safeParse(row.metadata) : null,
        createdAt: row.created_at,
        expiresAt: row.expires_at
    };
}

function safeParse(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

export async function saveState({
    providerType,
    state,
    codeVerifier,
    redirectUri,
    ttlMs = 10 * 60 * 1000,
    metadata = null
}) {
    if (!providerType || !state || !codeVerifier || !redirectUri) {
        throw new Error('providerType/state/codeVerifier/redirectUri are required');
    }
    await ensureTable();
    const pool = getPool();
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;
    const metaValue = metadata ? JSON.stringify(metadata) : null;
    const sql = `
        INSERT INTO oauth_state (provider_type, state, code_verifier, redirect_uri, metadata, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            provider_type = VALUES(provider_type),
            code_verifier = VALUES(code_verifier),
            redirect_uri = VALUES(redirect_uri),
            metadata = VALUES(metadata),
            expires_at = VALUES(expires_at)
    `;
    await pool.execute(sql, [providerType, state, codeVerifier, redirectUri, metaValue, expiresAt]);
}

export async function getState(state) {
    if (!state) return null;
    await ensureTable();
    const pool = getPool();
    const sql = `
        SELECT id, provider_type, state, code_verifier, redirect_uri, metadata, created_at, expires_at
        FROM oauth_state
        WHERE state = ?
        LIMIT 1
    `;
    const [rows] = await pool.execute(sql, [state]);
    if (!rows.length) return null;
    const record = normalizeRow(rows[0]);
    if (record?.expiresAt) {
        const expiresAt = new Date(record.expiresAt).getTime();
        if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
            await deleteState(state);
            return null;
        }
    }
    return record;
}

export async function deleteState(state) {
    if (!state) return 0;
    await ensureTable();
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM oauth_state WHERE state = ?', [state]);
    return result.affectedRows || 0;
}
