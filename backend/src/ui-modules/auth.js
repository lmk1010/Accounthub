import crypto from 'crypto';
import bcrypt from 'bcrypt';
import * as appMetaDao from '../dao/app-meta-dao.js';
import * as authTokensDao from '../dao/auth-tokens-dao.js';

/**
 * 登录限速器：基于 IP，每个 IP 在窗口期内最多尝试 MAX_ATTEMPTS 次
 */
const LOGIN_RATE_LIMIT = {
    windowMs: 15 * 60 * 1000,  // 15 分钟窗口
    maxAttempts: 10,            // 最多 10 次失败
};
const _loginAttempts = new Map(); // ip -> { count, firstAttempt }

function isLocalLoopbackIp(ip) {
    const value = String(ip || '').trim().toLowerCase();
    if (!value) return false;
    const normalized = value.split(',')[0].trim();
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

// 定期清理过期记录（每 5 分钟）
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of _loginAttempts) {
        if (now - data.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
            _loginAttempts.delete(ip);
        }
    }
}, 5 * 60 * 1000);

/**
 * 检查登录是否被限速
 * @returns {{ limited: boolean, retryAfterSec: number }}
 */
export function checkLoginRateLimit(ip) {
    if (isLocalLoopbackIp(ip)) return { limited: false, retryAfterSec: 0 };
    const now = Date.now();
    const record = _loginAttempts.get(ip);
    if (!record) return { limited: false, retryAfterSec: 0 };

    // 窗口过期，重置
    if (now - record.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        _loginAttempts.delete(ip);
        return { limited: false, retryAfterSec: 0 };
    }

    if (record.count >= LOGIN_RATE_LIMIT.maxAttempts) {
        const retryAfterSec = Math.ceil((LOGIN_RATE_LIMIT.windowMs - (now - record.firstAttempt)) / 1000);
        return { limited: true, retryAfterSec };
    }

    return { limited: false, retryAfterSec: 0 };
}

/**
 * 记录一次失败的登录尝试
 */
export function recordFailedLogin(ip) {
    if (isLocalLoopbackIp(ip)) return;
    const now = Date.now();
    const record = _loginAttempts.get(ip);
    if (!record || now - record.firstAttempt > LOGIN_RATE_LIMIT.windowMs) {
        _loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        record.count++;
    }
}

/**
 * 登录成功后清除限速记录
 */
export function clearLoginRateLimit(ip) {
    if (isLocalLoopbackIp(ip)) return;
    _loginAttempts.delete(ip);
}

/**
 * bcrypt 配置
 */
const BCRYPT_SALT_ROUNDS = 12;

/**
 * 未设置密码时返回 null，强制用户首次设置密码
 */

/**
 * 检查密码是否为哈希格式（bcrypt 哈希以 $2 开头）
 */
function isHashedPassword(password) {
    return password && password.startsWith('$2');
}

/**
 * 哈希密码
 */
export async function hashPassword(plainPassword) {
    return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
}

/**
 * 读取密码（哈希）
 * 如果数据库中存储的是明文，自动升级为哈希
 */
export async function readPasswordHash() {
    try {
        const storedPassword = await appMetaDao.getValue('admin_password');
        const trimmedPassword = typeof storedPassword === 'string' ? storedPassword.trim() : '';

        if (!trimmedPassword) {
            console.log('[Auth] Admin password not set, requiring initial setup');
            return null;
        }

        // 检查是否已经是哈希格式
        if (isHashedPassword(trimmedPassword)) {
            console.log('[Auth] Loaded hashed password from database');
            return trimmedPassword;
        }

        // 明文密码，自动升级为哈希
        console.log('[Auth] Upgrading plaintext password to bcrypt hash');
        const hashedPassword = await hashPassword(trimmedPassword);
        await appMetaDao.setValue('admin_password', hashedPassword);
        console.log('[Auth] Password upgraded to bcrypt hash successfully');
        return hashedPassword;

    } catch (error) {
        console.error('[Auth] Failed to load admin password:', error.message);
        return null;
    }
}

/**
 * 验证登录凭据（使用 bcrypt 安全比较）
 */
export async function validateCredentials(password) {
    if (!password) {
        return false;
    }

    try {
        const storedHash = await readPasswordHash();
        if (!storedHash) {
            // 密码未设置，拒绝登录
            console.log('[Auth] Password not configured, login rejected');
            return false;
        }
        // bcrypt.compare 内部使用恒定时间比较，防止时序攻击
        const isValid = await bcrypt.compare(password, storedHash);
        console.log('[Auth] Password validation result:', isValid ? 'success' : 'failed');
        return isValid;
    } catch (error) {
        console.error('[Auth] Password validation error:', error.message);
        return false;
    }
}

/**
 * 修改密码
 */
export async function changePassword(newPassword) {
    if (!newPassword || newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters');
    }

    const hashedPassword = await hashPassword(newPassword);
    await appMetaDao.setValue('admin_password', hashedPassword);
    console.log('[Auth] Password changed successfully');
    return true;
}

/**
 * 解析请求体JSON
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            try {
                resolve(body.trim() ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        };
        // 只在 req.readableEnded 真为 true(end 已 emit)时走 read() 路径,
        // 否则会和 flowing 模式的 nextTick flush 竞争导致 body 被 append 两次
        if (req.readableEnded) {
            try {
                let chunk;
                while (typeof req.read === 'function' && (chunk = req.read()) !== null) {
                    body += chunk.toString();
                }
            } catch (_e) { /* ignore */ }
            finish();
            return;
        }
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', finish);
        req.on('error', err => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

/**
 * 生成安全的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成token过期时间
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = 60 * 60 * 1000; // 1小时
    return now + expiry;
}

/**
 * 验证token
 */
export async function verifyToken(token) {
    const tokenInfo = await authTokensDao.getToken(token);
    if (!tokenInfo) {
        return null;
    }

    // 检查是否过期
    const expiryTime = Number(tokenInfo.expiry_time);
    if (Date.now() > expiryTime) {
        await deleteToken(token);
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
 * 保存token
 */
async function saveToken(token, tokenInfo) {
    await authTokensDao.saveToken(token, tokenInfo);
}

/**
 * 删除token
 */
async function deleteToken(token) {
    await authTokensDao.deleteToken(token);
}

/**
 * 清理过期的token
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

/**
 * 检查token验证
 */
export async function checkAuth(req) {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const tokenInfo = await verifyToken(token);
        return tokenInfo !== null;
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token) {
            return false;
        }
        const tokenInfo = await verifyToken(token);
        return tokenInfo !== null;
    } catch (error) {
        return false;
    }
}

/**
 * 处理登录请求
 */
export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Only POST requests are supported' }));
        return true;
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const { limited, retryAfterSec } = checkLoginRateLimit(ip);
    if (limited) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSec) });
        res.end(JSON.stringify({ success: false, message: `Too many login attempts, please retry after ${retryAfterSec}s` }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;

        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Password cannot be empty' }));
            return true;
        }

        const isValid = await validateCredentials(password);

        if (isValid) {
            clearLoginRateLimit(ip);
            const token = generateToken();
            const expiryTime = getExpiryTime();

            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: '1 hour'
            }));
        } else {
            recordFailedLogin(ip);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Incorrect password, please try again'
            }));
        }
    } catch (error) {
        console.error('[Auth] Login processing error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: 'Server error'
        }));
    }
    return true;
}

// 定时清理过期token
setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
