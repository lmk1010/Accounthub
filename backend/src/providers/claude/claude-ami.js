import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
import { getProviderModels } from '../provider-models.js';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { loadCredentialsFromConfig } from '../../services/oauth-credentials-store.js';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';

// AMI 常量配置
const AMI_CONSTANTS = {
    BASE_URL: 'https://app.ami.dev/api/v1/agent/v2',
    USAGE_URL: 'https://app.ami.dev/api/v1/trpc/pricing.usage,pricing.customer',
    SESSION_URL: 'https://app.ami.dev/api/v1/trpc/user.session.get',
    AGENT_URL: 'https://app.ami.dev',
    DEFAULT_MODEL: 'anthropic/claude-opus-4.5',
    AXIOS_TIMEOUT: 120000,
    USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ami/0.0.8 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36',
    CONTENT_TYPE: 'application/json',
    ORIGIN: 'https://app.ami.dev',
    TOTAL_CONTEXT_TOKENS: 200000,
};

// 模型映射
const AMI_MODEL_MAPPING = {
    'claude-opus-4-5': 'anthropic/claude-opus-4.5',
    'claude-opus-4-5-20251101': 'anthropic/claude-opus-4.5',
    'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4-6-20260217': 'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4-5-20250929': 'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4': 'anthropic/claude-sonnet-4',
    'claude-sonnet-4-20250514': 'anthropic/claude-sonnet-4',
    'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
    'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
};

// 工具版本号
const TOOL_VERSION = '021025';

/**
 * 规范化模型名称
 */
function normalizeModelName(model) {
    if (!model) return AMI_CONSTANTS.DEFAULT_MODEL;
    const m = model.toLowerCase();
    if (m.includes('opus-4')) return 'anthropic/claude-opus-4.5';
    if (m.includes('sonnet-4-5') || m.includes('sonnet-4.5')) return 'anthropic/claude-sonnet-4.5';
    if (m.includes('sonnet-4')) return 'anthropic/claude-sonnet-4';
    if (m.includes('haiku-4')) return 'anthropic/claude-haiku-4.5';
    return AMI_MODEL_MAPPING[model] || AMI_CONSTANTS.DEFAULT_MODEL;
}

/**
 * 生成消息 ID
 */
function generateMessageId() {
    return uuidv4().replace(/-/g, '').substring(0, 21);
}

export { normalizeModelName };

/**
 * AMI API Service
 * 提供 Claude Code 兼容的 API 接口
 */
export class AmiApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_AMI ?? false;
        this.uuid = config?.uuid;
        this.wosSession = null;
        this.axiosInstance = null;
        console.log(`[AMI] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[AMI] Initializing AMI API Service...');

        // 配置 HTTP Agent
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: AMI_CONSTANTS.AXIOS_TIMEOUT,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: AMI_CONSTANTS.AXIOS_TIMEOUT,
        });

        const axiosConfig = {
            timeout: AMI_CONSTANTS.AXIOS_TIMEOUT,
            httpAgent,
            httpsAgent,
            maxRedirects: 5,
            validateStatus: status => status < 500,
        };

        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }

        configureAxiosProxy(axiosConfig, this.config, 'claude-ami-oauth');
        this.axiosInstance = axios.create(axiosConfig);

        this.isInitialized = true;
        console.log('[AMI] AMI API Service initialized');
    }

    /**
     * 生成请求头
     */
    _generateHeaders(wosSession, contentLength = null) {
        const headers = {
            'host': 'app.ami.dev',
            'content-type': AMI_CONSTANTS.CONTENT_TYPE,
            'content-encoding': 'gzip',
            'user-agent': AMI_CONSTANTS.USER_AGENT,
            'accept': '*/*',
            'origin': AMI_CONSTANTS.ORIGIN,
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'accept-language': 'zh-CN',
            'cookie': `wos-session=${wosSession}`,
        };
        if (contentLength !== null) {
            headers['content-length'] = contentLength;
        }
        return headers;
    }

    /**
     * 将 Claude 格式的 content 转换为 AMI 的 parts 格式
     * @param {*} content - Claude 格式的 content
     * @param {string} role - 消息角色 (user/assistant)
     */
    _convertContentToParts(content, role) {
        if (!content) return [];
        if (typeof content === 'string') {
            // user 消息不需要 state 字段
            return [{ type: 'text', text: content }];
        }
        if (!Array.isArray(content)) return [];

        const parts = [];
        const isAssistant = role === 'assistant';

        for (const block of content) {
            if (block.type === 'text') {
                // 只有 assistant 消息才添加 state 字段
                const part = { type: 'text', text: block.text };
                if (isAssistant) part.state = 'done';
                parts.push(part);
            } else if (block.type === 'thinking') {
                parts.push({
                    type: 'reasoning',
                    text: block.thinking || '',
                    state: 'done'
                });
            } else if (block.type === 'tool_use') {
                const toolName = `${block.name}_${TOOL_VERSION}`;
                parts.push({
                    type: `tool-${toolName}`,
                    toolCallId: block.id,
                    state: 'partial-call',
                    input: block.input
                });
            }
        }
        return parts;
    }

    /**
     * 合并 tool_result 到对应的 tool part
     */
    _mergeToolResults(messages) {
        const toolResultMap = new Map();

        // 收集所有 tool_result
        for (const msg of messages) {
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        toolResultMap.set(block.tool_use_id, {
                            type: 'success',
                            result: this._extractToolResultContent(block.content),
                            context: []
                        });
                    }
                }
            }
        }
        return toolResultMap;
    }

    /**
     * 提取 tool_result 内容
     */
    _extractToolResultContent(content) {
        if (typeof content === 'string') return { text: content };
        if (Array.isArray(content)) {
            const texts = content.filter(c => c.type === 'text').map(c => c.text);
            return { text: texts.join('\n') };
        }
        return { text: '' };
    }

    /**
     * 转换 Claude 消息为 AMI 格式
     */
    _convertMessages(messages, model) {
        const toolResultMap = this._mergeToolResults(messages);
        const amiMessages = [];

        for (const msg of messages) {
            // 跳过只包含 tool_result 的 user 消息
            if (msg.role === 'user') {
                const hasOnlyToolResult = Array.isArray(msg.content) &&
                    msg.content.every(c => c.type === 'tool_result');
                if (hasOnlyToolResult) continue;
            }

            const amiMsg = {
                id: generateMessageId(),
                role: msg.role,
                parts: []
            };

            if (msg.role === 'assistant') {
                amiMsg.parts.push({ type: 'step-start' });
                amiMsg.metadata = {
                    createdAt: Date.now().toString(),
                    updatedAt: Date.now().toString(),
                    model: normalizeModelName(model)
                };
            }

            // 转换 content 为 parts
            const parts = this._convertContentToParts(msg.content, msg.role);
            amiMsg.parts.push(...parts);

            amiMessages.push(amiMsg);
        }

        return amiMessages;
    }

    /**
     * 构建 AMI 请求体
     */
    _buildRequestBody(messages, model, context = {}) {
        const amiMessages = this._convertMessages(messages, model);

        // 添加最后的空 assistant 消息作为响应占位符
        // AMI 期望最后一条消息是空的 assistant 消息，model 为 "optimistic"
        amiMessages.push({
            id: generateMessageId(),
            role: 'assistant',
            parts: [],
            metadata: {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                model: 'optimistic'
            }
        });

        return {
            messages: amiMessages,
            agentUrl: AMI_CONSTANTS.AGENT_URL,
            context: {
                environment: {
                    cwd: context.cwd || process.cwd(),
                    homeDir: context.homeDir || os.homedir(),
                    workingDirectory: context.workingDirectory || process.cwd(),
                    isGitRepo: context.isGitRepo || false,
                    allFiles: context.allFiles || []
                }
            }
        };
    }

    /**
     * 解析 AMI SSE 事件
     */
    _parseSSEEvent(line) {
        if (!line.startsWith('data: ')) return null;
        const data = line.substring(6);
        if (data === '[DONE]') return { type: 'done' };
        try {
            return JSON.parse(data);
        } catch (e) {
            console.error('[AMI] Failed to parse SSE:', data);
            return null;
        }
    }

    /**
     * 发送流式请求到 AMI
     */
    async streamChat(params, wosSession, onData, onError, onEnd) {
        await this.initialize();

        const { messages, model, context } = params;
        const requestBody = this._buildRequestBody(messages, model, context);

        // Gzip 压缩请求体
        const jsonBody = JSON.stringify(requestBody);
        const compressedBody = await gzip(Buffer.from(jsonBody, 'utf-8'));
        const headers = this._generateHeaders(wosSession, compressedBody.length);

        console.log('[AMI] Sending stream request...');

        try {
            const response = await this.axiosInstance({
                method: 'POST',
                url: AMI_CONSTANTS.BASE_URL,
                headers,
                data: compressedBody,
                responseType: 'stream',
            });

            return this._handleStreamResponse(response, onData, onError, onEnd);
        } catch (error) {
            console.error('[AMI] Request failed:', error.message);
            if (onError) onError(error);
            throw error;
        }
    }

    /**
     * 处理流式响应
     */
    async _handleStreamResponse(response, onData, onError, onEnd) {
        const stream = response.data;
        let buffer = '';

        // 状态跟踪
        const state = {
            messageId: null,
            thinkingContent: '',
            textContent: '',
            toolCalls: [],
            currentToolCall: null,
        };

        return new Promise((resolve, reject) => {
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const event = this._parseSSEEvent(line);
                    if (!event) continue;

                    this._processEvent(event, state, onData);
                }
            });

            stream.on('end', () => {
                if (onEnd) onEnd(state);
                resolve(state);
            });

            stream.on('error', (err) => {
                if (onError) onError(err);
                reject(err);
            });
        });
    }

    /**
     * 处理单个 SSE 事件
     */
    _processEvent(event, state, onData) {
        switch (event.type) {
            case 'start':
                state.messageId = event.messageId;
                break;
            case 'reasoning-delta':
                state.thinkingContent += event.delta || '';
                if (onData) onData({ type: 'thinking', delta: event.delta });
                break;
            case 'text-delta':
                state.textContent += event.delta || '';
                if (onData) onData({ type: 'text', delta: event.delta });
                break;
            case 'tool-input-available':
                state.toolCalls.push({
                    id: event.toolCallId,
                    name: event.toolName,
                    input: event.input
                });
                if (onData) onData({ type: 'tool_use', data: event });
                break;
            case 'finish':
                if (onData) onData({ type: 'finish', reason: event.finishReason });
                break;
        }
    }

    /**
     * 从工具名称中提取原始名称（去除版本号）
     */
    _extractToolName(toolName) {
        if (!toolName) return toolName;
        const match = toolName.match(/^(.+)_\d+$/);
        return match ? match[1] : toolName;
    }

    /**
     * 获取 wos-session（从配置或数据库）
     */
    async _getWosSession() {
        // 直接从 config 中获取（如果已经加载）
        if (this.wosSession) {
            return this.wosSession;
        }

        // 从数据库加载凭据
        try {
            const { credentials } = await loadCredentialsFromConfig(
                this.config,
                'AMI_WOS_SESSION',
                'AMI'
            );
            if (credentials?.AMI_WOS_SESSION) {
                this.wosSession = credentials.AMI_WOS_SESSION;
                console.log('[AMI] Loaded wos-session from database');
                return this.wosSession;
            }
        } catch (error) {
            console.error('[AMI] Failed to load credentials:', error.message);
        }

        throw new Error('[AMI] No wos-session available');
    }

    /**
     * 非流式生成内容（Claude 格式）
     */
    async generateContent(model, requestBody) {
        await this.initialize();
        const wosSession = await this._getWosSession();
        const normalizedModel = normalizeModelName(model);

        const content = [];
        let stopReason = 'end_turn';

        await this.streamChat(
            { messages: requestBody.messages, model, context: {} },
            wosSession,
            (data) => {
                // 收集所有内容
            },
            (error) => { throw error; },
            (state) => {
                if (state.thinkingContent) {
                    content.push({
                        type: 'thinking',
                        thinking: state.thinkingContent
                    });
                }
                if (state.textContent) {
                    content.push({
                        type: 'text',
                        text: state.textContent
                    });
                }
                for (const tool of state.toolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: tool.id,
                        name: this._extractToolName(tool.name),
                        input: tool.input
                    });
                    stopReason = 'tool_use';
                }
            }
        );

        return {
            id: `msg_${generateMessageId()}`,
            type: 'message',
            role: 'assistant',
            content,
            model: normalizedModel,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0
            }
        };
    }

    /**
     * 流式生成内容（Claude SSE 格式）
     */
    async *generateContentStream(model, requestBody) {
        await this.initialize();
        const wosSession = await this._getWosSession();
        const normalizedModel = normalizeModelName(model);
        const messageId = `msg_${generateMessageId()}`;

        const { messages } = requestBody;
        const amiRequestBody = this._buildRequestBody(messages, model, {});

        // 调试：打印请求体
        console.log('[AMI] Request body:', JSON.stringify(amiRequestBody, null, 2).substring(0, 2000));

        // Gzip 压缩请求体
        const jsonBody = JSON.stringify(amiRequestBody);
        const compressedBody = await gzip(Buffer.from(jsonBody, 'utf-8'));
        const headers = this._generateHeaders(wosSession, compressedBody.length);

        // 发送 message_start
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: normalizedModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        };

        let response;
        try {
            response = await this.axiosInstance({
                method: 'POST',
                url: AMI_CONSTANTS.BASE_URL,
                headers,
                data: compressedBody,
                responseType: 'stream',
            });
        } catch (error) {
            console.error('[AMI] Stream request failed:', error.message);
            throw error;
        }

        // 处理流式响应
        const stream = response.data;
        let buffer = '';
        let contentIndex = 0;
        let currentBlockType = null;
        let stopReason = 'end_turn';

        const eventQueue = [];
        let streamEnded = false;
        let streamError = null;

        stream.on('data', (chunk) => {
            const chunkStr = chunk.toString();
            console.log('[AMI SSE Raw]', chunkStr.substring(0, 500));
            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                const event = this._parseSSEEvent(line);
                if (event) {
                    console.log('[AMI SSE Event]', JSON.stringify(event).substring(0, 300));
                    eventQueue.push(event);
                }
            }
        });

        stream.on('end', () => { streamEnded = true; });
        stream.on('error', (err) => { streamError = err; });

        // 异步迭代事件队列
        while (!streamEnded || eventQueue.length > 0) {
            if (streamError) throw streamError;

            if (eventQueue.length === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }

            const event = eventQueue.shift();
            const claudeEvents = this._convertAmiEventToClaude(event, contentIndex, currentBlockType);

            for (const claudeEvent of claudeEvents) {
                if (claudeEvent.type === 'content_block_start') {
                    currentBlockType = claudeEvent.content_block?.type;
                    contentIndex = claudeEvent.index;
                }
                if (claudeEvent.type === 'content_block_stop') {
                    contentIndex++;
                    currentBlockType = null;
                }
                if (claudeEvent.stopReason) {
                    stopReason = claudeEvent.stopReason;
                }
                yield claudeEvent;
            }
        }

        // 发送 message_delta 和 message_stop
        yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 0 }
        };

        yield { type: 'message_stop' };
    }

    /**
     * 将 AMI 事件转换为 Claude SSE 事件
     */
    _convertAmiEventToClaude(event, contentIndex, currentBlockType) {
        const events = [];

        switch (event.type) {
            case 'reasoning-start':
                events.push({
                    type: 'content_block_start',
                    index: contentIndex,
                    content_block: { type: 'thinking', thinking: '' }
                });
                break;

            case 'reasoning-delta':
                if (event.delta) {
                    events.push({
                        type: 'content_block_delta',
                        index: contentIndex,
                        delta: { type: 'thinking_delta', thinking: event.delta }
                    });
                }
                break;

            case 'reasoning-end':
                events.push({
                    type: 'content_block_stop',
                    index: contentIndex
                });
                break;

            case 'text-start':
                events.push({
                    type: 'content_block_start',
                    index: contentIndex,
                    content_block: { type: 'text', text: '' }
                });
                break;

            case 'text-delta':
                if (event.delta) {
                    events.push({
                        type: 'content_block_delta',
                        index: contentIndex,
                        delta: { type: 'text_delta', text: event.delta }
                    });
                }
                break;

            case 'text-end':
                events.push({
                    type: 'content_block_stop',
                    index: contentIndex
                });
                break;

            case 'tool-input-available':
                const toolName = this._extractToolName(event.toolName);
                events.push({
                    type: 'content_block_start',
                    index: contentIndex,
                    content_block: {
                        type: 'tool_use',
                        id: event.toolCallId,
                        name: toolName,
                        input: {}
                    }
                });
                events.push({
                    type: 'content_block_delta',
                    index: contentIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify(event.input)
                    }
                });
                events.push({
                    type: 'content_block_stop',
                    index: contentIndex,
                    stopReason: 'tool_use'
                });
                break;

            case 'finish':
                // finish 事件不直接转换，由外层处理
                break;
        }

        return events;
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        await this.initialize();
        const wosSession = await this._getWosSession();

        // 构建 tRPC 查询参数
        const input = JSON.stringify({
            "0": {
                "daysAgo": 30,
                "valueGroupingWindow": "day",
                "timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"
            }
        });

        const url = `${AMI_CONSTANTS.USAGE_URL}?batch=1&input=${encodeURIComponent(input)}`;

        const headers = {
            'host': 'app.ami.dev',
            'user-agent': AMI_CONSTANTS.USER_AGENT,
            'accept': '*/*',
            'trpc-accept': 'application/jsonl',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'referer': 'https://app.ami.dev/usage',
            'accept-language': 'zh-CN',
            'cookie': `wos-session=${wosSession}`,
        };

        try {
            const response = await this.axiosInstance.get(url, { headers });
            return this._parseUsageResponse(response.data);
        } catch (error) {
            console.error('[AMI] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 解析 tRPC JSONL 用量响应
     */
    _parseUsageResponse(data) {
        try {
            // tRPC 返回 JSONL 格式，需要解析
            const lines = typeof data === 'string' ? data.split('\n').filter(l => l.trim()) : [JSON.stringify(data)];

            let customer = null;
            let usage = null;

            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    // 查找客户信息
                    if (parsed[3]?.[0]?.[0]?.customer) {
                        customer = parsed[3][0][0].customer;
                    }
                    // 查找用量信息
                    if (parsed[5]?.[0]?.[0]?.rows) {
                        usage = parsed[5][0][0];
                    }
                } catch (e) {
                    // 跳过无法解析的行
                }
            }

            // 汇总 token 用量
            const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
            if (usage?.rows) {
                for (const row of usage.rows) {
                    const tokenType = row.dimensions?.token_type;
                    if (tokenType && tokenUsage.hasOwnProperty(tokenType)) {
                        tokenUsage[tokenType] += row.value || 0;
                    }
                }
            }

            return {
                customer: customer ? {
                    id: customer.id,
                    email: customer.email,
                    name: customer.name
                } : null,
                usage: {
                    refreshedAt: usage?.refreshedAt,
                    total_tokens: tokenUsage.input + tokenUsage.output,
                    input_tokens: tokenUsage.input,
                    output_tokens: tokenUsage.output,
                    cache_read_tokens: tokenUsage.cache_read,
                    cache_write_tokens: tokenUsage.cache_write
                },
                // AMI 是按量付费，没有固定限额
                limits: {
                    type: 'pay_as_you_go',
                    description: 'AMI uses pay-as-you-go pricing'
                }
            };
        } catch (error) {
            console.error('[AMI] Failed to parse usage response:', error);
            return { customer: null, usage: null, limits: null };
        }
    }

    /**
     * 获取用户会话信息
     * @returns {Promise<Object>} 会话信息
     */
    async getSession() {
        await this.initialize();
        const wosSession = await this._getWosSession();

        const headers = {
            'host': 'app.ami.dev',
            'user-agent': AMI_CONSTANTS.USER_AGENT,
            'accept': '*/*',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'referer': 'https://app.ami.dev/dashboard',
            'accept-language': 'zh-CN',
            'cookie': `wos-session=${wosSession}`,
        };

        try {
            const response = await this.axiosInstance.get(AMI_CONSTANTS.SESSION_URL, { headers });
            return this._parseSessionResponse(response.data);
        } catch (error) {
            console.error('[AMI] Failed to get session:', error.message);
            throw error;
        }
    }

    /**
     * 解析会话响应
     */
    _parseSessionResponse(data) {
        try {
            const result = data?.result?.data;
            if (!result) {
                return { valid: false, user: null, tokens: null };
            }

            const user = result.user;
            return {
                valid: true,
                user: user ? {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    profilePictureUrl: user.profilePictureUrl,
                    workosId: user.workosId,
                    lastSignInAt: user.lastSignInAt,
                    createdAt: user.createdAt
                } : null,
                tokens: {
                    cli_token: result.cli_token,
                    bridge_token: result.bridge_token,
                    session_token: result.session_token
                }
            };
        } catch (error) {
            console.error('[AMI] Failed to parse session response:', error);
            return { valid: false, user: null, tokens: null };
        }
    }
}