/**
 * OAuth 路由模块
 * 处理 OAuth 认证相关请求
 */

import { sendJson, sendError } from './index.js';
import * as oauthService from '../services/oauth.service.js';

/**
 * OAuth 路由处理器
 */
export async function oauthRouter(method, path, req, res, context) {
    // GET /api/oauth/callback - OAuth 回调
    if (method === 'GET' && path.startsWith('/api/oauth/callback')) {
        return await handleOAuthCallback(req, res);
    }

    return false;
}

/**
 * OAuth 回调处理
 */
async function handleOAuthCallback(req, res) {
    try {
        const result = await oauthService.handleCallback(req);
        sendJson(res, 200, result);
    } catch (error) {
        console.error('[OAuth] Callback error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}
