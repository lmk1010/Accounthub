const DEFAULT_USER_AGENT = 'factory-cli/0.19.3';

function normalizeModelEntry(model) {
    if (!model || typeof model !== 'object') {
        return null;
    }
    const reasoning = typeof model.reasoning === 'string' ? model.reasoning.toLowerCase() : model.reasoning;
    return {
        ...model,
        id: model.id || model.model || null,
        type: model.type || null,
        provider: model.provider || null,
        reasoning
    };
}

function normalizeEndpoints(profile) {
    const endpoints = {};
    if (Array.isArray(profile?.endpoint)) {
        for (const entry of profile.endpoint) {
            if (entry && entry.name && entry.base_url) {
                endpoints[entry.name] = entry.base_url;
            }
        }
    }
    if (profile?.endpoints && typeof profile.endpoints === 'object') {
        for (const [key, value] of Object.entries(profile.endpoints)) {
            if (value) {
                endpoints[key] = value;
            }
        }
    }
    return endpoints;
}

export function resolveDroidProfile(config) {
    const rawProfile = config?.DROID_PROFILE ?? config?.DROID_CONFIG ?? null;
    if (!rawProfile) {
        throw new Error('[Droid] Missing DROID_PROFILE in provider credentials');
    }

    let profile = rawProfile;
    if (typeof rawProfile === 'string') {
        profile = JSON.parse(rawProfile);
    }

    const endpoints = normalizeEndpoints(profile);
    const models = Array.isArray(profile?.models)
        ? profile.models.map(normalizeModelEntry).filter(Boolean)
        : [];

    return {
        ...profile,
        endpoints,
        models,
        model_redirects: profile?.model_redirects ?? profile?.modelRedirects ?? {},
        system_prompt: profile?.system_prompt ?? profile?.systemPrompt ?? '',
        user_agent: profile?.user_agent ?? profile?.userAgent ?? DEFAULT_USER_AGENT,
        proxies: Array.isArray(profile?.proxies) ? profile.proxies : [],
        dev_mode: profile?.dev_mode ?? profile?.devMode ?? false
    };
}

export function getEndpoint(profile, type) {
    const baseUrl = profile?.endpoints?.[type];
    if (!baseUrl) {
        throw new Error(`[Droid] Endpoint not configured for type: ${type}`);
    }
    return baseUrl;
}

export function getSystemPrompt(profile) {
    return profile?.system_prompt || '';
}

export function getUserAgent(profile) {
    return profile?.user_agent || DEFAULT_USER_AGENT;
}

export function getProxyConfigs(profile) {
    if (!profile || !Array.isArray(profile.proxies)) {
        return [];
    }
    return profile.proxies.filter(item => item && typeof item === 'object');
}

export function getRedirectedModelId(profile, modelId) {
    if (!modelId || !profile?.model_redirects) {
        return modelId;
    }
    return profile.model_redirects[modelId] || modelId;
}

export function getModelById(profile, modelId) {
    if (!profile || !Array.isArray(profile.models)) {
        return null;
    }
    return profile.models.find(model => model && model.id === modelId) || null;
}

export function getModelReasoning(profile, modelId) {
    const model = getModelById(profile, modelId);
    if (!model || !model.reasoning) {
        return null;
    }
    const reasoning = String(model.reasoning).toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'auto'].includes(reasoning)) {
        return reasoning;
    }
    return null;
}

export function getModelProvider(profile, modelId) {
    const model = getModelById(profile, modelId);
    return model?.provider || null;
}

export function getModelType(profile, modelId) {
    const model = getModelById(profile, modelId);
    return model?.type || null;
}

export function listModels(profile) {
    const models = Array.isArray(profile?.models) ? profile.models : [];
    return {
        object: 'list',
        data: models.map(model => ({
            id: model.id,
            object: 'model',
            created: Date.now(),
            owned_by: model.type || 'droid',
            permission: [],
            root: model.id,
            parent: null
        }))
    };
}
