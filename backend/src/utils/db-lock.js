import { getPool } from '../config/database.js';

export async function acquireDbLock(lockKey, timeoutSeconds = 10) {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT GET_LOCK(?, ?) AS lock_result', [lockKey, timeoutSeconds]);
    const result = rows && rows[0] ? rows[0].lock_result : 0;
    if (result !== 1) {
        throw new Error(`Failed to acquire DB lock: ${lockKey}`);
    }
}

export async function releaseDbLock(lockKey) {
    const pool = getPool();
    await pool.execute('SELECT RELEASE_LOCK(?)', [lockKey]);
}

/**
 * 使用同一个连接执行 GET_LOCK / callback / RELEASE_LOCK
 * MySQL GET_LOCK 是连接级别的锁，必须在同一连接上 acquire 和 release
 */
export async function withDbLock(lockKey, timeoutSeconds, callback) {
    const pool = getPool();
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute('SELECT GET_LOCK(?, ?) AS lock_result', [lockKey, timeoutSeconds]);
        const result = rows && rows[0] ? rows[0].lock_result : 0;
        if (result !== 1) {
            throw new Error(`Failed to acquire DB lock: ${lockKey}`);
        }
        try {
            return await callback();
        } finally {
            await connection.execute('SELECT RELEASE_LOCK(?)', [lockKey]).catch(() => {});
        }
    } finally {
        connection.release();
    }
}
