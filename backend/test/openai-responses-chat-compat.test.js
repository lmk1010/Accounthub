import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesApiService } from '../src/providers/openai/openai-responses-core.js';
import { handleStreamRequest, handleUnaryRequest, MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from '../src/utils/common.js';

const MODEL = 'reasoning-model-v1';
const converter = new OpenAIResponsesConverter();
const openaiConverter = new OpenAIConverter();

function createMockResponse() {
    return {
        headersSent: false,
        statusCode: null,
        headers: null,
        body: '',
        ended: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        write(chunk) {
            this.body += String(chunk || '');
        },
        end(chunk = '') {
            this.body += String(chunk || '');
            this.ended = true;
        }
    };
}

function createTextResponse() {
    return {
        id: 'resp_text',
        model: MODEL,
        status: 'completed',
        output: [
            {
                id: 'reasoning_text',
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'Check the request' }]
            },
            {
                id: 'message_text',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello from the test.' }]
            }
        ],
        usage: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17
        }
    };
}

function createToolResponse() {
    return {
        id: 'resp_tool',
        model: MODEL,
        status: 'completed',
        output: [
            {
                id: 'reasoning_tool',
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'Call the lookup tool' }]
            },
            {
                id: 'tool_call',
                call_id: 'call_1',
                type: 'function_call',
                name: 'lookup_record',
                arguments: '{"id":"42"}'
            }
        ],
        usage: {
            input_tokens: 20,
            output_tokens: 8,
            total_tokens: 28
        }
    };
}

test('converts Responses text output to a chat completion', () => {
    const result = converter.toOpenAIResponse(createTextResponse(), MODEL);

    assert.equal(result.choices[0].message.content, 'Hello from the test.');
    assert.equal(result.choices[0].message.reasoning_content, 'Check the request');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 12);
    assert.equal(result.usage.completion_tokens, 5);
});

test('converts Responses stream events to chat chunks', () => {
    const roleChunk = converter.toOpenAIStreamChunk({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'message_text', type: 'message', role: 'assistant', content: [] }
    }, MODEL);
    const textChunk = converter.toOpenAIStreamChunk({
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'message_text',
        content_index: 0,
        delta: 'Hello'
    }, MODEL);
    const reasoningChunk = converter.toOpenAIStreamChunk({
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: 'reasoning_text',
        summary_index: 0,
        delta: 'Check'
    }, MODEL);
    const finishChunk = converter.toOpenAIStreamChunk({
        type: 'response.completed',
        response: createTextResponse()
    }, MODEL);

    assert.equal(roleChunk.choices[0].delta.role, 'assistant');
    assert.equal(textChunk.choices[0].delta.content, 'Hello');
    assert.equal(reasoningChunk.choices[0].delta.reasoning_content, 'Check');
    assert.equal(finishChunk.choices[0].finish_reason, 'stop');
    assert.equal(finishChunk.usage.completion_tokens, 5);
});

test('converts Responses function calls to chat tool calls', () => {
    const result = converter.toOpenAIResponse(createToolResponse(), MODEL);
    const toolCall = result.choices[0].message.tool_calls[0];

    assert.equal(result.choices[0].message.content, null);
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.equal(toolCall.function.name, 'lookup_record');
    assert.equal(toolCall.function.arguments, '{"id":"42"}');
});

test('normalizes camelCase usage token fields', () => {
    const response = createTextResponse();
    response.usage = {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        inputTokensDetails: { cachedTokens: 3 },
        outputTokensDetails: { reasoningTokens: 5 }
    };

    const result = converter.toOpenAIResponse(response, MODEL);

    // prompt_tokens is uncached-only so NewAPI does not double-bill prompt+cache
    assert.equal(result.usage.prompt_tokens, 8);
    assert.equal(result.usage.completion_tokens, 7);
    assert.equal(result.usage.total_tokens, 18);
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 3);
    assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 5);
});

test('splits Grok total input into uncached prompt and cached details for OpenAI clients', () => {
    const response = createTextResponse();
    response.usage = {
        prompt_text_tokens: 205083,
        completion_tokens: 1100,
        cached_prompt_text_tokens: 203776
    };

    const result = converter.toOpenAIResponse(response, MODEL);
    assert.equal(result.usage.prompt_tokens, 1307); // 205083 - 203776
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 203776);
    assert.equal(result.usage.completion_tokens, 1100);
    assert.equal(result.usage.total_tokens, 206183);
});

test('preserves Responses reasoning when converting to Claude and Gemini', () => {
    const response = createTextResponse();

    const claude = converter.toClaudeResponse(response, MODEL);
    assert.deepEqual(claude.content[0], { type: 'thinking', thinking: 'Check the request' });
    assert.deepEqual(claude.content[1], { type: 'text', text: 'Hello from the test.' });

    const gemini = converter.toGeminiResponse(response, MODEL);
    assert.deepEqual(gemini.candidates[0].content.parts[0], { thought: true, text: 'Check the request' });
    assert.deepEqual(gemini.candidates[0].content.parts[1], { text: 'Hello from the test.' });
});

test('maps Grok cache usage to Anthropic unary and streaming usage fields', () => {
    const response = createTextResponse();
    response.usage = {
        prompt_text_tokens: 113977,
        completion_tokens: 2176,
        cached_prompt_text_tokens: 91520
    };

    const unary = converter.toClaudeResponse(response, MODEL);
    assert.equal(unary.usage.input_tokens, 22457);
    assert.equal(unary.usage.output_tokens, 2176);
    assert.equal(unary.usage.cache_creation_input_tokens, 0);
    assert.equal(unary.usage.cache_read_input_tokens, 91520);
    assert.deepEqual(Object.keys(unary.usage).sort(), [
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'input_tokens',
        'output_tokens'
    ]);

    const start = converter.toClaudeStreamChunk({
        type: 'response.created',
        response
    }, MODEL);
    assert.equal(start.type, 'message_start');
    assert.equal(start.message.usage.input_tokens, 22457);
    assert.equal(start.message.usage.output_tokens, 0);
    assert.equal(start.message.usage.cache_creation_input_tokens, 0);
    assert.equal(start.message.usage.cache_read_input_tokens, 91520);

    const stream = converter.toClaudeStreamChunk({
        type: 'response.completed',
        response
    }, MODEL);
    assert.equal(stream[0].type, 'message_delta');
    assert.equal(stream[0].usage.input_tokens, 22457);
    assert.equal(stream[0].usage.output_tokens, 2176);
    assert.equal(stream[0].usage.cache_creation_input_tokens, 0);
    assert.equal(stream[0].usage.cache_read_input_tokens, 91520);
    assert.equal(stream[1].type, 'message_stop');
});

test('preserves reasoning state across chat compatibility conversion', () => {
    const response = createTextResponse();
    response.output[0] = {
        id: 'reasoning_state',
        type: 'reasoning',
        encrypted_content: 'synthetic-state',
        summary: [{ type: 'summary_text', text: 'Continue the plan' }]
    };

    const chat = converter.toOpenAIResponse(response, MODEL);
    const assistantMessage = chat.choices[0].message;
    const request = openaiConverter.toOpenAIResponsesRequest({
        model: MODEL,
        messages: [
            assistantMessage,
            { role: 'user', content: 'continue' }
        ]
    });

    assert.equal(assistantMessage.reasoning_details[0].encrypted_content, 'synthetic-state');
    assert.equal(request.input[0].type, 'reasoning');
    assert.equal(request.input[0].encrypted_content, 'synthetic-state');
    assert.equal(request.input[1].role, 'assistant');
    assert.equal(request.input[2].role, 'user');
});

test('preserves upstream Responses error status in unary path', async () => {
    const res = createMockResponse();
    const upstreamError = new Error('Request failed with status code 400');
    upstreamError.response = {
        status: 400,
        data: {
            error: {
                type: 'invalid_request_error',
                code: 'invalid_prompt',
                message: 'Unsupported parameter'
            }
        }
    };
    const service = {
        async generateContent() {
            throw upstreamError;
        }
    };

    await handleUnaryRequest(
        res,
        service,
        MODEL,
        { model: MODEL, input: 'ping' },
        MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        'none',
        '',
        null,
        'responses-test'
    );

    assert.equal(res.statusCode, 400);
    const payload = JSON.parse(res.body);
    assert.equal(payload.error.type, 'invalid_request_error');
    assert.equal(payload.error.code, 'invalid_prompt');
});

test('forwards only Codex protocol headers to the upstream Responses API', () => {
    const service = new OpenAIResponsesApiService({
        OPENAI_API_KEY: 'upstream-token',
        OPENAI_ORGANIZATION: 'org_test',
        OPENAI_PROJECT: 'project_test'
    });
    service.setRequestContext({
        headers: {
            authorization: 'Bearer downstream-token',
            cookie: 'session=secret',
            'x-accounthub-userid': 'user-1',
            originator: 'Codex Desktop',
            'x-client-request-id': 'client-request',
            'session-id': 'session-new',
            'thread-id': 'thread-new',
            'x-codex-turn-state': 'turn-state',
            'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
            'x-codex-beta-features': 'feature-a',
            'x-codex-installation-id': 'installation-1',
            'x-openai-subagent': 'collab_spawn',
            'x-responsesapi-include-timing-metrics': 'true'
        }
    });

    const headers = service.buildHeaders(null, true);

    assert.equal(headers.Authorization, 'Bearer upstream-token');
    assert.equal(headers.Accept, 'text/event-stream');
    assert.equal(headers['OpenAI-Organization'], 'org_test');
    assert.equal(headers['OpenAI-Project'], 'project_test');
    assert.equal(headers.originator, 'Codex Desktop');
    assert.equal(headers['x-client-request-id'], 'client-request');
    assert.equal(headers['session-id'], 'session-new');
    assert.equal(headers['thread-id'], 'thread-new');
    assert.equal(headers['x-codex-turn-state'], 'turn-state');
    assert.equal(headers['x-codex-turn-metadata'], '{"turn_id":"turn-1"}');
    assert.equal(headers['x-codex-beta-features'], 'feature-a');
    assert.equal(headers['x-codex-installation-id'], 'installation-1');
    assert.equal(headers['x-openai-subagent'], 'collab_spawn');
    assert.equal(headers['x-responsesapi-include-timing-metrics'], 'true');
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['x-accounthub-userid'], undefined);
    assert.equal(headers.session_id, undefined);
});

test('maps legacy Codex session headers to current names', () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    service.setRequestContext({
        headers: {
            session_id: 'legacy-session',
            thread_id: 'legacy-thread'
        }
    });

    const headers = service.buildHeaders();

    assert.equal(headers['session-id'], 'legacy-session');
    assert.equal(headers['thread-id'], 'legacy-thread');
    assert.equal(headers.session_id, undefined);
    assert.equal(headers.thread_id, undefined);
});

test('keeps request contexts isolated across concurrent Responses calls', async () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    const capturedHeaders = [];
    service.axiosInstance = {
        post: async (_endpoint, _body, config) => {
            capturedHeaders.push(config.headers);
            await new Promise(resolve => setTimeout(resolve, config.headers['thread-id'] === 'thread-a' ? 10 : 0));
            return { data: { id: config.headers['thread-id'] }, headers: {} };
        }
    };

    const [first, second] = await Promise.all([
        service.generateContent(MODEL, { input: 'a' }, { headers: { 'thread-id': 'thread-a' } }),
        service.generateContent(MODEL, { input: 'b' }, { headers: { 'thread-id': 'thread-b' } })
    ]);

    assert.equal(first.id, 'thread-a');
    assert.equal(second.id, 'thread-b');
    assert.deepEqual(capturedHeaders.map(headers => headers['thread-id']).sort(), ['thread-a', 'thread-b']);
});

test('exposes upstream turn state on the first Responses stream event', async () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    service.axiosInstance = {
        post: async () => ({
            headers: {
                'x-codex-turn-state': 'sticky-state',
                'x-codex-primary-used-percent': '37.5',
                'x-models-etag': 'models-v2',
                'x-reasoning-included': 'true',
                'set-cookie': 'secret=true'
            },
            data: Readable.from([
                'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
                'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[]}}\n\n'
            ])
        })
    };

    const events = [];
    for await (const event of service.generateContentStream(MODEL, { input: 'ping' })) {
        events.push(event);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].__upstreamHeaders['x-codex-turn-state'], 'sticky-state');
    assert.equal(JSON.stringify(events[0]).includes('__upstreamHeaders'), false);
});

test('forwards upstream turn state and requires response.completed', async () => {
    const res = createMockResponse();
    const service = {
        async *generateContentStream() {
            const created = { type: 'response.created', response: { id: 'resp-1' } };
            Object.defineProperty(created, '__upstreamHeaders', {
                value: {
                    'x-codex-turn-state': 'sticky-state',
                    'x-codex-primary-used-percent': '37.5',
                    'x-models-etag': 'models-v2',
                    'x-reasoning-included': 'true',
                    'set-cookie': 'secret=true'
                },
                enumerable: false,
                configurable: true
            });
            yield created;
            yield {
                type: 'response.completed',
                response: { id: 'resp-1', status: 'completed', output: [] }
            };
        }
    };

    const result = await handleStreamRequest(
        res,
        service,
        MODEL,
        { model: MODEL, input: 'ping' },
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        'none',
        '',
        null,
        'responses-test'
    );

    assert.equal(result.success, true);
    assert.equal(res.headers['x-codex-turn-state'], 'sticky-state');
    assert.equal(res.headers['x-codex-primary-used-percent'], '37.5');
    assert.equal(res.headers['x-models-etag'], 'models-v2');
    assert.equal(res.headers['x-reasoning-included'], 'true');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.match(res.body, /response\.completed/);
    assert.doesNotMatch(res.body, /\[DONE\]/);
});

test('marks a Responses stream without response.completed as failed', async () => {
    const res = createMockResponse();
    const service = {
        async *generateContentStream() {
            yield { type: 'response.created', response: { id: 'resp-1' } };
        }
    };

    const result = await handleStreamRequest(
        res,
        service,
        MODEL,
        { model: MODEL, input: 'ping' },
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        'none',
        '',
        null,
        'responses-test'
    );

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'ERR_RESPONSES_STREAM_INCOMPLETE');
    assert.match(res.body, /response\.failed/);
    assert.doesNotMatch(res.body, /\[DONE\]/);
});

test('does not retry after a tool event has already been sent', async () => {
    const res = createMockResponse();
    let attempts = 0;
    const service = {
        async *generateContentStream() {
            attempts++;
            yield {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    id: 'call-1',
                    type: 'function_call',
                    call_id: 'call-1',
                    name: 'lookup',
                    arguments: ''
                }
            };
            const error = new Error('socket reset');
            error.code = 'ECONNRESET';
            throw error;
        }
    };

    const result = await handleStreamRequest(
        res,
        service,
        MODEL,
        { model: MODEL, input: 'ping' },
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        'none',
        '',
        null,
        'responses-test',
        {
            CONFIG: {
                NETWORK_TOLERANCE_RETRIES: 2,
                NETWORK_TOLERANCE_DELAY_MS: 0
            },
            currentRetry: 0,
            networkRetryCount: 0
        }
    );

    assert.equal(attempts, 1);
    assert.equal(result.success, false);
    assert.match(res.body, /function_call/);
});

test('rejects an upstream Responses stream that ends without completion', async () => {
    const service = new OpenAIResponsesApiService({
        OPENAI_API_KEY: 'upstream-token',
        REQUEST_MAX_RETRIES: 0
    });
    service.axiosInstance = {
        post: async () => ({
            headers: {},
            data: Readable.from([
                'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n'
            ])
        })
    };

    await assert.rejects(async () => {
        for await (const _event of service.generateContentStream(MODEL, { input: 'ping' })) {
            // Consume the stream to force terminal validation.
        }
    }, error => error?.code === 'ERR_RESPONSES_STREAM_INCOMPLETE');
});

test('forwards compact response turn state without serializing internal metadata', async () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    let capturedHeaders;
    service.axiosInstance = {
        post: async (_endpoint, _body, config) => {
            capturedHeaders = config.headers;
            return {
                headers: { 'x-codex-turn-state': 'compact-state' },
                data: {
                    response: {
                        output: [{ type: 'message', role: 'assistant', content: [] }]
                    }
                }
            };
        }
    };

    const result = await service.generateContent(MODEL, {
        input: 'compact',
        __remote_compact: true
    }, {
        headers: {
            'session-id': 'compact-session',
            'thread-id': 'compact-thread',
            'x-codex-turn-state': 'prior-state'
        }
    });

    assert.equal(capturedHeaders['session-id'], 'compact-session');
    assert.equal(capturedHeaders['thread-id'], 'compact-thread');
    assert.equal(capturedHeaders['x-codex-turn-state'], 'prior-state');
    assert.equal(result.__upstreamHeaders['x-codex-turn-state'], 'compact-state');
    assert.equal(JSON.stringify(result).includes('__upstreamHeaders'), false);
});

test('preserves only explicit prompt cache keys', () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    const stateless = service.prepareRequestBody({
        model: MODEL,
        input: [{ role: 'user', content: 'ping' }]
    }, false);
    const cached = service.prepareRequestBody({
        model: MODEL,
        prompt_cache_key: 'explicit-cache',
        input: [{ role: 'user', content: 'ping' }]
    }, false);

    assert.equal(stateless.cacheId, null);
    assert.equal('prompt_cache_key' in stateless.requestBody, false);
    assert.equal(cached.cacheId, 'explicit-cache');
    assert.equal(cached.requestBody.prompt_cache_key, 'explicit-cache');
});

test('removes internal compact markers from upstream request bodies', () => {
    const service = new OpenAIResponsesApiService({ OPENAI_API_KEY: 'upstream-token' });
    const prepared = service.prepareRequestBody({
        model: MODEL,
        input: 'summarize',
        __remote_compact: true
    }, false, { isCompact: true });

    assert.equal('__remote_compact' in prepared.requestBody, false);
    assert.equal('stream' in prepared.requestBody, false);
});
