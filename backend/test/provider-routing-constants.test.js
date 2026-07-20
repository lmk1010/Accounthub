import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    getProtocolPrefix,
    MODEL_PROTOCOL_PREFIX,
    MODEL_PROVIDER,
    normalizeModelProvider
} from '../src/utils/common.js';

test('keeps persisted Codex and Grok provider types routable', () => {
    assert.equal(MODEL_PROVIDER.OPENAI_CODEX, 'openai-codex');
    assert.equal(MODEL_PROVIDER.OPENAI_XAI, 'openai-xai-oauth');
    assert.equal(normalizeModelProvider('openai-codex'), MODEL_PROVIDER.OPENAI_CODEX);
    assert.equal(normalizeModelProvider('openai-xai-oauth'), MODEL_PROVIDER.OPENAI_XAI);
    assert.equal(
        getProtocolPrefix(MODEL_PROVIDER.OPENAI_CODEX),
        MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
    );
});

test('normalizes the newer Grok provider alias to the persisted type', () => {
    assert.equal(normalizeModelProvider('openai-xai'), MODEL_PROVIDER.OPENAI_XAI);
});
