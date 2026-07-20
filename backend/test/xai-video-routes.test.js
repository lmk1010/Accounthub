import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { openaiProxyRouter } from '../src/routes/openai-proxy.routes.js';

function createRequest(path, body) {
    const req = Readable.from([JSON.stringify(body)]);
    req.method = 'POST';
    req.url = path;
    req.headers = {
        host: 'localhost',
        'content-type': 'application/json',
        'x-idempotency-key': 'route-test'
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    return req;
}

function createResponse() {
    return {
        headersSent: false,
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        end(chunk = '') {
            this.body += String(chunk || '');
        }
    };
}

function createContext(service) {
    return {
        apiService: service,
        config: {
            MODEL_PROVIDER: 'openai-xai-oauth',
            PROMPT_LOG_MODE: 'none',
            POOL_ID: 0,
            uuid: 'xai-video-route-test'
        },
        promptLogFilename: '',
        poolManager: null
    };
}

test('routes OpenAI video creation to the xAI video generator', async () => {
    const calls = [];
    const service = {
        async generateVideo(model, body, requestContext) {
            calls.push({ model, body, requestContext });
            return { request_id: 'video-route-create', status: 'pending' };
        }
    };
    const req = createRequest('/v1/videos', {
        model: 'grok-imagine-video-1.5',
        prompt: 'A product rotating on a table',
        seconds: 8,
        size: '1280x720'
    });
    const res = createResponse();

    const handled = await openaiProxyRouter('POST', '/v1/videos', req, res, createContext(service));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'grok-imagine-video-1.5');
    assert.equal(calls[0].body.__video_action, 'generate');
    assert.equal(calls[0].body.duration, 8);
    assert.equal(calls[0].body.aspect_ratio, '16:9');
    assert.equal(calls[0].requestContext.headers['x-idempotency-key'], 'route-test');
    assert.deepEqual(JSON.parse(res.body), {
        id: 'video-route-create',
        object: 'video',
        model: 'grok-imagine-video-1.5',
        prompt: 'A product rotating on a table',
        seconds: '8',
        size: '1280x720',
        created_at: JSON.parse(res.body).created_at,
        status: 'queued',
        progress: 0
    });
});

test('maps OpenAI video remix to xAI retrieve and edit on the same service', async () => {
    const calls = [];
    const service = {
        async generateVideo(model, body) {
            calls.push({ model, body });
            if (body.__video_action === 'retrieve') {
                return {
                    request_id: 'video-remix-source',
                    model: 'grok-imagine-video',
                    status: 'done',
                    video: {
                        url: 'https://example.com/source.mp4',
                        duration: 4
                    }
                };
            }
            return { request_id: 'video-remix-result', status: 'pending' };
        }
    };
    const path = '/v1/videos/video-remix-source/remix';
    const req = createRequest(path, { prompt: 'Add a slower camera pan' });
    const res = createResponse();

    const handled = await openaiProxyRouter('POST', path, req, res, createContext(service));
    const response = JSON.parse(res.body);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.__video_action, 'retrieve');
    assert.equal(calls[1].body.__video_action, 'edit');
    assert.deepEqual(calls[1].body.video, { url: 'https://example.com/source.mp4' });
    assert.equal(response.id, 'video-remix-result');
    assert.equal(response.remixed_from_video_id, 'video-remix-source');
    assert.equal(response.status, 'queued');
});
