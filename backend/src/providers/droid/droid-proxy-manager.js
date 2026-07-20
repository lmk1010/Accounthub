import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { getProxyConfigs } from './droid-profile.js';

function snapshotConfigs(configs) {
    try {
        return JSON.stringify(configs);
    } catch (_error) {
        return '';
    }
}

export class DroidProxyManager {
    constructor(profile) {
        this.profile = profile;
        this.proxyIndex = 0;
        this.lastSnapshot = '';
    }

    updateProfile(profile) {
        this.profile = profile;
    }

    getNextProxyAgent(targetUrl) {
        const proxies = getProxyConfigs(this.profile);
        if (!Array.isArray(proxies) || proxies.length === 0) {
            return null;
        }

        const currentSnapshot = snapshotConfigs(proxies);
        if (currentSnapshot !== this.lastSnapshot) {
            this.proxyIndex = 0;
            this.lastSnapshot = currentSnapshot;
            console.log('[Droid Proxy] Proxy configuration changed, round-robin index reset');
        }

        for (let attempt = 0; attempt < proxies.length; attempt += 1) {
            const index = (this.proxyIndex + attempt) % proxies.length;
            const proxy = proxies[index];

            if (!proxy || typeof proxy.url !== 'string' || proxy.url.trim() === '') {
                console.warn(`[Droid Proxy] Invalid proxy entry at index ${index}`);
                continue;
            }

            try {
                const url = proxy.url.trim();
                const httpAgent = new HttpProxyAgent(url);
                const httpsAgent = new HttpsProxyAgent(url);
                this.proxyIndex = (index + 1) % proxies.length;

                const label = proxy.name || url;
                console.log(`[Droid Proxy] Using proxy ${label} for request to ${targetUrl}`);
                return { httpAgent, httpsAgent, proxy };
            } catch (error) {
                console.warn(`[Droid Proxy] Failed to create proxy agent for ${proxy.url}: ${error.message}`);
            }
        }

        console.warn('[Droid Proxy] All configured proxies failed to initialize');
        return null;
    }
}
