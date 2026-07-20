/**
 * Warp AI 服务 - 完全重构版本
 * 基于抓包数据完美适配 Warp Multi-Agent 协议
 */

import http2 from 'http2';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError } from '../../utils/common.js';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import { withDeduplication } from '../../utils/file-lock.js';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import { getProviderModels } from '../provider-models.js';
import { mapToWarpModel } from './warp-model-mapper.js';
import { initProto, buildNewSessionRequest, buildContinueRequest, buildToolResultRequest, decodeResponseEvent } from './warp-proto.js';
import { WarpSessionState, convertWarpToolCallToClaude, buildWarpToolResult, buildInternalToolResult, getSupportedToolTypes } from './warp-converter.js';
import { updatePermissionsToAllAllow, getOrCreateExecutionProfile } from './warp-permissions.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

// 跨进程请求锁目录
const LOCK_DIR = '/tmp/warp-request-locks';
try {
    if (!fs.existsSync(LOCK_DIR)) {
        fs.mkdirSync(LOCK_DIR, { recursive: true });
    }
} catch (e) {
    logger.warn('[WarpAI] Failed to create lock directory:', e.message);
}

// 初始化 proto 类型
let protoInitialized = false;
async function ensureProtoInitialized() {
    if (!protoInitialized) {
        await initProto();
        protoInitialized = true;
        logger.info('[WarpAI] Proto types initialized');
    }
}

const WARP_CONSTANTS = {
    BASE_URL: 'https://app.warp.dev',
    TOKEN_PATH: '/proxy/token',
    API_KEY: 'AIzaSyBdy3O3S9hrdayLJxJ7mriBR4qgUaUygAs',
    CLIENT_ID: 'warp-app',
    CLIENT_VERSION: 'v0.2026.01.14.08.15.stable_02',
    OS_CATEGORY: 'macOS',
    OS_NAME: 'macOS',
    OS_VERSION: '15.6',
    CONTENT_TYPE: 'application/x-protobuf',
    ACCEPT: 'text/event-stream',
    DEFAULT_MODEL: 'warp-ai'
};

const WARP_MODELS = getProviderModels('claude-warp-oauth');

/**
 * 提取消息中的文本内容
 */
function extractTextFromContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (!item || typeof item !== 'object') return '';
                if (item.type === 'tool_result') {
                    if (typeof item.content === 'string') {
                        return item.content;
                    }
                    if (Array.isArray(item.content)) {
                        return item.content
                            .map(c => typeof c === 'string' ? c : (c?.text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    return '';
                }
                if (typeof item.text === 'string') return item.text;
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
    }
    return '';
}

/**
 * 从 metadata.user_id 中提取 session ID
 * Claude Code 的 user_id 格式: user_{hash}_account__session_{sessionId}
 */
function extractSessionIdFromMetadata(requestBody) {
    const userId = requestBody?.metadata?.user_id;
    if (!userId || typeof userId !== 'string') return null;

    // 提取 session_ 后面的部分
    const sessionMatch = userId.match(/session_([a-f0-9-]+)$/i);
    if (sessionMatch) {
        return sessionMatch[1];
    }
    return null;
}

/**
 * 从 system prompt 中解析 Working directory
 * Claude Code 会在 <env> 标签中包含 Working directory 信息
 */
function extractWorkingDirectoryFromSystem(requestBody) {
    // 尝试从 system 字段中解析
    const system = requestBody?.system;
    if (!system) {
        logger.info('[Warp] extractWorkingDirectory: no system field');
        return null;
    }

    // system 可能是字符串或数组
    let systemText = '';
    if (typeof system === 'string') {
        systemText = system;
    } else if (Array.isArray(system)) {
        systemText = system.map(item =>
            typeof item === 'string' ? item : (item?.text || '')
        ).join('\n');
    }

    // 使用正则匹配 <env> 标签中的 Working directory
    const envMatch = systemText.match(/<env>([\s\S]*?)<\/env>/i);
    if (envMatch) {
        const envContent = envMatch[1];
        // 匹配 Working directory: 后面的路径
        // 注意：env 内容中的换行可能是字面量 \n 或真正的换行符
        // 使用 (?:\\n|\n|\r) 同时匹配两种情况
        const wdMatch = envContent.match(/Working directory:\s*(\/[^\s\\]+)/i);
        if (wdMatch) {
            const wd = wdMatch[1].trim();
            logger.info('[Warp] extractWorkingDirectory: extracted wd:', wd);
            return wd;
        } else {
            logger.info('[Warp] extractWorkingDirectory: no Working directory match in env');
        }
    } else {
        logger.info('[Warp] extractWorkingDirectory: no <env> tag found');
    }

    return null;
}

/**
 * 获取工作目录
 */
function resolveWorkingDirectory(requestBody, config) {
    // 按优先级检查各个来源
    if (requestBody?.extra_body?.warp?.workingDirectory) {
        logger.info('[Warp] resolveWorkingDirectory: from extra_body.warp.workingDirectory');
        return requestBody.extra_body.warp.workingDirectory;
    }
    if (requestBody?.warp?.workingDirectory) {
        logger.info('[Warp] resolveWorkingDirectory: from warp.workingDirectory');
        return requestBody.warp.workingDirectory;
    }
    if (requestBody?.working_directory) {
        logger.info('[Warp] resolveWorkingDirectory: from working_directory');
        return requestBody.working_directory;
    }
    if (requestBody?.workingDirectory) {
        logger.info('[Warp] resolveWorkingDirectory: from workingDirectory');
        return requestBody.workingDirectory;
    }

    const fromSystem = extractWorkingDirectoryFromSystem(requestBody);
    if (fromSystem) {
        logger.info('[Warp] resolveWorkingDirectory: from system prompt:', fromSystem);
        return fromSystem;
    }

    if (config.WARP_WORKING_DIRECTORY) {
        logger.info('[Warp] resolveWorkingDirectory: from config');
        return config.WARP_WORKING_DIRECTORY;
    }

    logger.info('[Warp] resolveWorkingDirectory: using process.cwd()');
    return process.cwd();
}

/**
 * 构建 Claude 消息响应
 */
function buildClaudeMessageResponse(model, contentText, toolCalls = []) {
    const content = [];
    if (contentText) {
        content.push({
            type: 'text',
            text: contentText
        });
    }
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!tc || !tc.name) continue;
            content.push({
                type: 'tool_use',
                id: tc.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                name: tc.name,
                input: tc.input || tc.args || {}
            });
        }
    }
    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    return {
        id: `msg_${uuidv4()}`,
        type: 'message',
        role: 'assistant',
        model: model || WARP_CONSTANTS.DEFAULT_MODEL,
        content,
        stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: 0,
            output_tokens: 0
        }
    };
}

/**
 * Base64 URL-safe 解码
 */
function decodeWarpPayload(payload) {
    let normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (normalized.length % 4)) % 4;
    normalized += '='.repeat(pad);
    return Buffer.from(normalized, 'base64');
}

/**
 * Warp API 服务类 - 完全重构
 */
export class WarpApiService {
    constructor(config = {}) {
        this.config = config;
        this.isInitialized = false;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_WARP ?? false;
        this.baseUrl = config.WARP_BASE_URL || WARP_CONSTANTS.BASE_URL;
        this.apiKey = config.WARP_API_KEY || WARP_CONSTANTS.API_KEY;
        this.tokenUrl = config.WARP_TOKEN_URL || `${this.baseUrl}${WARP_CONSTANTS.TOKEN_PATH}?key=${this.apiKey}`;
        this.clientVersion = config.WARP_CLIENT_VERSION || WARP_CONSTANTS.CLIENT_VERSION;
        this.osCategory = config.WARP_OS_CATEGORY || WARP_CONSTANTS.OS_CATEGORY;
        this.osName = config.WARP_OS_NAME || WARP_CONSTANTS.OS_NAME;
        this.osVersion = config.WARP_OS_VERSION || WARP_CONSTANTS.OS_VERSION;
        this.axiosInstance = null;
        this.refreshAxios = null;
        this.oauthCredentialId = null;
        this.idToken = null;
        this.refreshToken = null;
        this.expiresAt = null;

        // 会话状态管理
        this.sessions = new Map(); // sessionKey -> WarpSessionState
        this.sessionAccess = new Map(); // sessionKey -> lastAccessTs
        const ttlRaw = Number(config.WARP_SESSION_TTL_MS);
        const maxRaw = Number(config.WARP_MAX_SESSIONS);
        this.sessionTtlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 30 * 60 * 1000;
        this.maxSessions = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 300;

        // 初始化锁（防止并发初始化）
        this._initializingPromise = null;

        // Execution Profile
        this.executionProfileUid = null;

        this._sessionCleanupTimer = setInterval(() => {
            this.cleanupSessions();
        }, 60000);
        if (this._sessionCleanupTimer.unref) this._sessionCleanupTimer.unref();
    }

    _touchSession(sessionKey) {
        if (!sessionKey) return;
        this.sessionAccess.set(sessionKey, Date.now());
    }

    _evictSession(sessionKey, clearStore = false) {
        const session = this.sessions.get(sessionKey);
        if (clearStore && session && typeof session.clear === 'function') {
            session.clear();
        }
        this.sessions.delete(sessionKey);
        this.sessionAccess.delete(sessionKey);
    }

    cleanupSessions() {
        if (this.sessions.size === 0) return;

        const now = Date.now();
        let evicted = 0;

        for (const [sessionKey, lastAccess] of this.sessionAccess.entries()) {
            if (now - lastAccess > this.sessionTtlMs) {
                this._evictSession(sessionKey, false);
                evicted += 1;
            }
        }

        if (this.sessions.size > this.maxSessions) {
            const sorted = Array.from(this.sessionAccess.entries()).sort((a, b) => a[1] - b[1]);
            const overflow = this.sessions.size - this.maxSessions;
            for (let i = 0; i < overflow; i += 1) {
                const [sessionKey] = sorted[i] || [];
                if (!sessionKey) continue;
                this._evictSession(sessionKey, false);
                evicted += 1;
            }
        }

        if (evicted > 0) {
            logger.info(`[Warp] Session cache cleaned: evicted=${evicted}, remaining=${this.sessions.size}`);
        }
    }

    async initialize() {
        if (this.isInitialized) return;

        // 防止并发初始化
        if (this._initializingPromise) {
            return this._initializingPromise;
        }

        this._initializingPromise = (async () => {
            if (this.isInitialized) return;
            await ensureProtoInitialized();
            this.setupAxiosInstances();
            await this.initializeAuth();
            this.isInitialized = true;
        })();

        try {
            await this._initializingPromise;
        } finally {
            this._initializingPromise = null;
        }
    }

    setupAxiosInstances() {
        if (this.axiosInstance && this.refreshAxios) return;

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: 120000
        });

        const axiosConfig = {
            baseURL: this.baseUrl,
            timeout: 120000,
            httpAgent,
            httpsAgent,
            headers: {
                'content-type': WARP_CONSTANTS.CONTENT_TYPE,
                'accept': WARP_CONSTANTS.ACCEPT,
                'x-warp-client-id': WARP_CONSTANTS.CLIENT_ID,
                'x-warp-client-version': this.clientVersion,
                'x-warp-os-category': this.osCategory,
                'x-warp-os-name': this.osName,
                'x-warp-os-version': this.osVersion
            }
        };

        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        configureAxiosProxy(axiosConfig, this.config, 'claude-warp-oauth');
        this.axiosInstance = axios.create(axiosConfig);

        const refreshConfig = {
            timeout: 120000,
            httpAgent,
            httpsAgent,
            headers: {
                'content-type': 'application/x-www-form-urlencoded'
            }
        };
        if (!this.useSystemProxy) {
            refreshConfig.proxy = false;
        }
        configureAxiosProxy(refreshConfig, this.config, 'claude-warp-oauth');
        this.refreshAxios = axios.create(refreshConfig);
    }

    async initializeAuth(forceRefresh = false) {
        this.setupAxiosInstances();
        let mergedCredentials = {};
        try {
            const { credentialId, credentials } = await loadCredentialsFromConfig(
                this.config,
                'WARP_OAUTH_CREDS_FILE_PATH',
                'Warp'
            );
            this.oauthCredentialId = credentialId;
            mergedCredentials = { ...mergedCredentials, ...credentials };
        } catch (error) {
            if (!Object.keys(mergedCredentials).length) {
                throw new Error(`[Warp Auth] ${error.message}`);
            }
        }

        this.refreshToken = mergedCredentials.refreshToken || mergedCredentials.refresh_token;
        this.idToken = mergedCredentials.idToken || mergedCredentials.id_token || mergedCredentials.accessToken;
        this.expiresAt = mergedCredentials.expiresAt || mergedCredentials.expires_at;

        if (forceRefresh || !this.idToken || this.isExpiryDateNear()) {
            if (!this.refreshToken) {
                throw new Error('[Warp Auth] Missing refresh token.');
            }
            const dedupeKey = `warp-token-refresh:${this.oauthCredentialId || 'unknown'}`;
            await withDeduplication(dedupeKey, async () => {
                await this.refreshAccessToken();
            });
        }

        if (!this.idToken) {
            throw new Error('[Warp Auth] No id token available after refresh.');
        }

        // 自动配置权限为全部允许（异步执行，不阻塞主流程）
        this.autoConfigurePermissions().catch(err => {
            logger.warn('[Warp Auth] Auto configure permissions failed:', err.message);
        });
    }

    /**
     * 自动配置 Warp 权限为全部允许，并获取/创建 execution profile
     */
    async autoConfigurePermissions() {
        try {
            // 获取或创建 execution profile
            const profile = await getOrCreateExecutionProfile(this.idToken, this.clientVersion);
            if (profile && profile.uid) {
                this.executionProfileUid = profile.uid;
                logger.info('[Warp Auth] Execution profile ready:', this.executionProfileUid);
            }

            // 更新权限配置
            const success = await updatePermissionsToAllAllow(this.idToken, this.clientVersion);
            if (success) {
                logger.info('[Warp Auth] Permissions auto-configured to all allow');
            }
        } catch (error) {
            logger.warn('[Warp Auth] Failed to auto-configure permissions:', error.message);
        }
    }

    async refreshAccessToken() {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken
        }).toString();

        const response = await this.refreshAxios.post(this.tokenUrl, body);
        if (!response?.data?.id_token) {
            throw new Error('[Warp Auth] Invalid refresh response: missing id_token.');
        }

        this.idToken = response.data.id_token;
        this.refreshToken = response.data.refresh_token || this.refreshToken;
        const expiresIn = Number(response.data.expires_in || 0);
        this.expiresAt = Date.now() + expiresIn * 1000;

        if (this.oauthCredentialId) {
            const existing = await oauthCredentialsDao.findById(this.oauthCredentialId);
            const merged = {
                ...(existing?.credentials || {}),
                refreshToken: this.refreshToken,
                idToken: this.idToken,
                expiresAt: this.expiresAt
            };
            await updateCredentialsById(this.oauthCredentialId, merged);
        }
    }

    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        let expiryMs = this.expiresAt;
        if (typeof expiryMs === 'string') {
            const parsed = Date.parse(expiryMs);
            if (!Number.isNaN(parsed)) {
                expiryMs = parsed;
            }
        }
        if (typeof expiryMs !== 'number') return true;
        const threshold = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
        return expiryMs <= Date.now() + threshold;
    }

    /**
     * 获取或创建会话（支持跨进程共享）
     */
    getOrCreateSession(sessionKey) {
        if (!sessionKey) sessionKey = 'default';

        if (!this.sessions.has(sessionKey)) {
            // 创建新会话时传入 sessionKey 以启用共享存储
            this.sessions.set(sessionKey, new WarpSessionState(sessionKey));
            logger.info('[Warp] Created new session for key:', sessionKey);
            if (this.sessions.size > this.maxSessions) {
                this.cleanupSessions();
            }
        } else {
            // 已存在的会话，从共享存储刷新状态
            const session = this.sessions.get(sessionKey);
            if (session._loadFromSharedStore) {
                session._loadFromSharedStore();
            }
        }
        this._touchSession(sessionKey);
        return this.sessions.get(sessionKey);
    }

    /**
     * HTTP/2 流式请求
     */
    async *makeHttp2StreamRequest(requestBody) {
        const client = http2.connect(this.baseUrl);
        let buffer = '';
        const dataPromises = [];
        let dataResolver = null;
        let streamEnded = false;
        let streamError = null;

        client.on('error', (err) => {
            streamError = err;
            streamEnded = true;
            if (dataResolver) {
                dataResolver(null);
            }
            client.close();
        });

        const headers = {
            ':method': 'POST',
            ':path': '/ai/multi-agent',
            ':scheme': 'https',
            ':authority': 'app.warp.dev',
            'x-warp-client-id': WARP_CONSTANTS.CLIENT_ID,
            'x-warp-client-version': this.clientVersion,
            'x-warp-os-category': this.osCategory,
            'x-warp-os-name': this.osName,
            'x-warp-os-version': this.osVersion,
            'content-type': WARP_CONSTANTS.CONTENT_TYPE,
            'authorization': `Bearer ${this.idToken}`,
            'accept': WARP_CONSTANTS.ACCEPT,
            'content-length': requestBody.length.toString()
        };

        const req = client.request(headers);

        req.on('response', (headers) => {
            const responseStatus = headers[':status'];
            logger.info('[Warp HTTP2] Response status:', responseStatus);

            if (responseStatus !== 200) {
                streamError = new Error(`HTTP ${responseStatus}`);
                streamError.status = responseStatus;
            }
        });

        req.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            buffer += text;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (dataResolver) {
                    dataResolver(line);
                    dataResolver = null;
                } else {
                    dataPromises.push(Promise.resolve(line));
                }
            }
        });

        req.on('end', () => {
            if (buffer.trim()) {
                if (dataResolver) {
                    dataResolver(buffer);
                    dataResolver = null;
                } else {
                    dataPromises.push(Promise.resolve(buffer));
                }
            }
            streamEnded = true;
            if (dataResolver) {
                dataResolver(null);
            }
            client.close();
        });

        req.on('error', (err) => {
            logger.error('[Warp HTTP2] Request error:', err.message);
            streamError = err;
            streamEnded = true;
            if (dataResolver) {
                dataResolver(null);
            }
            client.close();
        });

        logger.info('[Warp HTTP2] Sending request, body size:', requestBody.length, 'bytes');
        req.write(Buffer.from(requestBody));
        req.end();

        while (true) {
            if (streamError) {
                throw streamError;
            }

            let line;
            if (dataPromises.length > 0) {
                line = await dataPromises.shift();
            } else if (streamEnded) {
                break;
            } else {
                line = await new Promise(resolve => {
                    dataResolver = resolve;
                });
            }

            if (line === null) break;
            if (line) {
                yield line;
            }
        }
    }

    /**
     * 从 Warp toolCallResult 中提取执行结果
     * 注意：这是 Warp 回显我们发送的工具结果
     */
    extractToolResultFromWarp(tcr) {
        if (!tcr) return null;

        // runShellCommand 结果
        if (tcr.runShellCommand && tcr.runShellCommand.commandFinished) {
            return {
                type: 'bash',
                command: tcr.runShellCommand.command,
                output: tcr.runShellCommand.commandFinished.output || '',
                exitCode: tcr.runShellCommand.commandFinished.exitCode || 0
            };
        }

        // readFiles 结果
        if (tcr.readFiles) {
            if (tcr.readFiles.success) {
                const files = tcr.readFiles.success.files || [];
                const content = files.map(f => `=== ${f.filePath} ===\n${f.content}`).join('\n\n');
                return { type: 'read', output: content };
            }
            if (tcr.readFiles.error) {
                return { type: 'read', output: tcr.readFiles.error.message || '', isError: true };
            }
        }

        // grep 结果
        if (tcr.grep) {
            if (tcr.grep.success) {
                const matches = tcr.grep.success.matchedFiles || [];
                const output = matches.map(m => `${m.filePath}: ${m.matchedLines?.length || 0} matches`).join('\n');
                return { type: 'grep', output };
            }
            if (tcr.grep.error) {
                return { type: 'grep', output: tcr.grep.error.message || '', isError: true };
            }
        }

        // fileGlob 结果
        if (tcr.fileGlobV2) {
            if (tcr.fileGlobV2.success) {
                const files = tcr.fileGlobV2.success.matchedFiles || [];
                return { type: 'glob', output: files.map(f => f.filePath).join('\n') };
            }
            if (tcr.fileGlobV2.error) {
                return { type: 'glob', output: tcr.fileGlobV2.error.message || '', isError: true };
            }
        }

        return null;
    }

    /**
     * 检测消息中是否包含工具结果
     */
    hasToolResults(messages) {
        if (!Array.isArray(messages)) return false;

        for (const msg of messages) {
            // Claude 格式: role: user, content: [{ type: 'tool_result' }]
            if (msg && Array.isArray(msg.content)) {
                if (msg.content.some(block => block && block.type === 'tool_result')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 从消息中提取工具结果
     */
    extractToolResults(messages) {
        const results = [];

        for (const msg of messages) {
            if (msg && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block && block.type === 'tool_result') {
                        // 获取结果内容
                        let resultText = '';
                        if (typeof block.content === 'string') {
                            resultText = block.content;
                        } else if (Array.isArray(block.content)) {
                            resultText = block.content
                                .filter(c => c.type === 'text')
                                .map(c => c.text)
                                .join('\n');
                        }

                        // 调试日志：输出 Claude Code 发送的原始工具结果
                        logger.info('[Warp] extractToolResults - tool_use_id:', block.tool_use_id,
                            'content type:', typeof block.content,
                            'result length:', resultText.length,
                            'result preview:', resultText.substring(0, 100));

                        results.push({
                            toolCallId: block.tool_use_id,
                            result: resultText,
                            isError: block.is_error === true
                        });
                    }
                }
            }
        }

        return results;
    }

    /**
     * 将用户查询中的 Claude Code 工具名称转换为 Warp 工具名称
     * 添加明确的执行指令，强制 Warp 立即调用工具
     * @param {string} query - 用户查询
     * @returns {string} 转换后的查询
     */
    convertToolNamesInQuery(query) {
        if (!query) return query;

        // 不转换 system-reminder 内容
        if (query.includes('<system-reminder>')) {
            return query;
        }

        let convertedQuery = query;
        let toolDetected = null;

        // 中文模式检测
        const cnPatterns = [
            { pattern: /(?:调用|使用|用)\s*[Ww]rite\s*工具/g, tool: 'write' },
            { pattern: /(?:调用|使用|用)\s*[Ee]dit\s*工具/g, tool: 'edit' },
            { pattern: /(?:调用|使用|用)\s*[Rr]ead\s*工具/g, tool: 'read' },
            { pattern: /(?:调用|使用|用)\s*[Bb]ash\s*工具/g, tool: 'bash' },
            { pattern: /(?:调用|使用|用)\s*[Gg]rep\s*工具/g, tool: 'grep' },
            { pattern: /(?:调用|使用|用)\s*[Gg]lob\s*工具/g, tool: 'glob' },
        ];

        // 英文模式检测
        const enPatterns = [
            { pattern: /\b(?:use|call)\s+[Ww]rite\s+tool\b/g, tool: 'write' },
            { pattern: /\b(?:use|call)\s+[Ee]dit\s+tool\b/g, tool: 'edit' },
            { pattern: /\b(?:use|call)\s+[Rr]ead\s+tool\b/g, tool: 'read' },
            { pattern: /\b(?:use|call)\s+[Bb]ash\s+tool\b/g, tool: 'bash' },
            { pattern: /\b(?:use|call)\s+[Gg]rep\s+tool\b/g, tool: 'grep' },
            { pattern: /\b(?:use|call)\s+[Gg]lob\s+tool\b/g, tool: 'glob' },
        ];

        // 检测使用了哪个工具
        for (const { pattern, tool } of [...cnPatterns, ...enPatterns]) {
            if (pattern.test(convertedQuery)) {
                toolDetected = tool;
                // 移除工具调用短语，保留其他内容
                convertedQuery = convertedQuery.replace(pattern, '').trim();
                break;
            }
        }

        // 如果检测到工具调用，添加明确的执行指令
        if (toolDetected) {
            const toolInstructions = {
                write: `[IMPORTANT: You MUST immediately call the applyFileDiffs tool with newFiles to create the file. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
                edit: `[IMPORTANT: You MUST immediately call the applyFileDiffs tool with diffs to edit the file. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
                read: `[IMPORTANT: You MUST immediately call the readFiles tool. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
                bash: `[IMPORTANT: You MUST immediately call the runShellCommand tool. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
                grep: `[IMPORTANT: You MUST immediately call the grep tool. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
                glob: `[IMPORTANT: You MUST immediately call the fileGlob tool. Do NOT just describe what you will do - actually call the tool NOW.]\n\n${convertedQuery}`,
            };
            return toolInstructions[toolDetected] || convertedQuery;
        }

        return convertedQuery;
    }

    /**
     * 增强查询，添加工具调用指令
     * 当检测到用户想要查看/列出/搜索文件时，添加明确的工具调用指令
     */
    enhanceQueryWithToolInstructions(query) {
        if (!query) return query;

        // 跳过 system-reminder 内容
        if (query.includes('<system-reminder>')) {
            return query;
        }

        // 跳过 Claude Code 的系统请求（标题生成、摘要等）
        if (query.includes('Please write a') && query.includes('title for the following conversation')) {
            return query;
        }
        if (query.includes('Respond with the title') || query.includes('nothing else')) {
            return query;
        }
        if (query.includes('summarize') && query.includes('conversation')) {
            return query;
        }

        // 检测需要文件操作的查询模式
        const fileListPatterns = [
            /看看.*(?:项目|目录|文件夹|文件)/i,
            /(?:项目|目录|文件夹).*(?:有什么|内容|结构)/i,
            /(?:列出|显示|查看).*(?:文件|目录)/i,
            /what.*(?:files|project|directory)/i,
            /(?:list|show|view).*(?:files|contents)/i,
            /(?:ls|dir)\b/i
        ];

        for (const pattern of fileListPatterns) {
            if (pattern.test(query)) {
                logger.info('[Warp] Detected file listing query, adding tool instructions');
                return `[IMPORTANT: You MUST use the fileGlob or runShellCommand tool to list files. Do NOT just describe - actually call the tool NOW.]\n\n${query}`;
            }
        }

        // 检测需要读取文件的查询
        const readPatterns = [
            /(?:读取|打开|查看|看看).*(?:文件|内容)/i,
            /(?:read|open|view|show).*(?:file|content)/i
        ];

        for (const pattern of readPatterns) {
            if (pattern.test(query)) {
                logger.info('[Warp] Detected file read query, adding tool instructions');
                return `[IMPORTANT: You MUST use the readFiles tool. Do NOT just describe - actually call the tool NOW.]\n\n${query}`;
            }
        }

        return query;
    }

    /**
     * 获取最后一条用户查询
     * 跳过只包含 system-reminder 或 tool_result 的消息
     */
    getLastUserQuery(messages) {
        logger.info('[Warp] getLastUserQuery - total messages:', messages.length);

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            logger.info('[Warp] Checking message', i, 'role:', msg.role, 'content type:', typeof msg.content);

            if (msg.role === 'user') {
                let queryText = '';

                // 检查是否是纯文本消息
                if (typeof msg.content === 'string') {
                    queryText = msg.content;
                }
                // 检查是否有文本块
                else if (Array.isArray(msg.content)) {
                    // 收集所有文本块
                    const textBlocks = [];
                    let hasToolResult = false;

                    for (const block of msg.content) {
                        if (block.type === 'tool_result') {
                            hasToolResult = true;
                        } else if (block.type === 'text' && block.text) {
                            textBlocks.push(block.text);
                        }
                    }

                    logger.info('[Warp] Message', i, '- textBlocks:', textBlocks.length, 'hasToolResult:', hasToolResult);

                    // 如果只有 tool_result，跳过这条消息
                    if (hasToolResult && textBlocks.length === 0) {
                        logger.info('[Warp] Skipping tool_result only message');
                        continue;
                    }

                    // 合并所有文本块
                    queryText = textBlocks.join('\n');
                }

                // 跳过只包含 system-reminder 的消息
                if (queryText) {
                    const withoutReminder = queryText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
                    logger.info('[Warp] Message', i, '- queryText length:', queryText.length, 'withoutReminder length:', withoutReminder.length);

                    if (!withoutReminder) {
                        // 这条消息只有 system-reminder，继续找上一条
                        logger.info('[Warp] Skipping system-reminder only message');
                        continue;
                    }

                    // 跳过 Claude Code 内部系统请求
                    if (withoutReminder.includes('[SUGGESTION MODE:') ||
                        withoutReminder.includes('SUGGESTION MODE:') ||
                        (withoutReminder.includes('Please write a') && withoutReminder.includes('title for the following conversation')) ||
                        (withoutReminder.includes('Respond with the title') && withoutReminder.includes('nothing else'))) {
                        logger.info('[Warp] Skipping system request message');
                        continue;
                    }

                    let query = this.convertToolNamesInQuery(queryText);
                    return this.enhanceQueryWithToolInstructions(query);
                }
            }
        }

        logger.warn('[Warp] No valid user query found in messages');
        return '';
    }

    /**
     * 从单条消息中提取查询文本
     * @param {Object} message - 消息对象
     * @returns {string} 查询文本
     */
    extractQueryFromMessage(message) {
        if (!message) return '';

        let query = '';
        if (typeof message.content === 'string') {
            query = message.content;
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                    query = block.text;
                    break;
                }
            }
        }

        return this.convertToolNamesInQuery(query);
    }

    /**
     * 检测是否是系统请求（标题生成、摘要、建议等）
     */
    isSystemRequest(messages) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        if (!lastUserMsg) return false;

        let content = '';
        if (typeof lastUserMsg.content === 'string') {
            content = lastUserMsg.content;
        } else if (Array.isArray(lastUserMsg.content)) {
            for (const block of lastUserMsg.content) {
                if (block.type === 'text' && block.text) {
                    content = block.text;
                    break;
                }
            }
        }

        // 检测标题生成请求
        if (content.includes('Please write a') && content.includes('title for the following conversation')) {
            return 'title_generation';
        }
        if (content.includes('Respond with the title') && content.includes('nothing else')) {
            return 'title_generation';
        }

        // 检测 SUGGESTION MODE 请求
        if (content.includes('[SUGGESTION MODE:') || content.includes('SUGGESTION MODE:')) {
            return 'suggestion_mode';
        }

        // 检测摘要请求
        if (content.includes('summarize') && content.includes('conversation')) {
            return 'summary';
        }

        return false;
    }

    /**
     * 构建请求体
     */
    async buildRequestBody(messages, workingDirectory, model, options = {}) {
        // 优先使用 Claude Code 的 session ID，否则使用工作目录
        const claudeSessionId = options.claudeSessionId;
        const sessionKey = options.sessionKeyOverride || (claudeSessionId
            ? `session:${claudeSessionId}`
            : (workingDirectory || 'default'));
        logger.info('[Warp] buildRequestBody - sessionKey:', sessionKey, 'claudeSessionId:', claudeSessionId);
        const session = this.getOrCreateSession(sessionKey);

        // 工具缓存
        if (options.tools && options.tools.length > 0) {
            session.cachedTools = options.tools;
            session._saveToSharedStore(); // 保存到共享存储
            logger.info('[Warp] Cached tools:', options.tools.length);
        } else if (session.cachedTools && session.cachedTools.length > 0) {
            options.tools = session.cachedTools;
            logger.info('[Warp] Using cached tools:', options.tools.length);
        }

        const warpModel = mapToWarpModel(model);
        const homeDir = workingDirectory?.split('/').slice(0, 3).join('/') || '/Users/user';
        const context = { pwd: workingDirectory, home: homeDir };
        logger.info('[Warp] buildRequestBody - workingDirectory:', workingDirectory, 'context.pwd:', context.pwd);
        const supportedTools = getSupportedToolTypes(options.tools || []);

        // 过滤 system 消息
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        logger.info('[Warp] Building request - messages:', nonSystemMessages.length);
        logger.info('[Warp] Session state - conversationId:', session.conversationId, 'taskId:', session.taskId);
        logger.info('[Warp] supportedTools:', supportedTools.length, 'tools:', supportedTools);

        // 1. 检查是否包含工具结果
        if (this.hasToolResults(nonSystemMessages)) {
            logger.info('[Warp] Detected tool results, building tool result request');

            // 如果会话状态为空，尝试从共享存储重新加载
            if (!session.conversationId || !session.taskId) {
                logger.warn('[Warp] Session state missing, attempting to reload from shared store');
                if (session._loadFromSharedStore) {
                    session._loadFromSharedStore();
                    logger.info('[Warp] After reload - conversationId:', session.conversationId, 'taskId:', session.taskId);
                }
            }

            // 如果仍然没有会话状态，作为新会话处理
            if (!session.conversationId || !session.taskId) {
                logger.warn('[Warp] No valid session found, treating as new session');
                // 提取最后一条用户消息作为查询
                const lastUserMessage = nonSystemMessages.filter(m => m.role === 'user').pop();
                const query = this.extractQueryFromMessage(lastUserMessage);
                return buildNewSessionRequest(query, context, warpModel, supportedTools);
            }

            // 提取工具结果
            const toolResults = this.extractToolResults(nonSystemMessages);
            logger.info('[Warp] Tool results:', toolResults.length);

            // 从会话中获取待处理的工具调用，构建正确的工具结果
            // 只处理 Warp 知道的且未发送过的工具调用
            const warpToolResults = [];
            const processedToolCallIds = [];

            for (const tr of toolResults) {
                // 跳过已发送过的工具结果
                if (session.isToolResultSent(tr.toolCallId)) {
                    logger.info('[Warp] Skipping already sent tool result:', tr.toolCallId);
                    continue;
                }

                // 跳过 Claude Code 占位符结果（SUGGESTION MODE 等）
                if (tr.result && tr.result.includes('No tools needed for suggestion')) {
                    logger.info('[Warp] Skipping placeholder tool result:', tr.toolCallId);
                    continue;
                }

                const pendingTool = session.getPendingToolCall(tr.toolCallId);

                // 只处理 Warp 知道的工具调用
                if (!pendingTool) {
                    logger.info('[Warp] Skipping unknown tool result (local execution):', tr.toolCallId);
                    continue;
                }

                const toolName = pendingTool.name || 'Bash';
                const toolArgs = pendingTool.args || {};

                // 调试：输出工具结果内容
                logger.info('[Warp] Building tool result for:', toolName, 'id:', tr.toolCallId,
                    'result length:', tr.result?.length || 0,
                    'result preview:', (tr.result || '').substring(0, 100));

                const warpResult = buildWarpToolResult(
                    toolName,
                    tr.toolCallId,
                    toolArgs,
                    tr.result,
                    tr.isError,
                    context  // 传入上下文
                );
                warpToolResults.push(warpResult);
                processedToolCallIds.push(tr.toolCallId);
            }

            // 如果没有 Warp 知道的工具结果
            if (warpToolResults.length === 0) {
                // 关键修复：如果有 pending 工具调用但 Claude Code 没有返回对应结果
                // 需要给 Warp 发送这些工具的"错误结果"，否则 Warp 会一直等待
                if (session.pendingToolCalls.size > 0) {
                    logger.warn('[Warp] Claude Code ignored Warp tool calls, sending results for:',
                        session.pendingToolCalls.size);

                    // 为所有 pending 工具调用构建结果
                    for (const [toolCallId, toolCall] of session.pendingToolCalls) {
                        // 跳过已发送过的
                        if (session.isToolResultSent(toolCallId)) {
                            continue;
                        }

                        const toolName = toolCall.name || 'Bash';
                        const toolArgs = toolCall.args || {};

                        // 检查是否是内部工具调用
                        if (toolCall._internal) {
                            logger.info('[Warp] Building internal result for:', toolCallId, toolName);
                            const internalResult = buildInternalToolResult(toolCallId, toolName, context);
                            warpToolResults.push(internalResult);
                            processedToolCallIds.push(toolCallId);
                        } else {
                            logger.info('[Warp] Building error result for ignored tool:', toolCallId, toolName);
                            const errorResult = buildWarpToolResult(
                                toolName,
                                toolCallId,
                                toolArgs,
                                'Tool execution skipped by client',
                                true,  // isError = true
                                context
                            );
                            warpToolResults.push(errorResult);
                            processedToolCallIds.push(toolCallId);
                        }
                    }
                }

                // 如果还是没有结果，作为继续会话处理
                if (warpToolResults.length === 0) {
                    logger.info('[Warp] No tool results, treating as continue request');
                    const query = this.getLastUserQuery(nonSystemMessages);
                    return buildContinueRequest(
                        query || '',
                        {
                            conversationId: session.conversationId,
                            taskId: session.taskId,
                            taskDescription: session.taskDescription,
                            messages: session.messages
                        },
                        context,
                        warpModel,
                        supportedTools
                    );
                }
            }

            // 成功构建请求后，标记工具结果已发送，并删除已处理的工具调用
            for (const toolCallId of processedToolCallIds) {
                session.markToolResultSent(toolCallId);
                session.removePendingToolCall(toolCallId);
            }

            // 构建工具结果请求
            return buildToolResultRequest(
                warpToolResults,
                {
                    conversationId: session.conversationId,
                    taskId: session.taskId,
                    taskDescription: session.taskDescription,
                    messages: session.messages
                },
                context,
                warpModel,
                supportedTools
            );
        }

        // 2. 新会话请求
        if (!session.conversationId) {
            logger.info('[Warp] New session, building initial request');
            const query = this.getLastUserQuery(nonSystemMessages);
            if (!query || !query.trim()) {
                logger.warn('[Warp] Empty query for new session, messages:', JSON.stringify(nonSystemMessages.map(m => ({ role: m.role, contentType: typeof m.content }))));
            }
            return buildNewSessionRequest(query || '', context, warpModel, supportedTools);
        }

        // 3. 继续会话请求
        logger.info('[Warp] Continuing session, building continue request');
        const query = this.getLastUserQuery(nonSystemMessages);
        if (!query || !query.trim()) {
            logger.warn('[Warp] Empty query for continue request, messages:', JSON.stringify(nonSystemMessages.map(m => ({ role: m.role, contentType: typeof m.content }))));
        }
        return buildContinueRequest(
            query,
            {
                conversationId: session.conversationId,
                taskId: session.taskId,
                taskDescription: session.taskDescription,
                messages: session.messages
            },
            context,
            warpModel,
            supportedTools
        );
    }

    /**
     * 解析 Warp SSE 响应事件
     */
    parseResponseEvent(buffer) {
        try {
            const event = decodeResponseEvent(buffer);
            return event;
        } catch (error) {
            logger.error('[Warp] Failed to parse response event:', error.message);
            return null;
        }
    }

    /**
     * 处理 Warp 响应事件，提取文本和工具调用
     */
    processResponseEvent(event, session) {
        const result = {
            text: null,
            toolCalls: [],
            isInit: false,
            isTaskCreated: false,
            cancelledToolCallIds: new Set()  // 跟踪被取消的工具调用
        };

        if (!event) return result;

        // 转换为普通对象
        const eventObj = event.toJSON ? event.toJSON() : event;

        logger.info('[Warp] Processing event:', JSON.stringify(eventObj).substring(0, 500));

        // 处理 init 事件
        if (eventObj.init) {
            result.isInit = true;
            if (eventObj.init.conversationId) {
                session.conversationId = eventObj.init.conversationId;
                logger.info('[Warp] Got conversationId from init:', session.conversationId);
                // 保存到共享存储
                if (session._saveToSharedStore) {
                    session._saveToSharedStore();
                }
            }
        }

        // 处理 clientActions
        if (eventObj.clientActions && eventObj.clientActions.actions) {
            const actions = eventObj.clientActions.actions;

            for (const action of actions) {
                // 处理 createTask
                if (action.createTask) {
                    result.isTaskCreated = true;
                    const task = action.createTask.task;
                    if (task) {
                        session.taskId = task.id;
                        session.taskDescription = task.description;
                        logger.info('[Warp] Task created:', session.taskId, session.taskDescription);

                        // 保存初始消息，并处理其中的工具调用
                        if (task.messages && task.messages.length > 0) {
                            for (const msg of task.messages) {
                                session.addMessage(msg);

                                // 检查消息中的工具调用（特别是 server 类型的内部工具调用）
                                if (msg.toolCall) {
                                    const claudeToolCall = convertWarpToolCallToClaude(msg.toolCall);
                                    if (claudeToolCall && claudeToolCall._internal) {
                                        logger.info('[Warp] Adding internal tool call from createTask:', claudeToolCall.id, claudeToolCall.name);
                                        session.addPendingToolCall({
                                            toolCallId: claudeToolCall.id,
                                            name: claudeToolCall.name,
                                            args: claudeToolCall.input,
                                            _internal: true
                                        });
                                    }
                                }
                            }
                        }
                        // 保存到共享存储
                        if (session._saveToSharedStore) {
                            session._saveToSharedStore();
                        }
                    }
                }

                // 处理 addMessagesToTask
                if (action.addMessagesToTask) {
                    const messages = action.addMessagesToTask.messages || [];
                    for (const msg of messages) {
                        session.addMessage(msg);

                        // 提取文本
                        if (msg.agentOutput && msg.agentOutput.text) {
                            result.text = (result.text || '') + msg.agentOutput.text;
                        }

                        // 处理工具调用结果（Warp 服务器执行的结果）
                        if (msg.toolCallResult) {
                            const tcr = msg.toolCallResult;
                            if (tcr.cancel) {
                                // 工具调用被取消，但不要从待处理列表中移除
                                // 因为 Claude Code 可能已经执行了工具，后续会返回结果
                                logger.warn('[Warp] Tool call cancelled:', tcr.toolCallId);
                                // session.pendingToolCalls.delete(tcr.toolCallId); // 不删除！
                                result.cancelledToolCallIds.add(tcr.toolCallId);
                                result.toolCallCancelled = true;
                                // 从 result.toolCalls 中移除已取消的工具调用
                                result.toolCalls = result.toolCalls.filter(tc => tc.id !== tcr.toolCallId);
                            } else {
                                // Warp 回显了我们发送的工具结果
                                const serverResult = this.extractToolResultFromWarp(tcr);
                                if (serverResult) {
                                    logger.info('[Warp] Tool result echoed back:', tcr.toolCallId,
                                        'result length:', serverResult.output?.length || 0);
                                    // 标记这个工具调用已完成
                                    result.serverExecutedToolCalls = result.serverExecutedToolCalls || [];
                                    result.serverExecutedToolCalls.push({
                                        id: tcr.toolCallId,
                                        ...serverResult
                                    });
                                    // 从待处理中移除
                                    session.pendingToolCalls.delete(tcr.toolCallId);
                                    result.cancelledToolCallIds.add(tcr.toolCallId);
                                }
                            }
                        }

                        // 提取工具调用
                        if (msg.toolCall) {
                            const claudeToolCall = convertWarpToolCallToClaude(msg.toolCall);
                            if (claudeToolCall) {
                                // 跳过内部工具调用（如 _WarpServerInit）
                                if (claudeToolCall._internal) {
                                    logger.info('[Warp] Skipping internal tool call:', claudeToolCall.name);
                                    // 内部工具调用也需要添加到 pending，以便发送空结果
                                    session.addPendingToolCall({
                                        toolCallId: claudeToolCall.id,
                                        name: claudeToolCall.name,
                                        args: claudeToolCall.input,
                                        _internal: true
                                    });
                                } else {
                                    logger.info('[Warp] Adding tool call to result:', claudeToolCall.id, claudeToolCall.name);
                                    result.toolCalls.push(claudeToolCall);
                                    // 保存到待处理工具调用
                                    session.addPendingToolCall({
                                        toolCallId: claudeToolCall.id,
                                        name: claudeToolCall.name,
                                        args: claudeToolCall.input
                                    });
                                }
                            }
                        }
                    }
                }

                // 处理 appendToMessageContent (流式文本)
                if (action.appendToMessageContent) {
                    const content = action.appendToMessageContent;
                    if (content.message && content.message.agentOutput && content.message.agentOutput.text) {
                        result.text = (result.text || '') + content.message.agentOutput.text;
                    }
                }

                // 处理 updateTaskMessage
                if (action.updateTaskMessage) {
                    const msg = action.updateTaskMessage.message;
                    if (msg) {
                        session.updateMessage(msg.id, msg);

                        if (msg.agentOutput && msg.agentOutput.text) {
                            result.text = (result.text || '') + msg.agentOutput.text;
                        }

                        if (msg.toolCall) {
                            const claudeToolCall = convertWarpToolCallToClaude(msg.toolCall);
                            if (claudeToolCall) {
                                // 跳过内部工具调用（如 _WarpServerInit）
                                if (claudeToolCall._internal) {
                                    logger.info('[Warp] Skipping internal tool call in updateTaskMessage:', claudeToolCall.name);
                                    // 内部工具调用也需要添加到 pending，以便发送结果
                                    session.addPendingToolCall({
                                        toolCallId: claudeToolCall.id,
                                        name: claudeToolCall.name,
                                        args: claudeToolCall.input,
                                        _internal: true
                                    });
                                } else {
                                    // 检查是否已经在 toolCalls 中（避免重复）
                                    const alreadyExists = result.toolCalls.some(tc => tc.id === claudeToolCall.id);
                                    if (!alreadyExists) {
                                        logger.info('[Warp] Adding tool call from updateTaskMessage:', claudeToolCall.id, claudeToolCall.name);
                                        result.toolCalls.push(claudeToolCall);
                                    }
                                    // 更新 pendingToolCalls（用于流结束后的检查）
                                    session.addPendingToolCall({
                                        toolCallId: claudeToolCall.id,
                                        name: claudeToolCall.name,
                                        args: claudeToolCall.input
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // 处理 finished 事件中的错误
        if (eventObj.finished && eventObj.finished.internalError) {
            const errorMsg = eventObj.finished.internalError.message || '';
            logger.error('[Warp] Internal error:', errorMsg);

            // 如果是任务不存在的错误，标记需要清除会话
            if (errorMsg.includes('non-existent task') || errorMsg.includes('Not found')) {
                result.sessionExpired = true;
                logger.warn('[Warp] Session expired, will clear and retry');
            }
        }

        // 调试：返回前检查 toolCalls
        if (result.toolCalls.length > 0) {
            logger.info('[Warp] processResponseEvent returning with toolCalls:', result.toolCalls.length);
        }

        return result;
    }

    /**
     * 获取跨进程请求锁
     */
    async acquireCrossProcessLock(sessionKey, timeout = 30000) {
        const safeKey = sessionKey.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
        const lockFile = path.join(LOCK_DIR, `lock_${safeKey}.lock`);
        const startTime = Date.now();
        const pollInterval = 50;

        while (Date.now() - startTime < timeout) {
            try {
                // 尝试创建锁文件（排他模式）
                const fd = fs.openSync(lockFile, 'wx');
                fs.writeSync(fd, `${process.pid}:${Date.now()}`);
                fs.closeSync(fd);
                logger.info('[Warp] Acquired cross-process lock for:', safeKey);
                return lockFile;
            } catch (e) {
                if (e.code === 'EEXIST') {
                    // 锁文件存在，检查是否过期（超过30秒视为过期）
                    try {
                        const stat = fs.statSync(lockFile);
                        if (Date.now() - stat.mtimeMs > 30000) {
                            fs.unlinkSync(lockFile);
                            logger.warn('[Warp] Removed stale lock file:', lockFile);
                            continue;
                        }
                    } catch (statErr) {
                        // 文件可能已被删除
                    }
                    await new Promise(r => setTimeout(r, pollInterval));
                } else {
                    throw e;
                }
            }
        }
        throw new Error('Failed to acquire lock: timeout');
    }

    /**
     * 释放跨进程请求锁
     */
    releaseCrossProcessLock(lockFile) {
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                logger.info('[Warp] Released cross-process lock:', lockFile);
            }
        } catch (e) {
            logger.warn('[Warp] Failed to release lock:', e.message);
        }
    }

    /**
     * 流式处理 Warp 响应
     */
    async *streamWarpResponse(messages, workingDirectory, model, options = {}, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 检测是否是系统请求（标题生成等）
        const systemRequestType = this.isSystemRequest(messages);
        const isEphemeralSystemSession = Boolean(systemRequestType);

        // 优先使用 Claude Code 的 session ID，否则使用工作目录
        const claudeSessionId = options.claudeSessionId;
        let sessionKey = claudeSessionId
            ? `session:${claudeSessionId}`
            : (workingDirectory || 'default');

        // 对系统请求使用独立的会话键，避免干扰实际用户查询
        if (systemRequestType) {
            sessionKey = `${sessionKey}:${systemRequestType}:${Date.now()}`;
            logger.info('[Warp] System request detected:', systemRequestType, 'using isolated session');
        }

        logger.info('[Warp] streamWarpResponse - sessionKey:', sessionKey, 'claudeSessionId:', claudeSessionId);

        // 使用跨进程文件锁确保请求串行处理
        let lockFile = null;
        let session = null;
        try {
            lockFile = await this.acquireCrossProcessLock(sessionKey);
        } catch (e) {
            logger.error('[Warp] Failed to acquire lock:', e.message);
            throw e;
        }

        try {
            session = this.getOrCreateSession(sessionKey);

            // 注意：不再在重试时清除会话，保持会话状态以确保后续请求成功

            const requestBody = await this.buildRequestBody(messages, workingDirectory, model, {
                ...options,
                sessionKeyOverride: sessionKey
            });
            logger.info('[Warp] Request body size:', requestBody.length, 'bytes');

            // 调试：保存请求体
            try {
                const fs = await import('fs');
                fs.writeFileSync('/tmp/warp-request.bin', requestBody);
                logger.info('[Warp] Request saved to /tmp/warp-request.bin');
            } catch (e) {
                // 忽略
            }

            let lineCount = 0;
            let hasContent = false;
            let sessionExpired = false;
            const emittedToolCallIds = new Set(); // 跟踪已输出的工具调用
            const cancelledToolCallIds = new Set(); // 跟踪被取消的工具调用

            for await (const line of this.makeHttp2StreamRequest(requestBody)) {
                lineCount++;

                if (!line.trim()) continue;

                if (line.startsWith('data:')) {
                    const payload = line.slice(5).trim();

                    if (!payload || payload === '[DONE]') {
                        continue;
                    }

                    try {
                        // 解码 protobuf
                        const buffer = decodeWarpPayload(payload);
                        const event = this.parseResponseEvent(buffer);

                        if (event) {
                            const processed = this.processResponseEvent(event, session);

                            // 调试：输出 processed 结果
                            if (processed.toolCalls && processed.toolCalls.length > 0) {
                                logger.info('[Warp] processResponseEvent returned toolCalls:', processed.toolCalls.length);
                            }

                            // 检测会话过期
                            if (processed.sessionExpired) {
                                sessionExpired = true;
                            }

                            // 收集被取消的工具调用 ID
                            if (processed.cancelledToolCallIds) {
                                for (const id of processed.cancelledToolCallIds) {
                                    cancelledToolCallIds.add(id);
                                    logger.info('[Warp] Recorded cancelled tool call:', id);
                                }
                            }

                            // 输出文本
                            if (processed.text) {
                                hasContent = true;
                                yield { type: 'text', text: processed.text };
                            }

                            // 输出工具调用（跳过被服务器执行或取消的）
                            for (const tc of processed.toolCalls) {
                                // 跳过被取消或服务器已执行的工具调用
                                if (cancelledToolCallIds.has(tc.id)) {
                                    logger.info('[Warp] Skipping server-handled tool call:', tc.id);
                                    continue;
                                }
                                // 跳过已经输出过的工具调用
                                if (session.isToolCallEmitted(tc.id) || emittedToolCallIds.has(tc.id)) {
                                    logger.info('[Warp] Skipping already emitted tool call in stream:', tc.id);
                                    continue;
                                }
                                hasContent = true;
                                emittedToolCallIds.add(tc.id);
                                session.markToolCallEmitted(tc.id);  // 持久化到会话状态
                                logger.info('[Warp] Yielding tool call:', tc.id, tc.name);
                                yield {
                                    type: 'tool_call',
                                    tool_call: {
                                        id: tc.id,
                                        name: tc.name,
                                        args: tc.input || {}
                                    }
                                };
                            }

                            // 输出服务器执行的工具结果（作为文本）
                            if (processed.serverExecutedToolCalls) {
                                for (const stc of processed.serverExecutedToolCalls) {
                                    if (stc.output) {
                                        hasContent = true;
                                        logger.info('[Warp] Outputting server tool result:', stc.id, stc.type);
                                        // 不输出原始结果，Warp 会继续处理并生成回复
                                    }
                                }
                            }
                        }
                    } catch (parseError) {
                        logger.error('[Warp] Parse error:', parseError.message);
                    }
                }
            }

            logger.info('[Warp] Stream ended. Lines:', lineCount, 'hasContent:', hasContent);

            // 检查是否有待处理的工具调用需要输出
            // Warp 可能分多次发送工具调用，第一次命令为空，后续更新才有完整参数
            if (session.pendingToolCalls && session.pendingToolCalls.size > 0) {
                logger.info('[Warp] Checking pending tool calls:', session.pendingToolCalls.size);
                for (const [toolCallId, toolCall] of session.pendingToolCalls) {
                    // 跳过已经输出过的工具调用（使用会话状态跟踪）
                    if (session.isToolCallEmitted(toolCallId) || emittedToolCallIds.has(toolCallId)) {
                        logger.info('[Warp] Skipping already emitted tool call:', toolCallId);
                        continue;
                    }
                    // 跳过被取消的工具调用
                    if (cancelledToolCallIds.has(toolCallId)) {
                        logger.info('[Warp] Skipping cancelled pending tool call:', toolCallId);
                        continue;
                    }
                    // 检查工具调用是否有完整参数
                    if (toolCall.name && toolCall.args) {
                        const hasValidArgs = Object.keys(toolCall.args).length > 0 &&
                            (toolCall.args.command || toolCall.args.file_path || toolCall.args.pattern);
                        if (hasValidArgs) {
                            logger.info('[Warp] Outputting pending tool call:', toolCallId, toolCall.name);
                            hasContent = true;
                            emittedToolCallIds.add(toolCallId);
                            session.markToolCallEmitted(toolCallId);  // 持久化到会话状态
                            yield {
                                type: 'tool_call',
                                tool_call: {
                                    id: toolCallId,
                                    name: toolCall.name,
                                    args: toolCall.args
                                }
                            };
                        }
                    }
                }
            }

            // 空响应重试
            // 会话过期时，清除会话并重试
            if (sessionExpired && retryCount < maxRetries) {
                logger.warn('[Warp] Session expired, clearing session and retrying...');
                this._evictSession(sessionKey, true);
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamWarpResponse(messages, workingDirectory, model, options, retryCount + 1);
                return;
            }

            // 空响应重试（非会话过期情况）
            // 注意：如果有工具被取消，说明 Warp 服务器已处理，不应重试
            // 如果还有待处理的工具调用，也不应重试，应该等待工具结果
            const hasServerActivity = cancelledToolCallIds.size > 0;
            const hasPendingTools = session.pendingToolCalls.size > 0;

            if (!hasContent && !hasServerActivity && !hasPendingTools && retryCount < maxRetries) {
                logger.warn('[Warp] Empty response, retrying... (keeping session state)');
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamWarpResponse(messages, workingDirectory, model, options, retryCount + 1);
                return;
            }

            // 如果有待处理的工具调用，批量输出它们而不是重试
            if (!hasContent && hasPendingTools) {
                logger.info('[Warp] Has pending tool calls, batch outputting them instead of retrying');
                const unemittedTools = session.getUnemittedToolCalls();

                // 批量输出所有未发送的工具调用
                for (const toolCall of unemittedTools) {
                    const claudeToolCall = convertWarpToolCallToClaude(toolCall);
                    if (claudeToolCall && !claudeToolCall._internal) {
                        // 检查是否有有效参数
                        const hasValidArgs = claudeToolCall.input && Object.keys(claudeToolCall.input).length > 0;
                        if (!hasValidArgs) {
                            logger.info('[Warp] Skipping tool call with empty args:', toolCall.toolCallId);
                            continue;
                        }

                        session.markToolCallEmitted(toolCall.toolCallId);
                        emittedToolCallIds.add(toolCall.toolCallId);
                        hasContent = true;
                        logger.info('[Warp] Batch outputting pending tool call:', toolCall.toolCallId, claudeToolCall.name);

                        // 使用与上面一致的 tool_call 格式
                        yield {
                            type: 'tool_call',
                            tool_call: {
                                id: claudeToolCall.id,
                                name: claudeToolCall.name,
                                args: claudeToolCall.input || {}
                            }
                        };
                    }
                }
            }

            // 如果 Warp 取消了工具但没有返回内容，说明服务器正在处理
            if (!hasContent && hasServerActivity) {
                logger.info('[Warp] Server handled tools, waiting for next request');
            }
        } catch (error) {
            const status = error.status || error.response?.status;

            if ((status === 401 || status === 403) && retryCount < 1) {
                await this.initializeAuth(true);
                yield* this.streamWarpResponse(messages, workingDirectory, model, options, retryCount + 1);
                return;
            }

            const isNetworkError = isRetryableNetworkError(error);
            if ((status === 429 || (status >= 500 && status < 600) || isNetworkError) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamWarpResponse(messages, workingDirectory, model, options, retryCount + 1);
                return;
            }

            throw error;
        } finally {
            // 释放跨进程锁
            if (lockFile) {
                this.releaseCrossProcessLock(lockFile);
            }

            // 系统请求会话只用于当前请求，结束后立刻清理，避免长期累积。
            if (isEphemeralSystemSession && sessionKey) {
                this._evictSession(sessionKey, true);
            } else if (sessionKey && this.sessions.has(sessionKey)) {
                this._touchSession(sessionKey);
            }
        }
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (this.isExpiryDateNear()) {
            await this.initializeAuth(true);
        }

        const messages = requestBody?.messages || [];
        const workingDirectory = resolveWorkingDirectory(requestBody, this.config);
        const requestModel = requestBody?.model || model;
        const tools = requestBody?.tools || [];
        const claudeSessionId = extractSessionIdFromMetadata(requestBody);

        let fullText = '';
        const toolCalls = [];

        for await (const chunk of this.streamWarpResponse(messages, workingDirectory, requestModel, { tools, claudeSessionId })) {
            if (chunk?.type === 'text') {
                fullText += chunk.text || '';
            } else if (chunk?.type === 'tool_call' && chunk.tool_call) {
                toolCalls.push({
                    id: chunk.tool_call.id,
                    name: chunk.tool_call.name,
                    input: chunk.tool_call.args || {}
                });
            }
        }

        return buildClaudeMessageResponse(requestModel || model, fullText, toolCalls);
    }

    /**
     * 生成内容（流式）- Claude SSE 格式
     */
    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (this.isExpiryDateNear()) {
            await this.initializeAuth(true);
        }

        const messages = requestBody?.messages || [];
        const workingDirectory = resolveWorkingDirectory(requestBody, this.config);
        const requestModel = requestBody?.model || model;
        const tools = requestBody?.tools || [];
        const claudeSessionId = extractSessionIdFromMetadata(requestBody);
        const messageId = `msg_${uuidv4()}`;

        // 状态追踪
        const streamState = {
            textBlockIndex: null,
            toolBlockIndices: new Map(),
            nextBlockIndex: 0,
            stoppedBlocks: new Set(),
            hasStarted: false,
            hasToolCalls: false,
            emittedToolCallIds: new Set()  // 跟踪已输出的工具调用ID，用于去重
        };

        // 辅助函数
        const ensureMessageStart = () => {
            if (streamState.hasStarted) return [];
            streamState.hasStarted = true;
            return [{
                message: {
                    content: [],
                    id: messageId,
                    model: model || WARP_CONSTANTS.DEFAULT_MODEL,
                    role: 'assistant',
                    stop_reason: null,
                    stop_sequence: null,
                    type: 'message',
                    usage: { input_tokens: 0, output_tokens: 0 }
                },
                type: 'message_start'
            }];
        };

        const ensureTextBlockStart = () => {
            if (streamState.textBlockIndex !== null) return [];
            const idx = streamState.nextBlockIndex++;
            streamState.textBlockIndex = idx;
            return [{
                content_block: { text: '', type: 'text' },
                index: idx,
                type: 'content_block_start'
            }];
        };

        const ensureToolBlockStart = (toolCall) => {
            if (streamState.toolBlockIndices.has(toolCall.id)) return [];
            const idx = streamState.nextBlockIndex++;
            streamState.toolBlockIndices.set(toolCall.id, idx);
            return [{
                content_block: {
                    id: toolCall.id,
                    input: {},
                    name: toolCall.name,
                    type: 'tool_use'
                },
                index: idx,
                type: 'content_block_start'
            }];
        };

        const stopBlock = (index) => {
            if (index == null || streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ index, type: 'content_block_stop' }];
        };

        // 1. message_start
        for (const event of ensureMessageStart()) {
            yield event;
        }

        // 2. 处理流
        let hasContent = false;

        for await (const chunk of this.streamWarpResponse(messages, workingDirectory, requestModel, { tools, claudeSessionId })) {
            if (!chunk) continue;

            // 文本
            if (chunk.type === 'text' && chunk.text) {
                for (const event of ensureTextBlockStart()) {
                    yield event;
                }
                hasContent = true;

                yield {
                    delta: { text: chunk.text, type: 'text_delta' },
                    index: streamState.textBlockIndex,
                    type: 'content_block_delta'
                };
                continue;
            }

            // 工具调用
            if (chunk.type === 'tool_call' && chunk.tool_call) {
                const tc = chunk.tool_call;
                logger.info('[Warp] generateContentStream received tool_call:', tc.id, tc.name);

                // 检查是否已经输出过这个工具调用（通过 ID 去重）
                if (streamState.emittedToolCallIds.has(tc.id)) {
                    logger.info('[Warp] Skipping duplicate tool call:', tc.id);
                    continue;
                }

                // 过滤无效参数
                const filteredArgs = { ...tc.args };
                delete filteredArgs.description;

                tc.args = filteredArgs;
                streamState.hasToolCalls = true;
                streamState.emittedToolCallIds.add(tc.id);

                // 关闭文本块
                if (streamState.textBlockIndex !== null && !streamState.stoppedBlocks.has(streamState.textBlockIndex)) {
                    for (const event of stopBlock(streamState.textBlockIndex)) {
                        yield event;
                    }
                }

                // 开始工具块
                for (const event of ensureToolBlockStart(tc)) {
                    yield event;
                }
                hasContent = true;

                const blockIndex = streamState.toolBlockIndices.get(tc.id);

                if (tc.args) {
                    yield {
                        delta: {
                            partial_json: JSON.stringify(tc.args),
                            type: 'input_json_delta'
                        },
                        index: blockIndex,
                        type: 'content_block_delta'
                    };
                }
            }
        }

        // 3. 无内容时发送错误
        if (!hasContent) {
            logger.warn('[Warp] No content received, sending error');
            for (const event of ensureTextBlockStart()) {
                yield event;
            }
            yield {
                delta: {
                    text: "[Warp API returned empty response. Please try again.]",
                    type: 'text_delta'
                },
                index: streamState.textBlockIndex,
                type: 'content_block_delta'
            };
        }

        // 4. content_block_stop
        if (streamState.textBlockIndex !== null) {
            for (const event of stopBlock(streamState.textBlockIndex)) {
                yield event;
            }
        }
        for (const [, blockIndex] of streamState.toolBlockIndices) {
            for (const event of stopBlock(blockIndex)) {
                yield event;
            }
        }

        // 5. message_delta
        yield {
            delta: {
                stop_reason: streamState.hasToolCalls ? 'tool_use' : 'end_turn',
                stop_sequence: null
            },
            type: 'message_delta',
            usage: { output_tokens: 0 }
        };

        // 6. message_stop
        yield { type: 'message_stop' };
    }

    async listModels() {
        if (WARP_MODELS.length === 0) {
            return { data: [] };
        }
        return {
            data: WARP_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'warp'
            }))
        };
    }
}
