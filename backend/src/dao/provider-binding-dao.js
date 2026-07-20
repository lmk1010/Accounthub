/**
 * Provider Binding DAO - 账号绑定访问层
 */

import { getPool } from '../config/database.js';

function toInt(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return parsed;
}

function normalizePoolId(poolId) {
    const parsed = toInt(poolId);
    if (parsed === null) {
        return 0;
    }
    return parsed;
}

async function executeQuery(connection, sql, params = []) {
    if (connection) {
        const [rows] = await connection.execute(sql, params);
        return rows;
    }
    const pool = getPool();
    const [rows] = await pool.execute(sql, params);
    return rows;
}

export async function withBindingLock(lockKey, timeoutSeconds, callback) {
    const pool = getPool();
    const connection = await pool.getConnection();
    let lockAcquired = false;
    try {
        const rows = await executeQuery(connection, 'SELECT GET_LOCK(?, ?) AS acquired', [lockKey, timeoutSeconds]);
        lockAcquired = rows && rows[0] && rows[0].acquired === 1;
        if (!lockAcquired) {
            return null;
        }
        const result = await callback(connection);
        return result;
    } finally {
        if (lockAcquired) {
            try {
                await executeQuery(connection, 'SELECT RELEASE_LOCK(?)', [lockKey]);
            } catch (error) {
                console.warn('[ProviderBindingDAO] Failed to release lock:', error.message);
            }
        }
        connection.release();
    }
}

export async function getBinding(providerType, tokenId, poolId = null, connection = null) {
    const normalizedTokenId = toInt(tokenId);
    const normalizedPoolId = normalizePoolId(poolId);
    if (!providerType || normalizedTokenId === null) {
        return null;
    }

    const rows = await executeQuery(
        connection,
        `
        SELECT provider_uuid, token_id, provider_type, last_used
        FROM provider_bindings
        WHERE provider_type = ? AND token_id = ? AND pool_id = ?
        LIMIT 1
        `,
        [providerType, normalizedTokenId, normalizedPoolId]
    );

    if (!rows || rows.length === 0) {
        return null;
    }

    return rows[0];
}

export async function upsertBinding(providerType, tokenId, poolId, providerUuid, connection = null) {
    const normalizedTokenId = toInt(tokenId);
    const normalizedPoolId = normalizePoolId(poolId);
    if (!providerType || normalizedTokenId === null || !providerUuid) {
        return false;
    }

    await executeQuery(
        connection,
        `
        INSERT INTO provider_bindings
            (provider_type, token_id, pool_id, provider_uuid, last_used)
        VALUES
            (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
            provider_uuid = VALUES(provider_uuid),
            last_used = NOW()
        `,
        [providerType, normalizedTokenId, normalizedPoolId, providerUuid]
    );

    return true;
}

export async function touchBinding(providerType, tokenId, poolId = null, connection = null) {
    const normalizedTokenId = toInt(tokenId);
    const normalizedPoolId = normalizePoolId(poolId);
    if (!providerType || normalizedTokenId === null) {
        return false;
    }

    await executeQuery(
        connection,
        `
        UPDATE provider_bindings
        SET last_used = NOW()
        WHERE provider_type = ? AND token_id = ? AND pool_id = ?
        `,
        [providerType, normalizedTokenId, normalizedPoolId]
    );

    return true;
}

export async function deleteBinding(providerType, tokenId, poolId = null, connection = null) {
    const normalizedTokenId = toInt(tokenId);
    const normalizedPoolId = normalizePoolId(poolId);
    if (!providerType || normalizedTokenId === null) {
        return false;
    }

    await executeQuery(
        connection,
        `
        DELETE FROM provider_bindings
        WHERE provider_type = ? AND token_id = ? AND pool_id = ?
        `,
        [providerType, normalizedTokenId, normalizedPoolId]
    );

    return true;
}

export async function deleteBindingsByProviderUuid(providerUuid, connection = null) {
    if (!providerUuid) {
        return false;
    }

    await executeQuery(
        connection,
        `
        DELETE FROM provider_bindings
        WHERE provider_uuid = ?
        `,
        [providerUuid]
    );

    return true;
}
