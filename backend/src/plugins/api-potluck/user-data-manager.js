/**
 * API 大锅饭 - 用户数据管理模块
 * 管理用户关联的凭据与资源包（MySQL）
 */

import * as apiPotluckDao from '../../dao/api-potluck-dao.js';
import { getPool } from '../../config/database.js';

// 默认配置值
const DEFAULT_CONFIG = {
    defaultDailyLimit: 500,
    bonusPerCredential: 300,
    bonusValidityDays: 30,
    persistInterval: 5000
};

// 配置缓存
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5秒缓存

function normalizeConfig(configRow = {}) {
    return {
        defaultDailyLimit: configRow.default_daily_limit ?? DEFAULT_CONFIG.defaultDailyLimit,
        bonusPerCredential: configRow.bonus_per_credential ?? DEFAULT_CONFIG.bonusPerCredential,
        bonusValidityDays: configRow.bonus_validity_days ?? DEFAULT_CONFIG.bonusValidityDays,
        persistInterval: configRow.persist_interval ?? DEFAULT_CONFIG.persistInterval
    };
}

async function getConfigInternal(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
        return configCache;
    }
    const configRow = await apiPotluckDao.getConfig();
    configCache = normalizeConfig(configRow);
    configCacheTime = now;
    return configCache;
}

/**
 * 获取当前配置（对外暴露）
 */
export async function getConfig() {
    return getConfigInternal();
}

/**
 * 更新配置
 */
export async function updateConfig(newConfig) {
    const updatedRow = await apiPotluckDao.updateConfig(newConfig);
    configCache = normalizeConfig(updatedRow);
    configCacheTime = Date.now();
    return configCache;
}

/**
 * 兼容旧接口：更新资源包配置
 */
export async function updateBonusConfig(newConfig) {
    return updateConfig(newConfig);
}

/**
 * 停止文件监听（兼容旧接口）
 */
export function stopFileWatcher() {
    return;
}

/**
 * 获取用户数据
 */
export async function getUserData(apiKey) {
    const [userRow, credentials, bonuses] = await Promise.all([
        apiPotluckDao.getUser(apiKey),
        apiPotluckDao.getUserCredentials(apiKey),
        apiPotluckDao.getUserBonuses(apiKey)
    ]);

    if (!userRow) return null;

    return {
        credentials,
        credentialBonuses: bonuses,
        createdAt: userRow.created_at || userRow.createdAt || null,
        migratedFrom: userRow.migrated_from || userRow.migratedFrom || null,
        migratedAt: userRow.migrated_at || userRow.migratedAt || null
    };
}

/**
 * 初始化用户数据（如果不存在）
 */
export async function ensureUserData(apiKey) {
    await apiPotluckDao.ensureUser(apiKey);
    return getUserData(apiKey);
}

/**
 * 添加凭据路径到用户
 */
export async function addUserCredential(apiKey, credentialInfo) {
    return apiPotluckDao.addUserCredential(apiKey, credentialInfo);
}

/**
 * 移除用户凭据
 */
export async function removeUserCredential(apiKey, credentialId) {
    return apiPotluckDao.removeUserCredential(apiKey, credentialId);
}

/**
 * 获取用户的所有凭据
 */
export async function getUserCredentials(apiKey) {
    return apiPotluckDao.getUserCredentials(apiKey);
}

/**
 * 通过路径查找凭据
 */
export async function findCredentialByPath(apiKey, credPath) {
    return apiPotluckDao.findCredentialByPath(apiKey, credPath);
}

/**
 * 检查凭据路径是否已被任何用户使用
 */
export async function isCredentialPathUsed(credPath) {
    return apiPotluckDao.isCredentialPathUsed(credPath);
}

/**
 * 迁移用户凭据到新 Key（用于 Key 重置时）
 */
export async function migrateUserCredentials(oldApiKey, newApiKey) {
    const pool = getPool();
    const now = new Date();
    const migratedFrom = `${oldApiKey.substring(0, 12)}...`;

    await apiPotluckDao.ensureUser(newApiKey);

    await pool.query(
        'UPDATE api_potluck_user_credentials SET api_key = ? WHERE api_key = ?',
        [newApiKey, oldApiKey]
    );

    await pool.query(
        'UPDATE api_potluck_credential_bonuses SET api_key = ? WHERE api_key = ?',
        [newApiKey, oldApiKey]
    );

    await pool.query(
        'UPDATE api_potluck_users SET migrated_from = ?, migrated_at = ? WHERE api_key = ?',
        [migratedFrom, now, newApiKey]
    );

    console.log(`[API Potluck UserData] Migrated credentials from ${oldApiKey.substring(0, 12)}... to ${newApiKey.substring(0, 12)}...`);
    return true;
}

/**
 * 获取所有用户及其凭据（用于批量健康检查）
 */
export async function getAllUsersCredentials() {
    return apiPotluckDao.getAllUsersCredentials();
}

// ============ 凭证资源包管理 ============

/**
 * 为凭证添加资源包（凭证健康时调用）
 */
export async function addCredentialBonus(apiKey, credentialId) {
    const grantedAt = new Date();
    return apiPotluckDao.addCredentialBonus(apiKey, credentialId, grantedAt);
}

/**
 * 移除凭证资源包（凭证失效时调用）
 */
export async function removeCredentialBonus(apiKey, credentialId) {
    return apiPotluckDao.removeCredentialBonus(apiKey, credentialId);
}

/**
 * 消耗资源包次数（FIFO 顺序）
 */
export async function consumeBonus(apiKey) {
    const config = await getConfigInternal();
    return apiPotluckDao.consumeBonus(apiKey, config.bonusPerCredential, config.bonusValidityDays);
}

/**
 * 计算资源包剩余次数
 */
export async function calculateBonusRemaining(apiKey, healthyCredentialIds = null) {
    const config = await getConfigInternal();
    return apiPotluckDao.calculateBonusRemaining(apiKey, config.bonusPerCredential, config.bonusValidityDays, healthyCredentialIds);
}

/**
 * 同步资源包状态（根据健康凭证列表）
 */
export async function syncCredentialBonuses(apiKey, credentialsWithHealth) {
    const config = await getConfigInternal();
    return apiPotluckDao.syncCredentialBonuses(apiKey, credentialsWithHealth, config.bonusPerCredential, config.bonusValidityDays);
}

/**
 * 获取用户的资源包详情
 */
export async function getBonusDetails(apiKey) {
    const config = await getConfigInternal();
    const bonuses = await apiPotluckDao.getUserBonuses(apiKey);

    const bonusPerCredential = config.bonusPerCredential;
    const validityDays = config.bonusValidityDays;

    const now = Date.now();
    const bonusItems = bonuses.map((bonus) => {
        const grantedAt = new Date(bonus.grantedAt);
        const expiresAt = new Date(grantedAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
        return {
            credentialId: bonus.credentialId,
            grantedAt: bonus.grantedAt,
            expiresAt: expiresAt.toISOString(),
            usedCount: bonus.usedCount,
            remaining: Math.max(0, bonusPerCredential - bonus.usedCount),
            _expired: expiresAt.getTime() <= now
        };
    }).filter(item => !item._expired).map(({ _expired, ...rest }) => rest);

    const totalRemaining = bonusItems.reduce((sum, item) => sum + item.remaining, 0);

    return {
        bonuses: bonusItems,
        totalRemaining,
        bonusPerCredential,
        validityDays
    };
}

/**
 * 获取所有用户的 API Key 列表
 */
export async function getAllUserApiKeys() {
    return apiPotluckDao.getAllUserApiKeys();
}

// 兼容旧接口
export const USER_DATA_FILE = null;
