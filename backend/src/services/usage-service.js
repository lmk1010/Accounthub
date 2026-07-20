/**
 * 用量查询服务
 * 用于处理各个提供商的授权文件用量查询
 */

import { getProviderPoolManager } from './service-manager.js';
import { peekServiceAdapter } from '../providers/adapter.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import { selectBestCodexPlanTitle } from '../utils/codex-plan.js';
export { formatXaiUsage } from '../utils/xai-usage.js';

const NEWAPI_QUOTA_UNIT_DIVISOR = 500000;

function resolveNewApiQuotaScale(rawQuotaLimit, rawCurrentUsage) {
    const quotaNum = Number(rawQuotaLimit);
    const usedNum = Number(rawCurrentUsage);
    if (Number.isFinite(quotaNum) && Math.abs(quotaNum) >= NEWAPI_QUOTA_UNIT_DIVISOR) {
        return NEWAPI_QUOTA_UNIT_DIVISOR;
    }
    if (!Number.isFinite(quotaNum) && Number.isFinite(usedNum) && Math.abs(usedNum) >= NEWAPI_QUOTA_UNIT_DIVISOR) {
        return NEWAPI_QUOTA_UNIT_DIVISOR;
    }
    return 1;
}

/**
 * 用量查询服务类
 * 提供统一的接口来查询各提供商的用量信息
 */
export class UsageService {
    constructor() {
        this.providerHandlers = {
            [MODEL_PROVIDER.KIRO_API]: this.getKiroUsage.bind(this),
            [MODEL_PROVIDER.GEMINI_CLI]: this.getGeminiUsage.bind(this),
            [MODEL_PROVIDER.ANTIGRAVITY]: this.getAntigravityUsage.bind(this),
            [MODEL_PROVIDER.CLAUDE_ANTIGRAVITY]: this.getClaudeAntigravityUsage.bind(this),
            [MODEL_PROVIDER.OPENAI_CODEX]: this.getCodexUsage.bind(this),
            [MODEL_PROVIDER.OPENAI_XAI]: this.getXaiUsage.bind(this),
        };
    }

    /**
     * 获取指定提供商的用量信息
     * @param {string} providerType - 提供商类型
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} 用量信息
     */
    async getUsage(providerType, uuid = null) {
        const handler = this.providerHandlers[providerType];
        if (!handler) {
            throw new Error(`不支持的提供商类型: ${providerType}`);
        }
        return handler(uuid);
    }

    /**
     * 获取所有提供商的用量信息
     * @returns {Promise<Object>} 所有提供商的用量信息
     */
    async getAllUsage() {
        const results = {};
        const poolManager = getProviderPoolManager();
        
        for (const [providerType, handler] of Object.entries(this.providerHandlers)) {
            try {
                // 检查是否有号池配置
                if (poolManager) {
                    const pools = await poolManager.getProviderPools(providerType);
                    if (pools && pools.length > 0) {
                        results[providerType] = [];
                        for (const pool of pools) {
                            try {
                                const usage = await handler(pool.uuid);
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    usage
                                });
                            } catch (error) {
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    error: error.message
                                });
                            }
                        }
                    }
                }
                
                // 如果没有号池配置，尝试获取单个实例的用量
                if (!results[providerType] || results[providerType].length === 0) {
                    const usage = await handler(null);
                    results[providerType] = [{ uuid: 'default', usage }];
                }
            } catch (error) {
                results[providerType] = [{ uuid: 'default', error: error.message }];
            }
        }
        
        return results;
    }

    /**
     * 获取 Kiro 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Kiro 用量信息
     */
    async getKiroUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.KIRO_API + uuid : MODEL_PROVIDER.KIRO_API;
        const adapter = peekServiceAdapter(providerKey);
        
        if (!adapter) {
            throw new Error(`Kiro 服务实例未找到: ${providerKey}`);
        }
        
        // 使用适配器的 getUsageLimits 方法
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }
        
        // 兼容直接访问 kiroApiService 的情况
        if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            return adapter.kiroApiService.getUsageLimits();
        }
        
        throw new Error(`Kiro 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 Gemini CLI 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Gemini 用量信息
     */
    async getGeminiUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.GEMINI_CLI + uuid : MODEL_PROVIDER.GEMINI_CLI;
        const adapter = peekServiceAdapter(providerKey);
        
        if (!adapter) {
            throw new Error(`Gemini CLI 服务实例未找到: ${providerKey}`);
        }
        
        // 使用适配器的 getUsageLimits 方法
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }
        
        // 兼容直接访问 geminiApiService 的情况
        if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            return adapter.geminiApiService.getUsageLimits();
        }
        
        throw new Error(`Gemini CLI 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 Antigravity 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Antigravity 用量信息
     */
    async getAntigravityUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.ANTIGRAVITY + uuid : MODEL_PROVIDER.ANTIGRAVITY;
        const adapter = peekServiceAdapter(providerKey);
        
        if (!adapter) {
            throw new Error(`Antigravity 服务实例未找到: ${providerKey}`);
        }
        
        // 使用适配器的 getUsageLimits 方法
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }
        
        // 兼容直接访问 antigravityApiService 的情况
        if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            return adapter.antigravityApiService.getUsageLimits();
        }
        
        throw new Error(`Antigravity 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 Claude Antigravity 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Claude Antigravity 用量信息
     */
    async getClaudeAntigravityUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.CLAUDE_ANTIGRAVITY + uuid : MODEL_PROVIDER.CLAUDE_ANTIGRAVITY;
        const adapter = peekServiceAdapter(providerKey);

        if (!adapter) {
            throw new Error(`Claude Antigravity 服务实例未找到: ${providerKey}`);
        }

        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }

        if (adapter.claudeAntigravityApiService && typeof adapter.claudeAntigravityApiService.getUsageLimits === 'function') {
            return adapter.claudeAntigravityApiService.getUsageLimits();
        }

        throw new Error(`Claude Antigravity 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 OpenAI Codex 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Codex 用量信息
     */
    async getCodexUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.OPENAI_CODEX + uuid : MODEL_PROVIDER.OPENAI_CODEX;
        const adapter = peekServiceAdapter(providerKey);

        if (!adapter) {
            throw new Error(`Codex 服务实例未找到: ${providerKey}`);
        }

        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }

        if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function') {
            return adapter.codexApiService.getUsageLimits();
        }

        throw new Error(`Codex 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 xAI Grok OAuth 提供商的用量信息
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} Grok 用量信息
     */
    async getXaiUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.OPENAI_XAI + uuid : MODEL_PROVIDER.OPENAI_XAI;
        const adapter = peekServiceAdapter(providerKey);

        if (!adapter) {
            throw new Error(`xAI Grok 服务实例未找到: ${providerKey}`);
        }

        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }

        if (adapter.xaiApiService && typeof adapter.xaiApiService.getUsageLimits === 'function') {
            return adapter.xaiApiService.getUsageLimits();
        }

        throw new Error(`xAI Grok 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取支持用量查询的提供商列表
     * @returns {Array<string>} 支持的提供商类型列表
     */
    getSupportedProviders() {
        return Object.keys(this.providerHandlers);
    }
}

// 导出单例实例
export const usageService = new UsageService();

/**
 * 格式化 Kiro 用量信息为易读格式
 * @param {Object} usageData - 原始用量数据
 * @returns {Object} 格式化后的用量信息
 */
export function formatKiroUsage(usageData) {
    if (!usageData) {
        return null;
    }

    function tsToBeijing(epochSec) {
        try {
            if (!epochSec) return null;
            return new Date(epochSec * 1000)
                .toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                .replace(/\//g, '-');
        } catch (e) {
            return null;
        }
    }

    const result = {
        // 基本信息
        daysUntilReset: usageData.daysUntilReset,
        nextDateReset: tsToBeijing(usageData.nextDateReset),
        
        // 订阅信息
        subscription: null,
        
        // 用户信息
        user: null,
        
        // 用量明细
        usageBreakdown: []
    };

    // 解析订阅信息
    if (usageData.subscriptionInfo) {
        result.subscription = {
            title: usageData.subscriptionInfo.subscriptionTitle,
            type: usageData.subscriptionInfo.type,
            upgradeCapability: usageData.subscriptionInfo.upgradeCapability,
            overageCapability: usageData.subscriptionInfo.overageCapability
        };
    }

    // 解析用户信息
    if (usageData.userInfo) {
        result.user = {
            email: usageData.userInfo.email,
            userId: usageData.userInfo.userId
        };
    }

    // 解析用量明细
    const breakdownList = Array.isArray(usageData.usageBreakdownList)
        ? usageData.usageBreakdownList
        : Array.isArray(usageData.usageBreakdown)
        ? usageData.usageBreakdown
        : Array.isArray(usageData.usage_breakdown_list)
        ? usageData.usage_breakdown_list
        : [];

    if (breakdownList.length) {
        for (const breakdown of breakdownList) {
            const remainingPercentRaw = breakdown.remainingPercent ?? breakdown.remainingPercentage ?? breakdown.remaining_percent;
            let remainingPercent = null;
            if (remainingPercentRaw !== undefined && remainingPercentRaw !== null && remainingPercentRaw !== '') {
                const parsed = Number(remainingPercentRaw);
                if (Number.isFinite(parsed)) {
                    remainingPercent = parsed <= 1 && parsed >= 0 ? parsed * 100 : parsed;
                }
            }

            // 优先使用 freeTrialInfo 中的用量（FREE 账号）
            const freeTrialInfo = breakdown.freeTrialInfo;
            const freeTrialStatus = freeTrialInfo?.freeTrialStatus;
            const freeTrialUsageLimit = freeTrialInfo?.usageLimitWithPrecision ?? freeTrialInfo?.usageLimit;
            const freeTrialCurrentUsage = freeTrialInfo?.currentUsageWithPrecision ?? freeTrialInfo?.currentUsage;
            const freeTrialActive = freeTrialInfo
                && (!freeTrialStatus || String(freeTrialStatus).toUpperCase().includes('ACTIVE'));
            const useFreeTrial = freeTrialActive && freeTrialUsageLimit !== undefined && freeTrialUsageLimit !== null;
            const currentUsage = useFreeTrial
                ? freeTrialCurrentUsage
                : (breakdown.currentUsageWithPrecision ?? breakdown.currentUsage);
            const usageLimit = useFreeTrial
                ? freeTrialUsageLimit
                : (breakdown.usageLimitWithPrecision ?? breakdown.usageLimit);

            const item = {
                resourceType: breakdown.resourceType,
                displayName: breakdown.displayName,
                displayNamePlural: breakdown.displayNamePlural,
                unit: breakdown.unit,
                currency: breakdown.currency,

                // 当前用量
                currentUsage: currentUsage,
                usageLimit: usageLimit,
                
                // 超额信息
                currentOverages: breakdown.currentOveragesWithPrecision ?? breakdown.currentOverages,
                overageCap: breakdown.overageCapWithPrecision ?? breakdown.overageCap,
                overageRate: breakdown.overageRate,
                overageCharges: breakdown.overageCharges,
                
                // 下次重置时间（UTC+8 北京时间）
                nextDateReset: tsToBeijing(breakdown.nextDateReset),
                
                // 免费试用信息
                freeTrial: null,
                
                // 奖励信息
                bonuses: []
            };

            // 解析免费试用信息
            if (breakdown.freeTrialInfo) {
                item.freeTrial = {
                    status: breakdown.freeTrialInfo.freeTrialStatus,
                    currentUsage: breakdown.freeTrialInfo.currentUsageWithPrecision ?? breakdown.freeTrialInfo.currentUsage,
                    usageLimit: breakdown.freeTrialInfo.usageLimitWithPrecision ?? breakdown.freeTrialInfo.usageLimit,
                    expiresAt: breakdown.freeTrialInfo.freeTrialExpiry 
                        ? new Date(breakdown.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
                        : null
                };
            }

            // 解析奖励信息
            if (breakdown.bonuses && Array.isArray(breakdown.bonuses)) {
                for (const bonus of breakdown.bonuses) {
                    item.bonuses.push({
                        code: bonus.bonusCode,
                        displayName: bonus.displayName,
                        description: bonus.description,
                        status: bonus.status,
                        currentUsage: bonus.currentUsage,
                        usageLimit: bonus.usageLimit,
                        redeemedAt: bonus.redeemedAt ? new Date(bonus.redeemedAt * 1000).toISOString() : null,
                        expiresAt: bonus.expiresAt ? new Date(bonus.expiresAt * 1000).toISOString() : null
                    });
                }
            }

            if (remainingPercent !== null) {
                item.remainingPercent = remainingPercent;
            }

            result.usageBreakdown.push(item);
        }
    }

    return result;
}

/**
 * 格式化 Gemini 用量信息为易读格式（映射到 Kiro 数据结构）
 * @param {Object} usageData - 原始用量数据
 * @returns {Object} 格式化后的用量信息
 */
export function formatGeminiUsage(usageData) {
    if (!usageData) {
        return null;
    }

    /**
     * 将 UTC 时间转换为北京时间
     * @param {string} utcString - UTC 时间字符串
     * @returns {string} 北京时间字符串
     */
    function utcToBeijing(utcString) {
        try {
            if (!utcString) return '--';
            return new Date(utcString)
                .toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                .replace(/\//g, '-');
        } catch (e) {
            return '--';
        }
    }

    const result = {
        // 基本信息 - 映射到 Kiro 结构
        daysUntilReset: null,
        nextDateReset: null,
        
        // 订阅信息
        subscription: {
            title: 'Gemini CLI OAuth',
            type: 'gemini-cli-oauth',
            upgradeCapability: null,
            overageCapability: null
        },
        
        // 用户信息
        user: {
            email: null,
            userId: null
        },
        
        // 用量明细
        usageBreakdown: []
    };

    // 解析配额信息
    if (usageData.quotaInfo) {
        result.subscription.title = usageData.quotaInfo.currentTier || 'Gemini CLI OAuth';
        if (usageData.quotaInfo.quotaResetTime) {
            result.nextDateReset = utcToBeijing(usageData.quotaInfo.quotaResetTime);
            // 计算距离重置的天数
            const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
            const now = new Date();
            const diffTime = resetDate.getTime() - now.getTime();
            result.daysUntilReset = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    }

    // 解析模型配额信息
    if (usageData.models && typeof usageData.models === 'object') {
        for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
            // Gemini 返回的数据结构：{ remaining, resetTime, resetTimeRaw }
            // remaining 是 0-1 之间的比例值，表示剩余配额百分比
            const remainingPercent = typeof modelInfo.remaining === 'number' ? modelInfo.remaining : 1;
            const usedPercent = 1 - remainingPercent;

            const rawResetTime = modelInfo.resetTimeRaw || modelInfo.resetTime || null;

            const item = {
                resourceType: 'MODEL_USAGE',
                displayName: modelInfo.displayName || modelName,
                displayNamePlural: modelInfo.displayName || modelName,
                unit: 'quota',
                currency: null,

                // 当前用量 - Gemini 返回的是剩余比例，转换为已用比例（百分比形式）
                currentUsage: Math.round(usedPercent * 100),
                usageLimit: 100, // 以百分比表示，总量为 100%

                // 超额信息
                currentOverages: 0,
                overageCap: 0,
                overageRate: null,
                overageCharges: 0,

                // 下次重置时间（UTC+8 北京时间）
                nextDateReset: rawResetTime ? utcToBeijing(rawResetTime) : null,
                
                // 免费试用信息
                freeTrial: null,
                
                // 奖励信息
                bonuses: [],

                // 额外的 Gemini 特有信息
                modelName: modelName,
                inputTokenLimit: modelInfo.inputTokenLimit || 0,
                outputTokenLimit: modelInfo.outputTokenLimit || 0,
                remaining: remainingPercent,
                remainingPercent: Math.round(remainingPercent * 100), // 剩余百分比
                resetTime: (modelInfo.resetTimeRaw || modelInfo.resetTime) ?
                           utcToBeijing(modelInfo.resetTimeRaw || modelInfo.resetTime) : '--',
                resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null
            };

            result.usageBreakdown.push(item);
        }
    }

    // 如果顶层 nextDateReset 为空，从 breakdown 中取第一个
    if (!result.nextDateReset && result.usageBreakdown.length > 0) {
        result.nextDateReset = result.usageBreakdown[0].nextDateReset || null;
    }

    return result;
}

/**
 * 格式化 Antigravity 用量信息为易读格式（映射到 Kiro 数据结构）
 * @param {Object} usageData - 原始用量数据
 * @returns {Object} 格式化后的用量信息
 */
export function formatAntigravityUsage(usageData) {
    if (!usageData) {
        return null;
    }

    /**
     * 将 UTC 时间转换为北京时间
     * @param {string} utcString - UTC 时间字符串
     * @returns {string} 北京时间字符串
     */
    function utcToBeijing(utcString) {
        try {
            if (!utcString) return '--';
            return new Date(utcString)
                .toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                .replace(/\//g, '-');
        } catch (e) {
            return '--';
        }
    }

    // 解析订阅等级 (FREE/PRO/ULTRA)
    const subscriptionTier = usageData.subscriptionTier || usageData.subscription_tier || 'FREE';

    const result = {
        // 基本信息 - 映射到 Kiro 结构
        daysUntilReset: null,
        nextDateReset: null,

        // 订阅信息
        subscription: {
            title: 'Gemini Antigravity',
            type: 'gemini-antigravity',
            tier: subscriptionTier, // FREE/PRO/ULTRA
            upgradeCapability: null,
            overageCapability: null
        },

        // 用户信息
        user: {
            email: null,
            userId: null
        },

        // 用量明细
        usageBreakdown: []
    };

    // 解析配额信息
    if (usageData.quotaInfo) {
        result.subscription.title = usageData.quotaInfo.currentTier || 'Gemini Antigravity';
        if (usageData.quotaInfo.quotaResetTime) {
            result.nextDateReset = utcToBeijing(usageData.quotaInfo.quotaResetTime);
            // 计算距离重置的天数
            const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
            const now = new Date();
            const diffTime = resetDate.getTime() - now.getTime();
            result.daysUntilReset = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    }

    // 解析模型配额信息
    if (usageData.models && typeof usageData.models === 'object') {
        for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
            // Antigravity 返回的数据结构：{ remaining, resetTime, resetTimeRaw }
            // remaining 是 0-1 之间的比例值，表示剩余配额百分比
            const remainingPercent = typeof modelInfo.remaining === 'number' ? modelInfo.remaining : 1;
            const usedPercent = 1 - remainingPercent;

            const rawResetTime = modelInfo.resetTimeRaw || modelInfo.resetTime || null;

            const item = {
                resourceType: 'MODEL_USAGE',
                displayName: modelInfo.displayName || modelName,
                displayNamePlural: modelInfo.displayName || modelName,
                unit: 'quota',
                currency: null,

                // 当前用量 - Antigravity 返回的是剩余比例，转换为已用比例（百分比形式）
                currentUsage: usedPercent * 100,
                usageLimit: 100, // 以百分比表示，总量为 100%

                // 超额信息
                currentOverages: 0,
                overageCap: 0,
                overageRate: null,
                overageCharges: 0,

                // 下次重置时间（UTC+8 北京时间）
                nextDateReset: rawResetTime ? utcToBeijing(rawResetTime) : null,
                
                // 免费试用信息
                freeTrial: null,
                
                // 奖励信息
                bonuses: [],

                // 额外的 Antigravity 特有信息
                modelName: modelName,
                inputTokenLimit: modelInfo.inputTokenLimit || 0,
                outputTokenLimit: modelInfo.outputTokenLimit || 0,
                remaining: remainingPercent,
                remainingPercent: remainingPercent * 100, // 剩余百分比
                resetTime: (modelInfo.resetTimeRaw || modelInfo.resetTime) ?
                           utcToBeijing(modelInfo.resetTimeRaw || modelInfo.resetTime) : '--',
                resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null
            };

            result.usageBreakdown.push(item);
        }
    }

    // 如果顶层 nextDateReset 为空，从 breakdown 中取第一个
    if (!result.nextDateReset && result.usageBreakdown.length > 0) {
        result.nextDateReset = result.usageBreakdown[0].nextDateReset || null;
    }

    return result;
}

/**
 * 格式化 Codex 用量信息为易读格式（尽量映射到 Kiro 结构）
 * @param {Object} usageData - 原始用量数据
 * @returns {Object} 格式化后的用量信息
 */
export function formatCodexUsage(usageData) {
    if (!usageData) {
        return null;
    }

    const data = usageData.data && typeof usageData.data === 'object' ? usageData.data : usageData;

    const result = {
        daysUntilReset: null,
        nextDateReset: null,
        subscription: {
            title: 'OpenAI Codex OAuth',
            type: 'openai-codex',
            upgradeCapability: null,
            overageCapability: null
        },
        user: {
            email: data.email || data.user_email || data.account_email || null,
            userId: data.userId || data.user_id || data.account_id || data.accountId || null
        },
        usageBreakdown: []
    };

    const subscriptionTitle = selectBestCodexPlanTitle(
        data.subscriptionTitle,
        data.subscription_title,
        data.plan,
        data.plan_type,
        data.planType,
        data.subscription?.title,
        data.subscription?.plan,
        data.subscription?.planType
    );
    if (subscriptionTitle) {
        result.subscription.title = subscriptionTitle;
    }

    function toNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function normalizePercent(value) {
        const num = toNumber(value);
        if (num === null) return null;
        // Only treat as 0-1 ratio when strictly between 0 and 1 (exclusive).
        // Values like 0 or 1 from wham API are already percentages (0%, 1%).
        const percent = num > 0 && num < 1 ? num * 100 : num;
        return Math.max(0, Math.min(100, percent));
    }

    function parseDateValue(value) {
        if (!value) return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString();
        }
        if (typeof value === 'number') {
            const ts = value < 1e12 ? value * 1000 : value;
            const date = new Date(ts);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            const asNumber = Number(trimmed);
            if (Number.isFinite(asNumber)) {
                return parseDateValue(asNumber);
            }
            const date = new Date(trimmed);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        return null;
    }

    function pickDate(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            if (obj[key]) {
                const parsed = parseDateValue(obj[key]);
                if (parsed) return parsed;
            }
        }
        return null;
    }

    function pickNumber(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                const num = toNumber(obj[key]);
                if (num !== null) return num;
            }
        }
        return null;
    }

    function extractUsageEntry(entry, fallbackName, defaultResetAt) {
        if (!entry || typeof entry !== 'object') return null;

        const usedKeys = [
            'currentUsage', 'used', 'usage', 'consumed', 'spent',
            'total_used', 'totalUsage', 'total_usage', 'used_amount',
            'usage_amount', 'usedQuota', 'tokensUsed', 'used_tokens'
        ];
        const limitKeys = [
            'usageLimit', 'limit', 'quota', 'total', 'totalLimit',
            'total_limit', 'max', 'capacity', 'allowance', 'budget'
        ];
        const remainingKeys = [
            'remaining', 'remainingQuota', 'remaining_quota', 'available',
            'left', 'balance', 'remaining_amount'
        ];
        const usedPercentKeys = [
            'percent', 'usagePercent', 'usage_percent', 'usedPercent',
            'used_percent', 'utilization', 'usagePercentage', 'usage_percentage'
        ];
        const remainingPercentKeys = [
            'remainingPercent', 'remaining_percent', 'remainingRatio',
            'remaining_ratio', 'remainingRate', 'remaining_rate'
        ];

        let used = pickNumber(entry, usedKeys);
        let limit = pickNumber(entry, limitKeys);
        const remaining = pickNumber(entry, remainingKeys);
        const usedPercent = normalizePercent(pickNumber(entry, usedPercentKeys));
        const remainingPercent = normalizePercent(pickNumber(entry, remainingPercentKeys));

        if (limit === null && remaining !== null && used !== null) {
            limit = used + remaining;
        }
        if (used === null && limit !== null && remaining !== null) {
            used = limit - remaining;
        }
        if (used === null && usedPercent !== null && limit !== null) {
            used = limit * (usedPercent / 100);
        }
        if (limit === null && used !== null && usedPercent !== null && usedPercent > 0) {
            limit = used / (usedPercent / 100);
        }
        if (limit === null && usedPercent !== null) {
            used = usedPercent;
            limit = 100;
        }
        if (used === null && limit === null && remainingPercent !== null) {
            used = 100 - remainingPercent;
            limit = 100;
        }

        if (used === null && limit === null) {
            return null;
        }

        const displayName = entry.displayName || entry.display_name || entry.name || entry.title ||
            entry.model || entry.type || entry.id || fallbackName || 'usage';
        const unit = entry.unit || entry.currency || entry.unitName || entry.unit_name || '';
        const nextReset = pickDate(entry, [
            'nextDateReset', 'next_reset', 'resetAt', 'reset_at',
            'resetTime', 'reset_time', 'period_end', 'billing_cycle_end'
        ]) || defaultResetAt;

        const item = {
            resourceType: entry.resourceType || entry.resource_type || 'USAGE',
            displayName: String(displayName),
            displayNamePlural: String(displayName),
            unit: unit || '',
            currency: entry.currency || null,
            currentUsage: used,
            usageLimit: limit ?? 0,
            currentOverages: 0,
            overageCap: 0,
            overageRate: null,
            overageCharges: 0,
            nextDateReset: nextReset,
            freeTrial: null,
            bonuses: []
        };

        if (remainingPercent !== null) {
            item.remainingPercent = remainingPercent;
        }

        return item;
    }

    function formatWindowDurationLabel(limitWindowSeconds) {
        const totalSeconds = toNumber(limitWindowSeconds);
        if (totalSeconds === null || totalSeconds <= 0) return null;
        if (totalSeconds % 86400 === 0) {
            return `${totalSeconds / 86400}天`;
        }
        if (totalSeconds % 3600 === 0) {
            return `${totalSeconds / 3600}小时`;
        }
        if (totalSeconds % 60 === 0) {
            return `${totalSeconds / 60}分钟`;
        }
        return `${totalSeconds}秒`;
    }

    function resolveCodexRateLimitLabel(label, limitWindowSeconds, metadata = {}) {
        const labelText = typeof label === 'string' ? label.trim() : '';
        if (labelText) return labelText;

        const limitIdText = typeof metadata.limitId === 'string' ? metadata.limitId.trim().toLowerCase() : '';
        const meteredFeatureText = typeof metadata.meteredFeature === 'string' ? metadata.meteredFeature.trim().toLowerCase() : '';
        const inferredSpark = limitIdText.includes('spark')
            || meteredFeatureText.includes('spark')
            || limitIdText === 'codex_other'
            || meteredFeatureText === 'codex_other';
        const prefix = inferredSpark
            ? 'Spark'
            : (typeof metadata.labelPrefix === 'string' ? metadata.labelPrefix.trim() : '');
        const durationText = formatWindowDurationLabel(limitWindowSeconds);
        if (prefix && durationText) return `${prefix} ${durationText}窗口`;
        if (prefix) return prefix;
        if (durationText) return `${durationText}窗口`;
        if (metadata.windowType === 'primary') return '主窗口';
        if (metadata.windowType === 'secondary') return '次窗口';
        return 'Rate Limit';
    }

    function extractRateLimitWindow(windowData, label, defaultResetAt, metadata = {}) {
        if (!windowData || typeof windowData !== 'object') return null;

        const usedPercent = normalizePercent(pickNumber(windowData, [
            'used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'usedPercentage'
        ]));
        const remainingPercent = normalizePercent(pickNumber(windowData, [
            'remaining_percent', 'remainingPercent', 'remaining_ratio', 'remainingRate'
        ]));
        const resetAfterSeconds = pickNumber(windowData, [
            'reset_after_seconds', 'resetAfterSeconds', 'reset_after', 'resetAfter'
        ]);
        const limitWindowSeconds = pickNumber(windowData, [
            'limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds',
            'limit_window', 'window'
        ]);
        const resetAtRaw = pickNumber(windowData, ['reset_at', 'resetAt']);
        let used = pickNumber(windowData, [
            'used', 'usage', 'current_usage', 'currentUsage', 'consumed', 'spent'
        ]);
        let limit = pickNumber(windowData, [
            'limit', 'quota', 'total', 'max', 'capacity', 'allowance'
        ]);

        if (used === null && usedPercent !== null) {
            used = usedPercent;
        }
        if (limit === null && usedPercent !== null) {
            limit = 100;
        }

        let resolvedRemaining = remainingPercent;
        if (usedPercent !== null) {
            resolvedRemaining = Math.max(0, Math.min(100, 100 - usedPercent));
        }

        if (used === null && limit === null && resolvedRemaining === null) {
            return null;
        }

        const nextReset = pickDate(windowData, [
            'nextDateReset', 'next_reset', 'resetAt', 'reset_at',
            'resetTime', 'reset_time', 'period_end', 'billing_cycle_end'
        ]) || defaultResetAt;

        const resolvedLabel = resolveCodexRateLimitLabel(label, limitWindowSeconds, metadata);

        const item = {
            resourceType: 'RATE_LIMIT',
            displayName: resolvedLabel,
            displayNamePlural: resolvedLabel,
            unit: limit === 100 && usedPercent !== null ? '%' : '',
            currency: null,
            currentUsage: used ?? 0,
            usageLimit: limit ?? 0,
            currentOverages: 0,
            overageCap: 0,
            overageRate: null,
            overageCharges: 0,
            nextDateReset: nextReset,
            freeTrial: null,
            bonuses: []
        };

        if (metadata.limitGroup) {
            item.limitGroup = metadata.limitGroup;
        }
        if (metadata.windowType) {
            item.windowType = metadata.windowType;
        }
        if (metadata.limitId) {
            item.limitId = metadata.limitId;
        }
        if (metadata.meteredFeature) {
            item.meteredFeature = metadata.meteredFeature;
        }

        if (resolvedRemaining !== null) {
            item.remainingPercent = resolvedRemaining;
        }
        const resolvedUsedPercent = usedPercent !== null
            ? usedPercent
            : (resolvedRemaining !== null ? Math.max(0, Math.min(100, 100 - resolvedRemaining)) : null);
        if (resolvedUsedPercent !== null) {
            item.usedPercent = resolvedUsedPercent;
        }
        if (resetAfterSeconds !== null) {
            item.resetAfterSeconds = resetAfterSeconds;
        }
        if (limitWindowSeconds !== null) {
            item.limitWindowSeconds = limitWindowSeconds;
        }
        if (resetAtRaw !== null) {
            item.resetAt = resetAtRaw;
        }

        return item;
    }

    const topReset = pickDate(data, [
        'nextDateReset', 'next_reset', 'resetAt', 'reset_at',
        'resetTime', 'reset_time', 'period_end', 'billing_cycle_end'
    ]);

    if (topReset) {
        result.nextDateReset = topReset;
        const resetDate = new Date(topReset);
        const now = new Date();
        const diffTime = resetDate.getTime() - now.getTime();
        result.daysUntilReset = Number.isNaN(diffTime) ? null : Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    const rateLimit = data.rate_limit || data.rateLimit;
    if (rateLimit && typeof rateLimit === 'object') {
        const windowDefs = [
            { key: 'primary_window', windowType: 'primary' },
            { key: 'secondary_window', windowType: 'secondary' }
        ];
        let earliestReset = null;

        for (const def of windowDefs) {
            const camelKey = def.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            const windowData = rateLimit[def.key] || rateLimit[camelKey];
            const item = extractRateLimitWindow(windowData, null, topReset, {
                limitGroup: 'main',
                windowType: def.windowType
            });
            if (item) {
                result.usageBreakdown.push(item);
                if (item.nextDateReset) {
                    const parsed = parseDateValue(item.nextDateReset);
                    if (parsed && (!earliestReset || new Date(parsed) < new Date(earliestReset))) {
                        earliestReset = parsed;
                    }
                }
            }
        }

        if (!result.nextDateReset && earliestReset) {
            result.nextDateReset = earliestReset;
            const resetDate = new Date(earliestReset);
            const now = new Date();
            const diffTime = resetDate.getTime() - now.getTime();
            result.daysUntilReset = Number.isNaN(diffTime) ? null : Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    }

    // Parse code_review_rate_limit (same structure as rate_limit)
    const codeReviewLimit = data.code_review_rate_limit || data.codeReviewRateLimit;
    if (codeReviewLimit && typeof codeReviewLimit === 'object') {
        const crWindowDefs = [
            { key: 'primary_window', windowType: 'primary' },
            { key: 'secondary_window', windowType: 'secondary' }
        ];
        for (const def of crWindowDefs) {
            const camelKey = def.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            const windowData = codeReviewLimit[def.key] || codeReviewLimit[camelKey];
            const item = extractRateLimitWindow(windowData, null, topReset, {
                limitGroup: 'code_review',
                windowType: def.windowType,
                labelPrefix: 'Code Review'
            });
            if (item) {
                result.usageBreakdown.push(item);
            }
        }
    }

    const additionalRateLimits = data.additional_rate_limits || data.additionalRateLimits;
    if (Array.isArray(additionalRateLimits)) {
        for (const entry of additionalRateLimits) {
            if (!entry || typeof entry !== 'object') continue;
            const rateLimitDetails = entry.rate_limit || entry.rateLimit;
            if (!rateLimitDetails || typeof rateLimitDetails !== 'object') continue;

            const limitIdRaw = entry.limit_name || entry.limitName || entry.metered_feature || entry.meteredFeature || 'Additional Rate Limit';
            const meteredFeatureRaw = entry.metered_feature || entry.meteredFeature || null;
            const labelPrefix = String(limitIdRaw);
            const windowDefs = [
                { key: 'primary_window', windowType: 'primary' },
                { key: 'secondary_window', windowType: 'secondary' }
            ];

            for (const def of windowDefs) {
                const camelKey = def.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                const windowData = rateLimitDetails[def.key] || rateLimitDetails[camelKey];
                const item = extractRateLimitWindow(windowData, null, topReset, {
                    limitGroup: 'additional',
                    windowType: def.windowType,
                    limitId: labelPrefix,
                    meteredFeature: meteredFeatureRaw ? String(meteredFeatureRaw) : null,
                    labelPrefix
                });
                if (item) {
                    result.usageBreakdown.push(item);
                }
            }
        }
    }

    const candidates = [
        data.usageBreakdown,
        data.usage,
        data.items,
        data.limits,
        data.buckets,
        data.metrics,
        data.balances
    ].filter(Array.isArray);

    for (const list of candidates) {
        for (const entry of list) {
            const item = extractUsageEntry(entry, null, topReset);
            if (item) result.usageBreakdown.push(item);
        }
    }

    if (data.models && typeof data.models === 'object' && !Array.isArray(data.models)) {
        for (const [modelName, modelInfo] of Object.entries(data.models)) {
            const item = extractUsageEntry(modelInfo, modelName, topReset);
            if (item) {
                item.modelName = modelName;
                result.usageBreakdown.push(item);
            }
        }
    }

    if (result.usageBreakdown.length === 0) {
        const fallback = extractUsageEntry(data, 'Total', topReset);
        if (fallback) {
            result.usageBreakdown.push(fallback);
        }
    }

    return result;
}

/**
 * 格式化 Codex 图片额度信息（来自 /backend-api/conversation/init）
 * @param {Object} usageData - 原始图片额度数据
 * @returns {Object|null}
 */
export function formatCodexImageUsage(usageData) {
    if (!usageData) {
        return null;
    }

    const data = usageData.data && typeof usageData.data === 'object' ? usageData.data : usageData;
    const limitsProgress = Array.isArray(data?.limits_progress)
        ? data.limits_progress
        : (Array.isArray(data?.limitsProgress) ? data.limitsProgress : []);

    const toOptionalNumber = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    };

    const parseDateValue = (value) => {
        if (!value) return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString();
        }
        if (typeof value === 'number') {
            const ts = value < 1e12 ? value * 1000 : value;
            const date = new Date(ts);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            const asNumber = Number(trimmed);
            if (Number.isFinite(asNumber)) {
                return parseDateValue(asNumber);
            }
            const date = new Date(trimmed);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        return null;
    };

    const pickNumber = (obj, keys) => {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                const num = toOptionalNumber(obj[key]);
                if (num !== null) return num;
            }
        }
        return null;
    };

    const pickDate = (obj, keys) => {
        if (!obj || typeof obj !== 'object') return null;
        for (const key of keys) {
            const parsed = parseDateValue(obj[key]);
            if (parsed) return parsed;
        }
        return null;
    };

    const imageEntry = limitsProgress.find((item) => {
        const featureName = String(item?.feature_name || item?.featureName || '').trim().toLowerCase();
        return featureName === 'image_gen';
    }) || null;

    const featureName = imageEntry?.feature_name || imageEntry?.featureName || 'image_gen';
    const remaining = pickNumber(imageEntry, ['remaining', 'quota', 'available', 'left']);
    const explicitLimit = pickNumber(imageEntry, ['limit', 'max', 'total', 'quota_limit', 'quotaLimit']);
    const explicitUsed = pickNumber(imageEntry, ['used', 'consumed', 'current_usage', 'currentUsage', 'spent']);
    const resetAt = pickDate(imageEntry, ['reset_after', 'resetAfter', 'restore_at', 'restoreAt', 'reset_at', 'resetAt', 'next_reset_at']);

    let limit = explicitLimit;
    let used = explicitUsed;
    if (used === null && limit !== null && remaining !== null) {
        used = Math.max(0, limit - remaining);
    }
    if (limit === null && used !== null && remaining !== null) {
        limit = Math.max(used + remaining, 0);
    }

    let remainingPercent = null;
    if (limit !== null && limit > 0 && remaining !== null) {
        remainingPercent = Math.max(0, Math.min(100, (remaining / limit) * 100));
    }

    const status = (() => {
        if (!imageEntry) return 'not_returned';
        if (remaining === null) return 'unknown';
        if (remaining <= 0) return 'critical';
        if (remaining <= 2) return 'warning';
        return 'normal';
    })();

    return {
        source: 'conversation/init',
        featureName,
        status,
        defaultModelSlug: data?.default_model_slug || data?.defaultModelSlug || null,
        remaining,
        used,
        limit,
        unit: 'images',
        resetAt,
        entry: imageEntry,
        limitsProgress,
        usageBreakdown: imageEntry ? [{
            resourceType: 'IMAGE_GENERATION',
            displayName: 'Image Generation',
            displayNamePlural: 'Image Generations',
            unit: 'images',
            currentUsage: used,
            usageLimit: limit,
            nextDateReset: resetAt,
            remaining,
            remainingPercent,
            featureName
        }] : []
    };
}

/**
 * 格式化 Foxcode 用量信息
 * @param {Object} usageData - 原始用量数据
 * @returns {Object|null} 统一格式的用量信息
 */
export function formatFoxcodeUsage(usageData) {
    if (!usageData || typeof usageData !== 'object') {
        return null;
    }

    const data = usageData?.data && typeof usageData.data === 'object' ? usageData.data : usageData;

    // Claude Official OAuth /api/oauth/usage 响应适配
    const oauthWindows = [
        { key: 'five_hour', label: '5小时窗口' },
        { key: 'seven_day', label: '7天窗口' },
        { key: 'seven_day_sonnet', label: '7天Sonnet窗口' },
        { key: 'seven_day_opus', label: '7天Opus窗口' }
    ];
    const hasOauthUsageWindow = oauthWindows.some((item) => data?.[item.key] && typeof data[item.key] === 'object');
    if (hasOauthUsageWindow) {
        const parseUtilization = (value) => {
            if (value === null || value === undefined || value === '') return null;
            if (typeof value === 'string') {
                const cleaned = value.trim().replace(/%$/, '');
                if (!cleaned) return null;
                const parsed = Number(cleaned);
                return Number.isFinite(parsed) ? parsed : null;
            }
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const utilizationSamples = oauthWindows
            .map(({ key }) => parseUtilization(data?.[key]?.utilization))
            .filter((value) => Number.isFinite(value));
        const hasGtOne = utilizationSamples.some((value) => value > 1);
        const hasBetweenZeroAndOne = utilizationSamples.some((value) => value > 0 && value < 1);

        const toPercent = (value) => {
            const num = parseUtilization(value);
            if (!Number.isFinite(num)) return null;
            if (num > 1) {
                return Math.max(0, Math.min(100, num));
            }
            if (num < 1) {
                return Math.max(0, Math.min(100, num * 100));
            }
            if (!hasGtOne && hasBetweenZeroAndOne) {
                return 100;
            }
            return 1;
        };

        const usageBreakdown = oauthWindows
            .map(({ key, label }) => {
                const windowData = data?.[key];
                if (!windowData || typeof windowData !== 'object') return null;
                const usedPercent = toPercent(windowData?.utilization);
                if (usedPercent === null) return null;
                return {
                    resourceType: 'WINDOW',
                    displayName: label,
                    displayNamePlural: label,
                    unit: 'percent',
                    currency: null,
                    currentUsage: usedPercent,
                    usageLimit: 100,
                    currentOverages: 0,
                    overageCap: 0,
                    overageRate: null,
                    overageCharges: 0,
                    nextDateReset: windowData?.resets_at || null,
                    freeTrial: null,
                    bonuses: [],
                    remainingPercent: Math.max(0, 100 - usedPercent),
                    usedPercent,
                    subscriptionId: key,
                    resetType: 'WINDOW'
                };
            })
            .filter(Boolean);

        // extra_usage（额外用量/超额用量）
        const extraUsage = data?.extra_usage;
        if (extraUsage && typeof extraUsage === 'object' && extraUsage.is_enabled) {
            const monthlyLimit = Number(extraUsage.monthly_limit) || 0;
            const usedCredits = Number(extraUsage.used_credits) || 0;
            const extraUtil = toPercent(extraUsage.utilization);
            usageBreakdown.push({
                resourceType: 'EXTRA_USAGE',
                displayName: '额外用量',
                displayNamePlural: '额外用量',
                unit: 'credits',
                currency: 'USD',
                currentUsage: usedCredits,
                usageLimit: monthlyLimit,
                currentOverages: 0,
                overageCap: 0,
                overageRate: null,
                overageCharges: 0,
                nextDateReset: null,
                freeTrial: null,
                bonuses: [],
                remainingPercent: monthlyLimit > 0 ? Math.max(0, ((monthlyLimit - usedCredits) / monthlyLimit) * 100) : null,
                usedPercent: extraUtil ?? (monthlyLimit > 0 ? (usedCredits / monthlyLimit) * 100 : 0),
                subscriptionId: 'extra_usage',
                resetType: 'MONTHLY'
            });
        }

        const usagePercent = usageBreakdown.length > 0
            ? Math.max(...usageBreakdown.map((item) => Number(item.usedPercent) || 0))
            : null;

        return {
            daysUntilReset: null,
            nextDateReset: usageBreakdown[0]?.nextDateReset || null,
            subscription: {
                title: 'Claude Official OAuth',
                type: 'claude-official-oauth',
                upgradeCapability: null,
                overageCapability: null
            },
            user: {
                email: data?.email || data?.user?.email || null,
                userId: data?.user_id || data?.userId || data?.id || null
            },
            usageBreakdown,
            subscriptionBreakdown: usageBreakdown.map((item) => ({
                subscriptionId: item.subscriptionId,
                planName: item.displayName,
                used: item.usedPercent,           // 已使用百分比
                limit: 100,                        // 总额度 100%
                remaining: item.remainingPercent,  // 剩余百分比
                usagePercentage: item.usedPercent,
                resetType: item.resetType,
                lastResetAt: item.nextDateReset
            })),
            quota: {
                currentUsage: usagePercent,
                quotaLimit: 100,
                quotaRemaining: usagePercent === null ? null : Math.max(0, 100 - usagePercent),
                usagePercentage: usagePercent
            }
        };
    }

    // NewAPI /api/user/self 响应适配
    const newApiQuota = Number(data?.quota);
    const newApiUsed = Number(data?.used_quota ?? data?.usedQuota);
    if (Number.isFinite(newApiQuota) || Number.isFinite(newApiUsed)) {
        const rawQuotaLimit = Number.isFinite(newApiQuota) ? newApiQuota : 0;
        const rawCurrentUsage = Number.isFinite(newApiUsed) ? newApiUsed : 0;
        const scale = resolveNewApiQuotaScale(rawQuotaLimit, rawCurrentUsage);
        const quotaLimit = rawQuotaLimit / scale;
        const currentUsage = rawCurrentUsage / scale;
        const quotaRemaining = quotaLimit > 0 ? Math.max(0, quotaLimit - currentUsage) : 0;
        const usagePercentage = rawQuotaLimit > 0 ? (rawCurrentUsage / rawQuotaLimit) * 100 : null;
        const remainingPercent = quotaLimit > 0 ? (quotaRemaining / quotaLimit) * 100 : null;
        const planName = data?.group || 'NewAPI';
        const userId = data?.id ?? data?.userId ?? null;

        return {
            daysUntilReset: null,
            nextDateReset: null,
            subscription: {
                title: planName,
                type: 'newapi',
                upgradeCapability: null,
                overageCapability: null
            },
            user: {
                email: data?.email || null,
                userId: userId != null ? String(userId) : null,
                username: data?.username || null
            },
            usageBreakdown: [
                {
                    resourceType: 'CREDIT',
                    displayName: planName,
                    displayNamePlural: planName,
                    unit: 'quota',
                    currency: null,
                    currentUsage,
                    usageLimit: quotaLimit,
                    currentOverages: 0,
                    overageCap: 0,
                    overageRate: null,
                    overageCharges: 0,
                    nextDateReset: null,
                    freeTrial: null,
                    bonuses: [],
                    remainingPercent,
                    usedPercent: usagePercentage,
                    subscriptionId: userId != null ? `newapi:${userId}` : null,
                    resetType: null
                }
            ],
            subscriptionBreakdown: [
                {
                    subscriptionId: userId != null ? `newapi:${userId}` : 'newapi',
                    planName,
                    used: currentUsage,
                    limit: quotaLimit,
                    remaining: quotaRemaining,
                    usagePercentage,
                    resetType: null,
                    lastResetAt: null
                }
            ],
            quota: {
                currentUsage,
                quotaLimit,
                quotaRemaining,
                usagePercentage
            }
        };
    }

    const quota = data?.quota && typeof data.quota === 'object' ? data.quota : {};
    const user = data?.user && typeof data.user === 'object' ? data.user : {};
    const sourceBreakdown = Array.isArray(quota.subscriptionBreakdown) ? quota.subscriptionBreakdown : [];

    const normalizeNum = (value) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };

    const usageBreakdown = sourceBreakdown.map((item) => {
        const used = normalizeNum(item?.used);
        const limit = normalizeNum(item?.limit);
        const remaining = normalizeNum(item?.remaining);
        const remainingPercent = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : null;
        return {
            resourceType: 'CREDIT',
            displayName: item?.planName || 'Foxcode Quota',
            displayNamePlural: item?.planName || 'Foxcode Quota',
            unit: 'tokens',
            currency: null,
            currentUsage: used,
            usageLimit: limit,
            currentOverages: 0,
            overageCap: 0,
            overageRate: null,
            overageCharges: 0,
            nextDateReset: item?.lastResetAt || null,
            freeTrial: null,
            bonuses: [],
            remainingPercent,
            usedPercent: remainingPercent === null ? null : Math.max(0, Math.min(100, 100 - remainingPercent)),
            subscriptionId: item?.subscriptionId || null,
            resetType: item?.resetType || null
        };
    });

    const firstPlan = usageBreakdown[0] || null;
    return {
        daysUntilReset: null,
        nextDateReset: firstPlan?.nextDateReset || null,
        subscription: {
            title: firstPlan?.displayName || data?.subscription?.current?.plan?.name || 'Foxcode',
            type: 'foxcode',
            upgradeCapability: null,
            overageCapability: null
        },
        user: {
            email: user?.email || null,
            userId: user?.id || null
        },
        usageBreakdown,
        subscriptionBreakdown: sourceBreakdown,
        quota: {
            currentUsage: quota?.currentUsage ?? null,
            quotaLimit: quota?.quotaLimit ?? null,
            quotaRemaining: quota?.quotaRemaining ?? null,
            usagePercentage: quota?.usagePercentage ?? null
        }
    };
}

/**
 * 格式化 Windsurf 用量数据 (来自 getUserStatus 返回值)
 * 输入: { planName, dailyPercent, weeklyPercent, dailyResetAt, weeklyResetAt,
 *         prompt:{used,limit,remaining}, flex:{used,limit,remaining}, percent, overageBalance }
 */
export function formatWindsurfUsage(data) {
    if (!data) return null;

    function tsToBeijing(epochSec) {
        try {
            if (!epochSec) return null;
            return new Date(epochSec * 1000)
                .toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                })
                .replace(/\//g, '-');
        } catch {
            return null;
        }
    }

    const usageBreakdown = [];

    if (data.dailyPercent != null) {
        const remainingPercent = Math.max(0, Math.min(100, data.dailyPercent));
        usageBreakdown.push({
            displayName: '每日额度',
            resourceType: 'DAILY_QUOTA',
            remainingPercent,
            usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
            currentUsage: null,
            usageLimit: null,
            unit: '%',
            nextDateReset: tsToBeijing(data.dailyResetAt),
            subscriptionId: 'daily',
            resetType: 'daily',
        });
    }

    if (data.weeklyPercent != null) {
        const remainingPercent = Math.max(0, Math.min(100, data.weeklyPercent));
        usageBreakdown.push({
            displayName: '每周额度',
            resourceType: 'WEEKLY_QUOTA',
            remainingPercent,
            usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
            currentUsage: null,
            usageLimit: null,
            unit: '%',
            nextDateReset: tsToBeijing(data.weeklyResetAt),
            subscriptionId: 'weekly',
            resetType: 'weekly',
        });
    }

    if (data.prompt?.limit != null && data.prompt.limit > 0) {
        const used = data.prompt.used ?? 0;
        usageBreakdown.push({
            displayName: 'Prompt Credits',
            resourceType: 'PROMPT_CREDITS',
            currentUsage: used,
            usageLimit: data.prompt.limit,
            remainingPercent: data.prompt.limit > 0
                ? Math.max(0, Math.min(100, ((data.prompt.remaining ?? (data.prompt.limit - used)) / data.prompt.limit) * 100))
                : null,
            usedPercent: data.prompt.limit > 0
                ? Math.max(0, Math.min(100, (used / data.prompt.limit) * 100))
                : null,
            unit: 'credits',
            nextDateReset: null,
            subscriptionId: 'prompt',
            resetType: 'monthly',
        });
    }

    return {
        daysUntilReset: null,
        nextDateReset: usageBreakdown[0]?.nextDateReset || null,
        subscription: {
            title: data.planName || 'Windsurf',
            type: 'windsurf',
            upgradeCapability: null,
            overageCapability: data.overageBalance != null ? `余额 $${data.overageBalance.toFixed(2)}` : null,
        },
        user: null,
        usageBreakdown,
    };
}
