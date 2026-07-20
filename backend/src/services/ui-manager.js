import { existsSync, readFileSync } from 'fs';
import path from 'path';

// Import UI modules
import * as auth from '../ui-modules/auth.js';
import * as configApi from '../ui-modules/config-api.js';
import * as providerApi from '../ui-modules/provider-api.js';
import * as providerPoolApi from '../ui-modules/provider-pool-api.js';
import * as usageApi from '../ui-modules/usage-api.js';
import * as systemApi from '../ui-modules/system-api.js';
import * as oauthApi from '../ui-modules/oauth-api.js';
import * as poolConfigApi from '../ui-modules/pool-config-api.js';
import * as channelConfigApi from '../ui-modules/channel-config-api.js';
import * as proxyPoolApi from '../ui-modules/proxy-pool-api.js';
import * as badAccountsApi from '../ui-modules/bad-accounts-api.js';
import * as requestLogsApi from '../ui-modules/request-logs-api.js';
import * as upstreamApi from '../ui-modules/upstream-api.js';
import * as tokenStatsApi from '../ui-modules/token-stats-api.js';
import * as xaiRegistrationApi from '../ui-modules/xai-registration-api.js';
import { handleEvents } from '../ui-modules/event-broadcast.js';
import { readRequestBody } from './api-manager.js';
import { emailRouter } from '../routes/email.routes.js';

// Re-export from event-broadcast module
export { broadcastEvent, initializeUIManagement } from '../ui-modules/event-broadcast.js';

/**
 * Serve static files for the UI
 * @param {string} path - The request path
 * @param {http.ServerResponse} res - The HTTP response object
 */
export async function serveStaticFiles(pathParam, res) {
    const filePath = path.join(process.cwd(), 'static', pathParam === '/' || pathParam === '/index.html' ? 'index.html' : pathParam.replace('/static/', ''));

    if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.ico': 'image/x-icon'
        }[ext] || 'text/plain';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(filePath));
        return true;
    }
    return false;
}

/**
 * Handle UI management API requests
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Promise<boolean>} - True if the request was handled by UI API
 */
export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    // 处理登录接口
    if (method === 'POST' && pathParam === '/api/login') {
        return await auth.handleLoginRequest(req, res);
    }

    // 健康检查接口（用于前端token验证）
    if (method === 'GET' && pathParam === '/api/health') {
        return await systemApi.handleHealthCheck(req, res);
    }
    
    // Handle UI management API requests (需要token验证，除了登录接口、健康检查和Events接口)
    if (pathParam.startsWith('/api/') && pathParam !== '/api/login' && pathParam !== '/api/health' && pathParam !== '/api/events' ) {
        // 检查token验证
        const isAuth = await auth.checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        return await configApi.handleUpdateAdminPassword(req, res);
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        return await configApi.handleGetConfig(req, res, currentConfig);
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        return await configApi.handleUpdateConfig(req, res, currentConfig, providerPoolManager);
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        return await systemApi.handleGetSystem(req, res);
    }

    // Get pool statistics for dashboard
    if (method === 'GET' && pathParam === '/api/pool-stats') {
        return await systemApi.handleGetPoolStats(req, res, providerPoolManager);
    }

    // Provider pool list
    if (method === 'GET' && pathParam === '/api/provider-pools') {
        return await providerPoolApi.handleGetProviderPools(req, res);
    }

    // Create provider pool
    if (method === 'POST' && pathParam === '/api/provider-pools') {
        return await providerPoolApi.handleCreateProviderPool(req, res, providerPoolManager);
    }

    // Update/Delete provider pool
    const providerPoolMatch = pathParam.match(/^\/api\/provider-pools\/(\d+)$/);
    if (providerPoolMatch) {
        const poolId = Number(providerPoolMatch[1]);
        if (method === 'PATCH') {
            return await providerPoolApi.handleUpdateProviderPool(req, res, providerPoolManager, poolId);
        }
        if (method === 'DELETE') {
            return await providerPoolApi.handleDeleteProviderPool(req, res, providerPoolManager, poolId);
        }
    }

    // Pool config - get all
    if (method === 'GET' && pathParam === '/api/pool-configs') {
        return await poolConfigApi.handleGetAllPoolConfigs(req, res);
    }

    // Pool config - get by provider type
    const poolConfigTypeMatch = pathParam.match(/^\/api\/pool-configs\/type\/(.+)$/);
    if (method === 'GET' && poolConfigTypeMatch) {
        return await poolConfigApi.handleGetPoolConfigsByType(req, res, poolConfigTypeMatch[1]);
    }

    // Pool config - update by id
    const poolConfigIdMatch = pathParam.match(/^\/api\/pool-configs\/(\d+)$/);
    if (method === 'PATCH' && poolConfigIdMatch) {
        const body = JSON.parse(await readRequestBody(req));
        return await poolConfigApi.handleUpdatePoolConfig(req, res, Number(poolConfigIdMatch[1]), body);
    }

    // Channel config routes
    if (pathParam.startsWith('/api/channel-configs')) {
        const body = (method === 'PUT' || method === 'POST') ? JSON.parse(await readRequestBody(req)) : null;
        const handled = await channelConfigApi.handleRequest(req, res, pathParam, method, body, providerPoolManager, currentConfig);
        // 必须 return true —— 外层 request-handler 用 `if (uiHandled) return` 判断是否已处理,
        // 裸 `return` 等价于 return undefined,会让外层继续往下 match 并再写一次 header,
        // 触发 "Cannot write headers after they are sent" → 500。
        if (handled) return true;
    }

    // Proxy pool - providers
    if (method === 'GET' && pathParam === '/api/proxy-providers') {
        return await proxyPoolApi.handleGetProxyProviders(req, res);
    }
    if (method === 'POST' && pathParam === '/api/proxy-providers') {
        return await proxyPoolApi.handleCreateProxyProvider(req, res);
    }
    if (method === 'PUT' && pathParam === '/api/proxy-providers') {
        return await proxyPoolApi.handleUpdateProxyProvider(req, res);
    }
    if (method === 'DELETE' && pathParam === '/api/proxy-providers') {
        return await proxyPoolApi.handleDeleteProxyProvider(req, res);
    }

    // Proxy pool - nodes
    if (method === 'GET' && pathParam === '/api/proxy-nodes') {
        return await proxyPoolApi.handleGetProxyNodes(req, res);
    }
    if (method === 'POST' && pathParam === '/api/proxy-nodes') {
        return await proxyPoolApi.handleCreateProxyNode(req, res);
    }
    if (method === 'PUT' && pathParam === '/api/proxy-nodes') {
        return await proxyPoolApi.handleUpdateProxyNode(req, res);
    }
    if (method === 'DELETE' && pathParam === '/api/proxy-nodes') {
        return await proxyPoolApi.handleDeleteProxyNode(req, res);
    }
    if (method === 'POST' && pathParam === '/api/proxy-nodes/test') {
        return await proxyPoolApi.handleTestProxyNode(req, res);
    }

    // Proxy pool - status and refresh
    if (method === 'GET' && pathParam === '/api/proxy-pool/status') {
        return await proxyPoolApi.handleGetProxyPoolStatus(req, res);
    }
    if (method === 'POST' && pathParam === '/api/proxy-pool/refresh') {
        return await proxyPoolApi.handleRefreshProxyPool(req, res);
    }

    // Get consumption statistics
    if (method === 'GET' && pathParam === '/api/consumption-stats') {
        return await systemApi.handleGetConsumptionStats(req, res);
    }

    // Update consumption statistics (sync from Kiro API)
    if (method === 'POST' && pathParam === '/api/consumption-stats/update') {
        return await systemApi.handleUpdateConsumptionStats(req, res);
    }

    // Reset consumption statistics
    if (method === 'POST' && pathParam === '/api/consumption-stats/reset') {
        return await systemApi.handleResetConsumptionStats(req, res);
    }

    // Upstream supplier management (e.g. antigravity-channel)
    const upstreamMatch = pathParam.match(/^\/api\/upstream\/([^\/]+)\/([^\/]+)\/(.+)$/);
    if (upstreamMatch) {
        const providerType = decodeURIComponent(upstreamMatch[1]);
        const providerUuid = decodeURIComponent(upstreamMatch[2]);
        const action = upstreamMatch[3];
        return await upstreamApi.handleUpstreamRequest(req, res, providerType, providerUuid, action);
    }

    // Get shard distribution map (which provider belongs to which worker)
    if (method === 'GET' && pathParam === '/api/providers/shard-map') {
        return await providerApi.handleGetShardMap(req, res);
    }

    // Get provider pools summary (lightweight)
    if (method === 'GET' && pathParam === '/api/providers/summary') {
        return await providerApi.handleGetProvidersSummary(req, res, currentConfig, providerPoolManager);
    }

    // Get provider pools full data
    if (method === 'GET' && pathParam === '/api/providers') {
        return await providerApi.handleGetProviders(req, res, currentConfig, providerPoolManager);
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        const providerType = decodeURIComponent(providerTypeMatch[1]);
        return await providerApi.handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Get available models for all providers or specific provider type
    if (method === 'GET' && pathParam === '/api/provider-models') {
        return await providerApi.handleGetProviderModels(req, res);
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        const providerType = decodeURIComponent(providerModelsMatch[1]);
        return await providerApi.handleGetProviderTypeModels(req, res, providerType);
    }

    // Add new provider configuration
    if (method === 'POST' && pathParam === '/api/providers') {
        return await providerApi.handleAddProvider(req, res, currentConfig, providerPoolManager);
    }

    // Reset all providers health status for a specific provider type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'reset-health' as UUID
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        const providerType = decodeURIComponent(resetHealthMatch[1]);
        return await providerApi.handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Reset single provider health status
    const resetSingleHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetSingleHealthMatch) {
        const providerType = decodeURIComponent(resetSingleHealthMatch[1]);
        const providerUuid = decodeURIComponent(resetSingleHealthMatch[2]);
        return await providerApi.handleResetSingleProviderHealth(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Perform health check for all providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'health-check' as UUID
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        const providerType = decodeURIComponent(healthCheckMatch[1]);
        return await providerApi.handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Delete all unhealthy providers for a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'delete-unhealthy' as UUID
    const deleteUnhealthyMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/delete-unhealthy$/);
    if (method === 'DELETE' && deleteUnhealthyMatch) {
        const providerType = decodeURIComponent(deleteUnhealthyMatch[1]);
        return await providerApi.handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Refresh UUIDs for all unhealthy providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'refresh-unhealthy-uuids' as UUID
    const refreshUnhealthyUuidsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/refresh-unhealthy-uuids$/);
    if (method === 'POST' && refreshUnhealthyUuidsMatch) {
        const providerType = decodeURIComponent(refreshUnhealthyUuidsMatch[1]);
        return await providerApi.handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Batch update check model name for a provider type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching as UUID
    const batchCheckModelMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/batch-check-model-name$/);
    if (method === 'POST' && batchCheckModelMatch) {
        const providerType = decodeURIComponent(batchCheckModelMatch[1]);
        return await providerApi.handleBatchUpdateCheckModelName(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Batch extract emails from accessToken for a provider type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching as UUID
    const batchExtractEmailsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/batch-extract-emails$/);
    if (method === 'POST' && batchExtractEmailsMatch) {
        const providerType = decodeURIComponent(batchExtractEmailsMatch[1]);
        return await providerApi.handleBatchExtractEmails(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Batch move selected providers to another pool
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching as UUID
    const batchMoveProvidersMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/batch-move-pool$/);
    if (method === 'POST' && batchMoveProvidersMatch) {
        const providerType = decodeURIComponent(batchMoveProvidersMatch[1]);
        return await providerApi.handleBatchMoveProviders(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Get all matched provider UUIDs by current filter (cross-page selection)
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching as UUID
    const providerUuidsByFilterMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/uuids-by-filter$/);
    if (method === 'GET' && providerUuidsByFilterMatch) {
        const providerType = decodeURIComponent(providerUuidsByFilterMatch[1]);
        return await providerApi.handleGetProviderUuidsByFilter(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Batch delete by filter (cross-page)
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching as UUID
    const batchDeleteByFilterMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/batch-delete-by-filter$/);
    if (method === 'POST' && batchDeleteByFilterMatch) {
        const providerType = decodeURIComponent(batchDeleteByFilterMatch[1]);
        return await providerApi.handleBatchDeleteByFilter(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Provider active users API - 账号当前实时用户
    // 使用 /api/account-users/:uuid 避免与 /api/providers/:type/:uuid 冲突
    const activeUsersMatch = pathParam.match(/^\/api\/account-users\/([^\/]+)$/);
    if (method === 'GET' && activeUsersMatch) {
        return await providerApi.handleGetProviderActiveUsers(req, res, activeUsersMatch[1]);
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];
        return await providerApi.handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action);
    }

    // Refresh UUID for specific provider configuration
    const refreshUuidMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-uuid$/);
    if (method === 'POST' && refreshUuidMatch) {
        const providerType = decodeURIComponent(refreshUuidMatch[1]);
        const providerUuid = refreshUuidMatch[2];
        return await providerApi.handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Refresh Token for specific provider configuration
    const refreshTokenMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-token$/);
    if (method === 'POST' && refreshTokenMatch) {
        const providerType = decodeURIComponent(refreshTokenMatch[1]);
        const providerUuid = refreshTokenMatch[2];
        return await providerApi.handleRefreshProviderToken(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Hard delete specific provider configuration
    const hardDeleteProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/hard-delete$/);
    if (method === 'DELETE' && hardDeleteProviderMatch) {
        const providerType = decodeURIComponent(hardDeleteProviderMatch[1]);
        const providerUuid = hardDeleteProviderMatch[2];
        return await providerApi.handleHardDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Update specific provider configuration
    // NOTE: This generic route must be after all specific routes like /reset-health, /health-check, /delete-unhealthy
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
        return await oauthApi.handleGenerateAuthUrl(req, res, currentConfig, providerType);
    }

    // Handle manual OAuth callback
    if (method === 'POST' && pathParam === '/api/oauth/manual-callback') {
        return await oauthApi.handleManualOAuthCallback(req, res);
    }

    // Codex 外部手动回调 API（供注册机调用，无需登录）
    if ((method === 'POST' || method === 'OPTIONS') && pathParam === '/api/codex/external-callback') {
        return await oauthApi.handleExternalCodexCallback(req, res);
    }

    // Codex 批量授权 API
    if (method === 'POST' && pathParam === '/api/codex/batch-auth/start') {
        return await oauthApi.handleCodexBatchStart(req, res, currentConfig);
    }
    if (method === 'POST' && pathParam === '/api/codex/batch-auth/stop') {
        return await oauthApi.handleCodexBatchStop(req, res);
    }
    if (method === 'GET' && pathParam === '/api/codex/batch-auth/status') {
        return await oauthApi.handleCodexBatchStatus(req, res);
    }

    // Codex AnyRegister JSON 导入
    if (method === 'POST' && pathParam === '/api/codex/import-anyregister-json') {
        return await oauthApi.handleImportCodexAnyRegisterJson(req, res);
    }

    if (method === 'POST' && pathParam === '/api/xai/import-credentials') {
        return await oauthApi.handleImportXaiCredentials(req, res);
    }

    if (method === 'POST' && pathParam === '/api/xai/cancel-polling') {
        return await oauthApi.handleCancelXaiPolling(req, res);
    }

    if (method === 'POST' && pathParam === '/api/xai/registration/start') {
        return await xaiRegistrationApi.handleStartXaiRegistration(req, res);
    }

    if (method === 'GET' && pathParam === '/api/xai/registration/status') {
        return await xaiRegistrationApi.handleGetXaiRegistrationStatus(req, res);
    }

    if (method === 'POST' && pathParam === '/api/xai/registration/stop') {
        return await xaiRegistrationApi.handleStopXaiRegistration(req, res);
    }

    const xaiRegistrationArtifactsMatch = pathParam.match(/^\/api\/xai\/registration\/tasks\/([^/]+)\/artifacts$/);
    if (method === 'GET' && xaiRegistrationArtifactsMatch) {
        return await xaiRegistrationApi.handleDownloadXaiRegistrationArtifacts(
            req,
            res,
            decodeURIComponent(xaiRegistrationArtifactsMatch[1])
        );
    }

    const xaiRegistrationTaskMatch = pathParam.match(/^\/api\/xai\/registration\/tasks\/([^/]+)$/);
    if (method === 'GET' && xaiRegistrationTaskMatch) {
        return await xaiRegistrationApi.handleGetXaiRegistrationTask(
            req,
            res,
            decodeURIComponent(xaiRegistrationTaskMatch[1])
        );
    }

    // Sync antigravity credentials between gemini-antigravity and claude-antigravity
    if (method === 'POST' && pathParam === '/api/oauth/sync-antigravity') {
        return await oauthApi.handleSyncAntigravityCredentials(req, res);
    }

    // Get OAuth credential by ID
    const oauthCredentialMatch = pathParam.match(/^\/api\/oauth-credentials\/(\d+)$/);
    if (method === 'GET' && oauthCredentialMatch) {
        const credentialId = Number(oauthCredentialMatch[1]);
        return await oauthApi.handleGetOAuthCredential(req, res, credentialId);
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        return await handleEvents(req, res);
    }

    // Quick link config to corresponding provider based on directory
    if (method === 'POST' && pathParam === '/api/quick-link-provider') {
        return await providerApi.handleQuickLinkProvider(req, res, currentConfig, providerPoolManager);
    }

    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        return await usageApi.handleGetUsage(req, res, currentConfig, providerPoolManager);
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        return await usageApi.handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        return await configApi.handleReloadConfig(req, res, providerPoolManager);
    }

    // Restart service (worker process)
    if (method === 'POST' && pathParam === '/api/restart-service') {
        return await systemApi.handleRestartService(req, res);
    }

    // Get service mode information
    if (method === 'GET' && pathParam === '/api/service-mode') {
        return await systemApi.handleGetServiceMode(req, res);
    }

    // Batch import Kiro refresh tokens with SSE (real-time progress)
    if (method === 'POST' && pathParam === '/api/kiro/batch-import-tokens') {
        return await oauthApi.handleBatchImportKiroTokens(req, res);
    }

    // Batch import Warp refresh tokens with SSE (real-time progress)
    if (method === 'POST' && pathParam === '/api/warp/batch-import-tokens') {
        return await oauthApi.handleBatchImportWarpTokens(req, res);
    }

    // Batch import Droid refresh tokens with SSE (real-time progress)
    if (method === 'POST' && pathParam === '/api/droid/batch-import-tokens') {
        return await oauthApi.handleBatchImportDroidTokens(req, res);
    }

    // Import AWS SSO credentials for Kiro
    if (method === 'POST' && pathParam === '/api/kiro/import-aws-credentials') {
        return await oauthApi.handleImportAwsCredentials(req, res);
    }

    // Batch import AWS credentials for Kiro (amazonq_accounts.txt format)
    if (method === 'POST' && pathParam === '/api/kiro/batch-import-aws-credentials') {
        return await oauthApi.handleBatchImportAwsCredentials(req, res);
    }

    // Import single Droid refresh token
    if (method === 'POST' && pathParam === '/api/droid/import-token') {
        return await oauthApi.handleImportDroidToken(req, res);
    }

    // Import single Warp refresh token
    if (method === 'POST' && pathParam === '/api/warp/import-token') {
        return await oauthApi.handleImportWarpToken(req, res);
    }

    // Import Orchids token
    if (method === 'POST' && pathParam === '/api/orchids/import-token') {
        return await oauthApi.handleImportOrchidsToken(req, res);
    }

    if (method === 'POST' && pathParam === '/api/ami/import-token') {
        return await oauthApi.handleImportAmiToken(req, res);
    }

    if (method === 'POST' && pathParam === '/api/claude-offical/cookie-oauth') {
        return await oauthApi.handleClaudeOfficialCookieAuth(req, res, currentConfig);
    }

    // Email management routes
    if (pathParam.startsWith('/api/emails')) {
        return await emailRouter(method, pathParam, req, res);
    }

    // Bad accounts API routes
    if (method === 'GET' && pathParam === '/api/bad-accounts') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await badAccountsApi.handleGetBadAccounts(req, res);
    }
    if (method === 'GET' && pathParam === '/api/bad-accounts/summary') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await badAccountsApi.handleGetBadAccountsSummary(req, res);
    }
    if (method === 'POST' && pathParam === '/api/bad-accounts') {
        return await badAccountsApi.handleCreateBadAccount(req, res);
    }
    if (method === 'POST' && pathParam === '/api/bad-accounts/batch-delete') {
        return await badAccountsApi.handleBatchDeleteBadAccounts(req, res);
    }
    if (method === 'DELETE' && pathParam === '/api/bad-accounts/clear') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await badAccountsApi.handleClearBadAccounts(req, res);
    }
    const badAccountIdMatch = pathParam.match(/^\/api\/bad-accounts\/(\d+)$/);
    if (method === 'DELETE' && badAccountIdMatch) {
        req.params = { id: badAccountIdMatch[1] };
        return await badAccountsApi.handleDeleteBadAccount(req, res);
    }

    // Provider error logs API
    const errorLogsMatch = pathParam.match(/^\/api\/providers\/([^/]+)\/error-logs$/);
    if (method === 'GET' && errorLogsMatch) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        req.params = { uuid: errorLogsMatch[1] };
        return await providerApi.handleGetProviderErrorLogs(req, res);
    }

    // Provider status logs API
    const statusLogsMatch = pathParam.match(/^\/api\/providers\/([^/]+)\/status-logs$/);
    if (method === 'GET' && statusLogsMatch) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        req.params = { uuid: statusLogsMatch[1] };
        return await providerApi.handleGetProviderStatusLogs(req, res);
    }

    // Request logs API - 账号请求日志
    const providerRequestLogsMatch = pathParam.match(/^\/api\/providers\/([^/]+)\/request-logs$/);
    if (method === 'GET' && providerRequestLogsMatch) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        req.params = { uuid: providerRequestLogsMatch[1] };
        return await requestLogsApi.handleGetProviderRequestLogs(req, res);
    }
    if (method === 'DELETE' && providerRequestLogsMatch) {
        req.params = { uuid: providerRequestLogsMatch[1] };
        return await requestLogsApi.handleClearProviderRequestLogs(req, res);
    }

    // Request logs API - 池子请求日志
    if (method === 'GET' && pathParam === '/api/request-logs') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await requestLogsApi.handleGetPoolRequestLogs(req, res);
    }
    if (method === 'DELETE' && pathParam === '/api/request-logs/clear') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await requestLogsApi.handleClearPoolRequestLogs(req, res);
    }

    // Get token stats for a specific provider
    const tokenStatsProviderMatch = pathParam.match(/^\/api\/token-stats\/provider\/([^/]+)$/);
    if (method === 'GET' && tokenStatsProviderMatch) {
        const providerUuid = decodeURIComponent(tokenStatsProviderMatch[1]);
        req.params = { uuid: providerUuid };
        return await tokenStatsApi.getProviderTokenStats(req, res);
    }

    // Get top providers by token usage
    if (method === 'GET' && pathParam === '/api/token-stats/top') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams);
        return await tokenStatsApi.getTopProviders(req, res);
    }

    // Rebuild token stats (admin only)
    if (method === 'POST' && pathParam === '/api/token-stats/rebuild') {
        return await tokenStatsApi.rebuildStats(req, res);
    }

    // Initialize token stats table
    if (method === 'POST' && pathParam === '/api/token-stats/init') {
        return await tokenStatsApi.initializeTable(req, res);
    }

    return false;
}
