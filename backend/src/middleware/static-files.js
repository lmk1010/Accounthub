/**
 * 静态文件服务中间件
 * 用于服务前端构建产物
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MIME 类型映射
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
};

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 静态文件服务处理器
 * @param {string} staticDir - 静态文件目录
 * @param {Object} options - 配置选项
 */
export function createStaticFileHandler(staticDir, options = {}) {
    const {
        maxAge = 3600,           // 缓存时间（秒）
        enableGzip = true,       // 是否启用 Gzip
        spaFallback = true       // SPA 路由回退
    } = options;

    return async (req, res, pathname) => {
        try {
            // 移除查询参数
            const cleanPath = pathname.split('?')[0];

            // 构建文件路径
            let filePath = path.join(staticDir, cleanPath);

            // 检查文件是否存在
            if (!fs.existsSync(filePath)) {
                // SPA 路由回退：返回 index.html
                if (spaFallback && !cleanPath.startsWith('/api') && !cleanPath.startsWith('/v1')) {
                    filePath = path.join(staticDir, 'index.html');
                    if (!fs.existsSync(filePath)) {
                        return false; // 文件不存在
                    }
                } else {
                    return false; // 文件不存在
                }
            }

            // 检查是否是目录
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                filePath = path.join(filePath, 'index.html');
                if (!fs.existsSync(filePath)) {
                    return false;
                }
            }

            // 读取文件
            const content = fs.readFileSync(filePath);
            const mimeType = getMimeType(filePath);

            // 设置响应头
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Cache-Control', `public, max-age=${maxAge}`);

            // 设置 ETag
            const etag = `"${stat.size}-${stat.mtime.getTime()}"`;
            res.setHeader('ETag', etag);

            // 检查 If-None-Match
            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304);
                res.end();
                return true;
            }

            // 发送文件内容
            res.writeHead(200);
            res.end(content);
            return true;

        } catch (error) {
            console.error('[StaticFiles] Error serving file:', error.message);
            return false;
        }
    };
}
