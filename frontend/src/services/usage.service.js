/**
 * 用量数据服务
 */
import apiClient from './api';

export const usageService = {
  getAll: async (options = {}) => {
    const params = new URLSearchParams();
    if (options.refresh) params.set('refresh', 'true');
    if (options.cacheOnly) params.set('cacheOnly', 'true');
    const query = params.toString();
    return await apiClient.get(`/usage${query ? `?${query}` : ''}`, {
      signal: options.signal
    });
  },

  getByType: async (providerType, options = {}) => {
    const params = new URLSearchParams();
    if (options.refresh) {
      params.set('refresh', 'true');
      // 添加时间戳防止浏览器缓存
      params.set('_t', Date.now().toString());
    }
    if (options.uuid) {
      params.set('uuid', String(options.uuid));
    }
    if (options.poolId !== undefined && options.poolId !== null && options.poolId !== '') {
      params.set('poolId', String(options.poolId));
    }
    if (options.cacheOnly) params.set('cacheOnly', 'true');
    const query = params.toString();
    return await apiClient.get(`/usage/${encodeURIComponent(providerType)}${query ? `?${query}` : ''}`, {
      signal: options.signal
    });
  }
};
