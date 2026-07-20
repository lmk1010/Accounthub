import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { providerService } from '../services/provider.service';
import './GrokRegistration.css';

const RUNNING_STATUSES = new Set(['running', 'stopping', 'importing']);

const STATUS_LABELS = {
  running: '运行中',
  stopping: '停止中',
  importing: '导入中',
  completed: '已完成',
  completed_with_errors: '部分完成',
  stopped: '已停止',
  failed: '失败',
};

const STAGE_LABELS = {
  starting: '启动',
  preparing: '准备引擎',
  registering: '注册账号',
  converting: '生成 JSON',
  importing: '导入号池',
  completed: '完成',
  stopping: '停止',
  stopped: '已停止',
  failed: '失败',
};

const initialForm = {
  emailProvider: 'cloudmail',
  count: 1,
  threads: 1,
  poolId: '',
  proxy: '',
  domains: '',
  cloudmailUrl: '',
  cloudmailAdminEmail: '',
  cloudmailPassword: '',
  cloudflareApiBase: '',
  cloudflareApiKey: '',
  cloudflareAuthMode: 'bearer',
  cloudflarePathDomains: '/domains',
  cloudflarePathAccounts: '/accounts',
  cloudflarePathToken: '/token',
  cloudflarePathMessages: '/messages',
  duckmailApiKey: '',
  yydsApiKey: '',
  yydsJwt: '',
  hotmailAccounts: '',
  fastMode: true,
  browserReuse: true,
  useUv: true,
  pythonCommand: 'python3',
  registerEnginePath: '',
  converterScriptPath: '',
};

function buildEventsUrl() {
  const apiBase = String(import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');
  if (/^https?:\/\//i.test(apiBase)) return `${apiBase}/events`;
  return new URL(`${apiBase}/events`, window.location.origin).toString();
}

function normalizePools(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function mergeLogs(current, incoming) {
  const combined = [...current, ...(Array.isArray(incoming) ? incoming : [])];
  const bySequence = new Map();
  combined.forEach((entry, index) => {
    const key = entry?.seq ?? `${entry?.timestamp || ''}-${entry?.message || ''}-${index}`;
    bySequence.set(key, entry);
  });
  return [...bySequence.values()]
    .sort((a, b) => (a?.seq || 0) - (b?.seq || 0))
    .slice(-1200);
}

function getPoolName(pool) {
  if (!pool) return '';
  return pool?.name || pool?.poolName || `号池 ${pool?.id}`;
}

function getPoolId(pool) {
  return pool?.id ?? pool?.poolId ?? pool?.pool_id;
}

export default function GrokRegistration() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedPoolId = searchParams.get('poolId') || '';
  const requestedPoolName = searchParams.get('poolName') || '';
  const [form, setForm] = useState({ ...initialForm, poolId: requestedPoolId });
  const [pools, setPools] = useState([]);
  const [task, setTask] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const taskIdRef = useRef(null);
  const logEndRef = useRef(null);

  const isRunning = Boolean(task && RUNNING_STATUSES.has(task.status));
  const metrics = task?.metrics || {};
  const selectedPool = pools.find((pool) => String(getPoolId(pool)) === String(form.poolId));
  const returnUrl = useMemo(() => {
    if (!form.poolId) return '/providers/openai-xai-oauth';
    const params = new URLSearchParams({
      pool: form.poolId,
      poolName: getPoolName(selectedPool) || requestedPoolName || '默认池',
    });
    return `/providers/openai-xai-oauth?${params.toString()}`;
  }, [form.poolId, requestedPoolName, selectedPool]);

  const updateField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const hydrateTask = useCallback((nextTask) => {
    if (!nextTask) return;
    taskIdRef.current = nextTask.id;
    setTask(nextTask);
    setLogs((current) => mergeLogs(current, nextTask.logs));
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await providerService.getXaiRegistrationStatus();
      setEnvironment(response?.environment || null);
      if (response?.defaults) {
        setForm((current) => ({
          ...current,
          pythonCommand: current.pythonCommand || response.defaults.pythonCommand || 'python3',
          registerEnginePath: current.registerEnginePath || response.defaults.registerEnginePath || '',
          converterScriptPath: current.converterScriptPath || response.defaults.converterScriptPath || '',
          useUv: current.useUv ?? response.defaults.useUv,
        }));
      }
      if (response?.task) hydrateTask(response.task);
      return response?.task || null;
    } catch (statusError) {
      setError(statusError?.response?.data?.error || statusError?.message || '注册任务状态加载失败');
      return null;
    }
  }, [hydrateTask]);

  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      setLoading(true);
      try {
        const [poolPayload] = await Promise.all([
          providerService.getPools('openai-xai-oauth'),
          fetchStatus(),
        ]);
        if (!mounted) return;
        const poolList = normalizePools(poolPayload);
        setPools(poolList);
        setForm((current) => {
          if (current.poolId) return current;
          const defaultPool = poolList.find((pool) => pool.isDefault || pool.is_default) || poolList[0];
          return { ...current, poolId: defaultPool ? String(getPoolId(defaultPool)) : '' };
        });
      } catch (loadError) {
        if (mounted) {
          setError(loadError?.response?.data?.error || loadError?.message || 'Grok 注册页面加载失败');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    initialize();
    return () => {
      mounted = false;
    };
  }, [fetchStatus]);

  useEffect(() => {
    const eventSource = new EventSource(buildEventsUrl());
    const parseEvent = (event) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };
    const handleLog = (event) => {
      const data = parseEvent(event);
      if (!data || (taskIdRef.current && data.taskId !== taskIdRef.current)) return;
      if (!taskIdRef.current) taskIdRef.current = data.taskId;
      setLogs((current) => mergeLogs(current, [data]));
    };
    const handleTask = (event) => {
      const data = parseEvent(event);
      if (!data?.task) return;
      if (taskIdRef.current && data.taskId !== taskIdRef.current) return;
      hydrateTask(data.task);
      if (data.error) setError(data.error);
    };
    eventSource.addEventListener('xai_registration_log', handleLog);
    eventSource.addEventListener('xai_registration_progress', handleTask);
    eventSource.addEventListener('xai_registration_complete', handleTask);
    eventSource.addEventListener('xai_registration_error', handleTask);
    return () => eventSource.close();
  }, [hydrateTask]);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = window.setInterval(fetchStatus, 3000);
    return () => window.clearInterval(timer);
  }, [fetchStatus, isRunning]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  const validateForm = () => {
    if (form.emailProvider === 'cloudmail' && (!form.cloudmailUrl || !form.cloudmailAdminEmail || !form.cloudmailPassword)) {
      return '请填写 CloudMail URL、管理员邮箱和密码';
    }
    if (form.emailProvider === 'cloudflare' && !form.cloudflareApiBase) {
      return '请填写 Cloudflare 邮箱 API 地址';
    }
    if (form.emailProvider === 'duckmail' && !form.duckmailApiKey) {
      return '请填写 DuckMail API Key';
    }
    if (form.emailProvider === 'yyds' && !form.yydsApiKey && !form.yydsJwt) {
      return '请填写 YYDS API Key 或 JWT';
    }
    if (['hotmail', 'outlookmail'].includes(form.emailProvider) && !form.hotmailAccounts.trim()) {
      return '请填写 Hotmail/Outlook 四段式凭据';
    }
    return '';
  };

  const handleStart = async () => {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError('');
    setLogs([]);
    try {
      const response = await providerService.startXaiRegistration({
        ...form,
        count: Number(form.count),
        threads: Number(form.threads),
        poolId: form.poolId ? Number(form.poolId) : null,
      });
      if (!response?.task) throw new Error('后端未返回注册任务');
      taskIdRef.current = response.task.id;
      hydrateTask(response.task);
    } catch (startError) {
      setError(startError?.response?.data?.error || startError?.message || 'Grok 注册任务启动失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (!task?.id) return;
    setStopping(true);
    setError('');
    try {
      const response = await providerService.stopXaiRegistration(task.id);
      if (response?.task) hydrateTask(response.task);
    } catch (stopError) {
      setError(stopError?.response?.data?.error || stopError?.message || '停止任务失败');
    } finally {
      setStopping(false);
    }
  };

  const handleDownload = async () => {
    if (!task?.id) return;
    setDownloading(true);
    setError('');
    try {
      const blob = await providerService.downloadXaiRegistrationArtifacts(task.id);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `grok-registration-${task.id}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError?.response?.data?.error || downloadError?.message || '下载 JSON 失败');
    } finally {
      setDownloading(false);
    }
  };

  const renderEmailFields = () => {
    if (form.emailProvider === 'cloudmail') {
      return (
        <>
          <div className="grok-reg-field grok-reg-field-wide">
            <label htmlFor="cloudmail-url">CloudMail URL</label>
            <input id="cloudmail-url" value={form.cloudmailUrl} onChange={(event) => updateField('cloudmailUrl', event.target.value)} placeholder="https://mail.example.com" />
          </div>
          <div className="grok-reg-field">
            <label htmlFor="cloudmail-admin">管理员邮箱</label>
            <input id="cloudmail-admin" value={form.cloudmailAdminEmail} onChange={(event) => updateField('cloudmailAdminEmail', event.target.value)} />
          </div>
          <div className="grok-reg-field">
            <label htmlFor="cloudmail-password">管理员密码</label>
            <input id="cloudmail-password" type="password" value={form.cloudmailPassword} onChange={(event) => updateField('cloudmailPassword', event.target.value)} />
          </div>
        </>
      );
    }
    if (form.emailProvider === 'cloudflare') {
      return (
        <>
          <div className="grok-reg-field grok-reg-field-wide">
            <label htmlFor="cloudflare-base">邮箱 API 地址</label>
            <input id="cloudflare-base" value={form.cloudflareApiBase} onChange={(event) => updateField('cloudflareApiBase', event.target.value)} placeholder="https://temp-mail.example.com" />
          </div>
          <div className="grok-reg-field">
            <label htmlFor="cloudflare-key">API Key</label>
            <input id="cloudflare-key" type="password" value={form.cloudflareApiKey} onChange={(event) => updateField('cloudflareApiKey', event.target.value)} />
          </div>
          <div className="grok-reg-field">
            <label htmlFor="cloudflare-mode">认证方式</label>
            <select id="cloudflare-mode" value={form.cloudflareAuthMode} onChange={(event) => updateField('cloudflareAuthMode', event.target.value)}>
              <option value="bearer">Bearer</option>
              <option value="x-api-key">X-API-Key</option>
              <option value="none">无认证</option>
            </select>
          </div>
          <div className="grok-reg-path-grid grok-reg-field-wide">
            {[
              ['cloudflarePathDomains', 'Domains', '/domains'],
              ['cloudflarePathAccounts', 'Accounts', '/accounts'],
              ['cloudflarePathToken', 'Token', '/token'],
              ['cloudflarePathMessages', 'Messages', '/messages'],
            ].map(([key, label, placeholder]) => (
              <div className="grok-reg-field" key={key}>
                <label htmlFor={key}>{label} 路径</label>
                <input id={key} value={form[key]} onChange={(event) => updateField(key, event.target.value)} placeholder={placeholder} />
              </div>
            ))}
          </div>
        </>
      );
    }
    if (form.emailProvider === 'duckmail') {
      return (
        <div className="grok-reg-field grok-reg-field-wide">
          <label htmlFor="duckmail-key">DuckMail API Key</label>
          <input id="duckmail-key" type="password" value={form.duckmailApiKey} onChange={(event) => updateField('duckmailApiKey', event.target.value)} />
        </div>
      );
    }
    if (form.emailProvider === 'yyds') {
      return (
        <>
          <div className="grok-reg-field">
            <label htmlFor="yyds-key">YYDS API Key</label>
            <input id="yyds-key" type="password" value={form.yydsApiKey} onChange={(event) => updateField('yydsApiKey', event.target.value)} />
          </div>
          <div className="grok-reg-field">
            <label htmlFor="yyds-jwt">YYDS JWT</label>
            <input id="yyds-jwt" type="password" value={form.yydsJwt} onChange={(event) => updateField('yydsJwt', event.target.value)} />
          </div>
        </>
      );
    }
    return (
      <div className="grok-reg-field grok-reg-field-wide">
        <label htmlFor="hotmail-accounts">Hotmail/Outlook 四段式凭据</label>
        <textarea
          id="hotmail-accounts"
          rows={6}
          value={form.hotmailAccounts}
          onChange={(event) => updateField('hotmailAccounts', event.target.value)}
          placeholder="邮箱----密码----ClientID----RefreshToken"
        />
      </div>
    );
  };

  if (loading) {
    return (
      <div className="grok-registration-page grok-registration-loading">
        <i className="fas fa-spinner fa-spin" />
        <span>加载 Grok 注册工作台...</span>
      </div>
    );
  }

  return (
    <div className="grok-registration-page">
      <div className="grok-registration-header">
        <div className="grok-registration-title-row">
          <button className="grok-reg-icon-button" type="button" onClick={() => navigate(returnUrl)} title="返回 Grok 渠道">
            <i className="fas fa-arrow-left" />
          </button>
          <img src="/logos/xai.svg" alt="" className="grok-registration-logo" />
          <div>
            <h1>Grok 注册任务</h1>
            <span>{selectedPool ? getPoolName(selectedPool) : '未指定号池'}</span>
          </div>
        </div>
        <div className={`grok-registration-status status-${task?.status || 'idle'}`}>
          <span className="grok-reg-status-dot" />
          <span>{task ? STATUS_LABELS[task.status] || task.status : '待启动'}</span>
          {task?.stage && <strong>{STAGE_LABELS[task.stage] || task.stage}</strong>}
        </div>
      </div>

      {error && (
        <div className="grok-registration-alert" role="alert">
          <i className="fas fa-exclamation-circle" />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} title="关闭">
            <i className="fas fa-times" />
          </button>
        </div>
      )}

      <div className="grok-registration-metrics">
        {[
          ['目标', metrics.target || Number(form.count) || 0],
          ['注册成功', metrics.registered || 0],
          ['JSON', metrics.generated || metrics.converted || 0],
          ['已导入', metrics.imported || 0],
          ['跳过', metrics.skipped || 0],
          ['失败', (metrics.registrationFailed || 0) + (metrics.conversionFailed || 0) + (metrics.importFailed || 0)],
        ].map(([label, value]) => (
          <div className="grok-registration-metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="grok-registration-workspace">
        <section className="grok-registration-form-pane">
          <div className="grok-reg-section-heading">
            <h2>任务配置</h2>
            <div className="grok-reg-runtime">
              <span className={environment?.registerEngineReady ? 'ready' : 'missing'}>注册引擎</span>
              <span className={environment?.converterReady ? 'ready' : 'missing'}>JSON 转换</span>
              <span className={environment?.uvReady ? 'ready' : 'missing'}>uv</span>
              <span className={environment?.chromiumReady ? 'ready' : 'missing'}>Chromium</span>
              <span className={environment?.displayReady ? 'ready' : 'missing'}>显示环境</span>
            </div>
          </div>

          <div className="grok-reg-form-grid">
            <div className="grok-reg-field">
              <label htmlFor="email-provider">邮箱渠道</label>
              <select id="email-provider" value={form.emailProvider} disabled={isRunning} onChange={(event) => updateField('emailProvider', event.target.value)}>
                <option value="cloudmail">CloudMail</option>
                <option value="cloudflare">Cloudflare Mail</option>
                <option value="duckmail">DuckMail</option>
                <option value="yyds">YYDS Mail</option>
                <option value="hotmail">Hotmail / Outlook</option>
              </select>
            </div>
            <div className="grok-reg-field">
              <label htmlFor="target-pool">目标号池</label>
              <select id="target-pool" value={form.poolId} disabled={isRunning} onChange={(event) => updateField('poolId', event.target.value)}>
                <option value="">默认号池</option>
                {pools.map((pool) => (
                  <option key={getPoolId(pool)} value={getPoolId(pool)}>
                    {getPoolName(pool)}{pool.isDefault || pool.is_default ? '（默认）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="grok-reg-field">
              <label htmlFor="register-count">注册数量</label>
              <input id="register-count" type="number" min="1" max="50" value={form.count} disabled={isRunning} onChange={(event) => updateField('count', event.target.value)} />
            </div>
            <div className="grok-reg-field">
              <label htmlFor="register-threads">并发数</label>
              <input id="register-threads" type="number" min="1" max="10" value={form.threads} disabled={isRunning} onChange={(event) => updateField('threads', event.target.value)} />
            </div>
            <div className="grok-reg-field grok-reg-field-wide">
              <label htmlFor="register-domains">邮箱域名</label>
              <input id="register-domains" value={form.domains} disabled={isRunning} onChange={(event) => updateField('domains', event.target.value)} placeholder="example.com" />
            </div>
            {renderEmailFields()}
            <div className="grok-reg-field grok-reg-field-wide">
              <label htmlFor="register-proxy">代理</label>
              <input id="register-proxy" value={form.proxy} disabled={isRunning} onChange={(event) => updateField('proxy', event.target.value)} placeholder="http://127.0.0.1:7890" />
            </div>
          </div>

          <div className="grok-reg-toggle-row">
            <label>
              <input type="checkbox" checked={form.fastMode} disabled={isRunning} onChange={(event) => updateField('fastMode', event.target.checked)} />
              <span>快速模式</span>
            </label>
            <label>
              <input type="checkbox" checked={form.browserReuse} disabled={isRunning} onChange={(event) => updateField('browserReuse', event.target.checked)} />
              <span>复用浏览器</span>
            </label>
            <label>
              <input type="checkbox" checked={form.useUv} disabled={isRunning} onChange={(event) => updateField('useUv', event.target.checked)} />
              <span>使用 uv</span>
            </label>
          </div>

          <details className="grok-reg-advanced">
            <summary>运行环境</summary>
            <div className="grok-reg-form-grid">
              <div className="grok-reg-field grok-reg-field-wide">
                <label htmlFor="python-command">Python 命令</label>
                <input id="python-command" value={form.pythonCommand} disabled={isRunning} onChange={(event) => updateField('pythonCommand', event.target.value)} />
              </div>
              <div className="grok-reg-field grok-reg-field-wide">
                <label htmlFor="register-engine-path">注册引擎目录</label>
                <input id="register-engine-path" value={form.registerEnginePath} disabled={isRunning} onChange={(event) => updateField('registerEnginePath', event.target.value)} />
              </div>
              <div className="grok-reg-field grok-reg-field-wide">
                <label htmlFor="converter-path">SSO 转 JSON 脚本</label>
                <input id="converter-path" value={form.converterScriptPath} disabled={isRunning} onChange={(event) => updateField('converterScriptPath', event.target.value)} />
              </div>
            </div>
          </details>

          <div className="grok-reg-actions">
            {isRunning ? (
              <button className="grok-reg-button danger" type="button" disabled={stopping || task?.status === 'stopping'} onClick={handleStop}>
                <i className={`fas ${stopping ? 'fa-spinner fa-spin' : 'fa-stop'}`} />
                <span>{stopping || task?.status === 'stopping' ? '停止中...' : '停止任务'}</span>
              </button>
            ) : (
              <button className="grok-reg-button primary" type="button" disabled={submitting} onClick={handleStart}>
                <i className={`fas ${submitting ? 'fa-spinner fa-spin' : 'fa-play'}`} />
                <span>{submitting ? '启动中...' : '开始注册'}</span>
              </button>
            )}
            {task?.artifactAvailable && (
              <button className="grok-reg-button secondary" type="button" disabled={downloading} onClick={handleDownload}>
                <i className={`fas ${downloading ? 'fa-spinner fa-spin' : 'fa-file-archive'}`} />
                <span>{downloading ? '打包中...' : '下载 JSON'}</span>
              </button>
            )}
            {task && !isRunning && (
              <button className="grok-reg-button secondary" type="button" onClick={() => navigate(returnUrl)}>
                <i className="fas fa-arrow-right" />
                <span>返回号池</span>
              </button>
            )}
          </div>
        </section>

        <section className="grok-registration-log-pane">
          <div className="grok-reg-section-heading">
            <h2>实时日志</h2>
            <span className="grok-reg-task-id">{task?.id ? task.id.slice(0, 8) : 'no task'}</span>
          </div>
          <div className="grok-registration-log" aria-live="polite">
            {logs.length === 0 ? (
              <div className="grok-registration-log-empty">等待任务日志</div>
            ) : (
              logs.map((entry, index) => (
                <div className={`grok-registration-log-line level-${entry.level || 'info'}`} key={entry.seq || `${entry.timestamp}-${index}`}>
                  <time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</time>
                  <span>{entry.message}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
          {task?.error && (
            <div className="grok-registration-task-error">
              <i className="fas fa-times-circle" />
              <span>{task.error}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
