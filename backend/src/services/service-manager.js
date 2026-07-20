import { getServiceAdapter, serviceInstances, getServiceInstanceMetrics, deleteServiceInstancesByUuid } from '../providers/adapter.js';
import { ProviderPoolManagerDB } from '../providers/provider-pool-manager-db.js';
import * as providerDao from '../dao/provider-dao.js';
import { ownsUuid, SHARD_ENABLED, SHARD_ID, SHARD_COUNT } from '../utils/shard.js';

import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as channelDispatchLogsDao from '../dao/channel-dispatch-logs-dao.js';
import { getCodexChannelDefaults } from './codex-channel-config-cache.js';
import {
    PROVIDER_MAPPINGS,
    createProviderConfig
} from '../utils/provider-utils.js';
import { formatOAuthCredentialRef } from '../utils/oauth-credentials.js';

/**
 * 浅合并两个对象，用于替代 deepmerge 以提高性能
 * 对于 provider 配置合并场景，浅合并足够使用
 * @param {Object} target - 目标对象
 * @param {Object} source - 源对象
 * @returns {Object} 合并后的新对象
 */
function shallowMerge(target, source) {
    return { ...target, ...source };
}

// 存储 ProviderPoolManager 实例
let providerPoolManager = null;

function buildPoolRejectError(rejectReason = '') {
    const reasonText = String(rejectReason || '').trim();
    const isConcurrencyLimit = /并发|concurrency/i.test(reasonText);

    const err = new Error(
        isConcurrencyLimit
            ? '并发数量超出限制，请稍后重试'
            : '当前算力紧张，请稍后再试'
    );
    err.status = isConcurrencyLimit ? 429 : 400;
    err.statusCode = err.status;
    err.poolRejectReason = reasonText || null;
    err.isConcurrencyLimit = isConcurrencyLimit;
    return err;
}

function normalizeIdentityList(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(/[\s,;，；]+/).map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function getRequestHeader(headers, names = []) {
    if (!headers || typeof headers !== 'object') return null;
    for (const name of names) {
        const value = headers[name] ?? headers[String(name).toLowerCase()];
        if (Array.isArray(value)) {
            const first = value.find(item => String(item || '').trim());
            if (first) return String(first).trim();
        } else if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim();
        }
    }
    return null;
}

function getNewApiUserIdFromContext(requestContext = {}) {
    const direct = requestContext?.userId;
    if (direct !== undefined && direct !== null && String(direct).trim()) {
        return String(direct).trim();
    }
    return getRequestHeader(requestContext?.headers, [
        'x-accounthub-userid',
        'x-accounthub-user-id',
        'x-account-hub-user-id',
        'x-newapi-userid',
        'x-newapi-user-id',
        'x-user-id',
        'x-uid'
    ]);
}

function isUserIdBlacklisted(userId, blacklistedUserIds = []) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) return false;

    const blacklist = new Set(normalizeIdentityList(blacklistedUserIds));
    return blacklist.has(normalizedUserId)
        || blacklist.has(`user:${normalizedUserId}`)
        || blacklist.has(`userid:${normalizedUserId}`)
        || blacklist.has(`userId:${normalizedUserId}`);
}

async function rejectBlacklistedNewApiUser(config, requestedModel, requestContext) {
    if (config?.MODEL_PROVIDER !== 'openai-codex') return;

    const userId = getNewApiUserIdFromContext(requestContext);
    if (!userId) return;

    const channelConfig = await getCodexChannelDefaults();
    if (!isUserIdBlacklisted(userId, channelConfig?.codexBlacklistedNewApiUserIds)) {
        return;
    }

    const logMsg = `[API Service] Blocked openai-codex request by NewAPI user blacklist: userId=${userId}`;
    console.warn(logMsg);
    logChannelDispatchError(config.MODEL_PROVIDER, requestedModel, 'newapi_user_blacklist', logMsg, requestContext);
    const err = buildPoolRejectError('命中渠道用户黑名单');
    err.isUserBlacklist = true;
    throw err;
}

/**
 * 脱敏 Authorization 头，保留前缀和末尾几位
 */
function maskAuthorization(auth) {
    if (!auth || typeof auth !== 'string') return null;
    if (auth.length <= 12) return auth.substring(0, 4) + '***';
    return auth.substring(0, 8) + '***' + auth.substring(auth.length - 4);
}

/**
 * 记录渠道调度错误日志（异步，不阻塞主流程）
 */
function logChannelDispatchError(providerType, requestedModel, errorType, errorMessage, requestContext) {
    const ctx = requestContext || {};
    const headers = ctx.headers || {};

    // 脱敏请求头：只保留有用的调试信息
    const safeHeaders = {};
    const HEADER_ALLOWLIST = [
        'user-agent', 'x-request-id', 'x-forwarded-for', 'x-real-ip',
        'x-accounthub-tokenid', 'x-accounthub-token-id', 'x-token-id',
        'x-accounthub-userid', 'x-accounthub-user-id', 'x-newapi-userid', 'x-newapi-user-id', 'x-user-id',
        'x-accounthub-useremail', 'x-accounthub-user-email', 'x-user-email',
        'x-accounthub-username', 'x-accounthub-user-name', 'x-username',
        'x-accounthub-clientip', 'x-accounthub-client-ip', 'x-client-ip',
        'content-type', 'accept', 'origin', 'referer',
    ];
    for (const key of HEADER_ALLOWLIST) {
        if (headers[key]) safeHeaders[key] = headers[key];
    }

    channelDispatchLogsDao.create({
        providerType,
        requestModel: requestedModel,
        errorType,
        errorMessage,
        dispatchDetail: ctx.dispatchDetail || null,
        requestPath: ctx.path || null,
        requestMethod: ctx.method || null,
        clientIp: ctx.clientIp || null,
        userAgent: headers['user-agent'] || null,
        authorizationPreview: maskAuthorization(headers['authorization']),
        clientTokenId: ctx.clientTokenId || null,
        userId: ctx.userId || null,
        userEmail: ctx.userEmail || null,
        username: ctx.username || null,
        requestHeaders: Object.keys(safeHeaders).length > 0 ? safeHeaders : null,
    }).catch(err => {
        console.error('[ChannelDispatchLog] Failed to log dispatch error:', err.message);
    });
}

/**
 * 扫描 configs 目录并自动关联未关联的配置文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @returns {Promise<Object>} 更新后的 providerPools 对象
 */
export async function autoLinkProviderConfigs(config) {
    // 确保 providerPools 对象存在
    if (!config.providerPools) {
        config.providerPools = {};
    }
    
    let totalNewProviders = 0;
    const allNewProviders = {};

    const unlinkedCredentials = await oauthCredentialsDao.findAll({ isUsed: false });

    // 遍历所有提供商映射
    for (const mapping of PROVIDER_MAPPINGS) {
        const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId, urlKeys } = mapping;
        if (mapping.autoLink === false) {
            continue;
        }
        const credentialProviderType = mapping.credentialProviderType || providerType;

        // 确保提供商类型数组存在
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }

        const credentialsForProvider = unlinkedCredentials.filter(
            (credential) => credential.provider_type === credentialProviderType
        );

        if (!credentialsForProvider.length) {
            continue;
        }

        const newProviders = [];

        for (const credential of credentialsForProvider) {
            const credRef = formatOAuthCredentialRef(credentialProviderType, credential.id);
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: credRef,
                credentialId: credential.id,
                defaultCheckModel,
                needsProjectId,
                urlKeys
            });

            newProviders.push(newProvider);

            const dbProvider = {
                uuid: newProvider.uuid,
                provider_type: providerType,
                pool_id: credential.pool_id || null,
                custom_name: newProvider.customName || null,
                oauth_credential_id: credential.id,
                credentials: newProvider,
                is_healthy: true,
                is_disabled: false,
                usage_count: 0,
                error_count: 0,
                last_used: null,
                last_error_time: null,
                last_error_message: null,
                check_health: newProvider.checkHealth || false,
                check_model_name: newProvider.checkModelName || null,
                not_supported_models: newProvider.notSupportedModels || null
            };
            const createdProvider = await providerDao.create(dbProvider);
            await oauthCredentialsDao.markUsed(credential.id, createdProvider.uuid);
            const subscriptionTitle = credential.credentials?.subscriptionTitle || null;
            if (subscriptionTitle) {
                await providerDao.updateUsageInfo(createdProvider.uuid, { subscriptionTitle });
            }
        }

        if (newProviders.length > 0) {
            config.providerPools[providerType].push(...newProviders);
            totalNewProviders += newProviders.length;
            allNewProviders[displayName] = newProviders;
        }
    }

    if (totalNewProviders > 0) {
        console.log(`[Auto-Link] Added ${totalNewProviders} new config(s) to database:`);
        for (const [displayName, providers] of Object.entries(allNewProviders)) {
            console.log(`  ${displayName}: ${providers.length} config(s)`);
            providers.forEach((provider) => {
                const credKey = Object.keys(provider).find((key) =>
                    key.endsWith('_CREDS_FILE_PATH') || key.endsWith('_TOKEN_FILE_PATH')
                );
                if (credKey) {
                    console.log(`    - ${provider[credKey]}`);
                }
            });
        }
    } else {
        console.log('[Auto-Link] No new configs to link');
    }

    // Update provider pool manager if available
    if (providerPoolManager) {
        await providerPoolManager.reload();
    }
    return config.providerPools;
}

/**
 * 递归扫描提供商配置目录
 * @param {string} dirPath - 目录路径
 * @param {Set} linkedPaths - 已关联的路径集合
 * @param {Array} newProviders - 新提供商配置数组
 * @param {Object} options - 配置选项
 * @param {string} options.credPathKey - 凭据路径键名
 * @param {string} options.defaultCheckModel - 默认检测模型
 * @param {boolean} options.needsProjectId - 是否需要 PROJECT_ID
 */
// 注意：autoLink 逻辑已迁移到数据库凭据表

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
/**
 * Phase 1: 注册 providerDao.deleted 事件统一 listener
 *
 * 每次 provider 被 markDeleted / deleteProvider 时:
 *   1) 本 worker 本地 dispose 所有该 uuid 对应的 adapter 变体(含不同 proxy)
 *   2) 向 master 广播 provider_removed,master 再分发到其他 worker,其他 worker 本地也清
 *
 * 幂等:重复注册不会叠加(setupOnce 标记)。
 */
let providerDeletedListenerWired = false;
function wireProviderDeletedListener() {
    if (providerDeletedListenerWired) return;
    providerDeletedListenerWired = true;
    providerDao.providerDaoEvents.on('deleted', ({ uuid, providerType }) => {
        if (!uuid) return;
        try {
            const removed = deleteServiceInstancesByUuid(uuid);
            if (removed > 0) {
                console.log(`[ServiceManager] provider deleted (${providerType || '?'}, ${String(uuid).slice(0, 8)}): disposed ${removed} local adapter(s)`);
            }
        } catch (error) {
            console.warn('[ServiceManager] local dispose on delete failed:', error?.message || error);
        }
        // 广播到其他进程。
        // - worker:process.send 经 cluster IPC → master → 其他 workers
        // - admin:process.send 经 spawn stdio IPC → master 的 adminProcess.on('message') → 所有 workers
        // - master 自己:没有 process.send,跳过(master 也不持有 adapter)
        const isBroadcastable = (process.env.IS_WORKER_PROCESS === 'true' || process.env.IS_ADMIN_PROCESS === 'true')
            && typeof process.send === 'function';
        if (isBroadcastable) {
            try {
                process.send({
                    type: 'broadcast_event',
                    originPid: process.pid,
                    eventType: 'provider_removed',
                    data: { providerType: providerType || null, uuid }
                });
            } catch (error) {
                console.warn('[ServiceManager] broadcast provider_removed failed:', error?.message || error);
            }
        }
    });
    console.log('[ServiceManager] providerDao deleted listener registered');
}

/**
 * Phase 5: 分片数一致性检查
 *
 * 每次 worker 启动时把当前 WORKER_SHARD_COUNT 写到 Redis,同时和上一次运行写的值比较。
 * 如果分片数发生变化(比如从 3 worker 扩到 4 worker),记一条 WARN 日志:
 *   "Sticky bindings may be stale — old_count vs new_count"
 *
 * 不做自动清理,因为停机扩缩容是运维决策,清理 Redis sticky 键应该手工执行。
 * 但至少让运维能在日志里第一眼看到分片拓扑变化,判断是否要 FLUSHDB sticky 命名空间。
 *
 * 只 shard 0 写入,避免 N 个 worker 同时竞争(写 0 结果相同,但降噪)。
 */
async function checkShardTopologyConsistency() {
    if (process.env.IS_WORKER_PROCESS !== 'true') return;

    try {
        const { SHARD_COUNT, SHARD_ID, SHARD_ENABLED } = await import('../utils/shard.js');
        if (!SHARD_ENABLED) return;
        if (SHARD_ID !== 0) return; // 只 shard 0 执行

        const { getRedisClient, isRedisAvailable } = await import('./redis-client.js');
        if (!isRedisAvailable()) return;
        const redis = getRedisClient();
        if (!redis) return;

        const KEY = 'shard:topology:count';
        const previous = await redis.get(KEY).catch(() => null);
        const prevCount = parseInt(previous, 10);

        if (Number.isFinite(prevCount) && prevCount !== SHARD_COUNT) {
            console.warn(`[ShardTopology] ⚠ SHARD_COUNT changed: was ${prevCount}, now ${SHARD_COUNT}`);
            console.warn('[ShardTopology] ⚠ Sticky session bindings in Redis may point to uuids under a different shard mapping.');
            console.warn('[ShardTopology] ⚠ Existing sessions may temporarily fall back to local re-selection until sticky keys expire (TTL).');
            console.warn('[ShardTopology] ⚠ To clear proactively, run: redis-cli --scan --pattern "aiclient:sticky:*" | xargs redis-cli del');
        } else if (!Number.isFinite(prevCount)) {
            console.log(`[ShardTopology] First startup under sharded mode, count=${SHARD_COUNT}`);
        } else {
            console.log(`[ShardTopology] Consistent shard count=${SHARD_COUNT}`);
        }

        await redis.set(KEY, String(SHARD_COUNT)).catch(() => {});
    } catch (error) {
        console.warn('[ShardTopology] consistency check failed:', error?.message || error);
    }
}

export async function initApiService(config) {
    // Phase 1: 在 provider pool manager 构造前就注册 delete listener,避免初始化期间错失事件
    wireProviderDeletedListener();

    // Phase 5: 分片数一致性检查(每次启动都跑一遍)
    await checkShardTopologyConsistency();

    // 使用数据库版本的 ProviderPoolManagerDB
    providerPoolManager = new ProviderPoolManagerDB({
        globalConfig: config,
        maxErrorCount: config.MAX_ERROR_COUNT ?? 3,
        providerFallbackChain: config.providerFallbackChain || {},
    });

    // 从数据库初始化
    await providerPoolManager.initialize();
    console.log('[Initialization] ProviderPoolManagerDB initialized from database.');

    // admin 进程(独立 spawn)不预热 adapter 池,避免重复持有 1000+ 个 axios 实例
    // admin 端的测号/用量查询走按需懒加载(getServiceAdapter)
    const IS_ADMIN_PROCESS = process.env.IS_ADMIN_PROCESS === 'true';

    if (IS_ADMIN_PROCESS) {
        console.log('[Initialization] Admin process detected, skipping provider pool node pre-initialization.');
    } else {
        // Initialize all provider pool nodes at startup
        // 初始化号池中所有提供商的所有节点,以避免首个请求的额外延迟
        // Phase 1 改动:
        //   1) getProviderPools() 默认已不再 includeDeleted,墓碑 provider 不会出现在这里
        //   2) 跳过 is_healthy === false / is_deleted 的节点
        // Phase 2+3 改动:
        //   3) 只初始化本 worker shard 归属的 provider(ownsUuid 过滤),其他 worker 的 provider
        //      由它们自己持有 adapter,不在本进程浪费内存
        const providerPools = providerPoolManager && typeof providerPoolManager.getProviderPools === 'function'
            ? await providerPoolManager.getProviderPools()
            : null;
        if (providerPools && Object.keys(providerPools).length > 0) {
            let totalInitialized = 0;
            let totalFailed = 0;
            let totalSkippedUnhealthy = 0;
            let totalSkippedDeleted = 0;
            let totalSkippedOtherShard = 0;

            for (const [providerType, providerConfigs] of Object.entries(providerPools)) {
                // 验证提供商类型是否在 DEFAULT_MODEL_PROVIDERS 中
                if (config.DEFAULT_MODEL_PROVIDERS && Array.isArray(config.DEFAULT_MODEL_PROVIDERS)) {
                    if (!config.DEFAULT_MODEL_PROVIDERS.includes(providerType)) {
                        console.log(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
                        continue;
                    }
                }

                if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
                    continue;
                }

                console.log(`[Initialization] Scanning ${providerConfigs.length} node(s) for provider '${providerType}' (shard ${SHARD_ENABLED ? `${SHARD_ID}/${SHARD_COUNT}` : 'disabled'})...`);

                // 初始化该提供商类型的所有节点
                for (const providerConfig of providerConfigs) {
                    // 跳过已禁用的节点
                    if (providerConfig.is_disabled || providerConfig.isDisabled) {
                        continue;
                    }
                    // Phase 1: 跳过已删除节点(即便 getProviderPools 误传 includeDeleted 也兜底)
                    if (providerConfig.is_deleted || providerConfig.isDeleted) {
                        totalSkippedDeleted++;
                        continue;
                    }
                    // Phase 1: 跳过已不健康节点(恢复由 performHealthChecks 单独处理,不在启动时占 adapter)
                    const healthyFlag = providerConfig.is_healthy ?? providerConfig.isHealthy;
                    if (healthyFlag === false || healthyFlag === 0) {
                        totalSkippedUnhealthy++;
                        continue;
                    }
                    // Phase 2+3: shard 过滤 —— 不归属本 worker 的 provider 不占 adapter 内存
                    if (SHARD_ENABLED && !ownsUuid(providerConfig.uuid)) {
                        totalSkippedOtherShard++;
                        continue;
                    }

                    try {
                        const nodeConfig = shallowMerge(config, {
                            ...providerConfig,
                            MODEL_PROVIDER: providerType
                        });
                        delete nodeConfig.providerPools;

                        getServiceAdapter(nodeConfig);
                        totalInitialized++;

                        const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                        console.log(`  ✓ Initialized node: ${identifier}`);
                    } catch (error) {
                        totalFailed++;
                        const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                        console.warn(`  ✗ Failed to initialize node ${identifier}: ${error.message}`);
                    }
                }
            }

            console.log(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed, ${totalSkippedUnhealthy} skipped unhealthy, ${totalSkippedDeleted} skipped deleted, ${totalSkippedOtherShard} skipped other-shard.`);
            const metrics = getServiceInstanceMetrics();
            console.log(`[Initialization] Adapter cache after init: live=${metrics.live} hot=${metrics.hot} (shard ${SHARD_ENABLED ? `${SHARD_ID}/${SHARD_COUNT}` : 'single'})`);

            // 将本 shard 拥有的 provider 数记下,供 worker_stats 上报
            if (providerPoolManager) {
                providerPoolManager._ownedProviderCount = totalInitialized;
            }
        } else {
            console.log('[Initialization] No provider pools configured. Skipping node initialization.');
        }

        if (providerPoolManager && typeof providerPoolManager.warmupNodes === 'function') {
            void providerPoolManager.warmupNodes().catch(error => {
                console.error('[Initialization] Provider warmup failed:', error.message);
            });
        }
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(config, requestedModel = null, options = {}) {
    let serviceConfig = config;
    await rejectBlacklistedNewApiUser(config, requestedModel, options.requestContext);

    if (providerPoolManager && typeof providerPoolManager.selectProvider === 'function') {
        const skipUsageCount = options.skipUsageCount !== undefined ? options.skipUsageCount : true;
        const poolId = options.poolId !== undefined ? options.poolId : config.POOL_ID;
        const sessionId = options.sessionId || null;
        // 方案 B:sticky 由 master 的 TCP dispatcher 保证路由,业务层只需本地选号
        const selectedProviderConfig = await providerPoolManager.selectProvider(
            config.MODEL_PROVIDER,
            requestedModel,
            {
                skipUsageCount,
                poolId,
                poolIdExplicit: options.poolIdExplicit !== undefined ? options.poolIdExplicit : !!config.POOL_ID_EXPLICIT,
                isProviderUser: options.isProviderUser === true,
                sessionId,
                requestContext: options.requestContext || null,
                excludeUuids: Array.isArray(options.excludeUuids) ? options.excludeUuids : []
            }
        );

        if (selectedProviderConfig) {
            serviceConfig = shallowMerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            console.log(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${requestedModel ? ` (model: ${requestedModel})` : ''}`);
        } else {
            const rejectReason = providerPoolManager._lastRejectReason || '未知原因';
            const logMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${requestedModel ? ` supporting model: ${requestedModel}` : ''} | 原因: ${rejectReason}`;
            console.error(logMsg);
            logChannelDispatchError(config.MODEL_PROVIDER, requestedModel, 'no_healthy_provider', logMsg, options.requestContext);
            throw buildPoolRejectError(rejectReason);
        }
    }
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter and return detailed result.
 * AccountHub routing is strict: no cross-provider fallback is attempted here.
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    let actualModel = null;
    await rejectBlacklistedNewApiUser(config, requestedModel, options.requestContext);

    if (providerPoolManager && typeof providerPoolManager.selectProviderWithFallback === 'function') {
        const skipUsageCount = options.skipUsageCount === true;
        const poolId = options.poolId !== undefined ? options.poolId : config.POOL_ID;
        const isProviderUser = options.isProviderUser === true;
        const sessionId = options.sessionId || null;
        // 方案 B:sticky 由 master TCP dispatcher 保证路由,业务层只需本地选号
        const selectedResult = await providerPoolManager.selectProviderWithFallback(
            config.MODEL_PROVIDER,
            requestedModel,
            {
                skipUsageCount,
                poolId,
                poolIdExplicit: options.poolIdExplicit !== undefined ? options.poolIdExplicit : !!config.POOL_ID_EXPLICIT,
                isProviderUser,
                sessionId,
                requestContext: options.requestContext || null,
                excludeUuids: Array.isArray(options.excludeUuids) ? options.excludeUuids : []
            }
        );

        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed, actualModel: fallbackModel } = selectedResult;

            // 合并选中的提供者配置到当前请求的 config 中（使用浅合并提高性能）
            serviceConfig = shallowMerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel;
            
            // 如果发生了 fallback，需要更新 MODEL_PROVIDER
            if (isFallback) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        } else {
            const rejectReason = providerPoolManager._lastRejectReason || '未知原因';
            const logMsg = `[API Service] No healthy provider found in configured pool for ${config.MODEL_PROVIDER}${requestedModel ? ` supporting model: ${requestedModel}` : ''} | 原因: ${rejectReason}`;
            console.error(logMsg);
            logChannelDispatchError(config.MODEL_PROVIDER, requestedModel, 'no_healthy_provider', logMsg, options.requestContext);
            throw buildPoolRejectError(rejectReason);
        }
    }
    
    const service = getServiceAdapter(serviceConfig);

    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid,
        actualModel,
        poolId: serviceConfig?.poolId ?? null  // 传递 poolId
    };
}

/**
 * Get the provider pool manager instance
 * @returns {Object} The provider pool manager
 */
export function getProviderPoolManager() {
    return providerPoolManager;
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider, providerInfo) {
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.provider] - Optional.provider filter by provider type
 * @param {boolean} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(config, options = {}) {
    let providerPools = {};
    try {
        if (providerPoolManager && typeof providerPoolManager.getProviderPools === 'function') {
            providerPools = await providerPoolManager.getProviderPools();
        } else {
            const allProviders = await providerDao.findAll();
            for (const provider of allProviders) {
                const providerType = provider.provider_type;
                if (!providerPools[providerType]) {
                    providerPools[providerType] = [];
                }
                providerPools[providerType].push(provider);
            }
        }
    } catch (error) {
        console.warn('[API Service] Failed to load provider pools:', error.message);
    }

    const normalizeProviderEntry = (item) => {
        const credentials = item && typeof item.credentials === 'object' ? item.credentials : {};
        return {
            ...credentials,
            ...item,
            customName: item?.customName ?? item?.custom_name ?? credentials.customName ?? null,
            isDisabled: item?.isDisabled ?? item?.is_disabled ?? credentials.isDisabled ?? false,
            isHealthy: item?.isHealthy ?? item?.is_healthy ?? credentials.isHealthy ?? null,
            lastErrorTime: item?.lastErrorTime ?? item?.last_error_time ?? credentials.lastErrorTime ?? null,
            lastErrorMessage: item?.lastErrorMessage ?? item?.last_error_message ?? credentials.lastErrorMessage ?? null,
            uuid: item?.uuid ?? credentials.uuid ?? null
        };
    };

    // providerPoolsSlim 只保留顶级 key 及部分字段，过滤 isDisabled 为 true 的元素
    const slimFields = [
        'customName',
        'isHealthy',
        'lastErrorTime',
        'lastErrorMessage'
    ];
    // identify 字段映射表
    const identifyFieldMap = {
        'openai-custom': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'claude-custom': 'CLAUDE_BASE_URL',
        'claude-offical': 'CLAUDE_BASE_URL',
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'openai-droid': 'DROID_OAUTH_CREDS_FILE_PATH',
        'openaiResponses-droid': 'DROID_OAUTH_CREDS_FILE_PATH',
        'claude-droid': 'DROID_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'openai-codex': 'CODEX_OAUTH_CREDS_FILE_PATH',
        'openai-xai-oauth': 'XAI_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
        'claude-warp-oauth': 'WARP_OAUTH_CREDS_FILE_PATH'
    };
    let providerPoolsSlim = [];
    let unhealthyProvideIdentifyList = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        const identifyField = identifyFieldMap[key] || null;
        const slimArr = providerPools[key]
            .map(item => normalizeProviderEntry(item))
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim = {};
                for (const f of slimFields) {
                    slim[f] = item.hasOwnProperty(f) ? item[f] : null;
                }
                // identify 字段
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : 'NoCustomName';
                    let identifyStr = `${tmpCustomName}::${key}::${item[identifyField]}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 统计
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
