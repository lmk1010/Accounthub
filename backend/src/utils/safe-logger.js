/**
 * 日志脱敏工具
 * 自动隐藏敏感信息（token、password、apiKey等）
 */

// 敏感字段名列表（不区分大小写）
const SENSITIVE_FIELDS = [
    'password', 'passwd', 'pwd',
    'token', 'accesstoken', 'refreshtoken', 'access_token', 'refresh_token',
    'apikey', 'api_key', 'secret', 'secretkey', 'secret_key',
    'authorization', 'auth', 'bearer',
    'credential', 'credentials',
    'private', 'privatekey', 'private_key',
    'cookie', 'session', 'sessionid', 'session_id'
];

// 敏感值模式（正则匹配）
const SENSITIVE_PATTERNS = [
    // Bearer token
    /Bearer\s+[A-Za-z0-9\-_\.]+/gi,
    // API keys (常见格式)
    /sk-[A-Za-z0-9]{20,}/g,
    /pk-[A-Za-z0-9]{20,}/g,
    // JWT tokens
    /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    // Base64 encoded credentials
    /Basic\s+[A-Za-z0-9+/=]{20,}/gi,
];

/**
 * 检查字段名是否为敏感字段
 */
function isSensitiveField(fieldName) {
    if (!fieldName) return false;
    const lowerName = fieldName.toLowerCase().replace(/[_-]/g, '');
    return SENSITIVE_FIELDS.some(sf => lowerName.includes(sf.replace(/[_-]/g, '')));
}

/**
 * 脱敏字符串值
 * @param {string} value - 原始值
 * @param {number} showChars - 显示的字符数（前后各显示一半）
 */
function maskString(value, showChars = 4) {
    if (!value || typeof value !== 'string') return value;
    if (value.length <= showChars * 2) return '***';

    const halfShow = Math.floor(showChars / 2);
    return value.slice(0, halfShow) + '***' + value.slice(-halfShow);
}

/**
 * 脱敏对象中的敏感字段
 */
function sanitizeObject(obj, depth = 0) {
    if (depth > 10) return '[MAX_DEPTH]'; // 防止循环引用
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
        // 对字符串应用敏感模式匹配
        let result = obj;
        for (const pattern of SENSITIVE_PATTERNS) {
            result = result.replace(pattern, match => maskString(match, 8));
        }
        return result;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item, depth + 1));
    }

    if (typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            if (isSensitiveField(key)) {
                // 敏感字段，脱敏处理
                if (typeof value === 'string') {
                    sanitized[key] = maskString(value);
                } else {
                    sanitized[key] = '[REDACTED]';
                }
            } else {
                sanitized[key] = sanitizeObject(value, depth + 1);
            }
        }
        return sanitized;
    }

    return obj;
}

/**
 * 脱敏日志参数
 */
function sanitizeArgs(args) {
    return args.map(arg => {
        if (typeof arg === 'string') {
            let result = arg;
            for (const pattern of SENSITIVE_PATTERNS) {
                result = result.replace(pattern, match => maskString(match, 8));
            }
            return result;
        }
        if (typeof arg === 'object') {
            return sanitizeObject(arg);
        }
        return arg;
    });
}

/**
 * 创建安全的日志函数
 */
function createSafeLogger(level, originalFn) {
    return function(...args) {
        const sanitizedArgs = sanitizeArgs(args);
        originalFn.apply(console, sanitizedArgs);
    };
}

// 保存原始 console 方法
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
};

// 安全日志对象
export const safeLogger = {
    log: createSafeLogger('log', originalConsole.log),
    info: createSafeLogger('info', originalConsole.info),
    warn: createSafeLogger('warn', originalConsole.warn),
    error: createSafeLogger('error', originalConsole.error),
    debug: createSafeLogger('debug', originalConsole.debug),

    // 原始日志（用于非敏感信息）
    raw: originalConsole,
};

/**
 * 全局替换 console（可选）
 * 调用此函数后，所有 console.log 等都会自动脱敏
 */
export function enableGlobalSanitization() {
    console.log = safeLogger.log;
    console.info = safeLogger.info;
    console.warn = safeLogger.warn;
    console.error = safeLogger.error;
    console.debug = safeLogger.debug;
    originalConsole.log('[Logger] Global log sanitization enabled');
}

/**
 * 恢复原始 console
 */
export function disableGlobalSanitization() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    originalConsole.log('[Logger] Global log sanitization disabled');
}

/**
 * 手动脱敏函数（用于特定场景）
 */
export function sanitize(data) {
    if (typeof data === 'string') {
        let result = data;
        for (const pattern of SENSITIVE_PATTERNS) {
            result = result.replace(pattern, match => maskString(match, 8));
        }
        return result;
    }
    return sanitizeObject(data);
}

export default safeLogger;
