import { getSystemPrompt, getModelReasoning, getUserAgent } from '../droid-profile.js';

export function transformToAnthropic(openaiRequest, profile) {
    const anthropicRequest = {
        model: openaiRequest.model,
        messages: []
    };

    if (openaiRequest.stream !== undefined) {
        anthropicRequest.stream = openaiRequest.stream;
    }

    if (openaiRequest.max_tokens) {
        anthropicRequest.max_tokens = openaiRequest.max_tokens;
    } else if (openaiRequest.max_completion_tokens) {
        anthropicRequest.max_tokens = openaiRequest.max_completion_tokens;
    } else {
        anthropicRequest.max_tokens = 4096;
    }

    let systemContent = [];

    if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
        for (const msg of openaiRequest.messages) {
            if (msg.role === 'system') {
                if (typeof msg.content === 'string') {
                    systemContent.push({ type: 'text', text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'text') {
                            systemContent.push({ type: 'text', text: part.text });
                        } else {
                            systemContent.push(part);
                        }
                    }
                }
                continue;
            }

            const anthropicMsg = {
                role: msg.role,
                content: []
            };

            if (typeof msg.content === 'string') {
                anthropicMsg.content.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        anthropicMsg.content.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url') {
                        anthropicMsg.content.push({ type: 'image', source: part.image_url });
                    } else {
                        anthropicMsg.content.push(part);
                    }
                }
            }

            anthropicRequest.messages.push(anthropicMsg);
        }
    }

    const systemPrompt = getSystemPrompt(profile);
    if (systemPrompt || systemContent.length > 0) {
        anthropicRequest.system = [];
        if (systemPrompt) {
            anthropicRequest.system.push({ type: 'text', text: systemPrompt });
        }
        anthropicRequest.system.push(...systemContent);
    }

    if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
        anthropicRequest.tools = openaiRequest.tools.map(tool => {
            if (tool.type === 'function') {
                return {
                    name: tool.function.name,
                    description: tool.function.description,
                    input_schema: tool.function.parameters || {}
                };
            }
            return tool;
        });
    }

    const reasoningLevel = getModelReasoning(profile, openaiRequest.model);
    if (reasoningLevel === 'auto') {
        if (openaiRequest.thinking !== undefined) {
            anthropicRequest.thinking = openaiRequest.thinking;
        }
    } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
        const budgetTokens = {
            low: 4096,
            medium: 12288,
            high: 24576,
            xhigh: 24576
        };
        anthropicRequest.thinking = {
            type: 'enabled',
            budget_tokens: budgetTokens[reasoningLevel]
        };
    } else {
        delete anthropicRequest.thinking;
    }

    if (openaiRequest.temperature !== undefined) {
        anthropicRequest.temperature = openaiRequest.temperature;
    }
    if (openaiRequest.top_p !== undefined) {
        anthropicRequest.top_p = openaiRequest.top_p;
    }
    if (openaiRequest.stop !== undefined) {
        anthropicRequest.stop_sequences = Array.isArray(openaiRequest.stop)
            ? openaiRequest.stop
            : [openaiRequest.stop];
    }

    return anthropicRequest;
}

export function getAnthropicHeaders(authHeader, clientHeaders = {}, isStreaming = true, modelId = null, provider = 'anthropic', profile) {
    const sessionId = clientHeaders['x-session-id'] || generateUUID();
    const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

    const headers = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'anthropic-version': clientHeaders['anthropic-version'] || '2023-06-01',
        'authorization': authHeader || '',
        'x-api-key': 'placeholder',
        'x-api-provider': provider,
        'x-factory-client': 'cli',
        'x-session-id': sessionId,
        'x-assistant-message-id': messageId,
        'user-agent': getUserAgent(profile),
        'x-stainless-timeout': '600',
        'connection': 'keep-alive'
    };

    const reasoningLevel = modelId ? getModelReasoning(profile, modelId) : null;
    let betaValues = [];

    if (clientHeaders['anthropic-beta']) {
        betaValues = clientHeaders['anthropic-beta'].split(',').map(v => v.trim());
    }

    const thinkingBeta = 'interleaved-thinking-2025-05-14';
    if (reasoningLevel === 'auto') {
        // keep client beta values
    } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
        if (!betaValues.includes(thinkingBeta)) {
            betaValues.push(thinkingBeta);
        }
    } else {
        betaValues = betaValues.filter(v => v !== thinkingBeta);
    }

    if (betaValues.length > 0) {
        headers['anthropic-beta'] = betaValues.join(', ');
    }

    const stainlessDefaults = {
        'x-stainless-arch': 'x64',
        'x-stainless-lang': 'js',
        'x-stainless-os': 'MacOS',
        'x-stainless-runtime': 'node',
        'x-stainless-retry-count': '0',
        'x-stainless-package-version': '0.57.0',
        'x-stainless-runtime-version': 'v24.3.0'
    };

    if (isStreaming) {
        headers['x-stainless-helper-method'] = 'stream';
    }

    Object.keys(stainlessDefaults).forEach(header => {
        headers[header] = clientHeaders[header] || stainlessDefaults[header];
    });

    if (clientHeaders['x-stainless-timeout']) {
        headers['x-stainless-timeout'] = clientHeaders['x-stainless-timeout'];
    }

    return headers;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
