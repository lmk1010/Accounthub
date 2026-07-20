/**
 * 仪表盘页面
 */

import { useEffect, useMemo, useState } from 'react';
import { statsService } from '../services/stats.service';
import { systemService } from '../services/system.service';
import { usageService } from '../services/usage.service';
import CustomSelect from '../components/CustomSelect';
import './Dashboard.css';

const formatUptime = (seconds) => {
  if (!Number.isFinite(seconds)) return '--';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`;
};

const formatNumber = (value, decimals = 0) => {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(decimals);
};

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return '--';
  return `${value.toFixed(1)}%`;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

// 支持的提供商配置
const CONSUMPTION_PROVIDERS = [
  { value: 'all', label: '全部渠道' },
  { value: 'claude-kiro-oauth', label: 'Kiro (Claude)' },
  { value: 'gemini-antigravity', label: 'Antigravity (Gemini)' },
  { value: 'openai-codex', label: 'Codex (OpenAI)' },
];

export default function Dashboard() {
  const [systemInfo, setSystemInfo] = useState(null);
  const [poolStats, setPoolStats] = useState(null);
  const [consumptionStats, setConsumptionStats] = useState(null);
  const [mysqlStatus, setMysqlStatus] = useState(null);
  const [providerType, setProviderType] = useState('all');
  const [consumptionProvider, setConsumptionProvider] = useState('all');
  const [usageData, setUsageData] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadBaseData = async () => {
    try {
      setLoading(true);
      setError('');
      const [systemInfoData, poolStatsData, consumptionData, mysqlData, usageDataResult] = await Promise.all([
        systemService.getInfo(),
        statsService.getPoolStats(providerType),
        statsService.getConsumptionStats(),
        systemService.getMySQLStatus().catch(() => null),
        usageService.getAll({ cacheOnly: true }).catch(() => null)
      ]);
      setSystemInfo(systemInfoData);
      setPoolStats(poolStatsData);
      setConsumptionStats(consumptionData);
      setMysqlStatus(mysqlData);
      setUsageData(usageDataResult);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError('加载仪表盘数据失败');
    } finally {
      setLoading(false);
    }
  };

  const loadUsageData = async (provider, refresh = false) => {
    try {
      setUsageLoading(true);
      let data;
      if (provider === 'all') {
        data = await usageService.getAll({ refresh });
      } else {
        data = await usageService.getByType(provider, { refresh });
      }
      setUsageData(data);
    } catch (err) {
      console.error('Failed to load usage data:', err);
    } finally {
      setUsageLoading(false);
    }
  };

  const reloadPoolStats = async (type) => {
    try {
      const data = await statsService.getPoolStats(type || 'all');
      setPoolStats(data);
    } catch (err) {
      console.error('Failed to reload pool stats:', err);
    }
  };

  useEffect(() => {
    loadBaseData();
  }, []);

  useEffect(() => {
    if (!poolStats) return;
    reloadPoolStats(providerType);
  }, [providerType]);

  useEffect(() => {
    if (consumptionProvider !== 'all') {
      loadUsageData(consumptionProvider);
    }
  }, [consumptionProvider]);

  // 计算用量统计摘要（统一使用百分比模式）
  const usageSummary = useMemo(() => {
    // 获取数据源
    let allInstances = [];
    let totalWithUsage = 0;
    let totalAccountCount = 0;
    let totalPercentSum = 0;
    let totalUsageUsed = 0;
    let totalUsageLimit = 0;
    let warningCount = 0;
    let criticalCount = 0;

    if (consumptionProvider === 'all') {
      // 全部渠道：汇总所有渠道的数据
      const providers = usageData?.providers || {};
      for (const providerData of Object.values(providers)) {
        if (providerData?.instances && providerData.instances.length > 0) {
          allInstances.push(...providerData.instances);
        } else if (providerData?.summary) {
          totalWithUsage += providerData.summary.withUsage || 0;
          totalAccountCount += providerData.summary.total || 0;
          totalPercentSum += (providerData.summary.quotaUsagePercent ?? providerData.summary.avgPercent ?? 0) * (providerData.summary.withUsage || 0);
          totalUsageUsed += Number(providerData.summary.totalUsed) || 0;
          totalUsageLimit += Number(providerData.summary.totalLimit) || 0;
        }
        if (providerData?.summary) {
          warningCount += providerData.summary.warningCount || 0;
          criticalCount += providerData.summary.criticalCount || 0;
        }
      }
    } else {
      // 特定渠道
      const providerData = usageData?.providers?.[consumptionProvider] || usageData;
      if (providerData?.instances && providerData.instances.length > 0) {
        allInstances = providerData.instances;
      } else if (providerData?.summary) {
        totalWithUsage = providerData.summary.withUsage || 0;
        totalAccountCount = providerData.summary.total || 0;
        totalPercentSum = (providerData.summary.quotaUsagePercent ?? providerData.summary.avgPercent ?? 0) * (providerData.summary.withUsage || 0);
        totalUsageUsed = Number(providerData.summary.totalUsed) || 0;
        totalUsageLimit = Number(providerData.summary.totalLimit) || 0;
      }
      if (providerData?.summary) {
        warningCount = providerData.summary.warningCount || 0;
        criticalCount = providerData.summary.criticalCount || 0;
      }
    }

    // 计算统计数据
    const accountCount = allInstances.length > 0 ? allInstances.length : totalAccountCount;
    let totalUsed = 0;
    let totalLimit = 0;
    let validCount = 0;

    if (allInstances.length > 0) {
      for (const instance of allInstances) {
        const summary = instance.usageSummary;
        if (summary && !instance.error) {
          const used = Number(summary.used);
          const limit = Number(summary.limit);
          if (Number.isFinite(limit) && limit > 0) {
            totalUsed += Number.isFinite(used) ? Math.max(0, used) : 0;
            totalLimit += limit;
          }
          if (Number.isFinite(Number(summary.percent))) {
            validCount++;
          }
        }
      }
    } else {
      totalUsed = totalUsageUsed > 0 ? totalUsageUsed : totalPercentSum;
      totalLimit = totalUsageLimit;
      validCount = totalWithUsage;
    }

    const avgPercent = totalLimit > 0
      ? Math.max(0, Math.min(100, (totalUsed / totalLimit) * 100))
      : validCount > 0
        ? totalUsed / validCount
        : 0;

    return {
      usagePercent: avgPercent,
      creditsRemaining: Math.max(0, 100 - avgPercent),
      accountCount,
      validCount,
      warningCount,
      criticalCount,
      unit: '%',
      isPercentMode: true,
      noData: accountCount === 0
    };
  }, [consumptionProvider, usageData]);

  // 号池健康状态：不再盲目默认为 'healthy'
  // 当 poolStats 还未加载时显示 'loading'
  // 当后端返回 healthStatus 时使用后端值
  // 否则根据 unhealthy 比率自行计算
  const poolHealthStatus = useMemo(() => {
    if (!poolStats) return 'loading';
    if (poolStats.healthStatus) return poolStats.healthStatus;
    // 后端没给 healthStatus，根据数据自行判断
    const totalActive = poolStats.totalActive ?? 0;
    const totalUnhealthy = poolStats.totalUnhealthy ?? 0;
    if (totalActive === 0) return 'warning'; // 没有可用账号也应告警
    const ratio = totalUnhealthy / totalActive;
    if (ratio > 0.5) return 'error';
    if (ratio > 0.2) return 'warning';
    return 'healthy';
  }, [poolStats]);

  const poolStatusText = poolHealthStatus === 'error'
    ? '异常'
    : poolHealthStatus === 'warning'
      ? '告警'
      : poolHealthStatus === 'loading'
        ? '加载中'
        : '健康';

  const badRate = useMemo(() => {
    if (!poolStats?.totalActive) return 0;
    return (poolStats.totalUnhealthy / poolStats.totalActive) * 100;
  }, [poolStats]);

  const successRate = useMemo(() => {
    if (!poolStats?.totalRequests) return 0;
    return (poolStats.successRequests / poolStats.totalRequests) * 100;
  }, [poolStats]);

  return (
    <section id="dashboard" className="section active">
      <div className="dashboard-layout">
        {error && <div className="alert alert-error">{error}</div>}
        {/* 第一行：运行概览 + 消耗状态 */}
        <div className="dashboard-row">
          {/* 运行概览 */}
          <div className="dashboard-panel overview-panel">
            <div className="panel-header">
              <div>
                <h3>运行概览</h3>
                <p className="panel-subtitle">资源使用与核心状态</p>
              </div>
            </div>
            <div className="overview-content">
              {/* 左侧蓝色卡片 */}
              <div className="overview-card">
                <div className="overview-card-top">
                  <span className="overview-brand">AICLIENT</span>
                  <span className="overview-chip"><i className="fas fa-signal"></i></span>
                </div>
                <div className="overview-value">{formatUptime(systemInfo?.uptime)}</div>
                <div className="overview-label">运行时间</div>
                <div className="overview-footer">
                  <div className="overview-meta">
                    <span className="meta-label">运行模式</span>
                    <span className="meta-value">{systemInfo?.mode || '--'}</span>
                  </div>
                  <div className="overview-meta">
                    <span className="meta-label">进程 PID</span>
                    <span className="meta-value">{systemInfo?.pid || '--'}</span>
                  </div>
                </div>
              </div>
              {/* 右侧指标列表 */}
              <div className="overview-metrics">
                <div className="metric-row">
                  <span className="metric-label">内存使用</span>
                  <span className="metric-value">{systemInfo?.memoryUsage || '-- / --'}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">CPU 使用</span>
                  <span className="metric-value">{systemInfo?.cpuUsage || '--%'}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">服务器时间</span>
                  <span className="metric-value">{systemInfo?.serverTime || '--'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 消耗状态 */}
          <div className="dashboard-panel consumption-panel">
            <div className="panel-header">
              <div>
                <h3>消耗状态</h3>
                <p className="panel-subtitle">
                  {consumptionProvider === 'all' ? '全部渠道用量统计' :
                   consumptionProvider === 'claude-kiro-oauth' ? 'Kiro 用量统计' :
                   consumptionProvider === 'gemini-antigravity' ? 'Antigravity 用量统计' :
                   consumptionProvider === 'openai-codex' ? 'Codex 用量统计' : '用量统计'}
                </p>
              </div>
              <div className="consumption-controls">
                <CustomSelect
                  value={consumptionProvider}
                  onChange={setConsumptionProvider}
                  options={CONSUMPTION_PROVIDERS}
                  size="small"
                  className="consumption-provider-select"
                />
                <button
                  className="consumption-refresh-btn"
                  onClick={() => loadUsageData(consumptionProvider, true)}
                  disabled={usageLoading}
                  title="刷新用量数据"
                >
                  <i className={`fas fa-sync-alt ${usageLoading ? 'fa-spin' : ''}`} />
                </button>
              </div>
            </div>
            <div className="consumption-stats-grid">
              <div className="consumption-stat-card total">
                <div className="consumption-stat-icon">
                  <i className="fas fa-chart-pie"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{formatPercent(usageSummary.usagePercent)}</span>
                  <span className="consumption-stat-label">平均使用率</span>
                </div>
              </div>
              <div className="consumption-stat-card remaining">
                <div className="consumption-stat-icon">
                  <i className="fas fa-battery-three-quarters"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{formatPercent(usageSummary.creditsRemaining)}</span>
                  <span className="consumption-stat-label">平均剩余</span>
                </div>
              </div>
              <div className="consumption-stat-card accounts">
                <div className="consumption-stat-icon">
                  <i className="fas fa-users"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{usageSummary.accountCount}</span>
                  <span className="consumption-stat-label">账号数量</span>
                </div>
              </div>
              <div className="consumption-stat-card used">
                <div className="consumption-stat-icon">
                  <i className="fas fa-check-circle"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{usageSummary.validCount || 0}</span>
                  <span className="consumption-stat-label">有效账号</span>
                </div>
              </div>
              <div className="consumption-stat-card warning">
                <div className="consumption-stat-icon">
                  <i className="fas fa-exclamation-triangle"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{usageSummary.warningCount || 0}</span>
                  <span className="consumption-stat-label">告警账号</span>
                </div>
              </div>
              <div className="consumption-stat-card critical">
                <div className="consumption-stat-icon">
                  <i className="fas fa-times-circle"></i>
                </div>
                <div className="consumption-stat-body">
                  <span className="consumption-stat-value">{usageSummary.criticalCount || 0}</span>
                  <span className="consumption-stat-label">超限账号</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 第二行：号池状态 */}
        <div className="dashboard-panel pool-status-panel">
          <div className="panel-header">
            <div>
              <h3>号池状态</h3>
              <p className="panel-subtitle">账号池健康状态与统计</p>
            </div>
            <div className="pool-status-controls">
              <select
                className="pool-provider-filter"
                value={providerType}
                onChange={(event) => setProviderType(event.target.value)}
              >
                <option value="all">全部号池</option>
                {Object.keys(poolStats?.providerTypes || {}).map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <div className="pool-status-badge">
                <span className={`status-dot ${poolHealthStatus}`}></span>
                <span>{poolStatusText}</span>
              </div>
            </div>
          </div>
          <div className="pool-stats-grid">
            <div className="pool-stat-card">
              <div className="pool-stat-icon available">
                <i className="fas fa-check-circle"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{poolStats?.totalHealthy ?? 0}</span>
                <span className="pool-stat-label">可用账号</span>
              </div>
            </div>
            <div className="pool-stat-card">
              <div className="pool-stat-icon total">
                <i className="fas fa-database"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{poolStats?.totalActive ?? 0}</span>
                <span className="pool-stat-label">总账号数</span>
              </div>
            </div>
            <div className="pool-stat-card">
              <div className="pool-stat-icon error">
                <i className="fas fa-exclamation-triangle"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{formatPercent(badRate)}</span>
                <span className="pool-stat-label">坏号 <i className="fas fa-external-link-alt" style={{fontSize: '10px'}}></i></span>
              </div>
            </div>
            <div className="pool-stat-card">
              <div className="pool-stat-icon switch">
                <i className="fas fa-exchange-alt"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{poolStats?.switchCount ?? 0}</span>
                <span className="pool-stat-label">切号次数</span>
              </div>
            </div>
            <div className="pool-stat-card">
              <div className="pool-stat-icon requests">
                <i className="fas fa-paper-plane"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{poolStats?.totalRequests ?? 0}</span>
                <span className="pool-stat-label">总请求数</span>
              </div>
            </div>
            <div className="pool-stat-card">
              <div className="pool-stat-icon success">
                <i className="fas fa-thumbs-up"></i>
              </div>
              <div className="pool-stat-body">
                <span className="pool-stat-value">{formatPercent(successRate)}</span>
                <span className="pool-stat-label">成功率 <i className="fas fa-external-link-alt" style={{fontSize: '10px'}}></i></span>
              </div>
            </div>
          </div>
        </div>

        {/* 第三行：并发情况 */}
        <div className="dashboard-panel concurrency-panel">
          <div className="panel-header">
            <div>
              <h3>并发情况</h3>
              <p className="panel-subtitle">实时连接与负载状态</p>
            </div>
          </div>
          <div className="concurrency-stats-grid">
            <div className="concurrency-stat-card active">
              <div className="concurrency-stat-icon">
                <i className="fas fa-bolt"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">{systemInfo?.concurrency?.active ?? 0}</span>
                <span className="concurrency-stat-label">当前连接</span>
              </div>
            </div>
            <div className="concurrency-stat-card peak">
              <div className="concurrency-stat-icon">
                <i className="fas fa-chart-line"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">{systemInfo?.concurrency?.peak ?? 0}</span>
                <span className="concurrency-stat-label">峰值连接</span>
              </div>
            </div>
            <div className="concurrency-stat-card load">
              <div className="concurrency-stat-icon">
                <i className="fas fa-tachometer-alt"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">{systemInfo?.load?.percent ? `${systemInfo.load.percent}%` : '--'}</span>
                <span className="concurrency-stat-label">系统负载</span>
              </div>
            </div>
            <div className="concurrency-stat-card total">
              <div className="concurrency-stat-icon">
                <i className="fas fa-link"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">{systemInfo?.concurrency?.total ?? 0}</span>
                <span className="concurrency-stat-label">累计连接</span>
              </div>
            </div>
            <div className="concurrency-stat-card avg">
              <div className="concurrency-stat-icon">
                <i className="fas fa-balance-scale"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">
                  {systemInfo?.load ? `${systemInfo.load.avg1m} / ${systemInfo.load.avg5m} / ${systemInfo.load.avg15m}` : '--'}
                </span>
                <span className="concurrency-stat-label">负载均值</span>
              </div>
            </div>
            <div className="concurrency-stat-card cores">
              <div className="concurrency-stat-icon">
                <i className="fas fa-microchip"></i>
              </div>
              <div className="concurrency-stat-body">
                <span className="concurrency-stat-value">{systemInfo?.load?.cpuCount ?? systemInfo?.cpus ?? '--'}</span>
                <span className="concurrency-stat-label">CPU 核心</span>
              </div>
            </div>
          </div>
        </div>

        {/* 第四行：MySQL 状态 */}
        {mysqlStatus && (
          <div className="dashboard-panel mysql-panel">
            <div className="panel-header">
              <div>
                <h3>MySQL 状态</h3>
                <p className="panel-subtitle">数据库连接与性能监控 · v{mysqlStatus.version}</p>
              </div>
              <div className="mysql-uptime">
                <i className="fas fa-clock"></i>
                <span>{formatUptime(mysqlStatus.uptime)}</span>
              </div>
            </div>
            <div className="mysql-stats-grid">
              <div className="mysql-stat-card connections">
                <div className="mysql-stat-icon">
                  <i className="fas fa-plug"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{mysqlStatus.connections?.current ?? 0} / {mysqlStatus.connections?.max ?? 0}</span>
                  <span className="mysql-stat-label">当前连接</span>
                </div>
              </div>
              <div className="mysql-stat-card running">
                <div className="mysql-stat-icon">
                  <i className="fas fa-running"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{mysqlStatus.connections?.running ?? 0}</span>
                  <span className="mysql-stat-label">活跃线程</span>
                </div>
              </div>
              <div className="mysql-stat-card queries">
                <div className="mysql-stat-icon">
                  <i className="fas fa-search"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{formatNumber(mysqlStatus.queries?.total ?? 0)}</span>
                  <span className="mysql-stat-label">总查询数</span>
                </div>
              </div>
              <div className="mysql-stat-card slow">
                <div className="mysql-stat-icon">
                  <i className="fas fa-hourglass-half"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{mysqlStatus.queries?.slowQueries ?? 0}</span>
                  <span className="mysql-stat-label">慢查询</span>
                </div>
              </div>
              <div className="mysql-stat-card traffic-in">
                <div className="mysql-stat-icon">
                  <i className="fas fa-download"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{formatBytes(mysqlStatus.traffic?.bytesReceived ?? 0)}</span>
                  <span className="mysql-stat-label">接收流量</span>
                </div>
              </div>
              <div className="mysql-stat-card traffic-out">
                <div className="mysql-stat-icon">
                  <i className="fas fa-upload"></i>
                </div>
                <div className="mysql-stat-body">
                  <span className="mysql-stat-value">{formatBytes(mysqlStatus.traffic?.bytesSent ?? 0)}</span>
                  <span className="mysql-stat-label">发送流量</span>
                </div>
              </div>
            </div>
            <div className="mysql-pool-info">
              <span className="pool-info-item">
                <i className="fas fa-layer-group"></i>
                本地连接池: {mysqlStatus.localPool?.total ?? 0} 总 / {mysqlStatus.localPool?.free ?? 0} 空闲 / {mysqlStatus.localPool?.queue ?? 0} 等待
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
