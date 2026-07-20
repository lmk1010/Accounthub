/**
 * OpenAI Responses API 转换器
 * 处理 OpenAI Responses API 格式与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseConverter } from '../BaseConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import {
    extractAndProcessSystemMessages as extractSystemMessages,
    extractTextFromMessageContent as extractText,
    CLAUDE_DEFAULT_MAX_TOKENS,
    GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
    GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT
} from '../utils.js';
import { extractTokenUsage } from '../../utils/token-usage.js';

function safeString(value) {
    return typeof value === 'string' ? value : '';
}

function collectResponsesOutput(output) {
    return Array.isArray(output)
        ? output.filter(item => item && typeof item === 'object')
        : [];
}

function collectContentText(parts, allowedTypes = null) {
    if (!Array.isArray(parts)) return '';
    return parts
        .map(part => {
            if (!part || typeof part !== 'object') return '';
            if (allowedTypes && part.type && !allowedTypes.has(part.type)) return '';
            return safeString(part.text ?? part.delta);
        })
        .filter(Boolean)
        .join('');
}

function pushUniqueText(texts, text) {
    if (text && !texts.includes(text)) {
        texts.push(text);
    }
}

function extractReasoningFromItem(item) {
    if (!item || typeof item !== 'object') return '';
    const texts = [];

    pushUniqueText(texts, collectContentText(item.summary));
    pushUniqueText(texts, collectContentText(item.content));
    pushUniqueText(texts, safeString(item.text));
    pushUniqueText(texts, safeString(item.reasoning_content));
    pushUniqueText(texts, safeString(item.reasoning_text));
    if (typeof item.reasoning === 'string') {
        pushUniqueText(texts, item.reasoning);
    } else if (item.reasoning && typeof item.reasoning === 'object') {
        pushUniqueText(texts, safeString(item.reasoning.text));
        pushUniqueText(texts, collectContentText(item.reasoning.summary));
        pushUniqueText(texts, collectContentText(item.reasoning.content));
    }

    return texts.join('');
}

function extractReasoningContent(output) {
    return collectResponsesOutput(output)
        .filter(item => item.type === 'reasoning' || item.summary || item.reasoning || item.reasoning_content || item.reasoning_text)
        .map(extractReasoningFromItem)
        .filter(Boolean)
        .join('\n\n');
}

function extractAssistantText(output) {
    return collectResponsesOutput(output)
        .filter(item => (
            (item.type === 'message' && (item.role === 'assistant' || !item.role))
            || item.type === 'output_text'
        ))
        .map(item => {
            if (Array.isArray(item.content)) {
                return collectContentText(item.content, new Set(['output_text', 'text']));
            }
            return safeString(item.content)
                || safeString(item.text)
                || safeString(item.output_text);
        })
        .filter(Boolean)
        .join('\n');
}

function extractChatMessageText(response) {
    const content = response?.choices?.[0]?.message?.content ?? response?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return collectContentText(content, new Set(['output_text', 'text']));
    }
    return '';
}

function extractChatReasoningContent(response) {
    return safeString(response?.choices?.[0]?.message?.reasoning_content)
        || safeString(response?.reasoning_content);
}

function extractToolCalls(output) {
    let toolIndex = 0;
    const toolCalls = [];
    for (const item of collectResponsesOutput(output)) {
        if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || !item.name) {
            continue;
        }
        toolCalls.push({
            index: toolIndex,
            id: item.call_id || item.id || `call_${uuidv4().replace(/-/g, '')}`,
            type: 'function',
            function: {
                name: item.name,
                arguments: safeString(item.arguments ?? item.input)
            }
        });
        toolIndex += 1;
    }
    return toolCalls;
}

function mapResponsesFinishReason(response, hasToolCalls = false) {
    if (hasToolCalls) {
        return 'tool_calls';
    }

    const explicitReason = safeString(response?.stop_reason) || safeString(response?.incomplete_details?.reason);
    switch (explicitReason) {
        case 'tool_use':
        case 'tool_calls':
            return 'tool_calls';
        case 'max_output_tokens':
        case 'max_tokens':
            return 'length';
        case 'content_filter':
            return 'content_filter';
        case 'end_turn':
        case 'stop':
            return 'stop';
        default:
            break;
    }

    switch (response?.status) {
        case 'incomplete':
        case 'truncated':
            return 'length';
        case 'completed':
        case 'cancelled':
        default:
            return 'stop';
    }
}

function buildOpenAIUsage(usage) {
    const {
        uncachedInputTokens,
        totalInputTokens,
        outputTokens: completionTokens,
        cacheReadTokens: cachedTokens,
        cacheCreationTokens,
        reasoningTokens
    } = extractTokenUsage(usage);
    // NewAPI / Anthropic-style billing treats prompt and cache as separate line items.
    // Grok/OpenAI upstream reports total input that already includes cache reads; if we
    // forward that total as prompt_tokens AND also expose cached_tokens, gateways bill
    // prompt+cache and double-count. Always emit uncached prompt + explicit cache.
    const promptTokens = uncachedInputTokens;
    const totalTokens = totalInputTokens + completionTokens;
    const result = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: {
            cached_tokens: cachedTokens
        },
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
    if (cacheCreationTokens > 0) {
        result.prompt_tokens_details.cache_creation_tokens = cacheCreationTokens;
    }
    return result;
}

function mapClaudeStopReason(reason) {
    switch (reason) {
        case 'tool_calls':
        case 'tool_use':
            return 'tool_use';
        case 'length':
        case 'max_tokens':
        case 'max_output_tokens':
            return 'max_tokens';
        case 'content_filter':
            return 'stop_sequence';
        case 'stop':
        case 'end_turn':
        default:
            return 'end_turn';
    }
}

function parseToolArguments(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return {};
    try {
        return JSON.parse(value);
    } catch (error) {
        return {};
    }
}

function buildOpenAIStreamChunk(responsesChunk, model, delta = {}, finishReason = null, usage = null) {
    const resolvedModel = model || responsesChunk?.response?.model || responsesChunk?.model;
    const created = responsesChunk?.response?.created_at || responsesChunk?.created_at || responsesChunk?.created || Math.floor(Date.now() / 1000);
    const chunk = {
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        created,
        model: resolvedModel,
        system_fingerprint: '',
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };

    if (usage) {
        chunk.usage = buildOpenAIUsage(usage);
    }

    return chunk;
}

/**
 * OpenAI Responses API 转换器类
 * 支持 OpenAI Responses 格式与 OpenAI、Claude、Gemini 之间的转换
 */
export class OpenAIResponsesConverter extends BaseConverter {
    constructor() {
        super(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        this._claudeStreamStates = new Map();
    }

    // =============================================================================
    // 请求转换
    // =============================================================================

    /**
     * 转换请求到目标协议
     */
    convertRequest(data, toProtocol) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换响应到目标协议
     */
    convertResponse(data, toProtocol, model) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiResponse(data, model);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换流式响应块到目标协议
     */
    convertStreamChunk(chunk, toProtocol, model) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiStreamChunk(chunk, model);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换模型列表到目标协议
     */
    convertModelList(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIModelList(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeModelList(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiModelList(data);
            default:
                return data;
        }
    }

    // =============================================================================
    // 转换到 OpenAI 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为标准 OpenAI 请求
     */
    toOpenAIRequest(responsesRequest) {
        const openaiRequest = {
            model: responsesRequest.model,
            messages: [],
            stream: responsesRequest.stream || false
        };

        // OpenAI Responses API 使用 instructions 和 input 字段
        // 需要转换为标准的 messages 格式
        if (responsesRequest.instructions) {
            // instructions 作为系统消息
            openaiRequest.messages.push({
                role: 'system',
                content: responsesRequest.instructions
            });
        }

        // input 包含用户消息和历史对话
        if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
            responsesRequest.input.forEach(item => {
                if (item.type === 'message') {
                    // 提取消息内容
                    const content = item.content
                        .filter(c => c.type === 'input_text')
                        .map(c => c.text)
                        .join('\n');
                    
                    if (content) {
                        openaiRequest.messages.push({
                            role: item.role,
                            content: content
                        });
                    }
                }
            });
        }

        // 如果有标准的 messages 字段，也支持
        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            responsesRequest.messages.forEach(msg => {
                openaiRequest.messages.push({
                    role: msg.role,
                    content: msg.content
                });
            });
        }

        // 复制其他参数
        if (responsesRequest.temperature !== undefined) {
            openaiRequest.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = responsesRequest.max_tokens;
        }
        if (responsesRequest.top_p !== undefined) {
            openaiRequest.top_p = responsesRequest.top_p;
        }

        return openaiRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为标准 OpenAI 响应
     */
    toOpenAIResponse(responsesResponse, model) {
        const output = collectResponsesOutput(responsesResponse?.output);
        const assistantText = extractAssistantText(output);
        const toolCalls = extractToolCalls(output);
        const reasoningContent = extractReasoningContent(output);
        const reasoningDetails = output.filter(item => item && typeof item === 'object' && item.type === 'reasoning');
        const message = {
            role: 'assistant',
            content: assistantText || (toolCalls.length > 0 ? null : '')
        };

        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }
        if (reasoningDetails.length > 0) {
            message.reasoning_details = reasoningDetails;
            message.reasoning_items = reasoningDetails;
            const encryptedContent = reasoningDetails.find(item => typeof item.encrypted_content === 'string')?.encrypted_content;
            if (encryptedContent) {
                message.reasoning_encrypted_content = encryptedContent;
            }
        }

        return {
            id: responsesResponse.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: responsesResponse.created_at || responsesResponse.created || Math.floor(Date.now() / 1000),
            model: model || responsesResponse.model,
            choices: [{
                index: 0,
                message,
                finish_reason: mapResponsesFinishReason(responsesResponse, toolCalls.length > 0)
            }],
            usage: buildOpenAIUsage(responsesResponse.usage)
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为标准 OpenAI 流式块
     */
    toOpenAIStreamChunk(responsesChunk, model) {
        if (!responsesChunk || typeof responsesChunk !== 'object') {
            return null;
        }

        switch (responsesChunk.type) {
            case 'response.output_item.added': {
                const item = responsesChunk.item || {};
                if (item.type === 'message' && item.role === 'assistant') {
                    return buildOpenAIStreamChunk(responsesChunk, model, {
                        role: 'assistant',
                        content: ''
                    });
                }
                if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name) {
                    return buildOpenAIStreamChunk(responsesChunk, model, {
                        tool_calls: [{
                            index: responsesChunk.output_index || 0,
                            id: item.call_id || item.id,
                            type: 'function',
                            function: {
                                name: item.name,
                                arguments: ''
                            }
                        }]
                    });
                }
                return null;
            }

            case 'response.output_text.delta':
                return buildOpenAIStreamChunk(responsesChunk, model, {
                    content: safeString(responsesChunk.delta)
                });

            case 'response.reasoning_summary_text.delta':
                return buildOpenAIStreamChunk(responsesChunk, model, {
                    reasoning_content: safeString(responsesChunk.delta)
                });

            case 'response.function_call_arguments.delta':
            case 'response.custom_tool_call_input.delta':
                return buildOpenAIStreamChunk(responsesChunk, model, {
                    tool_calls: [{
                        index: responsesChunk.output_index || 0,
                        id: responsesChunk.item_id,
                        type: 'function',
                        function: {
                            arguments: safeString(responsesChunk.delta)
                        }
                    }]
                });

            case 'response.completed': {
                const output = collectResponsesOutput(responsesChunk.response?.output);
                const finishReason = mapResponsesFinishReason(responsesChunk.response, extractToolCalls(output).length > 0);
                return buildOpenAIStreamChunk(
                    responsesChunk,
                    model,
                    {},
                    finishReason,
                    responsesChunk.response?.usage || null
                );
            }

            default:
                return null;
        }
    }

    // =============================================================================
    // 转换到 Claude 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为 Claude 请求
     */
    toClaudeRequest(responsesRequest) {
        const claudeRequest = {
            model: responsesRequest.model,
            messages: [],
            max_tokens: responsesRequest.max_tokens || CLAUDE_DEFAULT_MAX_TOKENS,
            stream: responsesRequest.stream || false
        };

        // 处理 instructions 作为系统消息
        if (responsesRequest.instructions) {
            claudeRequest.system = responsesRequest.instructions;
        }

        // 处理 input 数组中的消息
        if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
            responsesRequest.input.forEach(item => {
                if (item.type === 'message') {
                    const content = item.content
                        .filter(c => c.type === 'input_text')
                        .map(c => c.text)
                        .join('\n');
                    
                    if (content) {
                        claudeRequest.messages.push({
                            role: item.role === 'assistant' ? 'assistant' : 'user',
                            content: content
                        });
                    }
                }
            });
        }

        // 如果有标准的 messages 字段，也支持
        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            const { systemMessages, otherMessages } = extractSystemMessages(
                responsesRequest.messages
            );
            
            if (!claudeRequest.system && systemMessages.length > 0) {
                const systemTexts = systemMessages.map(msg => extractText(msg.content));
                claudeRequest.system = systemTexts.join('\n');
            }

            otherMessages.forEach(msg => {
                claudeRequest.messages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: typeof msg.content === 'string' ? msg.content : extractText(msg.content)
                });
            });
        }

        // 复制其他参数
        if (responsesRequest.temperature !== undefined) {
            claudeRequest.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.top_p !== undefined) {
            claudeRequest.top_p = responsesRequest.top_p;
        }

        return claudeRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为 Claude 响应
     */
    toClaudeResponse(responsesResponse, model) {
        const output = collectResponsesOutput(responsesResponse?.output);
        const toolCalls = extractToolCalls(output);
        const content = extractChatMessageText(responsesResponse) || extractAssistantText(output);
        const reasoningContent = extractChatReasoningContent(responsesResponse) || extractReasoningContent(output);
        const finishReason = responsesResponse?.choices?.[0]?.finish_reason
            || mapResponsesFinishReason(responsesResponse, toolCalls.length > 0);
        const usage = extractTokenUsage(responsesResponse?.usage);
        const contentBlocks = [];

        if (reasoningContent) {
            contentBlocks.push({
                type: 'thinking',
                thinking: reasoningContent
            });
        }
        if (content) {
            contentBlocks.push({
                type: 'text',
                text: content
            });
        }
        for (const toolCall of toolCalls) {
            contentBlocks.push({
                type: 'tool_use',
                id: toolCall.id || '',
                name: toolCall.function?.name || '',
                input: parseToolArguments(toolCall.function?.arguments)
            });
        }

        return {
            id: responsesResponse?.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: contentBlocks,
            model: model || responsesResponse?.model,
            stop_reason: mapClaudeStopReason(finishReason),
            usage: {
                input_tokens: usage.uncachedInputTokens,
                cache_creation_input_tokens: usage.cacheCreationTokens,
                cache_read_input_tokens: usage.cacheReadTokens,
                output_tokens: usage.outputTokens
            }
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Claude 流式块
     */
    toClaudeStreamChunk(responsesChunk, model) {
        if (!responsesChunk || typeof responsesChunk !== 'object') {
            return null;
        }

        if (typeof responsesChunk.type === 'string' && responsesChunk.type.startsWith('response.')) {
            return this._responsesEventToClaudeStreamChunk(responsesChunk, model);
        }

        const delta = responsesChunk.choices?.[0]?.delta || responsesChunk.delta || {};
        const finishReason = responsesChunk.choices?.[0]?.finish_reason || 
                           responsesChunk.finish_reason;

        if (finishReason) {
            return {
                type: 'message_stop'
            };
        }

        if (delta.content) {
            return {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: delta.content
                }
            };
        }

        return {
            type: 'message_start',
            message: {
                id: responsesChunk.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: model || responsesChunk.model
            }
        };
    }

    _getClaudeStreamStateKey(event) {
        return event?.response_id || event?.response?.id || event?.id || event?.item_id || event?.item?.id || 'default';
    }

    _getClaudeStreamState(key) {
        const normalizedKey = String(key || 'default');
        if (!this._claudeStreamStates.has(normalizedKey)) {
            this._claudeStreamStates.set(normalizedKey, {
                textStarted: new Set(),
                textDeltaSent: new Set(),
                textStopped: new Set(),
                thinkingStarted: new Set(),
                thinkingDeltaSent: new Set(),
                thinkingStopped: new Set(),
                toolStarted: new Set()
            });
        }
        return this._claudeStreamStates.get(normalizedKey);
    }

    _deleteClaudeStreamState(responsesChunk) {
        const keys = [
            responsesChunk?.response?.id,
            responsesChunk?.response_id,
            responsesChunk?.id,
            responsesChunk?.item_id,
            responsesChunk?.item?.id
        ].map(value => String(value || '').trim()).filter(Boolean);
        for (const key of keys) {
            this._claudeStreamStates.delete(key);
        }
        if (this._claudeStreamStates.size > 1000) {
            const firstKey = this._claudeStreamStates.keys().next().value;
            if (firstKey) this._claudeStreamStates.delete(firstKey);
        }
    }

    _claudeMessageStartFromResponses(event, model) {
        const response = event?.response || {};
        const usage = extractTokenUsage(response.usage);
        return {
            type: 'message_start',
            message: {
                id: response.id || event?.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: model || response.model || event?.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: usage.uncachedInputTokens,
                    cache_creation_input_tokens: usage.cacheCreationTokens,
                    cache_read_input_tokens: usage.cacheReadTokens,
                    output_tokens: 0
                }
            }
        };
    }

    _ensureClaudeTextBlockStarted(event, index) {
        const state = this._getClaudeStreamState(this._getClaudeStreamStateKey(event));
        const key = String(index);
        if (state.textStarted.has(key)) return [];
        state.textStarted.add(key);
        return [{
            type: 'content_block_start',
            index,
            content_block: {
                type: 'text',
                text: ''
            }
        }];
    }

    _ensureClaudeThinkingBlockStarted(event, index) {
        const state = this._getClaudeStreamState(this._getClaudeStreamStateKey(event));
        const key = String(index);
        if (state.thinkingStarted.has(key)) return [];
        state.thinkingStarted.add(key);
        return [{
            type: 'content_block_start',
            index,
            content_block: {
                type: 'thinking',
                thinking: ''
            }
        }];
    }

    _markClaudeTextDeltaSent(event, index) {
        this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).textDeltaSent.add(String(index));
    }

    _markClaudeThinkingDeltaSent(event, index) {
        this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).thinkingDeltaSent.add(String(index));
    }

    _hasClaudeTextDeltaSent(event, index) {
        return this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).textDeltaSent.has(String(index));
    }

    _hasClaudeThinkingDeltaSent(event, index) {
        return this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).thinkingDeltaSent.has(String(index));
    }

    _markClaudeTextStopped(event, index) {
        this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).textStopped.add(String(index));
    }

    _markClaudeThinkingStopped(event, index) {
        this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).thinkingStopped.add(String(index));
    }

    _hasClaudeTextStopped(event, index) {
        return this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).textStopped.has(String(index));
    }

    _hasClaudeThinkingStopped(event, index) {
        return this._getClaudeStreamState(this._getClaudeStreamStateKey(event)).thinkingStopped.has(String(index));
    }

    _responsesEventToClaudeStreamChunk(event, model) {
        const index = Number.isFinite(Number(event.output_index))
            ? Number(event.output_index)
            : (Number.isFinite(Number(event.content_index)) ? Number(event.content_index) : 0);

        switch (event.type) {
            case 'response.created':
                return this._claudeMessageStartFromResponses(event, model);

            case 'response.in_progress':
                return null;

            case 'response.content_part.added': {
                if (event.part?.type === 'output_text' || event.part?.type === 'text') {
                    return this._ensureClaudeTextBlockStarted(event, index);
                }
                return null;
            }

            case 'response.output_text.delta': {
                const deltaText = safeString(event.delta);
                const events = this._ensureClaudeTextBlockStarted(event, index);
                if (deltaText) {
                    this._markClaudeTextDeltaSent(event, index);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'text_delta',
                            text: deltaText
                        }
                    });
                }
                return events.length > 0 ? events : null;
            }

            case 'response.output_text.done':
            case 'response.content_part.done': {
                if (event.type === 'response.content_part.done'
                    && event.part?.type
                    && event.part.type !== 'output_text'
                    && event.part.type !== 'text') {
                    return null;
                }
                if (this._hasClaudeTextStopped(event, index)) {
                    return null;
                }
                const events = this._ensureClaudeTextBlockStarted(event, index);
                const doneText = safeString(event.text ?? event.part?.text);
                if (doneText && !this._hasClaudeTextDeltaSent(event, index)) {
                    this._markClaudeTextDeltaSent(event, index);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'text_delta',
                            text: doneText
                        }
                    });
                }
                events.push({
                    type: 'content_block_stop',
                    index
                });
                this._markClaudeTextStopped(event, index);
                return events;
            }

            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta': {
                const thinking = safeString(event.delta);
                const events = this._ensureClaudeThinkingBlockStarted(event, index);
                if (thinking) {
                    this._markClaudeThinkingDeltaSent(event, index);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'thinking_delta',
                            thinking
                        }
                    });
                }
                return events.length > 0 ? events : null;
            }

            case 'response.reasoning_summary_part.done':
            case 'response.reasoning_text.done': {
                if (this._hasClaudeThinkingStopped(event, index)) {
                    return null;
                }
                const events = this._ensureClaudeThinkingBlockStarted(event, index);
                const thinking = safeString(event.part?.text ?? event.text);
                if (thinking && !this._hasClaudeThinkingDeltaSent(event, index)) {
                    this._markClaudeThinkingDeltaSent(event, index);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'thinking_delta',
                            thinking
                        }
                    });
                }
                events.push({
                    type: 'content_block_stop',
                    index
                });
                this._markClaudeThinkingStopped(event, index);
                return events;
            }

            case 'response.output_item.added': {
                const item = event.item || {};
                if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name) {
                    const itemId = item.call_id || item.id || event.item_id || `toolu_${uuidv4().replace(/-/g, '')}`;
                    const state = this._getClaudeStreamState(this._getClaudeStreamStateKey(event));
                    if (state.toolStarted.has(String(index))) return null;
                    state.toolStarted.add(String(index));
                    return {
                        type: 'content_block_start',
                        index,
                        content_block: {
                            type: 'tool_use',
                            id: itemId,
                            name: item.name,
                            input: {}
                        }
                    };
                }
                return null;
            }

            case 'response.function_call_arguments.delta':
            case 'response.custom_tool_call_input.delta':
                return {
                    type: 'content_block_delta',
                    index,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: safeString(event.delta)
                    }
                };

            case 'response.output_item.done': {
                const item = event.item || {};
                if (item.type === 'function_call' || item.type === 'custom_tool_call') {
                    return {
                        type: 'content_block_stop',
                        index
                    };
                }
                return null;
            }

            case 'response.completed':
            case 'response.incomplete': {
                const response = event.response || {};
                const usage = extractTokenUsage(response.usage);
                const finishReason = mapClaudeStopReason(mapResponsesFinishReason(response));
                const chunks = [{
                    type: 'message_delta',
                    delta: {
                        stop_reason: finishReason,
                        stop_sequence: null
                    },
                    usage: {
                        input_tokens: usage.uncachedInputTokens,
                        cache_creation_input_tokens: usage.cacheCreationTokens,
                        cache_read_input_tokens: usage.cacheReadTokens,
                        output_tokens: usage.outputTokens
                    }
                }, {
                    type: 'message_stop'
                }];
                this._deleteClaudeStreamState(event);
                return chunks;
            }

            default:
                return null;
        }
    }

    // =============================================================================
    // 转换到 Gemini 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为 Gemini 请求
     */
    toGeminiRequest(responsesRequest) {
        const geminiRequest = {
            contents: [],
            generationConfig: {}
        };

        // 处理 instructions 作为系统指令
        if (responsesRequest.instructions) {
            geminiRequest.systemInstruction = {
                parts: [{
                    text: responsesRequest.instructions
                }]
            };
        }

        // 处理 input 数组中的消息
        if (responsesRequest.input && Array.isArray(responsesRequest.input)) {
            responsesRequest.input.forEach(item => {
                // 如果 item 没有 type 属性，默认为 message
                // 或者 item.type 明确为 message
                if (!item.type || item.type === 'message') {
                    let content = '';
                    if (Array.isArray(item.content)) {
                        content = item.content
                            .filter(c => c.type === 'input_text')
                            .map(c => c.text)
                            .join('\n');
                    } else if (typeof item.content === 'string') {
                        content = item.content;
                    }
                    
                    if (content) {
                        geminiRequest.contents.push({
                            role: item.role === 'assistant' ? 'model' : 'user',
                            parts: [{
                                text: content
                            }]
                        });
                    }
                }
            });
        }

        // 如果有标准的 messages 字段，也支持
        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            const { systemMessages, otherMessages } = extractSystemMessages(
                responsesRequest.messages
            );

            if (!geminiRequest.systemInstruction && systemMessages.length > 0) {
                const systemTexts = systemMessages.map(msg => extractText(msg.content));
                geminiRequest.systemInstruction = {
                    parts: [{
                        text: systemTexts.join('\n')
                    }]
                };
            }

            otherMessages.forEach(msg => {
                geminiRequest.contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{
                        text: typeof msg.content === 'string' ? msg.content : extractText(msg.content)
                    }]
                });
            });
        }

        // 设置生成配置
        if (responsesRequest.temperature !== undefined) {
            geminiRequest.generationConfig.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_tokens !== undefined) {
            geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_tokens;
        }
        if (responsesRequest.top_p !== undefined) {
            geminiRequest.generationConfig.topP = responsesRequest.top_p;
        }

        return geminiRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为 Gemini 响应
     */
    toGeminiResponse(responsesResponse, model) {
        const output = collectResponsesOutput(responsesResponse?.output);
        const toolCalls = extractToolCalls(output);
        const content = extractChatMessageText(responsesResponse) || extractAssistantText(output);
        const reasoningContent = extractChatReasoningContent(responsesResponse) || extractReasoningContent(output);
        const finishReason = responsesResponse?.choices?.[0]?.finish_reason
            || mapResponsesFinishReason(responsesResponse, toolCalls.length > 0);
        const usage = buildOpenAIUsage(responsesResponse?.usage);
        const parts = [];

        if (reasoningContent) {
            parts.push({
                thought: true,
                text: reasoningContent
            });
        }
        if (content) {
            parts.push({ text: content });
        }
        for (const toolCall of toolCalls) {
            parts.push({
                functionCall: {
                    name: toolCall.function?.name || '',
                    args: parseToolArguments(toolCall.function?.arguments)
                }
            });
        }
        if (parts.length === 0) {
            parts.push({ text: '' });
        }

        return {
            candidates: [{
                content: {
                    parts,
                    role: 'model'
                },
                finishReason: this.mapFinishReason(finishReason),
                index: 0
            }],
            usageMetadata: {
                promptTokenCount: usage.prompt_tokens,
                candidatesTokenCount: usage.completion_tokens,
                totalTokenCount: usage.total_tokens,
                cachedContentTokenCount: usage.prompt_tokens_details.cached_tokens,
                promptTokensDetails: [{
                    modality: "TEXT",
                    tokenCount: usage.prompt_tokens
                }],
                candidatesTokensDetails: [{
                    modality: "TEXT",
                    tokenCount: usage.completion_tokens
                }],
                thoughtsTokenCount: usage.completion_tokens_details.reasoning_tokens
            }
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Gemini 流式块
     */
    toGeminiStreamChunk(responsesChunk, model) {
        const delta = responsesChunk.choices?.[0]?.delta || responsesChunk.delta || {};
        const finishReason = responsesChunk.choices?.[0]?.finish_reason || 
                           responsesChunk.finish_reason;

        return {
            candidates: [{
                content: {
                    parts: delta.content ? [{
                        text: delta.content
                    }] : [],
                    role: 'model'
                },
                finishReason: finishReason ? this.mapFinishReason(finishReason) : null,
                index: 0
            }]
        };
    }

    // =============================================================================
    // 辅助方法
    // =============================================================================

    /**
     * 映射完成原因
     */
    mapFinishReason(reason) {
        const reasonMap = {
            'stop': 'STOP',
            'length': 'MAX_TOKENS',
            'content_filter': 'SAFETY',
            'end_turn': 'STOP'
        };
        return reasonMap[reason] || 'STOP';
    }

    /**
     * 将 OpenAI Responses 模型列表转换为标准 OpenAI 模型列表
     */
    toOpenAIModelList(responsesModels) {
        // OpenAI Responses 格式的模型列表已经是标准 OpenAI 格式
        // 如果输入已经是标准格式,直接返回
        if (responsesModels.object === 'list' && responsesModels.data) {
            return responsesModels;
        }

        // 如果是其他格式,转换为标准格式
        return {
            object: "list",
            data: (responsesModels.models || responsesModels.data || []).map(m => ({
                id: m.id || m.name,
                object: "model",
                created: m.created || Math.floor(Date.now() / 1000),
                owned_by: m.owned_by || "openai",
            })),
        };
    }

    /**
     * 将 OpenAI Responses 模型列表转换为 Claude 模型列表
     */
    toClaudeModelList(responsesModels) {
        const models = responsesModels.data || responsesModels.models || [];
        return {
            models: models.map(m => ({
                name: m.id || m.name,
                description: m.description || "",
            })),
        };
    }

    /**
     * 将 OpenAI Responses 模型列表转换为 Gemini 模型列表
     */
    toGeminiModelList(responsesModels) {
        const models = responsesModels.data || responsesModels.models || [];
        return {
            models: models.map(m => ({
                name: `models/${m.id || m.name}`,
                version: m.version || "1.0.0",
                displayName: m.displayName || m.id || m.name,
                description: m.description || `A generative model for text and chat generation. ID: ${m.id || m.name}`,
                inputTokenLimit: m.inputTokenLimit || GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
                outputTokenLimit: m.outputTokenLimit || GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
                supportedGenerationMethods: m.supportedGenerationMethods || ["generateContent", "streamGenerateContent"]
            }))
        };
    }

}
