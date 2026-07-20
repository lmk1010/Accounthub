
import { OAuth2Client } from 'google-auth-library';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import { formatExpiryTime, isRetryableNetworkError } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { handleGeminiAntigravityOAuth } from '../../auth/oauth-handlers.js';
import { getProxyConfigForProvider, getGoogleAuthProxyConfig } from '../../utils/proxy-utils.js';
import { cleanJsonSchemaProperties } from '../../converters/utils.js';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import { withDeduplication } from '../../utils/file-lock.js';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';

// 配置 HTTP/HTTPS agent 限制连接池大小，优化高并发性能
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 120000,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    timeout: 120000,
});

// --- Constants ---

// Base URLs - 按照 Go 代码的降级顺序
const ANTIGRAVITY_BASE_URL_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_SANDBOX_BASE_URL_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_BASE_URL_PROD = 'https://cloudcode-pa.googleapis.com';

const ANTIGRAVITY_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_SECRET || '';
const DEFAULT_USER_AGENT = 'antigravity/1.104.0 darwin/arm64';
const REFRESH_SKEW = 3000; // 3000秒（50分钟）提前刷新Token

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;


// Thinking 配置相关常量
const DEFAULT_THINKING_MIN = 1024;
const DEFAULT_THINKING_MAX = 100000;

// Safety Settings 阈值配置 (可通过环境变量 GEMINI_SAFETY_THRESHOLD 配置)
const SAFETY_THRESHOLD_MAP = {
    'OFF': 'OFF',
    'LOW': 'BLOCK_LOW_AND_ABOVE',
    'MEDIUM': 'BLOCK_MEDIUM_AND_ABOVE',
    'HIGH': 'BLOCK_ONLY_HIGH',
    'NONE': 'BLOCK_NONE'
};

/**
 * 递归深度清理 JSON 中的 cache_control 字段
 * [FIX #593] 防止 "Extra inputs are not permitted" 错误
 * @param {Object} value - 要清理的对象
 */
function deepCleanCacheControl(value) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (const item of value) {
            deepCleanCacheControl(item);
        }
    } else {
        if (value.cache_control !== undefined) {
            delete value.cache_control;
        }
        for (const key of Object.keys(value)) {
            if (typeof value[key] === 'object') {
                deepCleanCacheControl(value[key]);
            }
        }
    }
}

/**
 * 构建 Safety Settings 配置
 * 可通过环境变量 GEMINI_SAFETY_THRESHOLD 配置阈值
 * @returns {Array} Safety settings 数组
 */
function buildSafetySettings() {
    const envThreshold = process.env.GEMINI_SAFETY_THRESHOLD?.toUpperCase() || 'OFF';
    const threshold = SAFETY_THRESHOLD_MAP[envThreshold] || 'OFF';

    return [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold },
        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold }
    ];
}

/**
 * 合并连续的同角色消息
 * [FIX #813] 确保请求符合 Gemini 的角色交替协议
 * 参考: request.rs merge_adjacent_roles
 * @param {Array} contents - 消息内容数组
 * @returns {Array} 合并后的消息数组
 */
function mergeAdjacentRoles(contents) {
    if (!contents || contents.length <= 1) return contents;

    const merged = [];
    let current = { ...contents[0], parts: [...(contents[0].parts || [])] };

    for (let i = 1; i < contents.length; i++) {
        const next = contents[i];
        if (current.role === next.role) {
            // 合并 parts
            if (next.parts) {
                current.parts = [...current.parts, ...next.parts];
            }
        } else {
            // 合并完成后，对 model 消息重排序 parts（参考 request.rs:1602-1604）
            if (current.role === 'model') {
                current.parts = reorderGeminiParts(current.parts);
            }
            merged.push(current);
            current = { ...next, parts: [...(next.parts || [])] };
        }
    }
    // 最后一条消息也需要重排序
    if (current.role === 'model') {
        current.parts = reorderGeminiParts(current.parts);
    }
    merged.push(current);

    return merged;
}

/**
 * 对 assistant/model 消息中的 parts 进行排序
 * [FIX #709] 确保 thinking 块在最前面，然后是 text，最后是 tool
 * @param {Array} parts - parts 数组
 * @returns {Array} 排序后的 parts 数组
 */
function reorderGeminiParts(parts) {
    if (!parts || parts.length <= 1) return parts;

    const thinkingParts = [];
    const textParts = [];
    const toolParts = [];
    const otherParts = [];

    for (const part of parts) {
        if (part.thought === true) {
            thinkingParts.push(part);
        } else if (part.functionCall) {
            toolParts.push(part);
        } else if (part.text !== undefined) {
            // 过滤空文本
            if (part.text.trim() && part.text !== '(no content)') {
                textParts.push(part);
            }
        } else {
            otherParts.push(part);
        }
    }

    return [...thinkingParts, ...textParts, ...otherParts, ...toolParts];
}

/**
 * 深度清理 JSON 中的 [undefined] 字符串
 * [FIX] Cherry Studio 等客户端常见注入问题
 * @param {Object} value - 要清理的对象
 */
function deepCleanUndefined(value) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
            if (value[i] === '[undefined]' || value[i] === 'undefined') {
                value.splice(i, 1);
            } else if (typeof value[i] === 'object') {
                deepCleanUndefined(value[i]);
            }
        }
    } else {
        for (const key of Object.keys(value)) {
            if (value[key] === '[undefined]' || value[key] === 'undefined') {
                delete value[key];
            } else if (typeof value[key] === 'object') {
                deepCleanUndefined(value[key]);
            }
        }
    }
}

/**
 * 递归清理 thinking 相关字段
 * [FIX] 当 thinking 禁用时，清理所有 thought/thoughtSignature 字段
 * @param {Object} value - 要清理的对象
 */
function cleanThinkingFieldsRecursive(value) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (const item of value) {
            cleanThinkingFieldsRecursive(item);
        }
    } else {
        delete value.thought;
        delete value.thoughtSignature;
        for (const key of Object.keys(value)) {
            if (typeof value[key] === 'object') {
                cleanThinkingFieldsRecursive(value[key]);
            }
        }
    }
}

// 获取 Antigravity 模型列表
const ANTIGRAVITY_MODELS = getProviderModels('gemini-antigravity');

// 模型别名映射 - 别名 -> 真实模型名
const MODEL_ALIAS_MAP = {
    'gemini-2.5-computer-use-preview-10-2025': 'rev19-uic3-1p',
    'gemini-3-pro-image-preview': 'gemini-3-pro-image',
    'gemini-3-pro-preview': 'gemini-3-pro-high',
    'gemini-3-flash-preview': 'gemini-3-flash',
    'gemini-2.5-flash-preview': 'gemini-2.5-flash',
    // Claude 模型（基础名称）
    'gemini-claude-sonnet-4-5': 'claude-sonnet-4-5',
    'gemini-claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',
    'gemini-claude-opus-4': 'claude-opus-4',
    'gemini-claude-opus-4-5': 'claude-opus-4-5',
    'gemini-claude-opus-4-5-thinking': 'claude-opus-4-5-thinking',
    'gemini-claude-haiku-4-5': 'claude-haiku-4-5',
    'gemini-claude-4-sonnet': 'claude-4-sonnet',
    'gemini-claude-4-opus': 'claude-4-opus',
    // Claude 模型（带日期后缀）
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
    'claude-opus-4-5-20251101': 'claude-opus-4-5',
    'claude-opus-4-5-20251101-thinking': 'claude-opus-4-5-thinking',
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5'
};

// 真实模型名 -> 别名
const MODEL_NAME_MAP = {
    'rev19-uic3-1p': 'gemini-2.5-computer-use-preview-10-2025',
    'gemini-3-pro-image': 'gemini-3-pro-image-preview',
    'gemini-3-pro-high': 'gemini-3-pro-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-2.5-flash': 'gemini-2.5-flash-preview',
    // Claude 模型
    'claude-sonnet-4-5': 'gemini-claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking': 'gemini-claude-sonnet-4-5-thinking',
    'claude-opus-4': 'gemini-claude-opus-4',
    'claude-opus-4-5': 'gemini-claude-opus-4-5',
    'claude-opus-4-5-thinking': 'gemini-claude-opus-4-5-thinking',
    'claude-haiku-4-5': 'gemini-claude-haiku-4-5',
    'claude-4-sonnet': 'gemini-claude-4-sonnet',
    'claude-4-opus': 'gemini-claude-4-opus'
};

/**
 * 将别名转换为真实模型名
 * @param {string} modelName - 模型别名
 * @returns {string} 真实模型名
 */
function alias2ModelName(modelName) {
    // 直接匹配
    if (MODEL_ALIAS_MAP[modelName]) {
        return MODEL_ALIAS_MAP[modelName];
    }

    // 处理带日期后缀的模型名（如 claude-opus-4-5-20251101 -> claude-opus-4-5）
    // 匹配模式：模型名-YYYYMMDD
    const datePattern = /-\d{8}$/;
    if (datePattern.test(modelName)) {
        const baseName = modelName.replace(datePattern, '');
        if (MODEL_ALIAS_MAP[baseName]) {
            return MODEL_ALIAS_MAP[baseName];
        }
        // 如果去掉日期后的名称本身就是真实模型名，直接返回
        if (Object.values(MODEL_ALIAS_MAP).includes(baseName)) {
            return baseName;
        }
    }

    // 如果模型名本身就是真实模型名（在 MODEL_NAME_MAP 中），直接返回
    if (MODEL_NAME_MAP[modelName]) {
        return modelName;
    }

    return undefined;
}

/**
 * 将真实模型名转换为别名
 * @param {string} modelName - 真实模型名
 * @returns {string|null} 模型别名，如果不支持则返回 null
 */
function modelName2Alias(modelName) {
    return MODEL_NAME_MAP[modelName];
}

/**
 * 检查模型是否为 Claude 模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function isClaude(modelName) {
    return modelName && modelName.toLowerCase().includes('claude');
}

/**
 * 检查是否为图像模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function isImageModel(modelName) {
    return modelName && modelName.toLowerCase().includes('image');
}

/**
 * 检查模型是否支持 Thinking
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function modelSupportsThinking(modelName) {
    if (!modelName) return false;
    const name = modelName.toLowerCase();
    // 支持 thinking 的模型：gemini-3-*, gemini-2.5-*, claude-*-thinking
    return name.startsWith('gemini-3-') ||
           name.startsWith('gemini-2.5-') ||
           name.includes('-thinking');
}

/**
 * 生成随机请求ID
 * @returns {string}
 */
function generateRequestID() {
    return 'agent-' + uuidv4();
}

/**
 * 生成随机会话ID
 * @returns {string}
 */
function generateSessionID() {
    const n = Math.floor(Math.random() * 9000);
    return '-' + n.toString();
}

/**
 * 基于请求内容生成稳定的会话ID
 * 使用第一个用户消息的 SHA256 哈希值
 * @param {Object} payload - 请求体
 * @returns {string} 稳定的会话ID
 */
function generateStableSessionID(payload) {
    try {
        const contents = payload?.request?.contents;
        if (Array.isArray(contents)) {
            for (const content of contents) {
                if (content.role === 'user') {
                    const text = content.parts?.[0]?.text;
                    if (text) {
                        const hash = crypto.createHash('sha256').update(text).digest();
                        // 取前8字节转换为 BigInt，然后取正数
                        const n = hash.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
                        return '-' + n.toString();
                    }
                }
            }
        }
    } catch (e) {
        // 如果解析失败，回退到随机会话ID
    }
    return generateSessionID();
}

/**
 * 生成随机项目ID
 * @returns {string}
 */
function generateProjectID() {
    const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
    const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomPart = uuidv4().toLowerCase().substring(0, 5);
    return `${adj}-${noun}-${randomPart}`;
}

/**
 * 规范化 Thinking Budget
 * @param {string} modelName - 模型名称
 * @param {number} budget - 原始 budget 值
 * @returns {number} 规范化后的 budget
 */
function normalizeThinkingBudget(modelName, budget) {
    // -1 表示动态/无限制
    if (budget === -1) return -1;
    
    // 获取模型的 thinking 限制
    const min = DEFAULT_THINKING_MIN;
    const max = DEFAULT_THINKING_MAX;
    
    // 限制在有效范围内
    if (budget < min) return min;
    if (budget > max) return max;
    return budget;
}

/**
 * 规范化 Antigravity Thinking 配置
 * 对于 Claude 模型，确保 thinking budget < max_tokens
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {boolean} isClaudeModel - 是否为 Claude 模型
 * @returns {Object} 处理后的请求体
 */
function normalizeAntigravityThinking(modelName, payload, isClaudeModel) {
    // 如果模型不支持 thinking，移除 thinking 配置
    if (!modelSupportsThinking(modelName)) {
        if (payload?.request?.generationConfig?.thinkingConfig) {
            delete payload.request.generationConfig.thinkingConfig;
        }
        return payload;
    }
    
    const thinkingConfig = payload?.request?.generationConfig?.thinkingConfig;
    if (!thinkingConfig) return payload;
    
    const budget = thinkingConfig.thinkingBudget;
    if (budget === undefined) return payload;
    
    let normalizedBudget = normalizeThinkingBudget(modelName, budget);
    
    // 对于 Claude 模型，确保 thinking budget < max_tokens
    if (isClaudeModel) {
        const maxTokens = payload?.request?.generationConfig?.maxOutputTokens;
        if (maxTokens && maxTokens > 0 && normalizedBudget >= maxTokens) {
            normalizedBudget = maxTokens - 1;
        }
        
        // 检查最小 budget
        const minBudget = DEFAULT_THINKING_MIN;
        if (normalizedBudget >= 0 && normalizedBudget < minBudget) {
            // Budget 低于最小值，移除 thinking 配置
            delete payload.request.generationConfig.thinkingConfig;
            return payload;
        }
    }
    
    payload.request.generationConfig.thinkingConfig.thinkingBudget = normalizedBudget;
    return payload;
}

/**
 * 将 Gemini 格式请求转换为 Antigravity 格式
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {string} projectId - 项目ID
 * @returns {Object} 转换后的请求体
 */
function geminiToAntigravity(modelName, payload, projectId) {
    // 深拷贝请求体,避免修改原始对象
    let template = JSON.parse(JSON.stringify(payload));

    const isClaudeModel = isClaude(modelName);

    // 设置基本字段
    template.model = modelName;
    template.userAgent = 'antigravity';
    template.requestType = 'agent';
    template.project = projectId || generateProjectID();
    template.requestId = generateRequestID();

    // 确保 request 对象存在
    if (!template.request) {
        template.request = {};
    }

    // 设置会话ID - 使用稳定的会话ID
    template.request.sessionId = generateStableSessionID(template);

    // 删除安全设置
    if (template.request.safetySettings) {
        delete template.request.safetySettings;
    }

    // 参考 CLIProxyAPI: 如果 toolConfig 在顶层而不是 request 内，移动它
    if (template.toolConfig && !template.request.toolConfig) {
        template.request.toolConfig = template.toolConfig;
        delete template.toolConfig;
    }

    // 设置工具配置 - Claude 模型需要 VALIDATED 模式
    if (isClaudeModel) {
        // Claude 模型保留 tools，但需要设置 VALIDATED 模式
        if (template.request.tools && template.request.tools.length > 0) {
            if (!template.request.toolConfig) {
                template.request.toolConfig = {};
            }
            if (!template.request.toolConfig.functionCallingConfig) {
                template.request.toolConfig.functionCallingConfig = {};
            }
            template.request.toolConfig.functionCallingConfig.mode = 'VALIDATED';
        }
    } else {
        // 非 Claude 模型的工具配置
        if (template.request.toolConfig) {
            if (!template.request.toolConfig.functionCallingConfig) {
                template.request.toolConfig.functionCallingConfig = {};
            }
            template.request.toolConfig.functionCallingConfig.mode = 'VALIDATED';
        }
    }

    // 处理 Thinking 配置
    // 对于非 gemini-3-* 模型，将 thinkingLevel 转换为 thinkingBudget
    if (!modelName.startsWith('gemini-3-')) {
        if (template.request.generationConfig &&
            template.request.generationConfig.thinkingConfig &&
            template.request.generationConfig.thinkingConfig.thinkingLevel) {
            delete template.request.generationConfig.thinkingConfig.thinkingLevel;
            template.request.generationConfig.thinkingConfig.thinkingBudget = -1;
        }
    }

    // 清理所有工具声明中的 JSON Schema 属性（移除 Google API 不支持的属性如 exclusiveMinimum 等）
        if (template.request.tools && Array.isArray(template.request.tools)) {
        template.request.tools.forEach((tool) => {
                if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
                tool.functionDeclarations.forEach((funcDecl) => {
                    // 对于 Claude 模型，处理 parametersJsonSchema
                    if (isClaudeModel && funcDecl.parametersJsonSchema) {
                        funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parametersJsonSchema);
                            delete funcDecl.parameters.$schema;
                            delete funcDecl.parametersJsonSchema;
                    } else if (funcDecl.parameters) {
                        funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parameters);
                        }
                    });
                }
            });
        }

    // 如果是图像模型，增加参数 "generationConfig.imageConfig.imageSize": "4K"
    if (isImageModel(modelName)) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }

        if (!template.request.generationConfig.imageConfig) {
            template.request.generationConfig.imageConfig = {};
        }
        template.request.generationConfig.imageConfig.imageSize = '4K';
        // 对于图像模型，完全移除 thinkingConfig 以避免 oneof 冲突
        if (template.request.generationConfig.thinkingConfig) {
            delete template.request.generationConfig.thinkingConfig;
        }
    }

    // 移除请求中不被 API 识别的字段
    if (template.request.metadata) {
        delete template.request.metadata;
    }

    // 规范化 Thinking 配置
    template = normalizeAntigravityThinking(modelName, template, isClaudeModel);

    // 参考 CLIProxyAPI buildRequest: Claude/gemini-3-pro 模型需要特殊处理 systemInstruction
    const name = modelName ? modelName.toLowerCase() : '';
    if (name.includes('claude') || name.includes('gemini-3-pro')) {
        // 1. 先保存原始的 systemInstruction.parts
        const originalParts = template.request?.systemInstruction?.parts || [];

        // 2. 设置 Antigravity 系统提示词
        if (!template.request.systemInstruction) {
            template.request.systemInstruction = {};
        }
        template.request.systemInstruction.role = 'user';
        template.request.systemInstruction.parts = [
            { text: ANTIGRAVITY_SYSTEM_PROMPT },
            { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_PROMPT}[/ignore]` }
        ];

        // 3. 追加原始的 parts
        if (Array.isArray(originalParts) && originalParts.length > 0) {
            originalParts.forEach(part => {
                if (part && (part.text !== undefined || typeof part === 'string')) {
                    template.request.systemInstruction.parts.push(
                        typeof part === 'string' ? { text: part } : part
                    );
                }
            });
        }
    }

    // Claude 模型需要设置 VALIDATED 模式（在最后确保设置）
    if (isClaudeModel && template.request.tools && template.request.tools.length > 0) {
        if (!template.request.toolConfig) {
            template.request.toolConfig = {};
        }
        if (!template.request.toolConfig.functionCallingConfig) {
            template.request.toolConfig.functionCallingConfig = {};
        }
        template.request.toolConfig.functionCallingConfig.mode = 'VALIDATED';
    }

    // 非 Claude 模型删除 maxOutputTokens
    if (!isClaudeModel) {
        if (template.request.generationConfig && template.request.generationConfig.maxOutputTokens) {
            delete template.request.generationConfig.maxOutputTokens;
        }
    }

    // [FIX #593] 添加 Safety Settings 配置
    template.request.safetySettings = buildSafetySettings();

    // [FIX] 深度清理 [undefined] 字符串（Cherry Studio 等客户端注入）
    deepCleanUndefined(template.request);

    // [FIX #813] 合并连续同角色消息（内部会对 model 消息重排序 thinking 块）
    if (template.request.contents && Array.isArray(template.request.contents)) {
        template.request.contents = mergeAdjacentRoles(template.request.contents);
    }

    // [FIX] 如果 thinking 未启用，清理所有 thought/thoughtSignature 字段
    const isThinkingEnabled = template.request?.generationConfig?.thinkingConfig?.includeThoughts === true ||
                              template.request?.generationConfig?.thinkingConfig?.thinkingBudget > 0;
    if (!isThinkingEnabled && template.request.contents) {
        cleanThinkingFieldsRecursive(template.request.contents);
    }

    // [FIX #593] 深度清理所有 cache_control 字段
    deepCleanCacheControl(template);

    return template;
}

/**
 * 过滤 SSE 中的 usageMetadata（仅在最终块中保留）
 * @param {string} line - SSE 行数据
 * @returns {string} 过滤后的行数据
 */
function filterSSEUsageMetadata(line) {
    if (!line || typeof line !== 'string') return line;
    
    // 检查是否是 data: 开头的 SSE 数据
    if (!line.startsWith('data: ')) return line;
    
    try {
        const jsonStr = line.slice(6); // 移除 'data: ' 前缀
        const data = JSON.parse(jsonStr);
        
        // 检查是否有 finishReason，如果没有则移除 usageMetadata
        const hasFinishReason = data?.response?.candidates?.[0]?.finishReason ||
                               data?.candidates?.[0]?.finishReason;
        
        if (!hasFinishReason) {
            // 移除 usageMetadata
            if (data.response) {
                delete data.response.usageMetadata;
            }
            if (data.usageMetadata) {
                delete data.usageMetadata;
            }
            return 'data: ' + JSON.stringify(data);
        }
    } catch (e) {
        // 解析失败，返回原始数据
    }
    
    return line;
}

/**
 * 将流式响应转换为非流式响应
 * 用于 Claude 模型的非流式请求（实际上是流式请求然后合并）
 * @param {Buffer|string} stream - 流式响应数据
 * @returns {Object} 合并后的非流式响应
 */
function convertStreamToNonStream(stream) {
    const lines = stream.toString().split('\n');
    
    let responseTemplate = '';
    let traceId = '';
    let finishReason = '';
    let modelVersion = '';
    let responseId = '';
    let role = '';
    let usageRaw = null;
    const parts = [];
    
    // 用于合并连续的 text 和 thought 部分
    let pendingKind = '';
    let pendingText = '';
    let pendingThoughtSig = '';
    
    const flushPending = () => {
        if (!pendingKind) return;
        
        const text = pendingText;
        if (pendingKind === 'text') {
            if (text.trim()) {
                parts.push({ text: text });
            }
        } else if (pendingKind === 'thought') {
            if (text.trim() || pendingThoughtSig) {
                const part = { thought: true, text: text };
                if (pendingThoughtSig) {
                    part.thoughtSignature = pendingThoughtSig;
                }
                parts.push(part);
            }
        }
        
        pendingKind = '';
        pendingText = '';
        pendingThoughtSig = '';
    };
    
    const normalizePart = (part) => {
        const m = { ...part };
        // 处理 thoughtSignature / thought_signature
        const sig = part.thoughtSignature || part.thought_signature;
        if (sig) {
            m.thoughtSignature = sig;
            delete m.thought_signature;
        }
        // 处理 inline_data -> inlineData
        if (m.inline_data) {
            m.inlineData = m.inline_data;
            delete m.inline_data;
        }
        return m;
    };
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        let data;
        try {
            data = JSON.parse(trimmed);
        } catch (e) {
            continue;
        }
        
        let responseNode = data.response;
        if (!responseNode) {
            if (data.candidates) {
                responseNode = data;
            } else {
                continue;
            }
        }
        responseTemplate = JSON.stringify(responseNode);
        
        if (data.traceId) {
            traceId = data.traceId;
        }
        
        if (responseNode.candidates?.[0]?.content?.role) {
            role = responseNode.candidates[0].content.role;
        }
        
        if (responseNode.candidates?.[0]?.finishReason) {
            finishReason = responseNode.candidates[0].finishReason;
        }
        
        if (responseNode.modelVersion) {
            modelVersion = responseNode.modelVersion;
        }
        
        if (responseNode.responseId) {
            responseId = responseNode.responseId;
        }
        
        if (responseNode.usageMetadata) {
            usageRaw = responseNode.usageMetadata;
        } else if (data.usageMetadata) {
            usageRaw = data.usageMetadata;
        }
        
        const partsArray = responseNode.candidates?.[0]?.content?.parts;
        if (Array.isArray(partsArray)) {
            for (const part of partsArray) {
                const hasFunctionCall = part.functionCall !== undefined;
                const hasInlineData = part.inlineData !== undefined || part.inline_data !== undefined;
                const sig = part.thoughtSignature || part.thought_signature || '';
                const text = part.text || '';
                const thought = part.thought || false;
                
                if (hasFunctionCall || hasInlineData) {
                    flushPending();
                    parts.push(normalizePart(part));
                    continue;
                }
                
                if (thought || part.text !== undefined) {
                    const kind = thought ? 'thought' : 'text';
                    if (pendingKind && pendingKind !== kind) {
                        flushPending();
                    }
                    pendingKind = kind;
                    pendingText += text;
                    if (kind === 'thought' && sig) {
                        pendingThoughtSig = sig;
                    }
                    continue;
                }
                
                flushPending();
                parts.push(normalizePart(part));
            }
        }
    }
    
    flushPending();
    
    // 构建最终响应
    if (!responseTemplate) {
        responseTemplate = '{"candidates":[{"content":{"role":"model","parts":[]}}]}';
    }
    
    let result = JSON.parse(responseTemplate);
    
    // 设置 parts
    if (!result.candidates) {
        result.candidates = [{ content: { role: 'model', parts: [] } }];
    }
    if (!result.candidates[0]) {
        result.candidates[0] = { content: { role: 'model', parts: [] } };
    }
    if (!result.candidates[0].content) {
        result.candidates[0].content = { role: 'model', parts: [] };
    }
    result.candidates[0].content.parts = parts;
    
    if (role) {
        result.candidates[0].content.role = role;
    }
    if (finishReason) {
        result.candidates[0].finishReason = finishReason;
    }
    if (modelVersion) {
        result.modelVersion = modelVersion;
    }
    if (responseId) {
        result.responseId = responseId;
    }
    if (usageRaw) {
        result.usageMetadata = usageRaw;
    } else if (!result.usageMetadata) {
        result.usageMetadata = {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        };
    }
    
    // 包装为最终格式
    const output = {
        response: result,
        traceId: traceId || ''
    };
    
    return output;
}

/**
 * 将 Antigravity 响应转换为 Gemini 格式
 * @param {Object} antigravityResponse - Antigravity 响应
 * @returns {Object|null} Gemini 格式响应
 */
function toGeminiApiResponse(antigravityResponse) {
    if (!antigravityResponse) return null;

    const compliantResponse = {
        candidates: antigravityResponse.candidates
    };

    if (antigravityResponse.usageMetadata) {
        compliantResponse.usageMetadata = antigravityResponse.usageMetadata;
    }

    if (antigravityResponse.promptFeedback) {
        compliantResponse.promptFeedback = antigravityResponse.promptFeedback;
    }

    if (antigravityResponse.automaticFunctionCallingHistory) {
        compliantResponse.automaticFunctionCallingHistory = antigravityResponse.automaticFunctionCallingHistory;
    }

    return compliantResponse;
}

/**
 * 确保请求体中的内容部分都有角色属性
 * @param {Object} requestBody - 请求体
 * @returns {Object} 处理后的请求体
 */
function ensureRolesInContents(requestBody, modelName) {
    delete requestBody.model;
    // 移除不被 API 识别的字段
    delete requestBody.metadata;

    // 统一 system_instruction 为 systemInstruction
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    // 确保 systemInstruction 格式正确（保留原始 parts 结构，交给 geminiToAntigravity 处理）
    if (requestBody.systemInstruction) {
        if (typeof requestBody.systemInstruction === 'string') {
            // 字符串格式转为对象格式
            requestBody.systemInstruction = {
                role: 'user',
                parts: [{ text: requestBody.systemInstruction }]
            };
        } else if (typeof requestBody.systemInstruction === 'object') {
            // 确保有 role
            if (!requestBody.systemInstruction.role) {
                requestBody.systemInstruction.role = 'user';
            }
            // 确保 parts 是数组格式
            if (!requestBody.systemInstruction.parts) {
                if (requestBody.systemInstruction.text) {
                    requestBody.systemInstruction.parts = [{ text: requestBody.systemInstruction.text }];
                    delete requestBody.systemInstruction.text;
                } else {
                    requestBody.systemInstruction.parts = [];
                }
            }
        }
    }

    // 确保 contents 中的每个消息都有 role
    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
        });
    }

    return requestBody;
}

export class AntigravityApiService {
    constructor(config) {
        // 检查是否需要使用代理
        const proxyConfig = getGoogleAuthProxyConfig(config, 'gemini-antigravity');
        
        // 配置 OAuth2Client 使用自定义的 HTTP agent
        const oauth2Options = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        };
        
        if (proxyConfig) {
            oauth2Options.transporterOptions = proxyConfig;
            console.log('[Antigravity] Using proxy for OAuth2Client');
        } else {
            oauth2Options.transporterOptions = {
                agent: httpsAgent,
            };
        }
        
        this.authClient = new OAuth2Client(oauth2Options);
        this.availableModels = [];
        this.isInitialized = false;

        this.config = config;
        this.host = config.HOST;
        this.oauthCredsFilePath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
        this.oauthCredentialId = null;
        this.userAgent = DEFAULT_USER_AGENT; // 支持通用 USER_AGENT 配置
        this.projectId = config.PROJECT_ID;

        // 多环境降级顺序 - 按照 Go 代码的顺序
        this.baseURLs = this.getBaseURLFallbackOrder(config);
        
        // 保存代理配置供后续使用
        this.proxyConfig = getProxyConfigForProvider(config, 'gemini-antigravity');
    }

    /**
     * 获取 Base URL 降级顺序
     * @param {Object} config - 配置对象
     * @returns {string[]} Base URL 列表
     */
    getBaseURLFallbackOrder(config) {
        // 如果配置了自定义 base_url，只使用该 URL
        if (config.ANTIGRAVITY_BASE_URL) {
            return [config.ANTIGRAVITY_BASE_URL.replace(/\/$/, '')];
        }
        
        // 默认降级顺序：daily -> sandbox -> prod
        return [
            ANTIGRAVITY_SANDBOX_BASE_URL_DAILY,
            ANTIGRAVITY_BASE_URL_DAILY,
            ANTIGRAVITY_BASE_URL_PROD
        ];
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[Antigravity] Initializing Antigravity API Service...');
        await this.initializeAuth();

        if (!this.projectId) {
            this.projectId = await this.discoverProjectAndModels();
        } else {
            console.log(`[Antigravity] Using provided Project ID: ${this.projectId}`);
            // 获取可用模型
            await this.fetchAvailableModels();
        }

        this.isInitialized = true;
        console.log(`[Antigravity] Initialization complete. Project ID: ${this.projectId}`);
    }

    async initializeAuth(forceRefresh = false) {
        // 检查是否需要刷新 Token
        const needsRefresh = forceRefresh || this.isTokenExpiringSoon();

        if (this.authClient.credentials.access_token && !needsRefresh) {
            // Token 有效且不需要刷新
            return;
        }

        // Antigravity 不支持 base64 配置，直接使用文件路径
        try {
            const { credentialId, credentials } = await loadCredentialsFromConfig(
                this.config,
                'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
                'Antigravity'
            );
            this.oauthCredentialId = credentialId;
            this.authClient.setCredentials(credentials);
            console.log('[Antigravity Auth] Authentication configured successfully from database.');

            if (needsRefresh) {
                // 使用去重锁：多个并发刷新请求只执行一次，共享结果
                const dedupeKey = `antigravity-token-refresh:${this.oauthCredentialId || 'unknown'}`;
                await withDeduplication(dedupeKey, async () => {
                    console.log('[Antigravity Auth] Token expiring soon or force refresh requested. Refreshing token...');
                    const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                    this.authClient.setCredentials(newCredentials);
                    if (this.oauthCredentialId) {
                        await this._saveCredentials(this.oauthCredentialId, newCredentials);
                    }
                    console.log('[Antigravity Auth] Token refreshed and saved to database successfully.');
                });
                
                // 如果是等待其他请求完成的刷新，需要重新加载凭证
                // 因为 withDeduplication 只让第一个调用者执行刷新并更新自己的内存状态
                // 其他等待者需要从文件重新加载
                if (this.isTokenExpiringSoon() && this.oauthCredentialId) {
                    const refreshedRecord = await oauthCredentialsDao.findById(this.oauthCredentialId);
                    if (refreshedRecord?.credentials) {
                        this.authClient.setCredentials(refreshedRecord.credentials);
                        console.log('[Antigravity Auth] Credentials reloaded after concurrent refresh');
                    }
                }
            }
        } catch (error) {
            console.error('[Antigravity Auth] Error initializing authentication:', error.message);
            if (!forceRefresh) {
                console.log('[Antigravity Auth] Credentials not found. Starting new authentication flow...');
                const newTokens = await this.getNewToken();
                this.authClient.setCredentials(newTokens);
                console.log('[Antigravity Auth] New token obtained and loaded into memory.');
            } else {
                console.error('[Antigravity Auth] Failed to initialize authentication from database:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken() {
        // 使用统一的 OAuth 处理方法
        const { authUrl, authInfo } = await handleGeminiAntigravityOAuth(this.config);
        
        console.log('\n[Antigravity Auth] 正在自动打开浏览器进行授权...');
        console.log('[Antigravity Auth] 授权链接:', authUrl, '\n');

        // 自动打开浏览器
        const showFallbackMessage = () => {
            console.log('[Antigravity Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开');
        };

        if (this.config) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        const startTime = new Date();
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const record = await oauthCredentialsDao.findLatestByProviderType('gemini-antigravity', startTime);
                    if (record && record.credentials?.access_token) {
                        clearInterval(checkInterval);
                        this.oauthCredentialId = record.id;
                        console.log('[Antigravity Auth] New token obtained successfully.');
                        resolve(record.credentials);
                    }
                } catch (_error) {
                    // 继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Antigravity Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    isTokenExpiringSoon() {
        if (!this.authClient.credentials.expiry_date) {
            return false;
        }
        const currentTime = Date.now();
        const expiryTime = this.authClient.credentials.expiry_date;
        const refreshSkewMs = REFRESH_SKEW * 1000;
        return expiryTime <= (currentTime + refreshSkewMs);
    }

    /**
     * 保存凭证到文件（使用文件锁防止并发写入）
     * @param {string} filePath - 凭证文件路径
     * @param {Object} credentials - 凭证数据
     */
    async _saveCredentials(credentialId, credentials) {
        try {
            await updateCredentialsById(credentialId, credentials);
            console.log(`[Antigravity Auth] Credentials saved to database (${credentialId})`);
        } catch (error) {
            console.error(`[Antigravity Auth] Failed to save credentials: ${error.message}`);
        }
    }

    async discoverProjectAndModels() {
        if (this.projectId) {
            console.log(`[Antigravity] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        console.log('[Antigravity] Discovering Project ID...');
        try {
            const initialProjectId = "";
            // Prepare client metadata
            const clientMetadata = {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                duetProject: initialProjectId,
            };

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            const loadResponse = await this.callApi('loadCodeAssist', loadRequest);

            // Check if we already have a project ID from the response
            if (loadResponse.cloudaicompanionProject) {
                console.log(`[Antigravity] Discovered existing Project ID: ${loadResponse.cloudaicompanionProject}`);
                // 获取可用模型
                await this.fetchAvailableModels();
                return loadResponse.cloudaicompanionProject;
            }

            // If no existing project, we need to onboard
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || 'free-tier';

            const onboardRequest = {
                tierId: tierId,
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            let lroResponse = await this.callApi('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30; // Maximum number of retries (60 seconds total)
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                lroResponse = await this.callApi('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            console.log(`[Antigravity] Onboarded and discovered Project ID: ${discoveredProjectId}`);
            // 获取可用模型
            await this.fetchAvailableModels();
            return discoveredProjectId;
        } catch (error) {
            console.error('[Antigravity] Failed to discover Project ID:', error.response?.data || error.message);
            console.log('[Antigravity] Falling back to generated Project ID as last resort...');
            const fallbackProjectId = generateProjectID();
            console.log(`[Antigravity] Generated fallback Project ID: ${fallbackProjectId}`);
            // 获取可用模型
            await this.fetchAvailableModels();
            return fallbackProjectId;
        }
    }

    async fetchAvailableModels() {
        console.log('[Antigravity] Fetching available models...');

        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                const requestOptions = {
                    url: modelsURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify({})
                };

                const res = await this.authClient.request(requestOptions);
                // console.log(`[Antigravity] Raw response from ${baseURL}:`, Object.keys(res.data.models));
                if (res.data && res.data.models) {
                    const models = Object.keys(res.data.models);
                    this.availableModels = models
                        .map(modelName2Alias)
                        .filter(alias => alias !== undefined && alias !== '' && alias !== null)
                        .filter(alias => ANTIGRAVITY_MODELS.includes(alias));

                    console.log(`[Antigravity] Available models: [${this.availableModels.join(', ')}]`);
                    return;
                }
            } catch (error) {
                console.error(`[Antigravity] Failed to fetch models from ${baseURL}:`, error.message);
            }
        }

        console.warn('[Antigravity] Failed to fetch models from all endpoints. Using default models.');
        this.availableModels = ANTIGRAVITY_MODELS;
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();

        const now = Math.floor(Date.now() / 1000);
        const formattedModels = this.availableModels.map(modelId => {
            const displayName = modelId.split('-').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');

            const modelInfo = {
                name: `models/${modelId}`,
                version: '1.0.0',
                displayName: displayName,
                description: `Antigravity model: ${modelId}`,
                inputTokenLimit: 1024000,
                outputTokenLimit: 65535,
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
                object: 'model',
                created: now,
                ownedBy: 'antigravity',
                type: 'antigravity'
            };

            if (modelId.endsWith('-thinking') || modelId.includes('-thinking-')) {
                modelInfo.thinking = {
                    min: 1024,
                    max: 100000,
                    zeroAllowed: false,
                    dynamicAllowed: true
                };
            }

            return modelInfo;
        });

        return { models: formattedModels };
    }

    async callApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];

        try {
            const requestOptions = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': this.userAgent
                },
                responseType: 'json',
                body: JSON.stringify(body)
            };

            const res = await this.authClient.request(requestOptions);
            return res.data;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            console.error(`[Antigravity API] Error calling ${method} on ${baseURL}:`, status, error.message);

            if ((status === 400 || status === 401) && !isRetry) {
                console.log('[Antigravity API] Received 401/400. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                return this.callApi(method, body, true, retryCount, baseURLIndex);
            }

            if (status === 429) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    console.log(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[Antigravity API] Rate limited. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, body, isRetry, retryCount + 1, 0);
                }
            }

            // Handle network errors - try next base URL first, then retry with backoff
            if (isNetworkError) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    console.log(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL}. Trying next base URL...`);
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    console.log(`[Antigravity API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, body, isRetry, retryCount + 1, 0);
                }
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Antigravity API] Server error ${status}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1, baseURLIndex);
            }

            throw error;
        }
    }

    async * streamApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];

        try {
            const requestOptions = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                params: { alt: 'sse' },
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': this.userAgent
                },
                responseType: 'stream',
                body: JSON.stringify(body)
            };

            const res = await this.authClient.request(requestOptions);

            if (res.status !== 200) {
                let errorBody = '';
                for await (const chunk of res.data) {
                    errorBody += chunk.toString();
                }
                throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
            }

            yield* this.parseSSEStream(res.data);
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            console.error(`[Antigravity API] Error during stream ${method} on ${baseURL}:`, status, error.message);

            if ((status === 400 || status === 401) && !isRetry) {
                console.log('[Antigravity API] Received 401/400 during stream. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                yield* this.streamApi(method, body, true, retryCount, baseURLIndex);
                return;
            }

            if (status === 429) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    console.log(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
                    yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                    return;
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[Antigravity API] Rate limited during stream. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(method, body, isRetry, retryCount + 1, 0);
                    return;
                }
            }

            // Handle network errors - try next base URL first, then retry with backoff
            if (isNetworkError) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    console.log(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL} during stream. Trying next base URL...`);
                    yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                    return;
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    console.log(`[Antigravity API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(method, body, isRetry, retryCount + 1, 0);
                    return;
                }
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Antigravity API] Server error ${status} during stream. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1, baseURLIndex);
                return;
            }

            throw error;
        }
    }

    async * parseSSEStream(stream) {
        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        let buffer = [];
        for await (let line of rl) {
            if (line.startsWith('data: ')) {
                // 过滤 usageMetadata（仅在最终块中保留）
                line = filterSSEUsageMetadata(line);
                buffer.push(line.slice(6));
            } else if (line === '' && buffer.length > 0) {
                try {
                    yield JSON.parse(buffer.join('\n'));
                } catch (e) {
                    console.error('[Antigravity Stream] Failed to parse JSON chunk:', buffer.join('\n'));
                }
                buffer = [];
            }
        }

        if (buffer.length > 0) {
            try {
                yield JSON.parse(buffer.join('\n'));
            } catch (e) {
                console.error('[Antigravity Stream] Failed to parse final JSON chunk:', buffer.join('\n'));
            }
        }
    }

    async generateContent(model, requestBody) {
        console.log(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        let selectedModel = model;
        if (!this.availableModels.includes(model)) {
            console.warn(`[Antigravity] Model '${model}' not found. Using default model: '${this.availableModels[0]}'`);
            selectedModel = this.availableModels[0];
        }

        const actualModelName = alias2ModelName(selectedModel);
        // 深拷贝请求体
        const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)), actualModelName);
        const isClaudeModel = isClaude(actualModelName);

        // 将处理后的请求体转换为 Antigravity 格式
        const payload = geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId);

        // 设置模型名称为实际模型名
        payload.model = actualModelName;

        // 对于 Claude 模型，使用流式请求然后转换为非流式响应
        if (isClaudeModel) {
            return await this.executeClaudeNonStream(payload);
        }

        const response = await this.callApi('generateContent', payload);
        return toGeminiApiResponse(response.response);
    }

    /**
     * 执行 Claude 非流式请求
     * Claude 模型实际上使用流式请求，然后将结果合并为非流式响应
     * @param {Object} payload - 请求体
     * @returns {Object} 非流式响应
     */
    async executeClaudeNonStream(payload) {
        const chunks = [];
        
        try {
            const stream = this.streamApi('streamGenerateContent', payload);
            for await (const chunk of stream) {
                if (chunk) {
                    chunks.push(JSON.stringify(chunk));
                }
            }
            
            // 将流式响应转换为非流式响应
            const streamData = chunks.join('\n');
            const nonStreamResponse = convertStreamToNonStream(streamData);
            return toGeminiApiResponse(nonStreamResponse.response);
        } catch (error) {
            console.error('[Antigravity] Claude non-stream execution error:', error.message);
            throw error;
        }
    }

    async * generateContentStream(model, requestBody) {
        console.log(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        let selectedModel = model;
        if (!this.availableModels.includes(model)) {
            console.warn(`[Antigravity] Model '${model}' not found. Using default model: '${this.availableModels[0]}'`);
            selectedModel = this.availableModels[0];
        }

        const actualModelName = alias2ModelName(selectedModel);
        // 深拷贝请求体
        const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)), actualModelName);

        // 将处理后的请求体转换为 Antigravity 格式
        const payload = geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId);

        // 设置模型名称为实际模型名
        payload.model = actualModelName;

        const stream = this.streamApi('streamGenerateContent', payload);
        for await (const chunk of stream) {
            yield toGeminiApiResponse(chunk.response);
        }
    }

    isExpiryDateNear() {
        try {
            const currentTime = Date.now();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            console.log(`[Antigravity] Expiry date: ${this.authClient.credentials.expiry_date}, Current time: ${currentTime}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${currentTime + cronNearMinutesInMillis}`);
            return this.authClient.credentials.expiry_date <= (currentTime + cronNearMinutesInMillis);
        } catch (error) {
            console.error(`[Antigravity] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取模型配额信息
     * @returns {Promise<Object>} 模型配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Antigravity] Token is near expiry, refreshing before getUsageLimits request...');
            await this.initializeAuth(true);
        }

        try {
            const modelsWithQuotas = await this.getModelsWithQuotas();
            return modelsWithQuotas;
        } catch (error) {
            console.error('[Antigravity] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 获取订阅等级信息（通过 loadCodeAssist API）
     * @returns {Promise<string>} 订阅等级 (FREE/PRO/ULTRA)
     */
    async fetchSubscriptionTier() {
        for (const baseURL of this.baseURLs) {
            try {
                const loadURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`;
                const requestOptions = {
                    url: loadURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify({
                        metadata: { ideType: 'ANTIGRAVITY' }
                    })
                };

                const res = await this.authClient.request(requestOptions);

                if (res.data) {
                    // 优先使用 paidTier，其次 currentTier
                    const tier = res.data.paidTier || res.data.currentTier;
                    if (tier && tier.id) {
                        const tierId = tier.id.toLowerCase();
                        if (tierId.includes('ultra')) {
                            console.log(`[Antigravity] Subscription tier: ULTRA`);
                            return 'ULTRA';
                        } else if (tierId.includes('pro')) {
                            console.log(`[Antigravity] Subscription tier: PRO`);
                            return 'PRO';
                        }
                    }
                }
                console.log(`[Antigravity] Subscription tier: FREE`);
                return 'FREE';
            } catch (error) {
                console.error(`[Antigravity] Failed to fetch subscription tier from ${baseURL}:`, error.message);
            }
        }
        return 'FREE';
    }

    /**
     * 获取带配额信息的模型列表
     * @returns {Promise<Object>} 模型配额信息
     */
    async getModelsWithQuotas() {
        try {
            // 先获取订阅等级
            const subscriptionTier = await this.fetchSubscriptionTier();

            // 解析模型配额信息
            const result = {
                lastUpdated: Date.now(),
                subscriptionTier: subscriptionTier,
                models: {}
            };

            // 调用 fetchAvailableModels 接口获取模型和配额信息
            for (const baseURL of this.baseURLs) {
                try {
                    const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                    const requestOptions = {
                        url: modelsURL,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': this.userAgent
                        },
                        responseType: 'json',
                        body: JSON.stringify({ project: this.projectId })
                    };

                    const res = await this.authClient.request(requestOptions);
                    console.log(`[Antigravity] fetchAvailableModels success`);
                    if (res.data && res.data.models) {
                        const modelsData = res.data.models;

                        // 遍历模型数据，提取配额信息
                        for (const [modelId, modelData] of Object.entries(modelsData)) {
                            const aliasName = modelName2Alias(modelId);
                            if (aliasName == null || aliasName === '') continue; // 跳过不支持的模型

                            const modelInfo = {
                                name: modelId,
                                displayName: aliasName,
                                remaining: 0,
                                percentage: 0,
                                usedPercentage: 100,
                                resetTime: null,
                                resetTimeFormatted: null
                            };

                            // 从 quotaInfo 中提取配额信息
                            if (modelData.quotaInfo) {
                                const fraction = modelData.quotaInfo.remainingFraction || 0;
                                // 限制在 0-1 范围内（API 可能返回 > 1.0）
                                const clampedFraction = Math.min(1, Math.max(0, fraction));
                                modelInfo.remaining = clampedFraction;
                                modelInfo.percentage = Math.round(clampedFraction * 100 * 100) / 100; // 保留2位小数
                                modelInfo.usedPercentage = Math.round((1 - clampedFraction) * 100 * 100) / 100;

                                // 重置时间处理
                                const resetTimeRaw = modelData.quotaInfo.resetTime || null;
                                modelInfo.resetTime = resetTimeRaw;
                                if (resetTimeRaw) {
                                    modelInfo.resetTimeFormatted = this.formatResetTime(resetTimeRaw);
                                }
                            }

                            result.models[aliasName] = modelInfo;
                        }

                        // 对模型按名称排序
                        const sortedModels = {};
                        Object.keys(result.models).sort().forEach(key => {
                            sortedModels[key] = result.models[key];
                        });
                        result.models = sortedModels;
                        console.log(`[Antigravity] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
                        break; // 成功获取后退出循环
                    }
                } catch (error) {
                    console.error(`[Antigravity] Failed to fetch models with quotas from ${baseURL}:`, error.message);
                }
            }

            return result;
        } catch (error) {
            console.error('[Antigravity] Failed to get models with quotas:', error.message);
            throw error;
        }
    }

    /**
     * 格式化重置时间为人类可读格式
     * @param {string} resetTimeISO - ISO8601 格式的时间字符串
     * @returns {string} 格式化后的时间字符串（如 "2h 30m", "1d 5h"）
     */
    formatResetTime(resetTimeISO) {
        if (!resetTimeISO) return null;

        try {
            const resetDate = new Date(resetTimeISO);
            const now = new Date();
            const diffMs = resetDate.getTime() - now.getTime();

            if (diffMs <= 0) return 'now';

            const totalMinutes = Math.floor(diffMs / 60000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            const days = Math.floor(hours / 24);
            const remainingHours = hours % 24;

            if (days > 0) {
                if (remainingHours > 0) {
                    return `${days}d ${remainingHours}h`;
                }
                return `${days}d`;
            } else if (hours > 0) {
                if (minutes > 0) {
                    return `${hours}h ${minutes}m`;
                }
                return `${hours}h`;
            } else {
                return `${Math.max(1, minutes)}m`;
            }
        } catch (e) {
            return null;
        }
    }

}
