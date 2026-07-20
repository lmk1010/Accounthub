/**
 * 提供商服务
 */
import apiClient from './api';

const normalizeProviderRecord = (provider) => {
  if (!provider || typeof provider !== 'object') {
    return provider;
  }
  return {
    ...provider,
    providerType: provider.providerType ?? provider.provider_type ?? provider.type ?? provider.provider,
    createdAt: provider.createdAt ?? provider.created_at ?? null,
    updatedAt: provider.updatedAt ?? provider.updated_at ?? null,
    poolId: provider.poolId ?? provider.pool_id ?? null,
    isHealthy: provider.isHealthy ?? provider.is_healthy ?? provider.healthy ?? true,
    isDisabled: provider.isDisabled ?? provider.is_disabled ?? provider.disabled ?? false,
    isDeleted: provider.isDeleted ?? provider.is_deleted ?? provider.deleted ?? false,
    customName: provider.customName ?? provider.custom_name ?? null,
    usageCount: provider.usageCount ?? provider.usage_count ?? 0,
    errorCount: provider.errorCount ?? provider.error_count ?? 0,
    lastUsed: provider.lastUsed ?? provider.last_used ?? null,
    lastErrorTime: provider.lastErrorTime ?? provider.last_error_time ?? null,
    lastErrorMessage: provider.lastErrorMessage ?? provider.last_error_message ?? null,
    scheduledRecoveryTime: provider.scheduledRecoveryTime ?? provider.scheduled_recovery_time ?? null,
    oauthCredentialId: provider.oauthCredentialId ?? provider.oauth_credential_id ?? null,
    // Kiro 用量信息
    subscriptionTitle: provider.subscriptionTitle ?? provider.subscription_title ?? null,
    usageLimit: provider.usageLimit ?? provider.usage_limit ?? null,
    currentUsage: provider.currentUsage ?? provider.current_usage ?? null,
    nextResetTime: provider.nextResetTime ?? provider.next_reset_time ?? null,
    freeTrialExpiry: provider.freeTrialExpiry ?? provider.free_trial_expiry ?? null,
    // Kiro 可用模型
    availableModels: provider.availableModels ?? provider.available_models ?? null,
    // Kiro 设备槽位配置
    maxDevices: provider.maxDevices ?? provider.max_devices ?? 3,
  };
};

const normalizeProviderDetail = (providerType, payload) => {
  if (!payload) return payload;
  if (payload.providerType || payload.providers) {
    const providers = Array.isArray(payload.providers)
      ? payload.providers.map(normalizeProviderRecord)
      : [];
    return {
      ...payload,
      providerType: payload.providerType || providerType,
      providers,
    };
  }
  if (Array.isArray(payload)) {
    const providers = payload.map(normalizeProviderRecord);
    const healthyCount = providers.filter((item) => item.isHealthy && !item.isDisabled && !item.isDeleted).length;
    const disabledCount = providers.filter((item) => item.isDisabled && !item.isDeleted).length;
    const deletedCount = providers.filter((item) => item.isDeleted).length;
    return {
      providerType,
      providers,
      totalCount: providers.length,
      healthyCount,
      disabledCount,
      deletedCount,
      totalWithDeleted: providers.length,
    };
  }
  return payload;
};

export const providerService = {
  // 获取提供商摘要
  getSummary: async () => {
    const response = await apiClient.get('/providers/summary');
    const payload = response?.data ?? response;
    if (payload?.providerTypes) {
      return payload.providerTypes;
    }
    if (payload?.success && payload?.data?.providerTypes) {
      return payload.data.providerTypes;
    }
    return payload;
  },

  // 获取所有提供商
  getAll: async (options = {}) => {
    const params = new URLSearchParams();
    if (options.filter) params.set('filter', options.filter);
    if (options.page) params.set('page', options.page);
    if (options.pageSize) params.set('pageSize', options.pageSize);
    const query = params.toString();
    const response = await apiClient.get(`/providers${query ? `?${query}` : ''}`);
    const payload = response?.data ?? response;
    const data = payload?.success && payload?.data ? payload.data : payload;
    if (data?.providers && Array.isArray(data.providers)) {
      return {
        ...data,
        providers: data.providers.map(normalizeProviderRecord),
      };
    }
    if (Array.isArray(data)) {
      return data.map(normalizeProviderRecord);
    }
    return data;
  },

  // 获取指定类型的提供商
  getByType: async (providerType, options = {}) => {
    const params = new URLSearchParams();
    if (options.filter) params.set('filter', options.filter);
    if (options.page) params.set('page', options.page);
    if (options.pageSize) params.set('pageSize', options.pageSize);
    if (options.poolId !== undefined && options.poolId !== null) params.set('poolId', options.poolId);
    if (options.createdAfter) params.set('createdAfter', options.createdAfter);
    if (options.createdBefore) params.set('createdBefore', options.createdBefore);
    if (options.search) params.set('search', options.search);
    const query = params.toString();
    const response = await apiClient.get(`/providers/${providerType}${query ? `?${query}` : ''}`);
    const payload = response?.data ?? response;
    const data = payload?.success && payload?.data ? payload.data : payload;

    // 后端返回对象格式，直接使用后端统计数据
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const providers = Array.isArray(data.providers)
        ? data.providers.map(normalizeProviderRecord)
        : [];
      return {
        providerType: data.providerType || providerType,
        providers,
        totalCount: data.totalCount ?? providers.length,
        healthyCount: data.healthyCount ?? 0,
        cooldownCount: data.cooldownCount ?? 0,
        unhealthyCount: data.unhealthyCount ?? 0,
        disabledCount: data.disabledCount ?? 0,
        deletedCount: data.deletedCount ?? 0,
        totalActive: data.totalActive ?? Math.max((data.totalWithDeleted ?? data.totalCount ?? providers.length) - (data.deletedCount ?? 0), 0),
        totalWithDeleted: data.totalWithDeleted ?? data.totalCount ?? providers.length,
        page: data.page ?? options.page ?? 1,
        pageSize: data.pageSize ?? options.pageSize ?? 20,
      };
    }

    // 兼容旧版本：后端返回数组时，在前端计算（不推荐）
    if (Array.isArray(data)) {
      const providers = data.map(normalizeProviderRecord);
      const healthyCount = providers.filter((item) => item.isHealthy && !item.isDisabled && !item.isDeleted).length;
      const disabledCount = providers.filter((item) => item.isDisabled && !item.isDeleted).length;
      const deletedCount = providers.filter((item) => item.isDeleted).length;
      return {
        providerType,
        providers,
        totalCount: providers.length,
        healthyCount,
        disabledCount,
        deletedCount,
        totalWithDeleted: providers.length,
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 20,
      };
    }

    return normalizeProviderDetail(providerType, data);
  },

  // 获取池子列表
  getPools: async (providerType) => {
    const params = new URLSearchParams();
    if (providerType) params.set('providerType', providerType);
    const query = params.toString();
    const response = await apiClient.get(`/provider-pools${query ? `?${query}` : ''}`);
    const payload = response?.data ?? response;
    if (payload?.success && Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  },

  // 创建池子
  createPool: async ({ providerType, name, isDefault = false }) => {
    return await apiClient.post('/provider-pools', { providerType, name, isDefault });
  },

  // 更新池子
  updatePool: async (poolId, updates) => {
    return await apiClient.patch(`/provider-pools/${poolId}`, updates);
  },

  // 删除池子
  deletePool: async (poolId) => {
    return await apiClient.delete(`/provider-pools/${poolId}`);
  },

  // 获取提供商支持的模型
  getModels: async () => {
    return await apiClient.get('/provider-models');
  },

  // 获取指定类型提供商支持的模型
  getTypeModels: async (providerType) => {
    return await apiClient.get(`/provider-models/${providerType}`);
  },

  // 添加提供商
  add: async (providerData) => {
    return await apiClient.post('/providers', providerData);
  },

  // 更新提供商
  update: async (providerType, uuid, providerData) => {
    return await apiClient.put(`/providers/${providerType}/${uuid}`, providerData);
  },

  // 删除提供商
  delete: async (providerType, uuid) => {
    try {
      if (providerType) {
        return await apiClient.delete(`/providers/${providerType}/${uuid}`);
      }
    } catch (error) {
      const status = error.response?.status;
      if (status !== 404 && status !== 405) {
        throw error;
      }
    }
    return await apiClient.delete(`/providers/${uuid}`);
  },

  // 彻底删除提供商
  hardDelete: async (providerType, uuid) => {
    return await apiClient.delete(`/providers/${providerType}/${uuid}/hard-delete`);
  },

  // 启用提供商
  enable: async (providerType, uuid) => {
    return await apiClient.post(`/providers/${providerType}/${uuid}/enable`);
  },

  // 禁用提供商
  disable: async (providerType, uuid) => {
    return await apiClient.post(`/providers/${providerType}/${uuid}/disable`);
  },

  // 重置提供商健康状态（支持单个或全部）
  resetHealth: async (providerType, uuid = null) => {
    if (uuid) {
      return await apiClient.post(`/providers/${providerType}/${uuid}/reset-health`);
    }
    return await apiClient.post(`/providers/${providerType}/reset-health`);
  },

  // 删除不健康的提供商
  deleteUnhealthy: async (providerType) => {
    return await apiClient.delete(`/providers/${providerType}/delete-unhealthy`);
  },

  // 健康检查
  healthCheck: async (providerType, options = {}) => {
    return await apiClient.post(`/providers/${providerType}/health-check`, options);
  },

  // 批量从 accessToken 提取邮箱
  batchExtractEmails: async (providerType) => {
    return await apiClient.post(`/providers/${providerType}/batch-extract-emails`);
  },

  // 按筛选条件批量删除（跨页）
  batchDeleteByFilter: async (providerType, { filter, poolId, createdAfter, createdBefore, mode }) => {
    return await apiClient.post(`/providers/${providerType}/batch-delete-by-filter`, {
      filter, poolId, createdAfter, createdBefore, mode
    });
  },

  // 按勾选账号批量转池
  batchMoveToPool: async (providerType, { uuids, targetPoolId }) => {
    return await apiClient.post(`/providers/${providerType}/batch-move-pool`, {
      uuids,
      targetPoolId,
    });
  },

  // 按筛选条件获取全部 UUID（用于跨页全选）
  getUuidsByFilter: async (providerType, options = {}) => {
    const params = new URLSearchParams();
    if (options.filter) params.set('filter', options.filter);
    if (options.poolId !== undefined && options.poolId !== null) params.set('poolId', options.poolId);
    if (options.createdAfter) params.set('createdAfter', options.createdAfter);
    if (options.createdBefore) params.set('createdBefore', options.createdBefore);
    if (options.search) params.set('search', options.search);
    const query = params.toString();
    return await apiClient.get(`/providers/${providerType}/uuids-by-filter${query ? `?${query}` : ''}`);
  },

  // 获取账号状态记录
  getProviderStatusLogs: async (uuid, page = 1, pageSize = 10) => {
    return await apiClient.get(`/providers/${uuid}/status-logs?page=${page}&pageSize=${pageSize}`);
  },

  // 获取账号实时用户列表
  getProviderActiveUsers: async (uuid) => {
    return await apiClient.get(`/account-users/${uuid}`);
  },

  // 刷新提供商 UUID
  refreshUuid: async (providerType, uuid) => {
    return await apiClient.post(`/providers/${providerType}/${uuid}/refresh-uuid`);
  },

  // 刷新提供商 Token
  refreshToken: async (providerType, uuid) => {
    return await apiClient.post(`/providers/${providerType}/${uuid}/refresh-token`);
  },

  // 刷新不健康提供商 UUID
  refreshUnhealthyUuids: async (providerType) => {
    return await apiClient.post(`/providers/${providerType}/refresh-unhealthy-uuids`);
  },

  // 批量更新健康检查模型
  batchUpdateCheckModelName: async (providerType, checkModelName) => {
    return await apiClient.post(`/providers/${providerType}/batch-check-model-name`, {
      checkModelName,
    });
  },

  // 生成授权链接
  generateAuthUrl: async (providerType, options = {}) => {
    return await apiClient.post(`/providers/${providerType}/generate-auth-url`, options);
  },

  // Claude Official Cookie 自动授权
  claudeOfficialCookieOAuth: async (options = {}) => {
    return await apiClient.post('/claude-offical/cookie-oauth', options);
  },

  // 手动 OAuth 回调
  manualCallback: async (provider, callbackUrl, authMethod, taskId) => {
    return await apiClient.post('/oauth/manual-callback', {
      provider,
      callbackUrl,
      authMethod,
      taskId,
    });
  },

  // 取消 Kiro OAuth 轮询任务
  cancelKiroPolling: async (taskId = null) => {
    return await apiClient.post('/kiro/cancel-polling', { taskId });
  },

  // Codex 批量授权
  codexBatchStart: async (options = {}) => {
    return await apiClient.post('/codex/batch-auth/start', options);
  },
  codexBatchStop: async () => {
    return await apiClient.post('/codex/batch-auth/stop', {});
  },
  codexBatchStatus: async () => {
    return await apiClient.get('/codex/batch-auth/status');
  },

  // 导入 AnyRegister 生成的 Codex JSON
  importCodexAnyRegisterJson: async (payload) => {
    return await apiClient.post('/codex/import-anyregister-json', payload);
  },

  // 导入 xAI Grok JSON、API Key、Access Token 或 Refresh Token
  importXaiCredentials: async (payload) => {
    return await apiClient.post('/xai/import-credentials', payload, { timeout: 180000 });
  },

  // 取消 xAI Device Flow 后台轮询
  cancelXaiPolling: async (taskId = null) => {
    return await apiClient.post('/xai/cancel-polling', { taskId });
  },

  // Grok 自动注册任务
  startXaiRegistration: async (payload = {}) => {
    return await apiClient.post('/xai/registration/start', payload);
  },
  getXaiRegistrationStatus: async () => {
    return await apiClient.get('/xai/registration/status');
  },
  getXaiRegistrationTask: async (taskId) => {
    return await apiClient.get(`/xai/registration/tasks/${encodeURIComponent(taskId)}`);
  },
  stopXaiRegistration: async (taskId = null) => {
    return await apiClient.post('/xai/registration/stop', { taskId });
  },
  downloadXaiRegistrationArtifacts: async (taskId) => {
    return await apiClient.get(
      `/xai/registration/tasks/${encodeURIComponent(taskId)}/artifacts`,
      { responseType: 'blob' }
    );
  },

  // 导入 Warp Token
  importWarpToken: async (refreshToken) => {
    return await apiClient.post('/warp/import-token', { refreshToken });
  },

  // 批量导入 Warp Token
  batchImportWarpTokens: async (refreshTokens) => {
    return await apiClient.post('/warp/batch-import-tokens', { refreshTokens });
  },

  // 导入 Orchids Token / Cookie
  importOrchidsToken: async (payload) => {
    return await apiClient.post('/orchids/import-token', payload);
  },

  // 导入 AMI Token (wos-session)
  importAmiToken: async (payload) => {
    return await apiClient.post('/ami/import-token', payload);
  },

  // 导入 Kiro AWS 凭据
  importKiroAwsCredentials: async (credentials, poolId) => {
    return await apiClient.post('/kiro/import-aws-credentials', { credentials, poolId: poolId || undefined });
  },

  // 导入 Droid Token
  importDroidToken: async (payload) => {
    return await apiClient.post('/droid/import-token', payload);
  },

  // 批量导入 Droid Token
  batchImportDroidTokens: async (payload) => {
    return await apiClient.post('/droid/batch-import-tokens', payload);
  },

  // 上游管理: 健康检查
  getUpstreamHealth: async (providerType, uuid) => {
    return await apiClient.get(`/upstream/${encodeURIComponent(providerType)}/${uuid}/health`);
  },

  // 上游管理: 反代状态
  getUpstreamProxyStatus: async (providerType, uuid) => {
    return await apiClient.get(`/upstream/${encodeURIComponent(providerType)}/${uuid}/proxy/status`);
  },

  // 上游管理: 启动反代
  startUpstreamProxy: async (providerType, uuid) => {
    return await apiClient.post(`/upstream/${encodeURIComponent(providerType)}/${uuid}/proxy/start`);
  },

  // 上游管理: 停止反代
  stopUpstreamProxy: async (providerType, uuid) => {
    return await apiClient.post(`/upstream/${encodeURIComponent(providerType)}/${uuid}/proxy/stop`);
  },

  // 上游管理: 账号列表
  getUpstreamAccounts: async (providerType, uuid) => {
    return await apiClient.get(`/upstream/${encodeURIComponent(providerType)}/${uuid}/accounts`);
  },

  // 上游管理: 导入 refresh token
  importUpstreamRefreshToken: async (providerType, uuid, refreshToken) => {
    return await apiClient.post(`/upstream/${encodeURIComponent(providerType)}/${uuid}/accounts/import-refresh-token`, {
      refreshToken
    });
  },

  // 上游管理: 切换账号
  switchUpstreamAccount: async (providerType, uuid, accountId) => {
    return await apiClient.post(`/upstream/${encodeURIComponent(providerType)}/${uuid}/accounts/switch`, {
      accountId
    });
  },

  // 获取OAuth凭据详情
  getOAuthCredential: async (credentialId) => {
    const response = await apiClient.get(`/oauth-credentials/${credentialId}`);
    return response?.data ?? response;
  },

  // 获取账号错误历史
  getProviderErrorLogs: async (uuid, page = 1, pageSize = 10) => {
    return await apiClient.get(`/providers/${uuid}/error-logs?page=${page}&pageSize=${pageSize}`);
  },
};
