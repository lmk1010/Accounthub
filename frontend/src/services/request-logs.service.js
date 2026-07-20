/**
 * Request Logs Service - 请求日志服务
 */

import api from './api';

/**
 * 获取账号的请求日志
 */
export async function getProviderRequestLogs(uuid, options = {}) {
    const params = new URLSearchParams();
    if (options.page) params.append('page', options.page);
    if (options.pageSize) params.append('pageSize', options.pageSize);
    if (options.isSuccess !== undefined) params.append('isSuccess', options.isSuccess);
    if (options.startDate) params.append('startDate', options.startDate);
    if (options.endDate) params.append('endDate', options.endDate);

    const queryString = params.toString();
    const url = `/providers/${uuid}/request-logs${queryString ? `?${queryString}` : ''}`;
    return api.get(url);
}

/**
 * 获取池子的请求日志
 */
export async function getPoolRequestLogs(providerType, poolId, options = {}) {
    const params = new URLSearchParams();
    params.append('providerType', providerType);
    if (poolId !== undefined && poolId !== null) params.append('poolId', poolId);
    if (options.page) params.append('page', options.page);
    if (options.pageSize) params.append('pageSize', options.pageSize);
    if (options.isSuccess !== undefined) params.append('isSuccess', options.isSuccess);
    if (options.startDate) params.append('startDate', options.startDate);
    if (options.endDate) params.append('endDate', options.endDate);

    return api.get(`/request-logs?${params.toString()}`);
}

/**
 * 清空账号的请求日志
 */
export async function clearProviderRequestLogs(uuid) {
    return api.delete(`/providers/${uuid}/request-logs`);
}

/**
 * 清空池子的请求日志
 */
export async function clearPoolRequestLogs(providerType, poolId) {
    const params = new URLSearchParams();
    params.append('providerType', providerType);
    if (poolId !== undefined && poolId !== null) params.append('poolId', poolId);
    return api.delete(`/request-logs/clear?${params.toString()}`);
}

/**
 * 获取请求日志错误详情（大字段）
 */
export async function getRequestLogErrorDetail(id) {
    return api.get(`/request-logs/${id}/error-detail`);
}

export const requestLogsService = {
    getProviderRequestLogs,
    getPoolRequestLogs,
    clearProviderRequestLogs,
    clearPoolRequestLogs,
    getRequestLogErrorDetail
};
