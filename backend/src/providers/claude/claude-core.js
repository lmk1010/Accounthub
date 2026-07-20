/**
 * claude-core.js — 兼容层
 * 原始的 ClaudeApiService 已拆分为：
 *   - claude-base.js    → ClaudeBaseService（共享基类）
 *   - claude-custom.js  → ClaudeCustomApiService（claude-custom 专属）
 *   - claude-official.js → ClaudeOfficialApiService（claude-offical 专属）
 *
 * 此文件保留 re-export，兼容现有 import 路径。
 */
export { ClaudeBaseService, pickFirstNonEmpty, parseJsonSafely, getHeaderValueCaseInsensitive, normalizeClaudeBaseUrl } from './claude-base.js';
export { ClaudeCustomApiService } from './claude-custom.js';
export { ClaudeOfficialApiService } from './claude-official.js';

// 向后兼容：旧代码 import { ClaudeApiService } from './claude-core.js'
// 默认映射到 Official（保持原有行为：构造函数内部根据 providerType 判断）
// 如果需要严格隔离，请直接 import 对应的子类
export { ClaudeOfficialApiService as ClaudeApiService } from './claude-official.js';
