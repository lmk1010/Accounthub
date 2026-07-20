import assert from 'node:assert/strict';
import test from 'node:test';

import {
    extractTokenUsage,
    normalizeResponsesUsage
} from '../src/utils/token-usage.js';

test('extracts cache usage from xAI Responses usage fields', () => {
    const usage = extractTokenUsage({
        input_tokens: 2048,
        output_tokens: 32,
        total_tokens: 2080,
        input_tokens_details: {
            cached_tokens: 1536
        },
        output_tokens_details: {
            reasoning_tokens: 12
        }
    });

    assert.deepEqual(usage, {
        inputTokens: 2048,
        uncachedInputTokens: 512,
        totalInputTokens: 2048,
        outputTokens: 32,
        totalTokens: 2080,
        cacheReadTokens: 1536,
        cacheCreationTokens: 0,
        reasoningTokens: 12
    });
});

test('extracts cache usage from xAI Chat Completions fields without zero masking', () => {
    const usage = extractTokenUsage({
        prompt_tokens: 1800,
        completion_tokens: 20,
        input_tokens_details: {
            cached_tokens: 0
        },
        prompt_tokens_details: {
            cached_tokens: 1400
        }
    });

    assert.equal(usage.inputTokens, 1800);
    assert.equal(usage.uncachedInputTokens, 400);
    assert.equal(usage.totalInputTokens, 1800);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.totalTokens, 1820);
    assert.equal(usage.cacheReadTokens, 1400);
});

test('normalizes camelCase and provider aliases into Responses usage fields', () => {
    const normalized = normalizeResponsesUsage({
        inputTokens: 1200,
        outputTokens: 10,
        cachedTokens: 900,
        cacheCreationInputTokens: 100,
        reasoningTokens: 4
    });

    assert.equal(normalized.input_tokens, 1200);
    assert.equal(normalized.output_tokens, 10);
    assert.equal(normalized.total_tokens, 1210);
    assert.equal(normalized.input_tokens_details.cached_tokens, 900);
    assert.equal(normalized.input_tokens_details.cache_creation_tokens, 100);
    assert.equal(normalized.output_tokens_details.reasoning_tokens, 4);
});

test('extracts Grok CLI cached prompt text tokens', () => {
    const usage = extractTokenUsage({
        prompt_text_tokens: 1600,
        completion_tokens: 18,
        cached_prompt_text_tokens: 1280
    });

    assert.equal(usage.inputTokens, 1600);
    assert.equal(usage.uncachedInputTokens, 320);
    assert.equal(usage.totalInputTokens, 1600);
    assert.equal(usage.outputTokens, 18);
    assert.equal(usage.cacheReadTokens, 1280);
});

test('keeps native Anthropic input tokens separate from cache usage', () => {
    const usage = extractTokenUsage({
        input_tokens: 280,
        output_tokens: 18,
        cache_creation_input_tokens: 120,
        cache_read_input_tokens: 1400
    });

    assert.equal(usage.inputTokens, 280);
    assert.equal(usage.uncachedInputTokens, 280);
    assert.equal(usage.totalInputTokens, 1800);
    assert.equal(usage.cacheCreationTokens, 120);
    assert.equal(usage.cacheReadTokens, 1400);
});

test('subtracts provider cache reads and creations that are included in total input', () => {
    const usage = extractTokenUsage({
        input_tokens: 1800,
        output_tokens: 18,
        input_tokens_details: {
            cached_tokens: 1400,
            cache_creation_tokens: 120
        }
    });

    assert.equal(usage.uncachedInputTokens, 280);
    assert.equal(usage.totalInputTokens, 1800);
    assert.equal(usage.cacheCreationTokens, 120);
    assert.equal(usage.cacheReadTokens, 1400);
});

test('splits the observed Grok total input into uncached and cached tokens', () => {
    const usage = extractTokenUsage({
        prompt_text_tokens: 113977,
        completion_tokens: 2176,
        cached_prompt_text_tokens: 91520
    });

    assert.equal(usage.uncachedInputTokens, 22457);
    assert.equal(usage.totalInputTokens, 113977);
    assert.equal(usage.cacheReadTokens, 91520);
});
