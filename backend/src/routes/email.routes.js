/**
 * 邮箱管理路由模块
 */

import { readRequestBody, sendJson, sendError } from './index.js';
import * as emailDao from '../dao/email-dao.js';
import * as emailImap from '../services/email-imap.service.js';
import * as emailAuth from '../services/email-auth.service.js';

/**
 * 邮箱路由处理器
 */
export async function emailRouter(method, path, req, res, context) {
    // GET /api/emails - 获取邮箱列表
    if (method === 'GET' && path === '/api/emails') {
        return await handleGetEmails(req, res);
    }

    // GET /api/emails/stats - 获取统计
    if (method === 'GET' && path === '/api/emails/stats') {
        return await handleGetStats(req, res);
    }

    // GET /api/emails/batch-ids - 获取批次列表
    if (method === 'GET' && path === '/api/emails/batch-ids') {
        return await handleGetBatchIds(req, res);
    }

    // GET /api/emails/:id - 获取单个邮箱
    const getMatch = path.match(/^\/api\/emails\/(\d+)$/);
    if (method === 'GET' && getMatch) {
        return await handleGetEmail(req, res, parseInt(getMatch[1]));
    }

    // POST /api/emails - 创建邮箱
    if (method === 'POST' && path === '/api/emails') {
        return await handleCreateEmail(req, res);
    }

    // POST /api/emails/batch - 批量导入
    if (method === 'POST' && path === '/api/emails/batch') {
        return await handleBatchImport(req, res);
    }

    // POST /api/emails/batch-set-role - 按批次批量设角色
    if (method === 'POST' && path === '/api/emails/batch-set-role') {
        return await handleBatchSetRole(req, res);
    }

    // DELETE /api/emails/batch/:batchId - 按批次删除
    const batchDeleteMatch = path.match(/^\/api\/emails\/batch\/(.+)$/);
    if (method === 'DELETE' && batchDeleteMatch) {
        return await handleBatchDelete(req, res, decodeURIComponent(batchDeleteMatch[1]));
    }

    // PUT /api/emails/:id - 更新邮箱
    const putMatch = path.match(/^\/api\/emails\/(\d+)$/);
    if (method === 'PUT' && putMatch) {
        return await handleUpdateEmail(req, res, parseInt(putMatch[1]));
    }

    // POST /api/emails/:id/enable - 启用
    const enableMatch = path.match(/^\/api\/emails\/(\d+)\/enable$/);
    if (method === 'POST' && enableMatch) {
        return await handleEnable(req, res, parseInt(enableMatch[1]));
    }

    // POST /api/emails/:id/disable - 禁用
    const disableMatch = path.match(/^\/api\/emails\/(\d+)\/disable$/);
    if (method === 'POST' && disableMatch) {
        return await handleDisable(req, res, parseInt(disableMatch[1]));
    }

    // DELETE /api/emails/:id - 删除邮箱
    const deleteMatch = path.match(/^\/api\/emails\/(\d+)$/);
    if (method === 'DELETE' && deleteMatch) {
        return await handleDeleteEmail(req, res, parseInt(deleteMatch[1]));
    }

    // GET /api/emails/:id/messages - 获取邮件列表
    const messagesMatch = path.match(/^\/api\/emails\/(\d+)\/messages$/);
    if (method === 'GET' && messagesMatch) {
        return await handleGetMessages(req, res, parseInt(messagesMatch[1]));
    }

    // GET /api/emails/:id/code - 获取最新验证码
    const codeMatch = path.match(/^\/api\/emails\/(\d+)\/code$/);
    if (method === 'GET' && codeMatch) {
        return await handleGetCode(req, res, parseInt(codeMatch[1]));
    }

    // POST /api/emails/:id/auth/start - 开始授权
    const authStartMatch = path.match(/^\/api\/emails\/(\d+)\/auth\/start$/);
    if (method === 'POST' && authStartMatch) {
        return await handleStartAuth(req, res, parseInt(authStartMatch[1]));
    }

    // GET /api/emails/:id/auth/poll - 轮询授权状态
    const authPollMatch = path.match(/^\/api\/emails\/(\d+)\/auth\/poll$/);
    if (method === 'GET' && authPollMatch) {
        return await handlePollAuth(req, res, parseInt(authPollMatch[1]));
    }

    // POST /api/emails/:id/link - 关联邮箱到提供商
    const linkMatch = path.match(/^\/api\/emails\/(\d+)\/link$/);
    if (method === 'POST' && linkMatch) {
        return await handleLinkProvider(req, res, parseInt(linkMatch[1]));
    }

    // DELETE /api/emails/:id/link - 解除邮箱关联
    const unlinkMatch = path.match(/^\/api\/emails\/(\d+)\/link$/);
    if (method === 'DELETE' && unlinkMatch) {
        return await handleUnlinkProvider(req, res, parseInt(unlinkMatch[1]));
    }

    return false;
}

async function handleGetEmails(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const status = url.searchParams.get('status') || null;
        const search = url.searchParams.get('search') || '';
        const linked = url.searchParams.get('linked') || null;
        const batchId = url.searchParams.get('batchId') || null;
        const linkRole = url.searchParams.get('linkRole') || null;
        const limit = parseInt(url.searchParams.get('limit')) || 100;
        const offset = parseInt(url.searchParams.get('offset')) || 0;

        const emails = await emailDao.findAll({ status, search, linked, batchId, linkRole, limit, offset });
        const total = await emailDao.count({ status, search, linked, batchId, linkRole });

        sendJson(res, 200, { emails, total, limit, offset });
    } catch (error) {
        console.error('[Email] Get emails error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleGetStats(req, res) {
    try {
        const stats = await emailDao.getStats();
        sendJson(res, 200, stats);
    } catch (error) {
        console.error('[Email] Get stats error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleGetBatchIds(req, res) {
    try {
        const batches = await emailDao.getDistinctBatchIds();
        sendJson(res, 200, { batches });
    } catch (error) {
        console.error('[Email] Get batch ids error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleGetEmail(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }
        sendJson(res, 200, email);
    } catch (error) {
        console.error('[Email] Get email error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleCreateEmail(req, res) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);

        if (!data.email || !data.client_id || !data.refresh_token) {
            sendError(res, 400, '缺少必填字段: email, client_id, refresh_token');
            return true;
        }

        const existing = await emailDao.findByEmail(data.email);
        if (existing) {
            sendError(res, 400, '邮箱已存在');
            return true;
        }

        const email = await emailDao.create(data);
        sendJson(res, 201, email);
    } catch (error) {
        console.error('[Email] Create email error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleBatchImport(req, res) {
    try {
        const body = await readRequestBody(req);
        const { content, importType = 'auto' } = JSON.parse(body);

        if (!content) {
            sendError(res, 400, '缺少导入内容');
            return true;
        }

        const lines = content.split('\n').filter(line => line.trim());
        const emails = [];

        for (const line of lines) {
            const parsed = parseLine(line, importType);
            if (parsed) {
                emails.push(parsed);
            }
        }

        if (!emails.length) {
            sendError(res, 400, '没有有效的邮箱数据');
            return true;
        }

        // 生成批次ID: YYYYMMDD-HHmmss-xxxx
        const now = new Date();
        const pad = (n, l = 2) => String(n).padStart(l, '0');
        const batchId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;

        const results = await emailDao.createBatch(emails, batchId);
        const success = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        sendJson(res, 200, { success, failed, batchId, details: results });
    } catch (error) {
        console.error('[Email] Batch import error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleBatchDelete(req, res, batchId) {
    try {
        const deleted = await emailDao.deleteByBatchId(batchId);
        sendJson(res, 200, { success: true, deleted });
    } catch (error) {
        console.error('[Email] Batch delete error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleBatchSetRole(req, res) {
    try {
        const body = await readRequestBody(req);
        const { batchId, linkRole } = JSON.parse(body);
        if (!batchId) {
            sendError(res, 400, '缺少批次ID');
            return true;
        }
        const affected = await emailDao.batchSetLinkRole(batchId, linkRole || null);
        sendJson(res, 200, { success: true, affected });
    } catch (error) {
        console.error('[Email] Batch set role error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

/**
 * 解析导入行
 * OAuth2格式: 邮箱 || 密码 || client_id || refresh_token
 * Graph令牌格式: 邮箱----密码----client_id----refresh_token
 * 密码格式: 邮箱——密码 或 邮箱----密码
 */
function parseLine(line, importType) {
    line = line.trim();
    if (!line) return null;

    // OAuth2 格式: 邮箱 || 密码 || client_id || refresh_token
    if (importType === 'oauth2' || (importType === 'auto' && line.includes('||'))) {
        const parts = line.split('||').map(p => p.trim());
        if (parts.length >= 4) {
            return {
                email: parts[0],
                password: parts[1] || null,
                auth_type: 'oauth2',
                client_id: parts[2],
                refresh_token: parts[3],
                display_name: parts[0]
            };
        }
    }

    // Graph令牌格式: 邮箱----密码----client_id----refresh_token (4个字段)
    if (importType === 'graph' || (importType === 'auto' && line.includes('----'))) {
        const parts = line.split('----').map(p => p.trim());
        if (parts.length >= 4 && parts[0].includes('@')) {
            return {
                email: parts[0],
                password: parts[1] || null,
                auth_type: 'oauth2',
                client_id: parts[2],
                refresh_token: parts[3],
                display_name: parts[0]
            };
        }
    }

    // 密码格式: 邮箱——密码 或 邮箱----密码 (2个字段)
    if (importType === 'password' || importType === 'auto') {
        const separators = ['——', '----', '--'];
        for (const sep of separators) {
            if (line.includes(sep)) {
                const parts = line.split(sep).map(p => p.trim());
                // 只有2个字段时才当作密码格式
                if (parts.length === 2 && parts[0].includes('@')) {
                    return {
                        email: parts[0],
                        password: parts[1],
                        auth_type: 'password',
                        client_id: null,
                        refresh_token: null,
                        display_name: parts[0]
                    };
                }
            }
        }
    }

    return null;
}

async function handleUpdateEmail(req, res, id) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);

        const email = await emailDao.update(id, data);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }
        sendJson(res, 200, email);
    } catch (error) {
        console.error('[Email] Update email error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleEnable(req, res, id) {
    try {
        const email = await emailDao.enable(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }
        sendJson(res, 200, email);
    } catch (error) {
        console.error('[Email] Enable error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleDisable(req, res, id) {
    try {
        const email = await emailDao.disable(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }
        sendJson(res, 200, email);
    } catch (error) {
        console.error('[Email] Disable error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleDeleteEmail(req, res, id) {
    try {
        const deleted = await emailDao.deleteById(id);
        if (!deleted) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }
        sendJson(res, 200, { success: true });
    } catch (error) {
        console.error('[Email] Delete error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleGetMessages(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const top = parseInt(url.searchParams.get('top')) || 10;
        const folder = url.searchParams.get('folder') || 'INBOX';

        const messages = await emailImap.getMessages(email, { top, folder });
        await emailDao.recordUsage(id);

        sendJson(res, 200, { messages });
    } catch (error) {
        console.error('[Email] Get messages error:', error);
        await emailDao.setError(id, error.message);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleGetCode(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }

        const result = await emailImap.getLatestCode(email);
        await emailDao.recordUsage(id);

        if (!result) {
            sendJson(res, 200, { found: false, message: '未找到验证码' });
            return true;
        }

        sendJson(res, 200, { found: true, ...result });
    } catch (error) {
        console.error('[Email] Get code error:', error);
        await emailDao.setError(id, error.message);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleStartAuth(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }

        const result = await emailAuth.startDeviceAuth(id);
        sendJson(res, 200, result);
    } catch (error) {
        console.error('[Email] Start auth error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handlePollAuth(req, res, id) {
    try {
        const result = await emailAuth.pollAuthStatus(id);
        sendJson(res, 200, result);
    } catch (error) {
        console.error('[Email] Poll auth error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleLinkProvider(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }

        const body = await readRequestBody(req);
        const { providerType, providerUuid, credentialId, linkRole } = JSON.parse(body);

        if (!providerType) {
            sendError(res, 400, '缺少提供商类型');
            return true;
        }

        // 仅 openai-codex 允许设置角色
        const effectiveRole = providerType === 'openai-codex' ? (linkRole || null) : null;

        const updated = await emailDao.linkToProvider(id, {
            providerType,
            providerUuid: providerUuid || null,
            credentialId: credentialId || null,
            linkRole: effectiveRole
        });
        sendJson(res, 200, updated);
    } catch (error) {
        console.error('[Email] Link provider error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}

async function handleUnlinkProvider(req, res, id) {
    try {
        const email = await emailDao.findById(id);
        if (!email) {
            sendError(res, 404, '邮箱不存在');
            return true;
        }

        const updated = await emailDao.unlinkProvider(id);
        sendJson(res, 200, updated);
    } catch (error) {
        console.error('[Email] Unlink provider error:', error);
        sendError(res, 500, error.message);
    }
    return true;
}
