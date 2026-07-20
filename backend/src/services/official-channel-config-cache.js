/**
 * Claude Official 渠道级配置缓存
 * 供 provider-pool-manager-db / claude-official / common 等模块共享
 */
import * as channelConfigDao from '../dao/channel-config-dao.js';

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function getOfficialChannelDefaults() {
    const now = Date.now();
    if (_cache && (now - _cacheTime) < CACHE_TTL) {
        return _cache;
    }
    try {
        const result = await channelConfigDao.getByProviderType('claude-offical');
        _cache = result?.config || {};
        _cacheTime = now;
    } catch (err) {
        console.warn('[OfficialChannelConfig] Failed to load:', err.message);
        if (!_cache) _cache = {};
    }
    return _cache;
}

export function getOfficialChannelDefaultsSync() {
    return _cache || {};
}

export function clearOfficialChannelConfigCache() {
    _cache = null;
    _cacheTime = 0;
}
