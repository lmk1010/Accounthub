/**
 * 代理池服务 - 管理代理厂商和节点
 */

import apiClient from './api';

export const proxyPoolService = {
    // 厂商相关
    async getProviders() {
        const res = await apiClient.get('/proxy-providers');
        return res?.data ?? res;
    },

    async createProvider(data) {
        const res = await apiClient.post('/proxy-providers', data);
        return res?.data ?? res;
    },

    async updateProvider(id, data) {
        const res = await apiClient.put(`/proxy-providers?id=${id}`, data);
        return res?.data ?? res;
    },

    async deleteProvider(id) {
        const res = await apiClient.delete(`/proxy-providers?id=${id}`);
        return res?.data ?? res;
    },

    // 节点相关
    async getNodes(providerId = null) {
        const url = providerId
            ? `/proxy-nodes?providerId=${providerId}`
            : '/proxy-nodes';
        const res = await apiClient.get(url);
        return res?.data ?? res;
    },

    async createNode(data) {
        const res = await apiClient.post('/proxy-nodes', data);
        return res?.data ?? res;
    },

    async updateNode(id, data) {
        const res = await apiClient.put(`/proxy-nodes?id=${id}`, data);
        return res?.data ?? res;
    },

    async deleteNode(id) {
        const res = await apiClient.delete(`/proxy-nodes?id=${id}`);
        return res?.data ?? res;
    },

    async testNode(data) {
        const res = await apiClient.post('/proxy-nodes/test', data);
        return res?.data ?? res;
    },

    // 代理池状态
    async getStatus() {
        const res = await apiClient.get('/proxy-pool/status');
        return res?.data ?? res;
    },

    async refresh() {
        const res = await apiClient.post('/proxy-pool/refresh');
        return res?.data ?? res;
    },
};
