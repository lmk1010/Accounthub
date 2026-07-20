/**
 * Channel Dispatch Logs Service - 渠道调度日志服务
 */

import api from './api';

/**
 * 获取渠道调度日志
 */
export async function getChannelDispatchLogs(providerType, options = {}) {
    const params = new URLSearchParams();
    if (options.page) params.append('page', options.page);
    if (options.pageSize) params.append('pageSize', options.pageSize);
    if (options.errorType) params.append('errorType', options.errorType);

    const queryString = params.toString();
    const url = `/channel-dispatch-logs/${encodeURIComponent(providerType)}${queryString ? `?${queryString}` : ''}`;
    return api.get(url);
}

/**
 * 清空渠道调度日志
 */
export async function clearChannelDispatchLogs(providerType) {
    return api.delete(`/channel-dispatch-logs/${encodeURIComponent(providerType)}`);
}

export const channelDispatchLogsService = {
    getChannelDispatchLogs,
    clearChannelDispatchLogs,
};
