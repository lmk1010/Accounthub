/**
 * 请求追踪服务
 * 调用后端 trace API
 */

import apiClient from './api';

export const traceService = {
  /**
   * 获取阶段统计
   */
  async getStats() {
    return apiClient.get('/trace/stats');
  },

  /**
   * 获取最近的追踪记录
   * @param {number} limit - 返回数量限制
   */
  async getRecentTraces(limit = 100) {
    return apiClient.get('/trace/recent', { params: { limit } });
  },

  /**
   * 获取慢请求
   * @param {number} threshold - 阈值(ms)
   * @param {number} limit - 返回数量限制
   */
  async getSlowTraces(threshold = 10000, limit = 50) {
    return apiClient.get('/trace/slow', { params: { threshold, limit } });
  },

  /**
   * 获取瓶颈分析
   */
  async getBottlenecks() {
    return apiClient.get('/trace/bottlenecks');
  },

  /**
   * 获取当前活跃的追踪
   */
  async getActiveTraces() {
    return apiClient.get('/trace/active');
  },

  /**
   * 重置统计数据
   */
  async resetStats() {
    return apiClient.post('/trace/reset');
  }
};
