/**
 * 侧边栏组件
 */

import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';
import './Sidebar.css';

export default function Sidebar({ isOpen, onClose }) {
  const logout = useAuthStore((state) => state.logout);

  return (
    <aside className={`sidebar${isOpen ? ' show' : ''}`} role="navigation" aria-label="Main Navigation">
      {/* Logo区域 */}
      <div className="sidebar-logo">
        <i className="fas fa-shield-halved"></i>
        <span>AccountHub</span>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'} end>
          <i className="fas fa-tachometer-alt"></i> <span>仪表盘</span>
        </NavLink>
        <NavLink to="/config" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-cog"></i> <span>代理配置</span>
        </NavLink>
        <NavLink to="/providers" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-layer-group"></i> <span>渠道管理</span>
        </NavLink>
        <NavLink to="/emails" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-envelope"></i> <span>邮箱管理</span>
        </NavLink>
        <NavLink to="/potluck-admin" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-utensils"></i> <span>分发管理</span>
        </NavLink>
        <NavLink to="/potluck-user" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-user-circle"></i> <span>分发用户</span>
        </NavLink>
        <NavLink to="/logs" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-file-alt"></i> <span>实时日志</span>
        </NavLink>
        <NavLink to="/monitor" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-chart-line"></i> <span>性能监控</span>
        </NavLink>
        <NavLink to="/tracing" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
          <i className="fas fa-route"></i> <span>链路追踪</span>
        </NavLink>
      </nav>
      {/* 底部装饰和功能区 */}
      <div className="sidebar-footer">
        <div className="sidebar-decoration">
          <i className="fas fa-rocket sidebar-decoration-icon"></i>
          <p className="sidebar-decoration-text">探索更多功能<br />提升您的体验</p>
        </div>
        <div className="sidebar-upgrade-btn" style={{ cursor: 'default', opacity: 0.85 }}>
          <i className="fas fa-layer-group"></i>
          <span>AccountHub</span>
        </div>
      </div>
    </aside>
  );
}
