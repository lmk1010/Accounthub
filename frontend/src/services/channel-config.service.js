import apiClient from './api';

export async function getByProviderType(providerType) {
  return await apiClient.get(`/channel-configs/${encodeURIComponent(providerType)}`);
}

export async function save(providerType, data) {
  return await apiClient.put(`/channel-configs/${encodeURIComponent(providerType)}`, data);
}

export async function triggerAutoReplenish(providerType, data = {}) {
  return await apiClient.post(`/channel-configs/${encodeURIComponent(providerType)}/auto-replenish`, data);
}
