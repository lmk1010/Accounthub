/**
 * Stats service
 */
import apiClient from './api';

const unwrap = (payload) => payload?.data ?? payload;

export const statsService = {
  getPoolStats: async (providerType = 'all') => {
    const payload = await apiClient.get('/stats/pool', {
      params: { providerType },
    });
    return unwrap(payload);
  },

  getErrorHistory: async (params = {}) => {
    const payload = await apiClient.get('/stats/errors', { params });
    return unwrap(payload);
  },

  clearErrorHistory: async () => {
    return await apiClient.delete('/stats/errors');
  },

  getConsumptionStats: async () => {
    const payload = await apiClient.get('/stats/consumption');
    return unwrap(payload);
  },

  updateConsumptionStats: async () => {
    const payload = await apiClient.post('/stats/consumption/update');
    return unwrap(payload);
  },

  resetConsumptionStats: async () => {
    const payload = await apiClient.post('/stats/consumption/reset');
    return unwrap(payload);
  },
};
