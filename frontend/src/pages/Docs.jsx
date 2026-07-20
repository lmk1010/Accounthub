/**
 * API 文档页面
 */

import { useEffect, useMemo, useState } from 'react';
import { configService } from '../services/config.service';
import './Docs.css';

const PROVIDERS = [
  {
    id: 'gemini-cli-oauth',
    name: 'Gemini CLI OAuth',
    icon: 'fas fa-gem',
    badge: { text: '突破限制', tone: 'oauth' },
    model: 'gemini-2.0-flash-exp',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'gemini-antigravity',
    name: 'Gemini Antigravity',
    icon: 'fas fa-rocket',
    badge: { text: '突破限制/实验性', tone: 'oauth' },
    model: 'gemini-3-pro-preview',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'claude-custom',
    name: 'Claude Custom',
    icon: 'fas fa-brain',
    badge: { text: '官方API/三方', tone: 'official' },
    model: 'claude-3-sonnet-20240229',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'claude-kiro-oauth',
    name: 'Claude Kiro OAuth',
    icon: 'fas fa-robot',
    badge: { text: '突破限制/免费使用', tone: 'oauth' },
    model: 'claude-3-5-sonnet-20241022',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'claude-warp-oauth',
    name: 'Warp AI OAuth',
    icon: 'fas fa-bolt',
    badge: { text: 'Warp AI', tone: 'oauth' },
    model: 'warp-ai',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'openai-custom',
    name: 'OpenAI Custom',
    icon: 'fas fa-comments',
    badge: { text: '官方API/三方', tone: 'official' },
    model: 'gpt-4',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    name: 'Qwen OAuth',
    icon: 'fas fa-code',
    badge: { text: '突破限制', tone: 'oauth' },
    model: 'qwen-turbo',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex OAuth',
    icon: 'fas fa-terminal',
    badge: { text: 'Codex OAuth', tone: 'oauth' },
    model: 'gpt-5-codex',
    protocols: ['responses'],
    defaultProtocol: 'responses',
  },
  {
    name: 'iFlow OAuth',
    icon: 'fas fa-wind',
    badge: { text: '突破限制', tone: 'oauth' },
    model: 'qwen3-max',
    protocols: ['openai', 'claude', 'responses'],
  },
  {
    id: 'claude-orchids-oauth',
    name: 'Orchids OAuth',
    icon: 'fas fa-seedling',
    badge: { text: '突破限制/免费使用', tone: 'oauth' },
    model: 'claude-sonnet-4-5',
    protocols: ['openai', 'claude', 'responses'],
  },
];

const buildOpenaiCurl = (baseUrl, providerId, model) => {
  const endpoint = `/${providerId}/v1/chat/completions`;
  return `curl ${baseUrl}${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1000
  }'`;
};

const buildClaudeCurl = (baseUrl, providerId, model, maxTokens = 1000) => {
  const endpoint = `/${providerId}/v1/messages`;
  return `curl ${baseUrl}${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": ${maxTokens},
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
};

const buildResponsesCurl = (baseUrl, providerId, model) => {
  const endpoint = `/${providerId}/v1/responses`;
  return `curl ${baseUrl}${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "Hello!"
  }'`;
};

const getBaseUrlFromConfig = (rawConfig) => {
  const publicBase = rawConfig?.PUBLIC_API_BASE_URL || rawConfig?.publicApiBaseUrl || rawConfig?.PUBLIC_BASE_URL;
  if (publicBase && typeof publicBase === 'string') {
    return publicBase.replace(/\/+$/, '');
  }
  const host = rawConfig?.HOST || rawConfig?.host || '127.0.0.1';
  const port = rawConfig?.SERVER_PORT || rawConfig?.PORT || 3000;
  const protocol = window.location.protocol || 'http:';
  const hostname = (host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost')
    ? window.location.hostname
    : host;
  const withPort = hostname.includes(':') ? hostname : `${hostname}:${port}`;
  return `${protocol}//${withPort}`;
};

export default function Docs() {
  const [baseUrl, setBaseUrl] = useState(`${window.location.protocol}//${window.location.hostname}:3000`);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [openProviders, setOpenProviders] = useState(() => new Set([PROVIDERS[0]?.id].filter(Boolean)));
  const [tipsOpen, setTipsOpen] = useState(true);
  const [activeProtocol, setActiveProtocol] = useState(() => {
    return PROVIDERS.reduce((acc, provider) => {
      acc[provider.id] = provider.defaultProtocol || 'claude';
      return acc;
    }, {});
  });

  useEffect(() => {
    let isMounted = true;
    const fetchConfig = async () => {
      try {
        setLoading(true);
        const data = await configService.get();
        const rawConfig = data?.data || data?.config || data || {};
        if (isMounted) {
          setBaseUrl(getBaseUrlFromConfig(rawConfig));
        }
      } catch (error) {
        console.error('加载配置失败:', error);
        if (isMounted) {
          setLoadError('无法读取后端配置，已使用默认地址');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };
    fetchConfig();
    return () => {
      isMounted = false;
    };
  }, []);

  const providerBlocks = useMemo(() => {
    return PROVIDERS.map((provider) => {
      const protocols = provider.protocols || ['openai', 'claude'];
      const fallbackProtocol = protocols.includes('claude') ? 'claude' : protocols[0];
      const protocol = activeProtocol[provider.id] || provider.defaultProtocol || fallbackProtocol;
      const openaiEndpoint = `/${provider.id}/v1/chat/completions`;
      const claudeEndpoint = `/${provider.id}/v1/messages`;
      const responsesEndpoint = `/${provider.id}/v1/responses`;
      const openaiCurl = buildOpenaiCurl(baseUrl, provider.id, provider.model);
      const claudeMaxTokens = provider.id === 'claude-orchids-oauth' ? 8192 : 1000;
      const claudeCurl = buildClaudeCurl(baseUrl, provider.id, provider.model, claudeMaxTokens);
      const responsesCurl = buildResponsesCurl(baseUrl, provider.id, provider.model);
      const endpointMap = {
        openai: openaiEndpoint,
        claude: claudeEndpoint,
        responses: responsesEndpoint,
      };
      const curlMap = {
        openai: openaiCurl,
        claude: claudeCurl,
        responses: responsesCurl,
      };
      const exampleLabelMap = {
        openai: '使用示例 (OpenAI 格式)',
        claude: '使用示例 (Claude 格式)',
        responses: '使用示例 (Responses 格式)',
      };
      return {
        ...provider,
        protocol,
        protocols,
        openaiEndpoint,
        claudeEndpoint,
        responsesEndpoint,
        openaiCurl,
        claudeCurl,
        responsesCurl,
        endpointMap,
        curlMap,
        exampleLabelMap,
      };
    });
  }, [activeProtocol, baseUrl]);

  const handleProtocolChange = (providerId, protocol) => {
    setActiveProtocol((prev) => ({ ...prev, [providerId]: protocol }));
  };

  const handleProviderToggle = (providerId, isOpen) => {
    setOpenProviders((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.add(providerId);
      } else {
        next.delete(providerId);
      }
      return next;
    });
  };

  return (
    <div className="docs-page">
      <div className="docs-header">
        <div>
          <h1>API 文档</h1>
          <p className="docs-subtitle">路径路由快速调用示例，支持 OpenAI / Claude / Responses 协议</p>
        </div>
      </div>

      {loadError && <div className="alert alert-warning">{loadError}</div>}

      <div className="docs-panel">
        <div className="docs-base-info">
          <div className="base-row">
            <span className="base-label">服务地址</span>
            <span className="base-value">{loading ? '读取中...' : baseUrl}</span>
          </div>
          <div className="base-row">
            <span className="base-label">认证方式</span>
            <span className="base-value">Authorization: Bearer YOUR_API_KEY / X-API-Key: YOUR_API_KEY</span>
          </div>
        </div>

        <div className="docs-provider-list">
          {providerBlocks.map((provider) => (
            <details
              className="docs-provider"
              key={provider.id}
              open={openProviders.has(provider.id)}
              onToggle={(event) => handleProviderToggle(provider.id, event.currentTarget.open)}
            >
              <summary className="docs-provider-summary">
                <div className="provider-title">
                  <i className={provider.icon}></i>
                  <span>{provider.name}</span>
                </div>
                <span className={`provider-badge ${provider.badge.tone}`}>{provider.badge.text}</span>
              </summary>
              <div className="docs-provider-body">
                <div className="protocol-tabs">
                  {provider.protocols.map((protocolKey) => {
                    const labelMap = {
                      openai: 'OpenAI 协议',
                      claude: 'Claude 协议',
                      responses: 'Responses 协议',
                    };
                    return (
                      <button
                        key={protocolKey}
                        className={`protocol-tab ${provider.protocol === protocolKey ? 'active' : ''}`}
                        onClick={() => handleProtocolChange(provider.id, protocolKey)}
                        type="button"
                      >
                        {labelMap[protocolKey] || protocolKey}
                      </button>
                    );
                  })}
                </div>

                <>
                  <div className="endpoint-info">
                    <label>端点路径</label>
                    <code className="endpoint-path">{provider.endpointMap[provider.protocol]}</code>
                  </div>
                  <div className="usage-example">
                    <label>{provider.exampleLabelMap[provider.protocol]}</label>
                    <pre><code>{provider.curlMap[provider.protocol]}</code></pre>
                  </div>
                </>
              </div>
            </details>
          ))}
        </div>

        <details className="docs-tips" open={tipsOpen} onToggle={(event) => setTipsOpen(event.currentTarget.open)}>
          <summary>使用提示</summary>
          <ul>
            <li><strong>即时切换:</strong> 修改 URL 路径即可切换不同的 AI 模型提供商</li>
            <li><strong>客户端配置:</strong> Cherry-Studio、NextChat、Cline 等客户端设置 API 端点为对应路径</li>
            <li><strong>跨协议调用:</strong> 支持 OpenAI 协议调用 Claude 模型，或 Claude 协议调用 OpenAI 模型</li>
            <li><strong>Responses 协议:</strong> Codex 使用 /v1/responses 端点</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
