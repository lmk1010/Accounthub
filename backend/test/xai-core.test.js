import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
    XaiApiService,
    XAI_DEFAULT_API_BASE_URL,
    XAI_DEFAULT_CHAT_BASE_URL,
    normalizeXaiRequestBody,
    normalizeXaiResponseEvent,
    validateXaiOAuthEndpoint
} from '../src/providers/openai/xai-core.js';

function createJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${claims}.signature`;
}

test('does not rotate Grok credentials for 422 request validation errors', async () => {
    const service = new XaiApiService({});
    const error = new Error('Request failed with status code 422');
    error.response = {
        status: 422,
        data: Readable.from([
            JSON.stringify({
                error: 'Failed to deserialize the JSON body into the target type'
            })
        ])
    };

    const decorated = await service._decorateRequestError(error);

    assert.equal(decorated.status, 422);
    assert.equal(decorated.skipErrorCount, true);
    assert.equal(decorated.shouldSwitchCredential, false);
    assert.equal(decorated.message, 'Failed to deserialize the JSON body into the target type');
    assert.equal(decorated.upstreamMessage, 'Failed to deserialize the JSON body into the target type');
    assert.deepEqual(decorated.response.data, {
        error: 'Failed to deserialize the JSON body into the target type'
    });
    service.dispose();
});

test('accepts only HTTPS OAuth endpoints on x.ai hosts', () => {
    assert.equal(
        validateXaiOAuthEndpoint('https://auth.x.ai/oauth/token', 'token_endpoint'),
        'https://auth.x.ai/oauth/token'
    );
    assert.equal(
        validateXaiOAuthEndpoint('https://login.auth.x.ai/device', 'device_authorization_endpoint'),
        'https://login.auth.x.ai/device'
    );
    assert.throws(
        () => validateXaiOAuthEndpoint('http://auth.x.ai/oauth/token'),
        /must use HTTPS/
    );
    assert.throws(
        () => validateXaiOAuthEndpoint('https://x.ai.example.com/oauth/token'),
        /host must be x\.ai/
    );
});

test('resolves OAuth and official API base URLs', () => {
    const oauthService = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            refresh_token: 'oauth-refresh',
            auth_kind: 'oauth',
            using_api: false,
            base_url: XAI_DEFAULT_API_BASE_URL
        }
    });
    oauthService._applyCredentials(oauthService.config.XAI_CREDENTIALS);
    assert.equal(oauthService._usingOfficialApi(), false);
    assert.equal(oauthService._officialBaseUrl(), XAI_DEFAULT_API_BASE_URL);
    assert.equal(oauthService._chatBaseUrl(), XAI_DEFAULT_CHAT_BASE_URL);
    oauthService.dispose();

    const apiService = new XaiApiService({
        XAI_CREDENTIALS: {
            api_key: 'xai-api-key',
            auth_kind: 'api_key',
            using_api: true,
            base_url: 'https://relay.example.com/v1/'
        }
    });
    apiService._applyCredentials(apiService.config.XAI_CREDENTIALS);
    assert.equal(apiService._usingOfficialApi(), true);
    assert.equal(apiService._officialBaseUrl(), 'https://relay.example.com/v1');
    assert.equal(apiService._chatBaseUrl(), 'https://relay.example.com/v1');
    apiService.dispose();
});

test('routes API-capable OAuth tokens through the official API', () => {
    const service = new XaiApiService({
        XAI_CHAT_BASE_URL: XAI_DEFAULT_API_BASE_URL,
        XAI_CREDENTIALS: {
            access_token: createJwt({
                sub: 'api-oauth-user',
                scope: 'openid grok-cli:access api:access'
            }),
            auth_kind: 'oauth',
            using_api: false,
            chat_base_url: XAI_DEFAULT_CHAT_BASE_URL
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);

    assert.equal(service._isApiKeyAuth(), false);
    assert.equal(service._usingOfficialApi(), true);
    assert.equal(service._chatBaseUrl(), XAI_DEFAULT_API_BASE_URL);
    const headers = service._buildHeaders(true, {}, null, false);
    assert.equal(headers.Authorization.startsWith('Bearer '), true);
    assert.equal(headers['X-XAI-Token-Auth'], undefined);
    assert.equal(headers['x-authenticateresponse'], undefined);
    service.dispose();
});

test('allows the UI route selector to force official API or Grok Build', () => {
    const credentials = {
        access_token: createJwt({
            sub: 'api-oauth-user',
            scope: 'openid grok-cli:access api:access'
        }),
        auth_kind: 'oauth'
    };
    const officialService = new XaiApiService({
        XAI_USING_API: 'true',
        XAI_CREDENTIALS: credentials
    });
    officialService._applyCredentials(credentials);
    assert.equal(officialService._usingOfficialApi(), true);
    assert.equal(officialService._chatBaseUrl(), XAI_DEFAULT_API_BASE_URL);
    officialService.dispose();

    const buildService = new XaiApiService({
        XAI_USING_API: 'false',
        XAI_CREDENTIALS: credentials
    });
    buildService._applyCredentials(credentials);
    assert.equal(buildService._usingOfficialApi(), false);
    assert.equal(buildService._chatBaseUrl(), XAI_DEFAULT_CHAT_BASE_URL);
    buildService.dispose();
});

test('channel-level route preference forces Build even when token has api:access', () => {
    const credentials = {
        access_token: createJwt({
            sub: 'api-oauth-user',
            scope: 'openid grok-cli:access api:access'
        }),
        auth_kind: 'oauth'
    };
    const service = new XaiApiService({
        // empty account-level selector → fall through to channel
        XAI_USING_API: '',
        __XAI_CHANNEL_USING_API: 'false',
        XAI_CREDENTIALS: credentials
    });
    service._applyCredentials(credentials);
    assert.equal(service._usingOfficialApi(), false);
    assert.equal(service._chatBaseUrl(), XAI_DEFAULT_CHAT_BASE_URL);
    service.dispose();
});

test('account-level route preference overrides channel preference', () => {
    const credentials = {
        access_token: createJwt({
            sub: 'api-oauth-user',
            scope: 'openid grok-cli:access api:access'
        }),
        auth_kind: 'oauth'
    };
    const service = new XaiApiService({
        XAI_USING_API: 'false',
        __XAI_CHANNEL_USING_API: 'true',
        XAI_CREDENTIALS: credentials
    });
    service._applyCredentials(credentials);
    assert.equal(service._usingOfficialApi(), false);
    assert.equal(service._chatBaseUrl(), XAI_DEFAULT_CHAT_BASE_URL);
    service.dispose();
});

test('strips AccountHub metadata before sending official OAuth requests', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: createJwt({
                sub: 'api-oauth-user',
                scope: 'openid grok-cli:access api:access'
            }),
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;

    let capturedBody = null;
    service.chatAxios = {
        post: async (_path, body) => {
            capturedBody = body;
            return {
                headers: {},
                data: Readable.from([
                    `data: ${JSON.stringify({
                        type: 'response.completed',
                        response: {
                            id: 'resp-official-oauth',
                            status: 'completed',
                            model: 'grok-4.5',
                            output: [],
                            usage: {
                                input_tokens: 4,
                                output_tokens: 1,
                                total_tokens: 5
                            }
                        }
                    })}\n\n`,
                    'data: [DONE]\n\n'
                ])
            };
        }
    };

    await service.generateContent('grok-4.5', {
        metadata: {
            traceId: 'trace-external-request',
            user_id: 'external-user'
        },
        input: [{ type: 'message', role: 'user', content: 'hello' }]
    });

    assert.equal('metadata' in capturedBody, false);
    service.dispose();
});

test('initializes Grok OAuth with an access token only', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'opaque-grok-access-token',
            auth_kind: 'oauth',
            using_api: false
        }
    });

    await service.initialize();

    assert.equal(service.accessToken, 'opaque-grok-access-token');
    assert.equal(service.refreshTokenValue, '');
    assert.equal(service.isInitialized, true);
    service.dispose();
});

test('does not fall back from Grok Build OIDC to the official API on proxy denial', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'opaque-grok-access-token',
            auth_kind: 'oauth',
            using_api: false,
            chat_base_url: XAI_DEFAULT_CHAT_BASE_URL
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;

    let rebuilt = false;
    service.chatAxios = {
        post: async () => {
            const error = new Error('Request failed with status code 403');
            error.response = {
                status: 403,
                data: { error: 'Access denied' }
            };
            throw error;
        }
    };
    service._buildClients = () => {
        rebuilt = true;
    };

    await assert.rejects(
        service.generateContent('grok-4.5', {
            input: [{ type: 'message', role: 'user', content: 'hello' }]
        }),
        /Access denied/
    );

    assert.equal(rebuilt, false);
    service.dispose();
});

test('removes unsupported request fields and preserves supported reasoning effort', () => {
    const result = normalizeXaiRequestBody({
        model: 'grok-4.5',
        previous_response_id: 'resp-old',
        prompt_cache_retention: '24h',
        safety_identifier: 'user-1',
        stream_options: { include_usage: true },
        metadata: { traceId: 'trace-test' },
        reasoning: { effort: 'high', summary: 'auto' },
        input: [{ type: 'message', role: 'user', content: 'hello' }]
    }, 'grok-4.5', true);

    assert.equal(result.stream, true);
    assert.equal(result.reasoning.effort, 'high');
    assert.equal(result.reasoning.summary, 'auto');
    assert.equal('previous_response_id' in result, false);
    assert.equal('prompt_cache_retention' in result, false);
    assert.equal('safety_identifier' in result, false);
    assert.equal('stream_options' in result, false);
    assert.equal('metadata' in result, false);
});

test('normalizes Grok Chat usage into Responses usage without dropping raw fields', () => {
    const event = normalizeXaiResponseEvent({
        type: 'response.completed',
        response: {
            usage: {
                prompt_tokens: 1800,
                completion_tokens: 24,
                prompt_tokens_details: {
                    cached_tokens: 1400
                }
            }
        }
    });

    assert.equal(event.response.usage.prompt_tokens, 1800);
    assert.equal(event.response.usage.prompt_tokens_details.cached_tokens, 1400);
    assert.equal(event.response.usage.input_tokens, 1800);
    assert.equal(event.response.usage.output_tokens, 24);
    assert.equal(event.response.usage.total_tokens, 1824);
    assert.equal(event.response.usage.input_tokens_details.cached_tokens, 1400);
});

test('injects a stable Grok cache key and exposes raw upstream usage to diagnostics', async () => {
    const observedUsage = [];
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false
        },
        XAI_USAGE_OBSERVER: (usage, eventType) => {
            observedUsage.push({ usage, eventType });
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;

    let capturedRequest = null;
    service.chatAxios = {
        post: async (path, body, config) => {
            capturedRequest = { path, body, headers: config.headers };
            return {
                headers: {},
                data: Readable.from([
                    `data: ${JSON.stringify({
                        type: 'response.completed',
                        response: {
                            id: 'resp-cache',
                            status: 'completed',
                            model: 'grok-4.5',
                            output: [],
                            usage: {
                                prompt_text_tokens: 1700,
                                completion_tokens: 16,
                                cached_prompt_text_tokens: 1280
                            }
                        }
                    })}\n\n`,
                    'data: [DONE]\n\n'
                ])
            };
        }
    };

    const response = await service.generateContent('grok-4.5', {
        input: [{ type: 'message', role: 'user', content: 'cache me' }]
    }, {
        headers: {
            'x-stainless-session-id': 'session-cache-123'
        }
    });

    assert.equal(capturedRequest.path, '/responses');
    assert.equal(capturedRequest.body.prompt_cache_key, 'session-cache-123');
    assert.equal(capturedRequest.headers['x-grok-conv-id'], 'session-cache-123');
    assert.equal(observedUsage[0].eventType, 'response.completed');
    assert.equal(observedUsage[0].usage.cached_prompt_text_tokens, 1280);
    assert.equal('input_tokens_details' in observedUsage[0].usage, false);
    assert.equal(response.usage.input_tokens_details.cached_tokens, 1280);
    service.dispose();
});

test('prefers explicit Grok cache keys over conversation and header identifiers', () => {
    const service = new XaiApiService({});

    assert.equal(service._resolveSessionId({
        prompt_cache_key: 'explicit-cache',
        conversation_id: 'conversation-cache'
    }, {
        sessionId: 'context-cache',
        headers: {
            'x-session-id': 'header-cache'
        }
    }), 'explicit-cache');

    service.dispose();
});

test('preserves metadata for the official xAI API when explicitly enabled', () => {
    const result = normalizeXaiRequestBody({
        metadata: { traceId: 'trace-test' }
    }, 'grok-4.5', false, { stripMetadata: false });

    assert.deepEqual(result.metadata, { traceId: 'trace-test' });
});

test('strips reasoning effort for models without thinking levels', () => {
    const result = normalizeXaiRequestBody({
        reasoning: { effort: 'high', summary: 'auto' }
    }, 'grok-composer-2.5-fast', false);

    assert.deepEqual(result.reasoning, { summary: 'auto' });
    assert.equal(result.stream, false);
});

test('normalizes namespaces, nested function tools, and tool choice', () => {
    const result = normalizeXaiRequestBody({
        tools: [
            { type: 'tool_search' },
            { type: 'image_generation' },
            { type: 'custom', name: 'apply_patch' },
            {
                type: 'function',
                function: {
                    name: 'lookup',
                    description: 'Look up an item',
                    parameters: { type: 'object', properties: { id: { type: 'string' } } }
                }
            },
            {
                type: 'namespace',
                name: 'codex_app',
                tools: [{
                    type: 'function',
                    name: 'automation_update',
                    strict: true,
                    parameters: { oneOf: [{ $ref: '#/$defs/job' }] }
                }]
            },
            { type: 'web_search', external_web_access: true }
        ],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
        parallel_tool_calls: true
    }, 'grok-4.5', true);

    assert.deepEqual(result.tools.map(tool => tool.type), [
        'function',
        'function',
        'web_search'
    ]);
    assert.equal(result.tools[0].name, 'lookup');
    assert.equal('function' in result.tools[0], false);
    assert.deepEqual(result.tools[1].parameters, {
        type: 'object',
        properties: {},
        additionalProperties: true
    });
    assert.equal(result.tools[1].strict, false);
    assert.equal('external_web_access' in result.tools[2], false);
    assert.deepEqual(result.tool_choice, { type: 'function', name: 'lookup' });
});

test('cleans compact requests and invalid reasoning state', () => {
    const result = normalizeXaiRequestBody({
        stream: true,
        tools: [{ type: 'function', name: 'lookup' }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        input: [
            { type: 'reasoning', content: null, encrypted_content: null },
            { type: 'compaction', encrypted_content: null },
            { type: 'compaction_trigger' },
            { type: 'message', role: 'user', content: 'continue' }
        ]
    }, 'grok-4.5', false, { isCompact: true });

    assert.equal('stream' in result, false);
    assert.equal('tools' in result, false);
    assert.equal('tool_choice' in result, false);
    assert.equal('parallel_tool_calls' in result, false);
    assert.deepEqual(result.input, [
        { type: 'reasoning' },
        { type: 'message', role: 'user', content: 'continue' }
    ]);
});

test('queries Grok billing with OAuth headers', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false,
            email: 'grok@example.com',
            sub: 'grok-user'
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    const requests = [];
    service.billingAxios = {
        get: async (path, config) => {
            requests.push({ path, config });
            if (path === '/v1/settings') {
                return {
                    data: {
                        subscription_tier_display: 'SuperGrok'
                    }
                };
            }
            return {
                data: {
                    config: {
                        creditUsagePercent: 25
                    }
                }
            };
        }
    };

    const result = await service.getUsageLimits();

    assert.deepEqual(requests.map(request => request.path), [
        '/v1/billing?format=credits',
        '/v1/settings'
    ]);
    const requestConfig = requests[0].config;
    assert.equal(requestConfig.headers.Authorization, 'Bearer oauth-access');
    assert.equal(requestConfig.headers.Accept, 'application/json');
    assert.equal(requestConfig.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(requestConfig.headers['x-grok-client-version'], '0.2.101');
    assert.equal(requestConfig.headers['x-grok-client-identifier'], 'grok-shell');
    assert.equal(requestConfig.headers['x-grok-client-mode'], 'headless');
    assert.equal(requestConfig.headers['x-authenticateresponse'], 'authenticate-response');
    assert.equal(requestConfig.headers['x-userid'], 'grok-user');
    assert.equal(requestConfig.headers['x-email'], 'grok@example.com');
    assert.equal(result.subscriptionTierDisplay, 'SuperGrok');
    assert.equal(result.account.email, 'grok@example.com');
    service.dispose();
});

test('verifies official OAuth API access without querying Grok Build billing', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: createJwt({
                sub: 'api-oauth-user',
                scope: 'openid grok-cli:access api:access'
            }),
            auth_kind: 'oauth',
            using_api: false,
            email: 'api-oauth@example.com'
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    let billingCalled = false;
    service.billingAxios = { get: async () => { billingCalled = true; } };
    service.apiAxios = {
        get: async (path, config) => {
            assert.equal(path, '/models');
            assert.equal(config.headers.Authorization.startsWith('Bearer '), true);
            return {
                data: {
                    object: 'list',
                    data: [{ id: 'grok-4.5', object: 'model' }]
                }
            };
        }
    };

    const result = await service.getUsageLimits();

    assert.equal(billingCalled, false);
    assert.equal(result.quotaUnavailable, true);
    assert.equal(result.apiAccessVerified, true);
    assert.equal(result.subscriptionTierDisplay, 'Grok OAuth');
    assert.equal(result.availableModels.includes('grok-4.5'), true);
    assert.equal(result.account.email, 'api-oauth@example.com');
    service.dispose();
});

test('reads the Grok subscription tier from the OAuth JWT', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: createJwt({
                sub: 'supergrok-user',
                scope: 'openid api:access',
                tier: 1
            }),
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    service.apiAxios = {
        get: async () => ({
            data: {
                object: 'list',
                data: [{ id: 'grok-4.5', object: 'model' }]
            }
        })
    };

    const result = await service.getUsageLimits();

    assert.equal(result.subscriptionTierDisplay, 'SuperGrok');
    service.dispose();
});

test('preserves CPA Grok client headers for chat and billing requests', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false,
            headers: {
                'x-grok-client-identifier': 'grok-shell',
                'x-authenticateresponse': 'authenticate-response',
                'User-Agent': 'grok-shell/0.2.93 (linux; x86_64)'
            }
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);

    const headers = service._buildGrokCliHeaders({ Accept: 'application/json' });

    assert.equal(headers.Authorization, 'Bearer oauth-access');
    assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
    assert.equal(headers['x-grok-client-mode'], 'headless');
    assert.equal(headers['x-authenticateresponse'], 'authenticate-response');
    assert.equal(headers['User-Agent'], 'grok-shell/0.2.93 (linux; x86_64)');
    service.dispose();
});

test('fetches the account-visible Grok model list with OAuth headers', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    let capturedRequest = null;
    service.chatAxios = {
        get: async (path, config) => {
            capturedRequest = { path, config };
            return {
                data: {
                    object: 'list',
                    data: [
                        { id: 'grok-4.5', object: 'model' },
                        { id: 'grok-composer-2.5-fast', object: 'model' },
                        { id: 'grok-4.5', object: 'model' }
                    ]
                }
            };
        }
    };

    const result = await service.listAvailableModels();

    assert.equal(capturedRequest.path, '/models');
    assert.equal(capturedRequest.config.headers.Authorization, 'Bearer oauth-access');
    assert.equal(capturedRequest.config.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.deepEqual(result.data.map(model => model.id), [
        'grok-4.5',
        'grok-composer-2.5-fast',
        'grok-imagine-image',
        'grok-imagine-image-quality',
        'grok-imagine-video',
        'grok-imagine-video-1.5',
        'grok-imagine-video-1.5-preview'
    ]);
    service.dispose();
});

test('uses Grok CLI OAuth headers for image requests', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false,
            headers: {
                'x-grok-client-identifier': 'grok-shell',
                'x-authenticateresponse': 'authenticate-response'
            }
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    let capturedRequest = null;
    service.chatAxios = {
        post: async (path, body, config) => {
            capturedRequest = { path, body, config };
            return { data: { created: 1, data: [{ url: 'https://example.com/image.png' }] } };
        }
    };

    await service.generateImage('grok-imagine-image-quality', {
        prompt: 'a test image',
        __image_action: 'generate'
    });

    assert.equal(capturedRequest.path, '/images/generations');
    assert.equal(capturedRequest.body.model, 'grok-imagine-image-quality');
    assert.equal(capturedRequest.config.headers.Authorization, 'Bearer oauth-access');
    assert.equal(capturedRequest.config.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(capturedRequest.config.headers['x-grok-client-identifier'], 'grok-shell');
    assert.equal(capturedRequest.config.headers['x-authenticateresponse'], 'authenticate-response');
    service.dispose();
});

test('creates and retrieves Grok video tasks with OAuth headers', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    const requests = [];
    service.chatAxios = {
        post: async (path, body, config) => {
            requests.push({ method: 'POST', path, body, config });
            return { data: { request_id: 'video/request 1', status: 'queued' }, headers: {} };
        },
        get: async (path, config) => {
            requests.push({ method: 'GET', path, config });
            return { data: { request_id: 'video/request 1', status: 'done' }, headers: {} };
        }
    };

    await service.generateVideo('grok-imagine-video', {
        prompt: 'a test video',
        __video_action: 'generate'
    }, {
        headers: { 'x-idempotency-key': 'idem-1' }
    });
    await service.generateVideo('grok-imagine-video', {
        __video_action: 'retrieve',
        __video_request_id: 'video/request 1'
    });

    assert.equal(requests[0].path, '/videos/generations');
    assert.equal(requests[0].body.model, 'grok-imagine-video');
    assert.equal(requests[0].config.headers['x-idempotency-key'], 'idem-1');
    assert.equal(requests[0].config.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(requests[1].path, '/videos/video%2Frequest%201');
    assert.equal(requests[1].config.headers.Authorization, 'Bearer oauth-access');
    service.dispose();
});

test('returns an incomplete Grok response as a valid terminal response', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._requestResponsesStream = async function* () {
        yield {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: []
            }
        };
        yield {
            type: 'response.incomplete',
            response: {
                id: 'response-1',
                status: 'incomplete',
                output: [],
                incomplete_details: {
                    reason: 'max_output_tokens'
                }
            }
        };
    };

    const result = await service.generateContent('grok-4.5', {
        input: 'hi',
        max_output_tokens: 8,
        stream: true
    });

    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.incomplete_details, {
        reason: 'max_output_tokens'
    });
    assert.equal(result.output[0].id, 'reasoning-1');
    service.dispose();
});

test('uses the static Grok model list only when the public model endpoint fails', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            access_token: 'oauth-access',
            auth_kind: 'oauth',
            using_api: false
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;
    service.chatAxios = {
        get: async () => {
            const error = new Error('upstream unavailable');
            error.response = { status: 503, data: { message: 'unavailable' } };
            throw error;
        }
    };

    await assert.rejects(() => service.listAvailableModels(), /upstream unavailable/);
    const fallback = await service.listModels();
    assert.ok(fallback.data.some(model => model.id === 'grok-4.5'));
    service.dispose();
});

test('rejects Grok billing queries for API-key credentials', async () => {
    const service = new XaiApiService({
        XAI_CREDENTIALS: {
            api_key: 'xai-api-key',
            auth_kind: 'api_key',
            using_api: true
        }
    });
    service._applyCredentials(service.config.XAI_CREDENTIALS);
    service.isInitialized = true;

    await assert.rejects(
        () => service.getUsageLimits(),
        error => error.code === 'XAI_BILLING_REQUIRES_OAUTH'
    );
    service.dispose();
});
