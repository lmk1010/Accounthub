import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderPoolManagerDB } from '../src/providers/provider-pool-manager-db.js';
import { concurrencyLimiter } from '../src/services/concurrency-limiter.js';

test('keeps Grok cache sessions on the same provider for the cache window', () => {
    const manager = new ProviderPoolManagerDB();
    const providerType = 'openai-xai-oauth';
    const config = manager._getStickyConfigForProvider(providerType, {}, {});
    const identity = manager._resolveStickyIdentity(providerType, {
        sessionId: 'grok-cache-session'
    }, {}, {});

    assert.equal(manager._supportsStickyIdentity(providerType), true);
    assert.equal(config.enabled, true);
    assert.equal(config.strictBinding, false);
    assert.equal(config.ttlSeconds, 15 * 60);
    assert.equal(config.identityMode, 'session');
    assert.equal(identity.stickyKey, 'session:grok-cache-session');
});

test('uses an explicit Grok prompt cache key as the provider stickiness session', () => {
    const sessionId = concurrencyLimiter.extractSessionId({
        prompt_cache_key: 'grok-explicit-cache-key',
        conversation_id: 'lower-priority-conversation'
    }, {
        headers: {
            'x-session-id': 'lower-priority-header'
        }
    });

    assert.equal(sessionId, 'grok-explicit-cache-key');
});
