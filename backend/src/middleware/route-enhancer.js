/**
 * 路由增强模块
 * 为现有的 request-handler 添加静态文件服务、日志和错误处理
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { createStaticFileHandler } from '../middleware/static-files.js';
import { wrapResponseForLogging } from '../middleware/request-logger.js';
import { handleError } from '../middleware/error-handler.js';
import { generatePrometheusMetrics } from '../monitoring/prometheus-exporter.js';
import { handleApiRoutes } from '../routes/index.js';
import { handleProxyRoutes } from '../routes/proxy.routes.js';
import { checkAuth } from '../ui-modules/auth.js';
import { logEvent } from '../ui-modules/event-broadcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 增强请求处理器
 * @param {Function} originalHandler - 原始的请求处理器
 * @param {Object} options - 配置选项
 */
export function enhanceRequestHandler(originalHandler, options = {}) {
    const {
        staticDir = path.join(__dirname, '../../dist'),
        enableStaticFiles = true,
        enableLogging = true,
        enableErrorHandling = true,
        config = null,
        poolManager = null
    } = options;

    // 创建静态文件处理器
    const staticFileHandler = enableStaticFiles
        ? createStaticFileHandler(staticDir, {
            maxAge: 3600,
            enableGzip: true,
            spaFallback: true
        })
        : null;

    return async (req, res) => {
        const startTime = Date.now();
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'Unknown';

        try {
            logEvent('http.request.start', {
                method,
                url: req.url,
                ip,
                userAgent
            }, {
                level: 'info',
                message: `[HTTP START] ${method} ${req.url} ${ip}`,
                writeToFile: true,
                emitConsole: true
            });

            // 1. 添加请求日志
            if (enableLogging) {
                wrapResponseForLogging(res, req, startTime);
            }

            // 2. 处理 /metrics 端点
            if (pathname === '/metrics') {
                const metrics = generatePrometheusMetrics();
                res.writeHead(200, {
                    'Content-Type': 'text/plain; version=0.0.4'
                });
                res.end(metrics);
                return;
            }

            // 3. 处理新的 API 路由（/api/* 路径）
            if (pathname.startsWith('/api/')) {
                // 登录和健康检查接口不需要认证
                const publicPaths = ['/api/auth/login', '/api/auth/setup-password', '/api/system/health'];
                const isPublicPath = publicPaths.includes(pathname) || pathname.startsWith('/api/potluckuser');

                // 检查认证（除了公开路径）
                if (!isPublicPath) {
                    const isAuth = await checkAuth(req);
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
                        return;
                    }
                }

                // 调用新的路由处理器
                const context = { config, poolManager };
                const handled = await handleApiRoutes(method, pathname, req, res, context);

                if (handled) {
                    return;
                }
            }

            // 4. 处理 API 代理路由（/v1/*, /v1beta/*, /{provider}/v1/*, /{provider}/v1beta/*）
            // 检查是否是直接的 API 路径或带提供商前缀的 API 路径
            const isDirectApiPath = pathname.startsWith('/v1');
            const hasProviderPrefix = /^\/[^/]+\/v1/.test(pathname);  // 匹配 /{provider}/v1

            if (isDirectApiPath || hasProviderPrefix) {
                // 确保 config 对象包含所有必要的属性
                const proxyContext = {
                    config: config || {},
                    poolManager
                };
                // 注意：带提供商前缀的路径会在 createRequestHandler 中被处理
                // 这里我们直接跳过，让 originalHandler 处理它
                if (isDirectApiPath) {
                    const handled = await handleProxyRoutes(method, pathname, req, res, proxyContext);
                    if (handled) {
                        return;
                    }
                }
                // 带提供商前缀的路径，跳过静态文件处理，直接进入 originalHandler
            }

            // 5. 尝试静态文件服务（仅对非 API 路径）
            // 排除带提供商前缀的 API 路径（如 /claude-warp-oauth/v1/messages）
            if (staticFileHandler && !pathname.startsWith('/api') && !pathname.startsWith('/v1') && !hasProviderPrefix) {
                const served = await staticFileHandler(req, res, pathname);
                if (served) {
                    return; // 静态文件已处理
                }
            }

            // 6. 调用原始处理器（其他路由）
            await originalHandler(req, res);

        } catch (error) {
            // 6. 错误处理
            if (enableErrorHandling) {
                handleError(error, req, res);
            } else {
                throw error;
            }
        }
    };
}
