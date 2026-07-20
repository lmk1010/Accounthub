import {
    handleModelListRequest,
    handleContentGenerationRequest,
    handleImageGenerationRequest,
    handleImageEditRequest,
    handleVideoContentRequest,
    handleVideoCreateRequest,
    handleVideoRemixRequest,
    handleVideoRetrieveRequest,
    handleXaiVideoNativeRequest,
    API_ACTIONS,
    ENDPOINT_TYPE
} from '../utils/common.js';
import { getProviderPoolManager } from './service-manager.js';

/**
 * Handle API authentication and routing
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} apiService - The API service instance
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @param {string} promptLogFilename - The prompt log filename
 * @returns {Promise<boolean>} - True if the request was handled by API
 */
export async function handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, promptLogFilename) {


    // Route model list requests
    if (method === 'GET') {
        if (path === '/v1/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1beta/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
        const videoContentMatch = path.match(/^\/v1\/videos\/([^/]+)\/content$/);
        if (videoContentMatch) {
            await handleVideoContentRequest(
                req,
                res,
                apiService,
                currentConfig,
                providerPoolManager,
                currentConfig.uuid,
                decodeURIComponent(videoContentMatch[1])
            );
            return true;
        }
        const videoRetrieveMatch = path.match(/^\/v1\/videos\/([^/]+)$/);
        if (videoRetrieveMatch) {
            await handleVideoRetrieveRequest(
                req,
                res,
                apiService,
                currentConfig,
                providerPoolManager,
                currentConfig.uuid,
                decodeURIComponent(videoRetrieveMatch[1])
            );
            return true;
        }
    }

    // Route content generation requests
    if (method === 'POST') {
        if (path === '/v1/chat/completions') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_CHAT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/responses') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/responses/compact') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES_COMPACT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/images/generations') {
            await handleImageGenerationRequest(req, res, apiService, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/images/edits') {
            await handleImageEditRequest(req, res, apiService, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/videos') {
            await handleVideoCreateRequest(
                req,
                res,
                apiService,
                currentConfig,
                promptLogFilename,
                providerPoolManager,
                currentConfig.uuid
            );
            return true;
        }
        const nativeVideoActions = {
            '/v1/videos/generations': 'generate',
            '/v1/videos/edits': 'edit',
            '/v1/videos/extensions': 'extension'
        };
        if (nativeVideoActions[path]) {
            await handleXaiVideoNativeRequest(
                req,
                res,
                apiService,
                currentConfig,
                providerPoolManager,
                currentConfig.uuid,
                nativeVideoActions[path]
            );
            return true;
        }
        const videoRemixMatch = path.match(/^\/v1\/videos\/([^/]+)\/remix$/);
        if (videoRemixMatch) {
            await handleVideoRemixRequest(
                req,
                res,
                apiService,
                currentConfig,
                providerPoolManager,
                currentConfig.uuid,
                decodeURIComponent(videoRemixMatch[1])
            );
            return true;
        }
        const geminiUrlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        if (geminiUrlPattern.test(path)) {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_CONTENT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1/messages') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid);
            return true;
        }
    }

    return false;
}

/**
 * Initialize API management features
 * @param {Map<string, ApiServiceAdapter>|Object} services - 已初始化的服务适配器集合
 *
 * Phase 1 改动:services 现在是 Map(见 providers/adapter.js 的重构)。为了兼容历史上可能
 * 出现的裸对象(兜底分支),这里用 iterateServices 统一取出 [key, adapter] 对。
 *
 * @returns {Function} heartbeat 函数
 */
export function initializeAPIManagement(services) {
    return async function heartbeatAndRefreshToken() {
        const keys = listServiceKeys(services);
        console.log(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()} (${keys.length} adapters)`);
        // 循环遍历所有已初始化的服务适配器,并尝试刷新令牌
        for (const [providerKey, entryOrAdapter] of iterateServices(services)) {
            // Map 里存的是 { adapter, uuid, ... } 结构;裸对象里直接是 adapter
            const serviceAdapter = entryOrAdapter && entryOrAdapter.adapter ? entryOrAdapter.adapter : entryOrAdapter;
            if (!serviceAdapter || typeof serviceAdapter.refreshToken !== 'function') continue;
            try {
                // For pooled providers, refreshToken should be handled by individual instances
                // For single instances, this remains relevant
                await serviceAdapter.refreshToken();
            } catch (error) {
                console.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${error.message}`);
                // 号池中的实例刷新失败交给 poolManager 的 state machine 处理,这里只记录
            }
        }
    };
}

function iterateServices(services) {
    if (!services) return [];
    if (services instanceof Map) return services.entries();
    return Object.entries(services);
}

function listServiceKeys(services) {
    if (!services) return [];
    if (services instanceof Map) return [...services.keys()];
    return Object.keys(services);
}

/**
 * Helper function to read request body
 * @param {http.IncomingMessage} req The HTTP request object.
 * @returns {Promise<string>} The request body as string.
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
