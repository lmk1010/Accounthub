/**
 * Kiro 缓存模拟服务（轻量版）
 *
 * 策略：用 length/4 快速估算 token 拆分比例，不调用 tokenizer（零延迟）。
 * 精确的 totalInputTokens 由 Kiro 返回的 contextUsagePercentage 在流结束后反算，
 * 再按估算比例拆分为 cache_read / cache_creation / input_tokens。
 */

import * as channelConfigDao from '../dao/channel-config-dao.js';

// 配置常量
const CACHE_CONFIG = {
    // 是否启用缓存模拟（可通过环境变量控制）
    ENABLED: process.env.KIRO_CACHE_SIMULATION !== 'false',
    // 最小可缓存 token 数（按模型区分）
    MIN_CACHEABLE_TOKENS: {
        'claude-opus-4.5': 4096,
        'claude-opus-4': 1024,
        'claude-sonnet-4.5': 1024,
        'claude-sonnet-4': 1024,
        'claude-sonnet-3.7': 1024,
        'claude-haiku-4.5': 4096,
        'claude-haiku-3.5': 2048,
        'claude-haiku-3': 2048,
        'default': 1024
    }
};

// 数据库配置缓存
let dbConfigCache = null;
let dbConfigCacheTime = 0;
const DB_CONFIG_CACHE_TTL = 60000; // 1分钟缓存

/**
 * 从数据库加载缓存模拟配置
 */
async function loadDbConfig() {
    const now = Date.now();
    if (dbConfigCache !== null && (now - dbConfigCacheTime) < DB_CONFIG_CACHE_TTL) {
        return dbConfigCache;
    }

    try {
        const config = await channelConfigDao.getByProviderType('claude-kiro-oauth');
        const enabled = config?.config?.cacheSimulationEnabled;
        dbConfigCache = enabled !== false; // 默认启用
        dbConfigCacheTime = now;
        return dbConfigCache;
    } catch (error) {
        console.warn('[KiroCacheSimulator] Error loading db config:', error.message);
        return true; // 出错时默认启用
    }
}

/**
 * 清除数据库配置缓存（配置更新时调用）
 */
export function clearDbConfigCache() {
    dbConfigCache = null;
    dbConfigCacheTime = 0;
}

/**
 * 检查缓存模拟是否启用（同步版本，仅检查环境变量）
 */
export function isCacheSimulationEnabled() {
    return CACHE_CONFIG.ENABLED;
}

/**
 * 检查缓存模拟是否启用（异步版本，检查数据库配置）
 */
export async function isCacheSimulationEnabledAsync() {
    if (!CACHE_CONFIG.ENABLED) {
        return false;
    }
    return await loadDbConfig();
}

/**
 * 设置缓存模拟开关
 */
export function setCacheSimulationEnabled(enabled) {
    CACHE_CONFIG.ENABLED = enabled;
    console.log(`[KiroCacheSimulator] Cache simulation ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * 快速估算 token 数量（~4 字符 = 1 token）
 * 不调用 tokenizer，零延迟。精确值由 Kiro 返回的 contextUsagePercentage 反算。
 */
function fastEstimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * 获取模型的最小可缓存 token 数
 */
function getMinCacheableTokens(model) {
    if (!model) return CACHE_CONFIG.MIN_CACHEABLE_TOKENS.default;

    // 标准化模型名称（移除版本号后缀）
    const normalizedModel = model.toLowerCase().replace(/@\d{8}$/, '');

    for (const [key, value] of Object.entries(CACHE_CONFIG.MIN_CACHEABLE_TOKENS)) {
        if (key === 'default') continue;
        if (normalizedModel.includes(key)) {
            return value;
        }
    }
    return CACHE_CONFIG.MIN_CACHEABLE_TOKENS.default;
}

/**
 * 检查内容块是否应该被缓存
 */
function shouldCache(block) {
    // 如果没有 cache_control 标记，默认不缓存
    // 但为了兼容性，如果是旧版本请求（没有 cache_control 字段），则默认缓存
    if (!block) return false;

    // 如果明确有 cache_control 字段，检查其值
    if (block.cache_control !== undefined) {
        return block.cache_control?.type === 'ephemeral';
    }

    // 兼容模式：如果整个请求都没有 cache_control 标记，则默认缓存所有内容
    return true;
}

/**
 * 获取消息的文本长度（用于快速 token 估算）
 * 排除动态生成的 ID，只保留实际内容
 */
function normalizeMessageContent(content, isHistory = false) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(block => {
            if (block.type === 'text' && block.text) {
                return block.text;
            }
            if (block.type === 'tool_use') {
                return JSON.stringify(block.input || {});
            }
            if (block.type === 'tool_result') {
                return typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content || '');
            }
            // 历史消息中的 thinking/redacted_thinking 不计入 token
            // Anthropic: "Thinking blocks from previous turns are stripped
            // and not counted towards your context window"
            if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                return isHistory ? '' : (block.thinking || '');
            }
            if (block.type === 'image') {
                // 图片按固定 token 数估算（base64 数据不参与文本长度计算）
                return 'x'.repeat(1600); // ~400 tokens
            }
            return '';
        }).filter(Boolean).join('');
    }
    return '';
}

/**
 * 规范化模型名称（确保缓存 key 一致性）
 * 将各种模型名称变体统一为 Kiro 官方短名称格式
 */
function normalizeModelForCache(model) {
    if (!model) return 'claude-sonnet-4.5';
    const m = model.toLowerCase();
    if (m.includes('opus-4')) return 'claude-opus-4.5';
    if (m.includes('sonnet-4-5') || m.includes('sonnet-4.5') || m.includes('sonnet_4_5')) return 'claude-sonnet-4.5';
    if (m.includes('sonnet-4') || m.includes('sonnet_4')) return 'claude-sonnet-4';
    if (m.includes('sonnet-3-7') || m.includes('sonnet-3.7') || m.includes('3_7_sonnet')) return 'claude-sonnet-3.7';
    if (m.includes('haiku-4')) return 'claude-haiku-4.5';
    if (m.includes('haiku-3')) return 'claude-haiku-3.5';
    return model;
}

/**
 * 计算可缓存内容的 token 数（system + tools + 历史消息）
 * 返回各部分的 token 数
 */
function countCacheableTokens(requestBody) {
    let systemTokens = 0;
    let toolsTokens = 0;
    let historyTokens = 0;

    // 1. System prompt tokens
    if (requestBody.system) {
        if (Array.isArray(requestBody.system)) {
            for (const block of requestBody.system) {
                if (shouldCache(block) && block.type === 'text' && block.text) {
                    systemTokens += fastEstimateTokens(block.text);
                }
            }
        } else if (typeof requestBody.system === 'string') {
            systemTokens += fastEstimateTokens(requestBody.system);
        }
    }

    // 2. Tools tokens
    if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
        const toolsJson = JSON.stringify(requestBody.tools);
        toolsTokens += fastEstimateTokens(toolsJson);
    }

    // 3. 历史消息 tokens（不含最后一条当前输入）
    if (requestBody.messages && Array.isArray(requestBody.messages) && requestBody.messages.length > 1) {
        const historyMessages = requestBody.messages.slice(0, -1);
        for (const msg of historyMessages) {
            const content = normalizeMessageContent(msg.content, true);
            historyTokens += fastEstimateTokens(content);
        }
    }

    return {
        systemTokens,
        toolsTokens,
        historyTokens,
        totalCacheableTokens: systemTokens + toolsTokens + historyTokens
    };
}

/**
 * 计算当前输入的 token 数（最后一条消息）
 */
function countCurrentInputTokens(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
        return 0;
    }

    const lastMessage = requestBody.messages[requestBody.messages.length - 1];
    const content = normalizeMessageContent(lastMessage.content);
    return fastEstimateTokens(content);
}

/**
 * 估算本次请求新增的历史消息 tokens（用于模拟增量缓存）
 */
function countNewHistoryTokens(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages) || requestBody.messages.length < 2) {
        return { newHistoryTokens: 0, hasPriorUserTurn: false };
    }

    const historyMessages = requestBody.messages.slice(0, -1);
    let lastUserIndex = -1;
    for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
        if (historyMessages[i]?.role === 'user') {
            lastUserIndex = i;
            break;
        }
    }

    const newHistory = lastUserIndex >= 0
        ? historyMessages.slice(lastUserIndex + 1)
        : historyMessages;

    let newHistoryTokens = 0;
    for (const msg of newHistory) {
        const content = normalizeMessageContent(msg.content, true);
        newHistoryTokens += fastEstimateTokens(content);
    }

    return { newHistoryTokens, hasPriorUserTurn: lastUserIndex >= 0 };
}

/**
 * 计算缓存 token 统计
 *
 * @param {Object} requestBody - Claude API 请求体
 * @param {Object} metadata - 请求元数据（包含 user_id）
 * @returns {Promise<{cacheCreationTokens: number, cacheReadTokens: number, inputTokens: number}>}
 */
export async function calculateCacheTokens(requestBody, metadata = null) {
    // 检查缓存模拟是否启用
    const enabled = await isCacheSimulationEnabledAsync();
    if (!enabled) {
        const inputTokens = countCurrentInputTokens(requestBody);
        return { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens };
    }

    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    try {
        const normalizedModel = normalizeModelForCache(requestBody.model || 'unknown');

        // 快速估算可缓存 tokens（system + tools + 历史消息）
        const tokenStats = countCacheableTokens(requestBody);
        const totalCacheableTokens = tokenStats.totalCacheableTokens;

        // 快速估算当前输入 tokens（最后一条消息）
        const inputTokens = countCurrentInputTokens(requestBody);

        // 检查最小可缓存 token 数
        const minTokens = getMinCacheableTokens(normalizedModel);
        if (totalCacheableTokens < minTokens) {
            return { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens };
        }

        // 估算新增历史 tokens
        const { newHistoryTokens, hasPriorUserTurn } = countNewHistoryTokens(requestBody);
        const boundedNewHistoryTokens = Math.min(newHistoryTokens, totalCacheableTokens);

        if (!hasPriorUserTurn) {
            // 首次请求：全部视为新建缓存
            cacheCreationTokens = totalCacheableTokens;
            cacheReadTokens = 0;
        } else {
            // 后续请求：新增部分为 creation，其余为 read
            cacheCreationTokens = boundedNewHistoryTokens;
            cacheReadTokens = totalCacheableTokens - cacheCreationTokens;
        }

        return { cacheCreationTokens, cacheReadTokens, inputTokens };
    } catch (error) {
        console.error('[KiroCacheSimulator] Error:', error.message);
        const inputTokens = countCurrentInputTokens(requestBody);
        return { cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens };
    }
}

/**
 * 获取缓存统计信息
 */
export async function getCacheStats() {
    const stats = {
        enabled: CACHE_CONFIG.ENABLED,
        minTokens: CACHE_CONFIG.MIN_CACHEABLE_TOKENS,
        storage: 'none',
        entries: 0
    };

    return stats;
}

/**
 * 清除所有缓存
 */
export async function clearCache() {
    // 仅做 token 计算，无真实缓存可清理
    console.log('[KiroCacheSimulator] Cache storage disabled, nothing to clear');
}

/**
 * 清除指定会话的缓存
 */
export async function clearSessionCache(sessionId) {
    void sessionId;
    // 仅做 token 计算，无真实缓存可清理
}

export default {
    isCacheSimulationEnabled,
    isCacheSimulationEnabledAsync,
    setCacheSimulationEnabled,
    clearDbConfigCache,
    calculateCacheTokens,
    getCacheStats,
    clearCache,
    clearSessionCache
};
