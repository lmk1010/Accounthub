import * as providerDao from '../dao/provider-dao.js';
import { getRequestBody } from '../utils/common.js';

const DEFAULT_TIMEOUT_MS = 15000;

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function normalizeBaseUrl(baseUrl, options = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    let normalized = baseUrl.trim().replace(/\/+$/, '');
    if (options.stripTrailingV1 && /\/v1$/i.test(normalized)) {
        normalized = normalized.replace(/\/v1$/i, '');
    }
    return normalized;
}

function getProviderCredentials(provider) {
    const credentials = provider?.credentials;
    if (!credentials || typeof credentials !== 'object') return {};
    return credentials;
}

function resolveUpstreamConfig(provider) {
    const credentials = getProviderCredentials(provider);
    const mode = credentials.upstreamMode || 'direct';
    const rawBaseUrl = normalizeBaseUrl(credentials.upstreamBaseUrl || credentials.CLAUDE_BASE_URL || '');
    const baseUrl = mode === 'direct'
        ? normalizeBaseUrl(rawBaseUrl, { stripTrailingV1: true })
        : rawBaseUrl;
    const adminToken = (credentials.upstreamAdminToken || '').trim();
    const directApiKey = (credentials.CLAUDE_API_KEY || '').trim();
    const upstreamApiKey = (credentials.upstreamApiKey || '').trim();
    const healthModel = (credentials.checkModelName || provider?.check_model_name || provider?.checkModelName || '').trim();
    const apiKey = mode === 'direct'
        ? (directApiKey || upstreamApiKey)
        : (upstreamApiKey || directApiKey);
    const timeoutMs = Number(credentials.upstreamRequestTimeoutMs || DEFAULT_TIMEOUT_MS);

    return {
        mode,
        baseUrl,
        adminToken,
        apiKey,
        healthModel,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 1000 ? timeoutMs : DEFAULT_TIMEOUT_MS
    };
}

function extractErrorMessage(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') return payload;
    return payload?.error?.message || payload?.message || payload?.error || null;
}

function normalizeTextField(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function parseJsonPayload(raw, fieldName) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
        return { ok: false, error: `${fieldName} 不是有效 JSON: ${error.message}` };
    }
}

function parseUpstreamImportItems(body) {
    const listKeys = ['records', 'accounts', 'items', 'data', 'list', 'tokens'];
    let payload = body;
    let legacySingleToken = false;

    if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (typeof body.jsonContent === 'string' && body.jsonContent.trim()) {
            const parsed = parseJsonPayload(body.jsonContent.trim(), 'jsonContent');
            if (!parsed.ok) return { error: parsed.error, items: [], legacySingleToken: false };
            payload = parsed.value;
        } else if (Array.isArray(body.refreshTokens)) {
            payload = body.refreshTokens;
        } else if (typeof body.refreshToken === 'string') {
            const rawRefreshToken = body.refreshToken.trim();
            if (rawRefreshToken.startsWith('[') || rawRefreshToken.startsWith('{')) {
                const parsed = parseJsonPayload(rawRefreshToken, 'refreshToken');
                if (!parsed.ok) return { error: parsed.error, items: [], legacySingleToken: false };
                payload = parsed.value;
            } else {
                payload = rawRefreshToken;
                legacySingleToken = true;
            }
        }
    }

    if (!Array.isArray(payload) && payload && typeof payload === 'object') {
        for (const key of listKeys) {
            if (Array.isArray(payload[key])) {
                payload = payload[key];
                break;
            }
        }
    }

    const rawItems = Array.isArray(payload) ? payload : [payload];
    const items = [];

    for (const rawItem of rawItems) {
        if (typeof rawItem === 'string') {
            const refreshToken = rawItem.trim();
            if (refreshToken) {
                items.push({ refreshToken, email: null });
            }
            continue;
        }

        if (!rawItem || typeof rawItem !== 'object') {
            continue;
        }

        const refreshToken = normalizeTextField(
            rawItem.refresh_token
            || rawItem.refreshToken
            || rawItem.rt
            || rawItem.token
        );
        if (!refreshToken) {
            continue;
        }

        const email = normalizeTextField(rawItem.email || rawItem.userEmail || rawItem.mail) || null;
        items.push({ refreshToken, email });
    }

    return { items, legacySingleToken, error: null };
}

async function callUpstreamApi(config, endpoint, options = {}) {
    if (!config.baseUrl) {
        const err = new Error('未配置 upstreamBaseUrl（或 CLAUDE_BASE_URL）');
        err.status = 400;
        throw err;
    }

    const url = `${config.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = {
        Accept: 'application/json'
    };

    if (config.adminToken) {
        headers.Authorization = `Bearer ${config.adminToken}`;
    }
    if (config.apiKey) {
        headers['x-api-key'] = config.apiKey;
    }
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
        response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(config.timeoutMs)
        });
    } catch (error) {
        const err = new Error(`上游请求失败: ${error.message}`);
        err.status = 502;
        throw err;
    }

    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { raw: text };
        }
    }

    if (!response.ok) {
        const message = extractErrorMessage(payload) || `上游返回错误: HTTP ${response.status}`;
        const err = new Error(message);
        err.status = response.status;
        err.payload = payload;
        throw err;
    }

    return payload ?? {};
}

function buildDirectClaudeHeaders(config) {
    const headers = {
        Accept: 'application/json',
        'anthropic-version': '2023-06-01'
    };
    if (config.adminToken) {
        headers.Authorization = `Bearer ${config.adminToken}`;
    }
    if (config.apiKey) {
        headers['x-api-key'] = config.apiKey;
    }
    return headers;
}

function buildDirectClaudeHealthPayloads(model) {
    return [
        {
            model,
            max_tokens: 1,
            stream: false,
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: 'ping' }]
                }
            ]
        },
        {
            model,
            max_tokens: 1,
            stream: false,
            messages: [
                {
                    role: 'user',
                    content: 'ping'
                }
            ]
        }
    ];
}

async function callDirectClaudeHealth(config) {
    if (!config.baseUrl) {
        const err = new Error('未配置 upstreamBaseUrl（或 CLAUDE_BASE_URL）');
        err.status = 400;
        throw err;
    }

    const endpointCandidates = ['/v1/messages'];
    const modelCandidates = [
        config.healthModel,
        'claude-sonnet-4-5-20250929',
        'claude-3-5-sonnet-20241022'
    ].filter(Boolean);

    let lastError = null;

    for (const endpoint of endpointCandidates) {
        const url = `${config.baseUrl}${endpoint}`;
        for (const model of modelCandidates) {
            const payloadCandidates = buildDirectClaudeHealthPayloads(model);
            for (const body of payloadCandidates) {
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            ...buildDirectClaudeHeaders(config),
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(config.timeoutMs)
                    });

                    const text = await response.text();
                    let payload = null;
                    if (text) {
                        try {
                            payload = JSON.parse(text);
                        } catch {
                            payload = { raw: text };
                        }
                    }

                    if (response.ok) {
                        return {
                            mode: 'direct',
                            ok: true,
                            endpoint,
                            model,
                            status: response.status,
                            payload
                        };
                    }

                    const message = extractErrorMessage(payload) || `健康探测失败: HTTP ${response.status}`;
                    const err = new Error(message);
                    err.status = response.status;
                    err.payload = payload;

                    if (response.status === 401 || response.status === 403) {
                        throw err;
                    }

                    lastError = err;
                    if (response.status === 400) {
                        continue;
                    }
                } catch (error) {
                    if (error?.status === 401 || error?.status === 403) {
                        throw error;
                    }
                    const err = error?.status
                        ? error
                        : Object.assign(new Error(`上游请求失败: ${error.message}`), { status: 502 });
                    lastError = err;
                }
            }
        }
    }

    throw lastError || Object.assign(new Error('直连健康检查失败'), { status: 502 });
}

async function loadProvider(providerType, providerUuid) {
    const provider = await providerDao.findByUuid(providerUuid);
    if (!provider) {
        const err = new Error('Provider not found');
        err.status = 404;
        throw err;
    }
    if (provider.provider_type !== providerType) {
        const err = new Error(`Provider type mismatch: expected ${providerType}, got ${provider.provider_type}`);
        err.status = 400;
        throw err;
    }
    return provider;
}

async function markProviderHealthChecked(providerUuid) {
    if (!providerUuid) return;
    try {
        await providerDao.update(providerUuid, {
            last_health_check_time: new Date()
        });
    } catch (error) {
        console.warn('[Upstream API] Failed to record last health check time:', error.message);
    }
}

export async function handleUpstreamRequest(req, res, providerType, providerUuid, action) {
    let provider = null;
    try {
        provider = await loadProvider(providerType, providerUuid);
        const config = resolveUpstreamConfig(provider);

        if (action !== 'health' && config.mode !== 'antigravity-channel') {
            sendJson(res, 400, { success: false, error: '当前账号未启用 antigravity-channel 模式（upstreamMode）' });
            return true;
        }

        if (!config.adminToken && !config.apiKey) {
            sendJson(res, 400, { success: false, error: '未配置 upstreamAdminToken 或 upstreamApiKey' });
            return true;
        }

        if (req.method === 'GET' && action === 'health') {
            const health = config.mode === 'antigravity-channel'
                ? await callUpstreamApi(config, '/health')
                : await callDirectClaudeHealth(config);
            await markProviderHealthChecked(provider.uuid);
            sendJson(res, 200, {
                success: true,
                health,
                config: {
                    mode: config.mode,
                    baseUrl: config.baseUrl,
                    hasAdminToken: Boolean(config.adminToken),
                    hasApiKey: Boolean(config.apiKey),
                    timeoutMs: config.timeoutMs
                }
            });
            return true;
        }

        if (req.method === 'GET' && action === 'proxy/status') {
            const status = await callUpstreamApi(config, '/api/proxy/status');
            sendJson(res, 200, { success: true, status });
            return true;
        }

        if (req.method === 'POST' && (action === 'proxy/start' || action === 'proxy/stop')) {
            const result = await callUpstreamApi(config, `/api/${action}`, { method: 'POST', body: {} });
            sendJson(res, 200, { success: true, result });
            return true;
        }

        if (req.method === 'GET' && action === 'accounts') {
            const result = await callUpstreamApi(config, '/api/accounts');
            const accounts = Array.isArray(result) ? result : (Array.isArray(result?.accounts) ? result.accounts : []);
            sendJson(res, 200, { success: true, accounts, raw: result });
            return true;
        }

        if (req.method === 'POST' && action === 'accounts/import-refresh-token') {
            const body = await getRequestBody(req);
            const parsed = parseUpstreamImportItems(body);
            if (parsed.error) {
                sendJson(res, 400, { success: false, error: parsed.error });
                return true;
            }

            const { items, legacySingleToken } = parsed;
            if (!items.length) {
                sendJson(res, 400, { success: false, error: 'refreshToken is required' });
                return true;
            }

            if (legacySingleToken && items.length === 1) {
                const result = await callUpstreamApi(config, '/api/accounts', {
                    method: 'POST',
                    body: { refreshToken: items[0].refreshToken }
                });
                sendJson(res, 200, { success: true, result });
                return true;
            }

            let imported = 0;
            let skipped = 0;
            let failed = 0;
            const details = [];
            const duplicatePattern = /duplicate|already\s+exists|already\s+imported|已存在|重复/i;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                try {
                    await callUpstreamApi(config, '/api/accounts', {
                        method: 'POST',
                        body: {
                            refreshToken: item.refreshToken,
                            ...(item.email ? { email: item.email } : {})
                        }
                    });
                    imported++;
                    details.push({ index: i + 1, email: item.email, status: 'imported' });
                } catch (error) {
                    const reason = error?.message || '导入失败';
                    const isDuplicate = duplicatePattern.test(reason);
                    if (isDuplicate) {
                        skipped++;
                    } else {
                        failed++;
                    }
                    details.push({
                        index: i + 1,
                        email: item.email,
                        status: isDuplicate ? 'skipped' : 'failed',
                        reason
                    });
                }
            }

            sendJson(res, 200, {
                success: failed === 0,
                total: items.length,
                imported,
                skipped,
                failed,
                details
            });
            return true;
        }

        if (req.method === 'POST' && action === 'accounts/switch') {
            const body = await getRequestBody(req);
            const accountId = body?.accountId?.trim();
            if (!accountId) {
                sendJson(res, 400, { success: false, error: 'accountId is required' });
                return true;
            }
            const result = await callUpstreamApi(config, '/api/accounts/switch', {
                method: 'POST',
                body: { accountId }
            });
            sendJson(res, 200, { success: true, result });
            return true;
        }

        sendJson(res, 404, { success: false, error: `Unsupported upstream action: ${action}` });
        return true;
    } catch (error) {
        if (action === 'health' && provider?.uuid) {
            await markProviderHealthChecked(provider.uuid);
        }
        sendJson(res, error.status || 500, {
            success: false,
            error: error.message,
            details: error.payload || null
        });
        return true;
    }
}
