/**
 * OAuth 授权链接弹窗（复用 Providers 样式）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { providerService } from '../services/provider.service';

function ModalShell({ open, onClose, title, subtitle, size = 'md', children, footer, onBeforeClose }) {
  const wrappedClose = async () => {
    if (onBeforeClose) await onBeforeClose();
    onClose();
  };
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        wrappedClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, onBeforeClose]);

  if (!open) return null;

  return (
    <div className="providers-modal-overlay" onClick={wrappedClose}>
      <div
        className={`providers-modal-card providers-modal-${size}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="providers-modal-header">
          <div className="providers-modal-header-info">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="providers-modal-close" onClick={wrappedClose} aria-label="关闭">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="providers-modal-body">{children}</div>
        {footer && <div className="providers-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

function NoticeBanner({ type, message }) {
  if (!message) return null;
  return <div className={`notice-banner notice-${type}`}>{message}</div>;
}

export default function AuthUrlModal({
  open,
  providerType,
  providerLabel,
  authUrl,
  authInfo,
  pools,
  onClose,
  onRegenerate,
  onManualCallback,
  onSuccess,
  onContinueAuth
}) {
  const DEFAULT_BUILDER_START_URL = 'https://view.awsapps.com/start';
  const [callbackUrl, setCallbackUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('success');
  const [port, setPort] = useState('');
  const [builderStartUrl, setBuilderStartUrl] = useState('');
  const [builderStartMode, setBuilderStartMode] = useState('personal');
  const [builderIdcRegion, setBuilderIdcRegion] = useState('');
  const [builderRuntimeRegion, setBuilderRuntimeRegion] = useState('');
  const [builderRegionMode, setBuilderRegionMode] = useState('custom');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingAuthUrl, setPendingAuthUrl] = useState('');
  const [continuousMode, setContinuousMode] = useState(false);
  const [successCount, setSuccessCount] = useState(0);
  const [successEmails, setSuccessEmails] = useState([]);
  const [batchMode, setBatchMode] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [debugLogs, setDebugLogs] = useState([]);

  const isCodex = (authInfo?.provider || providerType) === 'openai-codex';

  const resolvedProvider = authInfo?.provider || providerType;
  const isGrok = resolvedProvider === 'openai-xai-oauth';
  const isGrokDeviceFlow = isGrok && authInfo?.flow === 'device-code';
  const isGrokOidc = isGrok && authInfo?.flow === 'authorization-code';
  const devicePort = authInfo?.callbackPort || authInfo?.port || '';
  const requiredPort = devicePort || window.location.port || '3000';
  const isKiroSocial = resolvedProvider === 'claude-kiro-oauth' && authInfo?.authMethod === 'social';
  const isKiroBuilderCode = resolvedProvider === 'claude-kiro-oauth' &&
    authInfo?.authMethod === 'builder-id' &&
    authInfo?.flow === 'authorization-code';
  const isDeviceFlow = resolvedProvider === 'openai-qwen-oauth' ||
    resolvedProvider === 'openai-codex' ||
    isGrokDeviceFlow ||
    (resolvedProvider === 'claude-kiro-oauth' && authInfo?.authMethod === 'builder-id' && !isKiroBuilderCode);
  const isNoCallbackFlow = resolvedProvider === 'openai-qwen-oauth' ||
    isGrokDeviceFlow ||
    (resolvedProvider === 'claude-kiro-oauth' && authInfo?.authMethod === 'builder-id' && !isKiroBuilderCode);
  const showBuilderStart = resolvedProvider === 'claude-kiro-oauth' && authInfo?.authMethod === 'builder-id';
  const modalLabel = providerLabel || resolvedProvider || providerType || 'OAuth';

  const resolvedStartUrl = builderStartMode === 'personal'
    ? DEFAULT_BUILDER_START_URL
    : builderStartUrl;
  const resolvedIdcRegion = builderIdcRegion || 'us-east-1';
  const resolvedRuntimeRegion = builderRegionMode === 'sync'
    ? resolvedIdcRegion
    : (builderRuntimeRegion || 'us-east-1');
  const resolvedPoolId = selectedPoolId || '';
  const authStartUrl = authInfo?.builderIDStartURL || DEFAULT_BUILDER_START_URL;
  const authIdcRegion = authInfo?.idcRegion || 'us-east-1';
  const authRegion = authInfo?.region || 'us-east-1';
  const authPoolId = authInfo?.poolId ? String(authInfo.poolId) : '';
  const authPort = authInfo?.port || authInfo?.callbackPort || '';
  const debugKeywords = useMemo(() => {
    const providerKey = String(resolvedProvider || '').toLowerCase();
    if (providerKey === 'claude-kiro-oauth') return ['kiro', 'builder id', 'awsapps', providerKey];
    if (providerKey === 'openai-codex') return ['codex', providerKey];
    if (providerKey === 'openai-xai-oauth') return ['xai', 'grok', 'device authorization', providerKey];
    if (providerKey === 'openai-qwen-oauth') return ['qwen', providerKey];
    if (providerKey === 'openai-iflow') return ['iflow', providerKey];
    if (providerKey === 'claude-offical') return ['claude official', 'anthropic', providerKey];
    return [providerKey].filter(Boolean);
  }, [resolvedProvider, authInfo?.authMethod]);

  const appendDebugLog = (message, level = 'info') => {
    if (!message) return;
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setDebugLogs((prev) => {
      const next = [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        level,
        message: String(message)
      }];
      return next.slice(-30);
    });
  };

  const isRelevantDebugLog = (entry) => {
    const message = String(entry?.message || '').toLowerCase();
    if (!message) return false;
    return debugKeywords.some((keyword) => keyword && message.includes(keyword));
  };

  const hasErrorLogs = debugLogs.some((entry) => entry.level === 'error' || entry.level === 'warn');

  const defaultPoolId = useMemo(() => {
    if (!Array.isArray(pools) || pools.length === 0) return '';
    const defaultPool = pools.find((pool) => pool.isDefault) || pools[0];
    return defaultPool?.id ? String(defaultPool.id) : '';
  }, [pools]);
  const isDirty = showBuilderStart
    ? (resolvedStartUrl || DEFAULT_BUILDER_START_URL) !== (authStartUrl || DEFAULT_BUILDER_START_URL) ||
      resolvedIdcRegion !== authIdcRegion ||
      resolvedRuntimeRegion !== authRegion ||
      String(resolvedPoolId) !== String(authPoolId) ||
      (!isDeviceFlow && !isGrokOidc && String(port || '') !== String(authPort || ''))
    : (!isDeviceFlow && !isGrokOidc && !isKiroSocial && String(port || '') !== String(authPort || '')) ||
      String(resolvedPoolId) !== String(authPoolId);

  useEffect(() => {
    if (!open) return;
    setCallbackUrl('');
    setNotice('');
    setPort(String(requiredPort));
    const startUrl = authInfo?.builderIDStartURL || DEFAULT_BUILDER_START_URL;
    setBuilderStartUrl(startUrl);
    setBuilderStartMode(startUrl === DEFAULT_BUILDER_START_URL ? 'personal' : 'enterprise');
    const idcRegion = authInfo?.idcRegion || 'us-east-1';
    const runtimeRegion = authInfo?.region || 'us-east-1';
    setBuilderIdcRegion(idcRegion);
    setBuilderRuntimeRegion(runtimeRegion);
    setBuilderRegionMode(runtimeRegion === idcRegion ? 'sync' : 'custom');
    setSelectedPoolId(authInfo?.poolId || '');
    setPendingOpen(false);
    setPendingAuthUrl('');
    setSuccessCount(0);
    setSuccessEmails([]);
    setBatchMode(false);
    setBatchLoading(false);
    setDebugLogs([]);
  }, [open, requiredPort, authInfo]);

  useEffect(() => {
    if (!open) return;
    if (authInfo?.poolId) return;
    if (selectedPoolId) return;
    if (!defaultPoolId) return;
    setSelectedPoolId(defaultPoolId);
  }, [open, authInfo, selectedPoolId, defaultPoolId]);

  // 监听 SSE oauth_success 事件
  useEffect(() => {
    if (!open) return;

    const token = localStorage.getItem('token');
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const streamUrl = `${window.location.origin}/api/logs/stream${query}`;
    const eventSource = new EventSource(streamUrl);

    const handleOAuthSuccess = (event) => {
      try {
        const data = JSON.parse(event.data);
        const matchesTask = !authInfo?.taskId || !data.taskId || data.taskId === authInfo.taskId;
        if (data.provider === resolvedProvider && matchesTask) {
          const email = data.email || data.displayName || '';
          const successLabel = data.duplicate ? '账号已存在，Token 已更新' : '授权成功';
          setSuccessCount((prev) => prev + 1);
          if (email) setSuccessEmails((prev) => [...prev, email]);
          appendDebugLog(`${successLabel}${email ? ` (${email})` : ''}`, 'success');

          if (continuousMode && onContinueAuth) {
            setNotice(`${successLabel}${email ? ` (${email})` : ''}，正在生成下一个链接...`);
            setNoticeType('success');
            setCallbackUrl('');
            onContinueAuth({
              port: port || undefined,
              builderIDStartURL: resolvedStartUrl || undefined,
              idcRegion: resolvedIdcRegion || undefined,
              region: resolvedRuntimeRegion || undefined,
              poolId: resolvedPoolId || undefined,
            });
          } else {
            setNotice(`${successLabel}！`);
            setNoticeType('success');
            onSuccess?.();
          }
        }
      } catch (err) {
        console.error('Failed to parse oauth_success event:', err);
      }
    };

    const handleOAuthError = (event) => {
      try {
        const data = JSON.parse(event.data);
        const matchesTask = !authInfo?.taskId || !data.taskId || data.taskId === authInfo.taskId;
        if (data.provider === resolvedProvider && matchesTask) {
          const message = data.error || '授权失败';
          appendDebugLog(message, 'error');
          setNotice(message);
          setNoticeType('error');
        }
      } catch (err) {
        console.error('Failed to parse oauth_error event:', err);
      }
    };

    const handleLogEvent = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!isRelevantDebugLog(data)) return;
        const level = data.level || 'info';
        const normalized = String(data.message || '');
        if (!['warn', 'error'].includes(level) && !/[失败错异常error]/i.test(normalized)) return;
        appendDebugLog(normalized, level);
      } catch (err) {
        console.error('Failed to parse log event:', err);
      }
    };

    eventSource.addEventListener('oauth_success', handleOAuthSuccess);
    eventSource.addEventListener('oauth_error', handleOAuthError);
    eventSource.addEventListener('log', handleLogEvent);

    return () => {
      eventSource.removeEventListener('oauth_success', handleOAuthSuccess);
      eventSource.removeEventListener('oauth_error', handleOAuthError);
      eventSource.removeEventListener('log', handleLogEvent);
      eventSource.close();
    };
  }, [
    open,
    resolvedProvider,
    onSuccess,
    continuousMode,
    onContinueAuth,
    port,
    resolvedStartUrl,
    resolvedIdcRegion,
    resolvedRuntimeRegion,
    resolvedPoolId,
    authInfo?.taskId,
  ]);

  // Free 批量授权模式：启动/停止
  const handleToggleBatchMode = async (enabled) => {
    if (enabled) {
      setBatchLoading(true);
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch('/api/codex/batch-auth/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ poolId: resolvedPoolId || undefined })
        });
        const data = await resp.json();
        if (data.success || data.authUrl) {
          setBatchMode(true);
          appendDebugLog('批量授权模式已启动，回调服务器持续运行', 'success');
          setNotice('批量授权模式已启动，回调服务器持续运行');
          setNoticeType('success');
        } else {
          appendDebugLog(data.error || '启动失败', 'error');
          setNotice(data.error || '启动失败');
          setNoticeType('error');
        }
      } catch (err) {
        appendDebugLog('启动批量授权失败: ' + (err.message || err), 'error');
        setNotice('启动批量授权失败: ' + (err.message || err));
        setNoticeType('error');
      }
      setBatchLoading(false);
    } else {
      setBatchLoading(true);
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch('/api/codex/batch-auth/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          }
        });
        const data = await resp.json();
        setBatchMode(false);
        if (data.successCount > 0) {
          appendDebugLog(`批量授权已停止，共成功 ${data.successCount} 个`, 'success');
          setNotice(`批量授权已停止，共成功 ${data.successCount} 个`);
        } else {
          appendDebugLog('批量授权已停止', 'success');
          setNotice('批量授权已停止');
        }
        setNoticeType('success');
      } catch (err) {
        appendDebugLog('停止批量授权失败: ' + (err.message || err), 'error');
        setNotice('停止批量授权失败: ' + (err.message || err));
        setNoticeType('error');
        setBatchMode(false);
      }
      setBatchLoading(false);
    }
  };

  const instructions = useMemo(() => {
    if (resolvedProvider === 'openai-qwen-oauth') {
      return [
        '打开授权链接并登录 Qwen',
        '完成授权后复制回调链接',
        '将回调链接粘贴到下方进行手动回调',
      ];
    }
    if (resolvedProvider === 'openai-codex') {
      return [
        '打开授权链接并登录 OpenAI',
        '授权完成后会自动回调到本地端口',
        '如未自动回调，可复制回调链接手动提交',
      ];
    }
    if (isGrok) {
      if (authInfo?.flow === 'authorization-code') {
        return [
          '打开 xAI 授权页面并登录 Grok 账号',
          '授权后浏览器会跳转到 127.0.0.1 地址，页面打不开属于正常现象',
          '复制地址栏中的完整回调地址，粘贴到下方提交',
        ];
      }
      return [
        '打开 xAI 授权页面并登录 Grok 账号',
        authInfo?.userCode ? `确认设备验证码：${authInfo.userCode}` : '在授权页面输入设备验证码',
        '完成授权后保持此弹窗打开，系统会自动保存账号',
      ];
    }
    if (resolvedProvider === 'claude-kiro-oauth') {
      if (authInfo?.authMethod === 'social') {
        return [
          '打开授权链接并选择 Google 账号',
          '浏览器跳转到 kiro:// 开头的地址后复制完整地址',
          '粘贴到下方手动回调并提交',
        ];
      }
      if (isKiroBuilderCode) {
        return [
          '打开 AWS 授权链接，可在 AWS 页面中选择 Google 登录',
          '浏览器跳转到 127.0.0.1 回调地址后复制完整地址',
          '粘贴到下方手动回调并提交',
        ];
      }
      return [
        '打开授权链接并选择对应账号',
        '完成登录后授权访问',
        '等待回调完成或手动提交回调链接',
      ];
    }
    if (resolvedProvider === 'openai-iflow') {
      return [
        '打开授权链接并完成 iFlow 登录',
        '授权完成后返回此页面',
        '系统会自动保存凭据',
      ];
    }
    return [
      '打开授权链接并登录',
      '完成授权后返回此页面',
      '系统自动写入授权凭据',
    ];
  }, [resolvedProvider, authInfo?.authMethod, authInfo?.flow, authInfo?.userCode, isKiroBuilderCode, isGrok]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(authUrl || '');
      setNotice('链接已复制');
      setNoticeType('success');
    } catch (err) {
      appendDebugLog('复制失败: ' + (err.message || err), 'error');
      setNotice('复制失败');
      setNoticeType('error');
    }
  };

  const handleOpenWindow = () => {
    if (!authUrl && !onRegenerate) return;
    if (isDirty && onRegenerate) {
      setPendingOpen(true);
      setPendingAuthUrl(authUrl || '');
      setNotice('已更新链接，稍后自动打开');
      setNoticeType('success');
      handleRegenerate();
      return;
    }
    if (!authUrl) return;
    window.open(authUrl, 'OAuthAuthWindow', 'width=760,height=820,resizable=yes,scrollbars=yes');
  };

  const handleManualSubmit = async () => {
    if (!callbackUrl.trim()) {
      appendDebugLog('请输入回调 URL', 'error');
      setNotice('请输入回调 URL');
      setNoticeType('error');
      return;
    }
    try {
      if (!onManualCallback) {
        throw new Error('手动回调未启用');
      }
      const response = await onManualCallback(callbackUrl.trim());
      if (response?.success === false) {
        throw new Error(response?.error || '回调处理失败');
      }
      appendDebugLog('回调处理成功', 'success');
      setNotice('回调处理成功');
      setNoticeType('success');
      onSuccess?.();
    } catch (err) {
      appendDebugLog(err.message || '回调处理失败', 'error');
      setNotice(err.message || '回调处理失败');
      setNoticeType('error');
    }
  };

  const handleRegenerate = async () => {
    if (!onRegenerate) return;
    const options = {
      ...authInfo,
      port: port || undefined,
      builderIDStartURL: resolvedStartUrl || undefined,
      idcRegion: resolvedIdcRegion || undefined,
      region: resolvedRuntimeRegion || undefined,
      poolId: resolvedPoolId || undefined,
    };
    delete options.provider;
    delete options.redirectUri;
    delete options.callbackPort;
    try {
      appendDebugLog('正在刷新授权链接...', 'info');
      if (isGrok && authInfo?.taskId) {
        await providerService.cancelXaiPolling(authInfo.taskId);
      }
      await onRegenerate(options);
    } catch (err) {
      appendDebugLog(err.message || '刷新链接失败', 'error');
      setNotice(err.message || '刷新链接失败');
      setNoticeType('error');
    }
  };

  useEffect(() => {
    if (!pendingOpen) return;
    if (!authUrl) return;
    if (authUrl === pendingAuthUrl) return;
    if (isDirty) return;
    window.open(authUrl, 'OAuthAuthWindow', 'width=760,height=820,resizable=yes,scrollbars=yes');
    setPendingOpen(false);
    setPendingAuthUrl('');
  }, [pendingOpen, authUrl, pendingAuthUrl, isDirty]);

  // 连续授权模式：URL 更新后自动打开新窗口
  const prevAuthUrlRef = useRef(authUrl);
  useEffect(() => {
    if (!continuousMode || !open) return;
    if (!authUrl || authUrl === prevAuthUrlRef.current) return;
    if (successCount === 0) { prevAuthUrlRef.current = authUrl; return; }
    prevAuthUrlRef.current = authUrl;
    window.open(authUrl, 'OAuthAuthWindow', 'width=760,height=820,resizable=yes,scrollbars=yes');
  }, [authUrl, continuousMode, open, successCount]);

  const cleanupPendingAuthorization = async () => {
    if (batchMode) {
      try {
        const token = localStorage.getItem('token');
        await fetch('/api/codex/batch-auth/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          }
        });
        setBatchMode(false);
      } catch { /* ignore */ }
    }
    if (isGrok && authInfo?.taskId) {
      try {
        await providerService.cancelXaiPolling(authInfo.taskId);
      } catch { /* ignore */ }
    }
  };

  const handleClose = async () => {
    await cleanupPendingAuthorization();
    onClose();
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      onBeforeClose={cleanupPendingAuthorization}
      title="授权链接已生成"
      subtitle={`当前提供商：${modalLabel}`}
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={handleClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleOpenWindow}>
            <i className="fas fa-external-link-alt"></i>
            打开授权页面
          </button>
        </>
      }
    >
      <NoticeBanner type={noticeType} message={notice} />

      {(noticeType === 'error' || hasErrorLogs) && (
        <div className="manual-callback">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <h4><i className="fas fa-file-alt"></i>调试日志</h4>
            <button className="btn btn-outline btn-sm" onClick={() => setDebugLogs([])}>清空</button>
          </div>
          <p>显示本次授权弹窗捕获到的错误与相关后端日志。</p>
          <div style={{ maxHeight: '220px', overflow: 'auto', background: '#111827', borderRadius: '8px', padding: '10px 12px', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6', color: '#e5e7eb' }}>
            {debugLogs.length > 0 ? debugLogs.map((entry) => (
              <div key={entry.id} style={{ color: entry.level === 'error' ? '#fca5a5' : entry.level === 'warn' ? '#fde68a' : entry.level === 'success' ? '#86efac' : '#cbd5e1' }}>
                [{entry.timestamp}] {entry.message}
              </div>
            )) : (
              <div style={{ color: '#9ca3af' }}>暂时没有捕获到相关日志</div>
            )}
          </div>
        </div>
      )}

      {onContinueAuth && (
        <div className="auth-continuous-bar">
          <label className="auth-toggle-label">
            <input
              type="checkbox"
              checked={continuousMode}
              onChange={(e) => setContinuousMode(e.target.checked)}
            />
            <span>连续授权模式</span>
            <span className="auth-helper">授权成功后自动生成下一个链接，无需关闭弹窗</span>
          </label>
          {successCount > 0 && (
            <span className="auth-success-count">
              <i className="fas fa-check-circle"></i> 已成功 {successCount} 个
            </span>
          )}
        </div>
      )}

      {isCodex && (
        <div className="auth-continuous-bar">
          <label className="auth-toggle-label">
            <input
              type="checkbox"
              checked={batchMode}
              disabled={batchLoading}
              onChange={(e) => handleToggleBatchMode(e.target.checked)}
            />
            <span>{batchLoading ? '处理中...' : 'Free 批量授权模式'}</span>
            <span className="auth-helper">配合注册机使用，回调服务器持续运行，注册完自动授权</span>
          </label>
          {batchMode && (
            <>
              <span className="auth-success-count" style={{ color: '#f59e0b' }}>
                <i className="fas fa-bolt"></i> 回调服务运行中
              </span>
              <button
                className="btn btn-sm"
                style={{
                  marginLeft: '8px',
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '4px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                disabled={batchLoading}
                onClick={() => handleToggleBatchMode(false)}
              >
                <i className="fas fa-stop-circle"></i> 停止授权
              </button>
            </>
          )}
        </div>
      )}
      {successEmails.length > 0 && (
        <div className="auth-success-list">
          {successEmails.map((email, i) => (
            <span key={i} className="auth-success-tag"><i className="fas fa-user-check"></i> {email}</span>
          ))}
        </div>
      )}

      <div className="auth-info-grid">
        <div className="auth-card">
          <h4><i className="fas fa-list-ol"></i>授权步骤</h4>
          <ol>
            {instructions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
        <div className="auth-card">
          <h4><i className="fas fa-plug"></i>端口配置</h4>
          <p>
            {isGrokOidc
              ? 'Grok Build 使用浏览器本地回调，授权后复制完整回调地址提交。'
              : (isDeviceFlow || isKiroSocial
                ? '此授权方式无需回调端口。'
                : '回调服务端口用于接收 OAuth 回调。')}
          </p>
          {isKiroSocial ? (
            <div className="auth-port">kiro:// 回调</div>
          ) : isGrokOidc ? (
            <div className="auth-port">{devicePort || '本地回调'}</div>
          ) : isDeviceFlow ? (
            <div className="auth-port">{devicePort || '无需回调'}</div>
          ) : (
            <div className="auth-port-edit">
              <input type="number" value={port} onChange={(event) => setPort(event.target.value)} />
              <button className="btn btn-outline btn-sm" onClick={handleRegenerate}>
                重新生成
              </button>
            </div>
          )}
          {showBuilderStart && (
            <div className="auth-builder-url">
              <label>账号类型</label>
              <div className="auth-start-toggle">
                <button
                  type="button"
                  className={`auth-toggle-btn ${builderStartMode === 'personal' ? 'active' : ''}`}
                  onClick={() => {
                    setBuilderStartMode('personal');
                    setBuilderStartUrl(DEFAULT_BUILDER_START_URL);
                  }}
                >
                  个人账号
                </button>
                <button
                  type="button"
                  className={`auth-toggle-btn ${builderStartMode === 'enterprise' ? 'active' : ''}`}
                  onClick={() => {
                    setBuilderStartMode('enterprise');
                    if (builderStartUrl === DEFAULT_BUILDER_START_URL) {
                      setBuilderStartUrl('');
                    }
                  }}
                >
                  企业账号
                </button>
              </div>
              <span className="auth-helper">
                企业账号需要填写 Access Portal Start URL（如 https://d-xxxx.awsapps.com/start）
              </span>
            </div>
          )}
          {showBuilderStart && (
            <div className="auth-builder-url">
              <label>Builder ID Start URL</label>
              <input
                type="text"
                value={builderStartUrl}
                onChange={(event) => setBuilderStartUrl(event.target.value)}
                placeholder="https://d-xxxx.awsapps.com/start"
                disabled={builderStartMode === 'personal'}
              />
              <span className="auth-helper">修改后点击“刷新链接”生效</span>
              <button className="btn btn-outline btn-sm" onClick={handleRegenerate}>
                刷新链接
              </button>
            </div>
          )}
          {showBuilderStart && (
            <div className="auth-builder-url">
              <label>IDC Region</label>
              <input
                type="text"
                value={builderIdcRegion}
                onChange={(event) => setBuilderIdcRegion(event.target.value)}
                placeholder="us-east-1"
              />
              <button className="btn btn-outline btn-sm" onClick={handleRegenerate}>
                刷新链接
              </button>
            </div>
          )}
          {showBuilderStart && (
            <div className="auth-builder-url">
              <label>Runtime Region</label>
              <div className="auth-start-toggle">
                <button
                  type="button"
                  className={`auth-toggle-btn ${builderRegionMode === 'sync' ? 'active' : ''}`}
                  onClick={() => setBuilderRegionMode('sync')}
                >
                  与 IDC 一致
                </button>
                <button
                  type="button"
                  className={`auth-toggle-btn ${builderRegionMode === 'custom' ? 'active' : ''}`}
                  onClick={() => setBuilderRegionMode('custom')}
                >
                  自定义
                </button>
              </div>
              {builderRegionMode === 'custom' ? (
                <input
                  type="text"
                  value={builderRuntimeRegion}
                  onChange={(event) => setBuilderRuntimeRegion(event.target.value)}
                  placeholder="us-east-1"
                />
              ) : (
                <div className="auth-port">{resolvedIdcRegion || 'us-east-1'}</div>
              )}
              <span className="auth-helper">用于 q.&lt;region&gt;.amazonaws.com 请求区域</span>
              <button className="btn btn-outline btn-sm" onClick={handleRegenerate}>
                刷新链接
              </button>
            </div>
          )}
          {(pools && pools.length > 0) && (
            <div className="auth-builder-url">
              <label>目标号池</label>
              <select
                value={selectedPoolId}
                onChange={(event) => setSelectedPoolId(event.target.value)}
                className="auth-pool-select"
              >
                <option value="">默认号池</option>
                {pools.map((pool) => (
                  <option key={pool.id} value={pool.id}>{pool.name}</option>
                ))}
              </select>
              <button className="btn btn-outline btn-sm" onClick={handleRegenerate}>
                刷新链接
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="auth-url-block">
        <label>授权链接</label>
        <div className="auth-url-row">
          <input type="text" value={authUrl || ''} readOnly />
          <button className="btn btn-outline" onClick={handleCopy}>
            <i className="fas fa-copy"></i>
            复制
          </button>
        </div>
        {isDirty && (
          <div className="auth-helper">配置已修改，请先刷新链接</div>
        )}
      </div>

      {isGrok && authInfo?.userCode && (
        <div className="auth-url-block">
          <label>设备验证码</label>
          <div className="auth-url-row">
            <input type="text" value={authInfo.userCode} readOnly />
            <button
              className="btn btn-outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(authInfo.userCode);
                  setNotice('设备验证码已复制');
                  setNoticeType('success');
                } catch {
                  setNotice('复制失败');
                  setNoticeType('error');
                }
              }}
            >
              <i className="fas fa-copy"></i>
              复制
            </button>
          </div>
          <div className="auth-helper">
            验证码有效期约 {Math.max(1, Math.floor(Number(authInfo.expiresIn || 0) / 60))} 分钟，授权完成后账号会自动写入目标号池。
          </div>
        </div>
      )}

      {!isNoCallbackFlow && (
        <div className="manual-callback">
          <h4><i className="fas fa-hand-pointer"></i>手动回调</h4>
          <p>{isKiroSocial ? '授权后请粘贴 kiro:// 开头的完整回调地址。' : '如果浏览器未自动回调，可粘贴回调 URL 进行处理。'}</p>
          <div className="auth-url-row">
            <input
              type="text"
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="粘贴包含 code=... 的回调 URL"
            />
            <button className="btn btn-primary" onClick={handleManualSubmit}>
              提交回调
            </button>
          </div>
        </div>
      )}

      {isCodex && (
        <div className="manual-callback">
          <h4><i className="fas fa-robot"></i>外部回调 API（注册机用）</h4>
          <p>注册机捕获到 localhost 回调 URL 后，POST 到此接口即可自动完成授权。</p>
          <div className="auth-url-row">
            <input
              type="text"
              value={`${window.location.origin}/api/codex/external-callback`}
              readOnly
            />
            <button
              className="btn btn-outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}/api/codex/external-callback`);
                  setNotice('API 地址已复制');
                  setNoticeType('success');
                } catch { setNotice('复制失败'); setNoticeType('error'); }
              }}
            >
              <i className="fas fa-copy"></i> 复制
            </button>
          </div>
          <div className="auth-helper" style={{ marginTop: '8px', fontSize: '12px', color: '#9ca3af' }}>
            <code style={{ background: '#1f2937', padding: '8px 12px', borderRadius: '6px', display: 'block', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
{`POST ${window.location.origin}/api/codex/external-callback
Content-Type: application/json

{"callbackUrl": "http://localhost:1455/auth/callback?code=xxx&state=xxx"}`}
            </code>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
