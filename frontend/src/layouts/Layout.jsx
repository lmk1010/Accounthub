/**
 * 主布局组件
 */

import { useEffect, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';
import Sidebar from '../components/Sidebar';
import Header from '../components/Header';
import './Layout.css';

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, checkAuth } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const verify = async () => {
      const valid = await checkAuth();
      if (!valid) {
        navigate('/login');
      }
    };
    verify();
  }, [checkAuth, navigate]);

  // 路由变化时关闭侧边栏
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="container">
      <div className="main-card">
        <div className="main-content">
          <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} />
          <main className="content" role="main">
            <Header onMenuToggle={toggleSidebar} sidebarOpen={sidebarOpen} />
            <div id="content-container">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      {sidebarOpen && <div className="mobile-overlay active" onClick={closeSidebar} />}
    </div>
  );
}
