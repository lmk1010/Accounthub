/**
 * OpenAI 代理路由模块
 * 处理 OpenAI 兼容的 API 请求
 */

import {
    ENDPOINT_TYPE,
    handleContentGenerationRequest,
    handleImageEditRequest,
    handleImageGenerationRequest,
    handleModelListRequest,
    handleVideoContentRequest,
    handleVideoCreateRequest,
    handleVideoRemixRequest,
    handleVideoRetrieveRequest,
    handleXaiVideoNativeRequest
} from '../utils/common.js';

/**
 * OpenAI 代理路由处理器
 */
export async function openaiProxyRouter(method, path, req, res, context) {
    const { config, apiService, poolManager, promptLogFilename } = context;

    console.log('[OpenAI Proxy] Method:', method, 'Path:', path);
    console.log('[OpenAI Proxy] Config exists:', !!config);
    console.log('[OpenAI Proxy] ApiService exists:', !!apiService);
    console.log('[OpenAI Proxy] PoolManager exists:', !!poolManager);

    // GET /v1/models - 获取模型列表
    if (method === 'GET' && path === '/v1/models') {
        console.log('[OpenAI Proxy] Calling handleModelListRequest');
        await handleModelListRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.OPENAI_MODEL_LIST,
            config,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/chat/completions - 聊天补全
    if (method === 'POST' && path === '/v1/chat/completions') {
        await handleContentGenerationRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.OPENAI_CHAT,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/responses - 响应生成
    if (method === 'POST' && path === '/v1/responses') {
        await handleContentGenerationRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/responses/compact - 压缩响应生成（OpenAI 压缩端点）
    if (method === 'POST' && path === '/v1/responses/compact') {
        await handleContentGenerationRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.OPENAI_RESPONSES_COMPACT,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/images/generations - 图片生成
    if (method === 'POST' && path === '/v1/images/generations') {
        await handleImageGenerationRequest(
            req,
            res,
            apiService,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/images/edits - 图片编辑
    if (method === 'POST' && path === '/v1/images/edits') {
        await handleImageEditRequest(
            req,
            res,
            apiService,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1/videos - OpenAI 视频任务兼容入口
    if (method === 'POST' && path === '/v1/videos') {
        await handleVideoCreateRequest(
            req,
            res,
            apiService,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    const nativeVideoActions = {
        '/v1/videos/generations': 'generate',
        '/v1/videos/edits': 'edit',
        '/v1/videos/extensions': 'extension'
    };
    if (method === 'POST' && nativeVideoActions[path]) {
        await handleXaiVideoNativeRequest(
            req,
            res,
            apiService,
            config,
            poolManager,
            config.uuid,
            nativeVideoActions[path]
        );
        return true;
    }

    const videoRemixMatch = path.match(/^\/v1\/videos\/([^/]+)\/remix$/);
    if (method === 'POST' && videoRemixMatch) {
        await handleVideoRemixRequest(
            req,
            res,
            apiService,
            config,
            poolManager,
            config.uuid,
            decodeURIComponent(videoRemixMatch[1])
        );
        return true;
    }

    const videoContentMatch = path.match(/^\/v1\/videos\/([^/]+)\/content$/);
    if (method === 'GET' && videoContentMatch) {
        await handleVideoContentRequest(
            req,
            res,
            apiService,
            config,
            poolManager,
            config.uuid,
            decodeURIComponent(videoContentMatch[1])
        );
        return true;
    }

    const videoRetrieveMatch = path.match(/^\/v1\/videos\/([^/]+)$/);
    if (method === 'GET' && videoRetrieveMatch) {
        await handleVideoRetrieveRequest(
            req,
            res,
            apiService,
            config,
            poolManager,
            config.uuid,
            decodeURIComponent(videoRetrieveMatch[1])
        );
        return true;
    }

    return false;
}
