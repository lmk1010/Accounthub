/**
 * 配置服务层
 * 处理配置管理的业务逻辑
 */

import { CONFIG } from '../core/config-manager.js';
import { wipeAllServiceInstances } from '../providers/adapter.js';
import { initApiService } from './service-manager.js';
import * as appMetaDao from '../dao/app-meta-dao.js';
import { configureMonitoring } from './monitoring-scheduler.js';

/**
 * 获取配置
 */
export async function getConfig(currentConfig) {
    let systemPrompt = currentConfig.SYSTEM_PROMPT_CONTENT || '';

    try {
        const storedPrompt = await appMetaDao.getValue('system_prompt_content');
        if (storedPrompt !== null) {
            systemPrompt = storedPrompt;
        }
    } catch (error) {
        console.warn('[Config] Failed to read system prompt from database:', error.message);
    }

    return {
        ...currentConfig,
        PROXY_POOL_ENABLED: currentConfig.PROXY_POOL_ENABLED ?? false,
        systemPrompt
    };
}

/**
 * 更新配置
 */
export async function updateConfig(updates, currentConfig) {
    try {
        // 更新内存中的配置
        const configFields = [
            'REQUIRED_API_KEY', 'HOST', 'SERVER_PORT', 'MODEL_PROVIDER',
            'PUBLIC_API_BASE_URL',
            'SYSTEM_PROMPT_MODE', 'PROMPT_LOG_BASE_NAME', 'PROMPT_LOG_MODE',
            'REQUEST_MAX_RETRIES', 'REQUEST_BASE_DELAY', 'CREDENTIAL_SWITCH_MAX_RETRIES',
            'CRON_NEAR_MINUTES', 'CRON_REFRESH_TOKEN', 'MAX_ERROR_COUNT',
            'AUTH_TOKEN_CLEANUP_ENABLED', 'AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES',
            'PROVIDER_HEALTH_CHECK_ENABLED', 'PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES',
            'POTLUCK_HEALTH_SYNC_ENABLED', 'POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES',
            'USAGE_AUTO_DISABLE', 'USAGE_WARN_THRESHOLD', 'USAGE_DISABLE_THRESHOLD',
            'USAGE_REFRESH_ENABLED', 'USAGE_REFRESH_INTERVAL_MINUTES',
            'CODEX_AUTO_REPLENISH_ENABLED', 'CODEX_AUTO_REPLENISH_MODE', 'CODEX_AUTO_REPLENISH_SCRIPT_PATH',
            'CODEX_AUTO_REPLENISH_PYTHON_BIN', 'CODEX_AUTO_REPLENISH_PROXY',
            'CODEX_AUTO_REPLENISH_POOL_ID', 'CODEX_AUTO_REPLENISH_MIN_HEALTHY',
            'CODEX_AUTO_REPLENISH_BATCH_SIZE', 'CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS',
            'CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE', 'CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY',
            'CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN',
            'CODEX_STRICT_REQUEST_ALIGNMENT',
            'providerFallbackChain', 'modelFallbackMapping',
            'PROXY_URL', 'PROXY_ENABLED_PROVIDERS', 'PROXY_POOL_ENABLED',
            'OAUTH_CALLBACK_HOST', 'OAUTH_CALLBACK_SCHEME', 'OAUTH_CALLBACK_PORT'
        ];

        for (const field of configFields) {
            if (updates[field] !== undefined) {
                currentConfig[field] = updates[field];
            }
        }

        if (currentConfig.PROXY_POOL_ENABLED === undefined || currentConfig.PROXY_POOL_ENABLED === null) {
            currentConfig.PROXY_POOL_ENABLED = false;
        }

        // 处理系统提示更新
        if (updates.systemPrompt !== undefined) {
            await appMetaDao.setValue('system_prompt_content', updates.systemPrompt);
            currentConfig.SYSTEM_PROMPT_CONTENT = updates.systemPrompt;
        }

        // 保存配置到数据库
        await saveConfigToDatabase(currentConfig);

        return {
            success: true,
            message: 'Configuration updated successfully'
        };
    } catch (error) {
        console.error('[Config] Update config error:', error);
        return {
            success: false,
            message: error.message || 'Failed to update configuration'
        };
    }
}

/**
 * 更新管理员密码
 */
export async function updateAdminPassword(oldPassword, newPassword) {
    // 使用 bcrypt 安全验证旧密码
    const { validateCredentials, changePassword } = await import('../ui-modules/auth.js');
    const isValid = await validateCredentials(oldPassword);

    if (!isValid) {
        return {
            success: false,
            message: 'Incorrect old password'
        };
    }

    try {
        await changePassword(newPassword);

        return {
            success: true,
            message: 'Password updated successfully'
        };
    } catch (error) {
        console.error('[Config] Update admin password error:', error);
        return {
            success: false,
            message: error.message || 'Failed to update password'
        };
    }
}

/**
 * 保存配置到数据库
 */
async function saveConfigToDatabase(config) {
    if (config.PROXY_POOL_ENABLED === undefined || config.PROXY_POOL_ENABLED === null) {
        config.PROXY_POOL_ENABLED = false;
    }

    const configKeys = [
        'REQUIRED_API_KEY', 'HOST', 'SERVER_PORT', 'MODEL_PROVIDER',
        'PUBLIC_API_BASE_URL',
        'SYSTEM_PROMPT_MODE', 'PROMPT_LOG_BASE_NAME', 'PROMPT_LOG_MODE',
        'REQUEST_MAX_RETRIES', 'REQUEST_BASE_DELAY', 'CREDENTIAL_SWITCH_MAX_RETRIES',
        'CRON_NEAR_MINUTES', 'CRON_REFRESH_TOKEN', 'MAX_ERROR_COUNT',
        'AUTH_TOKEN_CLEANUP_ENABLED', 'AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES',
        'PROVIDER_HEALTH_CHECK_ENABLED', 'PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES',
        'POTLUCK_HEALTH_SYNC_ENABLED', 'POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES',
        'USAGE_AUTO_DISABLE', 'USAGE_WARN_THRESHOLD', 'USAGE_DISABLE_THRESHOLD',
        'USAGE_REFRESH_ENABLED', 'USAGE_REFRESH_INTERVAL_MINUTES',
        'CODEX_AUTO_REPLENISH_ENABLED', 'CODEX_AUTO_REPLENISH_MODE', 'CODEX_AUTO_REPLENISH_SCRIPT_PATH',
        'CODEX_AUTO_REPLENISH_PYTHON_BIN', 'CODEX_AUTO_REPLENISH_PROXY',
        'CODEX_AUTO_REPLENISH_POOL_ID', 'CODEX_AUTO_REPLENISH_MIN_HEALTHY',
        'CODEX_AUTO_REPLENISH_BATCH_SIZE', 'CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS',
        'CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE', 'CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY',
        'CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN',
        'CODEX_STRICT_REQUEST_ALIGNMENT',
        'PROXY_URL', 'PROXY_ENABLED_PROVIDERS', 'PROXY_POOL_ENABLED',
        'OAUTH_CALLBACK_HOST', 'OAUTH_CALLBACK_SCHEME', 'OAUTH_CALLBACK_PORT'
    ];

    for (const key of configKeys) {
        if (config[key] !== undefined) {
            let value = config[key];

            // 对于数组和对象，转换为 JSON 字符串
            if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                value = JSON.stringify(value);
            } else {
                // 对于基本类型，转换为字符串
                value = String(value);
            }

            await appMetaDao.setValue(key, value);
        }
    }

    // 保存复杂对象
    if (config.providerFallbackChain) {
        await appMetaDao.setValue('providerFallbackChain', JSON.stringify(config.providerFallbackChain));
    }

    if (config.modelFallbackMapping) {
        await appMetaDao.setValue('modelFallbackMapping', JSON.stringify(config.modelFallbackMapping));
    }
}

/**
 * 重载配置
 */
export async function reloadConfig(providerPoolManager) {
    try {
        const { initializeConfig } = await import('../core/config-manager.js');

        const newConfig = await initializeConfig(process.argv.slice(2));

        if (providerPoolManager) {
            await providerPoolManager.reload();
        }

        Object.assign(CONFIG, newConfig);

        // 清空并 dispose 所有服务实例,再重新初始化
        wipeAllServiceInstances();
        const services = await initApiService(CONFIG);
        configureMonitoring({
            config: CONFIG,
            providerPoolManager,
            services
        });

        console.log('[Config] Configuration reloaded successfully');

        return newConfig;
    } catch (error) {
        console.error('[Config] Failed to reload configuration:', error);
        throw error;
    }
}
