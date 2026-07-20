/**
 * 定价计算器数据服务
 */
import apiClient from './api';

export const pricingService = {
  getDashboard: (params = {}) => apiClient.get('/pricing/dashboard', { params }),
  getOverview: (params = {}) => apiClient.get('/pricing/overview', { params }),
  setProviderTier: (uuid, tier) =>
    apiClient.post('/pricing/provider-tier', { uuid, tier }),
};

export default pricingService;
