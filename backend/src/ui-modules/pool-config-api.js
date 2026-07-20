/**
 * Pool Config API - 号池配置 API
 */

import * as poolConfigDao from '../dao/pool-config-dao.js';
import { getProviderModels } from '../providers/provider-models.js';

/**
 * 获取所有号池配置
 */
export async function handleGetAllPoolConfigs(req, res) {
    try {
        const configs = await poolConfigDao.getAllPoolConfigs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: configs }));
    } catch (error) {
        console.error('[PoolConfigAPI] Error getting all configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}

/**
 * 获取指定提供商类型的号池配置
 */
export async function handleGetPoolConfigsByType(req, res, providerType) {
    try {
        const configs = await poolConfigDao.getPoolConfigsByProviderType(providerType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: configs }));
    } catch (error) {
        console.error('[PoolConfigAPI] Error getting configs by type:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}

/**
 * 更新号池配置
 */
export async function handleUpdatePoolConfig(req, res, id, body) {
    try {
        const success = await poolConfigDao.updatePoolConfig(id, body);
        if (success) {
            const updated = await poolConfigDao.getPoolConfigById(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: updated }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Pool config not found' }));
        }
    } catch (error) {
        console.error('[PoolConfigAPI] Error updating config:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}

/**
 * 获取提供商支持的模型列表
 */
export async function handleGetProviderModels(req, res, providerType) {
    try {
        const models = getProviderModels(providerType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: models }));
    } catch (error) {
        console.error('[PoolConfigAPI] Error getting models:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}
