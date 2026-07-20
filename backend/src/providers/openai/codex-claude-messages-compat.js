import { v4 as uuidv4 } from 'uuid';

const CODEX_COMPAT_DEFAULT_INSTRUCTIONS = `You are a coding assistant running inside a CLI on the user's computer. Behave like Claude Code, but do not claim to be Claude.

## Core Behavior

- Be concise, direct, and action-oriented.
- When the user asks you to do something, do it immediately if tools make it possible.
- Treat a direct user command as authorization to execute the task now.
- Do not ask for unnecessary confirmation.
- Do not ask the user to reply with phrases like "开始测试", "继续", or "确认" when the user has already clearly asked you to proceed.
- Do not ask the user to choose next steps when you can already complete the current task.
- Do not repeat the same sentence, summary, or execution preface twice.
- Do not restate the user's request before acting unless it is required to clarify an ambiguity.
- Avoid long preambles, self-talk, and ceremonial wording.
- Do not run self-checks, tool tests, or exploratory actions unless the user asked for them or they are required to complete the task.

## Tool Use

- Use the provided tools to inspect code, edit files, search, and run commands.
- Prefer fast search and file tools for discovery before shell commands when possible.
- Before a meaningful tool call, briefly state what you are about to do in one short sentence.
- When a task needs multiple steps, keep going until the requested work is done instead of stopping early.
- If a tool call fails, adapt and retry with the correct parameters instead of looping on the same mistake.

## Editing Constraints

- Make minimal, targeted changes that solve the root problem.
- Do not revert unrelated user changes.
- Avoid destructive actions unless the user explicitly asks for them.
- Preserve existing project conventions.
- Validate meaningful changes when practical.

## Response Style

- Prefer short, useful updates over explanations.
- If the user asks to test tools or inspect behavior, perform the requested checks directly and report the result concisely.
- After the user explicitly asks you to run a test, scan, or command, do not reply with another permission-seeking message. Execute it.
- Never output the same explanatory paragraph twice.
- If the environment blocks a request, explain the real blocker clearly and stop instead of inventing a workaround that changes the task.
- End with the result, not with a generic offer unless a real next step is needed.`;

const CLAUDE_CODE_SYSTEM_PATTERNS = [
    /you are claude code/i,
    /anthropic'?s official cli/i,
    /interactive agent that helps users with software engineering tasks/i,
    /claude code harness/i,
];

function safeString(value) {
    return typeof value === 'string' ? value : '';
}

function tryParseJsonObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { raw_input: value };
    } catch {
        return value.trim() ? { raw_input: value } : {};
    }
}

function stringifyJson(value, fallback = '{}') {
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return fallback;
    }
}

function normalizeClaudeTextBlocks(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    return content.map(block => {
        if (!block || typeof block !== 'object') return null;
        if (block.type === 'text' && typeof block.text === 'string') {
            return { type: 'text', text: block.text };
        }
        if (block.type === 'image') return block;
        if (block.type === 'tool_use') return block;
        if (block.type === 'tool_result') return block;
        if (typeof block.text === 'string') return { type: 'text', text: block.text };
        return null;
    }).filter(Boolean);
}

function extractTextFromClaudeBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
        .map(block => {
            if (!block || typeof block !== 'object') return '';
            if (typeof block.text === 'string') return block.text;
            if (typeof block === 'string') return block;
            return '';
        })
        .filter(Boolean)
        .join('');
}

function buildClaudeDataUrl(source) {
    if (!source || typeof source !== 'object') return '';
    const data = safeString(source.data || source.base64);
    if (!data) return '';
    const mediaType = safeString(source.media_type || source.mime_type) || 'application/octet-stream';
    return `data:${mediaType};base64,${data}`;
}

function shortenToolNameIfNeeded(name) {
    const raw = safeString(name);
    const limit = 64;
    if (raw.length <= limit) return raw;
    if (raw.startsWith('mcp__')) {
        const idx = raw.lastIndexOf('__');
        if (idx > 0) {
            const candidate = `mcp__${raw.slice(idx + 2)}`;
            return candidate.length > limit ? candidate.slice(0, limit) : candidate;
        }
    }
    return raw.slice(0, limit);
}

function buildShortNameMap(names) {
    const limit = 64;
    const used = new Set();
    const map = new Map();

    const makeUnique = (candidate) => {
        if (!used.has(candidate)) return candidate;
        for (let index = 1; ; index += 1) {
            const suffix = `_${index}`;
            const trimmed = `${candidate.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
            if (!used.has(trimmed)) return trimmed;
        }
    };

    for (const name of Array.isArray(names) ? names : []) {
        const base = shortenToolNameIfNeeded(name);
        const unique = makeUnique(base);
        used.add(unique);
        map.set(name, unique);
    }
    return map;
}

function buildClaudeToolNameMaps(claudeRequest) {
    const names = Array.isArray(claudeRequest?.tools)
        ? claudeRequest.tools.map(tool => safeString(tool?.name)).filter(Boolean)
        : [];
    const forward = buildShortNameMap(names);
    const reverse = new Map();
    for (const [original, short] of forward.entries()) {
        reverse.set(short, original);
    }
    return { forward, reverse };
}

function normalizeToolParameters(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }
    const normalized = { ...schema };
    delete normalized.$schema;
    if (!normalized.type) normalized.type = 'object';
    if (normalized.type === 'object' && (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties))) {
        normalized.properties = {};
    }
    return normalized;
}

function determineReasoningEffortFromClaudeThinking(claudeRequest) {
    const thinking = claudeRequest?.thinking;
    if (!thinking || typeof thinking !== 'object') return 'medium';

    const type = safeString(thinking.type).toLowerCase();
    if (type === 'adaptive' || type === 'auto') {
        const explicit = safeString(claudeRequest?.output_config?.effort).toLowerCase();
        return explicit || 'high';
    }
    if (type === 'disabled') {
        return 'low';
    }
    if (type === 'enabled') {
        const budget = Number(thinking.budget_tokens);
        if (!Number.isFinite(budget)) return 'medium';
        if (budget <= 50) return 'low';
        if (budget <= 200) return 'medium';
        return 'high';
    }
    return 'medium';
}

function buildResponsesMessageItem(role, contentParts) {
    if (!Array.isArray(contentParts) || contentParts.length === 0) return null;
    return {
        type: 'message',
        role,
        content: contentParts
    };
}

function convertAssistantBlocksToResponsesInput(blocks, output, toolNameMap = new Map()) {
    const textParts = [];
    const flushText = () => {
        const item = buildResponsesMessageItem('assistant', textParts.splice(0, textParts.length));
        if (item) output.push(item);
    };

    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push({ type: 'output_text', text: block.text });
            continue;
        }
        if (block.type === 'tool_use' && block.name) {
            flushText();
            const name = toolNameMap.get(block.name) || shortenToolNameIfNeeded(block.name);
            output.push({
                type: 'function_call',
                call_id: block.id || normalizeToolUseId(''),
                name,
                arguments: stringifyJson(block.input, '{}')
            });
        }
    }

    flushText();
}

function normalizeToolResultOutput(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const normalized = [];
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
                normalized.push({ type: 'input_text', text: block.text });
                continue;
            }
            if (block.type === 'image') {
                const imageUrl = buildClaudeDataUrl(block.source);
                if (imageUrl) normalized.push({ type: 'input_image', image_url: imageUrl });
            }
        }
        return normalized.length > 0 ? normalized : extractTextFromClaudeBlocks(content);
    }
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return stringifyJson(content, '');
}

function convertUserBlocksToResponsesInput(blocks, output) {
    const messageParts = [];
    const toolResults = [];

    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            messageParts.push({ type: 'input_text', text: block.text });
            continue;
        }
        if (block.type === 'image') {
            const imageUrl = buildClaudeDataUrl(block.source);
            if (imageUrl) {
                messageParts.push({ type: 'input_image', image_url: imageUrl });
            }
            continue;
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
            toolResults.push({
                type: 'function_call_output',
                call_id: block.tool_use_id,
                output: normalizeToolResultOutput(block.content)
            });
        }
    }

    const messageItem = buildResponsesMessageItem('user', messageParts);
    if (messageItem) output.push(messageItem);
    for (const toolResult of toolResults) {
        output.push(toolResult);
    }
}

function convertClaudeMessagesToResponsesInput(messages, toolNameMap = new Map()) {
    const input = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') continue;
        const role = message.role || 'user';
        const content = message.content;

        if (typeof content === 'string') {
            const textType = role === 'assistant' ? 'output_text' : 'input_text';
            input.push({
                type: 'message',
                role,
                content: [{ type: textType, text: content }]
            });
            continue;
        }

        if (!Array.isArray(content)) continue;

        if (role === 'assistant') {
            convertAssistantBlocksToResponsesInput(content, input, toolNameMap);
            continue;
        }

        if (role === 'user') {
            convertUserBlocksToResponsesInput(content, input);
            continue;
        }

        const text = extractTextFromClaudeBlocks(content);
        if (text) {
            input.push({
                type: 'message',
                role,
                content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
            });
        }
    }

    return input;
}

function mapClaudeTool(tool, toolNameMap = new Map()) {
    if (!tool || typeof tool !== 'object') return null;
    if (tool.type === 'web_search_20250305') {
        return { type: 'web_search' };
    }
    if (!tool.name) return null;
    return {
        type: 'function',
        name: toolNameMap.get(tool.name) || shortenToolNameIfNeeded(tool.name),
        description: safeString(tool.description),
        parameters: normalizeToolParameters(tool.input_schema),
        strict: false
    };
}

function mapClaudeToolChoice(toolChoice, toolNameMap = new Map()) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    if (toolChoice.type === 'tool' && toolChoice.name) {
        return { type: 'function', name: toolNameMap.get(toolChoice.name) || shortenToolNameIfNeeded(toolChoice.name) };
    }
    if (toolChoice.type === 'auto') return 'auto';
    if (toolChoice.type === 'any') return 'required';
    if (toolChoice.type === 'none') return 'none';
    return toolChoice;
}

function normalizeToolUseId(value) {
    const raw = safeString(value).trim();
    if (raw.startsWith('toolu_')) return raw;
    return `toolu_${raw || uuidv4().replace(/-/g, '')}`;
}

function buildToolUseInputDelta(index, rawInput) {
    const inputJson = typeof rawInput === 'string'
        ? rawInput
        : (() => {
            try {
                return JSON.stringify(rawInput ?? {});
            } catch {
                return '{}';
            }
        })();

    return {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'input_json_delta',
            partial_json: inputJson && inputJson.trim() ? inputJson : '{}'
        }
    };
}

function extractResponseObject(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.type === 'response.completed' && payload.response && typeof payload.response === 'object') {
        return payload.response;
    }
    if (payload.object === 'response') return payload;
    if (payload.response && payload.response.object === 'response') return payload.response;
    if (Array.isArray(payload.output)) return payload;
    return null;
}

function reconstructResponsesObjectFromEvents(events, fallbackModel = null) {
    let lastResponse = null;
    let responseId = '';
    let model = fallbackModel || '';
    const output = [];
    let usage = null;
    let status = 'completed';
    let incompleteDetails = null;

    for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
            lastResponse = event.response;
        }
    }

    if (lastResponse) return lastResponse;

    for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response.created' && event.response) {
            responseId = event.response.id || responseId;
            model = event.response.model || model;
            status = event.response.status || status;
        } else if (event.type === 'response.output_item.done' && event.item) {
            output.push(event.item);
        } else if (event.type === 'response.completed' && event.response) {
            usage = event.response.usage || usage;
            status = event.response.status || status;
            incompleteDetails = event.response.incomplete_details || incompleteDetails;
        }
    }

    if (!responseId && output.length === 0) return null;

    return {
        id: responseId || `resp_${uuidv4().replace(/-/g, '')}`,
        object: 'response',
        model,
        status,
        incomplete_details: incompleteDetails,
        output,
        usage
    };
}

function resolveClaudeToolReverseMap(options = {}) {
    const requestBody = options?.requestBody;
    const rawMap = requestBody?.__codex_claude_tool_name_reverse_map;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return new Map();
    return new Map(Object.entries(rawMap));
}

function extractClaudeContentFromOutput(output, options = {}) {
    const reverseToolNameMap = resolveClaudeToolReverseMap(options);
    const content = [];
    for (const item of Array.isArray(output) ? output : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'reasoning') {
            const thinkingText = Array.isArray(item.summary)
                ? item.summary.map(part => safeString(part?.text)).filter(Boolean).join('')
                : '';
            if (thinkingText) {
                content.push({ type: 'thinking', thinking: thinkingText });
            }
            continue;
        }
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    content.push({ type: 'text', text: part.text });
                }
            }
            continue;
        }
        if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name) {
            const rawInput = item.arguments ?? item.input ?? '';
            const restoredName = reverseToolNameMap.get(item.name) || item.name;
            content.push({
                type: 'tool_use',
                id: normalizeToolUseId(item.call_id || item.id),
                name: restoredName,
                input: tryParseJsonObject(rawInput)
            });
        }
    }
    return content;
}

function buildClaudeUsage(usage) {
    const cacheReadTokens = usage?.input_tokens_details?.cached_tokens
        || usage?.prompt_tokens_details?.cached_tokens
        || 0;
    const rawInputTokens = usage?.input_tokens || 0;
    const cacheCreationTokens = usage?.cache_creation_input_tokens
        || usage?.input_tokens_details?.cache_creation_tokens
        || 0;
    return {
        input_tokens: Math.max(0, rawInputTokens - cacheReadTokens),
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
        output_tokens: usage?.output_tokens || 0
    };
}

function convertResponsesStatusToClaudeStopReason(response, content) {
    const explicitStopReason = safeString(response?.stop_reason);
    const status = response?.status || 'completed';
    const incompleteReason = response?.incomplete_details?.reason || null;
    const hasToolUse = Array.isArray(content) && content.some(block => block.type === 'tool_use');

    if (explicitStopReason) {
        return explicitStopReason;
    }
    if (hasToolUse) {
        return 'tool_use';
    }

    switch (status) {
        case 'completed':
            return 'end_turn';
        case 'incomplete':
        case 'truncated':
            return (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens' || incompleteReason === null)
                ? 'max_tokens'
                : 'end_turn';
        case 'cancelled':
            return 'end_turn';
        default:
            return 'end_turn';
    }
}

function extractSystemText(system) {
    if (!system) return '';
    if (typeof system === 'string') {
        const trimmed = system.trim();
        return trimmed.startsWith('x-anthropic-billing-header: ') ? '' : trimmed;
    }
    if (Array.isArray(system)) {
        return system
            .map(block => safeString(block?.text).trim())
            .filter(text => text && !text.startsWith('x-anthropic-billing-header: '))
            .join('\n\n');
    }
    return '';
}

function isClaudeCodeSystemPrompt(systemText) {
    if (!systemText) return false;
    return CLAUDE_CODE_SYSTEM_PATTERNS.some(pattern => pattern.test(systemText));
}

export function buildCodexResponsesRequestFromClaude(claudeRequest) {
    const { forward: toolNameMap, reverse: reverseToolNameMap } = buildClaudeToolNameMaps(claudeRequest);
    const request = {
        model: claudeRequest.model,
        max_tokens: claudeRequest.max_tokens,
        instructions: '',
        input: [],
        store: false,
        stream: true,
        parallel_tool_calls: true,
        reasoning: {
            effort: determineReasoningEffortFromClaudeThinking(claudeRequest),
            summary: 'auto'
        },
        include: ['reasoning.encrypted_content'],
        __codex_claude_tool_name_reverse_map: Object.fromEntries(reverseToolNameMap)
    };

    const rawSystemText = extractSystemText(claudeRequest.system);
    if (rawSystemText && !rawSystemText.startsWith('x-anthropic-billing-header: ')) {
        request.input.push({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: rawSystemText }]
        });
    }

    if (Array.isArray(claudeRequest.messages)) {
        request.input.push(...convertClaudeMessagesToResponsesInput(claudeRequest.messages, toolNameMap));
    }

    if (Array.isArray(claudeRequest.tools)) {
        request.tools = claudeRequest.tools.map(tool => mapClaudeTool(tool, toolNameMap)).filter(Boolean);
        request.tool_choice = 'auto';
    }

    const mappedToolChoice = mapClaudeToolChoice(claudeRequest.tool_choice, toolNameMap);
    if (mappedToolChoice !== undefined) {
        request.tool_choice = mappedToolChoice;
    }

    if (claudeRequest.parallel_tool_calls !== undefined) {
        request.parallel_tool_calls = claudeRequest.parallel_tool_calls;
    }

    if (Array.isArray(claudeRequest.stop_sequences) && claudeRequest.stop_sequences.length > 0) {
        request.stop = [...claudeRequest.stop_sequences];
    }

    return Object.fromEntries(
        Object.entries(request).filter(([, value]) => value !== undefined)
    );
}

export function summarizeCodexClaudeCompatRequest(originalRequest, processedRequest, options = {}) {
    const rawSystemText = extractSystemText(originalRequest?.system);
    const customSystemText = rawSystemText && !isClaudeCodeSystemPrompt(rawSystemText)
        ? rawSystemText
        : '';
    const toolNames = Array.isArray(processedRequest?.tools)
        ? processedRequest.tools.map(tool => tool?.name).filter(Boolean).slice(0, 8)
        : [];

    return {
        requestedModel: options.requestedModel || originalRequest?.model || null,
        upstreamModel: options.upstreamModel || processedRequest?.model || null,
        stream: processedRequest?.stream === true,
        inputCount: Array.isArray(processedRequest?.input) ? processedRequest.input.length : 0,
        toolCount: Array.isArray(processedRequest?.tools) ? processedRequest.tools.length : 0,
        toolNames,
        toolChoice: processedRequest?.tool_choice || null,
        instructionMode: customSystemText ? 'developer_system' : 'empty',
        customSystemChars: customSystemText.length,
        forwardedClaudeFields: []
    };
}

export function summarizeCodexClaudeCompatResponse(payload, model) {
    const response = extractResponseObject(payload);
    if (!response) return null;
    const content = extractClaudeContentFromOutput(response.output);
    const textCount = content.filter(block => block.type === 'text').length;
    const toolUseNames = content.filter(block => block.type === 'tool_use').map(block => block.name).filter(Boolean);

    return {
        model: model || response.model || null,
        outputCount: Array.isArray(response.output) ? response.output.length : 0,
        textBlockCount: textCount,
        toolUseCount: toolUseNames.length,
        toolUseNames: toolUseNames.slice(0, 8),
        usage: buildClaudeUsage(response.usage)
    };
}

export function summarizeCodexClaudeCompatStreamEvent(nativeChunk, convertedChunk, model) {
    if (!nativeChunk || typeof nativeChunk !== 'object') return null;

    const convertedTypes = Array.isArray(convertedChunk)
        ? convertedChunk.map(item => item?.type).filter(Boolean)
        : (convertedChunk?.type ? [convertedChunk.type] : []);

    if (nativeChunk.type === 'response.created') {
        return {
            nativeType: nativeChunk.type,
            convertedTypes,
            model: model || nativeChunk.response?.model || null
        };
    }

    if (nativeChunk.type === 'response.output_item.added') {
        return {
            nativeType: nativeChunk.type,
            convertedTypes,
            itemType: nativeChunk.item?.type || null,
            itemName: nativeChunk.item?.name || null,
            outputIndex: nativeChunk.output_index ?? 0
        };
    }

    if (nativeChunk.type === 'response.completed') {
        return {
            nativeType: nativeChunk.type,
            convertedTypes,
            model: model || nativeChunk.response?.model || null,
            usage: buildClaudeUsage(nativeChunk.response?.usage),
            outputCount: Array.isArray(nativeChunk.response?.output) ? nativeChunk.response.output.length : 0,
            status: nativeChunk.response?.status || null,
            incompleteReason: nativeChunk.response?.incomplete_details?.reason || null
        };
    }

    return null;
}

export function convertCodexResponseToClaudeMessage(payload, model, options = {}) {
    const response = extractResponseObject(payload);
    if (!response) return null;

    const content = extractClaudeContentFromOutput(response.output, options);
    const stopReason = convertResponsesStatusToClaudeStopReason(response, content);

    return {
        id: response.id || `msg_${uuidv4().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        model: model || response.model,
        content,
        stop_reason: stopReason,
        stop_sequence: response.stop_sequence ?? null,
        usage: buildClaudeUsage(response.usage)
    };
}

export function convertCodexResponsesEventsToClaudeMessage(events, model, options = {}) {
    const response = reconstructResponsesObjectFromEvents(events, model);
    if (!response) return null;
    return convertCodexResponseToClaudeMessage(response, model, options);
}

export function convertClaudeMessageToSSEEvents(message) {
    if (!message || typeof message !== 'object') return [];

    const events = [];
    events.push({
        event: 'message_start',
        data: {
            type: 'message_start',
            message: {
                id: message.id,
                type: 'message',
                role: message.role,
                content: [],
                model: message.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: message.usage?.input_tokens || 0,
                    cache_creation_input_tokens: message.usage?.cache_creation_input_tokens || 0,
                    cache_read_input_tokens: message.usage?.cache_read_input_tokens || 0,
                    output_tokens: 0
                }
            }
        }
    });

    for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
            events.push({
                event: 'content_block_start',
                data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
            });
            if (block.text) {
                events.push({
                    event: 'content_block_delta',
                    data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }
                });
            }
            events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
            continue;
        }
        if (block.type === 'tool_use') {
            events.push({
                event: 'content_block_start',
                data: {
                    type: 'content_block_start',
                    index,
                    content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
                }
            });
            events.push({
                event: 'content_block_delta',
                data: {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'input_json_delta', partial_json: stringifyJson(block.input, '{}') }
                }
            });
            events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
            continue;
        }
        if (block.type === 'thinking') {
            events.push({
                event: 'content_block_start',
                data: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }
            });
            if (block.thinking) {
                events.push({
                    event: 'content_block_delta',
                    data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }
                });
            }
            events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
        }
    }

    events.push({
        event: 'message_delta',
        data: {
            type: 'message_delta',
            delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence || null },
            usage: { output_tokens: message.usage?.output_tokens || 0 }
        }
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
}

function getCompatStreamState(options = {}) {
    const state = options.state && typeof options.state === 'object' ? options.state : {};
    if (!Number.isInteger(state.blockIndex)) state.blockIndex = 0;
    if (typeof state.hasToolCall !== 'boolean') state.hasToolCall = false;
    if (typeof state.hasReceivedArgumentsDelta !== 'boolean') state.hasReceivedArgumentsDelta = false;
    return state;
}

export function convertCodexStreamEventToClaudeChunk(chunk, model, options = {}) {
    if (!chunk || typeof chunk !== 'object') return null;

    const reverseToolNameMap = resolveClaudeToolReverseMap(options);
    const state = getCompatStreamState(options);

    if (chunk.type === 'response.created') {
        return {
            type: 'message_start',
            message: {
                id: chunk.response?.id || `msg_${uuidv4().replace(/-/g, '')}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: model || chunk.response?.model,
                stop_reason: null,
                stop_sequence: null,
                usage: buildClaudeUsage(chunk.response?.usage)
            }
        };
    }

    if (chunk.type === 'response.reasoning_summary_part.added') {
        return {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: { type: 'thinking', thinking: '' }
        };
    }

    if (chunk.type === 'response.reasoning_summary_text.delta') {
        return {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'thinking_delta', thinking: safeString(chunk.delta) }
        };
    }

    if (chunk.type === 'response.reasoning_summary_part.done') {
        const currentIndex = state.blockIndex;
        state.blockIndex += 1;
        return { type: 'content_block_stop', index: currentIndex };
    }

    if (chunk.type === 'response.content_part.added' && chunk.part?.type === 'output_text') {
        return {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: { type: 'text', text: '' }
        };
    }

    if (chunk.type === 'response.output_text.delta') {
        return {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: {
                type: 'text_delta',
                text: safeString(chunk.delta)
            }
        };
    }

    if (chunk.type === 'response.output_text.done' || chunk.type === 'response.reasoning_summary_text.done') {
        return null;
    }

    if (chunk.type === 'response.content_part.done') {
        const currentIndex = state.blockIndex;
        state.blockIndex += 1;
        return { type: 'content_block_stop', index: currentIndex };
    }

    if (chunk.type === 'response.output_item.added') {
        const item = chunk.item || {};
        if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name) {
            state.hasToolCall = true;
            state.hasReceivedArgumentsDelta = false;
            const restoredName = reverseToolNameMap.get(item.name) || item.name;
            return [
                {
                    type: 'content_block_start',
                    index: state.blockIndex,
                    content_block: {
                        type: 'tool_use',
                        id: normalizeToolUseId(item.call_id || item.id),
                        name: restoredName,
                        input: {}
                    }
                },
                {
                    type: 'content_block_delta',
                    index: state.blockIndex,
                    delta: { type: 'input_json_delta', partial_json: '' }
                }
            ];
        }
        return null;
    }

    if (chunk.type === 'response.function_call_arguments.delta' || chunk.type === 'response.custom_tool_call_input.delta') {
        state.hasReceivedArgumentsDelta = true;
        return {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: {
                type: 'input_json_delta',
                partial_json: safeString(chunk.delta)
            }
        };
    }

    if (chunk.type === 'response.function_call_arguments.done' || chunk.type === 'response.custom_tool_call_input.done') {
        if (!state.hasReceivedArgumentsDelta) {
            const fullArgs = safeString(chunk.arguments ?? chunk.input);
            if (fullArgs) {
                return {
                    type: 'content_block_delta',
                    index: state.blockIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: fullArgs
                    }
                };
            }
        }
        return null;
    }

    if (chunk.type === 'response.output_item.done') {
        const item = chunk.item || {};
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            const currentIndex = state.blockIndex;
            state.blockIndex += 1;
            return { type: 'content_block_stop', index: currentIndex };
        }
        return null;
    }

    if (chunk.type === 'response.completed') {
        const stopReason = safeString(chunk.response?.stop_reason);
        return [
            {
                type: 'message_delta',
                delta: {
                    stop_reason: state.hasToolCall
                        ? 'tool_use'
                        : ((stopReason === 'max_tokens' || stopReason === 'stop') ? stopReason : 'end_turn'),
                    stop_sequence: null
                },
                usage: buildClaudeUsage(chunk.response?.usage)
            },
            {
                type: 'message_stop'
            }
        ];
    }

    return null;
}
