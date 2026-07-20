/**
 * 定价计算器路由
 * 给前端 PricingCalculator 页使用
 */

import { readRequestBody, sendJson, sendError } from './index.js';
import * as dao from '../dao/pricing-analytics-dao.js';

export async function pricingRouter(method, path, req, res, context) {
    if (method === 'GET' && path === '/api/pricing/dashboard') {
        return await handleGetDashboard(req, res);
    }
    if (method === 'GET' && path === '/api/pricing/overview') {
        return await handleGetOverview(req, res);
    }
    if (method === 'POST' && path === '/api/pricing/provider-tier') {
        return await handleSetProviderTier(req, res);
    }
    return false;
}

async function handleGetDashboard(req, res) {
    try {
        const url = new URL(req.url, 'http://localhost');
        const pool = url.searchParams.get('pool') || 'pro';
        const days = Number(url.searchParams.get('days')) || 30;
        const consumptionDays = Number(url.searchParams.get('consumptionDays')) || 7;
        const payload = await dao.getPricingDashboard({ pool, days, consumptionDays });
        sendJson(res, 200, { success: true, data: payload });
        return true;
    } catch (error) {
        console.error('[pricing] dashboard failed:', error);
        sendError(res, 500, error.message || 'Failed to load pricing dashboard');
        return true;
    }
}

async function handleGetOverview(req, res) {
    try {
        const url = new URL(req.url, 'http://localhost');
        const days = Number(url.searchParams.get('days')) || 30;
        const consumptionDays = Number(url.searchParams.get('consumptionDays')) || 7;
        const payload = await dao.getBusinessOverview({ days, consumptionDays });
        sendJson(res, 200, { success: true, data: payload });
        return true;
    } catch (error) {
        console.error('[pricing] overview failed:', error);
        sendError(res, 500, error.message || 'Failed to load business overview');
        return true;
    }
}

async function handleSetProviderTier(req, res) {
    try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const { uuid, tier } = payload;
        if (!uuid || typeof uuid !== 'string') {
            sendError(res, 400, 'uuid is required');
            return true;
        }
        if (tier != null && !['5x', '20x'].includes(String(tier))) {
            sendError(res, 400, 'tier must be one of: 5x, 20x, or null');
            return true;
        }
        const result = await dao.updateProviderTier(uuid, tier);
        sendJson(res, 200, { success: true, data: result });
        return true;
    } catch (error) {
        console.error('[pricing] set-tier failed:', error);
        sendError(res, 500, error.message || 'Failed to update tier');
        return true;
    }
}
