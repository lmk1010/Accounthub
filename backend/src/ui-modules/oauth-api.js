import { getRequestBody } from '../utils/common.js';
import {
    handleGeminiCliOAuth,
    handleGeminiAntigravityOAuth,
    handleQwenOAuth,
    handleKiroOAuth,
    handleIFlowOAuth,
    handleCodexOAuth,
    handleClaudeOfficialOAuth,
    handleClaudeOfficialCookieOAuth,
    handleOrchidsOAuth,
    handleKiroSocialManualCallback,
    handleKiroBuilderIDManualCallback,
    batchImportKiroRefreshTokensStream,
    batchImportWarpRefreshTokensStream,
    batchImportDroidRefreshTokensStream,
    importAwsCredentials,
    importDroidRefreshToken,
    importWarpRefreshToken,
    importOrchidsToken,
    importOrchidsWithPassword,
    startCodexBatchAuth,
    stopCodexBatchAuth,
    getCodexBatchStatus
} from '../auth/oauth-handlers.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as providerPoolDao from '../dao/provider-pool-dao.js';
import { formatOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { createProviderConfig, PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import {
    formatCodexPlanTitle as formatNormalizedCodexPlanTitle,
    normalizeCodexPlanKey
} from '../utils/codex-plan.js';
import {
    cancelXaiPolling,
    completeXaiOidcOAuth,
    importXaiCredentials,
    startXaiOAuth
} from '../auth/xai-oauth.js';

async function resolveImportPoolId(providerType, rawPoolId) {
    if (rawPoolId === null || rawPoolId === undefined || rawPoolId === '') {
        return null;
    }

    const normalizedPoolId = Number.parseInt(rawPoolId, 10);
    if (!Number.isFinite(normalizedPoolId)) {
        return null;
    }

    if (normalizedPoolId > 0) {
        return normalizedPoolId;
    }

    if (normalizedPoolId !== 0 || !providerType) {
        return null;
    }

    const pools = await providerPoolDao.findByType(providerType);
    const defaultPool = Array.isArray(pools) ? pools.find(pool => pool.is_default || pool.isDefault) : null;
    const defaultPoolId = Number.parseInt(defaultPool?.id, 10);
    return Number.isFinite(defaultPoolId) && defaultPoolId > 0 ? defaultPoolId : null;
}

function normalizeStringField(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function firstNormalizedString(...values) {
    for (const value of values) {
        const normalized = normalizeStringField(value);
        if (normalized) return normalized;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
    }
    return null;
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeKiroTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return value;
    }

    const numericValue = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^\d{12,}$/.test(value.trim()) ? Number(value.trim()) : null);

    if (Number.isFinite(numericValue)) {
        const date = new Date(numericValue);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }

    return value;
}

function normalizeKiroAccountManagerAccount(account, exportPayload = {}) {
    if (!isPlainObject(account)) return null;

    const sourceCredentials = isPlainObject(account.credentials) ? account.credentials : {};
    const clientId = sourceCredentials.clientId || sourceCredentials.client_id || account.clientId || account.client_id;
    const clientSecret = sourceCredentials.clientSecret || sourceCredentials.client_secret || account.clientSecret || account.client_secret;
    const profileArn = sourceCredentials.profileArn || sourceCredentials.profile_arn || account.profileArn || account.profile_arn || '';
    const provider = sourceCredentials.provider || sourceCredentials.socialProvider || sourceCredentials.provider_id || account.provider || account.idp;
    const authMethod = sourceCredentials.authMethod || sourceCredentials.auth_method || account.authMethod || account.auth_method ||
        (provider && !(clientId && clientSecret) ? 'social' : undefined);

    return {
        ...sourceCredentials,
        clientId,
        clientSecret,
        accessToken: sourceCredentials.accessToken || sourceCredentials.access_token || account.accessToken || account.access_token,
        refreshToken: sourceCredentials.refreshToken || sourceCredentials.refresh_token || account.refreshToken || account.refresh_token,
        profileArn,
        expiresAt: normalizeKiroTimestamp(sourceCredentials.expiresAt || sourceCredentials.expires_at || account.expiresAt || account.expires_at),
        authMethod,
        provider: provider || (authMethod === 'social' ? 'Google' : undefined),
        region: sourceCredentials.region || sourceCredentials.awsRegion || account.region || account.awsRegion || 'us-east-1',
        email: sourceCredentials.email || account.email,
        userId: sourceCredentials.userId || sourceCredentials.user_id || account.userId || account.user_id,
        nickname: sourceCredentials.nickname || account.nickname,
        idp: sourceCredentials.idp || account.idp,
        accountId: sourceCredentials.accountId || sourceCredentials.account_id || account.accountId || account.account_id || account.id,
        machineId: sourceCredentials.machineId || sourceCredentials.machine_id || account.machineId || account.machine_id,
        subscription: sourceCredentials.subscription || account.subscription,
        usage: sourceCredentials.usage || account.usage,
        status: sourceCredentials.status || account.status,
        sourceFormat: sourceCredentials.sourceFormat || 'kiro-account-manager',
        exportedAt: normalizeKiroTimestamp(sourceCredentials.exportedAt || exportPayload.exportedAt),
        kiroAccountManagerVersion: sourceCredentials.kiroAccountManagerVersion || exportPayload.version
    };
}

function isKiroAccountManagerAccount(value) {
    if (!isPlainObject(value) || !isPlainObject(value.credentials)) return false;
    const credentials = value.credentials;
    return Boolean(
        credentials.refreshToken ||
        credentials.refresh_token ||
        credentials.accessToken ||
        credentials.access_token ||
        value.email ||
        value.userId ||
        value.idp
    );
}

function extractKiroCredentialsFromPayload(payload, exportPayload = payload) {
    if (Array.isArray(payload)) {
        return payload.flatMap(item => extractKiroCredentialsFromPayload(item, exportPayload));
    }

    if (!isPlainObject(payload)) {
        return [];
    }

    if (Array.isArray(payload.accounts)) {
        return payload.accounts
            .map(account => normalizeKiroAccountManagerAccount(account, payload))
            .filter(Boolean);
    }

    if (isKiroAccountManagerAccount(payload)) {
        return [normalizeKiroAccountManagerAccount(payload, exportPayload)].filter(Boolean);
    }

    return [payload];
}

function decodeJwtClaims(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    try {
        const raw = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function extractCodexAuthClaims(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const authClaims = claims['https://api.openai.com/auth'];
    return authClaims && typeof authClaims === 'object' ? authClaims : null;
}

function extractCodexAccountId(token) {
    const authClaims = extractCodexAuthClaims(token);
    if (!authClaims) return null;
    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

function extractCodexUserId(token) {
    const authClaims = extractCodexAuthClaims(token);
    if (!authClaims) return null;
    const userId = firstNormalizedString(authClaims.chatgpt_user_id, authClaims.user_id);
    return userId || null;
}

function extractCodexAccountUserId(token) {
    const authClaims = extractCodexAuthClaims(token);
    if (!authClaims) return null;
    return firstNormalizedString(
        authClaims.chatgpt_account_user_id,
        authClaims.chatgptAccountUserId,
        authClaims.account_user_id,
        authClaims.accountUserId
    );
}

function extractCodexOrganizationId(token) {
    const authClaims = extractCodexAuthClaims(token);
    if (!authClaims) return null;

    const directOrganizationId = firstNormalizedString(
        authClaims.poid,
        authClaims.organization_id,
        authClaims.organizationId
    );
    if (directOrganizationId) return directOrganizationId;

    if (Array.isArray(authClaims.organizations)) {
        const defaultOrganization = authClaims.organizations.find(org => org?.is_default) || authClaims.organizations[0];
        return firstNormalizedString(defaultOrganization?.id, defaultOrganization?.organization_id);
    }

    return null;
}

function extractCodexEmail(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const profileClaims = claims['https://api.openai.com/profile'];
    if (profileClaims && typeof profileClaims === 'object') {
        const profileEmail = profileClaims.email;
        if (typeof profileEmail === 'string' && profileEmail.trim()) {
            return profileEmail.trim();
        }
    }
    const email = claims.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
}

function extractCodexPlanType(token) {
    const authClaims = extractCodexAuthClaims(token);
    if (!authClaims) return null;
    const planType = authClaims.chatgpt_plan_type;
    return typeof planType === 'string' && planType.trim() ? planType.trim() : null;
}

function extractCodexExpiresAt(token) {
    const claims = decodeJwtClaims(token);
    if (!claims || !Number.isFinite(Number(claims.exp))) return null;
    return new Date(Number(claims.exp) * 1000).toISOString();
}

function formatCodexPlanTitle(planType) {
    return formatNormalizedCodexPlanTitle(planType);
}

function isCodexTeamPlan(planType) {
    const normalized = normalizeStringField(planType);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    const planKey = normalizeCodexPlanKey(normalized);
    return ['team', 'business', 'enterprise'].includes(planKey)
        || lower === 'k12'
        || lower.includes('k-12')
        || lower.includes('education')
        || lower.includes('edu')
        || lower.includes('workspace');
}

function buildCodexImportIdentityKeys({ accountId, userId, email, planType } = {}) {
    const normalizedAccountId = normalizeStringField(accountId);
    const normalizedUserId = normalizeStringField(userId);
    const normalizedEmail = normalizeStringField(email);
    const emailKey = normalizedEmail ? normalizedEmail.toLowerCase() : null;
    const keys = [];

    if (normalizedAccountId && normalizedUserId) {
        keys.push(`member:${normalizedAccountId}:${normalizedUserId}`);
    }

    // Team 的 chatgpt_account_id 是组织账号,同组织不同成员必须用成员维度区分。
    // 同时保留 account+email 兼容旧导入数据,因为旧数据可能没有 chatgpt_user_id。
    if (normalizedAccountId && isCodexTeamPlan(planType)) {
        if (emailKey) {
            keys.push(`team:${normalizedAccountId}:email:${emailKey}`);
        }
        if (keys.length === 0) {
            keys.push(`team:${normalizedAccountId}`);
        }
        return Array.from(new Set(keys));
    }

    if (normalizedAccountId) {
        keys.push(`account:${normalizedAccountId}`);
    }
    if (emailKey) {
        keys.push(`email:${emailKey}`);
    }
    return Array.from(new Set(keys));
}

function hasAnyCodexImportIdentityKey(existingKeys, identityKeys = []) {
    return identityKeys.some(key => existingKeys.has(key));
}

function normalizeAnyRegisterItems(payload) {
    if (Array.isArray(payload)) {
        return payload.flatMap(item => normalizeAnyRegisterItems(item));
    }
    if (isPlainObject(payload)) {
        for (const key of ['tokens', 'items', 'records', 'data', 'payload', 'accounts', 'list']) {
            if (Array.isArray(payload[key])) {
                return payload[key].flatMap(item => normalizeAnyRegisterItems(item));
            }
        }
        for (const key of ['records', 'data', 'payload']) {
            if (isPlainObject(payload[key])) {
                return normalizeAnyRegisterItems(payload[key]);
            }
        }
        return [payload];
    }
    return [];
}

function normalizeCodexImportItem(item) {
    const sourceCredentials = isPlainObject(item?.credentials) ? item.credentials : {};
    const accountExtra = isPlainObject(item?.extra) ? item.extra : null;
    const accessToken = firstNormalizedString(
        sourceCredentials.access_token,
        sourceCredentials.accessToken,
        item?.access_token,
        item?.accessToken,
        item?.token
    );
    const idToken = firstNormalizedString(
        sourceCredentials.id_token,
        sourceCredentials.idToken,
        item?.id_token,
        item?.idToken
    );
    const profileToken = idToken || accessToken;

    const accountId = firstNormalizedString(
        sourceCredentials.chatgpt_account_id,
        sourceCredentials.chatgptAccountId,
        sourceCredentials.account_id,
        sourceCredentials.accountId,
        item?.chatgpt_account_id,
        item?.chatgptAccountId,
        item?.account_id,
        item?.accountId,
        extractCodexAccountId(profileToken),
        extractCodexAccountId(accessToken)
    );

    const email = firstNormalizedString(
        sourceCredentials.email,
        item?.email,
        item?.name,
        extractCodexEmail(profileToken),
        extractCodexEmail(accessToken)
    );

    const planType = firstNormalizedString(
        sourceCredentials.chatgpt_plan_type,
        sourceCredentials.chatgptPlanType,
        sourceCredentials.plan_type,
        sourceCredentials.planType,
        item?.chatgpt_plan_type,
        item?.chatgptPlanType,
        item?.plan_type,
        item?.planType,
        extractCodexPlanType(profileToken),
        extractCodexPlanType(accessToken)
    );

    const expiresAt = firstNormalizedString(
        sourceCredentials.expires_at,
        sourceCredentials.expiresAt,
        item?.expires_at,
        item?.expiresAt,
        item?.expired,
        item?.expires,
        extractCodexExpiresAt(profileToken),
        extractCodexExpiresAt(accessToken)
    );

    return {
        accessToken,
        refreshToken: firstNormalizedString(
            sourceCredentials.refresh_token,
            sourceCredentials.refreshToken,
            item?.refresh_token,
            item?.refreshToken,
            item?.rt
        ),
        idToken,
        clientId: firstNormalizedString(
            sourceCredentials.client_id,
            sourceCredentials.clientId,
            item?.client_id,
            item?.clientId
        ),
        accountId,
        userId: firstNormalizedString(
            sourceCredentials.chatgpt_user_id,
            sourceCredentials.chatgptUserId,
            sourceCredentials.user_id,
            sourceCredentials.userId,
            item?.chatgpt_user_id,
            item?.chatgptUserId,
            item?.user_id,
            item?.userId,
            extractCodexUserId(profileToken),
            extractCodexUserId(accessToken),
            sourceCredentials.chatgpt_account_user_id,
            sourceCredentials.chatgptAccountUserId,
            sourceCredentials.account_user_id,
            sourceCredentials.accountUserId,
            item?.chatgpt_account_user_id,
            item?.chatgptAccountUserId,
            item?.account_user_id,
            item?.accountUserId,
            extractCodexAccountUserId(profileToken),
            extractCodexAccountUserId(accessToken)
        ),
        accountUserId: firstNormalizedString(
            sourceCredentials.chatgpt_account_user_id,
            sourceCredentials.chatgptAccountUserId,
            sourceCredentials.account_user_id,
            sourceCredentials.accountUserId,
            item?.chatgpt_account_user_id,
            item?.chatgptAccountUserId,
            item?.account_user_id,
            item?.accountUserId,
            extractCodexAccountUserId(profileToken),
            extractCodexAccountUserId(accessToken)
        ),
        organizationId: firstNormalizedString(
            sourceCredentials.organization_id,
            sourceCredentials.organizationId,
            sourceCredentials.poid,
            item?.organization_id,
            item?.organizationId,
            item?.poid,
            extractCodexOrganizationId(profileToken),
            extractCodexOrganizationId(accessToken)
        ),
        email,
        planType,
        expiresAt,
        lastRefresh: firstNormalizedString(
            sourceCredentials.last_refresh,
            sourceCredentials.lastRefresh,
            item?.last_refresh,
            item?.lastRefresh,
            item?.refreshed_at,
            item?.refreshedAt
        ),
        registeredAt: firstNormalizedString(
            item?.registered_at,
            item?.registeredAt,
            sourceCredentials.registered_at,
            sourceCredentials.registeredAt
        ),
        modelMapping: sourceCredentials.model_mapping || sourceCredentials.modelMapping || item?.model_mapping || item?.modelMapping || null,
        sourceCredentials,
        accountExtra,
        accountName: firstNormalizedString(item?.name),
        accountType: firstNormalizedString(item?.type),
        platform: firstNormalizedString(item?.platform)
    };
}


function sanitizeImportFileTag(fileName) {
    const normalized = normalizeStringField(fileName) || 'anyregister';
    return normalized.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'anyregister';
}

/**
 * 生成 OAuth 授权 URL
 */
export async function handleGenerateAuthUrl(req, res, currentConfig, providerType) {
    try {
        let authUrl = '';
        let authInfo = {};
        
        // 解析 options
        let options = {};
        try {
            options = await getRequestBody(req);
        } catch (e) {
            // 如果没有请求体，使用默认空对象
        }

        // 根据提供商类型生成授权链接并启动回调服务器
        if (providerType === 'gemini-cli-oauth') {
            const result = await handleGeminiCliOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') {
            // 透传实际的 providerType，凭证存到对应类型下
            const result = await handleGeminiAntigravityOAuth(currentConfig, { ...options, actualProviderType: providerType });
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-qwen-oauth') {
            const result = await handleQwenOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-codex') {
            const result = await handleCodexOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-xai-oauth') {
            const result = await startXaiOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'claude-offical') {
            if (options?.sessionKey) {
                const result = await handleClaudeOfficialCookieOAuth(currentConfig, options);
                authUrl = null;
                authInfo = {
                    provider: 'claude-offical',
                    method: 'cookie-auto-oauth',
                    ...result
                };
            } else {
                const result = await handleClaudeOfficialOAuth(currentConfig, options);
                authUrl = result.authUrl;
                authInfo = result.authInfo;
            }
        } else if (providerType === 'claude-kiro-oauth') {
            // Kiro OAuth 支持多种认证方式
            // options.method 可以是: 'google' | 'github' | 'builder-id'
            const result = await handleKiroOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-iflow') {
            // iFlow OAuth 授权
            const result = await handleIFlowOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'claude-orchids-oauth') {
            // Orchids OAuth（手动导入模式）
            const result = await handleOrchidsOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Unsupported provider type: ${providerType}`
                }
            }));
            return true;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            authUrl: authUrl,
            authInfo: authInfo
        }));
        return true;
        
    } catch (error) {
        console.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to generate auth URL: ${error.message}`
            }
        }));
        return true;
    }
}

/**
 * 导入 xAI Grok JSON、API Key、Access Token 或 Refresh Token
 */
export async function handleImportXaiCredentials(req, res) {
    try {
        const body = await getRequestBody(req);
        const result = await importXaiCredentials(body || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to import xAI credentials:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message || 'Failed to import xAI credentials'
        }));
        return true;
    }
}

/**
 * 取消 xAI Device Flow 后台轮询
 */
export async function handleCancelXaiPolling(req, res) {
    try {
        const body = await getRequestBody(req);
        const result = cancelXaiPolling(body?.taskId || null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message || 'Failed to cancel xAI polling'
        }));
        return true;
    }
}

/**
 * Claude Official Cookie 自动授权
 */
export async function handleClaudeOfficialCookieAuth(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        const result = await handleClaudeOfficialCookieOAuth(currentConfig, body || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            data: result
        }));
        return true;
    } catch (error) {
        console.error('[Claude Official Cookie OAuth] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 处理手动 OAuth 回调
 */
export async function handleManualOAuthCallback(req, res) {
    try {
        const body = await getRequestBody(req);
        const { provider, callbackUrl, authMethod, taskId } = body;
        
        if (!provider || !callbackUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'provider and callbackUrl are required'
            }));
            return true;
        }
        
        console.log(`[OAuth Manual Callback] Processing manual callback for ${provider}`);

        if (provider === 'openai-xai-oauth' && authMethod === 'oidc') {
            const result = await completeXaiOidcOAuth(callbackUrl, taskId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Grok Build OIDC callback processed successfully',
                ...result
            }));
            return true;
        }

        if (provider === 'claude-kiro-oauth' && authMethod === 'social') {
            const result = await handleKiroSocialManualCallback(callbackUrl);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Kiro Google OAuth callback processed successfully',
                ...result
            }));
            return true;
        }
        if (provider === 'claude-kiro-oauth' && authMethod === 'builder-id') {
            const url = new URL(callbackUrl);
            if (url.searchParams.get('code')) {
                const result = await handleKiroBuilderIDManualCallback(callbackUrl);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Kiro Builder ID OAuth callback processed successfully',
                    ...result
                }));
                return true;
            }
        }
        
        // 解析回调URL
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const token = url.searchParams.get('token');
        
        if (!code && !token) {
            if ((provider === 'claude-kiro-oauth' && authMethod === 'builder-id') ||
                provider === 'openai-qwen-oauth') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: '设备流无需手动回调，后台正在轮询授权结果'
                }));
                return true;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Callback URL must contain code or token parameter'
            }));
            return true;
        }
        
        // 通过fetch请求本地OAuth回调服务器处理
        // 使用localhost而不是原始hostname，确保请求到达本地服务器
        const localUrl = new URL(callbackUrl);
        localUrl.hostname = 'localhost';
        localUrl.protocol = 'http:';
        
        try {
            const response = await fetch(localUrl.href);
            
            if (response.ok) {
                console.log(`[OAuth Manual Callback] Successfully processed callback for ${provider}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'OAuth callback processed successfully'
                }));
            } else {
                const errorText = await response.text();
                console.error(`[OAuth Manual Callback] Callback processing failed:`, errorText);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Callback processing failed: ${response.status}`
                }));
            }
        } catch (fetchError) {
            console.error(`[OAuth Manual Callback] Failed to process callback:`, fetchError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `Failed to process callback: ${fetchError.message}`
            }));
        }
        
        return true;
    } catch (error) {
        console.error('[OAuth Manual Callback] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 外部手动回调接口（供注册机等外部程序调用）
 * POST /api/codex/external-callback
 * Body: { callbackUrl: "http://localhost:1455/auth/callback?code=xxx&state=xxx" }
 * 无需登录 token，provider 固定为 openai-codex
 */
export async function handleExternalCodexCallback(req, res) {
    // CORS 支持
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
    }

    try {
        const body = await getRequestBody(req);
        const { callbackUrl } = body;

        if (!callbackUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'callbackUrl is required' }));
            return true;
        }

        console.log(`[External Codex Callback] Processing: ${callbackUrl}`);

        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        if (!code) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'callbackUrl must contain code parameter' }));
            return true;
        }

        // 转发到本地回调服务器
        const localUrl = new URL(callbackUrl);
        localUrl.hostname = 'localhost';
        localUrl.protocol = 'http:';

        try {
            const response = await fetch(localUrl.href);
            if (response.ok) {
                console.log(`[External Codex Callback] Success`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Codex OAuth callback processed' }));
            } else {
                const errorText = await response.text();
                console.error(`[External Codex Callback] Failed:`, errorText);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Callback failed: ${response.status}` }));
            }
        } catch (fetchError) {
            console.error(`[External Codex Callback] Fetch error:`, fetchError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `Failed to reach local callback server: ${fetchError.message}`
            }));
        }
        return true;
    } catch (error) {
        console.error('[External Codex Callback] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 导入 AnyRegister 生成的 Codex JSON（access_token 列表）
 */
export async function handleImportCodexAnyRegisterJson(req, res) {
    try {
        const body = await getRequestBody(req);
        const { jsonContent, records, poolId, fileName } = body || {};

        let parsedPayload = null;
        if (typeof jsonContent === 'string') {
            const raw = jsonContent.trim();
            if (!raw) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'jsonContent is empty' }));
                return true;
            }
            if (raw.length > 15 * 1024 * 1024) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'jsonContent too large (max 15MB)' }));
                return true;
            }
            try {
                parsedPayload = JSON.parse(raw);
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Invalid JSON: ${error.message}` }));
                return true;
            }
        } else if (Array.isArray(records) || (records && typeof records === 'object')) {
            parsedPayload = records;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'jsonContent or records is required' }));
            return true;
        }

        const items = normalizeAnyRegisterItems(parsedPayload).filter(item => item && typeof item === 'object');
        if (items.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No valid records found in JSON payload' }));
            return true;
        }

        const codexMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'openai-codex');
        if (!codexMapping) {
            throw new Error('openai-codex provider mapping not found');
        }

        const resolvedPoolId = await resolveImportPoolId('openai-codex', poolId);
        const existingCredentials = await oauthCredentialsDao.findAll({ providerType: 'openai-codex' });
        const existingIdentityKeys = new Set();

        for (const credential of existingCredentials) {
            const accountId = normalizeStringField(
                credential?.credentials?.accountId
                || credential?.credentials?.account_id
                || credential?.credentials?.chatgpt_account_id
            );
            const userId = normalizeStringField(
                credential?.credentials?.userId
                || credential?.credentials?.user_id
                || credential?.credentials?.chatgpt_user_id
                || credential?.credentials?.accountUserId
                || credential?.credentials?.account_user_id
                || credential?.credentials?.chatgpt_account_user_id
            );
            const email = normalizeStringField(credential?.email || credential?.credentials?.email);
            const planType = normalizeStringField(
                credential?.credentials?.planType
                || credential?.credentials?.plan_type
                || credential?.credentials?.chatgpt_plan_type
            );
            const identityKeys = buildCodexImportIdentityKeys({ accountId, userId, email, planType });
            for (const key of identityKeys) {
                existingIdentityKeys.add(key);
            }
        }

        const { broadcastEvent } = await import('../services/ui-manager.js');
        const fileTag = sanitizeImportFileTag(fileName);
        const nowIso = new Date().toISOString();
        const details = [];
        let imported = 0;
        let skipped = 0;
        let failed = 0;
        let noRefreshToken = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
                const normalizedItem = normalizeCodexImportItem(item);
                const accessToken = normalizedItem.accessToken;
                if (!accessToken) {
                    throw new Error('missing access_token');
                }

                const accountId = normalizedItem.accountId;
                const userId = normalizedItem.userId;
                const email = normalizedItem.email;
                const planType = normalizedItem.planType;
                const emailKey = email ? email.toLowerCase() : null;
                const identityKeys = buildCodexImportIdentityKeys({
                    accountId,
                    userId,
                    email,
                    planType
                });
                if (hasAnyCodexImportIdentityKey(existingIdentityKeys, identityKeys)) {
                    skipped++;
                    details.push({
                        index: i + 1,
                        status: 'skipped',
                        accountId: accountId || null,
                        userId: userId || null,
                        email: email || null,
                        planType: planType || null,
                        reason: 'duplicate_account'
                    });
                    continue;
                }

                const refreshToken = normalizedItem.refreshToken || '';
                const expiresAt = normalizedItem.expiresAt;
                const importedLastRefresh = normalizedItem.lastRefresh;
                const idToken = normalizedItem.idToken;
                const credentialsData = {
                    ...normalizedItem.sourceCredentials,
                    accessToken,
                    access_token: accessToken,
                    refreshToken,
                    refresh_token: refreshToken,
                    email: email || null,
                    expiresAt,
                    expires_at: expiresAt,
                    lastRefresh: importedLastRefresh || nowIso,
                    last_refresh: importedLastRefresh || nowIso,
                    type: 'codex',
                    planType: planType || null,
                    plan_type: planType || null,
                    chatgpt_plan_type: planType || null,
                    subscriptionTitle: formatCodexPlanTitle(planType)
                };
                if (accountId) {
                    credentialsData.accountId = accountId;
                    credentialsData.account_id = accountId;
                    credentialsData.chatgpt_account_id = accountId;
                }
                if (idToken) {
                    credentialsData.idToken = idToken;
                    credentialsData.id_token = idToken;
                }
                if (normalizedItem.clientId) {
                    credentialsData.clientId = normalizedItem.clientId;
                    credentialsData.client_id = normalizedItem.clientId;
                }
                if (normalizedItem.userId) {
                    credentialsData.userId = normalizedItem.userId;
                    credentialsData.user_id = normalizedItem.userId;
                    credentialsData.chatgpt_user_id = normalizedItem.userId;
                }
                if (normalizedItem.accountUserId) {
                    credentialsData.accountUserId = normalizedItem.accountUserId;
                    credentialsData.account_user_id = normalizedItem.accountUserId;
                    credentialsData.chatgpt_account_user_id = normalizedItem.accountUserId;
                }
                if (normalizedItem.organizationId) {
                    credentialsData.organizationId = normalizedItem.organizationId;
                    credentialsData.organization_id = normalizedItem.organizationId;
                }
                if (normalizedItem.modelMapping) {
                    credentialsData.modelMapping = normalizedItem.modelMapping;
                    credentialsData.model_mapping = normalizedItem.modelMapping;
                }
                if (normalizedItem.accountExtra) {
                    credentialsData.extra = normalizedItem.accountExtra;
                    credentialsData.account_extra = normalizedItem.accountExtra;
                }
                if (!refreshToken) {
                    noRefreshToken++;
                }

                const identityTag = normalizedItem.userId || accountId || emailKey || `row_${i + 1}`;
                const displayName = `${fileTag}_${String(identityTag).replace(/[^a-zA-Z0-9._@-]+/g, '_')}_${i + 1}.json`;
                const savedCredential = await oauthCredentialsDao.create({
                    provider_type: 'openai-codex',
                    credential_type: 'oauth',
                    credentials: credentialsData,
                    display_name: displayName,
                    email: email || null,
                    pool_id: resolvedPoolId,
                    source: 'import',
                    is_used: true,
                    metadata: {
                        importSource: 'anyregister-json',
                        sourceFile: normalizeStringField(fileName),
                        registeredAt: normalizedItem.registeredAt,
                        accountName: normalizedItem.accountName,
                        accountType: normalizedItem.accountType,
                        platform: normalizedItem.platform,
                        rowIndex: i + 1
                    }
                });

                const credentialRef = formatOAuthCredentialRef('openai-codex', savedCredential.id);
                const providerConfig = createProviderConfig({
                    credPathKey: codexMapping.credPathKey,
                    credPath: credentialRef,
                    credentialId: savedCredential.id,
                    defaultCheckModel: codexMapping.defaultCheckModel,
                    needsProjectId: codexMapping.needsProjectId || false,
                    urlKeys: codexMapping.urlKeys
                });

                if (email) {
                    providerConfig.customName = email;
                }

                await providerDao.create({
                    uuid: providerConfig.uuid,
                    provider_type: 'openai-codex',
                    pool_id: resolvedPoolId,
                    custom_name: email || null,
                    oauth_credential_id: savedCredential.id,
                    credentials: providerConfig,
                    is_healthy: true,
                    is_disabled: false,
                    check_health: true,
                    check_model_name: providerConfig.checkModelName || codexMapping.defaultCheckModel
                });
                await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);

                broadcastEvent('oauth_success', {
                    provider: 'openai-codex',
                    credentialId: savedCredential.id,
                    credentialRef,
                    relativePath: credentialRef,
                    email: email || null,
                    timestamp: new Date().toISOString()
                });

                for (const key of identityKeys) {
                    existingIdentityKeys.add(key);
                }
                imported++;
            } catch (error) {
                const failedItem = normalizeCodexImportItem(item);
                failed++;
                details.push({
                    index: i + 1,
                    status: 'failed',
                    accountId: failedItem.accountId || null,
                    userId: failedItem.userId || null,
                    email: failedItem.email || null,
                    reason: error.message
                });
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            total: items.length,
            imported,
            skipped,
            failed,
            noRefreshToken,
            details
        }));
        return true;
    } catch (error) {
        console.error('[Codex AnyRegister Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 批量导入 Kiro refreshToken（带实时进度 SSE）
 */
export async function handleBatchImportKiroTokens(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshTokens, region, poolId } = body;
        
        if (!refreshTokens || !Array.isArray(refreshTokens) || refreshTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshTokens array is required and must not be empty'
            }));
            return true;
        }
        
        console.log(`[Kiro Batch Import] Starting batch import of ${refreshTokens.length} tokens with SSE...`);
        
        // 设置 SSE 响应头
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        
        // 发送 SSE 事件的辅助函数
        const sendSSE = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        
        // 发送开始事件
        sendSSE('start', { total: refreshTokens.length });
        
        // 执行流式批量导入
        const result = await batchImportKiroRefreshTokensStream(
            refreshTokens,
            region || 'us-east-1',
            (progress) => {
                // 每处理完一个 token 发送进度更新
                sendSSE('progress', progress);
            },
            poolId
        );
        
        console.log(`[Kiro Batch Import] Completed: ${result.success} success, ${result.failed} failed`);
        
        // 发送完成事件
        sendSSE('complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });
        
        res.end();
        return true;
        
    } catch (error) {
        console.error('[Kiro Batch Import] Error:', error);
        // 如果已经开始发送 SSE，则发送错误事件
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 批量导入 Droid refreshToken（带实时进度 SSE）
 */
export async function handleBatchImportDroidTokens(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshTokens, clientId, factoryApiKey, nodeTypes } = body;

        if (!refreshTokens || !Array.isArray(refreshTokens) || refreshTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshTokens array is required and must not be empty'
            }));
            return true;
        }

        console.log(`[Droid Batch Import] Starting batch import of ${refreshTokens.length} tokens with SSE...`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const sendSSE = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        sendSSE('start', { total: refreshTokens.length });

        const result = await batchImportDroidRefreshTokensStream(
            refreshTokens,
            clientId || null,
            factoryApiKey || null,
            nodeTypes || null,
            (progress) => {
                sendSSE('progress', progress);
            }
        );

        console.log(`[Droid Batch Import] Completed: ${result.success} success, ${result.failed} failed`);

        sendSSE('complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });

        res.end();
        return true;

    } catch (error) {
        console.error('[Droid Batch Import] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 批量导入 Warp refreshToken（带实时进度 SSE）
 */
export async function handleBatchImportWarpTokens(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshTokens } = body;

        if (!refreshTokens || !Array.isArray(refreshTokens) || refreshTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshTokens array is required and must not be empty'
            }));
            return true;
        }

        console.log(`[Warp Batch Import] Starting batch import of ${refreshTokens.length} tokens with SSE...`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const sendSSE = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        sendSSE('start', { total: refreshTokens.length });

        const result = await batchImportWarpRefreshTokensStream(
            refreshTokens,
            (progress) => {
                sendSSE('progress', progress);
            }
        );

        console.log(`[Warp Batch Import] Completed: ${result.success} success, ${result.failed} failed`);

        sendSSE('complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });

        res.end();
        return true;

    } catch (error) {
        console.error('[Warp Batch Import] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 导入单个 Droid refreshToken
 */
export async function handleImportDroidToken(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshToken, clientId, factoryApiKey, nodeTypes } = body;

        if (!refreshToken || typeof refreshToken !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshToken is required'
            }));
            return true;
        }

        console.log('[Droid Import] Starting refresh token import...');

        const result = await importDroidRefreshToken(refreshToken, clientId || null, factoryApiKey || null, nodeTypes || null);

        if (result.success) {
            console.log(`[Droid Import] Successfully imported credentials to: ${result.path}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                path: result.path,
                expiresAt: result.expiresAt || null,
                message: 'Droid credentials imported successfully'
            }));
        } else {
            const statusCode = result.error === 'duplicate' ? 409 : 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: result.error,
                existingPath: result.existingPath || null
            }));
        }
        return true;

    } catch (error) {
        console.error('[Droid Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 导入单个 Warp refreshToken
 */
export async function handleImportWarpToken(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshToken } = body;

        if (!refreshToken || typeof refreshToken !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshToken is required'
            }));
            return true;
        }

        console.log('[Warp Import] Starting refresh token import...');

        const result = await importWarpRefreshToken(refreshToken);

        if (result.success) {
            console.log(`[Warp Import] Successfully imported credentials to: ${result.path}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                path: result.path,
                expiresAt: result.expiresAt || null,
                message: 'Warp credentials imported successfully'
            }));
        } else {
            const statusCode = result.error === 'duplicate' ? 409 : 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: result.error,
                existingPath: result.existingPath || null
            }));
        }

        return true;
    } catch (error) {
        console.error('[Warp Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 导入 AWS SSO 凭据用于 Kiro
 */
export async function handleImportAwsCredentials(req, res) {
    try {
        const body = await getRequestBody(req);
        const { credentials, poolId } = body;
        
        if (!credentials || typeof credentials !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'credentials object is required'
            }));
            return true;
        }
        
        console.log('[Kiro AWS Import] Starting Kiro credentials import...');

        const extractedCredentials = extractKiroCredentialsFromPayload(credentials);
        if (extractedCredentials.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'No valid credentials found'
            }));
            return true;
        }

        if (extractedCredentials.length > 1) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Multiple credentials found. Please use batch import for Kiro Account Manager export JSON.'
            }));
            return true;
        }

        const result = await importAwsCredentials(extractedCredentials[0], false, poolId || null);
        
        if (result.success) {
            console.log(`[Kiro AWS Import] Successfully imported credentials to: ${result.path}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                path: result.path,
                message: 'AWS credentials imported successfully'
            }));
        } else {
            // 重复凭据返回 409，字段问题返回 400，其他错误返回 500
            const statusCode = result.error === 'duplicate'
                ? 409
                : (result.error || '').startsWith('Missing required fields')
                    ? 400
                    : 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: result.error,
                existingPath: result.existingPath || null
            }));
        }
        return true;
        
    } catch (error) {
        console.error('[Kiro AWS Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 批量导入 AWS 凭据（支持 amazonq_accounts.txt 格式）
 * 格式: email|password|clientId|clientSecret|refreshToken|accessToken
 */
export async function handleBatchImportAwsCredentials(req, res) {
    try {
        const body = await getRequestBody(req);
        const { credentials: credentialsList, text, poolId } = body;

        let parsedCredentials = [];

        // 支持三种输入方式
        if (text && typeof text === 'string') {
            const trimmed = text.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    parsedCredentials = extractKiroCredentialsFromPayload(JSON.parse(trimmed));
                } catch {
                    parsedCredentials = [];
                }
            }

            if (parsedCredentials.length === 0) {
                // 解析文本格式 (每行一条记录)
                const lines = text.split('\n').filter(line => line.trim());
                for (const line of lines) {
                    const parts = line.split('|');
                    if (parts.length >= 6) {
                        parsedCredentials.push({
                            email: parts[0]?.trim(),
                            password: parts[1]?.trim(),
                            clientId: parts[2]?.trim(),
                            clientSecret: parts[3]?.trim(),
                            refreshToken: parts[4]?.trim(),
                            accessToken: parts[5]?.trim()
                        });
                    } else if (parts.length >= 4) {
                        // 兼容只有4个字段的格式: clientId|clientSecret|refreshToken|accessToken
                        parsedCredentials.push({
                            clientId: parts[0]?.trim(),
                            clientSecret: parts[1]?.trim(),
                            refreshToken: parts[2]?.trim(),
                            accessToken: parts[3]?.trim()
                        });
                    }
                }
            }
        } else if (Array.isArray(credentialsList)) {
            parsedCredentials = extractKiroCredentialsFromPayload(credentialsList);
        } else if (credentialsList && typeof credentialsList === 'object') {
            parsedCredentials = extractKiroCredentialsFromPayload(credentialsList);
        }

        if (parsedCredentials.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'No valid credentials found. Expected Kiro Account Manager JSON or text format: email|password|clientId|clientSecret|refreshToken|accessToken'
            }));
            return true;
        }

        console.log(`[Kiro AWS Batch Import] Starting batch import of ${parsedCredentials.length} credentials...`);

        // 设置 SSE 响应头
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const sendSSE = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        sendSSE('start', { total: parsedCredentials.length });

        const results = { total: parsedCredentials.length, success: 0, failed: 0, details: [] };

        for (let i = 0; i < parsedCredentials.length; i++) {
            const cred = parsedCredentials[i];
            const progressData = { index: i + 1, total: parsedCredentials.length };

            try {
                const result = await importAwsCredentials(cred, false, poolId);

                if (result.success) {
                    results.success++;
                    progressData.current = { index: i + 1, success: true, path: result.path, email: cred.email };
                } else {
                    results.failed++;
                    progressData.current = { index: i + 1, success: false, error: result.error, email: cred.email };
                }
            } catch (err) {
                results.failed++;
                progressData.current = { index: i + 1, success: false, error: err.message, email: cred.email };
            }

            results.details.push(progressData.current);
            sendSSE('progress', { ...progressData, successCount: results.success, failedCount: results.failed });
        }

        console.log(`[Kiro AWS Batch Import] Completed: ${results.success} success, ${results.failed} failed`);

        sendSSE('complete', {
            success: true,
            total: results.total,
            successCount: results.success,
            failedCount: results.failed,
            details: results.details
        });

        res.end();
        return true;

    } catch (error) {
        console.error('[Kiro AWS Batch Import] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return true;
    }
}

/**
 * 导入 Orchids Token
 * 支持三种格式：
 * 1. cookieString 格式 (完整的 Cookie 字符串，包含 __client 和 __session)
 * 2. token 字符串格式 (JWT|rotating_token) - 已废弃
 * 3. credentials 对象格式 (cookies, clerkSessionId, userId, workingDir)
 */
export async function handleImportOrchidsToken(req, res) {
    try {
        const body = await getRequestBody(req);
        const { token, credentials, workingDir, cookieString, email, password } = body;

        // 账号密码登录模式
        if (email && password) {
            console.log('[Orchids Import] Starting email/password sign-in...');

            const result = await importOrchidsWithPassword(email, password);

            if (result.success) {
                console.log(`[Orchids Import] Sign-in success: ${result.email} (${result.sessionId})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    path: result.path,
                    sessionId: result.sessionId,
                    userId: result.userId,
                    email: result.email,
                    verified: result.verified,
                    message: result.message
                }));
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: result.error
                }));
            }
            return true;
        }

        // 新格式：完整的 Cookie 字符串
        if (cookieString && typeof cookieString === 'string') {
            console.log('[Orchids Import] Starting cookie string import...');

            // 解析 Cookie 字符串
            const parsedResult = parseOrchidsCookieString(cookieString);
            if (!parsedResult.success) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: parsedResult.error
                }));
                return true;
            }

            // 保存凭据
            const result = await saveOrchidsCredentials(parsedResult.credentials);

            if (result.success) {
                console.log(`[Orchids Import] Successfully imported credentials to: ${result.path}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    path: result.path,
                    sessionId: result.sessionId,
                    userId: result.userId,
                    message: 'Orchids credentials imported successfully'
                }));
            } else {
                const statusCode = result.error === 'duplicate' ? 409 : 500;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: result.error,
                    existingPath: result.existingPath || null
                }));
            }
            return true;
        }

        // 如果提供了 credentials 对象，直接保存
        if (credentials && typeof credentials === 'object') {
            console.log('[Orchids Import] Starting credentials import...');

            // 验证必需字段
            if (!credentials.cookies && (!credentials.clerkSessionId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'credentials must contain cookies or clerkSessionId'
                }));
                return true;
            }

            // 直接保存凭据
            const result = await saveOrchidsCredentials(credentials);

            if (result.success) {
                console.log(`[Orchids Import] Successfully imported token to: ${result.path}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    path: result.path,
                    sessionId: result.sessionId,
                    userId: result.userId,
                    message: 'Orchids credentials imported successfully'
                }));
            } else {
                const statusCode = result.error === 'duplicate' ? 409 : 500;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: result.error,
                    existingPath: result.existingPath || null
                }));
            }
            return true;
        }

        // 原有的 token 字符串格式
        if (!token || typeof token !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'cookieString, token string or credentials object is required'
            }));
            return true;
        }

        console.log('[Orchids Import] Starting token import...');

        const result = await importOrchidsToken(token, { workingDir });
        
        if (result.success) {
            console.log(`[Orchids Import] Successfully imported token to: ${result.path}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                path: result.path,
                sessionId: result.sessionId,
                userId: result.userId,
                message: 'Orchids token imported successfully'
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: result.error
            }));
        }
        return true;
        
    } catch (error) {
        console.error('[Orchids Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 直接保存 Orchids 凭据（从 UI 表单提交）
 * 吸收 Go demo：提取 clientJwt 后调 Clerk API 验证并补全 sessionId/userId/email
 */
async function saveOrchidsCredentials(credentials) {
    const { broadcastEvent } = await import('../services/ui-manager.js');
    const { createProviderConfig, PROVIDER_MAPPINGS } = await import('../utils/provider-utils.js');
    const providerDaoMod = await import('../dao/provider-dao.js');

    try {
        // 提取 clientJwt：优先用显式字段，否则从 cookies 中提取
        let clientJwt = credentials.clientJwt || null;
        if (!clientJwt && credentials.cookies) {
            const match = credentials.cookies.match(/__client=([^;]+)/);
            if (match && match[1]?.split('.').length === 3) {
                clientJwt = match[1].trim();
            }
        }

        // 调 Clerk API 验证并获取完整信息（参照 Go demo）
        let accountInfo = null;
        if (clientJwt) {
            try {
                const clerkUrl = 'https://clerk.orchids.app/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0';
                const resp = await fetch(clerkUrl, {
                    method: 'GET',
                    headers: {
                        'Cookie': `__client=${clientJwt}`,
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orchids/0.0.57 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36',
                        'Accept-Language': 'zh-CN',
                    },
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const sessions = data?.response?.sessions || [];
                    if (sessions.length > 0) {
                        const session = sessions[0];
                        accountInfo = {
                            sessionId: data.response.last_active_session_id || session.id,
                            userId: session.user?.id || null,
                            email: session.user?.email_addresses?.[0]?.email_address || null,
                        };
                        console.log(`[Orchids Import] Clerk verified: session=${accountInfo.sessionId}, user=${accountInfo.userId}, email=${accountInfo.email}`);
                    }
                }
            } catch (e) {
                console.warn(`[Orchids Import] Clerk verification failed: ${e.message}, using provided values`);
            }
        }

        const credentialsData = {
            clientJwt: clientJwt || null,
            cookies: credentials.cookies || '',
            clerkSessionId: accountInfo?.sessionId || credentials.clerkSessionId || null,
            userId: accountInfo?.userId || credentials.userId || null,
            email: accountInfo?.email || null,
            projectId: '280b7bae-cd29-41e4-a0a6-7f603c43b607',
            importedAt: new Date().toISOString(),
        };

        const displayName = accountInfo?.email
            ? `orchids_${accountInfo.email}.json`
            : `orchids_${Date.now()}.json`;

        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-orchids-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: displayName,
            source: 'import',
            is_used: true,
            metadata: {
                sessionId: credentialsData.clerkSessionId,
                userId: credentialsData.userId,
                email: credentialsData.email,
                verified: !!accountInfo,
            }
        });
        const credentialRef = formatOAuthCredentialRef('claude-orchids-oauth', savedCredential.id);
        console.log(`[Orchids Import] Credentials saved to: ${credentialRef}`);

        // 创建 provider 并 markUsed
        const orchidsMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'claude-orchids-oauth');
        if (orchidsMapping) {
            const providerConfig = createProviderConfig({
                credPathKey: orchidsMapping.credPathKey,
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: orchidsMapping.defaultCheckModel,
                needsProjectId: orchidsMapping.needsProjectId || false,
                urlKeys: orchidsMapping.urlKeys
            });
            await providerDaoMod.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-orchids-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || orchidsMapping.defaultCheckModel
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        }

        broadcastEvent('oauth_success', {
            provider: 'claude-orchids-oauth',
            credentialId: savedCredential.id,
            credentialRef: credentialRef,
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            path: credentialRef,
            sessionId: credentialsData.clerkSessionId,
            userId: credentialsData.userId,
            email: credentialsData.email,
            verified: !!accountInfo,
        };

    } catch (error) {
        console.error('[Orchids Import] Save credentials failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 解析 Orchids Cookie 字符串
 * 从完整的 Cookie 字符串中提取 __client、__session 和 clerkSessionId
 * 支持新版 Clerk（可能没有 __client，只有 __session）
 * @param {string} cookieString - 完整的 Cookie 字符串
 * @returns {Object} 解析结果
 */
function parseOrchidsCookieString(cookieString) {
    try {
        // 提取 __client cookie（核心认证凭据）
        const clientMatch = cookieString.match(/__client=([^;]+)/);
        const clientCookie = clientMatch ? clientMatch[1].trim() : null;

        // 提取 __session cookie（可选）
        let sessionCookie = null;
        const sessionZMatch = cookieString.match(/__session_zF1LqDSA=([^;]+)/);
        const sessionMatch = cookieString.match(/__session=([^;]+)/);

        if (sessionZMatch) {
            sessionCookie = sessionZMatch[1].trim();
        } else if (sessionMatch) {
            sessionCookie = sessionMatch[1].trim();
        }

        // 必须有 __client 或 __session 其中之一
        if (!clientCookie && !sessionCookie) {
            return { success: false, error: 'Cookie 中缺少 __client 或 __session' };
        }

        // 解析 clerkSessionId 和 userId — 先从 __session JWT 本地解析
        let clerkSessionId = null;
        let userId = null;

        if (sessionCookie) {
            try {
                const sessionParts = sessionCookie.split('.');
                if (sessionParts.length === 3) {
                    const payloadBase64 = sessionParts[1].replace(/-/g, '+').replace(/_/g, '/');
                    const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf-8');
                    const payload = JSON.parse(payloadJson);
                    if (payload.sid) clerkSessionId = payload.sid;
                    if (payload.sub) userId = payload.sub;
                }
            } catch (e) {
                console.warn('[Orchids Import] Failed to parse __session JWT:', e.message);
            }
        }

        // 只要有 __client 就可以导入
        if (!clientCookie) {
            return { success: false, error: '无法从 Cookie 中提取 __client' };
        }

        // 构建 cookies 字符串
        const cookieParts = [];
        if (clientCookie) cookieParts.push(`__client=${clientCookie}`);
        if (sessionCookie) cookieParts.push(`__session=${sessionCookie}`);
        const clientUatMatch = cookieString.match(/__client_uat[^=]*=[^;]+/g);
        if (clientUatMatch) cookieParts.push(...clientUatMatch);
        const cookies = cookieParts.join('; ');

        return {
            success: true,
            credentials: {
                cookies: cookies,
                clientJwt: clientCookie,
                clerkSessionId: clerkSessionId,
                userId: userId,
            }
        };

    } catch (error) {
        return { success: false, error: `解析 Cookie 失败: ${error.message}` };
    }
}

async function repairClaudeAntigravityIdentity(credential) {
    if (!credential || credential.provider_type !== 'claude-antigravity') {
        return credential;
    }

    const identityName = String(credential.display_name || credential.email || '').trim();
    if (!identityName) {
        return credential;
    }

    let nextCredential = credential;
    try {
        if ((credential.email || '').trim() !== identityName) {
            const updated = await oauthCredentialsDao.updateEmail(credential.id, identityName);
            if (updated) nextCredential = updated;
        }
    } catch (error) {
        console.warn('[OAuth API] Failed to repair oauth credential email:', error.message);
    }

    try {
        const providers = await providerDao.findAll('claude-antigravity', { includeDeleted: true });
        const linkedProviders = providers.filter(item => Number(item.oauth_credential_id) === Number(credential.id));
        for (const provider of linkedProviders) {
            const currentCredentials = provider?.credentials && typeof provider.credentials === 'object'
                ? provider.credentials
                : {};
            const nextCredentials = {
                ...currentCredentials,
                email: identityName,
                customName: identityName
            };
            await providerDao.update(provider.uuid, {
                custom_name: identityName,
                credentials: nextCredentials
            });
        }
    } catch (error) {
        console.warn('[OAuth API] Failed to repair claude-antigravity providers identity:', error.message);
    }

    return nextCredential;
}


/**
 * 获取OAuth凭据详情
 */
export async function handleGetOAuthCredential(req, res, credentialId) {
    try {
        let credential = await oauthCredentialsDao.findById(credentialId);
        
        if (!credential) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Credential not found" } }));
            return true;
        }

        credential = await repairClaudeAntigravityIdentity(credential);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            success: true,
            credential: credential
        }));
        return true;
    } catch (error) {
        console.error("[OAuth API] Failed to get credential:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 导入 AMI Token (wos-session)
 */
export async function handleImportAmiToken(req, res) {
    try {
        const body = await getRequestBody(req);
        console.log('[AMI Import] Received body:', JSON.stringify(body));
        const { wosSession } = body;

        if (!wosSession || typeof wosSession !== 'string') {
            console.log('[AMI Import] wosSession missing or invalid, body keys:', Object.keys(body || {}));
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'wosSession is required'
            }));
            return true;
        }

        // 验证 wos-session 格式 (Fe26.2* 开头)
        let trimmed = wosSession.trim();

        // 如果用户输入了 wos-session= 前缀，去掉它
        if (trimmed.startsWith('wos-session=')) {
            trimmed = trimmed.substring('wos-session='.length);
        }

        if (!trimmed.startsWith('Fe26.2')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Invalid wos-session format (should start with Fe26.2)'
            }));
            return true;
        }

        console.log('[AMI Import] Starting wos-session import...');

        const result = await saveAmiCredentials(trimmed);

        if (result.success) {
            console.log(`[AMI Import] Successfully imported credentials`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                credentialId: result.credentialId,
                message: 'AMI credentials imported successfully'
            }));
        } else {
            const statusCode = result.error === 'duplicate' ? 409 : 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: result.error
            }));
        }
        return true;

    } catch (error) {
        console.error('[AMI Import] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 保存 AMI 凭据
 */
/**
 * 同步凭证到另一个 Antigravity provider
 * 支持 gemini-antigravity <-> claude-antigravity 互相同步
 */
export async function handleSyncAntigravityCredentials(req, res) {
    try {
        const body = await getRequestBody(req);
        const { sourceProvider, targetProvider, credentialIds, poolId } = body;

        // 校验 provider 类型
        const ALLOWED = ['gemini-antigravity', 'claude-antigravity'];
        if (!ALLOWED.includes(sourceProvider) || !ALLOWED.includes(targetProvider)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '仅支持 gemini-antigravity 和 claude-antigravity 之间同步' }));
            return true;
        }
        if (sourceProvider === targetProvider) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '源和目标不能相同' }));
            return true;
        }

        // 获取源凭证列表
        let sourceCredentials;
        if (credentialIds && Array.isArray(credentialIds) && credentialIds.length > 0) {
            // 同步指定的凭证
            const all = [];
            for (const id of credentialIds) {
                const cred = await oauthCredentialsDao.findById(id);
                if (cred && cred.provider_type === sourceProvider) all.push(cred);
            }
            sourceCredentials = all;
        } else {
            // 同步全部
            sourceCredentials = await oauthCredentialsDao.findAll({ providerType: sourceProvider });
        }

        if (!sourceCredentials || sourceCredentials.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, synced: 0, skipped: 0, message: '没有可同步的凭证' }));
            return true;
        }

        let synced = 0;
        let skipped = 0;
        const details = [];

        for (const src of sourceCredentials) {
            // 按邮箱检查目标是否已存在
            if (src.email) {
                const existing = await oauthCredentialsDao.findByEmail(targetProvider, src.email);
                if (existing) {
                    // 更新令牌
                    await oauthCredentialsDao.updateCredentials(existing.id, src.credentials);
                    skipped++;
                    details.push({ email: src.email, action: 'updated', targetId: existing.id });
                    continue;
                }
            }

            const resolvedPoolId = await resolveImportPoolId(targetProvider, poolId);

            // 创建新凭证
            const saved = await oauthCredentialsDao.create({
                provider_type: targetProvider,
                credential_type: src.credential_type || 'oauth',
                credentials: src.credentials,
                display_name: src.display_name,
                email: src.email,
                subscription_tier: src.subscription_tier,
                pool_id: resolvedPoolId,
                source: 'sync',
                metadata: { syncedFrom: sourceProvider, sourceId: src.id }
            });

            // 直接创建 provider 实例
            const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === targetProvider);
            if (mapping) {
                const credRef = formatOAuthCredentialRef(targetProvider, saved.id);
                const providerConfig = createProviderConfig({
                    credPathKey: mapping.credPathKey,
                    credPath: credRef,
                    credentialId: saved.id,
                    defaultCheckModel: mapping.defaultCheckModel,
                    needsProjectId: mapping.needsProjectId,
                    urlKeys: mapping.urlKeys
                });
                await providerDao.create({
                    uuid: providerConfig.uuid,
                    provider_type: targetProvider,
                    pool_id: resolvedPoolId,
                    custom_name: src.email || src.display_name || null,
                    oauth_credential_id: saved.id,
                    credentials: providerConfig,
                    is_healthy: true,
                    is_disabled: false,
                    usage_count: 0,
                    error_count: 0,
                    check_health: providerConfig.checkHealth || false,
                    check_model_name: mapping.defaultCheckModel || null,
                    not_supported_models: null
                });
                await oauthCredentialsDao.markUsed(saved.id, providerConfig.uuid);
            }

            synced++;
            details.push({ email: src.email, action: 'created', targetId: saved.id });
        }

        console.log(`[Antigravity Sync] ${sourceProvider} -> ${targetProvider}: synced=${synced}, updated=${skipped}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, synced, skipped, details }));
        return true;

    } catch (error) {
        console.error('[Antigravity Sync] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

async function saveAmiCredentials(wosSession) {
    const { broadcastEvent } = await import('../services/ui-manager.js');
    const { createProviderConfig, PROVIDER_MAPPINGS } = await import('../utils/provider-utils.js');
    const providerDaoMod = await import('../dao/provider-dao.js');

    try {
        const credentialsData = {
            AMI_WOS_SESSION: wosSession,
            importedAt: new Date().toISOString()
        };

        console.log('[AMI Import] Creating credential in database...');
        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-ami-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: `ami_${Date.now()}.json`,
            source: 'import',
            is_used: true,
            metadata: {
                importedAt: credentialsData.importedAt
            }
        });
        console.log('[AMI Import] Credential created with id:', savedCredential.id);

        // 直接创建 provider 并 markUsed
        const credentialRef = formatOAuthCredentialRef('claude-ami-oauth', savedCredential.id);
        const amiMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'claude-ami-oauth');
        if (amiMapping) {
            const providerConfig = createProviderConfig({
                credPathKey: amiMapping.credPathKey,
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: amiMapping.defaultCheckModel,
                needsProjectId: amiMapping.needsProjectId || false,
                urlKeys: amiMapping.urlKeys
            });
            await providerDaoMod.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-ami-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || amiMapping.defaultCheckModel
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
            console.log('[AMI Import] Provider created, uuid:', providerConfig.uuid);
        }

        // 广播更新事件
        broadcastEvent('provider-update', {
            type: 'credential-imported',
            provider: 'claude-ami-oauth',
            credentialId: savedCredential.id
        });

        return {
            success: true,
            credentialId: savedCredential.id
        };
    } catch (error) {
        console.error('[AMI Import] Failed to save credentials:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ==================== Codex 批量授权 API ====================

export async function handleCodexBatchStart(req, res, currentConfig) {
    try {
        let options = {};
        try { options = await getRequestBody(req); } catch (e) { /* empty body ok */ }

        const result = await startCodexBatchAuth(currentConfig, options);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}

export async function handleCodexBatchStop(req, res) {
    try {
        const result = await stopCodexBatchAuth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}

export async function handleCodexBatchStatus(req, res) {
    try {
        const result = getCodexBatchStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
    }
}
