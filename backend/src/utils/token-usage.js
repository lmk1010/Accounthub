function toFiniteTokenCount(value) {
    if (value === undefined || value === null || value === '') return null;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function firstTokenCount(...values) {
    for (const value of values) {
        const tokenCount = toFiniteTokenCount(value);
        if (tokenCount !== null) return tokenCount;
    }
    return null;
}

function maxTokenCount(...values) {
    let maximum = null;
    for (const value of values) {
        const tokenCount = toFiniteTokenCount(value);
        if (tokenCount === null) continue;
        maximum = maximum === null ? tokenCount : Math.max(maximum, tokenCount);
    }
    return maximum;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function extractTokenUsage(usage = {}) {
    const payload = isPlainObject(usage) ? usage : {};
    const inputTokens = firstTokenCount(
        payload.input_tokens,
        payload.inputTokens,
        payload.prompt_tokens,
        payload.promptTokens,
        payload.prompt_text_tokens,
        payload.promptTextTokens,
        payload.input_token_count,
        payload.inputTokenCount,
        payload.prompt_token_count,
        payload.promptTokenCount
    ) ?? 0;
    const outputTokens = firstTokenCount(
        payload.output_tokens,
        payload.outputTokens,
        payload.completion_tokens,
        payload.completionTokens,
        payload.output_token_count,
        payload.outputTokenCount,
        payload.completion_token_count,
        payload.completionTokenCount,
        payload.candidatesTokenCount
    ) ?? 0;
    const totalTokens = firstTokenCount(
        payload.total_tokens,
        payload.totalTokens,
        payload.total_token_count,
        payload.totalTokenCount
    ) ?? (inputTokens + outputTokens);
    const anthropicCacheReadTokens = maxTokenCount(
        payload.cache_read_input_tokens,
        payload.cacheReadInputTokens
    );
    const includedCacheReadTokens = maxTokenCount(
        payload.input_tokens_details?.cached_tokens,
        payload.inputTokensDetails?.cachedTokens,
        payload.prompt_tokens_details?.cached_tokens,
        payload.promptTokensDetails?.cachedTokens,
        payload.cached_tokens,
        payload.cachedTokens,
        payload.cached_prompt_tokens,
        payload.cachedPromptTokens,
        payload.cached_prompt_text_tokens,
        payload.cachedPromptTextTokens,
        payload.cachedContentTokenCount
    );
    const cacheReadTokens = maxTokenCount(
        anthropicCacheReadTokens,
        includedCacheReadTokens
    ) ?? 0;
    const anthropicCacheCreationTokens = maxTokenCount(
        payload.cache_creation_input_tokens,
        payload.cacheCreationInputTokens
    );
    const includedCacheCreationTokens = maxTokenCount(
        payload.input_tokens_details?.cache_creation_tokens,
        payload.inputTokensDetails?.cacheCreationTokens,
        payload.prompt_tokens_details?.cache_creation_tokens,
        payload.promptTokensDetails?.cacheCreationTokens
    );
    const cacheCreationTokens = maxTokenCount(
        anthropicCacheCreationTokens,
        includedCacheCreationTokens
    ) ?? 0;
    const uncachedInputTokens = Math.max(
        0,
        inputTokens
            - (anthropicCacheReadTokens === null ? (includedCacheReadTokens ?? 0) : 0)
            - (anthropicCacheCreationTokens === null ? (includedCacheCreationTokens ?? 0) : 0)
    );
    const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheCreationTokens;
    const reasoningTokens = maxTokenCount(
        payload.output_tokens_details?.reasoning_tokens,
        payload.outputTokensDetails?.reasoningTokens,
        payload.completion_tokens_details?.reasoning_tokens,
        payload.completionTokensDetails?.reasoningTokens,
        payload.reasoning_tokens,
        payload.reasoningTokens,
        payload.thoughtsTokenCount
    ) ?? 0;

    return {
        inputTokens,
        uncachedInputTokens,
        totalInputTokens,
        outputTokens,
        totalTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens
    };
}

export function normalizeResponsesUsage(usage) {
    if (!isPlainObject(usage)) return usage;

    const counts = extractTokenUsage(usage);
    const inputDetails = isPlainObject(usage.input_tokens_details)
        ? usage.input_tokens_details
        : (isPlainObject(usage.inputTokensDetails) ? usage.inputTokensDetails : {});
    const outputDetails = isPlainObject(usage.output_tokens_details)
        ? usage.output_tokens_details
        : (isPlainObject(usage.outputTokensDetails) ? usage.outputTokensDetails : {});
    const normalized = {
        ...usage,
        input_tokens: counts.inputTokens,
        output_tokens: counts.outputTokens,
        total_tokens: counts.totalTokens,
        input_tokens_details: {
            ...inputDetails,
            cached_tokens: counts.cacheReadTokens
        },
        output_tokens_details: {
            ...outputDetails,
            reasoning_tokens: counts.reasoningTokens
        }
    };

    if (counts.cacheCreationTokens > 0) {
        normalized.input_tokens_details.cache_creation_tokens = counts.cacheCreationTokens;
    }

    return normalized;
}
