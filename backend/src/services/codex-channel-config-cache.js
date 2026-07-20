import * as channelConfigDao from '../dao/channel-config-dao.js';

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_CODEX_CHANNEL_CONFIG = {
    codexHighConcurrencyUserIds: ['30', '81', '1'],
    codexBlacklistedNewApiUserIds: []
};

function normalizeIdentityList(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(/[\s,;，；]+/).map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function mergeCodexChannelConfig(config = {}) {
    return {
        ...DEFAULT_CODEX_CHANNEL_CONFIG,
        ...config,
        codexHighConcurrencyUserIds: Array.from(new Set([
            ...DEFAULT_CODEX_CHANNEL_CONFIG.codexHighConcurrencyUserIds,
            ...normalizeIdentityList(config.codexHighConcurrencyUserIds)
        ])),
        codexBlacklistedNewApiUserIds: Array.from(new Set(
            normalizeIdentityList(config.codexBlacklistedNewApiUserIds)
        ))
    };
}

export async function getCodexChannelDefaults() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL) {
        return cache;
    }

    try {
        const result = await channelConfigDao.getByProviderType('openai-codex');
        cache = mergeCodexChannelConfig(result?.config || {});
        cacheTime = now;
    } catch (error) {
        console.warn('[CodexChannelConfig] Failed to load:', error.message);
        if (!cache) cache = mergeCodexChannelConfig();
    }

    return cache;
}

export function clearCodexChannelConfigCache() {
    cache = null;
    cacheTime = 0;
}
