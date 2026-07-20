/**
 * 代理池 API - 管理代理厂商和节点
 */

import { getRequestBody } from '../utils/common.js';
import * as proxyPoolDao from '../dao/proxy-pool-dao.js';
import proxyPoolManager from '../services/proxy-pool-manager.js';
import axios from 'axios';
import { parseProxyUrl } from '../utils/proxy-utils.js';

function normalizeNodeFromBody(body = {}) {
    if (!body || typeof body !== 'object') {
        throw new Error('Invalid proxy payload');
    }

    let protocol = String(body.protocol || 'http').toLowerCase();
    let host = body.host ? String(body.host).trim() : '';
    let port = body.port !== undefined ? Number.parseInt(body.port, 10) : null;
    let username = body.username ? String(body.username).trim() : null;
    let password = body.password ? String(body.password) : null;

    const rawUrl = body.url ? String(body.url).trim() : '';
    if (rawUrl) {
        if (rawUrl.includes('://')) {
            const parsed = new URL(rawUrl);
            protocol = parsed.protocol.replace(':', '').toLowerCase();
            host = parsed.hostname;
            port = Number.parseInt(parsed.port, 10) || (protocol === 'https' ? 443 : 80);
            username = parsed.username ? decodeURIComponent(parsed.username) : username;
            password = parsed.password ? decodeURIComponent(parsed.password) : password;
        } else {
            const parts = rawUrl.split(':');
            if (parts.length >= 4) {
                host = parts[0];
                port = Number.parseInt(parts[1], 10);
                username = parts[2] || null;
                password = parts.slice(3).join(':') || null;
            } else if (parts.length === 2) {
                host = parts[0];
                port = Number.parseInt(parts[1], 10);
            } else {
                throw new Error('代理地址格式无效，支持 host:port 或 host:port:user:pass');
            }
        }
    }

    if (!host || !Number.isFinite(port) || port <= 0) {
        throw new Error('代理地址格式无效，请检查 host 和 port');
    }

    return {
        protocol,
        host,
        port,
        username,
        password
    };
}

function buildProxyUrlFromNode(node) {
    const protocol = String(node.protocol || 'http').toLowerCase();
    const host = String(node.host || '').trim();
    const port = Number.parseInt(node.port, 10);
    if (!host || !Number.isFinite(port)) {
        return null;
    }

    if (node.username && node.password !== null && node.password !== undefined) {
        const user = encodeURIComponent(String(node.username));
        const pass = encodeURIComponent(String(node.password));
        return `${protocol}://${user}:${pass}@${host}:${port}`;
    }

    return `${protocol}://${host}:${port}`;
}

function extractErrorMessage(error) {
    if (!error) return 'unknown error';
    const status = error.response?.status;
    const detail = error.response?.data?.message || error.response?.statusText || error.message;
    return status ? `HTTP ${status}: ${detail}` : String(detail || 'unknown error');
}

// 厂商相关API
export async function handleGetProxyProviders(req, res) {
    try {
        const providers = await proxyPoolDao.findAllProviders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providers }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleCreateProxyProvider(req, res) {
    try {
        const body = await getRequestBody(req);
        const id = await proxyPoolDao.createProvider(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleUpdateProxyProvider(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const id = url.searchParams.get('id');
        const body = await getRequestBody(req);
        await proxyPoolDao.updateProvider(id, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleDeleteProxyProvider(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const id = url.searchParams.get('id');
        await proxyPoolDao.deleteProvider(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

// 节点相关API
export async function handleGetProxyNodes(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const rawProviderId = url.searchParams.get('providerId');
        const providerId = rawProviderId === null || rawProviderId === '' ? undefined : Number.parseInt(rawProviderId, 10);
        const nodes = await proxyPoolDao.findAllNodes({ providerId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleCreateProxyNode(req, res) {
    try {
        const body = await getRequestBody(req);
        const parsedNode = normalizeNodeFromBody(body);
        const id = await proxyPoolDao.createNode({
            ...body,
            ...parsedNode
        });
        await proxyPoolManager.refreshNodes();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleUpdateProxyNode(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const id = url.searchParams.get('id');
        const body = await getRequestBody(req);
        const updates = { ...body };
        if (body.url || body.host || body.port || body.username || body.password || body.protocol) {
            Object.assign(updates, normalizeNodeFromBody(body));
        }
        await proxyPoolDao.updateNode(id, updates);
        await proxyPoolManager.refreshNodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

export async function handleTestProxyNode(req, res) {
    try {
        const body = await getRequestBody(req);
        let node = null;
        let nodeId = null;

        if (body?.id !== undefined && body?.id !== null && String(body.id).trim() !== '') {
            nodeId = Number.parseInt(body.id, 10);
            node = await proxyPoolDao.findNodeById(nodeId);
            if (!node) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: '代理节点不存在' }));
                return true;
            }
        } else {
            node = normalizeNodeFromBody(body);
        }

        const proxyUrl = buildProxyUrlFromNode(node);
        const proxyConfig = parseProxyUrl(proxyUrl || '');
        if (!proxyConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '代理地址或协议无效' }));
            return true;
        }

        const startedAt = Date.now();
        try {
            const response = await axios.get('https://api.ipify.org?format=json', {
                timeout: 10000,
                proxy: false,
                httpAgent: proxyConfig.httpAgent,
                httpsAgent: proxyConfig.httpsAgent,
                headers: {
                    'User-Agent': 'AccountHub-Proxy-Tester/1.0'
                }
            });
            const latency = Date.now() - startedAt;

            if (nodeId) {
                await proxyPoolDao.recordNodeUsage(nodeId, true, latency, null);
                await proxyPoolManager.refreshNodes();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                latency,
                exitIp: response?.data?.ip || null,
                message: '代理联通测试成功'
            }));
            return true;
        } catch (error) {
            const message = extractErrorMessage(error);
            const latency = Date.now() - startedAt;

            if (nodeId) {
                await proxyPoolDao.recordNodeUsage(nodeId, false, latency, message);
                await proxyPoolManager.refreshNodes();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                latency,
                message
            }));
            return true;
        }
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
    }
    return true;
}

export async function handleDeleteProxyNode(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const id = url.searchParams.get('id');
        await proxyPoolDao.deleteNode(id);
        await proxyPoolManager.refreshNodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

// 代理池状态
export async function handleGetProxyPoolStatus(req, res) {
    try {
        const nodeCount = proxyPoolManager.getNodeCount();
        const hasNodes = proxyPoolManager.hasNodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodeCount, hasNodes, initialized: proxyPoolManager.initialized }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}

// 刷新代理池
export async function handleRefreshProxyPool(req, res) {
    try {
        await proxyPoolManager.refreshNodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, nodeCount: proxyPoolManager.getNodeCount() }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return true;
}
