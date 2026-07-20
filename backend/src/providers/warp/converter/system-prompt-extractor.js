/**
 * System Prompt Extractor
 * 从消息历史中提取 system prompt
 *
 * System prompt 可能来自：
 * 1. role === 'system' 的消息
 * 2. Claude API 的 system 参数（在 API 调用层面）
 */

/**
 * 提取文本内容
 */
function extractText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && item.type === 'text' && typeof item.text === 'string') return item.text;
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content.text === 'string') {
        return content.text;
    }
    return '';
}

/**
 * 从消息历史中提取 system prompts
 *
 * @param {Array} history - 消息数组
 * @returns {Object} { systemPromptText: string, filteredHistory: Array }
 */
export function extractSystemPrompts(history) {
    if (!history || history.length === 0) {
        return { systemPromptText: null, filteredHistory: [] };
    }

    const systemPrompts = [];
    const filteredHistory = [];

    for (const msg of history) {
        if (msg.role === 'system') {
            const text = extractText(msg.content);
            if (text) {
                systemPrompts.push(text);
            }
        } else {
            filteredHistory.push(msg);
        }
    }

    const systemPromptText = systemPrompts.length > 0 ? systemPrompts.join('\n\n') : null;

    return {
        systemPromptText,
        filteredHistory
    };
}
