import * as channelConfigDao from '../dao/channel-config-dao.js';

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const DEFAULT_XAI_CHANNEL_CONFIG = {
    // '' = auto by token scopes; 'true' = official API; 'false' = Grok Build proxy
    XAI_USING_API: '',
    xaiClaudeMessagesDefaultModel: 'grok-4.5',
    xaiClaudeMessagesModelMapping: {},
    xaiStickySessionEnabled: true,
    xaiSessionBindingStrict: false,
    xaiStickySessionTtlMinutes: 15,
    xaiStickyIdentityMode: 'session'
};

/**
 * Normalize channel-level Grok route selector.
 * Returns '', 'true', or 'false'.
 */
export function normalizeXaiUsingApi(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return value !== 0 ? 'true' : 'false';
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'api', 'official'].includes(normalized)) return 'true';
    if (['false', '0', 'no', 'off', 'build', 'cli', 'chat', 'proxy'].includes(normalized)) return 'false';
    return '';
}

export async function getXaiChannelDefaults() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL) {
        return cache;
    }

    try {
        const result = await channelConfigDao.getByProviderType('openai-xai-oauth');
        const merged = {
            ...DEFAULT_XAI_CHANNEL_CONFIG,
            ...(result?.config || {}),
            defaultModel: result?.defaultModel || result?.config?.defaultModel || null
        };
        merged.XAI_USING_API = normalizeXaiUsingApi(
            merged.XAI_USING_API ?? merged.xaiUsingApi ?? merged.using_api
        );
        cache = merged;
        cacheTime = now;
    } catch (error) {
        console.warn('[XaiChannelConfig] Failed to load:', error.message);
        if (!cache) {
            cache = {
                ...DEFAULT_XAI_CHANNEL_CONFIG,
                defaultModel: null,
                XAI_USING_API: ''
            };
        }
    }

    return cache;
}

export function clearXaiChannelConfigCache() {
    cache = null;
    cacheTime = 0;
}
