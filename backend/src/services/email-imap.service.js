/**
 * 邮件服务
 * 使用 Microsoft Graph API 收取 Outlook 邮件
 */

import * as emailDao from '../dao/email-dao.js';

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

/**
 * 刷新 Access Token
 */
export async function refreshAccessToken(emailRecord) {
    const { id, clientId, refreshToken } = emailRecord;

    const params = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/.default'
    });

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error('[Email] Token refresh failed:', errText);
        let errMsg = 'Token刷新失败';
        try {
            const errData = JSON.parse(errText);
            // 显示完整错误描述
            errMsg = errData.error_description || errData.error || errText;
            if (errData.error === 'invalid_grant') {
                await emailDao.setError(id, errMsg);
            }
        } catch {
            errMsg = errText;
        }
        throw new Error(errMsg);
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await emailDao.updateToken(id, data.access_token, expiresAt);

    return data.access_token;
}

/**
 * 获取有效的 Access Token
 */
export async function getValidToken(emailRecord) {
    const { accessToken, tokenExpiresAt } = emailRecord;

    if (accessToken && tokenExpiresAt) {
        const expiresAt = new Date(tokenExpiresAt);
        if (expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
            return accessToken;
        }
    }

    return await refreshAccessToken(emailRecord);
}

/**
 * 获取邮件列表 (使用 Microsoft Graph API)
 */
export async function getMessages(emailRecord, options = {}) {
    const { top = 10 } = options;

    if (emailRecord.authType !== 'oauth2') {
        throw new Error('请先完成OAuth2授权');
    }

    const accessToken = await getValidToken(emailRecord);

    // 使用 Graph API 获取邮件（包含完整正文）
    const url = `${GRAPH_API}/me/messages?$top=${top}&$orderby=receivedDateTime desc&$select=subject,from,toRecipients,receivedDateTime,bodyPreview,body`;

    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });

    if (!res.ok) {
        const errText = await res.text();
        let errMsg = '获取邮件失败';
        try {
            const errData = JSON.parse(errText);
            errMsg = errData.error?.message || errText;
        } catch {
            errMsg = errText;
        }
        throw new Error(errMsg);
    }

    const data = await res.json();

    // 转换为统一格式
    const messages = (data.value || []).map(msg => ({
        subject: msg.subject || '(无主题)',
        from: msg.from?.emailAddress || { address: '', name: '' },
        to: msg.toRecipients?.[0]?.emailAddress?.address || '',
        receivedDateTime: msg.receivedDateTime || '',
        bodyPreview: msg.bodyPreview || '',
        body: msg.body?.content || '',
        bodyContentType: msg.body?.contentType || 'text'
    }));

    return messages;
}

/**
 * 从文本中提取验证码
 */
export function extractVerificationCode(text) {
    if (!text) return null;
    const patterns = [
        /验证码[：:]\s*(\d{4,8})/i,
        /code[：:\s]+(\d{4,8})/i,
        /(\d{6})/,
        /(\d{4})/
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/**
 * 获取最新验证码
 */
export async function getLatestCode(emailRecord, options = {}) {
    const messages = await getMessages(emailRecord, { top: 5, ...options });

    for (const msg of messages) {
        // 同时检查主题和正文预览
        const text = `${msg.subject || ''} ${msg.bodyPreview || ''}`;
        const code = extractVerificationCode(text);
        if (code) {
            return {
                code,
                subject: msg.subject,
                from: msg.from?.address || msg.from,
                receivedAt: msg.receivedDateTime
            };
        }
    }

    return null;
}
