/**
 * 渠道管理页面
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { providerService } from '../services/provider.service';
import { configService } from '../services/config.service';
import { usageService } from '../services/usage.service';
import * as poolConfigService from '../services/pool-config.service';
import AuthUrlModal from '../components/AuthUrlModal';
import { CodexJsonImportModal, GrokImportModal } from '../components/KiroImportModals';
import './Providers.css';
import './Providers-detail-modal.css';

const OSS_HIDDEN_PROVIDERS = new Set(['openai-qwen-oauth','openaiResponses-custom','openai-iflow']);

const PROVIDER_DISPLAY_ORDER = [
  'gemini-cli-oauth',
  'gemini-antigravity',
  'claude-antigravity',
  'openai-custom',
  'claude-custom',
  'claude-offical',
  'claude-kiro-oauth',
  'claude-ami-oauth',
  'claude-warp-oauth',
  'claude-orchids-oauth',
  'openai-droid',
  'openaiResponses-droid',
  'claude-droid',
  'openai-codex',
  'openai-xai-oauth',
  'openai-windsurf',
  'claude-windsurf',
];

const PROVIDER_NAME_MAP = {
  'gemini-cli-oauth': 'Gemini CLI OAuth',
  'gemini-antigravity': 'Gemini Antigravity',
  'claude-antigravity': 'Claude Antigravity',
  'openai-custom': 'OpenAI Custom',
  'claude-custom': 'Claude Custom',
  'claude-offical': 'Claude Offical',
  'claude-kiro-oauth': 'Claude Kiro OAuth',
  'claude-ami-oauth': 'Claude AMI OAuth',
  'claude-warp-oauth': 'Warp AI OAuth',
  'claude-orchids-oauth': 'Orchids OAuth',
  'openai-droid': 'Droid OpenAI',
  'openaiResponses-droid': 'Droid Responses',
  'claude-droid': 'Droid Claude',
  'openai-codex': 'OpenAI Codex OAuth',
  'openai-xai-oauth': 'xAI Grok OAuth',
  'openai-windsurf': 'WindsurfAPI',
  'claude-windsurf': 'Windsurf Native',
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

const PROVIDER_FIELD_CONFIGS = {
  'openai-custom': [
    {
      id: 'OPENAI_API_KEY',
      label: 'OpenAI API Key',
      type: 'password',
      placeholder: 'sk-...'
    },
    {
      id: 'OPENAI_BASE_URL',
      label: 'OpenAI Base URL',
      type: 'text',
      placeholder: 'https://api.openai.com/v1'
    }
  ],
  'openaiResponses-custom': [
    {
      id: 'OPENAI_API_KEY',
      label: 'OpenAI API Key',
      type: 'password',
      placeholder: 'sk-...'
    },
    {
      id: 'OPENAI_BASE_URL',
      label: 'OpenAI Base URL',
      type: 'text',
      placeholder: 'https://api.openai.com/v1'
    }
  ],
  'claude-custom': [
    {
      id: 'CLAUDE_API_KEY',
      label: 'Claude API Key',
      type: 'password',
      placeholder: 'sk-ant-...'
    },
    {
      id: 'CLAUDE_BASE_URL',
      label: 'Claude Base URL',
      type: 'text',
      placeholder: 'https://api.anthropic.com'
    },
    {
      id: 'foxcodeAuthBaseUrl',
      label: 'Foxcode Auth Base URL',
      type: 'text',
      placeholder: 'https://foxcode.rjj.cc'
    },
    {
      id: 'foxcodeEmail',
      label: 'Foxcode 邮箱',
      type: 'text',
      placeholder: 'name@example.com'
    },
    {
      id: 'foxcodePassword',
      label: 'Foxcode 密码',
      type: 'password',
      placeholder: '用于自动登录获取用量'
    },
    {
      id: 'claudeCustomSystemType',
      label: '系统类型',
      type: 'text',
      placeholder: 'self-developed / newapi'
    },
    {
      id: 'newapiUsername',
      label: 'NewAPI 用户名',
      type: 'text',
      placeholder: '用于自动登录拉取用量'
    },
    {
      id: 'newapiPassword',
      label: 'NewAPI 密码',
      type: 'password',
      placeholder: '用于自动登录拉取用量'
    },
    {
      id: 'newapiSystemToken',
      label: 'NewAPI 系统访问令牌',
      type: 'password',
      placeholder: '用于 API 身份认证（可选，优先于账号密码）'
    },
    {
      id: 'newapiUserId',
      label: 'NewAPI 用户ID',
      type: 'text',
      placeholder: '例如: 621 或 github_621'
    }
  ],
  'claude-offical': [
    {
      id: 'CLAUDE_API_KEY',
      label: 'Claude API Key',
      type: 'password',
      placeholder: 'sk-ant-...'
    },
    {
      id: 'CLAUDE_BASE_URL',
      label: 'Claude Base URL',
      type: 'text',
      placeholder: 'https://api.anthropic.com'
    },
    {
      id: 'officialStickySessionEnabled',
      label: '粘性会话开关',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialStickySessionTtlMinutes',
      label: '粘性会话TTL(分钟)',
      type: 'number',
      placeholder: '60'
    },
    {
      id: 'officialSessionBindingStrict',
      label: '严格绑定',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialStickyIdentityMode',
      label: '粘性身份模式',
      type: 'text',
      placeholder: 'session-or-fingerprint'
    },
    {
      id: 'officialFingerprintIncludeUser',
      label: '指纹包含用户',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialFingerprintIncludeToken',
      label: '指纹包含Token',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialFingerprintIncludePath',
      label: '指纹包含路径',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialQueueLockEnabled',
      label: '账号队列锁开关',
      type: 'text',
      placeholder: 'true / false'
    },
    {
      id: 'officialQueueLockTtlMs',
      label: '队列锁TTL(ms)',
      type: 'number',
      placeholder: '120000'
    },
    {
      id: 'officialQueueWaitTimeoutMs',
      label: '队列等待超时(ms)',
      type: 'number',
      placeholder: '30000'
    },
    {
      id: 'officialQueuePollIntervalMs',
      label: '队列轮询间隔(ms)',
      type: 'number',
      placeholder: '150'
    },
    {
      id: 'officialValidationBlockMinutes',
      label: '验证封禁隔离(分钟)',
      type: 'number',
      placeholder: '30'
    },
    {
      id: 'officialRateLimitCooldownMs',
      label: '429限流冷却(ms)',
      type: 'number',
      placeholder: '30000'
    },
    {
      id: 'officialOverloadCooldownMs',
      label: '529过载冷却(ms)',
      type: 'number',
      placeholder: '60000'
    },
    {
      id: 'officialContextL1Threshold',
      label: 'L1压缩阈值(tool截断)',
      type: 'number',
      placeholder: '0.40'
    },
    {
      id: 'officialContextL2Threshold',
      label: 'L2压缩阈值(thinking清理)',
      type: 'number',
      placeholder: '0.55'
    },
    {
      id: 'officialContextL3Threshold',
      label: 'L3压缩阈值(fork摘要)',
      type: 'number',
      placeholder: '0.70'
    },
    {
      id: 'officialFingerprintSalt',
      label: '指纹盐值',
      type: 'text',
      placeholder: '自定义盐值(可选)'
    },
    {
      id: 'officialAutoStopOnWarning',
      label: '5h警告自动停调度',
      type: 'text',
      placeholder: 'true / false'
    }
  ],
  'gemini-cli-oauth': [
    {
      id: 'PROJECT_ID',
      label: '项目ID',
      type: 'text',
      placeholder: 'Google Cloud 项目ID'
    },
    {
      id: 'GEMINI_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/gemini-cli-oauth/1'
    },
    {
      id: 'GEMINI_BASE_URL',
      label: 'Gemini Base URL',
      type: 'text',
      placeholder: 'https://cloudcode-pa.googleapis.com'
    }
  ],
  'claude-kiro-oauth': [
    {
      id: 'KIRO_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/claude-kiro-oauth/1'
    },
    {
      id: 'KIRO_BASE_URL',
      label: 'Base URL',
      type: 'text',
      placeholder: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse'
    },
    {
      id: 'KIRO_REFRESH_URL',
      label: 'Refresh URL',
      type: 'text',
      placeholder: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken'
    },
    {
      id: 'KIRO_REFRESH_IDC_URL',
      label: 'Refresh IDC URL',
      type: 'text',
      placeholder: 'https://oidc.{{region}}.amazonaws.com/token'
    }
  ],
  'claude-ami-oauth': [
    {
      id: 'AMI_WOS_SESSION',
      label: 'WOS Session Cookie',
      type: 'password',
      placeholder: 'wos-session cookie value'
    }
  ],
  'claude-warp-oauth': [
    {
      id: 'WARP_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/claude-warp-oauth/1'
    },
    {
      id: 'WARP_BASE_URL',
      label: 'Warp Base URL',
      type: 'text',
      placeholder: 'https://app.warp.dev'
    },
    {
      id: 'WARP_TOKEN_URL',
      label: 'Token URL',
      type: 'text',
      placeholder: 'https://app.warp.dev/proxy/token?key=AIzaSy...'
    },
    {
      id: 'WARP_API_KEY',
      label: 'API Key',
      type: 'text',
      placeholder: 'AIzaSy...'
    }
  ],
  'openai-qwen-oauth': [
    {
      id: 'QWEN_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/openai-qwen-oauth/1'
    },
    {
      id: 'QWEN_BASE_URL',
      label: 'Qwen Base URL',
      type: 'text',
      placeholder: 'https://portal.qwen.ai/v1'
    },
    {
      id: 'QWEN_OAUTH_BASE_URL',
      label: 'OAuth Base URL',
      type: 'text',
      placeholder: 'https://chat.qwen.ai'
    }
  ],
  'openai-codex': [
    {
      id: 'CODEX_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/openai-codex/1'
    },
    {
      id: 'CODEX_BASE_URL',
      label: 'Codex Base URL',
      type: 'text',
      placeholder: 'https://chatgpt.com'
    }
  ],
  'openai-xai-oauth': [
    {
      id: 'XAI_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/openai-xai-oauth/1'
    },
    {
      id: 'XAI_USING_API',
      label: '请求路径',
      type: 'select',
      options: [
        { value: '', label: '自动（按 Token 权限）' },
        { value: 'true', label: 'xAI 官方 API' },
        { value: 'false', label: 'Grok Build 代理' }
      ]
    },
    {
      id: 'XAI_BASE_URL',
      label: 'xAI API Base URL',
      type: 'text',
      placeholder: 'https://api.x.ai/v1'
    },
    {
      id: 'XAI_CHAT_BASE_URL',
      label: 'Grok Chat Base URL',
      type: 'text',
      placeholder: 'https://cli-chat-proxy.grok.com/v1'
    }
  ],
  'gemini-antigravity': [
    {
      id: 'PROJECT_ID',
      label: '项目ID (选填)',
      type: 'text',
      placeholder: '留空自动发现'
    },
    {
      id: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/gemini-antigravity/1'
    },
    {
      id: 'ANTIGRAVITY_BASE_URL_DAILY',
      label: 'Daily Base URL',
      type: 'text',
      placeholder: 'https://daily-cloudcode-pa.sandbox.googleapis.com'
    },
    {
      id: 'ANTIGRAVITY_BASE_URL_AUTOPUSH',
      label: 'Autopush Base URL',
      type: 'text',
      placeholder: 'https://autopush-cloudcode-pa.sandbox.googleapis.com'
    }
  ],
  'claude-antigravity': [
    {
      id: 'REUSE_GEMINI_CREDENTIALS',
      label: '复用 Gemini Antigravity 凭证',
      type: 'checkbox',
      placeholder: ''
    },
    {
      id: 'SHARED_CREDENTIALS_ID',
      label: '共享凭证ID (复用时填写)',
      type: 'text',
      placeholder: 'gemini-antigravity 的凭证ID'
    },
    {
      id: 'PROJECT_ID',
      label: '项目ID (选填)',
      type: 'text',
      placeholder: '留空自动发现'
    },
    {
      id: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用 (独立授权时填写)',
      type: 'text',
      placeholder: 'db://oauth/claude-antigravity/1'
    }
  ],
  'claude-windsurf': [
    {
      id: 'WINDSURF_API_KEY',
      label: 'Windsurf API Key',
      type: 'password',
      placeholder: 'windsurf.com/show-auth-token 获取'
    },
    {
      id: 'WINDSURF_LS_BINARY_PATH',
      label: 'Language Server 路径',
      type: 'text',
      placeholder: '/opt/windsurf/language_server_linux_x64'
    },
    {
      id: 'WINDSURF_API_SERVER_URL',
      label: 'API Server URL',
      type: 'text',
      placeholder: 'https://server.self-serve.windsurf.com'
    }
  ],
  'openai-windsurf': [
    {
      id: 'WINDSURF_BASE_URL',
      label: 'WindsurfAPI Base URL',
      type: 'text',
      placeholder: 'http://localhost:3003/v1'
    },
    {
      id: 'WINDSURF_API_KEY',
      label: 'API Key',
      type: 'password',
      placeholder: '若 .env 中 API_KEY 为空则留空'
    }
  ],
  'openai-iflow': [
    {
      id: 'IFLOW_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/openai-iflow/1'
    },
    {
      id: 'IFLOW_BASE_URL',
      label: 'iFlow Base URL',
      type: 'text',
      placeholder: 'https://iflow.cn/api'
    }
  ],
  'openai-droid': [
    {
      id: 'DROID_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/droid-oauth/1'
    },
    {
      id: 'DROID_PROFILE',
      label: 'Droid Profile (JSON)',
      type: 'text',
      placeholder: '粘贴 Droid 配置 JSON (profile)'
    }
  ],
  'openaiResponses-droid': [
    {
      id: 'DROID_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/droid-oauth/1'
    },
    {
      id: 'DROID_PROFILE',
      label: 'Droid Profile (JSON)',
      type: 'text',
      placeholder: '粘贴 Droid 配置 JSON (profile)'
    }
  ],
  'claude-droid': [
    {
      id: 'DROID_OAUTH_CREDS_FILE_PATH',
      label: 'OAuth 凭据引用',
      type: 'text',
      placeholder: 'db://oauth/droid-oauth/1'
    },
    {
      id: 'DROID_PROFILE',
      label: 'Droid Profile (JSON)',
      type: 'text',
      placeholder: '粘贴 Droid 配置 JSON (profile)'
    }
  ]
};

const FIELD_LABELS = {
  customName: '自定义名称',
  checkModelName: '检查模型名称',
  checkHealth: '健康检查',
  upstreamMode: '上游模式',
  OPENAI_API_KEY: 'OpenAI API Key',
  OPENAI_BASE_URL: 'OpenAI Base URL',
  CLAUDE_API_KEY: 'Claude API Key',
  CLAUDE_BASE_URL: 'Claude Base URL',
  foxcodeAuthBaseUrl: 'Foxcode Auth Base URL',
  foxcodeEmail: 'Foxcode 邮箱',
  foxcodePassword: 'Foxcode 密码',
  claudeCustomSystemType: '系统类型',
  newapiUsername: 'NewAPI 用户名',
  newapiPassword: 'NewAPI 密码',
  newapiSystemToken: 'NewAPI 系统访问令牌',
  newapiUserId: 'NewAPI 用户ID',
  officialStickySessionEnabled: '官方粘性会话',
  officialStickySessionTtlMinutes: '粘性会话TTL(分钟)',
  officialSessionBindingStrict: '严格会话绑定',
  officialStickyIdentityMode: '粘性身份模式',
  officialFingerprintIncludeUser: '指纹包含用户',
  officialFingerprintIncludeToken: '指纹包含Token',
  officialFingerprintIncludePath: '指纹包含路径',
  officialQueueLockEnabled: '账号队列锁开关',
  officialQueueLockTtlMs: '队列锁TTL(ms)',
  officialQueueWaitTimeoutMs: '队列等待超时(ms)',
  officialQueuePollIntervalMs: '队列轮询间隔(ms)',
  officialValidationBlockMinutes: '验证封禁隔离(分钟)',
  officialRateLimitCooldownMs: '429限流冷却(ms)',
  officialOverloadCooldownMs: '529过载冷却(ms)',
  officialContextL1Threshold: 'L1压缩阈值(tool截断)',
  officialContextL2Threshold: 'L2压缩阈值(thinking清理)',
  officialContextL3Threshold: 'L3压缩阈值(fork摘要)',
  officialFingerprintSalt: '指纹盐值',
  officialAutoStopOnWarning: '5h警告自动停调度',
  PROJECT_ID: '项目ID',
  GEMINI_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  KIRO_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  QWEN_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  CODEX_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  XAI_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  WINDSURF_API_KEY: 'Windsurf API Key',
  WINDSURF_LS_BINARY_PATH: 'Language Server 路径',
  WINDSURF_API_SERVER_URL: 'API Server URL',
  WINDSURF_BASE_URL: 'WindsurfAPI Base URL',
  IFLOW_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  GEMINI_BASE_URL: 'Gemini Base URL',
  KIRO_BASE_URL: 'Base URL',
  KIRO_REFRESH_URL: 'Refresh URL',
  KIRO_REFRESH_IDC_URL: 'Refresh IDC URL',
  QWEN_BASE_URL: 'Qwen Base URL',
  QWEN_OAUTH_BASE_URL: 'OAuth Base URL',
  CODEX_BASE_URL: 'Codex Base URL',
  XAI_USING_API: '请求路径',
  XAI_BASE_URL: 'xAI API Base URL',
  XAI_CHAT_BASE_URL: 'Grok Chat Base URL',
  ANTIGRAVITY_BASE_URL_DAILY: 'Daily Base URL',
  ANTIGRAVITY_BASE_URL_AUTOPUSH: 'Autopush Base URL',
  IFLOW_BASE_URL: 'iFlow Base URL',
  WARP_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  WARP_BASE_URL: 'Warp Base URL',
  WARP_TOKEN_URL: 'Token URL',
  WARP_API_KEY: 'API Key',
  DROID_OAUTH_CREDS_FILE_PATH: 'OAuth 凭据引用',
  DROID_PROFILE: 'Droid Profile'
};

const BASE_FIELDS = ['customName', 'checkModelName', 'checkHealth'];
const EXCLUDED_FIELDS = [
  'isHealthy',
  'lastUsed',
  'usageCount',
  'errorCount',
  'lastErrorTime',
  'uuid',
  'isDisabled',
  'lastHealthCheckTime',
  'lastHealthCheckModel',
  'lastErrorMessage',
  'notSupportedModels',
  'isDeleted'
];

const FIELD_ORDER_MAP = {
  'openai-custom': ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  'claude-custom': ['CLAUDE_API_KEY', 'CLAUDE_BASE_URL', 'foxcodeAuthBaseUrl', 'foxcodeEmail', 'foxcodePassword', 'claudeCustomSystemType', 'newapiSystemToken', 'newapiUserId', 'newapiUsername', 'newapiPassword', 'upstreamMode'],
  'claude-offical': [
    'CLAUDE_API_KEY',
    'CLAUDE_BASE_URL',
    'officialStickySessionEnabled',
    'officialStickySessionTtlMinutes',
    'officialSessionBindingStrict',
    'officialStickyIdentityMode',
    'officialFingerprintIncludeUser',
    'officialFingerprintIncludeToken',
    'officialFingerprintIncludePath',
    'officialQueueLockEnabled',
    'officialQueueLockTtlMs',
    'officialQueueWaitTimeoutMs',
    'officialQueuePollIntervalMs',
    'officialValidationBlockMinutes',
    'officialRateLimitCooldownMs',
    'officialOverloadCooldownMs',
    'officialContextL1Threshold',
    'officialContextL2Threshold',
    'officialContextL3Threshold',
    'officialFingerprintSalt',
    'officialAutoStopOnWarning'
  ],
  'gemini-cli-oauth': ['PROJECT_ID', 'GEMINI_OAUTH_CREDS_FILE_PATH', 'GEMINI_BASE_URL'],
  'claude-kiro-oauth': ['KIRO_OAUTH_CREDS_FILE_PATH', 'KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL'],
  'claude-ami-oauth': ['AMI_WOS_SESSION'],
  'claude-warp-oauth': ['WARP_OAUTH_CREDS_FILE_PATH', 'WARP_BASE_URL', 'WARP_TOKEN_URL', 'WARP_API_KEY'],
  'openai-codex': ['CODEX_OAUTH_CREDS_FILE_PATH', 'CODEX_BASE_URL'],
  'openai-xai-oauth': ['XAI_OAUTH_CREDS_FILE_PATH', 'XAI_USING_API', 'XAI_BASE_URL', 'XAI_CHAT_BASE_URL'],
  'gemini-antigravity': ['PROJECT_ID', 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', 'ANTIGRAVITY_BASE_URL_DAILY', 'ANTIGRAVITY_BASE_URL_AUTOPUSH'],
  'claude-antigravity': ['REUSE_GEMINI_CREDENTIALS', 'SHARED_CREDENTIALS_ID', 'PROJECT_ID', 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH'],
  'claude-windsurf': ['WINDSURF_API_KEY', 'WINDSURF_LS_BINARY_PATH', 'WINDSURF_API_SERVER_URL'],
  'openai-windsurf': ['WINDSURF_BASE_URL', 'WINDSURF_API_KEY'],
  'openai-droid': ['DROID_OAUTH_CREDS_FILE_PATH', 'DROID_PROFILE'],
  'openaiResponses-droid': ['DROID_OAUTH_CREDS_FILE_PATH', 'DROID_PROFILE'],
  'claude-droid': ['DROID_OAUTH_CREDS_FILE_PATH', 'DROID_PROFILE']
};

const CLAUDE_CUSTOM_UPSTREAM_MODE_OPTIONS = [
  { value: 'direct', label: '直连模式' },
  { value: 'antigravity-channel', label: '上游反代模式' },
];

const CLAUDE_CUSTOM_SYSTEM_TYPE_OPTIONS = [
  { value: 'self-developed', label: '自研系统' },
  { value: 'newapi', label: 'NewAPI 对接' },
];

const CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS = [
  { value: 'session-or-fingerprint', label: 'Session优先, 指纹兜底' },
  { value: 'session', label: '仅 Session' },
  { value: 'fingerprint', label: '仅 指纹' },
];

const DROID_NODE_TYPES = [
  { value: 'openai-droid', label: 'Droid OpenAI' },
  { value: 'openaiResponses-droid', label: 'Droid Responses' },
  { value: 'claude-droid', label: 'Droid Claude' }
];

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
};

const formatUsageValue = (value) => {
  if (value === null || value === undefined) return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (Math.abs(num) >= 1000) {
    return Math.round(num).toLocaleString('zh-CN');
  }
  return num % 1 === 0 ? String(num) : num.toFixed(2);
};

const formatPercent = (value) => {
  if (value === null || value === undefined) return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${num.toFixed(1)}%`;
};

const formatTimeRemaining = (isoTime) => {
  if (!isoTime) return '--';
  const diffMs = new Date(isoTime).getTime() - Date.now();
  if (diffMs <= 0) return '即将恢复';
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
};

const getUsageLevel = (percent, thresholds) => {
  const warn = Number(thresholds?.warn ?? 80);
  const disable = Number(thresholds?.disable ?? 95);
  if (percent >= disable) return 'critical';
  if (percent >= warn) return 'warning';
  return 'normal';
};

const getProviderDisplayName = (type) => PROVIDER_NAME_MAP[type] || type;

const getProviderIcon = (type) => {
  if (type.includes('gemini')) return '/logos/gemini.svg';
  if (type === 'openai-windsurf' || type === 'claude-windsurf') return '/logos/windsurf.svg';
  if (type === 'openai-xai-oauth') return '/logos/xai.svg';
  if (type.includes('claude')) return '/logos/claude.svg';
  if (type.includes('openai') || type.includes('qwen') || type.includes('codex') || type.includes('droid') || type.includes('iflow')) return '/logos/openai.svg';
  return null;
};

const getSummaryStats = (summary, type) => {
  const stats = summary?.[type] || {};
  const healthy = stats.healthy ?? stats.enabled ?? 0;
  const disabled = stats.disabled ?? 0;
  const deleted = stats.deleted ?? 0;
  // 总数 = 健康 + 禁用（不包含已删除）
  const total = healthy + disabled;
  return { total, healthy, disabled, deleted };
};

const getFieldLabel = (key) => FIELD_LABELS[key] || key;

const getProviderFieldOrder = (providerType, provider) => {
  const orderedFields = [...BASE_FIELDS];
  const predefinedOrder = providerType ? (FIELD_ORDER_MAP[providerType] || []) : [];
  const otherFields = Object.keys(provider || {})
    .filter((key) =>
      !EXCLUDED_FIELDS.includes(key) &&
      !orderedFields.includes(key) &&
      !predefinedOrder.includes(key)
    )
    .sort();
  const allExpectedFields = [...orderedFields, ...predefinedOrder, ...otherFields];
  return allExpectedFields.filter((key) => Object.prototype.hasOwnProperty.call(provider, key) || predefinedOrder.includes(key));
};

const normalizeProviderBaseFields = (provider) => {
  return {
    customName: provider.customName || provider.custom_name || '',
    checkModelName: provider.checkModelName || provider.check_model_name || '',
    checkHealth: provider.checkHealth ?? provider.check_health ?? provider.checkHealthEnabled ?? false,
  };
};

const buildDraftConfig = (providerType, provider) => {
  const baseFields = normalizeProviderBaseFields(provider);
  const fieldOrder = getProviderFieldOrder(providerType, provider);
  const notSupported = Array.isArray(provider.notSupportedModels)
    ? provider.notSupportedModels
    : Array.isArray(provider.not_supported_models)
    ? provider.not_supported_models
    : [];
  const draft = {
    ...baseFields,
    notSupportedModels: [...notSupported],
  };
  fieldOrder.forEach((key) => {
    if (BASE_FIELDS.includes(key)) return;
    if (!Object.prototype.hasOwnProperty.call(draft, key)) {
      draft[key] = provider[key] ?? '';
    }
  });
  return draft;
};

const getAuthAction = (providerType) => {
  if (providerType === 'claude-windsurf') {
    return { label: '添加账号', icon: 'fa-wind', variant: 'primary', action: 'windsurf-email-import' };
  }
  if (providerType === 'openai-windsurf') {
    return { label: '添加', icon: 'fa-plus-circle', variant: 'success', action: 'openai-import' };
  }
  if (providerType === 'openai-custom') {
    return { label: '导入', icon: 'fa-plus-circle', variant: 'success', action: 'openai-import' };
  }
  if (providerType === 'claude-custom') {
    return { label: '导入', icon: 'fa-plus-circle', variant: 'success', action: 'claude-import' };
  }
  if (providerType === 'claude-offical') {
    return { label: '接入', icon: 'fa-plug', variant: 'primary', action: 'claude-offical-method' };
  }
  if (providerType === 'claude-orchids-oauth') {
    return { label: '导入', icon: 'fa-cookie-bite', variant: 'warning', action: 'orchids-import' };
  }
  if (providerType === 'claude-warp-oauth') {
    return { label: '导入', icon: 'fa-cloud-upload-alt', variant: 'primary', action: 'warp-import' };
  }
  if (providerType === 'claude-kiro-oauth') {
    return { label: '授权', icon: 'fa-link', variant: 'primary', action: 'kiro-method' };
  }
  if (providerType === 'claude-ami-oauth') {
    return { label: '添加', icon: 'fa-plus', variant: 'primary', action: 'ami-import' };
  }
  if (providerType === 'openai-droid' || providerType === 'openaiResponses-droid' || providerType === 'claude-droid') {
    return { label: '导入', icon: 'fa-upload', variant: 'primary', action: 'droid-method' };
  }
  if (providerType === 'gemini-cli-oauth' || providerType === 'gemini-antigravity' || providerType === 'claude-antigravity') {
    return { label: '授权', icon: 'fa-link', variant: 'primary', action: 'oauth-host' };
  }
  if (providerType === 'openai-codex') {
    return { label: '导入', icon: 'fa-file-import', variant: 'success', action: 'codex-json-import' };
  }
  if (providerType === 'openai-xai-oauth') {
    return { label: '导入', icon: 'fa-file-import', variant: 'success', action: 'xai-import' };
  }

  return null;
};

const getExtraAuthActions = (providerType) => {
  if (providerType === 'openai-codex') {
    return [
      { label: '授权', icon: 'fa-link', variant: 'primary', action: 'oauth-direct' }
    ];
  }
  if (providerType === 'openai-xai-oauth') {
    return [
      { label: '注册', icon: 'fa-user-plus', variant: 'warning', action: 'xai-register' },
      { label: '授权', icon: 'fa-link', variant: 'primary', action: 'oauth-direct' }
    ];
  }
  return [];
};

const isSensitiveKey = (key) => key.toLowerCase().includes('key') || key.toLowerCase().includes('password');
const isOauthPathKey = (key) => key.includes('OAUTH_CREDS_FILE_PATH');

const parseLines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);

const normalizeKiroCredential = (credential) => {
  if (!credential || typeof credential !== 'object') return credential;
  const clientId = credential.clientId || credential.client_id || '';
  const clientSecret = credential.clientSecret || credential.client_secret || '';
  const profileArn = credential.profileArn || credential.profile_arn || '';
  const authMethod = credential.authMethod || credential.auth_method || (profileArn && !(clientId && clientSecret) ? 'social' : '');
  return {
    ...credential,
    clientId,
    clientSecret,
    accessToken: credential.accessToken || credential.access_token || '',
    refreshToken: credential.refreshToken || credential.refresh_token || '',
    profileArn,
    expiresAt: credential.expiresAt || credential.expires_at || '',
    authMethod,
    provider: credential.provider || credential.socialProvider || credential.provider_id || (authMethod === 'social' ? 'Google' : ''),
    region: credential.region || credential.awsRegion || 'us-east-1',
  };
};

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeKiroTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return value;
  const numericValue = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d{12,}$/.test(value.trim()) ? Number(value.trim()) : null);
  if (Number.isFinite(numericValue)) {
    const date = new Date(numericValue);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return value;
};

const normalizeKiroAccountManagerAccount = (account, exportPayload = {}) => {
  if (!isPlainObject(account)) return null;

  const sourceCredentials = isPlainObject(account.credentials) ? account.credentials : {};
  const clientId = sourceCredentials.clientId || sourceCredentials.client_id || account.clientId || account.client_id || '';
  const clientSecret = sourceCredentials.clientSecret || sourceCredentials.client_secret || account.clientSecret || account.client_secret || '';
  const profileArn = sourceCredentials.profileArn || sourceCredentials.profile_arn || account.profileArn || account.profile_arn || '';
  const provider = sourceCredentials.provider || sourceCredentials.socialProvider || sourceCredentials.provider_id || account.provider || account.idp || '';
  const authMethod = sourceCredentials.authMethod || sourceCredentials.auth_method || account.authMethod || account.auth_method ||
    (provider && !(clientId && clientSecret) ? 'social' : '');

  return normalizeKiroCredential({
    ...sourceCredentials,
    clientId,
    clientSecret,
    accessToken: sourceCredentials.accessToken || sourceCredentials.access_token || account.accessToken || account.access_token || '',
    refreshToken: sourceCredentials.refreshToken || sourceCredentials.refresh_token || account.refreshToken || account.refresh_token || '',
    profileArn,
    expiresAt: normalizeKiroTimestamp(sourceCredentials.expiresAt || sourceCredentials.expires_at || account.expiresAt || account.expires_at || ''),
    authMethod,
    provider: provider || (authMethod === 'social' ? 'Google' : ''),
    region: sourceCredentials.region || sourceCredentials.awsRegion || account.region || account.awsRegion || 'us-east-1',
    email: sourceCredentials.email || account.email || '',
    userId: sourceCredentials.userId || sourceCredentials.user_id || account.userId || account.user_id || '',
    nickname: sourceCredentials.nickname || account.nickname || '',
    idp: sourceCredentials.idp || account.idp || '',
    accountId: sourceCredentials.accountId || sourceCredentials.account_id || account.accountId || account.account_id || account.id || '',
    machineId: sourceCredentials.machineId || sourceCredentials.machine_id || account.machineId || account.machine_id || '',
    subscription: sourceCredentials.subscription || account.subscription,
    usage: sourceCredentials.usage || account.usage,
    status: sourceCredentials.status || account.status || '',
    sourceFormat: sourceCredentials.sourceFormat || 'kiro-account-manager',
    exportedAt: normalizeKiroTimestamp(sourceCredentials.exportedAt || exportPayload.exportedAt || ''),
    kiroAccountManagerVersion: sourceCredentials.kiroAccountManagerVersion || exportPayload.version || '',
  });
};

const isKiroAccountManagerAccount = (value) => {
  if (!isPlainObject(value) || !isPlainObject(value.credentials)) return false;
  const credentials = value.credentials;
  return Boolean(
    credentials.refreshToken ||
    credentials.refresh_token ||
    credentials.accessToken ||
    credentials.access_token ||
    value.email ||
    value.userId ||
    value.idp
  );
};

const extractKiroJsonCredentials = (payload, exportPayload = payload) => {
  if (Array.isArray(payload)) {
    return payload.flatMap(item => extractKiroJsonCredentials(item, exportPayload));
  }
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload.accounts)) {
    return payload.accounts
      .map(account => normalizeKiroAccountManagerAccount(account, payload))
      .filter(Boolean);
  }
  if (isKiroAccountManagerAccount(payload)) {
    return [normalizeKiroAccountManagerAccount(payload, exportPayload)].filter(Boolean);
  }
  return [normalizeKiroCredential(payload)];
};

const hasKiroFullCredential = (credential) => {
  const normalized = normalizeKiroCredential(credential);
  return Boolean(normalized?.clientId && normalized?.clientSecret && normalized?.accessToken && normalized?.refreshToken);
};

const parseBooleanLike = (value, defaultValue = null) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return defaultValue;
};

const getOfficialQueueLockSummary = (providersByType = {}, providerType) => {
  if (providerType !== 'claude-offical') return null;
  const providers = Array.isArray(providersByType?.[providerType])
    ? providersByType[providerType]
    : [];
  const activeProviders = providers.filter((item) => !(item?.isDeleted ?? item?.is_deleted));
  if (activeProviders.length === 0) {
    return { label: '-', className: 'stat-value stat-usage-empty' };
  }

  const enabledCount = activeProviders.filter((item) => {
    const value = item?.officialQueueLockEnabled ?? item?.CLAUDE_OFFICIAL_QUEUE_LOCK_ENABLED;
    return parseBooleanLike(value, true) === true;
  }).length;

  if (enabledCount === 0) {
    return { label: '关', className: 'stat-value stat-deleted' };
  }
  if (enabledCount === activeProviders.length) {
    return { label: '开', className: 'stat-value stat-healthy' };
  }
  return { label: `${enabledCount}/${activeProviders.length}`, className: 'stat-value stat-usage-warning' };
};

const streamBatchImport = async ({ endpoint, payload, onStart, onProgress, onComplete, onError }) => {
  try {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || '请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEventBlock = (block) => {
      if (!block.trim()) return;
      const lines = block.split('\n');
      let event = 'message';
      const dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith('event:')) {
          event = line.replace('event:', '').trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.replace('data:', '').trim());
        }
      });
      const dataString = dataLines.join('\n');
      let data = null;
      if (dataString) {
        try {
          data = JSON.parse(dataString);
        } catch (error) {
          data = { raw: dataString };
        }
      }

      if (event === 'start' && onStart) onStart(data);
      if (event === 'progress' && onProgress) onProgress(data);
      if (event === 'complete' && onComplete) onComplete(data);
      if (event === 'error' && onError) onError(data);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      parts.forEach(handleEventBlock);
    }
    if (buffer.trim()) {
      handleEventBlock(buffer);
    }
  } catch (error) {
    if (onError) {
      onError({ error: error.message || '批量导入失败' });
    }
  }
};

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

function BatchOperationModal({ open, providerType, providerTypeKey, onClose, onExecute, onBatchCodexAuth }) {
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
            {providerTypeKey === 'openai-codex' && (
              <button
                className="btn btn-secondary btn-lg"
                onClick={() => handleExecute('extract-emails')}
                style={{ width: '100%', marginBottom: '10px' }}
              >
                <i className="fas fa-envelope"></i> 获取邮箱
              </button>
            )}
            {providerTypeKey === 'openai-codex' && onBatchCodexAuth && (
              <button
                className="btn btn-warning btn-lg"
                onClick={() => { onClose(); onBatchCodexAuth(); }}
                style={{ width: '100%' }}
              >
                <i className="fas fa-bolt"></i> Free 批量授权
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

function CodexBatchAuthModal({ open, authUrl, onClose, onStop }) {
  const [successCount, setSuccessCount] = useState(0);
  const [successEmails, setSuccessEmails] = useState([]);
  const [currentAuthUrl, setCurrentAuthUrl] = useState(authUrl);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setCurrentAuthUrl(authUrl);
    setSuccessCount(0);
    setSuccessEmails([]);
    setNotice('');
  }, [open, authUrl]);

  // SSE 监听批量授权事件
  useEffect(() => {
    if (!open) return;
    const token = localStorage.getItem('token');
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const streamUrl = `${window.location.origin}/api/logs/stream${query}`;
    const eventSource = new EventSource(streamUrl);

    const handleSuccess = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.provider === 'openai-codex' && data.batchMode) {
          const email = data.email || '';
          setSuccessCount(data.batchCount || ((prev) => prev + 1));
          if (email) setSuccessEmails((prev) => [...prev, email]);
          setNotice(`授权成功${email ? ` (${email})` : ''}，等待下一个...`);
        }
      } catch (e) { /* ignore */ }
    };

    const handleNextUrl = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.authUrl) setCurrentAuthUrl(data.authUrl);
      } catch (e) { /* ignore */ }
    };

    eventSource.addEventListener('oauth_success', handleSuccess);
    eventSource.addEventListener('codex_batch_next_url', handleNextUrl);

    return () => {
      eventSource.removeEventListener('oauth_success', handleSuccess);
      eventSource.removeEventListener('codex_batch_next_url', handleNextUrl);
      eventSource.close();
    };
  }, [open]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentAuthUrl || '');
      setNotice('链接已复制');
    } catch (e) { setNotice('复制失败'); }
  };

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      onClose={() => { onStop(); onClose(); }}
      title="Free 批量授权模式"
      subtitle="OpenAI Codex OAuth — 回调服务器持续运行"
      size="lg"
      footer={
        <>
          <button className="btn btn-danger" onClick={() => { onStop(); onClose(); }}>
            <i className="fas fa-stop"></i> 停止批量授权
          </button>
        </>
      }
    >
      {notice && <div className="notice-banner notice-success">{notice}</div>}

      <div className="auth-continuous-bar">
        <span className="auth-success-count" style={{ fontSize: '1.1em' }}>
          <i className="fas fa-check-circle"></i> 已成功授权 {successCount} 个
        </span>
        <span className="auth-helper">
          注册机注册完成后会自动调用授权，无需手动操作
        </span>
      </div>

      {successEmails.length > 0 && (
        <div className="auth-success-list">
          {successEmails.map((email, i) => (
            <span key={i} className="auth-success-tag">
              <i className="fas fa-user-check"></i> {email}
            </span>
          ))}
        </div>
      )}

      <div className="auth-info-grid">
        <div className="auth-card">
          <h4><i className="fas fa-list-ol"></i> 使用说明</h4>
          <ol>
            <li>保持此窗口打开，回调服务器持续运行在 1455 端口</li>
            <li>在注册机中配置 AccountHub 地址并启用 Codex 授权</li>
            <li>注册机注册完 Free 账号后会自动完成 OAuth 授权</li>
            <li>授权成功的账号会自动出现在提供商列表中</li>
          </ol>
        </div>
        <div className="auth-card">
          <h4><i className="fas fa-link"></i> 当前授权链接</h4>
          <p style={{ fontSize: '0.85em', color: '#888' }}>
            注册机会自动生成新链接，此链接仅供手动测试
          </p>
          <div className="auth-url-row">
            <input type="text" value={currentAuthUrl || '等待生成...'} readOnly />
            <button className="btn btn-outline" onClick={handleCopy}>
              <i className="fas fa-copy"></i> 复制
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function NoticeBanner({ type, message }) {
  if (!message) return null;
  return <div className={`notice-banner notice-${type}`}>{message}</div>;
}

function Pagination({ page, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;
  const pages = [];
  const maxButtons = 7;
  let start = Math.max(1, page - 3);
  let end = Math.min(totalPages, start + maxButtons - 1);
  if (end - start < maxButtons - 1) {
    start = Math.max(1, end - maxButtons + 1);
  }
  for (let i = start; i <= end; i += 1) {
    pages.push(i);
  }

  return (
    <div className="pagination">
      <div className="pagination-info">
        显示 {start}-{end} / 共 {totalPages} 页
      </div>
      <div className="pagination-controls">
        <button className="page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <i className="fas fa-chevron-left"></i>
        </button>
        {start > 1 && (
          <>
            <button className="page-btn" onClick={() => onPageChange(1)}>1</button>
            {start > 2 && <span className="page-ellipsis">...</span>}
          </>
        )}
        {pages.map((p) => (
          <button
            key={p}
            className={`page-btn ${p === page ? 'active' : ''}`}
            onClick={() => onPageChange(p)}
          >
            {p}
          </button>
        ))}
        {end < totalPages && (
          <>
            {end < totalPages - 1 && <span className="page-ellipsis">...</span>}
            <button className="page-btn" onClick={() => onPageChange(totalPages)}>{totalPages}</button>
          </>
        )}
        <button className="page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          <i className="fas fa-chevron-right"></i>
        </button>
      </div>
    </div>
  );
}

function ApiKeyImportModal({
  open,
  providerType,
  title,
  apiLabel,
  configKey,
  baseUrlKey,
  baseUrlDefault,
  baseUrlLabel = 'Base URL',
  poolOptions = [],
  defaultPoolId,
  onClose,
  onSuccess,
}) {
  const [mode, setMode] = useState('single');
  const [customName, setCustomName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(baseUrlDefault);
  const [batchText, setBatchText] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [upstreamMode, setUpstreamMode] = useState('direct');
  const [claudeCustomSystemType, setClaudeCustomSystemType] = useState('self-developed');
  const [newapiSystemToken, setNewapiSystemToken] = useState('');
  const [newapiUserId, setNewapiUserId] = useState('');
  const [newapiUsername, setNewapiUsername] = useState('');
  const [newapiPassword, setNewapiPassword] = useState('');
  const [officialStickySessionEnabled, setOfficialStickySessionEnabled] = useState(true);
  const [officialStickySessionTtlMinutes, setOfficialStickySessionTtlMinutes] = useState(60);
  const [officialSessionBindingStrict, setOfficialSessionBindingStrict] = useState(false);
  const [officialStickyIdentityMode, setOfficialStickyIdentityMode] = useState('session-or-fingerprint');
  const [officialFingerprintIncludeUser, setOfficialFingerprintIncludeUser] = useState(true);
  const [officialFingerprintIncludeToken, setOfficialFingerprintIncludeToken] = useState(true);
  const [officialFingerprintIncludePath, setOfficialFingerprintIncludePath] = useState(false);
  const [officialQueueLockEnabled, setOfficialQueueLockEnabled] = useState(true);
  const [officialQueueLockTtlMs, setOfficialQueueLockTtlMs] = useState(120000);
  const [officialQueueWaitTimeoutMs, setOfficialQueueWaitTimeoutMs] = useState(30000);
  const [officialQueuePollIntervalMs, setOfficialQueuePollIntervalMs] = useState(150);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setCustomName('');
    setApiKey('');
    setBaseUrl(baseUrlDefault);
    setBatchText('');
    setSelectedPoolId(defaultPoolId !== undefined && defaultPoolId !== null ? String(defaultPoolId) : '');
    setUpstreamMode('direct');
    setClaudeCustomSystemType('self-developed');
    setNewapiSystemToken('');
    setNewapiUserId('');
    setNewapiUsername('');
    setNewapiPassword('');
    setOfficialStickySessionEnabled(true);
    setOfficialStickySessionTtlMinutes(60);
    setOfficialSessionBindingStrict(false);
    setOfficialStickyIdentityMode('session-or-fingerprint');
    setOfficialFingerprintIncludeUser(true);
    setOfficialFingerprintIncludeToken(true);
    setOfficialFingerprintIncludePath(false);
    setOfficialQueueLockEnabled(true);
    setOfficialQueueLockTtlMs(120000);
    setOfficialQueueWaitTimeoutMs(30000);
    setOfficialQueuePollIntervalMs(150);
    setResult(null);
    setError('');
  }, [open, baseUrlDefault, defaultPoolId]);

  useEffect(() => {
    if (!open) return;
    if (selectedPoolId) return;
    if (!Array.isArray(poolOptions) || poolOptions.length === 0) return;
    const defaultPool = poolOptions.find((pool) => pool.isDefault) || poolOptions[0];
    setSelectedPoolId(defaultPool?.id !== undefined && defaultPool?.id !== null ? String(defaultPool.id) : '');
  }, [open, poolOptions, selectedPoolId]);

  const normalizedPoolId = selectedPoolId === '' ? undefined : Number.parseInt(selectedPoolId, 10);
  const isClaudeCustom = providerType === 'claude-custom';
  const isClaudeOffical = providerType === 'claude-offical';
  const isNewApiType = isClaudeCustom && claudeCustomSystemType === 'newapi';

  const buildClaudeCustomExtras = (overrideUsername, overridePassword, overrideSystemToken, overrideUserId) => {
    if (!isClaudeCustom) return {};
    const extras = {
      upstreamMode,
      claudeCustomSystemType,
    };

    if (isNewApiType) {
      extras.newapiSystemToken = (overrideSystemToken ?? newapiSystemToken).trim();
      extras.newapiUserId = (overrideUserId ?? newapiUserId).trim();
      extras.newapiUsername = (overrideUsername ?? newapiUsername).trim();
      extras.newapiPassword = (overridePassword ?? newapiPassword).trim();
    }

    return extras;
  };

  const buildClaudeOfficalExtras = () => {
    if (!isClaudeOffical) return {};
    return {
      officialStickySessionEnabled,
      officialStickySessionTtlMinutes: Number(officialStickySessionTtlMinutes || 60),
      officialSessionBindingStrict,
      officialStickyIdentityMode,
      officialFingerprintIncludeUser,
      officialFingerprintIncludeToken,
      officialFingerprintIncludePath,
      officialQueueLockEnabled,
      officialQueueLockTtlMs: Number(officialQueueLockTtlMs || 120000),
      officialQueueWaitTimeoutMs: Number(officialQueueWaitTimeoutMs || 30000),
      officialQueuePollIntervalMs: Number(officialQueuePollIntervalMs || 150),
    };
  };

  const handleSingleImport = async () => {
    if (!customName.trim()) {
      setError('请输入节点名称');
      return;
    }
    if (!apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await providerService.add({
        providerType,
        poolId: Number.isFinite(normalizedPoolId) ? normalizedPoolId : undefined,
        providerConfig: {
          customName: customName.trim(),
          [configKey]: apiKey.trim(),
          [baseUrlKey]: baseUrl.trim() || baseUrlDefault,
          ...buildClaudeCustomExtras(),
          ...buildClaudeOfficalExtras(),
        },
      });
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      setResult({ success: 1, failed: 0, errors: [] });
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImport = async () => {
    const lines = parseLines(batchText);
    if (!lines.length) {
      setError('请输入至少一条数据');
      return;
    }
    const entries = lines
      .map((line) => line.split('|').map((part) => part.trim()))
      .filter((parts) => parts.length >= 2)
      .map((parts) => ({
        customName: parts[0],
        apiKey: parts[1],
        baseUrl: parts[2] || baseUrlDefault,
        username: parts[3] || '',
        password: parts[4] || '',
        systemToken: parts[5] || '',
        userId: parts[6] || '',
      }));

    if (!entries.length) {
      setError('没有可导入的数据');
      return;
    }

    setLoading(true);
    setError('');
    let success = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      try {
        const response = await providerService.add({
          providerType,
          poolId: Number.isFinite(normalizedPoolId) ? normalizedPoolId : undefined,
          providerConfig: {
            customName: entry.customName,
            [configKey]: entry.apiKey,
            [baseUrlKey]: entry.baseUrl,
            ...buildClaudeCustomExtras(entry.username, entry.password, entry.systemToken, entry.userId),
            ...buildClaudeOfficalExtras(),
          },
        });
        if (response?.success === false) {
          failed += 1;
          errors.push(`${entry.customName}: ${response?.error || '导入失败'}`);
        } else {
          success += 1;
        }
      } catch (importError) {
        failed += 1;
        errors.push(`${entry.customName}: ${importError.message || '导入失败'}`);
      }
    }

    setResult({ success, failed, errors });
    setLoading(false);
    onSuccess?.();
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      subtitle="支持单个导入或批量导入，导入后自动写入账号池"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          {mode === 'single' ? (
            <button className="btn btn-primary" onClick={handleSingleImport} disabled={loading}>
              {loading ? '导入中...' : '确认导入'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleBatchImport} disabled={loading}>
              {loading ? '导入中...' : '开始批量导入'}
            </button>
          )}
        </>
      }
    >
      <div className="modal-tabs">
        <button className={`tab-btn ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
          单个导入
        </button>
        <button className={`tab-btn ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
          批量导入
        </button>
      </div>

      <NoticeBanner type="error" message={error} />
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
          {result.errors.length > 0 && (
            <div className="notice-detail">
              {result.errors.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {Array.isArray(poolOptions) && poolOptions.length > 0 && (
        <div className="modal-form">
          <label>
            目标号池
            <select value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)}>
              {poolOptions.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}{pool.isDefault ? ' (默认)' : ''}
                </option>
              ))}
            </select>
            <span className="helper-text">导入账号将写入选中的号池</span>
          </label>
        </div>
      )}

      {providerType === 'claude-custom' && (
        <div className="modal-form">
          <label>
            上游模式
            <select value={upstreamMode} onChange={(event) => setUpstreamMode(event.target.value)}>
              {CLAUDE_CUSTOM_UPSTREAM_MODE_OPTIONS.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
            <span className="helper-text">直连模式适用于直接转发到上游 Claude 中转接口</span>
          </label>
          <label>
            系统类型
            <select value={claudeCustomSystemType} onChange={(event) => setClaudeCustomSystemType(event.target.value)}>
              {CLAUDE_CUSTOM_SYSTEM_TYPE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <span className="helper-text">选择 NewAPI 后可使用系统访问令牌，或账号密码自动登录刷新用量</span>
          </label>
          {isNewApiType && (
            <>
              <label>
                NewAPI 系统访问令牌
                <input
                  type="password"
                  value={newapiSystemToken}
                  onChange={(event) => setNewapiSystemToken(event.target.value)}
                  placeholder="可选；用于 API 身份认证，优先于账号密码"
                  autoComplete="new-password"
                />
              </label>
              <label>
                NewAPI 用户ID
                <input
                  type="text"
                  value={newapiUserId}
                  onChange={(event) => setNewapiUserId(event.target.value)}
                  placeholder="可选；如 621 或 github_621"
                />
              </label>
              <label>
                NewAPI 用户名
                <input
                  type="text"
                  value={newapiUsername}
                  onChange={(event) => setNewapiUsername(event.target.value)}
                  placeholder="可选；批量模式可在每行单独填写"
                />
              </label>
              <label>
                NewAPI 密码
                <input
                  type="password"
                  value={newapiPassword}
                  onChange={(event) => setNewapiPassword(event.target.value)}
                  placeholder="可选；批量模式可在每行单独填写"
                  autoComplete="new-password"
                />
              </label>
            </>
          )}
        </div>
      )}

      {providerType === 'claude-offical' && (
        <div className="modal-form">
          <label>
            粘性会话
            <select value={String(officialStickySessionEnabled)} onChange={(event) => setOfficialStickySessionEnabled(event.target.value === 'true')}>
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </label>
          <label>
            粘性会话 TTL(分钟)
            <input
              type="number"
              min="1"
              value={officialStickySessionTtlMinutes}
              onChange={(event) => setOfficialStickySessionTtlMinutes(Number(event.target.value || 60))}
            />
          </label>
          <label>
            严格绑定
            <select value={String(officialSessionBindingStrict)} onChange={(event) => setOfficialSessionBindingStrict(event.target.value === 'true')}>
              <option value="false">禁用</option>
              <option value="true">启用</option>
            </select>
          </label>
          <label>
            粘性身份模式
            <select value={officialStickyIdentityMode} onChange={(event) => setOfficialStickyIdentityMode(event.target.value)}>
              {CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            指纹包含用户
            <select value={String(officialFingerprintIncludeUser)} onChange={(event) => setOfficialFingerprintIncludeUser(event.target.value === 'true')}>
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </label>
          <label>
            指纹包含Token
            <select value={String(officialFingerprintIncludeToken)} onChange={(event) => setOfficialFingerprintIncludeToken(event.target.value === 'true')}>
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </label>
          <label>
            指纹包含路径
            <select value={String(officialFingerprintIncludePath)} onChange={(event) => setOfficialFingerprintIncludePath(event.target.value === 'true')}>
              <option value="false">禁用</option>
              <option value="true">启用</option>
            </select>
          </label>
          <label>
            账号队列锁
            <select value={String(officialQueueLockEnabled)} onChange={(event) => setOfficialQueueLockEnabled(event.target.value === 'true')}>
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
            <span className="helper-text">建议启用，减少同账号并发风控</span>
          </label>
          <label>
            队列锁 TTL(ms)
            <input
              type="number"
              min="1000"
              value={officialQueueLockTtlMs}
              onChange={(event) => setOfficialQueueLockTtlMs(Number(event.target.value || 120000))}
            />
          </label>
          <label>
            队列等待超时(ms)
            <input
              type="number"
              min="1000"
              value={officialQueueWaitTimeoutMs}
              onChange={(event) => setOfficialQueueWaitTimeoutMs(Number(event.target.value || 30000))}
            />
          </label>
          <label>
            队列轮询间隔(ms)
            <input
              type="number"
              min="20"
              value={officialQueuePollIntervalMs}
              onChange={(event) => setOfficialQueuePollIntervalMs(Number(event.target.value || 150))}
            />
          </label>
        </div>
      )}

      {mode === 'single' ? (
        <div className="modal-form">
          <label>
            节点名称
            <input
              type="text"
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder="例如：我的节点1"
            />
          </label>
          <label>
            {apiLabel}
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="必填"
            />
          </label>
          <label>
            {baseUrlLabel}
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={baseUrlDefault}
            />
          </label>
        </div>
      ) : (
        <div className="modal-form">
          <div className="helper-text">
            每行格式：节点名称|API Key|Base URL（Base URL 可省略）
            {isNewApiType ? '；NewAPI 可追加 |用户名|密码|系统访问令牌|用户ID' : ''}
          </div>
          <textarea
            rows={10}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder={isNewApiType
              ? `节点A|sk-xxx|${baseUrlDefault}|username|password|d2PpCApi...|621`
              : `节点A|sk-xxx|${baseUrlDefault}`}
          />
        </div>
      )}
    </ModalShell>
  );
}

function WindsurfEmailImportModal({ open, onClose, onSuccess, defaultPoolId, poolOptions = [] }) {
  const [mode, setMode] = useState('single');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lsBinaryPath, setLsBinaryPath] = useState('/opt/windsurf/language_server_linux_x64');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [batchText, setBatchText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setPassword('');
    setLsBinaryPath('/opt/windsurf/language_server_linux_x64');
    setBatchText('');
    setResult(null);
    setError('');
    setSelectedPoolId(defaultPoolId !== undefined && defaultPoolId !== null ? String(defaultPoolId) : '');
  }, [open, defaultPoolId]);

  const normalizedPoolId = selectedPoolId === '' ? undefined : Number.parseInt(selectedPoolId, 10);

  const handleSingleImport = async () => {
    if (!email.trim()) { setError('请输入邮箱'); return; }
    if (!password.trim()) { setError('请输入密码'); return; }
    setLoading(true);
    setError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch('/api/windsurf/email-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
          lsBinaryPath: lsBinaryPath.trim() || '/opt/windsurf/language_server_linux_x64',
          poolId: Number.isFinite(normalizedPoolId) ? normalizedPoolId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
      if (!res.ok || !data.success) {
        const msg = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null) || '导入失败';
        throw new Error(msg);
      }
      setResult({ success: 1, failed: 0 });
      onSuccess?.();
    } catch (err) {
      setError(typeof err === 'string' ? err : (err?.message || String(err) || '导入失败'));
    } finally {
      setLoading(false);
    }
  };

  const parseBatchText = (text) => {
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const entries = [];
    let i = 0;
    const lines = normalised.split('\n').map(l => l.trim()).filter(Boolean);
    while (i < lines.length) {
      const line = lines[i];
      const zhSingleLine = line.match(/邮箱[：:]\s*([^\s]+)[\s\S]*?密码[：:]\s*([^\s]+)/);
      if (zhSingleLine) {
        entries.push({ email: zhSingleLine[1].trim(), password: zhSingleLine[2].trim(), name: '' });
        i++; continue;
      }
      const zhEmailOnly = line.match(/^邮箱[：:]\s*([^\s]+)/);
      if (zhEmailOnly && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const zhPassLine = nextLine.match(/^密码[：:]\s*([^\s]+)/);
        if (zhPassLine) {
          entries.push({ email: zhEmailOnly[1].trim(), password: zhPassLine[1].trim(), name: '' });
          i += 2; continue;
        }
      }
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        entries.push({ email: parts[0], password: parts[1], name: parts[2] || '' });
        i++; continue;
      }
      i++;
    }
    return entries;
  };

  const handleBatchImport = async () => {
    const entries = parseBatchText(batchText);
    if (!entries.length) { setError('未解析到有效账号，支持格式：邮箱|密码 或 邮箱：xxx 密码：xxx'); return; }
    setLoading(true);
    setError('');
    let success = 0;
    let failed = 0;
    const errors = [];
    const token = localStorage.getItem('token');
    for (const { email: lineEmail, password: linePassword, name: lineName } of entries) {
      if (!lineEmail || !linePassword) { failed++; errors.push(`无效行: ${lineEmail}`); continue; }
      try {
        const res = await fetch('/api/windsurf/email-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            email: lineEmail,
            password: linePassword,
            customName: lineName || lineEmail,
            lsBinaryPath: lsBinaryPath.trim() || '/opt/windsurf/language_server_linux_x64',
            poolId: Number.isFinite(normalizedPoolId) ? normalizedPoolId : undefined,
          }),
        });
        const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        if (!res.ok || !data.success) {
          const msg = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null) || '导入失败';
          throw new Error(msg);
        }
        success++;
      } catch (err) {
        failed++;
        errors.push(`${lineEmail}: ${err.message}`);
      }
    }
    setResult({ success, failed, errors });
    if (success > 0) onSuccess?.();
    setLoading(false);
  };

  return (
    <ModalShell
      open={open}
      title="添加 Windsurf 账号（邮箱登录）"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>取消</button>
          {mode === 'single' ? (
            <button className="btn btn-primary" onClick={handleSingleImport} disabled={loading}>
              {loading ? '登录中...' : '登录并添加'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleBatchImport} disabled={loading}>
              {loading ? '批量导入中...' : '开始批量导入'}
            </button>
          )}
        </>
      }
    >
      <div className="modal-tabs">
        <button className={`tab-btn ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>单账号</button>
        <button className={`tab-btn ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>批量导入</button>
      </div>
      <NoticeBanner type="error" message={error} />
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
          {result.errors?.length > 0 && <div className="notice-detail">{result.errors.map(e => <span key={e}>{e}</span>)}</div>}
        </div>
      )}
      {Array.isArray(poolOptions) && poolOptions.length > 0 && (
        <div className="modal-form">
          <label>目标号池
            <select value={selectedPoolId} onChange={e => setSelectedPoolId(e.target.value)}>
              {poolOptions.map(pool => (
                <option key={pool.id} value={pool.id}>{pool.name}{pool.isDefault ? ' (默认)' : ''}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {mode === 'single' ? (
        <div className="modal-form">
          <label>邮箱
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" autoComplete="username" />
          </label>
          <label>密码
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Windsurf 账号密码" autoComplete="current-password" />
          </label>
          <label>Language Server 路径
            <input type="text" value={lsBinaryPath} onChange={e => setLsBinaryPath(e.target.value)} placeholder="/opt/windsurf/language_server_linux_x64" />
            <span className="helper-text">Windsurf 桌面应用内置，或从 Docker 镜像提取</span>
          </label>
        </div>
      ) : (
        <div className="modal-form">
          <label>Language Server 路径
            <input type="text" value={lsBinaryPath} onChange={e => setLsBinaryPath(e.target.value)} placeholder="/opt/windsurf/language_server_linux_x64" />
          </label>
          <label>批量账号（支持两种格式，可混用）
            <textarea
              value={batchText}
              onChange={e => setBatchText(e.target.value)}
              rows={10}
              placeholder={'格式1（竖线分隔）：\nexample1@gmail.com|password123\nexample2@gmail.com|pass456|备注名\n\n格式2（中文标注）：\n邮箱：example@gmail.com 密码：mypassword\n邮箱：foo@gmail.com 密码：bar123'}
            />
          </label>
        </div>
      )}
    </ModalShell>
  );
}

function WarpImportModal({ open, onClose, onSuccess }) {
  const [mode, setMode] = useState('single');
  const [singleToken, setSingleToken] = useState('');
  const [batchText, setBatchText] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setSingleToken('');
    setBatchText('');
    setProgress(null);
    setResult(null);
    setError('');
    setLoading(false);
  }, [open]);

  const handleSingleImport = async () => {
    if (!singleToken.trim()) {
      setError('请输入 refreshToken');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await providerService.importWarpToken(singleToken.trim());
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      setResult({ success: 1, failed: 0, errors: [] });
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImport = async () => {
    const tokens = parseLines(batchText);
    if (!tokens.length) {
      setError('请输入 refreshToken');
      return;
    }
    setLoading(true);
    setError('');
    setProgress({ current: 0, total: tokens.length, success: 0, failed: 0 });
    setResult(null);

    await streamBatchImport({
      endpoint: '/warp/batch-import-tokens',
      payload: { refreshTokens: tokens },
      onStart: (data) => {
        setProgress({ current: 0, total: data?.total || tokens.length, success: 0, failed: 0 });
      },
      onProgress: (data) => {
        setProgress({
          current: data?.index || 0,
          total: data?.total || tokens.length,
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
      },
      onComplete: (data) => {
        setResult({
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
          errors: (data?.details || [])
            .filter((item) => !item.success)
            .map((item) => item.error || '导入失败'),
        });
        setLoading(false);
        onSuccess?.();
      },
      onError: (data) => {
        setError(data?.error || '批量导入失败');
        setLoading(false);
      },
    });
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Warp Token 导入"
      subtitle="支持单个 refreshToken 或批量导入"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          {mode === 'single' ? (
            <button className="btn btn-primary" onClick={handleSingleImport} disabled={loading}>
              {loading ? '导入中...' : '确认导入'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleBatchImport} disabled={loading}>
              {loading ? '导入中...' : '开始批量导入'}
            </button>
          )}
        </>
      }
    >
      <div className="modal-tabs">
        <button className={`tab-btn ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
          单个导入
        </button>
        <button className={`tab-btn ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
          批量导入
        </button>
      </div>

      <NoticeBanner type="error" message={error} />
      {progress && (
        <div className="progress-card">
          <div className="progress-meta">
            <span>进度：{progress.current}/{progress.total}</span>
            <span>成功 {progress.success} / 失败 {progress.failed}</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-inner"
              style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      )}
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
        </div>
      )}

      {mode === 'single' ? (
        <div className="modal-form">
          <label>
            refreshToken
            <textarea
              rows={4}
              value={singleToken}
              onChange={(event) => setSingleToken(event.target.value)}
              placeholder="粘贴 refreshToken"
            />
          </label>
        </div>
      ) : (
        <div className="modal-form">
          <div className="helper-text">每行一个 refreshToken</div>
          <textarea
            rows={10}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder="token1\n token2"
          />
        </div>
      )}
    </ModalShell>
  );
}

function OrchidsImportModal({ open, onClose, onSuccess }) {
  const [mode, setMode] = useState('password');
  const [cookieString, setCookieString] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode('password');
    setCookieString('');
    setToken('');
    setEmail('');
    setPassword('');
    setError('');
    setResult(null);
    setLoading(false);
  }, [open]);

  const handleImport = async () => {
    let payload;
    if (mode === 'password') {
      if (!email.trim() || !password.trim()) {
        setError('请输入邮箱和密码');
        return;
      }
      payload = { email: email.trim(), password: password.trim() };
    } else if (mode === 'cookie') {
      if (!cookieString.trim()) {
        setError('请输入 Cookie 字符串');
        return;
      }
      payload = { cookieString: cookieString.trim() };
    } else {
      if (!token.trim()) {
        setError('请输入 Token');
        return;
      }
      payload = { token: token.trim() };
    }

    setLoading(true);
    setError('');
    try {
      const response = await providerService.importOrchidsToken(payload);
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      setResult(response);
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Orchids 账号导入"
      subtitle="支持账号密码登录、Cookie 字符串或 Token 格式"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? (mode === 'password' ? '登录中...' : '导入中...') : (mode === 'password' ? '登录并导入' : '确认导入')}
          </button>
        </>
      }
    >
      <div className="modal-tabs">
        <button className={`tab-btn ${mode === 'password' ? 'active' : ''}`} onClick={() => setMode('password')}>
          账号密码
        </button>
        <button className={`tab-btn ${mode === 'cookie' ? 'active' : ''}`} onClick={() => setMode('cookie')}>
          Cookie 字符串
        </button>
        <button className={`tab-btn ${mode === 'token' ? 'active' : ''}`} onClick={() => setMode('token')}>
          Token
        </button>
      </div>

      <NoticeBanner type="error" message={error} />
      {result && (
        <div className="notice-banner notice-success">
          导入成功{result.email ? ` — ${result.email}` : ''}
          {result.verified ? ' (已验证)' : ''}
        </div>
      )}

      {mode === 'password' ? (
        <div className="modal-form">
          <div className="helper-text">
            输入 Orchids 账号的邮箱和密码，自动登录并获取凭据
          </div>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="邮箱"
            className="form-input"
            style={{ marginBottom: '8px' }}
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="密码"
            className="form-input"
            onKeyDown={(event) => event.key === 'Enter' && handleImport()}
          />
        </div>
      ) : mode === 'cookie' ? (
        <div className="modal-form">
          <div className="helper-text">
            粘贴完整 Cookie 字符串（包含 __client 与 __session）
          </div>
          <textarea
            rows={8}
            value={cookieString}
            onChange={(event) => setCookieString(event.target.value)}
            placeholder="__client=...; __session=..."
          />
        </div>
      ) : (
        <div className="modal-form">
          <div className="helper-text">支持 JWT 或 JWT|rotating_token 格式</div>
          <textarea
            rows={6}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="eyJhbGciOi...|rotating_token"
          />
        </div>
      )}
    </ModalShell>
  );
}

function AmiImportModal({ open, onClose, onSuccess }) {
  const [wosSession, setWosSession] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setWosSession('');
    setError('');
    setResult(null);
    setLoading(false);
  }, [open]);

  const handleImport = async () => {
    const trimmed = wosSession.trim();
    if (!trimmed) {
      setError('请输入 wos-session cookie 值');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const response = await providerService.importAmiToken({ wosSession: trimmed });
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      setResult({ success: true });
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="AMI Token 导入"
      subtitle="导入 wos-session Cookie"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? '导入中...' : '确认导入'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      {result && <div className="notice-banner notice-success">导入成功</div>}

      <div className="modal-form">
        <div className="helper-text">
          从浏览器开发者工具获取 wos-session cookie 值（以 Fe26.2* 开头）
        </div>
        <textarea
          rows={6}
          value={wosSession}
          onChange={(event) => setWosSession(event.target.value)}
          placeholder="Fe26.2*1*..."
        />
      </div>
    </ModalShell>
  );
}

function DroidMethodModal({ open, onClose, onSelect }) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Droid Token 导入"
      subtitle="请选择导入方式"
      size="sm"
    >
      <div className="method-grid">
        <button className="method-card" onClick={() => onSelect('single')}>
          <i className="fas fa-bolt"></i>
          <div>
            <strong>单个导入</strong>
            <span>适合单次刷新或测试</span>
          </div>
        </button>
        <button className="method-card" onClick={() => onSelect('batch')}>
          <i className="fas fa-file-import"></i>
          <div>
            <strong>批量导入</strong>
            <span>支持多行 refreshToken</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

function DroidSingleImportModal({ open, onClose, onSuccess }) {
  const [refreshToken, setRefreshToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [factoryApiKey, setFactoryApiKey] = useState('');
  const [nodeTypes, setNodeTypes] = useState(DROID_NODE_TYPES.map((item) => item.value));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRefreshToken('');
    setClientId('');
    setFactoryApiKey('');
    setNodeTypes(DROID_NODE_TYPES.map((item) => item.value));
    setError('');
    setLoading(false);
  }, [open]);

  const toggleNodeType = (value) => {
    setNodeTypes((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    );
  };

  const handleImport = async () => {
    if (!refreshToken.trim()) {
      setError('请输入 refreshToken');
      return;
    }
    if (!nodeTypes.length) {
      setError('至少选择一个节点类型');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await providerService.importDroidToken({
        refreshToken: refreshToken.trim(),
        clientId: clientId.trim() || null,
        factoryApiKey: factoryApiKey.trim() || null,
        nodeTypes,
      });
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Droid 单个导入"
      subtitle="支持 Builder ID / refreshToken"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? '导入中...' : '确认导入'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      <div className="modal-form">
        <label>
          refreshToken
          <textarea
            rows={4}
            value={refreshToken}
            onChange={(event) => setRefreshToken(event.target.value)}
            placeholder="粘贴 refreshToken"
          />
        </label>
        <label>
          Client ID（可选）
          <input
            type="text"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="保持默认可留空"
          />
        </label>
        <label>
          Factory API Key（可选）
          <input
            type="password"
            value={factoryApiKey}
            onChange={(event) => setFactoryApiKey(event.target.value)}
            placeholder="可留空"
          />
        </label>
        <div className="checkbox-group">
          <span>节点类型</span>
          <div className="checkbox-grid">
            {DROID_NODE_TYPES.map((item) => (
              <label key={item.value}>
                <input
                  type="checkbox"
                  checked={nodeTypes.includes(item.value)}
                  onChange={() => toggleNodeType(item.value)}
                />
                {item.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function DroidBatchImportModal({ open, onClose, onSuccess }) {
  const [batchText, setBatchText] = useState('');
  const [clientId, setClientId] = useState('');
  const [factoryApiKey, setFactoryApiKey] = useState('');
  const [nodeTypes, setNodeTypes] = useState(DROID_NODE_TYPES.map((item) => item.value));
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBatchText('');
    setClientId('');
    setFactoryApiKey('');
    setNodeTypes(DROID_NODE_TYPES.map((item) => item.value));
    setProgress(null);
    setResult(null);
    setError('');
    setLoading(false);
  }, [open]);

  const toggleNodeType = (value) => {
    setNodeTypes((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    );
  };

  const handleImport = async () => {
    const tokens = parseLines(batchText);
    if (!tokens.length) {
      setError('请输入 refreshToken');
      return;
    }
    if (!nodeTypes.length) {
      setError('至少选择一个节点类型');
      return;
    }
    setLoading(true);
    setError('');
    setProgress({ current: 0, total: tokens.length, success: 0, failed: 0 });
    setResult(null);

    await streamBatchImport({
      endpoint: '/droid/batch-import-tokens',
      payload: {
        refreshTokens: tokens,
        clientId: clientId.trim() || null,
        factoryApiKey: factoryApiKey.trim() || null,
        nodeTypes,
      },
      onStart: (data) => {
        setProgress({ current: 0, total: data?.total || tokens.length, success: 0, failed: 0 });
      },
      onProgress: (data) => {
        setProgress({
          current: data?.index || 0,
          total: data?.total || tokens.length,
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
      },
      onComplete: (data) => {
        setResult({
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
          errors: (data?.details || [])
            .filter((item) => !item.success)
            .map((item) => item.error || '导入失败'),
        });
        setLoading(false);
        onSuccess?.();
      },
      onError: (data) => {
        setError(data?.error || '批量导入失败');
        setLoading(false);
      },
    });
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Droid 批量导入"
      subtitle="支持多行 refreshToken"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? '导入中...' : '开始批量导入'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      {progress && (
        <div className="progress-card">
          <div className="progress-meta">
            <span>进度：{progress.current}/{progress.total}</span>
            <span>成功 {progress.success} / 失败 {progress.failed}</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-inner"
              style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      )}
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
        </div>
      )}
      <div className="modal-form">
        <label>
          refreshToken（批量）
          <textarea
            rows={8}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder="每行一个 refreshToken"
          />
        </label>
        <label>
          Client ID（可选）
          <input
            type="text"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="保持默认可留空"
          />
        </label>
        <label>
          Factory API Key（可选）
          <input
            type="password"
            value={factoryApiKey}
            onChange={(event) => setFactoryApiKey(event.target.value)}
            placeholder="可留空"
          />
        </label>
        <div className="checkbox-group">
          <span>节点类型</span>
          <div className="checkbox-grid">
            {DROID_NODE_TYPES.map((item) => (
              <label key={item.value}>
                <input
                  type="checkbox"
                  checked={nodeTypes.includes(item.value)}
                  onChange={() => toggleNodeType(item.value)}
                />
                {item.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function KiroMethodModal({ open, pools, onClose, onSelect, onRefreshPools }) {
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (open) {
      // 弹窗打开时刷新池子列表
      if (onRefreshPools) {
        setLoading(true);
        onRefreshPools().finally(() => setLoading(false));
      }
    } else {
      setSelectedPoolId('');
      setDropdownOpen(false);
    }
  }, [open]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (mode) => {
    onSelect(mode, selectedPoolId);
  };

  const selectedPool = pools?.find(p => String(p.id) === String(selectedPoolId));
  const displayText = selectedPool ? selectedPool.name : '默认号池';

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Kiro 授权/导入"
      subtitle="请选择目标号池和认证方式"
      size="sm"
    >
      <div className="pool-select-section">
        <label>目标号池</label>
        <div className="custom-select" ref={dropdownRef}>
          <div
            className={`custom-select-trigger ${dropdownOpen ? 'open' : ''}`}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span>{displayText}</span>
            <i className={`fas fa-chevron-down ${dropdownOpen ? 'rotate' : ''}`}></i>
          </div>
          {dropdownOpen && (
            <div className="custom-select-options">
              <div
                className={`custom-select-option ${selectedPoolId === '' ? 'selected' : ''}`}
                onClick={() => { setSelectedPoolId(''); setDropdownOpen(false); }}
              >
                默认号池
              </div>
              {pools?.map((pool) => (
                <div
                  key={pool.id}
                  className={`custom-select-option ${String(selectedPoolId) === String(pool.id) ? 'selected' : ''}`}
                  onClick={() => { setSelectedPoolId(String(pool.id)); setDropdownOpen(false); }}
                >
                  {pool.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="method-grid">
        <button className="method-card" onClick={() => handleSelect('google')}>
          <i className="fab fa-google"></i>
          <div>
            <strong>Google 登录</strong>
            <span>Kiro Social OAuth</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('builder-id')}>
          <i className="fab fa-aws"></i>
          <div>
            <strong>AWS Builder ID</strong>
            <span>生成 OAuth 授权链接</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('batch-import')}>
          <i className="fas fa-file-import"></i>
          <div>
            <strong>批量导入</strong>
            <span>批量导入 refreshToken</span>
          </div>
        </button>
        <button className="method-card" onClick={() => handleSelect('aws-import')}>
          <i className="fas fa-cloud-upload-alt"></i>
          <div>
            <strong>JSON 导入</strong>
            <span>支持 Google/Social 与 AWS SSO</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

function ClaudeOfficialMethodModal({ open, onClose, onSelect }) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Claude Official 接入"
      subtitle="请选择认证方式"
      size="sm"
    >
      <div className="method-grid">
        <button className="method-card" onClick={() => onSelect('api-import')}>
          <i className="fas fa-key"></i>
          <div>
            <strong>API Key 导入</strong>
            <span>直接填写 url + key</span>
          </div>
        </button>
        <button className="method-card" onClick={() => onSelect('oauth')}>
          <i className="fas fa-link"></i>
          <div>
            <strong>OAuth 授权</strong>
            <span>标准官方 OAuth 流程</span>
          </div>
        </button>
        <button className="method-card" onClick={() => onSelect('setup-token')}>
          <i className="fas fa-shield-alt"></i>
          <div>
            <strong>Setup Token</strong>
            <span>支持 setup-token 授权</span>
          </div>
        </button>
        <button className="method-card" onClick={() => onSelect('cookie-oauth')}>
          <i className="fas fa-cookie-bite"></i>
          <div>
            <strong>Cookie OAuth</strong>
            <span>通过 sessionKey 自动换 token</span>
          </div>
        </button>
        <button className="method-card" onClick={() => onSelect('cookie-setup-token')}>
          <i className="fas fa-cookie"></i>
          <div>
            <strong>Cookie Setup</strong>
            <span>Cookie + setup-token 模式</span>
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

function ClaudeOfficialCookieModal({ open, authMode = 'oauth', pools = [], onClose, onRefreshPools, onSubmit }) {
  const [sessionKey, setSessionKey] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setSessionKey('');
    setSelectedPoolId('');
    setError('');
    setLoading(false);
    if (onRefreshPools) onRefreshPools();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (selectedPoolId) return;
    if (!Array.isArray(pools) || pools.length === 0) return;
    const defaultPool = pools.find((pool) => pool.isDefault) || pools[0];
    setSelectedPoolId(defaultPool?.id ? String(defaultPool.id) : '');
  }, [open, pools, selectedPoolId]);

  const handleSubmit = async () => {
    if (!sessionKey.trim()) {
      setError('请输入 Claude sessionKey');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await onSubmit?.({
        sessionKey: sessionKey.trim(),
        authMode,
        poolId: selectedPoolId || undefined,
      });
    } catch (err) {
      setError(err.message || 'Cookie 自动授权失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={authMode === 'setup-token' ? 'Claude Cookie Setup Token' : 'Claude Cookie OAuth'}
      subtitle="使用 Claude Web sessionKey 自动换取凭据"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? '授权中...' : '开始授权'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      <div className="modal-form">
        <label>
          Pool（可选）
          <select value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)}>
            <option value="">默认池</option>
            {pools.map((pool) => (
              <option key={pool.id} value={String(pool.id)}>{pool.name}</option>
            ))}
          </select>
        </label>
        <label>
          sessionKey
          <textarea
            rows={5}
            value={sessionKey}
            onChange={(event) => setSessionKey(event.target.value)}
            placeholder="粘贴 Claude 网站的 sessionKey"
          />
        </label>
      </div>
    </ModalShell>
  );
}

function KiroBatchImportModal({ open, poolId, onClose, onSuccess }) {
  const [batchText, setBatchText] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detectedFormat, setDetectedFormat] = useState(null);
  const [parsedCredentials, setParsedCredentials] = useState(null);
  const hadSuccessRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setBatchText('');
    setProgress(null);
    setResult(null);
    setError('');
    setLoading(false);
    setDetectedFormat(null);
    setParsedCredentials(null);
    hadSuccessRef.current = false;
  }, [open]);

  const handleClose = () => {
    if (hadSuccessRef.current) onSuccess?.();
    else onClose();
  };

  // 字符串特征检测 JSON 凭据
  const looksLikeJsonCredential = (text) => {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    return t.includes('"refreshToken"') ||
      t.includes('"refresh_token"') ||
      (t.includes('"accounts"') && t.includes('"credentials"'));
  };

  // 解析 JSON 凭据（多重回退策略）
  const parseJsonCredentials = (text) => {
    const trimmed = text.trim();
    const validate = (payload) => {
      const normalized = extractKiroJsonCredentials(payload).map(normalizeKiroCredential);
      if (normalized.length > 0 && normalized.every(item => item && typeof item === 'object' && item.refreshToken)) return normalized;
      return null;
    };
    try {
      const parsed = JSON.parse(trimmed);
      const r = validate(parsed);
      if (r) return r;
    } catch { /* continue */ }
    const cleaned = trimmed.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').replace(/[\r]/g, '');
    if (cleaned !== trimmed) {
      try {
        const parsed = JSON.parse(cleaned);
        const r = validate(parsed);
        if (r) return r;
      } catch { /* continue */ }
    }
    const src = cleaned || trimmed;
    if (src.startsWith('{') || src.startsWith('[')) {
      let depth = 0, inStr = false, esc = false;
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(src.substring(0, i + 1));
            const r = validate(parsed);
            if (r) return r;
          } catch { /* continue */ }
          break;
        }
      }
    }
    const lines = src.split('\n').filter(l => l.trim());
    const objects = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        const normalized = extractKiroJsonCredentials(parsed).map(normalizeKiroCredential);
        objects.push(...normalized.filter(item => item && typeof item === 'object' && item.refreshToken));
      } catch { /* skip */ }
    }
    if (objects.length > 0) return objects;
    return null;
  };

  // 检测输入格式
  useEffect(() => {
    if (!batchText.trim()) { setDetectedFormat(null); return; }
    if (looksLikeJsonCredential(batchText)) {
      const t = batchText.trim();
      if (t.includes('"accounts"') && t.includes('"credentials"')) {
        setDetectedFormat('accountManager');
        return;
      }
      const hasFull = (t.includes('"clientId"') || t.includes('"client_id"'))
        && (t.includes('"clientSecret"') || t.includes('"client_secret"'))
        && (t.includes('"accessToken"') || t.includes('"access_token"'))
        && (t.includes('"refreshToken"') || t.includes('"refresh_token"'));
      setDetectedFormat(hasFull ? 'fullCredential' : 'jsonRefreshToken');
      return;
    }
    const lines = batchText.split('\n').filter(line => line.trim());
    if (lines.length === 0) { setDetectedFormat(null); return; }
    const hasAwsFormat = lines.some(line => line.includes('|') && line.split('|').length >= 4);
    setDetectedFormat(hasAwsFormat ? 'awsCredentials' : 'refreshToken');
  }, [batchText]);

  // JSON 凭据逐个导入
  const handleJsonImport = async (credentials) => {
    const token = localStorage.getItem('token');
    const total = credentials.length;
    let success = 0, failed = 0;
    const errors = [];
    setProgress({ current: 0, total, success: 0, failed: 0 });
    for (let i = 0; i < total; i++) {
      const cred = normalizeKiroCredential(credentials[i]);
      const hasFullCreds = hasKiroFullCredential(cred);
      try {
        const response = await fetch('/api/kiro/import-aws-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            credentials: hasFullCreds ? cred : cred,
            poolId: poolId || undefined,
          }),
        });
        const data = await response.json();
        if (data.success) success++;
        else { failed++; errors.push(data.error || '导入失败'); }
      } catch (e) { failed++; errors.push(e.message || '网络错误'); }
      setProgress({ current: i + 1, total, success, failed });
    }
    setResult({ success, failed, errors });
    setLoading(false);
    if (success > 0) hadSuccessRef.current = true;
  };

  // 解析预览
  const handleParsePreview = () => {
    setError('');
    const jsonCreds = parseJsonCredentials(batchText);
    if (!jsonCreds || jsonCreds.length === 0) {
      let parseErr = 'JSON 格式无法解析';
      try { JSON.parse(batchText.trim()); } catch (e) { parseErr = e.message; }
      setError(`JSON 解析失败: ${parseErr}`);
      return;
    }
    setParsedCredentials(jsonCreds);
  };

  const handleBackToEdit = () => {
    setParsedCredentials(null);
    setProgress(null);
    setResult(null);
    setError('');
  };

  // 确认导入已解析的凭据
  const handleConfirmImport = async () => {
    if (!parsedCredentials || parsedCredentials.length === 0) return;
    if (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') {
      setLoading(true); setError(''); setResult(null);
      await handleJsonImport(parsedCredentials);
      return;
    }
    const tokens = parsedCredentials.map(c => normalizeKiroCredential(c)?.refreshToken).filter(Boolean);
    if (tokens.length === 0) { setError('未找到有效的 refreshToken'); return; }
    setLoading(true); setError('');
    setProgress({ current: 0, total: tokens.length, success: 0, failed: 0 });
    setResult(null);
    await streamBatchImport({
      endpoint: '/kiro/batch-import-tokens',
      payload: { refreshTokens: tokens, poolId: poolId || undefined },
      onStart: (data) => { setProgress({ current: 0, total: data?.total || tokens.length, success: 0, failed: 0 }); },
      onProgress: (data) => { setProgress({ current: data?.index || 0, total: data?.total || tokens.length, success: data?.successCount || 0, failed: data?.failedCount || 0 }); },
      onComplete: (data) => {
        setResult({ success: data?.successCount || 0, failed: data?.failedCount || 0, errors: (data?.details || []).filter(i => !i.success).map(i => i.error || '导入失败') });
        setLoading(false);
        if (data?.successCount > 0) hadSuccessRef.current = true;
      },
      onError: (data) => { setError(data?.error || '批量导入失败'); setLoading(false); },
    });
  };

  const handleImport = async () => {
    // JSON 格式 → 走解析预览流程
    if (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') {
      handleParsePreview();
      return;
    }
    const lines = parseLines(batchText);
    if (!lines.length) { setError('请输入凭据'); return; }
    setLoading(true); setError('');
    setProgress({ current: 0, total: lines.length, success: 0, failed: 0 });
    setResult(null);
    if (detectedFormat === 'awsCredentials') {
      await streamBatchImport({
        endpoint: '/kiro/batch-import-aws-credentials',
        payload: { text: batchText, poolId: poolId || undefined },
        onStart: (data) => { setProgress({ current: 0, total: data?.total || lines.length, success: 0, failed: 0 }); },
        onProgress: (data) => { setProgress({ current: data?.index || 0, total: data?.total || lines.length, success: data?.successCount || 0, failed: data?.failedCount || 0 }); },
        onComplete: (data) => {
          setResult({ success: data?.successCount || 0, failed: data?.failedCount || 0, errors: (data?.details || []).filter(i => !i.success).map(i => i.error || '导入失败') });
          setLoading(false);
          if (data?.successCount > 0) hadSuccessRef.current = true;
        },
        onError: (data) => { setError(data?.error || '批量导入失败'); setLoading(false); },
      });
    } else {
      await streamBatchImport({
        endpoint: '/kiro/batch-import-tokens',
        payload: { refreshTokens: lines, poolId: poolId || undefined },
        onStart: (data) => { setProgress({ current: 0, total: data?.total || lines.length, success: 0, failed: 0 }); },
        onProgress: (data) => { setProgress({ current: data?.index || 0, total: data?.total || lines.length, success: data?.successCount || 0, failed: data?.failedCount || 0 }); },
        onComplete: (data) => {
          setResult({ success: data?.successCount || 0, failed: data?.failedCount || 0, errors: (data?.details || []).filter(i => !i.success).map(i => i.error || '导入失败') });
          setLoading(false);
          if (data?.successCount > 0) hadSuccessRef.current = true;
        },
        onError: (data) => { setError(data?.error || '批量导入失败'); setLoading(false); },
      });
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="Kiro 批量导入"
      subtitle="支持 refreshToken 或完整凭据格式"
      size="md"
      footer={
        parsedCredentials && !result ? (
          <>
            <button className="btn btn-secondary" onClick={handleBackToEdit} disabled={loading}>
              <i className="fas fa-arrow-left" /> 返回修改
            </button>
            <button className="btn btn-primary" onClick={handleConfirmImport} disabled={loading}>
              {loading ? '导入中...' : `确认导入 (${parsedCredentials.length} 个)`}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={handleClose} disabled={loading}>
              关闭
            </button>
            {!result && (
              <button className="btn btn-primary" onClick={handleImport} disabled={loading || !batchText.trim()}>
                {loading ? '导入中...' : (detectedFormat === 'fullCredential' || detectedFormat === 'jsonRefreshToken' || detectedFormat === 'accountManager') ? '解析预览' : '开始导入'}
              </button>
            )}
          </>
        )
      }
    >
      <NoticeBanner type="error" message={error} />
      {progress && (
        <div className="progress-card">
          <div className="progress-meta">
            <span>进度：{progress.current}/{progress.total}</span>
            <span>成功 {progress.success} / 失败 {progress.failed}</span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-inner"
              style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      )}
      {result && (
        <div className="notice-banner notice-success">
          导入完成：成功 {result.success} 个，失败 {result.failed} 个
        </div>
      )}

      {parsedCredentials && !result ? (
        <div className="parsed-credentials-preview">
          <div className="preview-header">
            <span>解析到 {parsedCredentials.length} 个账号</span>
            <span className="preview-format-tag">
              {detectedFormat === 'accountManager' ? 'Account Manager' : detectedFormat === 'fullCredential' ? '完整凭据' : 'RefreshToken'}
            </span>
          </div>
          <div className="preview-list">
            {parsedCredentials.map((cred, idx) => {
              const normalizedCred = normalizeKiroCredential(cred);
              const hasFullCreds = hasKiroFullCredential(normalizedCred);
              const tokenPreview = normalizedCred.refreshToken
                ? `${normalizedCred.refreshToken.substring(0, 12)}...${normalizedCred.refreshToken.slice(-6)}`
                : '无 refreshToken';
              return (
                <div key={idx} className="preview-item">
                  <div className="preview-item-index">#{idx + 1}</div>
                  <div className="preview-item-info">
                    {cred.email && <div className="preview-item-email">{cred.email}</div>}
                    <div className="preview-item-token" title={normalizedCred.refreshToken}>{tokenPreview}</div>
                    <div className="preview-item-tags">
                      {hasFullCreds && <span className="tag tag-full">完整凭据</span>}
                      {!hasFullCreds && <span className="tag tag-token">仅 Token</span>}
                      {cred.region && <span className="tag tag-region">{cred.region}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : !result && (
        <div className="modal-form">
          {detectedFormat && (
            <div className={`format-hint ${detectedFormat === 'awsCredentials' ? 'format-aws' : detectedFormat === 'fullCredential' ? 'format-aws' : 'format-token'}`}>
              <i className={`fas ${detectedFormat === 'awsCredentials' || detectedFormat === 'fullCredential' ? 'fa-key' : 'fa-ticket-alt'}`} />
              {detectedFormat === 'fullCredential'
                ? '检测到 JSON 完整凭据，点击「解析预览」查看账号列表'
                : detectedFormat === 'accountManager'
                  ? '检测到 Kiro Account Manager 导出 JSON，点击「解析预览」查看账号列表'
                  : detectedFormat === 'jsonRefreshToken'
                    ? '检测到 JSON 格式，点击「解析预览」查看账号列表'
                    : detectedFormat === 'awsCredentials'
                      ? '检测到 AWS 凭据格式，将使用完整凭据导入'
                      : '检测到 RefreshToken 格式，将使用 Token 导入'}
            </div>
          )}
          <textarea
            rows={10}
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            placeholder={`支持四种格式：\n\n1. 纯 RefreshToken（每行一个）:\naorAAAAA...\n\n2. AWS 完整凭据（| 分隔）:\nemail|password|clientId|clientSecret|refreshToken|accessToken\n\n3. JSON 凭据（Google/Social 或 AWS，支持 snake_case）:\n{"refreshToken":"...","accessToken":"...","profileArn":"...","authMethod":"social"}\n\n4. Kiro Account Manager 导出 JSON:\n{"version":"1.6.1","accounts":[{"email":"name@example.com","credentials":{"refreshToken":"...","accessToken":"...","authMethod":"social"}}]}`}
          />
        </div>
      )}
    </ModalShell>
  );
}

function KiroAwsImportModal({ open, poolId, onClose, onSuccess }) {
  const [mode, setMode] = useState('single'); // 'single' | 'batch'
  const [jsonText, setJsonText] = useState('');
  const [batchText, setBatchText] = useState('');
  const [credentials, setCredentials] = useState(null);
  const [validation, setValidation] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setJsonText('');
    setBatchText('');
    setCredentials(null);
    setValidation(null);
    setError('');
    setLoading(false);
    setProgress(null);
    setResult(null);
  }, [open]);

  // 单个导入：解析 JSON
  useEffect(() => {
    if (!open || mode !== 'single') return;
    if (!jsonText.trim()) {
      setCredentials(null);
      setValidation(null);
      return;
    }
    try {
      const parsedPayload = JSON.parse(jsonText);
      const extracted = extractKiroJsonCredentials(parsedPayload);
      if (extracted.length !== 1) {
        setCredentials(null);
        setValidation({
          type: 'error',
          message: extracted.length > 1 ? '检测到多个账号，请切换批量导入' : '未找到有效凭据',
        });
        return;
      }
      const parsed = normalizeKiroCredential(extracted[0]);
      setCredentials(parsed);
      setValidation(null);
    } catch (_error) {
      setCredentials(null);
      setValidation({ type: 'error', message: 'JSON 格式错误' });
    }
  }, [jsonText, open, mode]);

  // 单个导入：验证字段
  useEffect(() => {
    if (!credentials || mode !== 'single') return;
    const missing = credentials.refreshToken ? [] : ['refreshToken'];
    if ((credentials.clientId || credentials.clientSecret) && !hasKiroFullCredential(credentials)) {
      if (!credentials.clientId) missing.push('clientId');
      if (!credentials.clientSecret) missing.push('clientSecret');
      if (!credentials.accessToken) missing.push('accessToken');
    }
    if (missing.length) {
      setValidation({ type: 'warning', message: `缺少字段：${missing.join(', ')}` });
    } else {
      setValidation({
        type: 'success',
        message: hasKiroFullCredential(credentials) ? 'AWS SSO 凭据完整，可以导入' : 'Google/Social 凭据完整，可以导入',
      });
    }
  }, [credentials, mode]);

  // 批量导入：解析文本行数
  useEffect(() => {
    if (!open || mode !== 'batch') return;
    if (!batchText.trim()) {
      setValidation(null);
      return;
    }
    const trimmed = batchText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsedPayload = JSON.parse(trimmed);
        const extracted = extractKiroJsonCredentials(parsedPayload).filter(item => item?.refreshToken);
        if (extracted.length > 0) {
          setValidation({ type: 'success', message: `检测到 ${extracted.length} 条 Kiro Account Manager/JSON 凭据` });
          return;
        }
      } catch {
        setValidation({ type: 'error', message: 'JSON 格式错误' });
        return;
      }
    }
    const lines = batchText.split('\n').filter(line => line.trim() && line.includes('|'));
    if (lines.length === 0) {
      setValidation({ type: 'error', message: '未检测到有效数据行' });
    } else {
      setValidation({ type: 'success', message: `检测到 ${lines.length} 条凭据` });
    }
  }, [batchText, open, mode]);

  // 单个导入
  const handleSingleImport = async () => {
    if (!credentials) {
      setError('请先输入凭据内容');
      return;
    }
    if (validation?.type === 'warning') {
      setError('凭据缺少字段，无法导入');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await providerService.importKiroAwsCredentials(credentials, poolId);
      if (response?.success === false) {
        throw new Error(response?.error || '导入失败');
      }
      onSuccess?.();
    } catch (importError) {
      setError(importError.message || '导入失败');
    } finally {
      setLoading(false);
    }
  };

  // 批量导入
  const handleBatchImport = async () => {
    if (!batchText.trim()) {
      setError('请先输入凭据内容');
      return;
    }
    let expectedTotal = 0;
    try {
      const parsedPayload = JSON.parse(batchText.trim());
      const extracted = extractKiroJsonCredentials(parsedPayload).filter(item => item?.refreshToken);
      expectedTotal = extracted.length;
    } catch { /* use backend total */ }
    setLoading(true);
    setError('');
    setProgress(expectedTotal > 0 ? { current: 0, total: expectedTotal, success: 0, failed: 0 } : null);
    setResult(null);

    await streamBatchImport({
      endpoint: '/kiro/batch-import-aws-credentials',
      payload: { text: batchText, poolId: poolId || undefined },
      onStart: (data) => {
        setProgress({ current: 0, total: data?.total || 0, success: 0, failed: 0 });
      },
      onProgress: (data) => {
        setProgress({
          current: data?.index || 0,
          total: data?.total || 0,
          success: data?.successCount || 0,
          failed: data?.failedCount || 0,
        });
      },
      onComplete: (data) => {
        setResult(data);
        setLoading(false);
        if (data?.successCount > 0) {
          onSuccess?.();
        }
      },
      onError: (err) => {
        setError(err?.error || '导入失败');
        setLoading(false);
      },
    });
  };

  const handleImport = mode === 'single' ? handleSingleImport : handleBatchImport;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Kiro JSON 凭据导入"
      subtitle="支持 Google/Social token JSON 或 AWS SSO 凭据"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleImport} disabled={loading}>
            {loading ? '导入中...' : '确认导入'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />

      <div className="mode-tabs" style={{ marginBottom: '1rem' }}>
        <button
          className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('single')}
          disabled={loading}
        >
          单个导入 (JSON)
        </button>
        <button
          className={`btn btn-sm ${mode === 'batch' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('batch')}
          disabled={loading}
          style={{ marginLeft: '0.5rem' }}
        >
          批量导入 (文本)
        </button>
      </div>

      {validation && (
        <div className={`notice-banner notice-${validation.type}`}>{validation.message}</div>
      )}

      {mode === 'single' ? (
        <>
          <div className="modal-form">
            <textarea
              rows={10}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              placeholder={`{"accessToken":"...","refreshToken":"...","profileArn":"...","authMethod":"social"}\n\n或 Kiro Account Manager 导出 JSON：\n{"version":"1.6.1","accounts":[{"email":"name@example.com","credentials":{"refreshToken":"...","accessToken":"...","authMethod":"social"}}]}`}
            />
          </div>
          {credentials && (
            <pre className="json-preview">{JSON.stringify(credentials, null, 2)}</pre>
          )}
        </>
      ) : (
        <>
          <div className="modal-form">
            <textarea
              rows={10}
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={`每行一条，格式：email|password|clientId|clientSecret|refreshToken|accessToken\n\n或粘贴 Kiro Account Manager 导出 JSON`}
            />
          </div>
          {progress && (
            <div className="batch-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <div className="progress-text">
                {progress.current}/{progress.total} - 成功: {progress.success}, 失败: {progress.failed}
              </div>
            </div>
          )}
          {result && (
            <div className={`notice-banner notice-${result.failedCount > 0 ? 'warning' : 'success'}`}>
              导入完成：成功 {result.successCount}，失败 {result.failedCount}
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}

function OAuthHostModal({ open, providerType, onClose, onConfirm, poolOptions = [] }) {
  const [host, setHost] = useState('localhost');
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    // 默认选中默认号池
    const defaultPool = poolOptions.find(p => p.isDefault) || poolOptions[0];
    setSelectedPoolId(defaultPool?.id?.toString() || '');
  }, [open, poolOptions]);

  useEffect(() => {
    if (!open) return;
    let isMounted = true;
    const loadConfig = async () => {
      try {
        const config = await configService.get();
        if (isMounted) {
          setHost(config?.OAUTH_CALLBACK_HOST || '');
        }
      } catch (err) {
        if (isMounted) {
          setError('读取当前回调配置失败');
        }
      }
    };
    loadConfig();
    return () => {
      isMounted = false;
    };
  }, [open]);

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      if (host.trim()) {
        const config = await configService.get();
        config.OAUTH_CALLBACK_HOST = host.trim();
        await configService.update(config);
      }
      onConfirm?.({ host: host.trim() || undefined, poolId: selectedPoolId || undefined });
      onClose();
    } catch (err) {
      setError(err.message || '保存配置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="配置 OAuth 回调地址"
      subtitle={`当前提供商：${getProviderDisplayName(providerType)}`}
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={loading}>
            确认并生成授权
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      <div className="modal-form">
        <label>
          公网 IP 或域名
          <input
            type="text"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="例如：123.45.67.89 或 api.example.com"
          />
          <span className="helper-text">留空将自动检测服务器 IP（Docker 环境可能不准确）</span>
        </label>
        {poolOptions.length > 0 && (
          <label>
            目标号池
            <select value={selectedPoolId} onChange={(e) => setSelectedPoolId(e.target.value)}>
              {poolOptions.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}{pool.isDefault ? ' (默认)' : ''}
                </option>
              ))}
            </select>
            <span className="helper-text">授权成功后账号将添加到此号池</span>
          </label>
        )}
      </div>
    </ModalShell>
  );
}

function AddProviderModal({ open, providerType, poolId, onClose, onSuccess }) {
  const [form, setForm] = useState({
    customName: '',
    checkModelName: '',
    checkHealth: 'true',
  });
  const [extraFields, setExtraFields] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const fields = PROVIDER_FIELD_CONFIGS[providerType] || [];
  const rawSystemType = String(extraFields.claudeCustomSystemType || '').trim().toLowerCase();
  const inferredNewApi = Boolean(
    String(extraFields.newapiSystemToken || '').trim()
    || String(extraFields.newapiUserId || '').trim()
    || String(extraFields.newapiUsername || '').trim()
    || String(extraFields.newapiPassword || '').trim()
  );
  const normalizedSystemType = rawSystemType || (inferredNewApi ? 'newapi' : 'self-developed');
  const isClaudeCustomNewApi = providerType === 'claude-custom' && normalizedSystemType === 'newapi';

  useEffect(() => {
    if (!open) return;
    setForm({ customName: '', checkModelName: '', checkHealth: 'true' });
    setExtraFields({});
    setError('');
    setLoading(false);
  }, [open, providerType]);

  const handleChange = (key, value) => {
    if (BASE_FIELDS.includes(key)) {
      setForm((prev) => ({ ...prev, [key]: value }));
    } else {
      setExtraFields((prev) => ({ ...prev, [key]: value }));
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError('');
    try {
      const providerConfig = {
        customName: form.customName.trim(),
        checkModelName: form.checkModelName.trim(),
        checkHealth: form.checkHealth === 'true',
        ...extraFields,
      };
      if (providerType === 'claude-custom') {
        providerConfig.claudeCustomSystemType = normalizedSystemType;
        if (normalizedSystemType === 'newapi') {
          delete providerConfig.foxcodeAuthBaseUrl;
          delete providerConfig.foxcodeEmail;
          delete providerConfig.foxcodePassword;
        }
      }
      const response = await providerService.add({ providerType, providerConfig, poolId });
      if (response?.success === false) {
        throw new Error(response?.error || '添加失败');
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || '添加失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="添加新提供商"
      subtitle={getProviderDisplayName(providerType)}
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? '保存中...' : '保存'}
          </button>
        </>
      }
    >
      <NoticeBanner type="error" message={error} />
      <div className="modal-form">
        <label>
          自定义名称
          <input
            type="text"
            value={form.customName}
            onChange={(event) => handleChange('customName', event.target.value)}
            placeholder="例如：我的节点1"
          />
        </label>
        <label>
          检查模型名称
          <input
            type="text"
            value={form.checkModelName}
            onChange={(event) => handleChange('checkModelName', event.target.value)}
            placeholder="例如：gpt-3.5-turbo"
          />
        </label>
        <label>
          健康检查
          <select value={form.checkHealth} onChange={(event) => handleChange('checkHealth', event.target.value)}>
            <option value="true">启用</option>
            <option value="false">禁用</option>
          </select>
        </label>
        {fields.map((field) => {
          if (
            isClaudeCustomNewApi
            && (field.id === 'foxcodeAuthBaseUrl' || field.id === 'foxcodeEmail' || field.id === 'foxcodePassword')
          ) {
            return null;
          }

          if (providerType === 'claude-custom' && field.id === 'claudeCustomSystemType') {
            return (
              <label key={field.id}>
                {field.label}
                <select
                  value={normalizedSystemType}
                  onChange={(event) => handleChange(field.id, event.target.value)}
                >
                  {CLAUDE_CUSTOM_SYSTEM_TYPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
            );
          }

          if (field.type === 'select') {
            return (
              <label key={field.id}>
                {field.label}
                <select
                  value={String(extraFields[field.id] ?? '')}
                  onChange={(event) => handleChange(field.id, event.target.value)}
                >
                  {(field.options || []).map((item) => (
                    <option key={item.value || 'auto'} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
            );
          }

          return (
            <label key={field.id}>
              {field.label}
              <input
                type={field.type || 'text'}
                value={extraFields[field.id] || ''}
                onChange={(event) => handleChange(field.id, event.target.value)}
                placeholder={field.placeholder || ''}
              />
            </label>
          );
        })}
      </div>
    </ModalShell>
  );
}

function ProviderItem({
  provider,
  providerType,
  models,
  actionLoading,
  selected,
  onSelectChange,
  onToggleDisable,
  onRefreshUuid,
  onDelete,
  onSave,
  poolOptions,
  onMovePool,
  usageSummary,
  usageError,
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => buildDraftConfig(providerType, provider));
  const isClaudeCustomNewApi = providerType === 'claude-custom'
    && (() => {
      const rawSystemType = String(draft.claudeCustomSystemType || '').trim().toLowerCase();
      if (rawSystemType) return rawSystemType === 'newapi';
      return Boolean(
        String(draft.newapiSystemToken || '').trim()
        || String(draft.newapiUserId || '').trim()
        || String(draft.newapiUsername || '').trim()
        || String(draft.newapiPassword || '').trim()
      );
    })();

  useEffect(() => {
    if (!editing) {
      setDraft(buildDraftConfig(providerType, provider));
    }
  }, [provider, providerType, editing]);

  const isDeleted = Boolean(provider.isDeleted || provider.deleted);
  const isDisabled = Boolean(provider.isDisabled || provider.disabled);
  const isHealthy = Boolean(provider.isHealthy || provider.healthy);

  const providerCredentials = provider?.credentials && typeof provider.credentials === 'object'
    ? provider.credentials
    : {};
  const relayState = String(
    provider.relayState
    || providerCredentials.relayState
    || providerCredentials.relay_state
    || ''
  ).trim().toLowerCase();
  const cooldownRecoveryTime =
    provider.scheduledRecoveryTime
    || provider.scheduled_recovery_time
    || providerCredentials.relayStateRecoverAt
    || providerCredentials.relay_state_recover_at
    || null;
  const hasFutureRecoveryTime = cooldownRecoveryTime && new Date(cooldownRecoveryTime) > new Date();

  // 配额冷却判断：兼容 scheduledRecoveryTime / relayState / isCooldown
  const isQuotaCooldown = !isHealthy && !isDeleted && !isDisabled
    && (
      provider.isCooldown === true
      || provider.status === 'cooldown'
      || relayState === 'cooldown'
      || relayState === 'overloaded'
      || hasFutureRecoveryTime
    );

  const statusClass = isDeleted
    ? 'deleted'
    : isDisabled
    ? 'disabled'
    : isHealthy
    ? 'healthy'
    : isQuotaCooldown
    ? 'cooldown'
    : 'unhealthy';

  const displayName = provider.customName || provider.custom_name || provider.uuid || '未命名账号';
  const usagePercent = usageSummary?.percent ?? null;
  const usageBadgeLabel = usageSummary
    ? formatPercent(usagePercent || 0)
    : usageError
    ? '失败'
    : '--';
  const usageBadgeClass = usageSummary
    ? `status-usage status-${usageSummary.status || 'normal'}`
    : usageError
    ? 'status-usage status-error'
    : 'status-usage status-empty';
  const canSelect = !isDeleted && typeof onSelectChange === 'function';
  const poolOptionsList = Array.isArray(poolOptions) ? poolOptions : [];
  const currentPoolId = provider.poolId ?? provider.pool_id ?? 0;
  const showPoolSelect = poolOptionsList.length > 1;

  const handlePoolChange = (event) => {
    event.stopPropagation();
    const nextPoolId = event.target.value;
    if (String(nextPoolId) === String(currentPoolId)) return;
    onMovePool?.(provider, nextPoolId);
  };

  const handleToggleEdit = () => {
    if (editing) {
      setEditing(false);
      setDraft(buildDraftConfig(providerType, provider));
    } else {
      setEditing(true);
      setExpanded(true);
    }
  };

  const handleSave = () => {
    onSave(provider.uuid, draft, () => setEditing(false));
  };

  const handleFieldChange = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleModelToggle = (model) => {
    const current = draft.notSupportedModels || [];
    const next = current.includes(model)
      ? current.filter((item) => item !== model)
      : [...current, model];
    setDraft((prev) => ({ ...prev, notSupportedModels: next }));
  };

  const fieldOrder = getProviderFieldOrder(providerType, provider);

  return (
    <div className={`provider-item-detail ${statusClass} ${expanded ? 'expanded' : ''}`}>
      <div
        className="provider-item-header"
        onClick={() => setExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            setExpanded((prev) => !prev);
          }
        }}
      >
        {canSelect && (
          <label className="provider-select-box" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={(event) => onSelectChange?.(event.target.checked)}
            />
          </label>
        )}
        <div className="provider-info">
          <h4>{displayName}</h4>
          <div className="provider-meta">
            <span>
              <i className="fas fa-fingerprint"></i>
              UUID: {provider.uuid || '--'}
            </span>
            {isHealthy ? (
              <span className="status-badge status-healthy">
                <i className="fas fa-check-circle"></i> 正常
              </span>
            ) : isDisabled ? (
              <span className="status-badge status-disabled">
                <i className="fas fa-pause-circle"></i> 已禁用
              </span>
            ) : isQuotaCooldown ? (
              <span className="status-badge status-cooldown" title={cooldownRecoveryTime ? `恢复时间: ${new Date(cooldownRecoveryTime).toLocaleString()}` : '配额冷却'}>
                <i className="fas fa-snowflake"></i> 配额冷却{cooldownRecoveryTime ? ` (${formatTimeRemaining(cooldownRecoveryTime)})` : ''}
              </span>
            ) : (
              <span className="status-badge status-unhealthy">
                <i className="fas fa-exclamation-circle"></i> 异常
              </span>
            )}
            {usageSummary && (
              <span
                className={`status-badge status-battery ${usageSummary.status || 'normal'}`}
                title={usageSummary?.peakLabel || '用量信息'}
              >
                <i className={`fas fa-battery-${usageSummary.status === 'critical' ? 'empty' : usageSummary.status === 'warning' ? 'half' : 'full'}`}></i> {formatPercent(usagePercent || 0)}
              </span>
            )}
            <span className="status-badge status-used">
              <i className="fas fa-chart-line"></i> 已 {provider.usageCount ?? 0}次
            </span>
            {(provider.errorCount ?? 0) > 0 && (
              <span
                className="status-badge status-error-count"
                title={`错误 ${provider.errorCount} 次`}
              >
                <i className="fas fa-times-circle"></i> {provider.errorCount}
              </span>
            )}
            {provider.lastErrorMessage && !isDeleted && (
              <span
                className="error-icon-badge"
                title={provider.lastErrorMessage}
                onClick={(e) => {
                  e.stopPropagation();
                  alert(provider.lastErrorMessage);
                }}
              >
                <i className="fas fa-exclamation-circle"></i>
              </span>
            )}
          </div>
          <div className="provider-health-meta">
            <span>
              <i className="fas fa-clock"></i>
              最后使用: {formatDateTime(provider.lastUsed)}
            </span>
            {provider.lastErrorTime && (
              <span>
                <i className="fas fa-exclamation-triangle"></i>
                最后错误: {formatDateTime(provider.lastErrorTime)}
              </span>
            )}
          </div>
          {usageSummary && usageSummary.autoDisabled && (
            <div className="provider-item-usage-status">
              <span className="status-badge status-auto-disabled" title={usageSummary.autoDisableReason || ''}>
                <i className="fas fa-ban"></i> 已自动禁用
              </span>
            </div>
          )}
        </div>
        <div className="provider-actions-group" onClick={(event) => event.stopPropagation()}>
          {showPoolSelect && (
            <select
              className="provider-pool-select"
              value={String(currentPoolId)}
              onChange={handlePoolChange}
              onClick={(event) => event.stopPropagation()}
              disabled={actionLoading === `pool-${provider.uuid}`}
            >
              {poolOptionsList.map((pool) => (
                <option key={pool.id} value={String(pool.id)}>
                  {pool.name || `池子 ${pool.id}`}
                </option>
              ))}
            </select>
          )}
          {!isDeleted && (
            <>
              <button
                className={`btn btn-sm ${isDisabled ? 'btn-success' : 'btn-warning'}`}
                onClick={() => onToggleDisable(provider)}
                disabled={actionLoading === `toggle-${provider.uuid}`}
              >
                <i className={`fas ${isDisabled ? 'fa-play' : 'fa-ban'}`}></i>
                {isDisabled ? '启用' : '禁用'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleToggleEdit}
              >
                <i className={`fas ${editing ? 'fa-times' : 'fa-edit'}`}></i>
                {editing ? '取消' : '编辑'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onRefreshUuid(provider)}
                disabled={actionLoading === `refresh-${provider.uuid}`}
              >
                <i className="fas fa-sync-alt"></i>
                刷新uuid
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => onDelete(provider)}
                disabled={actionLoading === `delete-${provider.uuid}`}
              >
                <i className="fas fa-trash-alt"></i>
                删除
              </button>
            </>
          )}
          {isDeleted && (
            <span className="deleted-tag">
              <i className="fas fa-trash"></i>
              已删除
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="provider-item-content">
          <div className="config-grid">
            {fieldOrder.map((key) => {
              const value = BASE_FIELDS.includes(key) ? draft[key] : draft[key] ?? '';

              if (
                isClaudeCustomNewApi
                && (key === 'foxcodeAuthBaseUrl' || key === 'foxcodeEmail' || key === 'foxcodePassword')
              ) {
                return null;
              }

              if (key === 'checkHealth') {
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value)}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      <option value="true">启用</option>
                      <option value="false">禁用</option>
                    </select>
                  </label>
                );
              }

              if (key === 'upstreamMode' && providerType === 'claude-custom') {
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value || 'direct')}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      {CLAUDE_CUSTOM_UPSTREAM_MODE_OPTIONS.map((mode) => (
                        <option key={mode.value} value={mode.value}>{mode.label}</option>
                      ))}
                    </select>
                  </label>
                );
              }

              if (key === 'claudeCustomSystemType' && providerType === 'claude-custom') {
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value || 'self-developed')}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      {CLAUDE_CUSTOM_SYSTEM_TYPE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                );
              }

              if (key === 'XAI_USING_API' && providerType === 'openai-xai-oauth') {
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value ?? '')}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      <option value="">自动（按 Token 权限）</option>
                      <option value="true">xAI 官方 API</option>
                      <option value="false">Grok Build 代理</option>
                    </select>
                    <span className="helper-text">
                      官方 API: api.x.ai；Build: cli-chat-proxy.grok.com
                    </span>
                  </label>
                );
              }

              if ((key === 'officialStickySessionEnabled' || key === 'officialSessionBindingStrict' || key === 'officialQueueLockEnabled') && providerType === 'claude-offical') {
                const defaultValue = (key === 'officialStickySessionEnabled' || key === 'officialQueueLockEnabled') ? 'true' : 'false';
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value ?? defaultValue)}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      <option value="true">启用</option>
                      <option value="false">禁用</option>
                    </select>
                  </label>
                );
              }

              if ((key === 'officialFingerprintIncludeUser' || key === 'officialFingerprintIncludeToken' || key === 'officialFingerprintIncludePath') && providerType === 'claude-offical') {
                const defaultValue = key === 'officialFingerprintIncludePath' ? 'false' : 'true';
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value ?? defaultValue)}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      <option value="true">启用</option>
                      <option value="false">禁用</option>
                    </select>
                  </label>
                );
              }

              if (key === 'officialStickyIdentityMode' && providerType === 'claude-offical') {
                return (
                  <label key={key} className="config-item">
                    <span>{getFieldLabel(key)}</span>
                    <select
                      value={String(value || 'session-or-fingerprint')}
                      onChange={(event) => handleFieldChange(key, event.target.value)}
                      disabled={!editing}
                    >
                      {CLAUDE_OFFICAL_STICKY_IDENTITY_MODE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                );
              }

            const isSensitive = isSensitiveKey(key);
            const normalizedValue = value === null || value === undefined ? '' : String(value);
            const displayValue = editing
              ? normalizedValue
              : (isSensitive ? (normalizedValue ? '********' : '') : normalizedValue);
            return (
              <label key={key} className="config-item">
                  <span>{getFieldLabel(key)}</span>
                  <input
                    type={isSensitive ? 'password' : 'text'}
                    value={displayValue}
                    onChange={(event) => handleFieldChange(key, event.target.value)}
                    disabled={!editing}
                    placeholder={getFieldLabel(key)}
                  />
                  {isOauthPathKey(key) && (
                    <span className="helper-text">可填写 db://oauth/... 引用</span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="config-item full-width">
            <label>
              <i className="fas fa-ban"></i> 不支持的模型
              <span className="helper-text">选择后系统将自动排除</span>
            </label>
            <div className="models-checkbox-grid">
              {models?.length ? (
                models.map((model) => (
                  <label key={model} className="model-checkbox">
                    <input
                      type="checkbox"
                      checked={(draft.notSupportedModels || []).includes(model)}
                      onChange={() => handleModelToggle(model)}
                      disabled={!editing}
                    />
                    <span>{model}</span>
                  </label>
                ))
              ) : (
                <div className="models-loading">暂无模型列表</div>
              )}
            </div>
          </div>

          {editing && (
            <div className="config-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSave}
                disabled={actionLoading === `save-${provider.uuid}`}
              >
                保存
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleToggleEdit}>
                取消
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PoolSelectModal({
  open,
  providerType,
  pools,
  loading,
  onClose,
  onSelectPool,
  onCreatePool,
  onRefresh,
  onConfigModels,
}) {
  const [poolName, setPoolName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setPoolName('');
    setIsDefault(false);
    setError('');
  }, [open]);

  const handleCreate = async () => {
    if (!poolName.trim()) {
      setError('请输入池子名称');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onCreatePool?.({ name: poolName.trim(), isDefault });
      setPoolName('');
      setIsDefault(false);
      if (onRefresh) {
        await onRefresh();
      }
    } catch (err) {
      setError(err?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`${getProviderDisplayName(providerType)} 池子列表`}
      subtitle="选择池子进入账号管理"
      size="lg"
      footer={
        <div className="pool-modal-footer">
          <button className="btn btn-outline btn-sm" onClick={onRefresh} disabled={loading || saving}>
            <i className="fas fa-sync-alt"></i> 刷新
          </button>
          <div className="pool-create-inline">
            <input
              type="text"
              value={poolName}
              onChange={(event) => setPoolName(event.target.value)}
              placeholder="新池子名称"
            />
            <label className="pool-default-toggle">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
              />
              默认池
            </label>
            <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={saving}>
              <i className="fas fa-plus"></i> 新建
            </button>
          </div>
        </div>
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      <div className="pool-list">
        {loading ? (
          <div className="pool-loading">
            <i className="fas fa-spinner fa-spin"></i> 加载池子中...
          </div>
        ) : pools?.length ? (
          pools.map((pool) => {
            const poolUsagePercent = pool.quotaUsagePercent ?? pool.averageUsage;

            return (
              <div key={pool.id} className="pool-entry-wrapper">
                <button
                  className="pool-entry"
                  type="button"
                  onClick={() => onSelectPool?.(pool)}
                >
                  <div className="pool-entry-main">
                    <span className="pool-entry-name">{pool.name || `池子 ${pool.id}`}</span>
                    {pool.isDefault && <span className="pool-entry-tag">默认</span>}
                  </div>
                  <div className="pool-entry-stats">
                    <span>总数 {pool.total ?? 0}</span>
                    <span>健康 {pool.healthy ?? 0}</span>
                    <span>禁用 {pool.disabled ?? 0}</span>
                    <span>总额度占比 {poolUsagePercent !== null && poolUsagePercent !== undefined ? `${poolUsagePercent.toFixed(1)}%` : '--'}</span>
                  </div>
                  <div className="pool-entry-action">
                    进入
                    <i className="fas fa-chevron-right"></i>
                  </div>
                </button>
                <button
                  className="btn btn-outline btn-xs pool-model-config-btn"
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onConfigModels?.(pool); }}
                  title="配置支持的模型"
                >
                  <i className="fas fa-cog"></i> 模型路由
                </button>
              </div>
            );
          })
        ) : (
          <div className="empty-state">暂无池子</div>
        )}
      </div>
    </ModalShell>
  );
}

function PoolModelConfigModal({
  open,
  pool,
  providerType,
  models,
  onClose,
  onSave,
}) {
  const [supportedModels, setSupportedModels] = useState([]);
  const [notSupportedModels, setNotSupportedModels] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pool) {
      setSupportedModels(pool.supportedModels || []);
      setNotSupportedModels(pool.notSupportedModels || []);
    }
  }, [pool]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave?.({
        supportedModels: supportedModels.length > 0 ? supportedModels : null,
        notSupportedModels: notSupportedModels.length > 0 ? notSupportedModels : null,
      });
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  const toggleSupported = (model) => {
    setSupportedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };

  const toggleNotSupported = (model) => {
    setNotSupportedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`模型路由配置 - ${pool?.name || '号池'}`}
      subtitle="配置该号池支持或不支持的模型，实现精细化路由"
      size="md"
    >
      <div className="pool-model-config">
        <div className="config-section">
          <h4><i className="fas fa-check-circle"></i> 支持的模型 (白名单)</h4>
          <p className="helper-text">留空表示支持所有模型</p>
          <div className="models-checkbox-grid">
            {models?.map((model) => (
              <label key={`sup-${model}`} className="model-checkbox">
                <input
                  type="checkbox"
                  checked={supportedModels.includes(model)}
                  onChange={() => toggleSupported(model)}
                />
                <span>{model}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="config-section">
          <h4><i className="fas fa-ban"></i> 不支持的模型 (黑名单)</h4>
          <p className="helper-text">黑名单优先级高于白名单</p>
          <div className="models-checkbox-grid">
            {models?.map((model) => (
              <label key={`not-${model}`} className="model-checkbox">
                <input
                  type="checkbox"
                  checked={notSupportedModels.includes(model)}
                  onChange={() => toggleNotSupported(model)}
                />
                <span>{model}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="config-actions">
          <button className="btn btn-outline btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ProviderDetailModal({
  open,
  providerType,
  poolId,
  poolName,
  poolOptions,
  detail,
  loading,
  error,
  filter,
  page,
  pageSize,
  usageDetail,
  actionLoading,
  onClose,
  onFilterChange,
  onPageChange,
  onRefresh,
  onRefreshUsage,
  onResetHealth,
  onHealthCheck,
  onDeleteUnhealthy,
  onRefreshUnhealthy,
  onBatchUpdateCheckModelName,
  onToggleDisable,
  onRefreshUuid,
  onDeleteProvider,
  onSaveProvider,
  onMovePool,
  onBatchMoveProviders,
}) {
  const [models, setModels] = useState([]);
  const [batchCheckModel, setBatchCheckModel] = useState('');
  const [selectedProviderUuids, setSelectedProviderUuids] = useState(() => new Set());
  const [batchTargetPoolId, setBatchTargetPoolId] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [kiroImportOpen, setKiroImportOpen] = useState(false);
  const usageIndex = useMemo(() => {
    const index = new Map();
    if (usageDetail?.instances?.length) {
      usageDetail.instances.forEach((item) => {
        if (item?.uuid) {
          index.set(item.uuid, item);
        }
      });
    }
    return index;
  }, [usageDetail]);
  const usageSummary = usageDetail?.summary || null;
  const usageThresholds = usageDetail?.thresholds || null;
  const poolOptionsList = Array.isArray(poolOptions) ? poolOptions : [];
  const availableTargetPools = useMemo(
    () => poolOptionsList.filter((pool) => String(pool.id) !== String(poolId ?? '')),
    [poolId, poolOptionsList]
  );
  const pageSelectableUuids = useMemo(
    () => (detail?.providers || [])
      .filter((provider) => !(provider.isDeleted || provider.deleted))
      .map((provider) => provider.uuid)
      .filter(Boolean),
    [detail?.providers]
  );
  const selectedCount = selectedProviderUuids.size;
  const allCurrentPageSelected = pageSelectableUuids.length > 0
    && pageSelectableUuids.every((uuid) => selectedProviderUuids.has(uuid));

  useEffect(() => {
    if (!open) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !providerType) return;
    const loadModels = async () => {
      try {
        const data = await providerService.getTypeModels(providerType);
        setModels(Array.isArray(data) ? data : data?.models || []);
      } catch (err) {
        setModels([]);
      }
    };
    loadModels();
  }, [open, providerType]);

  useEffect(() => {
    setSelectedProviderUuids(new Set());
  }, [open, providerType, poolId, filter]);

  useEffect(() => {
    if (!open) return;
    if (!availableTargetPools.length) {
      setBatchTargetPoolId('');
      return;
    }
    setBatchTargetPoolId((prev) => {
      if (prev && availableTargetPools.some((pool) => String(pool.id) === String(prev))) {
        return prev;
      }
      return String(availableTargetPools[0].id);
    });
  }, [open, availableTargetPools]);

  const handleSelectProvider = (provider, checked) => {
    const uuid = provider?.uuid;
    if (!uuid) return;
    setSelectedProviderUuids((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(uuid);
      } else {
        next.delete(uuid);
      }
      return next;
    });
  };

  const handleToggleSelectCurrentPage = () => {
    setSelectedProviderUuids((prev) => {
      const next = new Set(prev);
      if (allCurrentPageSelected) {
        pageSelectableUuids.forEach((uuid) => next.delete(uuid));
      } else {
        pageSelectableUuids.forEach((uuid) => next.add(uuid));
      }
      return next;
    });
  };

  const handleBatchMoveSelected = async () => {
    if (!selectedCount || !batchTargetPoolId) return;
    const success = await onBatchMoveProviders?.([...selectedProviderUuids], batchTargetPoolId);
    if (success) {
      setSelectedProviderUuids(new Set());
    }
  };

  const totalCount = detail?.totalCount ?? detail?.providers?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <>
      {open && (
        <div className="provider-modal" onClick={onClose}>
          <div className="provider-modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="provider-modal-header">
              <h3>
                <i className="fas fa-cogs"></i>
                {getProviderDisplayName(providerType)} 账号管理
                {poolName && <span className="provider-pool-tag">池子: {poolName}</span>}
              </h3>
              <button className="modal-close" onClick={onClose} aria-label="关闭">
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="provider-modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="provider-summary">
                <div className="provider-summary-left">
                  {totalCount > 0 && (
                    <>
                      <div className="provider-summary-item provider-summary-stat">
                        <span className="label">总数</span>
                        <span className="value">{detail?.totalWithDeleted ?? totalCount ?? 0}</span>
                      </div>
                      <div className="provider-summary-item provider-summary-stat">
                        <span className="label">健康</span>
                        <span className="value text-success">{detail?.healthyCount ?? 0}</span>
                      </div>
                      <div className="provider-summary-item provider-summary-stat">
                        <span className="label">禁用</span>
                        <span className="value text-warning">{detail?.disabledCount ?? 0}</span>
                      </div>
                      <div className="provider-summary-item provider-summary-stat">
                        <span className="label">删除</span>
                        <span className="value text-danger">{detail?.deletedCount ?? 0}</span>
                      </div>
                      {usageSummary?.withUsage > 0 && (
                        <div className="provider-summary-item provider-summary-usage">
                          <span className="label">用量峰值</span>
                          <span className={`value ${getUsageLevel(usageSummary.maxPercent || 0, usageThresholds)}`}>
                            {formatPercent(usageSummary.maxPercent || 0)}
                          </span>
                          <span className="usage-hints">
                            告警 {usageSummary.warningCount ?? 0} · 高压 {usageSummary.criticalCount ?? 0}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="provider-summary-right">
                  <div className="provider-summary-actions">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        const params = new URLSearchParams({
                          providerType,
                          poolId: poolId ?? '',
                          poolName: poolName || '默认池'
                        });
                        window.location.href = `/bad-accounts?${params.toString()}`;
                      }}
                    >
                      <i className="fas fa-exclamation-triangle"></i> 坏号
                    </button>
                    <button className="btn btn-success btn-sm" onClick={() => {
                      if (providerType === 'claude-kiro-oauth') {
                        setKiroImportOpen(true);
                      } else {
                        setAddModalOpen(true);
                      }
                    }}>
                      <i className="fas fa-plus"></i> 添加
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={onRefreshUsage}
                      disabled={actionLoading === 'refresh-usage'}
                    >
                      <i className="fas fa-chart-pie"></i> 用量
                    </button>
                    <button
                      className="btn btn-warning btn-sm"
                      onClick={onResetHealth}
                      disabled={actionLoading === 'reset-health'}
                    >
                      <i className="fas fa-heartbeat"></i> 重置
                    </button>
                    <button
                      className="btn btn-info btn-sm"
                      onClick={onHealthCheck}
                      disabled={actionLoading === 'health-check'}
                    >
                      <i className="fas fa-stethoscope"></i> 检测
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={onRefreshUnhealthy}
                      disabled={actionLoading === 'refresh-unhealthy'}
                    >
                      <i className="fas fa-sync-alt"></i> 刷新
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={onDeleteUnhealthy}
                      disabled={actionLoading === 'delete-unhealthy'}
                    >
                      <i className="fas fa-trash-alt"></i> 删除
                    </button>
                  </div>
                  <div className="provider-summary-item provider-summary-filter">
                    <label className="label">筛选</label>
                    <select value={filter} onChange={(event) => onFilterChange(event.target.value)}>
                      <option value="healthy">健康</option>
                      <option value="unhealthy">异常</option>
                      <option value="disabled">禁用</option>
                      <option value="deleted">已删除</option>
                      <option value="all">全部</option>
                    </select>
                  </div>
                  <div className="provider-summary-batch">
                    <span className="batch-label">批量检查模型</span>
                    <input
                      className="batch-check-model-input"
                      value={batchCheckModel}
                      onChange={(event) => setBatchCheckModel(event.target.value)}
                      placeholder="gpt-6-codex"
                      list="batch-check-models"
                    />
                    <datalist id="batch-check-models">
                      {COMMON_CHECK_MODELS.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => onBatchUpdateCheckModelName(batchCheckModel)}
                      disabled={!batchCheckModel}
                    >
                      <i className="fas fa-check"></i> 更新
                    </button>
                  </div>
                  {availableTargetPools.length > 0 && (
                    <div className="provider-summary-batch provider-summary-batch-move">
                      <span className="batch-label">批量转池</span>
                      <span className="batch-selected-count">已选 {selectedCount} 个</span>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={handleToggleSelectCurrentPage}
                        disabled={!pageSelectableUuids.length}
                      >
                        {allCurrentPageSelected ? '取消本页' : '全选本页'}
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => setSelectedProviderUuids(new Set())}
                        disabled={!selectedCount}
                      >
                        清空
                      </button>
                      <select
                        className="provider-pool-select provider-pool-batch-select"
                        value={batchTargetPoolId}
                        onChange={(event) => setBatchTargetPoolId(event.target.value)}
                      >
                        {availableTargetPools.map((pool) => (
                          <option key={pool.id} value={String(pool.id)}>
                            {pool.name || `池子 ${pool.id}`}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={handleBatchMoveSelected}
                        disabled={!selectedCount || !batchTargetPoolId || actionLoading === 'batch-move-pool'}
                      >
                        <i className="fas fa-right-left"></i> 转移已选
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />

              <div className="provider-accounts">
                {loading ? (
                  <div className="page-loading">
                    <i className="fas fa-spinner fa-spin"></i> 加载账号详情中...
                  </div>
                ) : detail?.providers?.length ? (
                  detail.providers.map((provider) => (
                    <ProviderItem
                      key={provider.uuid}
                      provider={provider}
                      providerType={providerType}
                      models={models}
                      actionLoading={actionLoading}
                      selected={selectedProviderUuids.has(provider.uuid)}
                      onSelectChange={(checked) => handleSelectProvider(provider, checked)}
                      onToggleDisable={onToggleDisable}
                      onRefreshUuid={onRefreshUuid}
                      onDelete={onDeleteProvider}
                      onSave={onSaveProvider}
                      poolOptions={poolOptions}
                      onMovePool={onMovePool}
                      usageSummary={usageIndex.get(provider.uuid)?.usageSummary || null}
                      usageError={usageIndex.get(provider.uuid)?.error || null}
                    />
                  ))
                ) : (
                  <div className="empty-state">暂无账号数据</div>
                )}
              </div>

              <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
            </div>
          </div>
        </div>
      )}

      <AddProviderModal
        open={addModalOpen}
        providerType={providerType}
        poolId={poolId}
        onClose={() => setAddModalOpen(false)}
        onSuccess={onRefresh}
      />

      {providerType === 'claude-kiro-oauth' && (
        <KiroAwsImportModal
          open={kiroImportOpen}
          poolId={poolId}
          onClose={() => setKiroImportOpen(false)}
          onSuccess={() => {
            setKiroImportOpen(false);
            onRefresh?.();
          }}
        />
      )}
    </>
  );
}

export default function Providers() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState({});
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [allProviders, setAllProviders] = useState(null);
  const [allProvidersLoading, setAllProvidersLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFallbackTypes, setDetailFallbackTypes] = useState(() => new Set());
  const [selectedType, setSelectedType] = useState('');
  const [selectedPoolId, setSelectedPoolId] = useState(null);
  const [selectedPoolName, setSelectedPoolName] = useState('');
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [detailFilter, setDetailFilter] = useState('healthy');
  const [detailPage, setDetailPage] = useState(1);
  const [detailPageSize] = useState(5);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [usageSnapshot, setUsageSnapshot] = useState(null);
  const [usageSummaryLoading, setUsageSummaryLoading] = useState(false);
  const [usageDetailMap, setUsageDetailMap] = useState({});
  const [poolModalOpen, setPoolModalOpen] = useState(false);
  const [poolModalType, setPoolModalType] = useState('');
  const [poolListMap, setPoolListMap] = useState({});
  const [poolLoading, setPoolLoading] = useState(false);
  const [modelConfigModal, setModelConfigModal] = useState(null);
  const [models, setModels] = useState([]);

  const [authModal, setAuthModal] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [batchOperationModal, setBatchOperationModal] = useState(false);
  const [codexBatchAuth, setCodexBatchAuth] = useState(null); // { running, authUrl, successCount, emails }
  const [providerListFilter, setProviderListFilter] = useState('with-accounts');

  const providerTypes = useMemo(() => {
    const existing = Object.keys(summary || {});
    const merged = [...new Set([...PROVIDER_DISPLAY_ORDER, ...existing])]
      .filter((type) => !OSS_HIDDEN_PROVIDERS.has(type));
    return sortProviderTypes(merged);
  }, [summary]);

  const usageSummaryMap = useMemo(() => {
    const providers = usageSnapshot?.providers || {};
    return Object.entries(providers).reduce((acc, [type, data]) => {
      if (data?.summary) {
        acc[type] = data.summary;
      }
      return acc;
    }, {});
  }, [usageSnapshot]);

  const providerListStats = useMemo(() => {
    return providerTypes.reduce((acc, type) => {
      const summaryEntry = summary?.[type] || {};
      const providerCount = Array.isArray(allProviders?.[type]) ? allProviders[type].length : null;
      const totalWithDeleted = summaryEntry.totalWithDeleted
        ?? summaryEntry.total
        ?? providerCount
        ?? 0;
      const hasAccounts = providerCount !== null
        ? providerCount > 0
        : totalWithDeleted > 0
          || (summaryEntry.deleted ?? 0) > 0
          || (summaryEntry.healthy ?? 0) > 0
          || (summaryEntry.disabled ?? 0) > 0;
      acc[type] = { totalWithDeleted, hasAccounts };
      return acc;
    }, {});
  }, [allProviders, providerTypes, summary]);

  const withAccountsProviderTypes = useMemo(() => {
    if (summaryLoading && !allProviders) {
      return providerTypes;
    }
    return providerTypes.filter((type) => providerListStats[type]?.hasAccounts);
  }, [allProviders, providerListStats, providerTypes, summaryLoading]);

  const visibleProviderTypes = providerListFilter === 'with-accounts'
    ? withAccountsProviderTypes
    : providerTypes;

  const totalStats = useMemo(() => {
    let totalUsagePercent = 0;
    let totalWithUsage = 0;
    let totalUsed = 0;
    let totalLimit = 0;

    const stats = providerTypes.reduce(
      (acc, type) => {
        const stats = getSummaryStats(summary, type);
        const usageSummary = usageSummaryMap[type] || null;
        const usagePercent = usageSummary?.quotaUsagePercent ?? usageSummary?.avgPercent ?? usageSummary?.maxPercent ?? 0;
        const hasUsage = (usageSummary?.withUsage || 0) > 0;
        const summaryUsed = Number(usageSummary?.totalUsed);
        const summaryLimit = Number(usageSummary?.totalLimit);

        if (Number.isFinite(summaryLimit) && summaryLimit > 0) {
          totalUsed += Number.isFinite(summaryUsed) ? Math.max(0, summaryUsed) : 0;
          totalLimit += summaryLimit;
        } else if (hasUsage) {
          totalUsagePercent += usagePercent;
          totalWithUsage++;
        }

        acc.total += stats.total;
        acc.healthy += stats.healthy;
        acc.disabled += stats.disabled;
        acc.deleted += stats.deleted;
        return acc;
      },
      { total: 0, healthy: 0, disabled: 0, deleted: 0 }
    );

    stats.avgUsagePercent = totalLimit > 0
      ? Math.max(0, Math.min(100, (totalUsed / totalLimit) * 100))
      : totalWithUsage > 0
        ? totalUsagePercent / totalWithUsage
        : 0;
    stats.usageLevel = getUsageLevel(stats.avgUsagePercent, usageSnapshot?.thresholds || null);

    return stats;
  }, [providerTypes, summary, usageSummaryMap, usageSnapshot]);

  const selectedUsageDetail = selectedType ? usageDetailMap[selectedType] : null;

  const fetchSummary = async () => {
    try {
      setSummaryLoading(true);
      setError('');
      const data = await providerService.getSummary();
      setSummary(data || {});
    } catch (fetchError) {
      console.error('Failed to fetch provider summary:', fetchError);
      const providerPools = await fetchAllProviders();
      if (providerPools) {
        const fallbackSummary = Object.entries(providerPools).reduce((acc, [type, providers]) => {
          const activeProviders = providers.filter((provider) => !provider.isDeleted);
          const healthy = activeProviders.filter((provider) => provider.isHealthy && !provider.isDisabled).length;
          const disabled = activeProviders.filter((provider) => provider.isDisabled).length;
          const unhealthy = activeProviders.filter((provider) => !provider.isHealthy && !provider.isDisabled).length;
          acc[type] = {
            total: activeProviders.length,
            totalWithDeleted: providers.length,
            enabled: activeProviders.filter((provider) => !provider.isDisabled).length,
            healthy,
            unhealthy,
            disabled,
            deleted: providers.filter((provider) => provider.isDeleted).length,
          };
          return acc;
        }, {});
        setSummary(fallbackSummary);
        setError('');
      } else {
        setError('加载提供商统计失败');
      }
    } finally {
      setSummaryLoading(false);
    }
  };

  const fetchUsageSummary = async (options = {}) => {
    if (usageSummaryLoading) {
      return usageSnapshot;
    }
    try {
      setUsageSummaryLoading(true);
      const data = await usageService.getAll({
        refresh: options.refresh,
        cacheOnly: options.cacheOnly,
      });
      setUsageSnapshot(data || null);
      return data;
    } catch (fetchError) {
      console.error('Failed to fetch usage summary:', fetchError);
      return null;
    } finally {
      setUsageSummaryLoading(false);
    }
  };

  const fetchUsageDetail = async (providerType, options = {}) => {
    if (!providerType) return null;
    try {
      const data = await usageService.getByType(providerType, {
        refresh: options.refresh,
        cacheOnly: options.cacheOnly,
      });
      setUsageDetailMap((prev) => ({ ...prev, [providerType]: data }));
      setUsageSnapshot((prev) => {
        const base = prev || {
          timestamp: data?.cachedAt || data?.timestamp || null,
          thresholds: data?.thresholds || null,
          providers: {}
        };
        return {
          ...base,
          providers: {
            ...(base.providers || {}),
            [providerType]: data,
          },
        };
      });
      return data;
    } catch (fetchError) {
      console.error('Failed to fetch provider usage:', fetchError);
      return null;
    }
  };

  const buildProviderPoolMap = (providerList) => {
    if (!Array.isArray(providerList)) {
      return providerList || {};
    }
    return providerList.reduce((acc, provider) => {
      const providerType = provider.providerType || provider.provider_type || provider.type;
      if (!providerType) {
        return acc;
      }
      if (!acc[providerType]) {
        acc[providerType] = [];
      }
      acc[providerType].push(provider);
      return acc;
    }, {});
  };

  const fetchAllProviders = async () => {
    if (allProvidersLoading) {
      return allProviders;
    }
    if (allProviders) {
      return allProviders;
    }
    try {
      setAllProvidersLoading(true);
      const data = await providerService.getAll();
      const list = Array.isArray(data?.providers) ? data.providers : data;
      const normalized = buildProviderPoolMap(list);
      setAllProviders(normalized);
      return normalized;
    } catch (fetchError) {
      console.error('Failed to fetch provider list:', fetchError);
      return null;
    } finally {
      setAllProvidersLoading(false);
    }
  };

  const getPoolsForType = (type) => {
    if (!type) return [];
    return poolListMap[type] || [];
  };

  const fetchPoolsForType = async (type, options = {}) => {
    if (!type) return [];
    if (!options.refresh && poolListMap[type]) {
      return poolListMap[type];
    }
    try {
      setPoolLoading(true);
      const data = await providerService.getPools(type);
      const pools = Array.isArray(data) ? data : data?.data || [];
      setPoolListMap((prev) => ({ ...prev, [type]: pools }));
      return pools;
    } catch (fetchError) {
      console.error('Failed to fetch pool list:', fetchError);
      return [];
    } finally {
      setPoolLoading(false);
    }
  };

  const buildFallbackDetail = (providerType, options, providerPools) => {
    if (!providerPools) return null;
    let providers = providerPools[providerType] || [];
    const poolId = options?.poolId ?? null;
    if (poolId !== null && poolId !== undefined) {
      const normalizedPoolId = Number.parseInt(poolId, 10);
      if (Number.isFinite(normalizedPoolId)) {
        providers = providers.filter((provider) => {
          const providerPoolId = provider.poolId ?? provider.pool_id ?? null;
          if (normalizedPoolId === 0) {
            return providerPoolId === null || providerPoolId === 0;
          }
          return providerPoolId === normalizedPoolId;
        });
      }
    }
    const filter = options?.filter || 'all';
    const page = Number.isFinite(options?.page) && options.page > 0 ? options.page : 1;
    const pageSize = Number.isFinite(options?.pageSize) && options.pageSize > 0 ? options.pageSize : providers.length;
    const filtered = providers.filter((provider) => {
      const isDeleted = Boolean(provider.isDeleted);
      const isDisabled = Boolean(provider.isDisabled);
      const isHealthy = Boolean(provider.isHealthy);
      if (filter === 'healthy') {
        return isHealthy && !isDisabled && !isDeleted;
      }
      if (filter === 'unhealthy') {
        return !isHealthy && !isDeleted;
      }
      if (filter === 'disabled') {
        return isDisabled && !isDeleted;
      }
      if (filter === 'deleted') {
        return isDeleted;
      }
      return true;
    });

    const offset = (page - 1) * pageSize;
    const pagedProviders = filtered.slice(offset, offset + pageSize);
    const healthyCount = summary?.[providerType]?.healthy ?? providers.filter((p) => p.isHealthy && !p.isDisabled && !p.isDeleted).length;
    const disabledCount = summary?.[providerType]?.disabled ?? providers.filter((p) => p.isDisabled && !p.isDeleted).length;
    const deletedCount = summary?.[providerType]?.deleted ?? providers.filter((p) => p.isDeleted).length;
    const totalCount = filtered.length;
    const totalWithDeleted = summary?.[providerType]?.totalWithDeleted
      ?? summary?.[providerType]?.total
      ?? providers.length;

    return {
      providerType,
      providers: pagedProviders,
      totalCount,
      healthyCount,
      disabledCount,
      deletedCount,
      totalWithDeleted,
      page,
      pageSize,
      fallback: true,
    };
  };

  const buildSummaryOnlyDetail = (providerType, options) => {
    const summaryEntry = summary?.[providerType] || {};
    const page = Number.isFinite(options?.page) && options.page > 0 ? options.page : 1;
    const pageSize = Number.isFinite(options?.pageSize) && options.pageSize > 0 ? options.pageSize : 5;
    return {
      providerType,
      providers: [],
      totalCount: 0,
      healthyCount: summaryEntry.healthy ?? 0,
      disabledCount: summaryEntry.disabled ?? 0,
      deletedCount: summaryEntry.deleted ?? 0,
      totalWithDeleted: summaryEntry.totalWithDeleted ?? summaryEntry.total ?? 0,
      page,
      pageSize,
      fallback: true,
    };
  };

  const fetchProviderDetail = async (type, options = {}) => {
    if (!type) return;
    setDetailLoading(true);
    const poolId = options.poolId ?? selectedPoolId;
    if (detailFallbackTypes.has(type)) {
      const providerPools = await fetchAllProviders();
      const fallbackDetail = buildFallbackDetail(type, { ...options, poolId }, providerPools);
      if (fallbackDetail) {
        setSelectedDetail(fallbackDetail);
        setError('');
      } else {
        const summaryOnly = buildSummaryOnlyDetail(type, options);
        if (summaryOnly.totalWithDeleted > 0) {
          setSelectedDetail(summaryOnly);
          setError('');
        } else {
          setError('加载提供商详情失败');
        }
      }
      setDetailLoading(false);
      return;
    }
    try {
      setError('');
      const data = await providerService.getByType(type, { ...options, poolId });
      setSelectedDetail(data || null);
    } catch (fetchError) {
      console.error('Failed to fetch provider detail:', fetchError);
      setDetailFallbackTypes((prev) => {
        const next = new Set(prev);
        next.add(type);
        return next;
      });
      const providerPools = await fetchAllProviders();
      const fallbackDetail = buildFallbackDetail(type, { ...options, poolId }, providerPools);
      if (fallbackDetail) {
        setSelectedDetail(fallbackDetail);
        setError('');
      } else {
        const summaryOnly = buildSummaryOnlyDetail(type, options);
        if (summaryOnly.totalWithDeleted > 0) {
          setSelectedDetail(summaryOnly);
          setError('');
        } else {
          setError('加载提供商详情失败');
        }
      }
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshAll = async (type = selectedType) => {
    await fetchSummary();
    await fetchUsageSummary({ cacheOnly: true });
    if (type) {
      await fetchProviderDetail(type, {
        filter: detailFilter,
        page: detailPage,
        pageSize: detailPageSize,
        poolId: selectedPoolId,
      });
      await fetchUsageDetail(type, { cacheOnly: true });
    }
  };

  useEffect(() => {
    fetchSummary();
    fetchUsageSummary({ cacheOnly: true });
    fetchAllProviders();
  }, []);

  useEffect(() => {
    if (selectedType) {
      fetchProviderDetail(selectedType, {
        filter: detailFilter,
        page: detailPage,
        pageSize: detailPageSize,
        poolId: selectedPoolId,
      });
    }
  }, [selectedType, detailFilter, detailPage, selectedPoolId]);

  useEffect(() => {
    if (!selectedType) return;
    // 只加载缓存数据，不自动刷新
    // 用户需要刷新时可以手动点击刷新按钮
    fetchUsageDetail(selectedType, { cacheOnly: true });
  }, [selectedType]);

  useEffect(() => {
    if (!modelConfigModal?.providerType) {
      setModels([]);
      return;
    }
    const loadModels = async () => {
      try {
        const data = await providerService.getTypeModels(modelConfigModal.providerType);
        setModels(Array.isArray(data) ? data : data?.models || []);
      } catch (err) {
        setModels([]);
      }
    };
    loadModels();
  }, [modelConfigModal?.providerType]);

  const openPoolModal = async (type) => {
    setPoolModalType(type);
    setPoolModalOpen(true);
    await fetchPoolsForType(type, { refresh: true });
  };

  const resolvePoolSelection = (type, pool) => {
    if (pool) return pool;
    const pools = getPoolsForType(type);
    if (pools.length) {
      return pools.find((item) => item.isDefault) || pools[0];
    }
    return { id: 0, name: '默认池' };
  };

  const openProviderModal = async (type, pool) => {
    await fetchPoolsForType(type);
    const resolvedPool = resolvePoolSelection(type, pool);
    setSelectedPoolId(resolvedPool?.id ?? 0);
    setSelectedPoolName(resolvedPool?.name || '默认池');
    setSelectedType(type);
    setDetailFilter('healthy');
    setDetailPage(1);
    setSelectedDetail(null);
    setError('');
  };

  const handleSelectPool = async (pool) => {
    const type = poolModalType;
    setPoolModalOpen(false);
    if (type) {
      await openProviderModal(type, pool);
    }
  };

  const handleCreatePool = async ({ name, isDefault }) => {
    if (!poolModalType) return;
    await providerService.createPool({ providerType: poolModalType, name, isDefault });
    await fetchPoolsForType(poolModalType, { refresh: true });
  };

  const handleTypeAction = async (actionKey, actionFn) => {
    if (!selectedType) return;
    try {
      setActionLoading(actionKey);
      await actionFn();
      await refreshAll(selectedType);
    } catch (actionError) {
      console.error('Provider action failed:', actionError);
      setError(actionError?.message || '操作失败');
    } finally {
      setActionLoading('');
    }
  };

  const handleResetHealth = () => {
    handleTypeAction('reset-health', () => providerService.resetHealth(selectedType));
  };

  const handleBatchOperation = async (operation, progressCallback) => {
    try {
      progressCallback(0, 1, '准备执行...');

      if (operation === 'refresh-usage') {
        progressCallback(0, 1, '正在刷新用量...');
        await fetchUsageDetail(selectedType, { refresh: true });
        await fetchUsageSummary({ refresh: true });
      } else if (operation === 'health-check') {
        progressCallback(0, 1, '正在执行健康检查...');
        await providerService.healthCheck(selectedType);
      } else if (operation === 'extract-emails') {
        progressCallback(0, 1, '正在从 accessToken 提取邮箱...');
        await providerService.batchExtractEmails(selectedType);
      }

      progressCallback(1, 1, '执行完成');
      await refreshAll(selectedType);
    } catch (error) {
      throw error;
    }
  };

  const handleHealthCheck = () => {
    console.log('[DEBUG] handleHealthCheck called, opening batch operation modal');
    console.log('[DEBUG] batchOperationModal state before:', batchOperationModal);
    setBatchOperationModal(true);
    console.log('[DEBUG] setBatchOperationModal(true) called');
  };

  const handleStartCodexBatchAuth = async () => {
    try {
      const result = await providerService.codexBatchStart({ poolId: undefined });
      if (result?.success || result?.authUrl) {
        setCodexBatchAuth({
          running: true,
          authUrl: result.authUrl,
          port: result.port,
          successCount: 0,
          emails: []
        });
      } else {
        alert(result?.error || '启动批量授权失败');
      }
    } catch (err) {
      alert('启动批量授权失败: ' + (err.message || err));
    }
  };

  const handleStopCodexBatchAuth = async () => {
    try {
      const result = await providerService.codexBatchStop();
      setCodexBatchAuth(null);
      await refreshAll('openai-codex');
      if (result?.successCount > 0) {
        alert(`批量授权已停止，共成功 ${result.successCount} 个`);
      }
    } catch (err) {
      setCodexBatchAuth(null);
    }
  };

  const handleRefreshUsage = () => {
    handleTypeAction('refresh-usage', async () => {
      await fetchUsageDetail(selectedType, { refresh: true });
      await fetchUsageSummary({ refresh: true });
    });
  };

  const handleDeleteUnhealthy = () => {
    if (!confirm(`确定要删除 ${getProviderDisplayName(selectedType)} 的所有不健康账号吗？`)) return;
    handleTypeAction('delete-unhealthy', () => providerService.deleteUnhealthy(selectedType));
  };

  const handleRefreshUnhealthy = () => {
    if (!confirm(`确定要刷新 ${getProviderDisplayName(selectedType)} 的不健康 UUID 吗？`)) return;
    handleTypeAction('refresh-unhealthy', () => providerService.refreshUnhealthyUuids(selectedType));
  };

  const handleBatchUpdateCheckModelName = (checkModelName) => {
    if (!checkModelName) return;
    handleTypeAction('batch-check-model', () =>
      providerService.batchUpdateCheckModelName(selectedType, checkModelName)
    );
  };

  const handleToggleDisable = async (provider) => {
    if (!selectedType || !provider?.uuid) return;
    const isDisabled = provider.isDisabled || provider.disabled;
    const label = isDisabled ? '启用' : '禁用';
    if (!confirm(`确定要${label}该账号吗？`)) return;

    try {
      setActionLoading(`toggle-${provider.uuid}`);
      if (isDisabled) {
        await providerService.enable(selectedType, provider.uuid);
      } else {
        await providerService.disable(selectedType, provider.uuid);
      }
      await refreshAll(selectedType);
    } catch (actionError) {
      console.error('Failed to toggle provider:', actionError);
      setError(actionError?.message || `${label}失败`);
    } finally {
      setActionLoading('');
    }
  };

  const handleRefreshUuid = async (provider) => {
    if (!selectedType || !provider?.uuid) return;
    try {
      setActionLoading(`refresh-${provider.uuid}`);
      await providerService.refreshUuid(selectedType, provider.uuid);
      await refreshAll(selectedType);
    } catch (actionError) {
      console.error('Failed to refresh uuid:', actionError);
      setError(actionError?.message || '刷新 UUID 失败');
    } finally {
      setActionLoading('');
    }
  };

  const handleDeleteProvider = async (provider) => {
    if (!selectedType || !provider?.uuid) return;
    if (!confirm('确定要删除该账号吗？')) return;
    try {
      setActionLoading(`delete-${provider.uuid}`);
      const response = await providerService.delete(selectedType, provider.uuid);
      if (response?.success === false) {
        throw new Error(response?.error?.message || response?.message || '删除失败');
      }
      await refreshAll(selectedType);
    } catch (actionError) {
      console.error('Failed to delete provider:', actionError);
      setError(actionError?.message || '删除失败');
    } finally {
      setActionLoading('');
    }
  };

  const handleSaveProvider = async (uuid, draftConfig, onDone) => {
    if (!selectedType || !uuid) return;
    try {
      setActionLoading(`save-${uuid}`);
      const payload = {
        ...draftConfig,
        checkHealth: draftConfig.checkHealth === true || draftConfig.checkHealth === 'true',
      };
      await providerService.update(selectedType, uuid, { providerConfig: payload });
      await refreshAll(selectedType);
      onDone?.();
    } catch (actionError) {
      console.error('Failed to save provider:', actionError);
      setError(actionError?.message || '保存失败');
    } finally {
      setActionLoading('');
    }
  };

  const handleMovePool = async (provider, nextPoolId) => {
    if (!selectedType || !provider?.uuid) return;
    try {
      setActionLoading(`pool-${provider.uuid}`);
      await providerService.update(selectedType, provider.uuid, {
        providerConfig: {},
        poolId: nextPoolId,
      });
      await refreshAll(selectedType);
    } catch (actionError) {
      console.error('Failed to move pool:', actionError);
      setError(actionError?.message || '移动池子失败');
    } finally {
      setActionLoading('');
    }
  };

  const handleBatchMoveToPool = async (uuids, targetPoolId) => {
    if (!selectedType || !Array.isArray(uuids) || uuids.length === 0) return false;
    try {
      setActionLoading('batch-move-pool');
      const response = await providerService.batchMoveToPool(selectedType, { uuids, targetPoolId });
      if (response?.success === false) {
        throw new Error(response?.error?.message || response?.message || '批量转池失败');
      }
      await refreshAll(selectedType);
      return true;
    } catch (actionError) {
      console.error('Failed to batch move providers:', actionError);
      setError(actionError?.message || '批量转池失败');
      return false;
    } finally {
      setActionLoading('');
    }
  };

  const handleAuthAction = async (providerType, action) => {
    setError('');
    if (action === 'windsurf-email-import') {
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      setAuthModal({
        type: 'windsurf-email-import',
        providerType,
        poolId: defaultPool?.id,
      });
      return;
    }
    if (action === 'openai-import') {
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      if (providerType === 'openai-windsurf') {
        setAuthModal({
          type: 'api-import',
          providerType,
          title: '添加 WindsurfAPI 节点',
          apiLabel: 'API Key (留空则不填)',
          configKey: 'WINDSURF_API_KEY',
          baseUrlKey: 'WINDSURF_BASE_URL',
          baseUrlDefault: 'http://localhost:3003/v1',
          poolId: defaultPool?.id,
        });
        return;
      }
      setAuthModal({
        type: 'api-import',
        providerType,
        title: '导入 OpenAI API Key',
        apiLabel: 'OpenAI API Key',
        configKey: 'OPENAI_API_KEY',
        baseUrlKey: 'OPENAI_BASE_URL',
        baseUrlDefault: 'https://api.openai.com/v1',
        poolId: defaultPool?.id,
      });
      return;
    }
    if (action === 'claude-import') {
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      setAuthModal({
        type: 'api-import',
        providerType,
        title: '导入 Claude API Key',
        apiLabel: 'Claude API Key',
        configKey: 'CLAUDE_API_KEY',
        baseUrlKey: 'CLAUDE_BASE_URL',
        baseUrlDefault: 'https://api.anthropic.com',
        poolId: defaultPool?.id,
      });
      return;
    }
    if (action === 'orchids-import') {
      setAuthModal({ type: 'orchids-import' });
      return;
    }
    if (action === 'ami-import') {
      setAuthModal({ type: 'ami-import' });
      return;
    }
    if (action === 'warp-import') {
      setAuthModal({ type: 'warp-import' });
      return;
    }
    if (action === 'droid-method') {
      setAuthModal({ type: 'droid-method' });
      return;
    }
    if (action === 'kiro-method') {
      setAuthModal({ type: 'kiro-method' });
      return;
    }
    if (action === 'codex-json-import') {
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      setAuthModal({
        type: 'codex-json-import',
        providerType,
        poolId: defaultPool?.id,
      });
      return;
    }
    if (action === 'xai-import') {
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      setAuthModal({
        type: 'xai-import',
        providerType,
        poolId: defaultPool?.id,
      });
      return;
    }
    if (action === 'xai-register') {
      navigate('/providers/openai-xai-oauth/register');
      return;
    }
    if (action === 'oauth-host') {
      setAuthModal({ type: 'oauth-host', providerType });
      return;
    }
    if (action === 'oauth-direct') {
      await handleGenerateAuthUrl(providerType, {});
      return;
    }
    if (action === 'claude-offical-method') {
      setAuthModal({ type: 'claude-offical-method' });
      return;
    }
    if (action === 'claude-offical-oauth') {
      await handleGenerateAuthUrl(providerType, {});
      return;
    }
    if (action === 'claude-offical-setup-token') {
      await handleGenerateAuthUrl(providerType, { authMode: 'setup-token' });
      return;
    }
    if (action === 'claude-offical-cookie-oauth') {
      setAuthModal({ type: 'claude-offical-cookie', providerType, authMode: 'oauth' });
      return;
    }
    if (action === 'claude-offical-cookie-setup-token') {
      setAuthModal({ type: 'claude-offical-cookie', providerType, authMode: 'setup-token' });
    }
  };

  const handleClaudeOfficialCookieOAuth = async ({ sessionKey, authMode, poolId }) => {
    try {
      setAuthLoading(true);
      const response = await providerService.claudeOfficialCookieOAuth({
        sessionKey,
        authMode,
        poolId,
      });
      if (response?.success === false) {
        throw new Error(response?.error || 'Cookie 自动授权失败');
      }
      setAuthModal(null);
      await refreshAll('claude-offical');
    } catch (err) {
      setError(err.message || 'Cookie 自动授权失败');
      throw err;
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGenerateAuthUrl = async (providerType, options) => {
    try {
      setAuthLoading(true);
      const pools = await fetchPoolsForType(providerType);
      const defaultPool = Array.isArray(pools) ? (pools.find((pool) => pool.isDefault) || pools[0]) : null;
      const resolvedOptions = {
        ...options,
        poolId: options?.poolId !== undefined ? options.poolId : (defaultPool?.id ?? undefined),
      };
      const response = await providerService.generateAuthUrl(providerType, resolvedOptions);
      if (response?.success === false) {
        throw new Error(response?.error || '生成授权失败');
      }
      if (!response?.authUrl && response?.authInfo?.method === 'cookie-auto-oauth') {
        await refreshAll(providerType);
        setAuthModal(null);
        return;
      }
      setAuthModal({
        type: 'auth-url',
        providerType,
        authUrl: response?.authUrl,
        authInfo: {
          ...response?.authInfo,
          provider: response?.authInfo?.provider || providerType,
        },
      });
    } catch (err) {
      setError(err.message || '生成授权失败');
    } finally {
      setAuthLoading(false);
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
    await refreshAll();
  };

  useEffect(() => {
    if (authModal?.type !== 'auth-url') return;
    if (!authModal?.providerType) return;
    fetchPoolsForType(authModal.providerType);
  }, [authModal, fetchPoolsForType]);

  return (
    <div className="providers-page">
      <div className="providers-header">
        <div>
          <h1>渠道管理</h1>
          <p className="providers-subtitle">渠道 → 号池 → 账号 三级管理，支持健康检查与批量维护</p>
        </div>
        <div className="providers-actions">
          <button
            className="btn btn-outline"
            onClick={() => refreshAll()}
            disabled={summaryLoading || usageSummaryLoading}
          >
            <i className="fas fa-sync-alt"></i>
            刷新数据
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="stats-grid stats-grid-5">
        <div className="stat-card">
          <div className="stat-icon stat-icon-primary">
            <i className="fas fa-database"></i>
          </div>
          <div className="stat-info">
            <h3>{summaryLoading ? '--' : totalStats.total}</h3>
            <p>总数</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-success">
            <i className="fas fa-check-circle"></i>
          </div>
          <div className="stat-info">
            <h3>{summaryLoading ? '--' : totalStats.healthy}</h3>
            <p>健康</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-warning">
            <i className="fas fa-ban"></i>
          </div>
          <div className="stat-info">
            <h3>{summaryLoading ? '--' : totalStats.disabled}</h3>
            <p>禁用</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-danger">
            <i className="fas fa-trash-alt"></i>
          </div>
          <div className="stat-info">
            <h3>{summaryLoading ? '--' : totalStats.deleted}</h3>
            <p>删除</p>
          </div>
        </div>
        <div className="stat-card">
          <div className={`stat-icon stat-icon-${totalStats.usageLevel === 'critical' ? 'danger' : totalStats.usageLevel === 'warning' ? 'warning' : 'success'}`}>
            <i className={`fas fa-battery-${totalStats.usageLevel === 'critical' ? 'empty' : totalStats.usageLevel === 'warning' ? 'half' : 'full'}`}></i>
          </div>
          <div className="stat-info">
            <h3 className={totalStats.usageLevel === 'critical' ? 'text-danger' : totalStats.usageLevel === 'warning' ? 'text-warning' : 'text-success'}>
              {summaryLoading ? '--' : formatPercent(totalStats.avgUsagePercent || 0)}
            </h3>
            <p>用量</p>
          </div>
        </div>
      </div>

      <div className="providers-toolbar">
        <div className="provider-filter-tabs" role="tablist" aria-label="渠道筛选">
          <button
            className={`provider-filter-tab ${providerListFilter === 'with-accounts' ? 'active' : ''}`}
            onClick={() => setProviderListFilter('with-accounts')}
            type="button"
          >
            <span>有账号</span>
            <span className="provider-filter-count">{withAccountsProviderTypes.length}</span>
          </button>
          <button
            className={`provider-filter-tab ${providerListFilter === 'all' ? 'active' : ''}`}
            onClick={() => setProviderListFilter('all')}
            type="button"
          >
            <span>全部</span>
            <span className="provider-filter-count">{providerTypes.length}</span>
          </button>
        </div>
        <div className="provider-filter-meta">
          当前显示 {visibleProviderTypes.length} / {providerTypes.length} 个渠道
        </div>
      </div>

      <div className="providers-container">
        {visibleProviderTypes.length === 0 ? (
          <div className="providers-empty-state">
            <i className="fas fa-inbox"></i>
            <span>当前没有包含账号的渠道</span>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={() => setProviderListFilter('all')}
            >
              查看全部
            </button>
          </div>
        ) : (
        <div className="providers-list">
          {visibleProviderTypes.map((type) => {
            const stats = getSummaryStats(summary, type);
            const authAction = getAuthAction(type);
            const extraAuthActions = getExtraAuthActions(type);
            const usageSummary = usageSummaryMap[type] || null;
            const usageThresholds = usageSnapshot?.thresholds || null;
            const usagePercent = usageSummary?.quotaUsagePercent ?? usageSummary?.avgPercent ?? usageSummary?.maxPercent ?? 0;
            const hasUsage = (usageSummary?.withUsage || 0) > 0;
            const usageLevel = getUsageLevel(usagePercent, usageThresholds);
            const supportsUsage = USAGE_SUPPORTED_TYPES.has(type);
            const usageDisplay = supportsUsage
              ? (hasUsage ? Math.round(usagePercent).toString() : '0')
              : '-';
            const usageClass = supportsUsage
              ? `stat-value stat-usage-${usageLevel}`
              : 'stat-value stat-usage-empty';
            const queueLockSummary = getOfficialQueueLockSummary(allProviders || {}, type);
            return (
              <div
                key={type}
                className={`provider-item ${selectedType === type ? 'active' : ''}`}
                onClick={() => navigate(`/providers/${type}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    navigate(`/providers/${type}`);
                  }
                }}
              >
                <div className="provider-header">
                  <div className="provider-name">
                    {getProviderIcon(type) && (
                      <img src={getProviderIcon(type)} alt="" className="provider-logo" />
                    )}
                    <span className="provider-type-text">{getProviderDisplayName(type)}</span>
                  </div>
                  <div className="provider-header-right">
                    {authAction && (
                      <button
                        className={`auth-action-btn auth-${authAction.variant}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAuthAction(type, authAction.action);
                        }}
                      >
                        <i className={`fas ${authAction.icon}`}></i>
                        <span>{authAction.label}</span>
                      </button>
                    )}
                    {extraAuthActions.map((item) => (
                      <button
                        key={`${type}-${item.action}`}
                        className={`auth-action-btn auth-${item.variant}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAuthAction(type, item.action);
                        }}
                      >
                        <i className={`fas ${item.icon}`}></i>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className={`provider-stats-row ${queueLockSummary ? 'has-queue-lock' : ''}`}>
                  <span className="stat-item">
                    <span className="stat-label">总数</span>
                    <span className="stat-value">{stats.total}</span>
                  </span>
                  <span className="stat-item">
                    <span className="stat-label">健康</span>
                    <span className="stat-value stat-healthy">{stats.healthy}</span>
                  </span>
                  <span className="stat-item">
                    <span className="stat-label">禁用</span>
                    <span className="stat-value stat-disabled">{stats.disabled}</span>
                  </span>
                  <span className="stat-item">
                    <span className="stat-label">删除</span>
                    <span className="stat-value stat-deleted">{stats.deleted}</span>
                  </span>
                  <span className="stat-item">
                    <span className="stat-label">用量</span>
                    <span className={usageClass}>{usageDisplay}</span>
                  </span>
                  {queueLockSummary && (
                    <span className="stat-item">
                      <span className="stat-label">队列锁</span>
                      <span className={queueLockSummary.className}>{queueLockSummary.label}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      <PoolSelectModal
        open={poolModalOpen}
        providerType={poolModalType}
        pools={getPoolsForType(poolModalType)}
        loading={poolLoading}
        onClose={() => setPoolModalOpen(false)}
        onSelectPool={handleSelectPool}
        onCreatePool={handleCreatePool}
        onRefresh={() => fetchPoolsForType(poolModalType, { refresh: true })}
        onConfigModels={(pool) => {
          setModelConfigModal({ pool, providerType: poolModalType });
        }}
      />

      <ProviderDetailModal
        open={Boolean(selectedType)}
        providerType={selectedType}
        poolId={selectedPoolId}
        poolName={selectedPoolName}
        poolOptions={getPoolsForType(selectedType)}
        detail={selectedDetail}
        loading={detailLoading}
        error={error}
        filter={detailFilter}
        page={detailPage}
        pageSize={detailPageSize}
        usageDetail={selectedUsageDetail}
        actionLoading={actionLoading}
        onClose={() => {
          setSelectedType('');
          setSelectedPoolId(null);
          setSelectedPoolName('');
        }}
        onFilterChange={(value) => {
          setDetailFilter(value);
          setDetailPage(1);
        }}
        onPageChange={(next) => setDetailPage(next)}
        onRefresh={() => refreshAll(selectedType)}
        onRefreshUsage={handleRefreshUsage}
        onResetHealth={handleResetHealth}
        onHealthCheck={handleHealthCheck}
        onDeleteUnhealthy={handleDeleteUnhealthy}
        onRefreshUnhealthy={handleRefreshUnhealthy}
        onBatchUpdateCheckModelName={handleBatchUpdateCheckModelName}
        onToggleDisable={handleToggleDisable}
        onRefreshUuid={handleRefreshUuid}
        onDeleteProvider={handleDeleteProvider}
        onSaveProvider={handleSaveProvider}
        onMovePool={handleMovePool}
        onBatchMoveProviders={handleBatchMoveToPool}
      />

      <ApiKeyImportModal
        open={authModal?.type === 'api-import'}
        providerType={authModal?.providerType}
        title={authModal?.title}
        apiLabel={authModal?.apiLabel}
        configKey={authModal?.configKey}
        baseUrlKey={authModal?.baseUrlKey}
        baseUrlDefault={authModal?.baseUrlDefault}
        baseUrlLabel={authModal?.baseUrlLabel}
        poolOptions={getPoolsForType(authModal?.providerType)}
        defaultPoolId={authModal?.poolId}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <WindsurfEmailImportModal
        open={authModal?.type === 'windsurf-email-import'}
        defaultPoolId={authModal?.poolId}
        poolOptions={getPoolsForType(authModal?.providerType)}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <WarpImportModal
        open={authModal?.type === 'warp-import'}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <OrchidsImportModal
        open={authModal?.type === 'orchids-import'}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <AmiImportModal
        open={authModal?.type === 'ami-import'}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <DroidMethodModal
        open={authModal?.type === 'droid-method'}
        onClose={() => setAuthModal(null)}
        onSelect={(mode) => setAuthModal({ type: mode === 'single' ? 'droid-single' : 'droid-batch' })}
      />

      <DroidSingleImportModal
        open={authModal?.type === 'droid-single'}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <DroidBatchImportModal
        open={authModal?.type === 'droid-batch'}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <KiroMethodModal
        open={authModal?.type === 'kiro-method'}
        pools={getPoolsForType('claude-kiro-oauth')}
        onClose={() => setAuthModal(null)}
        onRefreshPools={() => fetchPoolsForType('claude-kiro-oauth', { refresh: true })}
        onSelect={(mode, poolId) => {
          if (mode === 'google') {
            setAuthModal(null);
            handleGenerateAuthUrl('claude-kiro-oauth', { method: 'google', poolId });
            return;
          }
          if (mode === 'builder-id') {
            setAuthModal(null);
            handleGenerateAuthUrl('claude-kiro-oauth', { method: 'builder-id', poolId });
            return;
          }
          if (mode === 'batch-import') {
            setAuthModal({ type: 'kiro-batch', poolId });
            return;
          }
          if (mode === 'aws-import') {
            setAuthModal({ type: 'kiro-aws', poolId });
          }
        }}
      />

      <KiroBatchImportModal
        open={authModal?.type === 'kiro-batch'}
        poolId={authModal?.poolId}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <KiroAwsImportModal
        open={authModal?.type === 'kiro-aws'}
        poolId={authModal?.poolId}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <CodexJsonImportModal
        open={authModal?.type === 'codex-json-import'}
        poolOptions={getPoolsForType('openai-codex')}
        defaultPoolId={authModal?.poolId}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <GrokImportModal
        open={authModal?.type === 'xai-import'}
        poolOptions={getPoolsForType('openai-xai-oauth')}
        defaultPoolId={authModal?.poolId}
        onClose={() => setAuthModal(null)}
        onSuccess={handleAuthSuccess}
      />

      <OAuthHostModal
        open={authModal?.type === 'oauth-host'}
        providerType={authModal?.providerType}
        poolOptions={getPoolsForType(authModal?.providerType)}
        onClose={() => setAuthModal(null)}
        onConfirm={({ host, poolId }) => handleGenerateAuthUrl(authModal?.providerType, { host, poolId })}
      />

      <ClaudeOfficialMethodModal
        open={authModal?.type === 'claude-offical-method'}
        onClose={() => setAuthModal(null)}
        onSelect={async (mode) => {
          if (mode === 'api-import') {
            await handleAuthAction('claude-offical', 'claude-import');
            return;
          }
          if (mode === 'oauth') {
            setAuthModal(null);
            await handleGenerateAuthUrl('claude-offical', {});
            return;
          }
          if (mode === 'setup-token') {
            setAuthModal(null);
            await handleGenerateAuthUrl('claude-offical', { authMode: 'setup-token' });
            return;
          }
          if (mode === 'cookie-oauth') {
            setAuthModal({ type: 'claude-offical-cookie', providerType: 'claude-offical', authMode: 'oauth' });
            return;
          }
          if (mode === 'cookie-setup-token') {
            setAuthModal({ type: 'claude-offical-cookie', providerType: 'claude-offical', authMode: 'setup-token' });
          }
        }}
      />

      <ClaudeOfficialCookieModal
        open={authModal?.type === 'claude-offical-cookie'}
        authMode={authModal?.authMode}
        pools={getPoolsForType('claude-offical')}
        onClose={() => setAuthModal(null)}
        onRefreshPools={() => fetchPoolsForType('claude-offical', { refresh: true })}
        onSubmit={handleClaudeOfficialCookieOAuth}
      />

      <AuthUrlModal
        open={authModal?.type === 'auth-url'}
        providerType={authModal?.providerType}
        providerLabel={getProviderDisplayName(authModal?.authInfo?.provider || authModal?.providerType)}
        authUrl={authModal?.authUrl}
        authInfo={authModal?.authInfo}
        pools={getPoolsForType(authModal?.providerType)}
        onClose={() => setAuthModal(null)}
        onRegenerate={(options) => handleGenerateAuthUrl(authModal?.providerType, options)}
        onManualCallback={handleManualCallback}
        onSuccess={handleAuthSuccess}
        onContinueAuth={async (options) => {
          try {
            const providerType = authModal?.providerType;
            if (!providerType) return;
            await refreshAll(providerType);
            const response = await providerService.generateAuthUrl(providerType, options);
            if (response?.authUrl) {
              setAuthModal((prev) => ({
                ...prev,
                authUrl: response.authUrl,
                authInfo: { ...response.authInfo, provider: response.authInfo?.provider || providerType },
              }));
            }
          } catch (err) {
            console.error('[ContinuousAuth] Failed to regenerate:', err);
          }
        }}
      />

      {authLoading && <div className="auth-loading">生成授权链接中...</div>}

      <PoolModelConfigModal
        open={!!modelConfigModal}
        pool={modelConfigModal?.pool}
        providerType={modelConfigModal?.providerType}
        models={models}
        onClose={() => setModelConfigModal(null)}
        onSave={async (config) => {
          if (modelConfigModal?.pool?.id) {
            await poolConfigService.updatePoolConfig(modelConfigModal.pool.id, config);
            await fetchPoolsForType(modelConfigModal.providerType, { refresh: true });
          }
        }}
      />

      <BatchOperationModal
        open={batchOperationModal}
        providerType={getProviderDisplayName(selectedType)}
        providerTypeKey={selectedType}
        onClose={() => setBatchOperationModal(false)}
        onExecute={handleBatchOperation}
        onBatchCodexAuth={handleStartCodexBatchAuth}
      />

      <CodexBatchAuthModal
        open={!!codexBatchAuth}
        authUrl={codexBatchAuth?.authUrl}
        onClose={() => setCodexBatchAuth(null)}
        onStop={handleStopCodexBatchAuth}
      />
    </div>
  );
}
