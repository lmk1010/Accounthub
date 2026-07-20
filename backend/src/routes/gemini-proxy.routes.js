/**
 * Gemini 代理路由模块
 * 处理 Gemini API 请求
 */

import { handleModelListRequest, handleContentGenerationRequest, ENDPOINT_TYPE, API_ACTIONS } from '../utils/common.js';

/**
 * Gemini 代理路由处理器
 */
export async function geminiProxyRouter(method, path, req, res, context) {
    const { config, apiService, poolManager, promptLogFilename } = context;

    // GET /v1beta/models - 获取模型列表
    if (method === 'GET' && path === '/v1beta/models') {
        await handleModelListRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.GEMINI_MODEL_LIST,
            config,
            poolManager,
            config.uuid
        );
        return true;
    }

    // POST /v1beta/models/{model}:generateContent - 内容生成
    const geminiUrlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
    if (method === 'POST' && geminiUrlPattern.test(path)) {
        await handleContentGenerationRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    return false;
}
