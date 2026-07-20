/**
 * 认证服务
 */

import apiClient from './api';

export const authService = {
  // 登录
  login: async (password) => {
    try {
      const response = await apiClient.post('/auth/login', { password });
      if (response.success && response.token) {
        localStorage.setItem('token', response.token);
      }
      return response;
    } catch (error) {
      const payload = error.response?.data;
      if (payload && typeof payload === 'object') {
        return payload;
      }
      return { success: false, message: '登录失败，请重试' };
    }
  },

  // 登出
  logout: async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
  },

  // 验证 token
  verifyToken: async () => {
    return await apiClient.get('/auth/verify');
  },

  // 检查是否已登录
  isAuthenticated: () => {
    return !!localStorage.getItem('token');
  },
};
