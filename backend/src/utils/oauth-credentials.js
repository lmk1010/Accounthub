export const OAUTH_REF_PREFIX = 'db://oauth/';

export function formatOAuthCredentialRef(providerType, id) {
    if (!providerType || !id) return null;
    return `${OAUTH_REF_PREFIX}${providerType}/${id}`;
}

export function parseOAuthCredentialRef(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/^db:\/\/oauth\/([^/]+)\/(\d+)$/);
    if (!match) return null;
    return {
        providerType: match[1],
        id: Number(match[2])
    };
}

export function extractCredentialId(config, credPathKey = null) {
    if (!config || typeof config !== 'object') return null;
    if (config.oauthCredentialId) return Number(config.oauthCredentialId);
    if (config.OAUTH_CREDENTIAL_ID) return Number(config.OAUTH_CREDENTIAL_ID);
    if (config.oauth_credential_id) return Number(config.oauth_credential_id);
    if (credPathKey && config[credPathKey]) {
        const parsed = parseOAuthCredentialRef(config[credPathKey]);
        if (parsed) return parsed.id;
    }
    return null;
}
