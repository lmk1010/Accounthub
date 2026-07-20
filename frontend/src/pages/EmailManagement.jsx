/**
 * 邮箱管理页面
 */

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../services/api';
import './EmailManagement.css';

/**
 * 简易 HTML 消毒：移除 script 标签和事件处理属性，防止 XSS
 */
function sanitizeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript\s*:/gi, 'void:');
}

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}`;
};

// 将文本中的URL转换为可点击链接
const linkifyText = (text) => {
  if (!text) return '';
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0;
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="mail-link">
          {part}
        </a>
      );
    }
    return part;
  });
};

export default function EmailManagement() {
  const [emails, setEmails] = useState([]);
  const [stats, setStats] = useState({ total: 0, active: 0, disabled: 0, error: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [linkedFilter, setLinkedFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [importContent, setImportContent] = useState('');
  const [importType, setImportType] = useState('auto');
  const [importing, setImporting] = useState(false);
  const [showMailModal, setShowMailModal] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMail, setLoadingMail] = useState(false);
  const [codeResult, setCodeResult] = useState(null);
  const [expandedMailIdx, setExpandedMailIdx] = useState(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authInfo, setAuthInfo] = useState(null);
  const [authPolling, setAuthPolling] = useState(false);
  // 分页状态
  const [page, setPage] = useState(1);
  const [pageSize] = useState(12);
  const [total, setTotal] = useState(0);
  // 关联弹窗状态
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkEmail, setLinkEmail] = useState(null);
  const [linkProviderType, setLinkProviderType] = useState('');
  const [linkRole, setLinkRole] = useState('');
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailEmail, setDetailEmail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // 批次筛选
  const [batchIds, setBatchIds] = useState([]);
  const [batchFilter, setBatchFilter] = useState('');
  // 角色筛选
  const [roleFilter, setRoleFilter] = useState('');

  // 刷新数据（不显示loading）
  const refreshData = useCallback(async () => {
    try {
      const params = { limit: pageSize, offset: (page - 1) * pageSize };
      if (filter) params.status = filter;
      if (linkedFilter) params.linked = linkedFilter;
      if (search) params.search = search;
      if (batchFilter) params.batchId = batchFilter;
      if (roleFilter) params.linkRole = roleFilter;
      const [emailData, statsData] = await Promise.all([
        apiClient.get('/emails', { params }),
        apiClient.get('/emails/stats')
      ]);
      setEmails(emailData.emails || []);
      setTotal(emailData.total || 0);
      setStats(statsData);
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }, [filter, linkedFilter, search, batchFilter, roleFilter, page, pageSize]);

  // 加载邮箱列表
  const loadEmails = useCallback(async () => {
    try {
      setLoading(true);
      const params = { limit: pageSize, offset: (page - 1) * pageSize };
      if (filter) params.status = filter;
      if (linkedFilter) params.linked = linkedFilter;
      if (search) params.search = search;
      if (batchFilter) params.batchId = batchFilter;
      if (roleFilter) params.linkRole = roleFilter;

      const data = await apiClient.get('/emails', { params });
      setEmails(data.emails || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || '网络错误');
    } finally {
      setLoading(false);
    }
  }, [filter, linkedFilter, search, batchFilter, roleFilter, page, pageSize]);

  // 加载统计
  const loadStats = useCallback(async () => {
    try {
      const data = await apiClient.get('/emails/stats');
      setStats(data);
    } catch (err) {
      console.error('Load stats error:', err);
    }
  }, []);

  // 加载批次列表
  const loadBatchIds = useCallback(async () => {
    try {
      const data = await apiClient.get('/emails/batch-ids');
      setBatchIds(data.batches || []);
    } catch (err) {
      console.error('Load batch ids error:', err);
    }
  }, []);

  useEffect(() => {
    loadEmails();
    loadStats();
    loadBatchIds();
  }, [loadEmails, loadStats, loadBatchIds]);

  // 筛选或搜索变化时重置页码
  useEffect(() => {
    setPage(1);
  }, [filter, linkedFilter, search, batchFilter, roleFilter]);

  const copyToClipboard = useCallback(async (value) => {
    if (value === null || value === undefined) return;
    const text = String(value);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, []);

  // 启用邮箱
  const handleEnable = async (id) => {
    try {
      await apiClient.post(`/emails/${id}/enable`);
      await loadEmails();
      await loadStats();
    } catch (err) {
      console.error('Enable error:', err);
    }
  };

  // 禁用邮箱
  const handleDisable = async (id) => {
    try {
      await apiClient.post(`/emails/${id}/disable`);
      await loadEmails();
      await loadStats();
    } catch (err) {
      console.error('Disable error:', err);
    }
  };

  // 删除邮箱
  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除此邮箱吗？')) return;
    try {
      await apiClient.delete(`/emails/${id}`);
      await loadEmails();
      await loadStats();
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  // 打开关联弹窗
  const handleOpenLinkModal = (email) => {
    setLinkEmail(email);
    setLinkProviderType(email.linkedProviderType || '');
    setLinkRole(email.linkRole || '');
    setShowLinkModal(true);
  };

  // 关联/解除关联邮箱到提供商
  const handleLinkProvider = async () => {
    if (!linkEmail) return;
    try {
      if (!linkProviderType) {
        await apiClient.delete(`/emails/${linkEmail.id}/link`);
      } else {
        await apiClient.post(`/emails/${linkEmail.id}/link`, {
          providerType: linkProviderType,
          linkRole: linkRole || null
        });
      }
      setShowLinkModal(false);
      setLinkEmail(null);
      setLinkProviderType('');
      setLinkRole('');
      await refreshData();
    } catch (err) {
      alert('操作失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 批量导入
  const handleImport = async () => {
    if (!importContent.trim()) return;
    try {
      setImporting(true);
      const data = await apiClient.post('/emails/batch', { content: importContent, importType });
      alert(`导入完成: 成功 ${data.success} 个, 失败 ${data.failed} 个\n批次号: ${data.batchId}`);
      setShowImportModal(false);
      setImportContent('');
      setImportType('auto');
      await refreshData();
      loadBatchIds();
    } catch (err) {
      alert('导入失败: ' + (err.response?.data?.error?.message || err.message));
      await refreshData();
    } finally {
      setImporting(false);
    }
  };

  // 打开邮件模态框
  const handleOpenMail = (email) => {
    setSelectedEmail(email);
    setMessages([]);
    setCodeResult(null);
    setShowMailModal(true);
  };

  const handleOpenDetail = async (email) => {
    setShowDetailModal(true);
    setDetailEmail(email);
    setLoadingDetail(true);
    try {
      const data = await apiClient.get(`/emails/${email.id}`);
      setDetailEmail(data || email);
    } catch (err) {
      alert('获取详情失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleCloseDetailModal = () => {
    setShowDetailModal(false);
    setDetailEmail(null);
    setLoadingDetail(false);
  };

  // 按批次删除
  const handleBatchDelete = async () => {
    if (!batchFilter) return;
    if (!window.confirm(`确定要删除批次 ${batchFilter} 的所有邮箱吗？`)) return;
    try {
      const data = await apiClient.delete(`/emails/batch/${encodeURIComponent(batchFilter)}`);
      alert(`已删除 ${data.deleted} 个邮箱`);
      setBatchFilter('');
      await refreshData();
      loadBatchIds();
    } catch (err) {
      alert('批量删除失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 按批次批量设角色
  const handleBatchSetRole = async (role) => {
    if (!batchFilter) return;
    const label = role || '清除';
    if (!window.confirm(`确定要将批次 ${batchFilter} 的所有邮箱设为「${label}」吗？`)) return;
    try {
      const data = await apiClient.post('/emails/batch-set-role', { batchId: batchFilter, linkRole: role || null });
      alert(`已更新 ${data.affected} 个邮箱`);
      await refreshData();
    } catch (err) {
      alert('批量设角色失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 获取邮件列表
  const handleFetchMessages = async () => {
    if (!selectedEmail) return;
    try {
      setLoadingMail(true);
      const data = await apiClient.get(`/emails/${selectedEmail.id}/messages`);
      setMessages(data.messages || []);
    } catch (err) {
      alert('获取邮件失败: ' + (err.response?.data?.error?.message || err.message));
      await refreshData();
    } finally {
      setLoadingMail(false);
    }
  };

  // 获取验证码
  const handleFetchCode = async () => {
    if (!selectedEmail) return;
    try {
      setLoadingMail(true);
      const data = await apiClient.get(`/emails/${selectedEmail.id}/code`);
      setCodeResult(data);
    } catch (err) {
      alert('获取验证码失败: ' + (err.response?.data?.error?.message || err.message));
      await refreshData();
    } finally {
      setLoadingMail(false);
    }
  };

  // 开始授权
  const handleStartAuth = async (email) => {
    try {
      setSelectedEmail(email);
      const data = await apiClient.post(`/emails/${email.id}/auth/start`);
      setAuthInfo(data);
      setShowAuthModal(true);
      startPolling(email.id);
    } catch (err) {
      alert('启动授权失败: ' + (err.response?.data?.error?.message || err.message));
      await refreshData();
    }
  };

  // 轮询授权状态
  const startPolling = (emailId) => {
    setAuthPolling(true);
    const poll = async () => {
      try {
        const data = await apiClient.get(`/emails/${emailId}/auth/poll`);
        if (data.status === 'success') {
          setAuthPolling(false);
          setShowAuthModal(false);
          alert('授权成功！');
          refreshData();
        } else if (data.status === 'pending') {
          setTimeout(poll, 3000);
        } else {
          setAuthPolling(false);
          if (data.status !== 'not_found') {
            alert(data.message || '授权失败');
          }
          refreshData();
        }
      } catch {
        setAuthPolling(false);
        refreshData();
      }
    };
    setTimeout(poll, 3000);
  };

  const detailItems = detailEmail ? [
    { label: '邮箱', value: detailEmail.email, copyable: true },
    { label: '密码', value: detailEmail.password || '--', copyable: Boolean(detailEmail.password) },
    { label: '认证方式', value: detailEmail.authType || detailEmail.auth_type || '--' },
    { label: 'Client ID', value: detailEmail.clientId || detailEmail.client_id || '--', copyable: Boolean(detailEmail.clientId || detailEmail.client_id) },
    { label: 'Refresh Token', value: detailEmail.refreshToken || detailEmail.refresh_token || '--', copyable: Boolean(detailEmail.refreshToken || detailEmail.refresh_token) },
    { label: 'Access Token', value: detailEmail.accessToken || detailEmail.access_token || '--', copyable: Boolean(detailEmail.accessToken || detailEmail.access_token) },
    { label: 'Token 过期时间', value: formatDateTime(detailEmail.tokenExpiresAt || detailEmail.token_expires_at) },
    { label: '状态', value: detailEmail.status || '--' },
    { label: '最后错误', value: detailEmail.lastError || detailEmail.last_error || '--' },
    { label: '最后使用', value: formatDateTime(detailEmail.lastUsedAt || detailEmail.last_used_at) },
    { label: '使用次数', value: detailEmail.usageCount ?? detailEmail.usage_count ?? 0 },
    { label: '关联渠道', value: detailEmail.linkedProviderType || detailEmail.linked_provider_type || '--' },
    { label: '关联角色', value: detailEmail.linkRole || detailEmail.link_role || '--' },
    { label: '批次号', value: detailEmail.batchId || detailEmail.batch_id || '--' },
    { label: '创建时间', value: formatDateTime(detailEmail.createdAt || detailEmail.created_at) },
    { label: '更新时间', value: formatDateTime(detailEmail.updatedAt || detailEmail.updated_at) }
  ] : [];

  if (error) {
    return (
      <div className="email-management-page">
        <div className="page-error">加载失败: {error}</div>
      </div>
    );
  }

  return (
    <div className="email-management-page">
      {/* 头部 */}
      <div className="email-header">
        <div className="email-header-left">
          <i className="fas fa-envelope" style={{ fontSize: '1.25rem', color: 'var(--primary-color)' }} />
          <h1>邮箱管理</h1>
        </div>
        <div className="email-header-right">
          <button className="btn btn-primary" onClick={() => setShowImportModal(true)}>
            <i className="fas fa-file-import" /> 批量导入
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="email-stats">
        <div className="stat-card">
          <div className="stat-card-header">
            <i className="fas fa-inbox" />
            <span>总数</span>
          </div>
          <div className="stat-card-value">{stats.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">
            <i className="fas fa-check-circle" />
            <span>正常</span>
          </div>
          <div className="stat-card-value text-success">{stats.active}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">
            <i className="fas fa-pause-circle" />
            <span>禁用</span>
          </div>
          <div className="stat-card-value text-warning">{stats.disabled}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">
            <i className="fas fa-exclamation-circle" />
            <span>异常</span>
          </div>
          <div className="stat-card-value text-danger">{stats.error}</div>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="email-toolbar">
        <div className="toolbar-left">
          <select value={filter} onChange={e => setFilter(e.target.value)} className="filter-select">
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">禁用</option>
            <option value="error">异常</option>
          </select>
          <select value={linkedFilter} onChange={e => setLinkedFilter(e.target.value)} className="filter-select">
            <option value="">全部关联</option>
            <option value="linked">已关联</option>
            <option value="unlinked">未关联</option>
            <option value="gemini-antigravity">Gemini Antigravity</option>
            <option value="claude-kiro-oauth">Claude Kiro</option>
            <option value="openai-codex">OpenAI Codex</option>
            <option value="openai-droid">Droid</option>
          </select>
          <select value={batchFilter} onChange={e => setBatchFilter(e.target.value)} className="filter-select">
            <option value="">全部批次</option>
            {batchIds.map(b => (
              <option key={b.batchId} value={b.batchId}>{b.batchId} ({b.count})</option>
            ))}
          </select>
          <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="filter-select">
            <option value="">全部角色</option>
            <option value="母号">母号</option>
            <option value="子号">子号</option>
          </select>
        </div>
        <div className="toolbar-right">
          {batchFilter && (
            <div className="batch-actions">
              <button className="btn btn-outline btn-batch-role" onClick={() => handleBatchSetRole('母号')}>
                <i className="fas fa-crown" /> 设为母号
              </button>
              <button className="btn btn-outline btn-batch-role" onClick={() => handleBatchSetRole('子号')}>
                <i className="fas fa-user" /> 设为子号
              </button>
              <button className="btn btn-outline btn-batch-role" onClick={() => handleBatchSetRole('')}>
                <i className="fas fa-eraser" /> 清除角色
              </button>
              <button className="btn btn-outline btn-batch-delete" onClick={handleBatchDelete}>
                <i className="fas fa-trash-alt" /> 删除批次
              </button>
            </div>
          )}
          <input
            type="text"
            className="search-input"
            placeholder="搜索邮箱..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="btn btn-outline" onClick={() => { loadEmails(); loadStats(); }}>
            <i className="fas fa-sync-alt" /> 刷新
          </button>
        </div>
      </div>

      {/* 邮箱列表 */}
      {loading ? (
        <div className="page-loading">加载中...</div>
      ) : (
        <div className="emails-grid">
          {emails.length === 0 ? (
            <div className="empty-state">暂无邮箱数据</div>
          ) : (
            emails.map(email => (
              <div key={email.id} className="email-card">
                <div className="email-card-top">
                  <div className="email-address-wrap">
                    <span className="email-address" title={email.email}>{email.email}</span>
                    <button
                      className="btn-copy"
                      title="复制邮箱"
                      onClick={() => copyToClipboard(email.email)}
                    >
                      <i className="fas fa-copy" />
                    </button>
                    <button
                      className="btn-copy"
                      title={email.password ? '复制密码' : '无可复制密码'}
                      onClick={() => copyToClipboard(email.password)}
                      disabled={!email.password}
                    >
                      <i className="fas fa-key" />
                    </button>
                  </div>
                  <span className={`status-badge ${email.status}`}>
                    <i className={`fas ${email.status === 'active' ? 'fa-check-circle' : email.status === 'disabled' ? 'fa-ban' : 'fa-exclamation-triangle'}`} />
                    {email.status === 'active' ? '正常' : email.status === 'disabled' ? '禁用' : '异常'}
                  </span>
                </div>
                <div className="email-meta">
                  <span className="meta-item">
                    <span className="meta-label">认证方式</span>
                    <span className={`meta-value ${email.authType === 'oauth2' ? 'text-success' : 'text-warning'}`}>
                      {email.authType === 'oauth2' ? 'OAuth2' : '待授权'}
                    </span>
                  </span>
                  <span className="meta-item">
                    <span className="meta-label">使用次数</span>
                    <span className="meta-value">{email.usageCount ?? 0}</span>
                  </span>
                  <span className="meta-item full">
                    <span className="meta-label">最后使用</span>
                    <span className="meta-value">{formatDateTime(email.lastUsedAt)}</span>
                  </span>
                  {email.status === 'error' && email.lastError && (
                    <span className="meta-item full error-info">
                      <span className="meta-label">错误</span>
                      <span className="meta-value text-danger" title={email.lastError}>
                        {email.lastError.length > 30 ? email.lastError.slice(0, 30) + '...' : email.lastError}
                      </span>
                    </span>
                  )}
                  <span className="meta-item full">
                    <span className="meta-label">关联渠道</span>
                    <span className={`meta-value ${email.linkedProviderType ? 'text-primary' : 'text-muted'}`}>
                      {email.linkedProviderType || '未关联'}
                      {email.linkRole && <span className={`role-tag ${email.linkRole === '母号' ? 'role-master' : 'role-sub'}`}>{email.linkRole}</span>}
                    </span>
                  </span>
                  {email.batchId && (
                    <span className="meta-item full">
                      <span className="meta-label">批次</span>
                      <span className="meta-value"><span className="batch-tag">{email.batchId}</span></span>
                    </span>
                  )}
                </div>
                <div className="email-actions">
                  {email.authType === 'oauth2' ? (
                    <button className="btn btn-action" onClick={() => handleOpenMail(email)}>
                      <i className="fas fa-inbox" /> 收信
                    </button>
                  ) : (
                    <button className="btn btn-action btn-auth" onClick={() => handleStartAuth(email)}>
                      <i className="fas fa-key" /> 授权
                    </button>
                  )}
                  {email.status === 'disabled' ? (
                    <button className="btn btn-action btn-enable" onClick={() => handleEnable(email.id)}>
                      <i className="fas fa-play" /> 启用
                    </button>
                  ) : (
                    <button className="btn btn-action btn-disable" onClick={() => handleDisable(email.id)}>
                      <i className="fas fa-pause" /> 禁用
                    </button>
                  )}
                  <button className="btn btn-action btn-link" onClick={() => handleOpenLinkModal(email)}>
                    <i className="fas fa-link" /> 关联
                  </button>
                  <button className="btn btn-action btn-detail" onClick={() => handleOpenDetail(email)}>
                    <i className="fas fa-circle-info" /> 详情
                  </button>
                  <button className="btn btn-action btn-delete" onClick={() => handleDelete(email.id)}>
                    <i className="fas fa-trash" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 分页 */}
      {total > pageSize && (
        <div className="pagination">
          <button
            className="btn btn-outline"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            <i className="fas fa-chevron-left" /> 上一页
          </button>
          <span className="page-info">
            第 {page} 页 / 共 {Math.ceil(total / pageSize)} 页 (共 {total} 条)
          </span>
          <button
            className="btn btn-outline"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => setPage(p => p + 1)}
          >
            下一页 <i className="fas fa-chevron-right" />
          </button>
        </div>
      )}

      {/* 导入模态框 */}
      {showImportModal && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>批量导入邮箱</h2>
              <button className="modal-close" onClick={() => setShowImportModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="import-type-select">
                <label>导入格式：</label>
                <select value={importType} onChange={e => setImportType(e.target.value)}>
                  <option value="auto">自动识别</option>
                  <option value="graph">Graph令牌 (邮箱----密码----client_id----refresh_token)</option>
                  <option value="oauth2">OAuth2 (邮箱||密码||client_id||refresh_token)</option>
                  <option value="password">密码 (邮箱——密码)</option>
                </select>
              </div>
              <textarea
                value={importContent}
                onChange={e => setImportContent(e.target.value)}
                placeholder={importType === 'password'
                  ? '每行一个，格式：邮箱——密码'
                  : importType === 'oauth2'
                  ? '每行一个，格式：邮箱 || 密码 || client_id || refresh_token'
                  : importType === 'graph'
                  ? '每行一个，格式：邮箱----密码----client_id----refresh_token'
                  : '支持三种格式：\nGraph令牌: 邮箱----密码----client_id----refresh_token\nOAuth2: 邮箱 || 密码 || client_id || refresh_token\n密码: 邮箱——密码'}
              />
              <p className="modal-hint">
                {importType === 'password' && '密码格式：邮箱——密码 或 邮箱----密码'}
                {importType === 'oauth2' && 'OAuth2格式：邮箱 || 密码 || client_id || refresh_token'}
                {importType === 'graph' && 'Graph令牌格式：邮箱----密码----client_id----refresh_token'}
                {importType === 'auto' && '自动识别：支持 ---- 分隔的Graph令牌、|| 分隔的OAuth2、—— 分隔的密码格式'}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowImportModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? '导入中...' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 邮箱详情模态框 */}
      {showDetailModal && (
        <div className="modal-overlay" onClick={handleCloseDetailModal}>
          <div className="modal-content modal-large" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>邮箱详情</h2>
              <button className="modal-close" onClick={handleCloseDetailModal}>&times;</button>
            </div>
            <div className="modal-body detail-modal-body">
              {loadingDetail ? (
                <div className="page-loading">加载详情中...</div>
              ) : (
                <div className="detail-list">
                  {detailItems.map(item => (
                    <div key={item.label} className="detail-item">
                      <span className="detail-label">{item.label}</span>
                      <div className="detail-value-wrap">
                        <span className="detail-value" title={String(item.value)}>{item.value}</span>
                        {item.copyable && (
                          <button
                            className="btn-copy-small detail-copy"
                            title={`复制${item.label}`}
                            onClick={() => copyToClipboard(item.value)}
                          >
                            <i className="fas fa-copy" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 邮件模态框 */}
      {showMailModal && selectedEmail && (
        <div className="modal-overlay" onClick={() => setShowMailModal(false)}>
          <div className="modal-content modal-large" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedEmail.email}</h2>
              <button className="modal-close" onClick={() => setShowMailModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="mail-actions">
                <button className="btn btn-primary" onClick={handleFetchCode} disabled={loadingMail}>
                  <i className="fas fa-key" /> 获取验证码
                </button>
                <button className="btn btn-outline" onClick={handleFetchMessages} disabled={loadingMail}>
                  <i className="fas fa-envelope" /> 获取邮件
                </button>
              </div>

              {codeResult && (
                <div className="code-result">
                  {codeResult.found ? (
                    <>
                      <div className="code-value">{codeResult.code}</div>
                      <div className="code-info">来自: {codeResult.from}</div>
                      <div className="code-info">主题: {codeResult.subject}</div>
                    </>
                  ) : (
                    <div className="code-info">未找到验证码</div>
                  )}
                </div>
              )}

              {messages.length > 0 && (
                <div className="mail-list">
                  {messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`mail-item ${expandedMailIdx === idx ? 'expanded' : ''}`}
                      onClick={() => setExpandedMailIdx(expandedMailIdx === idx ? null : idx)}
                    >
                      <div className="mail-item-header">
                        <div className="mail-subject">
                          <i className={`fas ${expandedMailIdx === idx ? 'fa-chevron-down' : 'fa-chevron-right'}`} />
                          {msg.subject}
                        </div>
                        <div className="mail-time">{formatDateTime(msg.receivedDateTime)}</div>
                      </div>
                      <div className="mail-from">{msg.from?.emailAddress?.address || msg.from?.address}</div>
                      {expandedMailIdx === idx ? (
                        <div className="mail-body" onClick={e => e.stopPropagation()}>
                          {msg.bodyContentType === 'html' ? (
                            <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.body) }} />
                          ) : (
                            <div className="mail-body-text">{linkifyText(msg.body || msg.bodyPreview)}</div>
                          )}
                        </div>
                      ) : (
                        <div className="mail-preview">{msg.bodyPreview}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 授权模态框 */}
      {showAuthModal && authInfo && (
        <div className="modal-overlay">
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>授权邮箱</h2>
              <button className="modal-close" onClick={() => { setShowAuthModal(false); setAuthPolling(false); }}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="auth-steps">
                <div className="auth-step">
                  <span className="step-num">1</span>
                  <span>打开浏览器访问：</span>
                  <a href={authInfo.verificationUri} target="_blank" rel="noopener noreferrer" className="auth-link">
                    {authInfo.verificationUri}
                  </a>
                </div>
                <div className="auth-step">
                  <span className="step-num">2</span>
                  <span>输入验证码：</span>
                  <span className="auth-code">{authInfo.userCode}</span>
                  <button className="btn-copy-small" onClick={() => navigator.clipboard.writeText(authInfo.userCode)}>
                    <i className="fas fa-copy" />
                  </button>
                </div>
                <div className="auth-step">
                  <span className="step-num">3</span>
                  <span>登录并授权</span>
                </div>
              </div>
              <div className="auth-status">
                {authPolling ? (
                  <><i className="fas fa-spinner fa-spin" /> 等待授权中...</>
                ) : (
                  <span>授权完成后自动关闭</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 关联渠道弹窗 */}
      {showLinkModal && linkEmail && (
        <div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
          <div className="modal-content modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>关联渠道</h2>
              <button className="modal-close" onClick={() => setShowLinkModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p className="link-email-info">邮箱: {linkEmail.email}</p>
              <div className="form-group">
                <label>选择渠道类型</label>
                <select
                  value={linkProviderType}
                  onChange={e => { setLinkProviderType(e.target.value); if (e.target.value !== 'openai-codex') setLinkRole(''); }}
                  className="form-select"
                >
                  <option value="">-- 不关联 --</option>
                  <option value="gemini-antigravity">Gemini Antigravity</option>
                  <option value="claude-kiro-oauth">Claude Kiro</option>
                  <option value="openai-codex">OpenAI Codex</option>
                  <option value="openai-droid">Droid</option>
                </select>
              </div>
              {linkProviderType === 'openai-codex' && (
                <div className="form-group">
                  <label>角色分组</label>
                  <select
                    value={linkRole}
                    onChange={e => setLinkRole(e.target.value)}
                    className="form-select"
                  >
                    <option value="">不指定</option>
                    <option value="母号">母号</option>
                    <option value="子号">子号</option>
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowLinkModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleLinkProvider}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
