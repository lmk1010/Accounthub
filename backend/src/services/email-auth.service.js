/**
 * Outlook OAuth2 Device Code Flow 授权服务
 */

import * as emailDao from '../dao/email-dao.js';

// Thunderbird 公共客户端ID（支持个人账户）
const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';

/**
 * 开始 Device Code Flow 授权
 * 将授权信息存到数据库
 */
export async function startDeviceAuth(emailId) {
    const res = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPE
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`获取设备码失败: ${err}`);
    }

    const data = await res.json();

    // 保存授权信息到数据库（用 last_error 字段临时存储 device_code）
    const authData = JSON.stringify({
        deviceCode: data.device_code,
        userCode: data.user_code,
        expiresAt: Date.now() + data.expires_in * 1000
    });

    await emailDao.update(emailId, {
        last_error: authData,
        status: 'disabled'  // 标记为授权中
    });

    console.log('[Auth] Started auth for email:', emailId, 'userCode:', data.user_code);

    return {
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in,
        message: data.message
    };
}

/**
 * 轮询检查授权状态
 */
export async function pollAuthStatus(emailId) {
    const email = await emailDao.findById(emailId);
    if (!email || !email.lastError) {
        return { status: 'not_found', message: '未找到授权请求' };
    }

    let auth;
    try {
        auth = JSON.parse(email.lastError);
    } catch {
        return { status: 'not_found', message: '授权数据无效' };
    }

    if (!auth.deviceCode) {
        return { status: 'not_found', message: '未找到授权请求' };
    }

    if (Date.now() > auth.expiresAt) {
        await emailDao.update(emailId, { last_error: null });
        return { status: 'expired', message: '授权已过期，请重新发起' };
    }

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: auth.deviceCode
        })
    });

    const data = await res.json();

    if (data.error === 'authorization_pending') {
        return { status: 'pending', message: '等待用户授权...' };
    }

    if (data.error === 'slow_down') {
        return { status: 'pending', message: '请稍候...' };
    }

    if (data.error) {
        await emailDao.update(emailId, { last_error: null });
        return { status: 'error', message: data.error_description || data.error };
    }

    // 授权成功，保存token
    console.log('[Auth] Success! Saving token for:', emailId);

    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await emailDao.update(emailId, {
        auth_type: 'oauth2',
        client_id: CLIENT_ID,
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        token_expires_at: expiresAt,
        status: 'active',
        last_error: null
    });

    return { status: 'success', message: '授权成功！' };
}
