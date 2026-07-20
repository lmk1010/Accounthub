/**
 * Channel Config API - 渠道配置 API
 */

import * as channelConfigDao from '../dao/channel-config-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import {
    broadcastChannelConfigUpdated,
    clearChannelConfigRuntimeCaches
} from '../services/channel-config-runtime.js';
import { ensureCodexAutoReplenish } from '../services/codex-auto-replenish.service.js';
import { normalizeXaiUsingApi } from '../services/xai-channel-config-cache.js';
import {
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL
} from '../providers/openai/xai-constants.js';

/**
 * Apply Grok route preference to every openai-xai-oauth account.
 * Keeps account-level XAI_USING_API / chat base URLs aligned with the channel switch,
 * so request routing and billing quota both flip together.
 */
async function applyXaiRoutePreferenceToAccounts(routePreference) {
    const normalized = normalizeXaiUsingApi(routePreference);
    const providers = await providerDao.findByType('openai-xai-oauth', { includeDeleted: true });
    let updatedProviders = 0;
    let updatedCredentials = 0;
    const touchedCredentialIds = new Set();

    for (const provider of providers) {
        const credentials = provider.credentials && typeof provider.credentials === 'object'
            ? { ...provider.credentials }
            : {};
        const previous = normalizeXaiUsingApi(
            credentials.XAI_USING_API
            ?? credentials.xaiUsingApi
            ?? credentials.using_api
        );

        credentials.XAI_USING_API = normalized;
        credentials.xaiUsingApi = normalized;

        if (normalized === 'true') {
            credentials.chat_base_url = credentials.base_url || credentials.baseUrl || XAI_DEFAULT_API_BASE_URL;
            credentials.chatBaseUrl = credentials.chat_base_url;
        } else if (normalized === 'false') {
            credentials.chat_base_url = XAI_DEFAULT_CHAT_BASE_URL;
            credentials.chatBaseUrl = XAI_DEFAULT_CHAT_BASE_URL;
        }
        // auto ('') leaves chat_base_url alone so token-scope auto routing can re-resolve.

        const changed = previous !== normalized
            || credentials.XAI_USING_API !== provider.credentials?.XAI_USING_API
            || credentials.chat_base_url !== provider.credentials?.chat_base_url;

        if (changed) {
            await providerDao.update(provider.uuid, { credentials });
            updatedProviders += 1;
        }

        const oauthId = provider.oauth_credential_id || provider.oauthCredentialId || credentials.oauth_credential_id;
        if (oauthId && !touchedCredentialIds.has(String(oauthId))) {
            touchedCredentialIds.add(String(oauthId));
            try {
                const oauthRow = await oauthCredentialsDao.findById(oauthId);
                if (oauthRow?.credentials && typeof oauthRow.credentials === 'object') {
                    const oauthCreds = {
                        ...oauthRow.credentials,
                        XAI_USING_API: normalized,
                        xaiUsingApi: normalized
                    };
                    if (normalized === 'true') {
                        oauthCreds.chat_base_url = oauthCreds.base_url || oauthCreds.baseUrl || XAI_DEFAULT_API_BASE_URL;
                        oauthCreds.chatBaseUrl = oauthCreds.chat_base_url;
                    } else if (normalized === 'false') {
                        oauthCreds.chat_base_url = XAI_DEFAULT_CHAT_BASE_URL;
                        oauthCreds.chatBaseUrl = XAI_DEFAULT_CHAT_BASE_URL;
                    }
                    await oauthCredentialsDao.updateCredentials(oauthId, oauthCreds);
                    updatedCredentials += 1;
                }
            } catch (error) {
                console.warn(`[ChannelConfig] Failed to sync XAI route on oauth credential ${oauthId}:`, error?.message || error);
            }
        }
    }

    return {
        route: normalized || 'auto',
        updatedProviders,
        updatedCredentials,
        totalProviders: providers.length
    };
}

export async function handleRequest(req, res, pathParam, method, body, providerPoolManager = null, currentConfig = {}) {
    const codexReplenishMatch = pathParam.match(/^\/api\/channel-configs\/([^/]+)\/auto-replenish$/);
    if (codexReplenishMatch && method === 'POST') {
        const providerType = decodeURIComponent(codexReplenishMatch[1]);
        if (providerType !== 'openai-codex') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '仅 openai-codex 支持自动补号' } }));
            return true;
        }

        try {
            const payload = body && typeof body === 'object' ? body : {};
            const result = await ensureCodexAutoReplenish(currentConfig, {
                reason: payload.reason || 'manual_ui',
                force: payload.force !== false,
                targetCount: payload.targetCount,
                settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {}
            });

            if (providerPoolManager && typeof providerPoolManager.reload === 'function') {
                await providerPoolManager.reload();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
        }
        return true;
    }

    // GET /api/channel-configs/:providerType
    const typeMatch = pathParam.match(/^\/api\/channel-configs\/(.+)$/);
    if (typeMatch && method === 'GET') {
        const providerType = decodeURIComponent(typeMatch[1]);
        const config = await channelConfigDao.getByProviderType(providerType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ config: config || { providerType, defaultModel: null, config: {} } }));
        return true;
    }

    // PUT /api/channel-configs/:providerType
    if (typeMatch && method === 'PUT') {
        const providerType = decodeURIComponent(typeMatch[1]);
        const payload = body && typeof body === 'object' ? { ...body } : {};
        let xaiRouteApplyResult = null;

        if (providerType === 'openai-xai-oauth') {
            const configObj = payload.config && typeof payload.config === 'object'
                ? { ...payload.config }
                : {};
            const routePref = normalizeXaiUsingApi(
                configObj.XAI_USING_API
                ?? configObj.xaiUsingApi
                ?? payload.XAI_USING_API
            );
            configObj.XAI_USING_API = routePref;
            configObj.xaiUsingApi = routePref;
            payload.config = configObj;

            try {
                xaiRouteApplyResult = await applyXaiRoutePreferenceToAccounts(routePref);
                console.log(
                    `[ChannelConfig] Applied Grok route=${xaiRouteApplyResult.route} `
                    + `to ${xaiRouteApplyResult.updatedProviders}/${xaiRouteApplyResult.totalProviders} accounts`
                );
            } catch (error) {
                console.error('[ChannelConfig] Failed to apply Grok route to accounts:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `应用 Grok 请求路径失败: ${error.message}` } }));
                return true;
            }
        }

        const config = await channelConfigDao.upsert(providerType, payload);

        clearChannelConfigRuntimeCaches(providerType);
        broadcastChannelConfigUpdated(providerType);

        if (providerType === 'openai-xai-oauth' && providerPoolManager && typeof providerPoolManager.reload === 'function') {
            try {
                await providerPoolManager.reload();
            } catch (error) {
                console.warn('[ChannelConfig] provider pool reload after Grok route change failed:', error?.message || error);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            config,
            ...(xaiRouteApplyResult ? { xaiRouteApply: xaiRouteApplyResult } : {})
        }));
        return true;
    }

    // GET /api/channel-configs
    if (pathParam === '/api/channel-configs' && method === 'GET') {
        const configs = await channelConfigDao.getAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configs }));
        return true;
    }

    return false;
}
