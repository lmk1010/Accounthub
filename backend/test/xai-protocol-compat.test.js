import assert from 'node:assert/strict';
import test from 'node:test';

import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import {
    MODEL_PROTOCOL_PREFIX,
    MODEL_PROVIDER,
    getProtocolPrefix
} from '../src/utils/common.js';
import { normalizeXaiRequestBody } from '../src/providers/openai/xai-core.js';

test('routes the Grok provider through the OpenAI Responses protocol', () => {
    assert.equal(
        getProtocolPrefix(MODEL_PROVIDER.OPENAI_XAI),
        MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
    );
});

test('converts OpenAI Chat requests into Grok Responses requests', () => {
    const converted = convertData({
        model: 'grok-4.5',
        messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Find item 42.' }
        ],
        max_completion_tokens: 128,
        reasoning_effort: 'high',
        prompt_cache_key: 'chat-session-cache',
        tools: [{
            type: 'function',
            function: {
                name: 'lookup',
                description: 'Look up an item',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id']
                }
            }
        }],
        tool_choice: { type: 'function', function: { name: 'lookup' } }
    }, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROVIDER.OPENAI_XAI);
    const normalized = normalizeXaiRequestBody(converted, converted.model, true);

    assert.equal(normalized.model, 'grok-4.5');
    assert.equal(normalized.max_output_tokens, 128);
    assert.equal(normalized.reasoning.effort, 'high');
    assert.equal(normalized.prompt_cache_key, 'chat-session-cache');
    assert.equal(normalized.input[0].role, 'developer');
    assert.equal(normalized.input[1].role, 'user');
    assert.equal(normalized.tools[0].name, 'lookup');
    assert.equal('function' in normalized.tools[0], false);
    assert.deepEqual(normalized.tool_choice, { type: 'function', name: 'lookup' });
});

test('converts OpenAI Chat image_url blocks into Grok input_image blocks', () => {
    const imageUrl = 'data:image/png;base64,aGVsbG8=';
    const converted = convertData({
        model: 'grok-4.5',
        messages: [{
            role: 'user',
            content: [{
                type: 'image_url',
                image_url: {
                    url: imageUrl,
                    detail: 'high'
                }
            }, {
                type: 'text',
                text: 'Describe this image.'
            }]
        }]
    }, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROVIDER.OPENAI_XAI);
    const normalized = normalizeXaiRequestBody(converted, converted.model, true);

    assert.deepEqual(normalized.input[0].content, [{
        type: 'input_image',
        image_url: imageUrl,
        detail: 'high'
    }, {
        type: 'input_text',
        text: 'Describe this image.'
    }]);
});

test('converts Claude messages and tools into Grok Responses requests', () => {
    const converted = convertData({
        model: 'grok-4.5',
        system: [{ type: 'text', text: 'Use the available tools.' }],
        messages: [
            {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'toolu_1',
                    name: 'lookup',
                    input: { id: '42' }
                }]
            },
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: 'found'
                }, {
                    type: 'text',
                    text: 'Summarize it.'
                }]
            }
        ],
        max_tokens: 256,
        thinking: { type: 'enabled', budget_tokens: 500 },
        tools: [{
            name: 'lookup',
            description: 'Look up an item',
            input_schema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id']
            }
        }],
        tool_choice: { type: 'tool', name: 'lookup' }
    }, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROVIDER.OPENAI_XAI);
    const normalized = normalizeXaiRequestBody(converted, converted.model, true);

    assert.equal(normalized.max_output_tokens, 256);
    assert.equal(normalized.reasoning.effort, 'high');
    assert.equal(normalized.input[0].role, 'developer');
    assert.equal(normalized.input.some(item => item.type === 'function_call'), true);
    assert.equal(normalized.input.some(item => item.type === 'function_call_output'), true);
    assert.equal(normalized.tools[0].name, 'lookup');
    assert.deepEqual(normalized.tool_choice, { type: 'function', name: 'lookup' });
});

test('converts Claude base64 images into Grok input_image blocks', () => {
    const converted = convertData({
        model: 'grok-4.5',
        messages: [{
            role: 'user',
            content: [{
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'aGVsbG8='
                }
            }, {
                type: 'text',
                text: 'Describe this image.'
            }]
        }]
    }, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROVIDER.OPENAI_XAI);
    const normalized = normalizeXaiRequestBody(converted, converted.model, true);

    assert.deepEqual(normalized.input[0].content, [{
        type: 'input_image',
        image_url: 'data:image/png;base64,aGVsbG8='
    }, {
        type: 'input_text',
        text: 'Describe this image.'
    }]);
});
