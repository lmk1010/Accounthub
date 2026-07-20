/**
 * 迁移脚本：将 app_config JSON 拆分为独立的键值对
 *
 * 使用方法：
 * node src/scripts/migrate-app-config-to-keys.js
 */

import * as appMetaDao from '../dao/app-meta-dao.js';

const CONFIG_KEYS = [
    'REQUIRED_API_KEY',
    'SERVER_PORT',
    'HOST',
    'MODEL_PROVIDER',
    'SYSTEM_PROMPT_MODE',
    'PROXY_URL',
    'PROXY_ENABLED_PROVIDERS',
    'OAUTH_CALLBACK_HOST',
    'OAUTH_CALLBACK_SCHEME',
    'OAUTH_CALLBACK_PORT',
    'PROMPT_LOG_BASE_NAME',
    'PROMPT_LOG_MODE',
    'REQUEST_MAX_RETRIES',
    'REQUEST_BASE_DELAY',
    'CREDENTIAL_SWITCH_MAX_RETRIES',
    'CRON_NEAR_MINUTES',
    'CRON_REFRESH_TOKEN',
    'MAX_ERROR_COUNT',
    'providerFallbackChain',
    'modelFallbackMapping'
];

async function migrate() {
    try {
        console.log('[Migration] Starting app_config to individual keys migration...');

        // 1. 读取现有的 app_config
        const appConfigJson = await appMetaDao.getValue('app_config');

        if (!appConfigJson) {
            console.log('[Migration] No app_config found. Nothing to migrate.');
            return;
        }

        console.log('[Migration] Found app_config, parsing...');
        const appConfig = JSON.parse(appConfigJson);

        // 2. 检查是否已经有独立键存在
        const existingKeys = await checkExistingKeys();

        if (existingKeys.length > 0) {
            console.log(`[Migration] Warning: Found ${existingKeys.length} existing individual keys:`);
            console.log(existingKeys.join(', '));
            console.log('[Migration] These keys will be SKIPPED to avoid overwriting existing data.');
        }

        // 3. 将每个配置项写入独立的键
        let migratedCount = 0;
        let skippedCount = 0;

        for (const key of CONFIG_KEYS) {
            if (appConfig[key] !== undefined) {
                // 检查是否已存在
                const existingValue = await appMetaDao.getValue(key);

                if (existingValue !== null) {
                    console.log(`[Migration] Skip ${key} (already exists)`);
                    skippedCount++;
                    continue;
                }

                // 转换值为合适的格式
                let value = appConfig[key];

                // 对于数组和对象，转换为 JSON 字符串
                if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                    value = JSON.stringify(value);
                } else {
                    // 对于基本类型，转换为字符串
                    value = String(value);
                }

                await appMetaDao.setValue(key, value);
                console.log(`[Migration] Migrated ${key}: ${value.length > 50 ? value.substring(0, 50) + '...' : value}`);
                migratedCount++;
            }
        }

        console.log('\n[Migration] ========================================');
        console.log(`[Migration] Migration completed!`);
        console.log(`[Migration] Total keys migrated: ${migratedCount}`);
        console.log(`[Migration] Keys skipped: ${skippedCount}`);
        console.log('[Migration] ========================================');
        console.log('\n[Migration] Notes:');
        console.log('- The original app_config JSON is preserved');
        console.log('- New code will read from individual keys');
        console.log('- You can safely remove app_config later if needed');

        process.exit(0);

    } catch (error) {
        console.error('[Migration] Error:', error);
        process.exit(1);
    }
}

async function checkExistingKeys() {
    const existing = [];

    for (const key of CONFIG_KEYS) {
        const value = await appMetaDao.getValue(key);
        if (value !== null) {
            existing.push(key);
        }
    }

    return existing;
}

// 运行迁移
migrate();
