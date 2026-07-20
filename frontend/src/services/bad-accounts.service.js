/**
 * Bad Accounts Service - 坏号记录前端服务
 */

const API_BASE = '';

/**
 * 获取坏号记录列表
 */
export async function getBadAccounts(options = {}) {
    const params = new URLSearchParams();
    if (options.providerType) params.append('providerType', options.providerType);
    if (options.poolId !== undefined) params.append('poolId', options.poolId);
    if (options.errorType) params.append('errorType', options.errorType);
    if (options.detectionSource) params.append('detectionSource', options.detectionSource);
    if (options.page) params.append('page', options.page);
    if (options.pageSize) params.append('pageSize', options.pageSize);

    const url = `${API_BASE}/api/bad-accounts?${params.toString()}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (!response.ok) throw new Error('Failed to fetch bad accounts');
    return response.json();
}

/**
 * 获取坏号统计摘要
 */
export async function getBadAccountsSummary(options = {}) {
    const params = new URLSearchParams();
    if (options.providerType) params.append('providerType', options.providerType);
    if (options.poolId !== undefined) params.append('poolId', options.poolId);

    const url = `${API_BASE}/api/bad-accounts/summary?${params.toString()}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (!response.ok) throw new Error('Failed to fetch summary');
    return response.json();
}

/**
 * 删除单个坏号记录
 */
export async function deleteBadAccount(id) {
    const response = await fetch(`${API_BASE}/api/bad-accounts/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (!response.ok) throw new Error('Failed to delete bad account');
    return response.json();
}

/**
 * 批量删除坏号记录
 */
export async function batchDeleteBadAccounts(ids) {
    const response = await fetch(`${API_BASE}/api/bad-accounts/batch-delete`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ ids })
    });
    if (!response.ok) throw new Error('Failed to batch delete');
    return response.json();
}

/**
 * 清空指定池子的坏号记录
 */
export async function clearBadAccounts(providerType, poolId) {
    const params = new URLSearchParams({ providerType });
    if (poolId !== undefined) params.append('poolId', poolId);

    const response = await fetch(`${API_BASE}/api/bad-accounts/clear?${params.toString()}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    if (!response.ok) throw new Error('Failed to clear bad accounts');
    return response.json();
}

/**
 * 错误类型映射
 */
export const ERROR_TYPE_LABELS = {
    '403_forbidden': '403 禁止访问',
    '429_rate_limit': '429 请求过多',
    'quota_exceeded': '配额耗尽',
    'auth_failed': '认证失败',
    'token_expired': 'Token过期',
    'server_error': '服务器错误',
    'unknown': '未知错误'
};

/**
 * 检测来源映射
 */
export const DETECTION_SOURCE_LABELS = {
    'kiro': 'Kiro',
    'gemini': 'Gemini',
    'codex': 'Codex',
    'manual': '手动'
};
