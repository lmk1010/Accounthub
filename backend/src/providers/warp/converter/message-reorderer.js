/**
 * Message Reorderer
 * 基于 Warp2Api 的 reorder.py 实现
 *
 * 目的：
 * 1. 展开多个 tool_calls 为单独的消息
 * 2. 将 tool_result 紧跟在对应的 tool_call 之后
 * 3. 保留未匹配的 tool_result
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
 * 将 content 标准化为数组
 */
function normalizeContentToList(content) {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }
    if (Array.isArray(content)) {
        return content;
    }
    if (content && typeof content === 'object') {
        return [content];
    }
    return [];
}

/**
 * 重排序消息以适配 Anthropic/Warp 格式
 *
 * @param {Array} history - Claude 格式的消息数组
 * @returns {Array} 重排序后的消息数组
 */
export function reorderMessagesForAnthropic(history) {
    if (!history || history.length === 0) {
        return [];
    }

    // Step 1: 展开消息
    const expanded = [];
    for (const m of history) {
        if (m.role === 'user') {
            const items = normalizeContentToList(m.content);
            // 如果是多个 content parts，拆分为多条消息
            if (Array.isArray(m.content) && items.length > 1) {
                for (const seg of items) {
                    if (seg && typeof seg === 'object' && seg.type === 'text' && typeof seg.text === 'string') {
                        expanded.push({ role: 'user', content: seg.text });
                    } else {
                        expanded.push({
                            role: 'user',
                            content: typeof seg === 'object' ? [seg] : seg
                        });
                    }
                }
            } else {
                expanded.push(m);
            }
        } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 1) {
            // 如果有多个 tool_calls，先添加文本消息，然后为每个 tool_call 创建单独的消息
            const assistantText = extractText(normalizeContentToList(m.content));
            if (assistantText) {
                expanded.push({ role: 'assistant', content: assistantText });
            }
            for (const tc of m.tool_calls) {
                expanded.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: [tc]
                });
            }
        } else {
            expanded.push(m);
        }
    }

    // Step 2: 确定最后一条输入消息的 tool_call_id（如果存在）
    let lastInputToolId = null;
    let lastInputIsTool = false;
    for (let i = expanded.length - 1; i >= 0; i--) {
        const m = expanded[i];
        if (m.role === 'tool' && m.tool_call_id) {
            lastInputToolId = m.tool_call_id;
            lastInputIsTool = true;
            break;
        }
        if (m.role === 'user') {
            break;
        }
    }

    // Step 3: 建立 tool_results 和 assistant_tc_ids 映射
    const toolResultsById = new Map();
    const assistantTcIds = new Set();

    for (const m of expanded) {
        if (m.role === 'tool' && m.tool_call_id && !toolResultsById.has(m.tool_call_id)) {
            toolResultsById.set(m.tool_call_id, m);
        }
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) {
                const id = tc?.id;
                if (typeof id === 'string' && id) {
                    assistantTcIds.add(id);
                }
            }
        }
    }

    // Step 4: 重排序，将 tool_result 紧跟在 tool_call 之后
    const result = [];
    let trailingAssistantMsg = null;

    for (const m of expanded) {
        // 跳过已匹配的 tool results（稍后会插入到正确位置）
        if (m.role === 'tool') {
            // 保留未匹配的 tool results
            if (!m.tool_call_id || !assistantTcIds.has(m.tool_call_id)) {
                result.push(m);
                if (m.tool_call_id) {
                    toolResultsById.delete(m.tool_call_id);
                }
            }
            continue;
        }

        // 处理 assistant 的 tool_calls
        if (m.role === 'assistant' && m.tool_calls) {
            const ids = [];
            for (const tc of m.tool_calls) {
                const id = tc?.id;
                if (typeof id === 'string' && id) {
                    ids.push(id);
                }
            }

            // 如果最后一条输入是 tool result，并且这个 assistant 消息包含对应的 tool_call
            // 则暂存这个消息，稍后添加到末尾
            if (lastInputIsTool && lastInputToolId && ids.includes(lastInputToolId)) {
                if (trailingAssistantMsg === null) {
                    trailingAssistantMsg = m;
                }
                continue;
            }

            // 添加 assistant 消息
            result.push(m);
            // 立即添加对应的 tool_results
            for (const id of ids) {
                const tr = toolResultsById.get(id);
                if (tr) {
                    result.push(tr);
                    toolResultsById.delete(id);
                }
            }
            continue;
        }

        result.push(m);
    }

    // Step 5: 如果有 trailing assistant message，添加到末尾
    if (lastInputIsTool && lastInputToolId && trailingAssistantMsg !== null) {
        result.push(trailingAssistantMsg);
        const tr = toolResultsById.get(lastInputToolId);
        if (tr) {
            result.push(tr);
            toolResultsById.delete(lastInputToolId);
        }
    }

    return result;
}
