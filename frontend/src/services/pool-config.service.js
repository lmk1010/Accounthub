/**
 * Pool Config Service - 号池配置前端服务
 */

const API_BASE = '/api';

/**
 * 获取所有号池配置
 */
export async function getAllPoolConfigs() {
  const res = await fetch(`${API_BASE}/pool-configs`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

/**
 * 获取指定提供商类型的号池配置
 */
export async function getPoolConfigsByType(providerType) {
  const res = await fetch(`${API_BASE}/pool-configs/type/${encodeURIComponent(providerType)}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

/**
 * 更新号池配置
 */
export async function updatePoolConfig(id, config) {
  const res = await fetch(`${API_BASE}/pool-configs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}
