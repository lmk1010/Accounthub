/**
 * 配置页面
 */

import { useEffect, useRef, useState } from 'react';
import { configService } from '../services/config.service';
import { proxyPoolService } from '../services/proxy-pool.service';
import CustomSelect from '../components/CustomSelect';
import './Config.css';

const PROVIDER_OPTIONS = [
  { value: 'gemini-cli-oauth', label: 'Gemini CLI OAuth', icon: 'fa-robot' },
  { value: 'gemini-antigravity', label: 'Gemini Antigravity', icon: 'fa-rocket' },
  { value: 'openai-custom', label: 'OpenAI Custom', icon: 'fa-brain' },
  { value: 'claude-custom', label: 'Claude Custom', icon: 'fa-comment-dots' },
  { value: 'claude-kiro-oauth', label: 'Claude Kiro OAuth', icon: 'fa-key' },
  { value: 'claude-warp-oauth', label: 'Warp AI OAuth', icon: 'fa-bolt' },
  { value: 'openai-codex', label: 'OpenAI Codex OAuth', icon: 'fa-code' },
  { value: 'openai-droid', label: 'Droid OpenAI', icon: 'fa-bolt' },
  { value: 'openaiResponses-droid', label: 'Droid Responses', icon: 'fa-bolt' },
  { value: 'claude-droid', label: 'Droid Claude', icon: 'fa-bolt' },
  { value: 'claude-orchids-oauth', label: 'Orchids OAuth', icon: 'fa-seedling' },
];

const PROXY_PROVIDER_OPTIONS = [
  { value: 'gemini-cli-oauth', label: 'Gemini CLI OAuth', icon: 'fa-robot' },
  { value: 'gemini-antigravity', label: 'Gemini Antigravity', icon: 'fa-rocket' },
  { value: 'openai-custom', label: 'OpenAI Custom', icon: 'fa-brain' },
  { value: 'claude-custom', label: 'Claude Custom', icon: 'fa-comment-dots' },
  { value: 'claude-kiro-oauth', label: 'Claude Kiro OAuth', icon: 'fa-key' },
  { value: 'claude-warp-oauth', label: 'Warp AI OAuth', icon: 'fa-bolt' },
  { value: 'openai-codex', label: 'OpenAI Codex OAuth', icon: 'fa-code' },
  { value: 'claude-orchids-oauth', label: 'Orchids OAuth', icon: 'fa-seedling' },
];

const buildDefaultConfig = (rawConfig) => {
  const normalizedCallbackHost = normalizeConfigValue(rawConfig?.OAUTH_CALLBACK_HOST, '');
  const normalizedCallbackScheme = normalizeConfigValue(rawConfig?.OAUTH_CALLBACK_SCHEME, 'http');
  const normalizedCallbackPort = normalizeConfigValue(rawConfig?.OAUTH_CALLBACK_PORT, '');

  return {
    REQUIRED_API_KEY: '',
    HOST: '127.0.0.1',
    SERVER_PORT: 3000,
    PUBLIC_API_BASE_URL: '',
    SYSTEM_PROMPT_MODE: 'append',
    PROMPT_LOG_BASE_NAME: 'prompt_log',
    PROMPT_LOG_MODE: 'none',
    REQUEST_MAX_RETRIES: 3,
    REQUEST_BASE_DELAY: 1000,
    CREDENTIAL_SWITCH_MAX_RETRIES: 5,
    CRON_NEAR_MINUTES: 1,
    CRON_REFRESH_TOKEN: false,
    MAX_ERROR_COUNT: 3,
    AUTH_TOKEN_CLEANUP_ENABLED: true,
    AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES: 5,
    PROVIDER_HEALTH_CHECK_ENABLED: true,
    PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES: 5,
    POTLUCK_HEALTH_SYNC_ENABLED: true,
    POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES: 5,
    USAGE_REFRESH_ENABLED: false,
    USAGE_REFRESH_INTERVAL_MINUTES: 10,
    USAGE_AUTO_DISABLE: false,
    USAGE_WARN_THRESHOLD: 80,
    USAGE_DISABLE_THRESHOLD: 95,
    PROXY_URL: '',
    PROXY_POOL_ENABLED: false,
    ...rawConfig,
    OAUTH_CALLBACK_HOST: normalizedCallbackHost,
    OAUTH_CALLBACK_SCHEME: normalizedCallbackScheme,
    OAUTH_CALLBACK_PORT: normalizedCallbackPort,
    systemPrompt: rawConfig?.systemPrompt ?? rawConfig?.SYSTEM_PROMPT_CONTENT ?? '',
  };
};

const parseProviders = (rawConfig) => {
  if (Array.isArray(rawConfig?.DEFAULT_MODEL_PROVIDERS) && rawConfig.DEFAULT_MODEL_PROVIDERS.length > 0) {
    return rawConfig.DEFAULT_MODEL_PROVIDERS;
  }
  if (Array.isArray(rawConfig?.MODEL_PROVIDER) && rawConfig.MODEL_PROVIDER.length > 0) {
    return rawConfig.MODEL_PROVIDER;
  }
  if (typeof rawConfig?.MODEL_PROVIDER === 'string') {
    return rawConfig.MODEL_PROVIDER.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const normalizeConfigValue = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string' && (raw === '' || raw === 'null' || raw === 'undefined')) {
    return fallback;
  }
  return raw;
};

const parseProxyNodeInput = (rawInput, selectedProtocol = 'http') => {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (!input) {
    throw new Error('请输入代理地址');
  }

  let protocol = selectedProtocol || 'http';
  let host = '';
  let port = null;
  let username = null;
  let password = null;

  if (input.includes('://')) {
    const parsed = new URL(input);
    protocol = parsed.protocol.replace(':', '').toLowerCase();
    host = parsed.hostname;
    port = Number.parseInt(parsed.port, 10) || (protocol === 'https' ? 443 : 80);
    username = parsed.username ? decodeURIComponent(parsed.username) : null;
    password = parsed.password ? decodeURIComponent(parsed.password) : null;
  } else {
    const parts = input.split(':');
    if (parts.length >= 4) {
      host = parts[0];
      port = Number.parseInt(parts[1], 10);
      username = parts[2] || null;
      password = parts.slice(3).join(':') || null;
    } else if (parts.length === 2) {
      host = parts[0];
      port = Number.parseInt(parts[1], 10);
    } else {
      throw new Error('格式错误，支持 host:port 或 host:port:user:pass');
    }
  }

  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('代理地址无效，请检查 host 和端口');
  }

  return {
    protocol,
    host,
    port,
    username,
    password,
  };
};

const formatProxyAddress = (proxy) => {
  if (!proxy) return '';
  const protocol = proxy.protocol || 'http';
  const auth = proxy.username ? `${proxy.username}:${proxy.password ? '***' : ''}@` : '';
  return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
};

const extractApiErrorMessage = (error, fallback = '操作失败') => {
  return error?.response?.data?.error?.message
    || error?.response?.data?.message
    || error?.message
    || fallback;
};

export default function Config() {
  const [config, setConfig] = useState(null);
  const [selectedProviders, setSelectedProviders] = useState([]);
  const [proxyProviders, setProxyProviders] = useState([]);
  const [providerFallbackChain, setProviderFallbackChain] = useState('');
  const [modelFallbackMapping, setModelFallbackMapping] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [jsonErrors, setJsonErrors] = useState({ fallback: '', model: '' });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [basicCollapsed, setBasicCollapsed] = useState(true);
  const [advancedCollapsed, setAdvancedCollapsed] = useState(true);
  const [monitoringCollapsed, setMonitoringCollapsed] = useState(true);
  const [proxyPoolCollapsed, setProxyPoolCollapsed] = useState(true);
  const [proxyPool, setProxyPool] = useState([]);
  const [newProxy, setNewProxy] = useState({ name: '', url: '', protocol: 'http' });
  const [testingInputProxy, setTestingInputProxy] = useState(false);
  const [testingNodeIds, setTestingNodeIds] = useState({});
  const successTimerRef = useRef(null);

  useEffect(() => {
    fetchConfig();
    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  const showSuccess = (message) => {
    setSuccess(message);
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
    }
    successTimerRef.current = setTimeout(() => setSuccess(''), 3000);
  };

  const fetchConfig = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await configService.get();
      const rawConfig = data?.data || data?.config || data || {};
      const nextConfig = buildDefaultConfig(rawConfig);
      setConfig(nextConfig);

      const providers = parseProviders(rawConfig);
      const fallbackProvider = PROVIDER_OPTIONS[0]?.value;
      setSelectedProviders(providers.length > 0 ? providers : (fallbackProvider ? [fallbackProvider] : []));

      const proxyList = Array.isArray(rawConfig?.PROXY_ENABLED_PROVIDERS)
        ? rawConfig.PROXY_ENABLED_PROVIDERS
        : [];
      setProxyProviders(proxyList);

      if (rawConfig?.providerFallbackChain && typeof rawConfig.providerFallbackChain === 'object') {
        setProviderFallbackChain(JSON.stringify(rawConfig.providerFallbackChain, null, 2));
      } else {
        setProviderFallbackChain('');
      }

      if (rawConfig?.modelFallbackMapping && typeof rawConfig.modelFallbackMapping === 'object') {
        setModelFallbackMapping(JSON.stringify(rawConfig.modelFallbackMapping, null, 2));
      } else {
        setModelFallbackMapping('');
      }

      await refreshProxyNodes();
    } catch (fetchError) {
      console.error('Failed to fetch config:', fetchError);
      setError('加载配置失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const refreshProxyNodes = async () => {
    try {
      const nodesResult = await proxyPoolService.getNodes();
      setProxyPool(nodesResult?.nodes || []);
    } catch {
      setProxyPool([]);
    }
  };

  const handleSave = async () => {
    setError('');
    setSuccess('');

    if (selectedProviders.length === 0) {
      setError('至少选择一个模型提供商');
      return;
    }

    let fallbackChainPayload = {};
    let modelFallbackPayload = {};

    if (providerFallbackChain.trim()) {
      try {
        fallbackChainPayload = JSON.parse(providerFallbackChain);
        setJsonErrors((prev) => ({ ...prev, fallback: '' }));
      } catch (parseError) {
        setJsonErrors((prev) => ({
          ...prev,
          fallback: 'Fallback 链配置格式无效，请输入有效的 JSON',
        }));
        setError('Fallback 链配置格式无效');
        return;
      }
    } else {
      setJsonErrors((prev) => ({ ...prev, fallback: '' }));
    }

    if (modelFallbackMapping.trim()) {
      try {
        modelFallbackPayload = JSON.parse(modelFallbackMapping);
        setJsonErrors((prev) => ({ ...prev, model: '' }));
      } catch (parseError) {
        setJsonErrors((prev) => ({
          ...prev,
          model: '模型映射配置格式无效，请输入有效的 JSON',
        }));
        setError('模型映射配置格式无效');
        return;
      }
    } else {
      setJsonErrors((prev) => ({ ...prev, model: '' }));
    }

    const callbackHost = normalizeConfigValue(config?.OAUTH_CALLBACK_HOST, '');
    const callbackScheme = normalizeConfigValue(config?.OAUTH_CALLBACK_SCHEME, '');
    const callbackPort = normalizeConfigValue(config?.OAUTH_CALLBACK_PORT, '');

    const payload = {
      REQUIRED_API_KEY: config?.REQUIRED_API_KEY || '',
      HOST: config?.HOST || '127.0.0.1',
      SERVER_PORT: parseNumber(config?.SERVER_PORT, 3000),
      PUBLIC_API_BASE_URL: config?.PUBLIC_API_BASE_URL?.trim() || '',
      MODEL_PROVIDER: selectedProviders.join(','),
      SYSTEM_PROMPT_MODE: config?.SYSTEM_PROMPT_MODE || 'append',
      PROMPT_LOG_BASE_NAME: config?.PROMPT_LOG_BASE_NAME || '',
      PROMPT_LOG_MODE: config?.PROMPT_LOG_MODE || 'none',
      REQUEST_MAX_RETRIES: parseNumber(config?.REQUEST_MAX_RETRIES, 3),
      REQUEST_BASE_DELAY: parseNumber(config?.REQUEST_BASE_DELAY, 1000),
      CREDENTIAL_SWITCH_MAX_RETRIES: parseNumber(config?.CREDENTIAL_SWITCH_MAX_RETRIES, 5),
      CRON_NEAR_MINUTES: parseNumber(config?.CRON_NEAR_MINUTES, 1),
      CRON_REFRESH_TOKEN: Boolean(config?.CRON_REFRESH_TOKEN),
      MAX_ERROR_COUNT: parseNumber(config?.MAX_ERROR_COUNT, 3),
      AUTH_TOKEN_CLEANUP_ENABLED: Boolean(config?.AUTH_TOKEN_CLEANUP_ENABLED),
      AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES: parseNumber(config?.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES, 5),
      PROVIDER_HEALTH_CHECK_ENABLED: Boolean(config?.PROVIDER_HEALTH_CHECK_ENABLED),
      PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES: parseNumber(config?.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES, 5),
      POTLUCK_HEALTH_SYNC_ENABLED: Boolean(config?.POTLUCK_HEALTH_SYNC_ENABLED),
      POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES: parseNumber(config?.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES, 5),
      USAGE_REFRESH_ENABLED: Boolean(config?.USAGE_REFRESH_ENABLED),
      USAGE_REFRESH_INTERVAL_MINUTES: parseNumber(config?.USAGE_REFRESH_INTERVAL_MINUTES, 10),
      USAGE_AUTO_DISABLE: Boolean(config?.USAGE_AUTO_DISABLE),
      USAGE_WARN_THRESHOLD: parseNumber(config?.USAGE_WARN_THRESHOLD, 80),
      USAGE_DISABLE_THRESHOLD: parseNumber(config?.USAGE_DISABLE_THRESHOLD, 95),
      providerFallbackChain: fallbackChainPayload,
      modelFallbackMapping: modelFallbackPayload,
      PROXY_URL: config?.PROXY_URL?.trim() || null,
      PROXY_ENABLED_PROVIDERS: proxyProviders,
      PROXY_POOL_ENABLED: Boolean(config?.PROXY_POOL_ENABLED),
      OAUTH_CALLBACK_HOST: callbackHost,
      OAUTH_CALLBACK_SCHEME: callbackScheme,
      OAUTH_CALLBACK_PORT: callbackPort,
      systemPrompt: config?.systemPrompt || '',
    };

    try {
      setSaving(true);
      await configService.update(payload);

      if (adminPassword.trim()) {
        await configService.updateAdminPassword(adminPassword.trim());
        setAdminPassword('');
      }

      let reloadErrorMessage = '';
      try {
        await configService.reload();
      } catch (reloadError) {
        reloadErrorMessage = extractApiErrorMessage(reloadError, '重载配置失败');
      }

      showSuccess('配置保存成功');
      if (reloadErrorMessage) {
        setError(`配置已保存，但自动重载失败：${reloadErrorMessage}`);
      }
    } catch (saveError) {
      console.error('Failed to save config:', saveError);
      setError(extractApiErrorMessage(saveError, '保存配置失败，请稍后重试'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setAdminPassword('');
    setError('');
    setSuccess('');
    await fetchConfig();
  };

  const handleReload = async () => {
    setReloading(true);
    setError('');
    setSuccess('');
    try {
      await configService.reload();
      await fetchConfig();
      showSuccess('配置已刷新');
    } catch (reloadError) {
      console.error('Failed to reload config:', reloadError);
      setError(reloadError?.message || '刷新配置失败');
    } finally {
      setReloading(false);
    }
  };

  const handleFieldChange = (key) => (event) => {
    const { type, checked, value } = event.target;
    setConfig((prev) => ({
      ...prev,
      [key]: type === 'checkbox' ? checked : value,
    }));
  };

  const toggleProvider = (value) => {
    setSelectedProviders((prev) => {
      if (prev.includes(value)) {
        if (prev.length === 1) {
          setError('至少选择一个模型提供商');
          return prev;
        }
        return prev.filter((item) => item !== value);
      }
      setError('');
      return [...prev, value];
    });
  };

  const toggleProxyProvider = (value) => {
    setProxyProviders((prev) => {
      if (prev.includes(value)) {
        return prev.filter((item) => item !== value);
      }
      return [...prev, value];
    });
  };

  const addProxy = async () => {
    try {
      const parsedNode = parseProxyNodeInput(newProxy.url, newProxy.protocol);
      await proxyPoolService.createNode({
        name: newProxy.name.trim() || `代理 ${proxyPool.length + 1}`,
        ...parsedNode,
      });
      await refreshProxyNodes();
      setNewProxy({ name: '', url: '', protocol: 'http' });
      setError('');
      showSuccess('代理节点添加成功');
    } catch (err) {
      setError(extractApiErrorMessage(err, '添加代理节点失败'));
    }
  };

  const testInputProxy = async () => {
    try {
      setTestingInputProxy(true);
      setError('');
      const parsedNode = parseProxyNodeInput(newProxy.url, newProxy.protocol);
      const result = await proxyPoolService.testNode(parsedNode);
      if (result?.success) {
        const latencyText = result.latency ? `${result.latency}ms` : '--';
        const exitIpText = result.exitIp || '未知';
        showSuccess(`联通正常，延迟 ${latencyText}，出口IP ${exitIpText}`);
      } else {
        setError(result?.message || '代理联通测试失败');
      }
    } catch (err) {
      setError(extractApiErrorMessage(err, '代理联通测试失败'));
    } finally {
      setTestingInputProxy(false);
    }
  };

  const testProxyNode = async (id) => {
    try {
      setTestingNodeIds((prev) => ({ ...prev, [id]: true }));
      setError('');
      const result = await proxyPoolService.testNode({ id });
      if (result?.success) {
        const latencyText = result.latency ? `${result.latency}ms` : '--';
        const exitIpText = result.exitIp || '未知';
        showSuccess(`节点测试通过，延迟 ${latencyText}，出口IP ${exitIpText}`);
      } else {
        setError(result?.message || '节点联通测试失败');
      }
      await refreshProxyNodes();
    } catch (err) {
      setError(extractApiErrorMessage(err, '节点联通测试失败'));
    } finally {
      setTestingNodeIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  const removeProxy = async (id) => {
    try {
      await proxyPoolService.deleteNode(id);
      await refreshProxyNodes();
    } catch (err) {
      setError(extractApiErrorMessage(err, '删除代理节点失败'));
    }
  };

  const toggleProxyEnabled = async (id) => {
    const node = proxyPool.find((p) => p.id === id);
    if (!node) return;
    try {
      await proxyPoolService.updateNode(id, { isEnabled: !node.is_enabled });
      await refreshProxyNodes();
    } catch (err) {
      setError(extractApiErrorMessage(err, '更新代理节点失败'));
    }
  };

  if (loading || !config) {
    return (
      <div className="page-loading">
        <i className="fas fa-spinner fa-spin"></i> 加载中...
      </div>
    );
  }

  return (
    <div className="config">
      <div className="config-header">
        <div>
          <h1>配置管理</h1>
          <p className="config-subtitle">统一管理核心参数与代理策略，保存后自动生效</p>
        </div>
        <div className="config-actions">
          <button className="btn btn-secondary" onClick={handleReload} disabled={saving || reloading}>
            {reloading ? '刷新中...' : '刷新配置'}
          </button>
          <button className="btn btn-secondary" onClick={handleReset} disabled={saving || reloading}>
            重置
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || reloading}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="config-panel">
        <div className="config-form">
          <div className="config-section">
            <h2 className="config-section-title collapsible" onClick={() => setBasicCollapsed(!basicCollapsed)}>
              <i className={`fas fa-chevron-${basicCollapsed ? 'right' : 'down'}`}></i>
              <i className="fas fa-sliders-h"></i>
              基础配置
            </h2>

            {!basicCollapsed && (
            <div className="config-section-content">
            <div className="form-group password-input-group">
              <label htmlFor="apiKey">API 密钥</label>
              <div className="password-input-wrapper">
                <input
                  id="apiKey"
                  type={showApiKey ? 'text' : 'password'}
                  className="form-control"
                  placeholder="请输入 API 密钥"
                  value={config.REQUIRED_API_KEY || ''}
                  onChange={handleFieldChange('REQUIRED_API_KEY')}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowApiKey((prev) => !prev)}
                  aria-label="显示/隐藏密钥"
                >
                  <i className={`fas ${showApiKey ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                </button>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="host">监听地址</label>
                <input
                  id="host"
                  type="text"
                  className="form-control"
                  value={config.HOST || ''}
                  onChange={handleFieldChange('HOST')}
                />
              </div>
              <div className="form-group">
                <label htmlFor="port">端口</label>
                <input
                  id="port"
                  type="number"
                  className="form-control"
                  value={config.SERVER_PORT ?? ''}
                  onChange={handleFieldChange('SERVER_PORT')}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="publicApiBase">对外 API 地址</label>
              <input
                id="publicApiBase"
                type="text"
                className="form-control"
                placeholder="例如: http://your-domain:13000"
                value={config.PUBLIC_API_BASE_URL || ''}
                onChange={handleFieldChange('PUBLIC_API_BASE_URL')}
              />
              <div className="helper-text">用于文档展示外网地址，Docker 端口映射时建议填写</div>
            </div>

            <div className="form-group pool-section">
              <label>模型提供商 (可多选)</label>
              <div className="provider-tags">
                {PROVIDER_OPTIONS.map((provider) => (
                  <button
                    key={provider.value}
                    type="button"
                    className={`provider-tag ${selectedProviders.includes(provider.value) ? 'selected' : ''}`}
                    onClick={() => toggleProvider(provider.value)}
                  >
                    <i className={`fas ${provider.icon}`}></i>
                    <span>{provider.label}</span>
                  </button>
                ))}
              </div>
              <small className="form-text">至少选择一个模型提供商，保存后用于启动初始化。</small>
            </div>
            </div>
            )}
          </div>

          <div className="config-section">
            <h2 className="config-section-title collapsible" onClick={() => setAdvancedCollapsed(!advancedCollapsed)}>
              <i className={`fas fa-chevron-${advancedCollapsed ? 'right' : 'down'}`}></i>
              <i className="fas fa-cogs"></i>
              高级配置
            </h2>

            {!advancedCollapsed && (
            <div className="config-section-content">
            <div className="proxy-config-section">
              <h4>
                <i className="fas fa-globe"></i>
                代理设置
              </h4>
              <div className="form-group">
                <label htmlFor="proxyUrl">代理地址</label>
                <input
                  id="proxyUrl"
                  type="text"
                  className="form-control"
                  placeholder="例如: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  value={config.PROXY_URL || ''}
                  onChange={handleFieldChange('PROXY_URL')}
                />
                <small className="form-text">支持 HTTP / HTTPS / SOCKS5，留空表示不使用代理。</small>
              </div>
              <div className="form-group pool-section">
                <label>启用代理的提供商</label>
                <div className="provider-tags">
                  {PROXY_PROVIDER_OPTIONS.map((provider) => (
                    <button
                      key={provider.value}
                      type="button"
                      className={`provider-tag ${proxyProviders.includes(provider.value) ? 'selected' : ''}`}
                      onClick={() => toggleProxyProvider(provider.value)}
                    >
                      <i className={`fas ${provider.icon}`}></i>
                      <span>{provider.label}</span>
                    </button>
                  ))}
                </div>
                <small className="form-text">只为选中的提供商启用代理，其余保持直连。</small>
              </div>
            </div>

            <div className="proxy-config-section">
              <h4>
                <i className="fas fa-link"></i>
                OAuth 回调设置
              </h4>
              <div className="form-group">
                <label htmlFor="oauthCallbackHost">回调域名/公网 IP</label>
                <input
                  id="oauthCallbackHost"
                  type="text"
                  className="form-control"
                  placeholder="例如: accounthub.example.com"
                  value={config.OAUTH_CALLBACK_HOST || ''}
                  onChange={handleFieldChange('OAUTH_CALLBACK_HOST')}
                />
                <small className="form-text">留空使用自动检测或环境变量。</small>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="oauthCallbackScheme">回调协议</label>
                  <select
                    id="oauthCallbackScheme"
                    className="form-control"
                    value={config.OAUTH_CALLBACK_SCHEME || 'http'}
                    onChange={handleFieldChange('OAUTH_CALLBACK_SCHEME')}
                  >
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="oauthCallbackPort">回调端口</label>
                  <input
                    id="oauthCallbackPort"
                    type="number"
                    className="form-control"
                    placeholder="留空表示 80/443"
                    value={config.OAUTH_CALLBACK_PORT ?? ''}
                    onChange={handleFieldChange('OAUTH_CALLBACK_PORT')}
                  />
                </div>
              </div>
              <small className="form-text">使用域名 + https 时，端口留空或 443，需通过 Nginx 转发到本地回调端口。</small>
            </div>

            <div className="config-row">
              <div className="form-group">
                <label htmlFor="systemPromptMode">系统提示模式</label>
                <select
                  id="systemPromptMode"
                  className="form-control"
                  value={config.SYSTEM_PROMPT_MODE || 'append'}
                  onChange={handleFieldChange('SYSTEM_PROMPT_MODE')}
                >
                  <option value="append">追加 (append)</option>
                  <option value="overwrite">覆盖 (overwrite)</option>
                </select>
                <small className="form-text">系统提示从数据库加载，可在下方配置。</small>
              </div>
            </div>

            <div className="config-row">
              <div className="form-group">
                <label htmlFor="promptLogBaseName">提示日志基础名称</label>
                <input
                  id="promptLogBaseName"
                  type="text"
                  className="form-control"
                  placeholder="例如: prompt_log"
                  value={config.PROMPT_LOG_BASE_NAME || ''}
                  onChange={handleFieldChange('PROMPT_LOG_BASE_NAME')}
                />
              </div>
              <div className="form-group">
                <label htmlFor="promptLogMode">提示日志模式</label>
                <select
                  id="promptLogMode"
                  className="form-control"
                  value={config.PROMPT_LOG_MODE || 'none'}
                  onChange={handleFieldChange('PROMPT_LOG_MODE')}
                >
                  <option value="none">无 (none)</option>
                  <option value="console">控制台 (console)</option>
                  <option value="file">文件 (file)</option>
                </select>
              </div>
            </div>

            <div className="form-group pool-section">
              <label htmlFor="providerFallbackChain">跨类型 Fallback 链配置</label>
              <textarea
                id="providerFallbackChain"
                className={`form-control config-textarea ${jsonErrors.fallback ? 'config-textarea-error' : ''}`}
                rows="6"
                placeholder={`例如:\n{\n  \"gemini-cli-oauth\": [\"gemini-antigravity\"],\n  \"gemini-antigravity\": [\"gemini-cli-oauth\"]\n}`}
                value={providerFallbackChain}
                onChange={(event) => {
                  setProviderFallbackChain(event.target.value);
                  if (jsonErrors.fallback) {
                    setJsonErrors((prev) => ({ ...prev, fallback: '' }));
                  }
                }}
              ></textarea>
              {jsonErrors.fallback && <div className="config-error-text">{jsonErrors.fallback}</div>}
              <small className="form-text">JSON 格式，键为主类型，值为降级链数组。</small>
            </div>

            <div className="form-group pool-section">
              <label htmlFor="modelFallbackMapping">跨协议模型映射</label>
              <textarea
                id="modelFallbackMapping"
                className={`form-control config-textarea ${jsonErrors.model ? 'config-textarea-error' : ''}`}
                rows="6"
                placeholder={`例如:\n{\n  \"gemini-claude-opus-4-5-thinking\": {\n    \"targetProviderType\": \"claude-kiro-oauth\",\n    \"targetModel\": \"claude-opus-4-5\"\n  }\n}`}
                value={modelFallbackMapping}
                onChange={(event) => {
                  setModelFallbackMapping(event.target.value);
                  if (jsonErrors.model) {
                    setJsonErrors((prev) => ({ ...prev, model: '' }));
                  }
                }}
              ></textarea>
              {jsonErrors.model && <div className="config-error-text">{jsonErrors.model}</div>}
              <small className="form-text">JSON 格式，用于跨协议模型路由与兜底。</small>
            </div>

            <div className="form-group system-prompt-section">
              <label htmlFor="systemPrompt">系统提示</label>
              <textarea
                id="systemPrompt"
                className="form-control"
                rows="4"
                placeholder="输入系统提示..."
                value={config.systemPrompt || ''}
                onChange={handleFieldChange('systemPrompt')}
              ></textarea>
            </div>

            <div className="form-group pool-section">
              <label htmlFor="adminPassword">后台登录密码</label>
              <div className="password-input-wrapper">
                <input
                  id="adminPassword"
                  type={showAdminPassword ? 'text' : 'password'}
                  className="form-control"
                  placeholder="设置后台登录密码（留空则不修改）"
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowAdminPassword((prev) => !prev)}
                  aria-label="显示/隐藏密码"
                >
                  <i className={`fas ${showAdminPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                </button>
              </div>
              <small className="form-text">修改后需要重新登录管理控制台。</small>
            </div>
            </div>
            )}
          </div>

          <div className="config-section">
            <h2 className="config-section-title collapsible" onClick={() => setMonitoringCollapsed(!monitoringCollapsed)}>
              <i className={`fas fa-chevron-${monitoringCollapsed ? 'right' : 'down'}`}></i>
              <i className="fas fa-heartbeat"></i>
              监测配置
            </h2>

            {!monitoringCollapsed && (
            <div className="config-section-content">
              <div className="monitoring-group">
                <div className="monitoring-group-title">
                  <i className="fas fa-clock"></i>
                  定时任务
                </div>
                <div className="monitoring-task-list">
                  <div className="monitoring-task">
                    <div className="monitoring-task-info">
                      <div className="monitoring-task-title">号池健康检查 + 临期刷新</div>
                      <div className="monitoring-task-desc">定时检查账号状态，并处理临期 token 刷新。</div>
                    </div>
                    <div className="monitoring-task-controls">
                      <div className="monitoring-task-field">
                        <label htmlFor="providerHealthCheckInterval">间隔(分钟)</label>
                        <input
                          id="providerHealthCheckInterval"
                          type="number"
                          className="form-control input-compact"
                          min="1"
                          max="120"
                          value={config.PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES ?? 5}
                          onChange={handleFieldChange('PROVIDER_HEALTH_CHECK_INTERVAL_MINUTES')}
                        />
                      </div>
                      <div className="monitoring-task-switch">
                        <span>启用</span>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={Boolean(config.PROVIDER_HEALTH_CHECK_ENABLED)}
                            onChange={handleFieldChange('PROVIDER_HEALTH_CHECK_ENABLED')}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="monitoring-task">
                    <div className="monitoring-task-info">
                      <div className="monitoring-task-title">OAuth 自动刷新</div>
                      <div className="monitoring-task-desc">周期性刷新 OAuth 凭据，保存后生效。</div>
                    </div>
                    <div className="monitoring-task-controls">
                      <div className="monitoring-task-field">
                        <label htmlFor="cronNearMinutes">间隔(分钟)</label>
                        <input
                          id="cronNearMinutes"
                          type="number"
                          className="form-control input-compact"
                          min="1"
                          max="60"
                          value={config.CRON_NEAR_MINUTES ?? 1}
                          onChange={handleFieldChange('CRON_NEAR_MINUTES')}
                        />
                      </div>
                      <div className="monitoring-task-switch">
                        <span>启用</span>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={Boolean(config.CRON_REFRESH_TOKEN)}
                            onChange={handleFieldChange('CRON_REFRESH_TOKEN')}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="monitoring-task">
                    <div className="monitoring-task-info">
                      <div className="monitoring-task-title">Potluck 健康同步</div>
                      <div className="monitoring-task-desc">同步 Potluck 凭据健康状态（启用插件时生效）。</div>
                    </div>
                    <div className="monitoring-task-controls">
                      <div className="monitoring-task-field">
                        <label htmlFor="potluckHealthInterval">间隔(分钟)</label>
                        <input
                          id="potluckHealthInterval"
                          type="number"
                          className="form-control input-compact"
                          min="1"
                          max="120"
                          value={config.POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES ?? 5}
                          onChange={handleFieldChange('POTLUCK_HEALTH_CHECK_INTERVAL_MINUTES')}
                        />
                      </div>
                      <div className="monitoring-task-switch">
                        <span>启用</span>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={Boolean(config.POTLUCK_HEALTH_SYNC_ENABLED)}
                            onChange={handleFieldChange('POTLUCK_HEALTH_SYNC_ENABLED')}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="monitoring-task">
                    <div className="monitoring-task-info">
                      <div className="monitoring-task-title">登录 Token 清理</div>
                      <div className="monitoring-task-desc">清理过期登录 token，减轻表压力。</div>
                    </div>
                    <div className="monitoring-task-controls">
                      <div className="monitoring-task-field">
                        <label htmlFor="authCleanupInterval">间隔(分钟)</label>
                        <input
                          id="authCleanupInterval"
                          type="number"
                          className="form-control input-compact"
                          min="1"
                          max="60"
                          value={config.AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES ?? 5}
                          onChange={handleFieldChange('AUTH_TOKEN_CLEANUP_INTERVAL_MINUTES')}
                        />
                      </div>
                      <div className="monitoring-task-switch">
                        <span>启用</span>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={Boolean(config.AUTH_TOKEN_CLEANUP_ENABLED)}
                            onChange={handleFieldChange('AUTH_TOKEN_CLEANUP_ENABLED')}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="monitoring-task">
                    <div className="monitoring-task-info">
                      <div className="monitoring-task-title">用量定时刷新</div>
                      <div className="monitoring-task-desc">定时刷新所有渠道的额度用量信息。</div>
                    </div>
                    <div className="monitoring-task-controls">
                      <div className="monitoring-task-field">
                        <label htmlFor="usageRefreshInterval">间隔(分钟)</label>
                        <input
                          id="usageRefreshInterval"
                          type="number"
                          className="form-control input-compact"
                          min="1"
                          max="120"
                          value={config.USAGE_REFRESH_INTERVAL_MINUTES ?? 10}
                          onChange={handleFieldChange('USAGE_REFRESH_INTERVAL_MINUTES')}
                        />
                      </div>
                      <div className="monitoring-task-switch">
                        <span>启用</span>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={Boolean(config.USAGE_REFRESH_ENABLED)}
                            onChange={handleFieldChange('USAGE_REFRESH_ENABLED')}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="monitoring-group">
                <div className="monitoring-group-title">
                  <i className="fas fa-redo"></i>
                  重试与切换
                </div>
                <div className="monitoring-fields">
                  <div className="form-group compact">
                    <label htmlFor="requestMaxRetries">最大重试次数</label>
                    <input
                      id="requestMaxRetries"
                      type="number"
                      className="form-control input-compact"
                      min="0"
                      max="10"
                      value={config.REQUEST_MAX_RETRIES ?? 3}
                      onChange={handleFieldChange('REQUEST_MAX_RETRIES')}
                    />
                  </div>
                  <div className="form-group compact">
                    <label htmlFor="requestBaseDelay">重试基础延迟 (毫秒)</label>
                    <input
                      id="requestBaseDelay"
                      type="number"
                      className="form-control input-compact"
                      min="0"
                      step="100"
                      value={config.REQUEST_BASE_DELAY ?? 1000}
                      onChange={handleFieldChange('REQUEST_BASE_DELAY')}
                    />
                  </div>
                  <div className="form-group compact">
                    <label htmlFor="credentialSwitchMaxRetries">坏凭证切换最大重试次数</label>
                    <input
                      id="credentialSwitchMaxRetries"
                      type="number"
                      className="form-control input-compact"
                      min="1"
                      max="50"
                      value={config.CREDENTIAL_SWITCH_MAX_RETRIES ?? 5}
                      onChange={handleFieldChange('CREDENTIAL_SWITCH_MAX_RETRIES')}
                    />
                    <small className="form-text">认证错误后自动切换凭证，默认 5 次。</small>
                  </div>
                </div>
              </div>

              <div className="monitoring-group">
                <div className="monitoring-group-title">
                  <i className="fas fa-heartbeat"></i>
                  健康与用量阈值
                </div>
                <div className="monitoring-fields">
                  <div className="form-group compact">
                    <label htmlFor="maxErrorCount">提供商最大错误次数</label>
                    <input
                      id="maxErrorCount"
                      type="number"
                      className="form-control input-compact"
                      min="1"
                      max="10"
                      value={config.MAX_ERROR_COUNT ?? 3}
                      onChange={handleFieldChange('MAX_ERROR_COUNT')}
                    />
                    <small className="form-text">连续错误达到此次数后标记为不健康。</small>
                  </div>
                  <div className="form-group compact">
                    <label htmlFor="usageWarnThreshold">告警阈值 (%)</label>
                    <input
                      id="usageWarnThreshold"
                      type="number"
                      className="form-control input-compact"
                      min="0"
                      max="100"
                      value={config.USAGE_WARN_THRESHOLD ?? 80}
                      onChange={handleFieldChange('USAGE_WARN_THRESHOLD')}
                    />
                  </div>
                  <div className="form-group compact">
                    <label htmlFor="usageDisableThreshold">禁用阈值 (%)</label>
                    <input
                      id="usageDisableThreshold"
                      type="number"
                      className="form-control input-compact"
                      min="0"
                      max="100"
                      value={config.USAGE_DISABLE_THRESHOLD ?? 95}
                      onChange={handleFieldChange('USAGE_DISABLE_THRESHOLD')}
                    />
                  </div>
                  <div className="form-group compact monitoring-span">
                    <label>达到禁用阈值自动禁用账号</label>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={Boolean(config.USAGE_AUTO_DISABLE)}
                        onChange={handleFieldChange('USAGE_AUTO_DISABLE')}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <small className="form-text">按百分比计算，按单账号最紧张的模型配额触发。</small>
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>

          <div className="config-section">
            <h2 className="config-section-title collapsible" onClick={() => setProxyPoolCollapsed(!proxyPoolCollapsed)}>
              <i className={`fas fa-chevron-${proxyPoolCollapsed ? 'right' : 'down'}`}></i>
              <i className="fas fa-network-wired"></i>
              代理池配置
            </h2>

            {!proxyPoolCollapsed && (
            <div className="config-section-content">
              <div className="proxy-pool-global-switch">
                <div className="form-group">
                  <label>启用代理池</label>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={Boolean(config.PROXY_POOL_ENABLED)}
                      onChange={handleFieldChange('PROXY_POOL_ENABLED')}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                  <small className="form-text">全局开关，关闭后所有号池都不走代理。开启后需在号池设置中单独启用。</small>
                </div>
              </div>

              <div className="proxy-pool-info">
                <div className="proxy-pool-tips">
                  <i className="fas fa-lightbulb"></i>
                  <div className="tips-content">
                    <strong>使用教程：</strong>
                    <span>1. 添加多个静态住宅IP代理节点 2. 开启全局代理池开关 3. 在号池设置中启用"使用代理池" 4. 系统将自动轮询使用代理节点发送请求</span>
                  </div>
                </div>
              </div>

              <div className="proxy-pool-add">
                <div className="form-row">
                  <div className="form-group">
                    <label>名称</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="代理名称（可选）"
                      value={newProxy.name}
                      onChange={(e) => setNewProxy({ ...newProxy, name: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>协议</label>
                    <CustomSelect
                      value={newProxy.protocol}
                      onChange={(val) => setNewProxy({ ...newProxy, protocol: val })}
                      options={[
                        { value: 'http', label: 'HTTP' },
                        { value: 'https', label: 'HTTPS' },
                        { value: 'socks5', label: 'SOCKS5' },
                      ]}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>代理地址</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="支持 host:port / host:port:user:pass / http(s)://user:pass@host:port"
                      value={newProxy.url}
                      onChange={(e) => setNewProxy({ ...newProxy, url: e.target.value })}
                    />
                    <small className="form-text">示例：`185.124.58.121:12323:username:password`</small>
                  </div>
                  <div className="proxy-add-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={testInputProxy}
                      style={{ alignSelf: 'flex-end', marginBottom: '1rem' }}
                      disabled={testingInputProxy}
                    >
                      <i className={`fas ${testingInputProxy ? 'fa-spinner fa-spin' : 'fa-plug'}`}></i>
                      {testingInputProxy ? ' 测试中...' : ' 测试联通'}
                    </button>
                    <button className="btn btn-primary" onClick={addProxy} style={{ alignSelf: 'flex-end', marginBottom: '1rem' }}>
                      <i className="fas fa-plus"></i> 添加
                    </button>
                  </div>
                </div>
              </div>

              {proxyPool.length > 0 && (
              <div className="proxy-pool-list">
                <table className="proxy-table">
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>名称</th>
                      <th>协议</th>
                      <th>地址</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxyPool.map((proxy) => (
                      <tr key={proxy.id} className={proxy.is_enabled ? '' : 'disabled'}>
                        <td>
                          <label className="toggle-switch small">
                            <input type="checkbox" checked={proxy.is_enabled} onChange={() => toggleProxyEnabled(proxy.id)} />
                            <span className="toggle-slider"></span>
                          </label>
                        </td>
                        <td>{proxy.name}</td>
                        <td><span className={`protocol-badge ${proxy.protocol}`}>{proxy.protocol.toUpperCase()}</span></td>
                        <td className="proxy-url">{formatProxyAddress(proxy)}</td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => testProxyNode(proxy.id)}
                            disabled={Boolean(testingNodeIds[proxy.id])}
                            style={{ marginRight: '0.375rem' }}
                          >
                            <i className={`fas ${testingNodeIds[proxy.id] ? 'fa-spinner fa-spin' : 'fa-vial'}`}></i>
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => removeProxy(proxy.id)}>
                            <i className="fas fa-trash"></i>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}

              {proxyPool.length === 0 && (
              <div className="proxy-pool-empty">
                <i className="fas fa-info-circle"></i> 暂无代理节点，请添加代理
              </div>
              )}
            </div>
            )}
          </div>

          <div className="form-actions">
            <button className="btn btn-success" onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存配置'}
            </button>
            <button className="btn btn-secondary" onClick={handleReset} disabled={saving}>
              重置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
