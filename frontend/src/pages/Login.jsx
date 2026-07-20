/**
 * 登录页面
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';
import './Login.css';

const RESEARCH_NOTICE_VERSION = '2026-07-20';
const RESEARCH_NOTICE_KEY = 'accounthub_research_notice_accepted';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [acceptResearch, setAcceptResearch] = useState(false);
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
      setUsername(savedUsername);
      setRememberMe(true);
    }
    localStorage.removeItem('loginPassword');
    const accepted = localStorage.getItem(RESEARCH_NOTICE_KEY) === RESEARCH_NOTICE_VERSION;
    setAcceptResearch(accepted);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');

    if (!acceptResearch) {
      setError('请先阅读并勾选研究用途与责任说明');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }

    setLoading(true);
    try {
      const response = await login(password);
      if (response.success) {
        localStorage.setItem(RESEARCH_NOTICE_KEY, RESEARCH_NOTICE_VERSION);
        if (rememberMe) {
          localStorage.setItem('loginRemember', 'true');
          localStorage.setItem('loginUsername', username);
        } else {
          localStorage.removeItem('loginRemember');
          localStorage.removeItem('loginUsername');
        }
        localStorage.removeItem('loginPassword');
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
    setNotice('公开发行版不提供自助注册。仅限授权管理员登录；如需账号请联系部署方。');
  };

  const handleForgotPassword = (e) => {
    e.preventDefault();
    setError('');
    setNotice('请联系部署管理员重置密码。请勿在不受信任的环境中保存密码。');
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
            <h1>AccountHub</h1>
            <p>账号池控制面 · 研究与授权自建</p>
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
          <h2>管理员登录</h2>

          <div className="tab-buttons">
            <button
              type="button"
              className={!isRegister ? 'active' : ''}
              onClick={() => setIsRegister(false)}
            >
              登录
            </button>
            <button
              type="button"
              className={isRegister ? 'active' : ''}
              onClick={handleRegisterClick}
            >
              注册
            </button>
          </div>

          <p className="form-description">
            统一管理 AI 提供商账号池、OAuth 与协议网关。本软件用于学习、研究与授权自建实验。
          </p>

          <div className="research-notice" role="note">
            <div className="research-notice-title">
              <i className="fas fa-balance-scale" />
              使用须知 / Research use
            </div>
            <ul>
              <li>仅用于学习、科学研究与<strong>授权</strong>自建实验。</li>
              <li>仅使用您有权使用的 API Key / OAuth 凭证；禁止未授权访问与违规刷号。</li>
              <li>请遵守各 AI 厂商服务条款与当地法律法规；部署与使用责任由操作者自行承担。</li>
              <li>本项目不提供任何厂商账号、付费额度或官方背书。</li>
            </ul>
            <p className="research-notice-links">
              详情见仓库 NOTICE.md、docs/public/RESEARCH_USE.md、docs/public/PRIVACY.md
            </p>
            <label className="research-accept">
              <input
                type="checkbox"
                checked={acceptResearch}
                onChange={(e) => setAcceptResearch(e.target.checked)}
                disabled={loading}
              />
              <span>
                我已阅读并同意：本软件仅用于研究与授权自建，相关合规责任由我自行承担。
              </span>
            </label>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="username">用户名</label>
              <input
                type="text"
                id="username"
                placeholder="可选，仅用于本机记住显示名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoComplete="username"
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">密码</label>
              <div className="password-input-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  placeholder="请输入管理员密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="toggle-password"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? '隐藏' : '显示'}
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
                <span>记住用户名</span>
              </label>
              <a href="#" className="forgot-password" onClick={handleForgotPassword}>
                忘记密码？
              </a>
            </div>

            {error && <div className="error-message show">{error}</div>}
            {notice && <div className="notice-message show">{notice}</div>}

            <button
              type="submit"
              className="login-button"
              disabled={loading || !acceptResearch}
            >
              {loading ? <span className="login-spinner" /> : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
