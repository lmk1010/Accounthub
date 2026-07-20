import axios from 'axios';
import * as oauthCredentialsDao from '../../dao/oauth-credentials-dao.js';
import { loadCredentialsFromConfig, updateCredentialsById } from '../../services/oauth-credentials-store.js';
import { withDeduplication } from '../../utils/file-lock.js';

const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';

export class DroidAuthManager {
    constructor(config, proxyManager) {
        this.config = config;
        this.proxyManager = proxyManager;
        this._initialized = false;
        this.oauthCredentialId = null;
        this.accessToken = null;
        this.refreshToken = null;
        this.factoryApiKey = null;
        this.clientId = DEFAULT_CLIENT_ID;
        this.lastRefreshTime = null;
    }

    async initialize() {
        if (this._initialized) {
            return;
        }

        const { credentialId, credentials } = await loadCredentialsFromConfig(
            this.config,
            'DROID_OAUTH_CREDS_FILE_PATH',
            'droid-oauth'
        );

        this.oauthCredentialId = credentialId;
        this.accessToken = credentials.accessToken || credentials.access_token || null;
        this.refreshToken = credentials.refreshToken || credentials.refresh_token || null;
        this.factoryApiKey = credentials.factoryApiKey || credentials.factory_api_key || null;
        this.clientId = credentials.clientId || credentials.client_id || DEFAULT_CLIENT_ID;
        this.lastRefreshTime = credentials.lastRefreshTime || credentials.last_refresh_time || null;

        this._initialized = true;
    }

    _shouldRefresh() {
        if (!this.lastRefreshTime) {
            return true;
        }
        const last = Number(this.lastRefreshTime) || Date.parse(this.lastRefreshTime) || 0;
        return (Date.now() - last) >= REFRESH_INTERVAL_MS;
    }

    async getAuthHeader(clientAuthorization = null) {
        await this.initialize();

        if (this.factoryApiKey) {
            return `Bearer ${this.factoryApiKey}`;
        }

        if (this.refreshToken) {
            if (!this.accessToken || this._shouldRefresh()) {
                await this.refreshApiKey();
            }
            if (!this.accessToken) {
                throw new Error('[Droid] Access token unavailable after refresh');
            }
            return `Bearer ${this.accessToken}`;
        }

        if (clientAuthorization) {
            return clientAuthorization;
        }

        throw new Error('[Droid] No authorization available (factory key, refresh token, or client auth required)');
    }

    async refreshApiKey() {
        await this.initialize();
        if (!this.refreshToken) {
            throw new Error('[Droid] Refresh token missing');
        }

        const dedupeKey = `droid-refresh:${this.oauthCredentialId || this.refreshToken}`;
        return await withDeduplication(dedupeKey, async () => {
            const params = new URLSearchParams();
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', this.refreshToken);
            params.append('client_id', this.clientId || DEFAULT_CLIENT_ID);

            const proxyAgentInfo = this.proxyManager?.getNextProxyAgent?.(REFRESH_URL);
            const requestConfig = {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 20000
            };

            if (proxyAgentInfo?.httpAgent || proxyAgentInfo?.httpsAgent) {
                requestConfig.httpAgent = proxyAgentInfo.httpAgent;
                requestConfig.httpsAgent = proxyAgentInfo.httpsAgent;
                requestConfig.proxy = false;
            }

            const response = await axios.post(REFRESH_URL, params.toString(), requestConfig);
            if (!response?.data) {
                throw new Error('[Droid] Refresh response empty');
            }

            const data = response.data;
            this.accessToken = data.access_token || data.accessToken || this.accessToken;
            this.refreshToken = data.refresh_token || data.refreshToken || this.refreshToken;
            this.lastRefreshTime = Date.now();

            const existing = this.oauthCredentialId
                ? await oauthCredentialsDao.findById(this.oauthCredentialId)
                : null;
            const merged = {
                ...(existing?.credentials || {}),
                accessToken: this.accessToken,
                refreshToken: this.refreshToken,
                clientId: this.clientId || DEFAULT_CLIENT_ID,
                factoryApiKey: this.factoryApiKey || null,
                lastRefreshTime: this.lastRefreshTime
            };
            await updateCredentialsById(this.oauthCredentialId, merged);

            console.log('[Droid] API token refreshed successfully');
            return this.accessToken;
        });
    }
}
