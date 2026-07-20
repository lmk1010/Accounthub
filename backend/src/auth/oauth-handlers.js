import { OAuth2Client } from 'google-auth-library';
import http from 'http';
import crypto from 'crypto';
import open from 'open';
import os from 'os';
import axios from 'axios';
import { broadcastEvent } from '../services/ui-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { configureAxiosProxy, getGoogleAuthProxyConfig, getProxyConfigForProvider } from '../utils/proxy-utils.js';
import * as providerDao from '../dao/provider-dao.js';
import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import * as oauthStateDao from '../dao/oauth-state-dao.js';
import * as providerPoolDao from '../dao/provider-pool-dao.js';
import { formatOAuthCredentialRef } from '../utils/oauth-credentials.js';
import { createProviderConfig, generateUUID, PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { formatCodexPlanTitle as formatNormalizedCodexPlanTitle } from '../utils/codex-plan.js';
import * as appMetaDao from '../dao/app-meta-dao.js';

async function resolveImportPoolId(providerType, rawPoolId) {
    if (rawPoolId === null || rawPoolId === undefined || rawPoolId === '') {
        return null;
    }

    const normalizedPoolId = Number.parseInt(rawPoolId, 10);
    if (!Number.isFinite(normalizedPoolId)) {
        return null;
    }

    if (normalizedPoolId > 0) {
        return normalizedPoolId;
    }

    if (normalizedPoolId !== 0 || !providerType) {
        return null;
    }

    const pools = await providerPoolDao.findByType(providerType);
    const defaultPool = Array.isArray(pools) ? pools.find(pool => pool.is_default || pool.isDefault) : null;
    const defaultPoolId = Number.parseInt(defaultPool?.id, 10);
    return Number.isFinite(defaultPoolId) && defaultPoolId > 0 ? defaultPoolId : null;
}

/**
 * 获取 Google 用户信息（邮箱）
 * @param {string} accessToken - 访问令牌
 * @returns {Promise<{email: string, name: string}|null>}
 */
async function getGoogleUserInfo(accessToken) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return { email: data.email, name: data.name };
    } catch (error) {
        console.error('[OAuth] 获取用户信息失败:', error.message);
        return null;
    }
}

/**
 * 获取 Antigravity 订阅等级
 * @param {string} accessToken - 访问令牌
 * @returns {Promise<string>} 订阅等级 FREE/PRO/ULTRA
 */
async function getAntigravitySubscriptionTier(accessToken) {
    const baseURLs = [
        'https://daily-cloudcode-pa.sandbox.googleapis.com',
        'https://daily-cloudcode-pa.googleapis.com'
    ];
    for (const baseURL of baseURLs) {
        try {
            const response = await fetch(`${baseURL}/v1internal:fetchAvailableModels`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ project: '' })
            });
            if (!response.ok) continue;
            const data = await response.json();
            const tier = data.subscriptionTier || data.subscription_tier || data.tier || 'FREE';
            console.log(`[OAuth] 获取订阅等级成功: ${tier}`);
            return tier;
        } catch (error) {
            continue;
        }
    }
    return 'FREE';
}

/**
 * 自动检测 OAuth 回调地址的主机名
 * 优先级：
 * 1. 配置文件中的 OAUTH_CALLBACK_HOST
 * 2. 环境变量 OAUTH_CALLBACK_HOST
 * 3. 自动检测服务器的局域网 IP
 * 4. 回退到 localhost
 *
 * @param {Object} currentConfig - 当前配置对象
 * @param {string} [overrideHost] - 可选的覆盖主机地址（用户在前端输入）
 * @returns {string} 回调主机地址
 */
function getOAuthCallbackHost(currentConfig, overrideHost) {
    // 0. 最高优先级：用户在前端输入的 host
    if (overrideHost && overrideHost.trim()) {
        console.log(`[OAuth] 使用用户指定的回调地址: ${overrideHost}`);
        return overrideHost.trim();
    }

    // 1. 优先使用配置文件中的设置
    if (currentConfig.OAUTH_CALLBACK_HOST) {
        return currentConfig.OAUTH_CALLBACK_HOST;
    }

    // 2. 检查环境变量
    if (process.env.OAUTH_CALLBACK_HOST) {
        return process.env.OAUTH_CALLBACK_HOST;
    }

    // 3. 默认使用 localhost
    return 'localhost';
}

/**
 * 获取 OAuth 回调地址的协议
 * @param {Object} currentConfig - 当前配置对象
 * @param {string} [overrideScheme] - 覆盖协议
 * @returns {string} 协议 (http/https)
 */
function getOAuthCallbackScheme(currentConfig, overrideScheme) {
    const candidates = [
        overrideScheme,
        currentConfig?.OAUTH_CALLBACK_SCHEME,
        process.env.OAUTH_CALLBACK_SCHEME
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const value = String(candidate).trim().replace(/:$/, '');
        if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') {
            continue;
        }
        return value;
    }
    return 'http';
}

/**
 * 获取 OAuth 回调地址的端口（用于重定向地址）
 * @param {Object} currentConfig - 当前配置对象
 * @param {string|number} [overridePort] - 覆盖端口
 * @returns {number|null} 端口号或 null
 */
function getOAuthCallbackPort(currentConfig, overridePort) {
    const candidates = [
        overridePort,
        currentConfig?.OAUTH_CALLBACK_PORT,
        process.env.OAUTH_CALLBACK_PORT
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const raw = String(candidate).trim();
        if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') continue;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function buildOAuthRedirectUri({ scheme, host, port, path }) {
    const normalizedScheme = (scheme ? String(scheme) : 'http').trim().replace(/:$/, '') || 'http';
    const normalizedHost = String(host || '').trim();
    const normalizedPath = path && String(path).trim() ? String(path).trim() : '/';
    const normalizedPort = Number.isFinite(port) ? port : null;
    const isDefaultPort = (normalizedScheme === 'http' && normalizedPort === 80) ||
        (normalizedScheme === 'https' && normalizedPort === 443);
    const origin = normalizedPort && !isDefaultPort
        ? `${normalizedScheme}://${normalizedHost}:${normalizedPort}`
        : `${normalizedScheme}://${normalizedHost}`;
    const pathWithSlash = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
    return `${origin}${pathWithSlash}`;
}

/**
 * OAuth 提供商配置
 */
const OAUTH_PROVIDERS = {
    'gemini-cli-oauth': {
        clientId: process.env.GEMINI_OAUTH_CLIENT_ID || '',
        clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET || '',
        port: 8085,
        credentialsDir: '.gemini',
        credentialsFile: 'oauth_creds.json',
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        logPrefix: '[Gemini Auth]'
    },
    'gemini-antigravity': {
        clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_ID || '',
        clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_SECRET || '',
        port: 8086,
        credentialsDir: '.antigravity',
        credentialsFile: 'oauth_creds.json',
        scope: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/cclog',
            'https://www.googleapis.com/auth/experimentsandconfigs'
        ],
        prompt: 'consent',
        includeGrantedScopes: true,
        logPrefix: '[Antigravity Auth]'
    }
};

/**
 * 活动的服务器实例管理
 */
const activeServers = new Map();

/**
 * 活动的轮询任务管理
 */
const activePollingTasks = new Map();

/**
 * Qwen OAuth 配置
 */
const QWEN_OAUTH_CONFIG = {
    clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
    scope: 'openid profile email model.completion',
    deviceCodeEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    credentialsDir: '.qwen',
    credentialsFile: 'oauth_creds.json',
    logPrefix: '[Qwen Auth]'
};

/**
 * Kiro OAuth 配置（支持多种认证方式）
 */
const KIRO_OAUTH_CONFIG = {
    // Kiro Auth Service 端点 (用于 Social Auth)
    authServiceEndpoint: 'https://prod.us-east-1.auth.desktop.kiro.dev',
    
    // AWS SSO OIDC 端点 (用于 Builder ID)
    ssoOIDCEndpoint: 'https://oidc.{{region}}.amazonaws.com',
    
    // AWS Builder ID 起始 URL
    builderIDStartURL: 'https://view.awsapps.com/start',
    
    // 本地回调端口范围（用于 Social Auth HTTP 回调）
    callbackPortStart: 19876,
    callbackPortEnd: 19880,
    
    // 超时配置
    authTimeout: 10 * 60 * 1000,  // 10 分钟
    pollInterval: 5000,           // 5 秒
    
    // CodeWhisperer Scopes
    scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
    ],
    
    // 凭据存储（符合现有规范）
    credentialsDir: '.kiro',
    credentialsFile: 'oauth_creds.json',
    
    // 日志前缀
    logPrefix: '[Kiro Auth]'
};

const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';

function getKiroSsoOidcHeaders(region = 'us-east-1', maxAttempts = 4) {
    const platform = os.platform();
    const release = os.release();
    const osName = platform === 'win32'
        ? `windows#${release}`
        : platform === 'darwin'
            ? `macos#${release}`
            : `${platform}#${release}`;
    const nodeVersion = process.version.replace(/^v/, '');

    return {
        'Content-Type': 'application/json',
        'x-amz-user-agent': 'aws-sdk-js/3.980.0 KiroIDE',
        'user-agent': `aws-sdk-js/3.980.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/sso-oidc#3.980.0 m/E KiroIDE`,
        'host': `oidc.${region}.amazonaws.com`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': `attempt=1; max=${maxAttempts}`,
        'Connection': 'close'
    };
}

/**
 * Warp OAuth 配置
 */
const WARP_OAUTH_CONFIG = {
    tokenEndpoint: 'https://app.warp.dev/proxy/token',
    apiKey: 'AIzaSyBdy3O3S9hrdayLJxJ7mriBR4qgUaUygAs',
    logPrefix: '[Warp Auth]'
};

/**
 * iFlow OAuth 配置
 */
const IFLOW_OAUTH_CONFIG = {
    // OAuth 端点
    tokenEndpoint: 'https://iflow.cn/oauth/token',
    authorizeEndpoint: 'https://iflow.cn/oauth',
    userInfoEndpoint: 'https://iflow.cn/api/oauth/getUserInfo',
    successRedirectURL: 'https://iflow.cn/oauth/success',
    
    // 客户端凭据
    clientId: '10009311001',
    clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
    
    // 本地回调端口
    callbackPort: 8087,
    
    // 凭据存储
    credentialsDir: '.iflow',
    credentialsFile: 'oauth_creds.json',
    
    // 日志前缀
    logPrefix: '[iFlow Auth]'
};

/**
 * OpenAI Codex OAuth 配置
 */
const CODEX_OAUTH_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    callbackPort: 1455,
    scope: 'openid profile email offline_access',
    logPrefix: '[Codex Auth]'
};

/**
 * Claude Official OAuth 配置
 */
const CLAUDE_OFFICIAL_OAUTH_CONFIG = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeEndpoint: 'https://claude.ai/oauth/authorize',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
    profileEndpoint: 'https://api.anthropic.com/api/oauth/profile',
    usageEndpoint: 'https://api.anthropic.com/api/oauth/usage',
    cookieOrganizationsEndpoint: 'https://claude.ai/api/organizations',
    cookieAuthorizeEndpointTemplate: 'https://claude.ai/v1/oauth/{organization_uuid}/authorize',
    cookieRedirectUri: 'https://platform.claude.com/oauth/code/callback',
    redirectPath: '/auth/callback',
    callbackPort: 1457,
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code',
    betaHeader: 'oauth-2025-04-20',
    logPrefix: '[Claude Official OAuth]'
};

/**
 * 活动的 iFlow 回调服务器管理
 */
const activeIFlowServers = new Map();

/**
 * 活动的 Codex 回调服务器管理
 */
const activeCodexServers = new Map();

/**
 * 活动的 Kiro 回调服务器管理
 */
const activeKiroServers = new Map();
const activeKiroSocialStates = new Map();
const activeKiroBuilderCodeStates = new Map();

/**
 * 活动的 Claude Official 回调服务器管理
 */
const activeClaudeOfficialServers = new Map();

/**
 * 活动的 Kiro 轮询任务管理（用于 Builder ID Device Code）
 */
const activeKiroPollingTasks = new Map();

/**
 * 创建带代理支持的 fetch 请求
 * @param {string} url - 请求 URL
 * @param {Object} options - fetch 选项
 * @param {string} providerType - 提供商类型，用于获取代理配置
 * @returns {Promise<Response>}
 */
async function fetchWithProxy(url, options = {}, providerType) {
    const proxyConfig = getProxyConfigForProvider(CONFIG, providerType);

    if (proxyConfig) {
        const axiosConfig = configureAxiosProxy({
            url,
            method: options.method || 'GET',
            headers: options.headers,
            data: options.body,
            responseType: 'arraybuffer',
            validateStatus: () => true
        }, CONFIG, providerType);

        const response = await axios(axiosConfig);
        return new Response(response.data, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }

    return fetch(url, options);
}

/**
 * 生成 HTML 响应页面
 * @param {boolean} isSuccess - 是否成功
 * @param {string} message - 显示消息
 * @returns {string} HTML 内容
 */
function generateResponsePage(isSuccess, message) {
    const title = isSuccess ? '授权成功！' : '授权失败';
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
}

/**
 * 关闭指定端口的活动服务器
 * @param {number} port - 端口号
 * @returns {Promise<void>}
 */
async function closeActiveServer(provider, port = null) {
    // 1. 关闭该提供商之前的所有服务器
    const existing = activeServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeServers.delete(provider);
                console.log(`[OAuth] 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    // 2. 如果指定了端口，检查是否有其他提供商占用了该端口
    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeServers.delete(p);
                        console.log(`[OAuth] 已关闭端口 ${port} 上被占用（提供商: ${p}）的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * 创建 OAuth 回调服务器
 * @param {Object} config - OAuth 提供商配置
 * @param {string} redirectUri - 重定向 URI
 * @param {OAuth2Client} authClient - OAuth2 客户端
 * @param {string} credPath - 凭据保存路径
 * @param {string} provider - 提供商标识
 * @returns {Promise<http.Server>} HTTP 服务器实例
 */
async function createOAuthCallbackServer(config, redirectUri, authClient, provider, options = {}) {
    const port = parseInt(options.port) || config.port;
    // 实际存储凭证的 provider_type（支持 claude-antigravity 等透传）
    const storageProvider = options.actualProviderType || provider;

    const resolveClaudeAntigravityDisplayName = (displayName, userEmail) => {
        const candidate = typeof displayName === 'string' ? displayName.trim() : '';
        if (candidate) return candidate;
        const fallback = typeof userEmail === 'string' ? userEmail.trim() : '';
        return fallback || null;
    };

    const syncClaudeAntigravityProviderIdentity = async (credentialId, identityName) => {
        if (!credentialId || !identityName) return;
        const providers = await providerDao.findAll('claude-antigravity', { includeDeleted: true });
        const linkedProviders = providers.filter(p => Number(p.oauth_credential_id) === Number(credentialId));
        for (const linkedProvider of linkedProviders) {
            const currentCredentials = linkedProvider?.credentials && typeof linkedProvider.credentials === 'object'
                ? linkedProvider.credentials
                : {};
            const nextCredentials = {
                ...currentCredentials,
                email: identityName,
                customName: identityName
            };
            await providerDao.update(linkedProvider.uuid, {
                custom_name: identityName,
                credentials: nextCredentials
            });
        }
    };

    // 先关闭该提供商之前可能运行的所有服务器，或该端口上的旧服务器
    await closeActiveServer(provider, port);
    
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, redirectUri);
                const code = url.searchParams.get('code');
                const errorParam = url.searchParams.get('error');
                
                if (code) {
                    console.log(`${config.logPrefix} 收到来自 Google 的成功回调: ${req.url}`);

                    try {
                        const { tokens } = await authClient.getToken(code);

                        // 获取用户邮箱信息
                        const userInfo = await getGoogleUserInfo(tokens.access_token);
                        const userEmail = userInfo?.email || null;

                        // 获取订阅等级（仅 Antigravity 系列）
                        let subscriptionTier = null;
                        if (storageProvider === 'gemini-antigravity' || storageProvider === 'claude-antigravity') {
                            subscriptionTier = await getAntigravitySubscriptionTier(tokens.access_token);
                        }

                        // 检查是否已存在相同邮箱的凭据（按实际存储类型查找）
                        if (userEmail) {
                            let existingCredential = await oauthCredentialsDao.findByEmail(storageProvider, userEmail);
                            if (!existingCredential && storageProvider === 'claude-antigravity') {
                                existingCredential = await oauthCredentialsDao.findByDisplayName(storageProvider, userEmail);
                            }
                            if (existingCredential) {
                                console.log(`${config.logPrefix} 账号已存在(${storageProvider}): ${userEmail}, 更新令牌`);
                                await oauthCredentialsDao.updateCredentials(existingCredential.id, tokens);

                                if (storageProvider === 'claude-antigravity') {
                                    const identityName = resolveClaudeAntigravityDisplayName(options.displayName, userEmail);
                                    if (identityName) {
                                        try {
                                            if ((existingCredential.email || '').trim() !== identityName) {
                                                await oauthCredentialsDao.updateEmail(existingCredential.id, identityName);
                                            }
                                            await syncClaudeAntigravityProviderIdentity(existingCredential.id, identityName);
                                        } catch (syncErr) {
                                            console.warn(`${config.logPrefix} 同步 claude-antigravity 显示名称失败: ${syncErr.message}`);
                                        }
                                    }
                                }

                                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                                res.end(generateResponsePage(true, `账号 ${userEmail} 已存在，令牌已更新`));
                                return;
                            }
                        }

                        const normalizedPoolId = await resolveImportPoolId(storageProvider, options.poolId);
                        const antigravityDisplayName = storageProvider === 'claude-antigravity'
                            ? resolveClaudeAntigravityDisplayName(options.displayName, userEmail)
                            : null;

                        const savedCredential = await oauthCredentialsDao.create({
                            provider_type: storageProvider,
                            credential_type: 'oauth',
                            credentials: tokens,
                            display_name: antigravityDisplayName || options.displayName || userEmail || null,
                            email: antigravityDisplayName || userEmail,
                            subscription_tier: subscriptionTier,
                            pool_id: normalizedPoolId,
                            source: 'oauth',
                            is_used: true,
                            metadata: {
                                authMethod: options.authMethod || null,
                                providerDir: options.providerDir || null
                            }
                        });
                        const credentialRef = formatOAuthCredentialRef(storageProvider, savedCredential.id);
                        console.log(`${config.logPrefix} 新令牌已接收并保存到数据库(${storageProvider}): ${credentialRef}`);

                        // 直接创建 provider 并 markUsed，不走 autoLink
                        const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === storageProvider || m.credentialProviderType === storageProvider);
                        if (mapping) {
                            const providerConfig = createProviderConfig({
                                credPathKey: mapping.credPathKey,
                                credPath: credentialRef,
                                credentialId: savedCredential.id,
                                defaultCheckModel: mapping.defaultCheckModel,
                                needsProjectId: mapping.needsProjectId || false,
                                urlKeys: mapping.urlKeys
                            });

                            if (storageProvider === 'claude-antigravity' && antigravityDisplayName) {
                                providerConfig.email = antigravityDisplayName;
                                providerConfig.customName = antigravityDisplayName;
                            }

                            await providerDao.create({
                                uuid: providerConfig.uuid,
                                provider_type: storageProvider,
                                pool_id: normalizedPoolId,
                                oauth_credential_id: savedCredential.id,
                                custom_name: (storageProvider === 'claude-antigravity' ? antigravityDisplayName : null),
                                credentials: providerConfig,
                                is_healthy: true,
                                is_disabled: false,
                                check_health: true,
                                check_model_name: providerConfig.checkModelName || mapping.defaultCheckModel
                            });
                            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                            console.log(`${config.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
                        }

                        // 广播授权成功事件
                        broadcastEvent('oauth_success', {
                            provider: storageProvider,
                            credentialId: savedCredential.id,
                            credentialRef: credentialRef,
                            relativePath: credentialRef,
                            timestamp: new Date().toISOString()
                        });

                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(true, '您可以关闭此页面'));
                    } catch (tokenError) {
                        console.error(`${config.logPrefix} 获取令牌失败:`, tokenError);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `获取令牌失败: ${tokenError.message}`));
                    } finally {
                        server.close(() => {
                            activeServers.delete(provider);
                        });
                    }
                } else if (errorParam) {
                    const errorMessage = `授权失败。Google 返回错误: ${errorParam}`;
                    console.error(`${config.logPrefix}`, errorMessage);
                    
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, errorMessage));
                    server.close(() => {
                        activeServers.delete(provider);
                    });
                } else {
                    console.log(`${config.logPrefix} 忽略无关请求: ${req.url}`);
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error(`${config.logPrefix} 处理回调时出错:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
                
                if (server.listening) {
                    server.close(() => {
                        activeServers.delete(provider);
                    });
                }
            }
        });
        
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`${config.logPrefix} 端口 ${port} 已被占用`);
                reject(new Error(`端口 ${port} 已被占用`));
            } else {
                console.error(`${config.logPrefix} 服务器错误:`, err);
                reject(err);
            }
        });
        
        const host = '0.0.0.0';
        server.listen(port, host, () => {
            console.log(`${config.logPrefix} OAuth 回调服务器已启动于 ${host}:${port}`);
            activeServers.set(provider, { server, port });
            resolve(server);
        });
    });
}

/**
 * 处理 Google OAuth 授权（通用函数）
 * @param {string} providerKey - 提供商键名
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
async function handleGoogleOAuth(providerKey, currentConfig, options = {}) {
    const config = OAUTH_PROVIDERS[providerKey];
    if (!config) {
        throw new Error(`未知的提供商: ${providerKey}`);
    }

    const port = parseInt(options.port) || config.port;
    const host = getOAuthCallbackHost(currentConfig, options.host);
    const redirectUri = `http://${host}:${port}`;

    console.log(`${config.logPrefix} 使用回调地址: ${redirectUri}`);

    // 获取代理配置
    const proxyConfig = getGoogleAuthProxyConfig(currentConfig, providerKey);

    // 构建 OAuth2Client 选项
    const oauth2Options = {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
    };

    if (proxyConfig) {
        oauth2Options.transporterOptions = proxyConfig;
        console.log(`${config.logPrefix} Using proxy for OAuth token exchange`);
    }

    const authClient = new OAuth2Client(oauth2Options);
    authClient.redirectUri = redirectUri;

    // 手动构建 OAuth URL，与参考项目保持一致
    // 避免 google-auth-library 默认使用 firstparty/nativeapp 流程
    const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
    const scopeString = Array.isArray(config.scope) ? config.scope.join(' ') : config.scope;
    const authParams = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopeString,
        access_type: 'offline',
        prompt: config.prompt || 'select_account',
        include_granted_scopes: config.includeGrantedScopes ? 'true' : 'false'
    });
    const authUrl = `${AUTH_URL}?${authParams.toString()}`;
    
    // 启动回调服务器
    try {
        await createOAuthCallbackServer(config, redirectUri, authClient, providerKey, options);
    } catch (error) {
        throw new Error(`启动回调服务器失败: ${error.message}`);
    }
    
    return {
        authUrl,
        authInfo: {
            provider: providerKey,
            redirectUri: redirectUri,
            port: port,
            ...options
        }
    };
}

/**
 * 处理 Gemini CLI OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleGeminiCliOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-cli-oauth', currentConfig, options);
}

/**
 * 处理 Gemini Antigravity OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleGeminiAntigravityOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-antigravity', currentConfig, options);
}

/**
 * 生成 PKCE 代码验证器
 * @returns {string} Base64URL 编码的随机字符串
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * 生成 PKCE 代码挑战
 * @param {string} codeVerifier - 代码验证器
 * @returns {string} Base64URL 编码的 SHA256 哈希
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}

function decodeJwtClaims(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    try {
        const raw = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

function extractCodexAccountId(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const authClaims = claims['https://api.openai.com/auth'];
    if (!authClaims || typeof authClaims !== 'object') return null;
    const accountId = authClaims.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

function extractCodexEmail(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    // 优先从 https://api.openai.com/profile 中提取邮箱
    const profileClaims = claims['https://api.openai.com/profile'];
    if (profileClaims && typeof profileClaims === 'object') {
        const profileEmail = profileClaims.email;
        if (typeof profileEmail === 'string' && profileEmail.trim()) {
            return profileEmail.trim();
        }
    }
    // 回退到顶层 email 字段
    const email = claims.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
}

function extractCodexPlanType(token) {
    const claims = decodeJwtClaims(token);
    if (!claims) return null;
    const authClaims = claims['https://api.openai.com/auth'];
    if (!authClaims || typeof authClaims !== 'object') return null;
    const planType = authClaims.chatgpt_plan_type;
    return typeof planType === 'string' && planType.trim() ? planType.trim() : null;
}

function formatCodexPlanTitle(planType) {
    return formatNormalizedCodexPlanTitle(planType);
}

/**
 * 停止活动的轮询任务
 * @param {string} taskId - 任务标识符
 */
function stopPollingTask(taskId) {
    const task = activePollingTasks.get(taskId);
    if (task) {
        task.shouldStop = true;
        activePollingTasks.delete(taskId);
        console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
    }
}

/**
 * 轮询获取 Qwen OAuth 令牌
 * @param {string} deviceCode - 设备代码
 * @param {string} codeVerifier - PKCE 代码验证器
 * @param {number} interval - 轮询间隔（秒）
 * @param {number} expiresIn - 过期时间（秒）
 * @param {string} taskId - 任务标识符
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回令牌信息
 */
async function pollQwenToken(deviceCode, codeVerifier, interval = 5, expiresIn = 300, taskId = 'default', options = {}) {
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;
    
    // 创建任务控制对象
    const taskControl = { shouldStop: false };
    activePollingTasks.set(taskId, taskControl);
    
    console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 开始轮询令牌 [${taskId}]，间隔 ${interval} 秒，最多尝试 ${maxAttempts} 次`);
    
    const poll = async () => {
        // 检查是否需要停止
        if (taskControl.shouldStop) {
            console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 轮询任务 [${taskId}] 已被停止`);
            throw new Error('轮询任务已被取消');
        }
        
        if (attempts >= maxAttempts) {
            activePollingTasks.delete(taskId);
            throw new Error('授权超时，请重新开始授权流程');
        }
        
        attempts++;
        
        const bodyData = {
            client_id: QWEN_OAUTH_CONFIG.clientId,
            device_code: deviceCode,
            grant_type: QWEN_OAUTH_CONFIG.grantType,
            code_verifier: codeVerifier
        };
        
        const formBody = Object.entries(bodyData)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
        
        try {
            const response = await fetchWithProxy(QWEN_OAUTH_CONFIG.tokenEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: formBody
            }, 'openai-qwen-oauth');
            
            const data = await response.json();
            
            if (response.ok && data.access_token) {
                // 成功获取令牌
                console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 成功获取令牌 [${taskId}]`);
                
                const savedCredential = await oauthCredentialsDao.create({
                    provider_type: 'openai-qwen-oauth',
                    credential_type: 'oauth',
                    credentials: data,
                    display_name: options.displayName || null,
                    source: 'oauth',
                    is_used: true,
                    metadata: {
                        providerDir: options.providerDir || null,
                        taskId: taskId
                    }
                });

                const credentialRef = formatOAuthCredentialRef('openai-qwen-oauth', savedCredential.id);
                console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 令牌已保存到数据库: ${credentialRef}`);

                // 直接创建 provider 并 markUsed
                const qwenMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'openai-qwen-oauth');
                if (qwenMapping) {
                    const normalizedPoolId = await resolveImportPoolId(storageProvider, options.poolId);
                    const providerConfig = createProviderConfig({
                        credPathKey: qwenMapping.credPathKey,
                        credPath: credentialRef,
                        credentialId: savedCredential.id,
                        defaultCheckModel: qwenMapping.defaultCheckModel,
                        needsProjectId: qwenMapping.needsProjectId || false,
                        urlKeys: qwenMapping.urlKeys
                    });
                    await providerDao.create({
                        uuid: providerConfig.uuid,
                        provider_type: 'openai-qwen-oauth',
                        pool_id: normalizedPoolId,
                        oauth_credential_id: savedCredential.id,
                        credentials: providerConfig,
                        is_healthy: true,
                        is_disabled: false,
                        check_health: true,
                        check_model_name: providerConfig.checkModelName || qwenMapping.defaultCheckModel
                    });
                    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                }

                // 清理任务
                activePollingTasks.delete(taskId);

                // 广播授权成功事件
                broadcastEvent('oauth_success', {
                    provider: 'openai-qwen-oauth',
                    credentialId: savedCredential.id,
                    credentialRef: credentialRef,
                    relativePath: credentialRef,
                    timestamp: new Date().toISOString()
                });

                return data;
            }
            
            // 检查错误类型
            if (data.error === 'authorization_pending') {
                // 用户尚未完成授权，继续轮询
                console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 等待用户授权 [${taskId}]... (第 ${attempts}/${maxAttempts} 次尝试)`);
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            } else if (data.error === 'slow_down') {
                // 需要降低轮询频率
                console.log(`${QWEN_OAUTH_CONFIG.logPrefix} 降低轮询频率`);
                await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                return poll();
            } else if (data.error === 'expired_token') {
                activePollingTasks.delete(taskId);
                throw new Error('设备代码已过期，请重新开始授权流程');
            } else if (data.error === 'access_denied') {
                activePollingTasks.delete(taskId);
                throw new Error('用户拒绝了授权请求');
            } else {
                activePollingTasks.delete(taskId);
                throw new Error(`授权失败: ${data.error || '未知错误'}`);
            }
        } catch (error) {
            if (error.message.includes('授权') || error.message.includes('过期') || error.message.includes('拒绝')) {
                throw error;
            }
            console.error(`${QWEN_OAUTH_CONFIG.logPrefix} 轮询出错:`, error);
            // 网络错误，继续重试
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            return poll();
        }
    };
    
    return poll();
}

/**
 * 处理 Qwen OAuth 授权（设备授权流程）
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleQwenOAuth(currentConfig, options = {}) {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    
    const bodyData = {
        client_id: QWEN_OAUTH_CONFIG.clientId,
        scope: QWEN_OAUTH_CONFIG.scope,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    };
    
    const formBody = Object.entries(bodyData)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    
    try {
        const response = await fetchWithProxy(QWEN_OAUTH_CONFIG.deviceCodeEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: formBody
        }, 'openai-qwen-oauth');
        
        if (!response.ok) {
            throw new Error(`Qwen OAuth请求失败: ${response.status} ${response.statusText}`);
        }
        
        const deviceAuth = await response.json();
        
        if (!deviceAuth.device_code || !deviceAuth.verification_uri_complete) {
            throw new Error('Qwen OAuth响应格式错误，缺少必要字段');
        }
        
        // 启动后台轮询获取令牌
        const interval = 5;
        // const expiresIn = deviceAuth.expires_in || 1800;
        const expiresIn = 300;
        
        // 生成唯一的任务ID
        const taskId = `qwen-${deviceAuth.device_code.substring(0, 8)}-${Date.now()}`;
        
        // 先停止之前可能存在的所有 Qwen 轮询任务
        for (const [existingTaskId] of activePollingTasks.entries()) {
            if (existingTaskId.startsWith('qwen-')) {
                stopPollingTask(existingTaskId);
            }
        }
        
        // 不等待轮询完成，立即返回授权信息
        pollQwenToken(deviceAuth.device_code, codeVerifier, interval, expiresIn, taskId, options)
            .catch(error => {
                console.error(`${QWEN_OAUTH_CONFIG.logPrefix} 轮询失败 [${taskId}]:`, error);
                // 广播授权失败事件
                broadcastEvent('oauth_error', {
                    provider: 'openai-qwen-oauth',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            });
        
        return {
            authUrl: deviceAuth.verification_uri_complete,
            authInfo: {
                provider: 'openai-qwen-oauth',
                deviceCode: deviceAuth.device_code,
                userCode: deviceAuth.user_code,
                verificationUri: deviceAuth.verification_uri,
                verificationUriComplete: deviceAuth.verification_uri_complete,
                expiresIn: expiresIn,
                interval: interval,
                codeVerifier: codeVerifier
            }
        };
    } catch (error) {
        console.error(`${QWEN_OAUTH_CONFIG.logPrefix} 请求失败:`, error);
        throw new Error(`Qwen OAuth 授权失败: ${error.message}`);
    }
}

/**
 * 处理 Kiro OAuth 授权（统一入口）
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 *   - method: 'google' | 'github' | 'builder-id'
 *   - saveToConfigs: boolean
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleKiroOAuth(currentConfig, options = {}) {
    const method = options.method || options.authMethod || 'google';  // 默认使用 Google，同时支持 authMethod 参数
    
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Starting OAuth with method: ${method}`);
    
    switch (method) {
        case 'google':
            return handleKiroSocialAuth('Google', currentConfig, options);
        case 'github':
            return handleKiroSocialAuth('Github', currentConfig, options);
        case 'builder-id':
        case 'builder-id-code':
            return handleKiroBuilderIDAuthCode(currentConfig, options);
        case 'builder-id-device':
            return handleKiroBuilderIDDeviceCode(currentConfig, options);
        default:
            throw new Error(`不支持的认证方式: ${method}`);
    }
}

/**
 * Kiro Social Auth (Google/GitHub) - 使用 HTTP localhost 回调
 */
async function handleKiroSocialAuth(provider, currentConfig, options = {}) {
    // 生成 PKCE 参数
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('base64url');
    const redirectUri = KIRO_SOCIAL_REDIRECT_URI;

    cleanupExpiredKiroSocialStates();
    activeKiroSocialStates.set(state, {
        codeVerifier,
        options,
        provider,
        createdAt: Date.now()
    });
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 使用 Kiro Social 回调协议: ${redirectUri}`);
    
    // 构建授权 URL
    const authUrl = `${KIRO_OAUTH_CONFIG.authServiceEndpoint}/login?` +
        `idp=${provider}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256&` +
        `state=${state}&` +
        `prompt=select_account`;
    
    return {
        authUrl,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'social',
            socialProvider: provider,
            redirectUri: redirectUri,
            state: state,
            callbackMode: 'manual',
            ...options
        }
    };
}

function cleanupExpiredKiroSocialStates() {
    const maxAgeMs = 10 * 60 * 1000;
    const now = Date.now();
    for (const [state, session] of activeKiroSocialStates.entries()) {
        if (!session?.createdAt || now - session.createdAt > maxAgeMs) {
            activeKiroSocialStates.delete(state);
        }
    }
}

function cleanupExpiredKiroBuilderCodeStates() {
    const maxAgeMs = 10 * 60 * 1000;
    const now = Date.now();
    for (const [state, session] of activeKiroBuilderCodeStates.entries()) {
        if (!session?.createdAt || now - session.createdAt > maxAgeMs) {
            activeKiroBuilderCodeStates.delete(state);
        }
    }
}

async function handleKiroBuilderIDAuthCode(currentConfig, options = {}) {
    const builderIDStartURL = options.builderIDStartURL || KIRO_OAUTH_CONFIG.builderIDStartURL;
    const { endpoint: ssoOIDCEndpoint, region: ssoOIDCRegion } = resolveKiroSsoOidcEndpoint(options);
    const callbackPort = Number.parseInt(options.port || options.callbackPort || KIRO_OAUTH_CONFIG.callbackPortStart, 10) || KIRO_OAUTH_CONFIG.callbackPortStart;
    const redirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('base64url');

    const regResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/client/register`, {
        method: 'POST',
        headers: getKiroSsoOidcHeaders(ssoOIDCRegion, 4),
        body: JSON.stringify({
            clientName: 'Kiro IDE',
            clientType: 'public',
            scopes: KIRO_OAUTH_CONFIG.scopes,
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [redirectUri],
            issuerUrl: builderIDStartURL
        })
    }, 'claude-kiro-oauth');

    if (!regResponse.ok) {
        const regErrBody = await regResponse.text().catch(() => '');
        throw new Error(`Kiro Builder ID 客户端注册失败: ${regResponse.status} ${regErrBody}`);
    }

    const regData = await regResponse.json();
    cleanupExpiredKiroBuilderCodeStates();
    activeKiroBuilderCodeStates.set(state, {
        codeVerifier,
        clientId: regData.clientId,
        clientSecret: regData.clientSecret,
        redirectUri,
        builderIDStartURL,
        ssoOIDCEndpoint,
        ssoOIDCRegion,
        options,
        createdAt: Date.now()
    });

    const authUrl = `${ssoOIDCEndpoint}/authorize?` +
        `response_type=code&client_id=${encodeURIComponent(regData.clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scopes=${encodeURIComponent(KIRO_OAUTH_CONFIG.scopes.join(','))}` +
        `&state=${encodeURIComponent(state)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256`;

    return {
        authUrl,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'builder-id',
            flow: 'authorization-code',
            builderIDStartURL,
            idcRegion: ssoOIDCRegion,
            region: options.region || 'us-east-1',
            port: callbackPort,
            redirectUri,
            state,
            poolId: options.poolId
        }
    };
}

async function exchangeAndSaveKiroSocialCode(code, codeVerifier, options = {}) {
    const tokenResponse = await fetchWithProxy(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'KiroIDE'
        },
        body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            redirect_uri: KIRO_SOCIAL_REDIRECT_URI
        })
    }, 'claude-kiro-oauth');

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Social token exchange failed:`, errorText);
        throw new Error(`获取令牌失败: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const saveData = {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
        authMethod: 'social',
        region: 'us-east-1'
    };

    const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', options.poolId);
    const savedCredential = await oauthCredentialsDao.create({
        provider_type: 'claude-kiro-oauth',
        credential_type: 'oauth',
        credentials: saveData,
        display_name: options.displayName || null,
        pool_id: normalizedPoolId,
        source: 'oauth',
        is_used: true,
        metadata: {
            authMethod: 'social',
            providerDir: options.providerDir || null
        }
    });
    const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);

    if (options.saveToConfigs !== false) {
        const providerConfig = createProviderConfig({
            credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
            credPath: credentialRef,
            credentialId: savedCredential.id,
            defaultCheckModel: 'claude-haiku-4-5',
            needsProjectId: false,
            urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
        });
        await providerDao.create({
            uuid: providerConfig.uuid,
            provider_type: 'claude-kiro-oauth',
            pool_id: normalizedPoolId,
            oauth_credential_id: savedCredential.id,
            credentials: providerConfig,
            is_healthy: true,
            is_disabled: false,
            check_health: true,
            check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
        });
        await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
    }

    broadcastEvent('oauth_success', {
        provider: 'claude-kiro-oauth',
        credentialId: savedCredential.id,
        credentialRef: credentialRef,
        relativePath: credentialRef,
        timestamp: new Date().toISOString()
    });

    return {
        credentialId: savedCredential.id,
        credentialRef,
        relativePath: credentialRef
    };
}

export async function handleKiroSocialManualCallback(callbackUrl) {
    cleanupExpiredKiroSocialStates();
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
        throw new Error('Kiro Google 回调链接必须包含 code 和 state');
    }

    const session = activeKiroSocialStates.get(state);
    if (!session) {
        throw new Error('Kiro Google 回调状态已过期，请重新生成授权链接');
    }

    const result = await exchangeAndSaveKiroSocialCode(code, session.codeVerifier, session.options);
    activeKiroSocialStates.delete(state);
    return result;
}

export async function handleKiroBuilderIDManualCallback(callbackUrl) {
    cleanupExpiredKiroBuilderCodeStates();
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
        throw new Error('Kiro Builder ID 回调链接必须包含 code 和 state');
    }

    const session = activeKiroBuilderCodeStates.get(state);
    if (!session) {
        throw new Error('Kiro Builder ID 回调状态已过期，请重新生成授权链接');
    }

    const tokenResponse = await fetchWithProxy(`${session.ssoOIDCEndpoint}/token`, {
        method: 'POST',
        headers: getKiroSsoOidcHeaders(session.ssoOIDCRegion, 4),
        body: JSON.stringify({
            clientId: session.clientId,
            clientSecret: session.clientSecret,
            grantType: 'authorization_code',
            code,
            codeVerifier: session.codeVerifier,
            redirectUri: session.redirectUri
        })
    }, 'claude-kiro-oauth');

    const rawText = await tokenResponse.text();
    let tokenData = null;
    try {
        tokenData = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
        tokenData = null;
    }
    if (!tokenResponse.ok || !tokenData?.accessToken) {
        const detail = tokenData?.error_description || tokenData?.error || rawText || '未知错误';
        throw new Error(`Kiro Builder ID 授权失败: HTTP ${tokenResponse.status} ${detail}`);
    }

    const options = session.options || {};
    const region = options.region || 'us-east-1';
    const idcRegion = options.idcRegion || options.idc_region || session.ssoOIDCRegion || region;
    const credentialsData = {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
        authMethod: 'builder-id',
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        region,
        idcRegion
    };
    if (tokenData.profileArn) credentialsData.profileArn = tokenData.profileArn;

    const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', options.poolId);
    const savedCredential = await oauthCredentialsDao.create({
        provider_type: 'claude-kiro-oauth',
        credential_type: 'oauth',
        credentials: credentialsData,
        display_name: options.displayName || null,
        pool_id: normalizedPoolId,
        source: 'oauth',
        is_used: true,
        metadata: {
            authMethod: 'builder-id',
            flow: 'authorization-code',
            providerDir: options.providerDir || null
        }
    });
    const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);
    const providerConfig = createProviderConfig({
        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
        credPath: credentialRef,
        credentialId: savedCredential.id,
        defaultCheckModel: 'claude-haiku-4-5',
        needsProjectId: false,
        urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
    });
    await providerDao.create({
        uuid: providerConfig.uuid,
        provider_type: 'claude-kiro-oauth',
        pool_id: normalizedPoolId,
        oauth_credential_id: savedCredential.id,
        credentials: providerConfig,
        is_healthy: true,
        is_disabled: false,
        check_health: true,
        check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
    });
    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
    activeKiroBuilderCodeStates.delete(state);
    broadcastEvent('oauth_success', { provider: 'claude-kiro-oauth', credentialId: savedCredential.id, credentialRef, relativePath: credentialRef, timestamp: new Date().toISOString() });
    return { credentialId: savedCredential.id, credentialRef, relativePath: credentialRef };
}

function resolveKiroSsoOidcEndpoint(options = {}) {
    const region = options.idcRegion || options.idc_region || options.region || 'us-east-1';
    const template = KIRO_OAUTH_CONFIG.ssoOIDCEndpoint;
    const endpoint = template.includes('{{region}}') ? template.replace('{{region}}', region) : template;
    return { endpoint, region };
}

/**
 * Kiro Builder ID - Device Code Flow（类似 Qwen OAuth 模式）
 */
async function handleKiroBuilderIDDeviceCode(currentConfig, options = {}) {
    // 停止之前的轮询任务
    for (const [existingTaskId] of activeKiroPollingTasks.entries()) {
        if (existingTaskId.startsWith('kiro-')) {
            stopKiroPollingTask(existingTaskId);
        }
    }

    // 获取 Builder ID Start URL（优先使用前端传入的值，否则使用默认值）
    const builderIDStartURL = options.builderIDStartURL || KIRO_OAUTH_CONFIG.builderIDStartURL;
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Using Builder ID Start URL: ${builderIDStartURL}`);
    const { endpoint: ssoOIDCEndpoint, region: ssoOIDCRegion } = resolveKiroSsoOidcEndpoint(options);
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Using SSO OIDC Endpoint: ${ssoOIDCEndpoint}`);

    // 1. 注册 OIDC 客户端
    const regResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/client/register`, {
        method: 'POST',
        headers: getKiroSsoOidcHeaders(ssoOIDCRegion, 4),
        body: JSON.stringify({
            clientName: 'Kiro IDE',
            clientType: 'public',
            scopes: KIRO_OAUTH_CONFIG.scopes,
            grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
        })
    }, 'claude-kiro-oauth');
    
    if (!regResponse.ok) {
        const regErrBody = await regResponse.text().catch(() => '');
        throw new Error(`Kiro OAuth 客户端注册失败: ${regResponse.status} ${regErrBody}`);
    }
    
    const regData = await regResponse.json();
    
    // 2. 启动设备授权
    const authResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/device_authorization`, {
        method: 'POST',
        headers: getKiroSsoOidcHeaders(ssoOIDCRegion, 4),
        body: JSON.stringify({
            clientId: regData.clientId,
            clientSecret: regData.clientSecret,
            startUrl: builderIDStartURL
        })
    }, 'claude-kiro-oauth');
    
    if (!authResponse.ok) {
        const authErrBody = await authResponse.text().catch(() => '');
        throw new Error(`Kiro OAuth 设备授权失败: ${authResponse.status} ${authErrBody}`);
    }
    
    const deviceAuth = await authResponse.json();
    
    // 3. 启动后台轮询（类似 Qwen OAuth 的模式）
    const taskId = `kiro-${deviceAuth.deviceCode.substring(0, 8)}-${Date.now()}`;

    
    // 异步轮询
    pollKiroBuilderIDToken(
        regData.clientId,
        regData.clientSecret,
        deviceAuth.deviceCode,
        5,
        300,
        taskId,
        options,
        ssoOIDCEndpoint
    ).catch(error => {
        const errorMessage = error?.message || error?.cause?.message || String(error) || '未知错误';
        const errorStack = error?.stack || '';
        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 轮询失败 [${taskId}]: ${errorMessage}`);
        if (errorStack) {
            console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 错误堆栈:`, errorStack);
        }
        broadcastEvent('oauth_error', {
            provider: 'claude-kiro-oauth',
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
    });
    
    return {
        authUrl: deviceAuth.verificationUriComplete,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'builder-id',
            deviceCode: deviceAuth.deviceCode,
            userCode: deviceAuth.userCode,
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            expiresIn: deviceAuth.expiresIn,
            interval: deviceAuth.interval,
            ...options
        }
    };
}

/**
 * 轮询获取 Kiro Builder ID Token
 */
async function pollKiroBuilderIDToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options = {}, ssoOIDCEndpoint = null) {
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;
    
    const taskControl = { shouldStop: false };
    activeKiroPollingTasks.set(taskId, taskControl);
    
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 开始轮询令牌 [${taskId}]`);
    
    const poll = async () => {
        if (taskControl.shouldStop) {
            throw new Error('轮询任务已被取消');
        }
        
        if (attempts >= maxAttempts) {
            activeKiroPollingTasks.delete(taskId);
            throw new Error('授权超时');
        }
        
        attempts++;
        
        try {
            const { endpoint: defaultEndpoint, region: ssoOIDCRegion } = resolveKiroSsoOidcEndpoint(options);
            const resolvedEndpoint = ssoOIDCEndpoint || defaultEndpoint;
            const response = await fetchWithProxy(`${resolvedEndpoint}/token`, {
                method: 'POST',
                headers: getKiroSsoOidcHeaders(ssoOIDCRegion, 4),
                body: JSON.stringify({
                    clientId,
                    clientSecret,
                    deviceCode,
                    grantType: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            }, 'claude-kiro-oauth');
            const rawText = await response.text();
            let data = null;
            try {
                data = rawText ? JSON.parse(rawText) : null;
            } catch (parseError) {
                data = null;
            }

            // 先检查是否是等待授权状态（HTTP 400 但 error 是 authorization_pending 或 slow_down）
            if (data?.error === 'authorization_pending') {
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 等待用户授权 [${taskId}]... (${attempts}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            }
            if (data?.error === 'slow_down') {
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 请求过快，减速等待 [${taskId}]...`);
                await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                return poll();
            }

            // 其他 HTTP 错误
            if (!response.ok) {
                const errorDetail = data?.error_description || data?.error || rawText || '未知错误';
                activeKiroPollingTasks.delete(taskId);
                throw new Error(`授权失败: HTTP ${response.status} ${errorDetail}`);
            }
            if (!data) {
                activeKiroPollingTasks.delete(taskId);
                throw new Error('授权失败: 无法解析响应');
            }

            if (data.accessToken) {
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 成功获取令牌 [${taskId}]`);
                const region = options.region || 'us-east-1';
                const idcRegion = options.idcRegion || options.idc_region || region;

                const tokenData = {
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
                    authMethod: 'builder-id',
                    clientId,
                    clientSecret,
                    region: region,
                    idcRegion: idcRegion
                };
                if (data.profileArn) {
                    tokenData.profileArn = data.profileArn;
                }

                const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', options.poolId);
                const savedCredential = await oauthCredentialsDao.create({
                    provider_type: 'claude-kiro-oauth',
                    credential_type: 'oauth',
                    credentials: tokenData,
                    display_name: options.displayName || null,
                    pool_id: normalizedPoolId,
                    source: 'oauth',
                    is_used: true,
                    metadata: {
                        providerDir: options.providerDir || null,
                        taskId: taskId
                    }
                });
                const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);

                // 直接创建 provider 并 markUsed
                {
                    const providerConfig = createProviderConfig({
                        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
                        credPath: credentialRef,
                        credentialId: savedCredential.id,
                        defaultCheckModel: 'claude-haiku-4-5',
                        needsProjectId: false,
                        urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
                    });
                    await providerDao.create({
                        uuid: providerConfig.uuid,
                        provider_type: 'claude-kiro-oauth',
                        pool_id: normalizedPoolId,
                        oauth_credential_id: savedCredential.id,
                        credentials: providerConfig,
                        is_healthy: true,
                        is_disabled: false,
                        check_health: true,
                        check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
                    });
                    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
                }

                activeKiroPollingTasks.delete(taskId);

                // 广播成功事件（符合现有规范）
                broadcastEvent('oauth_success', {
                    provider: 'claude-kiro-oauth',
                    credentialId: savedCredential.id,
                    credentialRef: credentialRef,
                    relativePath: credentialRef,
                    timestamp: new Date().toISOString()
                });

                return tokenData;
            }

            // 其他未知错误
            activeKiroPollingTasks.delete(taskId);
            throw new Error(`授权失败: ${data?.error || data?.error_description || '未知错误'}`);
        } catch (error) {
            const message = error?.message || error?.cause?.message || error?.error || (typeof error === 'string' ? error : '');
            console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 轮询请求出错 [${taskId}]: ${message || '未知错误'}`, error?.cause || '');
            if (message.includes('授权') || message.includes('取消')) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            return poll();
        }
    };
    
    return poll();
}

/**
 * 停止 Kiro 轮询任务
 * @param {string} taskId - 任务ID
 * @returns {boolean} 是否成功停止
 */
export function stopKiroPollingTask(taskId) {
    const task = activeKiroPollingTasks.get(taskId);
    if (task) {
        task.shouldStop = true;
        activeKiroPollingTasks.delete(taskId);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
        return true;
    }
    return false;
}

/**
 * 停止所有 Kiro 轮询任务
 * @returns {number} 停止的任务数量
 */
export function stopAllKiroPollingTasks() {
    let count = 0;
    for (const [taskId, task] of activeKiroPollingTasks.entries()) {
        if (taskId.startsWith('kiro-')) {
            task.shouldStop = true;
            activeKiroPollingTasks.delete(taskId);
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
            count++;
        }
    }
    return count;
}

/**
 * 启动 Kiro 回调服务器（用于 Social Auth HTTP 回调）
 */
async function startKiroCallbackServer(codeVerifier, expectedState, options = {}) {
    const portStart = KIRO_OAUTH_CONFIG.callbackPortStart;
    const portEnd = KIRO_OAUTH_CONFIG.callbackPortEnd;
    
    for (let port = portStart; port <= portEnd; port++) {
    // 关闭已存在的服务器
    await closeKiroServer(port);
    
    try {
        const server = await createKiroHttpCallbackServer(port, codeVerifier, expectedState, options);
        activeKiroServers.set('claude-kiro-oauth', { server, port });
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
        return port;
    } catch (err) {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 端口 ${port} 被占用，尝试下一个...`);
    }
    }
    
    throw new Error('所有端口都被占用');
}

/**
 * 关闭 Kiro 服务器
 */
async function closeKiroServer(provider, port = null) {
    const existing = activeKiroServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeKiroServers.delete(provider);
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [p, info] of activeKiroServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeKiroServers.delete(p);
                        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 已关闭端口 ${port} 上的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * 创建 Kiro HTTP 回调服务器
 */
function createKiroHttpCallbackServer(port, codeVerifier, expectedState, options = {}) {
    const host = options.callbackHost || '127.0.0.1';
    const redirectUri = `http://${host}:${port}/oauth/callback`;
    
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                
                if (url.pathname === '/oauth/callback') {
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const errorParam = url.searchParams.get('error');
                    
                    if (errorParam) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                        return;
                    }
                    
                    if (state !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, 'State 验证失败'));
                        return;
                    }
                    
                    // 交换 Code 获取 Token（使用动态的 redirect_uri）
                    const tokenResponse = await fetchWithProxy(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'AccountHub/1.0.0'
                        },
                        body: JSON.stringify({
                            code,
                            code_verifier: codeVerifier,
                            redirect_uri: redirectUri
                        })
                    }, 'claude-kiro-oauth');
                    
                    if (!tokenResponse.ok) {
                        const errorText = await tokenResponse.text();
                        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token exchange failed:`, errorText);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `获取令牌失败: ${tokenResponse.status}`));
                        return;
                    }
                    
                    const tokenData = await tokenResponse.json();
                    
                    const saveData = {
                        accessToken: tokenData.accessToken,
                        refreshToken: tokenData.refreshToken,
                        profileArn: tokenData.profileArn,
                        expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
                        authMethod: 'social',
                        region: 'us-east-1'
                    };

                    const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', options.poolId);
                    const savedCredential = await oauthCredentialsDao.create({
                        provider_type: 'claude-kiro-oauth',
                        credential_type: 'oauth',
                        credentials: saveData,
                        display_name: options.displayName || null,
                        pool_id: normalizedPoolId,
                        source: 'oauth',
                        is_used: true,
                        metadata: {
                            authMethod: 'social',
                            providerDir: options.providerDir || null
                        }
                    });
                    const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 令牌已保存: ${credentialRef}`);

                    // 直接创建 provider 并 markUsed
                    {
                        const providerConfig = createProviderConfig({
                            credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
                            credPath: credentialRef,
                            credentialId: savedCredential.id,
                            defaultCheckModel: 'claude-haiku-4-5',
                            needsProjectId: false,
                            urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
                        });
                        await providerDao.create({
                            uuid: providerConfig.uuid,
                            provider_type: 'claude-kiro-oauth',
                            pool_id: normalizedPoolId,
                            oauth_credential_id: savedCredential.id,
                            credentials: providerConfig,
                            is_healthy: true,
                            is_disabled: false,
                            check_health: true,
                            check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
                        });
                        await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
                    }

                    // 广播成功事件
                    broadcastEvent('oauth_success', {
                        provider: 'claude-kiro-oauth',
                        credentialId: savedCredential.id,
                        credentialRef: credentialRef,
                        relativePath: credentialRef,
                        timestamp: new Date().toISOString()
                    });

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(true, '授权成功！您可以关闭此页面'));
                    
                    // 关闭服务器
                    server.close(() => {
                        activeKiroServers.delete('claude-kiro-oauth');
                    });
                    
                } else {
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
            }
        });
        
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
        
        // 超时自动关闭
        setTimeout(() => {
            if (server.listening) {
                server.close(() => {
                    activeKiroServers.delete('claude-kiro-oauth');
                });
            }
        }, KIRO_OAUTH_CONFIG.authTimeout);
    });
}

/**
 * 生成 iFlow 授权链接
 * @param {string} state - 状态参数
 * @param {number} port - 回调端口
 * @param {string} host - 回调主机地址
 * @returns {Object} 包含 authUrl 和 redirectUri
 */
function generateIFlowAuthorizationURL(state, port, host = 'localhost') {
    const redirectUri = `http://${host}:${port}/oauth2callback`;
    const params = new URLSearchParams({
        loginMethod: 'phone',
        type: 'phone',
        redirect: redirectUri,
        state: state,
        client_id: IFLOW_OAUTH_CONFIG.clientId
    });
    const authUrl = `${IFLOW_OAUTH_CONFIG.authorizeEndpoint}?${params.toString()}`;
    return { authUrl, redirectUri };
}

/**
 * 交换授权码获取 iFlow 令牌
 * @param {string} code - 授权码
 * @param {string} redirectUri - 重定向 URI
 * @returns {Promise<Object>} 令牌数据
 */
async function exchangeIFlowCodeForTokens(code, redirectUri) {
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: IFLOW_OAUTH_CONFIG.clientId,
        client_secret: IFLOW_OAUTH_CONFIG.clientSecret
    });
    
    // 生成 Basic Auth 头
    const basicAuth = Buffer.from(`${IFLOW_OAUTH_CONFIG.clientId}:${IFLOW_OAUTH_CONFIG.clientSecret}`).toString('base64');

    const response = await fetchWithProxy(IFLOW_OAUTH_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${basicAuth}`
        },
        body: form.toString()
    }, 'openai-iflow');

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow token exchange failed: ${response.status} ${errorText}`);
    }
    
    const tokenData = await response.json();
    
    if (!tokenData.access_token) {
        throw new Error('iFlow token: missing access token in response');
    }
    
    return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        scope: tokenData.scope,
        expiresIn: tokenData.expires_in,
        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    };
}

/**
 * 获取 iFlow 用户信息（包含 API Key）
 * @param {string} accessToken - 访问令牌
 * @returns {Promise<Object>} 用户信息
 */
async function fetchIFlowUserInfo(accessToken) {
    if (!accessToken || accessToken.trim() === '') {
        throw new Error('iFlow api key: access token is empty');
    }
    
    const endpoint = `${IFLOW_OAUTH_CONFIG.userInfoEndpoint}?accessToken=${encodeURIComponent(accessToken)}`;

    const response = await fetchWithProxy(endpoint, {
        method: 'GET',
        headers: {
            'Accept': 'application/json'
        }
    }, 'openai-iflow');
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow user info failed: ${response.status} ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
        throw new Error('iFlow api key: request not successful');
    }
    
    if (!result.data || !result.data.apiKey) {
        throw new Error('iFlow api key: missing api key in response');
    }
    
    // 获取邮箱或手机号作为账户标识
    let email = (result.data.email || '').trim();
    if (!email) {
        email = (result.data.phone || '').trim();
    }
    if (!email) {
        throw new Error('iFlow token: missing account email/phone in user info');
    }
    
    return {
        apiKey: result.data.apiKey,
        email: email,
        phone: result.data.phone || ''
    };
}

/**
 * 关闭 iFlow 服务器
 * @param {string} provider - 提供商标识
 * @param {number} port - 端口号（可选）
 */
async function closeIFlowServer(provider, port = null) {
    const existing = activeIFlowServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeIFlowServers.delete(provider);
                console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [p, info] of activeIFlowServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeIFlowServers.delete(p);
                        console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 已关闭端口 ${port} 上的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * 创建 iFlow OAuth 回调服务器
 * @param {number} port - 端口号
 * @param {string} redirectUri - 重定向 URI
 * @param {string} expectedState - 预期的 state 参数
 * @param {Object} options - 额外选项
 * @returns {Promise<http.Server>} HTTP 服务器实例
 */
function createIFlowCallbackServer(port, redirectUri, expectedState, options = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://localhost:${port}`);
                
                if (url.pathname === '/oauth2callback') {
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const errorParam = url.searchParams.get('error');
                    
                    if (errorParam) {
                        console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 授权失败: ${errorParam}`);
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                        server.close(() => {
                            activeIFlowServers.delete('openai-iflow');
                        });
                        return;
                    }
                    
                    if (state !== expectedState) {
                        console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} State 验证失败`);
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, 'State 验证失败'));
                        server.close(() => {
                            activeIFlowServers.delete('openai-iflow');
                        });
                        return;
                    }
                    
                    if (!code) {
                        console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 缺少授权码`);
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, '缺少授权码'));
                        server.close(() => {
                            activeIFlowServers.delete('openai-iflow');
                        });
                        return;
                    }
                    
                    console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 收到授权回调，正在交换令牌...`);
                    
                    try {
                        // 1. 交换授权码获取令牌
                        const tokenData = await exchangeIFlowCodeForTokens(code, redirectUri);
                        console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 令牌交换成功`);
                        
                        // 2. 获取用户信息（包含 API Key）
                        const userInfo = await fetchIFlowUserInfo(tokenData.accessToken);
                        console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 用户信息获取成功: ${userInfo.email}`);
                        
                        // 3. 组合完整的凭据数据
                        const credentialsData = {
                            access_token: tokenData.accessToken,
                            refresh_token: tokenData.refreshToken,
                            expiry_date: new Date(tokenData.expiresAt).getTime(),
                            token_type: tokenData.tokenType,
                            scope: tokenData.scope,
                            apiKey: userInfo.apiKey
                        };
                        
                        // 4. 保存凭据
                        const savedCredential = await oauthCredentialsDao.create({
                            provider_type: 'openai-iflow',
                            credential_type: 'oauth',
                            credentials: credentialsData,
                            display_name: options.displayName || null,
                            source: 'oauth',
                            is_used: true,
                            metadata: {
                                email: userInfo.email || null,
                                providerDir: options.providerDir || null
                            }
                        });
                        const credentialRef = formatOAuthCredentialRef('openai-iflow', savedCredential.id);
                        console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 凭据已保存: ${credentialRef}`);

                        // 5. 直接创建 provider 并 markUsed
                        const iflowMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'openai-iflow');
                        if (iflowMapping) {
                            const normalizedPoolId = await resolveImportPoolId(storageProvider, options.poolId);
                            const providerConfig = createProviderConfig({
                                credPathKey: iflowMapping.credPathKey,
                                credPath: credentialRef,
                                credentialId: savedCredential.id,
                                defaultCheckModel: iflowMapping.defaultCheckModel,
                                needsProjectId: iflowMapping.needsProjectId || false,
                                urlKeys: iflowMapping.urlKeys
                            });
                            await providerDao.create({
                                uuid: providerConfig.uuid,
                                provider_type: 'openai-iflow',
                                pool_id: normalizedPoolId,
                                oauth_credential_id: savedCredential.id,
                                credentials: providerConfig,
                                is_healthy: true,
                                is_disabled: false,
                                check_health: true,
                                check_model_name: providerConfig.checkModelName || iflowMapping.defaultCheckModel
                            });
                            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                        }

                        // 6. 广播授权成功事件
                        broadcastEvent('oauth_success', {
                            provider: 'openai-iflow',
                            credentialId: savedCredential.id,
                            credentialRef: credentialRef,
                            relativePath: credentialRef,
                            email: userInfo.email,
                            timestamp: new Date().toISOString()
                        });

                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(true, `授权成功！账户: ${userInfo.email}，您可以关闭此页面`));
                        
                    } catch (tokenError) {
                        console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 令牌处理失败:`, tokenError);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `令牌处理失败: ${tokenError.message}`));
                    } finally {
                        server.close(() => {
                            activeIFlowServers.delete('openai-iflow');
                        });
                    }
                } else {
                    // 忽略其他请求
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
                
                if (server.listening) {
                    server.close(() => {
                        activeIFlowServers.delete('openai-iflow');
                    });
                }
            }
        });
        
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 端口 ${port} 已被占用`);
                reject(new Error(`端口 ${port} 已被占用`));
            } else {
                console.error(`${IFLOW_OAUTH_CONFIG.logPrefix} 服务器错误:`, err);
                reject(err);
            }
        });
        
        const host = '0.0.0.0';
        server.listen(port, host, () => {
            console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} OAuth 回调服务器已启动于 ${host}:${port}`);
            resolve(server);
        });
        
        // 10 分钟超时自动关闭
        setTimeout(() => {
            if (server.listening) {
                console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 回调服务器超时，自动关闭`);
                server.close(() => {
                    activeIFlowServers.delete('openai-iflow');
                });
            }
        }, 10 * 60 * 1000);
    });
}

/**
 * 处理 iFlow OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 *   - port: 自定义端口号
 *   - saveToConfigs: 是否保存到 configs 目录
 *   - providerDir: 提供商目录名
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleIFlowOAuth(currentConfig, options = {}) {
    const port = parseInt(options.port) || IFLOW_OAUTH_CONFIG.callbackPort;
    const providerKey = 'openai-iflow';
    const callbackHost = getOAuthCallbackHost(currentConfig);

    // 生成 state 参数
    const state = crypto.randomBytes(16).toString('base64url');

    // 生成授权链接
    const { authUrl, redirectUri } = generateIFlowAuthorizationURL(state, port, callbackHost);
    
    console.log(`${IFLOW_OAUTH_CONFIG.logPrefix} 生成授权链接: ${authUrl}`);
    
    // 关闭之前可能存在的服务器
    await closeIFlowServer(providerKey, port);
    
    // 启动回调服务器
    try {
        const server = await createIFlowCallbackServer(port, redirectUri, state, options);
        activeIFlowServers.set(providerKey, { server, port });
    } catch (error) {
        throw new Error(`启动 iFlow 回调服务器失败: ${error.message}`);
    }
    
    return {
        authUrl,
        authInfo: {
            provider: 'openai-iflow',
            redirectUri: redirectUri,
            callbackPort: port,
            state: state,
            ...options
        }
    };
}

/**
 * 创建 Codex OAuth 授权 URL
 */
function buildCodexAuthorizeUrl(state, codeChallenge, redirectUri) {
    const url = new URL(CODEX_OAUTH_CONFIG.authorizeEndpoint);
    const params = url.searchParams;
    params.set('response_type', 'code');
    params.set('client_id', CODEX_OAUTH_CONFIG.clientId);
    params.set('redirect_uri', redirectUri);
    params.set('scope', CODEX_OAUTH_CONFIG.scope);
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('state', state);
    params.set('id_token_add_organizations', 'true');
    params.set('codex_cli_simplified_flow', 'true');
    params.set('originator', 'codex_cli_rs');
    return url.toString();
}

async function exchangeCodexAuthorizationCode(code, codeVerifier, redirectUri) {
    const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code: code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
    });

    const response = await fetchWithProxy(CODEX_OAUTH_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: form.toString()
    }, 'openai-codex');

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Codex token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json();
    if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
        throw new Error('Codex token response missing fields');
    }

    return tokenData;
}

async function closeCodexServer(providerKey, port = null) {
    const existing = activeCodexServers.get(providerKey);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeCodexServers.delete(providerKey);
                console.log(`${CODEX_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${providerKey} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [key, info] of activeCodexServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeCodexServers.delete(key);
                        console.log(`${CODEX_OAUTH_CONFIG.logPrefix} 已关闭端口 ${port} 上的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

function createCodexCallbackServer(port, options = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                if (url.pathname !== '/auth/callback' && url.pathname !== '/oauth/callback') {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                    return;
                }

                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const errorParam = url.searchParams.get('error');

                if (errorParam) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                    return;
                }

                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, '缺少授权 code'));
                    return;
                }

                const stateRecord = await oauthStateDao.getState(state);
                if (!stateRecord || stateRecord.providerType !== 'openai-codex') {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, 'State 验证失败'));
                    return;
                }

                const tokenData = await exchangeCodexAuthorizationCode(code, stateRecord.codeVerifier, stateRecord.redirectUri);

                const accessToken = tokenData.access_token;
                const refreshToken = tokenData.refresh_token;
                const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
                const idToken = tokenData.id_token || tokenData.idToken || null;
                const tokenForProfile = idToken || accessToken;
                const accountId = extractCodexAccountId(tokenForProfile);
                const email = extractCodexEmail(tokenForProfile);
                const planType = extractCodexPlanType(tokenForProfile);
                const subscriptionTitle = formatCodexPlanTitle(planType);

                if (!accountId) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, '无法从 access_token 提取 account_id'));
                    return;
                }

                const credentialsData = {
                    accessToken,
                    refreshToken,
                    accountId,
                    email,
                    expiresAt,
                    lastRefresh: new Date().toISOString(),
                    type: 'codex',
                    planType: planType || null,
                    subscriptionTitle: subscriptionTitle || null
                };

                const metadataPoolId = stateRecord?.metadata?.poolId;
                const resolvedPoolId = await resolveImportPoolId('openai-codex', metadataPoolId ?? options.poolId);

                const savedCredential = await oauthCredentialsDao.create({
                    provider_type: 'openai-codex',
                    credential_type: 'oauth',
                    credentials: credentialsData,
                    display_name: options.displayName || `codex_${Date.now()}.json`,
                    pool_id: resolvedPoolId,
                    source: 'oauth',
                    is_used: true,
                    metadata: {
                        providerDir: options.providerDir || null
                    }
                });
                const credentialRef = formatOAuthCredentialRef('openai-codex', savedCredential.id);
                console.log(`${CODEX_OAUTH_CONFIG.logPrefix} 令牌已保存: ${credentialRef}`);

                // 直接创建 provider 并 markUsed
                const codexMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'openai-codex');
                if (codexMapping) {
                    const providerConfig = createProviderConfig({
                        credPathKey: codexMapping.credPathKey,
                        credPath: credentialRef,
                        credentialId: savedCredential.id,
                        defaultCheckModel: codexMapping.defaultCheckModel,
                        needsProjectId: codexMapping.needsProjectId || false,
                        urlKeys: codexMapping.urlKeys
                    });
                    if (email) {
                        providerConfig.customName = email;
                    }
                    await providerDao.create({
                        uuid: providerConfig.uuid,
                        provider_type: 'openai-codex',
                        pool_id: resolvedPoolId,
                        custom_name: email || null,
                        oauth_credential_id: savedCredential.id,
                        credentials: providerConfig,
                        is_healthy: true,
                        is_disabled: false,
                        check_health: true,
                        check_model_name: providerConfig.checkModelName || codexMapping.defaultCheckModel
                    });
                    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                }

                broadcastEvent('oauth_success', {
                    provider: 'openai-codex',
                    credentialId: savedCredential.id,
                    credentialRef: credentialRef,
                    relativePath: credentialRef,
                    email: credentialsData.email || null,
                    timestamp: new Date().toISOString()
                });

                await oauthStateDao.deleteState(state);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(true, 'Codex 授权成功，凭据已保存。'));

                server.close(() => {
                    activeCodexServers.delete('openai-codex');
                });
            } catch (error) {
                console.error(`${CODEX_OAUTH_CONFIG.logPrefix} 回调处理失败:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `回调处理失败: ${error.message}`));
            }
        });

        server.on('error', (err) => reject(err));
        server.listen(port, '0.0.0.0', () => {
            console.log(`${CODEX_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
            resolve(server);
        });

        setTimeout(() => {
            if (server.listening) {
                console.log(`${CODEX_OAUTH_CONFIG.logPrefix} 回调服务器超时，自动关闭`);
                server.close(() => {
                    activeCodexServers.delete('openai-codex');
                });
            }
        }, 10 * 60 * 1000);
    });
}

/**
 * 处理 Codex OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleCodexOAuth(currentConfig, options = {}) {
    const serverPort = parseInt(options.port, 10) || CODEX_OAUTH_CONFIG.callbackPort;
    const providerKey = 'openai-codex';
    const callbackHost = getOAuthCallbackHost(currentConfig, options.host);
    const callbackScheme = getOAuthCallbackScheme(currentConfig, options.scheme);
    const redirectPort = getOAuthCallbackPort(currentConfig, options.redirectPort);
    const normalizedPoolId = await resolveImportPoolId(providerKey, options.poolId);

    // 如果批量模式正在运行，复用批量服务器，只生成新 state
    if (codexBatchMode && codexBatchMode.server) {
        const authUrl = await generateBatchState(codexBatchMode.redirectUri, normalizedPoolId ?? codexBatchMode.poolId);
        console.log(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 复用批量服务器生成新授权链接`);
        return {
            authUrl,
            authInfo: {
                provider: providerKey,
                redirectUri: codexBatchMode.redirectUri,
                callbackPort: codexBatchMode.port,
                callbackHost: codexBatchMode.callbackHost,
                callbackScheme: codexBatchMode.callbackScheme,
                batchMode: true,
                ...options
            }
        };
    }

    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const redirectUri = buildOAuthRedirectUri({
        scheme: callbackScheme,
        host: callbackHost,
        port: redirectPort ?? serverPort,
        path: '/auth/callback'
    });
    const authUrl = buildCodexAuthorizeUrl(state, codeChallenge, redirectUri);

    await closeCodexServer(providerKey, serverPort);

    try {
        await oauthStateDao.saveState({
            providerType: providerKey,
            state,
            codeVerifier,
            redirectUri,
            ttlMs: 10 * 60 * 1000,
            metadata: normalizedPoolId !== null ? { poolId: normalizedPoolId } : null
        });
        const server = await createCodexCallbackServer(serverPort, options);
        activeCodexServers.set(providerKey, { server, port: serverPort });
    } catch (error) {
        await oauthStateDao.deleteState(state).catch(() => {});
        throw new Error(`启动 Codex 回调服务器失败: ${error.message}`);
    }

    return {
        authUrl,
        authInfo: {
            provider: providerKey,
            redirectUri: redirectUri,
            callbackPort: serverPort,
            callbackHost: callbackHost,
            callbackScheme: callbackScheme,
            callbackRedirectPort: redirectPort ?? serverPort,
            state: state,
            ...options
        }
    };
}

// ==================== Codex 批量授权模式 ====================

let codexBatchMode = null; // { server, port, poolId, callbackHost, callbackScheme, redirectUri, successCount, emails, startTime }

/**
 * 启动 Codex 批量授权模式
 * 回调服务器持久运行，每次授权成功后自动生成新 state 等待下一个
 */
export async function startCodexBatchAuth(currentConfig, options = {}) {
    if (codexBatchMode) {
        return { success: false, error: '批量授权模式已在运行中' };
    }

    const serverPort = parseInt(options.port, 10) || CODEX_OAUTH_CONFIG.callbackPort;
    const callbackHost = getOAuthCallbackHost(currentConfig, options.host);
    const callbackScheme = getOAuthCallbackScheme(currentConfig, options.scheme);
    const redirectPort = getOAuthCallbackPort(currentConfig, options.redirectPort);
    const normalizedPoolId = await resolveImportPoolId('openai-codex', options.poolId);

    const redirectUri = buildOAuthRedirectUri({
        scheme: callbackScheme,
        host: callbackHost,
        port: redirectPort ?? serverPort,
        path: '/auth/callback'
    });

    // 关闭已有的 Codex 服务器
    await closeCodexServer('openai-codex', serverPort);

    // 生成第一个 state
    const firstAuthUrl = await generateBatchState(redirectUri, normalizedPoolId);

    try {
        const server = await createCodexBatchCallbackServer(serverPort, redirectUri, normalizedPoolId, options);
        codexBatchMode = {
            server,
            port: serverPort,
            poolId: normalizedPoolId,
            callbackHost,
            callbackScheme,
            redirectUri,
            successCount: 0,
            emails: [],
            startTime: Date.now()
        };

        console.log(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 已启动，端口 ${serverPort}`);
        broadcastEvent('codex_batch_started', { port: serverPort, poolId: normalizedPoolId });

        return {
            success: true,
            authUrl: firstAuthUrl,
            port: serverPort,
            poolId: normalizedPoolId,
            redirectUri
        };
    } catch (error) {
        throw new Error(`启动批量授权服务器失败: ${error.message}`);
    }
}

/**
 * 停止 Codex 批量授权模式
 */
export async function stopCodexBatchAuth() {
    if (!codexBatchMode) {
        return { success: false, error: '批量授权模式未运行' };
    }

    const result = {
        success: true,
        successCount: codexBatchMode.successCount,
        emails: codexBatchMode.emails,
        duration: Math.round((Date.now() - codexBatchMode.startTime) / 1000)
    };

    await new Promise((resolve) => {
        codexBatchMode.server.close(() => resolve());
    });

    console.log(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 已停止，共授权 ${result.successCount} 个`);
    broadcastEvent('codex_batch_stopped', result);
    codexBatchMode = null;
    return result;
}

/**
 * 获取批量授权模式状态
 */
export function getCodexBatchStatus() {
    if (!codexBatchMode) {
        return { running: false };
    }
    return {
        running: true,
        port: codexBatchMode.port,
        poolId: codexBatchMode.poolId,
        successCount: codexBatchMode.successCount,
        emails: codexBatchMode.emails,
        duration: Math.round((Date.now() - codexBatchMode.startTime) / 1000)
    };
}

/**
 * 为批量模式生成新的 auth URL（新 state + code verifier）
 */
async function generateBatchState(redirectUri, poolId) {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    await oauthStateDao.saveState({
        providerType: 'openai-codex',
        state,
        codeVerifier,
        redirectUri,
        ttlMs: 30 * 60 * 1000, // 批量模式 30 分钟 TTL
        metadata: poolId !== null ? { poolId } : null
    });

    return buildCodexAuthorizeUrl(state, codeChallenge, redirectUri);
}

/**
 * 创建批量模式的持久回调服务器
 * 与普通模式的区别：成功后不关闭，自动生成新 state 广播新 authUrl
 */
function createCodexBatchCallbackServer(port, redirectUri, poolId, options = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                if (url.pathname !== '/auth/callback' && url.pathname !== '/oauth/callback') {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                    return;
                }

                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const errorParam = url.searchParams.get('error');

                if (errorParam) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                    return;
                }

                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, '缺少授权 code'));
                    return;
                }

                const stateRecord = await oauthStateDao.getState(state);
                if (!stateRecord || stateRecord.providerType !== 'openai-codex') {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, 'State 验证失败'));
                    return;
                }

                const tokenData = await exchangeCodexAuthorizationCode(code, stateRecord.codeVerifier, stateRecord.redirectUri);

                const accessToken = tokenData.access_token;
                const refreshToken = tokenData.refresh_token;
                const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
                const idToken = tokenData.id_token || tokenData.idToken || null;
                const tokenForProfile = idToken || accessToken;
                const accountId = extractCodexAccountId(tokenForProfile);
                const email = extractCodexEmail(tokenForProfile);
                const planType = extractCodexPlanType(tokenForProfile);
                const subscriptionTitle = formatCodexPlanTitle(planType);

                if (!accountId) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, '无法从 access_token 提取 account_id'));
                    return;
                }

                const credentialsData = {
                    accessToken,
                    refreshToken,
                    accountId,
                    email,
                    expiresAt,
                    lastRefresh: new Date().toISOString(),
                    type: 'codex',
                    planType: planType || null,
                    subscriptionTitle: subscriptionTitle || null
                };

                const metadataPoolId = stateRecord?.metadata?.poolId;
                const resolvedPoolId = await resolveImportPoolId('openai-codex', metadataPoolId ?? poolId);

                const savedCredential = await oauthCredentialsDao.create({
                    provider_type: 'openai-codex',
                    credential_type: 'oauth',
                    credentials: credentialsData,
                    display_name: options.displayName || `codex_${Date.now()}.json`,
                    pool_id: resolvedPoolId,
                    source: 'oauth',
                    is_used: true,
                    metadata: {
                        providerDir: options.providerDir || null,
                        batchMode: true
                    }
                });
                const credentialRef = formatOAuthCredentialRef('openai-codex', savedCredential.id);

                const codexMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'openai-codex');
                if (codexMapping) {
                    const providerConfig = createProviderConfig({
                        credPathKey: codexMapping.credPathKey,
                        credPath: credentialRef,
                        credentialId: savedCredential.id,
                        defaultCheckModel: codexMapping.defaultCheckModel,
                        needsProjectId: codexMapping.needsProjectId || false,
                        urlKeys: codexMapping.urlKeys
                    });
                    if (email) providerConfig.customName = email;
                    await providerDao.create({
                        uuid: providerConfig.uuid,
                        provider_type: 'openai-codex',
                        pool_id: resolvedPoolId,
                        custom_name: email || null,
                        oauth_credential_id: savedCredential.id,
                        credentials: providerConfig,
                        is_healthy: true,
                        is_disabled: false,
                        check_health: true,
                        check_model_name: providerConfig.checkModelName || codexMapping.defaultCheckModel
                    });
                    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                }

                await oauthStateDao.deleteState(state);

                // 更新批量模式计数
                if (codexBatchMode) {
                    codexBatchMode.successCount++;
                    if (email) codexBatchMode.emails.push(email);
                }

                // 广播成功事件
                broadcastEvent('oauth_success', {
                    provider: 'openai-codex',
                    credentialId: savedCredential.id,
                    credentialRef,
                    email: email || null,
                    batchMode: true,
                    batchCount: codexBatchMode?.successCount || 0,
                    timestamp: new Date().toISOString()
                });

                // 生成新的 auth URL 供下一个账号使用
                let nextAuthUrl = null;
                try {
                    nextAuthUrl = await generateBatchState(redirectUri, resolvedPoolId);
                    broadcastEvent('codex_batch_next_url', {
                        authUrl: nextAuthUrl,
                        count: codexBatchMode?.successCount || 0
                    });
                } catch (e) {
                    console.error(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 生成下一个 state 失败:`, e);
                }

                console.log(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 授权成功 #${codexBatchMode?.successCount || '?'}: ${email || accountId}`);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(true, `Codex 批量授权成功 #${codexBatchMode?.successCount || '?'}${email ? ` (${email})` : ''}，等待下一个...`));

                // 注意：不关闭 server，继续等待下一个回调
            } catch (error) {
                console.error(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 回调处理失败:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `回调处理失败: ${error.message}`));
            }
        });

        server.on('error', (err) => reject(err));
        server.listen(port, '0.0.0.0', () => {
            console.log(`${CODEX_OAUTH_CONFIG.logPrefix} [批量模式] 回调服务器已启动于端口 ${port}`);
            resolve(server);
        });

        // 批量模式不设超时，由用户手动停止
    });
}

function buildClaudeOfficialAuthorizeUrl(state, codeChallenge, redirectUri, scopeOverride = null) {
    const url = new URL(CLAUDE_OFFICIAL_OAUTH_CONFIG.authorizeEndpoint);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLAUDE_OFFICIAL_OAUTH_CONFIG.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopeOverride || CLAUDE_OFFICIAL_OAUTH_CONFIG.scope);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
}

async function exchangeClaudeOfficialAuthorizationCode(code, codeVerifier, state, redirectUri, options = {}) {
    const rawCode = String(code || '').trim();
    const cleanedCode = rawCode.split('#')[0]?.split('&')[0] ?? rawCode;
    const payload = {
        grant_type: 'authorization_code',
        client_id: CLAUDE_OFFICIAL_OAUTH_CONFIG.clientId,
        code: cleanedCode,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        state
    };

    if (options.authMode === 'setup-token') {
        payload.expires_in = 31536000;
    }

    const response = await fetchWithProxy(CLAUDE_OFFICIAL_OAUTH_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'claude-cli/1.0.56 (external, cli)',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://claude.ai/',
            'Origin': 'https://claude.ai'
        },
        body: JSON.stringify(payload)
    }, 'claude-offical');

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude OAuth token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json();
    if (!tokenData.access_token || !tokenData.expires_in) {
        throw new Error('Claude OAuth token response missing fields');
    }
    return tokenData;
}

async function fetchClaudeOfficialProfile(accessToken) {
    try {
        const response = await fetchWithProxy(CLAUDE_OFFICIAL_OAUTH_CONFIG.profileEndpoint, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'anthropic-beta': CLAUDE_OFFICIAL_OAUTH_CONFIG.betaHeader,
                'User-Agent': 'claude-cli/2.0.53 (external, cli)'
            }
        }, 'claude-offical');
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

function buildClaudeOfficialCookieHeaders(sessionKey) {
    return {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Cookie': `sessionKey=${sessionKey}`,
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/new',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
}

async function getClaudeOfficialCookieOrganizationInfo(sessionKey) {
    const response = await fetchWithProxy(CLAUDE_OFFICIAL_OAUTH_CONFIG.cookieOrganizationsEndpoint, {
        method: 'GET',
        headers: buildClaudeOfficialCookieHeaders(sessionKey),
        redirect: 'manual'
    }, 'claude-offical');

    if (!response.ok) {
        throw new Error(`Cookie 获取组织信息失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error('Cookie 获取组织信息失败: 响应格式无效');
    }

    let selectedOrg = null;
    for (const org of data) {
        const capabilities = Array.isArray(org?.capabilities) ? org.capabilities : [];
        if (!capabilities.includes('chat')) continue;
        if (!selectedOrg || capabilities.length > (selectedOrg.capabilities?.length || 0)) {
            selectedOrg = org;
        }
    }

    if (!selectedOrg?.uuid) {
        throw new Error('Cookie 获取组织信息失败: 未找到可用 chat 组织');
    }

    return {
        organizationUuid: selectedOrg.uuid,
        capabilities: Array.isArray(selectedOrg.capabilities) ? selectedOrg.capabilities : []
    };
}

async function authorizeClaudeOfficialWithCookie(sessionKey, organizationUuid, scope, state, codeChallenge) {
    const endpoint = CLAUDE_OFFICIAL_OAUTH_CONFIG.cookieAuthorizeEndpointTemplate
        .replace('{organization_uuid}', organizationUuid);
    const payload = {
        response_type: 'code',
        client_id: CLAUDE_OFFICIAL_OAUTH_CONFIG.clientId,
        organization_uuid: organizationUuid,
        redirect_uri: CLAUDE_OFFICIAL_OAUTH_CONFIG.cookieRedirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    };

    const response = await fetchWithProxy(endpoint, {
        method: 'POST',
        headers: {
            ...buildClaudeOfficialCookieHeaders(sessionKey),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        redirect: 'manual'
    }, 'claude-offical');

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[Claude Cookie OAuth] 自动授权失败: HTTP ${response.status}, body: ${errorText}`);
        throw new Error(`Cookie 自动授权失败: HTTP ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const redirectUri = data?.redirect_uri || data?.redirectUri || null;
    if (!redirectUri) {
        throw new Error('Cookie 自动授权失败: 未返回 redirect_uri');
    }

    const parsed = new URL(redirectUri);
    const authorizationCode = parsed.searchParams.get('code');
    if (!authorizationCode) {
        throw new Error('Cookie 自动授权失败: 未解析到 code');
    }

    return authorizationCode;
}

export async function handleClaudeOfficialCookieOAuth(currentConfig, options = {}) {
    const authMode = options.authMode === 'setup-token' ? 'setup-token' : 'oauth';
    const sessionKey = String(options.sessionKey || '').trim();
    if (!sessionKey) {
        throw new Error('sessionKey 不能为空');
    }

    const { organizationUuid, capabilities } = await getClaudeOfficialCookieOrganizationInfo(sessionKey);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');
    const scope = authMode === 'setup-token' ? 'user:inference' : 'user:profile user:inference';

    const authorizationCode = await authorizeClaudeOfficialWithCookie(
        sessionKey,
        organizationUuid,
        scope,
        state,
        codeChallenge
    );

    const tokenData = await exchangeClaudeOfficialAuthorizationCode(
        authorizationCode,
        codeVerifier,
        state,
        CLAUDE_OFFICIAL_OAUTH_CONFIG.cookieRedirectUri,
        { authMode }
    );

    const profileData = authMode === 'oauth'
        ? await fetchClaudeOfficialProfile(tokenData.access_token).catch(() => null)
        : null;

    const resolvedPoolId = await resolveImportPoolId(providerType, options.poolId);
    const dbProvider = createClaudeOfficialProviderPayload({
        tokenData,
        profileData,
        poolId: resolvedPoolId,
        options: {
            ...options,
            authMode,
            cookieOAuth: {
                organizationUuid,
                capabilities,
                sessionKey
            }
        }
    });

    const createdProvider = await providerDao.create(dbProvider);
    broadcastEvent('oauth_success', {
        provider: 'claude-offical',
        providerUuid: createdProvider.uuid,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        providerUuid: createdProvider.uuid,
        poolId: resolvedPoolId,
        authMode,
        organizationUuid,
        capabilities
    };
}

/**
 * Cookie OAuth 重新授权（仅获取 token，不创建 provider）
 * 用于 refresh_token 失效后自动用 sessionKey 重新拿 token
 */
export async function handleClaudeOfficialCookieReAuth(sessionKey, authMode = 'oauth') {
    const sk = String(sessionKey || '').trim();
    if (!sk) throw new Error('sessionKey 不能为空');

    const { organizationUuid } = await getClaudeOfficialCookieOrganizationInfo(sk);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');
    const scope = authMode === 'setup-token' ? 'user:inference' : 'user:profile user:inference';

    const authorizationCode = await authorizeClaudeOfficialWithCookie(
        sk, organizationUuid, scope, state, codeChallenge
    );

    return await exchangeClaudeOfficialAuthorizationCode(
        authorizationCode, codeVerifier, state,
        CLAUDE_OFFICIAL_OAUTH_CONFIG.cookieRedirectUri,
        { authMode }
    );
}

async function closeClaudeOfficialServer(providerKey, port = null) {
    const existing = activeClaudeOfficialServers.get(providerKey);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeClaudeOfficialServers.delete(providerKey);
                console.log(`${CLAUDE_OFFICIAL_OAUTH_CONFIG.logPrefix} 已关闭提供商 ${providerKey} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [key, info] of activeClaudeOfficialServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeClaudeOfficialServers.delete(key);
                        console.log(`${CLAUDE_OFFICIAL_OAUTH_CONFIG.logPrefix} 已关闭端口 ${port} 上的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

function createClaudeOfficialProviderPayload({ tokenData, profileData, poolId, options = {} }) {
    const uuid = generateUUID();
    const authMode = options.authMode === 'setup-token' ? 'setup-token' : 'oauth';
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || '';
    const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString();
    const tokenOrganization = tokenData?.organization && typeof tokenData.organization === 'object'
        ? tokenData.organization
        : null;
    const tokenAccount = tokenData?.account && typeof tokenData.account === 'object'
        ? tokenData.account
        : null;
    const profileObject = profileData && typeof profileData === 'object'
        ? (profileData?.data && typeof profileData.data === 'object' ? profileData.data : profileData)
        : null;
    const profileEmail = profileObject?.email || profileObject?.user?.email || null;
    const profileId = profileObject?.id || profileObject?.user_id || profileObject?.userId || null;
    const customName = options.displayName || profileEmail || `claude-oauth-${Date.now()}`;

    const credentials = {
        uuid,
        customName,
        CLAUDE_BASE_URL: 'https://api.anthropic.com',
        officialAuthMode: authMode,
        claudeOauthClientId: CLAUDE_OFFICIAL_OAUTH_CONFIG.clientId,
        claudeOauthAccessToken: accessToken,
        claudeOauthRefreshToken: refreshToken,
        claudeOauthExpiresAt: expiresAt,
        claudeOauthScope: tokenData.scope || (authMode === 'setup-token' ? 'user:inference' : CLAUDE_OFFICIAL_OAUTH_CONFIG.scope),
        claudeOauthTokenType: tokenData.token_type || 'Bearer',
        claudeOauthBetaHeader: CLAUDE_OFFICIAL_OAUTH_CONFIG.betaHeader,
        claudeOauthOrganization: tokenOrganization,
        claudeOauthAccount: tokenAccount,
        claudeOauthProfile: profileObject,
        claudeOauthEmail: profileEmail,
        claudeOauthUserId: profileId,
        checkModelName: 'claude-sonnet-4-5',
        checkHealth: false,
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        lastUsed: null,
        lastErrorTime: null,
        lastErrorMessage: null,
        lastHealthCheckTime: null,
        lastHealthCheckModel: null,
        officialStickySessionEnabled: options.officialStickySessionEnabled ?? true,
        officialStickySessionTtlMinutes: options.officialStickySessionTtlMinutes ?? 60,
        officialSessionBindingStrict: options.officialSessionBindingStrict ?? false,
        officialStickyIdentityMode: options.officialStickyIdentityMode || 'session-or-fingerprint',
        officialFingerprintIncludeUser: options.officialFingerprintIncludeUser ?? true,
        officialFingerprintIncludeToken: options.officialFingerprintIncludeToken ?? true,
        officialFingerprintIncludePath: options.officialFingerprintIncludePath ?? false,
        // Cookie OAuth: 保存 sessionKey 用于 refresh_token 失效后自动重新授权
        ...(options.cookieOAuth?.sessionKey ? { claudeOauthSessionKey: options.cookieOAuth.sessionKey } : {})
    };

    return {
        uuid,
        provider_type: 'claude-offical',
        pool_id: poolId,
        custom_name: customName,
        credentials,
        is_healthy: true,
        is_disabled: false,
        usage_count: 0,
        error_count: 0,
        check_health: false,
        check_model_name: credentials.checkModelName,
        not_supported_models: null
    };
}

function createClaudeOfficialCallbackServer(port, options = {}) {
    return new Promise((resolve, reject) => {
        const providerKey = 'claude-offical';
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                if (url.pathname !== CLAUDE_OFFICIAL_OAUTH_CONFIG.redirectPath && url.pathname !== '/oauth/callback') {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                    return;
                }

                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const errorParam = url.searchParams.get('error');

                if (errorParam) {
                    await oauthStateDao.deleteState(state).catch(() => {});
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                    return;
                }

                if (!code || !state) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, '缺少授权 code/state'));
                    return;
                }

                const stateRecord = await oauthStateDao.getState(state);
                if (!stateRecord || stateRecord.providerType !== providerKey) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, 'State 验证失败'));
                    return;
                }

                const authMode = stateRecord?.metadata?.authMode === 'setup-token' ? 'setup-token' : 'oauth';
                const tokenData = await exchangeClaudeOfficialAuthorizationCode(
                    code,
                    stateRecord.codeVerifier,
                    state,
                    stateRecord.redirectUri,
                    { authMode }
                );
                const profileData = authMode === 'oauth'
                    ? await fetchClaudeOfficialProfile(tokenData.access_token).catch(() => null)
                    : null;

                const metadataPoolId = stateRecord?.metadata?.poolId;
                const resolvedPoolId = await resolveImportPoolId(providerType, metadataPoolId ?? options.poolId);

                const dbProvider = createClaudeOfficialProviderPayload({
                    tokenData,
                    profileData,
                    poolId: resolvedPoolId,
                    options: {
                        ...options,
                        authMode
                    }
                });

                const createdProvider = await providerDao.create(dbProvider);

                broadcastEvent('oauth_success', {
                    provider: providerKey,
                    providerUuid: createdProvider.uuid,
                    timestamp: new Date().toISOString()
                });

                await oauthStateDao.deleteState(state);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(true, 'Claude Official OAuth 授权成功，账号已创建。'));

                server.close(() => {
                    activeClaudeOfficialServers.delete(providerKey);
                });
            } catch (error) {
                console.error(`${CLAUDE_OFFICIAL_OAUTH_CONFIG.logPrefix} 回调处理失败:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `回调处理失败: ${error.message}`));
            }
        });

        server.on('error', (err) => reject(err));
        server.listen(port, '0.0.0.0', () => {
            console.log(`${CLAUDE_OFFICIAL_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
            resolve(server);
        });

        setTimeout(() => {
            if (server.listening) {
                console.log(`${CLAUDE_OFFICIAL_OAUTH_CONFIG.logPrefix} 回调服务器超时，自动关闭`);
                server.close(() => {
                    activeClaudeOfficialServers.delete(providerKey);
                });
            }
        }, 10 * 60 * 1000);
    });
}

export async function handleClaudeOfficialOAuth(currentConfig, options = {}) {
    const providerKey = 'claude-offical';
    const serverPort = parseInt(options.port, 10) || CLAUDE_OFFICIAL_OAUTH_CONFIG.callbackPort;
    const callbackHost = getOAuthCallbackHost(currentConfig, options.host);
    const callbackScheme = getOAuthCallbackScheme(currentConfig, options.scheme);
    const redirectPort = getOAuthCallbackPort(currentConfig, options.redirectPort);
    const normalizedPoolId = await resolveImportPoolId(providerKey, options.poolId);

    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const authMode = options.authMode === 'setup-token' ? 'setup-token' : 'oauth';
    const scope = authMode === 'setup-token'
        ? 'user:inference'
        : CLAUDE_OFFICIAL_OAUTH_CONFIG.scope;

    const redirectUri = buildOAuthRedirectUri({
        scheme: callbackScheme,
        host: callbackHost,
        port: redirectPort ?? serverPort,
        path: CLAUDE_OFFICIAL_OAUTH_CONFIG.redirectPath
    });

    const authUrl = buildClaudeOfficialAuthorizeUrl(state, codeChallenge, redirectUri, scope);

    await closeClaudeOfficialServer(providerKey, serverPort);

    try {
        await oauthStateDao.saveState({
            providerType: providerKey,
            state,
            codeVerifier,
            redirectUri,
            ttlMs: 10 * 60 * 1000,
            metadata: {
                ...(normalizedPoolId !== null ? { poolId: normalizedPoolId } : {}),
                authMode
            }
        });

        const server = await createClaudeOfficialCallbackServer(serverPort, options);
        activeClaudeOfficialServers.set(providerKey, { server, port: serverPort });
    } catch (error) {
        await oauthStateDao.deleteState(state).catch(() => {});
        throw new Error(`启动 Claude Official 回调服务器失败: ${error.message}`);
    }

    return {
        authUrl,
        authInfo: {
            provider: providerKey,
            redirectUri,
            callbackPort: serverPort,
            callbackHost,
            callbackScheme,
            callbackRedirectPort: redirectPort ?? serverPort,
            authMode,
            state,
            ...options
        }
    };
}

/**
 * 使用 refresh_token 刷新 iFlow 令牌
 * @param {string} refreshToken - 刷新令牌
 * @returns {Promise<Object>} 新的令牌数据
 */
export async function refreshIFlowTokens(refreshToken) {
    const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: IFLOW_OAUTH_CONFIG.clientId,
        client_secret: IFLOW_OAUTH_CONFIG.clientSecret
    });
    
    // 生成 Basic Auth 头
    const basicAuth = Buffer.from(`${IFLOW_OAUTH_CONFIG.clientId}:${IFLOW_OAUTH_CONFIG.clientSecret}`).toString('base64');

    const response = await fetchWithProxy(IFLOW_OAUTH_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${basicAuth}`
        },
        body: form.toString()
    }, 'openai-iflow');

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow token refresh failed: ${response.status} ${errorText}`);
    }
    
    const tokenData = await response.json();
    
    if (!tokenData.access_token) {
        throw new Error('iFlow token refresh: missing access token in response');
    }
    
    // 获取用户信息以更新 API Key
    const userInfo = await fetchIFlowUserInfo(tokenData.access_token);
    
    return {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry_date: Date.now() + tokenData.expires_in * 1000,
        token_type: tokenData.token_type,
        scope: tokenData.scope,
        apiKey: userInfo.apiKey
    };
}

/**
 * Kiro Token 刷新常量
 */
const KIRO_REFRESH_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    CONTENT_TYPE_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    DEFAULT_PROVIDER: 'Google',
    REQUEST_TIMEOUT: 30000,
    DEFAULT_REGION: 'us-east-1'
};

function normalizeKiroCredentialFields(credentials = {}) {
    if (!credentials || typeof credentials !== 'object') return {};

    const clientId = credentials.clientId || credentials.client_id;
    const clientSecret = credentials.clientSecret || credentials.client_secret;
    const profileArn = credentials.profileArn || credentials.profile_arn || '';
    const authMethod = credentials.authMethod || credentials.auth_method ||
        (profileArn && !(clientId && clientSecret) ? KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL : undefined);
    const provider = credentials.provider || credentials.socialProvider || credentials.provider_id ||
        (authMethod === KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL ? KIRO_REFRESH_CONSTANTS.DEFAULT_PROVIDER : undefined);
    const region = credentials.region || credentials.awsRegion || KIRO_REFRESH_CONSTANTS.DEFAULT_REGION;

    return {
        ...credentials,
        clientId,
        clientSecret,
        accessToken: credentials.accessToken || credentials.access_token,
        refreshToken: credentials.refreshToken || credentials.refresh_token,
        profileArn,
        expiresAt: credentials.expiresAt || credentials.expires_at,
        authMethod,
        provider,
        region,
        idcRegion: credentials.idcRegion || credentials.idc_region || region,
        startUrl: credentials.startUrl || credentials.start_url,
        registrationExpiresAt: credentials.registrationExpiresAt || credentials.registration_expires_at
    };
}

function isKiroSocialCredential(credentials = {}) {
    const authMethod = String(credentials.authMethod || credentials.auth_method || '').toLowerCase();
    const hasBuilderFields = Boolean(credentials.clientId || credentials.clientSecret || credentials.client_id || credentials.client_secret);
    if (authMethod === KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL) return true;
    if (['idc', 'builder-id', 'iam'].includes(authMethod)) return false;
    if (!hasBuilderFields && (credentials.profileArn || credentials.profile_arn)) return true;
    if (!hasBuilderFields && (credentials.provider || credentials.socialProvider || credentials.provider_id)) return true;
    return Boolean(credentials.refreshToken && !credentials.clientId && !credentials.clientSecret);
}

/**
 * 通过 refreshToken 获取 accessToken
 * @param {string} refreshToken - Kiro 的 refresh token
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @returns {Promise<Object>} 包含 accessToken 等信息的对象
 */
async function refreshKiroToken(refreshToken, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION) {
    const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), KIRO_REFRESH_CONSTANTS.REQUEST_TIMEOUT);
    
    try {
        const response = await fetchWithProxy(refreshUrl, {
            method: 'POST',
            headers: {
                'Content-Type': KIRO_REFRESH_CONSTANTS.CONTENT_TYPE_JSON
            },
            body: JSON.stringify({ refreshToken }),
            signal: controller.signal
        }, 'claude-kiro-oauth');
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.accessToken) {
            throw new Error('Invalid refresh response: Missing accessToken');
        }
        
        const expiresIn = data.expiresIn || 3600;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        
        return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || refreshToken,
            profileArn: data.profileArn || '',
            expiresAt: expiresAt,
            authMethod: KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL,
            provider: KIRO_REFRESH_CONSTANTS.DEFAULT_PROVIDER,
            region: region
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

function resolveWarpTokenUrl(options = {}) {
    if (options.tokenUrl) {
        return options.tokenUrl;
    }
    if (CONFIG.WARP_TOKEN_URL) {
        return CONFIG.WARP_TOKEN_URL;
    }
    const apiKey = options.apiKey || CONFIG.WARP_API_KEY || WARP_OAUTH_CONFIG.apiKey;
    return `${WARP_OAUTH_CONFIG.tokenEndpoint}?key=${apiKey}`;
}

/**
 * 通过 refreshToken 获取 Warp id_token
 * @param {string} refreshToken - Warp refresh token
 * @param {Object} options - 可选参数（apiKey/tokenUrl）
 * @returns {Promise<Object>} 包含 idToken 等信息的对象
 */
async function refreshWarpToken(refreshToken, options = {}) {
    const tokenUrl = resolveWarpTokenUrl(options);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        }).toString();

        const response = await fetchWithProxy(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body,
            signal: controller.signal
        }, 'claude-warp-oauth');

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        if (!data.id_token) {
            throw new Error('Invalid refresh response: Missing id_token');
        }

        const expiresIn = Number(data.expires_in || 3600);
        const expiresAt = Date.now() + expiresIn * 1000;

        return {
            idToken: data.id_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

/**
 * 检查 Kiro 凭据是否已存在（基于 refreshToken + provider 组合）
 * @param {string} refreshToken - 要检查的 refreshToken
 * @param {string} provider - 提供商名称 (默认: 'claude-kiro-oauth')
 * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>} 检查结果
 */
export async function checkKiroCredentialsDuplicate(refreshToken, provider = 'claude-kiro-oauth') {
    try {
        const existing = await oauthCredentialsDao.findByRefreshToken(provider, refreshToken);
        if (!existing) {
            return { isDuplicate: false };
        }

        if (!existing.is_used || !existing.used_by_uuid) {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Ignore unused duplicate credential: ${existing.id}`);
            return { isDuplicate: false };
        }

        const linkedProvider = await providerDao.findByUuid(existing.used_by_uuid);
        if (!linkedProvider || linkedProvider.is_deleted) {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Ignore deleted-provider duplicate credential: ${existing.id}`);
            return { isDuplicate: false };
        }

        const credentialRef = formatOAuthCredentialRef(provider, existing.id);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Found duplicate refreshToken in active provider: ${credentialRef}`);
        return {
            isDuplicate: true,
            existingPath: credentialRef
        };
    } catch (error) {
        console.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
        return { isDuplicate: false };
    }
}

/**
 * 批量导入 Kiro refreshToken 并生成凭据文件
 * @param {string[]} refreshTokens - refreshToken 数组
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportKiroRefreshTokens(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    
    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        
        if (!refreshToken) {
            results.details.push({
                index: i + 1,
                success: false,
                error: 'Empty token'
            });
            results.failed++;
            continue;
        }
        
        // 检查重复
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                results.details.push({
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                });
                results.failed++;
                continue;
            }
        }
        
        try {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
            
            const tokenData = await refreshKiroToken(refreshToken, region);

            const savedCredential = await oauthCredentialsDao.create({
                provider_type: 'claude-kiro-oauth',
                credential_type: 'oauth',
                credentials: tokenData,
                display_name: `kiro_${Date.now()}.json`,
                source: 'batch_import',
                metadata: {
                    region: region,
                    originalRefreshToken: refreshToken
                }
            });

            const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${credentialRef}`);

            results.details.push({
                index: i + 1,
                success: true,
                path: credentialRef,
                expiresAt: tokenData.expiresAt
            });
            results.success++;
            
        } catch (error) {
            console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
            
            results.details.push({
                index: i + 1,
                success: false,
                error: error.message
            });
            results.failed++;
        }
    }
    
    // 如果有成功的，广播事件并自动关联
    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'claude-kiro-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

/**
 * 批量导入 Kiro refreshToken 并生成凭据文件（流式版本，支持实时进度回调）
 * @param {string[]} refreshTokens - refreshToken 数组
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @param {Function} onProgress - 进度回调函数，每处理完一个 token 调用
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportKiroRefreshTokensStream(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, onProgress = null, poolId = null, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    
    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        const progressData = {
            index: i + 1,
            total: refreshTokens.length,
            current: null
        };
        
        if (!refreshToken) {
            progressData.current = {
                index: i + 1,
                success: false,
                error: 'Empty token'
            };
            results.details.push(progressData.current);
            results.failed++;
            
            // 发送进度更新
            if (onProgress) {
                onProgress({
                    ...progressData,
                    successCount: results.success,
                    failedCount: results.failed
                });
            }
            continue;
        }
        
        // 检查重复
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                progressData.current = {
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
                results.details.push(progressData.current);
                results.failed++;
                
                // 发送进度更新
                if (onProgress) {
                    onProgress({
                        ...progressData,
                        successCount: results.success,
                        failedCount: results.failed
                    });
                }
                continue;
            }
        }
        
        try {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
            
            const tokenData = await refreshKiroToken(refreshToken, region);

            const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', poolId);
            // 如果指定了 poolId，创建时直接标记 is_used 防止 autoLink 竞态
            const createWithUsed = normalizedPoolId !== null;
            const savedCredential = await oauthCredentialsDao.create({
                provider_type: 'claude-kiro-oauth',
                credential_type: 'oauth',
                credentials: tokenData,
                display_name: `kiro_${Date.now()}.json`,
                source: 'batch_import',
                is_used: createWithUsed,
                metadata: {
                    region: region,
                    originalRefreshToken: refreshToken
                }
            });

            const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${credentialRef}`);

            // 如果指定了 poolId，直接创建 provider 到该池子
            if (normalizedPoolId !== null) {
                const existingInPool = (await providerDao.findAll('claude-kiro-oauth', {
                    includeDeleted: false,
                    poolId: normalizedPoolId
                })).find(p => Number(p.oauth_credential_id) === Number(savedCredential.id));

                if (existingInPool) {
                    await oauthCredentialsDao.markUsed(savedCredential.id, existingInPool.uuid);
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider already exists for credential ${savedCredential.id}, reuse uuid: ${existingInPool.uuid}`);
                } else {
                    const providerConfig = createProviderConfig({
                        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
                        credPath: credentialRef,
                        credentialId: savedCredential.id,
                        defaultCheckModel: 'claude-haiku-4-5',
                        needsProjectId: false,
                        urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
                    });

                    await providerDao.create({
                        uuid: providerConfig.uuid,
                        provider_type: 'claude-kiro-oauth',
                        pool_id: normalizedPoolId,
                        oauth_credential_id: savedCredential.id,
                        credentials: providerConfig,
                        is_healthy: true,
                        is_disabled: false,
                        check_health: true,
                        check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
                    });
                    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
                }
            }

            progressData.current = {
                index: i + 1,
                success: true,
                path: credentialRef,
                expiresAt: tokenData.expiresAt
            };
            results.details.push(progressData.current);
            results.success++;
            
        } catch (error) {
            console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
            
            progressData.current = {
                index: i + 1,
                success: false,
                error: error.message
            };
            results.details.push(progressData.current);
            results.failed++;
        }
        
        // 发送进度更新
        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    // 如果有成功的，广播事件
    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'claude-kiro-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });

        // 只有没有指定 poolId 时才自动关联（已禁用 autoLink）
    }

    return results;
}

/**
 * 检查 Warp 凭据是否已存在（基于 refreshToken）
 * @param {string} refreshToken - 要检查的 refreshToken
 * @param {string} provider - 提供商名称 (默认: 'claude-warp-oauth')
 * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>} 检查结果
 */
export async function checkWarpCredentialsDuplicate(refreshToken, provider = 'claude-warp-oauth') {
    try {
        const existing = await oauthCredentialsDao.findByRefreshToken(provider, refreshToken);
        if (!existing) {
            return { isDuplicate: false };
        }
        const credentialRef = formatOAuthCredentialRef(provider, existing.id);
        console.log(`${WARP_OAUTH_CONFIG.logPrefix} Found duplicate refreshToken in: ${credentialRef}`);
        return {
            isDuplicate: true,
            existingPath: credentialRef
        };
    } catch (error) {
        console.warn(`${WARP_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
        return { isDuplicate: false };
    }
}

/**
 * 批量导入 Warp refreshToken（流式版本，支持实时进度回调）
 * @param {string[]} refreshTokens - refreshToken 数组
 * @param {Function} onProgress - 进度回调函数
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查
 * @param {Object} options - 可选参数（apiKey/tokenUrl）
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportWarpRefreshTokensStream(refreshTokens, onProgress = null, skipDuplicateCheck = false, options = {}) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };

    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        const progressData = {
            index: i + 1,
            total: refreshTokens.length,
            current: null
        };

        if (!refreshToken) {
            progressData.current = {
                index: i + 1,
                success: false,
                error: 'Empty token'
            };
            results.details.push(progressData.current);
            results.failed++;
            if (onProgress) {
                onProgress({
                    ...progressData,
                    successCount: results.success,
                    failedCount: results.failed
                });
            }
            continue;
        }

        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkWarpCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                progressData.current = {
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
                results.details.push(progressData.current);
                results.failed++;
                if (onProgress) {
                    onProgress({
                        ...progressData,
                        successCount: results.success,
                        failedCount: results.failed
                    });
                }
                continue;
            }
        }

        try {
            console.log(`${WARP_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);

            const tokenData = await refreshWarpToken(refreshToken, options);
            const credentialsData = {
                refreshToken: tokenData.refreshToken,
                idToken: tokenData.idToken,
                expiresAt: tokenData.expiresAt
            };

            const savedCredential = await oauthCredentialsDao.create({
                provider_type: 'claude-warp-oauth',
                credential_type: 'oauth',
                credentials: credentialsData,
                display_name: `warp_${Date.now()}.json`,
                source: 'batch_import',
                metadata: {
                    tokenUrl: resolveWarpTokenUrl(options)
                }
            });

            const credentialRef = formatOAuthCredentialRef('claude-warp-oauth', savedCredential.id);
            console.log(`${WARP_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${credentialRef}`);

            progressData.current = {
                index: i + 1,
                success: true,
                path: credentialRef,
                expiresAt: tokenData.expiresAt
            };
            results.details.push(progressData.current);
            results.success++;
        } catch (error) {
            console.error(`${WARP_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
            progressData.current = {
                index: i + 1,
                success: false,
                error: error.message
            };
            results.details.push(progressData.current);
            results.failed++;
        }

        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'claude-warp-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

/**
 * 导入单个 Warp refreshToken
 * @param {string} refreshToken - refreshToken
 * @param {Object} options - 可选参数（skipDuplicateCheck/apiKey/tokenUrl）
 * @returns {Promise<Object>} 导入结果
 */
export async function importWarpRefreshToken(refreshToken, options = {}) {
    try {
        if (!refreshToken || !refreshToken.trim()) {
            return { success: false, error: 'refreshToken is required' };
        }

        const normalizedToken = refreshToken.trim();
        if (!options.skipDuplicateCheck) {
            const duplicateCheck = await checkWarpCredentialsDuplicate(normalizedToken);
            if (duplicateCheck.isDuplicate) {
                return {
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
            }
        }

        console.log(`${WARP_OAUTH_CONFIG.logPrefix} Refreshing token for manual import...`);
        const tokenData = await refreshWarpToken(normalizedToken, options);
        const credentialsData = {
            refreshToken: tokenData.refreshToken,
            idToken: tokenData.idToken,
            expiresAt: tokenData.expiresAt,
            lastRefreshTime: Date.now()
        };

        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-warp-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: `warp_${Date.now()}.json`,
            source: 'import',
            is_used: true,
            metadata: {
                tokenUrl: resolveWarpTokenUrl(options)
            }
        });
        const credentialRef = formatOAuthCredentialRef('claude-warp-oauth', savedCredential.id);

        console.log(`${WARP_OAUTH_CONFIG.logPrefix} Credentials saved to: ${credentialRef}`);

        // 直接创建 provider 并 markUsed
        const warpMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'claude-warp-oauth');
        if (warpMapping) {
            const providerConfig = createProviderConfig({
                credPathKey: warpMapping.credPathKey,
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: warpMapping.defaultCheckModel,
                needsProjectId: warpMapping.needsProjectId || false,
                urlKeys: warpMapping.urlKeys
            });
            await providerDao.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-warp-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || warpMapping.defaultCheckModel
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        }

        broadcastEvent('oauth_success', {
            provider: 'claude-warp-oauth',
            credentialId: savedCredential.id,
            credentialRef,
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            path: credentialRef,
            expiresAt: credentialsData.expiresAt || null
        };
    } catch (error) {
        console.error(`${WARP_OAUTH_CONFIG.logPrefix} Manual import failed:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

async function createKiroProviderForImport(savedCredential, credentialRef, normalizedPoolId) {
    const providerConfig = createProviderConfig({
        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
        credPath: credentialRef,
        credentialId: savedCredential.id,
        defaultCheckModel: 'claude-haiku-4-5',
        needsProjectId: false,
        urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
    });

    if (normalizedPoolId !== null) {
        const existingInPool = (await providerDao.findAll('claude-kiro-oauth', {
            includeDeleted: false,
            poolId: normalizedPoolId
        })).find(p => Number(p.oauth_credential_id) === Number(savedCredential.id));

        if (existingInPool) {
            await oauthCredentialsDao.markUsed(savedCredential.id, existingInPool.uuid);
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider already exists for credential ${savedCredential.id}, reuse uuid: ${existingInPool.uuid}`);
            return existingInPool.uuid;
        }
    }

    await providerDao.create({
        uuid: providerConfig.uuid,
        provider_type: 'claude-kiro-oauth',
        pool_id: normalizedPoolId,
        oauth_credential_id: savedCredential.id,
        credentials: providerConfig,
        is_healthy: true,
        is_disabled: false,
        check_health: true,
        check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
    });
    await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
    return providerConfig.uuid;
}

async function importKiroSocialCredentials(credentials, skipDuplicateCheck = false, poolId = null) {
    const normalized = normalizeKiroCredentialFields(credentials);
    const refreshToken = normalized.refreshToken;
    if (!refreshToken) {
        return { success: false, error: 'Missing required fields: refreshToken' };
    }

    if (!skipDuplicateCheck) {
        const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
        if (duplicateCheck.isDuplicate) {
            return {
                success: false,
                error: 'duplicate',
                existingPath: duplicateCheck.existingPath
            };
        }
    }

    const region = normalized.region || KIRO_REFRESH_CONSTANTS.DEFAULT_REGION;
    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Importing Kiro social credentials...`);
    const tokenData = await refreshKiroToken(refreshToken, region);
    const credentialsData = {
        accessToken: tokenData.accessToken || normalized.accessToken,
        refreshToken: tokenData.refreshToken || refreshToken,
        profileArn: tokenData.profileArn || normalized.profileArn || '',
        expiresAt: tokenData.expiresAt || normalized.expiresAt,
        tokenIssuedAt: new Date().toISOString(),
        authMethod: KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL,
        provider: normalized.provider || tokenData.provider || KIRO_REFRESH_CONSTANTS.DEFAULT_PROVIDER,
        region: tokenData.region || region
    };
    if (normalized.email) credentialsData.email = normalized.email;
    if (normalized.userId || normalized.user_id) credentialsData.userId = normalized.userId || normalized.user_id;
    if (normalized.startUrl) credentialsData.startUrl = normalized.startUrl;
    if (normalized.nickname) credentialsData.nickname = normalized.nickname;
    if (normalized.idp) credentialsData.idp = normalized.idp;
    if (normalized.accountId || normalized.account_id) credentialsData.accountId = normalized.accountId || normalized.account_id;
    if (normalized.machineId || normalized.machine_id) credentialsData.machineId = normalized.machineId || normalized.machine_id;
    if (normalized.subscription) credentialsData.subscription = normalized.subscription;
    if (normalized.usage) credentialsData.usage = normalized.usage;
    if (normalized.sourceFormat) credentialsData.sourceFormat = normalized.sourceFormat;
    if (normalized.exportedAt) credentialsData.exportedAt = normalized.exportedAt;
    if (normalized.kiroAccountManagerVersion) credentialsData.kiroAccountManagerVersion = normalized.kiroAccountManagerVersion;

    const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', poolId);
    const savedCredential = await oauthCredentialsDao.create({
        provider_type: 'claude-kiro-oauth',
        credential_type: 'oauth',
        credentials: credentialsData,
        display_name: `kiro_${Date.now()}.json`,
        source: 'import',
        is_used: true,
        metadata: {
            authMethod: credentialsData.authMethod,
            provider: credentialsData.provider || null,
            region: credentialsData.region || null,
            originalRefreshToken: refreshToken,
            sourceFormat: normalized.sourceFormat || null,
            accountId: normalized.accountId || normalized.account_id || null,
            machineId: normalized.machineId || normalized.machine_id || null,
            exportedAt: normalized.exportedAt || null,
            kiroAccountManagerVersion: normalized.kiroAccountManagerVersion || null,
            subscription: normalized.subscription || null,
            usage: normalized.usage || null
        }
    });
    const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);
    await createKiroProviderForImport(savedCredential, credentialRef, normalizedPoolId);

    broadcastEvent('oauth_success', {
        provider: 'claude-kiro-oauth',
        relativePath: credentialRef,
        timestamp: new Date().toISOString()
    });

    return {
        success: true,
        path: credentialRef
    };
}

/**
 * 导入 Kiro 凭据。Builder ID 需要 clientId/clientSecret；Social/Google 只需要 refreshToken。
 * @param {Object} credentials - Kiro 凭据对象
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 导入结果
 */
export async function importAwsCredentials(credentials, skipDuplicateCheck = false, poolId = null) {
    try {
        credentials = normalizeKiroCredentialFields(credentials);
        const socialCredential = isKiroSocialCredential(credentials);
        if (socialCredential) {
            return await importKiroSocialCredentials(credentials, skipDuplicateCheck, poolId);
        }

        // 验证必需字段 - 需要四个字段都存在
        const missingFields = [];
        if (!credentials.clientId) missingFields.push('clientId');
        if (!credentials.clientSecret) missingFields.push('clientSecret');
        if (!credentials.accessToken) missingFields.push('accessToken');
        if (!credentials.refreshToken) missingFields.push('refreshToken');
        
        if (missingFields.length > 0) {
            return {
                success: false,
                error: `Missing required fields: ${missingFields.join(', ')}`
            };
        }
        
        // 检查重复凭据
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(credentials.refreshToken);
            if (duplicateCheck.isDuplicate) {
                return {
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
            }
        }
        
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Importing AWS credentials...`);
        
        // 准备凭据数据 - 四个字段都是必需的
        const region = credentials.region || KIRO_REFRESH_CONSTANTS.DEFAULT_REGION;
        const idcRegion = credentials.idcRegion || credentials.idc_region || region;

        const credentialsData = {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            authMethod: credentials.authMethod || 'builder-id',
            region: region,
            idcRegion: idcRegion
        };
        
        // 可选字段
        if (credentials.profileArn) {
            credentialsData.profileArn = credentials.profileArn;
        }
        if (credentials.expiresAt) {
            credentialsData.expiresAt = credentials.expiresAt;
        }
        if (credentials.startUrl) {
            credentialsData.startUrl = credentials.startUrl;
        }
        if (credentials.registrationExpiresAt) {
            credentialsData.registrationExpiresAt = credentials.registrationExpiresAt;
        }
        
        // 尝试刷新获取最新的 accessToken
        try {
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Attempting to refresh token with provided credentials...`);
            
            const refreshRegion = idcRegion || region;
            const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', refreshRegion);
            
            const refreshResponse = await fetchWithProxy(refreshUrl, {
                method: 'POST',
                headers: getKiroSsoOidcHeaders(refreshRegion, 4),
                body: JSON.stringify({
                    refreshToken: credentials.refreshToken,
                    clientId: credentials.clientId,
                    clientSecret: credentials.clientSecret,
                    grantType: 'refresh_token'
                })
            }, 'claude-kiro-oauth');
            
            if (refreshResponse.ok) {
                const tokenData = await refreshResponse.json();
                credentialsData.accessToken = tokenData.accessToken;
                credentialsData.refreshToken = tokenData.refreshToken || credentialsData.refreshToken;
                if (tokenData.profileArn) {
                    credentialsData.profileArn = tokenData.profileArn;
                }
                const expiresIn = tokenData.expiresIn || 3600;
                credentialsData.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Token refreshed successfully`);
            } else {
                console.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh failed, saving original credentials`);
            }
        } catch (refreshError) {
            console.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh error:`, refreshError.message);
            // 继续保存原始凭据
        }
        
        const normalizedPoolId = await resolveImportPoolId('claude-kiro-oauth', poolId);
        const createWithUsed = normalizedPoolId !== null;

        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-kiro-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: `kiro_${Date.now()}.json`,
            source: 'import',
            is_used: createWithUsed,
            metadata: {
                authMethod: credentialsData.authMethod || null,
                region: credentialsData.region || null,
                idcRegion: credentialsData.idcRegion || null,
                originalRefreshToken: credentials.refreshToken || null
            }
        });
        const credentialRef = formatOAuthCredentialRef('claude-kiro-oauth', savedCredential.id);

        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials saved to: ${credentialRef}`);

        // 广播事件
        broadcastEvent('oauth_success', {
            provider: 'claude-kiro-oauth',
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        // 如果指定了 poolId，直接创建 provider 到该池子
        if (normalizedPoolId !== null) {
            const existingInPool = (await providerDao.findAll('claude-kiro-oauth', {
                includeDeleted: false,
                poolId: normalizedPoolId
            })).find(p => Number(p.oauth_credential_id) === Number(savedCredential.id));

            if (existingInPool) {
                await oauthCredentialsDao.markUsed(savedCredential.id, existingInPool.uuid);
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider already exists for credential ${savedCredential.id}, reuse uuid: ${existingInPool.uuid}`);
            } else {
                const providerConfig = createProviderConfig({
                    credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
                    credPath: credentialRef,
                    credentialId: savedCredential.id,
                    defaultCheckModel: 'claude-haiku-4-5',
                    needsProjectId: false,
                    urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
                });

                await providerDao.create({
                    uuid: providerConfig.uuid,
                    provider_type: 'claude-kiro-oauth',
                    pool_id: normalizedPoolId,
                    oauth_credential_id: savedCredential.id,
                    credentials: providerConfig,
                    is_healthy: true,
                    is_disabled: false,
                    check_health: true,
                    check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
                });
                await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
                console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Provider created with poolId: ${normalizedPoolId}, uuid: ${providerConfig.uuid}`);
            }
        } else {
            // 没有指定 poolId，直接创建 provider 到默认池
            const providerConfig = createProviderConfig({
                credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: 'claude-haiku-4-5',
                needsProjectId: false,
                urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
            });
            await providerDao.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-kiro-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || 'claude-haiku-4-5'
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        }

        return {
            success: true,
            path: credentialRef
        };
        
    } catch (error) {
        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials import failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ============================================================================
// Droid OAuth 配置和批量导入
// ============================================================================

const DROID_OAUTH_CONFIG = {
    refreshUrl: 'https://api.workos.com/user_management/authenticate',
    defaultClientId: 'client_01HNM792M5G5G1A2THWPXKFMXB',
    requestTimeout: 20000,
    logPrefix: '[Droid Auth]'
};

const DROID_PROVIDER_TYPES = ['openai-droid', 'openaiResponses-droid', 'claude-droid'];
const DROID_PROFILE_META_KEY = 'DROID_PROFILE_DEFAULT';
const DROID_DEFAULT_PROFILE = {
    model_redirects: {
        'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929'
    },
    endpoint: [
        {
            name: 'openai',
            base_url: 'https://api.factory.ai/api/llm/o/v1/responses'
        },
        {
            name: 'anthropic',
            base_url: 'https://api.factory.ai/api/llm/a/v1/messages'
        },
        {
            name: 'common',
            base_url: 'https://api.factory.ai/api/llm/o/v1/chat/completions'
        }
    ],
    proxies: [],
    models: [
        {
            name: 'Opus 4.5',
            id: 'claude-opus-4-5-20251101',
            type: 'anthropic',
            reasoning: 'auto',
            provider: 'anthropic'
        },
        {
            name: 'Haiku 4.5',
            id: 'claude-haiku-4-5-20251001',
            type: 'anthropic',
            reasoning: 'auto',
            provider: 'anthropic'
        },
        {
            name: 'Sonnet 4.5',
            id: 'claude-sonnet-4-5-20250929',
            type: 'anthropic',
            reasoning: 'auto',
            provider: 'anthropic'
        },
        {
            name: 'GPT-6',
            id: 'gpt-6',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-6 Codex',
            id: 'gpt-6-codex',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.5',
            id: 'gpt-5.5',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.4',
            id: 'gpt-5.4',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.4 Mini',
            id: 'gpt-5.4-mini',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.4 Nano',
            id: 'gpt-5.4-nano',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.4 Codex',
            id: 'gpt-5.4-codex',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.3 Codex',
            id: 'gpt-5.3-codex',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.2',
            id: 'gpt-5.2',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.1',
            id: 'gpt-5.1',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GPT-5.1 Codex',
            id: 'gpt-5.1-codex',
            type: 'openai',
            reasoning: 'off',
            provider: 'openai'
        },
        {
            name: 'GPT-5.1 Codex Max',
            id: 'gpt-5.1-codex-max',
            type: 'openai',
            reasoning: 'auto',
            provider: 'openai'
        },
        {
            name: 'GLM-4.6',
            id: 'glm-4.6',
            type: 'common',
            reasoning: 'off',
            provider: 'fireworks'
        },
        {
            name: 'GLM-4.7',
            id: 'glm-4.7',
            type: 'common',
            reasoning: 'off',
            provider: 'fireworks'
        },
        {
            name: 'Gemini-3-Pro',
            id: 'gemini-3-pro-preview',
            type: 'common',
            reasoning: 'auto',
            provider: 'google'
        },
        {
            name: 'Gemini-3-Flash',
            id: 'gemini-3-flash-preview',
            type: 'common',
            reasoning: 'auto',
            provider: 'google'
        }
    ],
    dev_mode: false,
    user_agent: 'factory-cli/0.27.1',
    system_prompt: 'You are Droid, an AI software engineering agent built by Factory.\n\n'
};

async function loadDefaultDroidProfileValue() {
    let value = await appMetaDao.getValue(DROID_PROFILE_META_KEY);
    if (value) {
        try {
            JSON.parse(value);
            return value;
        } catch (error) {
            console.warn(`${DROID_OAUTH_CONFIG.logPrefix} Invalid profile in app_meta, resetting: ${error.message}`);
        }
    }

    const defaultValue = JSON.stringify(DROID_DEFAULT_PROFILE);
    await appMetaDao.setValue(DROID_PROFILE_META_KEY, defaultValue);
    return defaultValue;
}

function normalizeDroidProviderTypes(nodeTypes) {
    if (!Array.isArray(nodeTypes) || nodeTypes.length === 0) {
        return ['openai-droid'];
    }
    const unique = new Set();
    for (const entry of nodeTypes) {
        if (DROID_PROVIDER_TYPES.includes(entry)) {
            unique.add(entry);
        }
    }
    return Array.from(unique);
}

async function createDroidProvidersForCredential(credentialId, providerTypes) {
    const types = normalizeDroidProviderTypes(providerTypes);
    const profileValue = await loadDefaultDroidProfileValue();
    const credRef = formatOAuthCredentialRef('droid-oauth', credentialId);
    const createdProviders = [];
    let marked = false;

    for (const providerType of types) {
        const newProvider = createProviderConfig({
            credPathKey: 'DROID_OAUTH_CREDS_FILE_PATH',
            credPath: credRef,
            credentialId,
            defaultCheckModel: null,
            needsProjectId: false
        });
        newProvider.DROID_PROFILE = profileValue;

        const dbProvider = {
            uuid: newProvider.uuid,
            provider_type: providerType,
            custom_name: newProvider.customName || null,
            oauth_credential_id: credentialId,
            credentials: newProvider,
            is_healthy: true,
            is_disabled: false,
            usage_count: 0,
            error_count: 0,
            last_used: null,
            last_error_time: null,
            last_error_message: null,
            check_health: newProvider.checkHealth || false,
            check_model_name: newProvider.checkModelName || null,
            not_supported_models: newProvider.notSupportedModels || null
        };

        const createdProvider = await providerDao.create(dbProvider);
        if (!marked) {
            await oauthCredentialsDao.markUsed(credentialId, createdProvider.uuid);
            marked = true;
        }
        createdProviders.push(createdProvider);
    }

    return createdProviders;
}

async function refreshDroidToken(refreshToken, clientId = DROID_OAUTH_CONFIG.defaultClientId) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DROID_OAUTH_CONFIG.requestTimeout);

    try {
        const form = new URLSearchParams();
        form.append('grant_type', 'refresh_token');
        form.append('refresh_token', refreshToken);
        form.append('client_id', clientId || DROID_OAUTH_CONFIG.defaultClientId);

        const response = await fetchWithProxy(DROID_OAUTH_CONFIG.refreshUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: form.toString(),
            signal: controller.signal
        }, 'droid-oauth');

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Droid token refresh failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        if (!data.access_token) {
            throw new Error('Droid refresh response missing access token');
        }

        const expiresIn = data.expires_in || data.expiresIn || null;
        const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null;

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            clientId: clientId || DROID_OAUTH_CONFIG.defaultClientId,
            tokenType: data.token_type || null,
            expiresAt,
            user: data.user || null,
            organizationId: data.organization_id || data.organizationId || null
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Droid token refresh timeout');
        }
        throw error;
    }
}

export async function checkDroidCredentialsDuplicate(refreshToken, provider = 'droid-oauth') {
    try {
        const existing = await oauthCredentialsDao.findByRefreshToken(provider, refreshToken);
        if (!existing) {
            return { isDuplicate: false };
        }
        const credentialRef = formatOAuthCredentialRef(provider, existing.id);
        console.log(`${DROID_OAUTH_CONFIG.logPrefix} Found duplicate refreshToken in: ${credentialRef}`);
        return {
            isDuplicate: true,
            existingPath: credentialRef
        };
    } catch (error) {
        console.warn(`${DROID_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
        return { isDuplicate: false };
    }
}

export async function importDroidRefreshToken(refreshToken, clientId = DROID_OAUTH_CONFIG.defaultClientId, factoryApiKey = null, nodeTypes = null, skipDuplicateCheck = false) {
    try {
        if (!refreshToken || !refreshToken.trim()) {
            return { success: false, error: 'refreshToken is required' };
        }

        const normalizedToken = refreshToken.trim();

        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkDroidCredentialsDuplicate(normalizedToken);
            if (duplicateCheck.isDuplicate) {
                return {
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
            }
        }

        console.log(`${DROID_OAUTH_CONFIG.logPrefix} Refreshing token for manual import...`);
        const tokenData = await refreshDroidToken(normalizedToken, clientId);
        const now = Date.now();

        const credentialsData = {
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            clientId: tokenData.clientId || clientId || DROID_OAUTH_CONFIG.defaultClientId,
            factoryApiKey: factoryApiKey || null,
            lastRefreshTime: now
        };

        if (tokenData.expiresAt) {
            credentialsData.expiresAt = tokenData.expiresAt;
        }
        if (tokenData.tokenType) {
            credentialsData.tokenType = tokenData.tokenType;
        }
        if (tokenData.user) {
            credentialsData.user = tokenData.user;
        }
        if (tokenData.organizationId) {
            credentialsData.organizationId = tokenData.organizationId;
        }

        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'droid-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: `droid_${Date.now()}.json`,
            source: 'import',
            metadata: {
                clientId: credentialsData.clientId,
                userEmail: tokenData.user?.email || null,
                userId: tokenData.user?.id || null,
                organizationId: tokenData.organizationId || null
            }
        });
        const credentialRef = formatOAuthCredentialRef('droid-oauth', savedCredential.id);

        console.log(`${DROID_OAUTH_CONFIG.logPrefix} Credentials saved to: ${credentialRef}`);

        const createdProviders = await createDroidProvidersForCredential(savedCredential.id, nodeTypes);

        broadcastEvent('oauth_success', {
            provider: 'droid-oauth',
            credentialId: savedCredential.id,
            credentialRef: credentialRef,
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            path: credentialRef,
            expiresAt: credentialsData.expiresAt || null,
            providers: createdProviders.map(provider => ({
                uuid: provider.uuid,
                providerType: provider.provider_type
            }))
        };
    } catch (error) {
        console.error(`${DROID_OAUTH_CONFIG.logPrefix} Manual import failed:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

export async function batchImportDroidRefreshTokens(refreshTokens, clientId = DROID_OAUTH_CONFIG.defaultClientId, factoryApiKey = null, nodeTypes = null, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    let createdAny = false;

    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        if (!refreshToken) {
            results.details.push({
                index: i + 1,
                success: false,
                error: 'Empty token'
            });
            results.failed++;
            continue;
        }

        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkDroidCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                results.details.push({
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                });
                results.failed++;
                continue;
            }
        }

        try {
            console.log(`${DROID_OAUTH_CONFIG.logPrefix} Refreshing token ${i + 1}/${refreshTokens.length}...`);
            const tokenData = await refreshDroidToken(refreshToken, clientId);
            const now = Date.now();

            const credentialsData = {
                accessToken: tokenData.accessToken,
                refreshToken: tokenData.refreshToken,
                clientId: tokenData.clientId || clientId || DROID_OAUTH_CONFIG.defaultClientId,
                factoryApiKey: factoryApiKey || null,
                lastRefreshTime: now
            };

            if (tokenData.expiresAt) {
                credentialsData.expiresAt = tokenData.expiresAt;
            }
            if (tokenData.tokenType) {
                credentialsData.tokenType = tokenData.tokenType;
            }
            if (tokenData.user) {
                credentialsData.user = tokenData.user;
            }
            if (tokenData.organizationId) {
                credentialsData.organizationId = tokenData.organizationId;
            }

            const savedCredential = await oauthCredentialsDao.create({
                provider_type: 'droid-oauth',
                credential_type: 'oauth',
                credentials: credentialsData,
                display_name: `droid_${Date.now()}.json`,
                source: 'batch_import',
                metadata: {
                    clientId: credentialsData.clientId,
                    userEmail: tokenData.user?.email || null,
                    userId: tokenData.user?.id || null,
                    organizationId: tokenData.organizationId || null
                }
            });

            const credentialRef = formatOAuthCredentialRef('droid-oauth', savedCredential.id);
            console.log(`${DROID_OAUTH_CONFIG.logPrefix} Token ${i + 1} saved: ${credentialRef}`);

            await createDroidProvidersForCredential(savedCredential.id, nodeTypes);
            createdAny = true;

            results.details.push({
                index: i + 1,
                success: true,
                path: credentialRef,
                expiresAt: credentialsData.expiresAt || null
            });
            results.success++;

        } catch (error) {
            console.error(`${DROID_OAUTH_CONFIG.logPrefix} Token ${i + 1} refresh failed:`, error.message);
            results.details.push({
                index: i + 1,
                success: false,
                error: error.message
            });
            results.failed++;
        }
    }

    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'droid-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });

        if (createdAny) {
            // providers already created by createDroidProvidersForCredential
        }
    }

    return results;
}

export async function batchImportDroidRefreshTokensStream(refreshTokens, clientId = DROID_OAUTH_CONFIG.defaultClientId, factoryApiKey = null, nodeTypes = null, onProgress = null, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    let createdAny = false;

    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        const progressData = {
            index: i + 1,
            total: refreshTokens.length,
            current: null
        };

        if (!refreshToken) {
            progressData.current = {
                index: i + 1,
                success: false,
                error: 'Empty token'
            };
            results.details.push(progressData.current);
            results.failed++;

            if (onProgress) {
                onProgress({
                    ...progressData,
                    successCount: results.success,
                    failedCount: results.failed
                });
            }
            continue;
        }

        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkDroidCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                progressData.current = {
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
                results.details.push(progressData.current);
                results.failed++;

                if (onProgress) {
                    onProgress({
                        ...progressData,
                        successCount: results.success,
                        failedCount: results.failed
                    });
                }
                continue;
            }
        }

        try {
            console.log(`${DROID_OAUTH_CONFIG.logPrefix} Refreshing token ${i + 1}/${refreshTokens.length}...`);
            const tokenData = await refreshDroidToken(refreshToken, clientId);
            const now = Date.now();

            const credentialsData = {
                accessToken: tokenData.accessToken,
                refreshToken: tokenData.refreshToken,
                clientId: tokenData.clientId || clientId || DROID_OAUTH_CONFIG.defaultClientId,
                factoryApiKey: factoryApiKey || null,
                lastRefreshTime: now
            };

            if (tokenData.expiresAt) {
                credentialsData.expiresAt = tokenData.expiresAt;
            }
            if (tokenData.tokenType) {
                credentialsData.tokenType = tokenData.tokenType;
            }
            if (tokenData.user) {
                credentialsData.user = tokenData.user;
            }
            if (tokenData.organizationId) {
                credentialsData.organizationId = tokenData.organizationId;
            }

            const savedCredential = await oauthCredentialsDao.create({
                provider_type: 'droid-oauth',
                credential_type: 'oauth',
                credentials: credentialsData,
                display_name: `droid_${Date.now()}.json`,
                source: 'batch_import',
                metadata: {
                    clientId: credentialsData.clientId,
                    userEmail: tokenData.user?.email || null,
                    userId: tokenData.user?.id || null,
                    organizationId: tokenData.organizationId || null
                }
            });

            const credentialRef = formatOAuthCredentialRef('droid-oauth', savedCredential.id);
            console.log(`${DROID_OAUTH_CONFIG.logPrefix} Token ${i + 1} saved: ${credentialRef}`);

            await createDroidProvidersForCredential(savedCredential.id, nodeTypes);
            createdAny = true;

            progressData.current = {
                index: i + 1,
                success: true,
                path: credentialRef,
                expiresAt: credentialsData.expiresAt || null
            };
            results.details.push(progressData.current);
            results.success++;
        } catch (error) {
            console.error(`${DROID_OAUTH_CONFIG.logPrefix} Token ${i + 1} refresh failed:`, error.message);
            progressData.current = {
                index: i + 1,
                success: false,
                error: error.message
            };
            results.details.push(progressData.current);
            results.failed++;
        }

        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'droid-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });

        if (createdAny) {
            // providers already created by createDroidProvidersForCredential
        }
    }

    return results;
}

// ============================================================================
// Orchids OAuth 配置和处理函数
// ============================================================================

/**
 * Orchids OAuth 配置
 */
const ORCHIDS_OAUTH_CONFIG = {
    // Clerk 端点
    clerkClientUrl: 'https://clerk.orchids.app/v1/client',
    clerkTokenEndpoint: 'https://clerk.orchids.app/v1/client/sessions/{sessionId}/tokens',
    clerkJsVersion: '5.117.0',
    clerkApiVersion: '2025-11-10',
    // 固定值（参照 Go demo）
    defaultProjectId: '280b7bae-cd29-41e4-a0a6-7f603c43b607',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orchids/0.0.57 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36',
    origin: 'https://www.orchids.app',

    // 凭据存储
    credentialsDir: 'orchids',
    credentialsFile: 'orchids_creds.json',

    // 日志前缀
    logPrefix: '[Orchids Auth]'
};

/**
 * 通过 Clerk sign-in API 用邮箱+密码登录 Orchids，获取 __client JWT
 *
 * 流程：
 * 1. POST /v1/client/sign_ins (identifier=email) → 拿到 sign_in_id + __client cookie
 * 2. POST /v1/client/sign_ins/{id}/attempt_first_factor (password) → 登录完成，__client 更新
 * 3. 用最终的 __client 调 fetchOrchidsAccountInfo 获取完整账号信息
 *
 * @param {string} email - 邮箱
 * @param {string} password - 密码
 * @returns {Promise<Object>} { clientJwt, sessionId, userId, email, ... }
 */
async function orchidsSignInWithPassword(email, password) {
    const baseParams = `__clerk_api_version=${ORCHIDS_OAUTH_CONFIG.clerkApiVersion}&_clerk_js_version=${ORCHIDS_OAUTH_CONFIG.clerkJsVersion}`;
    const commonHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': ORCHIDS_OAUTH_CONFIG.origin,
        'Referer': `${ORCHIDS_OAUTH_CONFIG.origin}/`,
        'User-Agent': ORCHIDS_OAUTH_CONFIG.userAgent,
    };

    // 辅助：从 set-cookie 头提取 __client 值
    function extractClientJwt(response) {
        const setCookies = response.headers.getSetCookie?.() || [];
        for (const c of setCookies) {
            if (c.startsWith('__client=')) {
                const val = c.split(';')[0].replace('__client=', '');
                if (val && val.split('.').length === 3) return val;
            }
        }
        return null;
    }

    // Step 1: 提交 email，创建 sign_in
    console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Sign-in step 1: submitting email...`);
    const step1Resp = await fetch(
        `https://clerk.orchids.app/v1/client/sign_ins?${baseParams}`,
        {
            method: 'POST',
            headers: commonHeaders,
            body: `identifier=${encodeURIComponent(email)}`,
        }
    );

    let clientJwt = extractClientJwt(step1Resp);
    const step1Data = await step1Resp.json();

    if (step1Data.errors) {
        const errMsg = step1Data.errors[0]?.long_message || step1Data.errors[0]?.message || 'Unknown error';
        throw new Error(`Sign-in failed (step 1): ${errMsg}`);
    }

    const signInId = step1Data.response?.id;
    if (!signInId) {
        throw new Error('Sign-in failed: no sign_in id returned');
    }

    const status = step1Data.response?.status;
    console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Sign-in step 1 OK: id=${signInId}, status=${status}`);

    // Step 2: 提交密码
    console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Sign-in step 2: submitting password...`);
    const step2Headers = { ...commonHeaders };
    if (clientJwt) {
        step2Headers['Cookie'] = `__client=${clientJwt}`;
    }

    const step2Resp = await fetch(
        `https://clerk.orchids.app/v1/client/sign_ins/${signInId}/attempt_first_factor?${baseParams}`,
        {
            method: 'POST',
            headers: step2Headers,
            body: `strategy=password&password=${encodeURIComponent(password)}`,
        }
    );

    // 更新 __client（登录成功后会更新为已认证的 JWT）
    const newClientJwt = extractClientJwt(step2Resp);
    if (newClientJwt) clientJwt = newClientJwt;

    const step2Data = await step2Resp.json();

    if (step2Data.errors) {
        const errMsg = step2Data.errors[0]?.long_message || step2Data.errors[0]?.message || 'Unknown error';
        throw new Error(`Sign-in failed (step 2): ${errMsg}`);
    }

    const finalStatus = step2Data.response?.status;
    console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Sign-in step 2 result: status=${finalStatus}`);

    if (finalStatus !== 'complete') {
        throw new Error(`Sign-in incomplete: status=${finalStatus}. May require email verification or 2FA.`);
    }

    if (!clientJwt) {
        throw new Error('Sign-in completed but no __client JWT received');
    }

    // Step 3: 用 __client 获取完整账号信息
    console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Fetching account info with new __client...`);
    const accountInfo = await fetchOrchidsAccountInfo(clientJwt);

    return {
        clientJwt,
        ...accountInfo,
    };
}

/**
 * 用邮箱+密码导入 Orchids 账号
 * 自动登录 → 获取 __client JWT → 验证 → 存储完整凭据
 *
 * @param {string} email - 邮箱
 * @param {string} password - 密码
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 导入结果
 */
export async function importOrchidsWithPassword(email, password, options = {}) {
    try {
        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Signing in with email/password: ${email}`);

        // 1. 登录获取 __client JWT + 账号信息
        const signInResult = await orchidsSignInWithPassword(email, password);

        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Sign-in success: session=${signInResult.sessionId}, user=${signInResult.userId}, email=${signInResult.email}`);

        // 2. 构建凭据数据
        const credentialsData = {
            clientJwt: signInResult.clientJwt,
            clerkSessionId: signInResult.sessionId,
            userId: signInResult.userId,
            email: signInResult.email || email,
            projectId: signInResult.projectId || ORCHIDS_OAUTH_CONFIG.defaultProjectId,
            importedAt: new Date().toISOString(),
            authMethod: 'password',
        };

        // 3. 存储凭据
        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-orchids-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: `orchids_${signInResult.email || email}.json`,
            source: 'import',
            is_used: true,
            metadata: {
                mode: 'password',
                sessionId: signInResult.sessionId,
                userId: signInResult.userId,
                email: signInResult.email || email,
                verified: true,
            }
        });
        const credentialRef = formatOAuthCredentialRef('claude-orchids-oauth', savedCredential.id);

        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Credentials saved to: ${credentialRef}`);

        // 4. 创建 provider 并 markUsed
        const orchidsMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'claude-orchids-oauth');
        if (orchidsMapping) {
            const providerConfig = createProviderConfig({
                credPathKey: orchidsMapping.credPathKey,
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: orchidsMapping.defaultCheckModel,
                needsProjectId: orchidsMapping.needsProjectId || false,
                urlKeys: orchidsMapping.urlKeys
            });
            await providerDao.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-orchids-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || orchidsMapping.defaultCheckModel
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        }

        // 5. 广播事件
        broadcastEvent('oauth_success', {
            provider: 'claude-orchids-oauth',
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            path: credentialRef,
            sessionId: signInResult.sessionId,
            userId: signInResult.userId,
            email: signInResult.email || email,
            verified: true,
            message: `Signed in & imported: ${signInResult.email || email} (${signInResult.sessionId})`,
        };

    } catch (error) {
        console.error(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Password import failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 调用 Clerk API 验证 __client cookie 并获取账号信息
 * 参照 Go demo clerk.FetchAccountInfo()
 *
 * @param {string} clientJwt - __client cookie 的 JWT 值
 * @returns {Promise<Object>} { sessionId, userId, email, jwt }
 * @throws {Error} cookie 无效或 Clerk API 不可达时抛出
 */
async function fetchOrchidsAccountInfo(clientJwt) {
    const url = `${ORCHIDS_OAUTH_CONFIG.clerkClientUrl}?__clerk_api_version=${ORCHIDS_OAUTH_CONFIG.clerkApiVersion}&_clerk_js_version=${ORCHIDS_OAUTH_CONFIG.clerkJsVersion}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Cookie': `__client=${clientJwt}`,
            'User-Agent': ORCHIDS_OAUTH_CONFIG.userAgent,
            'Accept-Language': 'zh-CN',
        },
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Clerk API returned ${response.status}: ${body}`);
    }

    const data = await response.json();
    const sessions = data?.response?.sessions || [];

    if (sessions.length === 0) {
        throw new Error('No active sessions found — cookie may be expired');
    }

    const session = sessions[0];
    const sessionId = data.response.last_active_session_id || session.id;
    const userId = session.user?.id;
    const emailAddresses = session.user?.email_addresses || [];
    const email = emailAddresses.length > 0 ? emailAddresses[0].email_address : null;
    const jwt = session.last_active_token?.jwt || null;

    if (!sessionId) {
        throw new Error('Failed to extract sessionId from Clerk response');
    }

    return {
        sessionId,
        userId: userId || null,
        email: email || null,
        jwt,
        clientUat: Math.floor(Date.now() / 1000).toString(),
        projectId: ORCHIDS_OAUTH_CONFIG.defaultProjectId,
    };
}

/**
 * 解析 Orchids 凭据字符串（简化版）
 * 只需要 __client JWT 即可，其他参数通过 Clerk API 自动获取
 *
 * 支持的格式:
 * 1. 纯 JWT 字符串: "eyJhbGciOiJSUzI1NiJ9..." (从 payload 中提取 rotating_token)
 * 2. __client=xxx 格式: "__client=eyJhbGciOiJSUzI1NiJ9..."
 * 3. 完整 Cookies 格式（兼容旧版）: "__client=xxx; __session=xxx"
 * 4. JWT|xxx 格式（兼容旧版）
 *
 * @param {string} inputString - 输入字符串
 * @returns {Object} 解析后的凭据数据
 */
function parseOrchidsCredentials(inputString) {
    if (!inputString || typeof inputString !== 'string') {
        throw new Error('Invalid input string');
    }
    
    const trimmedInput = inputString.trim();
    
    // 格式1: 纯 JWT 字符串（三段式，以点分隔）
    if (trimmedInput.split('.').length === 3 && !trimmedInput.includes('=') && !trimmedInput.includes('|')) {
        console.log('[Orchids Auth] Detected pure JWT format');
        
        // 尝试从 JWT payload 中提取 rotating_token
        let rotatingToken = null;
        try {
            const parts = trimmedInput.split('.');
            if (parts.length === 3) {
                // 解码 JWT payload (Base64URL -> Base64 -> JSON)
                let payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                // 添加 padding
                while (payloadBase64.length % 4) {
                    payloadBase64 += '=';
                }
                const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf8');
                const payload = JSON.parse(payloadJson);
                
                if (payload.rotating_token) {
                    rotatingToken = payload.rotating_token;
                    console.log('[Orchids Auth] Extracted rotating_token from JWT payload');
                }
            }
        } catch (e) {
            console.warn('[Orchids Auth] Failed to extract rotating_token from JWT payload:', e.message);
        }
        
        return {
            type: 'jwt',
            clientJwt: trimmedInput,
            rotatingToken: rotatingToken
        };
    }
    
    // 格式2: __client=xxx 格式（可能包含或不包含 __session）
    if (trimmedInput.includes('__client=')) {
        const clientMatch = trimmedInput.match(/__client=([^;]+)/);
        if (clientMatch) {
            const clientValue = clientMatch[1].trim();
            // 处理可能的 | 分隔符（如 JWT|rotating_token）
            let jwtPart = clientValue;
            let rotatingToken = null;
            if (clientValue.includes('|')) {
                const parts = clientValue.split('|');
                jwtPart = parts[0];
                rotatingToken = parts[1] || null;
            }
            
            if (jwtPart.split('.').length === 3) {
                console.log('[Orchids Auth] Detected __client cookie format');
                return {
                    type: 'jwt',
                    clientJwt: jwtPart,
                    rotatingToken: rotatingToken
                };
            }
        }
        throw new Error('Invalid __client value. Expected a valid JWT.');
    }
    
    // 格式3: JWT|rotating_token 格式
    if (trimmedInput.includes('|')) {
        const parts = trimmedInput.split('|');
        if (parts.length >= 1) {
            const jwtPart = parts[0].trim();
            const rotatingToken = parts.length >= 2 ? parts[1].trim() : null;
            if (jwtPart.split('.').length === 3) {
                console.log('[Orchids Auth] Detected JWT|rotating_token format');
                return {
                    type: 'jwt',
                    clientJwt: jwtPart,
                    rotatingToken: rotatingToken
                };
            }
        }
    }
    
    throw new Error('Invalid format. Please provide the __client cookie value (JWT format). Example: eyJhbGciOiJSUzI1NiJ9...');
}

/**
 * 解析 Orchids JWT Token 字符串 (保留用于向后兼容)
 * @deprecated 请使用 parseOrchidsCredentials
 * 格式: JWT|rotating_token
 * JWT 包含 id (client_id) 和 rotating_token
 * @param {string} tokenString - 完整的 token 字符串
 * @returns {Object} 解析后的 token 数据
 */
function parseOrchidsToken(tokenString) {
    const result = parseOrchidsCredentials(tokenString);
    if (result.type === 'legacy') {
        return {
            clientId: result.clientId,
            rotatingToken: result.rotatingToken,
            jwt: result.jwt,
            rawPayload: result.rawPayload
        };
    }
    // 对于新格式，返回兼容的结构
    return {
        clientId: null,
        rotatingToken: result.clientValue,
        jwt: null,
        rawPayload: null
    };
}

/**
 * 从 Clerk 获取 session token
 * @param {string} sessionId - Clerk session ID
 * @param {string} cookies - Cookie 字符串
 * @returns {Promise<string>} JWT token
 */
async function getClerkSessionToken(sessionId, cookies) {
    const tokenUrl = ORCHIDS_OAUTH_CONFIG.clerkTokenEndpoint
        .replace('{sessionId}', sessionId) +
        `?_clerk_js_version=${ORCHIDS_OAUTH_CONFIG.clerkJsVersion}`;
    
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies,
            'Origin': 'https://www.orchids.app'
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Clerk token request failed: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    return data.jwt;
}

/**
 * 导入 Orchids 凭据
 * 解析 __client JWT → 调 Clerk API 验证并获取 sessionId/userId/email → 存储完整凭据
 *
 * @param {string} inputString - __client JWT 字符串（支持多种格式）
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 导入结果
 */
export async function importOrchidsToken(inputString, options = {}) {
    try {
        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Parsing Orchids credentials...`);

        // 1. 解析输入，提取 clientJwt
        const credData = parseOrchidsCredentials(inputString);

        if (!credData.clientJwt) {
            throw new Error('Failed to extract clientJwt from input');
        }

        // 2. 调 Clerk API 验证 cookie 并获取账号信息（参照 Go demo）
        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Verifying cookie via Clerk API...`);
        let accountInfo;
        try {
            accountInfo = await fetchOrchidsAccountInfo(credData.clientJwt);
            console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Verified: session=${accountInfo.sessionId}, user=${accountInfo.userId}, email=${accountInfo.email}`);
        } catch (verifyError) {
            console.warn(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Clerk verification failed: ${verifyError.message}`);
            console.warn(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Saving credentials anyway — will retry at runtime`);
            accountInfo = null;
        }

        // 3. 构建完整凭据数据
        const credentialsData = {
            clientJwt: credData.clientJwt,
            // 验证成功时存储完整信息，否则留空让运行时补全
            clerkSessionId: accountInfo?.sessionId || null,
            userId: accountInfo?.userId || null,
            email: accountInfo?.email || null,
            projectId: accountInfo?.projectId || ORCHIDS_OAUTH_CONFIG.defaultProjectId,
            importedAt: new Date().toISOString(),
        };

        if (credData.rotatingToken) {
            credentialsData.rotatingToken = credData.rotatingToken;
        }

        const savedCredential = await oauthCredentialsDao.create({
            provider_type: 'claude-orchids-oauth',
            credential_type: 'oauth',
            credentials: credentialsData,
            display_name: accountInfo?.email
                ? `orchids_${accountInfo.email}.json`
                : `orchids_${Date.now()}.json`,
            source: 'import',
            is_used: true,
            metadata: {
                mode: 'token',
                ...(accountInfo ? {
                    sessionId: accountInfo.sessionId,
                    userId: accountInfo.userId,
                    email: accountInfo.email,
                    verified: true,
                } : { verified: false }),
            }
        });
        const credentialRef = formatOAuthCredentialRef('claude-orchids-oauth', savedCredential.id);

        console.log(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Credentials saved to: ${credentialRef}`);

        // 4. 创建 provider 并 markUsed
        const orchidsMapping = PROVIDER_MAPPINGS.find(m => m.providerType === 'claude-orchids-oauth');
        if (orchidsMapping) {
            const providerConfig = createProviderConfig({
                credPathKey: orchidsMapping.credPathKey,
                credPath: credentialRef,
                credentialId: savedCredential.id,
                defaultCheckModel: orchidsMapping.defaultCheckModel,
                needsProjectId: orchidsMapping.needsProjectId || false,
                urlKeys: orchidsMapping.urlKeys
            });
            await providerDao.create({
                uuid: providerConfig.uuid,
                provider_type: 'claude-orchids-oauth',
                pool_id: null,
                oauth_credential_id: savedCredential.id,
                credentials: providerConfig,
                is_healthy: true,
                is_disabled: false,
                check_health: true,
                check_model_name: providerConfig.checkModelName || orchidsMapping.defaultCheckModel
            });
            await oauthCredentialsDao.markUsed(savedCredential.id, providerConfig.uuid);
        }

        // 5. 广播事件
        broadcastEvent('oauth_success', {
            provider: 'claude-orchids-oauth',
            relativePath: credentialRef,
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            path: credentialRef,
            sessionId: accountInfo?.sessionId || null,
            userId: accountInfo?.userId || null,
            email: accountInfo?.email || null,
            verified: !!accountInfo,
            message: accountInfo
                ? `Imported & verified: ${accountInfo.email} (${accountInfo.sessionId})`
                : 'Imported (unverified — Clerk API unreachable, will retry at runtime)',
        };

    } catch (error) {
        console.error(`${ORCHIDS_OAUTH_CONFIG.logPrefix} Token import failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 处理 Orchids OAuth（手动导入模式 - 简化版）
 * 只需要 __client JWT，其他参数自动获取
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回导入说明
 */
export async function handleOrchidsOAuth(currentConfig, options = {}) {
    // Orchids 使用简化的手动导入模式
    // 只需要 __client cookie 的值
    return {
        authUrl: null,
        authInfo: {
            provider: 'claude-orchids-oauth',
            method: 'manual-import',
            instructions: [
                '1. 登录 Orchids 平台 (https://orchids.app)',
                '2. 打开浏览器开发者工具 (F12)',
                '3. 切换到 Application > Cookies > https://orchids.app',
                '4. 找到 __client 并复制其值（一个长的 JWT 字符串）',
                '5. 使用 "导入 Token" 功能粘贴该值'
            ],
            tokenFormat: 'eyJhbGciOiJSUzI1NiJ9...',
            example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsaWVudF8uLi4',
            note: '只需要 __client 的值即可，sessionId 等参数会自动获取'
        }
    };
}
