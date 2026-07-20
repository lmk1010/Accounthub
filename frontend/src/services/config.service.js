/**
 * 配置服务
 */
import apiClient from './api';

export const configService = {
  // 获取配置
  get: async () => {
    return await apiClient.get('/config');
  },

  // 更新配置
  update: async (configData) => {
    return await apiClient.post('/config', configData);
  },

  // 重新加载配置
  reload: async () => {
    return await apiClient.post('/reload-config');
  },

  // 更新后台登录密码
  updateAdminPassword: async (password) => {
    return await apiClient.post('/admin-password', { password });
  },

  // 获取系统信息
  getSystemInfo: async () => {
    return await apiClient.get('/system/info');
  },

  // 修改管理员密码
  changePassword: async (oldPassword, newPassword) => {
    return await apiClient.post('/auth/change-password', {
      oldPassword,
      newPassword
    });
  },
};
