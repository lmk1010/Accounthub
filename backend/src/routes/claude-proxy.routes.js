/**
 * Claude 代理路由模块
 * 处理 Claude API 请求
 */

import { handleContentGenerationRequest, ENDPOINT_TYPE } from '../utils/common.js';

/**
 * Claude 代理路由处理器
 */
export async function claudeProxyRouter(method, path, req, res, context) {
    const { config, apiService, poolManager, promptLogFilename } = context;

    // POST /v1/messages - Claude 消息生成
    if (method === 'POST' && path === '/v1/messages') {
        await handleContentGenerationRequest(
            req,
            res,
            apiService,
            ENDPOINT_TYPE.CLAUDE_MESSAGE,
            config,
            promptLogFilename,
            poolManager,
            config.uuid
        );
        return true;
    }

    return false;
}
