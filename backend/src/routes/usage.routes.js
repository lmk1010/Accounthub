/**
 * 用量路由模块
 * 处理 /api/usage 相关接口
 */

import * as usageApi from '../ui-modules/usage-api.js';

export async function usageRouter(method, path, req, res, context) {
  if (method === 'GET' && path === '/api/usage') {
    return await usageApi.handleGetUsage(req, res, context.config, context.poolManager);
  }

  const usageProviderMatch = path.match(/^\/api\/usage\/([^/]+)$/);
  if (method === 'GET' && usageProviderMatch) {
    const providerType = decodeURIComponent(usageProviderMatch[1]);
    return await usageApi.handleGetProviderUsage(req, res, context.config, context.poolManager, providerType);
  }

  return false;
}
