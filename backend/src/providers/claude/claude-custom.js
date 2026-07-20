import { ClaudeBaseService, pickFirstNonEmpty, parseJsonSafely } from './claude-base.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

const FOXCODE_DEFAULT_BASE_URL = 'https://foxcode.rjj.cc';
const CLAUDE_CUSTOM_PROVIDER_TYPE = 'claude-custom';
const CLAUDE_CUSTOM_SYSTEM_TYPES = {
    SELF_HOSTED: 'self-developed',
    NEWAPI: 'newapi'
};

function resolveNewApiSystemToken(config = {}) {
    return pickFirstNonEmpty(
        config.newapiSystemToken,
        config.NEWAPI_SYSTEM_TOKEN,
        config.newapiAccessToken,
        config.NEWAPI_ACCESS_TOKEN,
        config.newapiApiToken,
        config.NEWAPI_API_TOKEN
    );
}

function resolveNewApiUserHeader(config = {}) {
    const value = pickFirstNonEmpty(
        config.newapiUserId,
        config.NEWAPI_USER_ID,
        config.newapiUser,
        config.NEWAPI_USER,
        config.newapiUsername,
        config.NEWAPI_USERNAME
    );
    return String(value || '').trim();
}

function normalizeFoxcodeBaseUrl(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return FOXCODE_DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, '');
}

function normalizeNewApiBaseUrl(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\/+$/, '');
    return normalized.replace(/\/v1$/i, '');
}

function parseJwtExpMs(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || !Number.isFinite(payload.exp)) return null;
        return payload.exp * 1000;
    } catch {
        return null;
    }
}

function extractFoxcodeToken(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return (
        payload?.data?.token ||
        payload?.data?.accessToken ||
        payload?.data?.authToken ||
        payload?.token ||
        payload?.accessToken ||
        payload?.authToken ||
        null
    );
}

function extractFoxcodeError(payload, statusCode) {
    const statusText = statusCode ? `HTTP ${statusCode}` : 'HTTP 错误';
    if (!payload || typeof payload !== 'object') return statusText;
    return payload?.error || payload?.message || payload?.data?.message || statusText;
}

function extractNewApiError(payload, statusCode) {
    const statusText = statusCode ? `HTTP ${statusCode}` : 'HTTP 错误';
    if (!payload || typeof payload !== 'object') return statusText;
    return (
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        payload?.msg ||
        payload?.data?.message ||
        statusText
    );
}

function extractCookieHeader(response) {
    if (!response?.headers) return '';
    try {
        const getSetCookie = response.headers.getSetCookie;
        if (typeof getSetCookie === 'function') {
            const cookies = getSetCookie.call(response.headers) || [];
            const pairs = cookies
                .map((cookie) => String(cookie).split(';')[0]?.trim())
                .filter(Boolean);
            return pairs.join('; ');
        }
    } catch { /* ignore */ }
    const raw = response.headers.get('set-cookie');
    if (!raw) return '';
    return String(raw)
        .split(',')
        .map((segment) => segment.trim().split(';')[0])
        .filter(Boolean)
        .join('; ');
}

function extractNewApiUserId(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const userId =
        payload?.data?.id ??
        payload?.data?.userId ??
        payload?.data?.user?.id ??
        payload?.user?.id ??
        payload?.id;
    if (userId === null || userId === undefined || userId === '') return null;
    return String(userId);
}

function extractModelsFromResponse(payload) {
    const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.data?.data)
        ? payload.data.data
        : [];
    const models = [];
    for (const item of list) {
        const name =
            (typeof item === 'string' ? item : null) ||
            item?.id || item?.name || item?.model || item?.model_name;
        if (!name) continue;
        models.push({ name: String(name) });
    }
    return models;
}

/**
 * Claude Custom API Service
 * 处理 claude-custom 类型的提供商（自建/NewAPI/Foxcode）
 */
export class ClaudeCustomApiService extends ClaudeBaseService {
    constructor(config) {
        super(config);
        this.apiKey = config.CLAUDE_API_KEY || '';
        this._foxcodeToken = null;
        this._foxcodeTokenExpiresAt = 0;
        this._newApiToken = null;
        this._newApiTokenExpiresAt = 0;
        this._newApiSessionCookie = '';
        this._newApiUserId = resolveNewApiUserHeader(config) || null;
        this._quotaExhausted = false;
        this._quotaExhaustedRecoveryAt = null;
        this._quotaExhaustedReason = null;

        if (!this.apiKey) {
            throw new Error('Claude API Key is required for ClaudeCustomApiService.');
        }
    }

    getClaudeRequestHeaders() {
        return {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': this.apiKey,
        };
    }

    // ─── Custom System Type ───
    resolveClaudeCustomSystemType() {
        const explicitType = pickFirstNonEmpty(
            this.config.claudeCustomSystemType,
            this.config.CLAUDE_CUSTOM_SYSTEM_TYPE,
            this.config.upstreamSystemType,
            this.config.UPSTREAM_SYSTEM_TYPE
        ).toLowerCase();
        if (explicitType === CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI) return CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI;
        if (explicitType === CLAUDE_CUSTOM_SYSTEM_TYPES.SELF_HOSTED || explicitType === 'self') return CLAUDE_CUSTOM_SYSTEM_TYPES.SELF_HOSTED;
        const hasNewApiCredentials = Boolean(
            pickFirstNonEmpty(this.config.newapiUsername, this.config.NEWAPI_USERNAME, this.config.newapiEmail, this.config.NEWAPI_EMAIL)
            && pickFirstNonEmpty(this.config.newapiPassword, this.config.NEWAPI_PASSWORD)
        );
        const hasNewApiSystemToken = Boolean(resolveNewApiSystemToken(this.config));
        if (hasNewApiCredentials || hasNewApiSystemToken) return CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI;
        return CLAUDE_CUSTOM_SYSTEM_TYPES.SELF_HOSTED;
    }

    // ─── Foxcode ───
    resolveFoxcodeConfig() {
        const email = pickFirstNonEmpty(this.config.foxcodeEmail, this.config.FOXCODE_EMAIL);
        const password = pickFirstNonEmpty(this.config.foxcodePassword, this.config.FOXCODE_PASSWORD);
        const baseUrl = normalizeFoxcodeBaseUrl(pickFirstNonEmpty(this.config.foxcodeAuthBaseUrl, this.config.FOXCODE_AUTH_BASE_URL, FOXCODE_DEFAULT_BASE_URL));
        if (!email || !password) {
            throw new Error('未配置 foxcodeEmail/foxcodePassword，无法获取 foxcode 用量信息');
        }
        return { email, password, baseUrl };
    }

    async _loginFoxcode() {
        const config = this.resolveFoxcodeConfig();
        const response = await fetch(`${config.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: config.email, password: config.password, remember: false })
        });
        const text = await response.text();
        const payload = parseJsonSafely(text);
        if (!response.ok) throw new Error(`Foxcode 登录失败: ${extractFoxcodeError(payload, response.status)}`);
        if (payload && typeof payload === 'object' && payload.success === false) throw new Error(`Foxcode 登录失败: ${extractFoxcodeError(payload, response.status)}`);
        const token = extractFoxcodeToken(payload);
        if (!token) throw new Error('Foxcode 登录成功但未返回 token');
        this._foxcodeToken = token;
        this._foxcodeTokenExpiresAt = parseJwtExpMs(token) || (Date.now() + 50 * 60 * 1000);
        return token;
    }

    async _getFoxcodeToken(forceRefresh = false) {
        const now = Date.now();
        const tokenValid = this._foxcodeToken && this._foxcodeTokenExpiresAt > (now + 60 * 1000);
        if (!forceRefresh && tokenValid) return this._foxcodeToken;
        return this._loginFoxcode();
    }

    async _getFoxcodeUsageLimits(authRetried = false) {
        const foxcode = this.resolveFoxcodeConfig();
        const token = await this._getFoxcodeToken(authRetried);
        const response = await fetch(`${foxcode.baseUrl}/api/user/dashboard`, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
        });
        const text = await response.text();
        const payload = parseJsonSafely(text);
        if ((response.status === 401 || response.status === 403) && !authRetried) {
            return this._getFoxcodeUsageLimits(true);
        }
        if (!response.ok) throw new Error(`Foxcode 用量查询失败: ${extractFoxcodeError(payload, response.status)}`);
        if (payload && typeof payload === 'object' && payload.success === false) throw new Error(`Foxcode 用量查询失败: ${extractFoxcodeError(payload, response.status)}`);
        return payload || {};
    }

    // ─── NewAPI ───
    resolveNewApiConfig() {
        const username = pickFirstNonEmpty(this.config.newapiUsername, this.config.NEWAPI_USERNAME, this.config.newapiEmail, this.config.NEWAPI_EMAIL);
        const password = pickFirstNonEmpty(this.config.newapiPassword, this.config.NEWAPI_PASSWORD);
        const systemToken = String(resolveNewApiSystemToken(this.config) || '').trim();
        const userId = resolveNewApiUserHeader(this.config);
        const baseUrl = normalizeNewApiBaseUrl(pickFirstNonEmpty(
            this.config.newapiAuthBaseUrl, this.config.NEWAPI_AUTH_BASE_URL,
            this.config.newapiBaseUrl, this.config.NEWAPI_BASE_URL,
            this.config.CLAUDE_BASE_URL, this.baseUrl
        ));
        const hasLoginCredentials = Boolean(username && password);
        if (!systemToken && !hasLoginCredentials) {
            throw new Error('未配置 newapiSystemToken 或 newapiUsername/newapiPassword，无法获取 newapi 用量信息');
        }
        if (!baseUrl) throw new Error('未配置 NewAPI Base URL，无法获取 newapi 用量信息');
        return { username, password, baseUrl, systemToken, userId };
    }

    async _loginNewApi() {
        const config = this.resolveNewApiConfig();
        if (!config.username || !config.password) {
            throw new Error('未配置 newapiUsername/newapiPassword，无法执行 NewAPI 登录');
        }
        const endpointCandidates = ['/api/user/login', '/api/auth/login'];
        const bodyCandidates = [
            { username: config.username, password: config.password },
            { email: config.username, password: config.password },
            { username: config.username, password: config.password, remember: false },
            { email: config.username, password: config.password, remember: false }
        ];
        let lastError = null;
        for (const endpoint of endpointCandidates) {
            for (const body of bodyCandidates) {
                try {
                    const response = await fetch(`${config.baseUrl}${endpoint}`, {
                        method: 'POST',
                        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const text = await response.text();
                    const payload = parseJsonSafely(text);
                    if (!response.ok) { const error = new Error(`NewAPI 登录失败: ${extractNewApiError(payload, response.status)}`); error.statusCode = response.status; throw error; }
                    if (payload && typeof payload === 'object' && payload.success === false) throw new Error(`NewAPI 登录失败: ${extractNewApiError(payload, response.status)}`);
                    const token = extractFoxcodeToken(payload);
                    const cookieHeader = extractCookieHeader(response);
                    const userId = extractNewApiUserId(payload);
                    if (!token && !cookieHeader) throw new Error('NewAPI 登录成功但未返回 token/cookie');
                    this._newApiToken = token || null;
                    this._newApiTokenExpiresAt = token ? (parseJwtExpMs(token) || (Date.now() + 50 * 60 * 1000)) : (Date.now() + 30 * 60 * 1000);
                    this._newApiSessionCookie = cookieHeader || this._newApiSessionCookie || '';
                    this._newApiUserId = userId || this._newApiUserId || null;
                    return { token: this._newApiToken, cookie: this._newApiSessionCookie, userId: this._newApiUserId };
                } catch (error) { lastError = error; }
            }
        }
        throw lastError || new Error('NewAPI 登录失败');
    }

    async _getNewApiAuth(forceRefresh = false) {
        const config = this.resolveNewApiConfig();
        const hasLoginCredentials = Boolean(config.username && config.password);
        const preferredUserId = this._newApiUserId || config.userId || null;
        if (config.systemToken && (!forceRefresh || !hasLoginCredentials)) {
            return { token: config.systemToken, cookie: '', userId: preferredUserId };
        }

        const now = Date.now();
        const tokenValid = this._newApiToken && this._newApiTokenExpiresAt > (now + 60 * 1000);
        const hasCookie = Boolean(this._newApiSessionCookie);
        if (!forceRefresh && (tokenValid || hasCookie)) {
            return { token: this._newApiToken, cookie: this._newApiSessionCookie, userId: preferredUserId };
        }
        return this._loginNewApi();
    }

    async _getNewApiUserInfo(authRetried = false) {
        const config = this.resolveNewApiConfig();
        const auth = await this._getNewApiAuth(authRetried);
        const headers = { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-store' };
        if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
        if (auth?.cookie) headers.Cookie = auth.cookie;
        const requestUserId = auth?.userId || config.userId;
        if (requestUserId) headers['New-API-User'] = String(requestUserId);
        const response = await fetch(`${config.baseUrl}/api/user/self`, { method: 'GET', headers });
        const text = await response.text();
        const payload = parseJsonSafely(text);
        const canLoginRetry = Boolean(config.username && config.password);
        if ((response.status === 401 || response.status === 403) && !authRetried && canLoginRetry) return this._getNewApiUserInfo(true);
        if (!response.ok) throw new Error(`NewAPI 用量查询失败: ${extractNewApiError(payload, response.status)}`);
        if (payload && typeof payload === 'object' && payload.success === false) throw new Error(`NewAPI 用量查询失败: ${extractNewApiError(payload, response.status)}`);
        const payloadUserId = extractNewApiUserId(payload);
        if (payloadUserId) this._newApiUserId = payloadUserId;
        return payload || {};
    }

    async _listNewApiModels() {
        const config = this.resolveNewApiConfig();
        const auth = await this._getNewApiAuth(false);
        const headers = { Accept: 'application/json, text/plain, */*' };
        if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
        if (auth?.cookie) headers.Cookie = auth.cookie;
        const requestUserId = auth?.userId || config.userId;
        if (requestUserId) headers['New-API-User'] = String(requestUserId);
        const endpointCandidates = ['/api/models', '/v1/models'];
        for (const endpoint of endpointCandidates) {
            try {
                const response = await fetch(`${config.baseUrl}${endpoint}`, { method: 'GET', headers });
                const text = await response.text();
                const payload = parseJsonSafely(text);
                if (!response.ok || (payload && payload.success === false)) continue;
                const models = extractModelsFromResponse(payload);
                if (models.length > 0) return { models };
            } catch { /* try next */ }
        }
        throw new Error('NewAPI 模型列表为空或拉取失败');
    }

    // ─── Override: listModels ───
    async listModels() {
        console.log('[ClaudeCustomApiService] Listing available models.');
        const systemType = this.resolveClaudeCustomSystemType();
        if (systemType === CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI) {
            try {
                return await this._listNewApiModels();
            } catch (error) {
                console.warn('[ClaudeCustomApiService] Failed to load models from NewAPI, fallback to static list:', error.message);
            }
        }
        return super.listModels();
    }

    // ─── Override: getUsageLimits ───
    async getUsageLimits(authRetried = false) {
        const systemType = this.resolveClaudeCustomSystemType();
        let payload;
        if (systemType === CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI) {
            payload = await this._getNewApiUserInfo(authRetried);
        } else {
            payload = await this._getFoxcodeUsageLimits(authRetried);
        }
        // 检查额度是否耗尽
        this._checkUsageExhaustion(payload, systemType);
        return payload;
    }

    // ─── 额度耗尽检测 & Pool Manager 联动 ───

    _notifyPoolManagerCooldown(recoveryTime, reason) {
        try {
            const poolManager = getProviderPoolManager();
            const uuid = this.config.uuid;
            if (!poolManager || !uuid) return;
            console.log(`[Claude Custom] 🧊 Marking account ${uuid.slice(0, 8)} as cooldown: ${reason}, recovery at ${recoveryTime.toISOString()}`);
            poolManager.markProviderUnhealthyWithRecoveryTime(
                CLAUDE_CUSTOM_PROVIDER_TYPE, uuid, recoveryTime, reason, {
                    action: 'mark_unhealthy_quota_exhausted',
                    source: 'quota_exhausted',
                    metadata: { reason }
                }
            );
        } catch (e) {
            console.error('[Claude Custom] Failed to notify pool manager cooldown:', e.message);
        }
    }

    _notifyPoolManagerHealthy() {
        try {
            const poolManager = getProviderPoolManager();
            const uuid = this.config.uuid;
            if (!poolManager || !uuid) return;
            if (typeof poolManager.markProviderHealthy === 'function') {
                poolManager.markProviderHealthy(CLAUDE_CUSTOM_PROVIDER_TYPE, uuid, {
                    action: 'recover_from_cooldown', source: 'quota_recovered'
                });
                console.log(`[Claude Custom] ✅ Account ${uuid.slice(0, 8)} marked healthy`);
            }
        } catch (e) {
            console.error('[Claude Custom] Failed to notify pool manager healthy:', e.message);
        }
    }

    /**
     * 从 getUsageLimits 返回的数据中检查额度是否耗尽
     * NewAPI: quota - used_quota <= 0
     * Foxcode: subscriptionBreakdown 中 remaining <= 0
     */
    _checkUsageExhaustion(payload, systemType) {
        if (!payload || typeof payload !== 'object') return;
        const uuid = (this.config.uuid || '').slice(0, 8);
        const defaultRecoveryMs = 60 * 60 * 1000; // 1h fallback

        if (systemType === CLAUDE_CUSTOM_SYSTEM_TYPES.NEWAPI) {
            const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
            const quota = Number(data?.quota);
            const used = Number(data?.used_quota ?? data?.usedQuota);
            if (Number.isFinite(quota) && Number.isFinite(used) && quota > 0 && used >= quota) {
                const resetAt = new Date(Date.now() + defaultRecoveryMs);
                const reason = `NewAPI quota exhausted (used=${used}, limit=${quota})`;
                console.warn(`[Claude Custom] 🧊 ${reason} for account ${uuid}`);
                this._quotaExhausted = true;
                this._quotaExhaustedRecoveryAt = resetAt.getTime();
                this._quotaExhaustedReason = reason;
                this._notifyPoolManagerCooldown(resetAt, reason);
                return;
            }
        } else {
            // Foxcode: 检查 subscriptionBreakdown
            const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
            const breakdown = data?.quota?.subscriptionBreakdown
                || data?.subscriptionBreakdown
                || [];
            if (Array.isArray(breakdown)) {
                for (const item of breakdown) {
                    const limit = Number(item?.limit);
                    const remaining = Number(item?.remaining);
                    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining <= 0) {
                        const resetAt = item?.lastResetAt
                            ? new Date(new Date(item.lastResetAt).getTime() + defaultRecoveryMs)
                            : new Date(Date.now() + defaultRecoveryMs);
                        const reason = `Foxcode quota exhausted (${item?.planName || 'unknown'}, remaining=0)`;
                        console.warn(`[Claude Custom] 🧊 ${reason} for account ${uuid}`);
                        this._quotaExhausted = true;
                        this._quotaExhaustedRecoveryAt = resetAt.getTime();
                        this._quotaExhaustedReason = reason;
                        this._notifyPoolManagerCooldown(resetAt, reason);
                        return;
                    }
                }
            }
        }
        // 额度正常 → 清除耗尽标志
        if (this._quotaExhausted) {
            console.log(`[Claude Custom] ✅ Quota recovered for account ${uuid}`);
            this._quotaExhausted = false;
            this._quotaExhaustedRecoveryAt = null;
            this._quotaExhaustedReason = null;
            this._notifyPoolManagerHealthy();
        }
    }

    /**
     * 入口检查：额度耗尽时直接抛错切号
     */
    _ensureAccountAvailable() {
        if (this._quotaExhausted && this._quotaExhaustedRecoveryAt) {
            if (Date.now() >= this._quotaExhaustedRecoveryAt) {
                this._quotaExhausted = false;
                this._quotaExhaustedRecoveryAt = null;
                this._quotaExhaustedReason = null;
                return;
            }
            const recoveryIso = new Date(this._quotaExhaustedRecoveryAt).toISOString();
            const err = new Error(`此账号上游额度已耗尽（${this._quotaExhaustedReason || 'unknown'}），将于 ${recoveryIso} 自动恢复。`);
            err.status = 429; err.statusCode = 429;
            err.isQuotaCooldown = true;
            err.shouldSwitchCredential = true;
            err.skipErrorCount = true;
            err.quotaResetTime = recoveryIso;
            err.quotaResetDelayMs = Math.max(0, this._quotaExhaustedRecoveryAt - Date.now());
            err.quotaResetFormatted = recoveryIso;
            throw err;
        }
    }

    /**
     * 429 错误标记：设置切号标志让外层 common.js 正确处理
     */
    _mark429Error(error) {
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        error.isQuotaCooldown = true;
        const fallbackMs = 60000;
        const resetAtMs = Date.now() + fallbackMs;
        error.quotaResetTime = new Date(resetAtMs).toISOString();
        error.quotaResetDelayMs = fallbackMs;
        error.quotaResetFormatted = new Date(resetAtMs).toISOString();
    }

    // ─── Override: callApi（加入额度检查 + 429 标记） ───
    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        this._ensureAccountAvailable();
        try {
            return await super.callApi(endpoint, body, isRetry, retryCount);
        } catch (error) {
            const status = error.response?.status || error.status || error.statusCode;
            if (status === 429) {
                this._mark429Error(error);
            }
            throw error;
        }
    }

    // ─── Override: streamApi（加入额度检查 + 429 标记） ───
    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        this._ensureAccountAvailable();
        try {
            yield* super.streamApi(endpoint, body, isRetry, retryCount);
        } catch (error) {
            const status = error.response?.status || error.status || error.statusCode;
            if (status === 429) {
                this._mark429Error(error);
            }
            throw error;
        }
    }
}
