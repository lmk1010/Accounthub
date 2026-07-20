import { getRequestBody } from '../utils/common.js';
import * as providerPoolDao from '../dao/provider-pool-dao.js';
import * as providerDao from '../dao/provider-dao.js';
import * as providerUsageDao from '../dao/provider-usage-dao.js';
import { concurrencyLimiter } from '../services/concurrency-limiter.js';

function buildUsageMetricsMap(usageDetails = []) {
    const map = new Map();
    for (const detail of usageDetails) {
        const uuid = detail?.provider_uuid;
        const percent = Number(detail?.usageSummary?.percent);
        const used = Number(detail?.usageSummary?.used);
        const limit = Number(detail?.usageSummary?.limit);
        if (!uuid) {
            continue;
        }

        if (Number.isFinite(limit) && limit > 0) {
            map.set(uuid, {
                used: Number.isFinite(used) ? Math.max(0, used) : 0,
                limit,
                percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : (used / limit) * 100))
            });
            continue;
        }

        if (Number.isFinite(percent)) {
            const safePercent = Math.max(0, Math.min(100, percent));
            map.set(uuid, {
                used: safePercent,
                limit: 100,
                percent: safePercent
            });
        }
    }
    return map;
}

function buildPoolCountsMap(countRows, defaultPoolId) {
    const counts = new Map();
    for (const row of countRows) {
        const poolId = row.poolId ?? 0;
        counts.set(poolId, {
            totalWithDeleted: row.totalWithDeleted || 0,
            totalActive: row.totalActive || 0,
            deleted: row.deletedCount || 0,
            healthy: row.healthyCount || 0,
            disabled: row.disabledCount || 0,
            cooldown: row.cooldownCount || 0,
            unhealthy: row.unhealthyCount || 0
        });
    }

    if (defaultPoolId && counts.has(0) && defaultPoolId !== 0) {
        const defaultCounts = counts.get(defaultPoolId) || {
            totalWithDeleted: 0,
            totalActive: 0,
            deleted: 0,
            healthy: 0,
            disabled: 0,
            cooldown: 0,
            unhealthy: 0
        };
        const fallbackCounts = counts.get(0);
        defaultCounts.totalWithDeleted += fallbackCounts.totalWithDeleted;
        defaultCounts.totalActive += fallbackCounts.totalActive;
        defaultCounts.deleted += fallbackCounts.deleted;
        defaultCounts.healthy += fallbackCounts.healthy;
        defaultCounts.disabled += fallbackCounts.disabled;
        defaultCounts.cooldown += fallbackCounts.cooldown;
        defaultCounts.unhealthy += fallbackCounts.unhealthy;
        counts.set(defaultPoolId, defaultCounts);
        counts.delete(0);
    }

    return counts;
}

/**
 * 计算池子的总额度占比
 * @param {string} providerType - 提供商类型
 * @param {number} poolId - 池子ID
 * @returns {Promise<number|null>} 总额度占比（0-100），如果无法计算则返回null
 */

async function calculatePoolRealtimeStats(providerType, poolId) {
    try {
        const providers = await providerDao.findAll(providerType, {
            includeDeleted: false,
            poolId
        });

        if (!Array.isArray(providers) || providers.length === 0) {
            return {
                currentConcurrency: 0,
                peakConcurrency: 0,
                activeUserCount: 0,
                uniqueUserCount: 0
            };
        }

        // 并行拉取所有 provider 的 redis 数据。之前是 140 providers × 4 次 await 串行,
        // 700-1000ms 卡住 worker event loop;改成 Promise.all 后约 20-50ms。
        const uuids = providers
            .map(p => String(p?.uuid || '').trim())
            .filter(Boolean);

        const results = await Promise.all(uuids.map(async uuid => {
            const [current, peak, activeUsers, recentUsers] = await Promise.all([
                concurrencyLimiter.getAccountConcurrency(uuid),
                concurrencyLimiter.getAccountPeakConcurrency(uuid),
                concurrencyLimiter.getAccountUsers(uuid),
                concurrencyLimiter.getRecentUsers(uuid)
            ]);
            return { current, peak, activeUsers, recentUsers };
        }));

        let currentConcurrency = 0;
        let peakConcurrency = 0;
        const activeUserKeys = new Set();
        const uniqueUserKeys = new Set();
        for (const { current, peak, activeUsers, recentUsers } of results) {
            currentConcurrency += Number(current) || 0;
            peakConcurrency += Number(peak) || 0;
            for (const user of activeUsers || []) {
                const userKey = String(user?.userKey || '').trim();
                if (userKey) activeUserKeys.add(userKey);
            }
            for (const user of recentUsers || []) {
                const userKey = String(user?.userKey || '').trim();
                if (userKey) uniqueUserKeys.add(userKey);
            }
        }

        return {
            currentConcurrency,
            peakConcurrency,
            activeUserCount: activeUserKeys.size,
            uniqueUserCount: uniqueUserKeys.size
        };
    } catch (error) {
        console.error(`[Pool API] Failed to calculate realtime stats for pool ${poolId}:`, error);
        return {
            currentConcurrency: 0,
            peakConcurrency: 0,
            activeUserCount: 0,
            uniqueUserCount: 0
        };
    }
}

async function calculatePoolQuotaUsagePercent(providerType, poolId, usageMetricsMap = null) {
    try {
        // 获取池子中的所有账号（不包括已删除的）
        const providers = await providerDao.findAll(providerType, {
            includeDeleted: false,
            poolId: poolId
        });

        if (!providers || providers.length === 0) {
            return null;
        }

        let totalUsed = 0;
        let totalLimit = 0;

        for (const provider of providers) {
            let used = null;
            let limit = null;

            if (usageMetricsMap && provider?.uuid && usageMetricsMap.has(provider.uuid)) {
                const metric = usageMetricsMap.get(provider.uuid);
                used = metric?.used;
                limit = metric?.limit;
            } else {
                const currentUsage = provider.currentUsage ?? provider.current_usage;
                const usageLimit = provider.usageLimit ?? provider.usage_limit;

                if (currentUsage !== null && currentUsage !== undefined &&
                    usageLimit !== null && usageLimit !== undefined &&
                    usageLimit > 0) {
                    used = Number(currentUsage) || 0;
                    limit = Number(usageLimit) || 0;
                }
            }

            if (Number.isFinite(limit) && limit > 0) {
                totalUsed += Number.isFinite(used) ? Math.max(0, used) : 0;
                totalLimit += limit;
            }
        }

        if (totalLimit <= 0) {
            return null;
        }

        return Math.round((Math.max(0, Math.min(100, (totalUsed / totalLimit) * 100))) * 100) / 100;
    } catch (error) {
        console.error(`[Pool API] Failed to calculate quota usage percent for pool ${poolId}:`, error);
        return null;
    }
}

function buildPoolResponseEntry(pool, counts, quotaUsagePercent, realtimeStats, fallbackName = '默认池') {
    const stats = counts || {
        totalWithDeleted: 0,
        totalActive: 0,
        deleted: 0,
        healthy: 0,
        disabled: 0,
        cooldown: 0,
        unhealthy: 0
    };
    const realtime = realtimeStats || {
        currentConcurrency: 0,
        peakConcurrency: 0,
        activeUserCount: 0,
        uniqueUserCount: 0
    };
    return {
        id: pool?.id ?? 0,
        providerType: pool?.provider_type,
        name: pool?.name || fallbackName,
        isDefault: Boolean(pool?.is_default || pool?.isDefault),
        isEnabled: pool?.is_enabled === undefined ? true : Boolean(pool?.is_enabled),
        useProxy: Boolean(pool?.use_proxy),
        proxyNodeIds: Array.isArray(pool?.proxy_node_ids) ? pool.proxy_node_ids : [],
        codexHighConcurrencyUserIds: Array.isArray(pool?.codex_high_concurrency_user_ids) ? pool.codex_high_concurrency_user_ids : [],
        strategy: pool?.strategy || 'round-robin',
        supportedModels: pool?.supported_models || null,
        notSupportedModels: pool?.not_supported_models || null,
        // 并发控制字段
        userMaxConcurrency: pool?.user_max_concurrency || 0,
        accountMaxConcurrency: pool?.account_max_concurrency || 0,
        enableUserConcurrencyLimit: Boolean(pool?.enable_user_concurrency_limit),
        enableAccountConcurrencyLimit: Boolean(pool?.enable_account_concurrency_limit),
        // 代理商并发控制字段
        providerMaxConcurrency: pool?.provider_max_concurrency || 0,
        providerAccountMaxConcurrency: pool?.provider_account_max_concurrency || 0,
        enableProviderConcurrencyLimit: Boolean(pool?.enable_provider_concurrency_limit),
        enableProviderAccountConcurrencyLimit: Boolean(pool?.enable_provider_account_concurrency_limit),
        // Session 并发控制字段
        enableSessionLimit: Boolean(pool?.enable_session_limit),
        maxSessionsPerAccount: pool?.max_sessions_per_account || 0,
        // 健康检测开关
        enableHealthCheck: pool?.enable_health_check === undefined ? true : Boolean(pool?.enable_health_check),
        total: stats.totalActive,
        totalWithDeleted: stats.totalWithDeleted,
        healthy: stats.healthy,
        cooldown: stats.cooldown,
        unhealthy: stats.unhealthy,
        disabled: stats.disabled,
        deleted: stats.deleted,
        quotaUsagePercent,
        averageUsage: quotaUsagePercent,
        currentConcurrency: realtime.currentConcurrency || 0,
        peakConcurrency: realtime.peakConcurrency || 0,
        activeUserCount: realtime.activeUserCount || 0,
        uniqueUserCount: realtime.uniqueUserCount || 0
    };
}

export async function handleGetProviderPools(req, res) {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const providerType = requestUrl.searchParams.get('providerType');
        if (!providerType) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerType is required' } }));
            return true;
        }

        const pools = await providerPoolDao.findByType(providerType);
        const defaultPool = pools.find(pool => pool.is_default);
        const defaultPoolId = defaultPool ? defaultPool.id : null;
        const countRows = await providerDao.getPoolCounts(providerType);
        const countsMap = buildPoolCountsMap(countRows, defaultPoolId);
        const usageDetails = await providerUsageDao.findByProviderType(providerType);
        const usageMetricsMap = buildUsageMetricsMap(usageDetails);

        const responsePools = [];
        // 不再硬编码默认池，所有池子都从数据库获取
        // 如果没有池子，返回空数组，让用户自己创建

        for (const pool of pools) {
            const quotaUsagePercent = await calculatePoolQuotaUsagePercent(providerType, pool.id, usageMetricsMap);
            const realtimeStats = await calculatePoolRealtimeStats(providerType, pool.id);
            responsePools.push(buildPoolResponseEntry(pool, countsMap.get(pool.id), quotaUsagePercent, realtimeStats, pool.name));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: responsePools }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleCreateProviderPool(req, res, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { providerType, name, isDefault = false } = body;
        if (!providerType || !name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerType and name are required' } }));
            return true;
        }

        if (isDefault) {
            await providerPoolDao.clearDefault(providerType);
        }
        const poolId = await providerPoolDao.create({ providerType, name, isDefault });

        if (providerPoolManager) {
            await providerPoolManager.reload();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id: poolId }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleUpdateProviderPool(req, res, providerPoolManager, poolId) {
    try {
        const body = await getRequestBody(req);
        const updates = {};
        if (body.name !== undefined) {
            updates.name = body.name;
        }
        if (body.isDefault !== undefined) {
            updates.isDefault = Boolean(body.isDefault);
        }
        if (body.isEnabled !== undefined) {
            updates.isEnabled = Boolean(body.isEnabled);
        }
        if (body.useProxy !== undefined) {
            updates.useProxy = Boolean(body.useProxy);
        }
        if (body.proxyNodeIds !== undefined) {
            updates.proxyNodeIds = Array.isArray(body.proxyNodeIds) ? body.proxyNodeIds : [];
        }
        if (body.codexHighConcurrencyUserIds !== undefined) {
            updates.codexHighConcurrencyUserIds = body.codexHighConcurrencyUserIds;
        }
        if (body.strategy !== undefined) {
            updates.strategy = body.strategy;
        }
        if (body.supportedModels !== undefined) {
            updates.supportedModels = body.supportedModels;
        }
        if (body.notSupportedModels !== undefined) {
            updates.notSupportedModels = body.notSupportedModels;
        }
        // 并发控制字段
        if (body.userMaxConcurrency !== undefined) {
            updates.userMaxConcurrency = Number(body.userMaxConcurrency) || 0;
        }
        if (body.accountMaxConcurrency !== undefined) {
            updates.accountMaxConcurrency = Number(body.accountMaxConcurrency) || 0;
        }
        if (body.enableUserConcurrencyLimit !== undefined) {
            updates.enableUserConcurrencyLimit = Boolean(body.enableUserConcurrencyLimit);
        }
        if (body.enableAccountConcurrencyLimit !== undefined) {
            updates.enableAccountConcurrencyLimit = Boolean(body.enableAccountConcurrencyLimit);
        }
        // 代理商并发控制字段
        if (body.providerMaxConcurrency !== undefined) {
            updates.providerMaxConcurrency = Number(body.providerMaxConcurrency) || 0;
        }
        if (body.providerAccountMaxConcurrency !== undefined) {
            updates.providerAccountMaxConcurrency = Number(body.providerAccountMaxConcurrency) || 0;
        }
        if (body.enableProviderConcurrencyLimit !== undefined) {
            updates.enableProviderConcurrencyLimit = Boolean(body.enableProviderConcurrencyLimit);
        }
        if (body.enableProviderAccountConcurrencyLimit !== undefined) {
            updates.enableProviderAccountConcurrencyLimit = Boolean(body.enableProviderAccountConcurrencyLimit);
        }
        // Session 并发控制字段
        if (body.enableSessionLimit !== undefined) {
            updates.enableSessionLimit = Boolean(body.enableSessionLimit);
        }
        if (body.maxSessionsPerAccount !== undefined) {
            updates.maxSessionsPerAccount = Number(body.maxSessionsPerAccount) || 0;
        }
        // 健康检测开关
        if (body.enableHealthCheck !== undefined) {
            updates.enableHealthCheck = Boolean(body.enableHealthCheck);
        }

        const existing = await providerPoolDao.findById(poolId);
        if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Pool not found' } }));
            return true;
        }

        if (updates.isDefault) {
            await providerPoolDao.clearDefault(existing.provider_type);
        }

        await providerPoolDao.update(poolId, updates);

        if (providerPoolManager) {
            await providerPoolManager.reload();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleDeleteProviderPool(req, res, providerPoolManager, poolId) {
    try {
        const existing = await providerPoolDao.findById(poolId);
        if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Pool not found' } }));
            return true;
        }

        const counts = await providerDao.getPoolCounts(existing.provider_type);
        const inPool = counts.find(row => row.poolId === Number(poolId));
        if (inPool && inPool.totalWithDeleted > 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Pool is not empty' } }));
            return true;
        }

        await providerPoolDao.remove(poolId);
        if (providerPoolManager) {
            await providerPoolManager.reload();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
