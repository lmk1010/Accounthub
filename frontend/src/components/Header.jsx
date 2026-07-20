/**
 * 头部组件
 * 包含实时服务健康状态检测
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../stores/auth.store';
import './Header.css';

// 健康检查间隔（毫秒）
const HEALTH_CHECK_INTERVAL = 15000;

/**
 * 服务状态等级:
 *  - 'healthy'     → 一切正常
 *  - 'degraded'    → 有部分异常（如数据库异常但服务还在）
 *  - 'error'       → 服务不可达
 *  - 'checking'    → 初始加载中
 */
function useServerHealth() {
  const [status, setStatus] = useState('checking');
  const [detail, setDetail] = useState('');
  const failCountRef = useRef(0);

  const checkHealth = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch('/api/system/health', {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        failCountRef.current++;
        if (failCountRef.current >= 2) {
          setStatus('error');
          setDetail(`HTTP ${response.status}`);
        }
        return;
      }

      const data = await response.json();
      failCountRef.current = 0;

      if (data.database === 'unhealthy') {
        setStatus('degraded');
        setDetail('数据库异常');
      } else if (data.status === 'ok') {
        setStatus('healthy');
        setDetail('');
      } else {
        setStatus('degraded');
        setDetail(data.status || '状态未知');
      }
    } catch (err) {
      failCountRef.current++;
      if (failCountRef.current >= 2) {
        setStatus('error');
        setDetail(err.name === 'AbortError' ? '请求超时' : '服务不可达');
      }
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => clearInterval(timer);
  }, [checkHealth]);

  return { status, detail, checkHealth };
}

const STATUS_CONFIG = {
  checking: { text: '检测中', icon: 'fas fa-spinner fa-pulse', className: 'checking' },
  healthy:  { text: '运行中', icon: 'fas fa-circle', className: '' },
  degraded: { text: '', icon: 'fas fa-exclamation-circle', className: 'warning' },
  error:    { text: '服务异常', icon: 'fas fa-times-circle', className: 'error' },
};

export default function Header({ onMenuToggle, sidebarOpen }) {
  const logout = useAuthStore((state) => state.logout);
  const { status, detail, checkHealth } = useServerHealth();

  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.checking;
  const displayText = cfg.text || detail || '异常';

  return (
    <header className="header">
      <div className="header-content">
        {/* 左侧标题区域 */}
        <div className="header-title-area">
          <h1 className="page-title">AccountHub 管理控制台</h1>
          <p className="page-subtitle">统一管理 AI 服务提供商</p>
        </div>

        <button
          className="mobile-menu-toggle"
          aria-label="Menu"
          title="菜单"
          onClick={onMenuToggle}
        >
          <i className={`fas ${sidebarOpen ? 'fa-times' : 'fa-bars'}`}></i>
        </button>

        {/* 右侧控件区域 */}
        <div className="header-controls" id="headerControls">
          <span
            className={`status-badge ${cfg.className}`}
            id="serverStatus"
            title={detail ? `${displayText}: ${detail}` : displayText}
            onClick={checkHealth}
            style={{ cursor: 'pointer' }}
          >
            <i className={cfg.icon}></i>{' '}
            <span className="status-text">{displayText}</span>
          </span>
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="header-icon-btn" title="API 文档">
            <i className="fas fa-book"></i>
          </a>
          <button id="themeToggleBtn" className="header-icon-btn theme-toggle" aria-label="Toggle Theme" title="切换主题">
            <i className="fas fa-moon"></i>
            <i className="fas fa-sun"></i>
          </button>
          <button onClick={logout} className="header-icon-btn" title="退出登录">
            <i className="fas fa-sign-out-alt"></i>
          </button>
        </div>
      </div>
    </header>
  );
}
