/**
 * Potluck user page
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { potluckUserService } from '../services/potluck.service';
import './PotluckUser.css';

const formatTime = (value) => {
  if (!value) return '--';
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch (error) {
    return value;
  }
};

const formatNumber = (value) => {
  if (value === null || value === undefined) return '--';
  return Number(value).toLocaleString('zh-CN');
};

const copyText = async (text) => {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (error) {
    return false;
  }
};

const getHealthLabel = (value) => {
  if (value === true) return { label: '健康', className: 'healthy' };
  if (value === false) return { label: '异常', className: 'unhealthy' };
  return { label: '未知', className: 'unknown' };
};

export default function PotluckUser() {
  const [apiKey, setApiKey] = useState('');
  const [rememberKey, setRememberKey] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [usage, setUsage] = useState(null);
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [tokensText, setTokensText] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [importState, setImportState] = useState({ status: 'idle', total: 0, success: 0, failed: 0, logs: [] });
  const [awsJson, setAwsJson] = useState('');
  const logRef = useRef(null);

  const refreshUsage = async (key = apiKey) => {
    const { ok, payload } = await potluckUserService.getUsage(key);
    if (!ok) {
      throw new Error(payload?.error?.message || '获取用量失败');
    }
    setUsage(payload?.data || null);
  };

  const refreshCredentials = async (key = apiKey) => {
    const { ok, payload } = await potluckUserService.getCredentials(key);
    if (!ok) {
      throw new Error(payload?.error?.message || '获取凭据失败');
    }
    setCredentials(payload?.data || []);
  };

  const handleLogin = async (keyValue) => {
    const inputKey = (keyValue || apiKey).trim();
    if (!inputKey) {
      setError('请输入 API Key');
      return;
    }

    setLoading(true);
    setError('');
    setNotice('');

    try {
      await refreshUsage(inputKey);
      await refreshCredentials(inputKey);
      setApiKey(inputKey);
      setLoggedIn(true);
      if (rememberKey) {
        localStorage.setItem('potluck_user_key', inputKey);
      }
    } catch (err) {
      setError(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('potluck_user_key');
    setLoggedIn(false);
    setApiKey('');
    setUsage(null);
    setCredentials([]);
    setNotice('已退出登录');
  };

  const handleCheckAll = async () => {
    setLoading(true);
    setError('');
    try {
      const { ok, payload } = await potluckUserService.checkAllCredentials(apiKey);
      if (!ok) {
        throw new Error(payload?.error?.message || '健康检查失败');
      }
      const updated = payload?.data?.credentials || payload?.data || [];
      setCredentials(updated);
      setNotice('已更新全部凭据健康状态');
    } catch (err) {
      setError(err.message || '健康检查失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOne = async (credentialId) => {
    setLoading(true);
    setError('');
    try {
      const { ok, payload } = await potluckUserService.checkCredential(apiKey, credentialId);
      if (!ok) {
        throw new Error(payload?.error?.message || '健康检查失败');
      }
      const result = payload?.data;
      setCredentials((prev) => prev.map((cred) => (
        cred.id === credentialId
          ? { ...cred, isHealthy: result?.isHealthy, healthMessage: result?.message }
          : cred
      )));
    } catch (err) {
      setError(err.message || '健康检查失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerateKey = async () => {
    if (!window.confirm('确认重置 Key？旧 Key 将失效。')) return;
    setLoading(true);
    setError('');
    try {
      const { ok, payload } = await potluckUserService.regenerateKey(apiKey);
      if (!ok) {
        throw new Error(payload?.error?.message || '重置失败');
      }
      const newKey = payload?.data?.newKey;
      if (newKey) {
        setApiKey(newKey);
        localStorage.setItem('potluck_user_key', newKey);
        await refreshUsage(newKey);
        await refreshCredentials(newKey);
        setNotice('Key 已重置');
      }
    } catch (err) {
      setError(err.message || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImport = async () => {
    const tokens = tokensText.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length) {
      setError('请先输入 refreshToken');
      return;
    }

    setImportState({ status: 'running', total: tokens.length, success: 0, failed: 0, logs: [] });
    setError('');

    try {
      const response = await potluckUserService.streamBatchImport(apiKey, tokens, region);
      if (!response.ok || !response.body) {
        const payload = await response.json();
        throw new Error(payload?.error?.message || payload?.error || '导入失败');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      const processChunk = (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        parts.forEach((part) => {
          const lines = part.split('\n');
          let event = 'message';
          const dataLines = [];
          lines.forEach((line) => {
            if (line.startsWith('event:')) {
              event = line.replace('event:', '').trim();
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.replace('data:', '').trim());
            }
          });
          if (!dataLines.length) return;
          let data = null;
          try {
            data = JSON.parse(dataLines.join(''));
          } catch (err) {
            return;
          }

          if (event === 'start') {
            setImportState((prev) => ({ ...prev, total: data.total || prev.total }));
          } else if (event === 'progress') {
            setImportState((prev) => ({
              ...prev,
              success: data.successCount ?? prev.success,
              failed: data.failedCount ?? prev.failed,
              logs: [
                {
                  index: data.current?.index,
                  success: data.current?.success,
                  message: data.current?.success ? data.current?.path : data.current?.error,
                },
                ...prev.logs,
              ].slice(0, 50),
            }));
          } else if (event === 'complete') {
            setImportState((prev) => ({
              ...prev,
              status: 'done',
              success: data.successCount ?? prev.success,
              failed: data.failedCount ?? prev.failed,
            }));
            refreshCredentials();
          } else if (event === 'error') {
            setImportState((prev) => ({ ...prev, status: 'error' }));
            setError(data?.error || '导入失败');
          }
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        processChunk(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      setError(err.message || '导入失败');
      setImportState((prev) => ({ ...prev, status: 'error' }));
    }
  };

  const handleAwsImport = async () => {
    if (!awsJson.trim()) {
      setError('请粘贴 AWS 凭据 JSON');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const credentials = JSON.parse(awsJson);
      const { ok, payload } = await potluckUserService.importAwsCredentials(apiKey, credentials);
      if (!ok) {
        throw new Error(payload?.error?.message || payload?.error || '导入失败');
      }
      setNotice('AWS 凭据导入成功');
      await refreshCredentials();
    } catch (err) {
      setError(err.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const savedKey = localStorage.getItem('potluck_user_key');
    if (savedKey) {
      setApiKey(savedKey);
      handleLogin(savedKey);
    }
  }, []);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = 0;
  }, [importState.logs]);

  const usagePercent = useMemo(() => usage?.usage?.percent || 0, [usage]);

  if (!loggedIn) {
    return (
      <div className="potluck-user-page">
        <div className="potluck-user-card login-card">
          <h1>分发用户</h1>
          <p>输入你的 API Key 查看用量与凭据</p>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="login-form">
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="maki_xxx"
            />
            <label className="remember-line">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(event) => setRememberKey(event.target.checked)}
              />
              记住 Key
            </label>
            <button className="btn btn-primary" onClick={() => handleLogin()} disabled={loading}>
              {loading ? '验证中...' : '登录'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="potluck-user-page">
      <div className="potluck-user-header">
        <div>
          <h1>分发用户</h1>
          <p>用量、凭据与导入工具</p>
        </div>
        <div className="potluck-user-actions">
          <button className="btn btn-outline" onClick={() => refreshUsage()} disabled={loading}>
            <i className="fas fa-sync-alt"></i>
            刷新用量
          </button>
          <button className="btn btn-outline" onClick={handleLogout}>
            <i className="fas fa-sign-out-alt"></i>
            退出
          </button>
        </div>
      </div>

      {notice && <div className="alert alert-info">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="potluck-user-tabs">
        {['overview', 'credentials', 'kiro', 'aws', 'apikey'].map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' && '用量概览'}
            {tab === 'credentials' && '凭据管理'}
            {tab === 'kiro' && 'Kiro 导入'}
            {tab === 'aws' && 'AWS 凭据'}
            {tab === 'apikey' && 'API Key'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="potluck-user-card">
          <div className="card-header">
            <h2>用量概览</h2>
            <button className="btn btn-outline btn-sm" onClick={() => refreshUsage()}>
              刷新
            </button>
          </div>
          <div className="usage-grid">
            <div className="usage-card">
              <span className="label">今日使用</span>
              <span className="value">{formatNumber(usage?.usage?.today || 0)}</span>
            </div>
            <div className="usage-card">
              <span className="label">每日限额</span>
              <span className="value">{formatNumber(usage?.usage?.limit || 0)}</span>
            </div>
            <div className="usage-card">
              <span className="label">剩余额度</span>
              <span className="value">{formatNumber(usage?.usage?.remaining || 0)}</span>
            </div>
            <div className="usage-card">
              <span className="label">资源包剩余</span>
              <span className="value">{formatNumber(usage?.bonusRemaining || 0)}</span>
            </div>
            <div className="usage-card">
              <span className="label">资源包已用</span>
              <span className="value">{formatNumber(usage?.bonusUsed || 0)}</span>
            </div>
            <div className="usage-card">
              <span className="label">累计调用</span>
              <span className="value">{formatNumber(usage?.total || 0)}</span>
            </div>
          </div>
          <div className="usage-progress">
            <div className="progress-info">
              <span>今日使用率</span>
              <span>{usagePercent}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${Math.min(100, usagePercent)}%` }}></span>
            </div>
            <div className="usage-meta">
              <span>重置时间: {usage?.usage?.resetDate || '--'}</span>
              <span>最后使用: {formatTime(usage?.lastUsedAt)}</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'credentials' && (
        <div className="potluck-user-card">
          <div className="card-header">
            <h2>凭据管理</h2>
            <div className="card-actions">
              <button className="btn btn-outline btn-sm" onClick={() => refreshCredentials()} disabled={loading}>
                刷新
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleCheckAll} disabled={loading}>
                检查全部
              </button>
            </div>
          </div>
          <div className="credentials-list">
            {credentials.length === 0 ? (
              <div className="empty-state">
                <i className="fas fa-inbox"></i>
                <p>暂无凭据</p>
              </div>
            ) : (
              credentials.map((cred) => {
                const health = getHealthLabel(cred.isHealthy);
                return (
                  <div key={cred.id} className="credential-row">
                    <div className="credential-main">
                      <div className="credential-title">
                        <span>{cred.provider}</span>
                        <span className={`health-tag ${health.className}`}>{health.label}</span>
                      </div>
                      <div className="credential-meta">
                        <span>路径: {cred.path}</span>
                        <span>方式: {cred.authMethod}</span>
                        <span>添加时间: {formatTime(cred.addedAt)}</span>
                      </div>
                      {cred.bonus && (
                        <div className="credential-meta">
                          <span>资源包: {formatNumber(cred.bonus.remaining)} / {formatNumber(cred.bonus.total)}</span>
                          {cred.bonus.expiresAt && <span>到期: {formatTime(cred.bonus.expiresAt)}</span>}
                        </div>
                      )}
                      {cred.healthMessage && <div className="credential-message">{cred.healthMessage}</div>}
                    </div>
                    <div className="credential-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => handleCheckOne(cred.id)}>
                        检查
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {activeTab === 'kiro' && (
        <div className="potluck-user-card">
          <div className="card-header">
            <h2>Kiro 批量导入</h2>
            <p>每行一个 refreshToken，支持实时进度</p>
          </div>
          <div className="kiro-import">
            <textarea
              value={tokensText}
              onChange={(event) => setTokensText(event.target.value)}
              placeholder="refreshToken1&#10;refreshToken2"
            />
            <div className="kiro-actions">
              <input
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder="区域，例如 us-east-1"
              />
              <button className="btn btn-primary" onClick={handleBatchImport} disabled={importState.status === 'running'}>
                开始导入
              </button>
              <span className={`import-status ${importState.status}`}>
                {importState.status === 'running' && '导入中'}
                {importState.status === 'done' && '已完成'}
                {importState.status === 'error' && '失败'}
              </span>
            </div>
            <div className="import-summary">
              <span>总数: {importState.total}</span>
              <span>成功: {importState.success}</span>
              <span>失败: {importState.failed}</span>
            </div>
            <div className="import-log" ref={logRef}>
              {importState.logs.map((log, index) => (
                <div key={`${log.index}-${index}`} className={`import-log-line ${log.success ? 'success' : 'error'}`}>
                  <span># {log.index}</span>
                  <span>{log.success ? '成功' : '失败'}</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'aws' && (
        <div className="potluck-user-card">
          <div className="card-header">
            <h2>AWS 凭据导入</h2>
            <p>粘贴 Builder ID / AWS SSO 凭据 JSON</p>
          </div>
          <div className="aws-import">
            <textarea
              value={awsJson}
              onChange={(event) => setAwsJson(event.target.value)}
              placeholder='{"clientId":"...","clientSecret":"...","accessToken":"...","refreshToken":"..."}'
            />
            <button className="btn btn-primary" onClick={handleAwsImport} disabled={loading}>
              导入凭据
            </button>
          </div>
        </div>
      )}

      {activeTab === 'apikey' && (
        <div className="potluck-user-card">
          <div className="card-header">
            <h2>API Key</h2>
            <p>重置 Key 后旧 Key 将失效</p>
          </div>
          <div className="apikey-card">
            <div className="apikey-row">
              <span className="label">当前 Key</span>
              <span className="value">{usage?.maskedKey || apiKey}</span>
            </div>
            <div className="apikey-actions">
              <button
                className="btn btn-outline"
                onClick={async () => {
                  const ok = await copyText(apiKey);
                  if (!ok) {
                    alert('复制失败，请手动复制');
                  }
                }}
              >
                复制 Key
              </button>
              <button className="btn btn-danger" onClick={handleRegenerateKey}>
                重置 Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
