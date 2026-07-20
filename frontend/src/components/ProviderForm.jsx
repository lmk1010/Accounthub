/**
 * 提供商添加表单组件
 */

import { useState } from 'react';
import Modal from './Modal';
import './ProviderForm.css';

export default function ProviderForm({ isOpen, onClose, onSubmit }) {
  const [formData, setFormData] = useState({
    providerType: 'claude-warp-oauth',
    customName: '',
    credentials: {}
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      onClose();
    } catch (error) {
      console.error('Failed to add provider:', error);
      alert('添加失败: ' + (error.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="添加提供商"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? '添加中...' : '添加'}
          </button>
        </>
      }
    >
      <form className="provider-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>提供商类型</label>
          <select
            value={formData.providerType}
            onChange={(e) => setFormData({...formData, providerType: e.target.value})}
          >
            <option value="claude-warp-oauth">Claude Warp OAuth</option>
            <option value="gemini-cli-oauth">Gemini CLI OAuth</option>
            <option value="openai-codex">OpenAI Codex OAuth</option>
            <option value="openai-xai-oauth">xAI Grok OAuth</option>
          </select>
        </div>

        <div className="form-group">
          <label>自定义名称（可选）</label>
          <input
            type="text"
            value={formData.customName}
            onChange={(e) => setFormData({...formData, customName: e.target.value})}
            placeholder="为此提供商设置一个名称"
          />
        </div>
      </form>
    </Modal>
  );
}
