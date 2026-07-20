/**
 * 代理池管理器 - 负责代理节点的轮询、健康检查和请求转发
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as proxyPoolDao from '../dao/proxy-pool-dao.js';

class ProxyPoolManager {
    constructor() {
        this.nodes = [];
        this.currentIndex = 0;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        try {
            await this.refreshNodes();
            this.initialized = true;
            console.log(`[ProxyPool] Initialized with ${this.nodes.length} nodes`);
        } catch (err) {
            console.error('[ProxyPool] Failed to initialize:', err.message);
        }
    }

    async refreshNodes() {
        try {
            this.nodes = await proxyPoolDao.findAllNodes({ enabledOnly: true, healthyOnly: true });
            console.log(`[ProxyPool] Refreshed ${this.nodes.length} healthy nodes`);
        } catch (err) {
            console.error('[ProxyPool] Failed to refresh nodes:', err.message);
        }
    }

    getNextNode(allowedNodeIds = null) {
        const availableNodes = Array.isArray(allowedNodeIds) && allowedNodeIds.length > 0
            ? this.nodes.filter(node => allowedNodeIds.includes(Number(node.id)))
            : this.nodes;

        if (availableNodes.length === 0) return null;
        const node = availableNodes[this.currentIndex % availableNodes.length];
        this.currentIndex = (this.currentIndex + 1) % availableNodes.length;
        return node;
    }

    buildProxyUrl(node) {
        if (!node) return null;
        const { protocol, host, port, username, password } = node;
        let config = node.config;
        if (typeof config === 'string') {
            try { config = JSON.parse(config); } catch { config = {}; }
        }
        config = config || {};

        if (protocol === 'trojan') {
            const pwd = config.password || password || '';
            return `trojan://${pwd}@${host}:${port}`;
        }
        if (username && password) {
            return `${protocol}://${username}:${password}@${host}:${port}`;
        }
        return `${protocol}://${host}:${port}`;
    }

    createAgent(node) {
        if (!node) return null;
        const proxyUrl = this.buildProxyUrl(node);
        const protocol = node.protocol;

        if (protocol === 'socks5' || protocol === 'trojan') {
            return new SocksProxyAgent(proxyUrl);
        }
        return new HttpsProxyAgent(proxyUrl);
    }

    getProxyAgent(options = {}) {
        const allowedNodeIds = Array.isArray(options?.allowedNodeIds)
            ? options.allowedNodeIds.map(item => Number.parseInt(item, 10)).filter(item => Number.isFinite(item) && item > 0)
            : null;
        const node = this.getNextNode(allowedNodeIds);
        if (!node) return { agent: null, node: null };
        return { agent: this.createAgent(node), node };
    }

    async recordUsage(nodeId, success, latency = null, error = null) {
        try {
            await proxyPoolDao.recordNodeUsage(nodeId, success, latency, error);
        } catch (err) {
            console.error('[ProxyPool] Failed to record usage:', err.message);
        }
    }

    hasNodes() {
        return this.nodes.length > 0;
    }

    getNodeCount() {
        return this.nodes.length;
    }
}

const proxyPoolManager = new ProxyPoolManager();
export default proxyPoolManager;
