/**
 * Pricing Analytics DAO
 *
 * 给"定价计算器"页提供实时数据。跨两个库：
 *   aiclient（AccountHub 自己）— providers / request_logs / provider_usage_details
 *   aidistri（newapi 销售端）— plans / options / subscriptions / logs
 *
 * 支持多池：pro / plus / free 都是 openai-codex，靠 subscription_title 区分。
 * Plus 与 Free 在 newapi 层共用 channel 3，consumption 按本地 request 数量分摊。
 *
 * 性能注意：
 *   providers.uuid 的 collation (utf8mb4_general_ci) 和 request_logs.provider_uuid
 *   (utf8mb4_unicode_ci) 不一样。**千万别直接 JOIN 两表**（COLLATE 强转会打废
 *   request_logs 的 idx_uuid_created 索引，Free 池 407 号直接把 MySQL 压到 100% CPU）。
 *   正确做法：两表各自查，在 JS 里按 uuid 做 Map 合并。
 */

import { getPool } from '../config/database.js';

const NEWAPI_DB = 'aidistri';

export const POOLS = {
    pro: {
        key: 'pro',
        label: 'Codex Pro',
        providerType: 'openai-codex',
        subscriptionTitle: 'GPT PRO',
        newapiChannelId: 13,
        newapiChannelKey: '[13]',
        defaultCostRmb: 160,
        description: 'Pro 池 灰产号 ¥160 (5x) / ¥200 (20x)',
        tiers: {
            '5x':  { label: '5× 速', costRmb: 160 },
            '20x': { label: '20× 速', costRmb: 200 }
        },
        defaultTier: '5x'
    },
    plus: {
        key: 'plus',
        label: 'Codex Plus',
        providerType: 'openai-codex',
        subscriptionTitle: 'GPT PLUS',
        newapiChannelId: 3,
        newapiChannelKey: '[3]',
        defaultCostRmb: 9,
        description: '¥9/号 一次性（共用 ch3，与 Free 混发）',
        sharedChannel: true
    },
    free: {
        key: 'free',
        label: 'Codex Free',
        providerType: 'openai-codex',
        subscriptionTitle: 'GPT FREE',
        newapiChannelId: 3,
        newapiChannelKey: '[3]',
        defaultCostRmb: 0.3,
        description: '自注册号 ¥0.3/个（共用 ch3，与 Plus 混发）',
        sharedChannel: true
    }
};

export const POOL_KEYS = Object.keys(POOLS);

/** 单账号月成本：优先按 credentials.tier 查，否则用 pool defaultCost。 */
function resolveAccountMonthlyCost(poolDef, credentials) {
    if (!poolDef.tiers) return poolDef.defaultCostRmb;
    const tier = credentials?.tier || poolDef.defaultTier;
    return poolDef.tiers[tier]?.costRmb ?? poolDef.defaultCostRmb;
}

function resolvePool(key) {
    if (!key) return POOLS.pro;
    const pool = POOLS[key];
    if (!pool) throw new Error(`未知池子: ${key}`);
    return pool;
}

function parseJsonOption(raw) {
    if (!raw) return {};
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return {};
    }
}

function pickPercent(usageJson, windowType) {
    if (!usageJson) return null;
    let parsed;
    try { parsed = typeof usageJson === 'string' ? JSON.parse(usageJson) : usageJson; }
    catch { return null; }
    const breakdowns = parsed?.usageBreakdown;
    if (!Array.isArray(breakdowns)) return null;
    const hit = breakdowns.find(b =>
        b?.windowType === windowType && (b?.limitGroup === 'main' || !b?.limitGroup)
    );
    if (!hit) return null;
    const v = hit.currentUsage;
    return typeof v === 'number' ? v : (v != null ? Number(v) : null);
}

/**
 * 一次性查出最近 N 天所有 openai-codex provider 的请求聚合。
 * 利用 idx_request_logs_type_pool_time(provider_type, pool_id, created_at) 索引。
 * 返回 Map<uuid, {reqs, inputT, outputT, cacheT}>。
 */
async function getCodexUsageAgg(days = 7) {
    const dbPool = getPool();
    const [rows] = await dbPool.execute(`
        SELECT provider_uuid,
               COUNT(*) AS reqs,
               SUM(input_tokens) AS in_t,
               SUM(output_tokens) AS out_t,
               SUM(cache_read_tokens) AS cache_t
        FROM request_logs
        WHERE provider_type = 'openai-codex'
          AND is_success = 1
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY provider_uuid
    `, [days]);
    const m = new Map();
    for (const r of rows) {
        m.set(r.provider_uuid, {
            reqs: Number(r.reqs || 0),
            input: Number(r.in_t || 0),
            output: Number(r.out_t || 0),
            cache: Number(r.cache_t || 0)
        });
    }
    return m;
}

/** 一次性查所有 openai-codex provider 的 5h/7d usage snapshot。 */
async function getCodexUsageSnapshots() {
    const dbPool = getPool();
    const [rows] = await dbPool.execute(`
        SELECT d.provider_uuid, d.updated_at, d.usage_json
        FROM provider_usage_details d
        WHERE d.provider_type = 'openai-codex'
    `);
    const m = new Map();
    for (const r of rows) {
        m.set(r.provider_uuid, {
            updated_at: r.updated_at,
            weekly_pct: pickPercent(r.usage_json, 'secondary'),
            hourly_pct: pickPercent(r.usage_json, 'primary')
        });
    }
    return m;
}

/** 拉单池的 account-side 状态（含 K 反推） */
export async function getPoolState(poolKey, newapiPoolQuotaUsd = 0, reusable = {}) {
    const pool = resolvePool(poolKey);
    const dbPool = getPool();

    const [providers] = await dbPool.execute(`
        SELECT uuid, custom_name, subscription_title, is_healthy, is_disabled, usage_count,
               last_health_check_time, credentials,
               TIMESTAMPDIFF(DAY, created_at, NOW()) AS age_days
        FROM providers
        WHERE provider_type = ?
          AND subscription_title = ?
          AND is_deleted = 0
        ORDER BY is_healthy DESC, is_disabled ASC, age_days DESC
    `, [pool.providerType, pool.subscriptionTitle]);

    if (!providers.length) {
        return {
            pool, totalAccounts: 0, activeAccounts: 0,
            sampleAccount: null, kWeeklyUsd: 0, kMonthlyUsd: 0, accounts: []
        };
    }

    const usageMap = reusable.usageMap || await getCodexUsageSnapshots();
    const aggMap = reusable.aggMap || await getCodexUsageAgg(7);

    let best = null;
    const perAccount = [];

    // 按 tier 汇总成本
    const tierBreakdown = {};
    let totalMonthlyCostRmb = 0;

    for (const p of providers) {
        const u = usageMap.get(p.uuid);
        const agg = aggMap.get(p.uuid);
        const weeklyPct = u?.weekly_pct ?? null;
        const hourlyPct = u?.hourly_pct ?? null;
        const snapshotAt = u?.updated_at ? new Date(u.updated_at) : null;

        const tokens = agg ? { input: agg.input, output: agg.output, cache: agg.cache } : null;
        const reqCount = agg ? agg.reqs : 0;
        const dollars7dApi = tokens
            ? (tokens.input / 1e6) * 1.25 + (tokens.cache / 1e6) * 0.125 + (tokens.output / 1e6) * 10
            : null;

        let credentials = p.credentials;
        if (typeof credentials === 'string') {
            try { credentials = JSON.parse(credentials); } catch { credentials = {}; }
        }
        const tier = pool.tiers ? (credentials?.tier || pool.defaultTier) : null;
        const monthlyCostRmb = resolveAccountMonthlyCost(pool, credentials);
        totalMonthlyCostRmb += monthlyCostRmb;

        if (tier) {
            const slot = tierBreakdown[tier] || { count: 0, costRmb: 0, label: pool.tiers[tier]?.label || tier };
            slot.count += 1;
            slot.costRmb += monthlyCostRmb;
            tierBreakdown[tier] = slot;
        }

        const entry = {
            uuid: p.uuid,
            customName: p.custom_name,
            ageDays: p.age_days,
            isHealthy: Boolean(p.is_healthy),
            isDisabled: Boolean(p.is_disabled),
            tier,
            monthlyCostRmb,
            weeklyPct, hourlyPct, snapshotAt,
            tokens, reqCount, dollars7dApi
        };
        perAccount.push(entry);

        if (weeklyPct != null && weeklyPct > 0 && reqCount > 0) {
            if (!best || weeklyPct > best.weeklyPct) best = entry;
        }
    }

    const totalReqs = perAccount.reduce((a, b) => a + (b.reqCount || 0), 0);
    if (totalReqs > 0 && newapiPoolQuotaUsd > 0) {
        perAccount.forEach((a) => {
            a.dollars7dCustomer = a.reqCount > 0
                ? newapiPoolQuotaUsd * (a.reqCount / totalReqs)
                : 0;
        });
        if (best) best.dollars7dCustomer = newapiPoolQuotaUsd * (best.reqCount / totalReqs);
    }

    let kWeek = 0;
    if (best) {
        const sample$ = best.dollars7dCustomer || best.dollars7dApi || 0;
        kWeek = sample$ / (best.weeklyPct / 100);
    }
    const kMonth = kWeek * (30 / 7);

    // 大池（如 Free 407 号）前端展示用：只返回前 100 个活跃 + 所有不活跃 UUID 统计
    const maxReturn = 120;
    let accountsOut = perAccount;
    if (perAccount.length > maxReturn) {
        accountsOut = [...perAccount]
            .sort((a, b) => (b.reqCount || 0) - (a.reqCount || 0))
            .slice(0, maxReturn);
    }

    return {
        pool,
        totalAccounts: providers.length,
        activeAccounts: providers.filter(p => p.is_healthy && !p.is_disabled).length,
        monthlyCostRmb: totalMonthlyCostRmb,
        tierBreakdown,
        tiersSupported: pool.tiers ? Object.entries(pool.tiers).map(([k, v]) => ({ key: k, ...v })) : [],
        sampleAccount: best ? {
            uuid: best.uuid,
            customName: best.customName,
            ageDays: best.ageDays,
            weeklyPct: best.weeklyPct,
            dollars7dCustomer: best.dollars7dCustomer || null,
            dollars7dApi: best.dollars7dApi || null,
            reqCount: best.reqCount,
            tier: best.tier,
            snapshotAt: best.snapshotAt
        } : null,
        kWeeklyUsd: kWeek,
        kMonthlyUsd: kMonth,
        accounts: accountsOut,
        accountsTruncated: perAccount.length > accountsOut.length
    };
}

/** 更新一个 provider 的 tier（写入 providers.credentials.tier） */
export async function updateProviderTier(uuid, tier) {
    const dbPool = getPool();
    const [rows] = await dbPool.execute(
        `SELECT credentials FROM providers WHERE uuid = ? AND is_deleted = 0`,
        [uuid]
    );
    if (!rows.length) throw new Error('Provider not found');
    let credentials = rows[0].credentials;
    if (typeof credentials === 'string') {
        try { credentials = JSON.parse(credentials); } catch { credentials = {}; }
    }
    credentials = credentials || {};
    if (tier == null || tier === '') {
        delete credentials.tier;
    } else {
        credentials.tier = String(tier);
    }
    await dbPool.execute(
        `UPDATE providers SET credentials = ? WHERE uuid = ?`,
        [JSON.stringify(credentials), uuid]
    );
    return { uuid, tier: credentials.tier ?? null };
}

export async function getNewapiPricingRatios() {
    const pool = getPool();
    const [rows] = await pool.execute(`
        SELECT \`key\`, value
        FROM ${NEWAPI_DB}.options
        WHERE \`key\` IN ('ModelRatio','CompletionRatio','CacheRatio','GroupRatio','Price')
    `);
    const out = {};
    for (const r of rows) out[r.key] = parseJsonOption(r.value);
    return out;
}

export async function getNewapiPoolPlans(poolKey) {
    const pool = resolvePool(poolKey);
    const dbPool = getPool();
    const [rows] = await dbPool.execute(`
        SELECT id, name, price, quota_limit AS quota_usd, duration_days,
               billing_multiplier, billing_mode,
               input_price, cache_input_price, output_price,
               rpm_limit, concurrency_limit, sale_limit, status,
               FROM_UNIXTIME(created_at) AS created_at_str
        FROM ${NEWAPI_DB}.plans
        WHERE channel_ids = ?
        ORDER BY status DESC, duration_days, quota_usd
    `, [pool.newapiChannelKey]);
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        priceRmb: Number(r.price),
        quotaUsd: Number(r.quota_usd),
        durationDays: Number(r.duration_days),
        billingMultiplier: Number(r.billing_multiplier),
        billingMode: r.billing_mode,
        inputPrice: Number(r.input_price),
        cacheInputPrice: Number(r.cache_input_price),
        outputPrice: Number(r.output_price),
        rpmLimit: Number(r.rpm_limit),
        concurrencyLimit: Number(r.concurrency_limit),
        saleLimit: Number(r.sale_limit),
        status: Number(r.status),
        createdAt: r.created_at_str,
        unitPriceRmbPerUsd: r.quota_usd > 0 ? Number(r.price) / Number(r.quota_usd) : null
    }));
}

export async function getNewapiPoolSales(poolKey, days = 30) {
    const pool = resolvePool(poolKey);
    const dbPool = getPool();
    const [rows] = await dbPool.execute(`
        SELECT s.plan_id, p.name AS plan_name, p.duration_days,
               p.quota_limit AS quota_usd,
               COUNT(*) AS sold, SUM(s.amount) AS revenue_rmb,
               SUM(s.used_quota) / 500000 AS used_usd,
               MIN(FROM_UNIXTIME(s.created_at)) AS first_sold,
               MAX(FROM_UNIXTIME(s.created_at)) AS last_sold
        FROM ${NEWAPI_DB}.subscriptions s
        LEFT JOIN ${NEWAPI_DB}.plans p ON p.id = s.plan_id
        WHERE s.created_at >= UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL ? DAY))
          AND p.channel_ids = ?
        GROUP BY s.plan_id, p.name, p.duration_days, p.quota_limit
        ORDER BY sold DESC
    `, [days, pool.newapiChannelKey]);

    return rows.map(r => {
        const quotaUsd = r.quota_usd != null ? Number(r.quota_usd) : null;
        const soldUsdTotal = r.sold && quotaUsd ? r.sold * quotaUsd : null;
        return {
            planId: r.plan_id,
            planName: r.plan_name,
            durationDays: r.duration_days != null ? Number(r.duration_days) : null,
            quotaUsd,
            sold: Number(r.sold),
            revenueRmb: Number(r.revenue_rmb || 0),
            usedUsd: Number(r.used_usd || 0),
            soldUsdTotal,
            burnRate: soldUsdTotal && soldUsdTotal > 0 ? Number(r.used_usd || 0) / soldUsdTotal : null,
            firstSold: r.first_sold,
            lastSold: r.last_sold
        };
    });
}

/**
 * 单池 consumption。共享 channel（Plus/Free）按本地 request 占比从 channel 扣费里切出属于该池的。
 * 分享比例计算：取 aggMap 里这个池子 subscription_title 下所有账号的 req 数，
 * 除以同 channel 所有池子的 req 数。
 */
export async function getNewapiPoolConsumption(poolKey, days = 7, reusable = {}) {
    const pool = resolvePool(poolKey);
    const dbPool = getPool();

    const [rows] = await dbPool.execute(`
        SELECT model_name,
               COUNT(*) AS reqs,
               SUM(quota) AS quota_units,
               SUM(prompt_tokens) AS prompt_tokens,
               SUM(completion_tokens) AS completion_tokens
        FROM ${NEWAPI_DB}.logs
        WHERE created_at >= UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL ? DAY))
          AND channel_id = ?
        GROUP BY model_name
        ORDER BY reqs DESC
    `, [days, pool.newapiChannelId]);

    const channelConsumption = rows.map(r => ({
        model: r.model_name || '(unknown)',
        reqs: Number(r.reqs),
        quotaUsd: Number(r.quota_units || 0) / 500000,
        promptTokens: Number(r.prompt_tokens || 0),
        completionTokens: Number(r.completion_tokens || 0)
    }));
    const channelTotalUsd = channelConsumption.reduce((a, b) => a + b.quotaUsd, 0);

    if (!pool.sharedChannel) {
        return {
            channelTotalUsd, shareOfChannel: 1,
            poolTotalUsd: channelTotalUsd,
            byModel: channelConsumption
        };
    }

    // 本池 req 占比 = 该池所有账号 req / (该 channel 相关的所有池账号 req)
    // Plus 和 Free 共用 channel 3，相关的池就是 PLUS 和 FREE
    const sameChannelPools = Object.values(POOLS)
        .filter(p => p.newapiChannelKey === pool.newapiChannelKey);
    const aggMap = reusable.aggMap || await getCodexUsageAgg(days);

    // 拿这个 channel 下相关池所有账号的 uuid
    const [providerRows] = await dbPool.execute(`
        SELECT uuid, subscription_title
        FROM providers
        WHERE provider_type = 'openai-codex'
          AND is_deleted = 0
          AND subscription_title IN (${sameChannelPools.map(() => '?').join(',')})
    `, sameChannelPools.map(p => p.subscriptionTitle));

    let poolReqs = 0, totalReqs = 0;
    for (const r of providerRows) {
        const agg = aggMap.get(r.uuid);
        const reqs = agg ? agg.reqs : 0;
        totalReqs += reqs;
        if (r.subscription_title === pool.subscriptionTitle) poolReqs += reqs;
    }
    const share = totalReqs > 0 ? poolReqs / totalReqs : 0;

    return {
        channelTotalUsd,
        shareOfChannel: share,
        poolTotalUsd: channelTotalUsd * share,
        byModel: channelConsumption.map(m => ({
            ...m,
            reqs: Math.round(m.reqs * share),
            quotaUsd: m.quotaUsd * share,
            promptTokens: Math.round(m.promptTokens * share),
            completionTokens: Math.round(m.completionTokens * share)
        }))
    };
}

/** 汇总：单池整套仪表盘数据 */
export async function getPricingDashboard({ pool: poolKey = 'pro', days = 30, consumptionDays = 7 } = {}) {
    const poolDef = resolvePool(poolKey);

    // 预热可复用的聚合，避免 getPoolState + getNewapiPoolConsumption 各自再查一次
    const [usageMap, aggMap] = await Promise.all([
        getCodexUsageSnapshots(),
        getCodexUsageAgg(consumptionDays)
    ]);
    const reusable = { usageMap, aggMap };

    const [ratios, plans, sales, consumption] = await Promise.all([
        getNewapiPricingRatios(),
        getNewapiPoolPlans(poolKey),
        getNewapiPoolSales(poolKey, days),
        getNewapiPoolConsumption(poolKey, consumptionDays, reusable)
    ]);

    const poolTotalUsd = consumption.poolTotalUsd;
    const proPool = await getPoolState(poolKey, poolTotalUsd, reusable);

    const avgDaily = poolTotalUsd / Math.max(consumptionDays, 1);
    const activeConsuming = proPool.accounts.filter(a => (a.reqCount || 0) > 0).length || 1;
    const poolWeekCapacity = proPool.kWeeklyUsd * activeConsuming;
    const currentUtilization = poolWeekCapacity > 0
        ? (poolTotalUsd / (consumptionDays / 7)) / poolWeekCapacity
        : null;

    return {
        generatedAt: new Date().toISOString(),
        pool: poolDef,
        availablePools: Object.values(POOLS).map(p => ({
            key: p.key, label: p.label, description: p.description
        })),
        proPool,
        pricingRatios: ratios,
        plans,
        sales,
        consumption: {
            windowDays: consumptionDays,
            totalUsd: poolTotalUsd,
            channelTotalUsd: consumption.channelTotalUsd,
            shareOfChannel: consumption.shareOfChannel,
            avgDailyUsd: avgDaily,
            currentUtilization,
            byModel: consumption.byModel
        },
        defaults: {
            costPerAccountRmb: poolDef.defaultCostRmb,
            safetyFactor: 1.3,
            modelMix: 1.0
        }
    };
}

/** 各池顶部总览（轻量，共享查询，一次扫所有池） */
export async function getBusinessOverview({ days = 30, consumptionDays = 7 } = {}) {
    // 一次性拉所有可复用的 agg
    const [usageMap, aggMap] = await Promise.all([
        getCodexUsageSnapshots(),
        getCodexUsageAgg(consumptionDays)
    ]);
    const reusable = { usageMap, aggMap };

    const results = {};
    for (const key of POOL_KEYS) {
        const poolDef = POOLS[key];
        const [sales, consumption] = await Promise.all([
            getNewapiPoolSales(key, days),
            getNewapiPoolConsumption(key, consumptionDays, reusable)
        ]);
        const state = await getPoolState(key, consumption.poolTotalUsd, reusable);

        const totalRevenue = sales.reduce((a, b) => a + (b.revenueRmb || 0), 0);
        const totalSold = sales.reduce((a, b) => a + b.sold, 0);
        // 真实月成本按 tier 汇总（getPoolState 已算好）；没有 tier 的池退回 N × default
        const monthlyCost = state.monthlyCostRmb != null && state.monthlyCostRmb > 0
            ? state.monthlyCostRmb
            : state.totalAccounts * poolDef.defaultCostRmb;

        // 共享 channel 的池子：把 channel 级别的 sale 按 consumption 比例切给本池
        // （raw 字段保留原始值，attributed 用于 overview 计算避免重复加）
        const isShared = Boolean(poolDef.sharedChannel);
        const attrShare = isShared
            ? (consumption.shareOfChannel || 0)
            : 1;
        const attributedRevenueRmb = totalRevenue * attrShare;
        const attributedSoldCount = Math.round(totalSold * attrShare);

        results[key] = {
            key,
            label: poolDef.label,
            description: poolDef.description,
            defaultCostRmb: poolDef.defaultCostRmb,
            totalAccounts: state.totalAccounts,
            activeAccounts: state.activeAccounts,
            kMonthlyUsd: state.kMonthlyUsd,
            monthlyCostRmb: monthlyCost,
            tierBreakdown: state.tierBreakdown || null,
            sharesChannel: isShared,
            channelKey: poolDef.newapiChannelKey,
            windowDays: days,
            consumptionDays,
            recent: {
                // raw = 这个 channel 本身的合计（若共享，下面 attributed 会除以份额）
                soldCount: totalSold,
                revenueRmb: totalRevenue,
                attributedSoldCount,
                attributedRevenueRmb,
                consumedUsd: consumption.poolTotalUsd,
                channelConsumedUsd: consumption.channelTotalUsd,
                shareOfChannel: consumption.shareOfChannel
            },
            estMonthlyNetRmb: attributedRevenueRmb - monthlyCost
        };
    }
    return {
        generatedAt: new Date().toISOString(),
        pools: results,
        totals: {
            accounts: Object.values(results).reduce((a, b) => a + b.totalAccounts, 0),
            monthlyCostRmb: Object.values(results).reduce((a, b) => a + b.monthlyCostRmb, 0),
            // 用 attributed 数值汇总，不会重复加共享 channel
            monthlyRevenueRmb: Object.values(results).reduce((a, b) => a + (b.recent.attributedRevenueRmb || 0), 0),
            monthlyConsumedUsd: Object.values(results).reduce((a, b) => a + (b.recent.consumedUsd || 0), 0),
            estNetRmb: Object.values(results).reduce((a, b) => a + (b.estMonthlyNetRmb || 0), 0)
        }
    };
}
