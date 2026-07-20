import { MODEL_PROVIDER } from './common.js';

/**
 * 格式化 Grok billing 用量信息为 AccountHub 的统一结构。
 * @param {Object} usageData - Grok billing 原始响应
 * @returns {Object|null} 格式化后的用量信息
 */
export function formatXaiUsage(usageData) {
    if (!usageData) {
        return null;
    }

    const data = usageData.data && typeof usageData.data === 'object'
        ? usageData.data
        : usageData;
    const config = data.config && typeof data.config === 'object'
        ? data.config
        : {};
    const account = data.account && typeof data.account === 'object'
        ? data.account
        : {};

    const toNumber = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    };
    const clampPercent = (value) => {
        const num = toNumber(value);
        return num === null ? null : Math.max(0, Math.min(100, num));
    };
    const parseDate = (value) => {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const readVal = (value) => {
        if (value && typeof value === 'object' && value.val !== undefined) {
            return toNumber(value.val);
        }
        return toNumber(value);
    };
    const readBoolean = (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
        }
        return null;
    };

    const resetAt = parseDate(
        config.currentPeriod?.end
        ?? config.current_period?.end
        ?? config.billingPeriodEnd
        ?? config.billing_period_end
    );
    const periodType = String(
        config.currentPeriod?.type
        ?? config.current_period?.type
        ?? ''
    ).trim();
    const plan = [
        data.subscriptionTierDisplay,
        data.subscription_tier_display,
        data.settings?.subscriptionTierDisplay,
        data.settings?.subscription_tier_display,
        config.subscriptionTier,
        config.subscription_tier,
        data.subscriptionTier,
        data.subscription_tier
    ].find(value => typeof value === 'string' && value.trim()) || 'Grok OAuth';
    const usageBreakdown = [];

    const addPercentBreakdown = ({
        displayName,
        resourceType,
        usedPercent,
        subscriptionId,
        creditUsed = null,
        creditLimit = null
    }) => {
        const normalizedUsed = clampPercent(usedPercent);
        if (normalizedUsed === null) return;
        usageBreakdown.push({
            displayName,
            resourceType,
            currentUsage: normalizedUsed,
            usageLimit: 100,
            usedPercent: normalizedUsed,
            remainingPercent: Math.max(0, 100 - normalizedUsed),
            unit: '%',
            nextDateReset: resetAt,
            subscriptionId,
            creditUsed,
            creditLimit,
            creditUnit: creditUsed !== null || creditLimit !== null ? 'credits' : null
        });
    };

    if (periodType === 'USAGE_PERIOD_TYPE_WEEKLY') {
        // Grok 的 proto-JSON 会省略零值字段；fresh weekly 周期缺少该字段时实际是 0% 已用。
        const weeklyUsedPercent = config.creditUsagePercent
            ?? config.credit_usage_percent
            ?? 0;
        addPercentBreakdown({
            displayName: '每周共享额度',
            resourceType: 'XAI_WEEKLY_CREDITS',
            usedPercent: weeklyUsedPercent,
            subscriptionId: 'weekly_pool'
        });
    }

    const onDemandCap = readVal(config.onDemandCap ?? config.on_demand_cap);
    const onDemandUsed = readVal(config.onDemandUsed ?? config.on_demand_used);
    if (onDemandCap !== null && onDemandCap > 0 && onDemandUsed !== null) {
        addPercentBreakdown({
            displayName: '按需积分',
            resourceType: 'XAI_ON_DEMAND_CREDITS',
            usedPercent: (onDemandUsed / onDemandCap) * 100,
            subscriptionId: 'on_demand',
            creditUsed: onDemandUsed,
            creditLimit: onDemandCap
        });
    }

    const productUsage = Array.isArray(config.productUsage)
        ? config.productUsage
        : (Array.isArray(config.product_usage) ? config.product_usage : []);
    productUsage.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        const product = String(item.product ?? item.name ?? `产品 ${index + 1}`).trim();
        addPercentBreakdown({
            displayName: product || `产品 ${index + 1}`,
            resourceType: 'XAI_PRODUCT_CREDITS',
            usedPercent: item.usagePercent ?? item.usage_percent,
            subscriptionId: `product_${index + 1}`
        });
    });

    const prepaidBalance = readVal(config.prepaidBalance ?? config.prepaid_balance);
    const onDemandEnabled = readBoolean(
        data.settings?.on_demand_enabled
        ?? data.settings?.onDemandEnabled
        ?? config.onDemandEnabled
        ?? config.on_demand_enabled
    ) === true || (onDemandCap !== null && onDemandCap > 0);
    const hasPrepaidBalance = prepaidBalance !== null && prepaidBalance > 0;
    const overageCapability = onDemandCap !== null && onDemandCap > 0
        ? `按量付费上限 ${onDemandCap} credits`
        : (hasPrepaidBalance ? `按量付费余额 ${prepaidBalance} credits` : null);
    if (usageBreakdown.length === 0 && resetAt) {
        usageBreakdown.push({
            displayName: '结算周期',
            resourceType: 'XAI_BILLING_PERIOD',
            currentUsage: null,
            usageLimit: null,
            usedPercent: null,
            remainingPercent: null,
            unit: '',
            nextDateReset: resetAt,
            subscriptionId: 'billing_period'
        });
    }

    return {
        daysUntilReset: resetAt
            ? Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
            : null,
        nextDateReset: resetAt,
        quotaUnavailable: data.quotaUnavailable === true,
        quotaMessage: typeof data.quotaMessage === 'string' ? data.quotaMessage : null,
        quotaSource: typeof data.quotaSource === 'string' ? data.quotaSource : null,
        apiAccessVerified: data.apiAccessVerified === true,
        subscription: {
            title: String(plan).trim(),
            tier: String(plan).trim(),
            type: MODEL_PROVIDER.OPENAI_XAI,
            upgradeCapability: null,
            overageCapability
        },
        user: {
            email: account.email || data.email || null,
            userId: account.userId || account.user_id || data.userId || data.user_id || null,
            teamId: account.teamId || account.team_id || null
        },
        creditBalance: hasPrepaidBalance
            ? {
                remaining: prepaidBalance,
                unit: 'credits',
                type: 'on_demand',
                label: '按量付费余额'
            }
            : null,
        onDemand: {
            enabled: onDemandEnabled,
            cap: onDemandCap,
            used: onDemandUsed
        },
        usageBreakdown
    };
}
