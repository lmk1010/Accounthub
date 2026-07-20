import dotenv from 'dotenv';

const envFile = process.env.NODE_ENV === 'production'
    ? '.env.production'
    : (process.env.NODE_ENV === 'development' ? '.env.development' : '.env');
dotenv.config({ path: envFile });

const [
    { closeDatabase, initializeDatabase },
    providerDao,
    { XaiApiService },
    { XAI_PROVIDER_TYPE },
    { formatOAuthCredentialRef },
    { extractTokenUsage }
] = await Promise.all([
    import('../config/database.js'),
    import('../dao/provider-dao.js'),
    import('../providers/openai/xai-core.js'),
    import('../providers/openai/xai-constants.js'),
    import('../utils/oauth-credentials.js'),
    import('../utils/token-usage.js')
]);

function positiveInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function resolveProbeConfig() {
    const apiKey = String(process.env.XAI_API_KEY || '').trim();
    if (apiKey) {
        return {
            config: {
                XAI_CREDENTIALS: {
                    api_key: apiKey,
                    auth_kind: 'api_key',
                    using_api: true,
                    base_url: process.env.XAI_BASE_URL || undefined
                }
            },
            databaseOpened: false,
            credentialSource: 'XAI_API_KEY'
        };
    }

    await initializeDatabase();
    let credentialId = positiveInteger(process.env.XAI_CACHE_PROBE_CREDENTIAL_ID);
    const providerUuid = String(process.env.XAI_CACHE_PROBE_PROVIDER_UUID || '').trim();
    if (!credentialId && providerUuid) {
        const provider = await providerDao.findByUuid(providerUuid);
        if (provider?.provider_type !== XAI_PROVIDER_TYPE) {
            throw new Error(`Provider ${providerUuid} is not ${XAI_PROVIDER_TYPE}`);
        }
        credentialId = positiveInteger(provider.oauth_credential_id);
    }
    if (!credentialId) {
        throw new Error(
            'Set XAI_API_KEY, XAI_CACHE_PROBE_CREDENTIAL_ID, or XAI_CACHE_PROBE_PROVIDER_UUID'
        );
    }

    return {
        config: {
            XAI_OAUTH_CREDS_FILE_PATH: formatOAuthCredentialRef(XAI_PROVIDER_TYPE, credentialId),
            oauthCredentialId: credentialId
        },
        databaseOpened: true,
        credentialSource: `oauth:${credentialId}`
    };
}

function rawUsageShape(usage) {
    return {
        keys: Object.keys(usage || {}).sort(),
        inputDetailKeys: Object.keys(usage?.input_tokens_details || {}).sort(),
        promptDetailKeys: Object.keys(usage?.prompt_tokens_details || {}).sort(),
        cacheCandidates: {
            responses: usage?.input_tokens_details?.cached_tokens ?? null,
            chatCompletions: usage?.prompt_tokens_details?.cached_tokens ?? null,
            grokCli: usage?.cached_prompt_text_tokens ?? usage?.cachedPromptTextTokens ?? null,
            topLevel: usage?.cached_tokens ?? usage?.cachedTokens ?? null,
            claude: usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens ?? null
        }
    };
}

async function main() {
    const resolved = await resolveProbeConfig();
    const rawUsageEvents = [];
    const service = new XaiApiService({
        ...resolved.config,
        XAI_USAGE_OBSERVER: (usage, eventType) => {
            if (eventType === 'response.completed' || eventType === 'response.incomplete') {
                rawUsageEvents.push(usage);
            }
        }
    });
    const model = String(process.env.XAI_CACHE_PROBE_MODEL || 'grok-4.5').trim();
    const cacheKey = String(
        process.env.XAI_CACHE_PROBE_KEY || `accounthub-cache-probe-${Date.now()}`
    ).trim();
    const repeatedPrefix = Array.from(
        { length: 320 },
        (_, index) => `Stable cache probe paragraph ${index}: AccountHub verifies Grok prompt prefix reuse.`
    ).join('\n');
    const request = {
        model,
        prompt_cache_key: cacheKey,
        max_output_tokens: 32,
        input: [{
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_text',
                text: `${repeatedPrefix}\nReply with exactly: cache probe complete`
            }]
        }]
    };

    try {
        const results = [];
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const rawIndex = rawUsageEvents.length;
            const response = await service.generateContent(model, request, {
                sessionId: cacheKey
            });
            const rawUsage = rawUsageEvents[rawIndex] || null;
            results.push({
                attempt,
                normalized: extractTokenUsage(response?.usage),
                raw: rawUsageShape(rawUsage)
            });
            if (attempt === 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        const secondCacheRead = results[1]?.normalized?.cacheReadTokens || 0;
        console.log(JSON.stringify({
            model,
            credentialSource: resolved.credentialSource,
            cacheKey,
            cacheReturnedByGrok: secondCacheRead > 0,
            results
        }, null, 2));
    } finally {
        service.dispose();
        if (resolved.databaseOpened) await closeDatabase();
    }
}

main().catch(async error => {
    console.error(`[xAI Cache Probe] ${error.message}`);
    await closeDatabase().catch(() => {});
    process.exitCode = 1;
});
