import { getSystemPrompt, getUserAgent, getModelReasoning } from '../droid-profile.js';

export function transformToCommon(openaiRequest, profile) {
    const commonRequest = {
        ...openaiRequest
    };

    const systemPrompt = getSystemPrompt(profile);
    if (systemPrompt) {
        const hasSystemMessage = commonRequest.messages?.some(m => m.role === 'system');
        if (hasSystemMessage) {
            const firstIndex = commonRequest.messages.findIndex(m => m.role === 'system');
            commonRequest.messages = commonRequest.messages.map((msg, index) => {
                if (msg.role === 'system' && index === firstIndex) {
                    return {
                        role: 'system',
                        content: systemPrompt + (typeof msg.content === 'string' ? msg.content : '')
                    };
                }
                return msg;
            });
        } else {
            commonRequest.messages = [
                { role: 'system', content: systemPrompt },
                ...(commonRequest.messages || [])
            ];
        }
    }

    const reasoningLevel = getModelReasoning(profile, openaiRequest.model);
    if (reasoningLevel === 'auto') {
        // preserve
    } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
        commonRequest.reasoning_effort = reasoningLevel;
    } else {
        delete commonRequest.reasoning_effort;
    }

    return commonRequest;
}

export function getCommonHeaders(authHeader, clientHeaders = {}, provider = 'baseten', profile) {
    const sessionId = clientHeaders['x-session-id'] || generateUUID();
    const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

    const headers = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': authHeader || '',
        'x-api-provider': provider,
        'x-factory-client': 'cli',
        'x-session-id': sessionId,
        'x-assistant-message-id': messageId,
        'user-agent': getUserAgent(profile),
        'connection': 'keep-alive'
    };

    const stainlessDefaults = {
        'x-stainless-arch': 'x64',
        'x-stainless-lang': 'js',
        'x-stainless-os': 'MacOS',
        'x-stainless-runtime': 'node',
        'x-stainless-retry-count': '0',
        'x-stainless-package-version': '5.23.2',
        'x-stainless-runtime-version': 'v24.3.0'
    };

    Object.keys(stainlessDefaults).forEach(header => {
        headers[header] = clientHeaders[header] || stainlessDefaults[header];
    });

    return headers;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
