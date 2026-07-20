/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 */

export const PROVIDER_MODELS = {
    'openai-xai-oauth': [
        'grok-build-0.1',
        'grok-4.5',
        'grok-4.3',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-multi-agent-0309',
        'grok-3-mini',
        'grok-3-mini-fast',
        'grok-composer-2.5-fast',
        'grok-imagine-image',
        'grok-imagine-image-quality',
        'grok-imagine-video',
        'grok-imagine-video-1.5',
        'grok-imagine-video-1.5-preview'
    ],
    'gemini-cli-oauth': [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-pro-preview-06-05',
        'gemini-2.5-flash-preview-09-2025',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview'
    ],
    'gemini-antigravity': [
        'gemini-2.5-computer-use-preview-10-2025',
        'gemini-3-pro-image-preview',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-flash-preview',
        'gemini-claude-sonnet-4-5',
        'gemini-claude-sonnet-4-5-thinking',
        'gemini-claude-opus-4-5-thinking'
    ],
    'claude-antigravity': [
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-opus-4',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229'
    ],
    'claude-custom': [
        'claude-opus-4-6',
        'claude-opus-4-6-20260101',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022'
    ],
    'claude-offical': [
        'claude-opus-4-6',
        'claude-opus-4-6-20260101',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022'
    ],
    'claude-droid': [
        'claude-opus-4-6',
        'claude-opus-4-6-20260101',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022'
    ],
    'claude-kiro-oauth': [
        'claude-opus-4-6',
        'claude-opus-4-6-20260101',
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
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-3-7-sonnet-20250219',
        'minimax-m2.1',
        'deepseek-3.2'
    ],
    'claude-ami-oauth': [
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001'
    ],
    'claude-orchids-oauth': [
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-opus-4-5',
        'claude-haiku-4-5',
        'gemini-3',
        'gemini-3-flash',
        'gpt-5.2'
    ],
    'claude-windsurf': [
        // Claude
        'claude-4.5-haiku', 'claude-4.5-sonnet', 'claude-4.5-sonnet-thinking', 'claude-4.5-opus', 'claude-4.5-opus-thinking',
        'claude-sonnet-4.6', 'claude-sonnet-4.6-thinking', 'claude-sonnet-4.6-1m', 'claude-sonnet-4.6-thinking-1m',
        'claude-opus-4.6', 'claude-opus-4.6-thinking',
        'claude-opus-4-7-low', 'claude-opus-4-7-medium', 'claude-opus-4-7-high', 'claude-opus-4-7-xhigh', 'claude-opus-4-7-max',
        'claude-opus-4-7-medium-thinking', 'claude-opus-4-7-high-thinking', 'claude-opus-4-7-xhigh-thinking',
        'claude-4-sonnet', 'claude-4-sonnet-thinking', 'claude-4-opus', 'claude-4-opus-thinking',
        'claude-4.1-opus', 'claude-4.1-opus-thinking',
        // GPT
        'gpt-5.5', 'gpt-5.5-none', 'gpt-5.5-low', 'gpt-5.5-medium', 'gpt-5.5-high', 'gpt-5.5-xhigh',
        'gpt-5.4-none', 'gpt-5.4-low', 'gpt-5.4-medium', 'gpt-5.4-high', 'gpt-5.4-xhigh',
        'gpt-5.3-codex', 'gpt-5.3-codex-low', 'gpt-5.3-codex-high', 'gpt-5.3-codex-xhigh',
        'gpt-5.2', 'gpt-5.2-low', 'gpt-5.2-high', 'gpt-5.2-xhigh',
        'gpt-5.1', 'gpt-5.1-low', 'gpt-5.1-medium', 'gpt-5.1-high',
        'gpt-5', 'gpt-5-medium', 'gpt-5-high', 'gpt-5-codex',
        'gpt-4.1', 'gpt-4o',
        // o系列
        'o3', 'o3-high', 'o3-pro', 'o4-mini',
        // Gemini
        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.0-pro', 'gemini-3.0-flash', 'gemini-3.0-flash-high',
        'gemini-3.1-pro-low', 'gemini-3.1-pro-high',
        // 其他
        'deepseek-v3', 'deepseek-v3-2', 'deepseek-r1',
        'grok-3', 'grok-3-mini', 'grok-3-mini-thinking', 'grok-code-fast-1',
        'kimi-k2', 'kimi-k2-thinking', 'kimi-k2.5', 'kimi-k2-6',
        'glm-4.7', 'glm-4.7-fast', 'glm-5', 'glm-5.1',
        'qwen-3', 'minimax-m2.5',
        'swe-1.5', 'swe-1.5-fast', 'swe-1.5-thinking', 'swe-1.6', 'swe-1.6-fast',
        'adaptive', 'arena-fast', 'arena-smart',
    ],
    'openai-windsurf': [
        'claude-4.5-sonnet-thinking',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-6-20260217',
        'claude-opus-4-5-20251101',
        'claude-opus-4-6-20260101',
        'claude-haiku-4-5-20251001',
    ],
    'openai-custom': [],
    'openaiResponses-custom': [],
    'openai-droid': [],
    'openaiResponses-droid': [],
    'openai-qwen-oauth': [
        'qwen3-coder-plus',
        'qwen3-coder-flash'
    ],
    'openai-iflow': [
        // iFlow 特有模型
        'iflow-rome-30ba3b',
        // Qwen 模型
        'qwen3-coder-plus',
        'qwen3-max',
        'qwen3-vl-plus',
        'qwen3-max-preview',
        'qwen3-32b',
        'qwen3-235b-a22b-thinking-2507',
        'qwen3-235b-a22b-instruct',
        'qwen3-235b',
        // Kimi 模型
        'kimi-k2-0905',
        'kimi-k2',
        // GLM 模型
        'glm-4.6',
        'glm-4.7',
        // DeepSeek 模型
        'deepseek-v3.2',
        'deepseek-r1',
        'deepseek-v3'
    ],
    'openai-codex': [
        'gpt-image-1',
        'gpt-image-2',
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-max',
        'gpt-5.1-codex-mini',
        'gpt-5.2',
        'gpt-5.2-openai-compact',
        'gpt-5.2-codex',
        'gpt-5.3-codex-compact',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.4-nano',
        'gpt-5.4-codex',
        'gpt-5.5',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-6',
        'gpt-6-codex'
    ],
    'claude-warp-oauth': [
        // 自动模式
        'warp-ai',
        'auto',
        // Claude Opus 4.5
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-4-5-opus',
        'claude-4-5-opus-thinking',
        // Claude Sonnet 4.6
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-20260217',
        // Claude Sonnet 4.5
        'claude-sonnet-4-5',
        'claude-4-5-sonnet',
        'claude-4-5-sonnet-thinking',
        // Claude Sonnet 4
        'claude-sonnet-4',
        'claude-sonnet-4-20250514',
        'claude-4-sonnet',
        // Claude Opus 4.1
        'claude-opus-4-1',
        'claude-4.1-opus',
        // Claude Haiku 4.5
        'claude-haiku-4-5',
        'claude-4-5-haiku',
        // Gemini
        'gemini-2.5-pro',
        'gemini-3-pro'
    ]
};

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    return PROVIDER_MODELS[providerType] || [];
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    return PROVIDER_MODELS;
}
