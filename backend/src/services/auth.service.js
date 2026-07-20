/**
 * 认证服务层
 * 处理登录、token 管理等业务逻辑
 */

import crypto from 'crypto';
import * as appMetaDao from '../dao/app-meta-dao.js';
import * as authTokensDao from '../dao/auth-tokens-dao.js';
import { validateCredentials, readPasswordHash } from '../ui-modules/auth.js';

/**
 * 验证密码（委托给 bcrypt 安全验证）
 */
async function validatePassword(password) {
    return validateCredentials(password);
}

/**
 * 生成 token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 获取过期时间（1小时后）
 */
function getExpiryTime() {
    return Date.now() + (60 * 60 * 1000);
}

/**
 * 登录
 */
export async function login(password) {
    // 检查密码是否已设置
    const storedHash = await readPasswordHash();
    if (!storedHash) {
        return {
            success: false,
            needSetup: true,
            message: 'Admin password not configured. Please set a password first.'
        };
    }

    const isValid = await validatePassword(password);

    if (!isValid) {
        return {
            success: false,
            message: 'Incorrect password, please try again'
        };
    }

    const token = generateToken();
    const expiryTime = getExpiryTime();

    await authTokensDao.saveToken(token, {
        username: 'admin',
        loginTime: Date.now(),
        expiryTime
    });

    return {
        success: true,
        message: 'Login successful',
        token,
        expiresIn: '1 hour'
    };
}

/**
 * 登出
 */
export async function logout(token) {
    await authTokensDao.deleteToken(token);
}

/**
 * 验证 token
 */
export async function verifyToken(token) {
    const tokenInfo = await authTokensDao.getToken(token);

    if (!tokenInfo) {
        return null;
    }

    const expiryTime = Number(tokenInfo.expiry_time);

    if (Date.now() > expiryTime) {
        await authTokensDao.deleteToken(token);
        return null;
    }

    return {
        token: tokenInfo.token,
        username: tokenInfo.username,
        loginTime: Number(tokenInfo.login_time),
        expiryTime
    };
}

/**
 * 清理过期 token
 */
export async function cleanupExpiredTokens() {
    const now = Date.now();

    try {
        const removed = await authTokensDao.deleteExpiredTokens(now);

        if (removed > 0) {
            console.log(`[Auth] Cleaned up ${removed} expired token(s)`);
        }
    } catch (error) {
        console.error('[Auth] Failed to cleanup expired tokens:', error.message);
    }
}

let authCleanupTimer = null;

// 启动定时清理过期 token
export function startAuthCleanupScheduler(intervalMinutes = 5) {
    if (authCleanupTimer) {
        clearInterval(authCleanupTimer);
    }
    const safeMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 5;
    const intervalMs = safeMinutes * 60 * 1000;
    authCleanupTimer = setInterval(cleanupExpiredTokens, intervalMs);
}

// 停止定时清理过期 token
export function stopAuthCleanupScheduler() {
    if (authCleanupTimer) {
        clearInterval(authCleanupTimer);
        authCleanupTimer = null;
    }
}
