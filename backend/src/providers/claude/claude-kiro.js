import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import * as providerDao from '../../dao/provider-dao.js';
import * as providerStatusLogsDao from '../../dao/provider-status-logs-dao.js';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { getProviderModels } from '../provider-models.js';
import { countTokens } from '@anthropic-ai/tokenizer';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { withDeduplication } from '../../utils/file-lock.js';
import { withDbLock } from '../../utils/db-lock.js';
import { isDatabaseInitialized } from '../../config/database.js';
import * as channelConfigDao from '../../dao/channel-config-dao.js';
import { requestTracer, TRACE_PHASE } from '../../monitoring/request-tracer.js';
import { calculateCacheTokens, isCacheSimulationEnabled } from '../../services/kiro-cache-simulator.js';

// ── Fingerprint masking: 伪装为 Anthropic 原生响应格式 ──
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 生成 base62 随机字符串（模拟 Anthropic 原生 ID 格式）
 * @param {number} len - 长度，默认 24
 */
function randomBase62(len = 24) {
    let result = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) {
        result += BASE62_CHARS[bytes[i] % 62];
    }
    return result;
}

/** 生成 Anthropic 风格的 message ID: msg_01XxxYyy... */
function generateAnthropicMessageId() {
    return `msg_${randomBase62(24)}`;
}

/** 生成 Anthropic 风格的 tool_use ID: toolu_01XxxYyy... */
function generateAnthropicToolUseId() {
    return `toolu_${randomBase62(22)}`;
}

/** 生成 Anthropic 风格的 server_tool_use ID: srvtoolu_01XxxYyy... */
function generateAnthropicSrvToolUseId() {
    return `srvtoolu_${randomBase62(22)}`;
}

/**
 * 生成 Anthropic 风格的 thinking signature（~296 字符）
 * 格式参考: EqQBCgIYAhIM...（protobuf-like base64 前缀 + 随机 payload）
 * 用于指纹伪装，让流式响应的 signature_delta 看起来像原生 API
 */
function generateAnthropicThinkingSignature() {
    // Anthropic 原生签名前缀（protobuf 编码的固定头部）
    const prefixes = [
        'EqQBCgIYAhIM', 'EqQBCgIYAxIM', 'EqQBCgIYBBIM',
        'EqQBCgIYBRIM', 'EqQBCgIYBhIM',
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const targetLen = 292 + Math.floor(Math.random() * 8); // 292~300 字符
    const payloadLen = targetLen - prefix.length;
    const bytes = crypto.randomBytes(payloadLen);
    let payload = '';
    for (let i = 0; i < payloadLen; i++) {
        payload += BASE64_CHARS[bytes[i] % 64];
    }
    return prefix + payload;
}

const KIRO_THINKING = {
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
};

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    CODEWHISPERER_GENERATE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
    AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
    USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
    LIST_MODELS_URL: 'https://q.{{region}}.amazonaws.com/ListAvailableModels',
    MCP_URL: 'https://q.{{region}}.amazonaws.com/mcp',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5-20250929',
    AXIOS_TIMEOUT: 120000, // 2 minutes timeout (increased from 2 minutes)
    REFRESH_TIMEOUT: 20000, // refresh token timeout (20s)
    REFRESH_MAX_RETRIES: 2, // 总计最多尝试 1 + 2 次，避免拉长用户等待
    REFRESH_BASE_DELAY_MS: 250, // 指数退避基础延迟
    REFRESH_MAX_DELAY_MS: 2000, // 单次重试最大延迟
    REFRESH_JITTER_RATIO: 0.25, // 退避抖动比例，避免同时重试
    REFRESH_MAX_DURATION_MS: 12000, // token 刷新总耗时上限，控制体验
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.7.5',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    KIRO_DEFAULT_CONTEXT_TOKENS: 200000,
    KIRO_LARGE_CONTEXT_TOKENS: 1000000,
    CONTEXT_WARNING_DISPLAY_RATIO: 0.8625,
    TOKEN_LIFETIME_FALLBACK_MS: 60 * 60 * 1000,
    TOKEN_NEAR_WINDOW_MAX_RATIO: 0.5,
    TOKEN_NEAR_WINDOW_MIN_MS: 60 * 1000,
    TOKEN_MIN_REFRESH_INTERVAL_MS: 90 * 1000,
};

function normalizeKiroAuthMethod(authMethod, credentials = {}) {
    const rawMethod = authMethod || (
        credentials.clientId && credentials.clientSecret
            ? 'idc'
            : KIRO_CONSTANTS.AUTH_METHOD_SOCIAL
    );
    const method = String(rawMethod).toLowerCase();
    if (method === 'builder-id' || method === 'iam') return 'idc';
    if (method === 'apikey') return 'api_key';
    return method;
}

const KIRO_REFRESH_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const KIRO_REFRESH_TLS_RETRYABLE_PATTERNS = [
    'before secure tls connection was established',
    'client network socket disconnected',
    'socket hang up'
];

// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels('claude-kiro-oauth');

// 完整的模型映射表
// 统一使用 Kiro 官方的短名称格式（如 "claude-sonnet-4.5"），以确保缓存命中
const FULL_MODEL_MAPPING = {
    "claude-opus-4-6": "claude-opus-4.6",
    "claude-opus-4-6-20260101": "claude-opus-4.6",
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-4.7": "claude-opus-4.7",
    "claude-opus-4-7-low": "claude-opus-4.7",
    "claude-opus-4-7-medium": "claude-opus-4.7",
    "claude-opus-4-7-high": "claude-opus-4.7",
    "claude-opus-4-7-xhigh": "claude-opus-4.7",
    "claude-opus-4-7-max": "claude-opus-4.7",
    "claude-opus-4.7-low": "claude-opus-4.7",
    "claude-opus-4.7-medium": "claude-opus-4.7",
    "claude-opus-4.7-high": "claude-opus-4.7",
    "claude-opus-4.7-xhigh": "claude-opus-4.7",
    "claude-opus-4.7-max": "claude-opus-4.7",
    "claude-opus-4-7-medium-thinking": "claude-opus-4.7",
    "claude-opus-4-7-high-thinking": "claude-opus-4.7",
    "claude-opus-4-7-xhigh-thinking": "claude-opus-4.7",
    "claude-opus-4.7-medium-thinking": "claude-opus-4.7",
    "claude-opus-4.7-high-thinking": "claude-opus-4.7",
    "claude-opus-4.7-xhigh-thinking": "claude-opus-4.7",
    "claude-opus-4-8": "claude-opus-4.8",
    "claude-opus-4.8": "claude-opus-4.8",
    "claude-opus-4-8-low": "claude-opus-4.8",
    "claude-opus-4-8-medium": "claude-opus-4.8",
    "claude-opus-4-8-high": "claude-opus-4.8",
    "claude-opus-4-8-xhigh": "claude-opus-4.8",
    "claude-opus-4-8-max": "claude-opus-4.8",
    "claude-opus-4.8-low": "claude-opus-4.8",
    "claude-opus-4.8-medium": "claude-opus-4.8",
    "claude-opus-4.8-high": "claude-opus-4.8",
    "claude-opus-4.8-xhigh": "claude-opus-4.8",
    "claude-opus-4.8-max": "claude-opus-4.8",
    "claude-opus-4-8-medium-thinking": "claude-opus-4.8",
    "claude-opus-4-8-high-thinking": "claude-opus-4.8",
    "claude-opus-4-8-xhigh-thinking": "claude-opus-4.8",
    "claude-opus-4.8-medium-thinking": "claude-opus-4.8",
    "claude-opus-4.8-high-thinking": "claude-opus-4.8",
    "claude-opus-4.8-xhigh-thinking": "claude-opus-4.8",
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-sonnet-4-6-20260217": "claude-sonnet-4.6",
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-3-7-sonnet-20250219": "claude-sonnet-3.7",
    // 非 Claude 模型（Kiro 原生支持，直接透传）
    "minimax-m2.1": "minimax-m2.1",
    "deepseek-3.2": "deepseek-3.2"
};

// 规范化模型名称（用于缓存 key 一致性）
// 注意：检查顺序很重要，先检查更具体的模式
function normalizeModelName(model) {
    if (!model) return 'claude-sonnet-4.5';
    const m = model.toLowerCase();
    // 非 Claude 模型直接透传（如 minimax-m2.1）
    if (!m.startsWith('claude')) return FULL_MODEL_MAPPING[model] || model;
    // 检查 sonnet-4-6 / sonnet_4_6 / sonnet-4.6 (最具体的先检查)
    if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6') || m.includes('sonnet-4.6')) return 'claude-sonnet-4.6';
    // 检查 sonnet-4-5 / sonnet_4_5 / sonnet-4.5
    if (m.includes('sonnet-4-5') || m.includes('sonnet_4_5') || m.includes('sonnet-4.5')) return 'claude-sonnet-4.5';
    // 检查 opus-4-7 / opus_4_7 / opus-4.7
    if (m.includes('opus-4-7') || m.includes('opus_4_7') || m.includes('opus-4.7')) return 'claude-opus-4.7';
    // 检查 opus-4-8 / opus_4_8 / opus-4.8
    if (m.includes('opus-4-8') || m.includes('opus_4_8') || m.includes('opus-4.8')) return 'claude-opus-4.8';
    // 检查 opus-4-6 / opus_4_6 / opus-4.6
    if (m.includes('opus-4-6') || m.includes('opus_4_6') || m.includes('opus-4.6')) return 'claude-opus-4.6';
    // 检查 opus-4
    if (m.includes('opus-4') || m.includes('opus_4')) return 'claude-opus-4.5';
    // 检查 sonnet-3-7 / sonnet_3_7 / sonnet-3.7
    if (m.includes('sonnet-3-7') || m.includes('sonnet_3_7') || m.includes('sonnet-3.7') || m.includes('3_7_sonnet')) return 'claude-sonnet-3.7';
    // 检查 sonnet-4 / sonnet_4 (在 sonnet-4-5/4-6 之后检查)
    if (m.includes('sonnet-4') || m.includes('sonnet_4')) return 'claude-sonnet-4';
    // 检查 haiku-4
    if (m.includes('haiku-4') || m.includes('haiku_4')) return 'claude-haiku-4.5';
    // 检查 haiku-3
    if (m.includes('haiku-3') || m.includes('haiku_3')) return 'claude-haiku-3.5';
    return FULL_MODEL_MAPPING[model] || model;
}

function getKiroContextWindowTokens(model) {
    const raw = String(model || '').toLowerCase();
    const normalized = String(normalizeModelName(model) || '').toLowerCase();
    const modelName = `${raw} ${normalized}`;

    if (
        modelName.includes('sonnet-4-6') ||
        modelName.includes('sonnet_4_6') ||
        modelName.includes('sonnet-4.6') ||
        modelName.includes('opus-4-6') ||
        modelName.includes('opus_4_6') ||
        modelName.includes('opus-4.6') ||
        modelName.includes('opus-4-7') ||
        modelName.includes('opus_4_7') ||
        modelName.includes('opus-4.7') ||
        modelName.includes('opus-4-8') ||
        modelName.includes('opus_4_8') ||
        modelName.includes('opus-4.8')
    ) {
        return KIRO_CONSTANTS.KIRO_LARGE_CONTEXT_TOKENS;
    }

    return KIRO_CONSTANTS.KIRO_DEFAULT_CONTEXT_TOKENS;
}

function getDisplayedContextWindowTokens(model) {
    return Math.round(getKiroContextWindowTokens(model) * KIRO_CONSTANTS.CONTEXT_WARNING_DISPLAY_RATIO);
}

function normalizeThinkingEffort(effort) {
    const normalized = String(effort || '').toLowerCase().trim();
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(normalized) ? normalized : null;
}

function getThinkingEffortFromModel(model) {
    const raw = String(model || '').toLowerCase();
    const match = raw.match(/(?:^|[-.])(low|medium|high|xhigh|max)(?:-|$)/);
    return match ? normalizeThinkingEffort(match[1]) : null;
}

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

// 缓存的渠道配置
let _cachedChannelConfig = null;
let _cacheTime = 0;
const CACHE_TTL = 60000; // 1分钟缓存

/**
 * 获取 Kiro 渠道配置（带缓存）
 */
async function getChannelConfig() {
    const now = Date.now();
    if (_cachedChannelConfig && (now - _cacheTime) < CACHE_TTL) {
        return _cachedChannelConfig;
    }
    try {
        const config = await channelConfigDao.getByProviderType('claude-kiro-oauth');
        if (config) {
            _cachedChannelConfig = {
                defaultModel: config.defaultModel,
                disabledModels: config.config?.disabledModels || [],
                modelMapping: config.config?.modelMapping || {}
            };
            _cacheTime = now;
            return _cachedChannelConfig;
        }
    } catch (err) {
        console.warn('[Kiro] Failed to load channel config:', err.message);
    }
    return { defaultModel: null, disabledModels: [], modelMapping: {} };
}

/**
 * 获取 Kiro 渠道的默认模型
 */
async function getDefaultModel() {
    const config = await getChannelConfig();
    if (config.defaultModel && MODEL_MAPPING[config.defaultModel]) {
        return config.defaultModel;
    }
    return KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
}

/**
 * 检查模型是否被禁用
 */
async function isModelDisabled(model) {
    const config = await getChannelConfig();
    return config.disabledModels.includes(model);
}

async function getMappedModel(model) {
    const config = await getChannelConfig();
    const mappedModel = config.modelMapping?.[model];
    return typeof mappedModel === 'string' && mappedModel.trim() ? mappedModel.trim() : model;
}

function applyMappedModelEffort(requestBody, requestedModel, routedModel) {
    const effort = getThinkingEffortFromModel(requestedModel);
    if (!effort || requestedModel === routedModel) return requestBody;

    const outputConfig = requestBody?.output_config || requestBody?.outputConfig || {};
    if (normalizeThinkingEffort(outputConfig.effort)) return requestBody;

    return {
        ...requestBody,
        output_config: {
            ...outputConfig,
            effort
        }
    };
}

function isThinkingRequested(requestBody, model) {
    const thinkingType = String(requestBody?.thinking?.type || '').toLowerCase();
    if (thinkingType === 'disabled') return false;

    const outputConfig = requestBody?.output_config || requestBody?.outputConfig;
    return thinkingType === 'enabled'
        || thinkingType === 'adaptive'
        || thinkingType === 'auto'
        || Boolean(normalizeThinkingEffort(outputConfig?.effort))
        || Boolean(getThinkingEffortFromModel(model));
}

/**
 * 自定义凭证错误类
 * 用于标识需要切换凭证的错误
 */
class CredentialError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'CredentialError';
        this.shouldSwitchCredential = options.shouldSwitchCredential ?? false;
        this.skipErrorCount = options.skipErrorCount ?? false;
        this.credentialMarkedUnhealthy = options.credentialMarkedUnhealthy ?? false;
        this.statusCode = options.statusCode;
        this.originalError = options.originalError;
    }
}

/**
 * 400 错误类型映射
 * 用于区分不同类型的 400 错误，返回友好提示
 */
const BAD_REQUEST_ERROR_MAP = {
    // 内容过长 - 不是账号问题，返回友好提示让客户端换方式
    'CONTENT_LENGTH_EXCEEDS_THRESHOLD': {
        shouldSwitchCredential: false,
        skipErrorCount: true,
        recoveryMinutes: 0, // 不需要恢复时间
        clientMessage: 'Input content is too long. Please reduce the file size or use grep/head to read partial content.',
        clientCode: 'content_too_long'
    },
    'Input is too long': {
        shouldSwitchCredential: false,
        skipErrorCount: true,
        recoveryMinutes: 0,
        clientMessage: 'Input content is too long. Please reduce the file size or use grep/head to read partial content.',
        clientCode: 'content_too_long'
    },
    // 无效请求格式 - 可能是临时问题
    'ValidationException': {
        shouldSwitchCredential: true,
        skipErrorCount: true,
        recoveryMinutes: 1,
        clientMessage: 'Request validation failed. Please try again.',
        clientCode: 'validation_error'
    },
    // 模型不支持
    'model': {
        shouldSwitchCredential: true,
        skipErrorCount: true,
        recoveryMinutes: 0,
        clientMessage: 'The requested model is not available. Switching to another provider.',
        clientCode: 'model_not_available'
    },
    // 默认处理 - 400 错误通常是临时性问题（格式错误、网络抖动等），不应标记账号异常
    'default': {
        shouldSwitchCredential: true,
        skipErrorCount: true,              // ✅ 不计入错误次数
        recoveryMinutes: 0,                // ✅ 不设置恢复时间（不标记为异常）
        clientMessage: 'Bad request. Please check your input and try again.',
        clientCode: 'bad_request'
    }
};

/**
 * 解析 400 错误并返回处理策略
 * @param {Object} errorResponse - 错误响应对象
 * @returns {Object} 处理策略
 */
function parse400Error(errorResponse) {
    const responseData = errorResponse?.data;
    let reason = '';
    let message = '';

    if (responseData) {
        if (typeof responseData === 'string') {
            message = responseData;
        } else {
            reason = responseData.reason || '';
            message = responseData.message || responseData.error || '';
        }
    }

    // 按优先级匹配错误类型
    for (const [key, config] of Object.entries(BAD_REQUEST_ERROR_MAP)) {
        if (key === 'default') continue;
        if (reason.includes(key) || message.includes(key)) {
            return { ...config, matchedKey: key, originalMessage: message };
        }
    }

    return { ...BAD_REQUEST_ERROR_MAP['default'], matchedKey: 'default', originalMessage: message };
}

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

/**
 * 根据当前配置生成唯一的机器码（Machine ID）
 * @param {Object} credentials - 当前凭证信息
 * @returns {string} SHA256 格式的机器码
 */
function generateMachineIdFromConfig(credentials) {
    // 优先级：节点UUID > profileArn > clientId > fallback
    const baseKey = credentials.uuid || credentials.profileArn || credentials.clientId || "KIRO_DEFAULT_MACHINE";
    return crypto.createHash('sha256').update(baseKey).digest('hex');
}

/**
 * 实时获取系统配置信息，用于生成 User-Agent
 * @returns {Object} 包含 osName, nodeVersion 等信息
 */
function getSystemRuntimeInfo() {
    const osPlatform = os.platform();
    const osRelease = os.release();
    const nodeVersion = process.version.replace('v', '');
    
    let osName = osPlatform;
    if (osPlatform === 'win32') osName = `windows#${osRelease}`;
    else if (osPlatform === 'darwin') osName = `macos#${osRelease}`;
    else osName = `${osPlatform}#${osRelease}`;

    return {
        osName,
        nodeVersion
    };
}

// Helper functions for tool calls and JSON parsing

function isQuoteCharAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    const ch = text[index];
    return ch === '"' || ch === "'" || ch === '`';
}

function findRealTag(text, tag, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = text.indexOf(tag, searchStart);
        if (pos === -1) return -1;
        
        const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
        const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
        if (!hasQuoteBefore && !hasQuoteAfter) {
            return pos;
        }
        
        searchStart = pos + 1;
    }
}

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 * @param {string} text - 要搜索的文本
 * @param {number} startPos - 起始位置
 * @param {string} openChar - 开括号字符 (默认 '[')
 * @param {string} closeChar - 闭括号字符 (默认 ']')
 * @returns {number} 匹配的闭括号位置，未找到返回 -1
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}


/**
 * 尝试修复常见的 JSON 格式问题
 * @param {string} jsonStr - 可能有问题的 JSON 字符串
 * @returns {string} 修复后的 JSON 字符串
 */
function repairJson(jsonStr) {
    let repaired = jsonStr;
    // 移除尾部逗号
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // 为未引用的键添加引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    // 确保字符串值被正确引用
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

/**
 * 解析单个工具调用文本
 * @param {string} toolCallText - 工具调用文本
 * @returns {Object|null} 解析后的工具调用对象或 null
 */
function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        console.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }
        
        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            console.log(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

// 导出 normalizeModelName 供其他模块使用
export { normalizeModelName };

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
        this.uuid = config?.uuid; // 获取多节点配置的 uuid
        console.log(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        // this.accessToken = config.KIRO_ACCESS_TOKEN;
        // this.refreshToken = config.KIRO_REFRESH_TOKEN;
        // this.clientId = config.KIRO_CLIENT_ID;
        // this.clientSecret = config.KIRO_CLIENT_SECRET;
        // this.authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        // this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL;
        // this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL;
        // this.baseUrl = KIRO_CONSTANTS.BASE_URL;
        // this.codeWhispererGenerateUrl = KIRO_CONSTANTS.CODEWHISPERER_GENERATE_URL;
        // this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL;

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                console.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                console.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        }

        this.oauthCredentialId = null;
        this.idcRegion = null;
        this.tokenIssuedAt = null;

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method
        this.axiosSocialRefreshInstance = null;
        this.axiosIDCRefreshInstance = null;

        // 配额缓存，避免每次请求都查询
        this._usageCache = null;
        this._usageCacheTime = 0;

        this._usageCacheTTL = 60 * 1000; // 缓存 1 分钟
        this.transientErrorCooldownMs = config?.KIRO_TRANSIENT_COOLDOWN_MS ?? 30000;
        this.allowOverQuota = config?.KIRO_ALLOW_OVER_QUOTA !== false && process.env.KIRO_ALLOW_OVER_QUOTA !== 'false';

        // 429 递增退避：连续 429 次数越多，冷却越长
        this._consecutive429Count = 0;
        this._last429Time = 0;
        // 超过此间隔（5分钟）没有 429，重置计数器
        this._consecutive429ResetMs = 5 * 60 * 1000;
    }

    /**
     * 生成请求头
     * @returns {Object} 包含 machineId 相关的请求头
     */
    _generateDeviceHeaders() {
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });

        const kiroVersion = this._kiroVersion;
        const osName = this._osName;
        const nodeVersion = this._nodeVersion;

        return {
            'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
            'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
        };
    }

    _buildSsoOidcHeaders(maxAttempts = 4) {
        if (!this._osName || !this._nodeVersion) {
            const { osName, nodeVersion } = getSystemRuntimeInfo();
            this._osName = osName;
            this._nodeVersion = nodeVersion;
        }

        const region = this.idcRegion || this.region || 'us-east-1';
        return {
            'content-type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
            'x-amz-user-agent': 'aws-sdk-js/3.980.0 KiroIDE',
            'user-agent': `aws-sdk-js/3.980.0 ua/2.1 os/${this._osName} lang/js md/nodejs#${this._nodeVersion} api/sso-oidc#3.980.0 m/E KiroIDE`,
            'host': `oidc.${region}.amazonaws.com`,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': `attempt=1; max=${maxAttempts}`,
            'Connection': 'close'
        };
    }

    _buildCurlCommand(url, headers, body) {
        const escapeValue = value => String(value).replace(/'/g, `'\"'\"'`);
        const headerFlags = Object.entries(headers || {})
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `-H '${escapeValue(key)}: ${escapeValue(value)}'`);
        const escapedBody = escapeValue(JSON.stringify(body));
        return `curl -X POST '${escapeValue(url)}' \\\n  ${headerFlags.join(' \\\n  ')} \\\n  --data-raw '${escapedBody}'`;
    }

    _readBooleanConfig(key, defaultValue) {
        const raw = this.config?.[key] ?? process.env[key];
        if (raw === undefined || raw === null || raw === '') return defaultValue;
        if (typeof raw === 'boolean') return raw;
        const normalized = String(raw).trim().toLowerCase();
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        return defaultValue;
    }

    _isKiroEndpointFallbackEnabled() {
        const hasCustomBaseUrl = Boolean(this.config?.KIRO_BASE_URL);
        const explicitValue = this.config?.KIRO_ENDPOINT_FALLBACK ?? process.env.KIRO_ENDPOINT_FALLBACK;

        // A custom base URL often points at a private proxy. Avoid silently bypassing it
        // unless endpoint fallback is explicitly enabled for this provider/process.
        if (hasCustomBaseUrl && (explicitValue === undefined || explicitValue === null || explicitValue === '')) {
            return false;
        }

        return this._readBooleanConfig('KIRO_ENDPOINT_FALLBACK', true);
    }

    _getPreferredKiroEndpoint() {
        const raw = this.config?.KIRO_PREFERRED_ENDPOINT ?? process.env.KIRO_PREFERRED_ENDPOINT ?? 'auto';
        const preferred = String(raw).trim().toLowerCase();
        return ['kiro', 'codewhisperer', 'amazonq'].includes(preferred) ? preferred : 'auto';
    }

    _getKiroEndpointCandidates(model) {
        const rawModel = String(model || '').toLowerCase();

        // Preserve the legacy explicit AmazonQ route.
        if (rawModel.startsWith('amazonq')) {
            return [{
                name: 'AmazonQ Streaming',
                url: this.amazonQUrl
            }];
        }

        const endpoints = [
            {
                key: 'kiro',
                name: 'Kiro IDE',
                url: this.baseUrl
            },
            {
                key: 'codewhisperer',
                name: 'CodeWhisperer',
                url: this.codeWhispererGenerateUrl,
                amzTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
            },
            {
                key: 'amazonq',
                name: 'AmazonQ',
                url: this.baseUrl,
                amzTarget: 'AmazonQDeveloperStreamingService.SendMessage'
            }
        ];

        const preferred = this._getPreferredKiroEndpoint();
        const primaryIndex = Math.max(0, endpoints.findIndex(endpoint => endpoint.key === preferred));
        const ordered = preferred === 'auto'
            ? endpoints
            : [endpoints[primaryIndex], ...endpoints.filter((_, index) => index !== primaryIndex)];

        return this._isKiroEndpointFallbackEnabled() ? ordered : ordered.slice(0, 1);
    }

    _buildKiroApiHeaders(endpoint = {}) {
        const deviceHeaders = this._generateDeviceHeaders();
        const headers = {
            'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
            'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
            'amz-sdk-request': 'attempt=1; max=1',
            'x-amzn-kiro-agent-mode': 'vibe',
            'x-amzn-codewhisperer-optout': 'true',
            'Connection': 'close',
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': uuidv4(),
            'AUTH_MODE': 'bearer_only',
            ...deviceHeaders,
        };
        if (endpoint.amzTarget) {
            headers['X-Amz-Target'] = endpoint.amzTarget;
        }
        if (this.profileArn) {
            headers['x-amzn-kiro-profile-arn'] = this.profileArn;
        }
        return headers;
    }

    _isKiroEndpointFallbackError(error) {
        const status = error.response?.status;
        if (status === 408 || status === 425) return true;
        if (status === 429) return true;
        if (status >= 500 && status < 600) return true;
        return isRetryableNetworkError(error);
    }

    _formatKiroEndpointError(error) {
        const status = error.response?.status;
        if (status) return `HTTP ${status}`;
        return error.code || error.message || 'unknown error';
    }

    async _postKiroEndpointCandidates(model, requestData, axiosOptions = {}) {
        const endpoints = this._getKiroEndpointCandidates(model);
        let lastError = null;

        for (let i = 0; i < endpoints.length; i++) {
            const endpoint = endpoints[i];
            const headers = this._buildKiroApiHeaders(endpoint);
            const requestUrl = endpoint.url;

            try {
                console.log(`[Kiro] Endpoint ${endpoint.name}: ${requestUrl}`);
                console.log(`[Kiro] curl request:\n${this._buildCurlCommand(requestUrl, headers, requestData)}`);
                const response = await this.axiosInstance.post(requestUrl, requestData, {
                    ...axiosOptions,
                    headers
                });
                if (i > 0) {
                    console.log(`[Kiro] Endpoint fallback succeeded via ${endpoint.name}`);
                }
                return { response, headers, requestUrl, endpoint };
            } catch (error) {
                const responseStream = error.response?.data;
                if (responseStream && typeof responseStream.destroy === 'function') {
                    responseStream.destroy();
                }
                error.kiroEndpointName = endpoint.name;
                error.kiroEndpointUrl = requestUrl;
                error.kiroRequestHeaders = headers;
                error.curlCommand = this._buildCurlCommand(requestUrl, headers, requestData);
                lastError = error;

                const hasNext = i < endpoints.length - 1;
                if (hasNext && this._isKiroEndpointFallbackError(error)) {
                    console.warn(`[Kiro] Endpoint ${endpoint.name} failed (${this._formatKiroEndpointError(error)}), trying ${endpoints[i + 1].name}...`);
                    continue;
                }

                throw error;
            }
        }

        throw lastError || new Error('All Kiro endpoints failed');
    }

    /**
     * 懒建 axios 实例 + 底层 http(s) agent。幂等:已存在就直接返回。
     *
     * 必须在任何 this.axiosInstance.* 调用前跑一次。原先这段只在 initialize() 里,
     * 但 health check 会绕过 initialize() 直接调 initializeAuth(true, true),
     * 走到 _performTokenRefreshRequest → this.axiosInstance.post(...) → null crash,
     * 一次冷启动刷 27 个 unhealthy kiro 就会炸出几万条 ERROR,拖垮 event loop。
     */
    _ensureAxiosInstances() {
        if (this.axiosInstance && this.axiosSocialRefreshInstance && this.axiosIDCRefreshInstance) return;

        if (!this._kiroVersion) this._kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
        if (!this._osName || !this._nodeVersion) {
            const { osName, nodeVersion } = getSystemRuntimeInfo();
            this._osName = osName;
            this._nodeVersion = nodeVersion;
        }

        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 32,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-request': 'attempt=1; max=1',
                'x-amzn-kiro-agent-mode': 'vibe',
                'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${this._kiroVersion}-${machineId}`,
                'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${this._osName} lang/js md/nodejs#${this._nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${this._kiroVersion}-${machineId}`,
                'Connection': 'close'
            },
        };

        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        configureAxiosProxy(axiosConfig, this.config, 'claude-kiro-oauth');

        this.axiosInstance = axios.create(axiosConfig);

        this.axiosSocialRefreshInstance = axios.create({
            ...axiosConfig,
            headers: { 'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON }
        });
        this.axiosIDCRefreshInstance = axios.create({
            ...axiosConfig,
            headers: { 'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON }
        });
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[Kiro] Initializing Kiro API Service...');
        // 先建 axios 实例,再跑 initializeAuth。否则首次冷启动若凭证已接近过期,
        // initializeAuth 会走 refresh 分支访问 this.axiosInstance → null。
        this._ensureAxiosInstances();
        await this.initializeAuth();
        this.isInitialized = true;
    }

    async initializeAuth(forceRefresh = false, bypassMinRefreshInterval = false) {
        // health check / dispose 后再刷等路径会绕过 initialize() 直接调 initializeAuth,
        // 必须先保证 axios 实例存在,否则 refresh 会炸 null.post。
        this._ensureAxiosInstances();

        if (this.accessToken && !forceRefresh) {
            console.debug('[Kiro Auth] Access token already available and not forced refresh.');
            return;
        }

        let mergedCredentials = {};

        if (this.base64Creds) {
            Object.assign(mergedCredentials, this.base64Creds);
            console.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
            this.base64Creds = null;
        }

        try {
            const { credentialId, credentials } = await loadCredentialsFromConfig(
                this.config,
                'KIRO_OAUTH_CREDS_FILE_PATH',
                'Kiro'
            );
            this.oauthCredentialId = credentialId;
            mergedCredentials = { ...mergedCredentials, ...credentials };
            console.info('[Kiro Auth] Successfully loaded credentials from database.');
        } catch (error) {
            if (!Object.keys(mergedCredentials).length) {
                console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
                throw new Error('No credentials available for Kiro OAuth.');
            }
        }

        this.accessToken = mergedCredentials.accessToken;
        this.refreshToken = mergedCredentials.refreshToken;
        this.expiresAt = mergedCredentials.expiresAt;
        this.tokenIssuedAt = mergedCredentials.tokenIssuedAt || null;
        this.profileArn = mergedCredentials.profileArn;
        this.clientId = mergedCredentials.clientId;
        this.clientSecret = mergedCredentials.clientSecret;
        this.authMethod = normalizeKiroAuthMethod(mergedCredentials.authMethod, mergedCredentials);
        this.region = mergedCredentials.region || 'us-east-1';
        this.idcRegion = mergedCredentials.idcRegion || mergedCredentials.idc_region || null;
        if (mergedCredentials.startUrl) {
            this.startUrl = mergedCredentials.startUrl;
        }
        if (mergedCredentials.registrationExpiresAt) {
            this.registrationExpiresAt = mergedCredentials.registrationExpiresAt;
        }

        if (!this.region) {
            console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
            this.region = 'us-east-1';
        }
        if (!this.idcRegion) {
            this.idcRegion = this.region;
        }

        this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
        this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.idcRegion);
        this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace("{{region}}", this.region);
        this.codeWhispererGenerateUrl = (this.config.KIRO_CODEWHISPERER_GENERATE_URL || KIRO_CONSTANTS.CODEWHISPERER_GENERATE_URL).replace("{{region}}", this.region);
        this.amazonQUrl = (KIRO_CONSTANTS.AMAZON_Q_URL).replace("{{region}}", this.region);

        if (forceRefresh && !bypassMinRefreshInterval && this.accessToken && !this.isExpiryDateNear()) {
            const minRefreshIntervalMs = this._normalizeRetryNumber(
                this.config.KIRO_MIN_REFRESH_INTERVAL_MS,
                KIRO_CONSTANTS.TOKEN_MIN_REFRESH_INTERVAL_MS,
                0
            );
            const issuedAtMs = this.tokenIssuedAt ? new Date(this.tokenIssuedAt).getTime() : NaN;
            if (Number.isFinite(issuedAtMs) && issuedAtMs > 0) {
                const tokenAgeMs = Date.now() - issuedAtMs;
                if (tokenAgeMs >= 0 && tokenAgeMs < minRefreshIntervalMs) {
                    console.info(`[Kiro Auth] Skip force refresh: token age ${tokenAgeMs}ms < min interval ${minRefreshIntervalMs}ms`);
                    forceRefresh = false;
                }
            }
        }

        if (forceRefresh || (!this.accessToken && this.refreshToken)) {
            if (!this.refreshToken) {
                const error = new Error('No refresh token available to refresh access token.');
                await this._markCredentialUnhealthy('Missing refresh token', error);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            const dedupeKey = `kiro-token-refresh:${this.oauthCredentialId || 'unknown'}`;
            try {
                const refreshStart = Date.now();
                console.info(`[Kiro Auth] Refreshing token (method=${this.authMethod}, region=${this.region}, idcRegion=${this.idcRegion})`);
                await withDeduplication(dedupeKey, async () => {
                    await this._refreshTokenWithDistributedLock(forceRefresh);
                });
                console.info(`[Kiro Auth] Token refresh finished in ${Date.now() - refreshStart}ms`);
            } catch (error) {
                console.error('[Kiro Auth] Token refresh failed during initializeAuth:', error.message || error);
                await this._markCredentialUnhealthy('Token refresh failed', error);
                if (error) {
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                }
                throw error;
            }

            if (!this.accessToken || this.isExpiryDateNear()) {
                await this._reloadCredentialsAfterRefresh(this.oauthCredentialId);
            }
        }

        if (!this.accessToken) {
            throw new Error('No access token available after initialization and refresh attempts.');
        }
    }

    /**
     * 执行实际的 token 刷新操作（内部方法）
     * @param {number|null} credentialId - 凭据记录ID
     */
    async _doTokenRefresh(credentialId) {
        const maxRetries = this._normalizeRetryNumber(this.config.KIRO_REFRESH_MAX_RETRIES, KIRO_CONSTANTS.REFRESH_MAX_RETRIES);
        const baseDelayMs = this._normalizeRetryNumber(this.config.KIRO_REFRESH_BASE_DELAY_MS, KIRO_CONSTANTS.REFRESH_BASE_DELAY_MS, 1);
        const configuredMaxDelayMs = this._normalizeRetryNumber(this.config.KIRO_REFRESH_MAX_DELAY_MS, KIRO_CONSTANTS.REFRESH_MAX_DELAY_MS, 1);
        const maxDelayMs = Math.max(baseDelayMs, configuredMaxDelayMs);
        const jitterRatio = this._normalizeRetryRatio(this.config.KIRO_REFRESH_JITTER_RATIO, KIRO_CONSTANTS.REFRESH_JITTER_RATIO);
        const maxDurationMs = this._normalizeRetryNumber(
            this.config.KIRO_REFRESH_MAX_DURATION_MS,
            KIRO_CONSTANTS.REFRESH_MAX_DURATION_MS,
            1000
        );
        const refreshStartTime = Date.now();
        let lastError = null;

        for (let attempt = 0; ; attempt++) {
            const elapsedMs = Date.now() - refreshStartTime;
            const remainingBudgetMs = maxDurationMs - elapsedMs;
            if (remainingBudgetMs <= 0) {
                throw this._buildTokenRefreshError(
                    lastError || new Error(`Token refresh exceeded max duration ${maxDurationMs}ms`)
                );
            }

            const attemptTimeoutMs = Math.min(
                KIRO_CONSTANTS.REFRESH_TIMEOUT,
                Math.max(200, remainingBudgetMs)
            );
            try {
                await this._performTokenRefreshRequest(credentialId, attemptTimeoutMs);
                return;
            } catch (error) {
                lastError = error;
                const shouldRetry = attempt < maxRetries && this._isRetryableTokenRefreshError(error);
                if (!shouldRetry) {
                    throw this._buildTokenRefreshError(error);
                }

                const delayMs = this._calculateExponentialBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio);
                const remainingAfterAttempt = maxDurationMs - (Date.now() - refreshStartTime);
                if (delayMs >= remainingAfterAttempt || remainingAfterAttempt <= 200) {
                    throw this._buildTokenRefreshError(error);
                }
                const errorIdentifier = error.code || error.response?.status || (error.message || 'unknown').slice(0, 80);
                console.warn(`[Kiro Auth] Token refresh transient failure (${errorIdentifier}), retrying in ${delayMs}ms (timeout ${attemptTimeoutMs}ms)... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    async _refreshTokenWithDistributedLock(forceRefresh = false) {
        const credentialId = this.oauthCredentialId;
        const refreshOperation = async () => {
            if (credentialId) {
                await this._reloadCredentialsAfterRefresh(credentialId);
            }
            if (!forceRefresh && this.accessToken && !this.isExpiryDateNear()) {
                console.info('[Kiro Auth] Skip refresh after DB reload: token still valid');
                return;
            }
            await this._doTokenRefresh(credentialId);
        };

        if (!credentialId || !isDatabaseInitialized()) {
            await refreshOperation();
            return;
        }

        const dbLockKey = `kiro-refresh:${credentialId}`;
        try {
            await withDbLock(dbLockKey, 15, refreshOperation);
        } catch (error) {
            if ((error?.message || '').includes('Failed to acquire DB lock')) {
                console.warn(`[Kiro Auth] DB lock busy (${dbLockKey}), reloading credentials from DB`);
                await this._reloadCredentialsAfterRefresh(credentialId);
                return;
            }
            throw error;
        }
    }

    _normalizeRetryNumber(value, fallback, minValue = 0) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(minValue, Math.floor(parsed));
    }

    _normalizeRetryRatio(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(1, Math.max(0, parsed));
    }

    _calculateExponentialBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio) {
        const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitterOffset = (Math.random() * 2 - 1) * exponentialDelay * jitterRatio;
        return Math.max(0, Math.round(exponentialDelay + jitterOffset));
    }

    _isRetryableTokenRefreshError(error) {
        if (!error) return false;

        const status = error.response?.status;
        if (status) {
            return KIRO_REFRESH_RETRYABLE_STATUS_CODES.has(status);
        }

        if (isRetryableNetworkError(error)) {
            return true;
        }

        const message = (error.message || '').toLowerCase();
        return KIRO_REFRESH_TLS_RETRYABLE_PATTERNS.some(pattern => message.includes(pattern));
    }

    _buildTokenRefreshError(error) {
        const status = error.response?.status;
        const responseData = error.response?.data;
        const detail = responseData?.error_description || responseData?.error || error.message || 'unknown';

        if (status) {
            console.error(`[Kiro Auth] Token refresh failed (HTTP ${status}):`, responseData || error.message);
        } else {
            console.error('[Kiro Auth] Token refresh failed:', error.message || error);
        }

        const wrappedError = new Error(`Token refresh failed: ${status ? `HTTP ${status} ${detail}` : detail}`);
        wrappedError.response = error.response;
        wrappedError.status = status;
        wrappedError.originalError = error;
        if (error.stack) {
            wrappedError.stack = `${wrappedError.stack}\nCaused by: ${error.stack}`;
        }
        return wrappedError;
    }

    async _performTokenRefreshRequest(credentialId, timeoutMs = KIRO_CONSTANTS.REFRESH_TIMEOUT) {
        const requestBody = {
            refreshToken: this.refreshToken,
        };

        let refreshUrl = this.refreshUrl;
        if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            refreshUrl = this.refreshIDCUrl;
            requestBody.clientId = this.clientId;
            requestBody.clientSecret = this.clientSecret;
            requestBody.grantType = 'refresh_token';
        }

        let response = null;
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            response = await this.axiosSocialRefreshInstance.post(refreshUrl, requestBody, {
                timeout: timeoutMs
            });
            console.log('[Kiro Auth] Token refresh social response: ok');
        } else {
            response = await this.axiosIDCRefreshInstance.post(refreshUrl, requestBody, {
                timeout: timeoutMs,
                headers: this._buildSsoOidcHeaders(4)
            });
            console.log('[Kiro Auth] Token refresh idc response: ok');
        }

        if (!response.data || !response.data.accessToken) {
            throw new Error('Invalid refresh response: Missing accessToken');
        }

        const previousRefreshToken = this.refreshToken;
        const previousProfileArn = this.profileArn;

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken || previousRefreshToken;
        this.profileArn = response.data.profileArn || previousProfileArn;
        const expiresIn = response.data.expiresIn;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        this.expiresAt = expiresAt;
        this.tokenIssuedAt = new Date().toISOString();
        console.info('[Kiro Auth] Access token refreshed successfully');

        const updatedTokenData = {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: expiresAt,
            tokenIssuedAt: this.tokenIssuedAt,
        };
        if (this.profileArn) {
            updatedTokenData.profileArn = this.profileArn;
        }
        if (credentialId) {
            const existing = await oauthCredentialsDao.findById(credentialId);
            const merged = { ...(existing?.credentials || {}), ...updatedTokenData };
            await updateCredentialsById(credentialId, merged);
        }
    }

    /**
     * 在并发刷新完成后重新加载凭证（内部方法）
     * @param {number|null} credentialId - 凭据记录ID
     */
    async _reloadCredentialsAfterRefresh(credentialId) {
        if (!credentialId) return;
        try {
            const record = await oauthCredentialsDao.findById(credentialId);
            if (!record || !record.credentials) {
                return;
            }
            const credentials = record.credentials;
            this.accessToken = credentials.accessToken;
            this.refreshToken = credentials.refreshToken;
            this.expiresAt = credentials.expiresAt;
            if (credentials.tokenIssuedAt) {
                this.tokenIssuedAt = credentials.tokenIssuedAt;
            }
            if (credentials.profileArn) {
                this.profileArn = credentials.profileArn;
            }
            console.debug('[Kiro Auth] Credentials reloaded after concurrent refresh');
        } catch (error) {
            console.warn(`[Kiro Auth] Failed to reload credentials after refresh: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        if(message==null){
            return "";
        }
        if (Array.isArray(message)) {
            return message.map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    if (part.type === 'text' && part.text) return part.text;
                    if (part.text) return part.text;
                }
                return '';
            }).join('');
        } else if (typeof message.content === 'string') {
            return message.content;
        } else if (Array.isArray(message.content)) {
            return message.content.map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    if (part.type === 'text' && part.text) return part.text;
                    if (part.text) return part.text;
                }
                return '';
            }).join('');
        }
        return String(message.content || message);
    }

    _normalizeThinkingBudgetTokens(budgetTokens) {
        let value = Number(budgetTokens);
        if (!Number.isFinite(value) || value <= 0) {
            value = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        }
        value = Math.floor(value);
        return Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking, outputConfig = null, model = null) {
        const thinkingType = String(thinking?.type || '').toLowerCase();
        const modelEffort = getThinkingEffortFromModel(model);
        const requestedEffort = normalizeThinkingEffort(outputConfig?.effort) || modelEffort;

        if (thinkingType === 'disabled') return null;

        if (requestedEffort) {
            return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${requestedEffort}</thinking_effort>`;
        }

        if (thinkingType === 'enabled') {
            const budget = this._normalizeThinkingBudgetTokens(thinking.budget_tokens);
            return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }

        if (thinkingType === 'adaptive' || thinkingType === 'auto' || modelEffort) {
            const effort = requestedEffort || 'high';
            return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`;
        }

        return null;
    }

    _hasThinkingPrefix(text) {
        if (!text) return false;
        return text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG);
    }

    _toClaudeContentBlocksFromKiroText(content) {
        const raw = content ?? '';
        if (!raw) return [];
        
        const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) {
            return [{ type: "text", text: raw }];
        }
        
        const before = raw.slice(0, startPos);
        let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);
        
        const endPosInRest = findRealTag(rest, KIRO_THINKING.END_TAG);
        let thinking = '';
        let after = '';
        if (endPosInRest === -1) {
            thinking = rest;
        } else {
            thinking = rest.slice(0, endPosInRest);
            after = rest.slice(endPosInRest + KIRO_THINKING.END_TAG.length);
        }
        
        if (after.startsWith('\n\n')) after = after.slice(2);
        
        const blocks = [];
        if (before) blocks.push({ type: "text", text: before });
        blocks.push({ type: "thinking", thinking, signature: generateAnthropicThinkingSignature() });
        if (after) blocks.push({ type: "text", text: after });
        return blocks;
    }

    /**
     * 收集消息中所有的 tool_use 信息
     * @param {Array} messages - 消息数组
     * @returns {Object} { toolUseIds: Set<string>, toolNames: Set<string>, toolUseMap: Map<id, name> }
     */
    _collectToolUseInfo(messages) {
        const toolUseIds = new Set();
        const toolNames = new Set();
        const toolUseMap = new Map(); // id -> name

        for (const message of messages) {
            if (message.role !== 'assistant') continue;
            if (!Array.isArray(message.content)) continue;

            for (const part of message.content) {
                if (part.type === 'tool_use' && part.id && part.name) {
                    toolUseIds.add(part.id);
                    toolNames.add(part.name);
                    toolUseMap.set(part.id, part.name);
                }
            }
        }

        return { toolUseIds, toolNames, toolUseMap };
    }

    /**
     * 为历史中使用过但当前 tools 列表中没有的工具创建占位符定义
     * @param {Array} tools - 当前工具列表
     * @param {Set} historyToolNames - 历史中使用过的工具名集合
     * @returns {Array} 补充了占位符的工具列表
     */
    _ensureToolDefinitions(tools, historyToolNames) {
        if (!historyToolNames || historyToolNames.size === 0) {
            return tools || [];
        }

        const result = [...(tools || [])];
        const existingNames = new Set(result.map(t => t.name));

        for (const name of historyToolNames) {
            if (!existingNames.has(name)) {
                console.log(`[Kiro] Creating placeholder tool definition for: ${name}`);
                result.push({
                    name: name,
                    description: `Placeholder for tool used in conversation history`,
                    input_schema: { type: 'object', properties: {} }
                });
            }
        }

        return result;
    }

    /**
     * 从 metadata.user_id 中提取 session UUID
     * user_id 格式: user_xxx_account__session_0b4445e1-f5be-49e1-87ce-62bbc28ad705
     */
    _extractSessionId(metadata) {
        if (!metadata?.user_id) return null;
        const userId = metadata.user_id;
        const sessionPrefix = 'session_';
        const pos = userId.indexOf(sessionPrefix);
        if (pos === -1) return null;
        const sessionId = userId.substring(pos + sessionPrefix.length);
        // 验证是否为有效的 UUID 格式 (36 字符，包含 4 个 -)
        if (sessionId.length === 36 && (sessionId.match(/-/g) || []).length === 4) {
            return sessionId;
        }
        return null;
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     */
    buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null, metadata = null, outputConfig = null) {
        // 调试日志：打印最后3条消息的结构，用于排查400错误
        console.log(`[Kiro][Debug] Total messages: ${messages.length}`);
        const lastMessages = messages.slice(-3);
        for (let i = 0; i < lastMessages.length; i++) {
            const msg = lastMessages[i];
            const contentTypes = Array.isArray(msg.content)
                ? msg.content.map(c => c.type).join(',')
                : typeof msg.content;
            console.log(`[Kiro][Debug] Message[-${3-i}] role=${msg.role}, contentTypes=[${contentTypes}]`);
        }

        // 优先从 metadata.user_id 中提取 session UUID 作为 conversationId，以便 Kiro 命中缓存
        const sessionId = this._extractSessionId(metadata);
        const conversationId = sessionId || uuidv4();

        // 详细的 sessionId 验证日志
        if (sessionId) {
            console.log(`[Kiro] ✅ SessionId extracted: ${sessionId.substring(0, 8)}... (cache will work)`);
        } else {
            console.warn(`[Kiro] ⚠️ No sessionId extracted! metadata.user_id=${metadata?.user_id || 'undefined'}`);
            console.warn(`[Kiro] ⚠️ Using random conversationId: ${conversationId.substring(0, 8)}... (cache will NOT work across requests)`);
        }

        let systemPrompt = this.getContentText(inSystemPrompt);
        const processedMessages = messages;

        // 收集所有 tool_use 信息，用于验证 tool_result 配对
        const { toolUseIds, toolNames, toolUseMap } = this._collectToolUseInfo(processedMessages);
        if (toolUseIds.size > 0) {
            console.log(`[Kiro] Collected ${toolUseIds.size} tool_use(s) from history: ${[...toolNames].join(', ')}`);
        }

        // 确保历史中使用过的工具都有定义
        const augmentedTools = this._ensureToolDefinitions(tools, toolNames);

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        const thinkingPrefix = this._generateThinkingPrefix(thinking, outputConfig, model);
        if (thinkingPrefix) {
            if (!systemPrompt) {
                systemPrompt = thinkingPrefix;
            } else if (!this._hasThinkingPrefix(systemPrompt)) {
                systemPrompt = `${thinkingPrefix}\n${systemPrompt}`;
            }
        }

        // 判断最后一条消息是否为 assistant,如果是则移除
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
            if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
                console.log('[Kiro] Removing last assistant with "{" message from processedMessages');
                processedMessages.pop();
            }
        }

        // 合并相邻相同 role 的消息
        const mergedMessages = [];
        for (let i = 0; i < processedMessages.length; i++) {
            const currentMsg = processedMessages[i];
            
            if (mergedMessages.length === 0) {
                mergedMessages.push(currentMsg);
            } else {
                const lastMsg = mergedMessages[mergedMessages.length - 1];
                
                // 判断当前消息和上一条消息是否为相同 role
                if (currentMsg.role === lastMsg.role) {
                    // 合并消息内容
                    if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                        // 如果都是数组,合并数组内容
                        lastMsg.content.push(...currentMsg.content);
                    } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                        // 如果都是字符串,用换行符连接
                        lastMsg.content += '\n' + currentMsg.content;
                    } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                        // 上一条是数组,当前是字符串,添加为 text 类型
                        lastMsg.content.push({ type: 'text', text: currentMsg.content });
                    } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                        // 上一条是字符串,当前是数组,转换为数组格式
                        lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                    }
                    // console.log(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
                } else {
                    mergedMessages.push(currentMsg);
                }
            }
        }

        // 用合并后的消息替换原消息数组
        processedMessages.length = 0;
        processedMessages.push(...mergedMessages);

        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];

        // === 调试日志：模型映射 ===
        console.log(`[Kiro] 模型映射: 请求=${model} -> Kiro=${codewhispererModel} (默认=${this.modelName})`);
        console.log(`[Kiro] MODEL_MAPPING[${model}]=${MODEL_MAPPING[model]}, 账号UUID=${this.uuid?.slice(0,8)}`);

        // 动态压缩 tools（使用 augmentedTools，包含历史工具的占位符定义）
        let toolsContext = {};
        if (augmentedTools && Array.isArray(augmentedTools) && augmentedTools.length > 0) {
            // 将 web_search 工具转换为 remote_web_search（Kiro 原生支持）
            // 注意：Kiro 服务端原生支持 remote_web_search，不需要过滤
            const transformedTools = augmentedTools.map(tool => {
                const name = (tool.name || '').toLowerCase();
                // 将 web_search/websearch 转换为 remote_web_search
                if (name === 'web_search' || name === 'websearch') {
                    console.log(`[Kiro] Transforming tool: ${tool.name} -> remote_web_search`);
                    return {
                        ...tool,
                        name: 'remote_web_search',
                        description: tool.description || 'Search the web for information'
                    };
                }
                return tool;
            });

            // 去重：如果已经有 remote_web_search，则移除重复的
            const toolNames = new Set();
            const filteredTools = transformedTools.filter(tool => {
                const name = tool.name;
                if (toolNames.has(name)) {
                    console.log(`[Kiro] Removing duplicate tool: ${name}`);
                    return false;
                }
                toolNames.add(name);
                return true;
            });

            if (filteredTools.length === 0) {
                // 所有工具都被过滤掉了，不添加 tools 上下文
                console.log('[Kiro] All tools were filtered out');
            } else {
            const MAX_TOOL_SPEC_BYTES = 10240;
            const COMPACT_TOOL_DESCRIPTIONS = {
                Bash: [
                    'Execute a shell command.',
                    '',
                    'Rules:',
                    '- Use Read/Edit/Write/Grep/Glob for file operations and search.',
                    '- Do not use `cd`; set `cwd` instead.',
                    '- Avoid long-running or interactive commands.',
                    '- Use `timeout` when needed.'
                ].join('\n'),
                Write: [
                    'Write content to a file. IMPORTANT: Maximum 200 lines per call.',
                    '',
                    'For files > 200 lines, you MUST split into multiple calls:',
                    '1. First Write: write lines 1-200',
                    '2. Use Edit tool to append remaining content in 200-line chunks',
                    '',
                    'Failure to follow this limit will cause errors.'
                ].join('\n'),
                Edit: [
                    'Edit file content by replacing old_string with new_string.',
                    '',
                    'IMPORTANT: Maximum 200 lines per edit operation.',
                    'For large edits (> 200 lines), split into multiple Edit calls.',
                    'Each old_string and new_string must be <= 200 lines.',
                    '',
                    'Failure to follow this limit will cause errors.'
                ].join('\n')
            };
            const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
            const fitDescriptionToSpec = (toolName, desc, inputSchema) => {
                const baseSpec = { name: toolName, description: "", inputSchema: { json: inputSchema } };
                const baseBytes = jsonBytes(baseSpec);
                const allowedDescBytes = MAX_TOOL_SPEC_BYTES - baseBytes;
                if (allowedDescBytes <= 0) {
                    return { desc: "", truncated: desc.length > 0 };
                }

                const descEncodedBytes = jsonBytes(desc) - 2; // remove JSON quotes
                if (descEncodedBytes <= allowedDescBytes) {
                    return { desc, truncated: false };
                }

                const ellipsis = "...";
                const ellipsisEncodedBytes = jsonBytes(ellipsis) - 2;
                const targetBytes = Math.max(
                    0,
                    allowedDescBytes - (allowedDescBytes >= ellipsisEncodedBytes ? ellipsisEncodedBytes : 0)
                );

                let low = 0;
                let high = desc.length;
                let bestLen = 0;
                while (low <= high) {
                    const mid = Math.floor((low + high) / 2);
                    const prefix = desc.slice(0, mid);
                    const prefixBytes = jsonBytes(prefix) - 2;
                    if (prefixBytes <= targetBytes) {
                        bestLen = mid;
                        low = mid + 1;
                    } else {
                        high = mid - 1;
                    }
                }

                let finalDesc = desc.slice(0, bestLen);
                if (allowedDescBytes >= ellipsisEncodedBytes) {
                    finalDesc += ellipsis;
                }
                return { desc: finalDesc, truncated: true };
            };

            let truncatedCount = 0;
            const kiroTools = filteredTools.map(tool => {
                let desc = tool.description || "";
                const compactDesc = COMPACT_TOOL_DESCRIPTIONS[tool.name];
                if (compactDesc) {
                    desc = compactDesc;
                    console.log(`[Kiro] Using compact description for tool '${tool.name}'`);
                }
                const originalLength = desc.length;
                let inputSchema = tool.input_schema || {};

                const baseSpecBytes = jsonBytes({ name: tool.name, description: "", inputSchema: { json: inputSchema } });
                if (baseSpecBytes > MAX_TOOL_SPEC_BYTES) {
                    console.log(`[Kiro] Tool '${tool.name}' schema too large (${baseSpecBytes} bytes), using empty schema`);
                    inputSchema = {};
                }

                const fit = fitDescriptionToSpec(tool.name, desc, inputSchema);
                desc = fit.desc;
                if (fit.truncated) {
                    truncatedCount++;
                    console.log(`[Kiro] Truncated tool '${tool.name}' description: ${originalLength} -> ${desc.length} chars`);
                }

                return {
                    toolSpecification: {
                        name: tool.name,
                        description: desc,
                        inputSchema: {
                            json: inputSchema
                        }
                    }
                };
            });
            
            if (truncatedCount > 0) {
                console.log(`[Kiro] Truncated ${truncatedCount} tool description(s) to fit ${MAX_TOOL_SPEC_BYTES} bytes`);
            }

            toolsContext = { tools: kiroTools };
            }
        }

        const history = [];
        let startIndex = 0;

        // Handle system prompt
        if (systemPrompt) {
            // If the first message is a user message, prepend system prompt to it
            if (processedMessages[0].role === 'user') {
                let firstUserContent = this.getContentText(processedMessages[0]);
                history.push({
                    userInputMessage: {
                        content: `${systemPrompt}\n\n${firstUserContent}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
                startIndex = 1; // Start processing from the second message
            } else {
                // If the first message is not a user message, or if there's no initial user message,
                // add system prompt as a standalone user message.
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        // 保留最近 5 条历史消息中的图片
        const keepImageThreshold = 5;        
        for (let i = startIndex; i < processedMessages.length - 1; i++) {
            const message = processedMessages[i];
            // 计算当前消息距离最后一条消息的位置（从后往前数）
            const distanceFromEnd = (processedMessages.length - 1) - i;
            // 如果距离末尾不超过 5 条，则保留图片
            const shouldKeepImages = distanceFromEnd <= keepImageThreshold;
            
            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                };
                let imageCount = 0;
                let toolResults = [];
                let images = [];
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += part.text;
                        } else if (part.type === 'tool_result') {
                            // 获取内容文本
                            let contentText = this.getContentText(part.content);

                            // 处理错误的 tool_result：Kiro API 不支持 status: 'error'，需要转换为 success
                            const isError = part.is_error === true;
                            if (isError) {
                                // 保留错误信息，但标记为 success 状态
                                if (!contentText || contentText.trim() === '') {
                                    contentText = 'Tool execution failed';
                                }
                                console.log(`[Kiro] Converting error tool_result to success: ${part.tool_use_id}, error: ${contentText}`);
                            }

                            // 空的 tool_result 不能跳过，因为 Kiro API 要求 toolResults 必须与 toolUses 配对
                            // 给空结果一个默认内容
                            if (!isError && (!contentText || contentText.trim() === '')) {
                                console.log(`[Kiro] Empty tool_result: ${part.tool_use_id}, using default content`);
                                contentText = 'Command executed successfully.';
                            }

                            // 验证 tool_result 是否有对应的 tool_use
                            if (!toolUseIds.has(part.tool_use_id)) {
                                // 孤立的 tool_result，降级为普通文本
                                const toolName = toolUseMap.get(part.tool_use_id) || 'unknown';
                                console.log(`[Kiro] Orphan tool_result detected (no matching tool_use): ${part.tool_use_id}, degrading to text`);
                                userInputMessage.content += `\n[Tool result from ${toolName}]: ${contentText}`;
                                continue;
                            }

                            toolResults.push({
                                content: [{ text: contentText }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            if (shouldKeepImages) {
                                // 最近 5 条消息内的图片保留原始数据
                                images.push({
                                    format: part.source.media_type.split('/')[1],
                                    source: {
                                        bytes: part.source.data
                                    }
                                });
                            } else {
                                // 超过 5 条历史记录的图片只记录数量
                                imageCount++;
                            }
                        }
                    }
                } else {
                    userInputMessage.content = this.getContentText(message);
                }
                
                // 如果有保留的图片，添加到消息中
                if (images.length > 0) {
                    userInputMessage.images = images;
                    console.log(`[Kiro] Kept ${images.length} image(s) in recent history message (distance from end: ${distanceFromEnd})`);
                }
                
                // 如果有被替换的图片，添加占位符说明
                if (imageCount > 0) {
                    const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
                    userInputMessage.content = userInputMessage.content
                        ? `${userInputMessage.content}\n${imagePlaceholder}`
                        : imagePlaceholder;
                    console.log(`[Kiro] Replaced ${imageCount} image(s) with placeholder in old history message (distance from end: ${distanceFromEnd})`);
                }
                
                if (toolResults.length > 0) {
                    // 去重 toolResults - Kiro API 不接受重复的 toolUseId
                    const uniqueToolResults = [];
                    const seenIds = new Set();
                    for (const tr of toolResults) {
                        if (!seenIds.has(tr.toolUseId)) {
                            seenIds.add(tr.toolUseId);
                            uniqueToolResults.push(tr);
                        }
                    }
                    userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
                }
                
                history.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = {
                    content: ''
                };
                let toolUses = [];
                let thinkingText = '';
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'thinking') {
                            thinkingText += (part.thinking ?? part.text ?? '');
                        } else if (part.type === 'tool_use') {
                            toolUses.push({
                                input: part.input,
                                name: part.name,
                                toolUseId: part.id
                            });
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }
                
                if (thinkingText) {
                    assistantResponseMessage.content = assistantResponseMessage.content
                        ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                        : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
                }

                // 只添加非空字段
                if (toolUses.length > 0) {
                    assistantResponseMessage.toolUses = toolUses;
                }
                
                history.push({ assistantResponseMessage });
            }
        }

        // Build current message
        let currentMessage = processedMessages[processedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentToolUses = [];
        let currentImages = [];

        // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
        // 因为 CodeWhisperer API 的 currentMessage 必须是 userInputMessage 类型
        if (currentMessage.role === 'assistant') {
            console.log('[Kiro] Last message is assistant, moving it to history and creating user currentMessage');
            
            // 构建 assistant 消息并加入 history
            let assistantResponseMessage = {
                content: '',
                toolUses: []
            };
            let thinkingText = '';
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        assistantResponseMessage.content += part.text;
                    } else if (part.type === 'thinking') {
                        thinkingText += (part.thinking ?? part.text ?? '');
                    } else if (part.type === 'tool_use') {
                        assistantResponseMessage.toolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    }
                }
            } else {
                assistantResponseMessage.content = this.getContentText(currentMessage);
            }
            if (thinkingText) {
                assistantResponseMessage.content = assistantResponseMessage.content
                    ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                    : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
            }
            if (assistantResponseMessage.toolUses.length === 0) {
                delete assistantResponseMessage.toolUses;
            }
            history.push({ assistantResponseMessage });
            
            // 设置 currentContent 为 "Continue"，因为我们需要一个 user 消息来触发 AI 继续
            currentContent = 'Continue';
        } else {
            // 最后一条消息是 user，需要确保 history 最后一个元素是 assistantResponseMessage
            // Kiro API 要求 history 必须以 assistantResponseMessage 结尾
            if (history.length > 0) {
                const lastHistoryItem = history[history.length - 1];
                if (!lastHistoryItem.assistantResponseMessage) {
                    // 最后一个不是 assistantResponseMessage，需要补全一个空的
                    console.log('[Kiro] History does not end with assistantResponseMessage, adding empty one');
                    history.push({
                        assistantResponseMessage: {
                            content: 'Continue'
                        }
                    });
                }
            }

            // 处理 user 消息
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        currentContent += part.text;
                    } else if (part.type === 'tool_result') {
                        // Kiro API 不支持 status: 'error'，需要转换为 success
                        const isError = part.is_error === true;
                        let contentText = this.getContentText(part.content);

                        if (isError) {
                            // 将错误信息包装后作为 success 返回
                            if (!contentText || contentText.trim() === '') {
                                contentText = 'Tool execution failed';
                            }
                            console.log(`[Kiro] Converting error tool_result to success: ${part.tool_use_id}, error: ${contentText}`);
                            contentText = `[Error] ${contentText}`;
                        }

                        // 空的 tool_result 不能跳过，因为 Kiro API 要求 toolResults 必须与 toolUses 配对
                        // 给空结果一个默认内容
                        if (!isError && (!contentText || contentText.trim() === '')) {
                            console.log(`[Kiro] Empty tool_result in currentMessage: ${part.tool_use_id}, using default content`);
                            contentText = 'Command executed successfully.';
                        }

                        // 验证 tool_result 是否有对应的 tool_use
                        if (!toolUseIds.has(part.tool_use_id)) {
                            // 孤立的 tool_result，降级为普通文本
                            const toolName = toolUseMap.get(part.tool_use_id) || 'unknown';
                            console.log(`[Kiro] Orphan tool_result in currentMessage (no matching tool_use): ${part.tool_use_id}, degrading to text`);
                            currentContent += `\n[Tool result from ${toolName}]: ${contentText}`;
                            continue;
                        }

                        currentToolResults.push({
                            content: [{ text: contentText }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'tool_use') {
                        currentToolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    } else if (part.type === 'image') {
                        currentImages.push({
                            format: part.source.media_type.split('/')[1],
                            source: {
                                bytes: part.source.data
                            }
                        });
                    }
                }
            } else {
                currentContent = this.getContentText(currentMessage);
            }

            // Kiro API 要求 content 不能为空，即使有 toolResults
            if (!currentContent) {
                currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            }
        }

        const agentContinuationId = uuidv4();
        const request = {
            conversationState: {
                agentContinuationId: agentContinuationId,
                agentTaskType: 'vibe',
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: {} // Will be populated as userInputMessage
            }
        };
        
        // 只有当 history 非空时才添加（API 可能不接受空数组）
        if (history.length > 0) {
            request.conversationState.history = history;
        }

        // currentMessage 始终是 userInputMessage 类型
        // 注意：API 不接受 null 值，空字段应该完全不包含
        const userInputMessage = {
            content: currentContent,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        // 只有当 images 非空时才添加
        if (currentImages && currentImages.length > 0) {
            userInputMessage.images = currentImages;
        }

        // 构建 userInputMessageContext，只包含非空字段
        const userInputMessageContext = {};
        if (currentToolResults.length > 0) {
            // 去重 toolResults - Kiro API 不接受重复的 toolUseId
            const uniqueToolResults = [];
            const seenToolUseIds = new Set();
            for (const tr of currentToolResults) {
                if (!seenToolUseIds.has(tr.toolUseId)) {
                    seenToolUseIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessageContext.toolResults = uniqueToolResults;
        }
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            userInputMessageContext.tools = toolsContext.tools;
        }

        // 只有当 userInputMessageContext 有内容时才添加
        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        request.conversationState.currentMessage.userInputMessage = userInputMessage;

        if (this.profileArn) {
            request.profileArn = this.profileArn;
        }

        // fs.writeFile('claude-kiro-request'+Date.now()+'.json', JSON.stringify(request));
        return request;
    }

    parseEventStreamChunk(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;
        // console.log(`rawStr=${rawStr}`);

        // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
        // 使用更精确的正则来匹配 SSE 格式的事件
        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;
        
        // 首先尝试使用 SSE 格式解析
        let matches = [...rawStr.matchAll(sseEventRegex)];
        
        // 如果 SSE 格式没有匹配到，回退到旧的格式
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
                continue;
            }

            // 尝试找到完整的 JSON 对象
            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);

                    // 优先处理结构化工具调用事件
                    if (eventData.name && eventData.toolUseId) {
                        if (!currentToolCallDict) {
                            currentToolCallDict = {
                                id: eventData.toolUseId,
                                type: "function",
                                function: {
                                    name: eventData.name,
                                    arguments: ""
                                }
                            };
                        }
                        if (eventData.input) {
                            currentToolCallDict.function.arguments += eventData.input;
                        }
                        if (eventData.stop) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                console.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        // 处理内容，移除转义字符
                        let decodedContent = eventData.content;
                        // 处理常见的转义序列
                        decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                        // decodedContent = decodedContent.replace(/(?<!\\)\\t/g, '\t');
                        // decodedContent = decodedContent.replace(/\\"/g, '"');
                        // decodedContent = decodedContent.replace(/\\\\/g, '\\');
                        fullContent += decodedContent;
                    }
                    break;
                } catch (e) {
                    // JSON 解析失败，继续寻找下一个可能的结束位置
                    continue;
                }
            }
        }
        
        // 如果还有未完成的工具调用，添加到列表中
        if (currentToolCallDict) {
            toolCalls.push(currentToolCallDict);
        }

        // 检查解析后文本中的 bracket 格式工具调用
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            // 从响应文本中移除工具调用文本
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.replace(/\s+/g, ' ').trim();
        }

        const uniqueToolCalls = deduplicateToolCalls(toolCalls);
        return { content: fullContent || '', toolCalls: uniqueToolCalls };
    }
 

    /**
     * 调用 API 并处理错误重试
     */
    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking, body.metadata, body.output_config || body.outputConfig);

        // 提前声明请求上下文，以便在 catch 块中访问最后一次端点尝试
        let headers = null;
        let requestUrl = null;
        try {
            console.log('[Kiro] Request body:', JSON.stringify(requestData, null, 2));
            const result = await this._postKiroEndpointCandidates(model, requestData);
            headers = result.headers;
            requestUrl = result.requestUrl;
            const response = result.response;
            return response;
        } catch (error) {
            headers = error.kiroRequestHeaders || headers;
            requestUrl = error.kiroEndpointUrl || requestUrl;
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const responseData = error.response?.data;

            // 打印原始错误响应用于调试
            if (status) {
                console.error(`[Kiro] API Error (HTTP ${status}):`, JSON.stringify(responseData, null, 2));
            } else if (errorCode) {
                console.error(`[Kiro] Network Error (${errorCode}):`, errorMessage);
            }

            // 为所有错误保存 curl 命令用于调试
            if (headers && requestData && requestUrl) {
                error.curlCommand = error.curlCommand || this._buildCurlCommand(requestUrl, headers, requestData);
            }
            // 保存原始响应到 error 对象
            error.rawResponse = responseData;

            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 - try token refresh once before marking credential unhealthy
            if (status === 401 && !isRetry) {
                console.log('[Kiro] Received 401. Refreshing UUID and attempting token refresh...');
                const newUuid = await this._refreshUuid();
                if (newUuid) {
                    console.log(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
                    this.uuid = newUuid;
                }

                try {
                    await this.initializeAuth(true, true);
                    console.log('[Kiro] Token refresh successful after 401, retrying request...');
                    return this.callApi(method, model, body, true, retryCount);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during 401 retry:', refreshError.message);
                    await this._markCredentialDeleted('401 - Token refresh failed', refreshError);
                    // 保留原始error的curlCommand和response信息
                    if (error.curlCommand && !refreshError.curlCommand) {
                        refreshError.curlCommand = error.curlCommand;
                    }
                    if (error.response && !refreshError.response) {
                        refreshError.response = error.response;
                    }
                    throw refreshError;
                }
            }
    
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402) {
                await this._handle402Error(error, 'callApi');
            }

            // Handle 403 (Forbidden) - immediately switch credential, async refresh token in background
            if (status === 403) {
                const errMsg = String(error.message || '');
                const isSuspended = /suspended/i.test(errMsg) || /unusual.*activity/i.test(errMsg);
                if (isSuspended) {
                    console.log(`[Kiro] Received 403 with account suspended. Deleting credential immediately: ${(this.uuid || '').slice(0,8)}`);
                    await this._markCredentialDeleted('403 - Account suspended', error);
                } else {
                    console.log('[Kiro] Received 403. Switching credential immediately, async token refresh in background...');
                    await this._markCredentialUnhealthy('403 Forbidden', error);
                    // Fire-and-forget: refresh token in background, mark deleted if refresh fails
                    this._asyncRefreshOrDelete('403 Forbidden');
                }
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 429 (Too Many Requests) - 立即切号，不阻塞
            if (status === 429) {
                const { cooldownMs, recoveryTime, consecutive } = this._get429CooldownInfo(error.response?.headers);
                console.log(`[Kiro] 429 Rate Limit for ${(this.uuid || '').slice(0,8)}, consecutive #${consecutive}, cooldown ${cooldownMs}ms until ${recoveryTime.toISOString()}`);
                await this._markCredentialUnhealthyWithRecovery('429 Too Many Requests', error, recoveryTime);
                this._log429StatusEvent(consecutive, cooldownMs, recoveryTime);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                error.isQuotaCooldown = true;
                error.quotaResetTime = recoveryTime.toISOString();
                error.quotaResetDelayMs = cooldownMs;
                error.quotaResetFormatted = recoveryTime.toISOString();
                throw error;
            }

            // Handle 5xx server errors - NOT a credential issue, just transient AWS overload
            // Do NOT mark credential unhealthy, just switch to another credential for this request
            if (status >= 500 && status < 600) {
                console.log(`[Kiro] Received ${status} server error (transient, credential NOT marked unhealthy). Switching credential...`);
                // Mark error for credential switch without recording error count or marking unhealthy
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 400 (Bad Request) - 根据错误类型区分处理
            if (status === 400) {
                const errorResponseData = error.response?.data;
                const errorConfig = parse400Error(error.response);

                console.error(`[Kiro][400] ========== BAD REQUEST DEBUG INFO ==========`);
                console.error(`[Kiro][400] URL: ${requestUrl}, Model: ${model}`);
                console.error(`[Kiro][400] Error Type: ${errorConfig.matchedKey}`);
                console.error(`[Kiro][400] Error: ${errorMessage}`);
                try {
                    console.error(`[Kiro][400] Response:`, JSON.stringify(errorResponseData, null, 2));
                } catch (e) {
                    console.error(`[Kiro][400] Response: [unserializable]`);
                }
                console.error(`[Kiro][400] ============================================`);

                // 根据错误类型决定是否切换凭证
                if (errorConfig.shouldSwitchCredential && errorConfig.recoveryMinutes > 0) {
                    const recoveryTime = new Date(Date.now() + errorConfig.recoveryMinutes * 60 * 1000);
                    await this._markCredentialUnhealthyWithRecovery(
                        `400 ${errorConfig.matchedKey}: ${errorConfig.originalMessage}`,
                        error,
                        recoveryTime
                    );
                }

                // 对于客户端需要自己调整的错误（非账号问题），原样返回 API 错误
                // 判断标准：shouldSwitchCredential=false 或 skipErrorCount=true
                if (!errorConfig.shouldSwitchCredential || errorConfig.skipErrorCount) {
                    error.shouldSwitchCredential = errorConfig.shouldSwitchCredential;
                    error.skipErrorCount = errorConfig.skipErrorCount;
                    throw error;
                }

                // 账号问题的错误构造友好的错误返回给客户端
                const clientError = new Error(errorConfig.clientMessage);
                clientError.status = 400;
                clientError.statusCode = 400;
                clientError.code = errorConfig.clientCode;
                clientError.type = 'invalid_request_error';
                clientError.shouldSwitchCredential = errorConfig.shouldSwitchCredential;
                clientError.skipErrorCount = errorConfig.skipErrorCount;
                clientError.curlCommand = error.curlCommand;
                clientError.originalError = error;
                throw clientError;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                console.log(`[Kiro] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            console.error(`[Kiro] API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        }
    }

    /**
     * Helper method to refresh the current credential's UUID
     * Used when encountering 401 errors to get a fresh identity
     * @returns {string|null} - The new UUID, or null if refresh failed
     * @private
     */
    async _refreshUuid() {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            return await poolManager.refreshProviderUuid(MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            });
        } else {
            console.warn(`[Kiro] Cannot refresh UUID: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return null;
        }
    }

    /**
     * Helper method to mark the current credential as unhealthy
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    async _markCredentialUnhealthy(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            console.log(`[Kiro] Marking credential ${this.uuid} as unhealthy. Reason: ${reason}`);
            await poolManager.markProviderUnhealthyImmediately(MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, reason, {
                source: 'kiro_runtime',
                reason
            });
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            console.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * Mark credential as permanently deleted (token refresh failed, account dead)
     * @param {string} reason
     * @param {Error} [error]
     * @returns {Promise<boolean>}
     * @private
     */
    async _markCredentialDeleted(reason, error = null) {
        if (!this.uuid) {
            console.warn(`[Kiro] Cannot mark credential as deleted: uuid is empty`);
            return false;
        }
        try {
            console.log(`[Kiro] Marking credential ${this.uuid} as DELETED. Reason: ${reason}`);
            await providerDao.markDeleted(this.uuid, reason);
            // Also mark unhealthy in pool manager for immediate switch
            const poolManager = getProviderPoolManager();
            if (poolManager) {
                poolManager.markProviderUnhealthyImmediately(MODEL_PROVIDER.KIRO_API, {
                    uuid: this.uuid
                }, reason, {
                    source: 'kiro_runtime',
                    reason,
                    action: 'mark_deleted'
                });
            }
            if (error) {
                error.credentialMarkedUnhealthy = true;
                error.credentialMarkedDeleted = true;
            }
            return true;
        } catch (dbError) {
            console.error(`[Kiro] Failed to mark credential ${this.uuid} as deleted:`, dbError.message);
            // Fallback to unhealthy
            await this._markCredentialUnhealthy(reason, error);
            return false;
        }
    }

    /**
     * 403 后台异步刷新 token，刷新成功则恢复健康，刷新失败则标记 deleted
     * Fire-and-forget，不阻塞主请求流程
     * @param {string} reason - 触发原因
     * @private
     */
    _asyncRefreshOrDelete(reason) {
        const uuid = this.uuid;
        const credentialId = this.oauthCredentialId;
        if (!uuid) return;

        // Use setImmediate / nextTick to ensure this runs after the current request throws
        Promise.resolve().then(async () => {
            try {
                console.info(`[Kiro] Background token refresh for ${uuid} (reason: ${reason})`);
                await this.initializeAuth(true, true);
                // Refresh succeeded — mark healthy again so pool can reuse
                const poolManager = getProviderPoolManager();
                if (poolManager) {
                    await poolManager.markProviderHealthy(MODEL_PROVIDER.KIRO_API, uuid, {
                        source: 'kiro_runtime',
                        action: '403_background_refresh_recover'
                    });
                    console.info(`[Kiro] Background refresh succeeded for ${uuid}, marked healthy again`);
                }
            } catch (refreshError) {
                console.error(`[Kiro] Background refresh failed for ${uuid}, marking as deleted:`, refreshError.message);
                await this._markCredentialDeleted(`${reason} - background refresh failed`, null).catch(e => {
                    console.error(`[Kiro] Failed to mark ${uuid} as deleted after background refresh:`, e.message);
                });
            }
        });
    }

    /**
     * Helper method to mark the current credential as unhealthy with a recovery time
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @param {Date} [recoveryTime] - When the credential should recover
     * @returns {boolean} - Whether the credential was successfully marked
     * @private
     */
    async _markCredentialUnhealthyWithRecovery(reason, error = null, recoveryTime = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            console.log(`[Kiro] Marking credential ${this.uuid} as unhealthy with recovery time. Reason: ${reason}, Recovery: ${recoveryTime?.toISOString()}`);
            await poolManager.markProviderUnhealthyWithRecoveryTime(MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, recoveryTime, reason, {
                source: 'kiro_runtime',
                reason
            });
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            console.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * 计算下月1日 00:00:00 UTC 时间
     * @returns {Date} 下月1日的 Date 对象
     * @private
     */
    _getNextMonthFirstDay() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    }

    _getTransientRecoveryTime(baseDelay) {
        const minCooldown = Math.max(baseDelay * 2, 10000);
        const cooldownMs = Math.max(this.transientErrorCooldownMs, minCooldown);
        return new Date(Date.now() + cooldownMs);
    }

    /**
     * 解析 retry-after 响应头（秒数或 HTTP 日期）
     * @param {Object} headers - 响应头
     * @returns {number|null} 毫秒数，解析失败返回 null
     */
    _parseRetryAfterMs(headers) {
        if (!headers) return null;
        const raw = headers['retry-after'] || headers['Retry-After'];
        if (!raw) return null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.ceil(seconds * 1000);
        }
        const date = new Date(raw);
        if (!isNaN(date.getTime())) {
            const ms = date.getTime() - Date.now();
            return ms > 0 ? ms : null;
        }
        return null;
    }

    /**
     * 429 递增退避：根据连续 429 次数计算冷却时间
     * 阶梯：30s → 60s → 120s → 300s（5min），上限 5 分钟
     * 如果响应头有 retry-after 且更大，则用 retry-after
     * @param {Object} responseHeaders - 响应头
     * @returns {{ cooldownMs: number, recoveryTime: Date, consecutive: number }}
     */
    _get429CooldownInfo(responseHeaders) {
        const now = Date.now();
        // 超过 5 分钟没 429，重置计数
        if (now - this._last429Time > this._consecutive429ResetMs) {
            this._consecutive429Count = 0;
        }
        this._consecutive429Count++;
        this._last429Time = now;

        // 递增退避阶梯
        const tiers = [30000, 60000, 120000, 300000]; // 30s, 60s, 2min, 5min
        const tierIndex = Math.min(this._consecutive429Count - 1, tiers.length - 1);
        let cooldownMs = tiers[tierIndex];

        // 如果有 retry-after 且更大，用它
        const retryAfterMs = this._parseRetryAfterMs(responseHeaders);
        if (retryAfterMs && retryAfterMs > cooldownMs) {
            cooldownMs = retryAfterMs;
        }

        const recoveryTime = new Date(now + cooldownMs);
        return { cooldownMs, recoveryTime, consecutive: this._consecutive429Count };
    }

    /**
     * 记录 429 递增退避事件到状态日志
     */
    _log429StatusEvent(consecutive, cooldownMs, recoveryTime) {
        if (!this.uuid) return;
        providerStatusLogsDao.create({
            providerUuid: this.uuid,
            providerType: MODEL_PROVIDER.KIRO_API,
            poolId: this.poolId ?? 0,
            action: '429_rate_limit_cooldown',
            fromStatus: 'healthy',
            toStatus: 'cooldown',
            reason: `429 Too Many Requests — 连续第 ${consecutive} 次，冷却 ${Math.round(cooldownMs / 1000)}s`,
            source: 'kiro_adapter',
            metadata: {
                consecutive,
                cooldownMs,
                recoveryTime: recoveryTime.toISOString(),
                tier: consecutive <= 1 ? '30s' : consecutive <= 2 ? '60s' : consecutive <= 3 ? '2min' : '5min'
            }
        }).catch(err => {
            console.error('[Kiro] Failed to record 429 status log:', err.message);
        });
    }

    /**
     * 处理 402 错误（配额耗尽）
     * 验证用量限制并标记凭证为不健康，设置恢复时间为下月1日
     * @param {Error} error - 原始错误对象
     * @param {string} context - 错误发生的上下文（如 'callApi', 'stream'）
     * @throws {Error} 抛出带有切换凭证标记的错误
     * @private
     */
    async _handle402Error(error, context = 'unknown') {
        const responseData = error.response?.data;
        const errorDetail = responseData?.error || responseData?.message || responseData;
        console.log(`[Kiro] Received 402 (Quota Exceeded) in ${context}. Error detail:`, errorDetail);

        if (this.allowOverQuota) {
            console.log('[Kiro] Over-quota mode enabled; not marking credential unhealthy on 402.');
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            throw error;
        }

        console.log(`[Kiro] Verifying usage limits...`);
        try {
            // Verify usage limits to confirm quota exhaustion
            const usageLimits = await this.getUsageLimits();
            const isQuotaExhausted = usageLimits?.usedCount >= usageLimits?.limitCount;
            
            if (isQuotaExhausted) {
                console.log(`[Kiro] Quota confirmed exhausted: ${usageLimits?.usedCount}/${usageLimits?.limitCount}`);
                // Calculate recovery time: 1st day of next month at 00:00:00 UTC
                const nextMonth = this._getNextMonthFirstDay();
                await this._markCredentialUnhealthyWithRecovery('402 Payment Required - Quota Exhausted', error, nextMonth);
            } else {
                console.log(`[Kiro] Quota not exhausted (${usageLimits?.usedCount}/${usageLimits?.limitCount}), but received 402. Marking unhealthy anyway.`);
                await this._markCredentialUnhealthy('402 Payment Required - Unexpected', error);
            }
        } catch (usageError) {
            console.warn('[Kiro] Failed to verify usage limits:', usageError.message);
            // If we can't verify, still mark as unhealthy with recovery time
            const nextMonth = this._getNextMonthFirstDay();
            await this._markCredentialUnhealthyWithRecovery('402 Payment Required - Quota Exceeded (unverified)', error, nextMonth);
        }
        // Mark error for credential switch without recording error count
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
    }

    _processApiResponse(response) {
        const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        //console.log(`[Kiro] Raw response length: ${rawResponseText.length}`);
        if (rawResponseText.includes("[Called")) {
            console.log("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawResponseText);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        //console.log(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //console.log(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...rawBracketToolCalls);
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //console.log(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.replace(/\s+/g, ' ').trim();
        }
        
        //console.log(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //console.log(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls };
    }

    async generateContent(model, requestBody) {
        // 检查是否为 WebSearch 请求
        if (this.isWebSearchRequest(requestBody)) {
            console.log('[Kiro] Detected WebSearch request (non-stream), routing to WebSearch handler');
            return await this.handleWebSearchNonStream(model, requestBody);
        }

        const routedModel = await getMappedModel(model);
        if (routedModel !== model) {
            console.log(`[Kiro] Model mapping: requested=${model}, routed=${routedModel}`);
        }

        // 检查模型是否支持
        if (!MODEL_MAPPING[routedModel] && !MODEL_MAPPING[this.modelName]) {
            const error = new Error(`Model '${model}' is not supported by Kiro. Supported models: ${Object.keys(MODEL_MAPPING).join(', ')}`);
            error.statusCode = 400;
            error.code = 'model_not_supported';
            error.type = 'invalid_request_error';
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            throw error;
        }

        if (!this.isInitialized) await this.initialize();

        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContent request...');
            await this.initializeAuth(true);
        }

        // 获取默认模型（从渠道配置或常量）
        const defaultModel = await getDefaultModel();
        // 检查模型是否在映射中且未被禁用
        const modelDisabled = await isModelDisabled(routedModel);
        const modelSupported = Boolean(MODEL_MAPPING[routedModel]);
        const finalModel = (modelSupported && !modelDisabled) ? routedModel : defaultModel;
        if (finalModel !== routedModel) {
            const reason = !modelSupported ? 'unsupported' : 'disabled';
            console.log(`[Kiro] Model fallback: requested=${model}, routed=${routedModel}, final=${finalModel}, reason=${reason}, default=${defaultModel}`);
        }
        const routedRequestBody = applyMappedModelEffort(requestBody, model, finalModel);
        console.log(`[Kiro] Calling generateContent with model: ${finalModel}${routedModel !== model ? ` (requested=${model})` : ''}${modelDisabled ? ' (requested model disabled)' : ''}`);

        // 计算缓存 token（模拟），传入 metadata 用于会话隔离
        const cacheStats = await calculateCacheTokens(routedRequestBody, routedRequestBody.metadata);

        const response = await this.callApi('', finalModel, routedRequestBody);

        try {
            const { responseText, toolCalls } = this._processApiResponse(response);
            const result = this.buildClaudeResponse(responseText, false, 'assistant', model, toolCalls, cacheStats.inputTokens);
            if (result && typeof result === 'object') {
                result.__actualModel = finalModel;
                // 添加缓存 token 统计
                if (result.usage) {
                    result.usage.cache_creation_input_tokens = cacheStats.cacheCreationTokens;
                    result.usage.cache_read_input_tokens = cacheStats.cacheReadTokens;
                }
            }
            return result;
        } catch (error) {
            console.error('[Kiro] Error in generateContent:', error.message || error);
            throw new Error(`Error processing response: ${error.message || 'Unknown error'}`);
        }
    }

    /**
     * 解析 AWS Event Stream 格式，提取所有完整的 JSON 事件
     * 返回 { events: 解析出的事件数组, remaining: 未处理完的缓冲区 }
     *
     * 优化：使用单次正则扫描替代多次 indexOf，减少 CPU 开销
     */
    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;

        // 使用正则一次性找到所有可能的 JSON 起始位置
        // 匹配 {"content", {"name", {"followupPrompt", {"input", {"stop", {"contextUsagePercentage", {"unit
        const jsonStartRegex = /\{"(?:content|name|followupPrompt|input|stop|contextUsagePercentage|unit)"/g;

        let match;
        let lastProcessedEnd = 0;

        while ((match = jsonStartRegex.exec(remaining)) !== null) {
            const jsonStart = match.index;

            // 正确处理嵌套的 {} - 使用括号计数法
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;

            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];

                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }

                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }

                if (char === '"') {
                    inString = !inString;
                    continue;
                }

                if (!inString) {
                    if (char === '{') {
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            jsonEnd = i;
                            break;
                        }
                    }
                }
            }

            if (jsonEnd < 0) {
                // 不完整的 JSON，保留从这里开始的缓冲区等待更多数据
                remaining = remaining.substring(jsonStart);
                return { events, remaining };
            }

            const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);
                // 处理 content 事件
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    events.push({ type: 'content', data: parsed.content });
                }
                // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
                else if (parsed.name && parsed.toolUseId) {
                    events.push({
                        type: 'toolUse',
                        data: {
                            name: parsed.name,
                            toolUseId: parsed.toolUseId,
                            input: parsed.input || '',
                            stop: parsed.stop || false
                        }
                    });
                }
                // 处理工具调用的 input 续传事件（只有 input 字段）
                else if (parsed.input !== undefined && !parsed.name) {
                    events.push({
                        type: 'toolUseInput',
                        data: { input: parsed.input }
                    });
                }
                // 处理工具调用的结束事件（只有 stop 字段，且不包含 contextUsagePercentage）
                else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
                    events.push({
                        type: 'toolUseStop',
                        data: { stop: parsed.stop }
                    });
                }
                // 处理上下文使用百分比事件（最后一条消息）
                else if (parsed.contextUsagePercentage !== undefined) {
                    events.push({
                        type: 'contextUsage',
                        data: { contextUsagePercentage: parsed.contextUsagePercentage }
                    });
                }
                // 处理 credit 消耗事件（meteringEvent）
                else if (parsed.unit === 'credit' && parsed.usage !== undefined) {
                    events.push({
                        type: 'metering',
                        data: { creditUsage: parsed.usage }
                    });
                }

                lastProcessedEnd = jsonEnd + 1;
                // 更新正则的 lastIndex 以从 jsonEnd 后继续搜索
                jsonStartRegex.lastIndex = jsonEnd + 1;
            } catch (e) {
                // JSON 解析失败，继续搜索下一个
                jsonStartRegex.lastIndex = jsonStart + 1;
            }
        }

        // 截取剩余未处理的部分
        if (lastProcessedEnd > 0) {
            remaining = remaining.substring(lastProcessedEnd);
        }

        return { events, remaining };
    }

    /**
     * 真正的流式 API 调用 - 使用 responseType: 'stream'
     */
    async * streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking, body.metadata, body.output_config || body.outputConfig);

        // 调试：打印请求结构的关键信息
        const cs = requestData.conversationState;
        const historyLen = cs?.history?.length || 0;
        const currentMsgKeys = Object.keys(cs?.currentMessage?.userInputMessage || {});
        const hasTools = !!(cs?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length);
        const conversationId = cs?.conversationId;
        console.log(`[Kiro Debug] Request structure: historyLen=${historyLen}, currentMsgKeys=[${currentMsgKeys}], hasTools=${hasTools}, conversationId=${conversationId?.substring(0,8)}`);

        // 计算请求体大小
        const requestSize = JSON.stringify(requestData).length;
        console.log(`[Kiro Debug] Request size: ${(requestSize / 1024).toFixed(1)}KB`);

        let stream = null;
        let headers = null;
        let requestUrl = null;
        try {
            const result = await this._postKiroEndpointCandidates(model, requestData, {
                responseType: 'stream'
            });
            headers = result.headers;
            requestUrl = result.requestUrl;
            const response = result.response;

            stream = response.data;
            let buffer = '';
            let lastContentEvent = null;  // 用于检测连续重复的 content 事件

            for await (const chunk of stream) {
                buffer += chunk.toString();
                
                // 解析缓冲区中的事件
                const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
                buffer = remaining;
                
                // yield 所有事件，但过滤连续完全相同的 content 事件（Kiro API 有时会重复发送）
                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        // 检查是否与上一个 content 事件完全相同
                        if (lastContentEvent === event.data) {
                            // 跳过重复的内容
                            continue;
                        }
                        lastContentEvent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'toolUse') {
                        yield { type: 'toolUse', toolUse: event.data };
                    } else if (event.type === 'toolUseInput') {
                        yield { type: 'toolUseInput', input: event.data.input };
                    } else if (event.type === 'toolUseStop') {
                        yield { type: 'toolUseStop', stop: event.data.stop };
                    } else if (event.type === 'contextUsage') {
                        yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage };
                    } else if (event.type === 'metering') {
                        yield { type: 'metering', creditUsage: event.data.creditUsage };
                    }
                }
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }

            headers = error.kiroRequestHeaders || headers;
            requestUrl = error.kiroEndpointUrl || requestUrl;
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const responseData = error.response?.data;

            // 打印原始错误响应用于调试
            if (status) {
                let responseDataStr;
                try {
                    responseDataStr = typeof responseData === 'object' && responseData !== null && typeof responseData.pipe === 'function'
                        ? '[Stream object - not serializable]'
                        : JSON.stringify(responseData, null, 2);
                } catch (e) {
                    responseDataStr = `[Serialize failed: ${e.message}]`;
                }
                console.error(`[Kiro Stream] API Error (HTTP ${status}):`, responseDataStr);
            } else if (errorCode) {
                console.error(`[Kiro Stream] Network Error (${errorCode}):`, errorMessage);
            }

            // 为所有错误保存 curl 命令用于调试
            if (headers && requestData && requestUrl) {
                error.curlCommand = error.curlCommand || this._buildCurlCommand(requestUrl, headers, requestData);
            }
            // 保存原始响应到 error 对象
            error.rawResponse = responseData;

            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 - try token refresh once before marking credential unhealthy
            if (status === 401 && !isRetry) {
                console.log('[Kiro] Received 401 in stream. Attempting token refresh...');
                try {
                    await this.initializeAuth(true, true);
                    console.log('[Kiro] Token refresh successful after 401, retrying stream...');
                    yield* this.streamApiReal(method, model, body, true, retryCount);
                    return;
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during 401 retry:', refreshError.message);
                    await this._markCredentialDeleted('401 - Token refresh failed', refreshError);
                    // 保留原始error的curlCommand和response信息
                    if (error.curlCommand && !refreshError.curlCommand) {
                        refreshError.curlCommand = error.curlCommand;
                    }
                    if (error.response && !refreshError.response) {
                        refreshError.response = error.response;
                    }
                    throw refreshError;
                }
            }
            
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402) {
                await this._handle402Error(error, 'stream');
            }

            // Handle 403 (Forbidden) - immediately switch credential, async refresh token in background
            if (status === 403) {
                const errMsg = String(error.message || '');
                const isSuspended = /suspended/i.test(errMsg) || /unusual.*activity/i.test(errMsg);
                if (isSuspended) {
                    console.log(`[Kiro] Received 403 in stream with account suspended. Deleting credential immediately: ${(this.uuid || '').slice(0,8)}`);
                    await this._markCredentialDeleted('403 - Account suspended in stream', error);
                } else {
                    console.log('[Kiro] Received 403 in stream. Switching credential immediately, async token refresh in background...');
                    await this._markCredentialUnhealthy('403 Forbidden in stream', error);
                    // Fire-and-forget: refresh token in background, mark deleted if refresh fails
                    this._asyncRefreshOrDelete('403 Forbidden in stream');
                }
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 429 (Too Many Requests) - 立即切号，不阻塞
            if (status === 429) {
                const { cooldownMs, recoveryTime, consecutive } = this._get429CooldownInfo(error.response?.headers);
                console.log(`[Kiro] 429 Rate Limit in stream for ${(this.uuid || '').slice(0,8)}, consecutive #${consecutive}, cooldown ${cooldownMs}ms until ${recoveryTime.toISOString()}`);
                await this._markCredentialUnhealthyWithRecovery('429 Too Many Requests', error, recoveryTime);
                this._log429StatusEvent(consecutive, cooldownMs, recoveryTime);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                error.isQuotaCooldown = true;
                error.quotaResetTime = recoveryTime.toISOString();
                error.quotaResetDelayMs = cooldownMs;
                error.quotaResetFormatted = recoveryTime.toISOString();
                throw error;
            }

            // Handle 5xx server errors - NOT a credential issue, just transient AWS overload
            // Do NOT mark credential unhealthy, just switch to another credential for this request
            if (status >= 500 && status < 600) {
                console.log(`[Kiro] Received ${status} server error in stream (transient, credential NOT marked unhealthy). Switching credential...`);
                // Mark error for credential switch without recording error count or marking unhealthy
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 400 (Bad Request) - 根据错误类型区分处理
            if (status === 400) {
                const errorResponseData = error.response?.data;
                const errorConfig = parse400Error(error.response);

                console.error(`[Kiro][400] ========== BAD REQUEST DEBUG INFO ==========`);
                console.error(`[Kiro][400] URL: ${requestUrl}, Model: ${model}`);
                console.error(`[Kiro][400] Error Type: ${errorConfig.matchedKey}`);
                console.error(`[Kiro][400] Error: ${errorMessage}`);
                try {
                    console.error(`[Kiro][400] Response:`, JSON.stringify(errorResponseData, null, 2));
                } catch (e) {
                    console.error(`[Kiro][400] Response: [unserializable]`);
                }
                console.error(`[Kiro][400] ============================================`);

                // 根据错误类型决定是否切换凭证
                if (errorConfig.shouldSwitchCredential && errorConfig.recoveryMinutes > 0) {
                    const recoveryTime = new Date(Date.now() + errorConfig.recoveryMinutes * 60 * 1000);
                    await this._markCredentialUnhealthyWithRecovery(
                        `400 ${errorConfig.matchedKey}: ${errorConfig.originalMessage}`,
                        error,
                        recoveryTime
                    );
                }

                // 对于客户端需要自己调整的错误（非账号问题），原样返回 API 错误
                // 判断标准：shouldSwitchCredential=false 或 skipErrorCount=true
                if (!errorConfig.shouldSwitchCredential || errorConfig.skipErrorCount) {
                    error.shouldSwitchCredential = errorConfig.shouldSwitchCredential;
                    error.skipErrorCount = errorConfig.skipErrorCount;
                    throw error;
                }

                // 账号问题的错误构造友好的错误返回给客户端
                const clientError = new Error(errorConfig.clientMessage);
                clientError.status = 400;
                clientError.statusCode = 400;
                clientError.code = errorConfig.clientCode;
                clientError.type = 'invalid_request_error';
                clientError.shouldSwitchCredential = errorConfig.shouldSwitchCredential;
                clientError.skipErrorCount = errorConfig.skipErrorCount;
                clientError.curlCommand = error.curlCommand;
                clientError.originalError = error;
                throw clientError;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                console.log(`[Kiro] Network error (${errorIdentifier}) in stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
                return;
            }

            console.error(`[Kiro] Stream API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        } finally {
            // 确保流被关闭，释放资源
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    // 保留旧的非流式方法用于 generateContent
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            console.error('[Kiro] Error calling API:', error.message || error);
            throw error;
        }
    }

    // 真正的流式传输实现
    async * generateContentStream(model, requestBody) {
        // 检查是否为 WebSearch 请求
        if (this.isWebSearchRequest(requestBody)) {
            console.log('[Kiro] Detected WebSearch request, routing to WebSearch handler');
            yield* this.handleWebSearchStream(model, requestBody);
            return;
        }

        const routedModel = await getMappedModel(model);
        if (routedModel !== model) {
            console.log(`[Kiro] Model mapping (stream): requested=${model}, routed=${routedModel}`);
        }

        // 检查模型是否支持
        if (!MODEL_MAPPING[routedModel] && !MODEL_MAPPING[this.modelName]) {
            const error = new Error(`Model '${model}' is not supported by Kiro. Supported models: ${Object.keys(MODEL_MAPPING).join(', ')}`);
            error.statusCode = 400;
            error.code = 'model_not_supported';
            error.type = 'invalid_request_error';
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            throw error;
        }

        if (!this.isInitialized) await this.initialize();

        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContentStream request...');
            await this.initializeAuth(true);
        }

        // 预检查配额（在流式传输开始前，此时还可以切号重试）
        await this._preflightQuotaCheck();

        // 获取默认模型（从渠道配置或常量）
        const defaultModel = await getDefaultModel();
        // 检查模型是否在映射中且未被禁用
        const modelDisabled = await isModelDisabled(routedModel);
        const modelSupported = Boolean(MODEL_MAPPING[routedModel]);
        const finalModel = (modelSupported && !modelDisabled) ? routedModel : defaultModel;
        if (finalModel !== routedModel) {
            const reason = !modelSupported ? 'unsupported' : 'disabled';
            console.log(`[Kiro] Model fallback (stream): requested=${model}, routed=${routedModel}, final=${finalModel}, reason=${reason}, default=${defaultModel}`);
        }
        const routedRequestBody = applyMappedModelEffort(requestBody, model, finalModel);
        console.log(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming)${routedModel !== model ? ` (requested=${model})` : ''}${modelDisabled ? ' (requested model disabled)' : ''}`);

        let inputTokens = 0;
        let contextUsagePercentage = null;
        let creditUsage = null;
        const messageId = generateAnthropicMessageId();
        const requestStartTime = Date.now(); // 记录请求开始时间
        let ttftMs = null; // 首字耗时

        const thinkingRequested = isThinkingRequested(routedRequestBody, finalModel);

        const streamState = {
            thinkingRequested,
            buffer: '',
            inThinking: false,
            thinkingExtracted: false,
            thinkingBlockIndex: null,
            textBlockIndex: null,
            nextBlockIndex: 0,
            stoppedBlocks: new Set(),
            firstContentReceived: false, // 是否收到第一个内容
        };

        const ensureBlockStart = (blockType) => {
            if (blockType === 'thinking') {
                if (streamState.thinkingBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.thinkingBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "thinking", thinking: "" }
                }];
            }
            if (blockType === 'text') {
                if (streamState.textBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.textBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "text", text: "" }
                }];
            }
            return [];
        };

        const stopBlock = (index) => {
            if (index == null) return [];
            if (streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ type: "content_block_stop", index }];
        };

        // 生成 thinking block 的 signature_delta 事件（指纹伪装）
        const createSignatureDeltaEvents = (blockIndex) => {
            if (blockIndex == null) return [];
            return [{
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "signature_delta", signature: generateAnthropicThinkingSignature() }
            }];
        };

        const createTextDeltaEvents = (text) => {
            if (!text) return [];
            const events = [];
            events.push(...ensureBlockStart('text'));
            events.push({
                type: "content_block_delta",
                index: streamState.textBlockIndex,
                delta: { type: "text_delta", text }
            });
            return events;
        };

        const createThinkingDeltaEvents = (thinking) => {
            const events = [];
            events.push(...ensureBlockStart('thinking'));
            events.push({
                type: "content_block_delta",
                index: streamState.thinkingBlockIndex,
                delta: { type: "thinking_delta", thinking }
            });
            return events;
        };

        function* pushEvents(events) {
            for (const ev of events) {
                yield ev;
            }
        }

        try {
            let totalContent = '';
            let outputTokens = 0;
            const toolCalls = [];
            let currentToolCall = null; // 用于累积结构化工具调用

            // 计算缓存 token（快速估算，零延迟）
            const cacheStats = await calculateCacheTokens(routedRequestBody, routedRequestBody.metadata);

            // 1. 先发送 message_start 事件
            yield {
                type: "message_start",
                __actualModel: finalModel,
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    model: model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: cacheStats.inputTokens,
                        output_tokens: 0,
                        cache_creation_input_tokens: cacheStats.cacheCreationTokens,
                        cache_read_input_tokens: cacheStats.cacheReadTokens
                    },
                    service_tier: "standard",
                    inference_geo: "us",
                    content: []
                }
            };

            // 2. 流式接收并发送每个 content_block_delta
            for await (const event of this.streamApiReal('', finalModel, routedRequestBody)) {
                if (event.type === 'contextUsage' && event.contextUsagePercentage) {
                    // 捕获上下文使用百分比（包含输入和输出的总使用量）
                    contextUsagePercentage = event.contextUsagePercentage;
                } else if (event.type === 'metering' && event.creditUsage !== undefined) {
                    // 捕获 credit 消耗
                    creditUsage = event.creditUsage;
                    console.log(`[Kiro] Credit usage: ${creditUsage}`);
                } else if (event.type === 'content' && event.content) {
                    // 记录首字时间（第一次收到内容）
                    if (!streamState.firstContentReceived) {
                        streamState.firstContentReceived = true;
                        ttftMs = Date.now() - requestStartTime;
                        console.log(`[Kiro] TTFT (Time To First Token): ${ttftMs}ms`);
                        // 记录 TTFT 到追踪系统
                        const traceId = requestBody.metadata?.traceId;
                        if (traceId) {
                            requestTracer.recordPhase(traceId, TRACE_PHASE.TTFT, ttftMs);
                        }
                    }
                    totalContent += event.content;

                    if (!thinkingRequested) {
                        yield* pushEvents(createTextDeltaEvents(event.content));
                        continue;
                    }

                    streamState.buffer += event.content;
                    const events = [];

                    while (streamState.buffer.length > 0) {
                        if (!streamState.inThinking && !streamState.thinkingExtracted) {
                            const startPos = findRealTag(streamState.buffer, KIRO_THINKING.START_TAG);
                            if (startPos !== -1) {
                                const before = streamState.buffer.slice(0, startPos);
                                if (before) events.push(...createTextDeltaEvents(before));

                                streamState.buffer = streamState.buffer.slice(startPos + KIRO_THINKING.START_TAG.length);
                                streamState.inThinking = true;
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.START_TAG.length);
                            if (safeLen > 0) {
                                const safeText = streamState.buffer.slice(0, safeLen);
                                if (safeText) events.push(...createTextDeltaEvents(safeText));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.inThinking) {
                            const endPos = findRealTag(streamState.buffer, KIRO_THINKING.END_TAG);
                            if (endPos !== -1) {
                                const thinkingPart = streamState.buffer.slice(0, endPos);
                                if (thinkingPart) events.push(...createThinkingDeltaEvents(thinkingPart));

                                streamState.buffer = streamState.buffer.slice(endPos + KIRO_THINKING.END_TAG.length);
                                streamState.inThinking = false;
                                streamState.thinkingExtracted = true;

                                events.push(...createThinkingDeltaEvents(""));
                                events.push(...createSignatureDeltaEvents(streamState.thinkingBlockIndex));
                                events.push(...stopBlock(streamState.thinkingBlockIndex));

                                if (streamState.buffer.startsWith('\n\n')) {
                                    streamState.buffer = streamState.buffer.slice(2);
                                }
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.END_TAG.length);
                            if (safeLen > 0) {
                                const safeThinking = streamState.buffer.slice(0, safeLen);
                                if (safeThinking) events.push(...createThinkingDeltaEvents(safeThinking));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.thinkingExtracted) {
                            const rest = streamState.buffer;
                            streamState.buffer = '';
                            if (rest) events.push(...createTextDeltaEvents(rest));
                            break;
                        }
                    }

                    yield* pushEvents(events);
                } else if (event.type === 'toolUse') {
                    const tc = event.toolUse;
                    // 统计工具调用的内容到 totalContent（用于 token 计算）
                    if (tc.name) {
                        totalContent += tc.name;
                    }
                    if (tc.input) {
                        totalContent += tc.input;
                    }
                    // 工具调用事件（包含 name 和 toolUseId）
                    if (tc.name && tc.toolUseId) {
                        // 检查是否是同一个工具调用的续传（用原始上游 ID 匹配）
                        const isSameTool = currentToolCall && currentToolCall._upstreamId === tc.toolUseId;
                        if (!isSameTool) {
                            // 不同的工具调用 — 先把上一个完结掉（emit stop + push 到完成列表）
                            if (currentToolCall) {
                                if (!currentToolCall._streamStopped) {
                                    yield { type: "content_block_stop", index: currentToolCall.blockIndex };
                                    currentToolCall._streamStopped = true;
                                }
                                try {
                                    currentToolCall.input = JSON.parse(currentToolCall.inputRaw || '');
                                } catch (e) {
                                    currentToolCall.input = currentToolCall.inputRaw || '';
                                }
                                toolCalls.push(currentToolCall);
                            }
                            // 开始新的工具调用 — 立即 emit content_block_start, 让客户端马上看到工具名 + id
                            const newToolUseId = generateAnthropicToolUseId();
                            const blockIndex = streamState.nextBlockIndex++;
                            // remote_web_search 上游名字 → 客户端期待的 WebSearch (保持与下方批量补发逻辑一致)
                            const isRemoteWebSearch = (tc.name || '').toLowerCase() === 'remote_web_search';
                            const clientToolName = isRemoteWebSearch ? 'WebSearch' : tc.name;
                            currentToolCall = {
                                toolUseId: newToolUseId,
                                _upstreamId: tc.toolUseId,
                                name: tc.name,
                                _clientName: clientToolName,
                                _isRemoteWebSearch: isRemoteWebSearch,
                                blockIndex,
                                inputRaw: '',
                                _streamStarted: true,
                                _streamStopped: false,
                                _streamedAlready: true,
                            };
                            yield {
                                type: "content_block_start",
                                index: blockIndex,
                                content_block: {
                                    type: "tool_use",
                                    id: newToolUseId,
                                    name: clientToolName,
                                    input: {}
                                }
                            };
                        }
                        // 实时 yield input_json_delta — 这就是消除 25s 卡顿的关键
                        if (tc.input) {
                            currentToolCall.inputRaw += tc.input;
                            yield {
                                type: "content_block_delta",
                                index: currentToolCall.blockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: tc.input
                                }
                            };
                        }
                        // 如果这个事件包含 stop，完成工具调用
                        if (tc.stop) {
                            if (!currentToolCall._streamStopped) {
                                yield { type: "content_block_stop", index: currentToolCall.blockIndex };
                                currentToolCall._streamStopped = true;
                            }
                            try {
                                currentToolCall.input = JSON.parse(currentToolCall.inputRaw || '');
                            } catch (e) {
                                currentToolCall.input = currentToolCall.inputRaw || '';
                            }
                            toolCalls.push(currentToolCall);
                            currentToolCall = null;
                        }
                    }
                } else if (event.type === 'toolUseInput') {
                    // 工具调用的 input 续传事件
                    // 统计 input 内容到 totalContent（用于 token 计算）
                    if (event.input) {
                        totalContent += event.input;
                    }
                    if (currentToolCall && event.input) {
                        currentToolCall.inputRaw = (currentToolCall.inputRaw || '') + event.input;
                        // 实时 yield 续传 chunk
                        yield {
                            type: "content_block_delta",
                            index: currentToolCall.blockIndex,
                            delta: {
                                type: "input_json_delta",
                                partial_json: event.input
                            }
                        };
                    }
                } else if (event.type === 'toolUseStop') {
                    // 工具调用结束事件
                    if (currentToolCall && event.stop) {
                        if (!currentToolCall._streamStopped) {
                            yield { type: "content_block_stop", index: currentToolCall.blockIndex };
                            currentToolCall._streamStopped = true;
                        }
                        try {
                            currentToolCall.input = JSON.parse(currentToolCall.inputRaw || '');
                        } catch (e) {
                            currentToolCall.input = currentToolCall.inputRaw || '';
                        }
                        toolCalls.push(currentToolCall);
                        currentToolCall = null;
                    }
                }
            }
            
            // 处理未完成的工具调用（如果流提前结束）— 补 content_block_stop, 防止客户端卡死
            if (currentToolCall) {
                if (!currentToolCall._streamStopped) {
                    yield { type: "content_block_stop", index: currentToolCall.blockIndex };
                    currentToolCall._streamStopped = true;
                }
                try {
                    currentToolCall.input = JSON.parse(currentToolCall.inputRaw || '');
                } catch (e) {
                    currentToolCall.input = currentToolCall.inputRaw || '';
                }
                toolCalls.push(currentToolCall);
                currentToolCall = null;
            }

            if (thinkingRequested && streamState.buffer) {
                if (streamState.inThinking) {
                    console.warn('[Kiro] Incomplete thinking tag at stream end');
                    yield* pushEvents(createThinkingDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                    yield* pushEvents(createThinkingDeltaEvents(""));
                    yield* pushEvents(createSignatureDeltaEvents(streamState.thinkingBlockIndex));
                    yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
                } else if (!streamState.thinkingExtracted) {
                    yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                } else {
                    yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                }
            }

            yield* pushEvents(stopBlock(streamState.textBlockIndex));

            // 检查文本内容中的 bracket 格式工具调用
            const bracketToolCalls = parseBracketToolCalls(totalContent);
            if (bracketToolCalls && bracketToolCalls.length > 0) {
                for (const btc of bracketToolCalls) {
                    toolCalls.push({
                        toolUseId: btc.id || generateAnthropicToolUseId(),
                        name: btc.function.name,
                        input: JSON.parse(btc.function.arguments || '{}')
                    });
                }
            }

            // 3. 处理工具调用（如果有）
            //    实时 stream 路径已经在主循环里 yield 过 content_block_start/delta/stop
            //    (tc._streamedAlready === true), 这里只处理 bracket-format 解析出来的工具
            //    和任何遗漏的兜底情况.
            if (toolCalls.length > 0) {
                let blockIndexOffset = 0;
                const baseIndex = streamState.nextBlockIndex;

                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    // 已经实时 stream 过的工具跳过, 否则会重发一遍, 客户端看到两份 tool_use
                    if (tc._streamedAlready) {
                        continue;
                    }
                    const tcName = (tc.name || '').toLowerCase();

                    // 检测 remote_web_search 工具调用
                    // 返回 tool_use 类型的 WebSearch，让 Claude Code 客户端自己发起 WebSearch 请求
                    if (tcName === 'remote_web_search') {
                        const query = tc.input?.query || '';
                        console.log(`[Kiro] Detected remote_web_search, returning WebSearch tool_use for query: "${query}"`);

                        const toolUseId = tc.toolUseId || generateAnthropicToolUseId();
                        const blockIndex = baseIndex + blockIndexOffset++;

                        // 返回 tool_use 类型的 WebSearch（不是 server_tool_use）
                        yield {
                            type: "content_block_start",
                            index: blockIndex,
                            content_block: {
                                id: toolUseId,
                                type: "tool_use",
                                name: "WebSearch",
                                input: {}
                            }
                        };

                        // 分块发送 input_json_delta
                        const inputJson = JSON.stringify({ query: query });
                        yield {
                            type: "content_block_delta",
                            index: blockIndex,
                            delta: {
                                type: "input_json_delta",
                                partial_json: inputJson
                            }
                        };

                        yield { type: "content_block_stop", index: blockIndex };

                        continue; // 跳过后续处理
                    }

                    // 普通工具调用处理
                    const blockIndex = baseIndex + blockIndexOffset++;

                    // 检测空的 input（模型异常行为）
                    const inputIsEmpty = !tc.input ||
                        (typeof tc.input === 'object' && Object.keys(tc.input).length === 0) ||
                        (typeof tc.input === 'string' && tc.input.trim() === '');

                    // 如果 input 为空，构造一个带错误提示的默认 input
                    let finalInput = tc.input;
                    if (inputIsEmpty) {
                        console.warn(`[Kiro] Detected empty tool_use input for ${tc.name}, using error placeholder`);
                        // 给一个特殊的错误标记 input，让工具执行时能识别并返回有意义的错误
                        finalInput = { _error: 'EMPTY_INPUT', _message: `Tool ${tc.name} was called with empty parameters. Please retry with valid parameters.` };
                    }

                    yield {
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: {
                            type: "tool_use",
                            id: tc.toolUseId || generateAnthropicToolUseId(),
                            name: tc.name,
                            input: {}
                        }
                    };

                    yield {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                            type: "input_json_delta",
                            partial_json: typeof finalInput === 'string' ? finalInput : JSON.stringify(finalInput)
                        }
                    };

                    yield { type: "content_block_stop", index: blockIndex };
                }
            }

            // 计算 output tokens
            const contentBlocksForCount = thinkingRequested
                ? this._toClaudeContentBlocksFromKiroText(totalContent)
                : [{ type: "text", text: totalContent }];
            const plainForCount = contentBlocksForCount
                .map(b => (b.type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '')))
                .join('');
            outputTokens = this.countTextTokens(plainForCount);

            for (const tc of toolCalls) {
                outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
            }

            // 计算 input tokens
            // contextUsagePercentage 是 Kiro 返回的百分比，基于实际模型上下文窗口计算
            // 总 token = contextWindowTokens * contextUsagePercentage / 100
            // input token = 总 token - output token
            // 然后按 cacheStats 的估算比例拆分为 cache_read / cache_creation / input_tokens
            if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
                const contextWindowTokens = getKiroContextWindowTokens(finalModel);
                const displayedContextWindowTokens = getDisplayedContextWindowTokens(finalModel);
                const totalTokens = Math.round(contextWindowTokens * contextUsagePercentage / 100);
                const totalInputTokens = Math.max(0, totalTokens - outputTokens);

                // 用 cacheStats 估算比例拆分精确的 totalInputTokens
                const estimatedTotal = cacheStats.cacheReadTokens + cacheStats.cacheCreationTokens + cacheStats.inputTokens;
                if (estimatedTotal > 0) {
                    cacheStats.cacheReadTokens = Math.round(totalInputTokens * cacheStats.cacheReadTokens / estimatedTotal);
                    cacheStats.cacheCreationTokens = Math.round(totalInputTokens * cacheStats.cacheCreationTokens / estimatedTotal);
                    inputTokens = Math.max(0, totalInputTokens - cacheStats.cacheReadTokens - cacheStats.cacheCreationTokens);
                } else {
                    inputTokens = totalInputTokens;
                }
                console.log(`[Kiro] Token calculation: contextWindow=${contextWindowTokens}, total=${totalTokens}, output=${outputTokens}, totalInput=${totalInputTokens}, input=${inputTokens}, cacheRead=${cacheStats.cacheReadTokens}, cacheCreate=${cacheStats.cacheCreationTokens}`);

                // 当上下文使用超过 90% 时，注入系统提醒让 Claude Code 压缩上下文
                if (contextUsagePercentage > 90) {
                    console.warn(`[Kiro] Context usage ${contextUsagePercentage.toFixed(1)}% > 90%, injecting compaction reminder`);
                    const contextWarning = `\n\n<system-reminder>WARNING: Context usage is at ${contextUsagePercentage.toFixed(1)}% (${totalTokens}/${displayedContextWindowTokens} tokens). You should compact the conversation history immediately to avoid context overflow errors.</system-reminder>`;
                    yield {
                        type: "content_block_delta",
                        index: 0,
                        delta: {
                            type: "text_delta",
                            text: contextWarning
                        }
                    };
                }
            } else {
                console.warn('[Kiro Stream] contextUsagePercentage not received, using estimation');
                inputTokens = cacheStats.inputTokens;
            }

            // 4. 发送 message_delta 事件
            // 判断 stop_reason：如果有任何工具调用，返回 tool_use；否则 end_turn
            const hasToolCalls = toolCalls.length > 0;
            const messageDelta = {
                type: "message_delta",
                delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn" },
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheStats.cacheCreationTokens,
                    cache_read_input_tokens: cacheStats.cacheReadTokens
                },
                __ttftMs: ttftMs, // 首字耗时（内部字段）
                __requestDurationMs: Date.now() - requestStartTime // 完整请求耗时（内部字段）
            };
            // 添加 credit 消耗（Kiro 特有）
            if (creditUsage !== null) {
                messageDelta.usage.credit_usage = creditUsage;
            }
            yield messageDelta;

            // 5. 发送 message_stop 事件
            // 记录生成完成时间到追踪系统
            const traceIdFinal = requestBody.metadata?.traceId;
            if (traceIdFinal) {
                const completionMs = Date.now() - requestStartTime;
                requestTracer.recordPhase(traceIdFinal, TRACE_PHASE.COMPLETE, completionMs);
            }
            yield { type: "message_stop" };

        } catch (error) {
            console.error('[Kiro] Error in streaming generation:', error.message || error);
            // 保留原始error的所有重要属性，包括stack
            const wrappedError = new Error(`Error processing response: ${error.message || 'Unknown error'}`);
            wrappedError.curlCommand = error.curlCommand;
            wrappedError.shouldSwitchCredential = error.shouldSwitchCredential;
            wrappedError.skipErrorCount = error.skipErrorCount;
            wrappedError.response = error.response;
            // 保留原始错误的堆栈信息
            wrappedError.originalStack = error.stack;
            wrappedError.stack = error.stack || wrappedError.stack;
            throw wrappedError;
        }
    }

    /**
     * Count tokens for a given text using Claude's official tokenizer
     */
    countTextTokens(text) {
        if (!text) return 0;
        try {
            return countTokens(text);
        } catch (error) {
            // Fallback to estimation if tokenizer fails
            console.warn('[Kiro] Tokenizer error, falling back to estimation:', error.message);
            return Math.ceil((text || '').length / 4);
        }
    }

    /**
     * Calculate input tokens from request body using Claude's official tokenizer
     */
    estimateInputTokens(requestBody) {
        let totalTokens = 0;
        
        // Count system prompt tokens
        if (requestBody.system) {
            const systemText = this.getContentText(requestBody.system);
            totalTokens += this.countTextTokens(systemText);
        }
        
        // Count thinking prefix tokens if thinking is enabled
        if (requestBody.thinking?.type === 'enabled') {
            const budget = this._normalizeThinkingBudgetTokens(requestBody.thinking.budget_tokens);
            const prefixText = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
            totalTokens += this.countTextTokens(prefixText);
        }
        
        // Count all messages tokens
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                if (message.content) {
                    if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                totalTokens += this.countTextTokens(part.text);
                            } else if (part.type === 'thinking' && part.thinking) {
                                totalTokens += this.countTextTokens(part.thinking);
                            } else if (part.type === 'tool_result') {
                                const resultContent = this.getContentText(part.content);
                                totalTokens += this.countTextTokens(resultContent);
                            } else if (part.type === 'tool_use' && part.input) {
                                totalTokens += this.countTextTokens(JSON.stringify(part.input));
                            }
                        }
                    } else {
                        const contentText = this.getContentText(message);
                        totalTokens += this.countTextTokens(contentText);
                    }
                }
            }
        }
        
        // Count tools definitions tokens if present
        if (requestBody.tools && Array.isArray(requestBody.tools)) {
            totalTokens += this.countTextTokens(JSON.stringify(requestBody.tools));
        }
        
        return totalTokens;
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null, inputTokens = 0) {
        const messageId = generateAnthropicMessageId();

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0
                    },
                    service_tier: "standard",
                    inference_geo: "us",
                    content: []
                }
            });
 
            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += this.countTextTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id?.startsWith('toolu_') ? tc.id : generateAnthropicToolUseId(),
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });

                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(inputObject)
                        }
                    });

                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let stopReason = "end_turn";
            let outputTokens = 0;

            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id?.startsWith('toolu_') ? tc.id : generateAnthropicToolUseId(),
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += this.countTextTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            } else if (content) {
                contentArray.push({
                    type: "text",
                    text: content
                });
                outputTokens += this.countTextTokens(content);
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                },
                service_tier: "standard",
                inference_geo: "us",
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));
        
        return { models: models };
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now.
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const configuredNearMinutes = Number(this.config.CRON_NEAR_MINUTES || 10);
            const configuredNearMs = Math.max(0, configuredNearMinutes * 60 * 1000);

            const issuedAtMs = this.tokenIssuedAt ? new Date(this.tokenIssuedAt).getTime() : NaN;
            const expiryMs = expirationTime.getTime();
            const inferredLifetimeMs = Number.isFinite(issuedAtMs) && issuedAtMs > 0 && expiryMs > issuedAtMs
                ? (expiryMs - issuedAtMs)
                : KIRO_CONSTANTS.TOKEN_LIFETIME_FALLBACK_MS;
            const maxNearMs = Math.max(
                KIRO_CONSTANTS.TOKEN_NEAR_WINDOW_MIN_MS,
                Math.floor(inferredLifetimeMs * KIRO_CONSTANTS.TOKEN_NEAR_WINDOW_MAX_RATIO)
            );
            const effectiveNearMs = Math.min(configuredNearMs, maxNearMs);

            const thresholdTime = new Date(currentTime.getTime() + effectiveNearMs);
            console.log(`[Kiro] Expiry check: exp=${expiryMs}, now=${currentTime.getTime()}, configuredNearMs=${configuredNearMs}, effectiveNearMs=${effectiveNearMs}, threshold=${thresholdTime.getTime()}`);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            console.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * POST /v1/messages/count_tokens
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        let totalTokens = 0;

        // Count system prompt tokens
        if (requestBody.system) {
            const systemText = this.getContentText(requestBody.system);
            totalTokens += this.countTextTokens(systemText);
        }

        // Count all messages tokens
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                if (message.content) {
                    if (typeof message.content === 'string') {
                        totalTokens += this.countTextTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        for (const block of message.content) {
                            if (block.type === 'text' && block.text) {
                                totalTokens += this.countTextTokens(block.text);
                            } else if (block.type === 'tool_use') {
                                // Count tool use block tokens
                                totalTokens += this.countTextTokens(block.name || '');
                                totalTokens += this.countTextTokens(JSON.stringify(block.input || {}));
                            } else if (block.type === 'tool_result') {
                                // Count tool result block tokens
                                const resultContent = this.getContentText(block.content);
                                totalTokens += this.countTextTokens(resultContent);
                            } else if (block.type === 'image') {
                                // Images have a fixed token cost (approximately 1600 tokens for a typical image)
                                // This is an estimation as actual cost depends on image size
                                totalTokens += 1600;
                            } else if (block.type === 'document') {
                                // Documents - estimate based on content if available
                                if (block.source?.data) {
                                    // For base64 encoded documents, estimate tokens
                                    const estimatedChars = block.source.data.length * 0.75; // base64 to bytes ratio
                                    totalTokens += Math.ceil(estimatedChars / 4);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Count tools definitions tokens if present
        if (requestBody.tools && Array.isArray(requestBody.tools)) {
            for (const tool of requestBody.tools) {
                // Count tool name and description
                totalTokens += this.countTextTokens(tool.name || '');
                totalTokens += this.countTextTokens(tool.description || '');
                // Count input schema
                if (tool.input_schema) {
                    totalTokens += this.countTextTokens(JSON.stringify(tool.input_schema));
                }
            }
        }

        return { input_tokens: totalTokens };
    }

    /**
     * 获取缓存的用量限制信息（避免频繁请求）
     * @returns {Promise<Object>} 用量限制信息
     */
    async _getUsageLimitsCached() {
        const now = Date.now();
        // 缓存有效，直接返回
        if (this._usageCache && (now - this._usageCacheTime) < this._usageCacheTTL) {
            return this._usageCache;
        }
        // 缓存过期或不存在，重新获取
        try {
            this._usageCache = await this.getUsageLimits();
            this._usageCacheTime = now;
            return this._usageCache;
        } catch (error) {
            // 获取失败时，如果有旧缓存则返回旧缓存，否则抛出错误
            if (this._usageCache) {
                console.warn('[Kiro] Failed to refresh usage cache, using stale data');
                return this._usageCache;
            }
            throw error;
        }
    }

    /**
     * 预检查配额是否充足（在流式请求前调用）
     * @throws {Error} 配额耗尽时抛出带 shouldSwitchCredential 标记的错误
     */
    async _preflightQuotaCheck() {
        try {
            const usage = await this._getUsageLimitsCached();
            if (usage && usage.usedCount >= usage.limitCount) {
                if (this.allowOverQuota) {
                    console.log(`[Kiro] Usage is over quota (${usage.usedCount}/${usage.limitCount}); over-quota mode enabled, continuing request.`);
                    return;
                }

                console.log(`[Kiro] Quota exhausted: ${usage.usedCount}/${usage.limitCount}`);
                const error = new Error('Quota exhausted - switching credential');
                error.status = 402;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
        } catch (error) {
            // 如果是配额耗尽错误，直接抛出
            if (error.shouldSwitchCredential) {
                throw error;
            }
            // 其他错误（如网络问题）只记录日志，不阻止请求
            console.warn('[Kiro] Preflight quota check failed:', error.message);
        }
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits(authRetried = false) {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before getUsageLimits request...');
            await this.initializeAuth(true);
        }
        
        // 内部固定的资源类型
        const resourceType = 'AGENTIC_REQUEST';
        
        // 构建请求 URL
        const usageLimitsUrl = KIRO_CONSTANTS.USAGE_LIMITS_URL.replace('{{region}}', this.region);
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: resourceType
        });
        if (this.profileArn) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${usageLimitsUrl}?${params.toString()}`;

        // 构建请求头（使用设备槽位隔离）
        const deviceHeaders = this._generateDeviceHeaders();
        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            ...deviceHeaders,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=1',
            'Connection': 'close'
        };

        try {
            const response = await this.axiosInstance.get(fullUrl, { headers });
            console.log('[Kiro] Usage limits fetched successfully');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            
            // 从响应体中提取错误信息
            let errorMessage = error.message;
            if (error.response?.data) {
                // 尝试从响应体中获取错误描述
                const responseData = error.response.data;
                if (typeof responseData === 'string') {
                    errorMessage = responseData;
                } else if (responseData.message) {
                    errorMessage = responseData.message;
                } else if (responseData.error) {
                    errorMessage = typeof responseData.error === 'string' ? responseData.error : responseData.error.message || JSON.stringify(responseData.error);
                }
            }
            
            // 构建包含状态码和错误描述的错误信息
            const formattedError = status
                ? new Error(`API call failed: ${status} - ${errorMessage}`)
                : new Error(`API call failed: ${errorMessage}`);
            
            if (status === 401 && !authRetried) {
                console.log('[Kiro] Received 401 on getUsageLimits. Refreshing token and retrying once...');
                try {
                    await this.initializeAuth(true, true);
                    return this.getUsageLimits(true);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed after 401 on getUsageLimits, marking as deleted:', refreshError.message);
                    await this._markCredentialDeleted('401 - Token refresh failed on usage query', formattedError);
                    throw formattedError;
                }
            }

            if (status === 401) {
                console.log('[Kiro] Received 401 on getUsageLimits after retry. Marking credential as deleted...');
                await this._markCredentialDeleted('401 Unauthorized on usage query after token refresh', formattedError);
                throw formattedError;
            }
            
            // Handle 403 - immediately switch, async refresh token in background
            if (status === 403) {
                const errMsg = String(formattedError.message || '');
                const isSuspended = /suspended/i.test(errMsg) || /unusual.*activity/i.test(errMsg);
                if (isSuspended) {
                    console.log(`[Kiro] Received 403 on getUsageLimits with account suspended. Deleting credential immediately: ${(this.uuid || '').slice(0,8)}`);
                    await this._markCredentialDeleted('403 - Account suspended on usage query', formattedError);
                } else {
                    console.log('[Kiro] Received 403 on getUsageLimits. Marking unhealthy, async refresh in background...');
                    await this._markCredentialUnhealthy('403 Forbidden on usage query', formattedError);
                    this._asyncRefreshOrDelete('403 Forbidden on usage query');
                }
                throw formattedError;
            }
            
            console.error('[Kiro] Failed to fetch usage limits:', formattedError.message, error.message || 'Unknown error');
            throw formattedError;
        }
    }

    /**
     * 解析用量信息为标准格式
     * @param {Object} rawData - getUsageLimits 返回的原始数据
     * @returns {Object} 标准化的用量信息
     */
    parseUsageInfo(rawData) {
        if (!rawData) return null;

        const result = {
            subscriptionTitle: rawData.subscriptionInfo?.subscriptionTitle || null,
            subscriptionType: rawData.subscriptionInfo?.type || null,
            usageLimit: null,
            currentUsage: null,
            nextResetTime: null,
            freeTrialExpiry: null,
            freeTrialStatus: null
        };

        // 解析 usageBreakdownList 中的 Credit 信息
        const creditBreakdown = rawData.usageBreakdownList?.find(
            item => item.resourceType === 'CREDIT'
        );

        if (creditBreakdown) {
            // 优先使用 freeTrialInfo（免费试用期间）
            if (creditBreakdown.freeTrialInfo) {
                const trial = creditBreakdown.freeTrialInfo;
                result.usageLimit = trial.usageLimitWithPrecision ?? trial.usageLimit;
                result.currentUsage = trial.currentUsageWithPrecision ?? trial.currentUsage;
                result.freeTrialStatus = trial.freeTrialStatus;
                // 转换时间戳为 Date
                if (trial.freeTrialExpiry) {
                    result.freeTrialExpiry = new Date(trial.freeTrialExpiry * 1000);
                }
            } else {
                // 非试用期，使用常规额度
                result.usageLimit = creditBreakdown.usageLimitWithPrecision ?? creditBreakdown.usageLimit;
                result.currentUsage = creditBreakdown.currentUsageWithPrecision ?? creditBreakdown.currentUsage;
            }

            // 下次重置时间
            if (creditBreakdown.nextDateReset) {
                result.nextResetTime = new Date(creditBreakdown.nextDateReset * 1000);
            }
        }

        // 如果没有从 breakdown 获取到重置时间，使用顶层的
        if (!result.nextResetTime && rawData.nextDateReset) {
            result.nextResetTime = new Date(rawData.nextDateReset * 1000);
        }

        return result;
    }

    /**
     * 获取账号可用的模型列表
     * @returns {Promise<Object>} 可用模型信息
     */
    async listAvailableModels(authRetried = false) {
        if (!this.isInitialized) await this.initialize();

        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before listAvailableModels request...');
            await this.initializeAuth(true);
        }

        // 构建请求 URL
        const listModelsUrl = KIRO_CONSTANTS.LIST_MODELS_URL.replace('{{region}}', this.region);
        const params = new URLSearchParams({
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        });
        if (this.profileArn) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${listModelsUrl}?${params.toString()}`;

        // 构建请求头（使用设备槽位隔离）
        const deviceHeaders = this._generateDeviceHeaders();
        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            ...deviceHeaders,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=1',
            'Connection': 'close'
        };

        try {
            const response = await this.axiosInstance.get(fullUrl, { headers });
            console.log('[Kiro] Available models fetched successfully');
            return response.data;
        } catch (error) {
            const status = error.response?.status;

            let errorMessage = error.message;
            if (error.response?.data) {
                const responseData = error.response.data;
                if (typeof responseData === 'string') {
                    errorMessage = responseData;
                } else if (responseData.message) {
                    errorMessage = responseData.message;
                } else if (responseData.error) {
                    errorMessage = typeof responseData.error === 'string'
                        ? responseData.error
                        : responseData.error.message || JSON.stringify(responseData.error);
                }
            }

            const formattedError = status
                ? new Error(`ListAvailableModels failed: ${status} - ${errorMessage}`)
                : new Error(`ListAvailableModels failed: ${errorMessage}`);

            if (status === 401 && !authRetried) {
                console.log('[Kiro] Received 401 on listAvailableModels. Refreshing token and retrying once...');
                try {
                    await this.initializeAuth(true, true);
                    return this.listAvailableModels(true);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed after 401 on listAvailableModels:', refreshError.message);
                    await this._markCredentialDeleted('401 - Token refresh failed on models query', formattedError);
                    throw formattedError;
                }
            }

            if (status === 401) {
                console.log('[Kiro] Received 401 on listAvailableModels after retry. Marking credential as deleted...');
                await this._markCredentialDeleted('401 Unauthorized on models query after token refresh', formattedError);
                throw formattedError;
            }

            // Handle 403 - immediately switch, async refresh token in background
            if (status === 403) {
                const errMsg = String(formattedError.message || '');
                const isSuspended = /suspended/i.test(errMsg) || /unusual.*activity/i.test(errMsg);
                if (isSuspended) {
                    console.log(`[Kiro] Received 403 on listAvailableModels with account suspended. Deleting credential immediately: ${(this.uuid || '').slice(0,8)}`);
                    await this._markCredentialDeleted('403 - Account suspended on models query', formattedError);
                } else {
                    console.log('[Kiro] Received 403 on listAvailableModels. Marking unhealthy, async refresh in background...');
                    await this._markCredentialUnhealthy('403 Forbidden on models query', formattedError);
                    this._asyncRefreshOrDelete('403 Forbidden on models query');
                }
                throw formattedError;
            }

            console.error('[Kiro] Failed to fetch available models:', formattedError.message);
            throw formattedError;
        }
    }

    /**
     * 解析可用模型列表为标准格式
     * @param {Object} rawData - listAvailableModels 返回的原始数据
     * @returns {Array<string>} 可用模型ID列表
     */
    parseAvailableModels(rawData) {
        if (!rawData || !rawData.availableModels) {
            return [];
        }

        // 提取模型ID列表
        return rawData.availableModels.map(model => model.modelId || model.id).filter(Boolean);
    }

    // ==================== WebSearch 支持 ====================

    /**
     * 检查请求是否为纯 WebSearch 请求
     * 条件：tools 有且只有一个，且 name 为 web_search
     * @param {Object} requestBody - 请求体
     * @returns {boolean}
     */
    isWebSearchRequest(requestBody) {
        const tools = requestBody.tools;
        if (!tools || !Array.isArray(tools) || tools.length !== 1) {
            return false;
        }
        const toolName = (tools[0].name || '').toLowerCase();
        return toolName === 'web_search';
    }

    /**
     * 从消息中提取搜索查询
     * @param {Object} requestBody - 请求体
     * @returns {string|null} 搜索查询
     */
    extractSearchQuery(requestBody) {
        const messages = requestBody.messages;
        if (!messages || messages.length === 0) {
            return null;
        }

        // 获取第一条消息
        const firstMsg = messages[0];
        let text = '';

        if (typeof firstMsg.content === 'string') {
            text = firstMsg.content;
        } else if (Array.isArray(firstMsg.content)) {
            const firstBlock = firstMsg.content[0];
            if (firstBlock && firstBlock.type === 'text' && firstBlock.text) {
                text = firstBlock.text;
            }
        }

        if (!text) {
            return null;
        }

        // 去除前缀 "Perform a web search for the query: "
        const PREFIX = 'Perform a web search for the query: ';
        if (text.startsWith(PREFIX)) {
            text = text.substring(PREFIX.length);
        }

        return text.trim() || null;
    }

    /**
     * 生成随机 ID（22位大小写字母和数字）
     */
    _generateRandomId22() {
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 22; i++) {
            result += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return result;
    }

    /**
     * 生成随机 ID（8位小写字母和数字）
     */
    _generateRandomId8() {
        const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return result;
    }

    /**
     * 创建 MCP 请求
     * @param {string} query - 搜索查询
     * @returns {{ toolUseId: string, mcpRequest: Object }}
     */
    createMcpRequest(query) {
        const random22 = this._generateRandomId22();
        const timestamp = Date.now();
        const random8 = this._generateRandomId8();

        const requestId = `web_search_tooluse_${random22}_${timestamp}_${random8}`;
        const toolUseId = generateAnthropicSrvToolUseId();

        const mcpRequest = {
            id: requestId,
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'web_search',
                arguments: {
                    query: query
                }
            }
        };

        return { toolUseId, mcpRequest };
    }

    /**
     * 调用 MCP API
     * @param {Object} mcpRequest - MCP 请求对象
     * @returns {Promise<Object>} MCP 响应
     */
    async callMcpApi(mcpRequest) {
        if (!this.isInitialized) await this.initialize();

        const mcpUrl = KIRO_CONSTANTS.MCP_URL.replace('{{region}}', this.region);
        const deviceHeaders = this._generateDeviceHeaders();
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
            ...deviceHeaders,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=3',
            'Connection': 'close'
        };
        if (this.profileArn) {
            headers['x-amzn-kiro-profile-arn'] = this.profileArn;
        }

        try {
            const response = await this.axiosInstance.post(mcpUrl, mcpRequest, { headers });
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            console.error(`[Kiro] MCP API call failed (status=${status}):`, error.message);
            throw error;
        }
    }

    /**
     * 解析 MCP 响应中的搜索结果
     * @param {Object} mcpResponse - MCP 响应
     * @returns {Object|null} 搜索结果
     */
    parseSearchResults(mcpResponse) {
        if (!mcpResponse || mcpResponse.error) {
            if (mcpResponse?.error) {
                console.warn('[Kiro] MCP error:', mcpResponse.error);
            }
            return null;
        }

        const result = mcpResponse.result;
        if (!result || !result.content || result.content.length === 0) {
            return null;
        }

        const content = result.content[0];
        if (content.type !== 'text') {
            return null;
        }

        try {
            return JSON.parse(content.text);
        } catch (e) {
            console.warn('[Kiro] Failed to parse search results:', e.message);
            return null;
        }
    }

    /**
     * 生成搜索结果摘要
     * @param {string} query - 搜索查询
     * @param {Object|null} searchResults - 搜索结果
     * @returns {string} 摘要文本
     */
    generateSearchSummary(query, searchResults) {
        let summary = `Here are the search results for "${query}":\n\n`;

        if (searchResults && searchResults.results && searchResults.results.length > 0) {
            searchResults.results.forEach((result, i) => {
                summary += `${i + 1}. **${result.title}**\n`;
                if (result.snippet) {
                    const truncated = result.snippet.length > 200
                        ? result.snippet.substring(0, 200) + '...'
                        : result.snippet;
                    summary += `   ${truncated}\n`;
                }
                summary += `   Source: ${result.url}\n\n`;
            });
        } else {
            summary += 'No results found.\n';
        }

        summary += '\nPlease note that these are web search results and may not be fully accurate or up-to-date.';
        return summary;
    }

    /**
     * 处理 WebSearch 请求（流式）
     * @param {string} model - 模型名称
     * @param {Object} requestBody - 请求体
     * @yields {Object} SSE 事件
     */
    async * handleWebSearchStream(model, requestBody) {
        const query = this.extractSearchQuery(requestBody);
        if (!query) {
            throw new Error('Cannot extract search query from messages');
        }

        console.log(`[Kiro] Processing WebSearch request: "${query}"`);

        // 创建 MCP 请求
        const { toolUseId, mcpRequest } = this.createMcpRequest(query);

        // 调用 MCP API
        let searchResults = null;
        try {
            const mcpResponse = await this.callMcpApi(mcpRequest);
            searchResults = this.parseSearchResults(mcpResponse);
        } catch (error) {
            console.warn('[Kiro] MCP API call failed:', error.message);
        }

        // 估算 input tokens
        const inputTokens = this.estimateInputTokens(requestBody);
        const messageId = uuidv4();

        // 1. message_start
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            }
        };

        // 2. content_block_start (空 text 块) - index:0
        yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
        };
        yield { type: 'content_block_stop', index: 0 };

        // 3. content_block_start (server_tool_use) - index:1
        yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
                id: toolUseId,
                type: 'server_tool_use',
                name: 'web_search',
                input: {}
            }
        };

        // 4. content_block_delta (input_json_delta) - 分块发送
        const queryJson = JSON.stringify({ query: query });
        for (let i = 0; i < queryJson.length; i += 10) {
            yield {
                type: 'content_block_delta',
                index: 1,
                delta: {
                    type: 'input_json_delta',
                    partial_json: queryJson.substring(i, i + 10)
                }
            };
        }

        // 5. content_block_stop (server_tool_use)
        yield { type: 'content_block_stop', index: 1 };

        // 6. content_block_start (web_search_tool_result) - index:2
        const searchContent = searchResults && searchResults.results
            ? searchResults.results.map(r => {
                let domain = r.domain || '';
                if (!domain && r.url) {
                    try { domain = new URL(r.url).hostname; } catch (e) { domain = ''; }
                }
                return {
                    type: 'web_search_result',
                    title: r.title || domain,
                    url: r.url || '',
                    domain: domain,
                    encrypted_content: '',
                    page_age: ''
                };
            })
            : [];

        yield {
            type: 'content_block_start',
            index: 2,
            content_block: {
                type: 'web_search_tool_result',
                tool_use_id: toolUseId,
                content: searchContent
            }
        };

        // 7. content_block_stop (web_search_tool_result)
        yield { type: 'content_block_stop', index: 2 };

        // 8. content_block_start (text) - index:3
        yield {
            type: 'content_block_start',
            index: 3,
            content_block: { type: 'text', text: '' }
        };

        // 9. content_block_delta (text_delta) - 生成搜索结果摘要
        const summary = this.generateSearchSummary(query, searchResults);

        // 分块发送文本（每100字符一块）
        const chunkSize = 100;
        for (let i = 0; i < summary.length; i += chunkSize) {
            const chunk = summary.substring(i, i + chunkSize);
            yield {
                type: 'content_block_delta',
                index: 3,
                delta: { type: 'text_delta', text: chunk }
            };
        }

        // 10. content_block_stop (text)
        yield { type: 'content_block_stop', index: 3 };

        // 11. message_delta - stop_reason 必须是 tool_use
        const outputTokens = Math.ceil(summary.length / 4);
        yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: outputTokens }
        };

        // 12. message_stop
        yield { type: 'message_stop' };
    }

    /**
     * 处理 WebSearch 请求（非流式）
     * @param {string} model - 模型名称
     * @param {Object} requestBody - 请求体
     * @returns {Object} Claude 格式响应
     */
    async handleWebSearchNonStream(model, requestBody) {
        const query = this.extractSearchQuery(requestBody);
        if (!query) {
            throw new Error('Cannot extract search query from messages');
        }

        console.log(`[Kiro] Processing WebSearch request (non-stream): "${query}"`);

        // 创建 MCP 请求
        const { toolUseId, mcpRequest } = this.createMcpRequest(query);

        // 调用 MCP API
        let searchResults = null;
        try {
            const mcpResponse = await this.callMcpApi(mcpRequest);
            searchResults = this.parseSearchResults(mcpResponse);
        } catch (error) {
            console.warn('[Kiro] MCP API call failed:', error.message);
        }

        // 估算 tokens
        const inputTokens = this.estimateInputTokens(requestBody);
        const summary = this.generateSearchSummary(query, searchResults);
        const outputTokens = Math.ceil(summary.length / 4);

        // 构建搜索结果内容 - Claude Code 格式
        const searchContent = searchResults && searchResults.results
            ? searchResults.results.map(r => {
                let domain = r.domain || '';
                if (!domain && r.url) {
                    try { domain = new URL(r.url).hostname; } catch (e) { domain = ''; }
                }
                return {
                    type: 'web_search_result',
                    title: r.title || domain,
                    url: r.url || '',
                    domain: domain,
                    encrypted_content: '',
                    page_age: ''
                };
            })
            : [];

        return {
            id: `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
            type: 'message',
            role: 'assistant',
            model: model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
            },
            content: [
                {
                    id: toolUseId,
                    type: 'server_tool_use',
                    name: 'web_search',
                    input: { query: query }
                },
                {
                    type: 'web_search_tool_result',
                    tool_use_id: toolUseId,
                    content: searchContent
                },
                {
                    type: 'text',
                    text: summary
                }
            ]
        };
    }
}
