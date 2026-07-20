import {
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL
} from '../providers/openai/xai-constants.js';

export function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return '';
}

export function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
}

export function parseBooleanLike(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

export function decodeJwtClaims(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export function extractXaiScopes(record = {}) {
    const source = isPlainObject(record) ? record : {};
    const accessToken = firstString(
        source.access_token,
        source.accessToken,
        source.bearer_token,
        source.bearerToken,
        source.key
    );
    const claims = decodeJwtClaims(accessToken) || {};
    const scopes = new Set();
    const append = (value) => {
        if (Array.isArray(value)) {
            value.forEach(append);
            return;
        }
        if (typeof value !== 'string') return;
        value
            .split(/[\s,]+/)
            .map(item => item.trim())
            .filter(Boolean)
            .forEach(item => scopes.add(item));
    };
    [
        source.scope,
        source.scopes,
        source.scp,
        claims.scope,
        claims.scopes,
        claims.scp
    ].forEach(append);
    return [...scopes];
}

export function supportsXaiApiAccess(record = {}) {
    return extractXaiScopes(record).includes('api:access');
}

export function normalizeExpiry(value, claims = null, expiresIn = null) {
    if (value !== undefined && value !== null && value !== '') {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return new Date(value > 1e12 ? value : value * 1000).toISOString();
        }
        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
            const numeric = Number(value.trim());
            return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
        }
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    if (Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0) {
        return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
    }
    if (Number.isFinite(Number(claims?.exp)) && Number(claims.exp) > 0) {
        return new Date(Number(claims.exp) * 1000).toISOString();
    }
    return null;
}

export function inferTokenRecord(value) {
    const token = String(value || '').trim();
    if (!token) return null;
    if (token.startsWith('xai-')) {
        return { api_key: token, auth_kind: 'api_key', using_api: true };
    }
    if (decodeJwtClaims(token)) {
        return { access_token: token, auth_kind: 'oauth', using_api: false };
    }
    return { refresh_token: token, auth_kind: 'oauth', using_api: false };
}

export function parseXaiDeliveryLine(value) {
    const line = String(value || '').trim();
    if (!line || !line.includes('----')) return null;
    const parts = line.split('----');
    if (parts.length !== 3) return null;
    const email = parts[0].trim();
    const password = parts[1].trim();
    const sso = parts[2].trim();
    if (!email || !email.includes('@') || !password || !sso) return null;
    return { email, password, sso };
}

function isXaiDeliveryObject(value) {
    if (!isPlainObject(value)) return false;
    const hasOAuthToken = Boolean(firstString(
        value.access_token,
        value.accessToken,
        value.refresh_token,
        value.refreshToken,
        value.api_key,
        value.apiKey,
        value.key
    ));
    return !hasOAuthToken && Boolean(
        firstString(value.email)
        && firstString(value.password)
        && firstString(value.sso, value.sso_cookie, value.ssoCookie)
    );
}

export function extractXaiDeliveryAccounts(value) {
    if (Array.isArray(value)) {
        return value.flatMap(item => extractXaiDeliveryAccounts(item));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return extractXaiDeliveryAccounts(JSON.parse(trimmed));
            } catch {
                // Continue with line-oriented delivery text.
            }
        }
        return trimmed
            .split(/\r?\n/)
            .map(parseXaiDeliveryLine)
            .filter(Boolean);
    }
    if (!isPlainObject(value)) return [];

    if (isXaiDeliveryObject(value)) {
        return [{
            email: firstString(value.email),
            password: firstString(value.password),
            sso: firstString(value.sso, value.sso_cookie, value.ssoCookie)
        }];
    }

    const results = [];
    for (const key of ['accounts', 'items', 'records', 'tokens', 'list', 'data', 'payload']) {
        if (value[key] !== undefined) {
            results.push(...extractXaiDeliveryAccounts(value[key]));
        }
    }
    for (const key of ['tokenText', 'jsonContent']) {
        if (value[key] !== undefined) {
            results.push(...extractXaiDeliveryAccounts(value[key]));
        }
    }
    return results;
}

export function extractImportRecords(value) {
    if (Array.isArray(value)) {
        return value.flatMap(item => extractImportRecords(item));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return extractImportRecords(JSON.parse(trimmed));
            } catch {
                // Treat invalid JSON as one-token-per-line input.
            }
        }
        return trimmed
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => !line.includes('----'))
            .map(line => inferTokenRecord(line))
            .filter(Boolean);
    }
    if (!isPlainObject(value)) return [];

    for (const key of ['accounts', 'items', 'records', 'tokens', 'list']) {
        if (Array.isArray(value[key])) {
            return value[key].flatMap(item => extractImportRecords(item));
        }
    }
    for (const key of ['data', 'payload']) {
        if (Array.isArray(value[key]) || isPlainObject(value[key])) {
            const nested = extractImportRecords(value[key]);
            if (nested.length > 0) return nested;
        }
    }

    const cliAuthEntries = Object.entries(value)
        .filter(([key, entry]) => (
            key.includes('auth.x.ai')
            && isPlainObject(entry)
            && firstString(
                entry.key,
                entry.access_token,
                entry.accessToken,
                entry.refresh_token,
                entry.refreshToken
            )
        ))
        .map(([issuerKey, entry]) => ({ ...entry, issuer_key: issuerKey }));
    if (cliAuthEntries.length > 0) return cliAuthEntries;

    return [value];
}

export function normalizeXaiCredentialRecord(record) {
    if (typeof record === 'string') {
        const inferred = inferTokenRecord(record);
        return inferred ? normalizeXaiCredentialRecord(inferred) : null;
    }
    if (!isPlainObject(record)) return null;

    const nested = isPlainObject(record.credentials) ? record.credentials : {};
    const source = { ...record, ...nested };
    delete source.credentials;

    const authMode = firstString(source.auth_mode, source.authMode).toLowerCase();
    const explicitAuthKind = firstString(source.auth_kind, source.authKind).toLowerCase();
    const bearerToken = firstString(source.bearerToken, source.bearer_token);
    const keyToken = firstString(source.key);
    const genericToken = firstString(source.token);
    let apiKey = firstString(source.api_key, source.apiKey);
    let accessToken = firstString(source.access_token, source.accessToken);
    let refreshToken = firstString(source.refresh_token, source.refreshToken);
    if (bearerToken) {
        accessToken ||= bearerToken;
    }
    if (keyToken) {
        if (
            keyToken.startsWith('xai-')
            || authMode === 'api_key'
            || explicitAuthKind === 'api_key'
        ) {
            apiKey ||= keyToken;
        } else {
            // Grok Build auth.json stores the current bearer access token in `key`.
            accessToken ||= keyToken;
        }
    }
    if (genericToken) {
        const inferred = inferTokenRecord(genericToken);
        apiKey ||= inferred?.api_key || '';
        accessToken ||= inferred?.access_token || '';
        refreshToken ||= inferred?.refresh_token || '';
    }
    if (!apiKey && !accessToken && !refreshToken) return null;

    const idToken = firstString(source.id_token, source.idToken);
    const accessClaims = decodeJwtClaims(accessToken) || {};
    const idClaims = decodeJwtClaims(idToken) || {};
    const claims = { ...accessClaims, ...idClaims };
    const expiryClaims = Object.keys(accessClaims).length > 0 ? accessClaims : idClaims;
    const explicitUsingApi = firstValue(source.using_api, source.usingApi);
    const authKind = explicitAuthKind
        || (authMode === 'oidc' ? 'oauth' : '');
    const usingApi = Boolean(apiKey) || (
        explicitUsingApi !== null
            ? parseBooleanLike(explicitUsingApi, false)
            : Boolean(authKind && authKind !== 'oauth')
    );
    const expiresIn = Number(firstValue(source.expires_in, source.expiresIn));
    const expired = normalizeExpiry(
        firstValue(source.expired, source.expires_at, source.expiresAt, source.expiry_date, source.expiryDate),
        expiryClaims,
        expiresIn
    );
    const nowIso = new Date().toISOString();
    const baseUrl = firstString(source.base_url, source.baseUrl) || XAI_DEFAULT_API_BASE_URL;
    const scopeTokens = extractXaiScopes({
        ...source,
        access_token: accessToken
    });
    const supportsApiAccess = scopeTokens.includes('api:access');
    const configuredChatBaseUrl = firstString(source.chat_base_url, source.chatBaseUrl);
    const normalizedConfiguredChatBaseUrl = configuredChatBaseUrl.replace(/\/+$/, '');
    const shouldReplaceLegacyCliBase = supportsApiAccess
        && normalizedConfiguredChatBaseUrl === XAI_DEFAULT_CHAT_BASE_URL;
    const chatBaseUrl = configuredChatBaseUrl && !shouldReplaceLegacyCliBase
        ? configuredChatBaseUrl
        : ((usingApi || supportsApiAccess) ? baseUrl : XAI_DEFAULT_CHAT_BASE_URL);
    const tokenEndpoint = firstString(source.token_endpoint, source.tokenEndpoint);
    const lastRefresh = firstString(source.last_refresh, source.lastRefresh) || nowIso;
    const normalized = {
        ...source,
        type: 'xai',
        auth_kind: usingApi ? 'api_key' : 'oauth',
        authKind: usingApi ? 'api_key' : 'oauth',
        using_api: usingApi,
        usingApi,
        base_url: baseUrl,
        baseUrl,
        chat_base_url: chatBaseUrl,
        chatBaseUrl,
        email: firstString(source.email, claims.email),
        sub: firstString(
            source.sub,
            source.subject,
            source.user_id,
            source.userId,
            source.principal_id,
            source.principalId,
            claims.sub
        ),
        user_id: firstString(
            source.user_id,
            source.userId,
            source.principal_id,
            source.principalId,
            claims.principal_id,
            claims.sub
        ),
        userId: firstString(
            source.userId,
            source.user_id,
            source.principalId,
            source.principal_id,
            claims.principal_id,
            claims.sub
        ),
        principal_type: firstString(source.principal_type, source.principalType, claims.principal_type),
        principalType: firstString(source.principalType, source.principal_type, claims.principal_type),
        principal_id: firstString(source.principal_id, source.principalId, claims.principal_id),
        principalId: firstString(source.principalId, source.principal_id, claims.principal_id),
        team_id: firstString(source.team_id, source.teamId, claims.team_id),
        teamId: firstString(source.teamId, source.team_id, claims.team_id),
        token_endpoint: tokenEndpoint,
        tokenEndpoint,
        last_refresh: lastRefresh,
        lastRefresh
    };

    if (scopeTokens.length > 0) {
        normalized.scope = scopeTokens.join(' ');
    }
    if (apiKey) {
        normalized.api_key = apiKey;
        normalized.apiKey = apiKey;
        normalized.access_token = apiKey;
        normalized.accessToken = apiKey;
    } else if (accessToken) {
        normalized.access_token = accessToken;
        normalized.accessToken = accessToken;
    }
    if (refreshToken) {
        normalized.refresh_token = refreshToken;
        normalized.refreshToken = refreshToken;
    }
    if (idToken) {
        normalized.id_token = idToken;
        normalized.idToken = idToken;
    }
    if (expired) {
        normalized.expired = expired;
        normalized.expires_at = expired;
        normalized.expiresAt = expired;
    }
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
        normalized.expires_in = expiresIn;
        normalized.expiresIn = expiresIn;
    }
    return normalized;
}

export function normalizeXaiImportPayload(payload) {
    if (typeof payload === 'string') {
        return extractImportRecords(payload)
            .map(normalizeXaiCredentialRecord)
            .filter(Boolean);
    }
    const body = isPlainObject(payload) ? payload : {};
    const sources = [];
    if (body.records !== undefined) sources.push(body.records);
    if (body.jsonContent !== undefined) sources.push(body.jsonContent);
    if (body.tokenText !== undefined) sources.push(body.tokenText);
    if (body.tokens !== undefined) sources.push(body.tokens);
    if (sources.length === 0) sources.push(payload);
    return sources
        .flatMap(source => extractImportRecords(source))
        .map(normalizeXaiCredentialRecord)
        .filter(Boolean);
}
