import { access, readdir } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import Module from 'module';
import axios from 'axios';
import * as providerDao from '../dao/provider-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as channelConfigDao from '../dao/channel-config-dao.js';
import { PROVIDER_MAPPINGS, createProviderConfig } from '../utils/provider-utils.js';
import { formatOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { parseProxyUrl } from '../utils/proxy-utils.js';
import proxyPoolManager from './proxy-pool-manager.js';

const requireFromHere = createRequire(import.meta.url);
const DEFAULT_DUCKMAIL_API_BASE = 'https://api.duckmail.sbs';
const DEFAULT_NATIVE_BUNDLE_DIRS = [
    '/Users/liumingkang/AI/Project/Kiro-auto-register-main/out/main'
];

let runningPromise = null;

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNullableInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIntList(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isFinite(item) && item > 0);
}

function pickFirstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function inferRunnerMode(entryPath = '') {
    const normalizedPath = String(entryPath || '').trim().toLowerCase();
    return normalizedPath.endsWith('.py') ? 'script' : 'native';
}

function normalizeRunnerMode(value, fallback = 'native') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['native', 'protocol', 'js', 'bundle'].includes(normalized)) return 'native';
    if (['script', 'python', 'py', 'legacy'].includes(normalized)) return 'script';
    return fallback;
}

function normalizeSettingsOverrides(overrides = {}) {
    return {
        enabled: pickFirstDefined(overrides.enabled, overrides.codexAutoReplenishEnabled),
        mode: pickFirstDefined(overrides.mode, overrides.codexAutoReplenishMode),
        scriptPath: pickFirstDefined(overrides.scriptPath, overrides.entryPath, overrides.modulePath, overrides.codexAutoReplenishScriptPath),
        pythonBin: pickFirstDefined(overrides.pythonBin, overrides.codexAutoReplenishPythonBin),
        proxy: pickFirstDefined(overrides.proxy, overrides.codexAutoReplenishProxy),
        poolId: pickFirstDefined(overrides.poolId, overrides.codexAutoReplenishPoolId),
        minHealthy: pickFirstDefined(overrides.minHealthy, overrides.threshold, overrides.codexAutoReplenishThreshold, overrides.codexAutoReplenishMinHealthy),
        batchSize: pickFirstDefined(overrides.batchSize, overrides.targetCount, overrides.codexAutoReplenishBatchSize),
        timeoutSeconds: pickFirstDefined(overrides.timeoutSeconds, overrides.codexAutoReplenishTimeoutSeconds),
        useProxyPool: pickFirstDefined(overrides.useProxyPool, overrides.codexAutoReplenishUseProxyPool),
        proxyNodeIds: pickFirstDefined(overrides.proxyNodeIds, overrides.codexAutoReplenishProxyNodeIds),
        duckMailApiBase: pickFirstDefined(overrides.duckMailApiBase, overrides.codexAutoReplenishDuckMailApiBase),
        duckMailApiKey: pickFirstDefined(overrides.duckMailApiKey, overrides.codexAutoReplenishDuckMailApiKey),
        duckMailDomain: pickFirstDefined(overrides.duckMailDomain, overrides.codexAutoReplenishDuckMailDomain)
    };
}

function isEligibleProcess() {
    return process.env.IS_WORKER_PROCESS !== 'true';
}

function normalizeGeneratedCredentials(raw = {}) {
    const accessToken = raw.accessToken || raw.access_token || '';
    const refreshToken = raw.refreshToken || raw.refresh_token || '';
    const accountId = raw.accountId || raw.account_id || '';
    const email = raw.email || '';
    const expiresAt = raw.expiresAt || raw.expires_at || raw.expired || '';
    const lastRefresh = raw.lastRefresh || raw.last_refresh || raw.registered_at || new Date().toISOString();

    return {
        accessToken,
        refreshToken,
        accountId,
        email,
        expiresAt,
        lastRefresh,
        type: 'codex'
    };
}

function extractJsonPayload(stdout = '') {
    const lines = String(stdout)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .reverse();

    for (const line of lines) {
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        try {
            return JSON.parse(line);
        } catch {
            // ignore invalid json line
        }
    }

    throw new Error('未从补号脚本输出中解析到 JSON 凭证');
}

function promiseWithTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(label));
        }, timeoutMs);

        Promise.resolve(promise)
            .then(value => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch(error => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

async function findDefaultNativeBundlePath() {
    for (const dirPath of DEFAULT_NATIVE_BUNDLE_DIRS) {
        try {
            const fileNames = await readdir(dirPath);
            const candidate = fileNames
                .filter(fileName => /^gptRegister-.*\.js$/.test(fileName))
                .sort()
                .pop();
            if (candidate) {
                return path.join(dirPath, candidate);
            }
        } catch {
            // ignore missing directories
        }
    }

    return '';
}

async function resolveRunnerEntryPath(settings) {
    const configuredPath = String(settings.scriptPath || '').trim();
    if (configuredPath) {
        return configuredPath;
    }

    if (settings.mode === 'native') {
        return findDefaultNativeBundlePath();
    }

    return '';
}

function createAxiosLikeFetch(proxy, proxyNode = null) {
    const proxyConfig = proxy ? parseProxyUrl(proxy) : null;
    const sharedAgent = !proxyConfig && proxyNode ? proxyPoolManager.createAgent(proxyNode) : null;

    return async function netFetch(url, options = {}) {
        const requestConfig = {
            url,
            method: options.method || 'GET',
            headers: options.headers || {},
            data: options.body,
            timeout: 30000,
            validateStatus: () => true,
            responseType: 'text'
        };

        if (proxyConfig) {
            requestConfig.httpAgent = proxyConfig.httpAgent;
            requestConfig.httpsAgent = proxyConfig.httpsAgent;
            requestConfig.proxy = false;
        } else if (sharedAgent) {
            requestConfig.httpAgent = sharedAgent;
            requestConfig.httpsAgent = sharedAgent;
            requestConfig.proxy = false;
        }

        const response = await axios(requestConfig);
        const bodyText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            headers: response.headers,
            async json() {
                if (typeof response.data === 'object' && response.data !== null) {
                    return response.data;
                }
                return JSON.parse(bodyText || 'null');
            },
            async text() {
                return bodyText;
            }
        };
    };
}

function clearBundleCache(resolvedBundlePath) {
    const cache = requireFromHere.cache || {};
    const bundleDir = path.dirname(resolvedBundlePath);

    for (const cachePath of Object.keys(cache)) {
        if (!cachePath.startsWith(bundleDir + path.sep)) continue;
        if (!/(gptRegister-|accountHubAuth-|debugSnapshot)/.test(path.basename(cachePath))) continue;
        delete cache[cachePath];
    }
}

function loadNativeRegistrationModule(bundlePath, proxy, proxyNode = null) {
    const resolvedBundlePath = path.resolve(bundlePath);
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') {
            return {
                net: {
                    fetch: createAxiosLikeFetch(proxy, proxyNode)
                }
            };
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        clearBundleCache(resolvedBundlePath);
        const loadedModule = requireFromHere(resolvedBundlePath);
        if (typeof loadedModule.autoRegisterGPTWithProtocol !== 'function') {
            throw new Error('原生补号模块缺少 autoRegisterGPTWithProtocol 导出');
        }
        return loadedModule;
    } finally {
        Module._load = originalLoad;
    }
}

async function runNativeRegistration({ entryPath, proxy, proxyNode, timeoutMs, duckMailConfig }) {
    await access(entryPath);

    const logs = [];
    const log = (message) => {
        const line = String(message || '').trim();
        if (!line) return;
        logs.push(line);
        console.log(`[Codex AutoReplenish Native] ${line}`);
    };

    const nativeModule = loadNativeRegistrationModule(entryPath, proxy, proxyNode);
    const task = nativeModule.autoRegisterGPTWithProtocol({
        apiBase: duckMailConfig.apiBase || DEFAULT_DUCKMAIL_API_BASE,
        apiKey: duckMailConfig.apiKey || undefined,
        domain: duckMailConfig.domain || undefined
    }, log, proxy || undefined, null);

    const result = await promiseWithTimeout(task, timeoutMs, `原生补号执行超时 (${timeoutMs}ms)`);
    if (!result?.success) {
        const logTail = logs.slice(-8).join(' | ');
        throw new Error(`${result?.error || '原生补号失败'}${logTail ? ` | logs=${logTail}` : ''}`);
    }

    if (!result.codexToken) {
        throw new Error('原生补号未返回 codexToken');
    }

    let generated;
    try {
        generated = JSON.parse(result.codexToken);
    } catch (error) {
        throw new Error(`原生补号返回的 codexToken 解析失败: ${error.message}`);
    }

    return {
        mode: 'native',
        entryPath,
        generated,
        email: result.email || generated?.email || null,
        logs: logs.slice(-20)
    };
}

async function runLegacyRegistrationScript({ scriptPath, pythonBin, proxy, timeoutMs }) {
    await access(scriptPath);

    const scriptDir = path.dirname(scriptPath);
    const args = [scriptPath];
    if (proxy) {
        args.push('-p', proxy);
    }

    const generated = await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, args, {
            cwd: scriptDir,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finalize = (error, payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                reject(error);
            } else {
                resolve(payload);
            }
        };

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finalize(new Error(`补号脚本执行超时 (${timeoutMs}ms)`));
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', error => {
            finalize(error);
        });
        child.on('close', code => {
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `退出码 ${code}`;
                finalize(new Error(`补号脚本执行失败: ${message}`));
                return;
            }
            try {
                finalize(null, extractJsonPayload(stdout));
            } catch (error) {
                finalize(new Error(`${error.message} | stdout=${stdout.slice(-400)}`));
            }
        });
    });

    return {
        mode: 'script',
        entryPath: scriptPath,
        generated,
        email: generated?.email || null,
        logs: []
    };
}

async function getHealthyCount(poolId = null) {
    const counts = await providerDao.getTypeCounts('openai-codex', 'all', poolId);
    return Number(counts?.healthyCount) || 0;
}

async function createProviderFromCredential(credential, { poolId = null, customName = null } = {}) {
    const codexMapping = PROVIDER_MAPPINGS.find(item => item.providerType === 'openai-codex');
    if (!codexMapping) {
        throw new Error('未找到 openai-codex 提供商映射');
    }

    const credentialRef = formatOAuthCredentialRef('openai-codex', credential.id);
    const providerConfig = createProviderConfig({
        credPathKey: codexMapping.credPathKey,
        credPath: credentialRef,
        credentialId: credential.id,
        defaultCheckModel: codexMapping.defaultCheckModel,
        needsProjectId: codexMapping.needsProjectId || false,
        urlKeys: codexMapping.urlKeys,
        checkHealthDefault: true
    });

    if (customName) {
        providerConfig.customName = customName;
    }

    const createdProvider = await providerDao.create({
        uuid: providerConfig.uuid,
        provider_type: 'openai-codex',
        pool_id: poolId,
        custom_name: customName,
        oauth_credential_id: credential.id,
        credentials: providerConfig,
        is_healthy: true,
        is_disabled: false,
        usage_count: 0,
        error_count: 0,
        last_used: null,
        last_error_time: null,
        last_error_message: null,
        check_health: true,
        check_model_name: providerConfig.checkModelName || codexMapping.defaultCheckModel,
        not_supported_models: providerConfig.notSupportedModels || null
    });

    await oauthCredentialsDao.markUsed(credential.id, createdProvider.uuid);
    return createdProvider;
}

async function importGeneratedCredential(rawCredential, options = {}) {
    const normalized = normalizeGeneratedCredentials(rawCredential);
    if (!normalized.accessToken) {
        throw new Error('补号流程未返回 access_token');
    }

    const email = String(normalized.email || '').trim() || null;
    const poolId = parseNullableInt(options.poolId);

    if (email) {
        const existing = await oauthCredentialsDao.findByEmail('openai-codex', email);
        if (existing?.is_used) {
            return { status: 'duplicate_used', email, credentialId: existing.id };
        }
        if (existing && !existing.is_used) {
            await createProviderFromCredential(existing, { poolId, customName: email });
            return { status: 'relinked', email, credentialId: existing.id };
        }
    }

    const savedCredential = await oauthCredentialsDao.create({
        provider_type: 'openai-codex',
        credential_type: 'oauth',
        credentials: normalized,
        display_name: email || `codex_auto_${Date.now()}`,
        email,
        pool_id: poolId,
        source: 'auto_replenish',
        is_used: true,
        metadata: {
            autoReplenish: true,
            reason: options.reason || 'unknown',
            entryMode: options.mode || null,
            entryPath: options.entryPath || null,
            proxyNodeId: options.proxyNode?.id || null,
            importedAt: new Date().toISOString()
        }
    });

    await createProviderFromCredential(savedCredential, { poolId, customName: email });
    return { status: 'created', email, credentialId: savedCredential.id };
}

async function loadCodexAutoReplenishSettings(globalConfig = {}, overrides = {}) {
    const normalizedOverrides = normalizeSettingsOverrides(overrides);
    const channelRecord = await channelConfigDao.getByProviderType('openai-codex').catch(() => null);
    const cfg = channelRecord?.config || {};

    const configuredEntryPath = String(
        pickFirstDefined(normalizedOverrides.scriptPath, cfg.codexAutoReplenishScriptPath, globalConfig.CODEX_AUTO_REPLENISH_SCRIPT_PATH) || ''
    ).trim();
    const modeFallback = inferRunnerMode(configuredEntryPath);

    return {
        enabled: parseBoolean(
            pickFirstDefined(normalizedOverrides.enabled, cfg.codexAutoReplenishEnabled, globalConfig.CODEX_AUTO_REPLENISH_ENABLED),
            false
        ),
        mode: normalizeRunnerMode(
            pickFirstDefined(normalizedOverrides.mode, cfg.codexAutoReplenishMode, globalConfig.CODEX_AUTO_REPLENISH_MODE),
            modeFallback
        ),
        scriptPath: configuredEntryPath,
        pythonBin: String(
            pickFirstDefined(normalizedOverrides.pythonBin, cfg.codexAutoReplenishPythonBin, globalConfig.CODEX_AUTO_REPLENISH_PYTHON_BIN, 'python3') || 'python3'
        ).trim(),
        proxy: String(
            pickFirstDefined(normalizedOverrides.proxy, cfg.codexAutoReplenishProxy, globalConfig.CODEX_AUTO_REPLENISH_PROXY) || ''
        ).trim(),
        poolId: parseNullableInt(
            pickFirstDefined(normalizedOverrides.poolId, cfg.codexAutoReplenishPoolId, globalConfig.CODEX_AUTO_REPLENISH_POOL_ID)
        ),
        minHealthy: parsePositiveInt(
            pickFirstDefined(normalizedOverrides.minHealthy, cfg.codexAutoReplenishThreshold, cfg.codexAutoReplenishMinHealthy, globalConfig.CODEX_AUTO_REPLENISH_MIN_HEALTHY),
            50
        ),
        batchSize: parsePositiveInt(
            pickFirstDefined(normalizedOverrides.batchSize, cfg.codexAutoReplenishBatchSize, globalConfig.CODEX_AUTO_REPLENISH_BATCH_SIZE),
            10
        ),
        timeoutSeconds: parsePositiveInt(
            pickFirstDefined(normalizedOverrides.timeoutSeconds, cfg.codexAutoReplenishTimeoutSeconds, globalConfig.CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS),
            180
        ),
        useProxyPool: parseBoolean(
            pickFirstDefined(normalizedOverrides.useProxyPool, cfg.codexAutoReplenishUseProxyPool),
            false
        ),
        proxyNodeIds: normalizeIntList(
            pickFirstDefined(normalizedOverrides.proxyNodeIds, cfg.codexAutoReplenishProxyNodeIds)
        ),
        duckMailApiBase: String(
            pickFirstDefined(normalizedOverrides.duckMailApiBase, cfg.codexAutoReplenishDuckMailApiBase, globalConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE, DEFAULT_DUCKMAIL_API_BASE) || DEFAULT_DUCKMAIL_API_BASE
        ).trim(),
        duckMailApiKey: String(
            pickFirstDefined(normalizedOverrides.duckMailApiKey, cfg.codexAutoReplenishDuckMailApiKey, globalConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY) || ''
        ).trim(),
        duckMailDomain: String(
            pickFirstDefined(normalizedOverrides.duckMailDomain, cfg.codexAutoReplenishDuckMailDomain, globalConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN) || ''
        ).trim()
    };
}

async function resolveAttemptProxy(settings) {
    let proxy = settings.proxy || null;
    let proxyNode = null;

    if (settings.useProxyPool) {
        if (!proxyPoolManager.initialized) {
            await proxyPoolManager.initialize();
        } else {
            await proxyPoolManager.refreshNodes();
        }

        const node = proxyPoolManager.getNextNode(settings.proxyNodeIds);
        if (node) {
            proxy = proxyPoolManager.buildProxyUrl(node);
            proxyNode = {
                id: node.id,
                name: node.name || null,
                protocol: node.protocol || null,
                host: node.host || null,
                port: node.port || null,
                username: node.username || null,
                password: node.password || null,
                config: node.config || null
            };
        }
    }

    return { proxy, proxyNode };
}

export async function ensureCodexAutoReplenish(config = {}, { reason = 'manual', force = false, targetCount = null, settings: settingsOverrides = {} } = {}) {
    if (!isEligibleProcess()) {
        return { skipped: true, reason: 'worker_process' };
    }

    const settings = await loadCodexAutoReplenishSettings(config, settingsOverrides);

    if (!settings.enabled && !force) {
        return { skipped: true, reason: 'disabled' };
    }

    const entryPath = await resolveRunnerEntryPath(settings);
    if (!entryPath) {
        return { skipped: true, reason: settings.mode === 'native' ? 'missing_native_entry' : 'missing_script_path' };
    }

    if (runningPromise) {
        return runningPromise;
    }

    runningPromise = (async () => {
        const poolId = settings.poolId;
        const minHealthy = settings.minHealthy;
        const batchSize = settings.batchSize;
        const timeoutSeconds = settings.timeoutSeconds;
        const timeoutMs = timeoutSeconds * 1000;

        const healthyBefore = await getHealthyCount(poolId);
        if (!force && healthyBefore >= minHealthy) {
            return {
                skipped: true,
                reason: 'enough_accounts',
                poolId,
                healthyBefore,
                minHealthy,
                mode: settings.mode,
                entryPath
            };
        }

        const forcedTargetCount = parsePositiveInt(targetCount, 0);
        const targetCountValue = forcedTargetCount > 0
            ? forcedTargetCount
            : (force ? batchSize : Math.max(1, Math.min(batchSize, minHealthy - healthyBefore)));
        const maxAttempts = Math.max(targetCountValue * 3, targetCountValue);
        const result = {
            skipped: false,
            reason,
            poolId,
            mode: settings.mode,
            entryPath,
            targetCount: targetCountValue,
            healthyBefore,
            healthyAfter: healthyBefore,
            created: 0,
            relinked: 0,
            duplicates: 0,
            failed: 0,
            usedProxyPool: settings.useProxyPool,
            selectedProxyNodeIds: settings.proxyNodeIds,
            errors: [],
            logs: []
        };

        console.log(`[Codex AutoReplenish] Triggered by ${reason}, mode=${settings.mode}, healthy=${healthyBefore}, target=${targetCountValue}, pool=${poolId ?? 'all'}`);

        let attempts = 0;
        while ((result.created + result.relinked) < targetCountValue && attempts < maxAttempts) {
            attempts += 1;
            try {
                const { proxy, proxyNode } = await resolveAttemptProxy(settings);
                const registration = settings.mode === 'script'
                    ? await runLegacyRegistrationScript({
                        scriptPath: entryPath,
                        pythonBin: settings.pythonBin || 'python3',
                        proxy,
                        timeoutMs
                    })
                    : await runNativeRegistration({
                        entryPath,
                        proxy,
                        proxyNode,
                        timeoutMs,
                        duckMailConfig: {
                            apiBase: settings.duckMailApiBase,
                            apiKey: settings.duckMailApiKey,
                            domain: settings.duckMailDomain
                        }
                    });

                if (registration.logs?.length) {
                    result.logs = registration.logs.slice(-20);
                }

                const imported = await importGeneratedCredential(registration.generated, {
                    poolId,
                    reason,
                    mode: registration.mode,
                    entryPath: registration.entryPath,
                    proxyNode
                });

                if (imported.status === 'created') {
                    result.created += 1;
                    console.log(`[Codex AutoReplenish] Imported new credential: ${imported.email || imported.credentialId}`);
                } else if (imported.status === 'relinked') {
                    result.relinked += 1;
                    console.log(`[Codex AutoReplenish] Relinked unused credential: ${imported.email || imported.credentialId}`);
                } else {
                    result.duplicates += 1;
                    console.log(`[Codex AutoReplenish] Duplicate credential skipped: ${imported.email || imported.credentialId}`);
                }
            } catch (error) {
                result.failed += 1;
                result.errors.push(error.message);
                console.error('[Codex AutoReplenish] Registration attempt failed:', error.message);
            }
        }

        result.healthyAfter = await getHealthyCount(poolId);
        console.log(`[Codex AutoReplenish] Completed: mode=${settings.mode}, created=${result.created}, relinked=${result.relinked}, duplicates=${result.duplicates}, failed=${result.failed}, healthy=${result.healthyAfter}`);
        return result;
    })().finally(() => {
        runningPromise = null;
    });

    return runningPromise;
}
