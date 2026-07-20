import * as oauthCredentialsDao from '../dao/oauth-credentials-dao.js';
import { extractCredentialId } from '../utils/oauth-credentials.js';
import { withDbLock } from '../utils/db-lock.js';

export async function loadCredentialsFromConfig(config, credPathKey, providerType) {
    const credentialId = extractCredentialId(config, credPathKey);
    if (!credentialId) {
        throw new Error(`[${providerType}] OAuth credential id not configured`);
    }

    const record = await oauthCredentialsDao.findById(credentialId);
    if (!record) {
        throw new Error(`[${providerType}] OAuth credential not found for id ${credentialId}`);
    }
    return {
        credentialId,
        credentials: record.credentials
    };
}

export async function updateCredentialsById(credentialId, credentials, lockKey = null) {
    const key = lockKey || `oauth-credentials:${credentialId}`;
    return await withDbLock(key, 10, async () => {
        return await oauthCredentialsDao.updateCredentials(credentialId, credentials);
    });
}

export async function loadCredentialsById(credentialId) {
    if (!credentialId) return null;
    const record = await oauthCredentialsDao.findById(credentialId);
    return record?.credentials || null;
}
