/**
 * API 路由主入口
 * 统一管理所有 API 路由
 */

import { authRouter } from './auth.routes.js';
import { configRouter } from './config.routes.js';
import { providerRouter } from './provider.routes.js';
import { statsRouter } from './stats.routes.js';
import { systemRouter } from './system.routes.js';
import { oauthRouter } from './oauth.routes.js';
import { logsRouter } from './logs.routes.js';
import { emailRouter } from './email.routes.js';
import { monitorRouter } from './monitor.routes.js';
import { usageRouter } from './usage.routes.js';

/**
 * 路由匹配器
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {Object} context - 上下文对象（包含 config, poolManager 等）
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handleApiRoutes(method, path, req, res, context) {
    // 路由表
    const routers = [
        { prefix: '/api/auth', router: authRouter },
        { prefix: '/api/config', router: configRouter },
        { prefix: '/api/request-logs', router: providerRouter }, // request-logs 路由
        { prefix: '/api/providers', router: providerRouter },
        { prefix: '/api/channel-dispatch-logs', router: providerRouter },
        { prefix: '/api/stats', router: statsRouter },
        { prefix: '/api/system', router: systemRouter },
        { prefix: '/api/logs', router: logsRouter },
        { prefix: '/api/oauth', router: oauthRouter },
        { prefix: '/api/usage', router: usageRouter },
        { prefix: '/api/emails', router: emailRouter },
        { prefix: '/api/monitor', router: monitorRouter },
        { prefix: '/api/windsurf', router: providerRouter },
        { prefix: '/api/xai', router: providerRouter }
    ];

    // 匹配路由
    for (const { prefix, router } of routers) {
        if (path.startsWith(prefix) || path === prefix.replace(/\/$/, '')) {
            const handled = await router(method, path, req, res, context);
            if (handled) {
                return true;
            }
        }
    }

    return false;
}

/**
 * 辅助函数：读取请求体
 */
export function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(body);
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
 * 辅助函数：发送 JSON 响应
 */
export function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

/**
 * 辅助函数：发送错误响应
 */
export function sendError(res, statusCode, message, code = 'ERROR') {
    sendJson(res, statusCode, {
        error: {
            message,
            code
        }
    });
}
