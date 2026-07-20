/**
 * 日志工具 - 同时输出到控制台和文件
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志文件路径
const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, `warp-${new Date().toISOString().split('T')[0]}.log`);

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 日志流
let logStream = null;

/**
 * 获取日志流（延迟初始化）
 */
function getLogStream() {
    if (!logStream) {
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }
    return logStream;
}

/**
 * 格式化时间戳
 */
function getTimestamp() {
    return new Date().toISOString();
}

/**
 * 写入日志
 */
function writeLog(level, ...args) {
    const timestamp = getTimestamp();
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    // 输出到控制台
    console.log(...args);

    // 写入文件
    try {
        getLogStream().write(logLine);
    } catch (error) {
        console.error('[Logger] Failed to write to log file:', error);
    }
}

/**
 * 日志方法
 */
export const logger = {
    log: (...args) => writeLog('INFO', ...args),
    info: (...args) => writeLog('INFO', ...args),
    warn: (...args) => writeLog('WARN', ...args),
    error: (...args) => writeLog('ERROR', ...args),
    debug: (...args) => writeLog('DEBUG', ...args),

    /**
     * 关闭日志流
     */
    close: () => {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
    }
};

// 进程退出时关闭日志流
process.on('exit', () => {
    logger.close();
});

process.on('SIGINT', () => {
    logger.close();
    process.exit(0);
});
