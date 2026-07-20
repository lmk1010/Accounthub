/**
 * 用量查询页面
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import './Usage.css';

const PROVIDER_NAME_MAP = {
  'claude-kiro-oauth': 'Claude Kiro OAuth',
  'gemini-cli-oauth': 'Gemini CLI OAuth',
  'gemini-antigravity': 'Gemini Antigravity',
  'openai-codex': 'OpenAI Codex OAuth',
  'claude-warp-oauth': 'Warp AI OAuth',
  'openai-droid': 'Droid OpenAI',
  'openaiResponses-droid': 'Droid Responses',
  'claude-droid': 'Droid Claude'
};

const PROVIDER_ICON_MAP = {
  'claude-kiro-oauth': 'fas fa-robot',
  'gemini-cli-oauth': 'fas fa-gem',
  'gemini-antigravity': 'fas fa-rocket',
  'openai-codex': 'fas fa-terminal',
  'claude-warp-oauth': 'fas fa-bolt',
  'openai-droid': 'fas fa-bolt',
  'openaiResponses-droid': 'fas fa-bolt',
  'claude-droid': 'fas fa-bolt'
};

const getProviderDisplayName = (providerType) => PROVIDER_NAME_MAP[providerType] || providerType;
const getProviderIcon = (providerType) => PROVIDER_ICON_MAP[providerType] || 'fas fa-server';

const formatNumber = (num) => {
  if (num === null || num === undefined) return '0.00';
  const rounded = Math.ceil(Number(num) * 100) / 100;
  return rounded.toFixed(2);
};

const formatDate = (dateStr) => {
  if (!dateStr) return '--';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return dateStr;
  }
};

const calculateTotalUsage = (usageBreakdown) => {
  if (!usageBreakdown || usageBreakdown.length === 0) {
    return { hasData: false, used: 0, limit: 0, percent: 0 };
  }

  let totalUsed = 0;
  let totalLimit = 0;

  usageBreakdown.forEach((breakdown) => {
    totalUsed += breakdown.currentUsage || 0;
    totalLimit += breakdown.usageLimit || 0;

    if (breakdown.freeTrial && breakdown.freeTrial.status === 'ACTIVE') {
      totalUsed += breakdown.freeTrial.currentUsage || 0;
      totalLimit += breakdown.freeTrial.usageLimit || 0;
    }

    if (Array.isArray(breakdown.bonuses)) {
      breakdown.bonuses.forEach((bonus) => {
        if (bonus.status === 'ACTIVE') {
          totalUsed += bonus.currentUsage || 0;
          totalLimit += bonus.usageLimit || 0;
        }
      });
    }
  });

  const percent = totalLimit > 0 ? Math.min(100, (totalUsed / totalLimit) * 100) : 0;

  return {
    hasData: true,
    used: totalUsed,
    limit: totalLimit,
    percent
  };
};

function UsageDetailModal({ detail, onClose }) {
  useEffect(() => {
    const handleEsc = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  if (!detail) return null;

  const { instance, totalUsage } = detail;
  const percent = totalUsage?.percent || 0;
  const progressClass = percent >= 90 ? 'danger' : (percent >= 70 ? 'warning' : 'normal');
  const statusText = percent >= 90 ? '高用量' : (percent >= 70 ? '中用量' : '正常');
  const userEmail = instance?.usage?.user?.email || '';
  const subscriptionTitle = instance?.usage?.subscription?.title || '';
  const breakdownList = instance?.usage?.usageBreakdown || [];

  return (
    <div className="usage-detail-modal" onClick={onClose}>
      <div className="usage-detail-content" onClick={(event) => event.stopPropagation()}>
        <div className="usage-detail-header">
          <h3>
            <i className="fas fa-chart-pie"></i> 用量详情
          </h3>
          <button className="modal-close" onClick={onClose} title="关闭">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="usage-detail-body">
          <div className="detail-info-section">
            <div className="detail-info-row">
              <span className="detail-label">名称</span>
              <span className="detail-value" title={instance?.name || instance?.uuid || ''}>
                {instance?.name || instance?.uuid || '未知'}
              </span>
            </div>
            <div className="detail-info-row">
              <span className="detail-label">状态</span>
              <span className={`compact-card-status status-${progressClass}`}>
                <i className="fas fa-circle" style={{ fontSize: '0.4rem' }}></i>
                {statusText}
              </span>
            </div>
            {userEmail && (
              <div className="detail-info-row">
                <span className="detail-label">邮箱</span>
                <span className="detail-value" title={userEmail}>{userEmail}</span>
              </div>
            )}
            {subscriptionTitle && (
              <div className="detail-info-row">
                <span className="detail-label">订阅</span>
                <span className="detail-value subscription-badge">{subscriptionTitle}</span>
              </div>
            )}
          </div>

          <div className="detail-usage-section">
            <h4>
              <i className="fas fa-tachometer-alt"></i> 总用量
            </h4>
            <div className="detail-total-usage">
              <div className={`compact-progress-bar ${progressClass}`} style={{ height: '8px' }}>
                <div
                  className="compact-progress-fill"
                  style={{ width: `${Math.min(100, percent)}%` }}
                ></div>
              </div>
              <div className="detail-usage-stats">
                <span className={`detail-percent ${progressClass}`}>{percent.toFixed(2)}%</span>
                <span className="detail-usage-text">
                  {formatNumber(totalUsage?.used)} / {formatNumber(totalUsage?.limit)}
                </span>
              </div>
            </div>
          </div>

          {breakdownList.length > 0 && (
            <div className="detail-breakdown-section">
              <h4>
                <i className="fas fa-list-ul"></i> 用量明细
              </h4>
              <div className="detail-breakdown-list">
                {breakdownList.map((item, index) => {
                  const itemPercent = item.usageLimit > 0 ? (item.currentUsage / item.usageLimit) * 100 : 0;
                  const itemClass = itemPercent >= 90 ? 'danger' : (itemPercent >= 70 ? 'warning' : 'normal');
                  const itemName = item.displayName || item.resourceType || '未知';

                  return (
                    <div className="detail-breakdown-item" key={`${itemName}-${index}`}>
                      <div className="breakdown-item-header">
                        <span className="breakdown-name">{itemName}</span>
                        <span className={`breakdown-percent ${itemClass}`}>{itemPercent.toFixed(1)}%</span>
                      </div>
                      <div className={`compact-progress-bar ${itemClass}`}>
                        <div
                          className="compact-progress-fill"
                          style={{ width: `${Math.min(100, itemPercent)}%` }}
                        ></div>
                      </div>
                      <div className="breakdown-values">
                        {formatNumber(item.currentUsage)} / {formatNumber(item.usageLimit)}
                      </div>

                      {item.freeTrial && item.freeTrial.status === 'ACTIVE' && (
                        <div className="detail-extra-info free-trial">
                          <i className="fas fa-gift"></i>
                          <span>免费试用</span>
                          <span className="extra-usage">
                            {formatNumber(item.freeTrial.currentUsage)} / {formatNumber(item.freeTrial.usageLimit)}
                          </span>
                          <span className="extra-expires">到期: {formatDate(item.freeTrial.expiresAt)}</span>
                        </div>
                      )}

                      {Array.isArray(item.bonuses) && item.bonuses.map((bonus, bonusIndex) => (
                        bonus.status === 'ACTIVE' ? (
                          <div className="detail-extra-info bonus" key={`${bonus.displayName || bonus.code}-${bonusIndex}`}>
                            <i className="fas fa-star"></i>
                            <span>{bonus.displayName || bonus.code}</span>
                            <span className="extra-usage">
                              {formatNumber(bonus.currentUsage)} / {formatNumber(bonus.usageLimit)}
                            </span>
                            <span className="extra-expires">到期: {formatDate(bonus.expiresAt)}</span>
                          </div>
                        ) : null
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Usage() {
  const [usageData, setUsageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState('暂无数据');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [detail, setDetail] = useState(null);
  const abortRef = useRef(null);

  const groupedProviders = useMemo(() => {
    const providers = usageData?.providers || {};
    const entries = Object.entries(providers);
    const grouped = [];

    entries.forEach(([providerType, providerData]) => {
      const instances = providerData?.instances || [];
      const validInstances = instances.filter((instance) => {
        if (!instance) return false;
        if (instance.error === '服务实例未初始化') return false;
        if (instance.isDisabled || instance.disabled) return false;
        if (instance.isDeleted || instance.deleted) return false;
        if (instance.error && String(instance.error).includes('403')) return false;
        return instance.success && (instance.isHealthy ?? instance.healthy ?? true);
      });
      if (validInstances.length > 0) {
        grouped.push({ providerType, instances: validInstances });
      }
    });

    return grouped;
  }, [usageData]);

  const emptyState = useMemo(() => {
    if (!usageData) {
      return {
        icon: 'fa-chart-bar',
        text: '点击\"刷新用量\"按钮获取授权文件用量信息'
      };
    }
    const providerKeys = Object.keys(usageData.providers || {});
    if (providerKeys.length === 0) {
      return {
        icon: 'fa-chart-bar',
        text: '暂无用量数据'
      };
    }
    if (groupedProviders.length === 0) {
      return {
        icon: 'fa-chart-bar',
        text: '暂无健康的提供商'
      };
    }
    return null;
  }, [usageData, groupedProviders]);

  useEffect(() => {
    loadUsage();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const loadUsage = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await usageService.getAll({ cacheOnly: true });

      if (data?.noCache) {
        setUsageData(null);
        setLastUpdate('暂无数据');
        return;
      }

      setUsageData(data);

      if (data?.timestamp) {
        const timeStr = new Date(data.timestamp).toLocaleString('zh-CN');
        setLastUpdate(`上次刷新: ${timeStr}`);
      }
    } catch (err) {
      console.error('获取用量数据失败:', err);
      setError(err.message || '加载用量失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshUsage = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setLoading(true);
    setError('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await usageService.getAll({ refresh: true, signal: controller.signal });
      setUsageData(data);
      setLastUpdate(`更新时间: ${new Date().toLocaleString('zh-CN')}`);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') {
        return;
      }
      console.error('刷新用量失败:', err);
      setError(err.message || '刷新用量失败');
    } finally {
      setIsRefreshing(false);
      setLoading(false);
      abortRef.current = null;
    }
  };

  const stopRefresh = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsRefreshing(false);
    setLoading(false);
  };

  return (
    <div className="usage-page">
      <div className="usage-header">
        <div>
          <h1>用量查询</h1>
          <p className="usage-subtitle">快速查看授权文件用量与订阅配额</p>
        </div>
      </div>

      <div className="usage-panel">
        <div className="usage-controls">
          <div className="usage-control-buttons">
            <button
              className="btn btn-primary"
              id="refreshUsageBtn"
              onClick={refreshUsage}
              disabled={isRefreshing}
              style={{ display: isRefreshing ? 'none' : 'inline-flex' }}
            >
              <i className="fas fa-sync-alt"></i> 刷新用量
            </button>
            <button
              className="btn btn-danger"
              id="stopUsageBtn"
              onClick={stopRefresh}
              style={{ display: isRefreshing ? 'inline-flex' : 'none' }}
            >
              <i className="fas fa-stop"></i> 停止
            </button>
          </div>
          <span className="usage-last-update">{lastUpdate}</span>
        </div>

        {loading && (
          <div className="usage-loading">
            <i className="fas fa-spinner fa-spin"></i> 正在加载用量数据...
          </div>
        )}

        {error && (
          <div className="usage-error">
            <i className="fas fa-exclamation-triangle"></i>
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <div className="usage-content">
            {emptyState ? (
              <div className="usage-empty">
                <i className={`fas ${emptyState.icon}`}></i>
                <p>{emptyState.text}</p>
              </div>
            ) : (
              groupedProviders.map((group) => (
                <div className="usage-compact-group" key={group.providerType}>
                  <div className="usage-compact-header">
                    <i className={getProviderIcon(group.providerType)}></i>
                    <span>{getProviderDisplayName(group.providerType)}</span>
                    <span className="usage-compact-count">({group.instances.length})</span>
                  </div>
                  <div className="usage-compact-grid">
                    {group.instances.map((instance) => {
                      const totalUsage = instance.usage
                        ? calculateTotalUsage(instance.usage.usageBreakdown)
                        : { hasData: false, used: 0, limit: 0, percent: 0 };
                      const progressClass = totalUsage.percent >= 90
                        ? 'danger'
                        : (totalUsage.percent >= 70 ? 'warning' : 'normal');
                      const userEmail = instance.usage?.user?.email || '';
                      const displayName = instance.name || userEmail || instance.uuid?.substring(0, 8) || 'Unknown';
                      const fullName = instance.name || userEmail || instance.uuid || '';
                      const iconClass = progressClass === 'danger'
                        ? 'fa-exclamation-circle'
                        : (progressClass === 'warning' ? 'fa-exclamation-triangle' : 'fa-check-circle');

                      return (
                        <div
                          key={instance.uuid || displayName}
                          className={`usage-compact-card status-${progressClass}`}
                          onClick={() => setDetail({ instance, totalUsage })}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              setDetail({ instance, totalUsage });
                            }
                          }}
                        >
                          <div className={`compact-card-icon status-${progressClass}`}>
                            <i className={`fas ${iconClass}`}></i>
                          </div>
                          <div className="compact-card-info">
                            <div className="compact-card-percent">{totalUsage.percent.toFixed(1)}%</div>
                            <div className="compact-card-name" title={fullName}>{displayName}</div>
                            <div className="compact-card-usage">
                              {formatNumber(totalUsage.used)} / {formatNumber(totalUsage.limit)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <UsageDetailModal detail={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
