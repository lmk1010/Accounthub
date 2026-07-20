/**
 * 提供商管理路由模块
 * 处理提供商池的增删改查
 */

import { readRequestBody, sendJson, sendError } from './index.js';
import * as providerService from '../services/provider.service.js';
import { windsurfEmailLogin } from '../providers/windsurf/windsurf-service.js';
import { getCascadeModelConfigs } from '../providers/windsurf/windsurf-api.js';
import { resolveModelByUid } from '../providers/windsurf/windsurf-models.js';
import * as providerDao from '../dao/provider-dao.js';
import * as requestLogsDao from '../dao/request-logs-dao.js';
import * as providerErrorLogsDao from '../dao/provider-error-logs-dao.js';
import * as providerStatusLogsDao from '../dao/provider-status-logs-dao.js';
import * as channelDispatchLogsDao from '../dao/channel-dispatch-logs-dao.js';
import { handleGetShardMap } from '../ui-modules/provider-api.js';
import { getServiceAdapter, peekServiceAdapter } from '../providers/adapter.js';

/**
 * 提供商路由处理器
 */
export async function providerRouter(method, path, req, res, context) {
    // GET /api/request-logs/:id/error-detail - 获取错误详情（大字段）
    const requestLogErrorMatch = path.match(/^\/api\/request-logs\/(\d+)\/error-detail$/);
    if (method === 'GET' && requestLogErrorMatch) {
        const id = requestLogErrorMatch[1];
        return await handleGetRequestLogErrorDetail(req, res, id);
    }

    // GET /api/request-logs/:id - 获取单条日志详情
    const requestLogDetailMatch = path.match(/^\/api\/request-logs\/(\d+)$/);
    if (method === 'GET' && requestLogDetailMatch) {
        const id = requestLogDetailMatch[1];
        return await handleGetRequestLogDetail(req, res, id);
    }

    const providerRequestLogsMatch = path.match(/^\/api\/providers\/([^/]+)\/request-logs$/);
    if (providerRequestLogsMatch) {
        const uuid = providerRequestLogsMatch[1];
        if (method === 'GET') {
            return await handleGetProviderRequestLogs(req, res, uuid);
        }
        if (method === 'DELETE') {
            return await handleClearProviderRequestLogs(req, res, uuid);
        }
    }

    const providerErrorLogsMatch = path.match(/^\/api\/providers\/([^/]+)\/error-logs$/);
    if (method === 'GET' && providerErrorLogsMatch) {
        const uuid = providerErrorLogsMatch[1];
        return await handleGetProviderErrorLogs(req, res, uuid);
    }

    const providerStatusLogsMatch = path.match(/^\/api\/providers\/([^/]+)\/status-logs$/);
    if (method === 'GET' && providerStatusLogsMatch) {
        const uuid = providerStatusLogsMatch[1];
        return await handleGetProviderStatusLogs(req, res, uuid);
    }

    // GET /api/providers/shard-map - 获取 shard 分布图
    if (method === 'GET' && path === '/api/providers/shard-map') {
        return await handleGetShardMap(req, res);
    }

    // GET /api/providers/summary - 获取提供商摘要
    if (method === 'GET' && path === '/api/providers/summary') {
        return await handleGetProvidersSummary(req, res, context);
    }

    // GET /api/providers - 获取所有提供商
    if (method === 'GET' && path === '/api/providers') {
        return await handleGetProviders(req, res, context);
    }

    // GET /api/providers/:type - 获取指定类型的提供商
    if (method === 'GET' && path.startsWith('/api/providers/')) {
        const type = path.split('/')[3];
        if (type && type !== 'summary') {
            return await handleGetProvidersByType(req, res, context, type);
        }
    }

    // POST /api/providers - 添加提供商
    if (method === 'POST' && path === '/api/providers') {
        return await handleAddProvider(req, res, context);
    }

    // PUT /api/providers/:uuid - 更新提供商
    if (method === 'PUT') {
        const updateMatch = path.match(/^\/api\/providers\/([^/]+)$/);
        if (updateMatch) {
            return await handleUpdateProvider(req, res, context, updateMatch[1]);
        }
    }

    // DELETE /api/providers/:uuid - 删除提供商
    if (method === 'DELETE') {
        const deleteMatch = path.match(/^\/api\/providers\/([^/]+)$/);
        if (deleteMatch) {
            return await handleDeleteProvider(req, res, context, deleteMatch[1]);
        }
    }

    // POST /api/windsurf/email-login - Windsurf 邮箱密码登录获取 apiKey
    if (method === 'POST' && path === '/api/windsurf/email-login') {
        return await handleWindsurfEmailLogin(req, res);
    }

    // POST /api/windsurf/email-import - 邮箱密码登录并直接添加为提供商
    if (method === 'POST' && path === '/api/windsurf/email-import') {
        return await handleWindsurfEmailImport(req, res, context);
    }

    // POST /api/windsurf/refresh-models - 刷新指定账号的模型列表并持久化
    if (method === 'POST' && path === '/api/windsurf/refresh-models') {
        return await handleWindsurfRefreshModels(req, res, context);
    }

    // GET /api/windsurf/models/:uuid - 读取已缓存的模型列表
    const windsurfModelsMatch = path.match(/^\/api\/windsurf\/models\/([^/]+)$/);
    if (method === 'GET' && windsurfModelsMatch) {
        return await handleWindsurfGetModels(req, res, windsurfModelsMatch[1]);
    }

    // POST /api/xai/refresh-models - 刷新指定 Grok 账号的模型列表并持久化
    if (method === 'POST' && path === '/api/xai/refresh-models') {
        return await handleXaiRefreshModels(req, res, context);
    }

    // GET /api/xai/models/:uuid - 读取已缓存的 Grok 模型列表
    const xaiModelsMatch = path.match(/^\/api\/xai\/models\/([^/]+)$/);
    if (method === 'GET' && xaiModelsMatch) {
        return await handleXaiGetModels(req, res, xaiModelsMatch[1]);
    }

    // GET/DELETE /api/channel-dispatch-logs/:providerType - 渠道调度日志
    const channelDispatchLogsMatch = path.match(/^\/api\/channel-dispatch-logs\/([^/]+)$/);
    if (channelDispatchLogsMatch) {
        const providerType = decodeURIComponent(channelDispatchLogsMatch[1]);
        if (method === 'GET') {
            return await handleGetChannelDispatchLogs(req, res, providerType);
        }
        if (method === 'DELETE') {
            return await handleClearChannelDispatchLogs(req, res, providerType);
        }
    }

    return false;
}

async function handleGetRequestLogErrorDetail(req, res, id) {
    try {
        const detail = await requestLogsDao.findErrorDetailById(id);
        if (!detail) {
            sendError(res, 404, 'Request log not found', 'NOT_FOUND');
            return true;
        }
        sendJson(res, 200, { success: true, data: detail });
    } catch (error) {
        console.error('[Provider] Get request log error detail error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleGetRequestLogDetail(req, res, id) {
    try {
        const record = await requestLogsDao.findById(id);
        if (!record) {
            sendError(res, 404, 'Request log not found', 'NOT_FOUND');
            return true;
        }
        sendJson(res, 200, { success: true, data: record });
    } catch (error) {
        console.error('[Provider] Get request log detail error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleGetProviderRequestLogs(req, res, uuid) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const isSuccessParam = url.searchParams.get('isSuccess');
        const startDate = url.searchParams.get('startDate') || undefined;
        const endDate = url.searchParams.get('endDate') || undefined;

        const options = {
            page: Number.isFinite(pageParam) ? pageParam : 1,
            pageSize: Number.isFinite(pageSizeParam) ? pageSizeParam : 20,
            isSuccess: isSuccessParam !== null ? isSuccessParam === 'true' : undefined,
            startDate,
            endDate
        };

        const [records, total, summary] = await Promise.all([
            requestLogsDao.findByProviderUuid(uuid, options),
            requestLogsDao.countByProviderUuid(uuid, options),
            requestLogsDao.getProviderSummary(uuid)
        ]);

        sendJson(res, 200, {
            success: true,
            data: records,
            total,
            page: options.page,
            pageSize: options.pageSize,
            totalPages: Math.ceil(total / options.pageSize),
            summary
        });
    } catch (error) {
        console.error('[Provider] Get provider request logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleClearProviderRequestLogs(req, res, uuid) {
    try {
        const deleted = await requestLogsDao.clearByProviderUuid(uuid);
        sendJson(res, 200, { success: true, deleted });
    } catch (error) {
        console.error('[Provider] Clear provider request logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleGetProviderErrorLogs(req, res, uuid) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const page = Number.isFinite(pageParam) ? pageParam : 1;
        const pageSize = Number.isFinite(pageSizeParam) ? pageSizeParam : 10;

        const [logs, total] = await Promise.all([
            providerErrorLogsDao.findByUuid(uuid, { page, pageSize }),
            providerErrorLogsDao.countByUuid(uuid)
        ]);

        sendJson(res, 200, {
            success: true,
            data: logs,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize)
        });
    } catch (error) {
        console.error('[Provider] Get provider error logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

async function handleGetProviderStatusLogs(req, res, uuid) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const page = Number.isFinite(pageParam) ? pageParam : 1;
        const pageSize = Number.isFinite(pageSizeParam) ? pageSizeParam : 10;

        const [logs, total] = await Promise.all([
            providerStatusLogsDao.findByUuid(uuid, { page, pageSize }),
            providerStatusLogsDao.countByUuid(uuid)
        ]);

        sendJson(res, 200, {
            success: true,
            data: logs,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize)
        });
    } catch (error) {
        console.error('[Provider] Get provider status logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取提供商摘要
 */
async function handleGetProvidersSummary(req, res, context) {
    try {
        const summary = await providerService.getProvidersSummary(context.poolManager);
        sendJson(res, 200, { success: true, data: summary });
    } catch (error) {
        console.error('[Provider] Get providers summary error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取所有提供商
 */
async function handleGetProviders(req, res, context) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const filter = url.searchParams.get('filter') || 'all';

        const options = {
            filter,
            page: Number.isFinite(pageParam) ? pageParam : null,
            pageSize: Number.isFinite(pageSizeParam) ? pageSizeParam : null
        };

        const providers = await providerService.getAllProviders(context.poolManager, options);
        sendJson(res, 200, { success: true, data: providers });
    } catch (error) {
        console.error('[Provider] Get providers error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取指定类型的提供商
 */
async function handleGetProvidersByType(req, res, context, type) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const filter = url.searchParams.get('filter') || 'all';
        const poolIdParam = url.searchParams.get('poolId');

        const options = {
            filter,
            page: Number.isFinite(pageParam) ? pageParam : null,
            pageSize: Number.isFinite(pageSizeParam) ? pageSizeParam : null,
            poolId: poolIdParam !== null ? poolIdParam : null
        };

        const providers = await providerService.getProvidersByType(type, context.poolManager, options);
        sendJson(res, 200, { success: true, data: providers });
    } catch (error) {
        console.error('[Provider] Get providers by type error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 添加提供商
 */
async function handleAddProvider(req, res, context) {
    try {
        const body = await readRequestBody(req);
        const providerData = JSON.parse(body);

        const result = await providerService.addProvider(providerData, context.poolManager);

        if (result.success) {
            sendJson(res, 201, result);
        } else {
            sendError(res, 400, result.message, 'ADD_FAILED');
        }
    } catch (error) {
        console.error('[Provider] Add provider error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 更新提供商
 */
async function handleUpdateProvider(req, res, context, uuid) {
    try {
        const body = await readRequestBody(req);
        const updates = JSON.parse(body);

        const result = await providerService.updateProvider(uuid, updates, context.poolManager);

        if (result.success) {
            sendJson(res, 200, result);
        } else {
            sendError(res, 400, result.message, 'UPDATE_FAILED');
        }
    } catch (error) {
        console.error('[Provider] Update provider error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 删除提供商
 */
async function handleDeleteProvider(req, res, context, uuid) {
    try {
        const result = await providerService.deleteProvider(uuid, context.poolManager);

        if (result.success) {
            sendJson(res, 200, result);
        } else {
            sendError(res, 400, result.message, 'DELETE_FAILED');
        }
    } catch (error) {
        console.error('[Provider] Delete provider error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 获取渠道调度日志
 */
async function handleGetChannelDispatchLogs(req, res, providerType) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pageParam = parseInt(url.searchParams.get('page'), 10);
        const pageSizeParam = parseInt(url.searchParams.get('pageSize'), 10);
        const errorType = url.searchParams.get('errorType') || undefined;

        const result = await channelDispatchLogsDao.findByProviderType(providerType, {
            page: Number.isFinite(pageParam) ? pageParam : 1,
            pageSize: Number.isFinite(pageSizeParam) ? pageSizeParam : 20,
            errorType
        });

        sendJson(res, 200, {
            success: true,
            ...result
        });
    } catch (error) {
        console.error('[Provider] Get channel dispatch logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * 清除渠道调度日志
 */
async function handleClearChannelDispatchLogs(req, res, providerType) {
    try {
        const deleted = await channelDispatchLogsDao.deleteByProviderType(providerType);
        sendJson(res, 200, { success: true, deleted });
    } catch (error) {
        console.error('[Provider] Clear channel dispatch logs error:', error);
        sendError(res, 500, error.message, 'SERVER_ERROR');
    }
    return true;
}

/**
 * POST /api/windsurf/email-login
 * 用邮箱+密码登录 Windsurf，返回 apiKey（不创建提供商记录）。
 * Body: { email, password, proxy? }
 */
async function handleWindsurfEmailLogin(req, res) {
    try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw || '{}');
        const { email, password, proxy } = body || {};
        if (!email || !password) {
            sendError(res, 400, 'email 和 password 为必填项', 'VALIDATION_ERROR');
            return true;
        }
        const result = await windsurfEmailLogin(email, password, proxy || null);
        sendJson(res, 200, { success: true, ...result });
    } catch (err) {
        console.error('[Windsurf] Email login error:', err);
        sendError(res, 400, err.message || '登录失败', 'LOGIN_ERROR');
    }
    return true;
}

/**
 * POST /api/windsurf/email-import
 * 用邮箱+密码登录 Windsurf，然后直接添加为 claude-windsurf 提供商。
 * Body: { email, password, customName?, lsBinaryPath?, poolId?, proxy? }
 */
async function handleWindsurfEmailImport(req, res, context) {
    try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw || '{}');
        const {
            email, password, customName, lsBinaryPath, poolId, proxy,
        } = body || {};
        if (!email || !password) {
            sendError(res, 400, 'email 和 password 为必填项', 'VALIDATION_ERROR');
            return true;
        }
        const loginResult = await windsurfEmailLogin(email, password, proxy || null);
        const providerData = {
            providerType: 'claude-windsurf',
            poolId: poolId ? Number(poolId) : undefined,
            providerConfig: {
                customName: customName || loginResult.name || email,
                WINDSURF_API_KEY: loginResult.apiKey,
                WINDSURF_LS_BINARY_PATH: lsBinaryPath || '/opt/windsurf/language_server_linux_x64',
                WINDSURF_API_SERVER_URL: loginResult.apiServerUrl || 'https://server.self-serve.windsurf.com',
                _windsurfEmail: email,
                _windsurfRefreshToken: loginResult.refreshToken,
            },
        };
        const result = await providerService.addProvider(providerData, context.poolManager);
        sendJson(res, 200, { success: true, result });
    } catch (err) {
        console.error('[Windsurf] Email import error:', err);
        sendError(res, 400, err.message || '导入失败', 'IMPORT_ERROR');
    }
    return true;
}

/**
 * POST /api/windsurf/refresh-models
 * 调用 getCascadeModelConfigs 获取账号实时模型列表并持久化到 available_models 字段
 */
async function handleWindsurfRefreshModels(req, res, context) {
    try {
        const raw = await readRequestBody(req);
        const { uuid } = JSON.parse(raw || '{}');
        if (!uuid) {
            sendError(res, 400, 'uuid 为必填项', 'VALIDATION_ERROR');
            return true;
        }
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            sendError(res, 404, '账号不存在', 'NOT_FOUND');
            return true;
        }
        if (provider.provider_type !== 'claude-windsurf') {
            sendError(res, 400, '仅支持 claude-windsurf 渠道', 'UNSUPPORTED');
            return true;
        }
        const creds = typeof provider.credentials === 'string'
            ? JSON.parse(provider.credentials)
            : (provider.credentials || {});
        const apiKey = creds.WINDSURF_API_KEY;
        if (!apiKey) {
            sendError(res, 400, '该账号缺少 API Key，无法获取模型列表', 'NO_API_KEY');
            return true;
        }
        const { configs } = await getCascadeModelConfigs(apiKey);
        const models = configs
            .map(c => {
                const uid = c.modelUid || c.name || c.label;
                return uid ? resolveModelByUid(uid) : null;
            })
            .filter(Boolean);
        const uniqueModels = [...new Set(models)];
        await providerDao.update(uuid, { available_models: uniqueModels });
        sendJson(res, 200, { success: true, models: uniqueModels, count: uniqueModels.length, updatedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[Windsurf] Refresh models error:', err);
        sendError(res, 500, err.message || '获取模型列表失败', 'REFRESH_ERROR');
    }
    return true;
}

/**
 * GET /api/windsurf/models/:uuid
 * 读取数据库中已缓存的模型列表
 */
async function handleWindsurfGetModels(req, res, uuid) {
    try {
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            sendError(res, 404, '账号不存在', 'NOT_FOUND');
            return true;
        }
        const models = Array.isArray(provider.available_models) ? provider.available_models : [];
        sendJson(res, 200, { success: true, models, count: models.length });
    } catch (err) {
        sendError(res, 500, err.message || '读取失败', 'READ_ERROR');
    }
    return true;
}

function getProviderAdapter(provider, context) {
    const providerKey = provider.provider_type + provider.uuid;
    const cached = peekServiceAdapter(providerKey);
    if (cached) return cached;

    return getServiceAdapter({
        ...(context?.config || {}),
        ...(provider.credentials || {}),
        uuid: provider.uuid,
        MODEL_PROVIDER: provider.provider_type
    });
}

/**
 * POST /api/xai/refresh-models
 * 调用 Grok CLI /v1/models 获取账号实时模型列表并持久化。
 */
async function handleXaiRefreshModels(req, res, context) {
    try {
        const raw = await readRequestBody(req);
        const { uuid } = JSON.parse(raw || '{}');
        if (!uuid) {
            sendError(res, 400, 'uuid 为必填项', 'VALIDATION_ERROR');
            return true;
        }

        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            sendError(res, 404, '账号不存在', 'NOT_FOUND');
            return true;
        }
        if (provider.provider_type !== 'openai-xai-oauth') {
            sendError(res, 400, '仅支持 openai-xai-oauth 渠道', 'UNSUPPORTED');
            return true;
        }

        const adapter = getProviderAdapter(provider, context);
        if (!adapter || typeof adapter.listAvailableModels !== 'function') {
            sendError(res, 500, 'Grok 适配器不支持模型拉取', 'UNSUPPORTED');
            return true;
        }

        const rawModels = await adapter.listAvailableModels();
        const models = typeof adapter.parseAvailableModels === 'function'
            ? adapter.parseAvailableModels(rawModels)
            : (Array.isArray(rawModels?.data) ? rawModels.data.map(model => model?.id).filter(Boolean) : []);
        const uniqueModels = [...new Set(models.map(model => String(model).trim()).filter(Boolean))];
        if (uniqueModels.length === 0) {
            sendError(res, 502, 'Grok 上游未返回可用模型', 'EMPTY_MODEL_LIST');
            return true;
        }

        await providerDao.updateAvailableModels(uuid, uniqueModels);
        sendJson(res, 200, {
            success: true,
            models: uniqueModels,
            count: uniqueModels.length,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('[xAI] Refresh models error:', err);
        const status = Number(err?.status || err?.statusCode || err?.response?.status);
        sendError(
            res,
            Number.isFinite(status) && status >= 400 && status < 600 ? status : 500,
            err.message || '获取 Grok 模型列表失败',
            'REFRESH_ERROR'
        );
    }
    return true;
}

/**
 * GET /api/xai/models/:uuid
 * 读取数据库中已缓存的 Grok 模型列表。
 */
async function handleXaiGetModels(req, res, uuid) {
    try {
        const provider = await providerDao.findByUuid(uuid);
        if (!provider) {
            sendError(res, 404, '账号不存在', 'NOT_FOUND');
            return true;
        }
        if (provider.provider_type !== 'openai-xai-oauth') {
            sendError(res, 400, '仅支持 openai-xai-oauth 渠道', 'UNSUPPORTED');
            return true;
        }
        const models = Array.isArray(provider.available_models) ? provider.available_models : [];
        sendJson(res, 200, { success: true, models, count: models.length });
    } catch (err) {
        sendError(res, 500, err.message || '读取失败', 'READ_ERROR');
    }
    return true;
}
