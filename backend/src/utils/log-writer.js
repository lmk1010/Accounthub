import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const DATE_FORMAT = /\d{4}-\d{2}-\d{2}/;
let currentDate = null;
let logStream = null;

const ensureLogDir = () => {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
};

const getDateStamp = (date = new Date()) => {
    // 转换为 UTC+8 时区
    const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8Date.toISOString().split('T')[0];
};

const getLogFilePath = (dateStamp) => {
    if (!DATE_FORMAT.test(dateStamp)) {
        return path.join(LOG_DIR, 'server.log');
    }
    return path.join(LOG_DIR, `server-${dateStamp}.log`);
};

const rotateIfNeeded = () => {
    const today = getDateStamp();
    const logPath = getLogFilePath(today);

    // 检查日期和文件是否存在，文件被删除时重建
    if (today === currentDate && logStream && fs.existsSync(logPath)) {
        return logStream;
    }
    if (logStream) {
        logStream.end();
        logStream = null;
    }
    currentDate = today;
    ensureLogDir();
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    return logStream;
};

export function writeLogLine(level, message, meta = null) {
    try {
        // 转换为 UTC+8 时区
        const now = new Date();
        const utc8Date = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const timestamp = utc8Date.toISOString().replace('Z', '+08:00');
        const upperLevel = String(level || 'INFO').toUpperCase();
        const metaSuffix = meta ? ` ${safeStringify(meta)}` : '';
        const line = `[${timestamp}] [${upperLevel}] ${message}${metaSuffix}\n`;
        rotateIfNeeded().write(line);
    } catch (error) {
        // Fallback to stderr if logging fails
        try {
            process.stderr.write(`[LogWriter] Failed to write log: ${error?.message || error}\n`);
        } catch (_ignored) {
            // Ignore stderr failures
        }
    }
}

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return '"[Unserializable]"';
    }
}

export function closeLogStream() {
    if (logStream) {
        logStream.end();
        logStream = null;
    }
}
