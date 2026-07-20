/**
 * 渠道详情页面 - 号池列表 / 账号列表
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { providerService } from '../services/provider.service';
import { proxyPoolService } from '../services/proxy-pool.service';
import { usageService } from '../services/usage.service';
import { requestLogsService } from '../services/request-logs.service';
import * as channelConfigService from '../services/channel-config.service';
import { channelDispatchLogsService } from '../services/channel-dispatch-logs.service';
import AuthUrlModal from '../components/AuthUrlModal';
import {
  KiroMethodModal,
  KiroBatchImportModal,
  KiroAwsImportModal,
  CodexMethodModal,
  CodexJsonImportModal,
  GrokMethodModal,
  GrokImportModal
} from '../components/KiroImportModals';
import CustomSelect from '../components/CustomSelect';
import './ProviderDetail.css';
import './Providers.css'; // 引入 Kiro 弹窗所需的样式

const PROVIDER_NAME_MAP = {
  'gemini-cli-oauth': 'Gemini CLI OAuth',
  'gemini-antigravity': 'Gemini Antigravity',
  'openai-custom': 'OpenAI Custom',
  'claude-custom': 'Claude Custom',
  'claude-offical': 'Claude Offical',
  'claude-kiro-oauth': 'Claude Kiro OAuth',
  'claude-warp-oauth': 'Warp AI OAuth',
  'claude-orchids-oauth': 'Orchids OAuth',
  'openai-droid': 'Droid OpenAI',
  'openaiResponses-droid': 'Droid Responses',
  'claude-droid': 'Droid Claude',
  'openai-codex': 'OpenAI Codex OAuth',
  'openai-xai-oauth': 'xAI Grok OAuth',
};

const USAGE_SUPPORTED_TYPES = new Set([
  'claude-custom',
  'claude-offical',
  'claude-kiro-oauth',
  'gemini-cli-oauth',
  'gemini-antigravity',
  'claude-antigravity',
  'openai-codex',
  'openai-xai-oauth',
  'claude-windsurf',
]);

const CODEX_CARD_WINDOW_PLACEHOLDERS = ['5小时窗口', '每周窗口'];

const COMMON_CHECK_MODELS = [
  'gpt-6-codex',
  'gpt-6',
  'gpt-5.3-codex',
  'grok-4.5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6-20260217',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6-20260101',
  'claude-opus-4-5-20251101',
];

const STATUS_LABELS = {
  healthy: '健康',
  cooldown: '冷却',
  unhealthy: '异常',
  disabled: '禁用',
  deleted: '已删除',
};

const STATUS_ACTION_LABELS = {
  mark_unhealthy: '标记异常',
  mark_unhealthy_immediate: '立即异常',
  mark_unhealthy_recovery: '异常(待恢复)',
  mark_unhealthy_quota_cooldown: '冷却(额度耗尽)',
  mark_deleted: '标记删除',
  mark_healthy: '标记健康',
  recover_deleted: '恢复删除',
  disable: '禁用',
  enable: '启用',
  reset_health: '重置健康',
  health_check_recover: '检测恢复',
  health_check_fail: '检测失败',
  scheduled_recover: '定时恢复',
  delete: '删除',
};

function normalizeIdentityList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\s,;，；]+/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

const DEFAULT_CODEX_HIGH_CONCURRENCY_USER_IDS = ['30', '81'];

function normalizeCodexHighConcurrencyUserIds(value) {
  return Array.from(new Set([
    ...DEFAULT_CODEX_HIGH_CONCURRENCY_USER_IDS,
    ...normalizeIdentityList(value)
  ]));
}

// 不同 providerType 的配置字段映射
const PROVIDER_FIELD_CONFIG = {
  'claude-kiro-oauth': {
    credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'KIRO_BASE_URL', label: 'Base URL' },
      { key: 'KIRO_REFRESH_URL', label: 'Refresh URL' },
      { key: 'KIRO_REFRESH_IDC_URL', label: 'Refresh IDC URL' },
    ],
  },
  'claude-warp-oauth': {
    credPathKey: 'WARP_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'WARP_BASE_URL', label: 'Base URL' },
      { key: 'WARP_TOKEN_URL', label: 'Token URL' },
    ],
  },
  'claude-orchids-oauth': {
    credPathKey: 'ORCHIDS_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'ORCHIDS_BASE_URL', label: 'Base URL' },
    ],
  },
  'gemini-cli-oauth': {
    credPathKey: 'GEMINI_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'GEMINI_BASE_URL', label: 'Base URL' },
    ],
    extraFields: [
      { key: 'GEMINI_PROJECT_ID', label: 'Project ID', type: 'text' },
    ],
  },
  'gemini-antigravity': {
    credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'ANTIGRAVITY_BASE_URL_DAILY', label: 'Base URL (Daily)' },
      { key: 'ANTIGRAVITY_BASE_URL_AUTOPUSH', label: 'Base URL (Autopush)' },
    ],
    extraFields: [
      { key: 'ANTIGRAVITY_PROJECT_ID', label: 'Project ID', type: 'text' },
    ],
  },
  'openai-codex': {
    credPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'CODEX_BASE_URL', label: 'Base URL' },
    ],
  },
  'openai-xai-oauth': {
    credPathKey: 'XAI_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'XAI_BASE_URL', label: 'xAI API Base URL' },
      { key: 'XAI_CHAT_BASE_URL', label: 'Grok Chat Base URL' },
    ],
  },
  'openai-qwen-oauth': {
    credPathKey: 'QWEN_OAUTH_CREDS_FILE_PATH',
    credPathLabel: 'OAuth凭据路径',
    urlFields: [
      { key: 'QWEN_BASE_URL', label: 'Base URL' },
      { key: 'QWEN_OAUTH_BASE_URL', label: 'OAuth Base URL' },
    ],
  },
  'openai-iflow': {
    credPathKey: 'IFLOW_TOKEN_FILE_PATH',
    credPathLabel: 'Token文件路径',
    urlFields: [
      { key: 'IFLOW_BASE_URL', label: 'Base URL' },
    ],
  },
  'openai-custom': {
    urlFields: [
      { key: 'OPENAI_BASE_URL', label: 'Base URL' },
      { key: 'OPENAI_API_KEY', label: 'API Key', type: 'password' },
    ],
  },
  'claude-custom': {
    urlFields: [
      { key: 'CLAUDE_BASE_URL', label: 'Base URL' },
      { key: 'CLAUDE_API_KEY', label: 'API Key', type: 'password' },
    ],
  },
  'claude-offical': {
    urlFields: [
      { key: 'CLAUDE_BASE_URL', label: 'Base URL' },
      { key: 'CLAUDE_API_KEY', label: 'API Key', type: 'password' },
      { key: 'officialStickySessionEnabled', label: '官方粘性会话' },
      { key: 'officialStickySessionTtlMinutes', label: '粘性会话TTL(分钟)' },
      { key: 'officialSessionBindingStrict', label: '严格会话绑定' },
      { key: 'officialStickyIdentityMode', label: '粘性身份模式' },
      { key: 'officialFingerprintIncludeUser', label: '指纹包含用户' },
      { key: 'officialFingerprintIncludeToken', label: '指纹包含Token' },
      { key: 'officialFingerprintIncludePath', label: '指纹包含路径' },
    ],
  },
  'claude-antigravity': {
    urlFields: [
      { key: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', label: 'OAuth 凭据引用' },
      { key: 'antigravityStickySessionEnabled', label: '反重力粘性会话' },
      { key: 'antigravityStickySessionTtlMinutes', label: '粘性会话TTL(分钟)' },
      { key: 'antigravitySessionBindingStrict', label: '严格会话绑定' },
      { key: 'antigravityStickyIdentityMode', label: '粘性身份模式' },
      { key: 'antigravityFingerprintIncludeUser', label: '指纹包含用户' },
      { key: 'antigravityFingerprintIncludeToken', label: '指纹包含Token' },
      { key: 'antigravityFingerprintIncludePath', label: '指纹包含路径' },
      { key: 'antigravityFingerprintSalt', label: '指纹盐值' },
    ],
  },
};

const XAI_ROUTE_OPTIONS = [
  { value: '', label: '自动（按 Token 权限）' },
  { value: 'true', label: 'xAI 官方 API' },
  { value: 'false', label: 'Grok Build 代理' },
];

const CLAUDE_CUSTOM_UPSTREAM_MODES = [
  { value: 'direct', label: '直连模式' },
  { value: 'antigravity-channel', label: '上游反代模式' },
];

const CLAUDE_CUSTOM_SYSTEM_TYPES = [
  { value: 'self-developed', label: '自研系统' },
  { value: 'newapi', label: 'NewAPI 对接' },
];

const CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS = [
  { value: 'session-or-fingerprint', label: 'Session优先, 指纹兜底' },
  { value: 'session', label: '仅 Session' },
  { value: 'fingerprint', label: '仅 指纹' },
];

const UPSTREAM_AUTO_HEALTH_COOLDOWN_MS = 5 * 60 * 1000;

const normalizeUpstreamAccounts = (payload) => {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.accounts) ? payload.accounts : []);

  return list.map((item) => ({
    ...item,
    accountId: item.accountId || item.account_id || item.id || '',
    email: item.email || item.accountEmail || item.user || item.name || '--',
    isActive: Boolean(item.isActive ?? item.active ?? item.current ?? item.is_current),
  }));
};

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
};

const resolveProviderRecoveryAt = (provider = {}) => {
  const credentials = provider?.credentials && typeof provider.credentials === 'object'
    ? provider.credentials
    : {};
  return provider.scheduledRecoveryTime
    || provider.scheduled_recovery_time
    || credentials.relayStateRecoverAt
    || credentials.relay_state_recover_at
    || null;
};

const isProviderCooldown = (provider = {}) => {
  if (!provider || provider.isDeleted || provider.is_deleted || provider.isDisabled || provider.is_disabled || provider.isHealthy || provider.is_healthy) {
    return false;
  }
  if (typeof provider.isCooldown === 'boolean') {
    return provider.isCooldown;
  }
  const recoveryAtRaw = resolveProviderRecoveryAt(provider);
  const recoveryAtMs = recoveryAtRaw ? new Date(recoveryAtRaw).getTime() : NaN;
  return Number.isFinite(recoveryAtMs) && recoveryAtMs > Date.now();
};

const formatProxyNodeLabel = (log) => {
  const name = log?.proxyNodeName ? String(log.proxyNodeName).trim() : '';
  const host = log?.proxyNodeHost ? String(log.proxyNodeHost).trim() : '';
  const port = (log?.proxyNodePort ?? log?.proxy_node_port ?? null);
  const protocol = log?.proxyNodeProtocol ? String(log.proxyNodeProtocol).trim().toUpperCase() : '';
  const endpoint = host ? `${host}${port ? `:${port}` : ''}` : '';

  if (name && endpoint) return `${name} (${protocol || 'PROXY'} ${endpoint})`;
  if (name) return name;
  if (endpoint) return `${protocol || 'PROXY'} ${endpoint}`;
  return '';
};

const extractApiErrorMessage = (error, fallback = '操作失败') => {
  const payload = error?.response?.data;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) return payload.error.message.trim();
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  return fallback;
};

const formatStatusLabel = (status) => STATUS_LABELS[status] || status || '--';

const formatStatusAction = (action) => STATUS_ACTION_LABELS[action] || action || '--';

const getProviderDisplayName = (type) => PROVIDER_NAME_MAP[type] || type;

const getProviderIcon = (type) => {
  if (type.includes('gemini')) return '/logos/gemini.svg';
  if (type === 'openai-xai-oauth') return '/logos/xai.svg';
  if (type.includes('claude')) return '/logos/claude.svg';
  if (type.includes('openai') || type.includes('qwen') || type.includes('codex') || type.includes('droid') || type.includes('iflow')) return '/logos/openai.svg';
  return null;
};

// 策略标签映射
const STRATEGY_LABELS = {
  'priority': '优先',
  'round-robin': '轮询',
  'random': '随机',
  'least-used': '最少使用',
};

const getStrategyLabel = (strategy) => STRATEGY_LABELS[strategy] || strategy || '轮询';

const POOL_ROUTING_STRATEGY_OPTIONS = [
  { value: 'priority', label: '优先' },
  { value: 'round-robin', label: '轮询' },
  { value: 'random', label: '随机' },
  { value: 'least-used', label: '最少使用' },
];

const DEFAULT_POOL_ROUTING = {
  default: { strategy: 'priority', poolIds: [] },
  rules: [],
};

const DEFAULT_MODEL_PLACEHOLDER = '-- 选择默认模型 --';

const KIRO_DEFAULT_MODEL_LIST = [
  'claude-opus-4-8',
  'claude-opus-4.8',
  'claude-opus-4-8-low',
  'claude-opus-4-8-medium',
  'claude-opus-4-8-high',
  'claude-opus-4-8-xhigh',
  'claude-opus-4-8-max',
  'claude-opus-4.8-low',
  'claude-opus-4.8-medium',
  'claude-opus-4.8-high',
  'claude-opus-4.8-xhigh',
  'claude-opus-4.8-max',
  'claude-opus-4-8-medium-thinking',
  'claude-opus-4-8-high-thinking',
  'claude-opus-4-8-xhigh-thinking',
  'claude-opus-4.8-medium-thinking',
  'claude-opus-4.8-high-thinking',
  'claude-opus-4.8-xhigh-thinking',
  'claude-opus-4-7',
  'claude-opus-4.7',
  'claude-opus-4-7-low',
  'claude-opus-4-7-medium',
  'claude-opus-4-7-high',
  'claude-opus-4-7-xhigh',
  'claude-opus-4-7-max',
  'claude-opus-4.7-low',
  'claude-opus-4.7-medium',
  'claude-opus-4.7-high',
  'claude-opus-4.7-xhigh',
  'claude-opus-4.7-max',
  'claude-opus-4-7-medium-thinking',
  'claude-opus-4-7-high-thinking',
  'claude-opus-4-7-xhigh-thinking',
  'claude-opus-4.7-medium-thinking',
  'claude-opus-4.7-high-thinking',
  'claude-opus-4.7-xhigh-thinking',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-20260217',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'minimax-m2.1',
  'deepseek-3.2',
];

const KIRO_DISABLED_MODEL_LIST = [
  'claude-opus-4-8',
  'claude-opus-4.8',
  'claude-opus-4-8-low',
  'claude-opus-4-8-medium',
  'claude-opus-4-8-high',
  'claude-opus-4-8-xhigh',
  'claude-opus-4-8-max',
  'claude-opus-4.8-low',
  'claude-opus-4.8-medium',
  'claude-opus-4.8-high',
  'claude-opus-4.8-xhigh',
  'claude-opus-4.8-max',
  'claude-opus-4-8-medium-thinking',
  'claude-opus-4-8-high-thinking',
  'claude-opus-4-8-xhigh-thinking',
  'claude-opus-4.8-medium-thinking',
  'claude-opus-4.8-high-thinking',
  'claude-opus-4.8-xhigh-thinking',
  'claude-opus-4-7',
  'claude-opus-4.7',
  'claude-opus-4-7-low',
  'claude-opus-4-7-medium',
  'claude-opus-4-7-high',
  'claude-opus-4-7-xhigh',
  'claude-opus-4-7-max',
  'claude-opus-4.7-low',
  'claude-opus-4.7-medium',
  'claude-opus-4.7-high',
  'claude-opus-4.7-xhigh',
  'claude-opus-4.7-max',
  'claude-opus-4-7-medium-thinking',
  'claude-opus-4-7-high-thinking',
  'claude-opus-4-7-xhigh-thinking',
  'claude-opus-4.7-medium-thinking',
  'claude-opus-4.7-high-thinking',
  'claude-opus-4.7-xhigh-thinking',
  'claude-opus-4-6',
  'claude-opus-4-6-20260101',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-20260217',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'minimax-m2.1',
  'deepseek-3.2',
];

const KIRO_POOL_ROUTING_MODELS = Array.from(new Set([
  ...KIRO_DISABLED_MODEL_LIST,
  ...KIRO_DEFAULT_MODEL_LIST
]));

const CODEX_FALLBACK_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-codex-mini',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-codex',
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6',
  'gpt-6-codex',
];

const XAI_FALLBACK_MODELS = [
  'grok-4.5',
  'grok-composer-2.5-fast',
  'grok-imagine-image',
  'grok-imagine-image-quality',
  'grok-imagine-video',
  'grok-imagine-video-1.5',
  'grok-imagine-video-1.5-preview',
];

const DEFAULT_CODEX_CLAUDE_MESSAGES_MODEL_MAPPING = {
  'claude-haiku-4-5': 'gpt-5.5',
  'claude-haiku-4-5-20251001': 'gpt-5.5',
  'claude-sonnet-4': 'gpt-5.5',
  'claude-sonnet-4-20250514': 'gpt-5.5',
  'claude-sonnet-4-5': 'gpt-5.5',
  'claude-sonnet-4-5-20250929': 'gpt-5.5',
  'claude-sonnet-4-6': 'gpt-5.5',
  'claude-sonnet-4-6-20260217': 'gpt-5.5',
  'claude-opus-4-5': 'gpt-5.5',
  'claude-opus-4-5-20251101': 'gpt-5.5',
  'claude-opus-4-6': 'gpt-5.5',
  'claude-opus-4-6-20260101': 'gpt-5.5',
};

const DEFAULT_XAI_CLAUDE_MESSAGES_MODEL_MAPPING = {
  'claude-3-5-haiku-20241022': 'grok-4.5',
  'claude-3-5-haiku-latest': 'grok-4.5',
  'claude-3-5-sonnet-20241022': 'grok-4.5',
  'claude-3-5-sonnet-latest': 'grok-4.5',
  'claude-3-7-sonnet-20250219': 'grok-4.5',
  'claude-3-7-sonnet-latest': 'grok-4.5',
  'claude-haiku-4-5': 'grok-4.5',
  'claude-haiku-4-5-20251001': 'grok-4.5',
  'claude-sonnet-4': 'grok-4.5',
  'claude-sonnet-4-20250514': 'grok-4.5',
  'claude-sonnet-4-5': 'grok-4.5',
  'claude-sonnet-4-5-20250929': 'grok-4.5',
  'claude-sonnet-4-6': 'grok-4.5',
  'claude-sonnet-4-6-20260217': 'grok-4.5',
  'claude-opus-4': 'grok-4.5',
  'claude-opus-4-20250514': 'grok-4.5',
  'claude-opus-4-1': 'grok-4.5',
  'claude-opus-4-1-20250805': 'grok-4.5',
  'claude-opus-4-5': 'grok-4.5',
  'claude-opus-4-5-20251101': 'grok-4.5',
  'claude-opus-4-6': 'grok-4.5',
  'claude-opus-4-6-20260101': 'grok-4.5',
};


const CODEX_CLAUDE_REASONING_EFFORT_OPTIONS = [
  { value: 'auto', label: '跟随 Claude' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

const CODEX_CLAUDE_VERBOSITY_OPTIONS = [
  { value: 'default', label: '模型默认' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

const CODEX_CLAUDE_SERVICE_TIER_OPTIONS = [
  { value: 'standard', label: 'standard' },
  { value: 'fast', label: 'fast' },
  { value: 'flex', label: 'flex' },
];

const normalizeModelPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.models)) return payload.data.models;
  return [];
};

const buildModelOptions = (models) => (
  models.map(model => ({ value: model, label: model }))
);

const normalizePoolRouting = (value) => {
  const routing = value || {};
  const fallbackDefault = routing.default || {};
  return {
    default: {
      strategy: fallbackDefault.strategy || 'priority',
      poolIds: Array.isArray(fallbackDefault.poolIds)
        ? fallbackDefault.poolIds.map(id => Number(id)).filter(id => Number.isFinite(id))
        : [],
      poolNames: Array.isArray(fallbackDefault.poolNames) ? fallbackDefault.poolNames : [],
    },
    rules: Array.isArray(routing.rules)
      ? routing.rules.map(rule => ({
          models: Array.isArray(rule.models) ? rule.models : [],
          strategy: rule.strategy || 'priority',
          poolIds: Array.isArray(rule.poolIds)
            ? rule.poolIds.map(id => Number(id)).filter(id => Number.isFinite(id))
            : [],
          poolNames: Array.isArray(rule.poolNames) ? rule.poolNames : [],
        }))
      : [],
  };
};

// 电池组件 - 显示剩余额度
const BatteryBar = ({ percent, cellCount = 10, mini = false }) => {
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  const filledCells = Math.round((safePercent / 100) * cellCount);
  const colorClass = safePercent <= 20 ? 'danger' : safePercent <= 50 ? 'warning' : '';
  const percentClass = safePercent <= 20 ? 'danger' : safePercent <= 50 ? 'warning' : 'success';

  return (
    <div className="quota-battery">
      <div className={`battery-bar ${mini ? 'mini' : ''}`}>
        {Array.from({ length: cellCount }, (_, i) => (
          <div
            key={i}
            className={`battery-cell ${i < filledCells ? `filled ${colorClass}` : ''}`}
          />
        ))}
      </div>
      <span className={`battery-percent ${percentClass}`}>{Math.round(safePercent)}%</span>
    </div>
  );
};

const resolveCodexTierClass = (title) => {
  if (!title) return '';
  const upper = String(title).replace(/\s+/g, ' ').trim().toUpperCase();
  if (upper.includes('ENTERPRISE')) return 'enterprise';
  if (upper.includes('TEAM')) return 'team';
  if (upper.includes('PRO+') || (upper.includes('PRO') && upper.includes('PLUS'))) return 'pro-plus';
  if (upper.includes('PRO')) return 'pro';
  if (upper.includes('PLUS')) return 'plus';
  return 'free';
};

const formatCodexTierTitle = (title) => {
  if (!title) return '-';
  const normalized = String(title).replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  if (upper.includes('ENTERPRISE')) return 'ENTERPRISE';
  if (upper.includes('TEAM')) return 'TEAM';
  if (upper.includes('PRO+') || (upper.includes('PRO') && upper.includes('PLUS'))) return 'PRO+';
  if (upper.includes('PRO')) return 'PRO';
  if (upper.includes('PLUS')) return 'PLUS';
  if (upper.includes('FREE')) return 'FREE';
  return normalized;
};

const resolveProviderEmail = (provider = {}) => {
  const candidates = [
    provider.email,
    provider.userEmail,
    provider.accountEmail,
    provider.credentials?.email,
    provider.credentials?.userEmail,
    provider.credentials?.accountEmail,
  ];
  const hit = candidates.find((item) => typeof item === 'string' && item.trim().length > 0);
  return hit ? hit.trim() : '';
};

const formatDurationSeconds = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '--';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟${secs}秒`;
  return `${secs}秒`;
};

const formatLocalDateTime = (value) => {
  if (!value) return '--';
  const num = Number(value);
  if (Number.isFinite(num)) {
    const ts = num < 1e12 ? num * 1000 : num;
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

const formatQuotaMetric = (value) => {
  if (value === null || value === undefined) return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (Math.abs(num) >= 1000) return Math.round(num).toLocaleString('zh-CN');
  return num % 1 === 0 ? String(num) : num.toFixed(2);
};

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const buildCodexImageQuotaView = (summary, errorMessage = '') => {
  if (!summary && !errorMessage) return null;

  const status = String(summary?.status || '').trim().toLowerCase();
  const sourceStatus = String(summary?.sourceStatus || '').trim().toLowerCase();
  const remaining = toFiniteNumber(summary?.remaining);
  const used = toFiniteNumber(summary?.used);
  const limit = toFiniteNumber(summary?.limit);

  let tone = 'empty';
  if (status === 'critical') tone = 'critical';
  else if (status === 'warning') tone = 'warning';
  else if (remaining !== null) tone = 'normal';

  let remainingLabel = '未知';
  if (remaining !== null) {
    remainingLabel = `${formatQuotaMetric(Math.max(0, remaining))} 张`;
  } else if (sourceStatus === 'not_returned') {
    remainingLabel = '未返回';
  } else if (errorMessage) {
    remainingLabel = '刷新失败';
  }

  let detailLabel = '';
  if (used !== null && limit !== null && limit > 0) {
    detailLabel = `${formatQuotaMetric(Math.max(0, used))} / ${formatQuotaMetric(Math.max(0, limit))}`;
  }

  const metaParts = [];
  if (summary?.resetAt) {
    metaParts.push(`恢复 ${formatLocalDateTime(summary.resetAt)}`);
  }

  let notice = '';
  if (sourceStatus === 'not_returned') {
    notice = '接口未返回图片额度';
  } else if (errorMessage) {
    notice = errorMessage;
  }
  if (notice) {
    metaParts.push(notice);
  }

  return {
    tone,
    remainingLabel,
    detailLabel,
    resetAt: summary?.resetAt ? formatLocalDateTime(summary.resetAt) : '--',
    hasResetAt: Boolean(summary?.resetAt),
    notice,
    inlineLabel: ['图片额度', remainingLabel, ...metaParts].join(' · '),
    metaLabel: metaParts.join(' · ')
  };
};

const resolveCodexWindowLabel = (item) => {
  const limitId = String(item?.limitId || '').toLowerCase();
  const meteredFeature = String(item?.meteredFeature || '').toLowerCase();
  const isSparkWindow = item?.limitGroup === 'additional'
    && (
      limitId.includes('spark')
      || meteredFeature.includes('spark')
      || limitId === 'codex_other'
      || meteredFeature === 'codex_other'
    );
  const windowSeconds = Number(item?.limitWindowSeconds);
  if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
    if (isSparkWindow) {
      const minutes = Math.round(windowSeconds / 60);
      return minutes >= 60 ? `Spark ${Math.round(minutes / 60)}小时窗口` : `Spark ${minutes}分钟窗口`;
    }
    if (Math.abs(windowSeconds - 18000) <= 900) return '5小时窗口';
    if (Math.abs(windowSeconds - 604800) <= 7200) return '每周窗口';
    const hours = Math.round(windowSeconds / 3600);
    if (hours >= 24) {
      const days = Math.round(hours / 24);
      return `${days}天窗口`;
    }
    return `${hours}小时窗口`;
  }
  const name = String(item?.displayName || '').toLowerCase();
  if (isSparkWindow) return item?.displayName || 'Spark窗口';
  if (name.includes('secondary')) return '次级窗口';
  if (name.includes('primary')) return '主窗口';
  return item?.displayName || '窗口';
};

const buildCodexCardBreakdowns = (breakdowns) => {
  const rateWindows = Array.isArray(breakdowns)
    ? breakdowns.filter(item => item?.resourceType === 'RATE_LIMIT')
    : [];

  return rateWindows
    .map(item => {
      const remainingPercentRaw = Number(item?.remainingPercent);
      const usedPercentRaw = Number(item?.usedPercent);
      const currentUsage = Number(item?.currentUsage);
      const usageLimit = Number(item?.usageLimit);
      const windowSeconds = Number(item?.limitWindowSeconds);
      let remainingPercent = Number.isFinite(remainingPercentRaw) ? remainingPercentRaw : null;

      if (remainingPercent == null && Number.isFinite(usedPercentRaw)) {
        remainingPercent = Math.max(0, Math.min(100, 100 - usedPercentRaw));
      }

      if (remainingPercent == null && Number.isFinite(currentUsage) && Number.isFinite(usageLimit) && usageLimit > 0) {
        remainingPercent = Math.max(0, Math.min(100, 100 - (currentUsage / usageLimit) * 100));
      }

      const label = resolveCodexWindowLabel(item);
      const priority = label === '5小时窗口'
        ? 0
        : (label === '每周窗口' || label === '7天窗口' ? 1 : 2);

      return {
        label,
        remainingPercent,
        priority,
        windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : Number.MAX_SAFE_INTEGER,
      };
    })
    .filter(item => item.label && item.remainingPercent != null)
    .sort((left, right) => left.priority - right.priority || left.windowSeconds - right.windowSeconds)
    .slice(0, 2)
    .map(({ label, remainingPercent }) => ({ label, remainingPercent }));
};

const resolveResetAfterSeconds = (item) => {
  const direct = Number(item?.resetAfterSeconds);
  if (Number.isFinite(direct) && direct >= 0) {
    return direct;
  }
  const nextReset = item?.nextDateReset;
  if (!nextReset) return null;
  const date = new Date(nextReset);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
};

const pickUsageInstanceByUuid = (usageData, uuid, { allowFallback = false } = {}) => {
  if (!usageData || !Array.isArray(usageData.instances)) return null;
  const instances = usageData.instances;
  const matched = instances.find(item => item?.uuid === uuid);
  if (matched) return matched;
  if (!allowFallback) return null;
  if (!uuid && instances.length > 0) return instances[0];
  if (instances.length === 1) return instances[0];
  return null;
};

const hasCodexRateWindows = (usageData, uuid) => {
  const instance = pickUsageInstanceByUuid(usageData, uuid);
  const breakdowns = Array.isArray(instance?.usage?.usageBreakdown) ? instance.usage.usageBreakdown : [];
  return breakdowns.some(item => item?.resourceType === 'RATE_LIMIT');
};

const buildCachedKiroUsageData = (provider) => {
  if (!provider) return null;

  const usageLimit = provider.usageLimit ?? provider.usage_limit;
  const currentUsage = provider.currentUsage ?? provider.current_usage;

  if (usageLimit === null || usageLimit === undefined) {
    if (currentUsage === null || currentUsage === undefined) {
      return null;
    }
  }

  const limitValue = Number(usageLimit);
  const usedValue = Number(currentUsage);
  const hasLimit = Number.isFinite(limitValue);
  const hasUsed = Number.isFinite(usedValue);

  if (!hasLimit && !hasUsed) {
    return null;
  }

  const safeLimit = hasLimit ? limitValue : 0;
  const safeUsed = hasUsed ? usedValue : 0;
  let remainingPercent = null;

  if (hasLimit && safeLimit > 0 && hasUsed) {
    remainingPercent = Math.max(0, Math.min(100, 100 - (safeUsed / safeLimit) * 100));
  }

  const usageBreakdown = [{
    resourceType: 'CREDIT',
    displayName: 'Credit',
    displayNamePlural: 'Credits',
    unit: 'credits',
    currentUsage: safeUsed,
    usageLimit: safeLimit,
    nextDateReset: provider.nextResetTime ?? provider.next_reset_time ?? null,
    ...(remainingPercent !== null ? { remainingPercent } : {})
  }];

  const subscriptionTitle = provider.subscriptionTitle ?? provider.subscription_title ?? null;
  const usage = {
    subscription: subscriptionTitle ? { title: subscriptionTitle } : null,
    usageBreakdown
  };

  const usageSummary = {
    used: safeUsed,
    limit: safeLimit,
    remaining: hasLimit ? Math.max(0, safeLimit - safeUsed) : null,
    percent: hasLimit && safeLimit > 0 ? (safeUsed / safeLimit) * 100 : 0,
    unit: 'credits',
    resetAt: provider.nextResetTime ?? provider.next_reset_time ?? null,
    modelCount: usageBreakdown.length,
    minRemainingPercent: remainingPercent,
    peakLabel: 'Credit'
  };

  return {
    providerType: provider.providerType ?? provider.provider_type ?? null,
    instances: [{
      uuid: provider.uuid,
      name: provider.customName || provider.custom_name || provider.uuid,
      isHealthy: provider.isHealthy ?? provider.is_healthy ?? true,
      isDisabled: provider.isDisabled ?? provider.is_disabled ?? false,
      isDeleted: provider.isDeleted ?? provider.is_deleted ?? false,
      success: true,
      usage,
      usageSummary,
      error: null
    }]
  };
};

// 额度显示组件
const QuotaDisplay = ({ providerType, uuid, usageData, loading, error, subTier = null }) => {
  if (!USAGE_SUPPORTED_TYPES.has(providerType)) {
    return <span className="quota-unsupported">不支持额度查询</span>;
  }

  if (loading) {
    return (
      <span className="quota-loading">
        <i className="fas fa-spinner" /> 加载中...
      </span>
    );
  }

  if (error) {
    return <span className="quota-error">{error}</span>;
  }

  if (!usageData) {
    return <span className="quota-unsupported">暂无数据</span>;
  }

  // 从 API 返回的 instances 数组中找到对应 uuid 的数据
  const instance = pickUsageInstanceByUuid(usageData, uuid);

  if (!instance || instance.error) {
    return <span className="quota-error">{instance?.error || '暂无数据'}</span>;
  }

  const summary = instance.usageSummary;
  const usage = instance.usage;

  if (!summary && !usage) {
    return <span className="quota-unsupported">暂无数据</span>;
  }

  // 上次刷新时间
  const fetchedAt = instance?.updatedAt || usageData?.summary?.updatedAt || usageData?.timestamp || null;
  const fetchedAtDisplay = fetchedAt ? formatLocalDateTime(fetchedAt) : null;

  // 使用 usageSummary 中的 minRemainingPercent 或计算剩余百分比
  let remainingPercent = 100;
  let displayLabel = '';
  let used = 0;
  let limit = 0;

  if (summary) {
    remainingPercent = summary.minRemainingPercent ?? (100 - (summary.percent || 0));
    used = summary.used ?? 0;
    limit = summary.limit ?? 0;
    displayLabel = summary.peakLabel || '';
  }

  // 根据不同渠道显示不同格式
  if (providerType === 'claude-kiro-oauth') {
    // Kiro 显示剩余百分比和用量
    const breakdown = usage?.usageBreakdown?.[0];
    if (breakdown?.remainingPercent !== undefined) {
      remainingPercent = breakdown.remainingPercent;
    }
    // 获取订阅等级
    const subscriptionTitle = usage?.subscription?.title || '';
    const tierClass = subscriptionTitle.includes('ULTRA') ? 'ultra' :
      subscriptionTitle.includes('PRO+') ? 'pro-plus' :
      subscriptionTitle.includes('PRO') ? 'pro' : 'free';
    const nextReset = usage?.nextDateReset || breakdown?.nextDateReset || null;

    return (
      <div className="quota-kiro">
        {subscriptionTitle && (
          <span className={`kiro-tier-badge ${tierClass}`}>
            {subscriptionTitle.replace('KIRO ', '')}
          </span>
        )}
        <div className="quota-value">
          <BatteryBar percent={remainingPercent} cellCount={10} />
          {limit > 0 && (
            <span className="token-display">
              <span className="token-used">{Math.round(used)}</span>
              <span className="token-sep">/</span>
              <span className="token-limit">{Math.round(limit)}</span>
            </span>
          )}
          {nextReset && (
            <span className="quota-reset-time">重置: {formatLocalDateTime(nextReset)}</span>
          )}
        </div>
        {fetchedAtDisplay && (
          <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>
        )}
      </div>
    );
  }

  if (providerType === 'gemini-cli-oauth' || providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') {
    const breakdowns = usage?.usageBreakdown || [];
    const subscriptionTier = usage?.subscription?.tier || 'FREE';
    const nextReset = usage?.nextDateReset || null;

    return (
      <div className="quota-gemini">
        <div className="quota-summary">
          {(providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') && (
            <span className={`subscription-tier tier-${subscriptionTier.toLowerCase()}`}>
              {subscriptionTier}
            </span>
          )}
          <span className="model-count">{breakdowns.length} 模型</span>
          {nextReset && (
            <span className="quota-reset-time">重置: {formatLocalDateTime(nextReset)}</span>
          )}
        </div>
        {breakdowns.length > 0 && (
          <div className="quota-models-list">
            {breakdowns.map((item, idx) => (
              <div key={idx} className="quota-model-row">
                <span className="model-name" title={item.modelName}>{item.displayName}</span>
                <BatteryBar percent={item.remainingPercent || 0} cellCount={10} mini />
                <span className="model-reset">{item.resetTime || '--'}</span>
              </div>
            ))}
          </div>
        )}
        {fetchedAtDisplay && (
          <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>
        )}
      </div>
    );
  }

  if (providerType === 'claude-custom' || providerType === 'claude-offical') {
    const formatQuotaValue = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '--';
      if (Math.abs(num) >= 100) return Math.round(num).toString();
      if (Math.abs(num) >= 1) return num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
      return num.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    };

    const subscriptionBreakdown = Array.isArray(usage?.subscriptionBreakdown)
      ? usage.subscriptionBreakdown
      : [];
    const isFiveHourWindow = (item) => {
      const subscriptionId = String(item?.subscriptionId || '').toLowerCase();
      const planName = String(item?.planName || item?.displayName || '').toLowerCase();
      if (subscriptionId === 'five_hour') return true;
      return planName.includes('5小时') || planName.includes('5h') || planName.includes('five');
    };
    const primary = providerType === 'claude-offical'
      ? (subscriptionBreakdown.find(isFiveHourWindow) || subscriptionBreakdown[0] || usage?.usageBreakdown?.find(isFiveHourWindow) || usage?.usageBreakdown?.[0] || null)
      : (subscriptionBreakdown[0] || usage?.usageBreakdown?.[0] || null);
    const defaultPlanName = providerType === 'claude-offical' ? 'Claude Official' : 'Foxcode';
    const planName = primary?.planName || primary?.displayName || usage?.subscription?.title || defaultPlanName;
    const planUsed = Number(primary?.used ?? primary?.currentUsage ?? used ?? 0);
    const planLimit = Number(primary?.limit ?? primary?.usageLimit ?? limit ?? 0);
    const planRemaining = Number(primary?.remaining ?? Math.max(0, planLimit - planUsed));
    if (planLimit > 0) {
      remainingPercent = Math.max(0, Math.min(100, (planRemaining / planLimit) * 100));
    }

    return (
      <div className="quota-codex">
        <div className="quota-codex-header">
          <span className="codex-tier-badge tier-pro">{planName}</span>
          <div className="quota-value">
            <BatteryBar percent={remainingPercent} cellCount={10} />
            <span className="token-display">
              <span className="token-used">{formatQuotaValue(planUsed)}</span>
              <span className="token-sep">/</span>
              <span className="token-limit">{planLimit > 0 ? formatQuotaValue(planLimit) : '∞'}</span>
            </span>
          </div>
        </div>
        {subscriptionBreakdown.length > 0 && (
          <div className="codex-window-grid">
            {subscriptionBreakdown.map((item, idx) => (
              <div key={`${item?.subscriptionId || 'sub'}-${idx}`} className="codex-window-card">
                <div className="codex-window-header">
                  <span className="codex-window-title">{item?.planName || `订阅 ${idx + 1}`}</span>
                  <span className="codex-window-reset">重置类型：{item?.resetType || '--'}</span>
                </div>
                <div className="codex-window-meta">
                  {String(item?.resetType || '').toUpperCase() === 'WINDOW' ? (
                    <>
                      <span>已使用：{Math.round(Number(item?.used || 0))}%</span>
                      <span>总额度：{Math.round(Number(item?.limit || 0))}%</span>
                      <span>剩余：{Math.round(Number(item?.remaining || 0))}%</span>
                    </>
                  ) : (
                    <>
                      <span>已使用：{formatQuotaValue(item?.used)}</span>
                      <span>总额度：{formatQuotaValue(item?.limit)}</span>
                      <span>剩余：{formatQuotaValue(item?.remaining)}</span>
                      {Number.isFinite(Number(item?.usagePercentage)) && <span>使用率：{Number(item.usagePercentage).toFixed(4)}%</span>}
                    </>
                  )}
                  {item?.lastResetAt && <span>下次重置：{formatLocalDateTime(item.lastResetAt)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {fetchedAtDisplay && (
          <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>
        )}
      </div>
    );
  }

  if (providerType === 'openai-codex') {
    // Codex 显示积分/Token
    const breakdowns = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    const rateWindows = breakdowns.filter(item => item.resourceType === 'RATE_LIMIT');
    const primaryBreakdown = rateWindows[0] || breakdowns[0];
    const imageQuotaView = buildCodexImageQuotaView(instance.imageUsageSummary, instance.imageError || '');
    if (primaryBreakdown?.remainingPercent !== undefined) {
      remainingPercent = primaryBreakdown.remainingPercent;
    }
    const subscriptionTitle = usage?.subscription?.title || '';
    const tierClassBase = resolveCodexTierClass(subscriptionTitle);
    const tierLabel = formatCodexTierTitle(subscriptionTitle);
    const fullTierClass = subTier && tierClassBase === 'pro'
      ? `pro ${subTier === '20x' ? 'pro-20x' : 'pro-5x'}`
      : tierClassBase;
    const subTierLabel = subTier ? (subTier === '20x' ? '20×' : '5×') : null;

    return (
      <div className="quota-codex">
        <div className="quota-codex-header">
          {tierLabel && tierLabel !== '-' && (
            <span
              className={`codex-tier-badge ${fullTierClass}`}
              title={subTier ? `${tierLabel} · ${subTierLabel} 速度档位` : tierLabel}
            >
              {tierLabel}
              {subTierLabel && <span className="tier-suffix">{subTierLabel}</span>}
            </span>
          )}
          <div className="quota-value">
            <BatteryBar percent={remainingPercent} cellCount={10} />
            <span className="token-display">
              <span className="token-used">{Math.round(used)}</span>
              <span className="token-sep">/</span>
              <span className="token-limit">{limit > 0 ? Math.round(limit) : '∞'}</span>
            </span>
          </div>
        </div>
        {rateWindows.length > 0 && (
          <div className="codex-window-grid">
            {rateWindows.map((item, idx) => {
              const windowRemaining = item.remainingPercent;
              const usedPercent = Number.isFinite(item.usedPercent)
                ? item.usedPercent
                : (windowRemaining != null ? Math.max(0, Math.min(100, 100 - windowRemaining)) : null);
              const resetAfterSeconds = resolveResetAfterSeconds(item);
              const windowSeconds = Number.isFinite(item.limitWindowSeconds) ? item.limitWindowSeconds : null;
              const batteryPercent = windowRemaining != null
                ? windowRemaining
                : (usedPercent != null ? Math.max(0, 100 - usedPercent) : 0);

              return (
                <div key={`${item.displayName || 'window'}-${idx}`} className="codex-window-card">
                  <div className="codex-window-header">
                    <span className="codex-window-title">{resolveCodexWindowLabel(item)}</span>
                    <span className="codex-window-reset">重置时间：{formatLocalDateTime(item.nextDateReset || item.resetAt)}</span>
                  </div>
                  <div className="codex-window-battery">
                    <BatteryBar percent={batteryPercent} cellCount={10} mini />
                  </div>
                  <div className="codex-window-meta">
                    <span>已使用：{usedPercent != null ? `${Math.round(usedPercent)}%` : '--'}</span>
                    <span>距离重置：{resetAfterSeconds != null ? formatDurationSeconds(resetAfterSeconds) : '--'}</span>
                    <span>窗口：{windowSeconds != null ? formatDurationSeconds(windowSeconds) : '--'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {imageQuotaView && (
          <div className={`codex-image-panel ${imageQuotaView.tone}`}>
            <div className="codex-image-panel-header">
              <span className="codex-image-panel-title">图片额度</span>
              <span className={`codex-image-panel-value ${imageQuotaView.tone}`}>{imageQuotaView.remainingLabel}</span>
            </div>
            {imageQuotaView.metaLabel && (
              <div className="codex-image-panel-meta">
                <span>{imageQuotaView.metaLabel}</span>
              </div>
            )}
          </div>
        )}
        {fetchedAtDisplay && (
          <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>
        )}
      </div>
    );
  }

  if (providerType === 'openai-xai-oauth') {
    const breakdowns = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    const planTitle = usage?.subscription?.title || 'Grok OAuth';
    const normalizedPlan = planTitle.toLowerCase();
    const tierClass = normalizedPlan.includes('super') || normalizedPlan.includes('premium+')
      ? 'ultra'
      : (normalizedPlan.includes('premium') || normalizedPlan.includes('pro') ? 'pro' : 'free');
    const creditBalance = usage?.creditBalance;
    const nextReset = usage?.nextDateReset || null;
    const quotaUnavailable = usage?.quotaUnavailable === true;
    const quotaMessage = usage?.quotaMessage || 'API 访问正常，上游未提供账户额度明细';
    const meteredBreakdowns = breakdowns.filter(item => (
      item?.usedPercent !== null
      && item?.usedPercent !== undefined
      && Number.isFinite(Number(item.usedPercent))
    ));
    const breakdownSummary = meteredBreakdowns.length > 0
      ? `${meteredBreakdowns.length} 项套餐额度`
      : (breakdowns.length > 0 ? '套餐额度未公开' : null);

    return (
      <div className="quota-gemini">
        <div className="quota-summary">
          <span className={`kiro-tier-badge ${tierClass}`}>{planTitle}</span>
          {breakdownSummary && <span className="model-count">{breakdownSummary}</span>}
          {creditBalance && (
            <span className="model-count">
              {creditBalance.label || '按量付费余额'} {creditBalance.remaining} {creditBalance.unit}
            </span>
          )}
          {nextReset && (
            <span className="quota-reset-time">重置: {formatLocalDateTime(nextReset)}</span>
          )}
        </div>
        {breakdowns.length > 0 && (
          <div className="quota-models-list">
            {breakdowns.map((item, idx) => {
              const usedPercent = item.usedPercent === null || item.usedPercent === undefined
                ? null
                : Number(item.usedPercent);
              const hasPercent = Number.isFinite(usedPercent);
              const remaining = hasPercent
                ? Math.max(0, 100 - usedPercent)
                : Number(item.remainingPercent);
              return (
                <div key={`${item.subscriptionId || item.displayName}-${idx}`} className="quota-model-row">
                  <span className="model-name" title={item.displayName}>{item.displayName}</span>
                  {hasPercent ? (
                    <>
                      <BatteryBar percent={Number.isFinite(remaining) ? remaining : 0} cellCount={10} mini />
                      <span className="model-reset">
                        {Math.round(usedPercent)}% 已用 · 剩余 {Math.round(Number.isFinite(remaining) ? remaining : 0)}%
                      </span>
                    </>
                  ) : (
                    <span className="quota-unmetered">上游未提供用量比例</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {quotaUnavailable && (
          <span className="quota-unsupported">{quotaMessage}</span>
        )}
        {!quotaUnavailable && breakdowns.length === 0 && !creditBalance && (
          <span className="quota-unsupported">暂无配额数据</span>
        )}
        {fetchedAtDisplay && (
          <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>
        )}
      </div>
    );
  }

  if (providerType === 'claude-windsurf') {
    const breakdowns = usage?.usageBreakdown || [];
    const planTitle = usage?.subscription?.title || 'Windsurf';
    const overageCap = usage?.subscription?.overageCapability || null;
    const tierClass = planTitle.toLowerCase().includes('pro') ? 'pro'
      : planTitle.toLowerCase().includes('team') ? 'pro-plus'
      : planTitle.toLowerCase().includes('trial') ? 'free'
      : 'free';

    return (
      <div className="quota-kiro">
        <span className={`kiro-tier-badge ${tierClass}`}>{planTitle}</span>
        {overageCap && <span className="quota-overage-cap">{overageCap}</span>}
        <div style={{ marginTop: 8 }}>
          {breakdowns.map((item, idx) => (
            <div key={idx} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                <span>{item.displayName}</span>
                {item.currentUsage != null && item.usageLimit != null
                  ? <span>{item.currentUsage} / {item.usageLimit} {item.unit}</span>
                  : <span>{Math.round(item.remainingPercent ?? 0)}% 剩余</span>
                }
                {item.nextDateReset && <span style={{ color: '#888' }}>重置: {item.nextDateReset}</span>}
              </div>
              <BatteryBar percent={item.remainingPercent ?? 0} cellCount={10} />
            </div>
          ))}
          {breakdowns.length === 0 && <span className="quota-unsupported">暂无配额数据</span>}
        </div>
        {fetchedAtDisplay && <div className="quota-fetched-at">上次刷新: {fetchedAtDisplay}</div>}
      </div>
    );
  }

  return <span className="quota-unsupported">暂无数据</span>;
};

// 通用弹窗组件
function ModalShell({ open, onClose, title, subtitle, size = 'md', children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="providers-modal-overlay" onClick={onClose}>
      <div
        className={`providers-modal-card providers-modal-${size}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="providers-modal-header">
          <div className="providers-modal-header-info">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="providers-modal-close" onClick={onClose} aria-label="关闭">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="providers-modal-body">{children}</div>
        {footer && <div className="providers-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// 批量操作弹窗组件
function BatchOperationModal({ open, providerType, providerTypeKey, onClose, onExecute }) {
  const [selectedOperation, setSelectedOperation] = useState(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [status, setStatus] = useState('');

  const handleExecute = async (operation) => {
    setSelectedOperation(operation);
    setIsExecuting(true);
    setProgress({ current: 0, total: 0 });
    setStatus('准备执行...');

    try {
      await onExecute(operation, (current, total, message) => {
        setProgress({ current, total });
        setStatus(message || `处理中 ${current}/${total}`);
      });
      setStatus('执行完成！');
      setTimeout(() => {
        onClose();
        setIsExecuting(false);
        setSelectedOperation(null);
      }, 1500);
    } catch (error) {
      setStatus(`执行失败: ${error.message}`);
      setIsExecuting(false);
    }
  };

  const handleClose = () => {
    if (!isExecuting) {
      onClose();
      setSelectedOperation(null);
      setIsExecuting(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="批量操作"
      subtitle={`对 ${providerType} 的所有账号执行批量操作`}
      size="sm"
    >
      <div className="batch-operation-modal">
        {!isExecuting ? (
          <div className="operation-buttons">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => handleExecute('refresh-usage')}
              style={{ marginBottom: '10px', width: '100%' }}
            >
              <i className="fas fa-chart-line"></i> 刷新用量
            </button>
            <button
              className="btn btn-info btn-lg"
              onClick={() => handleExecute('health-check')}
              style={{ marginBottom: '10px', width: '100%' }}
            >
              <i className="fas fa-stethoscope"></i> 刷新健康状态
            </button>
            <button
              className="btn btn-warning btn-lg"
              onClick={() => handleExecute('health-check-problem')}
              style={{ marginBottom: '10px', width: '100%' }}
            >
              <i className="fas fa-heartbeat"></i> 检测异常/已删除
            </button>
            {providerTypeKey === 'openai-codex' && (
              <button
                className="btn btn-secondary btn-lg"
                onClick={() => handleExecute('batch-update-check-model')}
                style={{ marginBottom: '10px', width: '100%' }}
              >
                <i className="fas fa-sliders-h"></i> 批量设置检测模型
              </button>
            )}
            {providerTypeKey === 'openai-codex' && (
              <button
                className="btn btn-secondary btn-lg"
                onClick={() => handleExecute('extract-emails')}
                style={{ width: '100%' }}
              >
                <i className="fas fa-envelope"></i> 获取邮箱
              </button>
            )}
          </div>
        ) : (
          <div className="operation-progress">
            <div className="progress-info">
              <p>{status}</p>
              {progress.total > 0 && (
                <p className="progress-text">
                  {progress.current} / {progress.total} ({Math.round((progress.current / progress.total) * 100)}%)
                </p>
              )}
            </div>
            {progress.total > 0 && (
              <div className="progress-bar-container">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                ></div>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// 批量删除确认弹窗
function BatchDeleteModal({ open, count, loading, error, onClose, onConfirm }) {
  const handleConfirm = (mode) => {
    if (loading) return;
    onConfirm(mode);
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="批量删除"
      subtitle={`即将删除 ${count} 个账号`}
      size="sm"
      footer={(
        <>
          <button className="btn btn-outline" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button className="btn btn-warning" onClick={() => handleConfirm('soft')} disabled={loading}>
            <i className="fas fa-trash" /> 软删除
          </button>
          <button className="btn btn-danger" onClick={() => handleConfirm('hard')} disabled={loading}>
            <i className="fas fa-skull-crossbones" /> 硬删除
          </button>
        </>
      )}
    >
      <div className="batch-delete-modal">
        <p className="batch-delete-note">软删除仅标记删除，可在列表中查看。</p>
        <p className="batch-delete-warning">硬删除会清理凭据与 OAuth 关联数据，且不可恢复。</p>
        {error && <div className="batch-delete-error">{error}</div>}
      </div>
    </ModalShell>
  );
}

function RemoteAvailableModelsTab({ account, providerType, onRefreshed }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const models = Array.isArray(account?.availableModels) ? account.availableModels
    : Array.isArray(account?.available_models) ? account.available_models : [];
  const isXai = providerType === 'openai-xai-oauth';
  const endpoint = isXai ? '/api/xai/refresh-models' : '/api/windsurf/refresh-models';
  const providerLabel = isXai ? 'Grok' : 'Windsurf';

  const handleRefresh = async () => {
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ uuid: account.uuid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || data.message || '刷新失败');
      }
      setUpdatedAt(data.updatedAt);
      onRefreshed?.(data.models);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="detail-group">
      <div className="detail-group-title">
        可用模型列表
        <button
          type="button"
          className="btn-header-action"
          style={{ marginLeft: 12 }}
          onClick={handleRefresh}
          disabled={loading}
        >
          <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-sync'}`} />
          <span>{loading ? '拉取中...' : `从 ${providerLabel} 云端刷新`}</span>
        </button>
      </div>
      <div className="config-form">
        <small className="form-hint">
          {isXai
            ? '调用 Grok CLI /v1/models 获取该账号实际可见的模型列表，刷新后持久化入库。'
            : '调用 GetCascadeModelConfigs 接口获取该账号实际可见的模型列表，刷新后持久化入库。'}
          {updatedAt && <span style={{ marginLeft: 8, color: '#888' }}>上次刷新: {new Date(updatedAt).toLocaleString('zh-CN')}</span>}
        </small>
        {error && <div style={{ color: '#e53e3e', margin: '8px 0', fontSize: 13 }}>{error}</div>}
        {models.length === 0 ? (
          <div style={{ padding: '16px 0', color: '#888' }}>
            暂无缓存模型记录，点击上方按钮从 {providerLabel} 云端拉取。
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>共 {models.length} 个模型</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0' }}>
              {models.map((model, idx) => (
                <span
                  key={`${model}-${idx}`}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    background: '#eef4ff',
                    color: '#1d4ed8',
                    fontSize: 12,
                    fontFamily: 'monospace',
                  }}
                >
                  {model}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ProviderDetail() {
  const { providerType } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const poolId = searchParams.get('pool');
  const poolName = searchParams.get('poolName') || '默认池';
  const accountParam = searchParams.get('account');
  const tabParam = searchParams.get('tab');
  const isClaudeCustom = providerType === 'claude-custom';
  const isClaudeOffical = providerType === 'claude-offical';
  const isClaudeAntigravity = providerType === 'claude-antigravity';

  const [pools, setPools] = useState([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('healthy');
  const [sortBy, setSortBy] = useState('created_desc');
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [advancedFilterOpen, setAdvancedFilterOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [toast, setToast] = useState(null);
  const sortDropdownRef = useRef(null);
  const advancedFilterRef = useRef(null);
  const toastTimerRef = useRef(null);
  const autoOpenRef = useRef({ account: null, tab: null });
  const [checkingIds, setCheckingIds] = useState(new Set());
  const [refreshingTokenIds, setRefreshingTokenIds] = useState(new Set());
  const [batchCheckModel, setBatchCheckModel] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [showCreatePool, setShowCreatePool] = useState(false);
  const [showChannelConfig, setShowChannelConfig] = useState(false);
  const [channelConfigTab, setChannelConfigTab] = useState('basic');
  const [codexAutoReplenishRunning, setCodexAutoReplenishRunning] = useState(false);
  const [codexAutoReplenishResult, setCodexAutoReplenishResult] = useState(null);
  const [dispatchLogs, setDispatchLogs] = useState([]);
  const [dispatchLogsLoading, setDispatchLogsLoading] = useState(false);
  const [dispatchLogsPage, setDispatchLogsPage] = useState(1);
  const [dispatchLogsTotal, setDispatchLogsTotal] = useState(0);
  const [dispatchLogsTotalPages, setDispatchLogsTotalPages] = useState(0);
  const [showDispatchLogs, setShowDispatchLogs] = useState(false);
  const [dispatchLogDetail, setDispatchLogDetail] = useState(null);
  const [channelConfig, setChannelConfig] = useState({
    defaultModel: '', disabledModels: [], poolRouting: DEFAULT_POOL_ROUTING, cacheSimulationEnabled: true, modelMapping: {},
    usageRefreshEnabled: 'global', // 'global' | true | false
    healthCheckEnabled: 'global', // 'global' | true | false
    codexOpenAIChatCompatEnabled: false,
    codexClaudeMessagesCompatEnabled: false,
    codexClaudeMessagesModelMapping: { ...DEFAULT_CODEX_CLAUDE_MESSAGES_MODEL_MAPPING },
    codexClaudeMessagesReasoningEffort: 'auto',
    codexClaudeMessagesVerbosity: 'default',
    codexClaudeMessagesServiceTier: 'standard',
    codexClaudeMessagesPromptCacheEnabled: true,
    // '' = auto, 'true' = official API, 'false' = Grok Build
    XAI_USING_API: '',
    xaiClaudeMessagesDefaultModel: 'grok-4.5',
    xaiClaudeMessagesModelMapping: { ...DEFAULT_XAI_CLAUDE_MESSAGES_MODEL_MAPPING },
    codexImageGenerationEnabled: true,
    codexImageGenerationMode: 'responses-tool',
    codexStrictRequestAlignment: false,
    codexStickySessionEnabled: true,
    codexHighConcurrencyUserIds: DEFAULT_CODEX_HIGH_CONCURRENCY_USER_IDS,
    codexBlacklistedNewApiUserIds: [],
    codexAutoReplenishEnabled: false,
    codexAutoReplenishMode: 'native',
    codexAutoReplenishScriptPath: '',
    codexAutoReplenishPythonBin: 'python3',
    codexAutoReplenishDuckMailApiBase: 'https://api.duckmail.sbs',
    codexAutoReplenishDuckMailApiKey: '',
    codexAutoReplenishDuckMailDomain: '',
    codexAutoReplenishProxy: '',
    codexAutoReplenishPoolId: '',
    codexAutoReplenishThreshold: 50,
    codexAutoReplenishBatchSize: 10,
    codexAutoReplenishTimeoutSeconds: 180,
    codexAutoReplenishUseProxyPool: false,
    codexAutoReplenishProxyNodeIds: [],
    // claude-offical 调度配置（渠道级默认值）
    officialStickySessionEnabled: true,
    officialStickySessionTtlMinutes: 60,
    officialSessionBindingStrict: false,
    officialStickyIdentityMode: 'session-or-fingerprint',
    officialFingerprintIncludeUser: true,
    officialFingerprintIncludeToken: true,
    officialFingerprintIncludePath: false,
    officialFingerprintSalt: '',
    officialQueueLockEnabled: true,
    officialQueueLockTtlMs: 120000,
    officialQueueWaitTimeoutMs: 30000,
    officialQueuePollIntervalMs: 150,
    officialValidationBlockMinutes: 30,
    officialRateLimitCooldownMs: 30000,
    officialOverloadCooldownMs: 60000,
    officialContextL1Threshold: 0.40,
    officialContextL2Threshold: 0.55,
    officialContextL3Threshold: 0.70,
    officialAutoStopOnWarning: false,
    // claude-antigravity 调度配置（渠道级默认值）
    antigravityStickySessionEnabled: true,
    antigravityStickySessionTtlMinutes: 60,
    antigravitySessionBindingStrict: false,
    antigravityStickyIdentityMode: 'session-or-fingerprint',
    antigravityFingerprintIncludeUser: true,
    antigravityFingerprintIncludeToken: true,
    antigravityFingerprintIncludePath: false,
    antigravityFingerprintSalt: '',
  });
  const [newMappingFrom, setNewMappingFrom] = useState('');
  const [newMappingTo, setNewMappingTo] = useState('');
  const [newCompatMappingFrom, setNewCompatMappingFrom] = useState('');
  const [newCompatMappingTo, setNewCompatMappingTo] = useState('');
  const [channelModelOptions, setChannelModelOptions] = useState([]);
  const [savingChannelConfig, setSavingChannelConfig] = useState(false);
  const [newPoolName, setNewPoolName] = useState('');
  const [newPoolIsDefault, setNewPoolIsDefault] = useState(false);
  const [creatingPool, setCreatingPool] = useState(false);
  const [editingPool, setEditingPool] = useState(null);
  const [editPoolName, setEditPoolName] = useState('');
  const [editPoolIsDefault, setEditPoolIsDefault] = useState(false);
  const [editPoolStrategy, setEditPoolStrategy] = useState('round-robin');
  const [editPoolIsEnabled, setEditPoolIsEnabled] = useState(true);
  const [editPoolUseProxy, setEditPoolUseProxy] = useState(false);
  const [editPoolProxyNodeIds, setEditPoolProxyNodeIds] = useState([]);
  const [editPoolCodexHighConcurrencyUserIds, setEditPoolCodexHighConcurrencyUserIds] = useState([]);
  const [proxyNodes, setProxyNodes] = useState([]);
  const [proxyNodesLoading, setProxyNodesLoading] = useState(false);
  const [editPoolSupportedModels, setEditPoolSupportedModels] = useState([]);
  const [editPoolNotSupportedModels, setEditPoolNotSupportedModels] = useState([]);
  const [editPoolUserMaxConcurrency, setEditPoolUserMaxConcurrency] = useState(0);
  const [editPoolAccountMaxConcurrency, setEditPoolAccountMaxConcurrency] = useState(0);
  const [editPoolEnableUserConcurrencyLimit, setEditPoolEnableUserConcurrencyLimit] = useState(false);
  const [editPoolEnableAccountConcurrencyLimit, setEditPoolEnableAccountConcurrencyLimit] = useState(false);
  const [editPoolProviderMaxConcurrency, setEditPoolProviderMaxConcurrency] = useState(0);
  const [editPoolProviderAccountMaxConcurrency, setEditPoolProviderAccountMaxConcurrency] = useState(0);
  const [editPoolEnableProviderConcurrencyLimit, setEditPoolEnableProviderConcurrencyLimit] = useState(false);
  const [editPoolEnableProviderAccountConcurrencyLimit, setEditPoolEnableProviderAccountConcurrencyLimit] = useState(false);
  const [editPoolEnableSessionLimit, setEditPoolEnableSessionLimit] = useState(false);
  const [editPoolMaxSessionsPerAccount, setEditPoolMaxSessionsPerAccount] = useState(0);
  const [editPoolEnableHealthCheck, setEditPoolEnableHealthCheck] = useState(true);
  const [poolModelList, setPoolModelList] = useState([]);
  const [savingPool, setSavingPool] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newAccountData, setNewAccountData] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(20);
  const [totalCount, setTotalCount] = useState(0);
  const [totalActiveCount, setTotalActiveCount] = useState(0);
  const [healthyCount, setHealthyCount] = useState(0);
  const [cooldownCount, setCooldownCount] = useState(0);
  const [unhealthyCountState, setUnhealthyCountState] = useState(0);
  const [disabledCount, setDisabledCount] = useState(0);
  const [deletedCount, setDeletedCount] = useState(0);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [detailTab, setDetailTab] = useState('info');
  const [manualTestModel, setManualTestModel] = useState('gpt-5.3-codex');
  const [manualTestResult, setManualTestResult] = useState(null);
  const [tokenStats, setTokenStats] = useState(null);
  const [tokenStatsLoading, setTokenStatsLoading] = useState(false);
  const [tokenStatsRebuilding, setTokenStatsRebuilding] = useState(false);
  const [batchOperationModal, setBatchOperationModal] = useState(false);
  const [usageDataMap, setUsageDataMap] = useState({}); // { uuid: { data, loading, error } }
  const [quotaDebugModalOpen, setQuotaDebugModalOpen] = useState(false);
  const [quotaDebugLoading, setQuotaDebugLoading] = useState(false);
  const [quotaDebugResult, setQuotaDebugResult] = useState(null);
  const [quotaDebugError, setQuotaDebugError] = useState('');
  const [editFormData, setEditFormData] = useState({}); // 编辑表单数据
  const isClaudeCustomNewApi = isClaudeCustom
    && String(editFormData.claudeCustomSystemType || 'self-developed').toLowerCase() === 'newapi';
  const [savingAccount, setSavingAccount] = useState(false);
  const [oauthCredential, setOauthCredential] = useState(null); // OAuth凭据数据
  const [loadingCredential, setLoadingCredential] = useState(false);
  const [editCredentialData, setEditCredentialData] = useState({}); // 凭据编辑数据
  const [savingCredential, setSavingCredential] = useState(false);
  const [selectedUuids, setSelectedUuids] = useState(new Set()); // 批量选择
  const [batchLoading, setBatchLoading] = useState(false); // 批量操作loading
  const [batchSelectLoading, setBatchSelectLoading] = useState(false);
  const [batchTargetPoolId, setBatchTargetPoolId] = useState('');
  const [selectAllSnapshot, setSelectAllSnapshot] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false); // 凭证同步loading
  const [showSyncModal, setShowSyncModal] = useState(false); // 同步弹窗
  const [syncTargetPoolId, setSyncTargetPoolId] = useState(''); // 同步目标池
  const [syncTargetPools, setSyncTargetPools] = useState([]); // 目标provider的池列表
  const [syncResult, setSyncResult] = useState(null); // 同步结果
  const [batchDeleteModal, setBatchDeleteModal] = useState(false);
  const [batchDeleteError, setBatchDeleteError] = useState('');
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');
  const [filterDeleteModal, setFilterDeleteModal] = useState(false);
  const [filterDeleteError, setFilterDeleteError] = useState('');
  const [filterDeleteLoading, setFilterDeleteLoading] = useState(false);

  // 错误历史状态
  const [errorLogs, setErrorLogs] = useState([]);
  const [errorLogsLoading, setErrorLogsLoading] = useState(false);
  const [errorLogsPage, setErrorLogsPage] = useState(1);
  const [errorLogsTotal, setErrorLogsTotal] = useState(0);
  const [errorLogsTotalPages, setErrorLogsTotalPages] = useState(0);
  const [errorDetailLog, setErrorDetailLog] = useState(null); // 错误详情弹窗
  const [activeUsers, setActiveUsers] = useState([]); // 实时用户列表
  const [activeUsersLoading, setActiveUsersLoading] = useState(false);
  const [userSessionCounts, setUserSessionCounts] = useState({}); // 用户 session 计数
  const [userConcurrencyMap, setUserConcurrencyMap] = useState({});
  const [userPeakConcurrencyMap, setUserPeakConcurrencyMap] = useState({});
  const [accountCurrentConcurrency, setAccountCurrentConcurrency] = useState(0);
  const [accountPeakConcurrency, setAccountPeakConcurrency] = useState(0);
  const [accountActiveUserCount, setAccountActiveUserCount] = useState(0);
  const [accountUniqueUserCount, setAccountUniqueUserCount] = useState(0);
  const quotaCardPrefetchKeyRef = useRef('');
  const windsurfCardPrefetchKeyRef = useRef('');

  // 状态日志状态
  const [statusLogs, setStatusLogs] = useState([]);
  const [statusLogsLoading, setStatusLogsLoading] = useState(false);
  const [statusLogsPage, setStatusLogsPage] = useState(1);
  const [statusLogsTotal, setStatusLogsTotal] = useState(0);
  const [statusLogsTotalPages, setStatusLogsTotalPages] = useState(0);

  // 请求日志状态
  const [requestLogs, setRequestLogs] = useState([]);
  const [requestLogsLoading, setRequestLogsLoading] = useState(false);
  const [requestLogsPage, setRequestLogsPage] = useState(1);
  const [requestLogsTotal, setRequestLogsTotal] = useState(0);
  const [requestLogsTotalPages, setRequestLogsTotalPages] = useState(0);
  const [requestLogsSummary, setRequestLogsSummary] = useState(null);
  const [requestLogsFilter, setRequestLogsFilter] = useState('all'); // all, success, fail

  // Claude Custom 上游管理状态
  const [upstreamHealth, setUpstreamHealth] = useState(null);
  const [upstreamHealthChecked, setUpstreamHealthChecked] = useState(false);
  const [upstreamHealthError, setUpstreamHealthError] = useState(null);
  const [upstreamProxyStatus, setUpstreamProxyStatus] = useState(null);
  const [upstreamAccounts, setUpstreamAccounts] = useState([]);
  const [upstreamLoading, setUpstreamLoading] = useState({
    health: false,
    status: false,
    accounts: false,
    action: false,
  });
  const [upstreamImportToken, setUpstreamImportToken] = useState('');
  const [upstreamSwitchAccountId, setUpstreamSwitchAccountId] = useState('');
  const upstreamWarnedRef = useRef(new Set());
  const upstreamAutoHealthAtRef = useRef(new Map());
  const isUpstreamChannelMode = (editFormData.upstreamMode || 'direct') === 'antigravity-channel';
  const upstreamModeLabel = isUpstreamChannelMode ? '上游反代' : '直连';

  // Kiro 弹窗相关 state
  const [showKiroMethod, setShowKiroMethod] = useState(false);
  const [showKiroBatchImport, setShowKiroBatchImport] = useState(false);
  const [showKiroAwsImport, setShowKiroAwsImport] = useState(false);
  const [showCodexMethod, setShowCodexMethod] = useState(false);
  const [showCodexJsonImport, setShowCodexJsonImport] = useState(false);
  const [showGrokMethod, setShowGrokMethod] = useState(false);
  const [showGrokImport, setShowGrokImport] = useState(false);
  const [authModal, setAuthModal] = useState(null);

  // 点击外部关闭下拉框
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target)) {
        setSortDropdownOpen(false);
      }
      if (advancedFilterRef.current && !advancedFilterRef.current.contains(e.target)) {
        setAdvancedFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 弹窗打开时禁用 body 滚动
  useEffect(() => {
    const hasModal = selectedAccount || showCreatePool || editingPool || showAddAccount ||
      showKiroMethod || showKiroBatchImport || showKiroAwsImport ||
      showCodexMethod || showCodexJsonImport || showGrokMethod || showGrokImport ||
      authModal || batchDeleteModal || filterDeleteModal;
    if (hasModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedAccount, showCreatePool, editingPool, showAddAccount,
    showKiroMethod, showKiroBatchImport, showKiroAwsImport,
    showCodexMethod, showCodexJsonImport, showGrokMethod, showGrokImport,
    authModal, batchDeleteModal, filterDeleteModal]);

  const handleGenerateAuthUrl = async (targetProviderType, options = {}) => {
    try {
      const response = await providerService.generateAuthUrl(targetProviderType, options);
      if (response?.success === false) {
        throw new Error(response?.error || '生成授权失败');
      }
      setAuthModal({
        providerType: targetProviderType,
        authUrl: response?.authUrl,
        authInfo: {
          ...response?.authInfo,
          provider: response?.authInfo?.provider || targetProviderType,
        }
      });
    } catch (err) {
      alert(err.message || '生成授权失败');
    }
  };

  const handleManualCallback = async (callbackUrl) => {
    return await providerService.manualCallback(
      authModal?.providerType,
      callbackUrl,
      authModal?.authInfo?.authMethod,
      authModal?.authInfo?.taskId
    );
  };

  const handleAuthSuccess = async () => {
    setAuthModal(null);
    await loadProviders();
  };

  // 加载号池列表
  const loadPools = useCallback(async () => {
    try {
      setPoolsLoading(true);
      const data = await providerService.getPools(providerType);
      setPools(data || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setPoolsLoading(false);
    }
  }, [providerType]);

  const showToast = useCallback((type, message, duration = 3200) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast({ type, message });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  const loadProxyNodes = useCallback(async () => {
    try {
      setProxyNodesLoading(true);
      const result = await proxyPoolService.getNodes();
      const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
      setProxyNodes(nodes);
    } catch {
      setProxyNodes([]);
    } finally {
      setProxyNodesLoading(false);
    }
  }, []);

  // 加载账号列表
  const loadProviders = useCallback(async () => {
    if (poolId === null) return;
    try {
      setProvidersLoading(true);
      const opts = {
        filter: filter,
        page: currentPage,
        pageSize: pageSize,
        poolId: poolId,
      };
      if (createdAfter) opts.createdAfter = createdAfter + ' 00:00:00';
      if (createdBefore) opts.createdBefore = createdBefore + ' 23:59:59';
      const result = await providerService.getByType(providerType, opts);
      const list = result?.providers || [];
      console.log('[DEBUG] loadProviders - result:', result);
      console.log('[DEBUG] loadProviders - result.totalCount:', result?.totalCount);
      const includeDeleted = showDeleted || filter === 'deleted' || filter === 'all';
      const filtered = includeDeleted ? list : list.filter(p => !p.isDeleted);
      setProviders(filtered);
      const resolvedTotalCount = result?.totalCount ?? 0;
      const resolvedHealthyCount = result?.healthyCount ?? 0;
      const resolvedDisabledCount = result?.disabledCount ?? 0;
      const resolvedDeletedCount = result?.deletedCount ?? 0;
      const resolvedCooldownCount = result?.cooldownCount ?? 0;
      const resolvedUnhealthyCount = result?.unhealthyCount
        ?? Math.max((resolvedTotalCount || 0) - (resolvedHealthyCount || 0) - (resolvedDisabledCount || 0) - (resolvedCooldownCount || 0), 0);
      const resolvedTotalWithDeleted = result?.totalWithDeleted
        ?? resolvedTotalCount + resolvedDeletedCount;
      const resolvedTotalActive = Math.max(resolvedTotalWithDeleted - resolvedDeletedCount, 0);

      setTotalCount(resolvedTotalCount);
      setHealthyCount(resolvedHealthyCount);
      setCooldownCount(resolvedCooldownCount);
      setUnhealthyCountState(resolvedUnhealthyCount);
      setDisabledCount(resolvedDisabledCount);
      setDeletedCount(resolvedDeletedCount);
      setTotalActiveCount(resolvedTotalActive);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setProvidersLoading(false);
    }
  }, [providerType, poolId, showDeleted, currentPage, pageSize, filter, createdAfter, createdBefore]);

  useEffect(() => {
    setUsageDataMap({});
    quotaCardPrefetchKeyRef.current = '';
    windsurfCardPrefetchKeyRef.current = '';
  }, [providerType, poolId]);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  // 加载渠道配置
  const loadChannelConfig = useCallback(async () => {
    try {
      const result = await channelConfigService.getByProviderType(providerType);
      if (result?.config) {
        const cfg = result.config.config || {};
        setChannelConfig(prev => ({
          ...prev,
          defaultModel: result.config.defaultModel || '',
          disabledModels: cfg.disabledModels || [],
          poolRouting: normalizePoolRouting(cfg.poolRouting),
          cacheSimulationEnabled: cfg.cacheSimulationEnabled !== false,
          modelMapping: cfg.modelMapping || {},
          // claude-offical 调度配置
          officialStickySessionEnabled: cfg.officialStickySessionEnabled ?? true,
          officialStickySessionTtlMinutes: cfg.officialStickySessionTtlMinutes ?? 60,
          officialSessionBindingStrict: cfg.officialSessionBindingStrict ?? false,
          officialStickyIdentityMode: cfg.officialStickyIdentityMode || 'session-or-fingerprint',
          officialFingerprintIncludeUser: cfg.officialFingerprintIncludeUser ?? true,
          officialFingerprintIncludeToken: cfg.officialFingerprintIncludeToken ?? true,
          officialFingerprintIncludePath: cfg.officialFingerprintIncludePath ?? false,
          officialFingerprintSalt: cfg.officialFingerprintSalt || '',
          officialQueueLockEnabled: cfg.officialQueueLockEnabled ?? true,
          officialQueueLockTtlMs: cfg.officialQueueLockTtlMs ?? 120000,
          officialQueueWaitTimeoutMs: cfg.officialQueueWaitTimeoutMs ?? 30000,
          officialQueuePollIntervalMs: cfg.officialQueuePollIntervalMs ?? 150,
          officialValidationBlockMinutes: cfg.officialValidationBlockMinutes ?? 30,
          officialRateLimitCooldownMs: cfg.officialRateLimitCooldownMs ?? 30000,
          officialOverloadCooldownMs: cfg.officialOverloadCooldownMs ?? 60000,
          officialContextL1Threshold: cfg.officialContextL1Threshold ?? 0.40,
          officialContextL2Threshold: cfg.officialContextL2Threshold ?? 0.55,
          officialContextL3Threshold: cfg.officialContextL3Threshold ?? 0.70,
          officialAutoStopOnWarning: cfg.officialAutoStopOnWarning ?? false,
          antigravityStickySessionEnabled: cfg.antigravityStickySessionEnabled ?? true,
          antigravityStickySessionTtlMinutes: cfg.antigravityStickySessionTtlMinutes ?? 60,
          antigravitySessionBindingStrict: cfg.antigravitySessionBindingStrict ?? false,
          antigravityStickyIdentityMode: cfg.antigravityStickyIdentityMode || 'session-or-fingerprint',
          antigravityFingerprintIncludeUser: cfg.antigravityFingerprintIncludeUser ?? true,
          antigravityFingerprintIncludeToken: cfg.antigravityFingerprintIncludeToken ?? true,
          antigravityFingerprintIncludePath: cfg.antigravityFingerprintIncludePath ?? false,
          antigravityFingerprintSalt: cfg.antigravityFingerprintSalt || '',
          usageRefreshEnabled: cfg.usageRefreshEnabled ?? 'global',
          healthCheckEnabled: cfg.healthCheckEnabled ?? 'global',
          codexOpenAIChatCompatEnabled: cfg.codexOpenAIChatCompatEnabled ?? false,
          codexClaudeMessagesCompatEnabled: cfg.codexClaudeMessagesCompatEnabled ?? false,
          codexClaudeMessagesModelMapping: {
            ...DEFAULT_CODEX_CLAUDE_MESSAGES_MODEL_MAPPING,
            ...(cfg.codexClaudeMessagesModelMapping || {}),
          },
          codexClaudeMessagesReasoningEffort: cfg.codexClaudeMessagesReasoningEffort || 'auto',
          codexClaudeMessagesVerbosity: cfg.codexClaudeMessagesVerbosity || 'default',
          codexClaudeMessagesServiceTier: cfg.codexClaudeMessagesServiceTier || 'standard',
          codexClaudeMessagesPromptCacheEnabled: cfg.codexClaudeMessagesPromptCacheEnabled ?? true,
          XAI_USING_API: (() => {
            const raw = cfg.XAI_USING_API ?? cfg.xaiUsingApi ?? '';
            if (raw === true || raw === 'true' || raw === 1 || raw === '1') return 'true';
            if (raw === false || raw === 'false' || raw === 0 || raw === '0') return 'false';
            return '';
          })(),
          xaiClaudeMessagesDefaultModel: cfg.xaiClaudeMessagesDefaultModel || 'grok-4.5',
          xaiClaudeMessagesModelMapping: {
            ...DEFAULT_XAI_CLAUDE_MESSAGES_MODEL_MAPPING,
            ...(cfg.xaiClaudeMessagesModelMapping || {}),
          },
          codexImageGenerationEnabled: cfg.codexImageGenerationEnabled !== false,
          codexImageGenerationMode: cfg.codexImageGenerationMode === 'web-conversation' ? 'web-conversation' : 'responses-tool',
          codexStrictRequestAlignment: cfg.codexStrictRequestAlignment === true,
          codexStickySessionEnabled: cfg.codexStickySessionEnabled ?? true,
          codexHighConcurrencyUserIds: normalizeCodexHighConcurrencyUserIds(cfg.codexHighConcurrencyUserIds),
          codexBlacklistedNewApiUserIds: normalizeIdentityList(cfg.codexBlacklistedNewApiUserIds),
          codexAutoReplenishEnabled: cfg.codexAutoReplenishEnabled ?? false,
          codexAutoReplenishMode: cfg.codexAutoReplenishMode || ((cfg.codexAutoReplenishScriptPath || '').toLowerCase().endsWith('.py') ? 'script' : 'native'),
          codexAutoReplenishScriptPath: cfg.codexAutoReplenishScriptPath || '',
          codexAutoReplenishPythonBin: cfg.codexAutoReplenishPythonBin || 'python3',
          codexAutoReplenishDuckMailApiBase: cfg.codexAutoReplenishDuckMailApiBase || 'https://api.duckmail.sbs',
          codexAutoReplenishDuckMailApiKey: cfg.codexAutoReplenishDuckMailApiKey || '',
          codexAutoReplenishDuckMailDomain: cfg.codexAutoReplenishDuckMailDomain || '',
          codexAutoReplenishProxy: cfg.codexAutoReplenishProxy || '',
          codexAutoReplenishPoolId: cfg.codexAutoReplenishPoolId ?? (poolId ?? ''),
          codexAutoReplenishThreshold: cfg.codexAutoReplenishThreshold ?? cfg.codexAutoReplenishMinHealthy ?? 50,
          codexAutoReplenishBatchSize: cfg.codexAutoReplenishBatchSize ?? 10,
          codexAutoReplenishTimeoutSeconds: cfg.codexAutoReplenishTimeoutSeconds ?? 180,
          codexAutoReplenishUseProxyPool: cfg.codexAutoReplenishUseProxyPool ?? false,
          codexAutoReplenishProxyNodeIds: Array.isArray(cfg.codexAutoReplenishProxyNodeIds) ? cfg.codexAutoReplenishProxyNodeIds : [],
        }));
      }
    } catch (err) {
      console.error('Failed to load channel config:', err);
    }
  }, [providerType, poolId]);

  // 加载渠道调度日志
  const loadDispatchLogs = useCallback(async (page = 1) => {
    setDispatchLogsLoading(true);
    try {
      const result = await channelDispatchLogsService.getChannelDispatchLogs(providerType, {
        page,
        pageSize: 20
      });
      setDispatchLogs(result.data || []);
      setDispatchLogsTotal(result.total || 0);
      setDispatchLogsTotalPages(result.totalPages || 0);
      setDispatchLogsPage(page);
    } catch (err) {
      console.error('Failed to load dispatch logs:', err);
      setDispatchLogs([]);
    } finally {
      setDispatchLogsLoading(false);
    }
  }, [providerType]);

  const clearDispatchLogs = async () => {
    if (!window.confirm('确定清空所有调度日志？')) return;
    try {
      await channelDispatchLogsService.clearChannelDispatchLogs(providerType);
      setDispatchLogs([]);
      setDispatchLogsTotal(0);
      setDispatchLogsTotalPages(0);
      setDispatchLogsPage(1);
    } catch (err) {
      console.error('Failed to clear dispatch logs:', err);
    }
  };

  const loadChannelModels = useCallback(async () => {
    if (providerType === 'claude-kiro-oauth') {
      setChannelModelOptions(buildModelOptions(KIRO_DEFAULT_MODEL_LIST));
      return;
    }
    let models = [];
    try {
      const payload = await providerService.getTypeModels(providerType);
      models = normalizeModelPayload(payload);
    } catch (err) {
      console.error('Failed to load provider models:', err);
    }

    if (models.length === 0) {
      try {
        const payload = await providerService.getModels();
        const resolved = payload?.data ?? payload;
        if (Array.isArray(resolved?.[providerType])) {
          models = resolved[providerType];
        }
      } catch (err) {
        console.error('Failed to load provider model map:', err);
      }
    }

    if (models.length === 0) {
      if (providerType === 'openai-codex') {
        models = CODEX_FALLBACK_MODELS;
      } else if (providerType === 'openai-xai-oauth') {
        models = XAI_FALLBACK_MODELS;
      }
    }

    setChannelModelOptions(buildModelOptions(models));
  }, [providerType]);

  const codexAutoReplenishSettings = useMemo(() => ({
    codexAutoReplenishEnabled: channelConfig.codexAutoReplenishEnabled === true,
    codexAutoReplenishMode: channelConfig.codexAutoReplenishMode === 'script' ? 'script' : 'native',
    codexAutoReplenishScriptPath: channelConfig.codexAutoReplenishScriptPath || '',
    codexAutoReplenishPythonBin: channelConfig.codexAutoReplenishPythonBin || 'python3',
    codexAutoReplenishDuckMailApiBase: channelConfig.codexAutoReplenishDuckMailApiBase || 'https://api.duckmail.sbs',
    codexAutoReplenishDuckMailApiKey: channelConfig.codexAutoReplenishDuckMailApiKey || '',
    codexAutoReplenishDuckMailDomain: channelConfig.codexAutoReplenishDuckMailDomain || '',
    codexAutoReplenishProxy: channelConfig.codexAutoReplenishProxy || '',
    codexAutoReplenishPoolId: channelConfig.codexAutoReplenishPoolId === '' ? null : (Number(channelConfig.codexAutoReplenishPoolId) || null),
    codexAutoReplenishThreshold: Number(channelConfig.codexAutoReplenishThreshold) || 50,
    codexAutoReplenishBatchSize: Number(channelConfig.codexAutoReplenishBatchSize) || 10,
    codexAutoReplenishTimeoutSeconds: Number(channelConfig.codexAutoReplenishTimeoutSeconds) || 180,
    codexAutoReplenishUseProxyPool: channelConfig.codexAutoReplenishUseProxyPool === true,
    codexAutoReplenishProxyNodeIds: Array.isArray(channelConfig.codexAutoReplenishProxyNodeIds)
      ? channelConfig.codexAutoReplenishProxyNodeIds.map(item => Number(item)).filter(Number.isFinite)
      : [],
  }), [channelConfig]);

  const persistChannelConfig = useCallback(async (closeOnSuccess = false) => {
    setSavingChannelConfig(true);
    try {
      await channelConfigService.save(providerType, {
        defaultModel: channelConfig.defaultModel,
        config: {
          disabledModels: channelConfig.disabledModels,
          poolRouting: channelConfig.poolRouting,
          cacheSimulationEnabled: channelConfig.cacheSimulationEnabled,
          modelMapping: channelConfig.modelMapping,
          usageRefreshEnabled: channelConfig.usageRefreshEnabled ?? 'global',
          healthCheckEnabled: channelConfig.healthCheckEnabled ?? 'global',
          ...(providerType === 'openai-codex' ? {
            codexOpenAIChatCompatEnabled: channelConfig.codexOpenAIChatCompatEnabled === true,
            codexClaudeMessagesCompatEnabled: channelConfig.codexClaudeMessagesCompatEnabled === true,
            codexClaudeMessagesModelMapping: channelConfig.codexClaudeMessagesModelMapping || {},
            codexClaudeMessagesReasoningEffort: channelConfig.codexClaudeMessagesReasoningEffort || 'auto',
            codexClaudeMessagesVerbosity: channelConfig.codexClaudeMessagesVerbosity || 'default',
            codexClaudeMessagesServiceTier: channelConfig.codexClaudeMessagesServiceTier || 'standard',
            codexClaudeMessagesPromptCacheEnabled: channelConfig.codexClaudeMessagesPromptCacheEnabled !== false,
            codexImageGenerationEnabled: channelConfig.codexImageGenerationEnabled !== false,
            codexImageGenerationMode: channelConfig.codexImageGenerationMode === 'responses-tool' ? 'responses-tool' : 'web-conversation',
            codexStrictRequestAlignment: channelConfig.codexStrictRequestAlignment === true,
            codexStickySessionEnabled: channelConfig.codexStickySessionEnabled !== false,
            codexHighConcurrencyUserIds: normalizeIdentityList(channelConfig.codexHighConcurrencyUserIds),
            codexBlacklistedNewApiUserIds: normalizeIdentityList(channelConfig.codexBlacklistedNewApiUserIds),
          } : {}),
          ...(providerType === 'openai-xai-oauth' ? {
            XAI_USING_API: channelConfig.XAI_USING_API ?? '',
            xaiUsingApi: channelConfig.XAI_USING_API ?? '',
            xaiClaudeMessagesDefaultModel: channelConfig.xaiClaudeMessagesDefaultModel || 'grok-4.5',
            xaiClaudeMessagesModelMapping: channelConfig.xaiClaudeMessagesModelMapping || {},
          } : {}),
          ...(providerType === 'openai-codex' ? codexAutoReplenishSettings : {}),
          ...(providerType === 'claude-offical' ? {
            officialStickySessionEnabled: channelConfig.officialStickySessionEnabled,
            officialStickySessionTtlMinutes: Number(channelConfig.officialStickySessionTtlMinutes) || 60,
            officialSessionBindingStrict: channelConfig.officialSessionBindingStrict,
            officialStickyIdentityMode: channelConfig.officialStickyIdentityMode,
            officialFingerprintIncludeUser: channelConfig.officialFingerprintIncludeUser,
            officialFingerprintIncludeToken: channelConfig.officialFingerprintIncludeToken,
            officialFingerprintIncludePath: channelConfig.officialFingerprintIncludePath,
            officialFingerprintSalt: channelConfig.officialFingerprintSalt,
            officialQueueLockEnabled: channelConfig.officialQueueLockEnabled,
            officialQueueLockTtlMs: Number(channelConfig.officialQueueLockTtlMs) || 120000,
            officialQueueWaitTimeoutMs: Number(channelConfig.officialQueueWaitTimeoutMs) || 30000,
            officialQueuePollIntervalMs: Number(channelConfig.officialQueuePollIntervalMs) || 150,
            officialValidationBlockMinutes: Number(channelConfig.officialValidationBlockMinutes) || 30,
            officialRateLimitCooldownMs: Number(channelConfig.officialRateLimitCooldownMs) || 30000,
            officialOverloadCooldownMs: Number(channelConfig.officialOverloadCooldownMs) || 60000,
            officialContextL1Threshold: Number(channelConfig.officialContextL1Threshold) || 0.40,
            officialContextL2Threshold: Number(channelConfig.officialContextL2Threshold) || 0.55,
            officialContextL3Threshold: Number(channelConfig.officialContextL3Threshold) || 0.70,
            officialAutoStopOnWarning: channelConfig.officialAutoStopOnWarning,
          } : {}),
          ...(providerType === 'claude-antigravity' ? {
            antigravityStickySessionEnabled: channelConfig.antigravityStickySessionEnabled,
            antigravityStickySessionTtlMinutes: Number(channelConfig.antigravityStickySessionTtlMinutes) || 60,
            antigravitySessionBindingStrict: channelConfig.antigravitySessionBindingStrict,
            antigravityStickyIdentityMode: channelConfig.antigravityStickyIdentityMode,
            antigravityFingerprintIncludeUser: channelConfig.antigravityFingerprintIncludeUser,
            antigravityFingerprintIncludeToken: channelConfig.antigravityFingerprintIncludeToken,
            antigravityFingerprintIncludePath: channelConfig.antigravityFingerprintIncludePath,
            antigravityFingerprintSalt: channelConfig.antigravityFingerprintSalt,
          } : {})
        }
      });

      if (closeOnSuccess) {
        setShowChannelConfig(false);
      }
      return true;
    } catch (err) {
      showToast('error', `保存失败: ${err.message}`);
      return false;
    } finally {
      setSavingChannelConfig(false);
    }
  }, [channelConfig, codexAutoReplenishSettings, providerType, showToast]);

  // 保存渠道配置
  const saveChannelConfig = async () => {
    const success = await persistChannelConfig(true);
    if (success) {
      const routeHint = providerType === 'openai-xai-oauth'
        ? (channelConfig.XAI_USING_API === 'true'
          ? '已切换为官方 API（api.x.ai），并同步全部账号'
          : channelConfig.XAI_USING_API === 'false'
            ? '已切换为 Grok Build（cli-chat-proxy），并同步全部账号'
            : '已恢复自动路由（按 Token 权限），并同步全部账号')
        : '渠道配置已保存';
      showToast('success', routeHint);
      if (providerType === 'openai-xai-oauth') {
        try { await loadProviders(); } catch (_err) { /* ignore */ }
      }
    }
  };

  const triggerCodexAutoReplenish = useCallback(async () => {
    const persisted = await persistChannelConfig(false);
    if (!persisted) return;

    setCodexAutoReplenishRunning(true);
    try {
      const response = await channelConfigService.triggerAutoReplenish(providerType, {
        force: true,
        targetCount: Number(channelConfig.codexAutoReplenishBatchSize) || 10,
        settings: codexAutoReplenishSettings
      });
      setCodexAutoReplenishResult(response?.result || null);
      showToast('success', '已触发 Codex 自动补号');
      await loadProviders();
    } catch (err) {
      setCodexAutoReplenishResult({ error: err.message });
      showToast('error', `补号失败: ${err.message}`);
    } finally {
      setCodexAutoReplenishRunning(false);
    }
  }, [channelConfig.codexAutoReplenishBatchSize, codexAutoReplenishSettings, loadProviders, persistChannelConfig, providerType, showToast]);

  const updatePoolRouting = useCallback((updater) => {
    setChannelConfig(prev => {
      const current = normalizePoolRouting(prev.poolRouting);
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, poolRouting: next };
    });
  }, []);

  const updateKiroModelRouting = useCallback((model, updates) => {
    updatePoolRouting(current => {
      const rules = Array.isArray(current.rules) ? current.rules : [];
      const nextRules = [];
      let existingRule = null;

      rules.forEach(rule => {
        const models = Array.isArray(rule.models) ? rule.models : [];
        if (models.includes(model)) {
          if (!existingRule) {
            existingRule = rule;
          }
          const remainingModels = models.filter(m => m !== model);
          if (remainingModels.length > 0) {
            nextRules.push({ ...rule, models: remainingModels });
          }
          return;
        }
        nextRules.push(rule);
      });

      const nextPoolIds = updates.poolIds ?? existingRule?.poolIds ?? [];
      const nextStrategy = updates.strategy ?? existingRule?.strategy ?? current.default.strategy;
      const normalizedPoolIds = Array.isArray(nextPoolIds)
        ? nextPoolIds.filter(id => id !== null && id !== undefined)
        : [];

      if (normalizedPoolIds.length > 0) {
        nextRules.push({
          models: [model],
          strategy: nextStrategy,
          poolIds: normalizedPoolIds
        });
      }

      return { ...current, rules: nextRules };
    });
  }, [updatePoolRouting]);

  const togglePoolId = (poolIds, poolIdValue) => {
    const normalized = Array.isArray(poolIds) ? poolIds : [];
    if (normalized.includes(poolIdValue)) {
      return normalized.filter(id => id !== poolIdValue);
    }
    return [...normalized, poolIdValue];
  };

  const addPoolRoutingRule = () => {
    updatePoolRouting(current => ({
      ...current,
      rules: [
        ...current.rules,
        { models: [], strategy: 'priority', poolIds: [] }
      ]
    }));
  };

  const updatePoolRoutingRule = (index, patch) => {
    updatePoolRouting(current => ({
      ...current,
      rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    }));
  };

  const removePoolRoutingRule = (index) => {
    updatePoolRouting(current => ({
      ...current,
      rules: current.rules.filter((_, i) => i !== index)
    }));
  };

  const poolRouting = normalizePoolRouting(channelConfig.poolRouting);
  const kiroRoutingMap = useMemo(() => {
    if (providerType !== 'claude-kiro-oauth') return new Map();
    const map = new Map();
    const rules = Array.isArray(poolRouting.rules) ? poolRouting.rules : [];
    rules.forEach(rule => {
      const models = Array.isArray(rule.models) ? rule.models : [];
      models.forEach(model => {
        if (!KIRO_POOL_ROUTING_MODELS.includes(model) || map.has(model)) return;
        map.set(model, {
          poolIds: Array.isArray(rule.poolIds) ? rule.poolIds : [],
          strategy: rule.strategy || poolRouting.default.strategy
        });
      });
    });
    return map;
  }, [poolRouting.rules, poolRouting.default.strategy, providerType]);
  const defaultModelOptions = useMemo(() => {
    const options = [...channelModelOptions];
    if (channelConfig.defaultModel && !options.some(opt => opt.value === channelConfig.defaultModel)) {
      options.unshift({ value: channelConfig.defaultModel, label: channelConfig.defaultModel });
    }
    return [{ value: '', label: DEFAULT_MODEL_PLACEHOLDER }, ...options];
  }, [channelConfig.defaultModel, channelModelOptions]);

  const routingRuleModelOptions = useMemo(() => {
    return channelModelOptions.filter(option => option?.value);
  }, [channelModelOptions]);

  const routingRuleModelPlaceholder = useMemo(() => {
    if (providerType === 'openai-codex') {
      return '如 gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5';
    }
    const samples = routingRuleModelOptions.slice(0, 2).map(option => option.value);
    if (samples.length > 0) {
      return `如 ${samples.join(', ')}`;
    }
    return '如 model-a, model-b, model-*';
  }, [providerType, routingRuleModelOptions]);

  // 模型映射下拉选项：来源模型（请求模型）
  const mappingFromOptions = useMemo(() => {
    const keys = new Set(channelModelOptions.map(o => o.value));
    // 排除已有映射的 key
    const existing = new Set(Object.keys(channelConfig.modelMapping || {}));
    return Array.from(keys).filter(k => k && !existing.has(k)).sort()
      .map(k => ({ value: k, label: k }));
  }, [channelModelOptions, channelConfig.modelMapping]);

  // 模型映射下拉选项：目标模型（上游模型）
  const mappingToOptions = useMemo(() => {
    const providerTargets = providerType === 'openai-xai-oauth'
      ? channelModelOptions.map(option => option.value)
      : [
        'claude-sonnet-4-5', 'claude-sonnet-4-5-thinking',
        'claude-sonnet-4-6', 'claude-sonnet-4-6-thinking',
        'claude-opus-4-5-thinking', 'claude-opus-4-6-thinking',
        'claude-opus-4-7', 'claude-opus-4.7',
        'claude-opus-4-8', 'claude-opus-4.8',
        'minimax-m2.1',
        'deepseek-3.2',
      ];
    const vals = new Set([
      ...providerTargets,
      ...Object.values(channelConfig.modelMapping || {}),
    ]);
    return Array.from(vals).sort().map(v => ({ value: v, label: v }));
  }, [providerType, channelModelOptions, channelConfig.modelMapping]);

  const compatMappingToOptions = useMemo(() => {
    const compatMapping = providerType === 'openai-xai-oauth'
      ? channelConfig.xaiClaudeMessagesModelMapping
      : channelConfig.codexClaudeMessagesModelMapping;
    const vals = new Set([
      ...channelModelOptions.map(option => option.value),
      ...Object.values(compatMapping || {}),
    ]);
    return Array.from(vals).filter(Boolean).sort().map(value => ({ value, label: value }));
  }, [providerType, channelModelOptions, channelConfig.codexClaudeMessagesModelMapping, channelConfig.xaiClaudeMessagesModelMapping]);

  // 打开渠道配置弹窗时加载配置
  useEffect(() => {
    if (showChannelConfig) {
      setChannelConfigTab('basic');
      setCodexAutoReplenishResult(null);
      loadChannelConfig();
      loadChannelModels();
      if (providerType === 'openai-codex') {
        loadProxyNodes();
      }
    }
  }, [showChannelConfig, loadChannelConfig, loadChannelModels, loadProxyNodes, providerType]);

  // 打开调度日志面板时加载数据
  useEffect(() => {
    if (showDispatchLogs) {
      loadDispatchLogs(1);
    }
  }, [showDispatchLogs, loadDispatchLogs]);

  useEffect(() => {
    if (poolId !== null) {
      loadProviders();
    }
  }, [poolId, loadProviders]);

  useEffect(() => {
    if (!selectedAccount?.uuid) return;
    const updated = providers.find(provider => provider.uuid === selectedAccount.uuid);
    if (updated && updated !== selectedAccount) {
      setSelectedAccount(updated);
    }
  }, [providers, selectedAccount]);

  useEffect(() => {
    setManualTestResult(null);
  }, [selectedAccount?.uuid]);

  const manualTestModels = useMemo(() => {
    if (providerType !== 'openai-xai-oauth') return CODEX_FALLBACK_MODELS;
    const models = Array.isArray(selectedAccount?.availableModels)
      ? selectedAccount.availableModels
      : (Array.isArray(selectedAccount?.available_models) ? selectedAccount.available_models : []);
    return models.length > 0 ? models : XAI_FALLBACK_MODELS;
  }, [providerType, selectedAccount?.availableModels, selectedAccount?.available_models]);

  useEffect(() => {
    const preferredModel = providerType === 'openai-xai-oauth' ? 'grok-4.5' : 'gpt-5.3-codex';
    setManualTestModel(manualTestModels.includes(preferredModel) ? preferredModel : (manualTestModels[0] || preferredModel));
  }, [providerType, selectedAccount?.uuid, manualTestModels]);

  useEffect(() => {
    if (!accountParam || providers.length === 0) return;
    if (autoOpenRef.current.account === accountParam && autoOpenRef.current.tab === tabParam) return;
    const target = providers.find(provider => provider.uuid === accountParam);
    if (!target) return;
    setSelectedAccount(target);
    if (tabParam && ['info', 'config', 'upstream', 'stats', 'quota', 'check', 'requests', 'errors', 'status', 'users'].includes(tabParam)) {
      setDetailTab(tabParam);
    }
    autoOpenRef.current = { account: accountParam, tab: tabParam };
  }, [accountParam, tabParam, providers]);

  // 筛选条件变化时重置页码
  useEffect(() => {
    setCurrentPage(1);
  }, [filter, poolId, createdAfter, createdBefore]);

  // 加载单个账号的额度数据
  const loadAccountUsage = useCallback(async (uuid, options = {}) => {
    if (!USAGE_SUPPORTED_TYPES.has(providerType)) return;

    const resolvedOptions = typeof options === 'boolean' ? { refresh: options } : (options || {});

    setUsageDataMap(prev => ({
      ...prev,
      [uuid]: { ...prev[uuid], loading: true, error: null }
    }));

    try {
      const parsedPoolId = Number(poolId);
      const data = await usageService.getByType(providerType, {
        uuid,
        refresh: Boolean(resolvedOptions.refresh),
        cacheOnly: Boolean(resolvedOptions.cacheOnly),
        poolId: poolId !== null && Number.isFinite(parsedPoolId) ? parsedPoolId : undefined
      });
      const hasMatchedInstance = Array.isArray(data?.instances)
        ? data.instances.some(instance => instance?.uuid === uuid)
        : false;
      const normalizedData = (uuid && Array.isArray(data?.instances) && !hasMatchedInstance)
        ? null
        : data;
      setUsageDataMap(prev => {
        if (Array.isArray(normalizedData?.instances)) {
          const next = { ...prev };
          normalizedData.instances.forEach(instance => {
            if (!instance?.uuid) return;
            next[instance.uuid] = { data: normalizedData, loading: false, error: null };
          });
          if (uuid && !next[uuid]) {
            next[uuid] = { data: normalizedData, loading: false, error: null };
          }
          return next;
        }

        return {
          ...prev,
          [uuid]: { data: normalizedData, loading: false, error: null }
        };
      });
    } catch (err) {
      setUsageDataMap(prev => ({
        ...prev,
        [uuid]: { data: null, loading: false, error: err.message }
      }));
    }
  }, [providerType, poolId]);

  useEffect(() => {
    if (detailTab !== 'quota' || !selectedAccount?.uuid) return;
    const entry = usageDataMap[selectedAccount.uuid];
    if (entry?.loading) return;

    if (entry?.data) return;
    loadAccountUsage(selectedAccount.uuid, { cacheOnly: true });
  }, [detailTab, selectedAccount?.uuid, loadAccountUsage, usageDataMap, providerType]);

  useEffect(() => {
    if (!['openai-codex', 'openai-xai-oauth'].includes(providerType) || providersLoading || providers.length === 0) {
      return undefined;
    }

    const providerUuids = providers
      .map(provider => String(provider?.uuid || '').trim())
      .filter(Boolean);
    if (providerUuids.length === 0) {
      return undefined;
    }

    const prefetchKey = `${providerType}|${poolId ?? ''}|${providerUuids.join(',')}`;
    if (quotaCardPrefetchKeyRef.current === prefetchKey) {
      return undefined;
    }
    quotaCardPrefetchKeyRef.current = prefetchKey;

    setUsageDataMap(prev => {
      let changed = false;
      const next = { ...prev };
      providerUuids.forEach(uuid => {
        if (!next[uuid]?.data && !next[uuid]?.loading) {
          next[uuid] = { ...next[uuid], loading: true, error: null };
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    (async () => {
      try {
        const parsedPoolId = Number(poolId);
        const shouldRefresh = providerType === 'openai-xai-oauth';
        const data = await usageService.getByType(providerType, {
          refresh: shouldRefresh,
          cacheOnly: !shouldRefresh,
          poolId: poolId !== null && Number.isFinite(parsedPoolId) ? parsedPoolId : undefined
        });

        if (quotaCardPrefetchKeyRef.current !== prefetchKey) return;

        setUsageDataMap(prev => {
          const next = { ...prev };
          const instanceMap = new Map(
            Array.isArray(data?.instances)
              ? data.instances
                .filter(instance => instance?.uuid)
                .map(instance => [instance.uuid, instance])
              : []
          );

          providerUuids.forEach(uuid => {
            if (instanceMap.has(uuid)) {
              next[uuid] = { data, loading: false, error: null };
            } else if (next[uuid]?.loading) {
              next[uuid] = { ...next[uuid], loading: false, error: null };
            }
          });

          return next;
        });
      } catch (error) {
        if (quotaCardPrefetchKeyRef.current !== prefetchKey) return;
        console.error(`Failed to preload ${providerType} card usage:`, error);
        setUsageDataMap(prev => {
          const next = { ...prev };
          providerUuids.forEach(uuid => {
            if (next[uuid]?.loading) {
              next[uuid] = { ...next[uuid], loading: false, error: error.message };
            }
          });
          return next;
        });
      }
    })();
  }, [providerType, poolId, providers, providersLoading]);

  // Windsurf 卡片用量预加载 - claude-windsurf 账号列表加载后自动拉取各账号额度
  useEffect(() => {
    if (providerType !== 'claude-windsurf' || providersLoading || providers.length === 0) return undefined;
    const uuids = providers.map(p => String(p?.uuid || '').trim()).filter(Boolean);
    if (uuids.length === 0) return undefined;
    const key = `${providerType}|${poolId ?? ''}|${uuids.join(',')}`;
    if (windsurfCardPrefetchKeyRef.current === key) return undefined;
    windsurfCardPrefetchKeyRef.current = key;
    let cancelled = false;
    uuids.forEach(uuid => {
      if (!cancelled) loadAccountUsage(uuid, { cacheOnly: false }).catch(() => {});
    });
    return () => { cancelled = true; };
  }, [providerType, poolId, providers, providersLoading, loadAccountUsage]);

  // 当选中账号时加载额度 - 已禁用自动加载，改为手动点击"刷新额度"按钮加载
  // useEffect(() => {
  //   if (selectedAccount?.uuid && USAGE_SUPPORTED_TYPES.has(providerType)) {
  //     loadAccountUsage(selectedAccount.uuid);
  //   }
  // }, [selectedAccount?.uuid, providerType, loadAccountUsage]);

  // 当选中账号时加载OAuth凭据
  useEffect(() => {
    const loadCredential = async () => {
      const credId = selectedAccount?.oauthCredentialId;
      if (!credId) {
        setOauthCredential(null);
        return;
      }
      setLoadingCredential(true);
      try {
        const result = await providerService.getOAuthCredential(credId);
        const cred = result?.credential || null;
        setOauthCredential(cred);
        // 初始化凭据编辑数据
        if (cred?.credentials) {
          setEditCredentialData({ ...cred.credentials });
        }
      } catch (err) {
        console.error('Failed to load credential:', err);
        setOauthCredential(null);
      } finally {
        setLoadingCredential(false);
      }
    };
    if (selectedAccount) {
      loadCredential();
    }
  }, [selectedAccount?.oauthCredentialId]);

  // 初始化编辑表单数据
  useEffect(() => {
    if (selectedAccount) {
      const credentialData = selectedAccount.credentials || {};
      setEditFormData({
        customName: selectedAccount.customName || credentialData.customName || '',
        checkHealth: selectedAccount.checkHealth ?? credentialData.checkHealth ?? false,
        checkModelName: selectedAccount.checkModelName || credentialData.checkModelName || '',
        notSupportedModels: selectedAccount.notSupportedModels || credentialData.notSupportedModels || [],
        ...selectedAccount,
        XAI_USING_API: selectedAccount.XAI_USING_API ?? credentialData.XAI_USING_API ?? '',
        CLAUDE_BASE_URL: selectedAccount.CLAUDE_BASE_URL || credentialData.CLAUDE_BASE_URL || '',
        CLAUDE_API_KEY: selectedAccount.CLAUDE_API_KEY || credentialData.CLAUDE_API_KEY || '',
        foxcodeAuthBaseUrl: selectedAccount.foxcodeAuthBaseUrl || credentialData.foxcodeAuthBaseUrl || 'https://foxcode.rjj.cc',
        foxcodeEmail: selectedAccount.foxcodeEmail || credentialData.foxcodeEmail || '',
        foxcodePassword: selectedAccount.foxcodePassword || credentialData.foxcodePassword || '',
        claudeCustomSystemType: selectedAccount.claudeCustomSystemType || credentialData.claudeCustomSystemType || ((selectedAccount.newapiSystemToken || credentialData.newapiSystemToken || selectedAccount.newapiUserId || credentialData.newapiUserId || selectedAccount.newapiUsername || credentialData.newapiUsername) ? 'newapi' : 'self-developed'),
        newapiSystemToken: selectedAccount.newapiSystemToken || credentialData.newapiSystemToken || '',
        newapiUserId: selectedAccount.newapiUserId || credentialData.newapiUserId || '',
        newapiUsername: selectedAccount.newapiUsername || credentialData.newapiUsername || '',
        newapiPassword: selectedAccount.newapiPassword || credentialData.newapiPassword || '',
        officialStickySessionEnabled: selectedAccount.officialStickySessionEnabled ?? credentialData.officialStickySessionEnabled ?? true,
        officialStickySessionTtlMinutes: Number(selectedAccount.officialStickySessionTtlMinutes ?? credentialData.officialStickySessionTtlMinutes ?? 60),
        officialSessionBindingStrict: selectedAccount.officialSessionBindingStrict ?? credentialData.officialSessionBindingStrict ?? false,
        officialStickyIdentityMode: selectedAccount.officialStickyIdentityMode || credentialData.officialStickyIdentityMode || 'session-or-fingerprint',
        officialFingerprintIncludeUser: selectedAccount.officialFingerprintIncludeUser ?? credentialData.officialFingerprintIncludeUser ?? true,
        officialFingerprintIncludeToken: selectedAccount.officialFingerprintIncludeToken ?? credentialData.officialFingerprintIncludeToken ?? true,
        officialFingerprintIncludePath: selectedAccount.officialFingerprintIncludePath ?? credentialData.officialFingerprintIncludePath ?? false,
        antigravityStickySessionEnabled: selectedAccount.antigravityStickySessionEnabled ?? credentialData.antigravityStickySessionEnabled ?? true,
        antigravityStickySessionTtlMinutes: Number(selectedAccount.antigravityStickySessionTtlMinutes ?? credentialData.antigravityStickySessionTtlMinutes ?? 60),
        antigravitySessionBindingStrict: selectedAccount.antigravitySessionBindingStrict ?? credentialData.antigravitySessionBindingStrict ?? false,
        antigravityStickyIdentityMode: selectedAccount.antigravityStickyIdentityMode || credentialData.antigravityStickyIdentityMode || 'session-or-fingerprint',
        antigravityFingerprintIncludeUser: selectedAccount.antigravityFingerprintIncludeUser ?? credentialData.antigravityFingerprintIncludeUser ?? true,
        antigravityFingerprintIncludeToken: selectedAccount.antigravityFingerprintIncludeToken ?? credentialData.antigravityFingerprintIncludeToken ?? true,
        antigravityFingerprintIncludePath: selectedAccount.antigravityFingerprintIncludePath ?? credentialData.antigravityFingerprintIncludePath ?? false,
        antigravityFingerprintSalt: selectedAccount.antigravityFingerprintSalt || credentialData.antigravityFingerprintSalt || '',
        upstreamMode: selectedAccount.upstreamMode || 'direct',
        upstreamBaseUrl: selectedAccount.upstreamBaseUrl || selectedAccount.CLAUDE_BASE_URL || credentialData.CLAUDE_BASE_URL || '',
        upstreamAdminToken: selectedAccount.upstreamAdminToken || '',
        upstreamApiKey: selectedAccount.upstreamApiKey || selectedAccount.CLAUDE_API_KEY || credentialData.CLAUDE_API_KEY || '',
        upstreamRequestTimeoutMs: Number(selectedAccount.upstreamRequestTimeoutMs || 15000),
      });
    }
  }, [selectedAccount]);

  // 筛选后的账号列表
  const filteredProviders = useMemo(() => {
    let list = [...providers];
    // 状态筛选
    if (filter === 'active') {
      list = list.filter(p => !p.isDisabled && !p.isDeleted);
    } else if (filter === 'healthy') {
      list = list.filter(p => p.isHealthy && !p.isDisabled && !p.isDeleted);
    } else if (filter === 'cooldown') {
      list = list.filter(p => isProviderCooldown(p));
    } else if (filter === 'unhealthy') {
      list = list.filter(p => !p.isHealthy && !p.isDisabled && !p.isDeleted && !isProviderCooldown(p));
    } else if (filter === 'disabled') {
      list = list.filter(p => p.isDisabled && !p.isDeleted);
    } else if (filter === 'deleted') {
      list = list.filter(p => p.isDeleted);
    }
    // 搜索过滤
    if (searchText.trim()) {
      const keyword = searchText.trim().toLowerCase();
      list = list.filter(p => {
        const uuid = (p.uuid || '').toLowerCase();
        const name = (p.customName || '').toLowerCase();
        const email = (p.credentials?.email || '').toLowerCase();
        const error = (p.lastErrorMessage || '').toLowerCase();
        return uuid.includes(keyword) || name.includes(keyword) || email.includes(keyword) || error.includes(keyword);
      });
    }
    // 排序
    list.sort((a, b) => {
      if (sortBy === 'created_desc') {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      } else if (sortBy === 'created_asc') {
        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      } else if (sortBy === 'used_desc') {
        return new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0);
      } else if (sortBy === 'used_asc') {
        return new Date(a.lastUsed || 0) - new Date(b.lastUsed || 0);
      } else if (sortBy === 'usage_desc') {
        return (b.usageCount || 0) - (a.usageCount || 0);
      } else if (sortBy === 'usage_asc') {
        return (a.usageCount || 0) - (b.usageCount || 0);
      }
      return 0;
    });
    return list;
  }, [providers, filter, sortBy, searchText]);

  const availableBatchTargetPools = useMemo(
    () => (Array.isArray(pools) ? pools : []).filter((pool) => String(pool.id) !== String(poolId ?? '')),
    [pools, poolId]
  );

  const searchKeyword = searchText.trim();
  const selectionScopeKey = useMemo(() => JSON.stringify({
    filter,
    poolId: poolId ?? null,
    createdAfter: createdAfter || '',
    createdBefore: createdBefore || '',
    search: searchKeyword.toLowerCase(),
  }), [filter, poolId, createdAfter, createdBefore, searchKeyword]);
  const canSelectAcrossPages = totalCount > 0 && (searchKeyword ? true : totalCount > filteredProviders.length);
  const areAllVisibleSelected = filteredProviders.length > 0
    && filteredProviders.every((provider) => provider.uuid && selectedUuids.has(provider.uuid));
  const isAllSelected = selectAllSnapshot?.scopeKey === selectionScopeKey
    ? selectedUuids.size > 0 && selectedUuids.size === selectAllSnapshot.count
    : !canSelectAcrossPages && areAllVisibleSelected;

  useEffect(() => {
    if (!availableBatchTargetPools.length) {
      setBatchTargetPoolId('');
      return;
    }
    setBatchTargetPoolId((prev) => {
      if (prev && availableBatchTargetPools.some((pool) => String(pool.id) === String(prev))) {
        return prev;
      }
      return String(availableBatchTargetPools[0].id);
    });
  }, [availableBatchTargetPools]);

  useEffect(() => {
    if (selectedUuids.size === 0 && selectAllSnapshot !== null) {
      setSelectAllSnapshot(null);
    }
  }, [selectedUuids, selectAllSnapshot]);

  // 统计数据（使用后端返回的总数）
  const stats = useMemo(() => {
    const active = Math.max(totalActiveCount - (disabledCount || 0), 0);
    return {
      total: totalActiveCount,
      active,
      healthy: healthyCount,
      cooldown: cooldownCount,
      unhealthy: unhealthyCountState,
      disabled: disabledCount,
      deleted: deletedCount
    };
  }, [totalActiveCount, healthyCount, cooldownCount, unhealthyCountState, disabledCount, deletedCount]);

  const statusFilterTabs = useMemo(() => ([
    { key: 'active', label: '全部', count: stats.active },
    { key: 'healthy', label: '健康', count: stats.healthy },
    { key: 'cooldown', label: '冷却', count: stats.cooldown },
    { key: 'unhealthy', label: '异常', count: stats.unhealthy },
    { key: 'disabled', label: '禁用', count: stats.disabled ?? 0 },
    { key: 'deleted', label: '已删除', count: stats.deleted ?? 0 }
  ]), [stats]);

  const activeAdvancedFilterCount = useMemo(() => {
    let count = 0;
    if (createdAfter) count += 1;
    if (createdBefore) count += 1;
    if (searchText.trim()) count += 1;
    if (showDeleted) count += 1;
    if (batchCheckModel.trim()) count += 1;
    return count;
  }, [createdAfter, createdBefore, searchText, showDeleted, batchCheckModel]);

  const quotaUsageEntry = useMemo(() => {
    if (!selectedAccount?.uuid) return null;
    const entry = usageDataMap[selectedAccount.uuid];
    if (entry?.loading) {
      return entry;
    }
    if (entry?.data) {
      return entry;
    }
    if (providerType === 'claude-kiro-oauth') {
      const cachedData = buildCachedKiroUsageData(selectedAccount);
      if (cachedData) {
        return { data: cachedData, loading: false, error: null };
      }
    }
    return entry || null;
  }, [providerType, selectedAccount, usageDataMap]);

  // 选择号池
  const handleSelectPool = (pool) => {
    setSearchParams({ pool: pool.id, poolName: pool.name });
  };

  // 返回号池列表
  const handleBackToPools = () => {
    setSearchParams({});
    setProviders([]);
  };

  // 检测
  const handleCheck = async (uuid, extraOptions = {}) => {
    if (checkingIds.has(uuid)) return;
    setCheckingIds(prev => new Set([...prev, uuid]));
    try {
      const matched = providers.find(p => p.uuid === uuid) || selectedAccount;
      const checkMode = matched?.isDeleted ? 'deleted' : (extraOptions.checkMode || 'all');
      const options = { checkMode, includeDeleted: matched?.isDeleted, providerUuid: uuid };
      if (extraOptions.checkModelName) {
        options.checkModelName = extraOptions.checkModelName;
      }
      const parsedPoolId = Number(poolId);
      if (poolId !== null && Number.isFinite(parsedPoolId)) {
        options.poolId = parsedPoolId;
      }
      const result = await providerService.healthCheck(providerType, options);
      if (extraOptions.toastResult) {
        const details = Array.isArray(result?.results) ? result.results.find(item => item?.uuid === uuid) : null;
        if (details?.success === true) {
          showToast('success', `${extraOptions.toastPrefix || '检测通过'} (${details.modelName || options.checkModelName || '-'})`);
        } else if (details?.success === false) {
          showToast('error', `${extraOptions.toastPrefix || '检测失败'}: ${details.message || '请求失败'}`, 5200);
        } else {
          showToast('error', result?.message || '未获取到检测结果', 5200);
        }
      }
      await loadProviders();
    } catch (err) {
      console.error('Check failed:', err);
      if (extraOptions.toastResult) {
        const rawMessage = extractApiErrorMessage(err, '检测失败');
        showToast('error', rawMessage, 5200);
      }
    } finally {
      setCheckingIds(prev => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
    }
  };

  const handleCodexGptTest = async (uuid) => {
    await handleCheck(uuid, {
      checkMode: 'all',
      checkModelName: 'gpt-5.3-codex',
      toastResult: true,
      toastPrefix: 'gpt-5.3-codex 测试'
    });
  };

  const handleManualTest = async (uuid) => {
    if (!uuid || checkingIds.has(uuid)) return;
    const model = (manualTestModel || '').trim();
    if (!model) {
      showToast('error', '请先选择测试模型', 3000);
      return;
    }
    setCheckingIds(prev => new Set([...prev, uuid]));
    setManualTestResult({ loading: true, model });
    try {
      const matched = providers.find(p => p.uuid === uuid) || selectedAccount;
      const options = {
        checkMode: matched?.isDeleted ? 'deleted' : 'all',
        includeDeleted: !!matched?.isDeleted,
        providerUuid: uuid,
        checkModelName: model
      };
      const parsedPoolId = Number(poolId);
      if (poolId !== null && Number.isFinite(parsedPoolId)) {
        options.poolId = parsedPoolId;
      }
      const result = await providerService.healthCheck(providerType, options);
      const details = Array.isArray(result?.results)
        ? result.results.find(item => item?.uuid === uuid)
        : null;
      setManualTestResult({
        loading: false,
        model: details?.modelName || model,
        success: details?.success === true,
        message: details?.message || (details?.success ? '请求成功' : '未返回明确结果'),
        finishedAt: new Date().toISOString()
      });
      await loadProviders();
    } catch (err) {
      console.error('Manual test failed:', err);
      setManualTestResult({
        loading: false,
        model,
        success: false,
        message: extractApiErrorMessage(err, '测试失败'),
        finishedAt: new Date().toISOString()
      });
    } finally {
      setCheckingIds(prev => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
    }
  };

  // 刷新Token
  const handleRefreshToken = async (uuid) => {
    if (refreshingTokenIds.has(uuid)) return;
    setRefreshingTokenIds(prev => new Set([...prev, uuid]));
    try {
      const result = await providerService.refreshToken(providerType, uuid);
      showToast('success', result?.message || 'Token 刷新成功');
    } catch (err) {
      console.error('Refresh token failed:', err);
      const rawMessage = extractApiErrorMessage(err, '未知错误');
      showToast('error', `Token 刷新失败: ${rawMessage}`, 5200);
    } finally {
      setRefreshingTokenIds(prev => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
    }
  };

  // 批量操作处理
  const handleBatchOperation = async (operation, progressCallback) => {
    try {
      // 使用实际的账号总数
      // 优先使用 totalCount，如果为0则使用 healthyCount + disabledCount（不包括已删除）
      let total = totalCount;
      if (total === 0) {
        total = (healthyCount || 0) + (disabledCount || 0);
      }
      if (total === 0) {
        total = 1; // 最后的fallback
      }
      console.log('[DEBUG] handleBatchOperation - totalCount:', totalCount, 'healthyCount:', healthyCount, 'disabledCount:', disabledCount, 'final total:', total);
      progressCallback(0, total, '准备执行...');

      if (operation === 'refresh-usage') {
        progressCallback(0, total, `正在刷新 ${total} 个账号的用量...`);
        const parsedPoolId = Number(poolId);
        const refreshedData = await usageService.getByType(providerType, {
          refresh: true,
          poolId: poolId !== null && Number.isFinite(parsedPoolId) ? parsedPoolId : undefined
        });
        if (refreshedData?.instances?.length) {
          setUsageDataMap(prev => {
            const next = { ...prev };
            refreshedData.instances.forEach(instance => {
              if (!instance?.uuid) return;
              next[instance.uuid] = { data: refreshedData, loading: false, error: null };
            });
            return next;
          });
        }
      } else if (operation === 'health-check') {
        progressCallback(0, total, `正在检测 ${total} 个账号的健康状态...`);
        const options = {};
        const parsedPoolId = Number(poolId);
        if (poolId !== null && Number.isFinite(parsedPoolId)) {
          options.poolId = parsedPoolId;
        }
        if (batchCheckModel.trim()) {
          options.checkModelName = batchCheckModel.trim();
        }
        await providerService.healthCheck(providerType, options);
      } else if (operation === 'health-check-problem') {
        progressCallback(0, total, `正在检测异常/已删除账号...`);
        const options = { checkMode: 'problem', includeDeleted: true };
        const parsedPoolId = Number(poolId);
        if (poolId !== null && Number.isFinite(parsedPoolId)) {
          options.poolId = parsedPoolId;
        }
        if (batchCheckModel.trim()) {
          options.checkModelName = batchCheckModel.trim();
        }
        await providerService.healthCheck(providerType, options);
      } else if (operation === 'batch-update-check-model') {
        const targetModel = batchCheckModel.trim() || 'gpt-5.3-codex';
        progressCallback(0, total, `正在批量设置检测模型为 ${targetModel}...`);
        await providerService.batchUpdateCheckModelName(providerType, targetModel);
      } else if (operation === 'extract-emails') {
        progressCallback(0, total, `正在从 accessToken 提取邮箱...`);
        await providerService.batchExtractEmails(providerType);
      }

      progressCallback(total, total, '执行完成');
      await loadProviders();
      if (operation === 'refresh-usage') {
        await loadPools();
      }
    } catch (error) {
      throw error;
    }
  };

  // 批量检测
  const handleBatchCheck = async (checkAll = false) => {
    if (checkAll) {
      // 刷新全部：重新加载账号列表
      console.log('[DEBUG] Refreshing all providers');
      await loadProviders();
    } else {
      // 批量检测：打开批量操作弹窗
      console.log('[DEBUG] handleBatchCheck called, opening batch operation modal');
      setBatchOperationModal(true);
    }
  };

  // 禁用/启用
  const handleToggleDisable = async (uuid, isDisabled) => {
    try {
      if (isDisabled) {
        await providerService.enable(providerType, uuid);
      } else {
        await providerService.disable(providerType, uuid);
      }
      await loadProviders();
    } catch (err) {
      console.error('Toggle disable failed:', err);
    }
  };

  // 删除
  const handleDelete = async (uuid, isDeleted = false) => {
    const confirmText = isDeleted
      ? '确定要彻底删除此账号吗？此操作不可恢复！'
      : '确定要删除此账号吗？';
    if (!window.confirm(confirmText)) return;
    try {
      if (isDeleted) {
        await providerService.hardDelete(providerType, uuid);
      } else {
        await providerService.delete(providerType, uuid);
      }
      await loadProviders();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // 重置单个账号健康状态
  const handleResetHealth = async (uuid) => {
    try {
      await providerService.resetHealth(providerType, uuid);
      await loadProviders();
      if (selectedAccount?.uuid === uuid) {
        setSelectedAccount(prev => prev ? { ...prev, isHealthy: true, errorCount: 0 } : null);
      }
    } catch (err) {
      console.error('Reset health failed:', err);
      alert('重置失败: ' + err.message);
    }
  };

  // 批量选择切换
  const handleToggleSelect = (uuid, e) => {
    e.stopPropagation();
    setSelectAllSnapshot(null);
    setSelectedUuids(prev => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  // 全选/取消全选
  const handleSelectAll = async () => {
    if (isAllSelected) {
      setSelectedUuids(new Set());
      setSelectAllSnapshot(null);
      return;
    }

    if (!canSelectAcrossPages) {
      const uuids = filteredProviders.map((provider) => provider.uuid).filter(Boolean);
      setSelectedUuids(new Set(uuids));
      setSelectAllSnapshot(uuids.length > 0 ? {
        scopeKey: selectionScopeKey,
        count: uuids.length,
        acrossPages: false,
      } : null);
      return;
    }

    const baseOptions = {
      filter,
      poolId,
      createdAfter: createdAfter ? `${createdAfter} 00:00:00` : undefined,
      createdBefore: createdBefore ? `${createdBefore} 23:59:59` : undefined,
    };

    try {
      setBatchSelectLoading(true);

      let uuids = [];
      if (searchKeyword) {
        const result = await providerService.getUuidsByFilter(providerType, {
          ...baseOptions,
          search: searchKeyword,
        });
        uuids = Array.isArray(result?.uuids) ? result.uuids : [];
      } else {
        const pageSizeForSelection = 500;
        const totalPagesForSelection = Math.max(1, Math.ceil((totalCount || 0) / pageSizeForSelection));
        const selectedUuidSet = new Set();

        for (let page = 1; page <= totalPagesForSelection; page += 1) {
          const pageResult = await providerService.getByType(providerType, {
            ...baseOptions,
            page,
            pageSize: pageSizeForSelection,
          });
          const pageProviders = Array.isArray(pageResult?.providers) ? pageResult.providers : [];
          pageProviders.forEach((provider) => {
            if (provider?.uuid) {
              selectedUuidSet.add(provider.uuid);
            }
          });
          if (pageProviders.length < pageSizeForSelection) {
            break;
          }
        }

        uuids = [...selectedUuidSet];
      }

      setSelectedUuids(new Set(uuids));
      setSelectAllSnapshot(uuids.length > 0 ? {
        scopeKey: selectionScopeKey,
        count: uuids.length,
        acrossPages: true,
      } : null);
    } catch (err) {
      setSelectAllSnapshot(null);
      alert(`跨页全选失败: ${err.message}`);
    } finally {
      setBatchSelectLoading(false);
    }
  };

  // 批量重置健康
  const handleBatchReset = async () => {
    if (selectedUuids.size === 0) return;
    if (!window.confirm(`确定要重置 ${selectedUuids.size} 个账号的健康状态吗？`)) return;
    setBatchLoading(true);
    try {
      for (const uuid of selectedUuids) {
        await providerService.resetHealth(providerType, uuid);
      }
      setSelectedUuids(new Set());
      await loadProviders();
    } catch (err) {
      alert('批量重置失败: ' + err.message);
    } finally {
      setBatchLoading(false);
    }
  };

  // 批量禁用
  const handleBatchDisable = async () => {
    if (selectedUuids.size === 0) return;
    if (!window.confirm(`确定要禁用 ${selectedUuids.size} 个账号吗？`)) return;
    setBatchLoading(true);
    try {
      for (const uuid of selectedUuids) {
        await providerService.disable(providerType, uuid);
      }
      setSelectedUuids(new Set());
      await loadProviders();
    } catch (err) {
      alert('批量禁用失败: ' + err.message);
    } finally {
      setBatchLoading(false);
    }
  };

  // 批量删除
  const handleBatchDelete = () => {
    if (selectedUuids.size === 0 || batchLoading) return;
    setBatchDeleteError('');
    setBatchDeleteModal(true);
  };

  const handleBatchDeleteConfirm = async (mode) => {
    if (selectedUuids.size === 0) return;
    setBatchLoading(true);
    setBatchDeleteError('');
    try {
      for (const uuid of selectedUuids) {
        if (mode === 'hard') {
          await providerService.hardDelete(providerType, uuid);
        } else {
          await providerService.delete(providerType, uuid);
        }
      }
      setSelectedUuids(new Set());
      setBatchDeleteModal(false);
      await loadProviders();
    } catch (err) {
      console.error('Batch delete failed:', err);
      setBatchDeleteError(err?.message || '批量删除失败');
    } finally {
      setBatchLoading(false);
    }
  };

  const handleBatchMove = async () => {
    if (selectedUuids.size === 0 || !batchTargetPoolId) return;
    if (!window.confirm(`确定要将 ${selectedUuids.size} 个账号转移到目标池吗？`)) return;
    setBatchLoading(true);
    try {
      const response = await providerService.batchMoveToPool(providerType, {
        uuids: [...selectedUuids],
        targetPoolId: batchTargetPoolId,
      });
      if (response?.success === false) {
        throw new Error(response?.error?.message || response?.message || '批量转移失败');
      }
      setSelectedUuids(new Set());
      await Promise.all([loadProviders(), loadPools()]);
      showToast('success', response?.message || '批量转移成功');
    } catch (err) {
      alert(`批量转移失败: ${err.message}`);
    } finally {
      setBatchLoading(false);
    }
  };

  const handleCloseBatchDeleteModal = () => {
    if (batchLoading) return;
    setBatchDeleteModal(false);
    setBatchDeleteError('');
  };

  // 按筛选条件批量删除（跨页）
  const handleFilterDeleteConfirm = async (mode) => {
    setFilterDeleteLoading(true);
    setFilterDeleteError('');
    try {
      const opts = { filter, poolId, mode };
      if (createdAfter) opts.createdAfter = createdAfter + ' 00:00:00';
      if (createdBefore) opts.createdBefore = createdBefore + ' 23:59:59';
      await providerService.batchDeleteByFilter(providerType, opts);
      setFilterDeleteModal(false);
      await loadProviders();
    } catch (err) {
      setFilterDeleteError(err?.message || '批量删除失败');
    } finally {
      setFilterDeleteLoading(false);
    }
  };

  // 创建池子
  const handleCreatePool = async () => {
    if (!newPoolName.trim()) return;
    try {
      setCreatingPool(true);
      await providerService.createPool({
        providerType,
        name: newPoolName.trim(),
        isDefault: newPoolIsDefault,
      });
      setShowCreatePool(false);
      setNewPoolName('');
      setNewPoolIsDefault(false);
      await loadPools();
    } catch (err) {
      console.error('Create pool failed:', err);
      alert('创建失败: ' + err.message);
    } finally {
      setCreatingPool(false);
    }
  };

  // 编辑池子
  const handleEditPool = async (pool, e) => {
    e.stopPropagation();
    setEditingPool(pool);
    setEditPoolName(pool.name);
    setEditPoolIsDefault(pool.isDefault);
    setEditPoolStrategy(pool.strategy || 'round-robin');
    setEditPoolIsEnabled(pool.isEnabled !== false);
    setEditPoolUseProxy(pool.useProxy || false);
    setEditPoolProxyNodeIds(Array.isArray(pool.proxyNodeIds) ? pool.proxyNodeIds.map(item => Number(item)).filter(item => Number.isFinite(item)) : []);
    setEditPoolCodexHighConcurrencyUserIds(normalizeIdentityList(pool.codexHighConcurrencyUserIds));
    setEditPoolSupportedModels(pool.supportedModels || []);
    setEditPoolNotSupportedModels(pool.notSupportedModels || []);
    setEditPoolUserMaxConcurrency(pool.userMaxConcurrency || 0);
    setEditPoolAccountMaxConcurrency(pool.accountMaxConcurrency || 0);
    setEditPoolEnableUserConcurrencyLimit(pool.enableUserConcurrencyLimit || false);
    setEditPoolEnableAccountConcurrencyLimit(pool.enableAccountConcurrencyLimit || false);
    setEditPoolProviderMaxConcurrency(pool.providerMaxConcurrency || 0);
    setEditPoolProviderAccountMaxConcurrency(pool.providerAccountMaxConcurrency || 0);
    setEditPoolEnableProviderConcurrencyLimit(pool.enableProviderConcurrencyLimit || false);
    setEditPoolEnableProviderAccountConcurrencyLimit(pool.enableProviderAccountConcurrencyLimit || false);
    setEditPoolEnableSessionLimit(pool.enableSessionLimit || false);
    setEditPoolMaxSessionsPerAccount(pool.maxSessionsPerAccount || 0);
    setEditPoolEnableHealthCheck(pool.enableHealthCheck !== false);
    // 加载模型列表
    try {
      await loadProxyNodes();
      const data = await providerService.getTypeModels(providerType);
      setPoolModelList(Array.isArray(data) ? data : data?.models || []);
    } catch {
      setPoolModelList([]);
    }
  };

  // 切换池子启用/禁用
  const handleTogglePoolEnabled = async (pool, e) => {
    e.stopPropagation();
    try {
      const newEnabled = pool.isEnabled === false ? true : false;
      await providerService.updatePool(pool.id, {
        isEnabled: newEnabled,
      });
      await loadPools();
    } catch (err) {
      console.error('Toggle pool enabled failed:', err);
      alert('操作失败: ' + err.message);
    }
  };

  // 保存池子编辑
  const handleSavePool = async () => {
    if (!editPoolName.trim() || !editingPool) return;
    try {
      setSavingPool(true);
      await providerService.updatePool(editingPool.id, {
        name: editPoolName.trim(),
        isDefault: editPoolIsDefault,
        strategy: editPoolStrategy,
        isEnabled: editPoolIsEnabled,
        useProxy: editPoolUseProxy,
        proxyNodeIds: editPoolUseProxy ? editPoolProxyNodeIds : [],
        codexHighConcurrencyUserIds: normalizeIdentityList(editPoolCodexHighConcurrencyUserIds),
        supportedModels: editPoolSupportedModels.length > 0 ? editPoolSupportedModels : null,
        notSupportedModels: editPoolNotSupportedModels.length > 0 ? editPoolNotSupportedModels : null,
        userMaxConcurrency: editPoolUserMaxConcurrency,
        accountMaxConcurrency: editPoolAccountMaxConcurrency,
        enableUserConcurrencyLimit: editPoolEnableUserConcurrencyLimit,
        enableAccountConcurrencyLimit: editPoolEnableAccountConcurrencyLimit,
        providerMaxConcurrency: editPoolProviderMaxConcurrency,
        providerAccountMaxConcurrency: editPoolProviderAccountMaxConcurrency,
        enableProviderConcurrencyLimit: editPoolEnableProviderConcurrencyLimit,
        enableProviderAccountConcurrencyLimit: editPoolEnableProviderAccountConcurrencyLimit,
        enableSessionLimit: editPoolEnableSessionLimit,
        maxSessionsPerAccount: editPoolMaxSessionsPerAccount,
        enableHealthCheck: editPoolEnableHealthCheck,
      });
      setEditingPool(null);
      await loadPools();
    } catch (err) {
      alert('保存失败: ' + err.message);
    } finally {
      setSavingPool(false);
    }
  };

  const toggleEditPoolProxyNode = (nodeId) => {
    setEditPoolProxyNodeIds((prev) => {
      if (prev.includes(nodeId)) {
        return prev.filter(item => item !== nodeId);
      }
      return [...prev, nodeId];
    });
  };

  // 删除池子
  const handleDeletePool = async (pool, e) => {
    e.stopPropagation();
    if (pool.total > 0) {
      alert('池子中还有账号，无法删除');
      return;
    }
    if (!window.confirm(`确定要删除池子「${pool.name}」吗？`)) return;
    try {
      await providerService.deletePool(pool.id);
      await loadPools();
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  };

  // 打开同步弹窗，加载目标 provider 的池列表
  const handleOpenSyncModal = async () => {
    const targetProvider = providerType === 'gemini-antigravity' ? 'claude-antigravity' : 'gemini-antigravity';
    try {
      const data = await providerService.getPools(targetProvider);
      setSyncTargetPools(data || []);
    } catch {
      setSyncTargetPools([]);
    }
    setSyncTargetPoolId('');
    setSyncResult(null);
    setShowSyncModal(true);
  };

  // 执行同步
  const handleSyncAntigravity = async () => {
    const targetProvider = providerType === 'gemini-antigravity' ? 'claude-antigravity' : 'gemini-antigravity';
    try {
      setSyncLoading(true);
      setSyncResult(null);
      const token = localStorage.getItem('token');
      const res = await fetch('/api/oauth/sync-antigravity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          sourceProvider: providerType,
          targetProvider,
          poolId: syncTargetPoolId ? Number(syncTargetPoolId) : null
        })
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult({ success: true, synced: data.synced, skipped: data.skipped });
        await loadProviders();
      } else {
        setSyncResult({ success: false, error: data.error?.message || data.error || '未知错误' });
      }
    } catch (err) {
      setSyncResult({ success: false, error: err.message });
    } finally {
      setSyncLoading(false);
    }
  };

  // 添加账号
  const handleAddAccount = async () => {
    if (!newAccountData.trim()) return;
    try {
      setAddingAccount(true);
      await providerService.add({
        providerType,
        poolId: poolId ? Number(poolId) : 0,
        credentials: newAccountData.trim(),
      });
      setShowAddAccount(false);
      setNewAccountData('');
      await loadProviders();
    } catch (err) {
      alert('添加失败: ' + err.message);
    } finally {
      setAddingAccount(false);
    }
  };

  // 复制到剪贴板
  const handleCopyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      alert('已复制到剪贴板');
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // 更新凭据编辑字段
  const updateCredentialField = (key, value) => {
    setEditCredentialData(prev => ({ ...prev, [key]: value }));
  };

  // 加载错误历史（使用request_logs，只显示失败的）
  const loadErrorLogs = useCallback(async (uuid, page = 1) => {
    if (!uuid) return;
    try {
      setErrorLogsLoading(true);
      const result = await requestLogsService.getProviderRequestLogs(uuid, {
        page,
        pageSize: 10,
        isSuccess: false
      });
      setErrorLogs(result.data || []);
      setErrorLogsTotal(result.total || 0);
      setErrorLogsTotalPages(result.totalPages || 0);
      setErrorLogsPage(page);
    } catch (err) {
      console.error('Failed to load error logs:', err);
      setErrorLogs([]);
    } finally {
      setErrorLogsLoading(false);
    }
  }, []);

  // 加载状态流转日志
  const loadStatusLogs = useCallback(async (uuid, page = 1) => {
    if (!uuid) return;
    try {
      setStatusLogsLoading(true);
      const result = await providerService.getProviderStatusLogs(uuid, page, 10);
      setStatusLogs(result.data || []);
      setStatusLogsTotal(result.total || 0);
      setStatusLogsTotalPages(result.totalPages || 0);
      setStatusLogsPage(page);
    } catch (err) {
      console.error('Failed to load status logs:', err);
      setStatusLogs([]);
    } finally {
      setStatusLogsLoading(false);
    }
  }, []);

  // 加载实时用户列表
  const loadActiveUsers = useCallback(async (uuid) => {
    if (!uuid) return;
    try {
      setActiveUsersLoading(true);
      const result = await providerService.getProviderActiveUsers(uuid);
      setActiveUsers(result.users || []);
      setUserSessionCounts(result.userSessionCounts || {});
      setUserConcurrencyMap(result.userConcurrencyMap || {});
      setUserPeakConcurrencyMap(result.userPeakConcurrencyMap || {});
      setAccountCurrentConcurrency(Number(result.accountCurrentConcurrency) || 0);
      setAccountPeakConcurrency(Number(result.accountPeakConcurrency) || 0);
      setAccountActiveUserCount(Number(result.activeUserCount) || 0);
      setAccountUniqueUserCount(Number(result.uniqueUserCount) || 0);
    } catch (err) {
      console.error('Failed to load active users:', err);
      setActiveUsers([]);
      setUserSessionCounts({});
      setUserConcurrencyMap({});
      setUserPeakConcurrencyMap({});
      setAccountCurrentConcurrency(0);
      setAccountPeakConcurrency(0);
      setAccountActiveUserCount(0);
      setAccountUniqueUserCount(0);
    } finally {
      setActiveUsersLoading(false);
    }
  }, []);

  // 加载 Token 统计
  const loadTokenStats = useCallback(async (uuid) => {
    if (!uuid) return;
    try {
      setTokenStatsLoading(true);
      const response = await fetch(`/api/token-stats/provider/${uuid}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      if (!response.ok) {
        throw new Error('Failed to load token stats');
      }
      const result = await response.json();
      setTokenStats(result.data || null);
    } catch (err) {
      console.error('Failed to load token stats:', err);
      setTokenStats(null);
    } finally {
      setTokenStatsLoading(false);
    }
  }, []);

  const rebuildTokenStats = useCallback(async (uuid) => {
    if (!uuid) return;
    try {
      setTokenStatsRebuilding(true);
      const response = await fetch('/api/token-stats/rebuild', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uuid })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.success === false) {
        throw new Error(result?.error?.message || result?.message || '补全历史失败');
      }

      showToast('success', '历史 Token 统计补全完成');
      await loadTokenStats(uuid);
    } catch (err) {
      console.error('Failed to rebuild token stats:', err);
      showToast('error', extractApiErrorMessage(err, '补全历史失败'), 4800);
    } finally {
      setTokenStatsRebuilding(false);
    }
  }, [loadTokenStats, showToast]);

  const handleSendQuotaDebug = useCallback(async () => {
    const uuid = selectedAccount?.uuid;
    if (!uuid) return;

    setQuotaDebugLoading(true);
    setQuotaDebugError('');
    setQuotaDebugResult(null);

    try {
      const params = new URLSearchParams();
      params.set('refresh', 'true');
      params.set('includeRaw', 'true');
      const parsedPoolId = Number(poolId);
      if (poolId !== null && Number.isFinite(parsedPoolId)) {
        params.set('poolId', String(parsedPoolId));
      }
      params.set('_t', Date.now().toString());

      const requestPath = `/api/usage/${encodeURIComponent(providerType)}?${params.toString()}`;
      const response = await fetch(requestPath, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        }
      });

      const responseText = await response.text();
      let responseBody = responseText;
      try {
        responseBody = responseText ? JSON.parse(responseText) : null;
      } catch (_err) {
      }

      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const selectedInstance = Array.isArray(responseBody?.instances)
        ? (responseBody.instances.find(item => item?.uuid === uuid) || null)
        : null;

      const debugPayload = {
        request: {
          method: 'GET',
          providerType,
          uuid,
          poolId: poolId ?? null,
          url: requestPath,
          sentAt: new Date().toISOString()
        },
        response: {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers,
          selectedInstance,
          body: responseBody
        },
        receivedAt: new Date().toISOString()
      };

      setQuotaDebugResult(debugPayload);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      showToast('success', '额度查询测试完成');
    } catch (err) {
      const message = extractApiErrorMessage(err, '额度查询测试失败');
      setQuotaDebugError(message);
      showToast('error', message, 5200);
    } finally {
      setQuotaDebugLoading(false);
    }
  }, [poolId, providerType, selectedAccount?.uuid, showToast]);

  const persistUpstreamConfig = useCallback(async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;

    const selectedCredentials = selectedAccount?.credentials || {};
    const resolvedClaudeBaseUrl = editFormData.CLAUDE_BASE_URL || selectedAccount.CLAUDE_BASE_URL || selectedCredentials.CLAUDE_BASE_URL || '';
    const resolvedClaudeApiKey = editFormData.CLAUDE_API_KEY || selectedAccount.CLAUDE_API_KEY || selectedCredentials.CLAUDE_API_KEY || '';
    const resolvedUpstreamBaseUrl = editFormData.upstreamBaseUrl || resolvedClaudeBaseUrl;
    const resolvedUpstreamApiKey = editFormData.upstreamApiKey || resolvedClaudeApiKey;

    const patch = {
      upstreamMode: editFormData.upstreamMode || 'direct',
      upstreamBaseUrl: resolvedUpstreamBaseUrl,
      upstreamAdminToken: editFormData.upstreamAdminToken || '',
      upstreamApiKey: resolvedUpstreamApiKey,
      upstreamRequestTimeoutMs: Number(editFormData.upstreamRequestTimeoutMs || 15000),
      CLAUDE_BASE_URL: resolvedClaudeBaseUrl,
      CLAUDE_API_KEY: resolvedClaudeApiKey,
    };

    await providerService.update(providerType, selectedAccount.uuid, {
      providerConfig: patch,
    });

    setSelectedAccount(prev => prev ? { ...prev, ...patch } : prev);
  }, [editFormData, isClaudeCustom, providerType, selectedAccount]);

  const loadUpstreamHealth = useCallback(async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    const checkedAt = Date.now();
    try {
      setUpstreamLoading(prev => ({ ...prev, health: true }));
      setUpstreamHealthError(null);
      const result = await providerService.getUpstreamHealth(providerType, selectedAccount.uuid);
      setUpstreamHealth(result?.health || null);
      setUpstreamHealthChecked(true);
      upstreamAutoHealthAtRef.current.set(selectedAccount.uuid, checkedAt);
      setSelectedAccount(prev => prev ? { ...prev, lastHealthCheckTime: new Date(checkedAt).toISOString() } : prev);
    } catch (err) {
      setUpstreamHealth(null);
      setUpstreamHealthChecked(true);
      setUpstreamHealthError(err.response?.data?.error || err.message || '检查失败');
      upstreamAutoHealthAtRef.current.set(selectedAccount.uuid, checkedAt);
      setSelectedAccount(prev => prev ? { ...prev, lastHealthCheckTime: new Date(checkedAt).toISOString() } : prev);
      throw err;
    } finally {
      setUpstreamLoading(prev => ({ ...prev, health: false }));
    }
  }, [isClaudeCustom, providerType, selectedAccount?.uuid]);

  const loadUpstreamProxyStatus = useCallback(async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    try {
      setUpstreamLoading(prev => ({ ...prev, status: true }));
      const result = await providerService.getUpstreamProxyStatus(providerType, selectedAccount.uuid);
      setUpstreamProxyStatus(result?.status || null);
    } catch (err) {
      setUpstreamProxyStatus(null);
      throw err;
    } finally {
      setUpstreamLoading(prev => ({ ...prev, status: false }));
    }
  }, [isClaudeCustom, providerType, selectedAccount?.uuid]);

  const loadUpstreamAccounts = useCallback(async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    try {
      setUpstreamLoading(prev => ({ ...prev, accounts: true }));
      const result = await providerService.getUpstreamAccounts(providerType, selectedAccount.uuid);
      const accounts = normalizeUpstreamAccounts(result?.accounts || result?.raw || []);
      setUpstreamAccounts(accounts);
      if (!upstreamSwitchAccountId && accounts.length > 0) {
        const active = accounts.find(item => item.isActive);
        setUpstreamSwitchAccountId(active?.accountId || accounts[0].accountId || '');
      }
    } catch (err) {
      setUpstreamAccounts([]);
      throw err;
    } finally {
      setUpstreamLoading(prev => ({ ...prev, accounts: false }));
    }
  }, [isClaudeCustom, providerType, selectedAccount?.uuid, upstreamSwitchAccountId]);

  const handleRefreshUpstream = useCallback(async () => {
    try {
      await loadUpstreamHealth();

      const mode = editFormData.upstreamMode || 'direct';
      if (mode === 'antigravity-channel') {
        await Promise.all([
          loadUpstreamProxyStatus(),
          loadUpstreamAccounts(),
        ]);
      } else {
        setUpstreamProxyStatus(null);
        setUpstreamAccounts([]);
      }
    } catch (err) {
      const message = err.response?.data?.error || err.message || '刷新上游状态失败';
      const mode = editFormData.upstreamMode || 'direct';
      const warnKey = `${selectedAccount?.uuid || ''}:${detailTab}:${mode}:${message}`;
      if (!upstreamWarnedRef.current.has(warnKey)) {
        upstreamWarnedRef.current.add(warnKey);
        alert(message);
      }
    }
  }, [detailTab, editFormData.upstreamMode, loadUpstreamAccounts, loadUpstreamHealth, loadUpstreamProxyStatus, selectedAccount?.uuid]);

  const handleUpstreamProxyAction = async (action) => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    try {
      setUpstreamLoading(prev => ({ ...prev, action: true }));
      await persistUpstreamConfig();
      if (action === 'start') {
        await providerService.startUpstreamProxy(providerType, selectedAccount.uuid);
      } else {
        await providerService.stopUpstreamProxy(providerType, selectedAccount.uuid);
      }
      await loadUpstreamProxyStatus();
      alert(action === 'start' ? '反代已启动' : '反代已停止');
    } catch (err) {
      alert(err.response?.data?.error || err.message || '反代控制失败');
    } finally {
      setUpstreamLoading(prev => ({ ...prev, action: false }));
    }
  };

  const handleImportUpstreamToken = async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    if (!upstreamImportToken.trim()) {
      alert('请输入 refreshToken 或 JSON');
      return;
    }
    try {
      setUpstreamLoading(prev => ({ ...prev, action: true }));
      await persistUpstreamConfig();
      await providerService.importUpstreamRefreshToken(providerType, selectedAccount.uuid, upstreamImportToken.trim());
      setUpstreamImportToken('');
      await loadUpstreamAccounts();
      alert('导入 refreshToken 成功');
    } catch (err) {
      alert(err.response?.data?.error || err.message || '导入 refreshToken 失败');
    } finally {
      setUpstreamLoading(prev => ({ ...prev, action: false }));
    }
  };

  const handleSwitchUpstreamAccount = async () => {
    if (!isClaudeCustom || !selectedAccount?.uuid) return;
    if (!upstreamSwitchAccountId) {
      alert('请选择要切换的账号');
      return;
    }
    try {
      setUpstreamLoading(prev => ({ ...prev, action: true }));
      await persistUpstreamConfig();
      await providerService.switchUpstreamAccount(providerType, selectedAccount.uuid, upstreamSwitchAccountId);
      await loadUpstreamAccounts();
      await loadUpstreamProxyStatus();
      alert('账号切换成功');
    } catch (err) {
      alert(err.response?.data?.error || err.message || '切换账号失败');
    } finally {
      setUpstreamLoading(prev => ({ ...prev, action: false }));
    }
  };

  useEffect(() => {
    if (!selectedAccount?.uuid || !isClaudeCustom) {
      setUpstreamHealth(null);
      setUpstreamHealthChecked(false);
      setUpstreamHealthError(null);
      setUpstreamProxyStatus(null);
      setUpstreamAccounts([]);
      setUpstreamImportToken('');
      setUpstreamSwitchAccountId('');
      return;
    }

    if (detailTab === 'upstream') {
      const now = Date.now();
      const localCheckedAt = upstreamAutoHealthAtRef.current.get(selectedAccount.uuid) || 0;
      const dbCheckedAt = selectedAccount?.lastHealthCheckTime
        ? new Date(selectedAccount.lastHealthCheckTime).getTime()
        : 0;
      const latestCheckedAt = Math.max(localCheckedAt, Number.isFinite(dbCheckedAt) ? dbCheckedAt : 0);

      if (latestCheckedAt > 0 && now - latestCheckedAt < UPSTREAM_AUTO_HEALTH_COOLDOWN_MS) {
        return;
      }

      upstreamWarnedRef.current.clear();
      handleRefreshUpstream();
    }
  }, [detailTab, handleRefreshUpstream, isClaudeCustom, selectedAccount?.uuid]);

  // 切换到错误历史 Tab 时加载数据
  useEffect(() => {
    if (detailTab === 'errors' && selectedAccount?.uuid) {
      loadErrorLogs(selectedAccount.uuid, 1);
    }
  }, [detailTab, selectedAccount?.uuid, loadErrorLogs]);

  // 切换到状态日志 Tab 时加载数据
  useEffect(() => {
    if (detailTab === 'status' && selectedAccount?.uuid) {
      loadStatusLogs(selectedAccount.uuid, 1);
    }
  }, [detailTab, selectedAccount?.uuid, loadStatusLogs]);

  // 切换到实时用户 Tab 时加载数据
  useEffect(() => {
    if (detailTab === 'users' && selectedAccount?.uuid) {
      loadActiveUsers(selectedAccount.uuid);
    }
  }, [detailTab, selectedAccount?.uuid, loadActiveUsers]);

  // 切换到 Token 统计 Tab 时加载数据
  useEffect(() => {
    if (detailTab === 'tokens' && selectedAccount?.uuid) {
      loadTokenStats(selectedAccount.uuid);
    }
  }, [detailTab, selectedAccount?.uuid, loadTokenStats]);

  // 加载请求日志
  const loadRequestLogs = useCallback(async (uuid, page = 1, filterType = 'all') => {
    if (!uuid) return;
    try {
      setRequestLogsLoading(true);
      const options = { page, pageSize: 10 };
      if (filterType === 'success') options.isSuccess = true;
      if (filterType === 'fail') options.isSuccess = false;
      const result = await requestLogsService.getProviderRequestLogs(uuid, options);
      setRequestLogs(result.data || []);
      setRequestLogsTotal(result.total || 0);
      setRequestLogsTotalPages(result.totalPages || 0);
      setRequestLogsPage(page);
      setRequestLogsSummary(result.summary || null);
    } catch (err) {
      console.error('Failed to load request logs:', err);
      setRequestLogs([]);
    } finally {
      setRequestLogsLoading(false);
    }
  }, []);

  // 切换到请求日志 Tab 时加载数据
  useEffect(() => {
    if (detailTab === 'requests' && selectedAccount?.uuid) {
      loadRequestLogs(selectedAccount.uuid, 1, requestLogsFilter);
    }
  }, [detailTab, selectedAccount?.uuid, loadRequestLogs, requestLogsFilter]);

  // 保存账号配置
  const handleSaveAccount = async () => {
    if (!selectedAccount || !editFormData) return;
    try {
      setSavingAccount(true);
      await providerService.update(providerType, selectedAccount.uuid, {
        providerConfig: editFormData,
      });
      await loadProviders();
      setSelectedAccount(null);
    } catch (err) {
      alert('保存失败: ' + err.message);
    } finally {
      setSavingAccount(false);
    }
  };

  // 更新设备槽位数
  const handleUpdateMaxDevices = async (uuid, currentValue) => {
    const newValue = prompt('请输入最大设备槽位数 (1-10):', currentValue || 3);
    if (newValue === null) return;
    const num = parseInt(newValue, 10);
    if (isNaN(num) || num < 1 || num > 10) {
      alert('请输入 1-10 之间的数字');
      return;
    }
    try {
      await providerService.update(providerType, uuid, { max_devices: num });
      await loadProviders();
    } catch (err) {
      alert('更新失败: ' + err.message);
    }
  };

  // 更新编辑表单字段
  const updateEditField = (key, value) => {
    setEditFormData(prev => ({ ...prev, [key]: value }));
  };

  const icon = getProviderIcon(providerType);
  const isInPoolView = poolId !== null;

  // 渲染号池列表
  const renderPoolList = () => {
    if (poolsLoading) {
      return <div className="page-loading">加载中...</div>;
    }

    // 直接使用后端返回的池子列表（已包含默认池）
    const allPools = pools;

    return (
      <div className="pools-grid">
        {allPools.map(pool => {
          return (
            <div
              key={pool.id}
              className={`pool-card ${pool.isEnabled === false ? 'pool-disabled' : ''}`}
              onClick={() => handleSelectPool(pool)}
            >
              <div className="pool-card-header">
                <div className="pool-card-title">
                  <span className="pool-name">{pool.name}</span>
                  {pool.isDefault && <span className="pool-default-tag">默认</span>}
                  {pool.isEnabled === false && <span className="pool-disabled-tag">已禁用</span>}
                  {pool.useProxy && <span className="pool-proxy-tag"><i className="fas fa-globe" /> 代理</span>}
                </div>
                <div className="pool-card-actions pool-actions-visible">
                  <button
                    className={`pool-action-btn ${pool.isEnabled === false ? 'pool-action-enable' : 'pool-action-disable'}`}
                    onClick={(e) => handleTogglePoolEnabled(pool, e)}
                    title={pool.isEnabled === false ? '启用' : '禁用'}
                  >
                    <i className={`fas ${pool.isEnabled === false ? 'fa-play' : 'fa-pause'}`} />
                  </button>
                  {pool.id !== 0 && (
                    <>
                      <button className="pool-action-btn" onClick={(e) => handleEditPool(pool, e)} title="编辑">
                        <i className="fas fa-edit" />
                      </button>
                      <button className="pool-action-btn pool-action-delete" onClick={(e) => handleDeletePool(pool, e)} title="删除">
                        <i className="fas fa-trash" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="pool-card-meta">
                <span className="pool-strategy">{getStrategyLabel(pool.strategy)}</span>
              </div>
              <div className="pool-card-stats">
                <div className="pool-stat">
                  <span className="pool-stat-label">总数</span>
                  <span className="pool-stat-value">{pool.total ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">健康</span>
                  <span className="pool-stat-value text-success">{pool.healthy ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">禁用</span>
                  <span className="pool-stat-value text-warning">{pool.disabled ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">当前并发</span>
                  <span className="pool-stat-value">{pool.currentConcurrency ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">峰值并发</span>
                  <span className="pool-stat-value">{pool.peakConcurrency ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">活跃用户</span>
                  <span className="pool-stat-value">{pool.activeUserCount ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">唯一用户</span>
                  <span className="pool-stat-value">{pool.uniqueUserCount ?? 0}</span>
                </div>
                <div className="pool-stat">
                  <span className="pool-stat-label">总额度占比</span>
                  <span className="pool-stat-value">
                    {(pool.quotaUsagePercent ?? pool.averageUsage) !== null && (pool.quotaUsagePercent ?? pool.averageUsage) !== undefined
                      ? `${(pool.quotaUsagePercent ?? pool.averageUsage).toFixed(1)}%`
                      : '--'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // 渲染账号列表
  const renderAccountList = () => {
    if (providersLoading) {
      return <div className="page-loading">加载中...</div>;
    }

    return (
      <>
        {/* 工具栏 */}
        <div className="detail-toolbar">
          <div className="toolbar-left">
            <label className="checkbox-label select-all">
              <input
                type="checkbox"
                checked={isAllSelected}
                onChange={() => { handleSelectAll(); }}
                disabled={batchSelectLoading || (!filteredProviders.length && !totalCount)}
              />
              {batchSelectLoading
                ? '选择中...'
                : searchKeyword
                  ? '全选搜索结果'
                  : canSelectAcrossPages
                    ? `全选 ${totalCount} 项`
                    : '全选本页'}
            </label>
            <div className="filter-tabs" role="tablist" aria-label="状态筛选">
              {statusFilterTabs.map((item) => {
                const isDisabled = item.key !== 'active' && (Number(item.count) || 0) === 0 && filter !== item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={filter === item.key}
                    aria-disabled={isDisabled}
                    disabled={isDisabled}
                    className={`filter-tab ${filter === item.key ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => {
                      if (isDisabled) return;
                      setFilter(item.key);
                    }}
                  >
                    <span>{item.label}</span>
                    <span className="tab-count">{item.count}</span>
                  </button>
                );
              })}
            </div>
            <div className="custom-select" ref={sortDropdownRef}>
              <div className={`custom-select-trigger ${sortDropdownOpen ? 'open' : ''}`} onClick={() => setSortDropdownOpen(!sortDropdownOpen)}>
                <span>{sortBy === 'created_desc' ? '创建时间 ↓' : sortBy === 'created_asc' ? '创建时间 ↑' : sortBy === 'used_desc' ? '最近使用 ↓' : sortBy === 'used_asc' ? '最近使用 ↑' : sortBy === 'usage_desc' ? '使用次数 ↓' : '使用次数 ↑'}</span>
                <i className={`fas fa-chevron-down ${sortDropdownOpen ? 'rotate' : ''}`}></i>
              </div>
              {sortDropdownOpen && (
                <div className="custom-select-options">
                  <div className={`custom-select-option ${sortBy === 'created_desc' ? 'selected' : ''}`} onClick={() => { setSortBy('created_desc'); setSortDropdownOpen(false); }}>创建时间 ↓</div>
                  <div className={`custom-select-option ${sortBy === 'created_asc' ? 'selected' : ''}`} onClick={() => { setSortBy('created_asc'); setSortDropdownOpen(false); }}>创建时间 ↑</div>
                  <div className={`custom-select-option ${sortBy === 'used_desc' ? 'selected' : ''}`} onClick={() => { setSortBy('used_desc'); setSortDropdownOpen(false); }}>最近使用 ↓</div>
                  <div className={`custom-select-option ${sortBy === 'used_asc' ? 'selected' : ''}`} onClick={() => { setSortBy('used_asc'); setSortDropdownOpen(false); }}>最近使用 ↑</div>
                  <div className={`custom-select-option ${sortBy === 'usage_desc' ? 'selected' : ''}`} onClick={() => { setSortBy('usage_desc'); setSortDropdownOpen(false); }}>使用次数 ↓</div>
                  <div className={`custom-select-option ${sortBy === 'usage_asc' ? 'selected' : ''}`} onClick={() => { setSortBy('usage_asc'); setSortDropdownOpen(false); }}>使用次数 ↑</div>
                </div>
              )}
            </div>
            <div className="toolbar-filter-menu" ref={advancedFilterRef}>
              <button
                type="button"
                className={`custom-select-trigger ${advancedFilterOpen ? 'open' : ''}`}
                onClick={() => setAdvancedFilterOpen(prev => !prev)}
              >
                <i className="fas fa-sliders-h" />
                <span>筛选</span>
                {activeAdvancedFilterCount > 0 && <span className="filter-menu-badge">{activeAdvancedFilterCount}</span>}
                <i className={`fas fa-chevron-down ${advancedFilterOpen ? 'rotate' : ''}`} />
              </button>
              {advancedFilterOpen && (
                <div className="toolbar-filter-panel">
                  <div className="toolbar-filter-row">
                    <input
                      type="date"
                      className="date-input"
                      value={createdAfter}
                      onChange={e => setCreatedAfter(e.target.value)}
                      title="导入时间起始"
                      placeholder="开始日期"
                    />
                    <span className="toolbar-filter-sep">~</span>
                    <input
                      type="date"
                      className="date-input"
                      value={createdBefore}
                      onChange={e => setCreatedBefore(e.target.value)}
                      title="导入时间截止"
                      placeholder="结束日期"
                    />
                  </div>
                  <input
                    type="text"
                    className="search-input filter-panel-input"
                    placeholder="搜索 UUID/名称/邮箱/错误..."
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                  />
                  <input
                    type="text"
                    className="model-input filter-panel-input"
                    placeholder="检测模型名称"
                    value={batchCheckModel}
                    onChange={e => setBatchCheckModel(e.target.value)}
                  />
                  <label className="checkbox-label">
                    <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
                    显示已删除
                  </label>
                  <div className="toolbar-filter-actions">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setCreatedAfter('');
                        setCreatedBefore('');
                        setSearchText('');
                        setShowDeleted(false);
                        setBatchCheckModel('');
                      }}
                    >
                      清空筛选
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="toolbar-right">
            <button className="btn btn-outline" onClick={() => handleBatchCheck(false)}>
              <i className="fas fa-sync-alt" /> 批量检测
            </button>
            {providerType === 'claude-kiro-oauth' && (
              <button className="btn btn-outline btn-refresh-all" onClick={() => handleBatchCheck(true)} title="刷新所有账号的订阅级别和用量信息">
                <i className="fas fa-redo" /> 刷新全部
              </button>
            )}
            {(providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') && (
              <button
                className="btn btn-outline"
                onClick={handleOpenSyncModal}
                disabled={syncLoading}
                title={`同步凭证到 ${providerType === 'gemini-antigravity' ? 'Claude Antigravity' : 'Gemini Antigravity'}`}
              >
                <i className={`fas ${syncLoading ? 'fa-spinner fa-spin' : 'fa-exchange-alt'}`} />
                {' '}同步到{providerType === 'gemini-antigravity' ? 'Claude' : 'Gemini'}
              </button>
            )}
          </div>
        </div>

        {/* 批量操作栏 */}
        {selectedUuids.size > 0 && (
          <div className="batch-toolbar">
            <span className="batch-info">
              已选择 {selectedUuids.size} 项{selectAllSnapshot?.scopeKey === selectionScopeKey && selectAllSnapshot?.acrossPages ? '（跨页）' : ''}
            </span>
            <button className="btn btn-outline" onClick={handleBatchReset} disabled={batchLoading}>
              <i className="fas fa-redo" /> 重置
            </button>
            <button className="btn btn-outline btn-warning" onClick={handleBatchDisable} disabled={batchLoading}>
              <i className="fas fa-ban" /> 禁用
            </button>
            {availableBatchTargetPools.length > 0 && (
              <>
                <select
                  className="provider-pool-select batch-pool-select"
                  value={batchTargetPoolId}
                  onChange={(event) => setBatchTargetPoolId(event.target.value)}
                  disabled={batchLoading}
                >
                  {availableBatchTargetPools.map((pool) => (
                    <option key={pool.id} value={String(pool.id)}>
                      转到 {pool.name || `池子 ${pool.id}`}
                    </option>
                  ))}
                </select>
                <button className="btn btn-outline" onClick={handleBatchMove} disabled={batchLoading || !batchTargetPoolId}>
                  <i className="fas fa-right-left" /> 转移
                </button>
              </>
            )}
            <button className="btn btn-outline btn-danger" onClick={handleBatchDelete} disabled={batchLoading}>
              <i className="fas fa-trash" /> 删除
            </button>
            <button className="btn btn-outline" onClick={() => setSelectedUuids(new Set())}>
              取消选择
            </button>
          </div>
        )}

        {/* 按筛选条件批量删除 */}
        {totalCount > 0 && (createdAfter || createdBefore || (filter !== 'healthy' && filter !== 'active')) && (
          <div className="batch-toolbar" style={{ justifyContent: 'space-between' }}>
            <span className="batch-info">
              当前筛选共 {totalCount} 条结果
              {createdAfter && <span style={{ marginLeft: 6 }}>（从 {createdAfter}</span>}
              {createdBefore && <span>{createdAfter ? ' 至 ' : '（至 '}{createdBefore}</span>}
              {(createdAfter || createdBefore) && <span>）</span>}
            </span>
            <button
              className="btn btn-outline btn-danger"
              onClick={() => { setFilterDeleteError(''); setFilterDeleteModal(true); }}
              disabled={filterDeleteLoading}
            >
              <i className="fas fa-trash-alt" /> 删除所有筛选结果
            </button>
          </div>
        )}

        {/* 账号卡片 */}
        <div className="accounts-grid">
          {filteredProviders.length === 0 ? (
            <div className="empty-state">暂无账号数据</div>
          ) : (
            filteredProviders.map(provider => {
              const usageCount = provider.usageCount ?? 0;
              const errorCount = provider.errorCount ?? 0;
              const totalCount = usageCount + errorCount;
              const hasRequestStats = totalCount > 0;
              const successRateNum = hasRequestStats ? Math.round((usageCount / totalCount) * 100) : 0;
              const successRateText = hasRequestStats ? `${successRateNum}%` : '--';
              const successShare = hasRequestStats ? (usageCount / totalCount) * 100 : 0;
              const errorShare = hasRequestStats ? (errorCount / totalCount) * 100 : 0;
              const successRateToneClass = successRateNum >= 90 ? 'text-success' : successRateNum >= 70 ? 'text-warning' : 'text-danger';
              const isSelected = selectedUuids.has(provider.uuid);
              const recoveryAtRaw = resolveProviderRecoveryAt(provider);
              const recoveryAtMs = recoveryAtRaw ? new Date(recoveryAtRaw).getTime() : NaN;
              const providerRelayState = String(provider.credentials?.relayState || provider.relayState || '').trim().toLowerCase();
              const isQuotaCooldown = !provider.isDeleted
                && !provider.isDisabled
                && !provider.isHealthy
                && (provider.isCooldown === true
                    || providerRelayState === 'cooldown'
                    || providerRelayState === 'overloaded'
                    || (Number.isFinite(recoveryAtMs) && recoveryAtMs > Date.now()));

              // 从 usageDataMap 获取 Kiro 用量数据
              let kiroUsageData = null;
              const rawKiroTitle = provider.subscriptionTitle ?? provider.subscription_title ?? null;
              const rawKiroUsageLimit = provider.usageLimit ?? provider.usage_limit;
              const rawKiroCurrentUsage = provider.currentUsage ?? provider.current_usage;
              if (providerType === 'claude-kiro-oauth') {
                const usageEntry = usageDataMap[provider.uuid];
                if (usageEntry?.data?.instances) {
                  const instance = pickUsageInstanceByUuid(usageEntry.data, provider.uuid);
                  if (instance?.usage) {
                    const breakdown = instance.usage.usageBreakdown?.[0];
                    const limit = breakdown?.usageLimit ?? rawKiroUsageLimit;
                    const used = breakdown?.currentUsage ?? rawKiroCurrentUsage ?? 0;
                    const limitNum = Number(limit);
                    const usedNum = Number(used) || 0;
                    // 优先使用 API 返回的 remainingPercent，否则自己计算
                    let remainingPct = breakdown?.remainingPercent;
                    if (remainingPct == null && Number.isFinite(limitNum) && limitNum > 0) {
                      remainingPct = Math.max(0, Math.min(100, 100 - (usedNum / limitNum) * 100));
                    }
                    kiroUsageData = {
                      subscriptionTitle: instance.usage.subscription?.title || rawKiroTitle,
                      remainingPercent: remainingPct,
                      currentUsage: usedNum,
                      usageLimit: limit
                    };
                  }
                }
                // 如果没有实时数据，使用数据库中的数据
                if (!kiroUsageData && (rawKiroTitle || rawKiroUsageLimit != null || rawKiroCurrentUsage != null)) {
                  const limitValue = Number(rawKiroUsageLimit);
                  const usedValue = Number(rawKiroCurrentUsage) || 0;
                  const hasLimit = Number.isFinite(limitValue) && limitValue > 0;
                  const remainingPercent = hasLimit
                    ? Math.max(0, Math.min(100, 100 - (usedValue / limitValue) * 100))
                    : null;
                  kiroUsageData = {
                    subscriptionTitle: rawKiroTitle,
                    currentUsage: usedValue,
                    usageLimit: hasLimit ? limitValue : rawKiroUsageLimit,
                    remainingPercent
                  };
                }
              }
              let codexBreakdowns = [];
              const codexUsageEntry = providerType === 'openai-codex' ? usageDataMap[provider.uuid] : null;
              let codexImageQuotaView = null;
              if (providerType === 'openai-codex') {
                const inst = codexUsageEntry?.data?.instances
                  ? pickUsageInstanceByUuid(codexUsageEntry.data, provider.uuid)
                  : null;
                const bds = Array.isArray(inst?.usage?.usageBreakdown) ? inst.usage.usageBreakdown : [];
                codexBreakdowns = buildCodexCardBreakdowns(bds);
                codexImageQuotaView = buildCodexImageQuotaView(inst?.imageUsageSummary, inst?.imageError || '');
              }
              const codexCardLoading = providerType === 'openai-codex'
                ? Boolean(codexUsageEntry?.loading)
                : false;
              const codexCardSlots = providerType === 'openai-codex'
                ? (codexBreakdowns.length > 0
                  ? codexBreakdowns
                  : CODEX_CARD_WINDOW_PLACEHOLDERS.map(label => ({ label, remainingPercent: null })))
                : [];
              const xaiUsageEntry = providerType === 'openai-xai-oauth'
                ? usageDataMap[provider.uuid]
                : null;
              let xaiCardData = null;
              if (providerType === 'openai-xai-oauth') {
                const instance = xaiUsageEntry?.data?.instances
                  ? pickUsageInstanceByUuid(xaiUsageEntry.data, provider.uuid)
                  : null;
                const breakdowns = Array.isArray(instance?.usage?.usageBreakdown)
                  ? instance.usage.usageBreakdown
                  : [];
                const weeklyBreakdown = breakdowns.find(item => (
                  item?.resourceType === 'XAI_WEEKLY_CREDITS'
                  || item?.subscriptionId === 'weekly_pool'
                )) || null;
                const weeklyRemaining = Number(weeklyBreakdown?.remainingPercent);
                const dbLimit = Number(provider.usageLimit ?? provider.usage_limit);
                const dbUsed = Number(provider.currentUsage ?? provider.current_usage);
                const dbRemaining = Number.isFinite(dbLimit) && dbLimit > 0 && Number.isFinite(dbUsed)
                  ? Math.max(0, Math.min(100, 100 - (dbUsed / dbLimit) * 100))
                  : null;
                const remainingPercent = Number.isFinite(weeklyRemaining)
                  ? Math.max(0, Math.min(100, weeklyRemaining))
                  : dbRemaining;
                xaiCardData = {
                  planTitle: instance?.usage?.subscription?.title
                    || provider.subscriptionTitle
                    || provider.subscription_title
                    || null,
                  remainingPercent,
                  quotaUnavailable: instance?.usage?.quotaUnavailable === true,
                  nextResetTime: weeklyBreakdown?.nextDateReset
                    || instance?.usage?.nextDateReset
                    || provider.nextResetTime
                    || provider.next_reset_time
                    || null
                };
              }
              // Windsurf 卡片用量数据
              let windsurfCardData = null;
              if (providerType === 'claude-windsurf') {
                const usageEntry = usageDataMap[provider.uuid];
                if (usageEntry?.data?.instances) {
                  const instance = pickUsageInstanceByUuid(usageEntry.data, provider.uuid);
                  if (instance?.usage) {
                    const breakdowns = instance.usage.usageBreakdown || [];
                    windsurfCardData = {
                      planTitle: instance.usage.subscription?.title || 'Windsurf',
                      breakdowns,
                    };
                  }
                }
              }

              let claudeCustomUsageData = null;
              if (providerType === 'claude-custom' || providerType === 'claude-offical') {
                const usageLimit = provider.usageLimit ?? provider.usage_limit;
                const currentUsage = provider.currentUsage ?? provider.current_usage;
                const limitValue = Number(usageLimit);
                const usedValue = Number(currentUsage);
                const hasLimit = Number.isFinite(limitValue) && limitValue > 0;
                const hasUsed = Number.isFinite(usedValue);

                if (hasLimit || hasUsed) {
                  const safeLimit = hasLimit ? limitValue : 0;
                  const safeUsed = hasUsed ? usedValue : 0;
                  const remainingPercent = hasLimit
                    ? Math.max(0, Math.min(100, 100 - (safeUsed / safeLimit) * 100))
                    : null;
                  claudeCustomUsageData = {
                    usageLimit: hasLimit ? safeLimit : null,
                    currentUsage: hasUsed ? safeUsed : null,
                    remainingPercent,
                    planName: provider.subscriptionTitle ?? provider.subscription_title ?? null,
                  };
                }

                const usageEntry = usageDataMap[provider.uuid];
                if (usageEntry?.data?.instances) {
                  const instance = pickUsageInstanceByUuid(usageEntry.data, provider.uuid);
                  const subscriptionBreakdown = Array.isArray(instance?.usage?.subscriptionBreakdown)
                    ? instance.usage.subscriptionBreakdown
                    : [];
                  const usageBreakdown = Array.isArray(instance?.usage?.usageBreakdown)
                    ? instance.usage.usageBreakdown
                    : null;
                  const isFiveHourWindow = (item) => {
                    const subscriptionId = String(item?.subscriptionId || '').toLowerCase();
                    const planName = String(item?.planName || item?.displayName || '').toLowerCase();
                    if (subscriptionId === 'five_hour') return true;
                    return planName.includes('5小时') || planName.includes('5h') || planName.includes('five');
                  };
                  const firstSubscription = providerType === 'claude-offical'
                    ? (subscriptionBreakdown.find(isFiveHourWindow) || subscriptionBreakdown[0] || null)
                    : (subscriptionBreakdown[0] || null);
                  const firstBreakdown = providerType === 'claude-offical'
                    ? ((usageBreakdown || []).find(isFiveHourWindow) || (usageBreakdown || [])[0] || null)
                    : ((usageBreakdown || [])[0] || null);
                  const realUsed = Number(firstSubscription?.used ?? firstBreakdown?.currentUsage);
                  const realLimit = Number(firstSubscription?.limit ?? firstBreakdown?.usageLimit);
                  const hasRealUsed = Number.isFinite(realUsed);
                  const hasRealLimit = Number.isFinite(realLimit) && realLimit > 0;
                  const remainingPercent = hasRealLimit
                    ? Math.max(0, Math.min(100, 100 - (realUsed / realLimit) * 100))
                    : (Number.isFinite(firstBreakdown?.remainingPercent) ? firstBreakdown.remainingPercent : null);

                  if (hasRealUsed || hasRealLimit || remainingPercent != null) {
                    claudeCustomUsageData = {
                      usageLimit: hasRealLimit ? realLimit : null,
                      currentUsage: hasRealUsed ? realUsed : null,
                      remainingPercent,
                      planName: firstSubscription?.planName || instance?.usage?.subscription?.title || claudeCustomUsageData?.planName || null,
                    };
                  }
                }
              }
              // Claude Antigravity 额度（多模型平均值）
              let claudeAntigravityUsageData = null;
              if (providerType === 'claude-antigravity') {
                const dbLimit = provider.usageLimit ?? provider.usage_limit;
                const dbUsed = provider.currentUsage ?? provider.current_usage;
                const dbTier = provider.subscriptionTitle ?? provider.subscription_title ?? null;
                const dbLimitNum = Number(dbLimit);
                const dbUsedNum = Number(dbUsed);
                if (Number.isFinite(dbLimitNum) && dbLimitNum > 0) {
                  claudeAntigravityUsageData = {
                    remainingPercent: Math.max(0, Math.min(100, 100 - (dbUsedNum / dbLimitNum) * 100)),
                    tier: dbTier
                  };
                }
                // 如果有实时数据，覆盖
                const usageEntry = usageDataMap[provider.uuid];
                if (usageEntry?.data?.instances) {
                  const instance = pickUsageInstanceByUuid(usageEntry.data, provider.uuid);
                  const breakdowns = instance?.usage?.usageBreakdown || [];
                  if (breakdowns.length > 0) {
                    const avgPercent = breakdowns.reduce((sum, b) => sum + (b.remainingPercent || 0), 0) / breakdowns.length;
                    claudeAntigravityUsageData = {
                      remainingPercent: Math.round(avgPercent * 100) / 100,
                      tier: instance?.usage?.subscription?.tier || claudeAntigravityUsageData?.tier || null,
                      nextDateReset: instance?.usage?.nextDateReset || null
                    };
                  }
                }
              }
              const codexPlanTitle = provider.subscriptionTitle ?? provider.subscription_title ?? null;
              const codexTierLabel = formatCodexTierTitle(codexPlanTitle);
              // 细分 tier（5x / 20x 等，来自 credentials.tier）
              const codexSubTier = provider?.credentials?.tier || null; // '5x' | '20x' | null
              const codexTierClassBase = resolveCodexTierClass(codexPlanTitle);
              const codexFullTierClass = codexSubTier && codexTierClassBase === 'pro'
                ? `pro ${codexSubTier === '20x' ? 'pro-20x' : 'pro-5x'}`
                : codexTierClassBase;
              const codexSubTierLabel = codexSubTier
                ? (codexSubTier === '20x' ? '20×' : '5×')
                : null;
              const xaiPlanNormalized = String(xaiCardData?.planTitle || '').toLowerCase();
              const xaiTierClass = xaiPlanNormalized.includes('super') || xaiPlanNormalized.includes('premium+')
                ? 'ultra'
                : (xaiPlanNormalized.includes('premium') || xaiPlanNormalized.includes('pro') ? 'pro' : 'free');
              const kiroTierTitle = providerType === 'claude-kiro-oauth'
                ? (kiroUsageData?.subscriptionTitle || rawKiroTitle)
                : null;
              const providerEmail = resolveProviderEmail(provider);
              const providerCreatedAt = provider.createdAt || provider.created_at || provider.credentials?.createdAt || provider.credentials?.created_at || null;

              return (
                <div key={provider.uuid} className={`account-card ${isSelected ? 'selected' : ''} ${isQuotaCooldown ? 'quota-cooldown' : ''}`} onClick={() => setSelectedAccount(provider)}>
                  <div className="account-card-top">
                    <div className="account-status">
                      <input
                        type="checkbox"
                        className="card-checkbox"
                        checked={isSelected}
                        onChange={(e) => handleToggleSelect(provider.uuid, e)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      {provider.isDeleted ? (
                        <span className="status-badge deleted"><i className="fas fa-trash" /> 已删除</span>
                      ) : provider.isDisabled ? (
                        <span className="status-badge disabled"><i className="fas fa-ban" /> 禁用</span>
                      ) : provider.isHealthy ? (
                        <span className="status-badge healthy"><i className="fas fa-check-circle" /> 健康</span>
                      ) : isQuotaCooldown ? (
                        <span className="status-badge cooldown" title={`预计恢复: ${formatDateTime(recoveryAtRaw)}`}><i className="fas fa-snowflake" /> 冷却中</span>
                      ) : (
                        <span className="status-badge unhealthy"><i className="fas fa-exclamation-triangle" /> 异常</span>
                      )}
                    </div>
                    <div className="card-quick-actions">
                      {/* 近期用户数 tag */}
                      {provider.recentUserCount > 0 && (
                        <span className="user-count-tag" title={`近5分钟内 ${provider.recentUserCount} 个用户使用`}>
                          <i className="fas fa-users" /> {provider.recentUserCount}
                        </span>
                      )}
                      {/* Kiro 订阅级别徽章 */}
                      {providerType === 'claude-kiro-oauth' && (
                        <span className={`kiro-tier-badge ${
                          !kiroTierTitle ? '' :
                          kiroTierTitle.includes('ULTRA') ? 'ultra' :
                          kiroTierTitle.includes('PRO+') ? 'pro-plus' :
                          kiroTierTitle.includes('PRO') ? 'pro' : 'free'
                        }`}>
                          {kiroTierTitle?.replace('KIRO ', '') || '-'}
                        </span>
                      )}
                      {providerType === 'openai-codex' && (
                        <span
                          className={`codex-tier-badge ${codexFullTierClass}`}
                          title={codexSubTier ? `${codexTierLabel} · ${codexSubTierLabel} 速度档位` : codexTierLabel}
                        >
                          {codexTierLabel}
                          {codexSubTierLabel && (
                            <span className="tier-suffix">{codexSubTierLabel}</span>
                          )}
                        </span>
                      )}
                      {providerType === 'openai-xai-oauth' && xaiCardData?.planTitle && (
                        <span className={`kiro-tier-badge ${xaiTierClass}`}>
                          {xaiCardData.planTitle}
                        </span>
                      )}
                      {providerType === 'claude-antigravity' && (() => {
                        const rawTier = claudeAntigravityUsageData?.tier || '';
                        // 兼容旧数据：Gemini Antigravity -> PRO
                        const tier = ['PRO', 'ULTRA', 'FREE'].includes(rawTier.toUpperCase?.())
                          ? rawTier.toUpperCase()
                          : rawTier ? 'PRO' : null;
                        return tier ? (
                          <span className={`kiro-tier-badge ${tier === 'ULTRA' ? 'ultra' : tier === 'PRO' ? 'pro' : 'free'}`}>
                            {tier}
                          </span>
                        ) : null;
                      })()}
                      {/* Windsurf 订阅级别徽章 */}
                      {providerType === 'claude-windsurf' && windsurfCardData?.planTitle && (() => {
                        const t = windsurfCardData.planTitle;
                        const tc = t.toLowerCase().includes('pro') ? 'pro' : t.toLowerCase().includes('team') ? 'pro-plus' : 'free';
                        return <span className={`kiro-tier-badge ${tc}`}>{t}</span>;
                      })()}
                      <span
                        className="account-id copyable"
                        title={`点击复制: ${provider.uuid}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(provider.uuid);
                        }}
                      >
                        {provider.uuid?.slice(0, 8)}
                      </span>
                    </div>
                  </div>

                  <div className="account-name">
                    {provider.customName || <span className="placeholder-text">-</span>}
                  </div>
                  {providerEmail && (
                    <div className="account-email" title={providerEmail}>
                      <i className="fas fa-envelope" /> {providerEmail}
                    </div>
                  )}
                  {providerType === 'openai-codex' && providerCreatedAt && (
                    <div className="account-created-at" title={formatDateTime(providerCreatedAt)}>
                      <i className="fas fa-calendar-alt" /> 创建: {formatDateTime(providerCreatedAt)}
                    </div>
                  )}

                  <div className="account-stats">
                    <div className="account-progress-compact-header">
                      <span className="account-progress-title">成功率</span>
                      <span className={`account-progress-value ${successRateToneClass}`}>{successRateText}</span>
                      <span className="account-progress-compact-sep" />
                      <span className="text-success account-progress-count">成功 {usageCount}</span>
                      <span className="text-danger account-progress-count">失败 {errorCount}</span>
                    </div>
                    <div className="account-progress-track split">
                      <div className="account-progress-fill success" style={{ width: `${successShare}%` }} />
                      <div className="account-progress-fill danger" style={{ width: `${errorShare}%` }} />
                    </div>
                  </div>

                  {/* Kiro 用量信息 */}
                  {providerType === 'claude-kiro-oauth' && (kiroUsageData?.usageLimit != null || kiroUsageData?.currentUsage != null || kiroUsageData?.remainingPercent != null) && (
                    <div className="kiro-usage-info">
                      {kiroUsageData?.remainingPercent != null && (
                        <BatteryBar percent={kiroUsageData.remainingPercent} cellCount={10} mini />
                      )}
                      {kiroUsageData.usageLimit != null && (
                        <span className="usage-quota">
                          {Number(kiroUsageData.currentUsage || 0).toFixed(2)} / {kiroUsageData.usageLimit} credits
                        </span>
                      )}
                    </div>
                  )}

                  {/* Windsurf 用量 */}
                  {providerType === 'claude-windsurf' && windsurfCardData && (
                    <div className="ws-usage-compact">
                      <div className="ws-quota-row">
                        {windsurfCardData.breakdowns.filter(b => b.resetType === 'daily' || b.resetType === 'weekly').map((b, i) => (
                          <div key={i} className="ws-quota-item">
                            <span className="ws-quota-label">{b.displayName}</span>
                            <BatteryBar percent={b.remainingPercent ?? 0} cellCount={6} mini />
                            <span className="ws-quota-pct">{Math.round(b.remainingPercent ?? 0)}%</span>
                          </div>
                        ))}
                      </div>
                      {windsurfCardData.breakdowns.filter(b => b.resourceType === 'PROMPT_CREDITS' && (b.currentUsage ?? 0) > 0).map((b, i) => (
                        <div key={i} className="ws-credits-row">
                          Credits: {b.currentUsage ?? 0} / {b.usageLimit} 剩余 {Math.round(b.remainingPercent ?? 0)}%
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Codex 用量 - 固定展示真实窗口，不再回退为单个额度电池 */}
                  {providerType === 'openai-codex' && codexCardSlots.length > 0 && (
                    <div className="codex-usage-inline">
                      {codexCardSlots.map((item, index) => (
                        <div key={`${item.label}-${index}`} className={`codex-usage-slot ${item.remainingPercent == null ? 'placeholder' : ''}`} title={item.label}>
                          <span className="codex-slot-label">{item.label}</span>
                          {item.remainingPercent != null ? (
                            <BatteryBar percent={item.remainingPercent} cellCount={5} mini />
                          ) : (
                            <span className="codex-slot-placeholder">{codexCardLoading ? '加载中...' : '--'}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {providerType === 'openai-codex' && (codexImageQuotaView || codexCardLoading) && (
                    <div className={`codex-image-inline ${codexImageQuotaView?.tone || 'empty'}`}>
                      <span className="codex-image-inline-title">
                        {codexImageQuotaView?.inlineLabel || '图片额度 · 加载中...'}
                      </span>
                      {codexImageQuotaView?.detailLabel && (
                        <span className="codex-image-inline-meta">{`已用/总额 ${codexImageQuotaView.detailLabel}`}</span>
                      )}
                    </div>
                  )}

                  {providerType === 'openai-xai-oauth' && (
                    <div
                      className={`xai-usage-info ${xaiCardData?.remainingPercent == null ? 'placeholder' : ''}`}
                      title={xaiCardData?.nextResetTime ? `重置: ${formatLocalDateTime(xaiCardData.nextResetTime)}` : '每周共享额度'}
                    >
                      <span className="xai-usage-label">每周额度</span>
                      {xaiCardData?.remainingPercent != null ? (
                        <>
                          <BatteryBar percent={xaiCardData.remainingPercent} cellCount={8} mini />
                          <span className="xai-usage-value">剩余 {Math.round(xaiCardData.remainingPercent)}%</span>
                        </>
                      ) : (
                        <span className="xai-usage-placeholder">
                          {xaiUsageEntry?.loading
                            ? '加载中...'
                            : (xaiCardData?.quotaUnavailable ? 'API 可用' : '--')}
                        </span>
                      )}
                    </div>
                  )}

                  {(providerType === 'claude-custom' || providerType === 'claude-offical') && (claudeCustomUsageData?.usageLimit != null || claudeCustomUsageData?.currentUsage != null || claudeCustomUsageData?.remainingPercent != null) && (
                    <div className="codex-usage-info">
                      {claudeCustomUsageData?.remainingPercent != null && (
                        <BatteryBar percent={claudeCustomUsageData.remainingPercent} cellCount={10} mini />
                      )}
                      {claudeCustomUsageData?.usageLimit != null && claudeCustomUsageData?.currentUsage != null && (
                        <span className="usage-quota">
                          {Math.round(claudeCustomUsageData.currentUsage)} / {Math.round(claudeCustomUsageData.usageLimit)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Claude Antigravity 用量信息 */}
                  {providerType === 'claude-antigravity' && claudeAntigravityUsageData && (
                    <div className="antigravity-usage-bar">
                      <BatteryBar percent={claudeAntigravityUsageData.remainingPercent} cellCount={10} mini />
                      {claudeAntigravityUsageData.nextDateReset && (
                        <span className="antigravity-reset-time">{claudeAntigravityUsageData.nextDateReset}</span>
                      )}
                    </div>
                  )}

                  {/* Kiro 可用模型 */}
                  {providerType === 'claude-kiro-oauth' && provider.availableModels && provider.availableModels.length > 0 && (
                    <div className="kiro-available-models">
                      <span className="models-label">可用模型:</span>
                      <div className="models-tags">
                        {provider.availableModels.map((model, idx) => (
                          <span key={idx} className="model-tag">{model}</span>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              );
            })
          )}
        </div>

        {/* 分页 */}
        {totalCount > pageSize && (
          <div className="pagination">
            <button
              className="pagination-btn"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage(p => p - 1)}
            >
              上一页
            </button>
            <div className="pagination-pages">
              {(() => {
                const totalPages = Math.ceil(totalCount / pageSize);
                const items = [];
                if (totalPages <= 7) {
                  for (let i = 1; i <= totalPages; i += 1) {
                    items.push(i);
                  }
                } else {
                  const left = Math.max(2, currentPage - 2);
                  const right = Math.min(totalPages - 1, currentPage + 2);
                  items.push(1);
                  if (left > 2) items.push('ellipsis-left');
                  for (let i = left; i <= right; i += 1) {
                    items.push(i);
                  }
                  if (right < totalPages - 1) items.push('ellipsis-right');
                  items.push(totalPages);
                }
                return items.map((item, index) => {
                  if (typeof item === 'string') {
                    return (
                      <span key={`${item}-${index}`} className="pagination-ellipsis">...</span>
                    );
                  }
                  return (
                    <button
                      key={item}
                      className={`pagination-number ${currentPage === item ? 'active' : ''}`}
                      onClick={() => setCurrentPage(item)}
                    >
                      {item}
                    </button>
                  );
                });
              })()}
            </div>
            <span className="pagination-info">
              第 {currentPage} 页 / 共 {Math.ceil(totalCount / pageSize)} 页
            </span>
            <button
              className="pagination-btn"
              disabled={currentPage >= Math.ceil(totalCount / pageSize)}
              onClick={() => setCurrentPage(p => p + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </>
    );
  };

  if (error) {
    return (
      <div className="provider-detail-page">
        <div className="page-error">加载失败: {error}</div>
      </div>
    );
  }

  return (
    <div className="provider-detail-page">
      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.type || 'success'}`}>
            {toast.message}
          </div>
        </div>
      )}
      {/* 头部 */}
      <div className="detail-header">
        <div className="detail-header-left">
          <button className="btn btn-back" onClick={() => isInPoolView ? handleBackToPools() : navigate('/providers')}>
            <i className="fas fa-arrow-left" /> 返回
          </button>
          {icon && <img src={icon} alt="" className="header-logo" />}
          <div className="detail-title-block">
            <div className="detail-title-row">
              <h1 className="header-title">{getProviderDisplayName(providerType)}</h1>
              <span className="header-type">{providerType}</span>
            </div>
            {isInPoolView && (
              <div className="detail-subtitle-row">
                <i className="fas fa-chevron-right header-sep" />
                <span className="header-pool">{poolName}</span>
              </div>
            )}
          </div>
        </div>
        <div className="detail-header-right">
          {isInPoolView ? (
            <>
              <button
                className="btn btn-outline"
                onClick={() => {
                  const params = new URLSearchParams({
                    providerType,
                    poolId: poolId ?? '',
                    poolName: poolName || '默认池'
                  });
                  navigate(`/bad-accounts?${params.toString()}`);
                }}
              >
                <i className="fas fa-exclamation-triangle" /> 坏号记录
              </button>
              <button
                className="btn btn-outline"
                onClick={() => {
                  const params = new URLSearchParams({
                    providerType,
                    poolId: poolId ?? '',
                    poolName: poolName || '默认池'
                  });
                  navigate(`/pool-request-logs?${params.toString()}`);
                }}
              >
                <i className="fas fa-list-alt" /> 请求日志
              </button>
              {providerType === 'openai-xai-oauth' && (
                <button
                  className="btn btn-outline"
                  onClick={() => {
                    const params = new URLSearchParams({
                      poolId: poolId ?? '',
                      poolName: poolName || '默认池'
                    });
                    navigate(`/providers/openai-xai-oauth/register?${params.toString()}`);
                  }}
                >
                  <i className="fas fa-user-plus" /> 注册
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => {
                  // Kiro 类型使用专用弹窗
                  if (providerType === 'claude-kiro-oauth') {
                    setShowKiroMethod(true);
                  } else if (providerType === 'openai-codex') {
                    setShowCodexMethod(true);
                  } else if (providerType === 'openai-xai-oauth') {
                    setShowGrokMethod(true);
                  } else {
                    setShowAddAccount(true);
                  }
                }}
              >
                <i className="fas fa-plus" /> 添加账号
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={() => setShowDispatchLogs(true)}>
                <i className="fas fa-exclamation-circle" /> 调度日志
              </button>
              <button className="btn btn-outline" onClick={() => setShowChannelConfig(true)}>
                <i className="fas fa-cog" /> 渠道配置
              </button>
              {providerType === 'openai-xai-oauth' && (
                <button
                  className="btn btn-outline"
                  onClick={() => navigate('/providers/openai-xai-oauth/register')}
                >
                  <i className="fas fa-user-plus" /> 注册
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setShowCreatePool(true)}>
                <i className="fas fa-plus" /> 新建池子
              </button>
            </>
          )}
        </div>
      </div>

      {/* 内容区 */}
      {isInPoolView ? renderAccountList() : renderPoolList()}

      {/* 渠道配置弹窗 */}
      {showChannelConfig && (
        <div className="modal-overlay" onClick={() => setShowChannelConfig(false)}>
          <div className="modal-content modal-channel-config modal-channel-tabbed" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>渠道配置 - {PROVIDER_NAME_MAP[providerType] || providerType}</h3>
              <button className="modal-close" onClick={() => setShowChannelConfig(false)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="channel-config-tabs">
              <button className={`channel-config-tab ${channelConfigTab === 'basic' ? 'active' : ''}`} onClick={() => setChannelConfigTab('basic')}>
                <i className="fas fa-sliders-h" /> 基本配置
              </button>
              <button className={`channel-config-tab ${channelConfigTab === 'routing' ? 'active' : ''}`} onClick={() => setChannelConfigTab('routing')}>
                <i className="fas fa-route" /> 池子路由
              </button>
              {providerType === 'openai-codex' && (
                <button className={`channel-config-tab ${channelConfigTab === 'replenish' ? 'active' : ''}`} onClick={() => setChannelConfigTab('replenish')}>
                  <i className="fas fa-user-plus" /> 自动补号
                </button>
              )}
              {providerType === 'openai-codex' && (
                <button className={`channel-config-tab ${channelConfigTab === 'blacklist' ? 'active' : ''}`} onClick={() => setChannelConfigTab('blacklist')}>
                  <i className="fas fa-ban" /> 黑名单
                </button>
              )}
              <button className={`channel-config-tab ${channelConfigTab === 'mapping' ? 'active' : ''}`} onClick={() => setChannelConfigTab('mapping')}>
                <i className="fas fa-exchange-alt" /> 模型映射
              </button>
            </div>
            <div className="modal-body">

              {/* 基本配置 Tab */}
              {channelConfigTab === 'basic' && (
                <>
                  <div className="form-group">
                    <label>默认模型</label>
                    <CustomSelect
                      value={channelConfig.defaultModel}
                      onChange={(value) => setChannelConfig({ ...channelConfig, defaultModel: value })}
                      options={defaultModelOptions}
                      placeholder={DEFAULT_MODEL_PLACEHOLDER}
                    />
                    <small className="form-hint">当请求未指定模型或模型被禁用时使用的默认模型</small>
                  </div>

                  {providerType === 'openai-xai-oauth' && (
                    <div className="config-form-section">
                      <div className="config-form-section-title">
                        <i className="fas fa-random" /> Grok 请求路径（全渠道切换）
                      </div>
                      <div className="config-form-grid">
                        <div className="config-form-item full">
                          <label>请求路径</label>
                          <select
                            className="form-input"
                            value={String(channelConfig.XAI_USING_API ?? '')}
                            onChange={(e) => setChannelConfig(prev => ({
                              ...prev,
                              XAI_USING_API: e.target.value
                            }))}
                          >
                            {XAI_ROUTE_OPTIONS.map(option => (
                              <option key={option.value || 'auto'} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <small className="form-hint">
                            保存后立即对<strong>全部 Grok 账号</strong>生效：推理请求 + 额度查询一起切换。
                            官方 API 走 <code>api.x.ai</code>（有 api:access 时可用，额度明细不可用）；
                            Build 走 <code>cli-chat-proxy.grok.com</code>（可查套餐额度）。
                            账号级「请求路径」若单独设置，会覆盖本渠道默认值。
                          </small>
                        </div>
                        <div className="config-form-item">
                          <label>官方 API 端点</label>
                          <input
                            type="text"
                            className="form-input mono"
                            value="https://api.x.ai/v1"
                            readOnly
                          />
                        </div>
                        <div className="config-form-item">
                          <label>Grok Build 端点</label>
                          <input
                            type="text"
                            className="form-input mono"
                            value="https://cli-chat-proxy.grok.com/v1"
                            readOnly
                          />
                        </div>
                        <div className="config-form-item full">
                          <div className="form-hint" style={{
                            display: 'flex',
                            gap: 12,
                            flexWrap: 'wrap',
                            padding: '10px 12px',
                            borderRadius: 8,
                            background: 'var(--surface-2, rgba(0,0,0,0.04))'
                          }}>
                            <span>
                              当前选择：
                              <strong>
                                {channelConfig.XAI_USING_API === 'true'
                                  ? ' xAI 官方 API'
                                  : channelConfig.XAI_USING_API === 'false'
                                    ? ' Grok Build 代理'
                                    : ' 自动（按 Token 权限）'}
                              </strong>
                            </span>
                            <span>
                              额度：
                              <strong>
                                {channelConfig.XAI_USING_API === 'true'
                                  ? ' 官方 API 不提供套餐额度明细'
                                  : ' Build 路径可查询周额度 / 套餐'}
                              </strong>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {providerType === 'openai-codex' && (
                    <div className="config-form-section">
                      <div className="config-form-section-title"><i className="fas fa-comments" /> OpenAI Chat 兼容</div>
                      <div className="config-form-grid">
                        <div className="config-form-item full">
                          <label>支持 `/v1/chat/completions` 转 Codex Responses</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexOpenAIChatCompatEnabled === true}
                                onChange={e => setChannelConfig(prev => ({ ...prev, codexOpenAIChatCompatEnabled: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexOpenAIChatCompatEnabled ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexOpenAIChatCompatEnabled ? '已启用' : '已禁用'}
                            </span>
                          </div>
                          <small className="form-hint">仅对 `openai-codex` 渠道生效。开启后可用 OpenAI Chat 协议访问（会自动转为 Codex Responses）；关闭时 `/v1/chat/completions` 会返回 400，并提示使用 `/v1/responses`。</small>
                        </div>
                      </div>
                    </div>
                  )}

                  {providerType === 'openai-codex' && (
                    <div className="config-form-section">
                      <div className="config-form-section-title"><i className="fas fa-exchange-alt" /> Claude Messages 兼容</div>
                      <div className="config-form-grid">
                        <div className="config-form-item full">
                          <label>支持 `/v1/messages` 转 Codex Responses</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexClaudeMessagesCompatEnabled === true}
                                onChange={e => setChannelConfig(prev => ({ ...prev, codexClaudeMessagesCompatEnabled: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexClaudeMessagesCompatEnabled ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexClaudeMessagesCompatEnabled ? '已启用' : '已禁用'}
                            </span>
                          </div>
                          <small className="form-hint">仅对 `openai-codex` 渠道生效。开启后，Claude / `v1/messages` 请求会定向转换到 Codex Responses，并做专门回包适配；关闭时保持现状不变。</small>
                        </div>
                        <div className="config-form-item">
                          <label>推理强度</label>
                          <CustomSelect
                            value={String(channelConfig.codexClaudeMessagesReasoningEffort || 'auto')}
                            onChange={value => setChannelConfig(prev => ({ ...prev, codexClaudeMessagesReasoningEffort: value || 'auto' }))}
                            options={CODEX_CLAUDE_REASONING_EFFORT_OPTIONS}
                            placeholder="推理强度"
                          />
                          <small className="form-hint">映射到 `reasoning.effort`。选择“跟随 Claude”时沿用当前自动推断。</small>
                        </div>
                        <div className="config-form-item">
                          <label>输出冗长度</label>
                          <CustomSelect
                            value={String(channelConfig.codexClaudeMessagesVerbosity || 'default')}
                            onChange={value => setChannelConfig(prev => ({ ...prev, codexClaudeMessagesVerbosity: value || 'default' }))}
                            options={CODEX_CLAUDE_VERBOSITY_OPTIONS}
                            placeholder="输出冗长度"
                          />
                          <small className="form-hint">映射到 Responses API 的 `text.verbosity`。不支持的模型会忽略或报 400。</small>
                        </div>
                        <div className="config-form-item">
                          <label>服务档位</label>
                          <CustomSelect
                            value={String(channelConfig.codexClaudeMessagesServiceTier || 'standard')}
                            onChange={value => setChannelConfig(prev => ({ ...prev, codexClaudeMessagesServiceTier: value || 'standard' }))}
                            options={CODEX_CLAUDE_SERVICE_TIER_OPTIONS}
                            placeholder="服务档位"
                          />
                          <small className="form-hint">`fast` 会映射为 `service_tier=priority`，`flex` 会映射为 `service_tier=flex`。</small>
                        </div>
                        <div className="config-form-item">
                          <label>Prompt Cache</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexClaudeMessagesPromptCacheEnabled !== false}
                                onChange={e => setChannelConfig(prev => ({ ...prev, codexClaudeMessagesPromptCacheEnabled: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexClaudeMessagesPromptCacheEnabled !== false ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexClaudeMessagesPromptCacheEnabled !== false ? '已启用' : '已禁用'}
                            </span>
                          </div>
                          <small className="form-hint">启用后会使用 Claude Session 生成稳定的 `prompt_cache_key`，提升同会话缓存命中率。</small>
                        </div>
                        <div className="config-form-item full">
                          <label>兼容链路模型映射</label>
                          <div className="model-mapping-add">
                            <div className="mapping-select-wrap">
                              <input
                                type="text"
                                className="form-input"
                                value={newCompatMappingFrom}
                                onChange={e => setNewCompatMappingFrom(e.target.value)}
                                placeholder="Claude 请求模型，如 claude-opus-4-6"
                              />
                            </div>
                            <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                            <div className="mapping-select-wrap">
                              <CustomSelect
                                value={newCompatMappingTo}
                                onChange={setNewCompatMappingTo}
                                options={compatMappingToOptions}
                                placeholder="Codex 目标模型"
                                searchable
                              />
                            </div>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={!newCompatMappingFrom || !newCompatMappingTo}
                              onClick={() => {
                                if (newCompatMappingFrom && newCompatMappingTo) {
                                  setChannelConfig(prev => ({
                                    ...prev,
                                    codexClaudeMessagesModelMapping: {
                                      ...(prev.codexClaudeMessagesModelMapping || {}),
                                      [newCompatMappingFrom]: newCompatMappingTo
                                    }
                                  }));
                                  setNewCompatMappingFrom('');
                                  setNewCompatMappingTo('');
                                }
                              }}
                            >
                              <i className="fas fa-plus" /> 添加
                            </button>
                          </div>
                          {Object.keys(channelConfig.codexClaudeMessagesModelMapping || {}).length > 0 ? (
                            <div className="model-mapping-list" style={{ marginTop: 8 }}>
                              {Object.entries(channelConfig.codexClaudeMessagesModelMapping).map(([from, to]) => (
                                <div key={from} className="model-mapping-item">
                                  <span className="mapping-from">{from}</span>
                                  <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                                  <span className="mapping-to">{to}</span>
                                  <button
                                    className="btn btn-outline btn-sm mapping-delete"
                                    onClick={() => {
                                      setChannelConfig(prev => {
                                        const next = { ...(prev.codexClaudeMessagesModelMapping || {}) };
                                        delete next[from];
                                        return { ...prev, codexClaudeMessagesModelMapping: next };
                                      });
                                    }}
                                  >
                                    <i className="fas fa-trash" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <small className="form-hint">仅在 `/v1/messages` 兼容链路生效。默认已内置 `claude-opus-4-6 → gpt-5.5`，保存后会持久化到渠道配置。</small>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {providerType === 'openai-xai-oauth' && (
                    <div className="config-form-section">
                      <div className="config-form-section-title"><i className="fas fa-exchange-alt" /> Anthropic Messages 兼容</div>
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>默认目标模型</label>
                          <CustomSelect
                            value={channelConfig.xaiClaudeMessagesDefaultModel || 'grok-4.5'}
                            onChange={value => setChannelConfig(prev => ({ ...prev, xaiClaudeMessagesDefaultModel: value || 'grok-4.5' }))}
                            options={compatMappingToOptions}
                            placeholder="Grok 目标模型"
                            searchable
                          />
                          <small className="form-hint">`/v1/messages` 请求带 Claude 模型名但未命中映射时使用。</small>
                        </div>
                        <div className="config-form-item full">
                          <label>Claude 模型映射</label>
                          <div className="model-mapping-add">
                            <div className="mapping-select-wrap">
                              <input
                                type="text"
                                className="form-input"
                                value={newCompatMappingFrom}
                                onChange={e => setNewCompatMappingFrom(e.target.value)}
                                placeholder="Claude 请求模型，如 claude-sonnet-4-5"
                              />
                            </div>
                            <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                            <div className="mapping-select-wrap">
                              <CustomSelect
                                value={newCompatMappingTo}
                                onChange={setNewCompatMappingTo}
                                options={compatMappingToOptions}
                                placeholder="Grok 目标模型"
                                searchable
                              />
                            </div>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={!newCompatMappingFrom || !newCompatMappingTo}
                              onClick={() => {
                                if (newCompatMappingFrom && newCompatMappingTo) {
                                  setChannelConfig(prev => ({
                                    ...prev,
                                    xaiClaudeMessagesModelMapping: {
                                      ...(prev.xaiClaudeMessagesModelMapping || {}),
                                      [newCompatMappingFrom]: newCompatMappingTo
                                    }
                                  }));
                                  setNewCompatMappingFrom('');
                                  setNewCompatMappingTo('');
                                }
                              }}
                            >
                              <i className="fas fa-plus" /> 添加
                            </button>
                          </div>
                          {Object.keys(channelConfig.xaiClaudeMessagesModelMapping || {}).length > 0 ? (
                            <div className="model-mapping-list" style={{ marginTop: 8 }}>
                              {Object.entries(channelConfig.xaiClaudeMessagesModelMapping).map(([from, to]) => (
                                <div key={from} className="model-mapping-item">
                                  <span className="mapping-from">{from}</span>
                                  <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                                  <span className="mapping-to">{to}</span>
                                  <button
                                    className="btn btn-outline btn-sm mapping-delete"
                                    onClick={() => {
                                      setChannelConfig(prev => {
                                        const next = { ...(prev.xaiClaudeMessagesModelMapping || {}) };
                                        delete next[from];
                                        return { ...prev, xaiClaudeMessagesModelMapping: next };
                                      });
                                    }}
                                  >
                                    <i className="fas fa-trash" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <small className="form-hint">默认会把常见 `claude-*` 模型映射到 `grok-4.5`。</small>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {providerType === 'openai-codex' && (
                    <div className="config-form-section">
                      <div className="config-form-section-title"><i className="fas fa-link" /> Codex 渠道调度</div>
                      <div className="config-form-grid">
                        <div className="config-form-item full">
                          <label>图片生成能力</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexImageGenerationEnabled !== false}
                                onChange={e => setChannelConfig(prev => ({
                                  ...prev,
                                  codexImageGenerationEnabled: e.target.checked
                                }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexImageGenerationEnabled !== false ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexImageGenerationEnabled !== false ? '已开启' : '已关闭'}
                            </span>
                          </div>
                          <small className="form-hint">仅对 `openai-codex` 渠道的 `/v1/images/generations` 生效。关闭后该渠道不再提供 image 能力，请求会直接返回 400。</small>
                        </div>
                        <div className="config-form-item full">
                          <label>图片生成链路切换</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                disabled={channelConfig.codexImageGenerationEnabled === false}
                                checked={channelConfig.codexImageGenerationMode === 'responses-tool'}
                                onChange={e => setChannelConfig(prev => ({
                                  ...prev,
                                  codexImageGenerationMode: e.target.checked ? 'responses-tool' : 'web-conversation'
                                }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexImageGenerationMode === 'responses-tool' ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexImageGenerationMode === 'responses-tool' ? '新链路：Responses Tool' : '旧链路：网页会话'}
                            </span>
                          </div>
                          <small className="form-hint">开启图片能力后可切换 old/new。旧链路走网页会话与附件下载；新链路走 `Responses + image_generation tool`，更接近 demo 里的 `gpt-image-2` 实现。</small>
                        </div>
                        <div className="config-form-item">
                          <label>请求参数严格对齐</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexStrictRequestAlignment === true}
                                onChange={e => setChannelConfig(prev => ({ ...prev, codexStrictRequestAlignment: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexStrictRequestAlignment === true ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexStrictRequestAlignment === true ? '已启用' : '已禁用'}
                            </span>
                          </div>
                          <small className="form-hint">仅对 `openai-codex` 渠道生效。启用后将更严格贴近 Codex 原生请求字段；默认关闭以避免影响兼容性。</small>
                        </div>
                        <div className="config-form-item">
                          <label>粘性会话</label>
                          <div className="toggle-switch-wrapper">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={channelConfig.codexStickySessionEnabled !== false}
                                onChange={e => setChannelConfig(prev => ({ ...prev, codexStickySessionEnabled: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <span className={`toggle-label ${channelConfig.codexStickySessionEnabled !== false ? 'enabled' : 'disabled'}`}>
                              {channelConfig.codexStickySessionEnabled !== false ? '已启用' : '已禁用'}
                            </span>
                          </div>
                          <small className="form-hint">对所有 `openai-codex` 请求生效。启用后，同一 Session 会优先绑定到同一个 Codex 账号，提升上下文连续性与 Prompt Cache 命中率。</small>
                        </div>
                        <div className="config-form-item full">
                          <label>高并发用户绕过指纹粘性</label>
                          <textarea
                            className="form-textarea"
                            rows={3}
                            value={normalizeIdentityList(channelConfig.codexHighConcurrencyUserIds).join('\n')}
                            onChange={e => setChannelConfig(prev => ({
                              ...prev,
                              codexHighConcurrencyUserIds: normalizeIdentityList(e.target.value)
                            }))}
                            placeholder="每行一个，例如：30"
                          />
                          <small className="form-hint">匹配 userId、email、username、tokenId 或带前缀的 user:30/token:120/ip:43.155.215.189。命中后只绕过 fingerprint 粘性；请求带真实 session 时仍按 session 绑定。</small>
                        </div>
                      </div>
                    </div>
                  )}
                  {USAGE_SUPPORTED_TYPES.has(providerType) && (
                    <div className="form-group">
                      <label>用量定时刷新</label>
                      <CustomSelect
                        size="small"
                        value={String(channelConfig.usageRefreshEnabled ?? 'global')}
                        onChange={v => setChannelConfig(prev => ({ ...prev, usageRefreshEnabled: v === 'true' ? true : v === 'false' ? false : 'global' }))}
                        options={[
                          { value: 'global', label: '跟随全局' },
                          { value: 'true', label: '强制启用' },
                          { value: 'false', label: '强制禁用' },
                        ]}
                      />
                      <small className="form-hint">跟随全局：由系统配置页的"用量定时刷新"开关控制</small>
                    </div>
                  )}
                  <div className="form-group">
                    <label>健康检测</label>
                    <CustomSelect
                      size="small"
                      value={String(channelConfig.healthCheckEnabled ?? 'global')}
                      onChange={v => setChannelConfig(prev => ({ ...prev, healthCheckEnabled: v === 'true' ? true : v === 'false' ? false : 'global' }))}
                      options={[
                        { value: 'global', label: '跟随全局' },
                        { value: 'true', label: '强制启用' },
                        { value: 'false', label: '强制禁用' },
                      ]}
                    />
                    <small className="form-hint">跟随全局：由系统配置页的"健康检测"开关控制；禁用后该渠道所有池子不再自动检测</small>
                  </div>
                  {providerType === 'claude-kiro-oauth' && (
                    <div className="form-group">
                      <label>禁用模型</label>
                      <div className="checkbox-group">
                        {KIRO_DISABLED_MODEL_LIST.map(model => (
                          <label key={model} className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={channelConfig.disabledModels?.includes(model)}
                              onChange={e => {
                                const newDisabled = e.target.checked
                                  ? [...(channelConfig.disabledModels || []), model]
                                  : (channelConfig.disabledModels || []).filter(m => m !== model);
                                setChannelConfig({ ...channelConfig, disabledModels: newDisabled });
                              }}
                            />
                            {model}
                          </label>
                        ))}
                      </div>
                      <small className="form-hint">勾选的模型将被禁用，请求时自动回退到默认模型</small>
                    </div>
                  )}
                  {providerType === 'claude-kiro-oauth' && (
                    <div className="form-group">
                      <label>缓存模拟</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={channelConfig.cacheSimulationEnabled !== false}
                            onChange={e => setChannelConfig({ ...channelConfig, cacheSimulationEnabled: e.target.checked })}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                        <span className={`toggle-label ${channelConfig.cacheSimulationEnabled !== false ? 'enabled' : 'disabled'}`}>
                          {channelConfig.cacheSimulationEnabled !== false ? '启用' : '禁用'}
                        </span>
                      </div>
                      <small className="form-hint">模拟 Claude API 的 ephemeral 缓存行为，减少重复 token 计费（TTL 5分钟）</small>
                    </div>
                  )}
                  {providerType === 'claude-offical' && (
                    <div className="official-dispatch-config">
                      {/* 粘性会话 */}
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-link" /> 粘性会话</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>粘性会话</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialStickySessionEnabled !== false} onChange={e => setChannelConfig(prev => ({ ...prev, officialStickySessionEnabled: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialStickySessionEnabled !== false ? 'enabled' : 'disabled'}`}>{channelConfig.officialStickySessionEnabled !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>TTL (分钟)</label>
                              <input className="form-input" type="number" min="1" value={channelConfig.officialStickySessionTtlMinutes} onChange={e => setChannelConfig(prev => ({ ...prev, officialStickySessionTtlMinutes: Number(e.target.value) || 60 }))} />
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>严格绑定</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialSessionBindingStrict === true} onChange={e => setChannelConfig(prev => ({ ...prev, officialSessionBindingStrict: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialSessionBindingStrict ? 'enabled' : 'disabled'}`}>{channelConfig.officialSessionBindingStrict ? '启用' : '禁用'}</span>
                              </div>
                              <small className="form-hint">启用后会话只绑定一个账号，不允许漂移</small>
                            </div>
                            <div className="form-group">
                              <label>身份模式</label>
                              <CustomSelect
                                size="small"
                                value={channelConfig.officialStickyIdentityMode || 'session-or-fingerprint'}
                                onChange={v => setChannelConfig(prev => ({ ...prev, officialStickyIdentityMode: v }))}
                                options={CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 指纹配置 */}
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-fingerprint" /> 指纹配置</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>包含用户</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialFingerprintIncludeUser !== false} onChange={e => setChannelConfig(prev => ({ ...prev, officialFingerprintIncludeUser: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialFingerprintIncludeUser !== false ? 'enabled' : 'disabled'}`}>{channelConfig.officialFingerprintIncludeUser !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>包含 Token</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialFingerprintIncludeToken !== false} onChange={e => setChannelConfig(prev => ({ ...prev, officialFingerprintIncludeToken: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialFingerprintIncludeToken !== false ? 'enabled' : 'disabled'}`}>{channelConfig.officialFingerprintIncludeToken !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>包含路径</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialFingerprintIncludePath === true} onChange={e => setChannelConfig(prev => ({ ...prev, officialFingerprintIncludePath: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialFingerprintIncludePath ? 'enabled' : 'disabled'}`}>{channelConfig.officialFingerprintIncludePath ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>指纹盐值</label>
                              <input className="form-input" type="text" value={channelConfig.officialFingerprintSalt || ''} onChange={e => setChannelConfig(prev => ({ ...prev, officialFingerprintSalt: e.target.value }))} placeholder="可选，自定义盐值" />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 队列锁 */}
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-lock" /> 队列锁</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>队列锁</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialQueueLockEnabled !== false} onChange={e => setChannelConfig(prev => ({ ...prev, officialQueueLockEnabled: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialQueueLockEnabled !== false ? 'enabled' : 'disabled'}`}>{channelConfig.officialQueueLockEnabled !== false ? '启用' : '禁用'}</span>
                              </div>
                              <small className="form-hint">减少同账号并发风控</small>
                            </div>
                            <div className="form-group">
                              <label>锁 TTL (ms)</label>
                              <input className="form-input" type="number" min="1000" value={channelConfig.officialQueueLockTtlMs} onChange={e => setChannelConfig(prev => ({ ...prev, officialQueueLockTtlMs: Number(e.target.value) || 120000 }))} />
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>等待超时 (ms)</label>
                              <input className="form-input" type="number" min="1000" value={channelConfig.officialQueueWaitTimeoutMs} onChange={e => setChannelConfig(prev => ({ ...prev, officialQueueWaitTimeoutMs: Number(e.target.value) || 30000 }))} />
                            </div>
                            <div className="form-group">
                              <label>轮询间隔 (ms)</label>
                              <input className="form-input" type="number" min="50" value={channelConfig.officialQueuePollIntervalMs} onChange={e => setChannelConfig(prev => ({ ...prev, officialQueuePollIntervalMs: Number(e.target.value) || 150 }))} />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 冷却 & 隔离 */}
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-shield-alt" /> 冷却 & 隔离</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>429 限流冷却 (ms)</label>
                              <input className="form-input" type="number" min="1000" value={channelConfig.officialRateLimitCooldownMs} onChange={e => setChannelConfig(prev => ({ ...prev, officialRateLimitCooldownMs: Number(e.target.value) || 30000 }))} />
                            </div>
                            <div className="form-group">
                              <label>529 过载冷却 (ms)</label>
                              <input className="form-input" type="number" min="1000" value={channelConfig.officialOverloadCooldownMs} onChange={e => setChannelConfig(prev => ({ ...prev, officialOverloadCooldownMs: Number(e.target.value) || 60000 }))} />
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>验证封禁隔离 (分钟)</label>
                              <input className="form-input" type="number" min="1" value={channelConfig.officialValidationBlockMinutes} onChange={e => setChannelConfig(prev => ({ ...prev, officialValidationBlockMinutes: Number(e.target.value) || 30 }))} />
                            </div>
                            <div className="form-group">
                              <label>5h 警告自动停调度</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.officialAutoStopOnWarning === true} onChange={e => setChannelConfig(prev => ({ ...prev, officialAutoStopOnWarning: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.officialAutoStopOnWarning ? 'enabled' : 'disabled'}`}>{channelConfig.officialAutoStopOnWarning ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 上下文压缩阈值 */}
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-compress-arrows-alt" /> 上下文压缩阈值</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>L1 tool截断</label>
                              <input className="form-input" type="number" step="0.01" min="0" max="1" value={channelConfig.officialContextL1Threshold} onChange={e => setChannelConfig(prev => ({ ...prev, officialContextL1Threshold: Number(e.target.value) || 0.40 }))} />
                            </div>
                            <div className="form-group">
                              <label>L2 thinking清理</label>
                              <input className="form-input" type="number" step="0.01" min="0" max="1" value={channelConfig.officialContextL2Threshold} onChange={e => setChannelConfig(prev => ({ ...prev, officialContextL2Threshold: Number(e.target.value) || 0.55 }))} />
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>L3 fork摘要</label>
                              <input className="form-input" type="number" step="0.01" min="0" max="1" value={channelConfig.officialContextL3Threshold} onChange={e => setChannelConfig(prev => ({ ...prev, officialContextL3Threshold: Number(e.target.value) || 0.70 }))} />
                            </div>
                            <div className="form-group" />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {providerType === 'claude-antigravity' && (
                    <div className="official-dispatch-config">
                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-link" /> 粘性会话</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>粘性会话</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.antigravityStickySessionEnabled !== false} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityStickySessionEnabled: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.antigravityStickySessionEnabled !== false ? 'enabled' : 'disabled'}`}>{channelConfig.antigravityStickySessionEnabled !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>TTL (分钟)</label>
                              <input className="form-input" type="number" min="1" value={channelConfig.antigravityStickySessionTtlMinutes} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityStickySessionTtlMinutes: Number(e.target.value) || 60 }))} />
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>严格绑定</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.antigravitySessionBindingStrict === true} onChange={e => setChannelConfig(prev => ({ ...prev, antigravitySessionBindingStrict: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.antigravitySessionBindingStrict ? 'enabled' : 'disabled'}`}>{channelConfig.antigravitySessionBindingStrict ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>身份模式</label>
                              <CustomSelect
                                value={channelConfig.antigravityStickyIdentityMode || 'session-or-fingerprint'}
                                onChange={v => setChannelConfig(prev => ({ ...prev, antigravityStickyIdentityMode: v }))}
                                options={CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="config-form-section">
                        <div className="config-form-section-title"><i className="fas fa-fingerprint" /> 指纹策略</div>
                        <div className="config-form-grid">
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>包含用户</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.antigravityFingerprintIncludeUser !== false} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityFingerprintIncludeUser: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.antigravityFingerprintIncludeUser !== false ? 'enabled' : 'disabled'}`}>{channelConfig.antigravityFingerprintIncludeUser !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>包含 Token</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.antigravityFingerprintIncludeToken !== false} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityFingerprintIncludeToken: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.antigravityFingerprintIncludeToken !== false ? 'enabled' : 'disabled'}`}>{channelConfig.antigravityFingerprintIncludeToken !== false ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                          </div>
                          <div className="form-row-2col">
                            <div className="form-group">
                              <label>包含路径</label>
                              <div className="toggle-switch-wrapper">
                                <label className="toggle-switch">
                                  <input type="checkbox" checked={channelConfig.antigravityFingerprintIncludePath === true} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityFingerprintIncludePath: e.target.checked }))} />
                                  <span className="toggle-slider"></span>
                                </label>
                                <span className={`toggle-label ${channelConfig.antigravityFingerprintIncludePath ? 'enabled' : 'disabled'}`}>{channelConfig.antigravityFingerprintIncludePath ? '启用' : '禁用'}</span>
                              </div>
                            </div>
                            <div className="form-group">
                              <label>指纹盐值</label>
                              <input className="form-input" type="text" value={channelConfig.antigravityFingerprintSalt || ''} onChange={e => setChannelConfig(prev => ({ ...prev, antigravityFingerprintSalt: e.target.value }))} placeholder="可选，自定义盐值" />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              {/* 池子路由 Tab */}
              {channelConfigTab === 'routing' && (
              <div className="form-group">
                <label>池子路由策略</label>
                <div className="form-row-2col">
                  <div className="form-group">
                    <label>默认策略</label>
                    <CustomSelect
                      value={poolRouting.default.strategy}
                      onChange={(value) => updatePoolRouting(current => ({
                        ...current,
                        default: { ...current.default, strategy: value }
                      }))}
                      options={POOL_ROUTING_STRATEGY_OPTIONS}
                    />
                  </div>
                  <div className="form-group">
                    <label>默认池子</label>
                    <div className="checkbox-group compact">
                      {pools.length === 0 && <span className="form-hint">暂无池子可选</span>}
                      {pools.map(pool => (
                        <label key={`routing-default-${pool.id}`} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={poolRouting.default.poolIds?.includes(pool.id)}
                            onChange={() => updatePoolRouting(current => ({
                              ...current,
                              default: {
                                ...current.default,
                                poolIds: togglePoolId(current.default.poolIds, pool.id)
                              }
                            }))}
                          />
                          {pool.name} (#{pool.id}){pool.isDefault ? ' 默认' : ''}
                        </label>
                      ))}
                    </div>
                    <small className="form-hint">未命中规则时使用的池子列表（优先顺序按勾选顺序）</small>
                  </div>
                </div>
                {providerType === 'claude-kiro-oauth' ? (
                  <div className="form-group">
                    <div className="form-row-inline">
                      <span className="form-hint">模型池子规则（为每个模型指定可用池子与策略）</span>
                    </div>
                    <div className="kiro-model-routing-list">
                      {KIRO_POOL_ROUTING_MODELS.map(model => {
                        const rule = kiroRoutingMap.get(model);
                        const selectedPoolIds = rule?.poolIds || [];
                        const hasCustomPools = selectedPoolIds.length > 0;
                        const selectedStrategy = rule?.strategy || poolRouting.default.strategy;
                        return (
                          <div key={`kiro-routing-${model}`} className="pool-routing-rule kiro-model-rule">
                            <div className="kiro-model-rule-header">
                              <span className="kiro-model-name">{model}</span>
                              {!hasCustomPools && (
                                <span className="form-hint">未配置则跟随默认策略与池子</span>
                              )}
                            </div>
                            <div className="form-row-2col kiro-model-rule-row">
                              <div className="form-group">
                                <label>策略</label>
                                <CustomSelect
                                  value={selectedStrategy}
                                  onChange={(value) => updateKiroModelRouting(model, { strategy: value })}
                                  options={POOL_ROUTING_STRATEGY_OPTIONS}
                                  disabled={!hasCustomPools}
                                  size="small"
                                />
                              </div>
                              <div className="form-group">
                                <label>池子</label>
                                <div className="checkbox-group compact">
                                  {pools.length === 0 && <span className="form-hint">暂无池子可选</span>}
                                  {pools.map(pool => (
                                    <label key={`kiro-routing-${model}-${pool.id}`} className="checkbox-label">
                                      <input
                                        type="checkbox"
                                        checked={selectedPoolIds.includes(pool.id)}
                                        onChange={() => updateKiroModelRouting(model, {
                                          poolIds: togglePoolId(selectedPoolIds, pool.id)
                                        })}
                                      />
                                      {pool.name} (#{pool.id}){pool.isDefault ? ' 默认' : ''}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="form-group">
                    <div className="form-row-inline">
                      <span className="form-hint">模型规则（支持 * 通配，可按当前渠道模型精细路由）</span>
                      <button className="btn btn-outline btn-sm" type="button" onClick={addPoolRoutingRule}>
                        <i className="fas fa-plus" /> 添加规则
                      </button>
                    </div>
                    {poolRouting.rules.length === 0 && (
                      <div className="form-hint">暂无规则，当前仅使用默认策略</div>
                    )}
                    {poolRouting.rules.map((rule, index) => (
                      <div key={`pool-routing-rule-${index}`} className="pool-routing-rule">
                        <div className="form-row-2col">
                          <div className="form-group">
                            <label>模型匹配</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder={routingRuleModelPlaceholder}
                              value={(rule.models || []).join(', ')}
                              onChange={e => {
                                const models = e.target.value
                                  .split(',')
                                  .map(v => v.trim())
                                  .filter(Boolean);
                                updatePoolRoutingRule(index, { models });
                              }}
                            />
                            {routingRuleModelOptions.length > 0 && (
                              <>
                                <div style={{ marginTop: 8 }}>
                                  <CustomSelect
                                    size="small"
                                    value=""
                                    searchable
                                    placeholder={providerType === 'openai-codex' ? '快捷添加 GPT 模型' : '快捷添加模型'}
                                    options={routingRuleModelOptions.filter(option => !(rule.models || []).includes(option.value))}
                                    onChange={(value) => {
                                      if (!value) return;
                                      updatePoolRoutingRule(index, {
                                        models: [...new Set([...(rule.models || []), value])]
                                      });
                                    }}
                                  />
                                </div>
                                <small className="form-hint">先下拉添加精确模型；需要通配时再手动补 *</small>
                              </>
                            )}
                          </div>
                          <div className="form-group">
                            <label>策略</label>
                            <CustomSelect
                              value={rule.strategy || 'priority'}
                              onChange={(value) => updatePoolRoutingRule(index, { strategy: value })}
                              options={POOL_ROUTING_STRATEGY_OPTIONS}
                            />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>池子</label>
                          <div className="checkbox-group compact">
                            {pools.length === 0 && <span className="form-hint">暂无池子可选</span>}
                            {pools.map(pool => (
                              <label key={`routing-rule-${index}-${pool.id}`} className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={rule.poolIds?.includes(pool.id)}
                                  onChange={() => updatePoolRoutingRule(index, {
                                    poolIds: togglePoolId(rule.poolIds, pool.id)
                                  })}
                                />
                                {pool.name} (#{pool.id}){pool.isDefault ? ' 默认' : ''}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="form-group">
                          <button className="btn btn-outline btn-sm" type="button" onClick={() => removePoolRoutingRule(index)}>
                            <i className="fas fa-trash" /> 删除规则
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}

              {channelConfigTab === 'replenish' && providerType === 'openai-codex' && (
                <div className="codex-replenish-panel">
                  <div className="config-form-section">
                    <div className="config-form-section-title">自动补号开关</div>
                    <div className="config-form-grid">
                      <div className="config-form-item full">
                        <label>自动补号</label>
                        <div className="toggle-switch-wrapper codex-replenish-toggle-row">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={channelConfig.codexAutoReplenishEnabled === true}
                              onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishEnabled: e.target.checked }))}
                            />
                            <span className="toggle-slider"></span>
                          </label>
                          <span className={`toggle-label ${channelConfig.codexAutoReplenishEnabled ? 'enabled' : 'disabled'}`}>
                            {channelConfig.codexAutoReplenishEnabled ? '已启用' : '已禁用'}
                          </span>
                        </div>
                        <small className="form-hint">首次请求前如果健康号低于阈值，会在定时检测和删号后自动尝试补号。</small>
                      </div>
                      <div className="config-form-item">
                        <label>补号阈值</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={channelConfig.codexAutoReplenishThreshold}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishThreshold: e.target.value }))}
                          placeholder="50 或 100"
                        />
                        <small className="form-hint">常用值：50 / 100</small>
                      </div>
                      <div className="config-form-item">
                        <label>每次补号数量</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={channelConfig.codexAutoReplenishBatchSize}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishBatchSize: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="config-form-section">
                    <div className="config-form-section-title">执行配置</div>
                    <div className="config-form-grid">
                      <div className="config-form-item">
                        <label>补号模式</label>
                        <select
                          value={channelConfig.codexAutoReplenishMode || 'native'}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishMode: e.target.value }))}
                        >
                          <option value="native">原生协议</option>
                          <option value="script">兼容脚本</option>
                        </select>
                        <small className="form-hint">推荐原生协议：DuckMail 获取 → 注册 → OAuth 授权 → 自动导入 AccountHub。</small>
                      </div>
                      <div className="config-form-item">
                        <label>目标池子</label>
                        <select
                          value={channelConfig.codexAutoReplenishPoolId ?? ''}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishPoolId: e.target.value }))}
                        >
                          <option value="">全部池子</option>
                          {pools.map(pool => (
                            <option key={pool.id} value={String(pool.id)}>
                              {pool.name || `池子 ${pool.id}`}{pool.isDefault ? '（默认）' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="config-form-item full">
                        <label>{channelConfig.codexAutoReplenishMode === 'script' ? '脚本路径' : '执行模块路径'}</label>
                        <input
                          className="mono"
                          type="text"
                          value={channelConfig.codexAutoReplenishScriptPath}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishScriptPath: e.target.value }))}
                          placeholder={channelConfig.codexAutoReplenishMode === 'script'
                            ? '/Users/liumingkang/AI/Project/Kiro-auto-register-main/gpt_simple.py'
                            : '/Users/liumingkang/AI/Project/Kiro-auto-register-main/out/main/gptRegister-*.js（留空自动探测）'}
                        />
                      </div>
                      <div className="config-form-item">
                        <label>超时秒数</label>
                        <input
                          type="number"
                          min="30"
                          step="1"
                          value={channelConfig.codexAutoReplenishTimeoutSeconds}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishTimeoutSeconds: e.target.value }))}
                        />
                      </div>
                      {channelConfig.codexAutoReplenishMode === 'script' ? (
                        <div className="config-form-item">
                          <label>Python 命令</label>
                          <input
                            className="mono"
                            type="text"
                            value={channelConfig.codexAutoReplenishPythonBin}
                            onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishPythonBin: e.target.value }))}
                            placeholder="python3"
                          />
                        </div>
                      ) : (
                        <div className="config-form-item">
                          <label>DuckMail API</label>
                          <input
                            className="mono"
                            type="text"
                            value={channelConfig.codexAutoReplenishDuckMailApiBase}
                            onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishDuckMailApiBase: e.target.value }))}
                            placeholder="https://api.duckmail.sbs"
                          />
                        </div>
                      )}
                      {channelConfig.codexAutoReplenishMode === 'native' && (
                        <>
                          <div className="config-form-item">
                            <label>DuckMail 域名</label>
                            <input
                              type="text"
                              value={channelConfig.codexAutoReplenishDuckMailDomain}
                              onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishDuckMailDomain: e.target.value }))}
                              placeholder="留空自动轮换"
                            />
                          </div>
                          <div className="config-form-item full">
                            <label>DuckMail Key</label>
                            <input
                              className="mono"
                              type="password"
                              value={channelConfig.codexAutoReplenishDuckMailApiKey}
                              onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishDuckMailApiKey: e.target.value }))}
                              placeholder="可选；私有域名时填写"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="config-form-section">
                    <div className="config-form-section-title">代理配置</div>
                    <div className="config-form-grid">
                      <div className="config-form-item full">
                        <label>固定代理</label>
                        <input
                          className="mono"
                          type="text"
                          value={channelConfig.codexAutoReplenishProxy}
                          onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishProxy: e.target.value }))}
                          placeholder="http://user:pass@host:port"
                        />
                        <small className="form-hint">不使用代理池时，原生协议/脚本模式都会走这个固定代理。</small>
                      </div>
                      <div className="config-form-item full">
                        <label>代理池</label>
                        <div className="toggle-switch-wrapper codex-replenish-toggle-row">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={channelConfig.codexAutoReplenishUseProxyPool === true}
                              onChange={e => setChannelConfig(prev => ({ ...prev, codexAutoReplenishUseProxyPool: e.target.checked }))}
                            />
                            <span className="toggle-slider"></span>
                          </label>
                          <span className={`toggle-label ${channelConfig.codexAutoReplenishUseProxyPool ? 'enabled' : 'disabled'}`}>
                            {channelConfig.codexAutoReplenishUseProxyPool ? '使用代理池' : '不使用代理池'}
                          </span>
                        </div>
                      </div>
                    </div>
                    {channelConfig.codexAutoReplenishUseProxyPool && (
                      <div className="pool-proxy-node-config codex-replenish-proxy-nodes">
                        <div className="pool-proxy-node-header">
                          <label>代理池节点（可多选）</label>
                          <button
                            className="btn btn-outline btn-sm"
                            type="button"
                            onClick={loadProxyNodes}
                            disabled={proxyNodesLoading}
                          >
                            {proxyNodesLoading ? '刷新中...' : '刷新节点'}
                          </button>
                        </div>
                        <small className="form-hint">选择后仅从这些节点轮询；不选表示可使用全部健康代理节点。</small>
                        <div className="pool-proxy-node-list">
                          {proxyNodes.length === 0 && (
                            <div className="pool-proxy-node-empty">暂无可用代理节点，请先到“配置管理 / 代理池配置”添加节点。</div>
                          )}
                          {proxyNodes.map((node) => {
                            const nodeId = Number(node.id);
                            const selectedNodeIds = Array.isArray(channelConfig.codexAutoReplenishProxyNodeIds)
                              ? channelConfig.codexAutoReplenishProxyNodeIds.map(item => Number(item)).filter(Number.isFinite)
                              : [];
                            const checked = selectedNodeIds.includes(nodeId);
                            const nodeLabel = node.name || `节点 ${node.id}`;
                            const nodeAddress = `${node.protocol || 'http'}://${node.host}:${node.port}`;
                            return (
                              <label key={node.id} className="pool-proxy-node-item">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => setChannelConfig(prev => {
                                    const current = Array.isArray(prev.codexAutoReplenishProxyNodeIds)
                                      ? prev.codexAutoReplenishProxyNodeIds.map(item => Number(item)).filter(Number.isFinite)
                                      : [];
                                    const next = current.includes(nodeId)
                                      ? current.filter(item => item !== nodeId)
                                      : [...current, nodeId];
                                    return { ...prev, codexAutoReplenishProxyNodeIds: next };
                                  })}
                                />
                                <span className="pool-proxy-node-meta">
                                  <strong>{nodeLabel}</strong>
                                  <span>{nodeAddress}</span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="codex-replenish-note">
                    <i className="fas fa-info-circle" /> 手动补号会先保存当前配置，再立即触发一次强制补号；原生协议模式会自动完成 DuckMail → 注册 → 授权 → 导入。
                  </div>

                  {codexAutoReplenishResult && (
                    <div className={`codex-replenish-result ${codexAutoReplenishResult.error ? 'error' : ''}`}>
                      <div className="codex-replenish-result-title">
                        <i className={`fas ${codexAutoReplenishResult.error ? 'fa-exclamation-circle' : 'fa-check-circle'}`} />
                        最近一次补号结果
                      </div>
                      {codexAutoReplenishResult.error ? (
                        <div className="codex-replenish-result-message">{codexAutoReplenishResult.error}</div>
                      ) : (
                        <>
                          <div className="codex-replenish-result-grid">
                            <span>原因：{codexAutoReplenishResult.reason || 'manual_ui'}</span>
                            <span>目标：{codexAutoReplenishResult.targetCount ?? 0}</span>
                            <span>补前健康：{codexAutoReplenishResult.healthyBefore ?? 0}</span>
                            <span>补后健康：{codexAutoReplenishResult.healthyAfter ?? codexAutoReplenishResult.healthyBefore ?? 0}</span>
                            <span>新增：{codexAutoReplenishResult.created ?? 0}</span>
                            <span>重绑：{codexAutoReplenishResult.relinked ?? 0}</span>
                            <span>重复：{codexAutoReplenishResult.duplicates ?? 0}</span>
                            <span>失败：{codexAutoReplenishResult.failed ?? 0}</span>
                            <span>状态：{codexAutoReplenishResult.skipped ? `已跳过（${codexAutoReplenishResult.reason || 'unknown'}）` : '已执行'}</span>
                            <span>代理池：{codexAutoReplenishResult.usedProxyPool ? '是' : '否'}</span>
                          </div>
                          {Array.isArray(codexAutoReplenishResult.errors) && codexAutoReplenishResult.errors.length > 0 && (
                            <div className="codex-replenish-result-errors">
                              {codexAutoReplenishResult.errors.slice(0, 5).map((message, index) => (
                                <div key={`${message}-${index}`}>{message}</div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 黑名单 Tab */}
              {channelConfigTab === 'blacklist' && providerType === 'openai-codex' && (
                <div className="config-form-section">
                  <div className="config-form-section-title"><i className="fas fa-ban" /> NewAPI 用户黑名单</div>
                  <div className="config-form-grid">
                    <div className="config-form-item full">
                      <label>NewAPI UserID</label>
                      <textarea
                        className="form-textarea mono"
                        rows={10}
                        value={normalizeIdentityList(channelConfig.codexBlacklistedNewApiUserIds).join('\n')}
                        onChange={e => setChannelConfig(prev => ({
                          ...prev,
                          codexBlacklistedNewApiUserIds: normalizeIdentityList(e.target.value)
                        }))}
                        placeholder="每行一个，例如：30"
                      />
                      <small className="form-hint">命中 `X-AccountHub-UserId` / `X-NewAPI-User-Id` / `X-User-Id` 后，AccountHub 会直接返回“当前算力紧张，请稍后再试”。支持换行、逗号、空格批量输入。</small>
                    </div>
                    <div className="config-form-item full">
                      <label>当前命中数量</label>
                      <div className="blacklist-summary">
                        {normalizeIdentityList(channelConfig.codexBlacklistedNewApiUserIds).length} 个用户
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 模型映射 Tab */}
              {channelConfigTab === 'mapping' && (
                <div className="model-mapping-container">
                  <small className="form-hint">
                    {providerType === 'openai-xai-oauth'
                      ? '所有映射存储在数据库中。xAI Anthropic 兼容链路请优先使用基本配置里的 Claude 模型映射。'
                      : '所有映射存储在数据库中。未匹配的 Claude 模型会智能 fallback（opus→opus-4-5-thinking，其他→sonnet-4-5）。'}
                  </small>
                  <div className="model-mapping-add">
                    <div className="mapping-select-wrap">
                      <CustomSelect
                        value={newMappingFrom}
                        onChange={setNewMappingFrom}
                        options={mappingFromOptions}
                        placeholder="请求模型"
                        searchable
                      />
                    </div>
                    <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                    <div className="mapping-select-wrap">
                      <CustomSelect
                        value={newMappingTo}
                        onChange={setNewMappingTo}
                        options={mappingToOptions}
                        placeholder="目标模型"
                        searchable
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={!newMappingFrom || !newMappingTo}
                      onClick={() => {
                        if (newMappingFrom && newMappingTo) {
                          setChannelConfig(prev => ({
                            ...prev,
                            modelMapping: { ...prev.modelMapping, [newMappingFrom]: newMappingTo }
                          }));
                          setNewMappingFrom('');
                          setNewMappingTo('');
                        }
                      }}
                    >
                      <i className="fas fa-plus" /> 添加
                    </button>
                  </div>

                  {Object.keys(channelConfig.modelMapping || {}).length > 0 ? (
                    <>
                      <div className="mapping-section-title">映射规则 ({Object.keys(channelConfig.modelMapping).length})</div>
                      <div className="model-mapping-list">
                        {Object.entries(channelConfig.modelMapping).map(([from, to]) => (
                          <div key={from} className="model-mapping-item">
                            <span className="mapping-from">{from}</span>
                            <span className="mapping-arrow"><i className="fas fa-arrow-right" /></span>
                            <span className="mapping-to">{to}</span>
                            <button
                              className="btn btn-outline btn-sm mapping-delete"
                              onClick={() => {
                                setChannelConfig(prev => {
                                  const next = { ...prev.modelMapping };
                                  delete next[from];
                                  return { ...prev, modelMapping: next };
                                });
                              }}
                            >
                              <i className="fas fa-trash" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="empty-list">暂无映射规则，请添加或执行初始化 SQL</div>
                  )}
                </div>
              )}

            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowChannelConfig(false)}>取消</button>
              {providerType === 'openai-codex' && (
                <button
                  className="btn btn-outline"
                  onClick={triggerCodexAutoReplenish}
                  disabled={savingChannelConfig || codexAutoReplenishRunning}
                >
                  {codexAutoReplenishRunning ? '补号中...' : '立即补号'}
                </button>
              )}
              <button className="btn btn-primary" onClick={saveChannelConfig} disabled={savingChannelConfig || codexAutoReplenishRunning}>
                {savingChannelConfig ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 渠道调度日志弹窗 */}
      {showDispatchLogs && (
        <div className="modal-overlay" onClick={() => { setShowDispatchLogs(false); setDispatchLogDetail(null); }}>
          <div className="modal-content modal-dispatch-logs" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>调度日志 - {PROVIDER_NAME_MAP[providerType] || providerType}</h3>
              <div className="modal-header-actions">
                {dispatchLogs.length > 0 && (
                  <button className="btn btn-outline btn-sm" onClick={clearDispatchLogs}>
                    <i className="fas fa-trash" /> 清空
                  </button>
                )}
                <button className="btn btn-outline btn-sm" onClick={() => loadDispatchLogs(dispatchLogsPage)}>
                  <i className="fas fa-sync" /> 刷新
                </button>
                <button className="modal-close" onClick={() => { setShowDispatchLogs(false); setDispatchLogDetail(null); }}>
                  <i className="fas fa-times" />
                </button>
              </div>
            </div>
            <div className="modal-body dispatch-logs-body">
              {dispatchLogsLoading ? (
                <div className="loading-state">加载中...</div>
              ) : dispatchLogs.length > 0 ? (
                <>
                  <div className="dispatch-logs-total">共 {dispatchLogsTotal} 条调度错误记录</div>
                  <div className="dispatch-log-list">
                    {dispatchLogs.map((log) => {
                      const time = formatDateTime(log.created_at);
                      const headers = typeof log.request_headers === 'string' ? JSON.parse(log.request_headers || '{}') : (log.request_headers || {});
                      const detail = typeof log.dispatch_detail === 'string' ? JSON.parse(log.dispatch_detail || '{}') : (log.dispatch_detail || {});
                      return (
                        <div key={log.id} className="dispatch-log-item" onClick={() => setDispatchLogDetail(dispatchLogDetail?.id === log.id ? null : log)}>
                          <div className="dispatch-log-header">
                            <span className="dispatch-log-time">{time}</span>
                            <span className="dispatch-log-error-type">{log.error_type || 'unknown'}</span>
                            {log.request_model && <span className="dispatch-log-model">{log.request_model}</span>}
                          </div>
                          <div className="dispatch-log-message">{log.error_message}</div>
                          <div className="dispatch-log-meta">
                            {log.client_ip && <span className="dispatch-log-tag"><i className="fas fa-globe" /> {log.client_ip}</span>}
                            {log.client_token_id && <span className="dispatch-log-tag"><i className="fas fa-key" /> {log.client_token_id}</span>}
                            {log.user_email && <span className="dispatch-log-tag"><i className="fas fa-envelope" /> {log.user_email}</span>}
                            {log.username && <span className="dispatch-log-tag"><i className="fas fa-user" /> {log.username}</span>}
                            {log.authorization_preview && <span className="dispatch-log-tag"><i className="fas fa-lock" /> {log.authorization_preview}</span>}
                            {log.request_method && log.request_path && <span className="dispatch-log-tag"><i className="fas fa-link" /> {log.request_method} {log.request_path}</span>}
                          </div>
                          {dispatchLogDetail?.id === log.id && (
                            <div className="dispatch-log-detail">
                              {log.user_agent && (
                                <div className="dispatch-log-detail-row">
                                  <span className="dispatch-log-detail-label">User-Agent</span>
                                  <span className="dispatch-log-detail-value">{log.user_agent}</span>
                                </div>
                              )}
                              {Object.keys(headers).length > 0 && (
                                <div className="dispatch-log-detail-row">
                                  <span className="dispatch-log-detail-label">请求头</span>
                                  <pre className="dispatch-log-detail-pre">{JSON.stringify(headers, null, 2)}</pre>
                                </div>
                              )}
                              {Object.keys(detail).length > 0 && (
                                <div className="dispatch-log-detail-row">
                                  <span className="dispatch-log-detail-label">调度详情</span>
                                  <pre className="dispatch-log-detail-pre">{JSON.stringify(detail, null, 2)}</pre>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {dispatchLogsTotalPages > 1 && (
                    <div className="dispatch-logs-pagination">
                      <button className="btn btn-outline btn-sm" disabled={dispatchLogsPage <= 1} onClick={() => loadDispatchLogs(dispatchLogsPage - 1)}>上一页</button>
                      <span className="page-info">{dispatchLogsPage} / {dispatchLogsTotalPages}</span>
                      <button className="btn btn-outline btn-sm" disabled={dispatchLogsPage >= dispatchLogsTotalPages} onClick={() => loadDispatchLogs(dispatchLogsPage + 1)}>下一页</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-list">暂无调度错误记录</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 新建池子弹窗 */}
      {showCreatePool && (
        <div className="modal-overlay" onClick={() => setShowCreatePool(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建池子</h3>
              <button className="modal-close" onClick={() => setShowCreatePool(false)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>池子名称</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="请输入池子名称"
                  value={newPoolName}
                  onChange={e => setNewPoolName(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={newPoolIsDefault}
                    onChange={e => setNewPoolIsDefault(e.target.checked)}
                  />
                  设为默认池
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowCreatePool(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreatePool}
                disabled={!newPoolName.trim() || creatingPool}
              >
                {creatingPool ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑池子弹窗 */}
      {editingPool && (
        <div className="modal-overlay" onClick={() => setEditingPool(null)}>
          <div className="modal-content modal-pool-edit" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>编辑池子</h3>
              <button className="modal-close" onClick={() => setEditingPool(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-row-2col">
                <div className="form-group">
                  <label>池子名称</label>
                  <input
                    type="text"
                    className="form-input"
                    value={editPoolName}
                    onChange={e => setEditPoolName(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>路由策略</label>
                  <CustomSelect
                    value={editPoolStrategy}
                    onChange={setEditPoolStrategy}
                    options={[
                      { value: 'round-robin', label: '轮询' },
                      { value: 'random', label: '随机' },
                      { value: 'least-used', label: '最少使用' },
                    ]}
                  />
                </div>
              </div>
              <div className="form-row-inline">
                <div className="form-group-inline">
                  <label>池子状态</label>
                  <div className="toggle-switch-wrapper">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={editPoolIsEnabled}
                        onChange={e => setEditPoolIsEnabled(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <span className={`toggle-label ${editPoolIsEnabled ? 'enabled' : 'disabled'}`}>
                      {editPoolIsEnabled ? '启用' : '禁用'}
                    </span>
                  </div>
                </div>
                <div className="form-group-inline">
                  <label>代理池</label>
                  <div className="toggle-switch-wrapper">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={editPoolUseProxy}
                        onChange={e => setEditPoolUseProxy(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <span className={`toggle-label ${editPoolUseProxy ? 'enabled' : 'disabled'}`}>
                      {editPoolUseProxy ? '启用' : '禁用'}
                    </span>
                  </div>
                </div>
                <div className="form-group-inline">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={editPoolIsDefault}
                      onChange={e => setEditPoolIsDefault(e.target.checked)}
                    />
                    设为默认池
                  </label>
                </div>
                <div className="form-group-inline">
                  <label>健康检测</label>
                  <div className="toggle-switch-wrapper">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={editPoolEnableHealthCheck}
                        onChange={e => setEditPoolEnableHealthCheck(e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <span className={`toggle-label ${editPoolEnableHealthCheck ? 'enabled' : 'disabled'}`}>
                      {editPoolEnableHealthCheck ? '启用' : '禁用'}
                    </span>
                  </div>
                </div>
              </div>
              {editPoolUseProxy && (
                <div className="pool-proxy-node-config">
                  <div className="pool-proxy-node-header">
                    <label>生效代理节点（可多选）</label>
                    <button
                      className="btn btn-outline btn-sm"
                      type="button"
                      onClick={loadProxyNodes}
                      disabled={proxyNodesLoading}
                    >
                      {proxyNodesLoading ? '刷新中...' : '刷新节点'}
                    </button>
                  </div>
                  <small className="form-hint">
                    选择后仅使用这些代理节点；不选择表示使用全部可用代理节点。
                  </small>
                  <div className="pool-proxy-node-list">
                    {proxyNodes.length === 0 && (
                      <div className="pool-proxy-node-empty">暂无可用代理节点，请先到“配置管理 / 代理池配置”添加节点。</div>
                    )}
                    {proxyNodes.map((node) => {
                      const nodeId = Number(node.id);
                      const checked = editPoolProxyNodeIds.includes(nodeId);
                      const nodeLabel = node.name || `节点 ${node.id}`;
                      const nodeAddress = `${node.protocol || 'http'}://${node.host}:${node.port}`;
                      return (
                        <label key={node.id} className="pool-proxy-node-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleEditPoolProxyNode(nodeId)}
                          />
                          <span className="pool-proxy-node-meta">
                            <strong>{nodeLabel}</strong>
                            <span>{nodeAddress}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="pool-concurrency-config">
                <label>并发控制配置</label>
                <div className="concurrency-config-row">
                  <div className="concurrency-config-section">
                    <div className="form-group-inline">
                      <label>用户并发限制</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={editPoolEnableUserConcurrencyLimit}
                            onChange={e => setEditPoolEnableUserConcurrencyLimit(e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                        <span className={`toggle-label ${editPoolEnableUserConcurrencyLimit ? 'enabled' : 'disabled'}`}>
                          {editPoolEnableUserConcurrencyLimit ? '启用' : '禁用'}
                        </span>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>用户最大并发数</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        value={editPoolUserMaxConcurrency}
                        onChange={e => setEditPoolUserMaxConcurrency(parseInt(e.target.value) || 0)}
                        disabled={!editPoolEnableUserConcurrencyLimit}
                      />
                      <small className="form-hint">同一用户(Token/IP)最大并发请求数，0=不限制</small>
                    </div>
                  </div>
                  <div className="concurrency-config-section">
                    <div className="form-group-inline">
                      <label>账号并发限制</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={editPoolEnableAccountConcurrencyLimit}
                            onChange={e => setEditPoolEnableAccountConcurrencyLimit(e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                        <span className={`toggle-label ${editPoolEnableAccountConcurrencyLimit ? 'enabled' : 'disabled'}`}>
                          {editPoolEnableAccountConcurrencyLimit ? '启用' : '禁用'}
                        </span>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>账号最大并发数</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        value={editPoolAccountMaxConcurrency}
                        onChange={e => setEditPoolAccountMaxConcurrency(parseInt(e.target.value) || 0)}
                        disabled={!editPoolEnableAccountConcurrencyLimit}
                      />
                      <small className="form-hint">单账号最大并发数，超过则不分配该账号，0=不限制</small>
                    </div>
                  </div>
                </div>
              </div>
              <div className="pool-concurrency-config">
                <label>代理商并发控制配置</label>
                <div className="concurrency-config-row">
                  <div className="concurrency-config-section">
                    <div className="form-group-inline">
                      <label>代理商Key并发限制</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={editPoolEnableProviderConcurrencyLimit}
                            onChange={e => setEditPoolEnableProviderConcurrencyLimit(e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                        <span className={`toggle-label ${editPoolEnableProviderConcurrencyLimit ? 'enabled' : 'disabled'}`}>
                          {editPoolEnableProviderConcurrencyLimit ? '启用' : '禁用'}
                        </span>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>代理商Key最大并发数</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        value={editPoolProviderMaxConcurrency}
                        onChange={e => setEditPoolProviderMaxConcurrency(parseInt(e.target.value) || 0)}
                        disabled={!editPoolEnableProviderConcurrencyLimit}
                      />
                      <small className="form-hint">代理商按Key(TokenId)最大并发请求数，0=不限制</small>
                    </div>
                  </div>
                  <div className="concurrency-config-section">
                    <div className="form-group-inline">
                      <label>代理商账号并发限制</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={editPoolEnableProviderAccountConcurrencyLimit}
                            onChange={e => setEditPoolEnableProviderAccountConcurrencyLimit(e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                        <span className={`toggle-label ${editPoolEnableProviderAccountConcurrencyLimit ? 'enabled' : 'disabled'}`}>
                          {editPoolEnableProviderAccountConcurrencyLimit ? '启用' : '禁用'}
                        </span>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>代理商账号最大并发数</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        value={editPoolProviderAccountMaxConcurrency}
                        onChange={e => setEditPoolProviderAccountMaxConcurrency(parseInt(e.target.value) || 0)}
                        disabled={!editPoolEnableProviderAccountConcurrencyLimit}
                      />
                      <small className="form-hint">代理商单账号最大并发数，超过则不分配该账号，0=不限制</small>
                    </div>
                  </div>
                </div>
              </div>
              <div className="pool-concurrency-config">
                <label>Session 并发控制</label>
                <div className="concurrency-config-row">
                  <div className="concurrency-config-section">
                    <div className="form-group-inline">
                      <label>Session限制</label>
                      <div className="toggle-switch-wrapper">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={editPoolEnableSessionLimit}
                            onChange={e => setEditPoolEnableSessionLimit(e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>单账号最大Session数</label>
                      <input
                        type="number"
                        className="form-input"
                        min="0"
                        value={editPoolMaxSessionsPerAccount}
                        onChange={e => setEditPoolMaxSessionsPerAccount(parseInt(e.target.value) || 0)}
                        disabled={!editPoolEnableSessionLimit}
                      />
                      <small className="form-hint">基于 metadata.user_id 中的 sessionId 检测，限制单账号同时使用的会话数，0=不限制</small>
                    </div>
                  </div>
                </div>
              </div>
              {providerType === 'openai-codex' && (
                <div className="pool-concurrency-config">
                  <label>Codex 调度配置</label>
                  <div className="concurrency-config-row">
                    <div className="concurrency-config-section" style={{ gridColumn: '1 / -1' }}>
                      <div className="form-group">
                        <label>高并发用户绕过指纹粘性</label>
                        <textarea
                          className="form-textarea"
                          rows={3}
                          value={normalizeIdentityList(editPoolCodexHighConcurrencyUserIds).join('\n')}
                          onChange={e => setEditPoolCodexHighConcurrencyUserIds(normalizeIdentityList(e.target.value))}
                          placeholder="每行一个，例如：30"
                        />
                        <small className="form-hint">只对当前池子生效，留空则使用渠道配置。匹配 userId、email、username、tokenId 或 user:30/token:120/ip:43.155.215.189；真实 session 仍按 session 绑定。</small>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="pool-model-config">
                <label>模型路由配置</label>
                <div className="model-config-row">
                  <div className="model-config-section">
                    <div className="model-config-header">
                      <i className="fas fa-check-circle"></i> 白名单
                    </div>
                    <small className="form-hint">留空=支持全部</small>
                    <div className="models-checkbox-grid compact">
                      {poolModelList.map((model) => (
                        <label key={`sup-${model}`} className="model-checkbox">
                          <input
                            type="checkbox"
                            checked={editPoolSupportedModels.includes(model)}
                            onChange={() => {
                              setEditPoolSupportedModels(prev =>
                                prev.includes(model) ? prev.filter(m => m !== model) : [...prev, model]
                              );
                            }}
                          />
                          <span>{model}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="model-config-section">
                    <div className="model-config-header">
                      <i className="fas fa-ban"></i> 黑名单
                    </div>
                    <small className="form-hint">优先级高于白名单</small>
                    <div className="models-checkbox-grid compact">
                      {poolModelList.map((model) => (
                        <label key={`not-${model}`} className="model-checkbox">
                          <input
                            type="checkbox"
                            checked={editPoolNotSupportedModels.includes(model)}
                            onChange={() => {
                              setEditPoolNotSupportedModels(prev =>
                                prev.includes(model) ? prev.filter(m => m !== model) : [...prev, model]
                              );
                            }}
                          />
                          <span>{model}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setEditingPool(null)}>取消</button>
              <button
                className="btn btn-primary"
                onClick={handleSavePool}
                disabled={!editPoolName.trim() || savingPool}
              >
                {savingPool ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加账号弹窗 */}
      {showAddAccount && (
        <div className="modal-overlay" onClick={() => setShowAddAccount(false)}>
          <div className="modal-content modal-wide" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>添加账号</h3>
              <button className="modal-close" onClick={() => setShowAddAccount(false)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>凭据信息 (JSON 或 Token)</label>
                <textarea
                  className="form-textarea"
                  placeholder="请输入凭据信息"
                  rows={5}
                  value={newAccountData}
                  onChange={e => setNewAccountData(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowAddAccount(false)}>取消</button>
              <button
                className="btn btn-primary"
                onClick={handleAddAccount}
                disabled={!newAccountData.trim() || addingAccount}
              >
                {addingAccount ? '添加中...' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 账号详情弹窗 */}
      {selectedAccount && (
        <div className="modal-overlay" onClick={() => setSelectedAccount(null)}>
          <div className="modal-content modal-detail" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>账号详情</h3>
              <div className="modal-header-actions">
                {['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'claude-antigravity', 'openai-codex', 'openai-xai-oauth'].includes(providerType) && (
                  <button
                    className="btn-header-action btn-refresh-token"
                    onClick={() => handleRefreshToken(selectedAccount.uuid)}
                    disabled={refreshingTokenIds.has(selectedAccount.uuid)}
                    title="刷新Token"
                  >
                    <i className={`fas ${refreshingTokenIds.has(selectedAccount.uuid) ? 'fa-spinner fa-spin' : 'fa-key'}`} />
                    <span>刷新Token</span>
                  </button>
                )}
                {providerType === 'openai-codex' && (
                  <button
                    className="btn-header-action"
                    onClick={() => handleCodexGptTest(selectedAccount.uuid)}
                    disabled={checkingIds.has(selectedAccount.uuid)}
                    title="使用 gpt-5.3-codex 发送测试请求"
                  >
                    <i className={`fas ${checkingIds.has(selectedAccount.uuid) ? 'fa-spinner fa-spin' : 'fa-flask'}`} />
                    <span>测试5.3</span>
                  </button>
                )}
                <button
                  className="btn-header-action"
                  onClick={() => handleCheck(selectedAccount.uuid)}
                  disabled={checkingIds.has(selectedAccount.uuid)}
                  title="检测健康状态"
                >
                  <i className={`fas ${checkingIds.has(selectedAccount.uuid) ? 'fa-spinner fa-spin' : 'fa-heartbeat'}`} />
                  <span>检测</span>
                </button>
                <button
                  className={`btn-header-action ${selectedAccount.isDisabled ? 'btn-enable' : 'btn-disable'}`}
                  onClick={() => handleToggleDisable(selectedAccount.uuid, selectedAccount.isDisabled)}
                  title={selectedAccount.isDisabled ? '启用' : '禁用'}
                >
                  <i className={`fas ${selectedAccount.isDisabled ? 'fa-play' : 'fa-pause'}`} />
                  <span>{selectedAccount.isDisabled ? '启用' : '禁用'}</span>
                </button>
                <button
                  className="btn-header-action btn-reset"
                  onClick={() => handleResetHealth(selectedAccount.uuid)}
                  title="重置健康状态"
                >
                  <i className="fas fa-redo" />
                  <span>重置</span>
                </button>
                <button className="modal-close" onClick={() => setSelectedAccount(null)}>
                  <i className="fas fa-times" />
                </button>
              </div>
            </div>
            <div className="detail-tabs">
              <button
                className={`detail-tab ${detailTab === 'info' ? 'active' : ''}`}
                onClick={() => setDetailTab('info')}
              >
                基本信息
              </button>
              <button
                className={`detail-tab ${detailTab === 'config' ? 'active' : ''}`}
                onClick={() => setDetailTab('config')}
              >
                渠道配置
              </button>
              <button
                className={`detail-tab ${detailTab === 'stats' ? 'active' : ''}`}
                onClick={() => setDetailTab('stats')}
              >
                使用统计
              </button>
              {isClaudeCustom && (
                <button
                  className={`detail-tab ${detailTab === 'upstream' ? 'active' : ''}`}
                  onClick={() => setDetailTab('upstream')}
                >
                  上游管理
                  <span className={`detail-tab-mode ${isUpstreamChannelMode ? 'channel' : 'direct'}`}>
                    {upstreamModeLabel}
                  </span>
                </button>
              )}
              <button
                className={`detail-tab ${detailTab === 'quota' ? 'active' : ''}`}
                onClick={() => setDetailTab('quota')}
              >
                额度信息
              </button>
              <button
                className={`detail-tab ${detailTab === 'check' ? 'active' : ''}`}
                onClick={() => setDetailTab('check')}
              >
                检测配置
              </button>
              {(providerType === 'openai-codex' || providerType === 'openai-xai-oauth') && (
                <button
                  className={`detail-tab ${detailTab === 'manual-test' ? 'active' : ''}`}
                  onClick={() => setDetailTab('manual-test')}
                >
                  手动测试
                </button>
              )}
              {(providerType === 'openai-codex' || providerType === 'claude-windsurf' || providerType === 'openai-xai-oauth') && (
                <button
                  className={`detail-tab ${detailTab === 'available-models' ? 'active' : ''}`}
                  onClick={() => setDetailTab('available-models')}
                >
                  可用模型
                </button>
              )}
              <button
                className={`detail-tab ${detailTab === 'requests' ? 'active' : ''}`}
                onClick={() => setDetailTab('requests')}
              >
                请求日志
              </button>
              <button
                className={`detail-tab ${detailTab === 'errors' ? 'active' : ''}`}
                onClick={() => setDetailTab('errors')}
              >
                错误历史
              </button>
              <button
                className={`detail-tab ${detailTab === 'status' ? 'active' : ''}`}
                onClick={() => setDetailTab('status')}
              >
                状态日志
              </button>
              <button
                className={`detail-tab ${detailTab === 'users' ? 'active' : ''}`}
                onClick={() => setDetailTab('users')}
              >
                实时用户
              </button>
              <button
                className={`detail-tab ${detailTab === 'tokens' ? 'active' : ''}`}
                onClick={() => setDetailTab('tokens')}
              >
                Token统计
              </button>
            </div>
            <div className="detail-content">
              {detailTab === 'info' && (
                <>
                  {/* 当前状态 */}
                  <div className="detail-group">
                    <div className="detail-group-title">当前状态</div>
                    <div className="detail-group-content">
                      <div className="detail-row">
                        <div className="detail-cell">
                          <span className="detail-cell-label">健康状态</span>
                          <span className={`status-dot ${selectedAccount.isDeleted ? 'deleted' : selectedAccount.isDisabled ? 'disabled' : selectedAccount.isHealthy ? 'healthy' : 'unhealthy'}`}>
                            {selectedAccount.isDeleted ? '已删除' : selectedAccount.isDisabled ? '已禁用' : selectedAccount.isHealthy ? '健康' : '异常'}
                          </span>
                        </div>
                        <div className="detail-cell">
                          <span className="detail-cell-label">池子ID</span>
                          <span className="num-highlight primary">{selectedAccount.poolId ?? 0}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 基本配置 - 可编辑 */}
                  <div className="detail-group">
                    <div className="detail-group-title">基本配置</div>
                    <div className="config-form">
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>UUID</label>
                          <input type="text" className="mono" value={selectedAccount.uuid || ''} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>账号邮箱</label>
                          <input
                            type="text"
                            value={selectedAccount.email || selectedAccount.credentials?.email || ''}
                            readOnly
                          />
                        </div>
                        <div className="config-form-item">
                          <label>创建时间</label>
                          <input
                            type="text"
                            value={formatDateTime(selectedAccount.createdAt || selectedAccount.created_at || selectedAccount.credentials?.createdAt || selectedAccount.credentials?.created_at)}
                            readOnly
                          />
                        </div>
                        <div className="config-form-item">
                          <label>自定义名称</label>
                          <input
                            type="text"
                            value={editFormData.customName || ''}
                            onChange={e => updateEditField('customName', e.target.value)}
                            placeholder="输入自定义名称"
                          />
                        </div>
                        <div className="config-form-item">
                          <label>健康检查</label>
                          <select
                            value={editFormData.checkHealth ? 'true' : 'false'}
                            onChange={e => updateEditField('checkHealth', e.target.value === 'true')}
                          >
                            <option value="true">启用</option>
                            <option value="false">禁用</option>
                          </select>
                        </div>
                        <div className="config-form-item">
                          <label>检测模型名称</label>
                          <input
                            type="text"
                            value={editFormData.checkModelName || ''}
                            onChange={e => updateEditField('checkModelName', e.target.value)}
                            placeholder="如: claude-sonnet-4-5-20250929"
                          />
                        </div>
                        {providerType === 'openai-xai-oauth' && (
                          <>
                            <div className="config-form-item">
                              <label>请求路径</label>
                              <select
                                value={String(editFormData.XAI_USING_API ?? '')}
                                onChange={e => updateEditField('XAI_USING_API', e.target.value)}
                              >
                                {XAI_ROUTE_OPTIONS.map(option => (
                                  <option key={option.value || 'auto'} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <span className="config-form-help">
                                保存后立即切换该账号的推理和额度查询路径。留空则跟随渠道配置；账号级设置优先于渠道默认值。
                              </span>
                            </div>
                            <div className="config-form-item">
                              <label>可选端点（2 个）</label>
                              <input
                                type="text"
                                className="mono"
                                value="https://api.x.ai/v1 | https://cli-chat-proxy.grok.com/v1"
                                readOnly
                              />
                            </div>
                          </>
                        )}
                        {providerType === 'claude-kiro-oauth' && (
                          <div className="config-form-item">
                            <label>设备槽位</label>
                            <div className="config-inline-control">
                              <input type="text" value={selectedAccount.maxDevices || 3} readOnly />
                              <button
                                type="button"
                                className="btn btn-outline btn-xs"
                                onClick={() => handleUpdateMaxDevices(selectedAccount.uuid, selectedAccount.maxDevices)}
                              >
                                修改
                              </button>
                            </div>
                          </div>
                        )}
                        {selectedAccount.oauthCredentialId && (
                          <div className="config-form-item">
                            <label>OAuth凭据ID</label>
                            <input type="text" value={selectedAccount.oauthCredentialId || ''} readOnly />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 错误信息 */}
                  {selectedAccount.lastErrorMessage && (
                    <div className="detail-group">
                      <div className="detail-group-title">最后错误</div>
                      <div className="error-item">
                        <div className="error-item-header">
                          <span className="error-time">{formatDateTime(selectedAccount.lastErrorTime)}</span>
                          <span className="error-code">ERROR</span>
                        </div>
                        <div className="error-message">{selectedAccount.lastErrorMessage}</div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 使用统计Tab */}
              {detailTab === 'stats' && (
                <>
                  {/* 使用次数统计 */}
                  <div className="detail-group">
                    <div className="detail-group-title">使用次数</div>
                    <div className="detail-group-content">
                      <div className="detail-row">
                        <div className="detail-cell">
                          <span className="detail-cell-label">总使用次数</span>
                          <span className="num-highlight primary">{selectedAccount.usageCount ?? 0}</span>
                        </div>
                        <div className="detail-cell">
                          <span className="detail-cell-label">错误次数</span>
                          <span className={`num-highlight ${(selectedAccount.errorCount ?? 0) > 0 ? 'danger' : 'success'}`}>
                            {selectedAccount.errorCount ?? 0}
                          </span>
                        </div>
                        <div className="detail-cell">
                          <span className="detail-cell-label">成功率</span>
                          <span className={`num-highlight ${
                            (selectedAccount.usageCount ?? 0) === 0 ? 'primary' :
                            ((selectedAccount.usageCount - (selectedAccount.errorCount ?? 0)) / selectedAccount.usageCount * 100) >= 90 ? 'success' :
                            ((selectedAccount.usageCount - (selectedAccount.errorCount ?? 0)) / selectedAccount.usageCount * 100) >= 70 ? 'warning' : 'danger'
                          }`}>
                            {(selectedAccount.usageCount ?? 0) === 0 ? '--' :
                              `${(((selectedAccount.usageCount - (selectedAccount.errorCount ?? 0)) / selectedAccount.usageCount) * 100).toFixed(1)}%`}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 时间记录 */}
                  <div className="detail-group">
                    <div className="detail-group-title">时间记录</div>
                    <div className="config-form">
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>最后使用时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.lastUsed)} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>最后检测时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.lastHealthCheckTime)} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>最后错误时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.lastErrorTime)} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>计划恢复时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.scheduledRecoveryTime)} readOnly />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 最后错误信息 */}
                  {selectedAccount.lastErrorMessage && (
                    <div className="detail-group">
                      <div className="detail-group-title">最后错误信息</div>
                      <div className="error-item">
                        <div className="error-item-header">
                          <span className="error-time">{formatDateTime(selectedAccount.lastErrorTime)}</span>
                          <span className="error-code">ERROR</span>
                        </div>
                        <div className="error-message">{selectedAccount.lastErrorMessage}</div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 渠道配置Tab */}
              {detailTab === 'config' && (
                <>
                  {loadingCredential ? (
                    <div className="page-loading">加载凭据中...</div>
                  ) : oauthCredential ? (
                    <>
                      {/* 凭据基本信息 */}
                      <div className="detail-group">
                        <div className="detail-group-title">凭据信息</div>
                        <div className="config-form">
                          <div className="config-form-grid">
                            <div className="config-form-item">
                              <label>凭据ID</label>
                              <input type="text" value={oauthCredential.id || ''} readOnly />
                            </div>
                            <div className="config-form-item">
                              <label>凭据类型</label>
                              <input type="text" value={oauthCredential.credential_type || ''} readOnly />
                            </div>
                            <div className="config-form-item">
                              <label>显示名称</label>
                              <input type="text" value={oauthCredential.display_name || ''} readOnly />
                            </div>
                            <div className="config-form-item">
                              <label>来源</label>
                              <input type="text" value={oauthCredential.source || ''} readOnly />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 凭据内容 */}
                      {oauthCredential.credentials && (
                        <div className="detail-group">
                          <div className="detail-group-title">凭据内容</div>
                          <div className="config-form">
                            <div className="config-form-grid">
                              {Object.entries(oauthCredential.credentials).map(([key, value]) => {
                                const isSecret = key.toLowerCase().includes('token') ||
                                  key.toLowerCase().includes('secret') ||
                                  key.toLowerCase().includes('key') ||
                                  key.toLowerCase().includes('password') ||
                                  key.toLowerCase().includes('cookie');
                                const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value || '');
                                const editValue = editCredentialData[key] !== undefined
                                  ? (typeof editCredentialData[key] === 'object' ? JSON.stringify(editCredentialData[key]) : String(editCredentialData[key] || ''))
                                  : displayValue;
                                return (
                                  <div className="config-form-item" key={key}>
                                    <label>{key}</label>
                                    <div className="input-with-copy">
                                      <input
                                        type="text"
                                        className="mono"
                                        value={editValue}
                                        onChange={e => updateCredentialField(key, e.target.value)}
                                      />
                                      <button
                                        type="button"
                                        className="btn-copy"
                                        onClick={() => handleCopyValue(editValue)}
                                        title="复制"
                                      >
                                        <i className="fas fa-copy" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (isClaudeCustom || isClaudeOffical || isClaudeAntigravity) ? (
                    <>
                      <div className="detail-group">
                        <div className="detail-group-title">直连配置</div>
                        <div className="config-form">
                          <div className="config-form-grid">
                            {!isClaudeAntigravity ? (
                              <>
                                <div className="config-form-item">
                                  <label>CLAUDE_BASE_URL</label>
                                  <input
                                    type="text"
                                    value={editFormData.CLAUDE_BASE_URL || ''}
                                    onChange={e => updateEditField('CLAUDE_BASE_URL', e.target.value)}
                                    placeholder="例如: https://api.anthropic.com"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>CLAUDE_API_KEY</label>
                                  <input
                                    type="password"
                                    value={editFormData.CLAUDE_API_KEY || ''}
                                    onChange={e => updateEditField('CLAUDE_API_KEY', e.target.value)}
                                    placeholder="sk-..."
                                    autoComplete="new-password"
                                  />
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="config-form-item">
                                  <label>ANTIGRAVITY_OAUTH_CREDS_FILE_PATH</label>
                                  <input
                                    type="text"
                                    value={editFormData.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH || ''}
                                    onChange={e => updateEditField('ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', e.target.value)}
                                    placeholder="db://oauth/claude-antigravity/1"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>PROJECT_ID</label>
                                  <input
                                    type="text"
                                    value={editFormData.PROJECT_ID || ''}
                                    onChange={e => updateEditField('PROJECT_ID', e.target.value)}
                                    placeholder="留空自动发现"
                                  />
                                </div>
                              </>
                            )}
                            {isClaudeCustom && (
                              <>
                                {!isClaudeCustomNewApi && (
                                  <>
                                    <div className="config-form-item">
                                      <label>foxcodeAuthBaseUrl</label>
                                      <input
                                        type="text"
                                        value={editFormData.foxcodeAuthBaseUrl || ''}
                                        onChange={e => updateEditField('foxcodeAuthBaseUrl', e.target.value)}
                                        placeholder="https://foxcode.rjj.cc"
                                      />
                                    </div>
                                    <div className="config-form-item">
                                      <label>foxcodeEmail</label>
                                      <input
                                        type="text"
                                        value={editFormData.foxcodeEmail || ''}
                                        onChange={e => updateEditField('foxcodeEmail', e.target.value)}
                                        placeholder="用于自动登录获取用量"
                                      />
                                    </div>
                                    <div className="config-form-item">
                                      <label>foxcodePassword</label>
                                      <input
                                        type="password"
                                        value={editFormData.foxcodePassword || ''}
                                        onChange={e => updateEditField('foxcodePassword', e.target.value)}
                                        placeholder="用于自动登录获取用量"
                                        autoComplete="new-password"
                                      />
                                    </div>
                                  </>
                                )}
                                <div className="config-form-item">
                                  <label>claudeCustomSystemType</label>
                                  <select
                                    value={editFormData.claudeCustomSystemType || 'self-developed'}
                                    onChange={e => updateEditField('claudeCustomSystemType', e.target.value)}
                                  >
                                    {CLAUDE_CUSTOM_SYSTEM_TYPES.map((item) => (
                                      <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>newapiSystemToken</label>
                                  <input
                                    type="password"
                                    value={editFormData.newapiSystemToken || ''}
                                    onChange={e => updateEditField('newapiSystemToken', e.target.value)}
                                    placeholder="系统访问令牌（可选，优先于账号密码）"
                                    autoComplete="new-password"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>newapiUserId</label>
                                  <input
                                    type="text"
                                    value={editFormData.newapiUserId || ''}
                                    onChange={e => updateEditField('newapiUserId', e.target.value)}
                                    placeholder="用户ID/用户名（可选，如 621）"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>newapiUsername</label>
                                  <input
                                    type="text"
                                    value={editFormData.newapiUsername || ''}
                                    onChange={e => updateEditField('newapiUsername', e.target.value)}
                                    placeholder="NewAPI 登录用户名（可选）"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>newapiPassword</label>
                                  <input
                                    type="password"
                                    value={editFormData.newapiPassword || ''}
                                    onChange={e => updateEditField('newapiPassword', e.target.value)}
                                    placeholder="NewAPI 登录密码（可选）"
                                    autoComplete="new-password"
                                  />
                                </div>
                              </>
                            )}
                            {isClaudeOffical && (
                              <>
                                <div className="config-form-item">
                                  <label>officialStickySessionEnabled</label>
                                  <select
                                    value={String(editFormData.officialStickySessionEnabled ?? true)}
                                    onChange={e => updateEditField('officialStickySessionEnabled', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>officialStickySessionTtlMinutes</label>
                                  <input
                                    type="number"
                                    min="1"
                                    value={editFormData.officialStickySessionTtlMinutes ?? 60}
                                    onChange={e => updateEditField('officialStickySessionTtlMinutes', Number(e.target.value || 60))}
                                    placeholder="60"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>officialSessionBindingStrict</label>
                                  <select
                                    value={String(editFormData.officialSessionBindingStrict ?? false)}
                                    onChange={e => updateEditField('officialSessionBindingStrict', e.target.value === 'true')}
                                  >
                                    <option value="false">禁用</option>
                                    <option value="true">启用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>officialStickyIdentityMode</label>
                                  <select
                                    value={editFormData.officialStickyIdentityMode || 'session-or-fingerprint'}
                                    onChange={e => updateEditField('officialStickyIdentityMode', e.target.value)}
                                  >
                                    {CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS.map((item) => (
                                      <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>officialFingerprintIncludeUser</label>
                                  <select
                                    value={String(editFormData.officialFingerprintIncludeUser ?? true)}
                                    onChange={e => updateEditField('officialFingerprintIncludeUser', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>officialFingerprintIncludeToken</label>
                                  <select
                                    value={String(editFormData.officialFingerprintIncludeToken ?? true)}
                                    onChange={e => updateEditField('officialFingerprintIncludeToken', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>officialFingerprintIncludePath</label>
                                  <select
                                    value={String(editFormData.officialFingerprintIncludePath ?? false)}
                                    onChange={e => updateEditField('officialFingerprintIncludePath', e.target.value === 'true')}
                                  >
                                    <option value="false">禁用</option>
                                    <option value="true">启用</option>
                                  </select>
                                </div>
                              </>
                            )}
                            {isClaudeAntigravity && (
                              <>
                                <div className="config-form-item">
                                  <label>antigravityStickySessionEnabled</label>
                                  <select
                                    value={String(editFormData.antigravityStickySessionEnabled ?? true)}
                                    onChange={e => updateEditField('antigravityStickySessionEnabled', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityStickySessionTtlMinutes</label>
                                  <input
                                    type="number"
                                    min="1"
                                    value={editFormData.antigravityStickySessionTtlMinutes ?? 60}
                                    onChange={e => updateEditField('antigravityStickySessionTtlMinutes', Number(e.target.value || 60))}
                                    placeholder="60"
                                  />
                                </div>
                                <div className="config-form-item">
                                  <label>antigravitySessionBindingStrict</label>
                                  <select
                                    value={String(editFormData.antigravitySessionBindingStrict ?? false)}
                                    onChange={e => updateEditField('antigravitySessionBindingStrict', e.target.value === 'true')}
                                  >
                                    <option value="false">禁用</option>
                                    <option value="true">启用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityStickyIdentityMode</label>
                                  <select
                                    value={editFormData.antigravityStickyIdentityMode || 'session-or-fingerprint'}
                                    onChange={e => updateEditField('antigravityStickyIdentityMode', e.target.value)}
                                  >
                                    {CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS.map((item) => (
                                      <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityFingerprintIncludeUser</label>
                                  <select
                                    value={String(editFormData.antigravityFingerprintIncludeUser ?? true)}
                                    onChange={e => updateEditField('antigravityFingerprintIncludeUser', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityFingerprintIncludeToken</label>
                                  <select
                                    value={String(editFormData.antigravityFingerprintIncludeToken ?? true)}
                                    onChange={e => updateEditField('antigravityFingerprintIncludeToken', e.target.value === 'true')}
                                  >
                                    <option value="true">启用</option>
                                    <option value="false">禁用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityFingerprintIncludePath</label>
                                  <select
                                    value={String(editFormData.antigravityFingerprintIncludePath ?? false)}
                                    onChange={e => updateEditField('antigravityFingerprintIncludePath', e.target.value === 'true')}
                                  >
                                    <option value="false">禁用</option>
                                    <option value="true">启用</option>
                                  </select>
                                </div>
                                <div className="config-form-item">
                                  <label>antigravityFingerprintSalt</label>
                                  <input
                                    type="text"
                                    value={editFormData.antigravityFingerprintSalt || ''}
                                    onChange={e => updateEditField('antigravityFingerprintSalt', e.target.value)}
                                    placeholder="可选，自定义盐值"
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {isClaudeCustom && (
                        <div className="detail-group">
                          <div className="detail-group-title">上游供应商配置</div>
                          <div className="config-form">
                            <div className="config-form-grid">
                            <div className="config-form-item">
                              <label>upstreamMode</label>
                              <select
                                value={editFormData.upstreamMode || 'direct'}
                                onChange={e => updateEditField('upstreamMode', e.target.value)}
                              >
                                {CLAUDE_CUSTOM_UPSTREAM_MODES.map(mode => (
                                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="config-form-item">
                              <label>upstreamBaseUrl</label>
                              <input
                                type="text"
                                value={editFormData.upstreamBaseUrl || ''}
                                onChange={e => updateEditField('upstreamBaseUrl', e.target.value)}
                                placeholder="例如: https://your-antigravity.example.com"
                              />
                            </div>
                            <div className="config-form-item">
                              <label>upstreamAdminToken</label>
                              <input
                                type="password"
                                value={editFormData.upstreamAdminToken || ''}
                                onChange={e => updateEditField('upstreamAdminToken', e.target.value)}
                                placeholder="管理 token（推荐）"
                                autoComplete="new-password"
                              />
                            </div>
                            <div className="config-form-item">
                              <label>upstreamApiKey</label>
                              <input
                                type="password"
                                value={editFormData.upstreamApiKey || ''}
                                onChange={e => updateEditField('upstreamApiKey', e.target.value)}
                                placeholder="x-api-key（可选）"
                                autoComplete="new-password"
                              />
                            </div>
                            <div className="config-form-item">
                              <label>upstreamRequestTimeoutMs</label>
                              <input
                                type="number"
                                min="1000"
                                step="1000"
                                value={editFormData.upstreamRequestTimeoutMs || 15000}
                                onChange={e => updateEditField('upstreamRequestTimeoutMs', Number(e.target.value || 15000))}
                              />
                            </div>
                            </div>
                          </div>
                          <div className="upstream-config-tip">
                            修改上游配置后，先点底部“保存”，再在“上游管理”页执行控制操作。
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty-list">
                      {selectedAccount?.oauthCredentialId ? '无法加载凭据信息' : '该账号未关联OAuth凭据'}
                    </div>
                  )}
                </>
              )}

              {detailTab === 'upstream' && isClaudeCustom && (
                <>
                  <div className="detail-group">
                    <div className="detail-group-title">上游连接状态</div>
                    <div className="upstream-toolbar">
                      <div className="upstream-status-grid">
                        <div className="upstream-status-item">
                          <span className="upstream-status-label">健康检查</span>
                          <span
                            className={`status-dot ${!upstreamHealthChecked ? 'disabled' : upstreamHealth ? 'healthy' : 'unhealthy'}`}
                            title={upstreamHealthError || ''}
                          >
                            {!upstreamHealthChecked
                              ? '未检查'
                              : upstreamHealth
                                ? '可用'
                                : (upstreamHealthError ? `不可用: ${upstreamHealthError}` : '不可用')}
                          </span>
                        </div>
                        <div className="upstream-status-item">
                          <span className="upstream-status-label">反代状态</span>
                          <span className={`status-dot ${upstreamProxyStatus?.running ? 'healthy' : 'disabled'}`}>
                            {isUpstreamChannelMode ? (upstreamProxyStatus?.running ? '运行中' : '已停止') : '--'}
                          </span>
                        </div>
                        <div className="upstream-status-item">
                          <span className="upstream-status-label">上游账号数</span>
                          <span className="num-highlight primary">{upstreamAccounts.length}</span>
                        </div>
                      </div>
                      <div className="upstream-actions">
                        <button
                          className="btn btn-outline"
                          onClick={handleRefreshUpstream}
                          disabled={upstreamLoading.health || upstreamLoading.status || upstreamLoading.accounts || upstreamLoading.action}
                        >
                          <i className={`fas ${(upstreamLoading.health || upstreamLoading.status || upstreamLoading.accounts) ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`} />
                          刷新
                        </button>
                        {isUpstreamChannelMode && (
                          <>
                            <button
                              className="btn btn-success"
                              onClick={() => handleUpstreamProxyAction('start')}
                              disabled={upstreamLoading.action}
                            >
                              <i className={`fas ${upstreamLoading.action ? 'fa-spinner fa-spin' : 'fa-play'}`} />
                              启动反代
                            </button>
                            <button
                              className="btn btn-warning"
                              onClick={() => handleUpstreamProxyAction('stop')}
                              disabled={upstreamLoading.action}
                            >
                              <i className={`fas ${upstreamLoading.action ? 'fa-spinner fa-spin' : 'fa-stop'}`} />
                              停止反代
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {!isUpstreamChannelMode && (
                      <div className="upstream-config-tip" style={{ marginTop: '0.75rem' }}>
                        当前为直连模式，仅显示 Claude API 健康检查。
                      </div>
                    )}
                  </div>

                  {isUpstreamChannelMode && (
                    <div className="detail-group">
                      <div className="detail-group-title">导入 refreshToken</div>
                      <div className="upstream-import-box">
                        <textarea
                          className="upstream-token-input"
                          value={upstreamImportToken}
                          onChange={e => setUpstreamImportToken(e.target.value)}
                          placeholder={'支持两种格式:\n1) 单个 refreshToken\n2) JSON 数组: [{"email":"a@b.com","refresh_token":"..."}]'}
                          rows={3}
                        />
                        <button
                          className="btn btn-primary"
                          onClick={handleImportUpstreamToken}
                          disabled={!upstreamImportToken.trim() || upstreamLoading.action}
                        >
                          <i className={`fas ${upstreamLoading.action ? 'fa-spinner fa-spin' : 'fa-file-import'}`} />
                          导入到上游
                        </button>
                      </div>
                    </div>
                  )}

                  {isUpstreamChannelMode && (
                    <div className="detail-group">
                      <div className="detail-group-title">上游账号管理</div>
                      <div className="upstream-account-toolbar">
                        <select
                          value={upstreamSwitchAccountId}
                          onChange={e => setUpstreamSwitchAccountId(e.target.value)}
                        >
                          <option value="">-- 选择上游账号 --</option>
                          {upstreamAccounts.map(account => (
                            <option key={account.accountId || account.email} value={account.accountId}>
                              {account.email} {account.accountId ? `(${account.accountId})` : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-outline"
                          onClick={handleSwitchUpstreamAccount}
                          disabled={!upstreamSwitchAccountId || upstreamLoading.action}
                        >
                          <i className={`fas ${upstreamLoading.action ? 'fa-spinner fa-spin' : 'fa-random'}`} />
                          切换到该账号
                        </button>
                      </div>
                      <div className="upstream-account-list">
                        {upstreamLoading.accounts ? (
                          <div className="loading-state">加载中...</div>
                        ) : upstreamAccounts.length > 0 ? (
                          upstreamAccounts.map(account => (
                            <div key={account.accountId || account.email} className={`upstream-account-item ${account.isActive ? 'active' : ''}`}>
                              <div className="upstream-account-main">
                                <div className="upstream-account-email">{account.email || '--'}</div>
                                <div className="upstream-account-id">{account.accountId || '--'}</div>
                              </div>
                              <div className="upstream-account-state">
                                <span className={`status-dot ${account.isActive ? 'healthy' : 'disabled'}`}>
                                  {account.isActive ? '当前' : '待机'}
                                </span>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="empty-list">暂无上游账号，请先导入 refreshToken</div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 额度信息Tab */}
              {detailTab === 'quota' && (
                <div className="detail-group">
                  <div className="detail-group-title">额度信息</div>
                  {USAGE_SUPPORTED_TYPES.has(providerType) ? (
                    <div className="quota-detail-content">
                    <QuotaDisplay
                      providerType={providerType}
                      uuid={selectedAccount.uuid}
                      usageData={quotaUsageEntry?.data}
                      loading={quotaUsageEntry?.loading}
                      error={quotaUsageEntry?.error}
                      subTier={selectedAccount?.credentials?.tier || null}
                    />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-outline btn-refresh-quota"
                          onClick={() => loadAccountUsage(selectedAccount.uuid, { refresh: true })}
                          disabled={usageDataMap[selectedAccount.uuid]?.loading}
                        >
                          <i className={`fas ${usageDataMap[selectedAccount.uuid]?.loading ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`} />
                          刷新额度
                        </button>
                        <button
                          className="btn btn-outline"
                          onClick={() => {
                            setQuotaDebugModalOpen(true);
                            setQuotaDebugError('');
                            setQuotaDebugResult(null);
                          }}
                        >
                          <i className="fas fa-vial" /> 测试额度查询
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-list">该渠道不支持额度查询</div>
                  )}
                </div>
              )}

              {/* 检测配置Tab */}
              {detailTab === 'check' && (
                <>
                  <div className="detail-group">
                    <div className="detail-group-title">检测设置</div>
                    <div className="config-form">
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>启用健康检测</label>
                          <select
                            value={editFormData.checkHealth ? 'true' : 'false'}
                            onChange={e => updateEditField('checkHealth', e.target.value === 'true')}
                          >
                            <option value="true">启用</option>
                            <option value="false">禁用</option>
                          </select>
                        </div>
                        <div className="config-form-item">
                          <label>检测模型</label>
                          <select
                            value={editFormData.checkModelName || ''}
                            onChange={e => updateEditField('checkModelName', e.target.value)}
                          >
                            <option value="">-- 选择检测模型 --</option>
                            {COMMON_CHECK_MODELS.map(model => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        </div>
                        <div className="config-form-item full">
                          <label>最后检测使用的模型</label>
                          <input type="text" value={selectedAccount.lastHealthCheckModel || '--'} readOnly />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="detail-group">
                    <div className="detail-group-title">不支持的模型</div>
                    <div className="model-checkbox-list">
                      {COMMON_CHECK_MODELS.map(model => {
                        const notSupported = editFormData.notSupportedModels || [];
                        const isChecked = notSupported.includes(model);
                        return (
                          <label key={model} className="model-checkbox-item">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={e => {
                                const newList = e.target.checked
                                  ? [...notSupported, model]
                                  : notSupported.filter(m => m !== model);
                                updateEditField('notSupportedModels', newList);
                              }}
                            />
                            <span>{model}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="detail-group">
                    <div className="detail-group-title">检测时间</div>
                    <div className="config-form">
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>最后检测时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.lastHealthCheckTime)} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>计划恢复时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.scheduledRecoveryTime)} readOnly />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* 手动测试 Tab */}
              {detailTab === 'manual-test' && (providerType === 'openai-codex' || providerType === 'openai-xai-oauth') && (
                <>
                  <div className="detail-group">
                    <div className="detail-group-title">手动测试</div>
                    <div className="config-form">
                      <div className="config-form-grid">
                        <div className="config-form-item">
                          <label>测试模型</label>
                          <select
                            value={manualTestModel}
                            onChange={e => setManualTestModel(e.target.value)}
                            disabled={checkingIds.has(selectedAccount.uuid)}
                          >
                            {manualTestModels.map(model => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        </div>
                        <div className="config-form-item">
                          <label>&nbsp;</label>
                          <button
                            type="button"
                            className="btn-header-action"
                            onClick={() => handleManualTest(selectedAccount.uuid)}
                            disabled={checkingIds.has(selectedAccount.uuid) || !manualTestModel}
                          >
                            <i className={`fas ${checkingIds.has(selectedAccount.uuid) ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} />
                            <span>{checkingIds.has(selectedAccount.uuid) ? '测试中...' : '发送测试'}</span>
                          </button>
                        </div>
                      </div>
                      <small className="form-hint">
                        直接使用该账号凭证对上游发送一次 ping 请求，结果仅展示，不覆盖渠道默认检测模型。
                      </small>
                    </div>
                  </div>

                  {manualTestResult && (
                    <div className="detail-group">
                      <div className="detail-group-title">
                        测试结果
                        {!manualTestResult.loading && (
                          <span
                            style={{
                              marginLeft: 8,
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 12,
                              background: manualTestResult.success ? '#d4edda' : '#f8d7da',
                              color: manualTestResult.success ? '#155724' : '#721c24'
                            }}
                          >
                            {manualTestResult.success ? '成功' : '失败'}
                          </span>
                        )}
                      </div>
                      <div className="config-form">
                        <div className="config-form-grid">
                          <div className="config-form-item">
                            <label>使用模型</label>
                            <input type="text" value={manualTestResult.model || '--'} readOnly />
                          </div>
                          <div className="config-form-item">
                            <label>结束时间</label>
                            <input
                              type="text"
                              value={manualTestResult.finishedAt ? formatDateTime(manualTestResult.finishedAt) : '--'}
                              readOnly
                            />
                          </div>
                          <div className="config-form-item full">
                            <label>上游响应</label>
                            <textarea
                              value={manualTestResult.loading ? '测试中...' : (manualTestResult.message || '')}
                              readOnly
                              rows={6}
                              style={{ fontFamily: 'monospace', fontSize: 12 }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 可用模型 Tab */}
              {detailTab === 'available-models' && providerType === 'claude-windsurf' && (
                <RemoteAvailableModelsTab
                  account={selectedAccount}
                  providerType={providerType}
                  onRefreshed={(models) => {
                    setProviders(prev => prev.map(p =>
                      p.uuid === selectedAccount.uuid ? { ...p, availableModels: models, available_models: models } : p
                    ));
                  }}
                />
              )}

              {detailTab === 'available-models' && providerType === 'openai-xai-oauth' && (
                <RemoteAvailableModelsTab
                  account={selectedAccount}
                  providerType={providerType}
                  onRefreshed={(models) => {
                    setProviders(prev => prev.map(p =>
                      p.uuid === selectedAccount.uuid ? { ...p, availableModels: models, available_models: models } : p
                    ));
                  }}
                />
              )}

              {detailTab === 'available-models' && providerType === 'openai-codex' && (
                <>
                  <div className="detail-group">
                    <div className="detail-group-title">
                      该账号可用模型
                      <button
                        type="button"
                        className="btn-header-action"
                        style={{ marginLeft: 12 }}
                        onClick={() => handleCheck(selectedAccount.uuid)}
                        disabled={checkingIds.has(selectedAccount.uuid)}
                      >
                        <i className={`fas ${checkingIds.has(selectedAccount.uuid) ? 'fa-spinner fa-spin' : 'fa-sync'}`} />
                        <span>{checkingIds.has(selectedAccount.uuid) ? '刷新中...' : '刷新'}</span>
                      </button>
                    </div>
                    <div className="config-form">
                      <small className="form-hint">
                        列表来自上游 /backend-api/codex/models,随每次健康检测自动更新。上游按 client_version 返回账号可见的模型,Plus/Pro 可见范围可能不同。
                      </small>
                      {(() => {
                        const models = Array.isArray(selectedAccount.availableModels) ? selectedAccount.availableModels : [];
                        if (models.length === 0) {
                          return (
                            <div style={{ padding: '16px 0', color: '#888' }}>
                              暂无可用模型记录。点击上方"刷新"按钮触发一次健康检测即可拉取。
                            </div>
                          );
                        }
                        return (
                          <div className="models-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0' }}>
                            {models.map((model, idx) => (
                              <span
                                key={`${model}-${idx}`}
                                className="model-tag"
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: 12,
                                  background: '#eef4ff',
                                  color: '#1d4ed8',
                                  fontSize: 12,
                                  fontFamily: 'monospace'
                                }}
                              >
                                {model}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                      <div className="config-form-grid" style={{ marginTop: 12 }}>
                        <div className="config-form-item">
                          <label>最后检测时间</label>
                          <input type="text" value={formatDateTime(selectedAccount.lastHealthCheckTime)} readOnly />
                        </div>
                        <div className="config-form-item">
                          <label>订阅类型</label>
                          <input type="text" value={selectedAccount.subscriptionTitle || '--'} readOnly />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {detailTab === 'requests' && (
                <div className="request-logs-container">
                  {/* 统计摘要 */}
                  {requestLogsSummary && (
                    <div className="request-logs-summary">
                      <div className="summary-item">
                        <span className="summary-label">总请求</span>
                        <span className="summary-value">{requestLogsSummary.total}</span>
                      </div>
                      <div className="summary-item">
                        <span className="summary-label">成功</span>
                        <span className="summary-value text-success">{requestLogsSummary.successCount}</span>
                      </div>
                      <div className="summary-item">
                        <span className="summary-label">失败</span>
                        <span className="summary-value text-danger">{requestLogsSummary.failCount}</span>
                      </div>
                      <div className="summary-item">
                        <span className="summary-label">平均耗时</span>
                        <span className="summary-value">{requestLogsSummary.avgDuration}ms</span>
                      </div>
                    </div>
                  )}
                  {/* 筛选按钮 */}
                  <div className="request-logs-filter">
                    <button
                      className={`filter-btn ${requestLogsFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setRequestLogsFilter('all')}
                    >
                      全部
                    </button>
                    <button
                      className={`filter-btn ${requestLogsFilter === 'success' ? 'active' : ''}`}
                      onClick={() => setRequestLogsFilter('success')}
                    >
                      成功
                    </button>
                    <button
                      className={`filter-btn ${requestLogsFilter === 'fail' ? 'active' : ''}`}
                      onClick={() => setRequestLogsFilter('fail')}
                    >
                      失败
                    </button>
                  </div>
                  {requestLogsLoading ? (
                    <div className="loading-state">加载中...</div>
                  ) : requestLogs.length > 0 ? (
                    <>
                      <div className="request-list">
                        {requestLogs.map((log, index) => {
                          const proxyLabel = formatProxyNodeLabel(log);
                          return (
                            <div key={log.id || index} className="request-item">
                              <div className="request-item-header">
                                <span className="request-time">{formatDateTime(log.createdAt)}</span>
                                <span className={`request-status ${log.isSuccess ? 'success' : 'fail'}`}>
                                  {log.statusCode || (log.isSuccess ? '200' : 'ERR')}
                                </span>
                                {log.requestModel && <span className="request-model">{log.requestModel}</span>}
                                {log.durationMs > 0 && <span className="request-duration">{log.durationMs}ms</span>}
                                {!log.isSuccess && (log.errorDetail || log.errorStack || log.curlCommand) && (
                                  <button
                                    className="request-detail-btn"
                                    onClick={() => setErrorDetailLog(log)}
                                  >
                                    详情
                                  </button>
                                )}
                              </div>
                              {log.inputTokens > 0 || log.outputTokens > 0 ? (
                                <div className="request-tokens">
                                  <span>输入: {log.inputTokens}</span>
                                  <span>输出: {log.outputTokens}</span>
                                </div>
                              ) : null}
                              {(log.clientTokenId || log.username || log.userEmail || log.userId || log.clientIp || proxyLabel) ? (
                                <div className="request-meta">
                                  {log.clientTokenId && (
                                    <span title={log.clientTokenId}>
                                      Token: {log.clientTokenId.length > 10 ? `${log.clientTokenId.slice(0, 10)}...` : log.clientTokenId}
                                    </span>
                                  )}
                                  {log.username && <span>用户: {log.username}</span>}
                                  {log.userId && <span>ID: {log.userId}</span>}
                                  {log.clientIp && <span>IP: {log.clientIp}</span>}
                                  {proxyLabel && <span className="request-proxy">代理: {proxyLabel}</span>}
                                </div>
                              ) : null}
                              {!log.isSuccess && log.errorMessage && (
                                <div className="request-error">{log.errorMessage}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {requestLogsTotalPages > 1 && (
                        <div className="request-logs-pagination">
                          <button
                            className="btn btn-sm"
                            disabled={requestLogsPage <= 1}
                            onClick={() => loadRequestLogs(selectedAccount.uuid, requestLogsPage - 1, requestLogsFilter)}
                          >
                            上一页
                          </button>
                          <span className="page-info">{requestLogsPage} / {requestLogsTotalPages}</span>
                          <button
                            className="btn btn-sm"
                            disabled={requestLogsPage >= requestLogsTotalPages}
                            onClick={() => loadRequestLogs(selectedAccount.uuid, requestLogsPage + 1, requestLogsFilter)}
                          >
                            下一页
                          </button>
                        </div>
                      )}
                      <div className="request-logs-total">共 {requestLogsTotal} 条记录</div>
                    </>
                  ) : (
                    <div className="empty-list">暂无请求记录</div>
                  )}
                </div>
              )}

              {detailTab === 'errors' && (
                <div className="error-logs-container">
                  {errorLogsLoading ? (
                    <div className="loading-state">加载中...</div>
                  ) : errorLogs.length > 0 ? (
                    <>
                      <div className="error-list">
                        {errorLogs.map((log, index) => (
                          <div key={log.id || index} className="error-item">
                            <div className="error-item-header">
                              <span className="error-time">{formatDateTime(log.createdAt)}</span>
                              <span className={`error-code ${(log.statusCode >= 500) ? 'server' : (log.statusCode >= 400) ? 'client' : ''}`}>
                                {log.statusCode || 'ERR'}
                              </span>
                              {log.requestModel && <span className="error-model">{log.requestModel}</span>}
                              {log.durationMs > 0 && <span className="error-duration">{log.durationMs}ms</span>}
                              <button
                                className="error-detail-btn"
                                onClick={() => setErrorDetailLog(log)}
                              >
                                详情
                              </button>
                            </div>
                            <div className="error-message">{log.errorMessage || '未知错误'}</div>
                            {(log.clientIp || log.username || log.userEmail) && (
                              <div className="error-meta">
                                {log.clientIp && <span>IP: {log.clientIp}</span>}
                                {log.username && <span>用户: {log.username}</span>}
                                {log.userEmail && <span>邮箱: {log.userEmail}</span>}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      {errorLogsTotalPages > 1 && (
                        <div className="error-logs-pagination">
                          <button
                            className="btn btn-sm"
                            disabled={errorLogsPage <= 1}
                            onClick={() => loadErrorLogs(selectedAccount.uuid, errorLogsPage - 1)}
                          >
                            上一页
                          </button>
                          <span className="page-info">{errorLogsPage} / {errorLogsTotalPages}</span>
                          <button
                            className="btn btn-sm"
                            disabled={errorLogsPage >= errorLogsTotalPages}
                            onClick={() => loadErrorLogs(selectedAccount.uuid, errorLogsPage + 1)}
                          >
                            下一页
                          </button>
                        </div>
                      )}
                      <div className="error-logs-total">共 {errorLogsTotal} 条记录</div>
                    </>
                  ) : (
                    <div className="empty-list">暂无错误记录</div>
                  )}

                  {/* 错误详情弹窗 */}
                  {errorDetailLog && (
                    <div className="error-detail-overlay" onClick={() => setErrorDetailLog(null)}>
                      <div className="error-detail-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="error-detail-header">
                          <h4>错误详情</h4>
                          <button className="modal-close" onClick={() => setErrorDetailLog(null)}>
                            <i className="fas fa-times"></i>
                          </button>
                        </div>
                        <div className="error-detail-body">
                          <div className="error-detail-grid">
                            <div className="error-detail-item">
                              <span className="label">时间</span>
                              <span className="value">{formatDateTime(errorDetailLog.createdAt)}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">状态码</span>
                              <span className="value">{errorDetailLog.statusCode || '-'}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">模型</span>
                              <span className="value">{errorDetailLog.requestModel || '-'}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">耗时</span>
                              <span className="value">{errorDetailLog.durationMs ? `${errorDetailLog.durationMs}ms` : '-'}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">客户端IP</span>
                              <span className="value">{errorDetailLog.clientIp || '-'}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">用户</span>
                              <span className="value">{errorDetailLog.username || errorDetailLog.userEmail || errorDetailLog.userId || '-'}</span>
                            </div>
                            <div className="error-detail-item">
                              <span className="label">代理节点</span>
                              <span className="value">{formatProxyNodeLabel(errorDetailLog) || '-'}</span>
                            </div>
                          </div>
                          <div className="error-detail-section">
                            <div className="label">错误信息</div>
                            <div className="error-detail-message">{errorDetailLog.errorMessage || '无'}</div>
                          </div>
                          {errorDetailLog.errorDetail && (
                            <div className="error-detail-section">
                              <div className="label">错误详情</div>
                              <pre className="error-detail-pre">{(() => {
                                try {
                                  const parsed = typeof errorDetailLog.errorDetail === 'string'
                                    ? JSON.parse(errorDetailLog.errorDetail)
                                    : errorDetailLog.errorDetail;
                                  return JSON.stringify(parsed, null, 2);
                                } catch {
                                  return errorDetailLog.errorDetail;
                                }
                              })()}</pre>
                            </div>
                          )}
                          {errorDetailLog.errorStack && (
                            <div className="error-detail-section">
                              <div className="label">错误堆栈</div>
                              <pre className="error-detail-pre">{errorDetailLog.errorStack}</pre>
                            </div>
                          )}
                          {errorDetailLog.curlCommand && (
                            <div className="error-detail-section">
                              <div className="label">
                                curl 命令
                                <button
                                  className="copy-btn"
                                  onClick={() => {
                                    navigator.clipboard.writeText(errorDetailLog.curlCommand);
                                    alert('已复制');
                                  }}
                                >
                                  <i className="fas fa-copy"></i> 复制
                                </button>
                              </div>
                              <pre className="error-detail-pre curl-pre">{errorDetailLog.curlCommand}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {detailTab === 'status' && (
                <div className="status-logs-container">
                  {statusLogsLoading ? (
                    <div className="loading-state">加载中...</div>
                  ) : statusLogs.length > 0 ? (
                    <>
                      <div className="status-list">
                        {statusLogs.map((log, index) => (
                          <div key={log.id || index} className="status-item">
                            <div className="status-item-header">
                              <span className="status-time">{formatDateTime(log.created_at)}</span>
                              <span className="status-action">{formatStatusAction(log.action)}</span>
                              {log.source && <span className="status-source">{log.source}</span>}
                            </div>
                            <div className="status-item-body">
                              <span className={`status-badge ${log.from_status || 'unknown'}`}>
                                {formatStatusLabel(log.from_status)}
                              </span>
                              <span className="status-arrow">-&gt;</span>
                              <span className={`status-badge ${log.to_status || 'unknown'}`}>
                                {formatStatusLabel(log.to_status)}
                              </span>
                            </div>
                            {log.reason && <div className="status-reason">{log.reason}</div>}
                          </div>
                        ))}
                      </div>
                      {statusLogsTotalPages > 1 && (
                        <div className="status-logs-pagination">
                          <button
                            className="btn btn-sm"
                            disabled={statusLogsPage <= 1}
                            onClick={() => loadStatusLogs(selectedAccount.uuid, statusLogsPage - 1)}
                          >
                            上一页
                          </button>
                          <span className="page-info">{statusLogsPage} / {statusLogsTotalPages}</span>
                          <button
                            className="btn btn-sm"
                            disabled={statusLogsPage >= statusLogsTotalPages}
                            onClick={() => loadStatusLogs(selectedAccount.uuid, statusLogsPage + 1)}
                          >
                            下一页
                          </button>
                        </div>
                      )}
                      <div className="status-logs-total">共 {statusLogsTotal} 条记录</div>
                    </>
                  ) : (
                    <div className="empty-list">暂无状态记录</div>
                  )}
                </div>
              )}

              {/* 实时用户 Tab */}
              {detailTab === 'users' && (
                <div className="detail-section">
                  <div className="section-header">
                    <h4>近5分钟使用此账号的用户 ({accountUniqueUserCount || activeUsers.length})</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <span className="pool-strategy">当前并发 {accountCurrentConcurrency}</span>
                      <span className="pool-strategy">峰值并发 {accountPeakConcurrency}</span>
                      <span className="pool-strategy">活跃用户 {accountActiveUserCount}</span>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => loadActiveUsers(selectedAccount.uuid)}
                        disabled={activeUsersLoading}
                      >
                        <i className="fas fa-sync-alt" /> 刷新
                      </button>
                    </div>
                  </div>
                  {activeUsersLoading ? (
                    <div className="loading-spinner">加载中...</div>
                  ) : activeUsers.length > 0 ? (
                    <div className="active-users-list">
                      {activeUsers.map((user, idx) => (
                        <div key={user.userKey || idx} className="active-user-card">
                          <div className="user-avatar">
                            <i className="fas fa-user-circle" />
                          </div>
                          <div className="user-info">
                            <div className="user-main">
                              <span className="user-name">{user.username || user.tokenId || '-'}</span>
                              <span className="user-model">{user.model || '-'}</span>
                              {(() => {
                                const sc = userSessionCounts[user.userKey];
                                return sc && sc.count > 0 ? (
                                  <span className="user-sessions" title={`Session IDs: ${sc.sessionIds?.map(s => s.slice(0,8)).join(', ')}`}>
                                    <i className="fas fa-desktop" /> {sc.count} session{sc.count > 1 ? 's' : ''}
                                  </span>
                                ) : null;
                              })()}
                              {(() => {
                                const current = Number(user.currentConcurrency ?? userConcurrencyMap[user.userKey]) || 0;
                                const peak = Number(user.peakConcurrency ?? userPeakConcurrencyMap[user.userKey]) || current;
                                if (current <= 0 && peak <= 0) return null;
                                return (
                                  <span className="user-concurrency" title={`当前并发 ${current}，峰值并发 ${peak}`}>
                                    <i className="fas fa-bolt" /> 并发 {current}/{peak}
                                  </span>
                                );
                              })()}
                            </div>
                            <div className="user-details">
                              <span className="user-ip"><i className="fas fa-globe" /> {user.clientIp || '-'}</span>
                              <span className="user-time"><i className="fas fa-clock" /> {user.lastSeen ? new Date(user.lastSeen).toLocaleString() : '-'}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-list">近5分钟内没有用户使用此账号</div>
                  )}
                </div>
              )}

              {/* Token 统计 Tab */}
              {detailTab === 'tokens' && (
                <div className="detail-section">
                  <div className="section-header">
                    <h4>Token 使用统计</h4>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => rebuildTokenStats(selectedAccount.uuid)}
                        disabled={tokenStatsLoading || tokenStatsRebuilding}
                      >
                        <i className="fas fa-history" /> {tokenStatsRebuilding ? '补全中...' : '补全历史'}
                      </button>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => loadTokenStats(selectedAccount.uuid)}
                        disabled={tokenStatsLoading || tokenStatsRebuilding}
                      >
                        <i className="fas fa-sync-alt" /> 刷新
                      </button>
                    </div>
                  </div>
                  {tokenStatsLoading ? (
                    <div className="loading-spinner">加载中...</div>
                  ) : tokenStats?.stats && tokenStats.stats.length > 0 ? (
                    <div className="token-stats-container">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>输入 Token (M)</th>
                            <th>输出 Token (M)</th>
                            <th>总计 Token (M)</th>
                            <th>缓存写入 (M)</th>
                            <th>缓存读取 (M)</th>
                            <th>请求次数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tokenStats.stats.map((stat, idx) => (
                            <tr key={idx} className={stat.model === '总计' ? 'total-row' : ''}>
                              <td className={stat.model === '总计' ? 'bold' : ''}>{stat.model}</td>
                              <td className="num-highlight">{stat.inputTokensM}</td>
                              <td className="num-highlight">{stat.outputTokensM}</td>
                              <td className="num-highlight primary">{stat.totalTokensM}</td>
                              <td className="num-highlight">{stat.cacheCreationTokensM ?? '0.00'}</td>
                              <td className="num-highlight">{stat.cacheReadTokensM ?? '0.00'}</td>
                              <td>{stat.requestCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {tokenStats.stats[0]?.lastUpdated && (
                        <div className="stats-footer">
                          最后更新: {new Date(tokenStats.stats[0].lastUpdated).toLocaleString()}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="empty-list">暂无 Token 使用记录</div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setSelectedAccount(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveAccount}
                disabled={savingAccount}
              >
                {savingAccount ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kiro 方法选择弹窗 */}
      <KiroMethodModal
        open={showKiroMethod}
        fixedPoolId={poolId}
        onClose={() => setShowKiroMethod(false)}
        onSelect={(mode, selectedPoolId) => {
          setShowKiroMethod(false);
          if (mode === 'google') {
            handleGenerateAuthUrl('claude-kiro-oauth', {
              method: 'google',
              poolId: selectedPoolId || poolId || undefined
            });
          } else if (mode === 'builder-id') {
            handleGenerateAuthUrl('claude-kiro-oauth', {
              method: 'builder-id',
              poolId: selectedPoolId || poolId || undefined
            });
          } else if (mode === 'batch-import') {
            setShowKiroBatchImport(true);
          } else if (mode === 'aws-import') {
            setShowKiroAwsImport(true);
          }
        }}
      />

      {/* Codex 方法选择弹窗 */}
      <CodexMethodModal
        open={showCodexMethod}
        onClose={() => setShowCodexMethod(false)}
        onSelect={(mode) => {
          setShowCodexMethod(false);
          if (mode === 'oauth') {
            const normalizedPoolId = Number.isFinite(Number(poolId)) ? Number(poolId) : undefined;
            handleGenerateAuthUrl('openai-codex', { poolId: normalizedPoolId });
          } else if (mode === 'json-import') {
            setShowCodexJsonImport(true);
          }
        }}
      />

      {/* Codex JSON 导入弹窗 */}
      <CodexJsonImportModal
        open={showCodexJsonImport}
        poolId={poolId}
        poolOptions={pools}
        onClose={() => setShowCodexJsonImport(false)}
        onSuccess={() => loadProviders()}
      />

      {/* Grok 方法选择弹窗 */}
      <GrokMethodModal
        open={showGrokMethod}
        pools={pools}
        fixedPoolId={poolId}
        onClose={() => setShowGrokMethod(false)}
        onSelect={(mode, selectedPoolId) => {
          setShowGrokMethod(false);
          const normalizedPoolId = Number.isFinite(Number(selectedPoolId))
            ? Number(selectedPoolId)
            : (Number.isFinite(Number(poolId)) ? Number(poolId) : undefined);
          if (mode === 'oauth') {
            handleGenerateAuthUrl('openai-xai-oauth', { poolId: normalizedPoolId });
          } else if (mode === 'import') {
            setShowGrokImport(true);
          }
        }}
      />

      {/* Grok JSON / Token 导入弹窗 */}
      <GrokImportModal
        open={showGrokImport}
        fixedPoolId={poolId}
        poolOptions={pools}
        onClose={() => setShowGrokImport(false)}
        onSuccess={() => loadProviders()}
      />

      {/* Kiro 批量导入弹窗 */}
      <KiroBatchImportModal
        open={showKiroBatchImport}
        poolId={poolId}
        onClose={() => setShowKiroBatchImport(false)}
        onSuccess={() => loadProviders()}
      />

      {/* Kiro AWS SSO 导入弹窗 */}
      <KiroAwsImportModal
        open={showKiroAwsImport}
        poolId={poolId}
        onClose={() => setShowKiroAwsImport(false)}
        onSuccess={() => loadProviders()}
      />

      <ModalShell
        open={quotaDebugModalOpen}
        onClose={() => {
          if (quotaDebugLoading) return;
          setQuotaDebugModalOpen(false);
        }}
        title="测试额度查询"
        subtitle="点击发送后展示完整响应信息"
        size="lg"
        footer={(
          <>
            <button
              className="btn btn-outline"
              onClick={() => setQuotaDebugModalOpen(false)}
              disabled={quotaDebugLoading}
            >
              关闭
            </button>
            <button className="btn btn-primary" onClick={handleSendQuotaDebug} disabled={quotaDebugLoading}>
              <i className={`fas ${quotaDebugLoading ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} />
              {quotaDebugLoading ? '发送中...' : '发送'}
            </button>
          </>
        )}
      >
        <div className="detail-group" style={{ marginBottom: 12 }}>
          <div className="detail-group-title">请求参数</div>
          <div className="detail-row"><span>渠道:</span><span>{providerType}</span></div>
          <div className="detail-row"><span>账号UUID:</span><span>{selectedAccount?.uuid || '--'}</span></div>
          <div className="detail-row"><span>池ID:</span><span>{poolId ?? '--'}</span></div>
        </div>
        {quotaDebugError && <div className="error-banner">{quotaDebugError}</div>}
        <div className="detail-group">
          <div className="detail-group-title">完整响应</div>
          <pre className="dispatch-log-detail-pre" style={{ maxHeight: 420, overflow: 'auto' }}>
            {quotaDebugResult ? JSON.stringify(quotaDebugResult, null, 2) : '点击“发送”开始测试'}
          </pre>
        </div>
      </ModalShell>

      <AuthUrlModal
        open={Boolean(authModal)}
        providerType={authModal?.providerType}
        providerLabel={PROVIDER_NAME_MAP[authModal?.authInfo?.provider || authModal?.providerType] || authModal?.providerType}
        authUrl={authModal?.authUrl}
        authInfo={authModal?.authInfo}
        pools={pools}
        onClose={() => setAuthModal(null)}
        onRegenerate={(options) => handleGenerateAuthUrl(authModal?.providerType, options)}
        onManualCallback={handleManualCallback}
        onSuccess={handleAuthSuccess}
      />

      {/* 批量删除确认弹窗 */}
      <BatchDeleteModal
        open={batchDeleteModal}
        count={selectedUuids.size}
        loading={batchLoading}
        error={batchDeleteError}
        onClose={handleCloseBatchDeleteModal}
        onConfirm={handleBatchDeleteConfirm}
      />

      {/* 按筛选条件批量删除确认弹窗 */}
      <ModalShell
        open={filterDeleteModal}
        onClose={() => !filterDeleteLoading && setFilterDeleteModal(false)}
        title="删除所有筛选结果"
        subtitle={`即将删除当前筛选条件下的 ${totalCount} 个账号`}
        size="sm"
        footer={(
          <>
            <button className="btn btn-outline" onClick={() => setFilterDeleteModal(false)} disabled={filterDeleteLoading}>
              取消
            </button>
            <button className="btn btn-warning" onClick={() => handleFilterDeleteConfirm('soft')} disabled={filterDeleteLoading}>
              <i className="fas fa-trash" /> 软删除
            </button>
            <button className="btn btn-danger" onClick={() => handleFilterDeleteConfirm('hard')} disabled={filterDeleteLoading}>
              <i className="fas fa-skull-crossbones" /> 硬删除
            </button>
          </>
        )}
      >
        <div className="batch-delete-modal">
          <p className="batch-delete-note">软删除仅标记删除，可在列表中查看。</p>
          <p className="batch-delete-warning">硬删除会清理凭据与 OAuth 关联数据，且不可恢复。</p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 8 }}>
            筛选条件：{filter}
            {createdAfter && ` | 从 ${createdAfter}`}
            {createdBefore && ` | 至 ${createdBefore}`}
            {poolId && ` | 池 ${poolId}`}
          </p>
          {filterDeleteError && <div className="batch-delete-error">{filterDeleteError}</div>}
        </div>
      </ModalShell>

      {/* 批量操作弹窗 */}
      <BatchOperationModal
        open={batchOperationModal}
        providerType={PROVIDER_NAME_MAP[providerType] || providerType}
        providerTypeKey={providerType}
        onClose={() => setBatchOperationModal(false)}
        onExecute={handleBatchOperation}
      />

      {/* 凭证同步弹窗 */}
      <ModalShell
        open={showSyncModal}
        onClose={() => { setShowSyncModal(false); setSyncResult(null); }}
        title={`同步凭证到 ${providerType === 'gemini-antigravity' ? 'Claude Antigravity' : 'Gemini Antigravity'}`}
        subtitle="将当前所有凭证同步到目标渠道，已存在的邮箱会更新令牌"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => { setShowSyncModal(false); setSyncResult(null); }}>
              {syncResult?.success ? '关闭' : '取消'}
            </button>
            {!syncResult?.success && (
              <button className="btn btn-primary" onClick={handleSyncAntigravity} disabled={syncLoading}>
                {syncLoading ? <><i className="fas fa-spinner fa-spin" /> 同步中...</> : <><i className="fas fa-exchange-alt" /> 确认同步</>}
              </button>
            )}
          </div>
        }
      >
        {syncResult ? (
          <div style={{ padding: '12px 0' }}>
            {syncResult.success ? (
              <div className="success-message" style={{ color: 'var(--success-color, #22c55e)' }}>
                <i className="fas fa-check-circle" /> 同步完成：新建 <b>{syncResult.synced}</b> 个，更新 <b>{syncResult.skipped}</b> 个
              </div>
            ) : (
              <div className="error-message" style={{ color: 'var(--danger-color, #ef4444)' }}>
                <i className="fas fa-times-circle" /> 同步失败：{syncResult.error}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '8px 0' }}>
            <label style={{ fontWeight: 500 }}>目标号池</label>
            <select
              className="form-select"
              value={syncTargetPoolId}
              onChange={e => setSyncTargetPoolId(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color, #d1d5db)' }}
            >
              <option value="">不指定（自动分配）</option>
              {syncTargetPools.map(pool => (
                <option key={pool.id} value={pool.id}>
                  {pool.name || `池 #${pool.id}`}{pool.is_default ? ' (默认)' : ''}
                </option>
              ))}
            </select>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)' }}>
              将 {providerType === 'gemini-antigravity' ? 'Gemini' : 'Claude'} Antigravity 的所有凭证同步到{providerType === 'gemini-antigravity' ? 'Claude' : 'Gemini'} Antigravity
            </div>
          </div>
        )}
      </ModalShell>
    </div>
  );
}
