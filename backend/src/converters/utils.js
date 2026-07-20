/**
 * 转换器公共工具函数模块
 * 提供各种协议转换所需的通用辅助函数
 */

import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// 常量定义
// =============================================================================

// 通用默认值
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_TOP_P = 0.95;

// =============================================================================
// OpenAI 相关常量
// =============================================================================
export const OPENAI_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_DEFAULT_TEMPERATURE = 1;
export const OPENAI_DEFAULT_TOP_P = 0.95;
export const OPENAI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// Claude 相关常量
// =============================================================================
export const CLAUDE_DEFAULT_MAX_TOKENS = 200000;
export const CLAUDE_DEFAULT_TEMPERATURE = 1;
export const CLAUDE_DEFAULT_TOP_P = 0.95;

// =============================================================================
// Gemini 相关常量
// =============================================================================
export const GEMINI_DEFAULT_MAX_TOKENS = 65534;
export const GEMINI_DEFAULT_TEMPERATURE = 1;
export const GEMINI_DEFAULT_TOP_P = 0.95;
export const GEMINI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT = 65534;

// =============================================================================
// OpenAI Responses 相关常量
// =============================================================================
export const OPENAI_RESPONSES_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_RESPONSES_DEFAULT_TEMPERATURE = 1;
export const OPENAI_RESPONSES_DEFAULT_TOP_P = 0.95;
export const OPENAI_RESPONSES_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_RESPONSES_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// Ollama 相关常量
// =============================================================================
export const OLLAMA_DEFAULT_CONTEXT_LENGTH = 65534;
export const OLLAMA_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Claude 模型上下文长度
export const OLLAMA_CLAUDE_DEFAULT_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_SONNET_45_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_SONNET_45_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_HAIKU_45_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_HAIKU_45_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_OPUS_41_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_OPUS_41_MAX_OUTPUT_TOKENS = 32000;
export const OLLAMA_CLAUDE_SONNET_40_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_SONNET_40_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_SONNET_37_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_SONNET_37_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_OPUS_40_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_OPUS_40_MAX_OUTPUT_TOKENS = 32000;
export const OLLAMA_CLAUDE_HAIKU_35_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_HAIKU_35_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_HAIKU_30_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_HAIKU_30_MAX_OUTPUT_TOKENS = 8192;
export const OLLAMA_CLAUDE_SONNET_35_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_SONNET_35_MAX_OUTPUT_TOKENS = 200000;
export const OLLAMA_CLAUDE_OPUS_30_CONTEXT_LENGTH = 200000;
export const OLLAMA_CLAUDE_OPUS_30_MAX_OUTPUT_TOKENS = 8192;

// Gemini 模型上下文长度
export const OLLAMA_GEMINI_25_PRO_CONTEXT_LENGTH = 1048576;
export const OLLAMA_GEMINI_25_PRO_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_25_FLASH_CONTEXT_LENGTH = 1048576;
export const OLLAMA_GEMINI_25_FLASH_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_25_IMAGE_CONTEXT_LENGTH = 65534;
export const OLLAMA_GEMINI_25_IMAGE_MAX_OUTPUT_TOKENS = 32768;
export const OLLAMA_GEMINI_25_LIVE_CONTEXT_LENGTH = 131072;
export const OLLAMA_GEMINI_25_LIVE_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_25_TTS_CONTEXT_LENGTH = 65534;
export const OLLAMA_GEMINI_25_TTS_MAX_OUTPUT_TOKENS = 16384;
export const OLLAMA_GEMINI_20_FLASH_CONTEXT_LENGTH = 1048576;
export const OLLAMA_GEMINI_20_FLASH_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_20_IMAGE_CONTEXT_LENGTH = 32768;
export const OLLAMA_GEMINI_20_IMAGE_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_15_PRO_CONTEXT_LENGTH = 2097152;
export const OLLAMA_GEMINI_15_PRO_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_15_FLASH_CONTEXT_LENGTH = 1048576;
export const OLLAMA_GEMINI_15_FLASH_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_GEMINI_DEFAULT_CONTEXT_LENGTH = 1048576;
export const OLLAMA_GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 65534;

// GPT 模型上下文长度
export const OLLAMA_GPT4_TURBO_CONTEXT_LENGTH = 128000;
export const OLLAMA_GPT4_TURBO_MAX_OUTPUT_TOKENS = 8192;
export const OLLAMA_GPT4_32K_CONTEXT_LENGTH = 32768;
export const OLLAMA_GPT4_32K_MAX_OUTPUT_TOKENS = 8192;
export const OLLAMA_GPT4_BASE_CONTEXT_LENGTH = 200000;
export const OLLAMA_GPT4_BASE_MAX_OUTPUT_TOKENS = 8192;
export const OLLAMA_GPT35_16K_CONTEXT_LENGTH = 16385;
export const OLLAMA_GPT35_16K_MAX_OUTPUT_TOKENS = 8192;
export const OLLAMA_GPT35_BASE_CONTEXT_LENGTH = 8192;
export const OLLAMA_GPT35_BASE_MAX_OUTPUT_TOKENS = 8192;

// Qwen 模型上下文长度
export const OLLAMA_QWEN_CODER_PLUS_CONTEXT_LENGTH = 128000;
export const OLLAMA_QWEN_CODER_PLUS_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_QWEN_VL_PLUS_CONTEXT_LENGTH = 262144;
export const OLLAMA_QWEN_VL_PLUS_MAX_OUTPUT_TOKENS = 32768;
export const OLLAMA_QWEN_CODER_FLASH_CONTEXT_LENGTH = 128000;
export const OLLAMA_QWEN_CODER_FLASH_MAX_OUTPUT_TOKENS = 65534;
export const OLLAMA_QWEN_DEFAULT_CONTEXT_LENGTH = 32768;
export const OLLAMA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS = 200000;

export const OLLAMA_DEFAULT_FILE_TYPE = 2;
export const OLLAMA_DEFAULT_QUANTIZATION_VERSION = 2;
export const OLLAMA_DEFAULT_ROPE_FREQ_BASE = 10000.0;
export const OLLAMA_DEFAULT_TEMPERATURE = 0.7;
export const OLLAMA_DEFAULT_TOP_P = 0.9;
export const OLLAMA_DEFAULT_QUANTIZATION_LEVEL = 'Q4_0';
export const OLLAMA_SHOW_QUANTIZATION_LEVEL = 'Q4_K_M';

// =============================================================================
// 通用辅助函数
// =============================================================================

/**
 * 判断值是否为 undefined 或 0，并返回默认值
 * @param {*} value - 要检查的值
 * @param {*} defaultValue - 默认值
 * @returns {*} 处理后的值
 */
export function checkAndAssignOrDefault(value, defaultValue) {
    if (value !== undefined && value !== 0) {
        return value;
    }
    return defaultValue;
}

/**
 * 生成唯一ID
 * @param {string} prefix - ID前缀
 * @returns {string} 生成的ID
 */
export function generateId(prefix = '') {
    return prefix ? `${prefix}_${uuidv4()}` : uuidv4();
}

/**
 * 安全解析JSON字符串
 * @param {string} str - JSON字符串
 * @returns {*} 解析后的对象或原始字符串
 */
export function safeParseJSON(str) {
    if (!str) {
        return str;
    }
    let cleanedStr = str;

    // 处理可能被截断的转义序列
    if (cleanedStr.endsWith('\\') && !cleanedStr.endsWith('\\\\')) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1);
    } else if (cleanedStr.endsWith('\\u') || cleanedStr.endsWith('\\u0') || cleanedStr.endsWith('\\u00')) {
        const idx = cleanedStr.lastIndexOf('\\u');
        cleanedStr = cleanedStr.substring(0, idx);
    }

    try {
        return JSON.parse(cleanedStr || '{}');
    } catch (e) {
        return str;
    }
}

/**
 * 提取消息内容中的文本
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
export function extractTextFromMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

/**
 * 提取并处理系统消息
 * @param {Array} messages - 消息数组
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array}}
 */
export function extractAndProcessSystemMessages(messages) {
    const systemContents = [];
    const nonSystemMessages = [];

    for (const message of messages) {
        if (message.role === 'system') {
            systemContents.push(extractTextFromMessageContent(message.content));
        } else {
            nonSystemMessages.push(message);
        }
    }

    let systemInstruction = null;
    if (systemContents.length > 0) {
        systemInstruction = {
            parts: [{
                text: systemContents.join('\n')
            }]
        };
    }
    return { systemInstruction, nonSystemMessages };
}

/**
 * 清理JSON Schema属性（移除Gemini/Antigravity不支持的属性）
 * 参考 CLIProxyAPI 的 CleanJSONSchemaForAntigravity 实现
 * @param {Object} schema - JSON Schema
 * @param {boolean} addPlaceholder - 是否为空对象添加占位符（Claude VALIDATED 模式需要）
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaProperties(schema, addPlaceholder = true) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    // 如果是数组，递归处理每个元素
    if (Array.isArray(schema)) {
        return schema.map(item => cleanJsonSchemaProperties(item, addPlaceholder));
    }

    let result = JSON.parse(JSON.stringify(schema));

    // Phase 1: 转换 const 为 enum
    result = convertConstToEnum(result);

    // Phase 2: 确保 enum 值都是字符串
    result = convertEnumValuesToStrings(result);

    // Phase 3: 展平 anyOf/oneOf（选择最佳类型）
    result = flattenAnyOfOneOf(result);

    // Phase 4: 展平 type 数组
    result = flattenTypeArrays(result);

    // Phase 5: 合并 allOf
    result = mergeAllOf(result);

    // Phase 6: 移除不支持的关键字
    const unsupportedKeys = [
        '$schema', '$defs', 'definitions', 'const', '$ref', 'additionalProperties',
        'propertyNames', 'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum',
        'minimum', 'maximum', 'pattern', 'minItems', 'maxItems', 'format', 'default',
        'examples', 'title'
    ];
    result = removeUnsupportedKeys(result, unsupportedKeys);

    // Phase 7: 清理 required 字段（确保引用的属性存在）
    result = cleanupRequiredFields(result);

    // Phase 8: 为空对象 schema 添加占位符（Claude VALIDATED 模式需要）
    if (addPlaceholder) {
        result = addEmptySchemaPlaceholder(result);
    }

    return result;
}

/**
 * 转换 const 为 enum
 */
function convertConstToEnum(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(convertConstToEnum);

    const result = { ...schema };

    if (result.const !== undefined && result.enum === undefined) {
        result.enum = [result.const];
    }
    delete result.const;

    // 递归处理
    if (result.properties) {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = convertConstToEnum(value);
        }
    }
    if (result.items) {
        result.items = convertConstToEnum(schema.items);
    }

    return result;
}

/**
 * 确保 enum 值都是字符串（Gemini API 要求）
 */
function convertEnumValuesToStrings(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(convertEnumValuesToStrings);

    const result = { ...schema };

    if (Array.isArray(result.enum)) {
        result.enum = result.enum.map(v => String(v));
    }

    // 递归处理
    if (result.properties) {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = convertEnumValuesToStrings(value);
        }
    }
    if (result.items) {
        result.items = convertEnumValuesToStrings(schema.items);
    }

    return result;
}

/**
 * 展平 anyOf/oneOf，选择最佳类型
 */
function flattenAnyOfOneOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(flattenAnyOfOneOf);

    let result = { ...schema };

    for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(result[key]) && result[key].length > 0) {
            const items = result[key];
            // 选择最佳类型：优先 object > array > 其他非 null 类型
            let bestIdx = 0;
            let bestScore = -1;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const t = item.type;
                let score = 0;
                if (t === 'object' || item.properties) score = 3;
                else if (t === 'array' || item.items) score = 2;
                else if (t && t !== 'null') score = 1;
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            const selected = flattenAnyOfOneOf(items[bestIdx]);
            // 保留原有 description
            if (result.description && !selected.description) {
                selected.description = result.description;
            }
            result = selected;
            break;
        }
    }

    // 递归处理
    if (result.properties) {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = flattenAnyOfOneOf(value);
        }
        result.properties = newProps;
    }
    if (result.items) {
        result.items = flattenAnyOfOneOf(result.items);
    }

    return result;
}

/**
 * 展平 type 数组，选择第一个非 null 类型
 */
function flattenTypeArrays(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(flattenTypeArrays);

    const result = { ...schema };

    if (Array.isArray(result.type)) {
        const nonNullTypes = result.type.filter(t => t !== 'null');
        result.type = nonNullTypes.length > 0 ? nonNullTypes[0] : 'string';
    }

    // 递归处理
    if (result.properties) {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = flattenTypeArrays(value);
        }
    }
    if (result.items) {
        result.items = flattenTypeArrays(schema.items);
    }

    return result;
}

/**
 * 合并 allOf
 */
function mergeAllOf(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(mergeAllOf);

    let result = { ...schema };

    if (Array.isArray(result.allOf)) {
        for (const item of result.allOf) {
            if (item.properties) {
                result.properties = { ...result.properties, ...item.properties };
            }
            if (Array.isArray(item.required)) {
                result.required = [...new Set([...(result.required || []), ...item.required])];
            }
        }
        delete result.allOf;
    }

    // 递归处理
    if (result.properties) {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = mergeAllOf(value);
        }
        result.properties = newProps;
    }
    if (result.items) {
        result.items = mergeAllOf(result.items);
    }

    return result;
}

/**
 * 移除不支持的关键字
 */
function removeUnsupportedKeys(schema, unsupportedKeys) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => removeUnsupportedKeys(s, unsupportedKeys));

    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (unsupportedKeys.includes(key)) continue;

        if (key === 'properties' && typeof value === 'object') {
            result.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                result.properties[propKey] = removeUnsupportedKeys(propValue, unsupportedKeys);
            }
        } else if (key === 'items') {
            result.items = removeUnsupportedKeys(value, unsupportedKeys);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * 清理 required 字段，确保引用的属性存在
 */
function cleanupRequiredFields(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(cleanupRequiredFields);

    const result = { ...schema };

    if (Array.isArray(result.required) && result.properties) {
        result.required = result.required.filter(r => result.properties[r] !== undefined);
        if (result.required.length === 0) {
            delete result.required;
        }
    }

    // 递归处理
    if (result.properties) {
        result.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            result.properties[key] = cleanupRequiredFields(value);
        }
    }
    if (result.items) {
        result.items = cleanupRequiredFields(schema.items);
    }

    return result;
}

/**
 * 为空对象 schema 添加占位符（Claude VALIDATED 模式需要至少一个 required 属性）
 */
function addEmptySchemaPlaceholder(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(addEmptySchemaPlaceholder);

    const result = { ...schema };

    if (result.type === 'object') {
        const hasProperties = result.properties && Object.keys(result.properties).length > 0;
        const hasRequired = Array.isArray(result.required) && result.required.length > 0;

        if (!hasProperties) {
            // 空对象，添加 reason 占位符
            result.properties = {
                reason: {
                    type: 'string',
                    description: 'Brief explanation of why you are calling this tool'
                }
            };
            result.required = ['reason'];
        } else if (!hasRequired) {
            // 有属性但没有 required，添加 _ 占位符
            result.properties._ = { type: 'boolean' };
            result.required = ['_'];
        }
    }

    // 递归处理
    if (result.properties) {
        const newProps = {};
        for (const [key, value] of Object.entries(result.properties)) {
            newProps[key] = addEmptySchemaPlaceholder(value);
        }
        result.properties = newProps;
    }
    if (result.items) {
        result.items = addEmptySchemaPlaceholder(result.items);
    }

    return result;
}

/**
 * 映射结束原因
 * @param {string} reason - 结束原因
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {string} 映射后的结束原因
 */
export function mapFinishReason(reason, sourceFormat, targetFormat) {
    const reasonMappings = {
        openai: {
            anthropic: {
                stop: "end_turn",
                length: "max_tokens",
                content_filter: "stop_sequence",
                tool_calls: "tool_use"
            }
        },
        gemini: {
            anthropic: {
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                SAFETY: "stop_sequence",
                RECITATION: "stop_sequence",
                stop: "end_turn",
                length: "max_tokens",
                safety: "stop_sequence",
                recitation: "stop_sequence",
                other: "end_turn"
            }
        }
    };

    try {
        return reasonMappings[sourceFormat][targetFormat][reason] || "end_turn";
    } catch (e) {
        return "end_turn";
    }
}

/**
 * 根据budget_tokens智能判断OpenAI reasoning_effort等级
 * @param {number|null} budgetTokens - Anthropic thinking的budget_tokens值
 * @returns {string} OpenAI reasoning_effort等级
 */
export function determineReasoningEffortFromBudget(budgetTokens) {
    if (budgetTokens === null || budgetTokens === undefined) {
        console.info("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    const LOW_THRESHOLD = 50;
    const HIGH_THRESHOLD = 200;

    console.debug(`Threshold configuration: low <= ${LOW_THRESHOLD}, medium <= ${HIGH_THRESHOLD}, high > ${HIGH_THRESHOLD}`);

    let effort;
    if (budgetTokens <= LOW_THRESHOLD) {
        effort = "low";
    } else if (budgetTokens <= HIGH_THRESHOLD) {
        effort = "medium";
    } else {
        effort = "high";
    }

    console.info(`🎯 Budget tokens ${budgetTokens} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, high<=${HIGH_THRESHOLD})`);
    return effort;
}

/**
 * 从OpenAI文本中提取thinking内容
 * @param {string} text - 文本内容
 * @returns {string|Array} 提取后的内容
 */
export function extractThinkingFromOpenAIText(text) {
    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
    const matches = [...text.matchAll(thinkingPattern)];

    const contentBlocks = [];
    let lastEnd = 0;

    for (const match of matches) {
        const beforeText = text.substring(lastEnd, match.index).trim();
        if (beforeText) {
            contentBlocks.push({
                type: "text",
                text: beforeText
            });
        }

        const thinkingText = match[1].trim();
        if (thinkingText) {
            contentBlocks.push({
                type: "thinking",
                thinking: thinkingText
            });
        }

        lastEnd = match.index + match[0].length;
    }

    const afterText = text.substring(lastEnd).trim();
    if (afterText) {
        contentBlocks.push({
            type: "text",
            text: afterText
        });
    }

    if (contentBlocks.length === 0) {
        return text;
    }

    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text;
    }

    return contentBlocks;
}

// =============================================================================
// 工具状态管理器（单例模式）
// =============================================================================

/**
 * 全局工具状态管理器
 */
class ToolStateManager {
    constructor() {
        if (ToolStateManager.instance) {
            return ToolStateManager.instance;
        }
        ToolStateManager.instance = this;
        this._toolMappings = {};
        return this;
    }

    storeToolMapping(funcName, toolId) {
        this._toolMappings[funcName] = toolId;
    }

    getToolId(funcName) {
        return this._toolMappings[funcName] || null;
    }

    clearMappings() {
        this._toolMappings = {};
    }
}

export const toolStateManager = new ToolStateManager();