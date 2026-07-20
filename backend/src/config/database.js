/**
 * MySQL 数据库配置和连接池管理
 *
 * 高并发优化说明：
 * - connectionLimit: 连接池大小，需要与 MySQL max_connections 配合
 * - queueLimit: 等待队列限制，防止内存溢出
 * - acquireTimeout: 获取连接超时，避免无限等待
 *
 * MySQL 服务端配置要求（my.cnf）：
 * - max_connections >= connectionLimit × Worker数量 + 50
 * - wait_timeout = 600
 * - thread_cache_size = 100
 */

import mysql from 'mysql2/promise';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 数据库连接池
let pool = null;

// 连接池监控间隔（毫秒）
let monitorInterval = null;

function sanitizeSqlParam(value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(sanitizeSqlParam);
    if (value && typeof value === 'object' && value.constructor === Object) {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, sanitizeSqlParam(item)])
        );
    }
    return value;
}

export function sanitizeSqlParams(params) {
    if (params === undefined) return undefined;
    return sanitizeSqlParam(params);
}

function wrapSqlExecutor(target) {
    if (!target || target.__accounthubSqlSanitized) return target;

    for (const method of ['execute', 'query']) {
        if (typeof target[method] !== 'function') continue;
        const original = target[method].bind(target);
        target[method] = (sql, params, ...rest) => original(sql, sanitizeSqlParams(params), ...rest);
    }

    Object.defineProperty(target, '__accounthubSqlSanitized', {
        value: true,
        enumerable: false
    });
    return target;
}

function wrapPool(dbPool) {
    wrapSqlExecutor(dbPool);
    const originalGetConnection = dbPool.getConnection.bind(dbPool);
    dbPool.getConnection = async (...args) => {
        const connection = await originalGetConnection(...args);
        return wrapSqlExecutor(connection);
    };
    return dbPool;
}

/**
 * 获取数据库配置
 * 优先使用环境变量，其次使用配置文件
 */
export function getDatabaseConfig(config = {}) {
    // 根据 Worker 数量计算合理的默认连接数
    const workerCount = parseInt(process.env.WORKERS) || os.cpus().length;
    // 默认总连接数 600，平均分配给每个 Worker（提升并发能力）
    const defaultConnectionLimit = Math.max(50, Math.ceil(600 / workerCount));

    return {
        host: process.env.DB_HOST || config.DATABASE?.HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || config.DATABASE?.PORT || '3306'),
        user: process.env.DB_USER || config.DATABASE?.USER || 'root',
        password: process.env.DB_PASSWORD || config.DATABASE?.PASSWORD || '',
        // Prefer DB_DATABASE. New installs should use `accounthub`.
        // Legacy deployments may still set DB_DATABASE=aiclient explicitly.
        database: process.env.DB_DATABASE || config.DATABASE?.DATABASE || 'accounthub',

        // 连接池配置 - 高并发优化
        connectionLimit: parseInt(
            process.env.DB_CONNECTION_LIMIT ||
            config.DATABASE?.CONNECTION_LIMIT ||
            String(defaultConnectionLimit)
        ),
        waitForConnections: true,
        queueLimit: parseInt(process.env.DB_QUEUE_LIMIT || '200'),  // 限制等待队列，防止内存溢出（从1000降到200）
        acquireTimeout: 30000,  // 获取连接超时30秒，避免无限等待

        // Keep-Alive 配置
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,  // 10秒后开始 keep-alive 探测

        // 超时配置
        connectTimeout: 10000,      // 连接超时 10秒

        // 字符集
        charset: 'utf8mb4',

        // 时区设置
        timezone: '+08:00',

        // 其他优化配置
        multipleStatements: false,  // 禁用多语句（安全）
        namedPlaceholders: true     // 支持命名占位符
    };
}

/**
 * 初始化数据库连接池
 * @param {Object} config - 配置对象
 * @returns {Promise<mysql.Pool>}
 */
export async function initializeDatabase(config = {}) {
    if (pool) {
        console.log('[Database] Connection pool already initialized');
        return pool;
    }

    try {
        const dbConfig = getDatabaseConfig(config);

        console.log('[Database] Initializing connection pool...');
        console.log(`[Database] Host: ${dbConfig.host}:${dbConfig.port}`);
        console.log(`[Database] Database: ${dbConfig.database}`);
        console.log(`[Database] Connection Limit: ${dbConfig.connectionLimit}`);

        // 创建连接池
        pool = wrapPool(mysql.createPool(dbConfig));

        // 测试连接
        const connection = await pool.getConnection();
        console.log('[Database] Connection test successful');
        connection.release();

        // 设置连接池事件监听
        pool.on('connection', (connection) => {
            console.log('[Database] New connection established');
        });

        pool.on('acquire', (connection) => {
            // console.log('[Database] Connection acquired from pool');
        });

        pool.on('release', (connection) => {
            // console.log('[Database] Connection released back to pool');
        });

        return pool;
    } catch (error) {
        const details = [error.code, error.errno, error.sqlMessage, error.message]
            .filter(Boolean)
            .join(' | ');
        console.error('[Database] Failed to initialize connection pool:', details || 'Unknown error');
        throw error;
    }
}

/**
 * 获取数据库连接池
 * @returns {mysql.Pool}
 */
export function getPool() {
    if (!pool) {
        throw new Error('Database pool not initialized. Call initializeDatabase() first.');
    }
    return pool;
}

/**
 * 执行查询
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @returns {Promise<Array>}
 */
export async function query(sql, params = []) {
    const connection = await getPool().getConnection();
    try {
        const [rows] = await connection.execute(sql, params);
        return rows;
    } finally {
        connection.release();
    }
}

/**
 * 执行事务
 * @param {Function} callback - 事务回调函数
 * @returns {Promise<any>}
 */
export async function transaction(callback) {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * 检查数据库连接健康状态
 * @returns {Promise<boolean>}
 */
export async function checkHealth() {
    try {
        const connection = await getPool().getConnection();
        await connection.ping();
        connection.release();
        return true;
    } catch (error) {
        console.error('[Database] Health check failed:', error.message);
        return false;
    }
}

/**
 * 关闭数据库连接池
 * @returns {Promise<void>}
 */
export async function closeDatabase() {
    if (pool) {
        console.log('[Database] Closing connection pool...');
        await pool.end();
        pool = null;
        console.log('[Database] Connection pool closed');
    }
}

/**
 * 检查数据库是否已初始化
 * @returns {boolean}
 */
export function isDatabaseInitialized() {
    return pool !== null;
}

/**
 * 获取 MySQL 状态信息
 * @returns {Promise<Object>}
 */
export async function getMySQLStatus() {
    const connection = await getPool().getConnection();
    try {
        // 获取全局状态变量
        const [statusRows] = await connection.query('SHOW GLOBAL STATUS');
        const status = {};
        statusRows.forEach(row => {
            status[row.Variable_name] = row.Value;
        });

        // 获取全局变量
        const [variableRows] = await connection.query('SHOW GLOBAL VARIABLES');
        const variables = {};
        variableRows.forEach(row => {
            variables[row.Variable_name] = row.Value;
        });

        // 获取连接池状态
        const poolStatus = pool.pool;

        return {
            // 连接信息
            connections: {
                current: parseInt(status.Threads_connected) || 0,
                running: parseInt(status.Threads_running) || 0,
                max: parseInt(variables.max_connections) || 0,
                created: parseInt(status.Connections) || 0,
                aborted: parseInt(status.Aborted_connects) || 0,
                cached: parseInt(status.Threads_cached) || 0,
            },
            // 查询统计
            queries: {
                total: parseInt(status.Questions) || 0,
                select: parseInt(status.Com_select) || 0,
                insert: parseInt(status.Com_insert) || 0,
                update: parseInt(status.Com_update) || 0,
                delete: parseInt(status.Com_delete) || 0,
                slowQueries: parseInt(status.Slow_queries) || 0,
            },
            // 流量统计
            traffic: {
                bytesReceived: parseInt(status.Bytes_received) || 0,
                bytesSent: parseInt(status.Bytes_sent) || 0,
            },
            // 运行时间
            uptime: parseInt(status.Uptime) || 0,
            // 缓冲池
            bufferPool: {
                size: parseInt(variables.innodb_buffer_pool_size) || 0,
                reads: parseInt(status.Innodb_buffer_pool_reads) || 0,
                readRequests: parseInt(status.Innodb_buffer_pool_read_requests) || 0,
            },
            // 本地连接池状态
            localPool: {
                total: poolStatus?._allConnections?.length || 0,
                free: poolStatus?._freeConnections?.length || 0,
                acquiring: poolStatus?._acquiringConnections?.length || 0,
                queue: poolStatus?._connectionQueue?.length || 0,
            },
            // 版本信息
            version: variables.version || 'unknown',
        };
    } finally {
        connection.release();
    }
}

/**
 * 获取连接池健康状态（轻量级，不查询 MySQL）
 * @returns {Object}
 */
export function getPoolHealth() {
    if (!pool) {
        return { status: 'not_initialized', message: 'Database pool not initialized' };
    }

    const poolInternal = pool.pool;
    const total = poolInternal?._allConnections?.length || 0;
    const free = poolInternal?._freeConnections?.length || 0;
    const queue = poolInternal?._connectionQueue?.length || 0;
    const acquiring = poolInternal?._acquiringConnections?.length || 0;
    const used = total - free;

    // 计算利用率
    const configLimit = getDatabaseConfig().connectionLimit;
    const utilization = configLimit > 0 ? (used / configLimit) : 0;

    // 判断健康状态
    let status = 'healthy';
    let message = 'Connection pool is healthy';

    if (utilization > 0.9) {
        status = 'critical';
        message = `Connection pool near capacity: ${used}/${configLimit} (${(utilization * 100).toFixed(1)}%)`;
    } else if (utilization > 0.7) {
        status = 'warning';
        message = `Connection pool usage high: ${used}/${configLimit} (${(utilization * 100).toFixed(1)}%)`;
    }

    if (queue > 100) {
        status = 'critical';
        message = `Too many waiting requests in queue: ${queue}`;
    } else if (queue > 50) {
        status = status === 'critical' ? 'critical' : 'warning';
        message = `Queue building up: ${queue} waiting`;
    }

    return {
        status,
        message,
        total,
        free,
        used,
        queue,
        acquiring,
        configLimit,
        utilization: (utilization * 100).toFixed(1) + '%'
    };
}

/**
 * 执行带超时的查询
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @param {number} timeout - 超时时间（毫秒），默认 30 秒
 * @returns {Promise<Array>}
 */
export async function queryWithTimeout(sql, params = [], timeout = 30000) {
    const connection = await getPool().getConnection();

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Query timeout after ${timeout}ms`));
        }, timeout);
    });

    try {
        const queryPromise = connection.execute(sql, params);
        const [rows] = await Promise.race([queryPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        return rows;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * 启动连接池监控
 * @param {number} intervalMs - 监控间隔（毫秒），默认 60 秒
 */
export function startPoolMonitor(intervalMs = 60000) {
    if (monitorInterval) {
        console.log('[Database] Pool monitor already running');
        return;
    }

    monitorInterval = setInterval(() => {
        const health = getPoolHealth();
        if (health.status === 'critical') {
            console.error(`[Database] CRITICAL: ${health.message}`);
        } else if (health.status === 'warning') {
            console.warn(`[Database] WARNING: ${health.message}`);
        }
        // healthy 状态不输出日志，减少噪音
    }, intervalMs);

    console.log(`[Database] Pool monitor started (interval: ${intervalMs}ms)`);
}

/**
 * 停止连接池监控
 */
export function stopPoolMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        console.log('[Database] Pool monitor stopped');
    }
}

// 进程退出时关闭连接池和监控
process.on('SIGINT', async () => {
    stopPoolMonitor();
    await closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    stopPoolMonitor();
    await closeDatabase();
    process.exit(0);
});
