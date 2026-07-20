/**
 * Logs page
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logsService } from '../services/logs.service';
import './Logs.css';

const PAGE_SIZE = 200;
const STREAM_LIMIT = 500;

// 高亮关键字组件
const HighlightText = ({ text, keyword }) => {
  if (!keyword || !text) return text;
  const parts = text.split(new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === keyword.toLowerCase() ? (
      <mark key={i} className="search-highlight">{part}</mark>
    ) : (
      part
    )
  );
};

const formatDate = (date) => {
  if (!date) return '--';
  try {
    return new Date(date).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (error) {
    return date;
  }
};

const formatTime = (timestamp) => {
  if (!timestamp) return '--';
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return timestamp;
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) {
    return timestamp;
  }
};

const formatSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
};

const normalizeStreamEntry = (entry) => {
  if (!entry) return null;
  return {
    timestamp: entry.timestamp || null,
    level: entry.level ? entry.level.toLowerCase() : 'info',
    message: entry.message || entry.raw || '',
  };
};

export default function Logs() {
  const [activeTab, setActiveTab] = useState('stream');
  const [days, setDays] = useState([]);
  const [daysLoading, setDaysLoading] = useState(true);
  const [daysError, setDaysError] = useState('');
  const [archiveStats, setArchiveStats] = useState({ totalSize: 0, compressedSize: 0, compressedFiles: 0 });
  const [filter, setFilter] = useState('');
  const [expandedDays, setExpandedDays] = useState(() => new Set());
  const [openFiles, setOpenFiles] = useState([]);
  const [activeFile, setActiveFile] = useState('');
  const [fileData, setFileData] = useState({});
  const [fileSearch, setFileSearch] = useState('');
  const [searchMode, setSearchMode] = useState('local'); // 'local' | 'global'
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [streamEntries, setStreamEntries] = useState([]);
  const [streamSearch, setStreamSearch] = useState('');
  const [streamMatchIndex, setStreamMatchIndex] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [debugToolUse, setDebugToolUse] = useState(false);
  const [levelFilter, setLevelFilter] = useState(new Set(['debug', 'info', 'warn', 'error'])); // 日志级别过滤
  const [archiveWorking, setArchiveWorking] = useState(false);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const eventSourceRef = useRef(null);

  const loadDays = async () => {
    try {
      setDaysLoading(true);
      setDaysError('');
      const data = await logsService.getDays();
      setDays(data.days || []);
      setArchiveStats({
        totalSize: data.totalSize || 0,
        compressedSize: data.compressedSize || 0,
        compressedFiles: data.compressedFiles || 0,
      });
    } catch (error) {
      console.error('Failed to load log days:', error);
      setDaysError('加载日志文件失败');
    } finally {
      setDaysLoading(false);
    }
  };

  const loadRecent = async () => {
    try {
      const entries = await logsService.getRecent(200);
      const normalized = entries.map(normalizeStreamEntry).filter(Boolean);
      setStreamEntries(normalized.slice(-STREAM_LIMIT));
    } catch (error) {
      console.error('Failed to load recent logs:', error);
    }
  };

  const connectStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const streamUrl = logsService.getStreamUrl();
    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setStreamConnected(true);
    };
    eventSource.onerror = () => {
      setStreamConnected(false);
    };
    eventSource.addEventListener('log', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const entry = normalizeStreamEntry(payload);
        if (!entry) return;
        setStreamEntries((prev) => {
          const next = [...prev, entry];
          if (next.length > STREAM_LIMIT) {
            return next.slice(next.length - STREAM_LIMIT);
          }
          return next;
        });
      } catch (error) {
        console.error('Failed to parse log event:', error);
      }
    });
  };

  const disconnectStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStreamConnected(false);
  };

  const toggleStream = () => {
    setStreamEnabled((prev) => !prev);
  };

  const toggleDay = (date) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  const openFile = (file) => {
    if (!file?.name || file.isCompressed) return;
    setOpenFiles((prev) => {
      if (prev.find((item) => item.name === file.name)) {
        return prev;
      }
      return [...prev, file];
    });
    setActiveFile(file.name);
  };

  const closeFile = (fileName) => {
    setOpenFiles((prev) => {
      const next = prev.filter((file) => file.name !== fileName);
      setActiveFile((current) => {
        if (current !== fileName) return current;
        return next.length ? next[0].name : '';
      });
      return next;
    });
    setFileData((prev) => {
      const next = { ...prev };
      delete next[fileName];
      return next;
    });
  };

  const loadFileEntries = async (fileName, page = 1, replace = false) => {
    if (!fileName) return;
    setFileData((prev) => ({
      ...prev,
      [fileName]: {
        ...(prev[fileName] || {}),
        loading: true,
        error: '',
      },
    }));

    try {
      const payload = await logsService.getEntries({
        file: fileName,
        page,
        pageSize: PAGE_SIZE,
        direction: 'desc',
      });
      setFileData((prev) => ({
        ...prev,
        [fileName]: {
          entries: (() => {
            const existing = replace ? [] : (prev[fileName]?.entries || []);
            const nextEntries = payload.entries || [];
            return replace ? nextEntries : [...nextEntries, ...existing];
          })(),
          page: payload.page || page,
          pageSize: payload.pageSize || PAGE_SIZE,
          totalLines: payload.totalLines || 0,
          hasMore: payload.hasMore || false,
          loading: false,
          error: '',
        },
      }));
    } catch (error) {
      console.error('Failed to load log file:', error);
      setFileData((prev) => ({
        ...prev,
        [fileName]: {
          ...(prev[fileName] || {}),
          loading: false,
          error: '加载日志内容失败',
        },
      }));
    }
  };

  const loadMore = () => {
    const current = activeFile ? fileData[activeFile] : null;
    if (!current || current.loading || !current.hasMore) return;
    const nextPage = (current.page || 1) + 1;
    loadFileEntries(activeFile, nextPage, false);
  };

  const reloadFile = () => {
    if (!activeFile) return;
    loadFileEntries(activeFile, 1, true);
  };

  const handleGzipFile = async (fileName) => {
    if (!fileName || archiveWorking) return;
    if (!window.confirm(`确定要压缩日志文件 ${fileName} 吗？`)) return;
    try {
      setArchiveWorking(true);
      await logsService.gzipLogFile(fileName);
      if (activeFile === fileName) {
        closeFile(fileName);
      }
      await loadDays();
    } catch (error) {
      console.error('Failed to gzip log file:', error);
      alert('压缩失败：' + (error.message || '未知错误'));
    } finally {
      setArchiveWorking(false);
    }
  };

  const handleGzipAll = async () => {
    if (archiveWorking) return;
    if (!window.confirm('将压缩除今天外的全部日志文件，是否继续？')) return;
    try {
      setArchiveWorking(true);
      await logsService.gzipAll(1);
      await loadDays();
    } catch (error) {
      console.error('Failed to gzip all log files:', error);
      alert('压缩失败：' + (error.message || '未知错误'));
    } finally {
      setArchiveWorking(false);
    }
  };

  const handleCleanup = async () => {
    if (archiveWorking) return;
    if (!window.confirm('将删除 7 天前的日志（含 .gz），是否继续？')) return;
    try {
      setArchiveWorking(true);
      await logsService.cleanupLogs(7);
      await loadDays();
    } catch (error) {
      console.error('Failed to cleanup log files:', error);
      alert('清理失败：' + (error.message || '未知错误'));
    } finally {
      setArchiveWorking(false);
    }
  };

  const clearStream = () => {
    setStreamEntries([]);
  };

  const doGlobalSearch = async (keyword) => {
    if (!activeFile || !keyword.trim()) {
      setSearchResults(null);
      return;
    }
    setSearchLoading(true);
    try {
      const data = await logsService.searchEntries({
        file: activeFile,
        keyword: keyword.trim(),
        limit: 500,
      });
      setSearchResults(data);
    } catch (error) {
      console.error('Failed to search logs:', error);
      setSearchResults({ entries: [], total: 0, error: '搜索失败' });
    } finally {
      setSearchLoading(false);
    }
  };

  const clearSearch = () => {
    setFileSearch('');
    setSearchResults(null);
    setSearchMode('local');
  };

  const loadDebugConfig = async () => {
    try {
      const data = await logsService.getDebugConfig();
      setDebugToolUse(data.debugToolUse || false);
    } catch (error) {
      console.error('Failed to load debug config:', error);
    }
  };

  const toggleDebugToolUse = async () => {
    try {
      const newValue = !debugToolUse;
      await logsService.setDebugConfig({ debugToolUse: newValue });
      setDebugToolUse(newValue);
    } catch (error) {
      console.error('Failed to toggle debug config:', error);
    }
  };

  useEffect(() => {
    loadDays();
    loadRecent();
    loadDebugConfig();
  }, []);

  useEffect(() => {
    if (streamEnabled) {
      connectStream();
    } else {
      disconnectStream();
    }

    return () => disconnectStream();
  }, [streamEnabled]);

  useEffect(() => {
    if (!streamRef.current || !autoScroll) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [streamEntries, autoScroll]);

  useEffect(() => {
    if (!days.length) return;
    const firstDay = days[0];
    if (firstDay?.date) {
      setExpandedDays((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set(prev);
        next.add(firstDay.date);
        return next;
      });
    }
    if (!openFiles.length && firstDay?.files?.length) {
      const firstOpen = firstDay.files.find((file) => !file.isCompressed);
      if (firstOpen) {
        openFile(firstOpen);
      }
    }
  }, [days, openFiles.length]);

  useEffect(() => {
    if (!activeFile) return;
    if (fileData[activeFile]?.entries) return;
    loadFileEntries(activeFile, 1, true);
  }, [activeFile]);

  useEffect(() => {
    if (!fileRef.current) return;
    fileRef.current.scrollTop = fileRef.current.scrollHeight;
  }, [activeFile]);

  const filteredDays = useMemo(() => {
    if (!filter.trim()) return days;
    const term = filter.toLowerCase();
    return days
      .map((day) => {
        const matchedFiles = day.files.filter((file) => file.name.toLowerCase().includes(term));
        if (day.date.includes(term) || matchedFiles.length > 0) {
          return { ...day, files: matchedFiles };
        }
        return null;
      })
      .filter(Boolean);
  }, [days, filter]);

  const activeData = activeFile ? fileData[activeFile] : null;
  const activeEntries = useMemo(() => {
    const entries = activeData?.entries || [];
    if (!fileSearch.trim()) return entries;
    const term = fileSearch.toLowerCase();
    return entries.filter((entry) =>
      (entry.message || entry.raw || '').toLowerCase().includes(term)
    );
  }, [activeData, fileSearch]);

  // 切换日志级别过滤
  const toggleLevelFilter = (level) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  // 过滤后的实时日志
  const filteredStreamEntries = useMemo(() => {
    return streamEntries.filter((entry) => levelFilter.has(entry.level));
  }, [streamEntries, levelFilter]);

  const streamMatchIndices = useMemo(() => {
    if (!streamSearch.trim()) return [];
    const term = streamSearch.toLowerCase();
    const indices = [];
    filteredStreamEntries.forEach((entry, index) => {
      if ((entry.message || '').toLowerCase().includes(term)) {
        indices.push(index);
      }
    });
    return indices;
  }, [filteredStreamEntries, streamSearch]);

  // 重置匹配索引当搜索词变化
  useEffect(() => {
    setStreamMatchIndex(0);
  }, [streamSearch]);

  // 跳转到匹配位置
  const jumpToStreamMatch = useCallback((matchIdx) => {
    if (streamMatchIndices.length === 0) return;
    const entryIndex = streamMatchIndices[matchIdx];
    if (entryIndex === undefined) return;
    const element = streamRef.current?.querySelector(`[data-index="${entryIndex}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [streamMatchIndices]);

  const goToPrevStreamMatch = useCallback(() => {
    if (streamMatchIndices.length === 0) return;
    const newIndex = streamMatchIndex > 0 ? streamMatchIndex - 1 : streamMatchIndices.length - 1;
    setStreamMatchIndex(newIndex);
    jumpToStreamMatch(newIndex);
  }, [streamMatchIndices, streamMatchIndex, jumpToStreamMatch]);

  const goToNextStreamMatch = useCallback(() => {
    if (streamMatchIndices.length === 0) return;
    const newIndex = streamMatchIndex < streamMatchIndices.length - 1 ? streamMatchIndex + 1 : 0;
    setStreamMatchIndex(newIndex);
    jumpToStreamMatch(newIndex);
  }, [streamMatchIndices, streamMatchIndex, jumpToStreamMatch]);

  // 搜索后自动跳转到第一个匹配
  useEffect(() => {
    if (streamMatchIndices.length > 0 && streamSearch.trim()) {
      jumpToStreamMatch(0);
    }
  }, [streamMatchIndices, streamSearch, jumpToStreamMatch]);

  const totalFiles = days.reduce((sum, day) => sum + day.files.length, 0);
  const openFileCount = openFiles.length;

  return (
    <div className="logs-page">
      <div className="logs-header">
        <div>
          <h1>实时日志</h1>
          <p className="logs-subtitle">按天归档 + 实时流，支持多文件切换</p>
        </div>
        <div className="logs-actions">
          <button
            className={`btn ${debugToolUse ? 'btn-primary' : 'btn-outline'}`}
            onClick={toggleDebugToolUse}
            title="开启后会记录 Claude Code 的 tool_use 请求详情"
          >
            <i className="fas fa-bug"></i>
            Tool调试: {debugToolUse ? '开' : '关'}
          </button>
          <button className="btn btn-outline" onClick={loadDays} disabled={daysLoading}>
            <i className="fas fa-sync-alt"></i>
            刷新列表
          </button>
          <button className="btn btn-outline" onClick={toggleStream}>
            <i className={`fas fa-plug ${streamEnabled ? 'connected' : ''}`}></i>
            {streamEnabled ? '断开实时' : '连接实时'}
          </button>
        </div>
      </div>

      {daysError && <div className="alert alert-error">{daysError}</div>}

      <div className="logs-tabs-bar">
        <button
          className={`logs-tab-btn ${activeTab === 'stream' ? 'active' : ''}`}
          onClick={() => setActiveTab('stream')}
        >
          实时流
        </button>
        <button
          className={`logs-tab-btn ${activeTab === 'archive' ? 'active' : ''}`}
          onClick={() => setActiveTab('archive')}
        >
          归档日志
        </button>
      </div>

      <div className={`logs-card ${activeTab === 'stream' ? 'active' : 'hidden'}`}>
        <div className="logs-card-header">
          <div>
            <h2>实时流</h2>
            <span className={`logs-status ${streamConnected ? 'ok' : 'down'}`}>
              <i className="fas fa-circle"></i>
              {streamConnected ? '已连接' : '未连接'}
            </span>
          </div>
          <div className="logs-card-actions">
            <button className="btn btn-outline" onClick={() => setAutoScroll((prev) => !prev)}>
              <i className="fas fa-arrow-down"></i>
              自动滚动: {autoScroll ? '开' : '关'}
            </button>
            <button className="btn btn-outline" onClick={clearStream}>
              <i className="fas fa-broom"></i>
              清空视图
            </button>
          </div>
        </div>
        <div className="logs-card-toolbar">
          <div className="logs-level-select">
            <select
              value={levelFilter.size === 4 ? 'all' : Array.from(levelFilter)[0] || 'all'}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'all') {
                  setLevelFilter(new Set(['debug', 'info', 'warn', 'error']));
                } else {
                  setLevelFilter(new Set([val]));
                }
              }}
            >
              <option value="all">全部级别</option>
              <option value="debug">DEBUG</option>
              <option value="info">INFO</option>
              <option value="warn">WARN</option>
              <option value="error">ERROR</option>
            </select>
          </div>
          <div className="logs-input">
            <i className="fas fa-search"></i>
            <input
              type="text"
              placeholder="搜索关键字定位"
              value={streamSearch}
              onChange={(event) => setStreamSearch(event.target.value)}
            />
          </div>
          {streamSearch.trim() && (
            <div className="search-nav">
              <button
                className="btn btn-sm"
                onClick={goToPrevStreamMatch}
                disabled={streamMatchIndices.length === 0}
                title="上一个匹配"
              >
                <i className="fas fa-chevron-up"></i>
              </button>
              <span className="search-count">
                {streamMatchIndices.length > 0
                  ? `${streamMatchIndex + 1} / ${streamMatchIndices.length}`
                  : '0 / 0'}
              </span>
              <button
                className="btn btn-sm"
                onClick={goToNextStreamMatch}
                disabled={streamMatchIndices.length === 0}
                title="下一个匹配"
              >
                <i className="fas fa-chevron-down"></i>
              </button>
            </div>
          )}
          <div className="logs-count">
            {levelFilter.size < 4 && <span className="filter-hint">已过滤 </span>}
            共 {filteredStreamEntries.length} 条
            {levelFilter.size < 4 && <span className="filter-total"> / {streamEntries.length}</span>}
          </div>
        </div>
        <div className="logs-view" ref={streamRef}>
          {filteredStreamEntries.length === 0 ? (
            <div className="logs-empty">
              <i className="fas fa-wave-square"></i>
              <p>{streamEntries.length > 0 ? '当前过滤条件下无日志' : '暂无实时日志'}</p>
            </div>
          ) : (
            filteredStreamEntries.map((entry, index) => {
              const isMatch = streamSearch.trim() && streamMatchIndices.includes(index);
              const isCurrentMatch = isMatch && streamMatchIndices[streamMatchIndex] === index;
              return (
                <div
                  key={`${entry.timestamp}-${index}`}
                  data-index={index}
                  className={`log-line ${isMatch ? 'search-match' : ''} ${isCurrentMatch ? 'current-match' : ''}`}
                >
                  <span className="log-meta">
                    <span className="log-time">{formatTime(entry.timestamp)}</span>
                    <span className={`log-level level-${entry.level}`}>{entry.level.toUpperCase()}</span>
                  </span>
                  <span className="log-message">
                    {streamSearch.trim() ? (
                      <HighlightText text={entry.message} keyword={streamSearch} />
                    ) : (
                      entry.message
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className={`logs-card ${activeTab === 'archive' ? 'active' : 'hidden'}`}>
        <div className="logs-card-header">
          <div>
            <h2>归档日志</h2>
            <span className="logs-subtitle-inline">按天查看文件日志</span>
          </div>
          <div className="logs-card-actions">
            <button className="btn btn-outline" onClick={handleGzipAll} disabled={archiveWorking || daysLoading}>
              <i className="fas fa-file-archive"></i>
              一键压缩
            </button>
            <button className="btn btn-outline btn-danger" onClick={handleCleanup} disabled={archiveWorking || daysLoading}>
              <i className="fas fa-broom"></i>
              清理7天前
            </button>
            <button className="btn btn-outline" onClick={reloadFile} disabled={!activeFile}>
              <i className="fas fa-sync-alt"></i>
              刷新文件
            </button>
            <button
              className="btn btn-outline"
              onClick={() => {
                if (activeFile) {
                  window.open(logsService.getDownloadUrl(activeFile), '_blank');
                }
              }}
              disabled={!activeFile}
            >
              <i className="fas fa-download"></i>
              下载文件
            </button>
            <button
              className="btn btn-outline btn-danger"
              onClick={async () => {
                if (activeFile && window.confirm(`确定要删除日志文件 ${activeFile} 吗？此操作不可恢复！`)) {
                  try {
                    await logsService.deleteLogFile(activeFile);
                    // 从打开的文件列表中移除
                    setOpenFiles(prev => prev.filter(f => f !== activeFile));
                    // 清除文件数据
                    setFileData(prev => {
                      const newData = { ...prev };
                      delete newData[activeFile];
                      return newData;
                    });
                    // 如果是当前激活的文件，切换到其他文件
                    if (activeFile === activeFile) {
                      const remaining = openFiles.filter(f => f !== activeFile);
                      setActiveFile(remaining[0] || '');
                    }
                    // 重新加载日志列表
                    await loadDays();
                  } catch (error) {
                    console.error('Failed to delete log file:', error);
                    alert('删除日志文件失败：' + (error.message || '未知错误'));
                  }
                }
              }}
              disabled={!activeFile}
            >
              <i className="fas fa-trash"></i>
              删除文件
            </button>
            <button className="btn btn-outline" onClick={loadMore} disabled={!activeData?.hasMore}>
              <i className="fas fa-arrow-up"></i>
              加载更早
            </button>
          </div>
        </div>
        <div className="logs-archive-layout">
          <aside className="logs-archive-sidebar">
            <div className="logs-sidebar-header">
              <div className="logs-summary">
                <span>天数: {days.length}</span>
                <span>文件: {totalFiles}</span>
                <span>已打开: {openFileCount}</span>
              </div>
              <div className="logs-archive-stats">
                <span>总大小: {formatSize(archiveStats.totalSize)}</span>
                <span>已压缩: {formatSize(archiveStats.compressedSize)} / {archiveStats.compressedFiles} 个</span>
              </div>
              <div className="logs-filter">
                <i className="fas fa-search"></i>
                <input
                  type="text"
                  placeholder="筛选日期或文件"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            </div>
            <div className="logs-days">
              {daysLoading ? (
                <div className="logs-loading">
                  <i className="fas fa-spinner fa-spin"></i>
                  正在加载日志文件...
                </div>
              ) : filteredDays.length === 0 ? (
                <div className="logs-empty">
                  <i className="fas fa-folder-open"></i>
                  <p>暂无日志文件</p>
                </div>
              ) : (
                filteredDays.map((day) => {
                  const isOpen = expandedDays.has(day.date);
                  return (
                    <div key={day.date} className="logs-day-group">
                      <button className="logs-day-toggle" onClick={() => toggleDay(day.date)}>
                        <span className="logs-day-label">{formatDate(day.date)}</span>
                        <span className="logs-day-meta">{day.files.length} 个文件</span>
                        <i className={`fas fa-chevron-${isOpen ? 'up' : 'down'}`}></i>
                      </button>
                      {isOpen && (
                        <div className="logs-day-files">
                          {day.files.map((file) => (
                            <div
                              key={file.name}
                              className={`logs-file-item ${activeFile === file.name ? 'active' : ''} ${file.isCompressed ? 'compressed' : ''}`}
                            >
                              <button
                                className="logs-file-info"
                                onClick={() => openFile(file)}
                                disabled={file.isCompressed}
                              >
                                <div className="logs-file-main">
                                  <span className="logs-file-name">{file.name}</span>
                                  <span className="logs-file-size">{formatSize(file.size)}</span>
                                </div>
                                <div className="logs-file-meta">
                                  <span>更新时间: {formatTime(file.updatedAt)}</span>
                                  {file.isCompressed && (
                                    <span className="logs-file-badge">已压缩</span>
                                  )}
                                  {openFiles.find((item) => item.name === file.name) && (
                                    <span className="logs-file-open">已打开</span>
                                  )}
                                </div>
                              </button>
                              {!file.isCompressed && (
                                <button
                                  className="logs-file-compress"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleGzipFile(file.name);
                                  }}
                                  title="压缩为 gzip"
                                  disabled={archiveWorking}
                                >
                                  <i className="fas fa-file-archive"></i>
                                </button>
                              )}
                              <button
                                className="logs-file-download"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(logsService.getDownloadUrl(file.name), '_blank');
                                }}
                                title="下载文件"
                              >
                                <i className="fas fa-download"></i>
                              </button>
                              <button
                                className="logs-file-delete"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`确定要删除日志文件 ${file.name} 吗？此操作不可恢复！`)) {
                                    try {
                                      await logsService.deleteLogFile(file.name);
                                      // 从打开的文件列表中移除
                                      setOpenFiles(prev => prev.filter(f => f !== file.name));
                                      // 清除文件数据
                                      setFileData(prev => {
                                        const newData = { ...prev };
                                        delete newData[file.name];
                                        return newData;
                                      });
                                      // 如果是当前激活的文件，切换到其他文件
                                      if (activeFile === file.name) {
                                        const remaining = openFiles.filter(f => f !== file.name);
                                        setActiveFile(remaining[0] || '');
                                      }
                                      // 重新加载日志列表
                                      await loadDays();
                                    } catch (error) {
                                      console.error('Failed to delete log file:', error);
                                      alert('删除日志文件失败：' + (error.message || '未知错误'));
                                    }
                                  }
                                }}
                                title="删除文件"
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          <section className="logs-archive-main">
            <div className="logs-tabs">
              {openFiles.length === 0 ? (
                <div className="logs-empty-inline">未选择日志文件</div>
              ) : (
                openFiles.map((file) => (
                  <button
                    key={file.name}
                    className={`logs-tab ${activeFile === file.name ? 'active' : ''}`}
                    onClick={() => setActiveFile(file.name)}
                  >
                    <span>{file.name}</span>
                    <i className="fas fa-times" onClick={(event) => {
                      event.stopPropagation();
                      closeFile(file.name);
                    }}></i>
                  </button>
                ))
              )}
            </div>
            <div className="logs-card-toolbar">
              <div className="logs-input">
                <i className="fas fa-search"></i>
                <input
                  type="text"
                  placeholder={searchMode === 'global' ? '全文搜索...' : '搜索已加载内容'}
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && searchMode === 'global') {
                      doGlobalSearch(fileSearch);
                    }
                  }}
                  disabled={!activeFile}
                />
                {fileSearch && (
                  <button className="logs-input-clear" onClick={clearSearch} title="清除搜索">
                    <i className="fas fa-times"></i>
                  </button>
                )}
              </div>
              <div className="logs-search-actions">
                <button
                  className={`btn btn-sm ${searchMode === 'local' ? 'active' : ''}`}
                  onClick={() => { setSearchMode('local'); setSearchResults(null); }}
                  title="搜索已加载的内容"
                >
                  本地
                </button>
                <button
                  className={`btn btn-sm ${searchMode === 'global' ? 'active' : ''}`}
                  onClick={() => setSearchMode('global')}
                  title="搜索整个文件"
                >
                  全文
                </button>
                {searchMode === 'global' && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => doGlobalSearch(fileSearch)}
                    disabled={!fileSearch.trim() || searchLoading}
                  >
                    {searchLoading ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-search"></i>}
                    搜索
                  </button>
                )}
              </div>
              <div className="logs-count">
                {searchResults
                  ? `搜索结果: ${searchResults.total}${searchResults.hasMore ? '+' : ''} 条`
                  : activeFile
                    ? `显示 ${activeEntries.length} / ${activeData?.entries?.length || 0}`
                    : '未选择文件'}
              </div>
            </div>
            <div className="logs-view" ref={fileRef}>
              {!activeFile ? (
                <div className="logs-empty">
                  <i className="fas fa-file-alt"></i>
                  <p>请选择左侧日志文件</p>
                </div>
              ) : searchLoading ? (
                <div className="logs-loading">
                  <i className="fas fa-spinner fa-spin"></i>
                  正在搜索...
                </div>
              ) : activeData?.loading ? (
                <div className="logs-loading">
                  <i className="fas fa-spinner fa-spin"></i>
                  正在加载日志内容...
                </div>
              ) : activeData?.error ? (
                <div className="logs-empty">
                  <i className="fas fa-exclamation-circle"></i>
                  <p>{activeData.error}</p>
                </div>
              ) : searchResults ? (
                searchResults.entries?.length === 0 ? (
                  <div className="logs-empty">
                    <i className="fas fa-search"></i>
                    <p>未找到匹配的日志</p>
                  </div>
                ) : (
                  searchResults.entries.map((entry, idx) => (
                    <div
                      key={`search-${entry.lineNumber}-${idx}`}
                      className={`log-line ${entry.isMatch ? 'search-match' : 'search-context'}`}
                    >
                      <span className="log-meta">
                        <span className="log-line-number">#{entry.lineNumber}</span>
                        <span className="log-time">{formatTime(entry.timestamp)}</span>
                        <span className={`log-level level-${entry.level}`}>{entry.level.toUpperCase()}</span>
                      </span>
                      <span className="log-message">
                        {entry.isMatch ? (
                          <HighlightText text={entry.message} keyword={fileSearch} />
                        ) : (
                          entry.message
                        )}
                      </span>
                    </div>
                  ))
                )
              ) : activeEntries.length === 0 ? (
                <div className="logs-empty">
                  <i className="fas fa-file-alt"></i>
                  <p>当前文件暂无日志</p>
                </div>
              ) : (
                activeEntries.map((entry) => (
                  <div key={`${activeFile}-${entry.lineNumber}`} className="log-line">
                    <span className="log-meta">
                      <span className="log-line-number">#{entry.lineNumber}</span>
                      <span className="log-time">{formatTime(entry.timestamp)}</span>
                      <span className={`log-level level-${entry.level}`}>{entry.level.toUpperCase()}</span>
                    </span>
                    <span className="log-message">
                      {fileSearch.trim() && searchMode === 'local' ? (
                        <HighlightText text={entry.message} keyword={fileSearch} />
                      ) : (
                        entry.message
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
