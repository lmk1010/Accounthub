import axios from 'axios';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { getProviderModels } from '../provider-models.js';
import { extractCredentialId } from '../../utils/oauth-credentials.js';
import { loadCredentialsFromConfig, loadCredentialsById } from '../../services/oauth-credentials-store.js';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import { withDbLock } from '../../utils/db-lock.js';
import { isRetryableNetworkError } from '../../utils/common.js';
import {
    XAI_CLIENT_ID,
    XAI_CLIENT_IDENTIFIER,
    XAI_CLIENT_MODE,
    XAI_CLIENT_SCOPE,
    XAI_CLIENT_VERSION,
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL,
    XAI_DEVICE_GRANT_TYPE,
    XAI_DISCOVERY_URL,
    XAI_PROVIDER_TYPE
} from './xai-constants.js';
import {
    XAI_DEFAULT_VIDEO_MODEL,
    XAI_IMAGE_MODELS,
    XAI_VIDEO_MODELS,
    canonicalXaiVideoModel
} from './xai-media.js';
import { normalizeResponsesUsage } from '../../utils/token-usage.js';
import { supportsXaiApiAccess } from '../../auth/xai-credential-utils.js';
import {
    getXaiChannelDefaults,
    normalizeXaiUsingApi
} from '../../services/xai-channel-config-cache.js';

export {
    XAI_CLIENT_ID,
    XAI_CLIENT_IDENTIFIER,
    XAI_CLIENT_MODE,
    XAI_CLIENT_SCOPE,
    XAI_CLIENT_VERSION,
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL,
    XAI_DEVICE_GRANT_TYPE,
    XAI_DISCOVERY_URL,
    XAI_PROVIDER_TYPE
} from './xai-constants.js';

const XAI_BILLING_BASE_URL = 'https://cli-chat-proxy.grok.com';
const XAI_BILLING_PATH = '/v1/billing?format=credits';
const XAI_SETTINGS_PATH = '/v1/settings';
const XAI_REFRESH_LEAD_MS = 5 * 60 * 1000;
const XAI_TIER_DISPLAY_NAMES = new Map([
    [0, 'Free'],
    [1, 'SuperGrok'],
    [2, 'X Basic'],
    [3, 'X Premium'],
    [4, 'X Premium+'],
    [5, 'SuperGrok Heavy'],
    [6, 'SuperGrok Lite']
]);
const XAI_MODEL_IDS = getProviderModels(XAI_PROVIDER_TYPE);
const XAI_MODEL_LIST = XAI_MODEL_IDS.map(id => ({
    id,
    object: 'model',
    created: 1773014400,
    owned_by: 'xai'
}));
const XAI_REASONING_EFFORT_MODELS = new Set([
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-multi-agent-0309',
    'grok-3-mini',
    'grok-3-mini-fast'
]);

function parseBooleanLike(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return '';
}

function trimBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function isDefaultApiBaseUrl(value) {
    return trimBaseUrl(value) === XAI_DEFAULT_API_BASE_URL;
}

function cloneJson(value) {
    if (!value || typeof value !== 'object') return {};
    return JSON.parse(JSON.stringify(value));
}

function fallbackXaiModelList() {
    return {
        object: 'list',
        data: XAI_MODEL_LIST.map(model => ({ ...model }))
    };
}

function withBuiltinXaiMediaModels(payload) {
    const normalized = payload && typeof payload === 'object'
        ? cloneJson(payload)
        : { object: 'list', data: [] };
    const data = Array.isArray(normalized.data) ? normalized.data : [];
    const seen = new Set(data.map(model => firstString(model?.id, model?.slug, model?.name)).filter(Boolean));
    const mediaModelIds = new Set([...XAI_IMAGE_MODELS, ...XAI_VIDEO_MODELS]);
    for (const model of XAI_MODEL_LIST.filter(item => mediaModelIds.has(item.id))) {
        if (seen.has(model.id)) continue;
        data.push({ ...model });
        seen.add(model.id);
    }
    normalized.object ||= 'list';
    normalized.data = data;
    return normalized;
}

function normalizeXaiModelListPayload(payload) {
    const rawModels = Array.isArray(payload?.data)
        ? payload.data
        : (Array.isArray(payload?.models) ? payload.models : null);
    if (!rawModels) return null;

    const seen = new Set();
    const data = [];
    for (const rawModel of rawModels) {
        const model = typeof rawModel === 'string'
            ? { id: rawModel }
            : (rawModel && typeof rawModel === 'object' ? cloneJson(rawModel) : null);
        const id = firstString(model?.id, model?.slug, model?.name);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        data.push({
            ...model,
            id,
            object: model.object || 'model',
            owned_by: model.owned_by || model.ownedBy || 'xai'
        });
    }

    return data.length > 0 ? { object: 'list', data } : null;
}

function setHeader(headers, name, value, overwrite = true) {
    const existingKey = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
    if (existingKey && !overwrite) return;
    if (existingKey && existingKey !== name) delete headers[existingKey];
    headers[name] = value;
}

function normalizeFunctionTool(tool, namespaceName = '') {
    if (!tool || typeof tool !== 'object') return null;
    const normalized = cloneJson(tool);
    let type = String(normalized.type || '').trim();

    if (type === 'tool_search' || type === 'image_generation') return null;
    if (type === 'custom') {
        if (normalized.name === 'apply_patch') return null;
        normalized.type = 'function';
        type = 'function';
    }
    if (type === 'function' && normalized.function && typeof normalized.function === 'object') {
        const definition = normalized.function;
        normalized.name ||= definition.name;
        normalized.description ||= definition.description;
        normalized.parameters ||= definition.parameters;
        if (normalized.strict === undefined && definition.strict !== undefined) {
            normalized.strict = definition.strict;
        }
        delete normalized.function;
    }
    if (type === 'web_search') {
        delete normalized.external_web_access;
    }
    if (type === 'function' && (!normalized.parameters || typeof normalized.parameters !== 'object')) {
        normalized.parameters = { type: 'object', properties: {} };
    }
    if (
        type === 'function'
        && String(namespaceName).toLowerCase() === 'codex_app'
        && String(normalized.name).toLowerCase() === 'automation_update'
    ) {
        normalized.parameters = {
            type: 'object',
            properties: {},
            additionalProperties: true
        };
        if (normalized.strict === true) normalized.strict = false;
    }
    return normalized;
}

function normalizeToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    const normalized = cloneJson(toolChoice);
    if (normalized.type === 'function' && normalized.function?.name) {
        normalized.name ||= normalized.function.name;
        delete normalized.function;
    }
    return normalized;
}

function normalizeTools(tools) {
    if (!Array.isArray(tools)) return [];
    const normalized = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        if (tool.type === 'namespace') {
            const namespaceName = String(tool.name || '');
            for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
                const next = normalizeFunctionTool(nested, namespaceName);
                if (next) normalized.push(next);
            }
            continue;
        }
        const next = normalizeFunctionTool(tool);
        if (next) normalized.push(next);
    }
    return normalized;
}

function normalizeInputItems(input) {
    if (!Array.isArray(input)) return input;
    const normalized = [];
    for (const rawItem of input) {
        if (!rawItem || typeof rawItem !== 'object') {
            normalized.push(rawItem);
            continue;
        }
        const item = cloneJson(rawItem);
        const type = String(item.type || '');
        if (type === 'reasoning') {
            if (item.content === null) delete item.content;
            if (item.encrypted_content === null || (typeof item.encrypted_content === 'string' && !item.encrypted_content.trim())) {
                delete item.encrypted_content;
            }
        } else if (type === 'compaction') {
            if (
                item.encrypted_content === null
                || (Object.prototype.hasOwnProperty.call(item, 'encrypted_content') && typeof item.encrypted_content !== 'string')
                || (typeof item.encrypted_content === 'string' && !item.encrypted_content.trim())
            ) {
                continue;
            }
        }
        normalized.push(item);
    }
    return normalized;
}

export function normalizeXaiRequestBody(body, model, stream = true, options = {}) {
    const normalized = cloneJson(body);
    const isCompact = options.isCompact === true;

    normalized.model = model || normalized.model;
    if (options.stripMetadata !== false) {
        delete normalized.metadata;
    }
    delete normalized.previous_response_id;
    delete normalized.prompt_cache_retention;
    delete normalized.safety_identifier;
    delete normalized.stream_options;
    delete normalized.__remote_compact;

    if (Array.isArray(normalized.tools)) {
        normalized.tools = normalizeTools(normalized.tools);
    }
    if (normalized.tool_choice !== undefined) {
        normalized.tool_choice = normalizeToolChoice(normalized.tool_choice);
    }
    if (!Array.isArray(normalized.tools) || normalized.tools.length === 0) {
        delete normalized.tools;
        delete normalized.tool_choice;
        delete normalized.parallel_tool_calls;
    }
    if (Array.isArray(normalized.input)) {
        normalized.input = normalizeInputItems(normalized.input);
    }

    const baseModel = String(normalized.model || '').replace(/^.*\//, '').toLowerCase();
    if (!XAI_REASONING_EFFORT_MODELS.has(baseModel) && normalized.reasoning && typeof normalized.reasoning === 'object') {
        delete normalized.reasoning.effort;
        if (Object.keys(normalized.reasoning).length === 0) delete normalized.reasoning;
    }

    if (isCompact) {
        delete normalized.stream;
        delete normalized.tools;
        delete normalized.tool_choice;
        delete normalized.parallel_tool_calls;
        if (Array.isArray(normalized.input)) {
            normalized.input = normalized.input.filter(item => item?.type !== 'compaction_trigger');
        }
    } else {
        normalized.stream = Boolean(stream);
    }
    return normalized;
}

export function validateXaiOAuthEndpoint(rawUrl, field = 'endpoint') {
    const normalized = String(rawUrl || '').trim();
    if (!normalized) throw new Error(`xAI discovery ${field} is empty`);
    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (error) {
        throw new Error(`xAI discovery ${field} is invalid: ${error.message}`);
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') {
        throw new Error(`xAI discovery ${field} must use HTTPS`);
    }
    if (hostname !== 'x.ai' && !hostname.endsWith('.x.ai')) {
        throw new Error(`xAI discovery ${field} host must be x.ai`);
    }
    return normalized;
}

function decodeJwtClaims(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function resolveExpiryMs(credentials) {
    const raw = credentials?.expired
        ?? credentials?.expiresAt
        ?? credentials?.expires_at
        ?? credentials?.expiry_date
        ?? credentials?.expiryDate;
    if (raw === undefined || raw === null || raw === '') return 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw > 1e12 ? raw : raw * 1000;
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        const numeric = Number(raw.trim());
        return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseRetryAfterMs(headers, fallbackMs = 15000) {
    const value = headers?.['retry-after'];
    if (value !== undefined && value !== null && value !== '') {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
        const dateMs = new Date(value).getTime();
        if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - Date.now());
    }
    return fallbackMs;
}

async function readErrorData(data) {
    if (!data || typeof data.on !== 'function') return data;
    const chunks = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function stringifyErrorData(data) {
    if (typeof data === 'string') return data;
    try {
        return JSON.stringify(data || {});
    } catch {
        return String(data || '');
    }
}

function extractUpstreamErrorMessage(data) {
    if (typeof data === 'string') return data.trim();
    if (!data || typeof data !== 'object') return '';
    if (typeof data.error === 'string') return data.error.trim();
    return firstString(
        data.error?.message,
        data.response?.error?.message,
        data.message,
        Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail
    );
}

export function normalizeXaiResponseEvent(event) {
    if (!event || typeof event !== 'object') return event;
    const normalized = cloneJson(event);
    if (normalized.type === 'response.reasoning_text.delta') {
        normalized.type = 'response.reasoning_summary_text.delta';
        if (normalized.content_index !== undefined && normalized.summary_index === undefined) {
            normalized.summary_index = normalized.content_index;
        }
        delete normalized.content_index;
    } else if (normalized.type === 'response.reasoning_text.done') {
        normalized.type = 'response.reasoning_summary_part.done';
        normalized.part = {
            ...(normalized.part || {}),
            type: 'summary_text',
            text: normalized.text ?? normalized.part?.text ?? ''
        };
        if (normalized.content_index !== undefined && normalized.summary_index === undefined) {
            normalized.summary_index = normalized.content_index;
        }
        delete normalized.content_index;
        delete normalized.text;
    }
    if (normalized.response?.usage) {
        normalized.response.usage = normalizeResponsesUsage(normalized.response.usage);
    }
    if (normalized.usage) {
        normalized.usage = normalizeResponsesUsage(normalized.usage);
    }
    return normalized;
}

async function* parseSseStream(stream, onParsedEvent = null) {
    let buffer = '';
    for await (const chunk of stream) {
        buffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                if (payload === '[DONE]') return;
                continue;
            }
            try {
                const parsed = JSON.parse(payload);
                if (typeof onParsedEvent === 'function') onParsedEvent(parsed);
                yield normalizeXaiResponseEvent(parsed);
            } catch {
                // Ignore non-JSON SSE comments or keepalive payloads.
            }
        }
    }
    const tail = buffer.trim();
    if (tail) {
        const payload = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
        if (payload && payload !== '[DONE]') {
            try {
                const parsed = JSON.parse(payload);
                if (typeof onParsedEvent === 'function') onParsedEvent(parsed);
                yield normalizeXaiResponseEvent(parsed);
            } catch {
                // Upstream closed with a partial event.
            }
        }
    }
}

function resolveXaiSubscriptionTier(credentials = {}) {
    const explicit = firstString(
        credentials.subscription_tier_display,
        credentials.subscriptionTierDisplay,
        credentials.subscription_tier,
        credentials.subscriptionTier
    );
    if (explicit) return explicit;
    const accessToken = firstString(
        credentials.access_token,
        credentials.accessToken,
        credentials.token
    );
    const claims = decodeJwtClaims(accessToken) || {};
    const tier = Number(claims.tier);
    return Number.isInteger(tier)
        ? (XAI_TIER_DISPLAY_NAMES.get(tier) || String(tier))
        : 'Grok OAuth';
}

export class XaiApiService {
    constructor(config = {}) {
        this.config = config;
        this.oauthCredentialId = extractCredentialId(config, 'XAI_OAUTH_CREDS_FILE_PATH');
        this.credentials = {};
        this.accessToken = '';
        this.refreshTokenValue = '';
        this.tokenEndpoint = '';
        this.requestContext = {};
        this.isInitialized = false;
        this.refreshPromise = null;
        this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32, timeout: 120000 });
        this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32, timeout: 120000 });
        this.chatAxios = null;
        this.apiAxios = null;
        this.billingAxios = null;
    }

    setRequestContext(context = {}) {
        this.requestContext = context && typeof context === 'object' ? context : {};
    }

    _createAxios(baseURL, timeout = 120000) {
        const axiosConfig = {
            baseURL,
            timeout,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            headers: { 'Content-Type': 'application/json' }
        };
        if (!(this.config?.USE_SYSTEM_PROXY_XAI ?? false)) {
            axiosConfig.proxy = false;
        }
        configureAxiosProxy(axiosConfig, this.config, XAI_PROVIDER_TYPE);
        return axios.create(axiosConfig);
    }

    async _loadCredentials() {
        if (this.oauthCredentialId) {
            const loaded = await loadCredentialsFromConfig(this.config, 'XAI_OAUTH_CREDS_FILE_PATH', XAI_PROVIDER_TYPE);
            this.oauthCredentialId = loaded.credentialId;
            this._applyCredentials(loaded.credentials);
            return;
        }
        const inline = this.config.XAI_CREDENTIALS && typeof this.config.XAI_CREDENTIALS === 'object'
            ? this.config.XAI_CREDENTIALS
            : this.config;
        this._applyCredentials(inline);
    }

    _applyCredentials(credentials = {}) {
        this.credentials = credentials && typeof credentials === 'object' ? credentials : {};
        this.accessToken = firstString(
            this.credentials.access_token,
            this.credentials.accessToken,
            this.credentials.api_key,
            this.credentials.apiKey,
            this.credentials.token
        );
        this.refreshTokenValue = firstString(this.credentials.refresh_token, this.credentials.refreshToken);
        this.tokenEndpoint = firstString(
            this.credentials.token_endpoint,
            this.credentials.tokenEndpoint,
            this.config.XAI_TOKEN_ENDPOINT
        );
    }

    _isApiKeyAuth() {
        const explicit = this.credentials.using_api ?? this.credentials.usingApi;
        if (explicit !== undefined && explicit !== null && explicit !== '') {
            if (parseBooleanLike(explicit, false)) return true;
        }
        const authKind = firstString(this.credentials.auth_kind, this.credentials.authKind).toLowerCase();
        if (authKind) return authKind !== 'oauth';
        return Boolean(firstString(this.credentials.api_key, this.credentials.apiKey));
    }

    /**
     * Resolve route preference: account config > channel config > auto.
     * Returns '', 'true', or 'false'.
     */
    _resolveUsingApiPreference() {
        const accountPref = normalizeXaiUsingApi(
            this.config?.XAI_USING_API
            ?? this.credentials?.XAI_USING_API
            ?? this.credentials?.xaiUsingApi
        );
        if (accountPref) return accountPref;

        // Channel-level selector is applied asynchronously on initialize / refresh.
        // When available on config it wins over token-scope auto routing.
        const channelPref = normalizeXaiUsingApi(
            this.config?.__XAI_CHANNEL_USING_API
            ?? this.config?.xaiChannelUsingApi
        );
        if (channelPref) return channelPref;

        return '';
    }

    _usingOfficialApi() {
        const explicit = this._resolveUsingApiPreference();
        if (explicit) {
            return parseBooleanLike(explicit, false);
        }
        return this._isApiKeyAuth() || supportsXaiApiAccess(this.credentials);
    }

    async _applyChannelRouteDefaults() {
        try {
            const defaults = await getXaiChannelDefaults();
            const channelPref = normalizeXaiUsingApi(defaults?.XAI_USING_API);
            this.config = {
                ...(this.config || {}),
                __XAI_CHANNEL_USING_API: channelPref
            };
        } catch (error) {
            // Non-fatal: fall back to account/auto routing.
            console.warn('[xAI] Failed to load channel route defaults:', error?.message || error);
        }
    }

    _officialBaseUrl() {
        return trimBaseUrl(
            firstString(
                this.config.XAI_BASE_URL,
                this.credentials.api_base_url,
                this.credentials.apiBaseUrl,
                this.credentials.base_url,
                this.credentials.baseUrl
            ) || XAI_DEFAULT_API_BASE_URL
        );
    }

    _chatBaseUrl() {
        if (this._usingOfficialApi()) return this._officialBaseUrl();
        const configuredChat = firstString(this.config.XAI_CHAT_BASE_URL, this.credentials.chat_base_url, this.credentials.chatBaseUrl);
        if (configuredChat) {
            const normalized = trimBaseUrl(configuredChat);
            if (!isDefaultApiBaseUrl(normalized)) return normalized;
        }
        const credentialBase = firstString(this.credentials.base_url, this.credentials.baseUrl);
        if (credentialBase && !isDefaultApiBaseUrl(credentialBase)) return trimBaseUrl(credentialBase);
        return XAI_DEFAULT_CHAT_BASE_URL;
    }

    _buildGrokCliHeaders(overrides = {}) {
        const headers = {};
        const credentialHeaders = this.credentials.headers;
        if (credentialHeaders && typeof credentialHeaders === 'object' && !Array.isArray(credentialHeaders)) {
            for (const [name, value] of Object.entries(credentialHeaders)) {
                if (typeof value === 'string' && value.trim()) {
                    setHeader(headers, name, value.trim());
                }
            }
        }
        setHeader(headers, 'X-XAI-Token-Auth', 'xai-grok-cli', false);
        setHeader(headers, 'x-authenticateresponse', 'authenticate-response', false);
        setHeader(headers, 'x-grok-client-version', XAI_CLIENT_VERSION, false);
        setHeader(headers, 'x-grok-client-identifier', XAI_CLIENT_IDENTIFIER, false);
        setHeader(headers, 'x-grok-client-mode', XAI_CLIENT_MODE, false);
        const userId = firstString(
            this.credentials.user_id,
            this.credentials.userId,
            this.credentials.principal_id,
            this.credentials.principalId,
            this.credentials.sub,
            this.credentials.subject
        );
        const email = firstString(this.credentials.email);
        if (userId) setHeader(headers, 'x-userid', userId, false);
        if (email) setHeader(headers, 'x-email', email, false);
        setHeader(headers, 'User-Agent', `xai-grok-workspace/${XAI_CLIENT_VERSION}`, false);
        for (const [name, value] of Object.entries(overrides)) {
            if (value !== undefined && value !== null && value !== '') {
                setHeader(headers, name, String(value));
            }
        }
        setHeader(headers, 'Authorization', `Bearer ${this.accessToken}`);
        return headers;
    }

    _buildMediaHeaders(body = {}, context = null, overrides = {}) {
        const baseHeaders = this._usingOfficialApi()
            ? this._buildHeaders(false, body, context, true)
            : this._buildGrokCliHeaders({
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Connection: 'Keep-Alive'
            });
        for (const [name, value] of Object.entries(overrides)) {
            if (value !== undefined && value !== null && value !== '') {
                setHeader(baseHeaders, name, String(value));
            }
        }
        return baseHeaders;
    }

    _buildClients() {
        this.chatAxios = this._createAxios(this._chatBaseUrl());
        this.apiAxios = this._createAxios(this._officialBaseUrl());
        this.billingAxios = this._createAxios(XAI_BILLING_BASE_URL, 30000);
    }

    async initialize() {
        if (this.isInitialized) return;
        await this._loadCredentials();
        await this._applyChannelRouteDefaults();
        if ((!this.accessToken || this.isExpiryDateNear()) && this.refreshTokenValue) {
            await this.refreshToken(false);
        }
        if (!this.accessToken) {
            throw new Error('[xAI] Access token or API key is required');
        }
        this._buildClients();
        this.isInitialized = true;
    }

    isExpiryDateNear(credentials = this.credentials) {
        const expiryMs = resolveExpiryMs(credentials);
        return expiryMs > 0 && expiryMs <= Date.now() + XAI_REFRESH_LEAD_MS;
    }

    async _discoverTokenEndpoint() {
        const client = this._createAxios('', 30000);
        const response = await client.get(XAI_DISCOVERY_URL, { headers: { Accept: 'application/json' } });
        return validateXaiOAuthEndpoint(response.data?.token_endpoint, 'token_endpoint');
    }

    async refreshToken(force = false) {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this._refreshTokenInternal(force).finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }

    async _refreshTokenInternal(force) {
        if (!Object.keys(this.credentials).length) {
            await this._loadCredentials();
        }
        if (!force && this.accessToken && !this.isExpiryDateNear()) return this.credentials;
        if (!this.refreshTokenValue) {
            if (this.accessToken) return this.credentials;
            const error = new Error('[xAI] Refresh token is missing');
            error.code = 'XAI_REFRESH_TOKEN_MISSING';
            throw error;
        }

        const refreshOperation = async () => {
            if (this.oauthCredentialId) {
                const latest = await loadCredentialsById(this.oauthCredentialId);
                if (latest) {
                    this._applyCredentials(latest);
                    if (!force && this.accessToken && !this.isExpiryDateNear()) return latest;
                }
            }

            const endpoint = validateXaiOAuthEndpoint(
                this.tokenEndpoint || await this._discoverTokenEndpoint(),
                'token_endpoint'
            );
            const client = this._createAxios('', 30000);
            const form = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: XAI_CLIENT_ID,
                refresh_token: this.refreshTokenValue
            });
            const principalType = firstString(this.credentials.principal_type, this.credentials.principalType);
            const principalId = firstString(this.credentials.principal_id, this.credentials.principalId);
            if (principalType && principalId) {
                form.set('principal_type', principalType);
                form.set('principal_id', principalId);
            }
            let response;
            try {
                response = await client.post(endpoint, form.toString(), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Accept: 'application/json'
                    }
                });
            } catch (error) {
                if ([400, 401, 403].includes(error.response?.status)) {
                    error.code = 'XAI_REFRESH_TOKEN_DEAD';
                    error.shouldDeleteCredential = true;
                    error.isAuthCredentialIssue = true;
                }
                throw error;
            }

            const tokenData = response.data || {};
            const nextAccessToken = firstString(tokenData.access_token, tokenData.accessToken);
            if (!nextAccessToken) {
                throw new Error('[xAI] Token refresh response missing access_token');
            }
            const now = new Date();
            const expiresIn = Number(tokenData.expires_in ?? tokenData.expiresIn ?? 0);
            const accessClaims = decodeJwtClaims(nextAccessToken) || {};
            const idClaims = decodeJwtClaims(tokenData.id_token || tokenData.idToken) || {};
            const next = {
                ...this.credentials,
                type: 'xai',
                auth_kind: 'oauth',
                access_token: nextAccessToken,
                accessToken: nextAccessToken,
                refresh_token: tokenData.refresh_token || tokenData.refreshToken || this.refreshTokenValue,
                refreshToken: tokenData.refresh_token || tokenData.refreshToken || this.refreshTokenValue,
                token_type: tokenData.token_type || tokenData.tokenType || this.credentials.token_type || 'Bearer',
                tokenType: tokenData.token_type || tokenData.tokenType || this.credentials.tokenType || 'Bearer',
                expires_in: expiresIn || this.credentials.expires_in || null,
                expiresIn: expiresIn || this.credentials.expiresIn || null,
                expired: expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000).toISOString() : this.credentials.expired,
                last_refresh: now.toISOString(),
                lastRefresh: now.toISOString(),
                token_endpoint: endpoint,
                tokenEndpoint: endpoint,
                base_url: this.credentials.base_url || XAI_DEFAULT_API_BASE_URL,
                scope: firstString(tokenData.scope, accessClaims.scope, this.credentials.scope),
                using_api: false,
                email: firstString(idClaims.email, accessClaims.email, this.credentials.email),
                sub: firstString(idClaims.sub, accessClaims.sub, this.credentials.sub),
                user_id: firstString(
                    this.credentials.user_id,
                    this.credentials.userId,
                    accessClaims.principal_id,
                    accessClaims.sub,
                    idClaims.sub
                ),
                principal_type: firstString(accessClaims.principal_type, principalType),
                principal_id: firstString(accessClaims.principal_id, principalId),
                team_id: firstString(accessClaims.team_id, this.credentials.team_id, this.credentials.teamId)
            };
            const idToken = firstString(tokenData.id_token, tokenData.idToken);
            if (idToken) {
                next.id_token = idToken;
                next.idToken = idToken;
            }
            // Keep chat_base_url aligned with the active route preference.
            // Account/channel XAI_USING_API overrides token-scope auto routing.
            this._applyCredentials(next);
            next.chat_base_url = this._usingOfficialApi()
                ? (next.base_url || XAI_DEFAULT_API_BASE_URL)
                : XAI_DEFAULT_CHAT_BASE_URL;
            next.chatBaseUrl = next.chat_base_url;
            if (this.oauthCredentialId) {
                await oauthCredentialsDao.updateCredentials(this.oauthCredentialId, next);
            }
            this._applyCredentials(next);
            if (this.isInitialized) this._buildClients();
            return next;
        };

        if (!this.oauthCredentialId) return refreshOperation();
        return withDbLock(`xai-oauth-refresh:${this.oauthCredentialId}`, 10, refreshOperation);
    }

    async _ensureValidCredentials() {
        if (!this.isInitialized) {
            await this.initialize();
            return;
        }
        if (this.refreshTokenValue && this.isExpiryDateNear()) {
            await this.refreshToken(false);
        }
    }

    _resolveSessionId(body, context) {
        return firstString(
            body?.prompt_cache_key,
            body?.conversation_id,
            context?.sessionId,
            context?.headers?.['x-session-id'],
            context?.headers?.session_id,
            context?.headers?.['x-stainless-session-id'],
            context?.headers?.['x-grok-conv-id'],
            this.requestContext?.sessionId,
            this.requestContext?.headers?.['x-session-id'],
            this.requestContext?.headers?.session_id,
            this.requestContext?.headers?.['x-stainless-session-id'],
            this.requestContext?.headers?.['x-grok-conv-id']
        );
    }

    _buildHeaders(stream, body, context, officialApi = false) {
        const headers = {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            Connection: 'Keep-Alive'
        };
        const sessionId = this._resolveSessionId(body, context);
        if (sessionId) headers['x-grok-conv-id'] = sessionId;
        if (!officialApi && !this._usingOfficialApi() && this._chatBaseUrl() === XAI_DEFAULT_CHAT_BASE_URL) {
            Object.assign(headers, this._buildGrokCliHeaders({
                'Content-Type': 'application/json',
                Accept: stream ? 'text/event-stream' : 'application/json',
                Connection: 'Keep-Alive'
            }));
        }
        return headers;
    }

    async _decorateRequestError(error, data = undefined) {
        const status = error.response?.status || error.status || error.statusCode;
        const responseData = data === undefined ? await readErrorData(error.response?.data) : data;
        const text = stringifyErrorData(responseData).toLowerCase();
        const upstreamMessage = extractUpstreamErrorMessage(responseData);
        error.status = status;
        error.statusCode = status;
        error.upstreamData = responseData;
        error.upstreamHeaders = error.response?.headers || {};
        if (error.response && typeof error.response === 'object') {
            error.response.data = responseData;
        }
        if (upstreamMessage) {
            error.upstreamMessage = upstreamMessage;
            if (/^request failed with status code \d+$/i.test(String(error.message || '').trim())) {
                error.message = upstreamMessage;
            }
        }

        if (status === 400 || status === 422) {
            error.skipErrorCount = true;
            error.shouldSwitchCredential = false;
        } else if (status === 401 || status === 403) {
            error.skipErrorCount = true;
            error.shouldSwitchCredential = true;
            error.isAuthCredentialIssue = true;
            error.shouldDeleteCredential = true;
        } else if (status === 402 || status === 429) {
            const isFreeUsageExhausted = text.includes('free-usage-exhausted') || text.includes('included free usage');
            const delayMs = isFreeUsageExhausted
                ? 24 * 60 * 60 * 1000
                : parseRetryAfterMs(error.response?.headers, status === 402 ? 60 * 60 * 1000 : 15000);
            error.skipErrorCount = true;
            error.shouldSwitchCredential = true;
            error.isQuotaCooldown = true;
            error.quotaResetDelayMs = delayMs;
            error.quotaResetTime = new Date(Date.now() + delayMs).toISOString();
            error.quotaResetFormatted = error.quotaResetTime;
        } else if ((status >= 500 && status < 600) || (!status && isRetryableNetworkError(error))) {
            error.skipErrorCount = true;
            error.shouldSwitchCredential = true;
        }
        return error;
    }

    async *_requestResponsesStream(endpoint, body, context, authRetried = false) {
        await this._ensureValidCredentials();
        const isCompact = endpoint.endsWith('/compact');
        const model = body?.model;
        const prepared = normalizeXaiRequestBody(body, model, !isCompact, {
            isCompact
        });
        if (!isCompact && !prepared.prompt_cache_key) {
            const promptCacheKey = this._resolveSessionId(body, context);
            if (promptCacheKey) {
                prepared.prompt_cache_key = promptCacheKey;
            } else if (String(model || '').startsWith('grok-composer-')) {
                prepared.prompt_cache_key = crypto.randomUUID();
            }
        }
        const headers = this._buildHeaders(!isCompact, prepared, context, false);

        try {
            if (isCompact) {
                const response = await this.chatAxios.post(endpoint, prepared, { headers });
                yield response.data;
                return;
            }
            const response = await this.chatAxios.post(endpoint, prepared, {
                headers,
                responseType: 'stream'
            });
            for await (const event of parseSseStream(response.data, parsedEvent => {
                if (typeof this.config?.XAI_USAGE_OBSERVER !== 'function') return;
                const usage = parsedEvent?.response?.usage || parsedEvent?.usage;
                if (usage) {
                    this.config.XAI_USAGE_OBSERVER(cloneJson(usage), parsedEvent.type);
                }
            })) {
                if (event?.type === 'error' || event?.type === 'response.failed') {
                    const message = event?.error?.message
                        || event?.response?.error?.message
                        || `xAI stream ${event.type}`;
                    const streamError = new Error(message);
                    streamError.response = {
                        status: event?.error?.status || event?.response?.status || 500,
                        data: event,
                        headers: response.headers
                    };
                    throw streamError;
                }
                yield event;
            }
        } catch (error) {
            const status = error.response?.status;
            if ((status === 401 || status === 403) && !authRetried && this.refreshTokenValue) {
                await this.refreshToken(true);
                yield* this._requestResponsesStream(endpoint, body, context, true);
                return;
            }
            throw await this._decorateRequestError(error);
        }
    }

    async generateContent(model, requestBody, requestContext = null) {
        const context = requestContext && typeof requestContext === 'object' ? requestContext : this.requestContext;
        const isCompact = requestBody?.__remote_compact === true;
        const body = { ...(requestBody || {}), model };
        if (isCompact) {
            for await (const response of this._requestResponsesStream('/responses/compact', body, context)) {
                if (response?.response && Array.isArray(response.response.output) && !Array.isArray(response.output)) {
                    return { output: response.response.output };
                }
                return response;
            }
        }

        const outputItems = [];
        for await (const event of this._requestResponsesStream('/responses', body, context)) {
            if (event?.type === 'response.output_item.done' && event.item) {
                outputItems[event.output_index ?? outputItems.length] = event.item;
            }
            if (
                (event?.type === 'response.completed' || event?.type === 'response.incomplete')
                && event.response
            ) {
                const response = cloneJson(event.response);
                if ((!Array.isArray(response.output) || response.output.length === 0) && outputItems.length > 0) {
                    response.output = outputItems.filter(Boolean);
                }
                return response;
            }
        }
        const error = new Error('xAI stream disconnected before response.completed');
        error.status = 504;
        error.statusCode = 504;
        error.skipErrorCount = true;
        error.shouldSwitchCredential = true;
        throw error;
    }

    async *generateContentStream(model, requestBody, requestContext = null) {
        const context = requestContext && typeof requestContext === 'object' ? requestContext : this.requestContext;
        const isCompact = requestBody?.__remote_compact === true;
        const body = { ...(requestBody || {}), model };
        yield* this._requestResponsesStream(isCompact ? '/responses/compact' : '/responses', body, context);
    }

    async _fetchRemoteModels(authRetried = false) {
        await this._ensureValidCredentials();
        const usingOfficialApi = this._usingOfficialApi();
        const client = usingOfficialApi ? this.apiAxios : this.chatAxios;
        const headers = usingOfficialApi
            ? this._buildHeaders(false, {}, null, true)
            : this._buildGrokCliHeaders({ Accept: 'application/json' });

        try {
            const response = await client.get('/models', { headers });
            const normalized = normalizeXaiModelListPayload(response.data);
            if (!normalized) {
                const error = new Error('[xAI] Grok model list response is empty or invalid');
                error.code = 'XAI_INVALID_MODEL_LIST';
                throw error;
            }
            return withBuiltinXaiMediaModels(normalized);
        } catch (error) {
            const status = error.response?.status;
            if ((status === 401 || status === 403) && !authRetried && this.refreshTokenValue) {
                await this.refreshToken(true);
                return this._fetchRemoteModels(true);
            }
            throw await this._decorateRequestError(error);
        }
    }

    async listModels() {
        try {
            return await this._fetchRemoteModels();
        } catch (error) {
            console.warn(`[xAI] Failed to fetch remote model list, using fallback: ${error.message}`);
            return fallbackXaiModelList();
        }
    }

    async listAvailableModels() {
        return this._fetchRemoteModels();
    }

    async generateImage(model, requestBody, requestContext = null, authRetried = false) {
        await this._ensureValidCredentials();
        const body = cloneJson(requestBody);
        const action = body.__image_action === 'edit' ? 'edit' : 'generate';
        delete body.__image_action;
        body.model = model || body.model || 'grok-imagine-image';
        const endpoint = action === 'edit' ? '/images/edits' : '/images/generations';
        const context = requestContext && typeof requestContext === 'object' ? requestContext : this.requestContext;
        const client = this._usingOfficialApi() ? this.apiAxios : this.chatAxios;
        try {
            const response = await client.post(endpoint, body, {
                headers: this._buildMediaHeaders(body, context)
            });
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            if ((status === 401 || status === 403) && !authRetried && this.refreshTokenValue) {
                await this.refreshToken(true);
                return this.generateImage(model, requestBody, requestContext, true);
            }
            throw await this._decorateRequestError(error);
        }
    }

    async generateVideo(model, requestBody, requestContext = null, authRetried = false) {
        await this._ensureValidCredentials();
        const body = cloneJson(requestBody);
        const action = String(body.__video_action || 'generate').trim().toLowerCase();
        const requestId = firstString(body.__video_request_id, body.request_id, body.id);
        delete body.__video_action;
        delete body.__video_request_id;

        const context = requestContext && typeof requestContext === 'object' ? requestContext : this.requestContext;
        let method = 'post';
        let endpoint = '/videos/generations';
        if (action === 'edit') endpoint = '/videos/edits';
        if (action === 'extension' || action === 'extend') endpoint = '/videos/extensions';
        if (action === 'retrieve') {
            if (!requestId) {
                const error = new Error('request_id is required');
                error.status = 400;
                throw error;
            }
            method = 'get';
            endpoint = `/videos/${encodeURIComponent(requestId)}`;
        } else {
            body.model = canonicalXaiVideoModel(model || body.model || XAI_DEFAULT_VIDEO_MODEL);
        }

        const idempotencyKey = firstString(
            context?.headers?.['x-idempotency-key'],
            context?.headers?.['X-Idempotency-Key']
        );
        const headers = this._buildMediaHeaders(body, context, idempotencyKey
            ? { 'x-idempotency-key': idempotencyKey }
            : {});
        const client = this._usingOfficialApi() ? this.apiAxios : this.chatAxios;

        try {
            const response = method === 'get'
                ? await client.get(endpoint, { headers })
                : await client.post(endpoint, body, { headers });
            this._lastMediaUpstreamHeaders = response.headers || {};
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            if ((status === 401 || status === 403) && !authRetried && this.refreshTokenValue) {
                await this.refreshToken(true);
                return this.generateVideo(model, requestBody, requestContext, true);
            }
            const decorated = await this._decorateRequestError(error);
            if (action === 'retrieve' && (status === 403 || status === 404)) {
                decorated.skipErrorCount = true;
                decorated.shouldSwitchCredential = true;
                if (status === 403) {
                    decorated.isAuthCredentialIssue = false;
                    decorated.shouldDeleteCredential = false;
                }
            }
            throw decorated;
        }
    }

    async downloadVideo(videoUrl) {
        await this._ensureValidCredentials();
        let parsed;
        try {
            parsed = new URL(String(videoUrl || '').trim());
        } catch {
            const error = new Error('Invalid video URL');
            error.status = 502;
            throw error;
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
            const error = new Error('Invalid video URL');
            error.status = 502;
            throw error;
        }

        try {
            const response = await this.apiAxios.get(parsed.toString(), {
                headers: { Accept: '*/*' },
                responseType: 'stream',
                timeout: 120000
            });
            return {
                stream: response.data,
                status: response.status,
                headers: response.headers || {}
            };
        } catch (error) {
            throw await this._decorateRequestError(error);
        }
    }

    async getUsageLimits(authRetried = false) {
        await this._ensureValidCredentials();
        if (this._isApiKeyAuth()) {
            const error = new Error('[xAI] Grok billing quota query requires OAuth credentials; API keys are not supported');
            error.code = 'XAI_BILLING_REQUIRES_OAUTH';
            throw error;
        }
        if (this._usingOfficialApi()) {
            const models = await this._fetchRemoteModels();
            return {
                quotaUnavailable: true,
                quotaSource: 'xai-api-oauth',
                quotaMessage: 'xAI OAuth API 可用；官方 API 未提供套餐额度明细',
                apiAccessVerified: true,
                subscriptionTierDisplay: resolveXaiSubscriptionTier(this.credentials),
                account: {
                    email: firstString(this.credentials.email),
                    userId: firstString(
                        this.credentials.user_id,
                        this.credentials.userId,
                        this.credentials.sub,
                        this.credentials.subject
                    ),
                    teamId: firstString(this.credentials.team_id, this.credentials.teamId)
                },
                availableModels: models.data.map(model => model.id)
            };
        }

        try {
            const headers = this._buildGrokCliHeaders({ Accept: 'application/json' });
            const response = await this.billingAxios.get(XAI_BILLING_PATH, {
                headers
            });
            const data = response.data && typeof response.data === 'object'
                ? cloneJson(response.data)
                : {};
            let settings = {};
            try {
                const settingsResponse = await this.billingAxios.get(XAI_SETTINGS_PATH, { headers });
                settings = settingsResponse.data && typeof settingsResponse.data === 'object'
                    ? cloneJson(settingsResponse.data)
                    : {};
            } catch {
                // Billing data is still useful when the optional settings endpoint is unavailable.
            }
            const account = data.account && typeof data.account === 'object'
                ? data.account
                : {};
            return {
                ...data,
                settings,
                subscriptionTierDisplay: firstString(
                    settings.subscription_tier_display,
                    settings.subscriptionTierDisplay,
                    data.subscription_tier_display,
                    data.subscriptionTierDisplay
                ),
                account: {
                    ...account,
                    email: firstString(account.email, this.credentials.email),
                    userId: firstString(account.userId, account.user_id, this.credentials.sub, this.credentials.subject),
                    teamId: firstString(account.teamId, account.team_id, this.credentials.team_id, this.credentials.teamId)
                }
            };
        } catch (error) {
            const status = error.response?.status;
            if ((status === 401 || status === 403) && !authRetried && this.refreshTokenValue) {
                await this.refreshToken(true);
                return this.getUsageLimits(true);
            }
            error.status = status;
            error.statusCode = status;
            const detail = stringifyErrorData(error.response?.data);
            error.message = `[xAI] Grok billing quota query failed${status ? ` (${status})` : ''}${detail && detail !== '{}' ? `: ${detail}` : ''}`;
            throw error;
        }
    }

    dispose() {
        this.httpAgent?.destroy();
        this.httpsAgent?.destroy();
        this.chatAxios = null;
        this.apiAxios = null;
        this.billingAxios = null;
    }
}
