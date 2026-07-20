/**
 * Logs service
 */
import apiClient from './api';

const unwrap = (payload) => payload?.data ?? payload;

export const logsService = {
  getDays: async () => {
    const payload = await apiClient.get('/logs/days');
    const data = unwrap(payload);
    return {
      days: data?.days || [],
      totalFiles: data?.totalFiles || 0,
      totalSize: data?.totalSize || 0,
      compressedFiles: data?.compressedFiles || 0,
      compressedSize: data?.compressedSize || 0,
    };
  },

  getEntries: async ({ file, page = 1, pageSize = 200, direction = 'desc' }) => {
    const payload = await apiClient.get('/logs/entries', {
      params: {
        file,
        page,
        pageSize,
        direction,
      },
    });
    const data = unwrap(payload);
    return data || {};
  },

  getRecent: async (limit = 200) => {
    const payload = await apiClient.get('/logs/recent', {
      params: { limit },
    });
    const data = unwrap(payload);
    return data?.entries || [];
  },

  getStreamUrl: () => {
    const token = localStorage.getItem('token');
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${window.location.origin}/api/logs/stream${query}`;
  },

  getDownloadUrl: (fileName) => {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({ file: fileName });
    if (token) {
      params.set('token', token);
    }
    return `${window.location.origin}/api/logs/download?${params.toString()}`;
  },

  searchEntries: async ({ file, keyword, limit = 200, context = 3, caseSensitive = false }) => {
    const payload = await apiClient.get('/logs/search', {
      params: { file, keyword, limit, context, caseSensitive },
    });
    const data = unwrap(payload);
    return data || {};
  },

  getDebugConfig: async () => {
    const payload = await apiClient.get('/logs/debug-config');
    return unwrap(payload) || {};
  },

  setDebugConfig: async (config) => {
    const payload = await apiClient.post('/logs/debug-config', config);
    return unwrap(payload) || {};
  },

  deleteLogFile: async (fileName) => {
    const payload = await apiClient.delete('/logs/delete', {
      params: { file: fileName },
    });
    return unwrap(payload) || {};
  },

  gzipLogFile: async (fileName) => {
    const payload = await apiClient.post('/logs/gzip', { file: fileName });
    return unwrap(payload) || {};
  },

  gzipAll: async (keepDays = 1) => {
    const payload = await apiClient.post('/logs/gzip-all', { keepDays });
    return unwrap(payload) || {};
  },

  cleanupLogs: async (days = 7) => {
    const payload = await apiClient.delete('/logs/cleanup', {
      params: { days },
    });
    return unwrap(payload) || {};
  },
};
