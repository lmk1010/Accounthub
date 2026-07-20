/**
 * ConsumptionStats - 数据库版本
 * 使用 MySQL 存储消耗统计数据，替代 JSON 文件存储
 */

import * as consumptionDao from '../dao/consumption-dao.js';

// 成本常量
const COST_CONSTANTS = {
    CREDITS_PER_ACCOUNT: 550,      // 1个1号 = 550积分
    COST_PER_ACCOUNT: 0.4,         // 1个1号 = 0.4元
    COST_PER_CREDIT: 0.4 / 550     // 每积分成本 ≈ 0.000727元
};

/**
 * 消耗统计服务（数据库版本）
 */
export class ConsumptionStatsDB {
    constructor() {
        this.stats = {
            startTime: null,
            lastUpdateTime: null,
            providers: {}
        };
        this._initialized = false;
    }

    /**
     * 初始化 - 从数据库加载数据
     */
    async initialize() {
        if (this._initialized) {
            console.log('[ConsumptionStatsDB] Already initialized');
            return;
        }

        console.log('[ConsumptionStatsDB] Initializing from database...');

        try {
            // 1. 加载元数据
            const meta = await consumptionDao.getMeta();
            this.stats.startTime = meta.start_time || new Date().toISOString();
            this.stats.lastUpdateTime = meta.last_update_time || new Date().toISOString();
            this.stats.lastSyncTime = meta.last_sync_time || null;

            // 2. 加载所有消耗统计
            const allStats = await consumptionDao.getAll();

            // 按 provider_type 分组
            this.stats.providers = {};

            for (const stat of allStats) {
                const providerType = stat.provider_type;

                if (!this.stats.providers[providerType]) {
                    this.stats.providers[providerType] = {
                        accounts: {},
                        totalCreditsUsed: 0,
                        totalCost: 0,
                        lastSync: null
                    };
                }

                this.stats.providers[providerType].accounts[stat.provider_uuid] = {
                    uuid: stat.provider_uuid,
                    name: stat.custom_name || 'Unknown',
                    creditsUsed: Number(stat.credits_used),
                    cost: Number(stat.cost),
                    lastUpdate: stat.last_update
                };

                this.stats.providers[providerType].totalCreditsUsed += Number(stat.credits_used);
                this.stats.providers[providerType].totalCost += Number(stat.cost);
            }

            this._initialized = true;

            console.log(`[ConsumptionStatsDB] Initialized successfully`);
            console.log(`[ConsumptionStatsDB] Loaded ${allStats.length} consumption records`);
        } catch (error) {
            console.error('[ConsumptionStatsDB] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * 保存统计数据到数据库
     */
    async save() {
        if (!this._initialized) {
            throw new Error('ConsumptionStatsDB not initialized. Call initialize() first.');
        }

        console.log('[ConsumptionStatsDB] Saving to database...');

        try {
            // 1. 更新元数据
            await consumptionDao.updateMeta({
                start_time: this.stats.startTime,
                last_update_time: new Date().toISOString(),
                last_sync_time: this.stats.lastSyncTime
            });

            // 2. 批量更新消耗统计
            const updates = [];
            for (const [providerType, providerData] of Object.entries(this.stats.providers)) {
                for (const [uuid, accountData] of Object.entries(providerData.accounts)) {
                    updates.push(
                        consumptionDao.update(uuid, {
                            provider_type: providerType,
                            custom_name: accountData.name,
                            credits_used: accountData.creditsUsed,
                            cost: accountData.cost
                        })
                    );
                }
            }

            await Promise.all(updates);

            console.log(`[ConsumptionStatsDB] Saved ${updates.length} records to database`);
        } catch (error) {
            console.error('[ConsumptionStatsDB] Save failed:', error);
            throw error;
        }
    }

    /**
     * 从 Kiro API 更新消耗统计
     */
    async updateFromKiroAPI(usageData) {
        if (!this._initialized) {
            throw new Error('ConsumptionStatsDB not initialized. Call initialize() first.');
        }

        console.log('[ConsumptionStatsDB] Updating from Kiro API...');

        const providerType = 'claude-kiro-oauth';

        if (!this.stats.providers[providerType]) {
            this.stats.providers[providerType] = {
                accounts: {},
                totalCreditsUsed: 0,
                totalCost: 0,
                lastSync: null
            };
        }

        const providerData = this.stats.providers[providerType];

        // 遍历所有账号的用量数据
        for (const accountUsage of usageData) {
            const uuid = accountUsage.uuid;
            const usage = accountUsage.usage;

            if (!usage || usage.error) {
                console.warn(`[ConsumptionStatsDB] Skipping account ${uuid}: ${usage?.error || 'No usage data'}`);
                continue;
            }

            // 计算积分消耗
            let creditsUsed = 0;
            if (usage.usageBreakdown && Array.isArray(usage.usageBreakdown)) {
                for (const breakdown of usage.usageBreakdown) {
                    creditsUsed += breakdown.currentUsage || 0;
                }
            }

            // 计算成本
            const cost = creditsUsed * COST_CONSTANTS.COST_PER_CREDIT;

            // 更新账号数据
            if (!providerData.accounts[uuid]) {
                providerData.accounts[uuid] = {
                    uuid,
                    name: accountUsage.customName || 'Unknown',
                    creditsUsed: 0,
                    cost: 0,
                    lastUpdate: new Date().toISOString()
                };
            }

            providerData.accounts[uuid].creditsUsed = creditsUsed;
            providerData.accounts[uuid].cost = cost;
            providerData.accounts[uuid].lastUpdate = new Date().toISOString();
        }

        // 重新计算总计
        providerData.totalCreditsUsed = 0;
        providerData.totalCost = 0;

        for (const accountData of Object.values(providerData.accounts)) {
            providerData.totalCreditsUsed += accountData.creditsUsed;
            providerData.totalCost += accountData.cost;
        }

        providerData.lastSync = new Date().toISOString();
        this.stats.lastSyncTime = new Date().toISOString();

        // 保存到数据库
        await this.save();

        console.log(`[ConsumptionStatsDB] Updated ${Object.keys(providerData.accounts).length} accounts`);
        console.log(`[ConsumptionStatsDB] Total credits: ${providerData.totalCreditsUsed}, Total cost: ${providerData.totalCost.toFixed(4)}`);
    }

    /**
     * 获取统计数据
     */
    getStats() {
        if (!this._initialized) {
            throw new Error('ConsumptionStatsDB not initialized. Call initialize() first.');
        }

        return {
            ...this.stats,
            costConstants: COST_CONSTANTS
        };
    }

    /**
     * 重置统计数据
     */
    async reset() {
        console.log('[ConsumptionStatsDB] Resetting statistics...');

        this.stats = {
            startTime: new Date().toISOString(),
            lastUpdateTime: new Date().toISOString(),
            providers: {}
        };

        // 清空数据库（保留表结构）
        // 这里可以选择删除所有记录或者保留历史数据
        await this.save();

        console.log('[ConsumptionStatsDB] Statistics reset');
    }
}

// 导出单例实例
export const consumptionStatsDB = new ConsumptionStatsDB();

/**
 * 获取消耗统计数据（兼容旧 API）
 */
export async function getConsumptionStats() {
    if (!consumptionStatsDB._initialized) {
        await consumptionStatsDB.initialize();
    }
    return consumptionStatsDB.getStats();
}

/**
 * 更新消耗统计数据（从 Kiro API 同步）
 */
export async function updateConsumptionStats() {
    // 这个函数需要从外部传入 usageData
    // 暂时返回当前统计数据
    if (!consumptionStatsDB._initialized) {
        await consumptionStatsDB.initialize();
    }
    return consumptionStatsDB.getStats();
}

/**
 * 重置消耗统计数据
 */
export async function resetConsumptionStats() {
    if (!consumptionStatsDB._initialized) {
        await consumptionStatsDB.initialize();
    }
    await consumptionStatsDB.reset();
    return consumptionStatsDB.getStats();
}
