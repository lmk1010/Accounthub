// 加载环境变量配置（必须在最前面）
import dotenv from 'dotenv';

// 根据 NODE_ENV 加载对应的环境配置文件
const env = process.env.NODE_ENV || 'development';
if (env === 'production') {
    dotenv.config({ path: '.env.production' });
} else if (env === 'development') {
    dotenv.config({ path: '.env.development' });
} else {
    dotenv.config(); // 默认加载 .env
}

// 启用全局日志脱敏（生产环境自动启用）
import { enableGlobalSanitization } from '../utils/safe-logger.js';
if (env === 'production' || process.env.ENABLE_LOG_SANITIZATION === 'true') {
    enableGlobalSanitization();
}

console.log(`[Environment] Running in ${env} mode`);

import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { initializeConfig, CONFIG } from '../core/config-manager.js';
import { initApiService, autoLinkProviderConfigs } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { createRequestHandler } from '../handlers/request-handler.js';
import { initializeDatabase, isDatabaseInitialized } from '../config/database.js';
import { initTable as initEmailTable } from '../dao/email-dao.js';
import { ensureTable as ensureTokenStatsTable } from '../dao/provider-token-stats-dao.js';
import * as appMetaDao from '../dao/app-meta-dao.js';
import { enhanceRequestHandler } from '../middleware/route-enhancer.js';
import { configureMonitoring, stopAllMonitoring } from './monitoring-scheduler.js';
import { setConfigGetter } from '../plugins/api-potluck/key-manager.js';
import { getConfig as getPotluckConfig } from '../plugins/api-potluck/user-data-manager.js';
import { reloadConfig as reloadUiConfig } from '../ui-modules/config-api.js';
import { broadcastEventLocal } from '../ui-modules/event-broadcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * 描述 / Description:
 * (最终生产就绪版本 / Final Production Ready Version)
 * 此脚本创建一个独立的 Node.js HTTP 服务器，作为 Google Cloud Code Assist API 的本地代理。
 * 此版本包含所有功能和错误修复，设计为健壮、灵活且易于通过全面可控的日志系统进行监控。
 * 
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for the Google Cloud Code Assist API.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * 主要功能 / Key Features:
 * - OpenAI & Gemini & Claude 多重兼容性：无缝桥接使用 OpenAI API 格式的客户端与 Google Gemini API。支持原生 Gemini API (`/v1beta`) 和 OpenAI 兼容 (`/v1`) 端点。
 *   OpenAI & Gemini & Claude Dual Compatibility: Seamlessly bridges clients using the OpenAI API format with the Google Gemini API. Supports both native Gemini API (`/v1beta`) and OpenAI-compatible (`/v1`) endpoints.
 * 
 * - 强大的身份验证管理：支持多种身份验证方法，包括通过 Base64 字符串、文件路径或自动发现本地凭据的 OAuth 2.0 配置。能够自动刷新过期令牌以确保服务持续运行。
 *   Robust Authentication Management: Supports multiple authentication methods, including OAuth 2.0 configuration via Base64 strings, file paths, or automatic discovery of local credentials. Capable of automatically refreshing expired tokens to ensure continuous service operation.
 * 
 * - 灵活的 API 密钥验证：支持三种 API 密钥验证方法：`Authorization: Bearer <key>` 请求头、`x-goog-api-key` 请求头和 `?key=` URL 查询参数，可通过 `--api-key` 启动参数配置。
 *   Flexible API Key Validation: Supports three API key validation methods: `Authorization: Bearer <key>` request header, `x-goog-api-key` request header, and `?key=` URL query parameter, configurable via the `--api-key` startup parameter.
 * 
 * - 动态系统提示管理 / Dynamic System Prompt Management:
 *   - 文件注入：通过 `--system-prompt-file` 从外部文件加载系统提示，并通过 `--system-prompt-mode` 控制其行为（覆盖或追加）。
 *     File Injection: Loads system prompts from external files via `--system-prompt-file` and controls their behavior (overwrite or append) with `--system-prompt-mode`.
 *   - 实时同步：能够将请求中包含的系统提示实时写入 `configs/fetch_system_prompt.txt` 文件，便于开发者观察和调试。
 *     Real-time Synchronization: Capable of writing system prompts included in requests to the `fetch_system_prompt.txt` file in real-time, facilitating developer observation and debugging.
 * 
 * - 智能请求转换和修复：自动将 OpenAI 格式的请求转换为 Gemini 格式，包括角色映射（`assistant` -> `model`）、合并来自同一角色的连续消息以及修复缺失的 `role` 字段。
 *   Intelligent Request Conversion and Repair: Automatically converts OpenAI-formatted requests to Gemini format, including role mapping (`assistant` -> `model`), merging consecutive messages from the same role, and fixing missing `role` fields.
 * 
 * - 全面可控的日志系统：提供两种日志模式（控制台或文件），详细记录每个请求的输入和输出、剩余令牌有效性等信息，用于监控和调试。
 *   Comprehensive and Controllable Logging System: Provides two logging modes (console or file), detailing input and output of each request, remaining token validity, and other information for monitoring and debugging.
 * 
 * - 高度可配置的启动：支持通过命令行参数配置服务监听地址、端口、项目 ID、API 密钥和日志模式。
 *   Highly Configurable Startup: Supports configuring service listening address, port, project ID, API key, and logging mode via command-line parameters.
 *
 * 使用示例 / Usage Examples:
 * 
 * 基本用法 / Basic Usage:
 * node src/api-server.js
 * 
 * 服务器配置 / Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 * 
 * OpenAI 提供商 / OpenAI Provider:
 * node src/api-server.js --model-provider openai-custom --openai-api-key sk-xxx --openai-base-url https://api.openai.com/v1
 * 
 * Claude 提供商 / Claude Provider:
 * node src/api-server.js --model-provider claude-custom --claude-api-key sk-ant-xxx --claude-base-url https://api.anthropic.com
 * 
 * Gemini 提供商（使用 Base64 凭据的 OAuth）/ Gemini Provider (OAuth with Base64 credentials):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-base64 eyJ0eXBlIjoi... --project-id your-project-id
 * 
 * Gemini 提供商（使用凭据文件的 OAuth）/ Gemini Provider (OAuth with credentials file):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-file /path/to/credentials.json --project-id your-project-id
 * 
 * 系统提示管理 / System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 * 
 * 日志配置 / Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 * 
 * 完整示例 / Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 3000 \
 *   --api-key my-secret-key \
 *   --model-provider gemini-cli-oauth \
 *   --project-id my-gcp-project \
 *   --gemini-oauth-creds-file ./credentials.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 * 
 * 命令行参数 / Command Line Parameters:
 * --host <address>                    服务器监听地址 / Server listening address (default: 0.0.0.0)
 * --port <number>                     服务器监听端口 / Server listening port (default: 3000)
 * --api-key <key>                     身份验证所需的 API 密钥 / Required API key for authentication (default: 123456)
 * --model-provider <provider[,provider...]> AI 模型提供商 / AI model provider: openai-custom, claude-custom, gemini-cli-oauth, claude-kiro-oauth
 * --openai-api-key <key>             OpenAI API 密钥 / OpenAI API key (for openai-custom provider)
 * --openai-base-url <url>            OpenAI API 基础 URL / OpenAI API base URL (for openai-custom provider)
 * --claude-api-key <key>             Claude API 密钥 / Claude API key (for claude-custom provider)
 * --claude-base-url <url>            Claude API 基础 URL / Claude API base URL (for claude-custom provider)
 * --gemini-oauth-creds-base64 <b64>  Gemini OAuth 凭据的 Base64 字符串 / Gemini OAuth credentials as Base64 string
 * --gemini-oauth-creds-file <path>   Gemini OAuth 凭据 JSON 文件路径 / Path to Gemini OAuth credentials JSON file
 * --kiro-oauth-creds-base64 <b64>    Kiro OAuth 凭据的 Base64 字符串 / Kiro OAuth credentials as Base64 string
 * --kiro-oauth-creds-file <path>     Kiro OAuth 凭据 JSON 文件路径 / Path to Kiro OAuth credentials JSON file
 * --qwen-oauth-creds-file <path>     Qwen OAuth 凭据 JSON 文件路径 / Path to Qwen OAuth credentials JSON file
 * --project-id <id>                  Google Cloud 项目 ID / Google Cloud Project ID (for gemini-cli provider)
 * --system-prompt-file <path>        系统提示文件路径 / Path to system prompt file (default: configs/input_system_prompt.txt)
 * --system-prompt-mode <mode>        系统提示模式 / System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               提示日志模式 / Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      提示日志文件基础名称 / Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     API 请求失败时，自动重试的最大次数。 / Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      自动重试之间的基础延迟时间（毫秒）。每次重试后延迟会增加。 / Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       OAuth 令牌刷新任务计划的间隔时间（分钟）。 / Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     是否开启 OAuth 令牌自动刷新任务 / Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       提供商号池配置文件路径 / Path to provider pools configuration file (default: null)
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import '../converters/register-converters.js'; // 注册所有转换器
import { getProviderPoolManager } from './service-manager.js';

// 检测是否作为子进程运行
const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';

// 存储服务器实例，用于优雅关闭
let serverInstance = null;
const socketStats = {
    activeConnections: 0,
    peakConnections: 0,
    totalConnections: 0,
    lastPeakTime: null
};

export function getSocketStats() {
    return { ...socketStats };
}

// 服务器配置常量
const SERVER_CONFIG = {
    // HTTP 最大连接数（可通过环境变量配置）
    MAX_CONNECTIONS: parseInt(process.env.MAX_CONNECTIONS) || 10000,
    // 请求超时（毫秒），0 表示禁用（流式响应需要）
    REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 0,
    // 头部超时（毫秒）
    HEADERS_TIMEOUT: parseInt(process.env.HEADERS_TIMEOUT) || 60000,
    // Keep-Alive 超时（毫秒）
    KEEP_ALIVE_TIMEOUT: parseInt(process.env.KEEP_ALIVE_TIMEOUT) || 65000
};

/**
 * 发送消息给主进程
 * @param {Object} message - 消息对象
 */
function sendToMaster(message) {
    if (IS_WORKER_PROCESS && process.send) {
        process.send(message);
    }
}

/**
 * 设置子进程通信处理
 */
function setupWorkerCommunication() {
    if (!IS_WORKER_PROCESS) return;

    // 定时上报状态给 Master（每 5 秒）
    setInterval(async () => {
        try {
            const { collectWorkerRuntimeStats } = await import('../core/worker-runtime-stats.js');
            const data = await collectWorkerRuntimeStats();
            sendToMaster({ type: 'worker_stats', data });
        } catch (err) {
            // 静默失败，不影响主流程
        }
    }, 5000);

    // 监听来自主进程的消息
    // 注意第二个参数 handle:cluster IPC 支持传递 socket 等 handle,用于 sticky_handoff
    process.on('message', (message, handle) => {
        if (!message || !message.type) return;

        if (message.type !== 'broadcast_event' && message.type !== 'sticky_handoff') {
            console.log('[Worker] Received message from master:', message.type);
        }

        switch (message.type) {
            case 'shutdown':
                console.log('[Worker] Shutdown requested by master');
                gracefulShutdown();
                break;
            case 'status':
                sendToMaster({
                    type: 'status',
                    data: {
                        pid: process.pid,
                        uptime: process.uptime(),
                        memoryUsage: process.memoryUsage()
                    }
                });
                break;
            case 'provider_pool_reload': {
                if (message.originPid && message.originPid === process.pid) {
                    break;
                }
                const manager = getProviderPoolManager();
                if (manager && typeof manager.reload === 'function') {
                    console.log('[Worker] Reloading provider pool data on master broadcast');
                    manager.reload({ broadcast: false }).catch(error => {
                        console.error('[Worker] Failed to reload provider pool data:', error.message);
                    });
                }
                break;
            }
            case 'config_reload': {
                if (message.originPid && message.originPid === process.pid) {
                    break;
                }
                const manager = getProviderPoolManager();
                console.log('[Worker] Reloading config on master broadcast');
                reloadUiConfig(manager, { broadcastProviderPool: false }).catch(error => {
                    console.error('[Worker] Failed to reload config:', error.message);
                });
                break;
            }
            case 'sticky_handoff': {
                // 方案 C 起不再使用 IPC fd handoff —— master 改成 loopback TCP 代理,
                // worker 通过标准 HTTP server 监听 127.0.0.1:11558+shardId 接收流量。
                // 还收到这个消息类型说明 master 和 worker 版本没对齐,记一条警告。
                console.warn('[Worker] deprecated sticky_handoff received; master should be using loopback TCP proxy. Destroying socket.');
                if (handle) {
                    try { handle.destroy(); } catch (_e) {}
                }
                break;
            }
            case 'broadcast_event': {
                if (message.originPid && message.originPid === process.pid) {
                    break;
                }
                // Phase 1:provider_removed 事件必须在本 worker 本地 dispose 对应 adapter,
                // 否则内存中仍残留其他 worker 刚刚删除的 provider,且若请求打过来会用到失效 credentials。
                // SSE 通道的 broadcastEventLocal 对 UI 客户端透传,本地清理逻辑与 UI 推送解耦。
                if (message.eventType === 'provider_removed') {
                    const uuid = message.data?.uuid;
                    if (uuid) {
                        import('../providers/adapter.js').then(({ deleteServiceInstancesByUuid }) => {
                            try {
                                const removed = deleteServiceInstancesByUuid(uuid);
                                if (removed > 0) {
                                    console.log(`[Worker] provider_removed broadcast: disposed ${removed} local adapter(s) for uuid ${String(uuid).slice(0, 8)}`);
                                }
                            } catch (error) {
                                console.warn('[Worker] provider_removed local cleanup failed:', error?.message || error);
                            }
                        }).catch(() => { /* adapter 模块加载失败静默 */ });
                    }
                }
                if (message.eventType === 'channel_config_updated') {
                    const providerType = message.data?.providerType;
                    import('./channel-config-runtime.js').then(({ clearChannelConfigRuntimeCaches }) => {
                        clearChannelConfigRuntimeCaches(providerType);
                    }).catch(error => {
                        console.warn('[Worker] channel_config_updated local cache cleanup failed:', error?.message || error);
                    });
                }
                broadcastEventLocal(message.eventType, message.data);
                break;
            }
            default:
                console.log('[Worker] Unknown message type:', message.type);
        }
    });

    // 监听断开连接
    process.on('disconnect', () => {
        console.log('[Worker] Disconnected from master, shutting down...');
        gracefulShutdown();
    });
}

/**
 * 优雅关闭服务器
 */
async function gracefulShutdown() {
    console.log('[Server] Initiating graceful shutdown...');

    stopAllMonitoring(getProviderPoolManager());

    // Phase 1: 停止 idle sweeper,避免关闭过程中仍然触发 dispose
    try {
        const { stopAdapterIdleSweeper } = await import('../providers/adapter-idle-sweeper.js');
        stopAdapterIdleSweeper();
    } catch (_error) { /* ignore */ }

    // Phase 1: 停止并发计数看门狗
    try {
        const { stopConcurrencyWatchdog } = await import('../handlers/request-handler.js');
        stopConcurrencyWatchdog();
    } catch (_error) { /* ignore */ }

    // 方案 B:worker 只负责关闭自己的 HTTP server(包括 loopback 调试端口)。
    // master 的 sticky dispatcher 关闭由 master 自己在 SIGTERM 时处理,worker 不需要参与。
    // 已经 handoff 给 worker 的 socket 还在 serverInstance 里,close() 会等它们自然结束。

    if (serverInstance) {
        serverInstance.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });

        // 设置超时,防止无限等待(SSE 长连可能永远不结束)
        setTimeout(() => {
            console.log('[Server] Shutdown timeout, forcing exit...');
            process.exit(1);
        }, 10000).unref();
    } else {
        process.exit(0);
    }
}

/**
 * 设置进程信号处理
 */
function setupSignalHandlers() {
    process.on('SIGTERM', () => {
        console.log('[Server] Received SIGTERM');
        gracefulShutdown();
    });

    process.on('SIGINT', () => {
        console.log('[Server] Received SIGINT');
        gracefulShutdown();
    });

    process.on('uncaughtException', (error) => {
        console.error('[Server] Uncaught exception:', error);
        gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
    });
}

// --- Server Initialization ---
async function startServer() {
    const useDatabaseEnv = process.env.USE_DATABASE === 'true';
    if (useDatabaseEnv) {
        console.log('[Initialization] Initializing database connection pool from environment...');
        await initializeDatabase();
        console.log('[Initialization] Database connection pool initialized successfully');
    }

    // Initialize configuration
    await initializeConfig(process.argv.slice(2));

    // Initialize database connection pool (if enabled)
    if (CONFIG.USE_DATABASE && !isDatabaseInitialized()) {
        console.log('[Initialization] Initializing database connection pool...');
        await initializeDatabase(CONFIG);
        console.log('[Initialization] Database connection pool initialized successfully');
    }

    // Initialize email table
    if (isDatabaseInitialized()) {
        try {
            await initEmailTable();
            console.log('[Initialization] Email table initialized successfully');
        } catch (err) {
            console.error('[Initialization] Failed to initialize email table:', err.message);
        }

        // Initialize token stats table
        try {
            await ensureTokenStatsTable();
            console.log('[Initialization] Token stats table initialized successfully');
        } catch (err) {
            console.error('[Initialization] Failed to initialize token stats table:', err.message);
        }

        // Load debug config from database
        try {
            const debugValue = await appMetaDao.getValue('debug_tool_use');
            global.DEBUG_TOOL_USE = debugValue === 'true';
            console.log(`[Initialization] DEBUG_TOOL_USE loaded: ${global.DEBUG_TOOL_USE}`);
        } catch (err) {
            console.error('[Initialization] Failed to load debug config:', err.message);
        }
    }

    // 自动关联 configs 目录中的配置文件到对应的提供商
    // console.log('[Initialization] Checking for unlinked provider configs...');
    // await autoLinkProviderConfigs(CONFIG);

    // Initialize Potluck services
    console.log('[Initialization] Initializing potluck services...');
    setConfigGetter(getPotluckConfig);

    // Initialize API services
    const services = await initApiService(CONFIG);
    
    // Initialize UI management features
    initializeUIManagement(CONFIG);
    
    // Initialize monitoring schedulers
    configureMonitoring({
        config: CONFIG,
        providerPoolManager: getProviderPoolManager(),
        services
    });
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());

    // Enhance request handler with middleware (static files, logging, error handling)
    const enhancedHandler = enhanceRequestHandler(requestHandlerInstance, {
        staticDir: path.join(__dirname, '../../dist'),
        enableStaticFiles: true,
        enableLogging: true,
        enableErrorHandling: true,
        config: CONFIG,
        poolManager: getProviderPoolManager()
    });

    serverInstance = http.createServer({
        // 设置服务器级别的超时
        requestTimeout: SERVER_CONFIG.REQUEST_TIMEOUT,
        headersTimeout: SERVER_CONFIG.HEADERS_TIMEOUT,
        keepAliveTimeout: SERVER_CONFIG.KEEP_ALIVE_TIMEOUT
    }, enhancedHandler);

    serverInstance.on('connection', (socket) => {
        const remoteAddress = socket?.remoteAddress || 'unknown';
        socketStats.activeConnections += 1;
        socketStats.totalConnections += 1;
        if (socketStats.activeConnections > socketStats.peakConnections) {
            socketStats.peakConnections = socketStats.activeConnections;
            socketStats.lastPeakTime = new Date().toISOString();
        }
        console.log(`[TCP CONNECT] ${remoteAddress}`);

        socket.on('close', () => {
            socketStats.activeConnections = Math.max(0, socketStats.activeConnections - 1);
        });
    });

    // 设置服务器的最大连接数（从环境变量读取）
    serverInstance.maxConnections = SERVER_CONFIG.MAX_CONNECTIONS;
    console.log(`[Server] Max connections configured: ${SERVER_CONFIG.MAX_CONNECTIONS}`);

    // 方案 B:worker 进程不再 bind 对外 1458(master 的 sticky dispatcher 接管),
    // 而是:
    //   - 绑一个 loopback-only 的调试端口 WORKER_LOCAL_PORT_BASE + SHARD_ID(11558、11559、11560...)
    //     这样 `docker exec curl 127.0.0.1:11558/health` 依然能直达单个 worker
    //   - 对外请求由 master 通过 IPC 把 socket handoff 给 worker,worker 的 httpServer.emit('connection', socket)
    //     走正常 HTTP 解析,响应流直出客户端
    // admin 进程(IS_ADMIN_PROCESS=true)保持原行为:bind 1456 对外
    // 单机模式(非 cluster worker,非 admin)保持原行为:bind CONFIG.SERVER_PORT
    let listenPort = CONFIG.SERVER_PORT;
    let listenHost = CONFIG.HOST;
    const IS_WORKER = IS_WORKER_PROCESS;
    const IS_ADMIN = process.env.IS_ADMIN_PROCESS === 'true';
    if (IS_WORKER && !IS_ADMIN) {
        const shardIdRaw = parseInt(process.env.WORKER_SHARD_ID, 10);
        const portBase = parseInt(process.env.WORKER_LOCAL_PORT_BASE, 10) || 11558;
        if (Number.isFinite(shardIdRaw) && shardIdRaw >= 0) {
            listenPort = portBase + shardIdRaw;
            listenHost = '127.0.0.1';
            console.log(`[Server] Worker shard ${shardIdRaw}: binding loopback debug port ${listenHost}:${listenPort} (main traffic via master sticky dispatcher handoff)`);
        }
    }
    serverInstance.listen(listenPort, listenHost, async () => {
        console.log(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        console.log(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            console.log(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        console.log(`  System Prompt: ${CONFIG.SYSTEM_PROMPT_CONTENT ? 'Loaded from MySQL' : 'Not configured'}`);
        console.log(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        console.log(`  Host: ${CONFIG.HOST}`);
        console.log(`  Port: ${CONFIG.SERVER_PORT}`);
        console.log(`  Required API Key: ${CONFIG.REQUIRED_API_KEY ? CONFIG.REQUIRED_API_KEY.slice(0, 4) + '****' + CONFIG.REQUIRED_API_KEY.slice(-4) : '(not set)'}`);
        console.log(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        console.log(`------------------------------------------`);
        console.log(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        console.log(`Supports multiple API formats:`);
        console.log(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/responses/compact, /v1/models`);
        console.log(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
        console.log(`  • Claude-compatible: /v1/messages`);
        console.log(`  • Health check: /health`);
        console.log(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI (DISABLED - 已禁用自动打开浏览器)
        // 只显示登录页面地址，不自动打开浏览器
        let loginUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
        if(CONFIG.HOST === '0.0.0.0'){
            loginUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
        }
        console.log(`[UI] Login page available at: ${loginUrl}`);

        // 服务器完全启动后,执行初始健康检查
        const poolManager = getProviderPoolManager();
        if (poolManager && CONFIG.PROVIDER_HEALTH_CHECK_ENABLED !== false) {
            console.log('[Initialization] Performing initial health checks for provider pools...');
            poolManager.performHealthChecks(true);
        }

        // Phase 1: worker 进程启动 adapter idle sweeper,兜底回收长时间未用的 adapter
        // Phase 4: admin 进程也启动 sweeper,使用激进 TTL(5 分钟),
        //          因为 admin 只在 UI 按钮触发时临时创建 adapter,不需要长期缓存
        const IS_ADMIN_PROCESS = process.env.IS_ADMIN_PROCESS === 'true';
        if (IS_WORKER_PROCESS || IS_ADMIN_PROCESS) {
            try {
                const { startAdapterIdleSweeper } = await import('../providers/adapter-idle-sweeper.js');
                startAdapterIdleSweeper();
            } catch (error) {
                console.warn('[Server] Failed to start adapter idle sweeper:', error?.message || error);
            }
        }

        // Phase 1: 启动并发计数自愈看门狗,避免 Redis active_connections 长期漂移污染监控
        if (IS_WORKER_PROCESS) {
            try {
                const { startConcurrencyWatchdog } = await import('../handlers/request-handler.js');
                startConcurrencyWatchdog();
            } catch (error) {
                console.warn('[Server] Failed to start concurrency watchdog:', error?.message || error);
            }
        }

        // 方案 B:sticky_handoff IPC handler 已在 setupWorkerCommunication 的 switch 里注册,
        // 它会读取模块级 serverInstance 注入传入的 socket。这里无需额外 setup。

        // Phase 5: 安装诊断信号(SIGUSR1 轻量快照、SIGUSR2 heap snapshot)
        // worker 和 admin 都装,方便按 pid 远程触发
        try {
            const { installDiagnosticsSignals } = await import('../core/diagnostics.js');
            installDiagnosticsSignals();
        } catch (error) {
            console.warn('[Server] Failed to install diagnostics signals:', error?.message || error);
        }

        // 如果是子进程，通知主进程已就绪
        if (IS_WORKER_PROCESS) {
            sendToMaster({ type: 'ready', pid: process.pid });
        }
    });
    return serverInstance; // Return the server instance for testing purposes
}

// 设置信号处理
setupSignalHandlers();

// 设置子进程通信
setupWorkerCommunication();

startServer().catch(err => {
    console.error("[Server] Failed to start server:", err.message);
    process.exit(1);
});

// 导出用于外部调用
export { gracefulShutdown, sendToMaster };
