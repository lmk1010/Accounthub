/**
 * 池子请求日志页面
 */

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { requestLogsService } from '../services/request-logs.service';
import './PoolRequestLogs.css';

const PAGE_SIZE = 20;

export default function PoolRequestLogs() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

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
    const [filterStatus, setFilterStatus] = useState('all');
    const [detailLog, setDetailLog] = useState(null);
    const [errorDetailLog, setErrorDetailLog] = useState(null); // 错误详情弹窗
    const [errorDetailData, setErrorDetailData] = useState(null); // 错误详情数据（大字段）
    const [loadingErrorDetail, setLoadingErrorDetail] = useState(false);

    const fetchRecords = useCallback(async () => {
        try {
            setLoading(true);
            setError('');
            const options = { page, pageSize: PAGE_SIZE };
            if (filterStatus === 'success') options.isSuccess = true;
            if (filterStatus === 'fail') options.isSuccess = false;

            const result = await requestLogsService.getPoolRequestLogs(
                providerType,
                poolId || undefined,
                options
            );
            setRecords(result.data || []);
            setTotal(result.total || 0);
            setTotalPages(result.totalPages || 0);
            setSummary(result.summary || null);
        } catch (err) {
            setError(err.message || '加载失败');
        } finally {
            setLoading(false);
        }
    }, [providerType, poolId, filterStatus, page]);

    useEffect(() => {
        fetchRecords();
    }, [fetchRecords]);

    const handleBack = () => {
        if (providerType && poolId) {
            navigate(`/providers/${providerType}?pool=${poolId}&poolName=${encodeURIComponent(poolName)}`);
        } else {
            navigate('/providers');
        }
    };

    const handleOpenErrorLogs = (log) => {
        if (!log?.providerUuid) return;
        const params = new URLSearchParams();
        if (poolId) params.set('pool', poolId);
        if (poolName) params.set('poolName', poolName);
        params.set('account', log.providerUuid);
        params.set('tab', 'errors');
        navigate(`/providers/${providerType}?${params.toString()}`);
    };

    const handleClearAll = async () => {
        if (!window.confirm('确定要清空所有请求日志吗？此操作不可恢复！')) return;
        try {
            await requestLogsService.clearPoolRequestLogs(providerType, poolId || undefined);
            fetchRecords();
        } catch (err) {
            setError(err.message || '清空失败');
        }
    };

    const handleShowErrorDetail = async (log) => {
        setErrorDetailLog(log);
        setErrorDetailData(null);
        setLoadingErrorDetail(true);
        try {
            const result = await requestLogsService.getRequestLogErrorDetail(log.id);
            setErrorDetailData(result.data);
        } catch (err) {
            console.error('加载错误详情失败:', err);
            setErrorDetailData({ error: '加载失败: ' + err.message });
        } finally {
            setLoadingErrorDetail(false);
        }
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '--';
        const date = new Date(dateStr);
        return date.toLocaleString('zh-CN');
    };

    const formatProxyNodeLabel = (log) => {
        const name = log?.proxyNodeName ? String(log.proxyNodeName).trim() : '';
        const host = log?.proxyNodeHost ? String(log.proxyNodeHost).trim() : '';
        const port = log?.proxyNodePort ?? null;
        const protocol = log?.proxyNodeProtocol ? String(log.proxyNodeProtocol).trim().toUpperCase() : '';
        const endpoint = host ? `${host}${port ? `:${port}` : ''}` : '';

        if (name && endpoint) return `${name} (${protocol || 'PROXY'} ${endpoint})`;
        if (name) return name;
        if (endpoint) return `${protocol || 'PROXY'} ${endpoint}`;
        return 'direct';
    };

    const truncateText = (text, maxLen = 140) => {
        if (!text) return '';
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    };

    const formatErrorDetail = (detail) => {
        if (!detail) return '';
        if (typeof detail === 'object') {
            try {
                return JSON.stringify(detail, null, 2);
            } catch (err) {
                return String(detail);
            }
        }
        const text = String(detail);
        const trimmed = text.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                return JSON.stringify(JSON.parse(trimmed), null, 2);
            } catch (err) {
                return text;
            }
        }
        return text;
    };

    const handleCopyCurl = async (curlCommand) => {
        if (!curlCommand) {
            alert('无 curl 数据');
            return;
        }
        try {
            await navigator.clipboard.writeText(curlCommand);
            alert('curl 命令已复制到剪贴板');
        } catch (err) {
            console.error('复制失败:', err);
            // 降级方案：创建临时文本区域
            const textArea = document.createElement('textarea');
            textArea.value = curlCommand;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            alert('curl 命令已复制到剪贴板');
        }
    };

    const successRate = summary && summary.total > 0
        ? ((summary.successCount / summary.total) * 100).toFixed(1)
        : 0;

    return (
        <div className="pool-request-logs-page">
            <div className="pool-logs-header">
                <div className="header-left">
                    <button className="btn btn-outline btn-sm" onClick={handleBack}>
                        <i className="fas fa-arrow-left"></i> 返回
                    </button>
                    <h1>请求日志</h1>
                    <span className="header-subtitle">
                        {providerType} / {poolName}
                    </span>
                </div>
                <div className="header-right">
                    <button className="btn btn-warning btn-sm" onClick={handleClearAll} disabled={total === 0}>
                        <i className="fas fa-broom"></i> 清空全部
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={fetchRecords}>
                        <i className="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>

            {error && <div className="notice-banner notice-error">{error}</div>}

            {summary && (
                <div className="pool-logs-summary">
                    <div className="summary-item">
                        <span className="summary-label">总请求</span>
                        <span className="summary-value">{summary.total || 0}</span>
                    </div>
                    <div className="summary-item success">
                        <span className="summary-label">成功</span>
                        <span className="summary-value">{summary.successCount || 0}</span>
                    </div>
                    <div className="summary-item fail">
                        <span className="summary-label">失败</span>
                        <span className="summary-value">{summary.failCount || 0}</span>
                    </div>
                    <div className="summary-item">
                        <span className="summary-label">成功率</span>
                        <span className={`summary-value ${Number(successRate) >= 90 ? 'text-success' : Number(successRate) >= 70 ? 'text-warning' : 'text-danger'}`}>
                            {successRate}%
                        </span>
                    </div>
                    <div className="summary-item">
                        <span className="summary-label">平均耗时</span>
                        <span className="summary-value">{summary.avgDuration || 0}ms</span>
                    </div>
                </div>
            )}

            <div className="pool-logs-filters">
                <div className="filter-group">
                    <button
                        className={`filter-btn ${filterStatus === 'all' ? 'active' : ''}`}
                        onClick={() => { setFilterStatus('all'); setPage(1); }}
                    >
                        全部
                    </button>
                    <button
                        className={`filter-btn ${filterStatus === 'success' ? 'active' : ''}`}
                        onClick={() => { setFilterStatus('success'); setPage(1); }}
                    >
                        成功
                    </button>
                    <button
                        className={`filter-btn ${filterStatus === 'fail' ? 'active' : ''}`}
                        onClick={() => { setFilterStatus('fail'); setPage(1); }}
                    >
                        失败
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="loading-state">加载中...</div>
            ) : records.length === 0 ? (
                <div className="empty-state">暂无请求日志</div>
            ) : (
                <>
                    <div className="pool-logs-list">
                        {records.map((log) => {
                            const proxyLabel = formatProxyNodeLabel(log);
                            return (
                            <div
                                key={log.id}
                                className={`log-item ${log.isSuccess ? 'success' : 'fail'}`}
                                onClick={() => setDetailLog(log)}
                            >
                                <div className="log-item-header">
                                    <span className="log-time">{formatDate(log.createdAt)}</span>
                                    <span className={`log-status ${log.isSuccess ? 'success' : 'fail'}`}>
                                        {log.statusCode || (log.isSuccess ? '200' : 'ERR')}
                                    </span>
                                    {log.requestModel && <span className="log-model">{log.requestModel}</span>}
                                    {log.durationMs > 0 && <span className="log-duration">{log.durationMs}ms</span>}
                                {log.ttftMs > 0 && <span className="log-ttft" title="首字耗时">TTFT:{log.ttftMs}ms</span>}
                                    {log.clientTokenId && (
                                        <span className="log-token" title={log.clientTokenId}>
                                            {log.clientTokenId.length > 10 ? `${log.clientTokenId.slice(0, 10)}...` : log.clientTokenId}
                                        </span>
                                    )}
                                    <span className="log-uuid" title={log.providerUuid}>
                                        {log.providerUuid?.slice(0, 8)}...
                                    </span>
                                    <div className="log-actions" onClick={(e) => e.stopPropagation()}>
                                        {!log.isSuccess && (
                                            <button
                                                className="log-action-btn curl-btn"
                                                onClick={() => handleCopyCurl(log.curlCommand)}
                                                title={log.curlCommand ? "复制 curl 命令" : "无 curl 数据"}
                                            >
                                                <i className="fas fa-terminal"></i> curl
                                            </button>
                                        )}
                                        <button
                                            className="log-action-btn"
                                            onClick={() => handleOpenErrorLogs(log)}
                                        >
                                            <i className="fas fa-bug"></i> 错误日志
                                        </button>
                                        <button
                                            className="log-action-btn"
                                            onClick={() => setDetailLog(log)}
                                        >
                                            <i className="fas fa-eye"></i> 详情
                                        </button>
                                    </div>
                                </div>
                                {(log.inputTokens > 0 || log.outputTokens > 0) && (
                                    <div className="log-tokens">
                                        <span>输入: {log.inputTokens}</span>
                                        <span>输出: {log.outputTokens}</span>
                                    </div>
                                )}
                                <div className="log-meta">
                                    <span className={`log-proxy-badge ${proxyLabel === 'direct' ? 'direct' : 'proxy'}`}>代理: {proxyLabel}</span>
                                    {log.username && <span>用户: {log.username}</span>}
                                    {log.userEmail && <span>邮箱: {log.userEmail}</span>}
                                    {log.userId && <span>ID: {log.userId}</span>}
                                    {log.clientIp && <span>IP: {log.clientIp}</span>}
                                </div>
                                {!log.isSuccess && (
                                    <div className="log-error">
                                        {log.errorMessage && truncateText(log.errorMessage)}
                                        <button
                                            className="error-detail-btn"
                                            onClick={(e) => { e.stopPropagation(); handleShowErrorDetail(log); }}
                                        >
                                            查看完整错误
                                        </button>
                                    </div>
                                )}
                            </div>
                            );
                        })}
                    </div>

                    {totalPages > 1 && (
                        <div className="pool-logs-pagination">
                            <button
                                className="btn btn-sm"
                                disabled={page <= 1}
                                onClick={() => setPage(p => p - 1)}
                            >
                                上一页
                            </button>
                            <span className="page-info">{page} / {totalPages}</span>
                            <button
                                className="btn btn-sm"
                                disabled={page >= totalPages}
                                onClick={() => setPage(p => p + 1)}
                            >
                                下一页
                            </button>
                        </div>
                    )}
                    <div className="pool-logs-total">共 {total} 条记录</div>
                </>
            )}

            {detailLog && (
                <div className="log-detail-overlay" onClick={() => setDetailLog(null)}>
                    <div className="log-detail-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="log-detail-header">
                            <h3>请求详情</h3>
                            <button className="log-detail-close" onClick={() => setDetailLog(null)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div className="log-detail-body">
                            <div className="log-detail-grid">
                                <div className="log-detail-item">
                                    <span className="log-detail-label">状态</span>
                                    <span className="log-detail-value">
                                        {detailLog.statusCode || (detailLog.isSuccess ? '200' : 'ERR')}
                                    </span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">模型</span>
                                    <span className="log-detail-value">{detailLog.requestModel || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">总耗时</span>
                                    <span className="log-detail-value">{detailLog.durationMs || 0}ms</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">首字耗时</span>
                                    <span className="log-detail-value">{detailLog.ttftMs ? `${detailLog.ttftMs}ms` : '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">输入/输出</span>
                                    <span className="log-detail-value">{detailLog.inputTokens || 0} / {detailLog.outputTokens || 0}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">缓存(创建/读取)</span>
                                    <span className="log-detail-value">{detailLog.cacheCreationTokens || 0} / {detailLog.cacheReadTokens || 0}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">账号UUID</span>
                                    <span className="log-detail-value mono">{detailLog.providerUuid || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">Token ID</span>
                                    <span className="log-detail-value mono">{detailLog.clientTokenId || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">用户名</span>
                                    <span className="log-detail-value mono">{detailLog.username || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">用户邮箱</span>
                                    <span className="log-detail-value mono">{detailLog.userEmail || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">User ID</span>
                                    <span className="log-detail-value mono">{detailLog.userId || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">客户端IP</span>
                                    <span className="log-detail-value mono">{detailLog.clientIp || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">代理节点</span>
                                    <span className={`log-detail-value log-detail-proxy-badge ${formatProxyNodeLabel(detailLog) === 'direct' ? 'direct' : 'proxy'}`}>{formatProxyNodeLabel(detailLog)}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">User-Agent</span>
                                    <span className="log-detail-value mono">{detailLog.userAgent || '--'}</span>
                                </div>
                                <div className="log-detail-item">
                                    <span className="log-detail-label">时间</span>
                                    <span className="log-detail-value">{formatDate(detailLog.createdAt)}</span>
                                </div>
                            </div>
                            {!detailLog.isSuccess && (detailLog.errorMessage || detailLog.errorDetail || detailLog.errorStack) && (
                                <div className="log-detail-error">
                                    {detailLog.errorMessage && (
                                        <>
                                            <div className="log-detail-label">错误信息</div>
                                            <div className="log-detail-message">{detailLog.errorMessage}</div>
                                        </>
                                    )}
                                    {detailLog.errorDetail && (
                                        <div className="log-detail-section">
                                            <div className="log-detail-label">错误详情</div>
                                            <pre className="log-detail-pre">{formatErrorDetail(detailLog.errorDetail)}</pre>
                                        </div>
                                    )}
                                    {detailLog.errorStack && (
                                        <div className="log-detail-section">
                                            <div className="log-detail-label">错误堆栈</div>
                                            <pre className="log-detail-pre">{detailLog.errorStack}</pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="log-detail-actions">
                            {!detailLog.isSuccess && detailLog.curlCommand && (
                                <button className="btn btn-primary btn-sm" onClick={() => handleCopyCurl(detailLog.curlCommand)}>
                                    <i className="fas fa-terminal"></i> 复制 curl 命令
                                </button>
                            )}
                            <button className="btn btn-outline btn-sm" onClick={() => handleOpenErrorLogs(detailLog)}>
                                <i className="fas fa-bug"></i> 打开账号错误日志
                            </button>
                            <button className="btn btn-outline btn-sm" onClick={() => setDetailLog(null)}>
                                关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 错误详情弹窗 */}
            {errorDetailLog && (
                <div className="log-detail-overlay" onClick={() => { setErrorDetailLog(null); setErrorDetailData(null); }}>
                    <div className="log-detail-modal error-detail-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="log-detail-header">
                            <h3>错误完整信息</h3>
                            <button className="log-detail-close" onClick={() => { setErrorDetailLog(null); setErrorDetailData(null); }}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div className="log-detail-body">
                            {loadingErrorDetail ? (
                                <div className="loading-state">加载中...</div>
                            ) : errorDetailData?.error ? (
                                <div className="error-state">{errorDetailData.error}</div>
                            ) : (
                                <>
                                    <div className="error-detail-section">
                                        <div className="log-detail-label">错误信息</div>
                                        <div className="error-detail-message">{errorDetailLog.errorMessage || '无'}</div>
                                    </div>
                                    <div className="error-detail-section">
                                        <div className="log-detail-label">服务器返回内容</div>
                                        <pre className="error-detail-pre">{errorDetailData?.errorDetail ? formatErrorDetail(errorDetailData.errorDetail) : '暂无数据'}</pre>
                                    </div>
                                    <div className="error-detail-section">
                                        <div className="log-detail-label">错误堆栈</div>
                                        <pre className="error-detail-pre">{errorDetailData?.errorStack || '暂无数据'}</pre>
                                    </div>
                                    <div className="error-detail-section">
                                        <div className="log-detail-label">
                                            curl 命令
                                            {errorDetailData?.curlCommand && (
                                                <button className="copy-btn" onClick={() => handleCopyCurl(errorDetailData.curlCommand)}>
                                                    <i className="fas fa-copy"></i> 复制
                                                </button>
                                            )}
                                        </div>
                                        <pre className="error-detail-pre curl-pre">{errorDetailData?.curlCommand || '暂无数据'}</pre>
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="log-detail-actions">
                            <button className="btn btn-outline btn-sm" onClick={() => { setErrorDetailLog(null); setErrorDetailData(null); }}>
                                关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
