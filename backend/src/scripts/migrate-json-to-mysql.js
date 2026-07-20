import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { initializeDatabase } from '../config/database.js';
import * as appMetaDao from '../dao/app-meta-dao.js';
import * as authTokensDao from '../dao/auth-tokens-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as apiPotluckDao from '../dao/api-potluck-dao.js';
import { getPool } from '../config/database.js';

const env = process.env.NODE_ENV || 'development';
if (env === 'production') {
    dotenv.config({ path: '.env.production' });
} else if (env === 'development') {
    dotenv.config({ path: '.env.development' });
} else {
    dotenv.config();
}

const DEFAULT_CONFIG_PATH = path.join('configs', 'config.json');
const DEFAULT_PWD_PATH = path.join('configs', 'pwd');
const DEFAULT_TOKEN_STORE_PATH = path.join('configs', 'token-store.json');
const DEFAULT_SCAN_DIR = 'configs';
const DEFAULT_POTLUCK_KEYS_PATH = path.join('configs', 'api-potluck-keys.json');
const DEFAULT_POTLUCK_DATA_PATH = path.join('configs', 'api-potluck-data.json');

function parseArgs(argv) {
    const options = {
        configPath: DEFAULT_CONFIG_PATH,
        pwdPath: DEFAULT_PWD_PATH,
        tokenStorePath: DEFAULT_TOKEN_STORE_PATH,
        scanDir: DEFAULT_SCAN_DIR,
        scanOauth: true,
        dryRun: false,
        defaultProvider: null,
        potluckKeysPath: DEFAULT_POTLUCK_KEYS_PATH,
        potluckDataPath: DEFAULT_POTLUCK_DATA_PATH
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--config' && argv[i + 1]) {
            options.configPath = argv[++i];
        } else if (arg === '--pwd' && argv[i + 1]) {
            options.pwdPath = argv[++i];
        } else if (arg === '--token-store' && argv[i + 1]) {
            options.tokenStorePath = argv[++i];
        } else if (arg === '--scan-dir' && argv[i + 1]) {
            options.scanDir = argv[++i];
        } else if (arg === '--no-scan-oauth') {
            options.scanOauth = false;
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--default-provider' && argv[i + 1]) {
            options.defaultProvider = argv[++i];
        } else if (arg === '--potluck-keys' && argv[i + 1]) {
            options.potluckKeysPath = argv[++i];
        } else if (arg === '--potluck-data' && argv[i + 1]) {
            options.potluckDataPath = argv[++i];
        }
    }

    return options;
}

async function readJsonFile(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

async function loadConfigFile(filePath) {
    if (!existsSync(filePath)) return null;
    return readJsonFile(filePath);
}

async function migrateConfig(configData, options) {
    if (!configData) {
        console.log('[Migrate] No config.json found, skipping app_config migration');
        return false;
    }
    if (options.dryRun) {
        console.log('[Migrate] Dry run: would write app_config to MySQL');
        return true;
    }
    await appMetaDao.setValue('app_config', JSON.stringify(configData));
    console.log('[Migrate] app_config stored in MySQL');
    return true;
}

async function migratePassword(filePath, options) {
    if (!existsSync(filePath)) {
        console.log('[Migrate] No pwd file found, skipping admin_password migration');
        return false;
    }
    const content = await fs.readFile(filePath, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
        console.log('[Migrate] pwd file is empty, skipping admin_password migration');
        return false;
    }
    if (options.dryRun) {
        console.log('[Migrate] Dry run: would write admin_password to MySQL');
        return true;
    }
    await appMetaDao.setValue('admin_password', trimmed);
    console.log('[Migrate] admin_password stored in MySQL');
    return true;
}

async function migrateTokenStore(filePath, options) {
    if (!existsSync(filePath)) {
        console.log('[Migrate] No token-store.json found, skipping auth_tokens migration');
        return false;
    }
    let tokenStore;
    try {
        tokenStore = await readJsonFile(filePath);
    } catch (error) {
        console.warn('[Migrate] Failed to parse token-store.json:', error.message);
        return false;
    }

    const tokens = tokenStore.tokens && typeof tokenStore.tokens === 'object' ? tokenStore.tokens : {};
    const entries = Object.entries(tokens);
    if (!entries.length) {
        console.log('[Migrate] token-store.json has no tokens, skipping');
        return false;
    }

    let migrated = 0;
    for (const [token, info] of entries) {
        if (!token || !info) continue;
        const loginTime = Number(info.loginTime || info.login_time || Date.now());
        const expiryTime = Number(info.expiryTime || info.expiry_time || 0);
        if (!expiryTime) {
            console.warn(`[Migrate] Skipping token without expiryTime: ${token}`);
            continue;
        }
        const username = info.username || 'admin';
        if (!options.dryRun) {
            await authTokensDao.saveToken(token, { username, loginTime, expiryTime });
        }
        migrated++;
    }

    if (options.dryRun) {
        console.log(`[Migrate] Dry run: would migrate ${migrated} token(s)`);
    } else {
        console.log(`[Migrate] Migrated ${migrated} token(s) to MySQL`);
    }
    return migrated > 0;
}

function isOAuthCredentialPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const directKeys = [
        'refresh_token',
        'access_token',
        'client_id',
        'client_secret',
        'device_code',
        'id_token',
        'refreshToken',
        'accessToken',
        'clientId',
        'clientSecret'
    ];
    if (directKeys.some((key) => key in payload)) {
        return true;
    }
    if (payload.installed || payload.web) {
        return true;
    }
    if (payload.credentials && typeof payload.credentials === 'object') {
        return true;
    }
    return false;
}

function detectProviderType(filePath, defaultProvider) {
    const lower = filePath.toLowerCase();
    if (lower.includes('antigravity')) return 'gemini-antigravity';
    if (lower.includes('gemini')) return 'gemini-cli-oauth';
    if (lower.includes('orchids')) return 'claude-orchids-oauth';
    if (lower.includes('kiro') || lower.includes('aws')) return 'claude-kiro-oauth';
    if (lower.includes('qwen')) return 'openai-qwen-oauth';
    if (lower.includes('iflow')) return 'openai-iflow';
    return defaultProvider;
}

async function listJsonFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await listJsonFiles(fullPath);
            results.push(...nested);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
            results.push(fullPath);
        }
    }
    return results;
}

function shouldSkipFile(filePath, options) {
    const filename = path.basename(filePath);
    const lower = filename.toLowerCase();
    const skipNames = new Set([
        path.basename(options.configPath).toLowerCase(),
        path.basename(options.tokenStorePath).toLowerCase(),
        'plugins.json',
        'provider_pools.json',
        'api-potluck-keys.json',
        'api-potluck-data.json'
    ]);
    if (skipNames.has(lower)) return true;
    if (lower.endsWith('.example') || lower.includes('.example.')) return true;
    return false;
}

async function migrateOAuthCredentials(options) {
    if (!options.scanOauth) {
        console.log('[Migrate] OAuth credential scan disabled');
        return 0;
    }

    const files = await listJsonFiles(options.scanDir);
    if (!files.length) {
        console.log('[Migrate] No JSON files found for OAuth scan');
        return 0;
    }

    let imported = 0;
    let skippedUnknown = 0;
    let skippedNonOauth = 0;

    for (const filePath of files) {
        if (shouldSkipFile(filePath, options)) continue;
        let payload;
        try {
            payload = await readJsonFile(filePath);
        } catch (_error) {
            continue;
        }
        if (!isOAuthCredentialPayload(payload)) {
            skippedNonOauth++;
            continue;
        }

        const providerType = detectProviderType(filePath, options.defaultProvider);
        if (!providerType) {
            skippedUnknown++;
            continue;
        }

        const refreshToken = payload.refresh_token || payload.refreshToken;
        if (!options.dryRun && refreshToken) {
            const existing = await oauthCredentialsDao.findByRefreshToken(providerType, refreshToken);
            if (existing) {
                continue;
            }
        }

        const displayName = path.basename(filePath);
        const sourcePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
        if (!options.dryRun) {
            await oauthCredentialsDao.create({
                provider_type: providerType,
                credential_type: 'oauth',
                credentials: payload,
                display_name: displayName,
                source: 'json_migration',
                metadata: { sourcePath }
            });
        }
        imported++;
    }

    if (options.dryRun) {
        console.log(`[Migrate] Dry run: would import ${imported} OAuth credential file(s)`);
    } else {
        console.log(`[Migrate] Imported ${imported} OAuth credential file(s)`);
    }
    if (skippedUnknown > 0) {
        console.log(`[Migrate] Skipped ${skippedUnknown} OAuth file(s) due to unknown provider type`);
    }
    if (skippedNonOauth > 0) {
        console.log(`[Migrate] Skipped ${skippedNonOauth} non-OAuth JSON file(s)`);
    }
    return imported;
}

async function migratePotluckKeys(filePath, options) {
    if (!existsSync(filePath)) {
        console.log('[Migrate] No api-potluck-keys.json found, skipping');
        return false;
    }

    let payload;
    try {
        payload = await readJsonFile(filePath);
    } catch (error) {
        console.warn('[Migrate] Failed to parse api-potluck-keys.json:', error.message);
        return false;
    }

    const keys = payload.keys && typeof payload.keys === 'object' ? payload.keys : {};
    const entries = Object.entries(keys);
    if (!entries.length) {
        console.log('[Migrate] api-potluck-keys.json has no keys, skipping');
        return false;
    }

    const pool = getPool();
    let migrated = 0;

    for (const [apiKey, keyData] of entries) {
        if (!apiKey || !keyData) continue;

        const createdAt = keyData.createdAt || new Date().toISOString();
        const lastResetDate = keyData.lastResetDate || null;
        const lastUsedAt = keyData.lastUsedAt || null;
        const name = keyData.name || null;
        const dailyLimit = Number.isFinite(keyData.dailyLimit) ? keyData.dailyLimit : 500;
        const todayUsage = Number.isFinite(keyData.todayUsage) ? keyData.todayUsage : 0;
        const totalUsage = Number.isFinite(keyData.totalUsage) ? keyData.totalUsage : 0;
        const enabled = keyData.enabled !== false;
        const bonusRemaining = Number.isFinite(keyData.bonusRemaining) ? keyData.bonusRemaining : 0;
        const regeneratedFrom = keyData.regeneratedFrom || null;
        const regeneratedAt = keyData.regeneratedAt || null;

        if (!options.dryRun) {
            await pool.query(
                `INSERT INTO api_potluck_users
                (api_key, name, created_at, daily_limit, today_usage, total_usage,
                 last_reset_date, last_used_at, enabled, bonus_remaining, regenerated_from, regenerated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    created_at = VALUES(created_at),
                    daily_limit = VALUES(daily_limit),
                    today_usage = VALUES(today_usage),
                    total_usage = VALUES(total_usage),
                    last_reset_date = VALUES(last_reset_date),
                    last_used_at = VALUES(last_used_at),
                    enabled = VALUES(enabled),
                    bonus_remaining = VALUES(bonus_remaining),
                    regenerated_from = VALUES(regenerated_from),
                    regenerated_at = VALUES(regenerated_at)`,
                [
                    apiKey,
                    name,
                    createdAt,
                    dailyLimit,
                    todayUsage,
                    totalUsage,
                    lastResetDate,
                    lastUsedAt,
                    enabled,
                    bonusRemaining,
                    regeneratedFrom,
                    regeneratedAt
                ]
            );
        }

        migrated++;
    }

    if (options.dryRun) {
        console.log(`[Migrate] Dry run: would migrate ${migrated} potluck key(s)`);
    } else {
        console.log(`[Migrate] Migrated ${migrated} potluck key(s) to MySQL`);
    }

    return migrated > 0;
}

async function migratePotluckData(filePath, options) {
    if (!existsSync(filePath)) {
        console.log('[Migrate] No api-potluck-data.json found, skipping');
        return false;
    }

    let payload;
    try {
        payload = await readJsonFile(filePath);
    } catch (error) {
        console.warn('[Migrate] Failed to parse api-potluck-data.json:', error.message);
        return false;
    }

    const config = payload.config || {};
    if (Object.keys(config).length > 0) {
        if (options.dryRun) {
            console.log('[Migrate] Dry run: would migrate api-potluck config');
        } else {
            await apiPotluckDao.updateConfig({
                defaultDailyLimit: config.defaultDailyLimit,
                bonusPerCredential: config.bonusPerCredential,
                bonusValidityDays: config.bonusValidityDays,
                persistInterval: config.persistInterval
            });
            console.log('[Migrate] Migrated api-potluck config');
        }
    }

    const users = payload.users && typeof payload.users === 'object' ? payload.users : {};
    const entries = Object.entries(users);
    if (!entries.length) {
        console.log('[Migrate] api-potluck-data.json has no users, skipping');
        return false;
    }

    const pool = getPool();
    let migratedUsers = 0;
    let migratedCredentials = 0;
    let migratedBonuses = 0;

    for (const [apiKey, userData] of entries) {
        if (!apiKey || !userData) continue;

        if (!options.dryRun) {
            await apiPotluckDao.ensureUser(apiKey);

            if (userData.createdAt) {
                await pool.query(
                    'UPDATE api_potluck_users SET created_at = ? WHERE api_key = ?',
                    [userData.createdAt, apiKey]
                );
            }

            const credentials = Array.isArray(userData.credentials) ? userData.credentials : [];
            for (const cred of credentials) {
                await apiPotluckDao.addUserCredential(apiKey, {
                    id: cred.id,
                    path: cred.path,
                    provider: cred.provider,
                    authMethod: cred.authMethod || cred.auth_method,
                    addedAt: cred.addedAt || cred.added_at
                });
                migratedCredentials++;
            }

            const bonuses = Array.isArray(userData.credentialBonuses) ? userData.credentialBonuses : [];
            for (const bonus of bonuses) {
                await pool.query(
                    `INSERT INTO api_potluck_credential_bonuses
                    (api_key, credential_id, granted_at, used_count)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        granted_at = VALUES(granted_at),
                        used_count = VALUES(used_count)`,
                    [
                        apiKey,
                        bonus.credentialId,
                        bonus.grantedAt,
                        Number.isFinite(bonus.usedCount) ? bonus.usedCount : 0
                    ]
                );
                migratedBonuses++;
            }
        } else {
            const credentials = Array.isArray(userData.credentials) ? userData.credentials : [];
            const bonuses = Array.isArray(userData.credentialBonuses) ? userData.credentialBonuses : [];
            migratedCredentials += credentials.length;
            migratedBonuses += bonuses.length;
        }

        migratedUsers++;
    }

    if (options.dryRun) {
        console.log(`[Migrate] Dry run: would migrate ${migratedUsers} potluck user(s)`);
    } else {
        console.log(`[Migrate] Migrated ${migratedUsers} potluck user(s) to MySQL`);
    }
    console.log(`[Migrate] Potluck credentials: ${migratedCredentials}, bonuses: ${migratedBonuses}`);

    return migratedUsers > 0;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    const configData = await loadConfigFile(options.configPath);
    await initializeDatabase(configData || {});

    await migrateConfig(configData, options);
    await migratePassword(options.pwdPath, options);
    await migrateTokenStore(options.tokenStorePath, options);
    await migrateOAuthCredentials(options);
    await migratePotluckKeys(options.potluckKeysPath, options);
    await migratePotluckData(options.potluckDataPath, options);

    console.log('[Migrate] Migration completed');
}

main().catch((error) => {
    const details = [error.code, error.errno, error.sqlMessage, error.message]
        .filter(Boolean)
        .join(' | ');
    console.error('[Migrate] Migration failed:', details || 'Unknown error');
    process.exit(1);
});
