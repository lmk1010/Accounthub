import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRouteApiService } from '../src/routes/route-service.js';

test('awaits the API service before routing model list requests', async () => {
    const modelList = {
        object: 'list',
        data: [
            { id: 'grok-4.5', object: 'model' },
            { id: 'grok-imagine-image', object: 'model' },
            { id: 'grok-imagine-video-1.5', object: 'model' }
        ]
    };
    const apiService = Promise.resolve({
        async listModels() {
            return modelList;
        }
    });
    const service = await resolveRouteApiService({
        apiService,
        config: {
            MODEL_PROVIDER: 'openai-xai-oauth',
            uuid: 'xai-model-list-route-test'
        }
    }, () => {
        throw new Error('injected API service should be used');
    });

    assert.deepEqual(await service.listModels(), modelList);
});

test('awaits an API service created from the route config', async () => {
    const config = { MODEL_PROVIDER: 'openai-xai-oauth' };
    const service = await resolveRouteApiService({ config }, async (receivedConfig) => {
        assert.equal(receivedConfig, config);
        return { provider: receivedConfig.MODEL_PROVIDER };
    });

    assert.deepEqual(service, { provider: 'openai-xai-oauth' });
});
