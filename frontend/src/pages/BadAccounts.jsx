/**
 * 坏号记录页面
 */

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import * as badAccountsService from '../services/bad-accounts.service';
import './BadAccounts.css';

const PAGE_SIZE = 20;

export default function BadAccounts() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    // 从URL参数获取筛选条件
    const providerType = searchParams.get('providerType') || '';
    const poolId = searchParams.get('poolId') || '';
    const poolName = searchParams.get('poolName') || '默认池';

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    const [summary, setSummary] = useState(null);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [filterErrorType, setFilterErrorType] = useState('');
    const [filterSource, setFilterSource] = useState('');

    const fetchRecords = useCallback(async () => {
        try {
            setLoading(true);
            setError('');
            const result = await badAccountsService.getBadAccounts({
                providerType,
                poolId: poolId || undefined,
                errorType: filterErrorType || undefined,
                detectionSource: filterSource || undefined,
                page,
                pageSize: PAGE_SIZE
            });
            setRecords(result.data || []);
            setTotal(result.total || 0);
            setTotalPages(result.totalPages || 0);
        } catch (err) {
            setError(err.message || '加载失败');
        } finally {
            setLoading(false);
        }
    }, [providerType, poolId, filterErrorType, filterSource, page]);

    const fetchSummary = useCallback(async () => {
        try {
            const result = await badAccountsService.getBadAccountsSummary({
                providerType,
                poolId: poolId || undefined
            });
            setSummary(result.data);
        } catch (err) {
            console.error('Failed to fetch summary:', err);
        }
    }, [providerType, poolId]);

    useEffect(() => {
        fetchRecords();
        fetchSummary();
    }, [fetchRecords, fetchSummary]);

    const handleBack = () => {
        navigate('/providers');
    };

    const handleDelete = async (id) => {
        if (!window.confirm('确定要删除这条记录吗？')) return;
        try {
            await badAccountsService.deleteBadAccount(id);
            fetchRecords();
            fetchSummary();
        } catch (err) {
            setError(err.message || '删除失败');
        }
    };

    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;
        if (!window.confirm(`确定要删除选中的 ${selectedIds.size} 条记录吗？`)) return;
        try {
            await badAccountsService.batchDeleteBadAccounts([...selectedIds]);
            setSelectedIds(new Set());
            fetchRecords();
            fetchSummary();
        } catch (err) {
            setError(err.message || '批量删除失败');
        }
    };

    const handleClearAll = async () => {
        if (!window.confirm('确定要清空所有坏号记录吗？此操作不可恢复！')) return;
        try {
            await badAccountsService.clearBadAccounts(providerType, poolId || undefined);
            fetchRecords();
            fetchSummary();
        } catch (err) {
            setError(err.message || '清空失败');
        }
    };

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === records.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(records.map(r => r.id)));
        }
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '--';
        const date = new Date(dateStr);
        return date.toLocaleString('zh-CN');
    };

    const getErrorTypeClass = (errorType) => {
        switch (errorType) {
            case '403_forbidden': return 'error-type-forbidden';
            case '429_rate_limit': return 'error-type-ratelimit';
            case 'quota_exceeded': return 'error-type-quota';
            case 'auth_failed': return 'error-type-auth';
            default: return 'error-type-unknown';
        }
    };

    return (
        <div className="bad-accounts-page">
            <div className="bad-accounts-header">
                <div className="header-left">
                    <button className="btn btn-outline btn-sm" onClick={handleBack}>
                        <i className="fas fa-arrow-left"></i> 返回
                    </button>
                    <h1>坏号记录</h1>
                    <span className="header-subtitle">
                        {providerType} / {poolName}
                    </span>
                </div>
                <div className="header-right">
                    {selectedIds.size > 0 && (
                        <button className="btn btn-danger btn-sm" onClick={handleBatchDelete}>
                            <i className="fas fa-trash"></i> 删除选中 ({selectedIds.size})
                        </button>
                    )}
                    <button className="btn btn-warning btn-sm" onClick={handleClearAll} disabled={total === 0}>
                        <i className="fas fa-broom"></i> 清空全部
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => { fetchRecords(); fetchSummary(); }}>
                        <i className="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>

            {error && <div className="notice-banner notice-error">{error}</div>}

            {summary && (
                <div className="bad-accounts-summary">
                    <div className="summary-item">
                        <span className="summary-label">总计</span>
                        <span className="summary-value">{summary.total || 0}</span>
                    </div>
                    {Object.entries(summary.byErrorType || {}).map(([type, count]) => (
                        <div key={type} className={`summary-item ${getErrorTypeClass(type)}`}>
                            <span className="summary-label">
                                {badAccountsService.ERROR_TYPE_LABELS[type] || type}
                            </span>
                            <span className="summary-value">{count}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="bad-accounts-filters">
                <select value={filterErrorType} onChange={(e) => { setFilterErrorType(e.target.value); setPage(1); }}>
                    <option value="">全部错误类型</option>
                    {Object.entries(badAccountsService.ERROR_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                    ))}
                </select>
                <select value={filterSource} onChange={(e) => { setFilterSource(e.target.value); setPage(1); }}>
                    <option value="">全部来源</option>
                    {Object.entries(badAccountsService.DETECTION_SOURCE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                    ))}
                </select>
            </div>

            <div className="bad-accounts-table-container">
                {loading ? (
                    <div className="loading-state">加载中...</div>
                ) : records.length === 0 ? (
                    <div className="empty-state">
                        <i className="fas fa-check-circle"></i>
                        <p>暂无坏号记录</p>
                    </div>
                ) : (
                    <table className="bad-accounts-table">
                        <thead>
                            <tr>
                                <th className="col-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.size === records.length && records.length > 0}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th className="col-name">名称</th>
                                <th className="col-error">错误类型</th>
                                <th className="col-source">来源</th>
                                <th className="col-message">错误信息</th>
                                <th className="col-time">记录时间</th>
                                <th className="col-actions">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {records.map(record => (
                                <tr key={record.id}>
                                    <td className="col-checkbox">
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.has(record.id)}
                                            onChange={() => toggleSelect(record.id)}
                                        />
                                    </td>
                                    <td className="col-name">
                                        <span className="record-name">{record.displayName || record.providerUuid || '--'}</span>
                                    </td>
                                    <td className="col-error">
                                        <span className={`error-badge ${getErrorTypeClass(record.errorType)}`}>
                                            {badAccountsService.ERROR_TYPE_LABELS[record.errorType] || record.errorType}
                                        </span>
                                    </td>
                                    <td className="col-source">
                                        <span className="source-badge">
                                            {badAccountsService.DETECTION_SOURCE_LABELS[record.detectionSource] || record.detectionSource}
                                        </span>
                                    </td>
                                    <td className="col-message">
                                        <span className="error-message" title={record.errorMessage}>
                                            {record.errorMessage ? (record.errorMessage.length > 50 ? record.errorMessage.slice(0, 50) + '...' : record.errorMessage) : '--'}
                                        </span>
                                    </td>
                                    <td className="col-time">{formatDate(record.createdAt)}</td>
                                    <td className="col-actions">
                                        <button className="btn btn-danger btn-xs" onClick={() => handleDelete(record.id)}>
                                            <i className="fas fa-trash"></i>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {totalPages > 1 && (
                <div className="bad-accounts-pagination">
                    <button
                        className="btn btn-outline btn-sm"
                        disabled={page <= 1}
                        onClick={() => setPage(p => p - 1)}
                    >
                        上一页
                    </button>
                    <span className="pagination-info">
                        第 {page} / {totalPages} 页，共 {total} 条
                    </span>
                    <button
                        className="btn btn-outline btn-sm"
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => p + 1)}
                    >
                        下一页
                    </button>
                </div>
            )}
        </div>
    );
}
