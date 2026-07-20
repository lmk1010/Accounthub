/**
 * Potluck admin page
 */

import { useEffect, useMemo, useState } from 'react';
import { potluckAdminService } from '../services/potluck.service';
import './PotluckAdmin.css';

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

export default function PotluckAdmin() {
  const [keys, setKeys] = useState([]);
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState({
    defaultDailyLimit: '',
    bonusPerCredential: '',
    bonusValidityDays: '',
    persistInterval: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [createForm, setCreateForm] = useState({ name: '', dailyLimit: '' });

  const loadAll = async () => {
    try {
      setLoading(true);
      setError('');
      const payload = await potluckAdminService.getKeys();
      setKeys(payload?.keys || []);
      setStats(payload?.stats || null);
      setConfig({
        defaultDailyLimit: payload?.config?.defaultDailyLimit ?? '',
        bonusPerCredential: payload?.config?.bonusPerCredential ?? '',
        bonusValidityDays: payload?.config?.bonusValidityDays ?? '',
        persistInterval: payload?.config?.persistInterval ?? '',
      });
    } catch (err) {
      console.error('Failed to load potluck admin data:', err);
      setError('加载分发数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleCreate = async () => {
    try {
      setNotice('');
      const name = createForm.name?.trim() || '';
      const dailyLimit = createForm.dailyLimit !== '' ? Number(createForm.dailyLimit) : undefined;
      const result = await potluckAdminService.createKey({ name, dailyLimit });
      if (result?.id) {
        setNotice(`已创建新 Key: ${result.id}`);
      }
      setCreateForm({ name: '', dailyLimit: '' });
      await loadAll();
    } catch (err) {
      console.error('Failed to create key:', err);
      setError('创建 Key 失败');
    }
  };

  const handleUpdateConfig = async () => {
    try {
      setNotice('');
      const payload = {
        defaultDailyLimit: config.defaultDailyLimit !== '' ? Number(config.defaultDailyLimit) : undefined,
        bonusPerCredential: config.bonusPerCredential !== '' ? Number(config.bonusPerCredential) : undefined,
        bonusValidityDays: config.bonusValidityDays !== '' ? Number(config.bonusValidityDays) : undefined,
        persistInterval: config.persistInterval !== '' ? Number(config.persistInterval) : undefined,
      };
      const result = await potluckAdminService.updateConfig(payload);
      setConfig({
        defaultDailyLimit: result?.defaultDailyLimit ?? '',
        bonusPerCredential: result?.bonusPerCredential ?? '',
        bonusValidityDays: result?.bonusValidityDays ?? '',
        persistInterval: result?.persistInterval ?? '',
      });
      setNotice('配置已保存');
    } catch (err) {
      console.error('Failed to update config:', err);
      setError('更新配置失败');
    }
  };

  const handleApplyLimit = async () => {
    try {
      const result = await potluckAdminService.applyLimitToAll();
      setNotice(result?.message || '已同步每日限额');
      await loadAll();
    } catch (err) {
      console.error('Failed to apply limit:', err);
      setError('批量限额更新失败');
    }
  };

  const handleApplyBonus = async () => {
    try {
      const result = await potluckAdminService.applyBonusToAll();
      setNotice(result?.message || '已同步资源包');
      await loadAll();
    } catch (err) {
      console.error('Failed to apply bonus:', err);
      setError('资源包同步失败');
    }
  };

  const handleToggle = async (keyId) => {
    try {
      await potluckAdminService.toggleKey(keyId);
      await loadAll();
    } catch (err) {
      console.error('Failed to toggle key:', err);
      setError('切换状态失败');
    }
  };

  const handleResetUsage = async (keyId) => {
    if (!window.confirm('确认重置该 Key 今日用量吗？')) return;
    try {
      await potluckAdminService.resetKeyUsage(keyId);
      await loadAll();
    } catch (err) {
      console.error('Failed to reset usage:', err);
      setError('重置失败');
    }
  };

  const handleRename = async (keyId) => {
    const name = window.prompt('输入新的名称');
    if (!name) return;
    try {
      await potluckAdminService.updateKeyName(keyId, name.trim());
      await loadAll();
    } catch (err) {
      console.error('Failed to update name:', err);
      setError('更新名称失败');
    }
  };

  const handleLimitUpdate = async (keyId) => {
    const value = window.prompt('输入新的每日限额');
    if (value === null) return;
    const dailyLimit = Number(value);
    if (Number.isNaN(dailyLimit)) {
      setError('每日限额必须是数字');
      return;
    }
    try {
      await potluckAdminService.updateKeyLimit(keyId, dailyLimit);
      await loadAll();
    } catch (err) {
      console.error('Failed to update limit:', err);
      setError('更新限额失败');
    }
  };

  const handleRegenerate = async (keyId) => {
    if (!window.confirm('确认重置 Key？旧 Key 将失效。')) return;
    try {
      const result = await potluckAdminService.regenerateKey(keyId);
      if (result?.newKey) {
        setNotice(`Key 已重置，新 Key: ${result.newKey}`);
      }
      await loadAll();
    } catch (err) {
      console.error('Failed to regenerate key:', err);
      setError('重置 Key 失败');
    }
  };

  const handleDelete = async (keyId) => {
    if (!window.confirm('确认删除该 Key 吗？')) return;
    try {
      await potluckAdminService.deleteKey(keyId);
      await loadAll();
    } catch (err) {
      console.error('Failed to delete key:', err);
      setError('删除失败');
    }
  };

  const filteredKeys = useMemo(() => {
    const term = search.trim().toLowerCase();
    return keys.filter((item) => {
      const matches = !term || `${item.name || ''} ${item.id || ''} ${item.maskedKey || ''}`.toLowerCase().includes(term);
      const statusMatch = filter === 'all'
        || (filter === 'enabled' && item.enabled)
        || (filter === 'disabled' && !item.enabled);
      return matches && statusMatch;
    });
  }, [keys, search, filter]);

  return (
    <div className="potluck-admin-page">
      <div className="potluck-header">
        <div>
          <h1>分发管理</h1>
          <p className="potluck-subtitle">Key 管理、限额与资源包配置</p>
        </div>
        <div className="potluck-actions">
          <button className="btn btn-outline" onClick={loadAll} disabled={loading}>
            <i className="fas fa-sync-alt"></i>
            刷新
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      <div className="potluck-stats">
        <div className="stat-card">
          <div className="stat-icon primary">
            <i className="fas fa-key"></i>
          </div>
          <div className="stat-body">
            <span className="stat-value">{formatNumber(stats?.totalKeys || 0)}</span>
            <span className="stat-label">Key 总数</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon success">
            <i className="fas fa-check-circle"></i>
          </div>
          <div className="stat-body">
            <span className="stat-value">{formatNumber(stats?.enabledKeys || 0)}</span>
            <span className="stat-label">启用中</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon warning">
            <i className="fas fa-ban"></i>
          </div>
          <div className="stat-body">
            <span className="stat-value">{formatNumber(stats?.disabledKeys || 0)}</span>
            <span className="stat-label">已禁用</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon info">
            <i className="fas fa-chart-line"></i>
          </div>
          <div className="stat-body">
            <span className="stat-value">{formatNumber(stats?.todayTotalUsage || 0)}</span>
            <span className="stat-label">今日用量</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon secondary">
            <i className="fas fa-layer-group"></i>
          </div>
          <div className="stat-body">
            <span className="stat-value">{formatNumber(stats?.totalUsage || 0)}</span>
            <span className="stat-label">累计用量</span>
          </div>
        </div>
      </div>

      <div className="potluck-grid">
        <section className="potluck-card">
          <div className="potluck-card-header">
            <div>
              <h2>配置中心</h2>
              <p>默认限额、资源包与持久化策略</p>
            </div>
            <div className="potluck-card-actions">
              <button className="btn btn-outline" onClick={handleUpdateConfig}>
                <i className="fas fa-save"></i>
                保存配置
              </button>
              <button className="btn btn-outline" onClick={handleApplyLimit}>
                <i className="fas fa-bolt"></i>
                应用限额
              </button>
              <button className="btn btn-outline" onClick={handleApplyBonus}>
                <i className="fas fa-gift"></i>
                同步资源包
              </button>
            </div>
          </div>
          <div className="potluck-config-form">
            <div className="form-group">
              <label>默认每日限额</label>
              <input
                className="form-control"
                type="number"
                value={config.defaultDailyLimit}
                onChange={(event) => setConfig((prev) => ({ ...prev, defaultDailyLimit: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>每凭据资源包</label>
              <input
                className="form-control"
                type="number"
                value={config.bonusPerCredential}
                onChange={(event) => setConfig((prev) => ({ ...prev, bonusPerCredential: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>资源包有效期（天）</label>
              <input
                className="form-control"
                type="number"
                value={config.bonusValidityDays}
                onChange={(event) => setConfig((prev) => ({ ...prev, bonusValidityDays: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>持久化间隔（毫秒）</label>
              <input
                className="form-control"
                type="number"
                value={config.persistInterval}
                onChange={(event) => setConfig((prev) => ({ ...prev, persistInterval: event.target.value }))}
              />
            </div>
          </div>
        </section>

        <section className="potluck-card">
          <div className="potluck-card-header">
            <div>
              <h2>创建 Key</h2>
              <p>创建新的分发 Key</p>
            </div>
            <div className="potluck-card-actions">
              <button className="btn btn-primary" onClick={handleCreate}>
                <i className="fas fa-plus"></i>
                创建
              </button>
            </div>
          </div>
          <div className="potluck-create-form">
            <div className="form-group">
              <label>名称</label>
              <input
                className="form-control"
                value={createForm.name}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="比如：渠道A"
              />
            </div>
            <div className="form-group">
              <label>每日限额（可选）</label>
              <input
                className="form-control"
                type="number"
                value={createForm.dailyLimit}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, dailyLimit: event.target.value }))}
                placeholder="留空使用默认限额"
              />
            </div>
          </div>
        </section>
      </div>

      <section className="potluck-card">
        <div className="potluck-card-header">
          <div>
            <h2>Key 列表</h2>
            <p>支持搜索、筛选与快捷操作</p>
          </div>
          <div className="potluck-card-actions">
            <div className="potluck-filter">
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">全部</option>
                <option value="enabled">启用</option>
                <option value="disabled">禁用</option>
              </select>
            </div>
            <div className="potluck-search">
              <i className="fas fa-search"></i>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索名称或 Key"
              />
            </div>
          </div>
        </div>

        <div className="potluck-key-list">
          {loading ? (
            <div className="potluck-empty">
              <i className="fas fa-spinner fa-spin"></i>
              加载中...
            </div>
          ) : filteredKeys.length === 0 ? (
            <div className="potluck-empty">
              <i className="fas fa-inbox"></i>
              <p>暂无 Key</p>
            </div>
          ) : (
            filteredKeys.map((item) => (
              <div key={item.id} className="potluck-key-row">
                <div className="key-main">
                  <div className="key-title">
                    <span className="key-name">{item.name || '未命名'}</span>
                    <span className={`key-status ${item.enabled ? 'enabled' : 'disabled'}`}>
                      {item.enabled ? '启用' : '禁用'}
                    </span>
                  </div>
                  <div className="key-meta">
                    <span className="key-full">
                      Key: <span className="key-value">{item.id}</span>
                    </span>
                    <span>今日 {formatNumber(item.todayUsage)} / {formatNumber(item.dailyLimit)}</span>
                    <span>资源包 {formatNumber(item.bonusRemaining)}</span>
                    <span>总计 {formatNumber(item.totalUsage)}</span>
                  </div>
                  <div className="key-meta">
                    <span>最近使用: {formatTime(item.lastUsedAt)}</span>
                    <span>创建: {formatTime(item.createdAt)}</span>
                    {item.regeneratedAt && <span>重置: {formatTime(item.regeneratedAt)}</span>}
                  </div>
                </div>
                <div className="key-actions">
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={async () => {
                      const success = await copyText(item.id);
                      setNotice(success ? '已复制完整 Key' : '复制失败');
                    }}
                  >
                    复制
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleRename(item.id)}>改名</button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleLimitUpdate(item.id)}>改限额</button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleResetUsage(item.id)}>重置今日</button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleToggle(item.id)}>
                    {item.enabled ? '禁用' : '启用'}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleRegenerate(item.id)}>重置 Key</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(item.id)}>删除</button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
