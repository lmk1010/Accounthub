import { handleError } from '../utils/common.js';
import { handleUIApiRequests, serveStaticFiles } from '../services/ui-manager.js';
import { handleAPIRequests } from '../services/api-manager.js';
import { getApiService, getProviderStatus } from '../services/service-manager.js';
import { getProviderPoolManager } from '../services/service-manager.js';
import { MODEL_PROVIDER, normalizeModelProvider } from '../utils/common.js';
import { PROMPT_LOG_FILENAME } from '../core/config-manager.js';
import { handleOllamaRequest, handleOllamaShow } from './ollama-handler.js';
import { handlePotluckApiRoutes, handlePotluckUserApiRoutes } from '../plugins/api-potluck/api-routes.js';
import { potluckAuthMiddleware, sendPotluckError } from '../plugins/api-potluck/middleware.js';
import { traceMonitorRouter } from '../routes/trace.routes.js';
import { getRedisClient, isRedisAvailable } from '../services/redis-client.js';

// 并发连接统计 - 本地备份（用于 Redis 不可用时的降级）
const concurrencyStats = {
    activeConnections: 0,
    peakConnections: 0,
    totalConnections: 0,
    lastPeakTime: null
};

// 记录最近一次"本地确实有活跃请求"的时间戳，供 Watchdog 判断漂移
let lastLocalActiveAt = 0;

// ─── Per-Worker Redis key ─────────────────────────────────────────────────────
// 每个 Worker 拥有独立的 active_connections key，解决集群模式下 Watchdog 误清其他
// Worker 计数的竞态问题。Peak / Total / LastPeakTime 仍为全局 key（聚合语义）。
//
//   Worker N  → monitor:active_connections:wN
//   Admin     → monitor:active_connections:admin
//   Standalone→ monitor:active_connections:standalone
//
// getConcurrencyStats() 聚合所有 monitor:active_connections:w* 得到全局 active。
// ─────────────────────────────────────────────────────────────────────────────
function resolveWorkerActiveKey() {
    const shardId = process.env.WORKER_SHARD_ID;
    if (shardId !== undefined && shardId !== '') return `monitor:active_connections:w${shardId}`;
    if (process.env.IS_ADMIN_PROCESS === 'true') return 'monitor:active_connections:admin';
    return 'monitor:active_connections:standalone';
}
const WORKER_ACTIVE_KEY = resolveWorkerActiveKey();

const REDIS_KEYS = {
    ACTIVE_THIS_WORKER: WORKER_ACTIVE_KEY,
    ACTIVE_WORKER_PATTERN: 'monitor:active_connections:w*',
    PEAK_CONNECTIONS: 'monitor:peak_connections',
    TOTAL_CONNECTIONS: 'monitor:total_connections',
    LAST_PEAK_TIME: 'monitor:last_peak_time'
};

/**
 * 聚合所有 Worker 的 active 计数（KEYS 扫描，仅用于读取统计，不在热路径上）
 */
async function getGlobalActiveConnections(redis) {
    try {
        const keys = await redis.keys(REDIS_KEYS.ACTIVE_WORKER_PATTERN);
        if (!keys || keys.length === 0) return 0;
        const vals = await Promise.all(keys.map(k => redis.get(k).catch(() => null)));
        return vals.reduce((sum, v) => sum + (parseInt(v) || 0), 0);
    } catch {
        return 0;
    }
}

/**
 * 增加本 Worker 的 Redis 并发计数，同时更新全局 total 和 peak
 */
async function incrRedisConnection() {
    const redis = getRedisClient();
    if (!redis) return null;

    try {
        // 本 Worker active +1，全局 total +1
        await Promise.all([
            redis.incr(REDIS_KEYS.ACTIVE_THIS_WORKER),
            redis.incr(REDIS_KEYS.TOTAL_CONNECTIONS)
        ]);

        // 用本地内存计数更新峰值（避免每次 incr 都扫全 Worker key）
        const localActive = concurrencyStats.activeConnections;
        const peak = await redis.get(REDIS_KEYS.PEAK_CONNECTIONS).catch(() => null);
        if (!peak || localActive > parseInt(peak)) {
            await Promise.all([
                redis.set(REDIS_KEYS.PEAK_CONNECTIONS, localActive),
                redis.set(REDIS_KEYS.LAST_PEAK_TIME, new Date().toISOString())
            ]);
        }
        return localActive;
    } catch (err) {
        console.error('[RequestHandler] Redis incr connection error:', err.message);
        return null;
    }
}

/**
 * 减少本 Worker 的 Redis 并发计数，失败重试 3 次，防止漂移
 */
async function decrRedisConnection() {
    const redis = getRedisClient();
    if (!redis) return null;

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const count = await redis.decr(REDIS_KEYS.ACTIVE_THIS_WORKER);
            if (count < 0) {
                await redis.set(REDIS_KEYS.ACTIVE_THIS_WORKER, 0);
                return 0;
            }
            return count;
        } catch (err) {
            lastErr = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 10 * (attempt + 1)));
        }
    }
    console.error('[RequestHandler] Redis decr connection error after retries:', lastErr?.message || lastErr);
    return null;
}

/**
 * 获取并发统计数据（优先从 Redis 获取）
 * active = 聚合所有 Worker 的 per-worker key
 * peak / total = 全局 key
 */
export async function getConcurrencyStats() {
    const redis = getRedisClient();
    if (!redis) {
        return { ...concurrencyStats };
    }

    try {
        const [active, peak, total, lastPeakTime] = await Promise.all([
            getGlobalActiveConnections(redis),
            redis.get(REDIS_KEYS.PEAK_CONNECTIONS),
            redis.get(REDIS_KEYS.TOTAL_CONNECTIONS),
            redis.get(REDIS_KEYS.LAST_PEAK_TIME)
        ]);

        return {
            activeConnections: active,
            peakConnections: parseInt(peak) || 0,
            totalConnections: parseInt(total) || 0,
            lastPeakTime: lastPeakTime || null
        };
    } catch (err) {
        console.error('[RequestHandler] Redis get stats error:', err.message);
        return { ...concurrencyStats };
    }
}

export function getLocalConcurrencyStats() {
    return { ...concurrencyStats };
}

/**
 * 并发计数自愈 Watchdog
 *
 * 每个 Worker 独立监控自己的 per-worker key：
 *   - 本地 active === 0 且超过 3 分钟没有新请求
 *   - 但 Redis 里本 Worker 的 key 仍 > 0（说明 decr 曾经丢失）
 * 则将本 Worker 的 key 清零。
 *
 * 不再依赖"只让 shard 0 操作全局 key"的 hack，每个 Worker 只操作自己的 key，
 * 彻底消除跨 Worker 竞态。
 */
let concurrencyWatchdogHandle = null;
export function startConcurrencyWatchdog(intervalMs = 60 * 1000) {
    if (process.env.IS_WORKER_PROCESS !== 'true') return null;
    if (concurrencyWatchdogHandle) return concurrencyWatchdogHandle;

    concurrencyWatchdogHandle = setInterval(async () => {
        try {
            // 本 Worker 本地仍有活跃请求，不需要自愈
            if (concurrencyStats.activeConnections !== 0) return;
            const idleForMs = Date.now() - lastLocalActiveAt;
            if (idleForMs < 3 * 60 * 1000) return;

            const redis = getRedisClient();
            if (!redis) return;

            // 读本 Worker 自己的 key，发现有漂移才清零
            const raw = await redis.get(REDIS_KEYS.ACTIVE_THIS_WORKER).catch(() => null);
            const remote = parseInt(raw, 10);
            if (!Number.isFinite(remote) || remote <= 0) return;

            console.warn(`[RequestHandler] Concurrency watchdog [${WORKER_ACTIVE_KEY}]: remote=${remote} but local idle for ${Math.round(idleForMs / 1000)}s, resetting to 0`);
            await redis.set(REDIS_KEYS.ACTIVE_THIS_WORKER, 0).catch(() => {});
        } catch (error) {
            console.warn('[RequestHandler] Concurrency watchdog error:', error?.message || error);
        }
    }, intervalMs);

    if (typeof concurrencyWatchdogHandle.unref === 'function') {
        concurrencyWatchdogHandle.unref();
    }
    return concurrencyWatchdogHandle;
}

export function stopConcurrencyWatchdog() {
    if (concurrencyWatchdogHandle) {
        clearInterval(concurrencyWatchdogHandle);
        concurrencyWatchdogHandle = null;
    }
}

/**
 * 重置并发统计数据（清 peak / total，保留 active 真实值）
 */
export async function resetConcurrencyStats() {
    const redis = getRedisClient();
    if (redis) {
        try {
            const activeCount = await getGlobalActiveConnections(redis);
            await Promise.all([
                redis.set(REDIS_KEYS.PEAK_CONNECTIONS, activeCount),
                redis.set(REDIS_KEYS.TOTAL_CONNECTIONS, 0),
                redis.set(REDIS_KEYS.LAST_PEAK_TIME, activeCount > 0 ? new Date().toISOString() : '')
            ]);
        } catch (err) {
            console.error('[RequestHandler] Redis reset stats error:', err.message);
        }
    }
    concurrencyStats.peakConnections = concurrencyStats.activeConnections;
    concurrencyStats.totalConnections = 0;
    concurrencyStats.lastPeakTime = concurrencyStats.activeConnections > 0 ? new Date().toISOString() : null;
}

/**
 * Parse request body as JSON
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON in request body'));
            }
        };
        // 只在 req.readableEnded 真为 true(end 已 emit)时走 read() 路径,
        // 否则会和 flowing 模式的 nextTick flush 竞争导致 body 被 append 两次
        if (req.readableEnded) {
            try {
                let chunk;
                while (typeof req.read === 'function' && (chunk = req.read()) !== null) {
                    body += chunk.toString();
                }
            } catch (_e) { /* ignore */ }
            finish();
            return;
        }
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', finish);
        req.on('error', err => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

function getPoolId(req, requestUrl) {
    const headerValue =
        req.headers['x-accounthub-poolid'] ||
        req.headers['x-accounthub-pool-id'] ||
        req.headers['x-account-hub-pool-id'] ||
        req.headers['x-pool-id'];
    if (headerValue) {
        if (Array.isArray(headerValue)) {
            return headerValue.length > 0 ? String(headerValue[0]).trim() : null;
        }
        return String(headerValue).trim();
    }
    const queryPoolId = requestUrl.searchParams.get('poolId') || requestUrl.searchParams.get('pool');
    return queryPoolId ? String(queryPoolId).trim() : null;
}

function isApiKeyAuthorized(req, requestUrl, requiredApiKey) {
    if (!requiredApiKey) return true;

    // 确保 requiredApiKey 是字符串类型
    const requiredKeyStr = String(requiredApiKey);

    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === requiredKeyStr) {
            return true;
        }
    }

    if (queryKey === requiredKeyStr) {
        return true;
    }

    if (googApiKey === requiredKeyStr) {
        return true;
    }

    if (claudeApiKey === requiredKeyStr) {
        return true;
    }

    return false;
}

/**
 * Main request handler. It authenticates the request, determines the endpoint type,
 * and delegates to the appropriate specialized handler function.
 * @param {Object} config - The server configuration
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Function} - The request handler function
 */
export function createRequestHandler(config, providerPoolManager) {
    return async function requestHandler(req, res) {
        // 并发统计：请求开始 - 同时更新本地和 Redis
        concurrencyStats.activeConnections++;
        concurrencyStats.totalConnections++;
        lastLocalActiveAt = Date.now();
        if (concurrencyStats.activeConnections > concurrencyStats.peakConnections) {
            concurrencyStats.peakConnections = concurrencyStats.activeConnections;
            concurrencyStats.lastPeakTime = new Date().toISOString();
        }
        // 异步更新 Redis（不阻塞请求）
        incrRedisConnection().catch(() => {});

        // Phase 1: 更稳的 decrement 触发链
        //   - res.on('finish') / res.on('close')  — 常规路径
        //   - req.on('close') / req.on('aborted') — 早期 abort(客户端断开 / 超时)
        //   - try/finally 在 handler 函数体末尾兜底(防止事件因未知原因不触发)
        // 旧实现只挂 res 两个事件,在极少数路径(比如被上层 serverInstance maxConnections
        // 拒绝后进入 handler 路径)事件不会触发,累计成了 Redis counter 漂移。
        let connectionClosed = false;
        const decrementConnection = () => {
            if (connectionClosed) return;
            connectionClosed = true;
            concurrencyStats.activeConnections = Math.max(0, concurrencyStats.activeConnections - 1);
            // 异步减少 Redis 计数(decrRedisConnection 内部已有 3 次重试)
            decrRedisConnection().catch(() => { /* 已在 decrRedisConnection 里记录 */ });
        };
        res.on('finish', decrementConnection);
        res.on('close', decrementConnection);
        req.on('close', decrementConnection);
        req.on('aborted', decrementConnection);

        // Shallow copy the config for each request to allow dynamic modification
        // 使用浅拷贝替代 deepmerge，减少 CPU 开销（config 对象在请求处理中只修改顶层属性）
        const currentConfig = { ...config };
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        let path = requestUrl.pathname;
        const method = req.method;

        // Set CORS headers for all requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key, Model-Provider, X-Requested-With, Accept, Origin, X-Idempotency-Key, X-AccountHub-TokenId, X-AccountHub-Token-Id, X-Token-Id, X-AccountHub-PoolId, X-AccountHub-Pool-Id, X-Pool-Id, X-AccountHub-UserId, X-AccountHub-User-Id, X-User-Id, X-AccountHub-UserEmail, X-AccountHub-User-Email, X-User-Email, X-AccountHub-Username, X-AccountHub-UserName, X-User-Name, X-AccountHub-ClientIP, X-AccountHub-Client-IP, X-Client-IP');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache for preflight

        // Security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Handle CORS preflight requests
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Serve static files for UI (除了登录页面需要认证)
        if (path.startsWith('/static/') || path === '/' || path === '/favicon.ico' || path === '/favicon.svg' || path === '/index.html' || path.startsWith('/app/') || path.startsWith('/components/') || path === '/login.html') {
            const served = await serveStaticFiles(path, res);
            if (served) return;
        }

        // 前端 SPA 路由支持 - 将前端路由重定向到 index.html
        const frontendRoutes = ['dashboard', 'docs', 'config', 'providers', 'usage', 'logs', 'request-logs', 'error-history', 'potluck-admin', 'potluck-user'];
        const pathWithoutSlash = path.slice(1); // 去掉开头的 /
        if (frontendRoutes.includes(pathWithoutSlash)) {
            const served = await serveStaticFiles('/', res);
            if (served) return;
        }

        // Potluck API routes
        const potluckUserHandled = await handlePotluckUserApiRoutes(method, path, req, res);
        if (potluckUserHandled) return;
        const potluckAdminHandled = await handlePotluckApiRoutes(method, path, req, res);
        if (potluckAdminHandled) return;

        const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
        if (uiHandled) return;

        // Trace monitoring API routes
        const traceHandled = await traceMonitorRouter(method, path, req, res);
        if (traceHandled) return;

        // Ollama show endpoint with model name
        if (method === 'POST' && path === '/ollama/api/show') {
            await handleOllamaShow(req, res);
            return true;
        }

        console.log(`\n${new Date().toLocaleString()}`);
        console.log(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);

        // Health check endpoint
        if (method === 'GET' && path === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                provider: currentConfig.MODEL_PROVIDER
            }));
            return true;
        }

        // providers health endpoint
        // url params: provider[string], customName[string], unhealthRatioThreshold[float]
        // 支持provider, customName过滤记录 
        // 支持unhealthRatioThreshold控制不健康比例的阈值, 当unhealthyRatio超过阈值返回summaryHealthy: false
        if (method === 'GET' && path === '/provider_health') {
            try {
                const provider = requestUrl.searchParams.get('provider');
                const customName = requestUrl.searchParams.get('customName');
                let unhealthRatioThreshold = requestUrl.searchParams.get('unhealthRatioThreshold');
                unhealthRatioThreshold = unhealthRatioThreshold === null ? 0.0001 : parseFloat(unhealthRatioThreshold);
                let provideStatus = await getProviderStatus(currentConfig, { provider, customName });
                let summaryHealth = true;
                if (!isNaN(unhealthRatioThreshold)) {
                    summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    items: provideStatus.providerPoolsSlim,
                    count: provideStatus.count,
                    unhealthyCount: provideStatus.unhealthyCount,
                    unhealthyRatio: provideStatus.unhealthyRatio,
                    unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
                    summaryHealth
                }));
                return true;
            } catch (error) {
                console.log(`[Server] req provider_health error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `获取账号健康状态失败: ${error.message}` }, currentConfig.MODEL_PROVIDER);
                return;
            }
        }


        // Handle API requests
        // Allow overriding MODEL_PROVIDER via request header
        const modelProviderHeader = req.headers['model-provider'];
        if (modelProviderHeader) {
            currentConfig.MODEL_PROVIDER = normalizeModelProvider(modelProviderHeader) || modelProviderHeader;
            console.log(`[Config] MODEL_PROVIDER overridden by header to: ${currentConfig.MODEL_PROVIDER}`);
        }
          
        // Check if the first path segment matches a MODEL_PROVIDER and switch if it does
        // Note: 'ollama' is not a valid MODEL_PROVIDER, it's a protocol prefix for Ollama API compatibility
        const originalPath = path;
        if (path === '/openai/v1/videos' || path.startsWith('/openai/v1/videos/')) {
            path = path.replace(/^\/openai\/v1/, '/v1');
            requestUrl.pathname = path;
            console.log(`[RouteDebug] OpenAI video alias rewrite: ${originalPath} -> ${path}`);
        }
        const pathSegments = path.split('/').filter(segment => segment.length > 0);
        const isOllamaPath = pathSegments[0] === 'ollama' || path.startsWith('/api/');
        
        if (pathSegments.length > 0 && !isOllamaPath) {
            const firstSegment = pathSegments[0];
            const normalizedProvider = normalizeModelProvider(firstSegment);
            if (firstSegment && normalizedProvider) {
                currentConfig.MODEL_PROVIDER = normalizedProvider;
                console.log(`[Config] MODEL_PROVIDER overridden by path segment to: ${currentConfig.MODEL_PROVIDER}`);
                pathSegments.shift();
                path = '/' + pathSegments.join('/');
                requestUrl.pathname = path;
                console.log(`[RouteDebug] Provider-prefixed path rewrite: ${originalPath} -> ${path}`);
            } else if (firstSegment && !normalizedProvider) {
                console.log(`[Config] Ignoring invalid MODEL_PROVIDER in path segment: ${firstSegment}`);
            }
        }

        // 1. 执行认证流程（Potluck Key 优先）
        let isAuthorized = false;
        const potluckAuth = await potluckAuthMiddleware(req, requestUrl);
        if (potluckAuth.authorized === false) {
            sendPotluckError(res, potluckAuth.error);
            return;
        }
        if (potluckAuth.authorized === true) {
            isAuthorized = true;
            currentConfig.potluckApiKey = potluckAuth.apiKey;
            currentConfig.potluckKeyData = potluckAuth.keyData;
        } else {
            isAuthorized = isApiKeyAuthorized(req, requestUrl, currentConfig.REQUIRED_API_KEY);
        }

        if (!isAuthorized) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'API Key 无效或缺失' } }));
            return;
        }

        const poolId = getPoolId(req, requestUrl);
        if (poolId) {
            currentConfig.POOL_ID = poolId;
            currentConfig.POOL_ID_EXPLICIT = true;
        } else {
            currentConfig.POOL_ID_EXPLICIT = false;
        }

        // 传递客户端请求头给 Droid 适配器使用（每请求隔离）
        currentConfig.DROID_CLIENT_HEADERS = req.headers;
        currentConfig.DROID_CLIENT_AUTHORIZATION = req.headers['authorization'] || null;
        currentConfig.DROID_CLIENT_X_API_KEY = req.headers['x-api-key'] || null;

        // Handle Ollama request BEFORE getting apiService (Ollama endpoints handle their own provider selection)
        // This is important because Ollama /api/tags aggregates models from ALL providers, not just the default one
        if (isOllamaPath) {
            const { handled, normalizedPath } = await handleOllamaRequest(method, path, requestUrl, req, res, null, currentConfig, providerPoolManager);
            if (handled) return;
            // If not handled by Ollama handler, continue with normal flow
            path = normalizedPath;
        }

        const isContentGenerationRequest = (
            method === 'POST' && (
                path === '/v1/chat/completions' ||
                path === '/v1/responses' ||
                path === '/v1/responses/compact' ||
                path === '/v1/images/generations' ||
                path === '/v1/images/edits' ||
                path === '/v1/videos' ||
                path === '/v1/videos/generations' ||
                path === '/v1/videos/edits' ||
                path === '/v1/videos/extensions' ||
                /^\/v1\/videos\/[^/]+\/remix$/.test(path) ||
                path === '/v1/messages' ||
                /\/v1beta\/models\/.+:(generateContent|streamGenerateContent)/.test(path)
            )
        ) || (
            method === 'GET' && /^\/v1\/videos\/[^/]+(?:\/content)?$/.test(path)
        );

        // 获取或选择 API Service 实例
        let apiService;
        if (!isContentGenerationRequest) {
            try {
                apiService = await getApiService(currentConfig, null, {
                    skipUsageCount: true,
                    requestContext: {
                        headers: req.headers,
                        path: req.url,
                        method: req.method,
                        clientIp: req.socket?.remoteAddress || null
                    }
                });
            } catch (error) {
                handleError(res, {
                    statusCode: error.statusCode || error.status || 500,
                    message: error.message || '获取服务实例失败'
                }, currentConfig.MODEL_PROVIDER);
                const poolManager = getProviderPoolManager();
                if (poolManager && !error.isUserBlacklist) {
                    poolManager.markProviderUnhealthy(currentConfig.MODEL_PROVIDER, currentConfig.uuid, error.message);
                }
                return;
            }
        }

        // Handle count_tokens requests (Anthropic API compatible)
        if (path.includes('/count_tokens') && method === 'POST') {
            try {
                const body = await parseRequestBody(req);
                console.log(`[Server] Handling count_tokens request for model: ${body.model}`);

                // Check if apiService has countTokens method
                if (apiService && typeof apiService.countTokens === 'function') {
                    const result = apiService.countTokens(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } else {
                    // Fallback: use estimateInputTokens if available
                    if (apiService && typeof apiService.estimateInputTokens === 'function') {
                        const inputTokens = apiService.estimateInputTokens(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ input_tokens: inputTokens }));
                    } else {
                        // Last resort: return 0 with a message
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ input_tokens: 0 }));
                    }
                }
                return true;
            } catch (error) {
                console.error(`[Server] count_tokens error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `Token 计数失败: ${error.message}` }, currentConfig.MODEL_PROVIDER);
                return;
            }
        }

        try {
            // Handle API requests (Ollama requests are already handled above before apiService is obtained)
            const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
            if (apiHandled) return;

            // Fallback for unmatched routes
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '请求路径不存在' } }));
        } catch (error) {
            handleError(res, error, currentConfig.MODEL_PROVIDER);
        }
    };
}
