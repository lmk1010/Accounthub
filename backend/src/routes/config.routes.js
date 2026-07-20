/**
 * 配置管理路由模块
 * 处理系统配置的读取和更新
 */

import { readRequestBody, sendJson, sendError } from './index.js';
import * as configService from '../services/config.service.js';

/**
 * 配置路由处理器
 */
export async function configRouter(method, path, req, res, context) {
    // GET /api/config - 获取配置
    if (method === 'GET' && path === '/api/config') {
        return await handleGetConfig(req, res, context);
    }

    // POST /api/config - 更新配置
    if (method === 'POST' && path === '/api/config') {
        return await handleUpdateConfig(req, res, context);
    }

    // POST /api/config/admin-password - 更新管理员密码
    if (method === 'POST' && path === '/api/config/admin-password') {
        return await handleUpdateAdminPassword(req, res);
    }

    return false;
}

/**
 * 获取配置
 */
async function handleGetConfig(req, res, context) {
    try {
        const config = await configService.getConfig(context.config);
        sendJson(res, 200, { success: true, config });
    } catch (error) {
        console.error('[Config] Get config error:', error);
        sendError(res, 500, error.message || 'Failed to get config', 'SERVER_ERROR');
    }
    return true;
}

/**
 * 更新配置
 */
async function handleUpdateConfig(req, res, context) {
    try {
        const body = await readRequestBody(req);
        const updates = JSON.parse(body);

        const result = await configService.updateConfig(updates, context.config);

        if (result.success) {
            sendJson(res, 200, result);
        } else {
            sendError(res, 400, result.message || 'Failed to update config', 'UPDATE_FAILED');
        }
    } catch (error) {
        console.error('[Config] Update config error:', error);
        sendError(res, 500, error.message || 'Failed to update config', 'SERVER_ERROR');
    }
    return true;
}

/**
 * 更新管理员密码
 */
async function handleUpdateAdminPassword(req, res) {
    try {
        const body = await readRequestBody(req);
        const { oldPassword, newPassword } = JSON.parse(body);

        if (!oldPassword || !newPassword) {
            sendError(res, 400, 'Old password and new password are required', 'INVALID_INPUT');
            return true;
        }

        const result = await configService.updateAdminPassword(oldPassword, newPassword);

        if (result.success) {
            sendJson(res, 200, result);
        } else {
            sendJson(res, 401, result);
        }
    } catch (error) {
        console.error('[Config] Update admin password error:', error);
        sendError(res, 500, error.message || 'Failed to update password', 'SERVER_ERROR');
    }
    return true;
}
