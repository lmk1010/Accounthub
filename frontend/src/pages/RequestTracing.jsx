/**
 * 请求链路追踪页面
 */

import { useEffect, useState, useCallback, memo } from 'react';
import { traceService } from '../services/trace.service';
import './RequestTracing.css';

// SVG 图标组件
const Icon = memo(({ name }) => {
  const icons = {
    activity: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>,
    clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>,
    zap: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>,
    alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
    check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>,
    refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,4 23,10 17,10"/><polyline points="1,20 1,14 7,14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
    target: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
    layers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12,2 2,7 12,12 22,7"/><polyline points="2,17 12,22 22,17"/><polyline points="2,12 12,17 22,12"/></svg>,
    server: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="13" width="20" height="6" rx="1"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="16" r="1" fill="currentColor"/></svg>,
    trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
    filter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/></svg>,
    chevronDown: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6,9 12,15 18,9"/></svg>,
    chevronUp: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18,15 12,9 6,15"/></svg>,
    search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    chevronLeft: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15,18 9,12 15,6"/></svg>,
    chevronRight: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9,18 15,12 9,6"/></svg>,
  };
  return icons[name] || null;
});

// 阶段名称映射
const PHASE_LABELS = {
  request_parse: '请求解析',
  auth_check: '认证检查',
  pool_select: '号池选择',
  token_refresh: 'Token刷新',
  request_build: '请求构建',
  ttft: '首字节',
  complete: '完成',
  mcp_call: 'MCP调用',
  response_convert: '响应转换'
};

// 阶段颜色
const PHASE_COLORS = {
  request_parse: '#3b82f6',
  auth_check: '#8b5cf6',
  pool_select: '#06b6d4',
  token_refresh: '#f59e0b',
  request_build: '#10b981',
  ttft: '#ef4444',
  complete: '#ec4899',
  mcp_call: '#6366f1',
  response_convert: '#14b8a6'
};

// 格式化时间
const formatMs = (ms) => {
  if (!Number.isFinite(ms)) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

// 瀑布图组件
const WaterfallChart = memo(({ phases, totalMs }) => {
  if (!phases || Object.keys(phases).length === 0) return null;

  const sortedPhases = Object.entries(phases)
    .filter(([, data]) => data.durationMs > 0)
    .sort((a, b) => {
      const orderA = Object.keys(PHASE_LABELS).indexOf(a[0]);
      const orderB = Object.keys(PHASE_LABELS).indexOf(b[0]);
      return orderA - orderB;
    });

  let offset = 0;
  const bars = sortedPhases.map(([phase, data]) => {
    const width = (data.durationMs / totalMs) * 100;
    const left = offset;
    offset += width;
    return { phase, ...data, width, left };
  });

  return (
    <div className="waterfall">
      <div className="waterfall-bars">
        {bars.map(bar => (
          <div
            key={bar.phase}
            className="waterfall-bar"
            style={{
              left: `${bar.left}%`,
              width: `${Math.max(bar.width, 1)}%`,
              backgroundColor: PHASE_COLORS[bar.phase] || '#94a3b8'
            }}
            title={`${PHASE_LABELS[bar.phase] || bar.phase}: ${formatMs(bar.durationMs)}`}
          />
        ))}
      </div>
      <div className="waterfall-legend">
        {bars.map(bar => (
          <span key={bar.phase} className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: PHASE_COLORS[bar.phase] }} />
            <span className="legend-label">{PHASE_LABELS[bar.phase] || bar.phase}</span>
            <span className="legend-value">{formatMs(bar.durationMs)}</span>
          </span>
        ))}
      </div>
    </div>
  );
});

// 统计卡片
const StatCard = memo(({ icon, color, value, label, sub }) => (
  <div className="stat-card">
    <div className={`stat-icon ${color}`}><Icon name={icon} /></div>
    <div className="stat-body">
      <div className="stat-value">{value}{sub && <small>{sub}</small>}</div>
      <div className="stat-label">{label}</div>
    </div>
  </div>
));

// 阶段统计表格
const PhaseStatsTable = memo(({ stats }) => {
  if (!stats) return null;

  const rows = Object.entries(stats)
    .filter(([, data]) => data.count > 0)
    .sort((a, b) => b[1].avgMs - a[1].avgMs);

  return (
    <div className="phase-stats-table">
      <div className="table-header">
        <span>阶段</span>
        <span>调用次数</span>
        <span>平均耗时</span>
        <span>最大耗时</span>
        <span>最小耗时</span>
      </div>
      {rows.map(([phase, data]) => (
        <div key={phase} className="table-row">
          <span className="phase-name">
            <span className="phase-dot" style={{ backgroundColor: PHASE_COLORS[phase] }} />
            {PHASE_LABELS[phase] || phase}
          </span>
          <span>{data.count}</span>
          <span className={data.avgMs > 3000 ? 'slow' : ''}>{formatMs(data.avgMs)}</span>
          <span className={data.maxMs > 5000 ? 'slow' : ''}>{formatMs(data.maxMs)}</span>
          <span>{formatMs(data.minMs)}</span>
        </div>
      ))}
    </div>
  );
});

// 追踪记录行
const TraceRow = memo(({ trace, expanded, onToggle }) => {
  const statusClass = trace.result?.success ? 'success' : 'error';
  const r = trace.result || {};
  const ttftMs = trace.phases?.ttft?.durationMs;

  return (
    <div className={`trace-item ${expanded ? 'expanded' : ''}`}>
      <div className="trace-header" onClick={onToggle}>
        <span className={`trace-status ${statusClass}`}>
          <Icon name={trace.result?.success ? 'check' : 'alert'} />
        </span>
        <span className="trace-id">{trace.traceId}</span>
        <span className="trace-path">{trace.metadata?.path || '--'}</span>
        <span className="trace-model">{trace.metadata?.model || '--'}</span>
        <span className={`trace-ttft ${ttftMs > 5000 ? 'slow' : ''}`}>
          {ttftMs ? formatMs(ttftMs) : '--'}
        </span>
        <span className={`trace-time ${trace.totalMs > 10000 ? 'slow' : ''}`}>
          {formatMs(trace.totalMs)}
        </span>
        <span className="trace-slowest">
          {PHASE_LABELS[trace.slowestPhase] || trace.slowestPhase}
        </span>
        <span className="trace-timestamp">
          {new Date(trace.timestamp).toLocaleTimeString()}
        </span>
        <span className="trace-expand">
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
        </span>
      </div>
      {expanded && (
        <div className="trace-detail">
          <WaterfallChart phases={trace.phases} totalMs={trace.totalMs} />
          <div className="trace-meta">
            <div className="meta-item">
              <span className="meta-label">Provider:</span>
              <span className="meta-value">{trace.metadata?.provider || '--'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Pool ID:</span>
              <span className="meta-value">{trace.metadata?.poolId || trace.metadata?.uuid || '--'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Input Tokens:</span>
              <span className="meta-value">{r.inputTokens || 0}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Output Tokens:</span>
              <span className="meta-value">{r.outputTokens || 0}</span>
            </div>
            {/* 缓存 Token 统计 */}
            {(r.cacheReadTokens > 0 || r.cacheCreationTokens > 0) && (
              <>
                <div className="meta-item cache">
                  <span className="meta-label">Cache Read:</span>
                  <span className="meta-value success">{r.cacheReadTokens || 0}</span>
                </div>
                <div className="meta-item cache">
                  <span className="meta-label">Cache Create:</span>
                  <span className="meta-value">{r.cacheCreationTokens || 0}</span>
                </div>
              </>
            )}
            {/* Kiro Credit 使用 */}
            {r.creditUsage && (
              <>
                <div className="meta-item credit">
                  <span className="meta-label">Credit Used:</span>
                  <span className="meta-value">{r.creditUsage.used ?? r.creditUsage}</span>
                </div>
                {r.creditUsage.remaining !== undefined && (
                  <div className="meta-item credit">
                    <span className="meta-label">Credit Remain:</span>
                    <span className="meta-value">{r.creditUsage.remaining}</span>
                  </div>
                )}
              </>
            )}
            {r.error && (
              <div className="meta-item error">
                <span className="meta-label">Error:</span>
                <span className="meta-value">{r.error}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// 刷新间隔选项
const INTERVALS = [
  { v: 0, l: '停止' },
  { v: 5000, l: '5s' },
  { v: 10000, l: '10s' },
  { v: 30000, l: '30s' },
];

// 每页显示数量选项
const PAGE_SIZES = [10, 20, 50, 100];

export default function RequestTracing() {
  const [stats, setStats] = useState(null);
  const [traces, setTraces] = useState([]);
  const [bottlenecks, setBottlenecks] = useState(null);
  const [activeTraces, setActiveTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [interval, setIntervalValue] = useState(10000);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [tab, setTab] = useState('recent'); // recent, slow, stats
  const [slowThreshold, setSlowThreshold] = useState(10000);

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const loadData = useCallback(async () => {
    try {
      setError('');
      const [statsRes, tracesRes, bottlenecksRes, activeRes] = await Promise.all([
        traceService.getStats(),
        tab === 'slow'
          ? traceService.getSlowTraces(slowThreshold, 50)
          : traceService.getRecentTraces(100),
        traceService.getBottlenecks(),
        traceService.getActiveTraces()
      ]);

      setStats(statsRes.data);
      // 按时间倒序排列，最新的在最前面
      const sortedTraces = (tracesRes.data || []).sort((a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
      );
      setTraces(sortedTraces);
      setBottlenecks(bottlenecksRes.data);
      setActiveTraces(activeRes.data || []);
      setLastUpdate(new Date());
    } catch (e) {
      setError('加载失败: ' + (e.response?.data?.message || e.message));
    } finally {
      setLoading(false);
    }
  }, [tab, slowThreshold]);

  useEffect(() => { loadData(); }, [loadData]);

  // 切换 tab 时重置分页
  useEffect(() => {
    setCurrentPage(1);
  }, [tab, slowThreshold]);

  useEffect(() => {
    if (interval > 0) {
      const t = window.setInterval(loadData, interval);
      return () => window.clearInterval(t);
    }
  }, [interval, loadData]);

  const handleReset = async () => {
    if (!window.confirm('确定要重置所有追踪统计数据吗？')) return;
    try {
      await traceService.resetStats();
      loadData();
    } catch (e) {
      setError('重置失败');
    }
  };

  // 计算汇总统计
  const summary = {
    totalTraces: traces.length,
    successRate: traces.length > 0
      ? ((traces.filter(t => t.result?.success).length / traces.length) * 100).toFixed(1)
      : 0,
    avgTime: traces.length > 0
      ? Math.round(traces.reduce((sum, t) => sum + (t.totalMs || 0), 0) / traces.length)
      : 0,
    activeCount: activeTraces.length
  };

  // 分页计算
  const totalPages = Math.ceil(traces.length / pageSize);
  const paginatedTraces = traces.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // 生成页码数组
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start + 1 < maxVisible) {
      start = Math.max(1, end - maxVisible + 1);
    }
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  if (loading && !stats) {
    return <div className="trace-loading"><Icon name="refresh" /><span>加载中...</span></div>;
  }

  return (
    <div className="request-tracing">
      {/* 顶栏 */}
      <header className="trace-page-header">
        <div className="trace-title">
          <Icon name="activity" />
          <h1>请求链路追踪</h1>
        </div>
        <div className="trace-controls">
          {lastUpdate && <span className="last-update">{lastUpdate.toLocaleTimeString()}</span>}
          <div className="interval-btns">
            {INTERVALS.map(o => (
              <button
                key={o.v}
                className={interval === o.v ? 'active' : ''}
                onClick={() => setIntervalValue(o.v)}
              >
                {o.l}
              </button>
            ))}
          </div>
          <button className="btn-refresh" onClick={loadData} disabled={loading}>
            <Icon name="refresh" />
          </button>
          <button className="btn-reset" onClick={handleReset}>
            <Icon name="trash" />
          </button>
        </div>
      </header>

      {error && <div className="trace-error"><Icon name="alert" />{error}</div>}

      {/* 汇总统计 */}
      <div className="summary-cards">
        <StatCard icon="layers" color="blue" value={summary.totalTraces} label="追踪记录" />
        <StatCard icon="check" color="green" value={`${summary.successRate}%`} label="成功率" />
        <StatCard icon="clock" color="orange" value={formatMs(summary.avgTime)} label="平均耗时" />
        <StatCard icon="zap" color="purple" value={summary.activeCount} label="活跃请求" />
      </div>

      {/* 瓶颈分析 */}
      {bottlenecks?.topBottlenecks?.length > 0 && (
        <div className="bottleneck-section">
          <h3><Icon name="target" /> 性能瓶颈 TOP 5</h3>
          <div className="bottleneck-bars">
            {bottlenecks.topBottlenecks.map((b, i) => (
              <div key={b.phase} className="bottleneck-item">
                <span className="bn-rank">#{i + 1}</span>
                <span className="bn-name">{PHASE_LABELS[b.phase] || b.phase}</span>
                <div className="bn-bar-wrap">
                  <div
                    className="bn-bar"
                    style={{
                      width: `${Math.min(100, (b.avgMs / bottlenecks.topBottlenecks[0].avgMs) * 100)}%`,
                      backgroundColor: PHASE_COLORS[b.phase]
                    }}
                  />
                </div>
                <span className="bn-time">{formatMs(b.avgMs)}</span>
              </div>
            ))}
          </div>
          {bottlenecks.recommendation?.length > 0 && (
            <div className="recommendations">
              <h4>优化建议</h4>
              <ul>
                {bottlenecks.recommendation.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Tab 切换 */}
      <div className="trace-tabs">
        <button className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')}>
          最近请求
        </button>
        <button className={tab === 'slow' ? 'active' : ''} onClick={() => setTab('slow')}>
          慢请求
        </button>
        <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>
          阶段统计
        </button>

        {tab === 'slow' && (
          <div className="slow-threshold">
            <label>阈值:</label>
            <select value={slowThreshold} onChange={e => setSlowThreshold(Number(e.target.value))}>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={20000}>20s</option>
              <option value={30000}>30s</option>
            </select>
          </div>
        )}
      </div>

      {/* 内容区 */}
      {tab === 'stats' ? (
        <PhaseStatsTable stats={stats} />
      ) : (
        <div className="trace-list">
          <div className="trace-list-header">
            <span>状态</span>
            <span>Trace ID</span>
            <span>路径</span>
            <span>模型</span>
            <span>首字</span>
            <span>总耗时</span>
            <span>最慢阶段</span>
            <span>时间</span>
            <span></span>
          </div>
          {traces.length === 0 ? (
            <div className="trace-empty">
              <Icon name="search" />
              <span>暂无追踪记录</span>
            </div>
          ) : (
            paginatedTraces.map(trace => (
              <TraceRow
                key={trace.traceId}
                trace={trace}
                expanded={expandedId === trace.traceId}
                onToggle={() => setExpandedId(expandedId === trace.traceId ? null : trace.traceId)}
              />
            ))
          )}

          {/* 分页控件 */}
          {traces.length > 0 && (
            <div className="pagination">
              <div className="pagination-info">
                共 <strong>{traces.length}</strong> 条记录，第 <strong>{currentPage}</strong> / <strong>{totalPages}</strong> 页
              </div>
              <div className="pagination-controls">
                <div className="page-size-select">
                  <span>每页</span>
                  <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                    {PAGE_SIZES.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <span>条</span>
                </div>
                <div className="page-btns">
                  <button
                    className="page-btn"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(1)}
                    title="首页"
                  >
                    <Icon name="chevronLeft" /><Icon name="chevronLeft" />
                  </button>
                  <button
                    className="page-btn"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(p => p - 1)}
                    title="上一页"
                  >
                    <Icon name="chevronLeft" />
                  </button>
                  {getPageNumbers().map(page => (
                    <button
                      key={page}
                      className={`page-btn ${currentPage === page ? 'active' : ''}`}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    className="page-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(p => p + 1)}
                    title="下一页"
                  >
                    <Icon name="chevronRight" />
                  </button>
                  <button
                    className="page-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(totalPages)}
                    title="末页"
                  >
                    <Icon name="chevronRight" /><Icon name="chevronRight" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 活跃请求 */}
      {activeTraces.length > 0 && (
        <div className="active-traces">
          <h3><Icon name="zap" /> 活跃请求 ({activeTraces.length})</h3>
          <div className="active-list">
            {activeTraces.map(t => (
              <div key={t.traceId} className="active-item">
                <span className="active-id">{t.traceId}</span>
                <span className="active-path">{t.metadata?.path || '--'}</span>
                <span className="active-phase">{PHASE_LABELS[t.currentPhase] || t.currentPhase || '处理中'}</span>
                <span className="active-elapsed">{formatMs(t.elapsedMs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
