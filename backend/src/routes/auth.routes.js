/**
 * 认证路由模块
 * 处理登录、token 验证等认证相关请求
 */

import { checkAuth, checkLoginRateLimit, recordFailedLogin, clearLoginRateLimit, readPasswordHash, changePassword } from '../ui-modules/auth.js';
import { readRequestBody, sendJson, sendError } from './index.js';
import * as authService from '../services/auth.service.js';

/**
 * 认证路由处理器
 */
export async function authRouter(method, path, req, res, context) {
    // POST /api/auth/login - 登录
    if (method === 'POST' && path === '/api/auth/login') {
        return await handleLogin(req, res);
    }

    // POST /api/auth/setup-password - 首次设置密码（仅密码未设置时可用）
    if (method === 'POST' && path === '/api/auth/setup-password') {
        return await handleSetupPassword(req, res);
    }

    // GET /api/auth/verify - 验证 token
    if (method === 'GET' && path === '/api/auth/verify') {
        return await handleVerifyToken(req, res);
    }

    // POST /api/auth/logout - 登出
    if (method === 'POST' && path === '/api/auth/logout') {
        return await handleLogout(req, res);
    }

    return false;
}

/**
 * 处理登录请求
 */
async function handleLogin(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const { limited, retryAfterSec } = checkLoginRateLimit(ip);
    if (limited) {
        sendJson(res, 429, { success: false, message: `Too many login attempts, please retry after ${retryAfterSec}s` });
        return true;
    }

    try {
        const body = await readRequestBody(req);
        const { password } = JSON.parse(body);

        if (!password) {
            sendError(res, 400, 'Password cannot be empty', 'INVALID_INPUT');
            return true;
        }

        const result = await authService.login(password);

        if (result.success) {
            clearLoginRateLimit(ip);
            sendJson(res, 200, result);
        } else {
            recordFailedLogin(ip);
            sendJson(res, 401, result);
        }
    } catch (error) {
        console.error('[Auth] Login error:', error);
        sendError(res, 500, error.message || 'Server error', 'SERVER_ERROR');
    }

    return true;
}

/**
 * 处理首次设置密码请求（仅密码未设置时可用）
 */
async function handleSetupPassword(req, res) {
    try {
        // 检查密码是否已设置，已设置则拒绝
        const existingHash = await readPasswordHash();
        if (existingHash) {
            sendError(res, 403, 'Password already configured. Use change-password instead.', 'ALREADY_CONFIGURED');
            return true;
        }

        const body = await readRequestBody(req);
        const { password } = JSON.parse(body);

        if (!password || password.length < 6) {
            sendError(res, 400, 'Password must be at least 6 characters', 'INVALID_INPUT');
            return true;
        }

        await changePassword(password);
        sendJson(res, 200, { success: true, message: 'Password configured successfully. Please login.' });
    } catch (error) {
        console.error('[Auth] Setup password error:', error);
        sendError(res, 500, error.message || 'Server error', 'SERVER_ERROR');
    }

    return true;
}

/**
 * 处理 token 验证请求
 */
async function handleVerifyToken(req, res) {
    try {
        const isValid = await checkAuth(req);

        if (isValid) {
            sendJson(res, 200, { valid: true });
        } else {
            sendJson(res, 401, { valid: false });
        }
    } catch (error) {
        console.error('[Auth] Verify token error:', error);
        sendError(res, 500, error.message || 'Server error', 'SERVER_ERROR');
    }

    return true;
}

/**
 * 处理登出请求
 */
async function handleLogout(req, res) {
    try {
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            await authService.logout(token);
        }

        sendJson(res, 200, { success: true, message: 'Logout successful' });
    } catch (error) {
        console.error('[Auth] Logout error:', error);
        sendError(res, 500, error.message || 'Server error', 'SERVER_ERROR');
    }

    return true;
}
