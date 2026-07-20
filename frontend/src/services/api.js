/**
 * API 基础配置
 */

import axios from 'axios';

const normalizeApiBase = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const fallback = '/api';
  if (!raw) return fallback;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '') || fallback;
  const normalized = `/${raw.replace(/^\/+/, '').replace(/\/$/, '')}`;
  return normalized === '/' ? fallback : normalized;
};

// 创建 axios 实例
const apiClient = axios.create({
  baseURL: normalizeApiBase(import.meta.env.VITE_API_BASE),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isLoginRequest = url.includes('/auth/login');
    if (status === 401 && !isLoginRequest) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default apiClient;
