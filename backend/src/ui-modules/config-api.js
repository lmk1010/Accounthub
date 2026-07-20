import { CONFIG } from '../core/config-manager.js';
import { wipeAllServiceInstances } from '../providers/adapter.js';
import { initApiService } from '../services/service-manager.js';
import { configureMonitoring } from '../services/monitoring-scheduler.js';
import { getRequestBody } from '../utils/common.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import * as appMetaDao from '../dao/app-meta-dao.js';

const META_CONFIG_KEYS = [
    'REQUIRED_API_KEY',
    'HOST',
    'SERVER_PORT',
    'MODEL_PROVIDER',
    'PUBLIC_API_BASE_URL',
    'SYSTEM_PROMPT_MODE',
    'PROMPT_LOG_BASE_NAME',
    'PROMPT_LOG_MODE',
    'REQUEST_MAX_RETRIES',
    'REQUEST_BASE_DELAY',
    'CREDENTIAL_SWITCH_MAX_RETRIES',
    'CRON_NEAR_MINUTES',
    'CRON_REFRESH_TOKEN',
    'MAX_ERROR_COUNT',
    'AUTH_TOKEN_CLEANUP_ENABLED',
    'AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES',
    'PROVIDER_HEALTH_CHECK_ENABLED',
    'PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES',
    'POTLUCK_HEALTH_SYNC_ENABLED',
    'POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES',
    'USAGE_REFRESH_ENABLED',
    'USAGE_REFRESH_INTERVAL_MINUTES',
    'USAGE_AUTO_DISABLE',
    'USAGE_WARN_THRESHOLD',
    'USAGE_DISABLE_THRESHOLD',
    'CODEX_AUTO_REPLENISH_ENABLED',
    'CODEX_AUTO_REPLENISH_MODE',
    'CODEX_AUTO_REPLENISH_SCRIPT_PATH',
    'CODEX_AUTO_REPLENISH_PYTHON_BIN',
    'CODEX_AUTO_REPLENISH_PROXY',
    'CODEX_AUTO_REPLENISH_POOL_ID',
    'CODEX_AUTO_REPLENISH_MIN_HEALTHY',
    'CODEX_AUTO_REPLENISH_BATCH_SIZE',
    'CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS',
    'CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE',
    'CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY',
    'CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN',
    'providerFallbackChain',
    'modelFallbackMapping',
    'PROXY_URL',
    'PROXY_ENABLED_PROVIDERS',
    'PROXY_POOL_ENABLED',
    'OAUTH_CALLBACK_HOST',
    'OAUTH_CALLBACK_SCHEME',
    'OAUTH_CALLBACK_PORT'
];

function normalizeMetaValue(value) {
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        return JSON.stringify(value);
    }
    return String(value);
}

async function saveConfigKeysToMeta(config) {
    for (const key of META_CONFIG_KEYS) {
        if (config[key] === undefined) continue;
        const value = normalizeMetaValue(config[key]);
        await appMetaDao.setValue(key, value);
    }
}

/**
 * 重载配置文件
 * 动态导入config-manager并重新初始化配置
 * @returns {Promise<Object>} 返回重载后的配置对象
 */
export async function reloadConfig(providerPoolManager, options = {}) {
    try {
        // Import config manager dynamically
        const { initializeConfig } = await import('../core/config-manager.js');
        
        // Reload main config
        const newConfig = await initializeConfig(process.argv.slice(2));
        // Update provider pool manager if available
        if (providerPoolManager) {
            // Reload provider data from database
            const shouldBroadcastPool = options.broadcastProviderPool !== false;
            await providerPoolManager.reload({ broadcast: shouldBroadcastPool });
        }
        
        // Update global CONFIG
        Object.assign(CONFIG, newConfig);
        console.log('[UI API] Configuration reloaded:');

        // Update initApiService - 清空并 dispose 所有服务实例,再重新初始化
        wipeAllServiceInstances();
        const services = await initApiService(CONFIG);
        configureMonitoring({
            config: CONFIG,
            providerPoolManager,
            services
        });
        
        console.log('[UI API] Configuration reloaded successfully');
        
        return newConfig;
    } catch (error) {
        console.error('[UI API] Failed to reload configuration:', error);
        throw error;
    }
}

function requestConfigReloadBroadcast(reason = 'update') {
    // Phase 2+3 补丁:admin 进程也需要能广播 config_reload 给 workers
    // admin 通过 spawn 的 stdio ipc 发,master.js 的 adminProcess.on('message') 转发给 cluster workers
    const canBroadcast = (process.env.IS_WORKER_PROCESS === 'true'
        || process.env.IS_ADMIN_PROCESS === 'true')
        && typeof process.send === 'function';
    if (canBroadcast) {
        process.send({
            type: 'config_reload',
            originPid: process.pid,
            reason
        });
    }
}

/**
 * 获取配置
 */
export async function handleGetConfig(req, res, currentConfig) {
    let systemPrompt = currentConfig.SYSTEM_PROMPT_CONTENT || '';
    try {
        const storedPrompt = await appMetaDao.getValue('system_prompt_content');
        if (storedPrompt !== null) {
            systemPrompt = storedPrompt;
        }
    } catch (error) {
        console.warn('[UI API] Failed to read system prompt from database:', error.message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...currentConfig,
        systemPrompt
    }));
    return true;
}

/**
 * 更新配置
 */
export async function handleUpdateConfig(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const newConfig = body;

        // Update config values in memory
        if (newConfig.REQUIRED_API_KEY !== undefined) currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
        if (newConfig.HOST !== undefined) currentConfig.HOST = newConfig.HOST;
        if (newConfig.SERVER_PORT !== undefined) currentConfig.SERVER_PORT = newConfig.SERVER_PORT;
        if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
        if (newConfig.PUBLIC_API_BASE_URL !== undefined) currentConfig.PUBLIC_API_BASE_URL = newConfig.PUBLIC_API_BASE_URL;
        if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
        if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
        if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
        if (newConfig.REQUEST_MAX_RETRIES !== undefined) currentConfig.REQUEST_MAX_RETRIES = newConfig.REQUEST_MAX_RETRIES;
        if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
        if (newConfig.CREDENTIAL_SWITCH_MAX_RETRIES !== undefined) currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES = newConfig.CREDENTIAL_SWITCH_MAX_RETRIES;
        if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
        if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
        if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
        if (newConfig.AUTH_TOKEN_CLEANUP_ENABLED !== undefined) {
            currentConfig.AUTH_TOKEN_CLEANUP_ENABLED = newConfig.AUTH_TOKEN_CLEANUP_ENABLED;
        }
        if (newConfig.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES !== undefined) {
            currentConfig.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES = newConfig.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES;
        }
        if (newConfig.PROVIDER_HEALTH_CHECK_ENABLED !== undefined) {
            currentConfig.PROVIDER_HEALTH_CHECK_ENABLED = newConfig.PROVIDER_HEALTH_CHECK_ENABLED;
        }
        if (newConfig.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES !== undefined) {
            currentConfig.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES = newConfig.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES;
        }
        if (newConfig.POTLUCK_HEALTH_SYNC_ENABLED !== undefined) {
            currentConfig.POTLUCK_HEALTH_SYNC_ENABLED = newConfig.POTLUCK_HEALTH_SYNC_ENABLED;
        }
        if (newConfig.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES !== undefined) {
            currentConfig.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES = newConfig.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES;
        }
        if (newConfig.USAGE_REFRESH_ENABLED !== undefined) {
            currentConfig.USAGE_REFRESH_ENABLED = newConfig.USAGE_REFRESH_ENABLED;
        }
        if (newConfig.USAGE_REFRESH_INTERVAL_MINUTES !== undefined) {
            currentConfig.USAGE_REFRESH_INTERVAL_MINUTES = newConfig.USAGE_REFRESH_INTERVAL_MINUTES;
        }
        if (newConfig.USAGE_AUTO_DISABLE !== undefined) currentConfig.USAGE_AUTO_DISABLE = newConfig.USAGE_AUTO_DISABLE;
        if (newConfig.USAGE_WARN_THRESHOLD !== undefined) currentConfig.USAGE_WARN_THRESHOLD = newConfig.USAGE_WARN_THRESHOLD;
        if (newConfig.USAGE_DISABLE_THRESHOLD !== undefined) currentConfig.USAGE_DISABLE_THRESHOLD = newConfig.USAGE_DISABLE_THRESHOLD;
        if (newConfig.providerFallbackChain !== undefined) currentConfig.providerFallbackChain = newConfig.providerFallbackChain;
        if (newConfig.modelFallbackMapping !== undefined) currentConfig.modelFallbackMapping = newConfig.modelFallbackMapping;
        
        // Proxy settings
        if (newConfig.PROXY_URL !== undefined) currentConfig.PROXY_URL = newConfig.PROXY_URL;
        if (newConfig.PROXY_ENABLED_PROVIDERS !== undefined) currentConfig.PROXY_ENABLED_PROVIDERS = newConfig.PROXY_ENABLED_PROVIDERS;
        if (newConfig.PROXY_POOL_ENABLED !== undefined) currentConfig.PROXY_POOL_ENABLED = Boolean(newConfig.PROXY_POOL_ENABLED);
        if (newConfig.OAUTH_CALLBACK_HOST !== undefined) currentConfig.OAUTH_CALLBACK_HOST = newConfig.OAUTH_CALLBACK_HOST;
        if (newConfig.OAUTH_CALLBACK_SCHEME !== undefined) currentConfig.OAUTH_CALLBACK_SCHEME = newConfig.OAUTH_CALLBACK_SCHEME;
        if (newConfig.OAUTH_CALLBACK_PORT !== undefined) currentConfig.OAUTH_CALLBACK_PORT = newConfig.OAUTH_CALLBACK_PORT;
        if (newConfig.CODEX_AUTO_REPLENISH_ENABLED !== undefined) currentConfig.CODEX_AUTO_REPLENISH_ENABLED = Boolean(newConfig.CODEX_AUTO_REPLENISH_ENABLED);
        if (newConfig.CODEX_AUTO_REPLENISH_MODE !== undefined) currentConfig.CODEX_AUTO_REPLENISH_MODE = newConfig.CODEX_AUTO_REPLENISH_MODE;
        if (newConfig.CODEX_AUTO_REPLENISH_SCRIPT_PATH !== undefined) currentConfig.CODEX_AUTO_REPLENISH_SCRIPT_PATH = newConfig.CODEX_AUTO_REPLENISH_SCRIPT_PATH;
        if (newConfig.CODEX_AUTO_REPLENISH_PYTHON_BIN !== undefined) currentConfig.CODEX_AUTO_REPLENISH_PYTHON_BIN = newConfig.CODEX_AUTO_REPLENISH_PYTHON_BIN;
        if (newConfig.CODEX_AUTO_REPLENISH_PROXY !== undefined) currentConfig.CODEX_AUTO_REPLENISH_PROXY = newConfig.CODEX_AUTO_REPLENISH_PROXY;
        if (newConfig.CODEX_AUTO_REPLENISH_POOL_ID !== undefined) currentConfig.CODEX_AUTO_REPLENISH_POOL_ID = newConfig.CODEX_AUTO_REPLENISH_POOL_ID;
        if (newConfig.CODEX_AUTO_REPLENISH_MIN_HEALTHY !== undefined) currentConfig.CODEX_AUTO_REPLENISH_MIN_HEALTHY = newConfig.CODEX_AUTO_REPLENISH_MIN_HEALTHY;
        if (newConfig.CODEX_AUTO_REPLENISH_BATCH_SIZE !== undefined) currentConfig.CODEX_AUTO_REPLENISH_BATCH_SIZE = newConfig.CODEX_AUTO_REPLENISH_BATCH_SIZE;
        if (newConfig.CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS !== undefined) currentConfig.CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS = newConfig.CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS;
        if (newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE !== undefined) currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE = newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE;
        if (newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY !== undefined) currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY = newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY;
        if (newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN !== undefined) currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN = newConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN;

        // Handle system prompt update
        if (newConfig.systemPrompt !== undefined) {
            try {
                await appMetaDao.setValue('system_prompt_content', newConfig.systemPrompt);
                currentConfig.SYSTEM_PROMPT_CONTENT = newConfig.systemPrompt;

                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: 'db://system_prompt',
                    type: 'system_prompt',
                    timestamp: new Date().toISOString()
                });
                
                console.log('[UI API] System prompt updated');
            } catch (e) {
                console.warn('[UI API] Failed to update system prompt:', e.message);
            }
        }

        // Update config stored in database
        try {
            await saveConfigKeysToMeta(currentConfig);

            // Create a clean config object for saving (exclude runtime-only properties)
            const configToSave = {
                REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY,
                SERVER_PORT: currentConfig.SERVER_PORT,
                HOST: currentConfig.HOST,
                PUBLIC_API_BASE_URL: currentConfig.PUBLIC_API_BASE_URL,
                MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
                SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
                PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
                PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
                REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
                REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
                CREDENTIAL_SWITCH_MAX_RETRIES: currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES,
                CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
                CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
                MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
                AUTH_TOKEN_CLEANUP_ENABLED: currentConfig.AUTH_TOKEN_CLEANUP_ENABLED,
                AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES: currentConfig.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES,
                PROVIDER_HEALTH_CHECK_ENABLED: currentConfig.PROVIDER_HEALTH_CHECK_ENABLED,
                PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES: currentConfig.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES,
                POTLUCK_HEALTH_SYNC_ENABLED: currentConfig.POTLUCK_HEALTH_SYNC_ENABLED,
                POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES: currentConfig.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES,
                USAGE_REFRESH_ENABLED: currentConfig.USAGE_REFRESH_ENABLED,
                USAGE_REFRESH_INTERVAL_MINUTES: currentConfig.USAGE_REFRESH_INTERVAL_MINUTES,
                USAGE_AUTO_DISABLE: currentConfig.USAGE_AUTO_DISABLE,
                USAGE_WARN_THRESHOLD: currentConfig.USAGE_WARN_THRESHOLD,
                USAGE_DISABLE_THRESHOLD: currentConfig.USAGE_DISABLE_THRESHOLD,
                CODEX_AUTO_REPLENISH_ENABLED: currentConfig.CODEX_AUTO_REPLENISH_ENABLED,
                CODEX_AUTO_REPLENISH_MODE: currentConfig.CODEX_AUTO_REPLENISH_MODE,
                CODEX_AUTO_REPLENISH_SCRIPT_PATH: currentConfig.CODEX_AUTO_REPLENISH_SCRIPT_PATH,
                CODEX_AUTO_REPLENISH_PYTHON_BIN: currentConfig.CODEX_AUTO_REPLENISH_PYTHON_BIN,
                CODEX_AUTO_REPLENISH_PROXY: currentConfig.CODEX_AUTO_REPLENISH_PROXY,
                CODEX_AUTO_REPLENISH_POOL_ID: currentConfig.CODEX_AUTO_REPLENISH_POOL_ID,
                CODEX_AUTO_REPLENISH_MIN_HEALTHY: currentConfig.CODEX_AUTO_REPLENISH_MIN_HEALTHY,
                CODEX_AUTO_REPLENISH_BATCH_SIZE: currentConfig.CODEX_AUTO_REPLENISH_BATCH_SIZE,
                CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS: currentConfig.CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS,
                CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE: currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE,
                CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY: currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY,
                CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN: currentConfig.CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN,
                providerFallbackChain: currentConfig.providerFallbackChain,
                modelFallbackMapping: currentConfig.modelFallbackMapping,
                PROXY_URL: currentConfig.PROXY_URL,
                PROXY_ENABLED_PROVIDERS: currentConfig.PROXY_ENABLED_PROVIDERS,
                PROXY_POOL_ENABLED: currentConfig.PROXY_POOL_ENABLED,
                OAUTH_CALLBACK_HOST: currentConfig.OAUTH_CALLBACK_HOST,
                OAUTH_CALLBACK_SCHEME: currentConfig.OAUTH_CALLBACK_SCHEME,
                OAUTH_CALLBACK_PORT: currentConfig.OAUTH_CALLBACK_PORT
            };

            await appMetaDao.setValue('app_config', JSON.stringify(configToSave));
            console.log('[UI API] Configuration saved to database');
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'update',
                filePath: 'db://app_config',
                type: 'main_config',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('[UI API] Failed to save configuration to database:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to save configuration to database: ' + error.message,
                    partial: true  // Indicate that memory config was updated but not saved
                }
            }));
            return true;
        }

        // Update the global CONFIG object to reflect changes immediately
        Object.assign(CONFIG, currentConfig);

        // 重新配置监控定时器（用量刷新、健康检查等），保存后立即生效
        try {
            configureMonitoring({ config: CONFIG, providerPoolManager });
            console.log('[UI API] Monitoring reconfigured after config save');
        } catch (monErr) {
            console.warn('[UI API] Failed to reconfigure monitoring:', monErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration updated successfully',
            details: 'Configuration has been updated in both memory and database'
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重载配置文件
 */
export async function handleReloadConfig(req, res, providerPoolManager) {
    try {
        // 调用重载配置函数
        const newConfig = await reloadConfig(providerPoolManager);

        requestConfigReloadBroadcast('reload');

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reload',
            filePath: 'db://app_config',
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration files reloaded successfully',
            details: {
                configReloaded: true,
                configPath: 'db://app_config'
            }
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to reload config files:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to reload configuration files: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 更新管理员密码
 */
export async function handleUpdateAdminPassword(req, res) {
    try {
        const body = await getRequestBody(req);
        const { password } = body;

        if (!password || password.trim() === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Password cannot be empty'
                }
            }));
            return true;
        }

        await appMetaDao.setValue('admin_password', password.trim());
        
        console.log('[UI API] Admin password updated successfully');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Admin password updated successfully'
        }));
        return true;
    } catch (error) {
        console.error('[UI API] Failed to update admin password:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to update password: ' + error.message
            }
        }));
        return true;
    }
}
