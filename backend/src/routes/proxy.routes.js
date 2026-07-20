/**
 * API 代理路由模块
 * 处理 OpenAI、Gemini、Claude 等 API 的代理请求
 */

import { openaiProxyRouter } from './openai-proxy.routes.js';
import { geminiProxyRouter } from './gemini-proxy.routes.js';
import { claudeProxyRouter } from './claude-proxy.routes.js';
import { resolveRouteApiService } from './route-service.js';
import { getApiService } from '../services/service-manager.js';
import { PROMPT_LOG_FILENAME } from '../core/config-manager.js';

/**
 * API 代理路由处理器
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {Object} context - 上下文对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handleProxyRoutes(method, path, req, res, context) {
    // 调试日志
    console.log('[ProxyRoutes] Config:', context.config ? 'exists' : 'missing');
    console.log('[ProxyRoutes] MODEL_PROVIDER:', context.config?.MODEL_PROVIDER);

    const apiService = await resolveRouteApiService(context, getApiService);

    // 完善上下文
    const fullContext = {
        ...context,
        apiService,
        promptLogFilename: PROMPT_LOG_FILENAME
    };

    // OpenAI 代理路由 (/v1/*)
    if (path.startsWith('/v1/')) {
        const handled = await openaiProxyRouter(method, path, req, res, fullContext);
        if (handled) return true;
    }

    // Gemini 代理路由 (/v1beta/*)
    if (path.startsWith('/v1beta/')) {
        const handled = await geminiProxyRouter(method, path, req, res, fullContext);
        if (handled) return true;
    }

    // Claude 代理路由 (/v1/messages)
    if (path === '/v1/messages') {
        const handled = await claudeProxyRouter(method, path, req, res, fullContext);
        if (handled) return true;
    }

    return false;
}
