/**
 * 登录页面
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';
import './Login.css';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);

  useEffect(() => {
    const remember = localStorage.getItem('loginRemember') === 'true';
    if (remember) {
      const savedUsername = localStorage.getItem('loginUsername') || '';
      const savedPassword = localStorage.getItem('loginPassword') || '';
      setUsername(savedUsername);
      setPassword(savedPassword);
      setRememberMe(true);
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    try {
      const response = await login(password);
      if (response.success) {
        if (rememberMe) {
          localStorage.setItem('loginRemember', 'true');
          localStorage.setItem('loginUsername', username);
          localStorage.setItem('loginPassword', password);
        } else {
          localStorage.removeItem('loginRemember');
          localStorage.removeItem('loginUsername');
          localStorage.removeItem('loginPassword');
        }
        navigate('/');
      } else {
        setError(response.message || '登录失败');
      }
    } catch (err) {
      setError('登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterClick = () => {
    setIsRegister(true);
    setError('');
    setNotice('暂不支持注册，请联系管理员');
  };

  const handleForgotPassword = (e) => {
    e.preventDefault();
    setError('');
    setNotice('暂不支持找回密码，请联系管理员');
  };

  const handleRememberChange = (e) => {
    const nextValue = e.target.checked;
    setRememberMe(nextValue);
    if (!nextValue) {
      localStorage.removeItem('loginRemember');
      localStorage.removeItem('loginUsername');
      localStorage.removeItem('loginPassword');
    }
  };

  return (
    <div className="login-page">
      <div className="login-left">
        <div className="login-image">
          <div className="image-overlay">
            <h1>欢迎使用系统</h1>
            <p>简单易用的管理平台</p>
          </div>
        </div>
      </div>

      <div className="login-right">
        <div className="login-header">
          <div className="logo-text">
            <i className="fas fa-shield-halved"></i>
            <span>AccountHub</span>
          </div>
        </div>

        <div className="login-form-container">
          <h2>欢迎来到 AccountHub！</h2>

          <div className="tab-buttons">
            <button
              className={!isRegister ? 'active' : ''}
              onClick={() => setIsRegister(false)}
            >
              登录
            </button>
            <button
              className={isRegister ? 'active' : ''}
              onClick={handleRegisterClick}
            >
              注册
            </button>
          </div>

          <p className="form-description">
            统一管理 AI 服务提供商与账号分发。
          </p>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="username">用户名</label>
              <input
                type="text"
                id="username"
                placeholder="请输入用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">密码</label>
              <div className="password-input-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                />
                <button
                  type="button"
                  className="toggle-password"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>

            <div className="form-options">
              <label className="remember-me">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={handleRememberChange}
                />
                <span>记住我</span>
              </label>
              <a href="#" className="forgot-password" onClick={handleForgotPassword}>忘记密码？</a>
            </div>

            {error && (
              <div className="error-message show">
                {error}
              </div>
            )}
            {notice && (
              <div className="notice-message show">
                {notice}
              </div>
            )}

            <button type="submit" className="login-button" disabled={loading}>
              {loading ? <span className="login-spinner"></span> : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
