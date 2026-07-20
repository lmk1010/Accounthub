/**
 * Warp 模型映射器
 * 将标准的 Claude 模型名称转换为 Warp 支持的模型名称
 */

// Warp 支持的 Claude 模型映射
const CLAUDE_MODEL_MAP = {
    // Claude Opus 4.5 (最新版本)
    'claude-opus-4-5-20251101': 'claude-4-5-opus',
    'claude-opus-4-5': 'claude-4-5-opus',
    'claude-opus-4.5': 'claude-4-5-opus',

    // Claude Sonnet 4.6
    'claude-sonnet-4-6-20260217': 'claude-4-5-sonnet',
    'claude-sonnet-4-6': 'claude-4-5-sonnet',
    'claude-sonnet-4.6': 'claude-4-5-sonnet',

    // Claude Sonnet 4.5
    'claude-sonnet-4-5-20250929': 'claude-4-5-sonnet',
    'claude-sonnet-4-5-20251101': 'claude-4-5-sonnet',
    'claude-sonnet-4-5': 'claude-4-5-sonnet',
    'claude-sonnet-4.5': 'claude-4-5-sonnet',

    // Claude 3.5 Sonnet
    'claude-3-5-sonnet-20241022': 'claude-4-5-sonnet',
    'claude-3-5-sonnet-20240620': 'claude-4-5-sonnet',
    'claude-3-5-sonnet': 'claude-4-5-sonnet',
    'claude-3.5-sonnet': 'claude-4-5-sonnet',

    // Claude 3.5 Haiku
    'claude-3-5-haiku-20241022': 'claude-4-5-haiku',
    'claude-3-5-haiku': 'claude-4-5-haiku',
    'claude-3.5-haiku': 'claude-4-5-haiku',

    // Claude Haiku 4.5 (新增映射)
    'claude-haiku-4-5-20251001': 'claude-4-5-haiku',
    'claude-haiku-4-5-20250110': 'claude-4-5-haiku',
    'claude-haiku-4-5': 'claude-4-5-haiku',
    'claude-haiku-4.5': 'claude-4-5-haiku',

    // Claude 3 Opus
    'claude-3-opus-20240229': 'claude-4.1-opus',
    'claude-3-opus': 'claude-4.1-opus',
    'claude-3.0-opus': 'claude-4.1-opus',

    // Claude 3 Sonnet
    'claude-3-sonnet-20240229': 'claude-4-sonnet',
    'claude-3-sonnet': 'claude-4-sonnet',
    'claude-3.0-sonnet': 'claude-4-sonnet',

    // Claude 4.5 系列（直接映射）
    'claude-4-5-sonnet': 'claude-4-5-sonnet',
    'claude-4-5-haiku': 'claude-4-5-haiku',
    'claude-4-5-opus': 'claude-4-5-opus',
    'claude-4.5-sonnet': 'claude-4-5-sonnet',
    'claude-4.5-haiku': 'claude-4-5-haiku',
    'claude-4.5-opus': 'claude-4-5-opus',

    // Claude 4 系列
    'claude-4-sonnet': 'claude-4-sonnet',
    'claude-4-opus': 'claude-4.1-opus',
    'claude-4.1-opus': 'claude-4.1-opus',
};

/**
 * 将用户请求的模型名称转换为 Warp 支持的模型名称
 * @param {string} modelName - 用户请求的模型名称
 * @returns {string} Warp 支持的模型名称
 */
export function mapToWarpModel(modelName) {
    if (!modelName || typeof modelName !== 'string') {
        return 'auto'; // 默认使用 auto
    }

    const normalized = modelName.toLowerCase().trim();

    // 检查是否在映射表中
    if (CLAUDE_MODEL_MAP[normalized]) {
        return CLAUDE_MODEL_MAP[normalized];
    }

    // 如果已经是 Warp 格式，直接返回
    if (normalized.startsWith('claude-4') ||
        normalized.startsWith('gpt-5') ||
        normalized.startsWith('gemini-') ||
        normalized === 'auto' ||
        normalized === 'auto-efficient' ||
        normalized === 'auto-genius') {
        return normalized;
    }

    // 默认返回 auto
    console.log(`[Warp Model Mapper] Unknown model: ${modelName}, using 'auto'`);
    return 'auto';
}

/**
 * 获取所有支持的模型映射
 * @returns {Object} 模型映射表
 */
export function getSupportedModels() {
    return { ...CLAUDE_MODEL_MAP };
}
