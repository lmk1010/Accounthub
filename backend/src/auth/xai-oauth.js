import axios from 'axios';
import crypto from 'crypto';
import { configureAxiosProxy } from '../utils/proxy-utils.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as providerPoolDao from '../dao/provider-pool-dao.js';
import { broadcastEvent, logEvent } from '../ui-modules/event-broadcast.js';
import { formatOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { createProviderConfig, PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import {
    validateXaiOAuthEndpoint
} from '../providers/openai/xai-core.js';
import {
    XAI_CLIENT_ID,
    XAI_CLIENT_REFERRER,
    XAI_CLIENT_SCOPE,
    XAI_CLIENT_SURFACE,
    XAI_CLIENT_VERSION,
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL,
    XAI_DEVICE_GRANT_TYPE,
    XAI_DISCOVERY_URL,
    XAI_PROVIDER_TYPE
} from '../providers/openai/xai-constants.js';
import {
    decodeJwtClaims,
    extractXaiDeliveryAccounts,
    normalizeExpiry,
    normalizeXaiCredentialRecord,
    normalizeXaiImportPayload,
    supportsXaiApiAccess
} from './xai-credential-utils.js';
import { convertXaiSsoDeliveries } from '../services/xai-sso-import.service.js';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
const OIDC_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const activePollingTasks = new Map();
let credentialPersistenceQueue = Promise.resolve();

function firstString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return '';
}

function sanitizeDisplaySegment(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9@._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function shortTokenHash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function createHttpClient(config = {}) {
    const axiosConfig = {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/json' }
    };
    if (!(config?.USE_SYSTEM_PROXY_XAI ?? false)) {
        axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, config, XAI_PROVIDER_TYPE);
    return axios.create(axiosConfig);
}

export function buildXaiDeviceFlowHeaders(surface = XAI_CLIENT_SURFACE) {
    return {
        'x-grok-client-version': XAI_CLIENT_VERSION,
        'x-grok-client-surface': surface
    };
}

export function buildXaiDeviceCodeParams() {
    return {
        client_id: XAI_CLIENT_ID,
        scope: XAI_CLIENT_SCOPE,
        referrer: XAI_CLIENT_REFERRER
    };
}

async function resolvePoolId(rawPoolId) {
    if (rawPoolId === null || rawPoolId === undefined || rawPoolId === '') return null;
    const normalized = Number.parseInt(rawPoolId, 10);
    if (!Number.isFinite(normalized)) return null;
    if (normalized > 0) return normalized;
    if (normalized !== 0) return null;
    const pools = await providerPoolDao.findByType(XAI_PROVIDER_TYPE);
    const defaultPool = Array.isArray(pools)
        ? pools.find(pool => pool.is_default || pool.isDefault)
        : null;
    const defaultPoolId = Number.parseInt(defaultPool?.id, 10);
    return Number.isFinite(defaultPoolId) && defaultPoolId > 0 ? defaultPoolId : null;
}

export async function discoverXaiOAuth(config = {}) {
    const client = createHttpClient(config);
    const response = await client.get(XAI_DISCOVERY_URL);
    return {
        authorizationEndpoint: validateXaiOAuthEndpoint(
            response.data?.authorization_endpoint,
            'authorization_endpoint'
        ),
        deviceAuthorizationEndpoint: validateXaiOAuthEndpoint(
            response.data?.device_authorization_endpoint,
            'device_authorization_endpoint'
        ),
        tokenEndpoint: validateXaiOAuthEndpoint(
            response.data?.token_endpoint,
            'token_endpoint'
        )
    };
}

async function requestDeviceCode(config, discovery) {
    const client = createHttpClient(config);
    const form = new URLSearchParams(buildXaiDeviceCodeParams());
    const response = await client.post(
        discovery.deviceAuthorizationEndpoint,
        form.toString(),
        {
            headers: {
                ...buildXaiDeviceFlowHeaders(),
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        }
    );
    const payload = response.data || {};
    const deviceCode = firstString(payload.device_code, payload.deviceCode);
    const userCode = firstString(payload.user_code, payload.userCode);
    const verificationUri = firstString(payload.verification_uri, payload.verificationUri);
    const verificationUriComplete = firstString(
        payload.verification_uri_complete,
        payload.verificationUriComplete
    );
    if (!deviceCode) throw new Error('xAI device code response missing device_code');
    if (!userCode) throw new Error('xAI device code response missing user_code');
    if (!verificationUri && !verificationUriComplete) {
        throw new Error('xAI device code response missing verification URI');
    }
    return {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresIn: Number(payload.expires_in ?? payload.expiresIn ?? 0),
        interval: Number(payload.interval ?? 0),
        tokenEndpoint: discovery.tokenEndpoint
    };
}

async function withCredentialPersistenceLock(operation) {
    const previous = credentialPersistenceQueue;
    let release;
    credentialPersistenceQueue = new Promise(resolve => {
        release = resolve;
    });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

export function buildCredentialIdentityKeys(credentials = {}) {
    const keys = [];
    const apiKey = firstString(credentials.api_key, credentials.apiKey);
    const refreshToken = firstString(credentials.refresh_token, credentials.refreshToken);
    const accessToken = firstString(credentials.access_token, credentials.accessToken);
    const email = firstString(credentials.email).toLowerCase();
    const subject = firstString(credentials.sub, credentials.subject);
    if (apiKey) keys.push(`api:${shortTokenHash(apiKey)}`);
    if (refreshToken) keys.push(`refresh:${shortTokenHash(refreshToken)}`);
    if (email) keys.push(`email:${email}`);
    if (subject) keys.push(`sub:${subject}`);
    if (keys.length === 0 && accessToken) keys.push(`access:${shortTokenHash(accessToken)}`);
    return keys;
}

export function findMatchingXaiCredential(credentials = {}, existingCredentials = []) {
    const identityKeys = new Set(buildCredentialIdentityKeys(credentials));
    if (identityKeys.size === 0 || !Array.isArray(existingCredentials)) return null;
    return existingCredentials.find(item => {
        const existing = item?.credentials || item || {};
        return buildCredentialIdentityKeys(existing).some(key => identityKeys.has(key));
    }) || null;
}

async function persistCredential(credentials, options = {}) {
    const mapping = PROVIDER_MAPPINGS.find(item => item.providerType === XAI_PROVIDER_TYPE);
    if (!mapping) throw new Error(`${XAI_PROVIDER_TYPE} provider mapping not found`);
    const resolvedPoolId = await resolvePoolId(options.poolId);
    const identity = firstString(credentials.email, credentials.sub) || shortTokenHash(
        credentials.api_key || credentials.refresh_token || credentials.access_token
    );
    const displayName = `xai-${sanitizeDisplaySegment(identity) || Date.now()}.json`;
    const savedCredential = await oauthCredentialsDao.create({
        provider_type: XAI_PROVIDER_TYPE,
        credential_type: credentials.using_api ? 'api_key' : 'oauth',
        credentials,
        display_name: displayName,
        email: credentials.email || null,
        pool_id: resolvedPoolId,
        source: options.source || 'import',
        is_used: true,
        metadata: {
            importSource: options.importSource || options.source || 'xai',
            sourceFile: options.fileName || null,
            authKind: credentials.auth_kind,
            subject: credentials.sub || null
        }
    });
    const credentialRef = formatOAuthCredentialRef(XAI_PROVIDER_TYPE, savedCredential.id);
    const providerConfig = createProviderConfig({
        credPathKey: mapping.credPathKey,
        credPath: credentialRef,
        credentialId: savedCredential.id,
        defaultCheckModel: mapping.defaultCheckModel,
        needsProjectId: false,
        urlKeys: mapping.urlKeys,
        checkHealthDefault: true
    });
    providerConfig.XAI_BASE_URL = credentials.base_url || XAI_DEFAULT_API_BASE_URL;
    providerConfig.XAI_CHAT_BASE_URL = credentials.chat_base_url
        || ((credentials.using_api || supportsXaiApiAccess(credentials))
            ? XAI_DEFAULT_API_BASE_URL
            : XAI_DEFAULT_CHAT_BASE_URL);
    providerConfig.customName = credentials.email
        || (credentials.using_api ? `xAI API ${identity}` : `Grok ${identity}`);
    await providerDao.create({
        uuid: providerConfig.uuid,
        provider_type: XAI_PROVIDER_TYPE,
        pool_id: resolvedPoolId,
        custom_name: providerConfig.customName,
        oauth_credential_id: savedCredential.id,
        credentials: providerConfig,
        is_healthy: true,
        is_disabled: false,
        check_health: true,
        check_model_name: mapping.defaultCheckModel
    });
    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
    return { savedCredential, providerConfig, credentialRef, resolvedPoolId };
}

async function prepareXaiImport(payload = {}) {
    const directRecords = normalizeXaiImportPayload(payload);
    const deliveryAccounts = extractXaiDeliveryAccounts(payload);
    if (deliveryAccounts.length === 0) {
        return { records: directRecords, conversionFailures: [], converted: 0 };
    }

    const conversion = await convertXaiSsoDeliveries(deliveryAccounts, {
        proxy: payload.proxy,
        converterScriptPath: payload.converterScriptPath,
        pythonCommand: payload.pythonCommand
    });
    const convertedRecords = conversion.records
        .map(normalizeXaiCredentialRecord)
        .filter(Boolean);
    return {
        records: [...directRecords, ...convertedRecords],
        conversionFailures: conversion.failures,
        converted: convertedRecords.length
    };
}

async function importXaiCredentialsUnlocked(payload = {}, prepared = null) {
    const importData = prepared || await prepareXaiImport(payload);
    const records = importData.records;
    const conversionFailures = Array.isArray(importData.conversionFailures)
        ? importData.conversionFailures
        : [];
    if (records.length === 0 && conversionFailures.length === 0) {
        throw new Error('No valid xAI credentials found');
    }
    const existingCredentials = await oauthCredentialsDao.findAll({ providerType: XAI_PROVIDER_TYPE });
    const existingKeys = new Set(
        existingCredentials.flatMap(item => buildCredentialIdentityKeys(item.credentials || {}))
    );
    const details = conversionFailures.map((failure, index) => ({
        index: records.length + index + 1,
        status: 'failed',
        email: failure.email || null,
        authKind: 'sso',
        reason: failure.reason || 'Grok SSO OAuth conversion failed'
    }));
    let imported = 0;
    let skipped = 0;
    let failed = conversionFailures.length;

    for (let index = 0; index < records.length; index += 1) {
        const credentials = records[index];
        const identityKeys = buildCredentialIdentityKeys(credentials);
        try {
            if (identityKeys.some(key => existingKeys.has(key))) {
                skipped += 1;
                details.push({
                    index: index + 1,
                    status: 'skipped',
                    email: credentials.email || null,
                    authKind: credentials.auth_kind,
                    reason: 'duplicate_credential'
                });
                continue;
            }
            const result = await persistCredential(credentials, {
                poolId: payload.poolId,
                source: 'import',
                importSource: 'xai-json-token',
                fileName: payload.fileName
            });
            identityKeys.forEach(key => existingKeys.add(key));
            imported += 1;
            details.push({
                index: index + 1,
                status: 'imported',
                email: credentials.email || null,
                authKind: credentials.auth_kind,
                credentialId: result.savedCredential.id,
                providerUuid: result.providerConfig.uuid
            });
            broadcastEvent('oauth_success', {
                provider: XAI_PROVIDER_TYPE,
                credentialId: result.savedCredential.id,
                credentialRef: result.credentialRef,
                relativePath: result.credentialRef,
                email: credentials.email || null,
                displayName: result.providerConfig.customName,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            failed += 1;
            details.push({
                index: index + 1,
                status: 'failed',
                email: credentials.email || null,
                authKind: credentials.auth_kind,
                reason: error.message
            });
        }
    }
    return {
        success: true,
        total: records.length + conversionFailures.length,
        imported,
        skipped,
        failed,
        converted: Number(importData.converted || 0),
        conversionFailed: conversionFailures.length,
        details
    };
}

export async function importXaiCredentials(payload = {}) {
    const prepared = await prepareXaiImport(payload);
    return withCredentialPersistenceLock(() => importXaiCredentialsUnlocked(payload, prepared));
}

async function exchangeDeviceCode(config, task, intervalMs) {
    const client = createHttpClient(config);
    const form = new URLSearchParams({
        grant_type: XAI_DEVICE_GRANT_TYPE,
        device_code: task.deviceCode,
        client_id: XAI_CLIENT_ID
    });
    try {
        const response = await client.post(task.tokenEndpoint, form.toString(), {
            signal: task.controller.signal,
            headers: {
                ...buildXaiDeviceFlowHeaders(),
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        });
        return { tokenData: response.data || {}, intervalMs, shouldContinue: false };
    } catch (error) {
        if (task.controller.signal.aborted) throw new Error('xAI device authorization cancelled');
        const payload = error.response?.data || {};
        const code = firstString(payload.error);
        if (code === 'authorization_pending') {
            return { tokenData: null, intervalMs, shouldContinue: true };
        }
        if (code === 'slow_down') {
            return {
                tokenData: null,
                intervalMs: intervalMs + DEFAULT_POLL_INTERVAL_MS,
                shouldContinue: true
            };
        }
        if (code === 'expired_token') throw new Error('xAI device code expired');
        if (code === 'access_denied') throw new Error('xAI device authorization denied');
        const description = firstString(payload.error_description, payload.message);
        if (code) {
            throw new Error(`xAI device token error: ${code}${description ? `: ${description}` : ''}`);
        }
        throw error;
    }
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) return;
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('xAI device authorization cancelled'));
        }, { once: true });
    });
}

async function persistXaiOAuthToken(task, tokenData, importSource, successMessage) {
    const accessToken = firstString(tokenData.access_token, tokenData.accessToken);
    if (!accessToken) throw new Error('xAI token response missing access_token');
    const idToken = firstString(tokenData.id_token, tokenData.idToken);
    const accessClaims = decodeJwtClaims(accessToken) || {};
    const idClaims = decodeJwtClaims(idToken) || {};
    const principalType = firstString(accessClaims.principal_type);
    const isTeamPrincipal = principalType.toLowerCase() === 'team';
    if (task.nonce && !isTeamPrincipal) {
        if (!idToken) throw new Error('xAI OIDC token response missing id_token');
        if (firstString(idClaims.nonce) !== task.nonce) {
            throw new Error('xAI OIDC id_token nonce mismatch');
        }
    }
    const expiresIn = Number(tokenData.expires_in ?? tokenData.expiresIn ?? 0);
    const nowIso = new Date().toISOString();
    const credentials = normalizeXaiCredentialRecord({
        access_token: accessToken,
        refresh_token: firstString(tokenData.refresh_token, tokenData.refreshToken),
        id_token: idToken,
        token_type: firstString(tokenData.token_type, tokenData.tokenType) || 'Bearer',
        expires_in: expiresIn,
        expired: normalizeExpiry(null, accessClaims, expiresIn),
        email: firstString(idClaims.email, accessClaims.email),
        sub: firstString(idClaims.sub, accessClaims.sub),
        user_id: firstString(accessClaims.principal_id, accessClaims.sub, idClaims.sub),
        principal_type: principalType,
        principal_id: firstString(accessClaims.principal_id),
        team_id: firstString(accessClaims.team_id),
        last_refresh: nowIso,
        token_endpoint: task.tokenEndpoint,
        scope: firstString(tokenData.scope, accessClaims.scope, XAI_CLIENT_SCOPE),
        base_url: XAI_DEFAULT_API_BASE_URL,
        chat_base_url: XAI_DEFAULT_API_BASE_URL,
        auth_kind: 'oauth',
        using_api: false
    });
    const persistence = await withCredentialPersistenceLock(async () => {
        const existingCredentials = await oauthCredentialsDao.findAll({
            providerType: XAI_PROVIDER_TYPE
        });
        const duplicateCredential = findMatchingXaiCredential(
            credentials,
            existingCredentials
        );
        if (duplicateCredential) {
            const updatedCredentials = normalizeXaiCredentialRecord({
                ...(duplicateCredential.credentials || {}),
                ...credentials
            });
            const updatedCredential = await oauthCredentialsDao.updateCredentials(
                duplicateCredential.id,
                updatedCredentials
            );
            if (
                credentials.email
                && credentials.email !== duplicateCredential.email
            ) {
                await oauthCredentialsDao.updateEmail(
                    duplicateCredential.id,
                    credentials.email
                );
            }
            return {
                duplicate: true,
                savedCredential: {
                    ...(updatedCredential || duplicateCredential),
                    email: credentials.email || duplicateCredential.email || null,
                    credentials: updatedCredentials
                },
                providerConfig: {
                    uuid: duplicateCredential.used_by_uuid || null,
                    customName: duplicateCredential.display_name
                        || credentials.email
                        || 'xAI Grok OAuth'
                },
                credentialRef: formatOAuthCredentialRef(
                    XAI_PROVIDER_TYPE,
                    duplicateCredential.id
                )
            };
        }
        return {
            duplicate: false,
            ...await persistCredential(credentials, {
                poolId: task.poolId,
                source: 'oauth',
                importSource
            })
        };
    });

    broadcastEvent('oauth_success', {
        provider: XAI_PROVIDER_TYPE,
        taskId: task.taskId,
        credentialId: persistence.savedCredential.id,
        credentialRef: persistence.credentialRef,
        relativePath: persistence.credentialRef,
        providerUuid: persistence.providerConfig.uuid,
        email: credentials.email || null,
        displayName: persistence.providerConfig.customName,
        duplicate: persistence.duplicate,
        tokenUpdated: persistence.duplicate,
        timestamp: new Date().toISOString()
    });
    logEvent(persistence.duplicate ? 'xai_oauth_duplicate' : 'xai_oauth_success', {
        email: credentials.email || null,
        taskId: task.taskId,
        credentialId: persistence.savedCredential.id,
        duplicate: persistence.duplicate
    }, {
        level: 'info',
        message: persistence.duplicate
            ? `[xAI OAuth] Existing account token updated${credentials.email ? `: ${credentials.email}` : ''}`
            : `${successMessage}${credentials.email ? `: ${credentials.email}` : ''}`
    });
    return {
        success: true,
        duplicate: persistence.duplicate,
        credentialId: persistence.savedCredential.id,
        credentialRef: persistence.credentialRef,
        providerUuid: persistence.providerConfig.uuid,
        email: credentials.email || null
    };
}

async function pollDeviceAuthorization(config, task) {
    let intervalMs = Math.max(DEFAULT_POLL_INTERVAL_MS, Number(task.interval || 0) * 1000);
    const maxDeadline = Date.now() + MAX_POLL_DURATION_MS;
    const codeDeadline = task.expiresIn > 0
        ? Date.now() + task.expiresIn * 1000
        : maxDeadline;
    const deadline = Math.min(maxDeadline, codeDeadline);
    let firstAttempt = true;

    while (Date.now() <= deadline) {
        if (!firstAttempt) await wait(intervalMs, task.controller.signal);
        firstAttempt = false;
        const result = await exchangeDeviceCode(config, task, intervalMs);
        intervalMs = result.intervalMs;
        if (result.shouldContinue) continue;
        await persistXaiOAuthToken(
            task,
            result.tokenData || {},
            'xai-device-flow',
            '[xAI OAuth] Device authorization succeeded'
        );
        return;
    }
    throw new Error('xAI device code expired');
}

export function buildXaiPkcePair() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    return { codeVerifier, codeChallenge };
}

export function buildXaiAuthorizeUrl(discovery, options = {}) {
    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', XAI_CLIENT_ID);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('scope', XAI_CLIENT_SCOPE);
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', options.state);
    url.searchParams.set('nonce', options.nonce);
    if (options.principalType) {
        url.searchParams.set('principal_type', options.principalType);
    }
    if (options.principalId) {
        url.searchParams.set('principal_id', options.principalId);
    }
    url.searchParams.set('referrer', XAI_CLIENT_REFERRER);
    return url.toString();
}

export async function startXaiOidcOAuth(config = {}, options = {}) {
    const discovery = await discoverXaiOAuth(config);
    const { codeVerifier, codeChallenge } = buildXaiPkcePair();
    const taskId = crypto.randomUUID();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const callbackPort = crypto.randomInt(49152, 65536);
    const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
    const task = {
        taskId,
        flow: 'authorization-code',
        state,
        nonce,
        codeVerifier,
        redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
        poolId: await resolvePoolId(options.poolId),
        expiresAt: Date.now() + OIDC_CALLBACK_TIMEOUT_MS,
        config,
        controller: new AbortController()
    };
    activePollingTasks.set(taskId, task);
    return {
        authUrl: buildXaiAuthorizeUrl(discovery, {
            redirectUri,
            codeChallenge,
            state,
            nonce,
            principalType: firstString(options.principalType, options.principal_type),
            principalId: firstString(options.principalId, options.principal_id)
        }),
        authInfo: {
            provider: XAI_PROVIDER_TYPE,
            authMethod: 'oidc',
            flow: 'authorization-code',
            taskId,
            callbackPort,
            redirectUri,
            expiresIn: Math.floor(OIDC_CALLBACK_TIMEOUT_MS / 1000),
            poolId: task.poolId,
            noCallback: false
        }
    };
}

function parseXaiOidcCallback(callbackInput) {
    const value = firstString(callbackInput);
    if (!value) throw new Error('xAI OIDC callback is required');
    if (!value.includes('://')) {
        return { code: value, state: '', error: '', errorDescription: '' };
    }
    const url = new URL(value);
    return {
        code: firstString(url.searchParams.get('code')),
        state: firstString(url.searchParams.get('state')),
        error: firstString(url.searchParams.get('error')),
        errorDescription: firstString(url.searchParams.get('error_description'))
    };
}

export async function completeXaiOidcOAuth(callbackInput, taskId = null) {
    const callback = parseXaiOidcCallback(callbackInput);
    const task = taskId
        ? activePollingTasks.get(taskId)
        : Array.from(activePollingTasks.values()).find(item => (
            item.flow === 'authorization-code'
            && callback.state
            && item.state === callback.state
        ));
    if (!task || task.flow !== 'authorization-code') {
        throw new Error('xAI OIDC authorization task was not found or has expired');
    }
    if (Date.now() > task.expiresAt) {
        activePollingTasks.delete(task.taskId);
        throw new Error('xAI OIDC authorization expired');
    }
    if (callback.error) {
        throw new Error(
            `xAI OIDC authorization failed: ${callback.error}${callback.errorDescription ? `: ${callback.errorDescription}` : ''}`
        );
    }
    if (!callback.code) {
        throw new Error('xAI OIDC callback must contain code');
    }
    if (callback.state && callback.state !== task.state) {
        throw new Error('xAI OIDC callback state mismatch');
    }

    const client = createHttpClient(task.config);
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.code,
        redirect_uri: task.redirectUri,
        client_id: XAI_CLIENT_ID,
        code_verifier: task.codeVerifier
    });
    let tokenData;
    try {
        const response = await client.post(task.tokenEndpoint, form.toString(), {
            signal: task.controller.signal,
            headers: {
                'x-grok-client-version': XAI_CLIENT_VERSION,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        });
        tokenData = response.data || {};
    } catch (error) {
        const payload = error.response?.data || {};
        const code = firstString(payload.error);
        const description = firstString(payload.error_description, payload.message);
        if (code) {
            throw new Error(`xAI OIDC token exchange failed: ${code}${description ? `: ${description}` : ''}`);
        }
        throw error;
    }

    const result = await persistXaiOAuthToken(
        task,
        tokenData,
        'xai-oidc-pkce',
        '[xAI OAuth] Grok Build OIDC authorization succeeded'
    );
    activePollingTasks.delete(task.taskId);
    return result;
}

export async function startXaiDeviceOAuth(config = {}, options = {}) {
    const discovery = await discoverXaiOAuth(config);
    const device = await requestDeviceCode(config, discovery);
    const taskId = crypto.randomUUID();
    const task = {
        ...device,
        taskId,
        poolId: await resolvePoolId(options.poolId),
        controller: new AbortController()
    };
    activePollingTasks.set(taskId, task);
    pollDeviceAuthorization(config, task)
        .catch(error => {
            if (!task.controller.signal.aborted) {
                console.error('[xAI OAuth] Device authorization failed:', error);
                broadcastEvent('oauth_error', {
                    provider: XAI_PROVIDER_TYPE,
                    taskId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                logEvent('xai_oauth_error', {
                    taskId,
                    error: error.message
                }, {
                    level: 'error',
                    message: `[xAI OAuth] Device authorization failed: ${error.message}`
                });
            }
        })
        .finally(() => {
            activePollingTasks.delete(taskId);
        });

    return {
        authUrl: device.verificationUriComplete || device.verificationUri,
        authInfo: {
            provider: XAI_PROVIDER_TYPE,
            authMethod: 'device-code',
            flow: 'device-code',
            taskId,
            userCode: device.userCode,
            verificationUri: device.verificationUri,
            verificationUriComplete: device.verificationUriComplete,
            expiresIn: device.expiresIn,
            interval: Math.max(DEFAULT_POLL_INTERVAL_MS / 1000, device.interval || 0),
            poolId: task.poolId,
            noCallback: true
        }
    };
}

export function resolveXaiOAuthFlow(options = {}) {
    return options?.flow === 'authorization-code'
        ? 'authorization-code'
        : 'device-code';
}

export async function startXaiOAuth(config = {}, options = {}) {
    if (resolveXaiOAuthFlow(options) === 'authorization-code') {
        return startXaiOidcOAuth(config, options);
    }
    return startXaiDeviceOAuth(config, options);
}

export function cancelXaiPolling(taskId = null) {
    const tasks = taskId
        ? [activePollingTasks.get(taskId)].filter(Boolean)
        : Array.from(activePollingTasks.values());
    tasks.forEach(task => {
        task.controller?.abort();
        activePollingTasks.delete(task.taskId);
    });
    return { success: true, cancelled: tasks.length, taskId: taskId || null };
}
