/**
 * Kiro 导入相关弹窗组件
 * 可在 Providers.jsx 和 ProviderDetail.jsx 中复用
 */

import { useEffect, useRef, useState } from 'react';
import { providerService } from '../services/provider.service';

// SSE 批量导入辅助函数
async function streamBatchImport({ endpoint, payload, onStart, onProgress, onComplete, onError }) {
  const token = localStorage.getItem('token');
  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    onError?.({ error: text || '请求失败' });
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    onError?.({ error: '无法读取响应流' });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let eventType = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (dataStr) {
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'start') onStart?.(data);
            else if (eventType === 'progress') onProgress?.(data);
            else if (eventType === 'complete') onComplete?.(data);
            else if (eventType === 'error') onError?.(data);
          } catch (e) {
            console.error('SSE parse error:', e);
          }
        }
      }
    }
  }
}

// 解析文本行
function parseLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeKiroCredential(credential) {
  if (!credential || typeof credential !== 'object') return credential;
  const clientId = credential.clientId || credential.client_id || '';
  const clientSecret = credential.clientSecret || credential.client_secret || '';
  const profileArn = credential.profileArn || credential.profile_arn || '';
  const authMethod = credential.authMethod || credential.auth_method || (profileArn && !(clientId && clientSecret) ? 'social' : '');
  return {
    ...credential,
    clientId,
    clientSecret,
    accessToken: credential.accessToken || credential.access_token || '',
    refreshToken: credential.refreshToken || credential.refresh_token || '',
    profileArn,
    expiresAt: credential.expiresAt || credential.expires_at || '',
    authMethod,
    provider: credential.provider || credential.socialProvider || credential.provider_id || (authMethod === 'social' ? 'Google' : ''),
    region: credential.region || credential.awsRegion || 'us-east-1',
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeKiroTimestamp(value) {
  if (value === null || value === undefined || value === '') return value;
  const numericValue = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d{12,}$/.test(value.trim()) ? Number(value.trim()) : null);
  if (Number.isFinite(numericValue)) {
    const date = new Date(numericValue);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return value;
}

function normalizeKiroAccountManagerAccount(account, exportPayload = {}) {
  if (!isPlainObject(account)) return null;

  const sourceCredentials = isPlainObject(account.credentials) ? account.credentials : {};
  const clientId = sourceCredentials.clientId || sourceCredentials.client_id || account.clientId || account.client_id || '';
  const clientSecret = sourceCredentials.clientSecret || sourceCredentials.client_secret || account.clientSecret || account.client_secret || '';
  const profileArn = sourceCredentials.profileArn || sourceCredentials.profile_arn || account.profileArn || account.profile_arn || '';
  const provider = sourceCredentials.provider || sourceCredentials.socialProvider || sourceCredentials.provider_id || account.provider || account.idp || '';
  const authMethod = sourceCredentials.authMethod || sourceCredentials.auth_method || account.authMethod || account.auth_method ||
    (provider && !(clientId && clientSecret) ? 'social' : '');

  return normalizeKiroCredential({
    ...sourceCredentials,
    clientId,
    clientSecret,
    accessToken: sourceCredentials.accessToken || sourceCredentials.access_token || account.accessToken || account.access_token || '',
    refreshToken: sourceCredentials.refreshToken || sourceCredentials.refresh_token || account.refreshToken || account.refresh_token || '',
    profileArn,
    expiresAt: normalizeKiroTimestamp(sourceCredentials.expiresAt || sourceCredentials.expires_at || account.expiresAt || account.expires_at || ''),
    authMethod,
    provider: provider || (authMethod === 'social' ? 'Google' : ''),
    region: sourceCredentials.region || sourceCredentials.awsRegion || account.region || account.awsRegion || 'us-east-1',
    email: sourceCredentials.email || account.email || '',
    userId: sourceCredentials.userId || sourceCredentials.user_id || account.userId || account.user_id || '',
    nickname: sourceCredentials.nickname || account.nickname || '',
    idp: sourceCredentials.idp || account.idp || '',
    accountId: sourceCredentials.accountId || sourceCredentials.account_id || account.accountId || account.account_id || account.id || '',
    machineId: sourceCredentials.machineId || sourceCredentials.machine_id || account.machineId || account.machine_id || '',
    subscription: sourceCredentials.subscription || account.subscription,
    usage: sourceCredentials.usage || account.usage,
    status: sourceCredentials.status || account.status || '',
    sourceFormat: sourceCredentials.sourceFormat || 'kiro-account-manager',
    exportedAt: normalizeKiroTimestamp(sourceCredentials.exportedAt || exportPayload.exportedAt || ''),
    kiroAccountManagerVersion: sourceCredentials.kiroAccountManagerVersion || exportPayload.version || '',
  });
}

function isKiroAccountManagerAccount(value) {
  if (!isPlainObject(value) || !isPlainObject(value.credentials)) return false;
  const credentials = value.credentials;
  return Boolean(
    credentials.refreshToken ||
    credentials.refresh_token ||
    credentials.accessToken ||
    credentials.access_token ||
    value.email ||
    value.userId ||
    value.idp
  );
}

function extractKiroJsonCredentials(payload, exportPayload = payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap(item => extractKiroJsonCredentials(item, exportPayload));
  }
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload.accounts)) {
    return payload.accounts
      .map(account => normalizeKiroAccountManagerAccount(account, payload))
      .filter(Boolean);
  }
  if (isKiroAccountManagerAccount(payload)) {
    return [normalizeKiroAccountManagerAccount(payload, exportPayload)].filter(Boolean);
  }
  return [normalizeKiroCredential(payload)];
}

function extractCodexJsonRecords(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap(item => extractCodexJsonRecords(item));
  }
  if (!isPlainObject(payload)) return [];
  for (const key of ['tokens', 'items', 'records', 'data', 'payload', 'accounts', 'list']) {
    if (Array.isArray(payload[key])) {
      return payload[key].flatMap(item => extractCodexJsonRecords(item));
    }
  }
  return [payload];
}

function hasKiroFullCredential(credential) {
  const normalized = normalizeKiroCredential(credential);
  return Boolean(normalized?.clientId && normalized?.clientSecret && normalized?.accessToken && normalized?.refreshToken);
}

// 通用弹窗外壳
function ModalShell({ open, onClose, title, subtitle, size = 'md', children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="providers-modal-overlay" onClick={onClose}>
      <div
        className={`providers-modal-card providers-modal-${size}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="providers-modal-header">
          <div className="providers-modal-header-info">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="providers-modal-close" onClick={onClose} aria-label="关闭">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="providers-modal-body">{children}</div>
        {footer && <div className="providers-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// 提示横幅
function NoticeBanner({ type, message }) {
  if (!message) return null;
  return <div className={`notice-banner notice-${type}`}>{message}</div>;
}

/**
 * Kiro 方法选择弹窗
 * @param {boolean} open - 是否打开
 * @param {Array} pools - 池子列表（当 fixedPoolId 为空时需要）
 * @param {string|number} fixedPoolId - 固定的池子ID（已在池子内时传入，不显示池子选择）
 * @param {Function} onClose - 关闭回调
 * @param {Function} onSelect - 选择回调 (mode, poolId)
 * @param {Function} onRefreshPools - 刷新池子列表回调
 */
export function KiroMethodModal({ open, pools, fixedPoolId, onClose, onSelect, onRefreshPools }) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);

  // 是否使用固定池子（已在池子详情页内）
  const useFixedPool = fixedPoolId !== undefined && fixedPoolId !== null;

  useEffect(() => {
    if (open) {
      if (!useFixedPool && onRefreshPools) {
        setLoading(true);
        onRefreshPools().finally(() => setLoading(false));
      }
    } else {
      setSelectedPoolId('');
      setDropdownOpen(false);
    }
  }, [open, useFixedPool, onRefreshPools]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (mode) => {
    const finalPoolId = useFixedPool ? fixedPoolId : selectedPoolId;
    onSelect(mode, finalPoolId);
  };

  const selectedPool = pools?.find(p => String(p.id) === String(selectedPoolId));
  const displayText = selectedPool ? selectedPool.name : '默认号池';

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Kiro 授权/导入"
      subtitle={useFixedPool ? '请选择认证方式' : '请选择目标号池和认证方式'}
      size="sm"
    >
      {/* 只有不使用固定池子时才显示池子选择 */}
      {!useFixedPool && (
        <div className="pool-select-section">
          <label>目标号池</label>
          <div className="custom-select" ref={dropdownRef}>
            <div
              className={`custom-select-trigger ${dropdownOpen ? 'open' : ''}`}
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span>{loading ? '加载中...' : displayText}</span>
              <i className={`fas fa-chevron-down ${dropdownOpen ? 'rotate' : ''}`}></i>
            </div>
            {dropdownOpen && (
              <div className="custom-select-options">
                <div
                  className={`custom-select-option ${selectedPoolId === '' ? 'selected' : ''}`}
                  onClick={() => { setSelectedPoolId(''); setDropdownOpen(false); }}
                >
                  默认号池
                </div>
                {pools?.map((pool) => (
                  <div
                    key={pool.id}
                    className={`custom-select-option ${String(selectedPoolId) === String(pool.id) ? 'selected' : ''}`}
                    onClick={() => { setSelectedPoolId(String(pool.id)); setDropdownOpen(false); }}
                  >
                    {pool.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="method-grid">
        <button className="method-card" onClick={() => handleSelect('google')}>
          <i className="fab fa-google"></i>
          <div>
            <strong>Google 登录</strong>
            <span>Kiro Social OAuth</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('builder-id')}>
          <i className="fab fa-aws"></i>
          <div>
            <strong>AWS Builder ID</strong>
            <span>生成 OAuth 授权链接</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('batch-import')}>
          <i className="fas fa-file-import"></i>
          <div>
            <strong>批量导入</strong>
            <span>批量导入 refreshToken</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('aws-import')}>
          <i className="fas fa-cloud-upload-alt"></i>
          <div>
            <strong>JSON 导入</strong>
            <span>支持 Google/Social 与 AWS SSO</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Codex 方式选择弹窗
 */
export function CodexMethodModal({ open, pools, fixedPoolId, defaultPoolId, onClose, onSelect, onRefreshPools }) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);
  const useFixedPool = fixedPoolId !== undefined && fixedPoolId !== null && fixedPoolId !== '';
  const showPoolSelect = !useFixedPool && Array.isArray(pools);

  useEffect(() => {
    if (!open) {
      setSelectedPoolId('');
      setDropdownOpen(false);
      return;
    }
    if (useFixedPool) {
      setSelectedPoolId(String(fixedPoolId));
      return;
    }
    if (defaultPoolId !== undefined && defaultPoolId !== null) {
      setSelectedPoolId(String(defaultPoolId));
    }
    if (showPoolSelect && onRefreshPools) {
      setLoading(true);
      onRefreshPools().finally(() => setLoading(false));
    }
  }, [open, useFixedPool, fixedPoolId, defaultPoolId, showPoolSelect, onRefreshPools]);

  useEffect(() => {
    if (!open || useFixedPool || selectedPoolId) return;
    if (!Array.isArray(pools) || pools.length === 0) return;
    const defaultPool = pools.find((pool) => pool.isDefault) || pools[0];
    if (defaultPool?.id !== undefined && defaultPool?.id !== null) {
      setSelectedPoolId(String(defaultPool.id));
    }
  }, [open, useFixedPool, selectedPoolId, pools]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (mode) => {
    const finalPoolId = useFixedPool ? fixedPoolId : selectedPoolId;
    onSelect(mode, finalPoolId || undefined);
  };

  const selectedPool = pools?.find(pool => String(pool.id) === String(selectedPoolId));
  const displayText = selectedPool ? selectedPool.name : '默认号池';

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Codex 授权/导入"
      subtitle={showPoolSelect ? '请选择目标号池和添加账号方式' : '请选择添加账号方式'}
      size="sm"
    >
      {showPoolSelect && (
        <div className="pool-select-section">
          <label>目标号池</label>
          <div className="custom-select" ref={dropdownRef}>
            <div
              className={`custom-select-trigger ${dropdownOpen ? 'open' : ''}`}
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span>{loading ? '加载中...' : displayText}</span>
              <i className={`fas fa-chevron-down ${dropdownOpen ? 'rotate' : ''}`}></i>
            </div>
            {dropdownOpen && (
              <div className="custom-select-options">
                <div
                  className={`custom-select-option ${selectedPoolId === '' ? 'selected' : ''}`}
                  onClick={() => { setSelectedPoolId(''); setDropdownOpen(false); }}
                >
                  默认号池
                </div>
                {pools?.map((pool) => (
                  <div
                    key={pool.id}
                    className={`custom-select-option ${String(selectedPoolId) === String(pool.id) ? 'selected' : ''}`}
                    onClick={() => { setSelectedPoolId(String(pool.id)); setDropdownOpen(false); }}
                  >
                    {pool.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="method-grid">
        <button className="method-card" onClick={() => handleSelect('oauth')}>
          <i className="fas fa-key"></i>
          <div>
            <strong>OAuth 授权</strong>
            <span>生成授权链接并完成登录</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('json-import')}>
          <i className="fas fa-file-import"></i>
          <div>
            <strong>JSON 文件导入</strong>
            <span>批量导入 AnyRegister JSON</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Codex AnyRegister JSON 导入弹窗
 */
export function CodexJsonImportModal({
  open,
  poolId,
  fixedPoolId,
  poolOptions = [],
  defaultPoolId,
  onClose,
  onSuccess
}) {
  const [fileName, setFileName] = useState('');
  const [jsonContent, setJsonContent] = useState('');
  const [records, setRecords] = useState([]);
  const [fileCount, setFileCount] = useState(0);
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const hadSuccessRef = useRef(false);
  const targetFixedPoolId = fixedPoolId ?? poolId;
  const useFixedPool = targetFixedPoolId !== undefined && targetFixedPoolId !== null && targetFixedPoolId !== '';

  useEffect(() => {
    if (!open) return;
    setFileName('');
    setJsonContent('');
    setRecords([]);
    setFileCount(0);
    setSelectedPoolId(useFixedPool
      ? String(targetFixedPoolId)
      : (defaultPoolId !== undefined && defaultPoolId !== null ? String(defaultPoolId) : ''));
    setLoading(false);
    setError('');
    setResult(null);
    hadSuccessRef.current = false;
  }, [open, useFixedPool, targetFixedPoolId, defaultPoolId]);

  useEffect(() => {
    if (!open || useFixedPool || selectedPoolId) return;
    if (!Array.isArray(poolOptions) || poolOptions.length === 0) return;
    const defaultPool = poolOptions.find((pool) => pool.isDefault) || poolOptions[0];
    if (defaultPool?.id !== undefined && defaultPool?.id !== null) {
      setSelectedPoolId(String(defaultPool.id));
    }
  }, [open, useFixedPool, selectedPoolId, poolOptions]);

  const handleClose = () => {
    if (hadSuccessRef.current) onSuccess?.();
    onClose();
  };

  const handleChooseFile = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    try {
      const parsedRecords = [];
      for (const file of files) {
        const text = await file.text();
        const parsed = JSON.parse(text || 'null');
        const items = extractCodexJsonRecords(parsed);
        parsedRecords.push(...items);
      }
      if (parsedRecords.length === 0) {
        throw new Error('未解析到可导入的记录');
      }
      const displayFileName = files.length > 5
        ? `${files.slice(0, 5).map((file) => file.name).join(', ')} 等 ${files.length} 个文件`
        : files.map((file) => file.name).join(', ');
      setFileName(displayFileName);
      setFileCount(files.length);
      setRecords(parsedRecords);
      setJsonContent('');
      setError('');
      setResult(null);
    } catch (e) {
      setFileName('');
      setJsonContent('');
      setRecords([]);
      setFileCount(0);
      setResult(null);
      setError(`读取 JSON 文件失败: ${e.message || '未知错误'}`);
    } finally {
      event.target.value = '';
    }
  };

  const handleJsonContentChange = (event) => {
    setJsonContent(event.target.value);
    setRecords([]);
    setFileName('');
    setFileCount(0);
    setResult(null);
  };

  const handleImport = async () => {
    const hasRecords = records.length > 0;
    const trimmedJsonContent = jsonContent.trim();
    if (!hasRecords && !trimmedJsonContent) {
      setError('请先选择 JSON 文件或粘贴 JSON 内容');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const resolvedPoolId = useFixedPool ? targetFixedPoolId : selectedPoolId;
      const payload = {
        poolId: resolvedPoolId || undefined,
        fileName: fileName || undefined
      };
      if (hasRecords) {
        payload.records = records;
      } else {
        payload.jsonContent = trimmedJsonContent;
      }
      const data = await providerService.importCodexAnyRegisterJson(payload);
      setResult(data);
      if ((data?.imported || 0) > 0) {
        hadSuccessRef.current = true;
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  const hasImportPayload = records.length > 0 || Boolean(jsonContent.trim());

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="Codex JSON 导入"
      subtitle="支持 AnyRegister 生成的 tokens.json"
      size="md"
      footer={(
        <>
          <button className="btn btn-secondary" onClick={handleClose} disabled={loading}>关闭</button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading || !hasImportPayload}>
            {loading ? '导入中...' : '一键导入'}
          </button>
        </>
      )}
    >
      <NoticeBanner type="error" message={error} />
      {result && (
        <div className="notice-banner notice-success">
          导入完成：总计 {result.total || 0}，成功 {result.imported || 0}，跳过 {result.skipped || 0}，失败 {result.failed || 0}
        </div>
      )}
      {result?.noRefreshToken > 0 && (
        <div className="notice-banner notice-warning">
          有 {result.noRefreshToken} 个账号缺少 refreshToken，仅可在 accessToken 有效期内使用。
        </div>
      )}
      <div className="modal-form">
        {!useFixedPool && (
          <label>
            <span>目标号池</span>
            <select
              value={selectedPoolId}
              onChange={(event) => setSelectedPoolId(event.target.value)}
              disabled={loading}
            >
              <option value="">默认号池</option>
              {poolOptions.map((pool) => (
                <option key={pool.id} value={String(pool.id)}>
                  {pool.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>JSON 文件</span>
          <input type="file" accept=".json,application/json" multiple onChange={handleChooseFile} disabled={loading} />
        </label>
        <label>
          <span>JSON 内容（可直接粘贴）</span>
          <textarea
            rows={10}
            value={jsonContent}
            onChange={handleJsonContentChange}
            placeholder='[{"access_token":"...","email":"...","type":"codex","registered_at":"..."}]'
          />
        </label>
        {fileName && (
          <small className="form-hint">
            已选择 {fileCount} 个文件，解析出 {records.length} 条记录: {fileName}
          </small>
        )}
      </div>
      {result?.details?.length > 0 && (
        <div className="parsed-credentials-preview">
          <div className="preview-header">
            <span>异常详情（前 30 条）</span>
          </div>
          <div className="preview-list">
            {result.details.slice(0, 30).map((item) => (
              <div key={`${item.status}-${item.index}`} className="preview-item">
                <div className="preview-item-index">#{item.index}</div>
                <div className="preview-item-info">
                  <div className="preview-item-email">{item.email || item.accountId || '--'}</div>
                  <div className="preview-item-token">{item.status}: {item.reason || '-'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Grok 添加方式选择弹窗
 */
export function GrokMethodModal(props) {
  if (!props.open) return null;
  return <GrokMethodModalContent {...props} />;
}

function GrokMethodModalContent({ pools, fixedPoolId, defaultPoolId, onClose, onSelect, onRefreshPools }) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const useFixedPool = fixedPoolId !== undefined && fixedPoolId !== null && fixedPoolId !== '';
  const showPoolSelect = !useFixedPool && Array.isArray(pools);
  const defaultPool = Array.isArray(pools)
    ? (pools.find((pool) => pool.isDefault) || pools[0])
    : null;
  const fallbackPoolId = defaultPoolId !== undefined && defaultPoolId !== null && defaultPoolId !== ''
    ? String(defaultPoolId)
    : (defaultPool?.id !== undefined && defaultPool?.id !== null ? String(defaultPool.id) : '');
  const effectivePoolId = useFixedPool ? String(fixedPoolId) : (selectedPoolId || fallbackPoolId);

  useEffect(() => {
    if (showPoolSelect && onRefreshPools) void onRefreshPools();
  }, [showPoolSelect, onRefreshPools]);

  const handleSelect = (mode) => {
    onSelect(mode, effectivePoolId || undefined);
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Grok 授权/导入"
      subtitle={showPoolSelect ? '请选择目标号池和添加账号方式' : '请选择添加账号方式'}
      size="sm"
    >
      {showPoolSelect && (
        <div className="pool-select-section">
          <label>目标号池</label>
          <select
            value={effectivePoolId}
            onChange={(event) => setSelectedPoolId(event.target.value)}
          >
            <option value="">默认号池</option>
            {pools.map((pool) => (
              <option key={pool.id} value={String(pool.id)}>{pool.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="method-grid">
        <button className="method-card" onClick={() => handleSelect('oauth')}>
          <i className="fas fa-link"></i>
          <div>
            <strong>xAI OAuth 授权</strong>
            <span>使用 Device Flow 登录 Grok</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('import')}>
          <i className="fas fa-file-import"></i>
          <div>
            <strong>凭据批量导入</strong>
            <span>CPA JSON、Token 或三段发货文本</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Grok JSON / Token 批量导入弹窗
 */
export function GrokImportModal(props) {
  if (!props.open) return null;
  return <GrokImportModalContent {...props} />;
}

function GrokImportModalContent({
  poolId,
  fixedPoolId,
  poolOptions = [],
  defaultPoolId,
  onClose,
  onSuccess
}) {
  const [fileName, setFileName] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [records, setRecords] = useState([]);
  const [fileTokenText, setFileTokenText] = useState('');
  const [inputText, setInputText] = useState('');
  const [proxy, setProxy] = useState('');
  const targetFixedPoolId = fixedPoolId ?? poolId;
  const useFixedPool = targetFixedPoolId !== undefined && targetFixedPoolId !== null && targetFixedPoolId !== '';
  const [selectedPoolId, setSelectedPoolId] = useState(
    useFixedPool
      ? String(targetFixedPoolId)
      : (defaultPoolId !== undefined && defaultPoolId !== null ? String(defaultPoolId) : '')
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const hadSuccessRef = useRef(false);
  const defaultPool = poolOptions.find((pool) => pool.isDefault) || poolOptions[0];
  const fallbackPoolId = defaultPool?.id !== undefined && defaultPool?.id !== null
    ? String(defaultPool.id)
    : '';
  const effectivePoolId = useFixedPool
    ? String(targetFixedPoolId)
    : (selectedPoolId || fallbackPoolId);

  const handleClose = () => {
    if (hadSuccessRef.current) onSuccess?.();
    onClose();
  };

  const handleChooseFile = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    try {
      const nextRecords = [];
      const tokenBlocks = [];
      for (const file of files) {
        const text = await file.text();
        try {
          const parsed = JSON.parse(text || 'null');
          const extracted = extractCodexJsonRecords(parsed);
          nextRecords.push(...extracted);
        } catch {
          tokenBlocks.push(text);
        }
      }
      if (nextRecords.length === 0 && tokenBlocks.every((item) => !item.trim())) {
        throw new Error('未解析到可导入的凭据');
      }
      setRecords(nextRecords);
      setFileTokenText(tokenBlocks.join('\n'));
      setFileCount(files.length);
      setFileName(files.length > 5
        ? `${files.slice(0, 5).map((file) => file.name).join(', ')} 等 ${files.length} 个文件`
        : files.map((file) => file.name).join(', '));
      setError('');
      setResult(null);
    } catch (readError) {
      setFileName('');
      setFileCount(0);
      setRecords([]);
      setFileTokenText('');
      setError(`读取凭据文件失败: ${readError.message || '未知错误'}`);
    } finally {
      event.target.value = '';
    }
  };

  const handleImport = async () => {
    const tokenText = [fileTokenText, inputText].filter(Boolean).join('\n').trim();
    if (records.length === 0 && !tokenText) {
      setError('请选择凭据文件，或粘贴 JSON / Token');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await providerService.importXaiCredentials({
        poolId: effectivePoolId || undefined,
        fileName: fileName || undefined,
        records: records.length > 0 ? records : undefined,
        tokenText: tokenText || undefined,
        proxy: proxy.trim() || undefined
      });
      setResult(data);
      if ((data?.imported || 0) > 0) hadSuccessRef.current = true;
    } catch (importError) {
      setError(
        importError.response?.data?.error?.message
        || importError.response?.data?.error
        || importError.message
        || '导入失败'
      );
    } finally {
      setLoading(false);
    }
  };

  const hasPayload = records.length > 0 || Boolean(fileTokenText.trim()) || Boolean(inputText.trim());

  return (
    <ModalShell
      open
      onClose={handleClose}
      title="Grok 凭据导入"
      subtitle="支持 CPA / Grok CLI JSON、Token，以及账号----密码----SSO 自动换证"
      size="md"
      footer={(
        <>
          <button className="btn btn-secondary" onClick={handleClose} disabled={loading}>关闭</button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading || !hasPayload}>
            {loading ? '导入中...' : '一键导入'}
          </button>
        </>
      )}
    >
      <NoticeBanner type="error" message={error} />
      {result && (
        <div className="notice-banner notice-success">
          导入完成：总计 {result.total || 0}，成功 {result.imported || 0}，跳过 {result.skipped || 0}，失败 {result.failed || 0}
          {(result.converted || result.conversionFailed) ? `，SSO 换证 ${result.converted || 0}/${(result.converted || 0) + (result.conversionFailed || 0)}` : ''}
        </div>
      )}
      <div className="modal-form">
        {!useFixedPool && (
          <label>
            <span>目标号池</span>
            <select value={effectivePoolId} onChange={(event) => setSelectedPoolId(event.target.value)} disabled={loading}>
              <option value="">默认号池</option>
              {poolOptions.map((pool) => (
                <option key={pool.id} value={String(pool.id)}>{pool.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>凭据文件</span>
          <input
            type="file"
            accept=".json,.txt,application/json,text/plain"
            multiple
            onChange={handleChooseFile}
            disabled={loading}
          />
        </label>
        <label>
          <span>JSON / Token 内容</span>
          <textarea
            rows={11}
            value={inputText}
            onChange={(event) => {
              setInputText(event.target.value);
              setResult(null);
            }}
            placeholder={'三段发货：账号----密码----SSO（自动换 OAuth）\n也可粘贴 CPA / Grok CLI JSON\nxai-... 识别为 API Key；JWT 识别为 Access Token\n其他裸 Token 识别为 Refresh Token'}
          />
        </label>
        <label>
          <span>换证代理（可选）</span>
          <input
            type="text"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://user:pass@host:port"
            disabled={loading}
          />
        </label>
        {fileName && (
          <small className="form-hint">
            已选择 {fileCount} 个文件，解析出 {records.length} 条 JSON 记录: {fileName}
          </small>
        )}
      </div>
      {result?.details?.length > 0 && (
        <div className="parsed-credentials-preview">
          <div className="preview-header"><span>导入详情（前 30 条）</span></div>
          <div className="preview-list">
            {result.details.slice(0, 30).map((item) => (
              <div key={`${item.status}-${item.index}`} className="preview-item">
                <div className="preview-item-index">#{item.index}</div>
                <div className="preview-item-info">
                  <div className="preview-item-email">{item.email || item.authKind || '--'}</div>
                  <div className="preview-item-token">{item.status}: {item.reason || item.providerUuid || '-'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Kiro 批量导入弹窗（支持 refreshToken 和 AWS 凭据格式自动检测）
 */
export function KiroBatchImportModal({ open, poolId, onClose, onSuccess }) {
  const [batchText, setBatchText] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detectedFormat, setDetectedFormat] = useState(null);
  const [parsedCredentials, setParsedCredentials] = useState(null); // 解析后的账号列表
  const hadSuccessRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setBatchText('');
    setProgress(null);
    setResult(null);
    setError('');
    setLoading(false);
    setDetectedFormat(null);
    setParsedCredentials(null);
    hadSuccessRef.current = false;
  }, [open]);

  // 关闭时如果有成功导入则触发刷新
  const handleClose = () => {
    if (hadSuccessRef.current) onSuccess?.();
    onClose();
  };

  // 检测文本是否看起来像 JSON 凭据（不依赖 JSON.parse，用字符串特征判断）
  const looksLikeJsonCredential = (text) => {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    return t.includes('"refreshToken"') ||
      t.includes('"refresh_token"') ||
      (t.includes('"accounts"') && t.includes('"credentials"'));
  };

  // 解析 JSON 凭据（在 handleImport 时调用，失败会设置 error）
  const parseJsonCredentials = (text) => {
    const trimmed = text.trim();

    const validate = (payload) => {
      const normalized = extractKiroJsonCredentials(payload).map(normalizeKiroCredential);
      if (normalized.length > 0 && normalized.every(item => item && typeof item === 'object' && item.refreshToken)) {
        return normalized;
      }
      return null;
    };

    // 1. 直接解析
    try {
      const parsed = JSON.parse(trimmed);
      const result = validate(parsed);
      if (result) return result;
    } catch { /* continue */ }

    // 2. 清理不可见字符后重试
    const cleaned = trimmed
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')  // zero-width chars, BOM, nbsp
      .replace(/[\r]/g, '');                           // carriage returns
    if (cleaned !== trimmed) {
      try {
        const parsed = JSON.parse(cleaned);
        const result = validate(parsed);
        if (result) return result;
      } catch { /* continue */ }
    }

    // 3. 括号匹配提取
    const src = cleaned || trimmed;
    if (src.startsWith('{') || src.startsWith('[')) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(src.substring(0, i + 1));
            const result = validate(parsed);
            if (result) return result;
          } catch { /* continue */ }
          break;
        }
      }
    }

    // 4. 每行一个 JSON
    const lines = src.split('\n').filter(l => l.trim());
    const objects = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        const normalized = extractKiroJsonCredentials(parsed).map(normalizeKiroCredential);
        objects.push(...normalized.filter(item => item && typeof item === 'object' && item.refreshToken));
      } catch { /* skip */ }
    }
    if (objects.length > 0) return objects;

    return null;
  };

  // 检测输入格式
  useEffect(() => {
    if (!batchText.trim()) {
      setDetectedFormat(null);
      return;
    }
    // 优先用字符串特征检测 JSON
    if (looksLikeJsonCredential(batchText)) {
      const t = batchText.trim();
      if (t.includes('"accounts"') && t.includes('"credentials"')) {
        setDetectedFormat('accountManager');
        return;
      }
      const hasFull = (t.includes('"clientId"') || t.includes('"client_id"'))
        && (t.includes('"clientSecret"') || t.includes('"client_secret"'))
        && (t.includes('"accessToken"') || t.includes('"access_token"'))
        && (t.includes('"refreshToken"') || t.includes('"refresh_token"'));
      setDetectedFormat(hasFull ? 'fullCredential' : 'jsonRefreshToken');
      return;
    }
    const lines = batchText.split('\n').filter(line => line.trim());
    if (lines.length === 0) {
      setDetectedFormat(null);
      return;
    }
    const hasAwsFormat = lines.some(line => line.includes('|') && line.split('|').length >= 4);
    setDetectedFormat(hasAwsFormat ? 'awsCredentials' : 'refreshToken');
  }, [batchText]);

  // JSON 凭据批量导入（逐个调用单条导入 API）
  const handleJsonImport = async (credentials) => {
    const token = localStorage.getItem('token');
    const total = credentials.length;
    let success = 0;
    let failed = 0;
    const errors = [];

    setProgress({ current: 0, total, success: 0, failed: 0 });

    for (let i = 0; i < total; i++) {
      const cred = normalizeKiroCredential(credentials[i]);
      // 判断是完整凭据还是仅 refreshToken
      const hasFullCreds = hasKiroFullCredential(cred);

      try {
        let response;
        if (hasFullCreds) {
          // 完整凭据 → 走 AWS credentials 导入
          response = await fetch('/api/kiro/import-aws-credentials', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ credentials: cred, poolId: poolId || undefined }),
          });
        } else {
          // 仅有 refreshToken → 走 refreshToken 单条导入（复用批量接口，单条）
          response = await fetch('/api/kiro/import-aws-credentials', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              credentials: cred,
              poolId: poolId || undefined,
            }),
          });
        }

        const data = await response.json();
        if (data.success) {
          success++;
        } else {
          failed++;
          errors.push(data.error || '导入失败');
        }
      } catch (e) {
        failed++;
        errors.push(e.message || '网络错误');
      }

      setProgress({ current: i + 1, total, success, failed });
    }

    setResult({ success, failed, errors });
    setLoading(false);
    if (success > 0) hadSuccessRef.current = true;
  };

  // 解析预览：解析 JSON 并显示账号列表
  const handleParsePreview = () => {
    setError('');
    const jsonCreds = parseJsonCredentials(batchText);
    if (!jsonCreds || jsonCreds.length === 0) {
      let parseErr = 'JSON 格式无法解析';
      try { JSON.parse(batchText.trim()); } catch (e) { parseErr = e.message; }
      setError(`JSON 解析失败: ${parseErr}`);
      return;
    }
    setParsedCredentials(jsonCreds);
  };

  // 返回编辑
  const handleBackToEdit = () => {
    setParsedCredentials(null);
    setProgress(null);
    setResult(null);
    setError('');
  };

  // 确认导入已解析的凭据
  const handleConfirmImport = async () => {
    if (!parsedCredentials || parsedCredentials.length === 0) return;

    if (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') {
      setLoading(true);
      setError('');
      setResult(null);
      await handleJsonImport(parsedCredentials);
      return;
    }

    // 兜底：提取 refreshToken 走批量
    const tokens = parsedCredentials.map(c => normalizeKiroCredential(c)?.refreshToken).filter(Boolean);
    if (tokens.length === 0) {
      setError('未找到有效的 refreshToken');
      return;
    }
    setLoading(true);
    setError('');
    setProgress({ current: 0, total: tokens.length, success: 0, failed: 0 });
    setResult(null);
    await streamBatchImport({
      endpoint: '/kiro/batch-import-tokens',
      payload: { refreshTokens: tokens, poolId: poolId || undefined },
      onStart: (data) => {
        setProgress({ current: 0, total: data?.total || tokens.length, success: 0, failed: 0 });
      },
      onProgress: (data) => {
        setProgress({
          current: data?.index || 0,
          total: data?.total || tokens.length,
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
      },
      onComplete: (data) => {
        setResult({
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
          errors: (data?.details || [])
            .filter((item) => !item.success)
            .map((item) => item.error || '导入失败'),
        });
        setLoading(false);
        if (data?.successCount > 0) hadSuccessRef.current = true;
      },
      onError: (data) => {
        setError(data?.error || '批量导入失败');
        setLoading(false);
      },
    });
  };

  const handleImport = async () => {
    // JSON 格式 → 走解析预览流程
    if (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') {
      handleParsePreview();
      return;
    }

    const lines = parseLines(batchText);
    if (!lines.length) {
      setError('请输入凭据');
      return;
    }
    setLoading(true);
    setError('');
    setProgress({ current: 0, total: lines.length, success: 0, failed: 0 });
    setResult(null);

    if (detectedFormat === 'awsCredentials') {
      await streamBatchImport({
        endpoint: '/kiro/batch-import-aws-credentials',
        payload: { text: batchText, poolId: poolId || undefined },
        onStart: (data) => {
          setProgress({ current: 0, total: data?.total || lines.length, success: 0, failed: 0 });
        },
        onProgress: (data) => {
          setProgress({
            current: data?.index || 0,
            total: data?.total || lines.length,
            success: data?.successCount || 0,
            failed: data?.failedCount || 0,
          });
        },
        onComplete: (data) => {
          setResult({
            success: data?.successCount || 0,
            failed: data?.failedCount || 0,
            errors: (data?.details || [])
              .filter((item) => !item.success)
              .map((item) => item.error || '导入失败'),
          });
          setLoading(false);
          if (data?.successCount > 0) hadSuccessRef.current = true;
        },
        onError: (data) => {
          setError(data?.error || '批量导入失败');
          setLoading(false);
        },
      });
    } else {
      await streamBatchImport({
        endpoint: '/kiro/batch-import-tokens',
        payload: { refreshTokens: lines, poolId: poolId || undefined },
        onStart: (data) => {
          setProgress({ current: 0, total: data?.total || lines.length, success: 0, failed: 0 });
        },
        onProgress: (data) => {
          setProgress({
            current: data?.index || 0,
            total: data?.total || lines.length,
            success: data?.successCount || 0,
            failed: data?.failedCount || 0,
          });
        },
        onComplete: (data) => {
          setResult({
            success: data?.successCount || 0,
            failed: data?.failedCount || 0,
            errors: (data?.details || [])
              .filter((item) => !item.success)
              .map((item) => item.error || '导入失败'),
          });
          setLoading(false);
          if (data?.successCount > 0) hadSuccessRef.current = true;
        },
        onError: (data) => {
          setError(data?.error || '批量导入失败');
          setLoading(false);
        },
      });
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="Kiro 批量导入"
      subtitle="支持 refreshToken 或完整凭据格式"
      size="md"
      footer={
        parsedCredentials && !result ? (
          <>
            <button className="btn btn-secondary" onClick={handleBackToEdit} disabled={loading}>
              <i className="fas fa-arrow-left" /> 返回修改
            </button>
            <button className="btn btn-primary" onClick={handleConfirmImport} disabled={loading}>
              {loading ? '导入中...' : `确认导入 (${parsedCredentials.length} 个)`}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={handleClose} disabled={loading}>
              关闭
            </button>
            {!result && (
              <button className="btn btn-primary" onClick={handleImport} disabled={loading || !batchText.trim()}>
                {loading ? '导入中...' : (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') ? '解析预览' : '开始导入'}
              </button>
            )}
          </>
        )
      }
    >
      <NoticeBanner type="error" message={error} />
      {progress && (
        <div className="progress-card">
          <div className="progress-meta">
            <span>进度：{progress.current}/{progress.total}</span>
            <span>成功 {progress.success} / 失败 {progress.failed}</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-inner"
              style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      )}
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
        </div>
      )}

      {/* 解析预览列表 */}
      {parsedCredentials && !result ? (
        <div className="parsed-credentials-preview">
          <div className="preview-header">
            <span>解析到 {parsedCredentials.length} 个账号</span>
            <span className="preview-format-tag">
              {detectedFormat === 'accountManager' ? 'Account Manager' : detectedFormat === 'fullCredential' ? '完整凭据' : 'RefreshToken'}
            </span>
          </div>
          <div className="preview-list">
            {parsedCredentials.map((cred, idx) => {
              const normalizedCred = normalizeKiroCredential(cred);
              const hasFullCreds = hasKiroFullCredential(normalizedCred);
              const tokenPreview = normalizedCred.refreshToken
                ? `${normalizedCred.refreshToken.substring(0, 12)}...${normalizedCred.refreshToken.slice(-6)}`
                : '无 refreshToken';
              return (
                <div key={idx} className="preview-item">
                  <div className="preview-item-index">#{idx + 1}</div>
                  <div className="preview-item-info">
                    {cred.email && <div className="preview-item-email">{cred.email}</div>}
                    <div className="preview-item-token" title={normalizedCred.refreshToken}>{tokenPreview}</div>
                    <div className="preview-item-tags">
                      {hasFullCreds && <span className="tag tag-full">完整凭据</span>}
                      {!hasFullCreds && <span className="tag tag-token">仅 Token</span>}
                      {cred.region && <span className="tag tag-region">{cred.region}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : !result && (
        <div className="modal-form">
          {detectedFormat && (
            <div className={`format-hint ${detectedFormat === 'awsCredentials' ? 'format-aws' : detectedFormat === 'fullCredential' ? 'format-aws' : 'format-token'}`}>
              <i className={`fas ${detectedFormat === 'awsCredentials' || detectedFormat === 'fullCredential' ? 'fa-key' : 'fa-ticket-alt'}`} />
              {detectedFormat === 'fullCredential'
                ? '检测到 JSON 完整凭据，点击「解析预览」查看账号列表'
                : detectedFormat === 'accountManager'
                  ? '检测到 Kiro Account Manager 导出 JSON，点击「解析预览」查看账号列表'
                  : detectedFormat === 'jsonRefreshToken'
                    ? '检测到 JSON 格式，点击「解析预览」查看账号列表'
                    : detectedFormat === 'awsCredentials'
                      ? '检测到 AWS 凭据格式，将使用完整凭据导入'
                      : '检测到 RefreshToken 格式，将使用 Token 导入'}
            </div>
          )}
          <textarea
            rows={10}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder={`支持四种格式：\n\n1. 纯 RefreshToken（每行一个）:\naorAAAAA...\n\n2. AWS 完整凭据（| 分隔）:\nemail|password|clientId|clientSecret|refreshToken|accessToken\n\n3. JSON 凭据（Google/Social 或 AWS，支持 snake_case）:\n{"refreshToken":"...","accessToken":"...","profileArn":"...","authMethod":"social"}\n\n4. Kiro Account Manager 导出 JSON:\n{"version":"1.6.1","accounts":[{"email":"name@example.com","credentials":{"refreshToken":"...","accessToken":"...","authMethod":"social"}}]}`}
          />
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Kiro JSON 凭据导入弹窗
 */
export function KiroAwsImportModal({ open, poolId, onClose, onSuccess }) {
  const [mode, setMode] = useState('single');
  const [jsonText, setJsonText] = useState('');
  const [batchText, setBatchText] = useState('');
  const [credentials, setCredentials] = useState(null);
  const [validation, setValidation] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setJsonText('');
    setBatchText('');
    setCredentials(null);
    setValidation(null);
    setError('');
    setLoading(false);
    setProgress(null);
    setResult(null);
  }, [open]);

  // 单个导入：解析 JSON
  useEffect(() => {
    if (!open || mode !== 'single') return;
    if (!jsonText.trim()) {
      setCredentials(null);
      setValidation(null);
      return;
    }
    try {
      const parsedPayload = JSON.parse(jsonText);
      const extracted = extractKiroJsonCredentials(parsedPayload);
      if (extracted.length !== 1) {
        setCredentials(null);
        setValidation({
          valid: false,
          message: extracted.length > 1 ? '检测到多个账号，请切换批量导入' : '未找到有效凭据',
        });
        return;
      }
      const parsed = normalizeKiroCredential(extracted[0]);
      setCredentials(parsed);
      const missing = [];
      if (!parsed.refreshToken) missing.push('refreshToken');
      if ((parsed.clientId || parsed.clientSecret) && !hasKiroFullCredential(parsed)) {
        if (!parsed.clientId) missing.push('clientId');
        if (!parsed.clientSecret) missing.push('clientSecret');
        if (!parsed.accessToken) missing.push('accessToken');
      }
      if (missing.length > 0) {
        setValidation({ valid: false, message: `缺少字段: ${missing.join(', ')}` });
      } else {
        setValidation({
          valid: true,
          message: hasKiroFullCredential(parsed) ? 'AWS SSO 凭据格式正确' : 'Google/Social 凭据格式正确',
        });
      }
    } catch (e) {
      setCredentials(null);
      setValidation({ valid: false, message: 'JSON 格式错误' });
    }
  }, [open, mode, jsonText]);

  const handleSingleImport = async () => {
    if (!credentials || !validation?.valid) return;
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/kiro/import-aws-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ credentials, poolId: poolId || undefined }),
      });
      const data = await response.json();
      if (data.success) {
        onSuccess?.();
        onClose();
      } else {
        setError(data.error || '导入失败');
      }
    } catch (e) {
      setError(e.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImport = async () => {
    const lines = parseLines(batchText);
    if (!lines.length) {
      setError('请输入凭据');
      return;
    }
    let expectedTotal = lines.length;
    try {
      const parsedPayload = JSON.parse(batchText.trim());
      const extracted = extractKiroJsonCredentials(parsedPayload).filter(item => item?.refreshToken);
      if (extracted.length > 0) expectedTotal = extracted.length;
    } catch { /* use line count */ }
    setLoading(true);
    setError('');
    setProgress({ current: 0, total: expectedTotal, success: 0, failed: 0 });
    setResult(null);

    await streamBatchImport({
      endpoint: '/kiro/batch-import-aws-credentials',
      payload: { text: batchText, poolId: poolId || undefined },
      onStart: (data) => {
        setProgress({ current: 0, total: data?.total || expectedTotal, success: 0, failed: 0 });
      },
      onProgress: (data) => {
        setProgress({
          current: data?.index || 0,
          total: data?.total || expectedTotal,
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
      },
      onComplete: (data) => {
        setResult({
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
        setLoading(false);
        onSuccess?.();
      },
      onError: (data) => {
        setError(data?.error || '批量导入失败');
        setLoading(false);
      },
    });
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Kiro JSON 凭据导入"
      subtitle="支持 Google/Social token JSON 或 AWS SSO 凭据"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button
            className="btn btn-primary"
            onClick={mode === 'single' ? handleSingleImport : handleBatchImport}
            disabled={loading || (mode === 'single' && !validation?.valid)}
          >
            {loading ? '导入中...' : '导入'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />

      {/* 模式切换 */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${mode === 'single' ? 'active' : ''}`}
          onClick={() => setMode('single')}
        >
          单个导入
        </button>
        <button
          className={`mode-tab ${mode === 'batch' ? 'active' : ''}`}
          onClick={() => setMode('batch')}
        >
          批量导入
        </button>
      </div>

      {mode === 'single' ? (
        <div className="modal-form">
          <label>
            <span>Kiro 凭据 JSON</span>
            <textarea
              rows={8}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={`{\n  "accessToken": "...",\n  "refreshToken": "...",\n  "profileArn": "...",\n  "authMethod": "social"\n}\n\n或 Kiro Account Manager 导出 JSON：\n{\n  "version": "1.6.1",\n  "accounts": [\n    {\n      "email": "name@example.com",\n      "credentials": { "refreshToken": "...", "accessToken": "...", "authMethod": "social" }\n    }\n  ]\n}`}
            />
          </label>
          {validation && (
            <div className={`validation-hint ${validation.valid ? 'valid' : 'invalid'}`}>
              <i className={`fas ${validation.valid ? 'fa-check-circle' : 'fa-exclamation-circle'}`} />
              {validation.message}
            </div>
          )}
        </div>
      ) : (
        <>
          {progress && (
            <div className="progress-card">
              <div className="progress-meta">
                <span>进度：{progress.current}/{progress.total}</span>
                <span>成功 {progress.success} / 失败 {progress.failed}</span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-bar-inner"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                ></div>
              </div>
            </div>
          )}
          {result && (
            <div className="notice-banner notice-success">
              导入完成：成功 {result.success} 个，失败 {result.failed} 个
            </div>
          )}
          <div className="modal-form">
            <label>
              <span>批量凭据</span>
              <textarea
                rows={10}
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={`email|password|clientId|clientSecret|refreshToken|accessToken\n\n或粘贴 Kiro Account Manager 导出 JSON`}
              />
            </label>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/**
 * Kiro OAuth 授权弹窗
 */
export function KiroOAuthModal({ open, poolId, onClose, onSuccess }) {
  const [authUrl, setAuthUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAuthUrl('');
    setError('');
    generateAuthUrl();
  }, [open]);

  const generateAuthUrl = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await providerService.generateAuthUrl('claude-kiro-oauth', {
        method: 'builder-id',
        poolId: poolId || undefined,
      });
      if (result.authUrl) {
        setAuthUrl(result.authUrl);
      } else {
        setError('生成授权链接失败');
      }
    } catch (e) {
      setError(e.message || '生成授权链接失败');
    } finally {
      setLoading(false);
    }
  };

  // 关闭时取消后端轮询任务
  const handleClose = async () => {
    try {
      await providerService.cancelKiroPolling();
    } catch (e) {
      console.warn('取消 Kiro 轮询失败:', e);
    }
    onClose();
  };

  const handleCopy = async () => {
    if (authUrl) {
      await navigator.clipboard.writeText(authUrl);
    }
  };

  const handleOpen = () => {
    if (authUrl) {
      window.open(authUrl, '_blank');
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="AWS Builder ID 授权"
      subtitle="使用 AWS Builder ID 进行 OAuth 授权"
      size="md"
      footer={
        <button className="btn btn-secondary" onClick={handleClose}>
          关闭
        </button>
      }
    >
      <NoticeBanner type="error" message={error} />

      {loading ? (
        <div className="auth-loading">
          <i className="fas fa-spinner fa-spin" />
          <span>正在生成授权链接...</span>
        </div>
      ) : authUrl ? (
        <div className="auth-card">
          <p>请点击下方按钮打开授权页面，完成 AWS Builder ID 登录后，系统将自动获取凭据。</p>
          <div className="auth-actions">
            <button className="btn btn-primary" onClick={handleOpen}>
              <i className="fas fa-external-link-alt" /> 打开授权页面
            </button>
            <button className="btn btn-secondary" onClick={handleCopy}>
              <i className="fas fa-copy" /> 复制链接
            </button>
          </div>
          <div className="auth-url-preview">
            <code>{authUrl}</code>
          </div>
        </div>
      ) : (
        <div className="auth-card">
          <p>点击下方按钮重新生成授权链接</p>
          <button className="btn btn-primary" onClick={generateAuthUrl}>
            <i className="fas fa-sync-alt" /> 重新生成
          </button>
        </div>
      )}
    </ModalShell>
  );
}
