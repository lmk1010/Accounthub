import { clearDbConfigCache } from './kiro-cache-simulator.js';
import { clearCodexChannelConfigCache } from './codex-channel-config-cache.js';
import { clearOfficialChannelConfigCache } from './official-channel-config-cache.js';
import { clearXaiChannelConfigCache } from './xai-channel-config-cache.js';
import { clearModelMappingCache } from '../providers/claude-antigravity/claude-antigravity-core.js';
import { deleteServiceInstancesByProviderType } from '../providers/adapter.js';

export function clearChannelConfigRuntimeCaches(providerType) {
    switch (providerType) {
        case 'claude-kiro-oauth':
            clearDbConfigCache();
            console.log('[ChannelConfig] Cleared Kiro cache simulation config cache');
            break;
        case 'claude-antigravity':
            clearModelMappingCache();
            console.log('[ChannelConfig] Cleared claude-antigravity model mapping cache');
            break;
        case 'claude-offical':
            clearOfficialChannelConfigCache();
            console.log('[ChannelConfig] Cleared claude-offical channel config cache');
            break;
        case 'openai-codex':
            clearCodexChannelConfigCache();
            console.log('[ChannelConfig] Cleared openai-codex channel config cache');
            break;
        case 'openai-xai-oauth':
            clearXaiChannelConfigCache();
            // Grok route preference (API vs Build) is resolved at adapter init time.
            // Wipe cached adapters so the next request / usage refresh picks up the new path.
            {
                const removed = deleteServiceInstancesByProviderType('openai-xai-oauth');
                console.log(`[ChannelConfig] Cleared openai-xai-oauth channel config cache (adapters=${removed})`);
            }
            break;
        default:
            break;
    }
}

export function broadcastChannelConfigUpdated(providerType) {
    const canBroadcast = (process.env.IS_WORKER_PROCESS === 'true'
        || process.env.IS_ADMIN_PROCESS === 'true')
        && typeof process.send === 'function';
    if (!canBroadcast) return;

    try {
        process.send({
            type: 'broadcast_event',
            originPid: process.pid,
            eventType: 'channel_config_updated',
            data: {
                providerType,
                updatedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.warn('[ChannelConfig] Failed to broadcast channel config update:', error?.message || error);
    }
}
