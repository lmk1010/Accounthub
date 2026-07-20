import { MODEL_PROVIDER } from '../utils/common.js';
import * as appMetaDao from '../dao/app-meta-dao.js';

export let CONFIG = {}; // Make CONFIG exportable
export let PROMPT_LOG_FILENAME = ''; // Make PROMPT_LOG_FILENAME exportable

const ALL_MODEL_PROVIDERS = Object.values(MODEL_PROVIDER);

function parseBooleanConfigValue(rawValue, defaultValue = false) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return defaultValue;
    }
    if (typeof rawValue === 'boolean') {
        return rawValue;
    }
    if (typeof rawValue === 'number') {
        return rawValue !== 0;
    }
    if (typeof rawValue === 'string') {
        const normalized = rawValue.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }

    try {
        const parsed = JSON.parse(String(rawValue));
        if (typeof parsed === 'boolean') return parsed;
        if (typeof parsed === 'number') return parsed !== 0;
        if (typeof parsed === 'string') {
            const normalized = parsed.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        }
    } catch {
        // ignore
    }

    return defaultValue;
}

function normalizeConfiguredProviders(config) {
    const fallbackProvider = MODEL_PROVIDER.GEMINI_CLI;
    const dedupedProviders = [];

    const addProvider = (value) => {
        if (typeof value !== 'string') {
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return;
        }
        const matched = ALL_MODEL_PROVIDERS.find((provider) => provider.toLowerCase() === trimmed.toLowerCase());
        if (!matched) {
            console.warn(`[Config Warning] Unknown model provider '${trimmed}'. This entry will be ignored.`);
            return;
        }
        if (!dedupedProviders.includes(matched)) {
            dedupedProviders.push(matched);
        }
    };

    const rawValue = config.MODEL_PROVIDER;
    if (Array.isArray(rawValue)) {
        rawValue.forEach((entry) => addProvider(typeof entry === 'string' ? entry : String(entry)));
    } else if (typeof rawValue === 'string') {
        rawValue.split(',').forEach(addProvider);
    } else if (rawValue != null) {
        addProvider(String(rawValue));
    }

    if (dedupedProviders.length === 0) {
        dedupedProviders.push(fallbackProvider);
    }

    config.DEFAULT_MODEL_PROVIDERS = dedupedProviders;
    config.MODEL_PROVIDER = dedupedProviders[0];
}

/**
 * Initializes the server configuration from MySQL database and command-line arguments.
 * @param {string[]} args - Command-line arguments.
 * @returns {Object} The initialized configuration object.
 */
export async function initializeConfig(args = process.argv.slice(2)) {
    let currentConfig = {};

    const buildDefaultConfig = () => ({
        REQUIRED_API_KEY: "",
        SERVER_PORT: 3000,
        HOST: '0.0.0.0',
        PUBLIC_API_BASE_URL: '',
        MODEL_PROVIDER: MODEL_PROVIDER.GEMINI_CLI,
        SYSTEM_PROMPT_MODE: 'append',
        PROXY_URL: null, // HTTP/HTTPS/SOCKS5 代理地址，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
        PROXY_ENABLED_PROVIDERS: [], // 启用代理的提供商列表，如 ['gemini-cli-oauth', 'claude-kiro-oauth']
        PROXY_POOL_ENABLED: false, // 代理池全局开关
        OAUTH_CALLBACK_HOST: 'localhost', // OAuth 回调地址的主机名，生产环境应设置为服务器的公网 IP 或域名
        OAUTH_CALLBACK_SCHEME: 'http', // OAuth 回调地址协议 (http/https)
        OAUTH_CALLBACK_PORT: null, // OAuth 回调地址端口 (可留空表示使用回调服务端口)
        PROMPT_LOG_BASE_NAME: "prompt_log",
        PROMPT_LOG_MODE: "none",
        REQUEST_MAX_RETRIES: 3,
        REQUEST_BASE_DELAY: 1000,
        CREDENTIAL_SWITCH_MAX_RETRIES: 5, // 坏凭证切换最大重试次数（用于认证错误后切换凭证）
        CRON_NEAR_MINUTES: 15,
        CRON_REFRESH_TOKEN: false,
        MAX_ERROR_COUNT: 3, // 提供商最大错误次数
        AUTH_TOKEN_CLEANUP_ENABLED: true, // 登录 token 清理定时任务开关
        AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES: 5, // 登录 token 清理间隔(分钟)
        PROVIDER_HEALTH_CHECK_ENABLED: true, // 号池健康检查定时任务开关
        PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES: 5, // 号池健康检查定时任务间隔(分钟)
        POTLUCK_HEALTH_SYNC_ENABLED: true, // Potluck 健康同步定时任务开关
        POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES: 5, // Potluck 健康同步间隔(分钟)
        USAGE_REFRESH_ENABLED: false, // 用量定时刷新开关
        USAGE_REFRESH_INTERVAL_MINUTES: 10, // 用量定时刷新间隔(分钟)
        USAGE_AUTO_DISABLE: false,
        USAGE_WARN_THRESHOLD: 80,
        USAGE_DISABLE_THRESHOLD: 95,
        CODEX_AUTO_REPLENISH_ENABLED: false,
        CODEX_AUTO_REPLENISH_MODE: 'native',
        CODEX_AUTO_REPLENISH_SCRIPT_PATH: '',
        CODEX_AUTO_REPLENISH_PYTHON_BIN: 'python3',
        CODEX_AUTO_REPLENISH_PROXY: '',
        CODEX_AUTO_REPLENISH_POOL_ID: null,
        CODEX_AUTO_REPLENISH_MIN_HEALTHY: 50,
        CODEX_AUTO_REPLENISH_BATCH_SIZE: 10,
        CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS: 180,
        CODEX_AUTO_REPLENISH_DUCKMAIL_API_BASE: 'https://api.duckmail.sbs',
        CODEX_AUTO_REPLENISH_DUCKMAIL_API_KEY: '',
        CODEX_AUTO_REPLENISH_DUCKMAIL_DOMAIN: '',
        CODEX_STRICT_REQUEST_ALIGNMENT: false,
        providerFallbackChain: {}, // 跨类型 Fallback 链配置
        USE_DATABASE: true, // 数据库模式开关
        DATABASE: {} // 数据库配置
    });

    try {
        // 从数据库加载配置，使用独立的键值对而不是 app_config JSON
        const configKeys = [
            'REQUIRED_API_KEY',
            'SERVER_PORT',
            'HOST',
            'PUBLIC_API_BASE_URL',
            'MODEL_PROVIDER',
            'SYSTEM_PROMPT_MODE',
            'PROXY_URL',
            'PROXY_ENABLED_PROVIDERS',
            'PROXY_POOL_ENABLED',
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
            'CODEX_STRICT_REQUEST_ALIGNMENT',
            'providerFallbackChain'
        ];

        currentConfig = buildDefaultConfig();
        let loadedCount = 0;

        for (const key of configKeys) {
            try {
                const value = await appMetaDao.getValue(key);
                if (value !== null && value !== undefined) {
                    // 处理不同类型的值
                    if (key === 'SERVER_PORT' || key === 'REQUEST_MAX_RETRIES' ||
                        key === 'REQUEST_BASE_DELAY' || key === 'CREDENTIAL_SWITCH_MAX_RETRIES' ||
                        key === 'CRON_NEAR_MINUTES' || key === 'MAX_ERROR_COUNT' ||
                        key === 'AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES' ||
                        key === 'PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES' ||
                        key === 'POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES' ||
                        key === 'USAGE_REFRESH_INTERVAL_MINUTES' ||
                        key === 'USAGE_WARN_THRESHOLD' || key === 'USAGE_DISABLE_THRESHOLD' ||
                        key === 'CODEX_AUTO_REPLENISH_POOL_ID' || key === 'CODEX_AUTO_REPLENISH_MIN_HEALTHY' ||
                        key === 'CODEX_AUTO_REPLENISH_BATCH_SIZE' || key === 'CODEX_AUTO_REPLENISH_TIMEOUT_SECONDS') {
                        if (key === 'CODEX_AUTO_REPLENISH_POOL_ID' && (value === 'null' || value === '' || value === null)) {
                            currentConfig[key] = null;
                            loadedCount++;
                            continue;
                        }
                        // 数字类型：先尝试JSON解析（处理旧数据），失败则直接parseInt
                        try {
                            const parsed = JSON.parse(value);
                            currentConfig[key] = parseInt(parsed, 10);
                        } catch {
                            currentConfig[key] = parseInt(value, 10);
                        }
                    } else if (key === 'CRON_REFRESH_TOKEN' || key === 'USAGE_AUTO_DISABLE' ||
                        key === 'AUTH_TOKEN_CLEANUP_ENABLED' || key === 'PROVIDER_HEALTH_CHECK_ENABLED' ||
                        key === 'POTLUCK_HEALTH_SYNC_ENABLED' || key === 'USAGE_REFRESH_ENABLED' ||
                        key === 'PROXY_POOL_ENABLED' || key === 'CODEX_AUTO_REPLENISH_ENABLED' ||
                        key === 'CODEX_STRICT_REQUEST_ALIGNMENT') {
                        // 布尔类型（兼容 true/false, 1/0, "1"/"0"）
                        currentConfig[key] = parseBooleanConfigValue(value, false);
                    } else if (key === 'PROXY_ENABLED_PROVIDERS' || key === 'providerFallbackChain') {
                        // 数组或对象类型
                        try {
                            currentConfig[key] = JSON.parse(value);
                        } catch (e) {
                            console.warn(`[Config Warning] Failed to parse ${key} as JSON, using default`);
                        }
                    } else if (key === 'REQUIRED_API_KEY') {
                        // API Key 必须是字符串类型
                        currentConfig[key] = String(value);
                    } else {
                        // 字符串类型：尝试JSON解析（处理旧的带引号数据），失败则直接使用
                        try {
                            currentConfig[key] = JSON.parse(value);
                        } catch {
                            currentConfig[key] = value;
                        }
                    }
                    loadedCount++;
                }
            } catch (error) {
                console.warn(`[Config Warning] Failed to load ${key} from MySQL:`, error.message);
            }
        }

        if (loadedCount > 0) {
            console.log(`[Config] Loaded ${loadedCount} configuration items from MySQL (individual keys)`);
        } else {
            console.warn('[Config] No configuration found in MySQL, using default configuration');
        }
    } catch (error) {
        console.error('[Config Error] Failed to load config from MySQL:', error.message);
        currentConfig = buildDefaultConfig();
        console.log('[Config] Using default configuration.');
    }

    // Parse command-line arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--api-key') {
            if (i + 1 < args.length) {
                currentConfig.REQUIRED_API_KEY = args[i + 1];
                i++;
            } else {
                console.warn(`[Config Warning] --api-key flag requires a value.`);
            }
        } else if (args[i] === '--log-prompts') {
            if (i + 1 < args.length) {
                const mode = args[i + 1];
                if (mode === 'console' || mode === 'file') {
                    currentConfig.PROMPT_LOG_MODE = mode;
                } else {
                    console.warn(`[Config Warning] Invalid mode for --log-prompts. Expected 'console' or 'file'. Prompt logging is disabled.`);
                }
                i++;
            } else {
                console.warn(`[Config Warning] --log-prompts flag requires a value.`);
            }
        } else if (args[i] === '--port') {
            if (i + 1 < args.length) {
                currentConfig.SERVER_PORT = parseInt(args[i + 1], 10);
                i++;
            } else {
                console.warn(`[Config Warning] --port flag requires a value.`);
            }
        } else if (args[i] === '--model-provider') {
            if (i + 1 < args.length) {
                currentConfig.MODEL_PROVIDER = args[i + 1];
                i++;
            } else {
                console.warn(`[Config Warning] --model-provider flag requires a value.`);
            }
        } else if (args[i] === '--system-prompt-mode') {
            if (i + 1 < args.length) {
                const mode = args[i + 1];
                if (mode === 'overwrite' || mode === 'append') {
                    currentConfig.SYSTEM_PROMPT_MODE = mode;
                } else {
                    console.warn(`[Config Warning] Invalid mode for --system-prompt-mode. Expected 'overwrite' or 'append'. Using default 'overwrite'.`);
                }
                i++;
            } else {
                console.warn(`[Config Warning] --system-prompt-mode flag requires a value.`);
            }
        } else if (args[i] === '--host') {
            if (i + 1 < args.length) {
                currentConfig.HOST = args[i + 1];
                i++;
            } else {
                console.warn(`[Config Warning] --host flag requires a value.`);
            }
        } else if (args[i] === '--prompt-log-base-name') {
            if (i + 1 < args.length) {
                currentConfig.PROMPT_LOG_BASE_NAME = args[i + 1];
                i++;
            } else {
                console.warn(`[Config Warning] --prompt-log-base-name flag requires a value.`);
            }
        } else if (args[i] === '--cron-near-minutes') {
            if (i + 1 < args.length) {
                currentConfig.CRON_NEAR_MINUTES = parseInt(args[i + 1], 10);
                i++;
            } else {
                console.warn(`[Config Warning] --cron-near-minutes flag requires a value.`);
            }
        } else if (args[i] === '--cron-refresh-token') {
            if (i + 1 < args.length) {
                currentConfig.CRON_REFRESH_TOKEN = args[i + 1].toLowerCase() === 'true';
                i++;
            } else {
                console.warn(`[Config Warning] --cron-refresh-token flag requires a value.`);
            }
        } else if (args[i] === '--max-error-count') {
            if (i + 1 < args.length) {
                currentConfig.MAX_ERROR_COUNT = parseInt(args[i + 1], 10);
                i++;
            } else {
                console.warn(`[Config Warning] --max-error-count flag requires a value.`);
            }
        }
    }

    normalizeConfiguredProviders(currentConfig);

    // 强制启用数据库模式
    currentConfig.USE_DATABASE = true;
    console.log('[Config] Database mode enabled');

    // 从数据库加载 system prompt
    currentConfig.SYSTEM_PROMPT_CONTENT = await getSystemPromptContent();

    // 号池配置从数据库加载
    currentConfig.providerPools = {};
    console.log('[Config] Provider pools are loaded from MySQL only');

    // 环境变量 PORT 覆盖（用于管理进程独立端口）
    if (process.env.PORT) {
        const envPort = parseInt(process.env.PORT, 10);
        if (!isNaN(envPort)) {
            console.log(`[Config] PORT overridden by environment variable: ${envPort}`);
            currentConfig.SERVER_PORT = envPort;
        }
    }

    // 标记是否为管理进程
    currentConfig.IS_ADMIN_PROCESS = process.env.IS_ADMIN_PROCESS === 'true';
    if (currentConfig.IS_ADMIN_PROCESS) {
        console.log('[Config] Running as ADMIN process (isolated from AI requests)');
    }

    // Set PROMPT_LOG_FILENAME based on the determined config
    if (currentConfig.PROMPT_LOG_MODE === 'file') {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        PROMPT_LOG_FILENAME = `${currentConfig.PROMPT_LOG_BASE_NAME}-${timestamp}.log`;
    } else {
        PROMPT_LOG_FILENAME = ''; // Clear if not logging to file
    }

    // Assign to the exported CONFIG
    Object.assign(CONFIG, currentConfig);
    return CONFIG;
}

/**
 * Gets system prompt content from MySQL database.
 * @returns {Promise<string|null>} System prompt content, or null if not found or an error occurs.
 */
export async function getSystemPromptContent() {
    try {
        const value = await appMetaDao.getValue('system_prompt_content');
        if (value && value.trim()) {
            console.log('[System Prompt] Loaded system prompt from MySQL');
            return value;
        }
        return null;
    } catch (error) {
        console.error(`[System Prompt] Error reading system prompt from MySQL: ${error.message}`);
        return null;
    }
}

export { ALL_MODEL_PROVIDERS };
