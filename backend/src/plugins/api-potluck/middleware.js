/**
 * API 大锅饭 - 中间件模块
 * 负责请求拦截和配额检查
 */

import { validateKey, incrementUsage, KEY_PREFIX } from './key-manager.js';

// 是否允许从URL传递API密钥（安全风险：密钥会被记录到日志和历史）
const ALLOW_URL_KEY = process.env.ALLOW_URL_API_KEY === 'true';

/**
 * 从请求中提取 Potluck API Key
 * 支持多种认证方式：
 * 1. Authorization: Bearer maki_xxx
 * 2. x-api-key: maki_xxx
 * 3. x-goog-api-key: maki_xxx
 * 4. URL query: ?key=maki_xxx (默认禁用，安全风险)
 *
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {URL} requestUrl - 解析后的 URL 对象
 * @returns {{key: string|null, source: string|null, warning: string|null}}
 */
export function extractPotluckKey(req, requestUrl) {
    // 1. 检查 Authorization header（推荐）
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith(KEY_PREFIX)) {
            return { key: token, source: 'authorization', warning: null };
        }
    }

    // 2. 检查 x-api-key header (Claude style)
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return { key: xApiKey, source: 'x-api-key', warning: null };
    }

    // 3. 检查 x-goog-api-key header (Gemini style)
    const googApiKey = req.headers['x-goog-api-key'];
    if (googApiKey && googApiKey.startsWith(KEY_PREFIX)) {
        return { key: googApiKey, source: 'x-goog-api-key', warning: null };
    }

    // 4. 检查 URL query parameter（默认禁用，有安全风险）
    const queryKey = requestUrl.searchParams.get('key');
    if (queryKey && queryKey.startsWith(KEY_PREFIX)) {
        if (!ALLOW_URL_KEY) {
            // 返回警告，但不提取密钥
            return {
                key: null,
                source: 'url_query',
                warning: 'API key in URL is not allowed for security reasons. Please use Authorization header instead.'
            };
        }
        // 如果明确允许，返回密钥但带警告
        console.warn('[Potluck] WARNING: API key extracted from URL query parameter. This is a security risk.');
        return {
            key: queryKey,
            source: 'url_query',
            warning: 'Using API key in URL is deprecated and insecure. Please use Authorization header.'
        };
    }

    return { key: null, source: null, warning: null };
}

/**
 * 检查请求是否使用 Potluck Key
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {URL} requestUrl - 解析后的 URL 对象
 * @returns {boolean}
 */
export function isPotluckRequest(req, requestUrl) {
    const result = extractPotluckKey(req, requestUrl);
    return result.key !== null;
}

/**
 * Potluck 认证中间件
 * 验证 Potluck API Key 并检查配额
 *
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {URL} requestUrl - 解析后的 URL 对象
 * @returns {Promise<{authorized: boolean, error?: Object, keyData?: Object, apiKey?: string}>}
 */
export async function potluckAuthMiddleware(req, requestUrl) {
    const extracted = extractPotluckKey(req, requestUrl);

    // 如果URL中有密钥但被禁止，返回错误
    if (extracted.warning && !extracted.key) {
        return {
            authorized: false,
            error: {
                statusCode: 400,
                message: extracted.warning,
                code: 'url_key_not_allowed'
            }
        };
    }

    const apiKey = extracted.key;

    if (!apiKey) {
        // 不是 potluck 请求，返回 null 让原有逻辑处理
        return { authorized: null };
    }

    // 验证 Key
    const validation = await validateKey(apiKey);

    if (!validation.valid) {
        const errorMessages = {
            'invalid_format': 'Invalid API key format',
            'not_found': 'API key not found',
            'disabled': 'API key has been disabled',
            'quota_exceeded': 'Quota exceeded for this API key'
        };

        const statusCodes = {
            'invalid_format': 401,
            'not_found': 401,
            'disabled': 403,
            'quota_exceeded': 429
        };

        return {
            authorized: false,
            error: {
                statusCode: statusCodes[validation.reason] || 401,
                message: errorMessages[validation.reason] || 'Authentication failed',
                code: validation.reason,
                keyData: validation.keyData
            }
        };
    }

    return {
        authorized: true,
        keyData: validation.keyData,
        apiKey: apiKey,
        warning: extracted.warning // 传递警告信息（如果有）
    };
}

/**
 * 记录 Potluck 请求使用
 * 在请求成功处理后调用
 * 
 * @param {string} apiKey - API Key
 * @returns {Promise<Object|null>}
 */
export async function recordPotluckUsage(apiKey) {
    if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
        return null;
    }
    return incrementUsage(apiKey);
}

/**
 * 创建 Potluck 错误响应
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @param {Object} error - 错误信息
 */
export function sendPotluckError(res, error) {
    const response = {
        error: {
            message: error.message,
            code: error.code,
            type: 'potluck_error'
        }
    };

    // 如果是配额超限，添加额外信息
    if (error.code === 'quota_exceeded' && error.keyData) {
        response.error.quota = {
            used: error.keyData.todayUsage,
            limit: error.keyData.dailyLimit,
            resetDate: error.keyData.lastResetDate
        };
    }

    res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
}
