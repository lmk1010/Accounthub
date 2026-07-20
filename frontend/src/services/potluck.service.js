/**
 * Potluck services
 */
import apiClient from './api';

const unwrap = (payload) => payload?.data ?? payload;

const potluckUserFetch = async (path, apiKey, options = {}) => {
  const headers = {
    ...(options.headers || {}),
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const response = await fetch(`/api/potluckuser${path}`, {
    ...options,
    headers,
  });
  return response;
};

export const potluckAdminService = {
  getStats: async () => {
    const payload = await apiClient.get('/potluck/stats');
    return unwrap(payload);
  },

  getKeys: async () => {
    const payload = await apiClient.get('/potluck/keys');
    return unwrap(payload);
  },

  getConfig: async () => {
    const payload = await apiClient.get('/potluck/config');
    return unwrap(payload);
  },

  updateConfig: async (config) => {
    const payload = await apiClient.put('/potluck/config', config);
    return unwrap(payload);
  },

  applyLimitToAll: async () => {
    const payload = await apiClient.post('/potluck/keys/apply-limit');
    return unwrap(payload);
  },

  applyBonusToAll: async () => {
    const payload = await apiClient.post('/potluck/keys/apply-bonus');
    return unwrap(payload);
  },

  createKey: async ({ name, dailyLimit }) => {
    const payload = await apiClient.post('/potluck/keys', { name, dailyLimit });
    return unwrap(payload);
  },

  updateKeyName: async (keyId, name) => {
    const payload = await apiClient.put(`/potluck/keys/${encodeURIComponent(keyId)}/name`, { name });
    return unwrap(payload);
  },

  updateKeyLimit: async (keyId, dailyLimit) => {
    const payload = await apiClient.put(`/potluck/keys/${encodeURIComponent(keyId)}/limit`, { dailyLimit });
    return unwrap(payload);
  },

  toggleKey: async (keyId) => {
    const payload = await apiClient.post(`/potluck/keys/${encodeURIComponent(keyId)}/toggle`);
    return unwrap(payload);
  },

  resetKeyUsage: async (keyId) => {
    const payload = await apiClient.post(`/potluck/keys/${encodeURIComponent(keyId)}/reset`);
    return unwrap(payload);
  },

  regenerateKey: async (keyId) => {
    const payload = await apiClient.post(`/potluck/keys/${encodeURIComponent(keyId)}/regenerate`);
    return unwrap(payload);
  },

  deleteKey: async (keyId) => {
    const payload = await apiClient.delete(`/potluck/keys/${encodeURIComponent(keyId)}`);
    return unwrap(payload);
  },
};

export const potluckUserService = {
  getUsage: async (apiKey) => {
    const response = await potluckUserFetch('/usage', apiKey);
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  getCredentials: async (apiKey) => {
    const response = await potluckUserFetch('/credentials', apiKey);
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  checkAllCredentials: async (apiKey) => {
    const response = await potluckUserFetch('/credentials/check-all', apiKey, {
      method: 'POST',
    });
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  checkCredential: async (apiKey, credentialId) => {
    const response = await potluckUserFetch(`/credentials/${encodeURIComponent(credentialId)}/health`, apiKey, {
      method: 'POST',
    });
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  regenerateKey: async (apiKey) => {
    const response = await potluckUserFetch('/regenerate-key', apiKey, {
      method: 'POST',
    });
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  importAwsCredentials: async (apiKey, credentials) => {
    const response = await potluckUserFetch('/kiro/import-aws-credentials', apiKey, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ credentials }),
    });
    const payload = await response.json();
    return { ok: response.ok, payload };
  },

  streamBatchImport: async (apiKey, refreshTokens, region) => {
    const response = await potluckUserFetch('/kiro/batch-import-tokens', apiKey, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshTokens, region }),
    });
    return response;
  },
};
