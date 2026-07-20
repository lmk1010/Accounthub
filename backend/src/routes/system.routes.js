/**
 * 系统路由模块
 * 处理系统信息、健康检查等
 */

import { sendJson, sendError } from './index.js';
import * as systemService from '../services/system.service.js';
import { getMySQLStatus } from '../config/database.js';
import http from 'http';

/**
 * 系统路由处理器
 */
export async function systemRouter(method, path, req, res, context) {
    // GET /api/system/health - 健康检查
    if (method === 'GET' && path === '/api/system/health') {
        return await handleHealthCheck(req, res);
    }

    // GET /api/system/info - 获取系统信息
    if (method === 'GET' && path === '/api/system/info') {
        return await handleGetSystemInfo(req, res);
    }

    // GET /api/system/mysql-status - 获取 MySQL 状态
    if (method === 'GET' && path === '/api/system/mysql-status') {
        return await handleGetMySQLStatus(req, res);
    }

    // GET /api/system/cluster - 获取集群状态
    if (method === 'GET' && path === '/api/system/cluster') {
        return await handleGetClusterStatus(req, res);
    }

    return false;
}

/**
 * 健康检查
 */
async function handleHealthCheck(req, res) {
    try {
        const health = await systemService.getHealthStatus();
        sendJson(res, 200, health);
    } catch (error) {
        console.error('[System] Health check error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取系统信息
 */
async function handleGetSystemInfo(req, res) {
    try {
        const info = await systemService.getSystemInfo();
        sendJson(res, 200, { success: true, data: info });
    } catch (error) {
        console.error('[System] Get system info error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取 MySQL 状态
 */
async function handleGetMySQLStatus(req, res) {
    try {
        const status = await getMySQLStatus();
        sendJson(res, 200, { success: true, data: status });
    } catch (error) {
        console.error('[System] Get MySQL status error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取集群状态（从 Master 进程获取）
 */
async function handleGetClusterStatus(req, res) {
    const masterPort = process.env.MASTER_PORT || 3100;

    try {
        const data = await new Promise((resolve, reject) => {
            const request = http.get(`http://127.0.0.1:${masterPort}/master/status`, (response) => {
                let body = '';
                response.on('data', chunk => body += chunk);
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('Invalid JSON from master'));
                    }
                });
            });

            request.on('error', (err) => {
                reject(err);
            });

            request.setTimeout(5000, () => {
                request.destroy();
                reject(new Error('Master request timeout'));
            });
        });

        sendJson(res, 200, { success: true, data });
    } catch (error) {
        // Master 不可用时返回单进程模式信息
        const memory = process.memoryUsage();
        const fallback = {
            mode: 'standalone',
            message: 'Running in standalone mode (master not available)',
            process: {
                pid: process.pid,
                uptime: process.uptime(),
                memoryMB: Math.round(memory.heapUsed / 1024 / 1024),
                memory
            }
        };
        sendJson(res, 200, { success: true, data: fallback });
    }
    return true;
}
