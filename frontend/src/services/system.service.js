/**
 * System service
 */
import apiClient from './api';

const unwrap = (payload) => payload?.data ?? payload;

export const systemService = {
  getInfo: async () => {
    const payload = await apiClient.get('/system/info');
    return unwrap(payload);
  },

  getMySQLStatus: async () => {
    const payload = await apiClient.get('/system/mysql-status');
    return unwrap(payload);
  },

  // 获取集群状态
  getClusterStatus: async () => {
    const payload = await apiClient.get('/system/cluster');
    return unwrap(payload);
  },
};

/**
 * Monitor service - 性能监控
 */
export const monitorService = {
  // 获取综合监控数据
  getOverview: async () => {
    const payload = await apiClient.get('/monitor/overview');
    return unwrap(payload);
  },

  // 获取号池健康状态
  getPoolHealth: async () => {
    const payload = await apiClient.get('/monitor/pool-health');
    return unwrap(payload);
  },

  // 获取 Redis 详细状态
  getRedisStatus: async () => {
    const payload = await apiClient.get('/monitor/redis');
    return unwrap(payload);
  },

  // 获取 MySQL 详细状态
  getMySQLStatus: async () => {
    const payload = await apiClient.get('/monitor/mysql');
    return unwrap(payload);
  },

  // 获取磁盘占用
  getDiskUsage: async () => {
    const payload = await apiClient.get('/monitor/disk');
    return unwrap(payload);
  },

  // 获取表大小
  getTableSizes: async () => {
    const payload = await apiClient.get('/monitor/mysql/tables');
    return unwrap(payload);
  },

  // 获取慢查询
  getSlowQueries: async () => {
    const payload = await apiClient.get('/monitor/mysql/slow-queries');
    return unwrap(payload);
  },

  // 获取集群状态
  getClusterStatus: async () => {
    const payload = await apiClient.get('/system/cluster');
    return unwrap(payload);
  },

  // 清理请求日志
  cleanupRequestLogs: async (mode, date) => {
    const payload = await apiClient.post('/monitor/cleanup-request-logs', { mode, date });
    return unwrap(payload);
  },

  // 获取 shard 分布图（哪个 provider 归属哪个 worker）
  getShardMap: async () => {
    const payload = await apiClient.get('/providers/shard-map');
    return unwrap(payload);
  },
};
