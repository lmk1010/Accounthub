/**
 * 性能监控页面 - Tab 版
 * Tabs: 概览 | 集群 | 数据库 | 缓存 | 号池 | 系统
 */

import { useEffect, useState, useCallback, memo } from 'react';
import { monitorService } from '../services/system.service';
import './Monitor.css';

// ─── 图标 ────────────────────────────────────────────────────────────────────
const ICONS = {
  server:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="13" width="20" height="6" rx="1"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="16" r="1" fill="currentColor"/></svg>,
  database:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v6c0 1.66-4 3-9 3s-9-1.34-9-3V5"/><path d="M21 11v6c0 1.66-4 3-9 3s-9-1.34-9-3v-6"/></svg>,
  memory:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>,
  cpu:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>,
  activity:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>,
  users:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  clock:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>,
  zap:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>,
  trendUp:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg>,
  trendDown: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,18 13.5,8.5 8.5,13.5 1,6"/><polyline points="17,18 23,18 23,12"/></svg>,
  alert:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  check:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>,
  hdd:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  refresh:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,4 23,10 17,10"/><polyline points="1,20 1,14 7,14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  arrowUp:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5,12 12,5 19,12"/></svg>,
  arrowDown: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19,12 12,19 5,12"/></svg>,
  layers:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12,2 2,7 12,12 22,7"/><polyline points="2,17 12,22 22,17"/><polyline points="2,12 12,17 22,12"/></svg>,
  gauge:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 12l4-4"/><circle cx="12" cy="12" r="2"/></svg>,
  bar:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>,
  pie:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>,
  shield:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  target:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  box:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27,6.96 12,12.01 20.73,6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  terminal:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  globe:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  signal:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="20" x2="2" y2="16"/><line x1="6" y1="20" x2="6" y2="12"/><line x1="10" y1="20" x2="10" y2="8"/><line x1="14" y1="20" x2="14" y2="4"/><line x1="18" y1="20" x2="18" y2="10"/><line x1="22" y1="20" x2="22" y2="6"/></svg>,
  pulse:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12h4l3-9 4 18 3-9h6"/></svg>,
  shard:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
};
const Icon = memo(({ name }) => ICONS[name] || null);

// ─── 基础子组件 ───────────────────────────────────────────────────────────────
const MiniProgress = memo(({ value, max = 100, color = '#3b82f6' }) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="mini-progress">
      <div className="mini-progress-bar" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
});

const MiniChart = memo(({ data = [], color = '#3b82f6' }) => {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${100 - (v / max) * 100}`).join(' ');
  return (
    <svg className="mini-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
      <polyline points={`0,100 ${pts} 100,100`} fill={`${color}20`} stroke="none"/>
    </svg>
  );
});

const Ring = memo(({ value, max = 100, size = 36, color = '#3b82f6' }) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const r = (size - 4) / 2, c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f1f5f9" strokeWidth="4"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
          strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`} style={{ transition: 'stroke-dashoffset 0.3s' }}/>
      </svg>
      <span className="ring-val">{pct.toFixed(0)}</span>
    </div>
  );
});

const Metric = memo(({ icon, color, value, label, sub, progress, ring, chart }) => (
  <div className={`m-card${ring || chart ? ' wide' : ''}`}>
    <div className={`m-icon ${color}`}><Icon name={icon} /></div>
    <div className="m-body">
      <div className="m-val">{value}{sub && <small>{sub}</small>}</div>
      <div className="m-lbl">{label}</div>
      {progress && <MiniProgress value={progress.value} max={progress.max} color={progress.color} />}
      {chart && <MiniChart data={chart.data} color={chart.color} />}
    </div>
    {ring && <Ring value={ring.value} max={ring.max} color={ring.color} />}
  </div>
));

const SectionTitle = memo(({ icon, children }) => (
  <div className="m-section"><Icon name={icon} /><span>{children}</span></div>
));

const Empty = memo(({ icon, children }) => (
  <div className="m-empty"><Icon name={icon} />{children}</div>
));

const ServiceStatus = memo(({ services }) => {
  if (!services) return null;
  const getColor = (s) => ({ healthy: '#10b981', warning: '#f59e0b', error: '#ef4444' }[s] || '#94a3b8');
  const icons = { api: 'server', mysql: 'database', redis: 'memory' };
  return (
    <div className="svc-row">
      {Object.entries(services).map(([name, info]) => (
        <div key={name} className="svc-item" style={{ '--c': getColor(info.status) }}>
          <div className="svc-icon"><Icon name={icons[name]} /></div>
          <span className="svc-name">{name.toUpperCase()}</span>
          <span className="svc-msg">{info.message}</span>
          <span className={`svc-badge ${info.status}`}>
            {info.status === 'healthy' ? '正常' : info.status === 'warning' ? '警告' : '错误'}
          </span>
        </div>
      ))}
    </div>
  );
});

// ─── 格式化 ───────────────────────────────────────────────────────────────────
const fmt = {
  uptime: (s) => {
    if (!Number.isFinite(s)) return '--';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
  },
  bytes: (b) => {
    if (!Number.isFinite(b) || b === 0) return '0B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)}${s[i]}`;
  },
  rate: (b) => !Number.isFinite(b) || b === 0 ? '0B/s' : `${fmt.bytes(b)}/s`,
  num: (v) => {
    if (!Number.isFinite(v)) return '--';
    return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
  },
};

// ─── Tab 定义 ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'overview', label: '概览',  icon: 'activity' },
  { id: 'cluster',  label: '集群',  icon: 'layers'   },
  { id: 'database', label: '数据库', icon: 'database' },
  { id: 'cache',    label: '缓存',  icon: 'memory'   },
  { id: 'pool',     label: '号池',  icon: 'shield'   },
  { id: 'system',   label: '系统',  icon: 'hdd'      },
];

const INTERVALS = [
  { v: 0,     l: '停'  },
  { v: 3000,  l: '3s'  },
  { v: 5000,  l: '5s'  },
  { v: 10000, l: '10s' },
  { v: 30000, l: '30s' },
];

// ─── Tab: 概览 ────────────────────────────────────────────────────────────────
function TabOverview({ data, history }) {
  const { services, concurrency: conn, system: sys } = data || {};
  return (
    <>
      <ServiceStatus services={services} />
      <SectionTitle icon="users">并发连接</SectionTitle>
      <div className="m-grid">
        <Metric icon="users"    color="blue"   value={conn?.active ?? '--'} label="当前连接"
          ring={{ value: conn?.active || 0, max: conn?.peak || 100, color: '#3b82f6' }}
          chart={{ data: history.conn, color: '#3b82f6' }} />
        <Metric icon="trendUp"  color="purple" value={conn?.peak ?? '--'} label="峰值" />
        <Metric icon="signal"   color="cyan"   value={conn?.peak10m ?? '--'} label="10分钟峰值" />
        <Metric icon="activity" color="cyan"   value={fmt.num(conn?.total)} label="累计请求" />
        <Metric icon="clock"    color="gray"   value={conn?.lastPeakTime ? new Date(conn.lastPeakTime).toLocaleTimeString() : '--'} label="峰值时间" />
        <Metric icon="clock"    color="teal"   value={fmt.uptime(sys?.uptime)} label="运行时间" />
      </div>
      <SectionTitle icon="cpu">CPU 负载</SectionTitle>
      <div className="m-grid">
        <Metric icon="cpu"    color="orange" value={`${sys?.load?.percent ?? '--'}%`} label="CPU负载"
          ring={{ value: sys?.load?.percent || 0, max: 100, color: '#f97316' }}
          chart={{ data: history.cpu, color: '#f97316' }} />
        <Metric icon="gauge" color="orange" value={sys?.load?.avg1m  ?? '--'} label="1m均值" />
        <Metric icon="gauge" color="orange" value={sys?.load?.avg5m  ?? '--'} label="5m均值" />
        <Metric icon="gauge" color="orange" value={sys?.load?.avg15m ?? '--'} label="15m均值" />
        <Metric icon="server" color="gray"  value={sys?.cpuCount ?? '--'} label="核心数" />
      </div>
      <SectionTitle icon="memory">内存</SectionTitle>
      <div className="m-grid">
        <Metric icon="memory" color="green"  value={fmt.bytes(sys?.memory?.heapUsed)} label="堆内存"
          ring={{ value: sys?.memory?.heapUsed || 0, max: sys?.memory?.heapTotal || 1, color: '#10b981' }}
          chart={{ data: history.mem, color: '#10b981' }} />
        <Metric icon="hdd"    color="green"  value={fmt.bytes(sys?.memory?.heapTotal)} label="堆总量" />
        <Metric icon="layers" color="teal"   value={fmt.bytes(sys?.memory?.rss)} label="RSS" />
        <Metric icon="box"    color="cyan"   value={fmt.bytes(sys?.memory?.external)} label="外部内存" />
        <Metric icon="activity" color="purple" value={sys?.platform ?? '--'} label="平台" />
      </div>
    </>
  );
}

// ─── Shard 卡片（含分页） ─────────────────────────────────────────────────────
const PAGE_SIZE = 10;

function ShardCard({ sid, providers, wi }) {
  const [page, setPage] = useState(0);
  const total = providers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = providers.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="shard-card">
      <div className="shard-card-header">
        <span className="shard-badge lg">Shard {sid}</span>
        <span className="shard-card-count">{total} providers</span>
        {wi && <span className="shard-pid">PID {wi.pid}</span>}
        {wi && wi.concurrencyActive != null && (
          <span className="shard-concur">
            {wi.concurrencyPeak != null ? `${wi.concurrencyActive}/${wi.concurrencyPeak}` : wi.concurrencyActive} active
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="shard-empty">暂无 provider</div>
      ) : (
        <>
          <div className="shard-provider-list">
            {slice.map((p, i) => (
              <div key={i} className="shard-provider-row">
                <span className={`shard-health-dot ${p.isDisabled ? 'disabled' : p.isHealthy ? 'ok' : 'err'}`} />
                <span className="shard-provider-name">{p.name}</span>
                <span className="shard-provider-type">{p.providerType}</span>
                {p.isDisabled && <span className="shard-tag disabled">禁用</span>}
                {!p.isHealthy && !p.isDisabled && <span className="shard-tag error">异常</span>}
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="shard-page-bar">
              <button className="shard-page-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>‹</button>
              <span className="shard-page-info">{safePage + 1} / {totalPages}</span>
              <button className="shard-page-btn" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}>›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Tab: 集群 ────────────────────────────────────────────────────────────────
function TabCluster({ cluster, shardMap, loadShardMap, shardLoading }) {
  const workers    = cluster?.workers || [];
  const dist       = shardMap?.shards || {};
  const counts     = shardMap?.counts || {};
  const dispatcher = shardMap?.dispatcher || cluster?.dispatcher;

  return (
    <>
      <SectionTitle icon="server">集群概览</SectionTitle>
      {cluster && !cluster.mode ? (
        <div className="m-grid">
          <Metric icon="server"  color="blue"   value={cluster.totalWorkers ?? '--'} sub={`/${cluster.master?.configuredWorkers ?? '--'}`} label="Worker数"
            ring={{ value: cluster.totalWorkers || 0, max: cluster.master?.configuredWorkers || 1, color: '#3b82f6' }} />
          <Metric icon="memory"  color="green"  value={`${cluster.cluster?.totalMemoryMB ?? '--'}MB`} label="集群内存" />
          <Metric icon="users"   color="purple" value={cluster.cluster?.activeConnections ?? '--'} label="总并发" />
          <Metric icon="trendUp" color="orange" value={cluster.cluster?.peakConnections ?? '--'} label="峰值并发" />
          <Metric icon="signal"  color="cyan"   value={fmt.num(cluster.cluster?.totalRequests)} label="总请求" />
          <Metric icon="cpu"     color="teal"   value={cluster.master?.cpuCores ?? '--'} label="CPU核心" />
          <Metric icon="hdd"     color="gray"   value={cluster.system?.usedMemoryPercent ?? '--'} label="系统内存" />
          <Metric icon="clock"   color="blue"   value={fmt.uptime(cluster.master?.uptime)} label="Master运行" />
        </div>
      ) : cluster?.mode === 'standalone' ? (
        <Empty icon="server">单进程模式运行</Empty>
      ) : (
        <Empty icon="server">集群状态不可用</Empty>
      )}

      {/* Sticky Dispatcher */}
      {dispatcher && (
        <>
          <SectionTitle icon="signal">Sticky Dispatcher</SectionTitle>
          <div className="m-grid">
            <Metric icon="activity" color="blue"   value={fmt.num(dispatcher.acceptedConnections)} label="接受连接" />
            <Metric icon="target"   color="green"  value={fmt.num(dispatcher.stickyHandoffs)}      label="Sticky转发" />
            <Metric icon="refresh"  color="orange" value={fmt.num(dispatcher.rrFallbackHandoffs)}  label="RR兜底" />
            <Metric icon="alert"    color="red"    value={fmt.num(dispatcher.headerParseErrors)}   label="解析错误" />
            <Metric icon="alert"    color="red"    value={fmt.num(dispatcher.handoffSendErrors)}   label="转发失败" />
          </div>
        </>
      )}

      {/* Worker 进程卡片 */}
      {workers.length > 0 && (
        <>
          <SectionTitle icon="layers">Worker 进程</SectionTitle>
          <div className="worker-cards">
            {workers.map((w, i) => {
              const memMB   = w.memory ? Math.round(w.memory.heapUsed / 1024 / 1024) : null;
              const heapMax = w.memory ? Math.round(w.memory.heapTotal / 1024 / 1024) : null;
              const isOk    = w.state === 'listening' || w.state === 'online';
              return (
                <div key={i} className={`worker-card ${isOk ? '' : 'worker-card-warn'}`}>
                  {/* 头部 */}
                  <div className="worker-card-header">
                    <span className="worker-id">W{w.id}</span>
                    <span className="shard-badge">S{w.shard?.id ?? '?'}</span>
                    <span className={`svc-badge ${isOk ? 'healthy' : 'warning'}`}>{w.state}</span>
                    {w.restartCount > 0 && <span className="worker-restart">↻{w.restartCount}</span>}
                  </div>
                  {/* PID */}
                  <div className="worker-pid">PID {w.pid}</div>
                  {/* 内存 */}
                  <div className="worker-row-item">
                    <span className="worker-item-label">内存</span>
                    <span className="worker-item-val">{memMB != null ? `${memMB}/${heapMax}MB` : '--'}</span>
                  </div>
                  {memMB != null && heapMax > 0 && (
                    <MiniProgress value={memMB} max={heapMax} color="#10b981" />
                  )}
                  {/* 并发 */}
                  <div className="worker-row-item">
                    <span className="worker-item-label">并发</span>
                    <span className="worker-item-val">
                      <strong>{w.concurrency?.active ?? '--'}</strong>
                      <span className="worker-item-sub">/{w.concurrency?.peak ?? '--'} peak</span>
                    </span>
                  </div>
                  {/* 其他 */}
                  <div className="worker-row-item">
                    <span className="worker-item-label">总请求</span>
                    <span className="worker-item-val">{fmt.num(w.concurrency?.total)}</span>
                  </div>
                  <div className="worker-row-item">
                    <span className="worker-item-label">热适配</span>
                    <span className="worker-item-val">{w.adapters?.live ?? '--'} live</span>
                  </div>
                  <div className="worker-row-item">
                    <span className="worker-item-label">Owned</span>
                    <span className="worker-item-val">{w.shard?.ownedProviders ?? '--'} providers</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Shard 分布 */}
      <div className="shard-map-header">
        <SectionTitle icon="shard">Provider Shard 分布</SectionTitle>
        <button className="m-refresh shard-refresh" onClick={loadShardMap} disabled={shardLoading}>
          <Icon name="refresh" />
        </button>
      </div>

      {shardLoading && <Empty icon="refresh">加载中...</Empty>}

      {!shardLoading && shardMap && (
        <>
          {/* 汇总 */}
          <div className="m-grid" style={{ marginBottom: 12 }}>
            <Metric icon="layers" color="blue"   value={shardMap.totalProviders ?? '--'} label="总 Provider 数" />
            <Metric icon="server" color="purple" value={shardMap.workerCount ?? '--'} label="Worker 数" />
          </div>

          {/* 均衡度条形图 */}
          <div className="shard-balance">
            {Object.entries(counts).map(([sid, count]) => {
              const maxCount = Math.max(...Object.values(counts), 1);
              const pct = (count / maxCount) * 100;
              const wi = shardMap.workers?.find(w => String(w.shardId) === String(sid));
              return (
                <div key={sid} className="shard-bar-item">
                  <div className="shard-bar-label">
                    <span className="shard-badge">S{sid}</span>
                    {wi && <span className="shard-pid">PID {wi.pid}</span>}
                  </div>
                  <div className="shard-bar-wrap">
                    <div className="shard-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="shard-bar-count">{count}</span>
                </div>
              );
            })}
          </div>

          {/* 各 Shard provider 详情 */}
          <div className="shard-grid">
            {Object.entries(dist).map(([sid, providers]) => {
              const wi = shardMap.workers?.find(w => String(w.shardId) === String(sid));
              return <ShardCard key={sid} sid={sid} providers={providers} wi={wi} />;
            })}
          </div>
        </>
      )}

      {!shardLoading && !shardMap && (
        <Empty icon="shard">暂无 Shard 数据，点击右上角刷新加载</Empty>
      )}

      {!shardLoading && shardMap && shardMap.totalProviders === 0 && (
        <div className="shard-no-provider">
          <Icon name="layers" />
          <span>当前数据库中没有配置任何 Provider，Shard 均为空。<br/>添加 Provider 后此处会显示分布情况。</span>
        </div>
      )}
    </>
  );
}

// ─── Tab: 数据库 ──────────────────────────────────────────────────────────────
function TabDatabase({ mysql, tables, onCleanup, onSlowQueries }) {
  return (
    <>
      <SectionTitle icon="database">MySQL 状态</SectionTitle>
      {mysql ? (
        <div className="m-grid">
          <Metric icon="users" color="blue"   value={mysql.connections?.current ?? '--'} sub={`/${mysql.connections?.max ?? '--'}`} label="连接数"
            ring={{ value: mysql.connections?.current || 0, max: mysql.connections?.max || 100, color: '#3b82f6' }}
            progress={{ value: mysql.connections?.current || 0, max: mysql.connections?.max || 100, color: '#3b82f6' }} />
          <Metric icon="zap"   color="green"  value={mysql.connections?.running ?? '--'} label="活跃线程" />
          <Metric icon="box"   color="purple" value={mysql.localPool?.total ?? '--'} sub={`/${mysql.localPool?.free ?? '--'}`} label="连接池" />
          <Metric icon="clock" color="orange" value={mysql.localPool?.queue ?? '--'} label="等待队列" />
          <Metric icon="bar"   color="cyan"   value={fmt.num(mysql.queries?.total)} label="总查询" />
          <Metric icon="arrowDown" color="green" value={fmt.bytes(mysql.traffic?.bytesReceived)} label="接收流量" />
          <Metric icon="arrowUp"   color="blue"  value={fmt.bytes(mysql.traffic?.bytesSent)}     label="发送流量" />
          <div className="m-card" style={{ cursor: 'pointer' }} onClick={onSlowQueries}>
            <div className="m-icon red"><Icon name="alert" /></div>
            <div className="m-body">
              <div className="m-val">{mysql.queries?.slowQueries ?? '--'}</div>
              <div className="m-lbl">慢查询 (点击查看)</div>
            </div>
          </div>
        </div>
      ) : <Empty icon="database">MySQL 不可用</Empty>}

      {tables?.tables?.length > 0 && (
        <>
          <SectionTitle icon="layers">表大小</SectionTitle>
          <div className="m-table-list">
            <div className="m-tbl-head" style={{ gridTemplateColumns: '1fr 80px 70px 70px 80px 60px' }}>
              <span>表名</span><span>行数</span><span>数据</span><span>索引</span><span>总计</span><span></span>
            </div>
            {tables.tables.slice(0, 10).map((t, i) => (
              <div key={i} className="m-tbl-row" style={{ gridTemplateColumns: '1fr 80px 70px 70px 80px 60px' }}>
                <span>{t.tableName}</span>
                <span>{fmt.num(t.rowCount)}</span>
                <span>{t.dataSizeMB}MB</span>
                <span>{t.indexSizeMB}MB</span>
                <span className="m-tbl-total">{t.totalSizeMB}MB</span>
                <span>{t.tableName === 'request_logs' && <button className="m-cleanup-btn" onClick={onCleanup}>清理</button>}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ─── Tab: 缓存 ────────────────────────────────────────────────────────────────
function TabCache({ redis, net }) {
  return (
    <>
      <SectionTitle icon="memory">Redis</SectionTitle>
      {redis ? (
        <div className="m-grid">
          <Metric icon="users"  color="red"    value={redis.clients?.connected ?? '--'} label="连接数" />
          <Metric icon="hdd"    color="purple" value={redis.memory?.usedHuman ?? '--'} label="内存" />
          <Metric icon="target" color="green"  value={`${redis.stats?.hitRate ?? '--'}%`} label="命中率"
            ring={{ value: redis.stats?.hitRate || 0, max: 100, color: '#10b981' }}
            progress={{ value: redis.stats?.hitRate || 0, max: 100, color: '#10b981' }} />
          <Metric icon="zap"    color="orange" value={fmt.num(redis.stats?.opsPerSec)} label="OPS/s" />
          <Metric icon="layers" color="blue"   value={redis.logQueueLength ?? '--'} label="日志队列" />
          <Metric icon="clock"  color="gray"   value={fmt.num(redis.stats?.expiredKeys)} label="过期键" />
          <Metric icon="clock"  color="teal"   value={fmt.uptime(redis.uptime)} label="运行时间" />
          <Metric icon="pulse"  color="cyan"   value={fmt.num(redis.stats?.totalCommands)} label="总命令" />
          <Metric icon="signal" color="purple" value={fmt.num(redis.stats?.keyspaceHits)} label="命中次数" />
          <Metric icon="alert"  color="red"    value={fmt.num(redis.stats?.keyspaceMisses)} label="未命中" />
        </div>
      ) : <Empty icon="memory">Redis 未连接</Empty>}

      <SectionTitle icon="globe">MySQL 网络带宽</SectionTitle>
      <div className="m-grid">
        <Metric icon="arrowDown" color="green"  value={fmt.rate(net?.mysql?.rxRate)} label="入站速率" />
        <Metric icon="arrowUp"   color="blue"   value={fmt.rate(net?.mysql?.txRate)} label="出站速率" />
        <Metric icon="trendDown" color="green"  value={fmt.bytes(net?.mysql?.totalRx)} label="总接收" />
        <Metric icon="trendUp"   color="blue"   value={fmt.bytes(net?.mysql?.totalTx)} label="总发送" />
        <Metric icon="activity"  color="purple" value={fmt.num(net?.mysql?.packets?.rx)} label="接收包" />
        <Metric icon="activity"  color="cyan"   value={fmt.num(net?.mysql?.packets?.tx)} label="发送包" />
      </div>
    </>
  );
}

// ─── Tab: 号池 ────────────────────────────────────────────────────────────────
function TabPool({ pool }) {
  return (
    <>
      <SectionTitle icon="shield">号池健康</SectionTitle>
      {pool ? (
        <>
          <div className="m-grid">
            <Metric icon="check"   color="green"  value={`${pool.stats?.successRate ?? '--'}%`} label="成功率"
              ring={{ value: pool.stats?.successRate || 0, max: 100, color: '#10b981' }}
              progress={{ value: pool.stats?.successRate || 0, max: 100, color: '#10b981' }} />
            <Metric icon="alert"   color="red"    value={`${pool.stats?.errorRate ?? '--'}%`} label="错误率" />
            <Metric icon="pie"     color="blue"   value={fmt.num(pool.stats?.totalRequests)} label="总请求" />
            <Metric icon="refresh" color="orange" value={pool.stats?.switchCount ?? '--'} label="切号次数" />
            <Metric icon="users"   color="purple" value={pool.stats?.activeAccounts ?? '--'} label="活跃账号" />
            <Metric icon="zap"     color="cyan"   value={pool.stats?.avgResponseTime ? `${pool.stats.avgResponseTime}ms` : '--'} label="平均响应" />
          </div>
          {pool.recentErrors?.length > 0 && (
            <>
              <SectionTitle icon="alert">最近错误</SectionTitle>
              <div className="m-errors">
                <div className="m-err-head"><span>时间</span><span>提供商</span><span>状态</span><span>错误</span></div>
                {pool.recentErrors.slice(0, 10).map((e, i) => (
                  <div key={i} className="m-err-row">
                    <span>{new Date(e.time).toLocaleTimeString()}</span>
                    <span>{e.providerType}</span>
                    <span className={`code-${Math.floor(e.statusCode / 100)}xx`}>{e.statusCode}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : <Empty icon="alert">号池数据不可用</Empty>}
    </>
  );
}

// ─── Tab: 系统 ────────────────────────────────────────────────────────────────
function TabSystem({ disk, cluster }) {
  return (
    <>
      <SectionTitle icon="hdd">磁盘占用</SectionTitle>
      {disk ? (
        <div className="m-grid">
          <Metric icon="hdd"      color="purple" value={fmt.bytes(disk.project?.size)} label="项目总大小" />
          <Metric icon="terminal" color="orange" value={fmt.bytes(disk.logs?.size)}    label="日志目录" />
          <Metric icon="box"      color="cyan"   value={fmt.bytes(disk.uploads?.size)} label="上传目录" />
        </div>
      ) : <Empty icon="hdd">磁盘数据不可用</Empty>}

      {cluster && !cluster.mode && (
        <>
          <SectionTitle icon="server">系统信息</SectionTitle>
          <div className="m-grid">
            <Metric icon="cpu"    color="blue"   value={cluster.master?.cpuCores ?? '--'} label="CPU核心" />
            <Metric icon="hdd"    color="orange" value={cluster.system?.usedMemoryPercent ?? '--'} label="系统内存使用率" />
            <Metric icon="server" color="gray"   value={cluster.system?.platform ?? '--'} label="平台" />
            <Metric icon="clock"  color="teal"   value={fmt.uptime(cluster.master?.uptime)} label="Master运行时间" />
          </div>
        </>
      )}
    </>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────
export default function Monitor() {
  const [activeTab, setActiveTab] = useState('overview');

  const [data,     setData]     = useState(null);
  const [pool,     setPool]     = useState(null);
  const [disk,     setDisk]     = useState(null);
  const [tables,   setTables]   = useState(null);
  const [cluster,  setCluster]  = useState(null);
  const [shardMap, setShardMap] = useState(null);
  const [shardLoading, setShardLoading] = useState(false);

  const [slowQueries,      setSlowQueries]      = useState(null);
  const [showSlowModal,    setShowSlowModal]    = useState(false);
  const [showCleanupModal, setShowCleanupModal] = useState(false);
  const [cleanupMode,      setCleanupMode]      = useState('before_today');
  const [cleanupDate,      setCleanupDate]      = useState('');
  const [cleanupLoading,   setCleanupLoading]   = useState(false);
  const [cleanupResult,    setCleanupResult]    = useState(null);

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [refreshInterval, setRefreshInterval] = useState(5000);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [history,    setHistory]    = useState({ cpu: [], mem: [], conn: [] });

  const load = useCallback(async () => {
    try {
      setError('');
      const [overview, health, diskData, tablesData, clusterData] = await Promise.all([
        monitorService.getOverview(),
        monitorService.getPoolHealth(),
        monitorService.getDiskUsage().catch(() => null),
        monitorService.getTableSizes().catch(() => null),
        monitorService.getClusterStatus().catch(() => null),
      ]);
      setData(overview);
      setPool(health);
      setDisk(diskData);
      setTables(tablesData);
      setCluster(clusterData);
      setLastUpdate(new Date());
      setHistory(p => ({
        cpu:  [...p.cpu.slice(-19),  overview?.system?.load?.percent    || 0],
        mem:  [...p.mem.slice(-19),  overview?.system?.memory?.heapUsed || 0],
        conn: [...p.conn.slice(-19), overview?.concurrency?.active      || 0],
      }));
    } catch {
      setError('数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShardMap = useCallback(async () => {
    setShardLoading(true);
    try {
      const result = await monitorService.getShardMap();
      setShardMap(result);
    } catch (e) {
      console.warn('Shard map load failed:', e.message);
    } finally {
      setShardLoading(false);
    }
  }, []);

  // 切到集群 tab 时自动加载 shard map
  useEffect(() => {
    if (activeTab === 'cluster' && !shardMap && !shardLoading) {
      loadShardMap();
    }
  }, [activeTab, shardMap, shardLoading, loadShardMap]);

  const openSlowQueries = useCallback(async () => {
    const sq = await monitorService.getSlowQueries().catch(() => null);
    setSlowQueries(sq);
    setShowSlowModal(true);
  }, []);

  const handleCleanup = useCallback(async () => {
    if (cleanupMode === 'before_date' && !cleanupDate) return;
    const msg = cleanupMode === 'before_today'
      ? '确认删除今天之前的所有请求日志？'
      : `确认删除 ${cleanupDate} 及之前的所有请求日志？`;
    if (!window.confirm(msg)) return;
    setCleanupLoading(true);
    setCleanupResult(null);
    try {
      const res = await monitorService.cleanupRequestLogs(cleanupMode, cleanupDate || undefined);
      setCleanupResult({ success: true, deleted: res.deleted });
      load();
    } catch (e) {
      setCleanupResult({ success: false, message: e.message || '清理失败' });
    } finally {
      setCleanupLoading(false);
    }
  }, [cleanupMode, cleanupDate, load]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (refreshInterval > 0) {
      const t = window.setInterval(load, refreshInterval);
      return () => window.clearInterval(t);
    }
  }, [refreshInterval, load]);

  if (loading && !data) {
    return <div className="m-loading"><Icon name="refresh" /><span>加载中...</span></div>;
  }

  const { mysql, redis, network: net } = data || {};

  return (
    <div className="monitor">
      {/* 顶栏 */}
      <header className="m-header">
        <div className="m-title"><Icon name="activity" /><h1>性能监控</h1></div>
        <div className="m-ctrl">
          {lastUpdate && <span className="m-time">{lastUpdate.toLocaleTimeString()}</span>}
          <div className="m-intervals">
            {INTERVALS.map(o => (
              <button key={o.v} className={refreshInterval === o.v ? 'active' : ''} onClick={() => setRefreshInterval(o.v)}>{o.l}</button>
            ))}
          </div>
          <button className="m-refresh" onClick={load} disabled={loading}><Icon name="refresh" /></button>
        </div>
      </header>

      {error && <div className="m-error"><Icon name="alert" />{error}</div>}

      {/* Tab 导航 */}
      <nav className="m-tabs">
        {TABS.map(tab => (
          <button key={tab.id} className={`m-tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            <span className="m-tab-icon"><Icon name={tab.icon} /></span>
            <span className="m-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Tab 内容区 */}
      <div className="m-tab-content">
        {activeTab === 'overview' && <TabOverview data={data} history={history} />}
        {activeTab === 'cluster'  && <TabCluster  cluster={cluster} shardMap={shardMap} loadShardMap={loadShardMap} shardLoading={shardLoading} />}
        {activeTab === 'database' && <TabDatabase  mysql={mysql} tables={tables} onCleanup={() => { setCleanupResult(null); setShowCleanupModal(true); }} onSlowQueries={openSlowQueries} />}
        {activeTab === 'cache'    && <TabCache     redis={redis} net={net} />}
        {activeTab === 'pool'     && <TabPool      pool={pool} />}
        {activeTab === 'system'   && <TabSystem    disk={disk} cluster={cluster} />}
      </div>

      {/* 慢查询弹窗 */}
      {showSlowModal && (
        <div className="m-modal-overlay" onClick={() => setShowSlowModal(false)}>
          <div className="m-modal" onClick={e => e.stopPropagation()}>
            <div className="m-modal-header">
              <h3><Icon name="alert" /> 慢查询列表</h3>
              <button onClick={() => setShowSlowModal(false)}>×</button>
            </div>
            <div className="m-modal-body">
              {slowQueries?.queries?.length > 0 ? (
                <div className="m-slow-list">
                  {slowQueries.queries.map((q, i) => (
                    <div key={i} className="m-slow-item">
                      <div className="m-slow-stats">
                        <span>执行 {q.execCount} 次</span><span>平均 {q.avgTimeSec}s</span><span>最大 {q.maxTimeSec}s</span>
                      </div>
                      <div className="m-slow-sql">{q.queryDigest}</div>
                    </div>
                  ))}
                </div>
              ) : <Empty icon="check">暂无慢查询记录</Empty>}
            </div>
          </div>
        </div>
      )}

      {/* 清理日志弹窗 */}
      {showCleanupModal && (
        <div className="m-modal-overlay" onClick={() => setShowCleanupModal(false)}>
          <div className="m-modal" onClick={e => e.stopPropagation()}>
            <div className="m-modal-header">
              <h3><Icon name="hdd" /> 清理 request_logs</h3>
              <button onClick={() => setShowCleanupModal(false)}>×</button>
            </div>
            <div className="m-modal-body">
              <div className="m-cleanup-form">
                <label className="m-cleanup-option">
                  <input type="radio" name="cleanupMode" value="before_today" checked={cleanupMode === 'before_today'} onChange={() => setCleanupMode('before_today')} />
                  <span>删除今天之前的所有日志</span>
                </label>
                <label className="m-cleanup-option">
                  <input type="radio" name="cleanupMode" value="before_date" checked={cleanupMode === 'before_date'} onChange={() => setCleanupMode('before_date')} />
                  <span>删除指定日期及之前的日志</span>
                </label>
                {cleanupMode === 'before_date' && (
                  <input type="date" className="m-cleanup-date" value={cleanupDate} onChange={e => setCleanupDate(e.target.value)} />
                )}
                {cleanupResult && (
                  <div className={`m-cleanup-result ${cleanupResult.success ? 'success' : 'error'}`}>
                    {cleanupResult.success ? `已删除 ${cleanupResult.deleted.toLocaleString()} 条日志` : `失败: ${cleanupResult.message}`}
                  </div>
                )}
                <button className="m-cleanup-submit" onClick={handleCleanup} disabled={cleanupLoading || (cleanupMode === 'before_date' && !cleanupDate)}>
                  {cleanupLoading ? '清理中...' : '确认清理'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
