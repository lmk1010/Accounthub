import { OpenAIResponsesApiService } from './openai/openai-responses-core.js'; // 导入OpenAIResponsesApiService
import { CodexApiService } from './openai/codex-core.js';
import { XaiApiService } from './openai/xai-core.js';
import { GeminiApiService } from './gemini/gemini-core.js'; // 导入geminiApiService
import { AntigravityApiService } from './gemini/antigravity-core.js'; // 导入AntigravityApiService
import { ClaudeAntigravityApiService } from './claude-antigravity/claude-antigravity-core.js'; // 导入ClaudeAntigravityApiService
import { OpenAIApiService } from './openai/openai-core.js'; // 导入OpenAIApiService
import { ClaudeCustomApiService } from './claude/claude-custom.js'; // 导入ClaudeCustomApiService
import { ClaudeOfficialApiService } from './claude/claude-official.js'; // 导入ClaudeOfficialApiService
import { KiroApiService } from './claude/claude-kiro.js'; // 导入KiroApiService
import { AmiApiService } from './claude/claude-ami.js'; // 导入AmiApiService
import { OrchidsApiService } from './claude/claude-orchids.js'; // 导入OrchidsApiService
import { QwenApiService } from './openai/qwen-core.js'; // 导入QwenApiService
import { IFlowApiService } from './openai/iflow-core.js'; // 导入IFlowApiService
import { WarpApiService } from './warp/warp-ai.js';
import { WindsurfApiService } from './openai/windsurf-core.js';
import { WindsurfClaudeApiService } from './windsurf/windsurf-service.js';
import { DroidOpenAIChatService } from './droid/droid-openai-chat.js';
import { DroidOpenAIResponsesService } from './droid/droid-openai-responses.js';
import { DroidClaudeService } from './droid/droid-claude.js';
import { MODEL_PROVIDER } from '../utils/common.js'; // 导入 MODEL_PROVIDER

// 定义AI服务适配器接口
// 所有的服务适配器都应该实现这些方法
export class ApiServiceAdapter {
    constructor() {
        if (new.target === ApiServiceAdapter) {
            throw new TypeError("Cannot construct ApiServiceAdapter instances directly");
        }
    }

    /**
     * 生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {Promise<object>} - API响应
     */
    async generateContent(model, requestBody) {
        throw new Error("Method 'generateContent()' must be implemented.");
    }

    /**
     * 流式生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {AsyncIterable<object>} - API响应流
     */
    async *generateContentStream(model, requestBody) {
        throw new Error("Method 'generateContentStream()' must be implemented.");
    }

    /**
     * 列出可用模型
     * @returns {Promise<object>} - 模型列表
     */
    async listModels() {
        throw new Error("Method 'listModels()' must be implemented.");
    }

    /**
     * 刷新认证令牌
     * @returns {Promise<void>}
     */
    async refreshToken() {
        throw new Error("Method 'refreshToken()' must be implemented.");
    }

    /**
     * 释放底层资源
     *
     * 通用实现:遍历自身所有属性,对看起来像 *Service 的对象调用 disposeServiceLike,
     * 子类无需覆盖。若某个 service 有特殊清理需要,可在 service 类上实现 dispose() 方法,
     * 会被 disposeServiceLike 识别并调用。
     */
    dispose() {
        for (const key of Object.keys(this)) {
            const value = this[key];
            if (!value || typeof value !== 'object') continue;
            const ctorName = value?.constructor?.name || '';
            if (/Service$/.test(ctorName) || typeof value.dispose === 'function') {
                disposeServiceLike(value);
                try { this[key] = null; } catch (_error) { /* readonly field ignore */ }
            }
        }
    }
}

/**
 * 安全销毁 http(s).Agent / axios instance 内嵌的 agent
 */
function destroyAgent(agent) {
    if (agent && typeof agent.destroy === 'function') {
        try { agent.destroy(); } catch (_error) { /* swallow */ }
    }
}

/**
 * 对一个 *ApiService 实例做尽力释放:
 *   - axios instance 的 httpAgent/httpsAgent
 *   - 独立的 tokenClient / axiosInstance
 *   - credentials / requestContext 引用
 *   - 常见的 sessions / sessionAccess Map
 *   - 若自身实现了 dispose() 则调用(允许 service 类自行扩展清理)
 *
 * 任何步骤抛错都被吞掉,确保调用方不会因为某一个 service 清理失败而中断整体 dispose 流程。
 */
function disposeServiceLike(svc) {
    if (!svc || typeof svc !== 'object') return;

    // 若 service 自身实现 dispose(),优先调用(允许扩展清理逻辑)
    if (typeof svc.dispose === 'function') {
        try { svc.dispose(); } catch (_error) { /* swallow */ }
    }

    // 顶层 agent
    destroyAgent(svc.httpAgent);
    destroyAgent(svc.httpsAgent);

    // 常见 axios 实例字段
    for (const key of ['axiosInstance', 'tokenClient', 'httpClient', 'client']) {
        const inst = svc[key];
        if (inst?.defaults) {
            destroyAgent(inst.defaults.httpAgent);
            destroyAgent(inst.defaults.httpsAgent);
        }
        if (inst) svc[key] = null;
    }

    // 释放可能持有对话/会话的 Map/Set
    for (const mapKey of ['sessions', 'sessionAccess', 'pendingToolCalls', 'sentToolResults', 'emittedToolCalls', 'messageIds']) {
        const v = svc[mapKey];
        if (v && typeof v.clear === 'function') {
            try { v.clear(); } catch (_error) { /* swallow */ }
        }
    }

    // 释放大对象引用,帮助 GC
    svc.credentials = null;
    svc.requestContext = null;
    svc.refreshInFlight = null;
    svc.backgroundRefreshInFlight = null;
    svc.isInitialized = false;
}

// Gemini API 服务适配器
export class GeminiApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.geminiApiService = new GeminiApiService(config);
        // this.geminiApiService.initialize().catch(error => {
        //     console.error("Failed to initialize geminiApiService:", error);
        // });
    }

    async generateContent(model, requestBody) {
        if (!this.geminiApiService.isInitialized) {
            console.warn("geminiApiService not initialized, attempting to re-initialize...");
            await this.geminiApiService.initialize();
        }
        return this.geminiApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.geminiApiService.isInitialized) {
            console.warn("geminiApiService not initialized, attempting to re-initialize...");
            await this.geminiApiService.initialize();
        }
        yield* this.geminiApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.geminiApiService.isInitialized) {
            console.warn("geminiApiService not initialized, attempting to re-initialize...");
            await this.geminiApiService.initialize();
        }
        // Gemini Core API 的 listModels 已经返回符合 Gemini 格式的数据，所以不需要额外转换
        return this.geminiApiService.listModels();
    }

    async refreshToken() {
        if(this.geminiApiService.isExpiryDateNear()===true){
            console.log(`[Gemini] Expiry date is near, refreshing token...`);
            return this.geminiApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.geminiApiService.isInitialized) {
            console.warn("geminiApiService not initialized, attempting to re-initialize...");
            await this.geminiApiService.initialize();
        }
        return this.geminiApiService.getUsageLimits();
    }
}

// Antigravity API 服务适配器
export class AntigravityApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.antigravityApiService = new AntigravityApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.antigravityApiService.isInitialized) {
            console.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.antigravityApiService.isInitialized) {
            console.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        yield* this.antigravityApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.antigravityApiService.isInitialized) {
            console.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.listModels();
    }

    async refreshToken() {
        if (this.antigravityApiService.isExpiryDateNear() === true) {
            console.log(`[Antigravity] Expiry date is near, refreshing token...`);
            return this.antigravityApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.antigravityApiService.isInitialized) {
            console.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.getUsageLimits();
    }
}

// Claude Antigravity API 服务适配器 (Claude API → Antigravity)
export class ClaudeAntigravityApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.claudeAntigravityApiService = new ClaudeAntigravityApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.claudeAntigravityApiService.isInitialized) {
            console.warn("claudeAntigravityApiService not initialized, attempting to re-initialize...");
            await this.claudeAntigravityApiService.initialize();
        }
        return this.claudeAntigravityApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.claudeAntigravityApiService.isInitialized) {
            console.warn("claudeAntigravityApiService not initialized, attempting to re-initialize...");
            await this.claudeAntigravityApiService.initialize();
        }
        yield* this.claudeAntigravityApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.claudeAntigravityApiService.isInitialized) {
            console.warn("claudeAntigravityApiService not initialized, attempting to re-initialize...");
            await this.claudeAntigravityApiService.initialize();
        }
        return this.claudeAntigravityApiService.listModels();
    }

    async refreshToken() {
        if (this.claudeAntigravityApiService.isExpiryDateNear?.() === true) {
            console.log(`[ClaudeAntigravity] Expiry date is near, refreshing token...`);
            return this.claudeAntigravityApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    async getUsageLimits() {
        if (!this.claudeAntigravityApiService.isInitialized) {
            await this.claudeAntigravityApiService.initialize();
        }
        return this.claudeAntigravityApiService.getUsageLimits();
    }
}

// OpenAI API 服务适配器
export class OpenAIApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.openAIApiService = new OpenAIApiService(config);
    }

    async generateContent(model, requestBody) {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        // The conversion logic is handled upstream in the server.
        return this.openAIApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        const stream = this.openAIApiService.generateContentStream(model, requestBody);
        // The stream is yielded directly without conversion.
        yield* stream;
    }

    async listModels() {
        // The adapter now returns the native model list from the underlying service.
        return this.openAIApiService.listModels();
    }

    async refreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return Promise.resolve();
    }
}

// OpenAI Responses API 服务适配器
export class OpenAIResponsesApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.openAIResponsesApiService = new OpenAIResponsesApiService(config);
    }

    setRequestContext(context) {
        if (typeof this.openAIResponsesApiService?.setRequestContext === 'function') {
            this.openAIResponsesApiService.setRequestContext(context);
        }
    }

    async generateContent(model, requestBody, requestContext = null) {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        return this.openAIResponsesApiService.generateContent(model, requestBody, requestContext);
    }

    async *generateContentStream(model, requestBody, requestContext = null) {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        const stream = this.openAIResponsesApiService.generateContentStream(model, requestBody, requestContext);
        yield* stream;
    }

    async listModels() {
        // The adapter returns the native model list from the underlying service.
        return this.openAIResponsesApiService.listModels();
    }

    async refreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return Promise.resolve();
    }
}

// OpenAI Codex API 服务适配器
export class CodexApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.codexApiService = new CodexApiService(config);
    }

    setRequestContext(context) {
        if (typeof this.codexApiService?.setRequestContext === 'function') {
            this.codexApiService.setRequestContext(context);
        }
    }

    async generateContent(model, requestBody, requestContext = null) {
        return this.codexApiService.generateContent(model, requestBody, requestContext);
    }

    async *generateContentStream(model, requestBody, requestContext = null) {
        const stream = this.codexApiService.generateContentStream(model, requestBody, requestContext);
        yield* stream;
    }

    async listModels() {
        return this.codexApiService.listModels();
    }

    async listAvailableModels() {
        return this.codexApiService.listModels();
    }

    parseAvailableModels(rawData) {
        if (!rawData || !Array.isArray(rawData.data)) return [];
        return rawData.data
            .map(model => model && (model.id || model.slug))
            .filter(Boolean);
    }

    async generateImage(model, requestBody, requestContext = null) {
        return this.codexApiService.generateImage(model, requestBody, requestContext);
    }

    async refreshToken(force = false) {
        return this.codexApiService.refreshToken(force);
    }

    async getUsageLimits() {
        return this.codexApiService.getUsageLimits();
    }

    async getImageUsageLimits() {
        return this.codexApiService.getImageUsageLimits();
    }
}

// xAI Grok Responses API 服务适配器
export class XaiApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.xaiApiService = new XaiApiService(config);
    }

    setRequestContext(context) {
        this.xaiApiService.setRequestContext(context);
    }

    async generateContent(model, requestBody, requestContext = null) {
        return this.xaiApiService.generateContent(model, requestBody, requestContext);
    }

    async *generateContentStream(model, requestBody, requestContext = null) {
        yield* this.xaiApiService.generateContentStream(model, requestBody, requestContext);
    }

    async listModels() {
        return this.xaiApiService.listModels();
    }

    async listAvailableModels() {
        return this.xaiApiService.listAvailableModels();
    }

    parseAvailableModels(rawData) {
        if (!rawData || !Array.isArray(rawData.data)) return [];
        return rawData.data.map(model => model?.id || model?.slug).filter(Boolean);
    }

    async generateImage(model, requestBody, requestContext = null) {
        return this.xaiApiService.generateImage(model, requestBody, requestContext);
    }

    async generateVideo(model, requestBody, requestContext = null) {
        return this.xaiApiService.generateVideo(model, requestBody, requestContext);
    }

    async downloadVideo(videoUrl) {
        return this.xaiApiService.downloadVideo(videoUrl);
    }

    async refreshToken(force = false) {
        return this.xaiApiService.refreshToken(force);
    }

    async getUsageLimits() {
        return this.xaiApiService.getUsageLimits();
    }
}

// Droid OpenAI Chat 服务适配器
export class DroidOpenAIChatServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.droidService = new DroidOpenAIChatService(config);
    }

    setRequestContext(context) {
        this.droidService.setRequestContext(context);
    }

    async generateContent(model, requestBody) {
        return this.droidService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.droidService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.droidService.listModels();
    }

    async refreshToken() {
        return this.droidService.refreshToken();
    }
}

// Droid OpenAI Responses 服务适配器
export class DroidOpenAIResponsesServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.droidService = new DroidOpenAIResponsesService(config);
    }

    setRequestContext(context) {
        this.droidService.setRequestContext(context);
    }

    async generateContent(model, requestBody) {
        return this.droidService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.droidService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.droidService.listModels();
    }

    async refreshToken() {
        return this.droidService.refreshToken();
    }
}

// Droid Claude 服务适配器
export class DroidClaudeServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.droidService = new DroidClaudeService(config);
    }

    setRequestContext(context) {
        this.droidService.setRequestContext(context);
    }

    async generateContent(model, requestBody) {
        return this.droidService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.droidService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.droidService.listModels();
    }

    async refreshToken() {
        return this.droidService.refreshToken();
    }
}

// Claude API 服务适配器
export class ClaudeCustomApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.claudeApiService = new ClaudeCustomApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.claudeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.claudeApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.claudeApiService.listModels();
    }

    setRequestContext(context) {
        if (typeof this.claudeApiService.setRequestContext === 'function') {
            this.claudeApiService.setRequestContext(context);
        }
    }

    async refreshToken() {
        return Promise.resolve();
    }

    async getUsageLimits() {
        return this.claudeApiService.getUsageLimits();
    }
}

export class ClaudeOfficialApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.claudeApiService = new ClaudeOfficialApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.claudeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.claudeApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.claudeApiService.listModels();
    }

    setRequestContext(context) {
        if (typeof this.claudeApiService.setRequestContext === 'function') {
            this.claudeApiService.setRequestContext(context);
        }
    }

    async refreshToken() {
        if (typeof this.claudeApiService.refreshToken === 'function') {
            return this.claudeApiService.refreshToken();
        }
        return Promise.resolve();
    }

    async getUsageLimits() {
        return this.claudeApiService.getUsageLimits();
    }

    // 5h session window & usage getters for pool manager / usage API
    get fiveHourAutoStopped() { return this.claudeApiService.fiveHourAutoStopped; }
    get fiveHourRecoveryAt() { return this.claudeApiService.fiveHourRecoveryAt; }
    get sessionWindowStatus() { return this.claudeApiService.sessionWindowStatus; }
    get sessionWindowStatusUpdatedAt() { return this.claudeApiService.sessionWindowStatusUpdatedAt; }
    get lastStreamUsage() { return this.claudeApiService.lastStreamUsage; }
}

// Kiro API 服务适配器
export class KiroApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.kiroApiService = new KiroApiService(config);
        // this.kiroApiService.initialize().catch(error => {
        //     console.error("Failed to initialize kiroApiService:", error);
        // });
    }

    async generateContent(model, requestBody) {
        // The adapter expects the requestBody to be in OpenAI format for Kiro API
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // The adapter expects the requestBody to be in OpenAI format for Kiro API
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        const stream = this.kiroApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // Returns the native model list from the Kiro service
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.listModels();
    }

    async refreshToken() {
        if(this.kiroApiService.isExpiryDateNear()===true){
            console.log(`[Kiro] Expiry date is near, refreshing token...`);
            return this.kiroApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.kiroApiService.isInitialized) {
            console.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.getUsageLimits();
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        return this.kiroApiService.countTokens(requestBody);
    }
}

// AMI API 服务适配器
export class AmiApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.amiApiService = new AmiApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.amiApiService.isInitialized) {
            await this.amiApiService.initialize();
        }
        return this.amiApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.amiApiService.isInitialized) {
            await this.amiApiService.initialize();
        }
        yield* this.amiApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return [];
    }

    async refreshToken() {
        return Promise.resolve();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.amiApiService.isInitialized) {
            await this.amiApiService.initialize();
        }
        return this.amiApiService.getUsageLimits();
    }

    /**
     * 获取用户会话信息
     * @returns {Promise<Object>} 会话信息
     */
    async getSession() {
        if (!this.amiApiService.isInitialized) {
            await this.amiApiService.initialize();
        }
        return this.amiApiService.getSession();
    }
}

// Orchids API 服务适配器
export class OrchidsApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.orchidsApiService = new OrchidsApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.orchidsApiService.isInitialized) {
            await this.orchidsApiService.initialize();
        }
        return this.orchidsApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.orchidsApiService.isInitialized) {
            await this.orchidsApiService.initialize();
        }
        yield* this.orchidsApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.orchidsApiService.listModels();
    }

    async refreshToken() {
        if (this.orchidsApiService.isExpiryDateNear()) {
            return this.orchidsApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

    async getUsageLimits() {
        if (!this.orchidsApiService.isInitialized) {
            await this.orchidsApiService.initialize();
        }
        return this.orchidsApiService.getUsageLimits();
    }

    countTokens(requestBody) {
        return this.orchidsApiService.countTokens(requestBody);
    }
}

// Qwen API 服务适配器
export class QwenApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.qwenApiService = new QwenApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.qwenApiService.isInitialized) {
            console.warn("qwenApiService not initialized, attempting to re-initialize...");
            await this.qwenApiService.initialize();
        }
        return this.qwenApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.qwenApiService.isInitialized) {
            console.warn("qwenApiService not initialized, attempting to re-initialize...");
            await this.qwenApiService.initialize();
        }
        yield* this.qwenApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.qwenApiService.isInitialized) {
            console.warn("qwenApiService not initialized, attempting to re-initialize...");
            await this.qwenApiService.initialize();
        }
        return this.qwenApiService.listModels();
    }

    async refreshToken() {
        if (this.qwenApiService.isExpiryDateNear()) {
            console.log(`[Qwen] Expiry date is near, refreshing token...`);
            return this.qwenApiService._initializeAuth(true);
        }
        return Promise.resolve();
    }
}

// iFlow API 服务适配器
export class IFlowApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.iflowApiService = new IFlowApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.iflowApiService.isInitialized) {
            console.warn("iflowApiService not initialized, attempting to re-initialize...");
            await this.iflowApiService.initialize();
        }
        return this.iflowApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.iflowApiService.isInitialized) {
            console.warn("iflowApiService not initialized, attempting to re-initialize...");
            await this.iflowApiService.initialize();
        }
        yield* this.iflowApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.iflowApiService.isInitialized) {
            console.warn("iflowApiService not initialized, attempting to re-initialize...");
            await this.iflowApiService.initialize();
        }
        return this.iflowApiService.listModels();
    }

    async refreshToken() {
        if (this.iflowApiService.isExpiryDateNear()) {
            console.log(`[iFlow] Expiry date is near, refreshing API key...`);
            await this.iflowApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }

}

// Windsurf Claude 原生服务适配器 (直接通过 Language Server 调用 Windsurf 云，无需外部代理)
export class WindsurfClaudeApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.windsurfService = new WindsurfClaudeApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.windsurfService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.windsurfService.generateContentStream(model, requestBody);
    }

    async getUsageLimits() {
        return this.windsurfService.getUsageLimits();
    }

    async listModels() {
        return this.windsurfService.listModels();
    }

    async refreshToken() {
        return Promise.resolve();
    }

    async dispose() {
        await this.windsurfService.dispose();
    }
}

// WindsurfAPI 服务适配器 (OpenAI-compatible proxy backed by Windsurf accounts)
export class WindsurfApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.windsurfApiService = new WindsurfApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.windsurfApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.windsurfApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.windsurfApiService.listModels();
    }

    async refreshToken() {
        return Promise.resolve();
    }
}

// Warp AI API 服务适配器
export class WarpApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.warpApiService = new WarpApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.warpApiService.isInitialized) {
            console.warn("warpApiService not initialized, attempting to re-initialize...");
            await this.warpApiService.initialize();
        }
        return this.warpApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.warpApiService.isInitialized) {
            console.warn("warpApiService not initialized, attempting to re-initialize...");
            await this.warpApiService.initialize();
        }
        yield* this.warpApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.warpApiService.isInitialized) {
            console.warn("warpApiService not initialized, attempting to re-initialize...");
            await this.warpApiService.initialize();
        }
        return this.warpApiService.listModels();
    }

    async refreshToken() {
        if (this.warpApiService.isExpiryDateNear()) {
            console.log(`[Warp] Expiry date is near, refreshing token...`);
            await this.warpApiService.initializeAuth(true);
        }
        return Promise.resolve();
    }
}

/**
 * 服务适配器单例池(Map)
 *
 * 注意:外部不要再用 `serviceInstances[key]` 或 `delete serviceInstances[key]`
 * 这种对象语义访问,改用下面导出的 helper:
 *   - getServiceAdapter(config)        工厂 + 读取 + 触刷 lastUsedAt
 *   - peekServiceAdapter(providerKey)  只读,不更新 lastUsedAt
 *   - deleteServiceInstance(key)       删除 + dispose 单个
 *   - deleteServiceInstancesByUuid(uuid)  删除 + dispose 同一 uuid 下所有 key
 *   - wipeAllServiceInstances()        全量清理(reload 时用)
 *   - listServiceInstanceEntries()     迭代快照([key, entry])
 *   - getServiceInstanceMetrics()      live/hot/disposed 统计
 *
 * 每个 entry 的形状:{ adapter, uuid, providerType, createdAt, lastUsedAt }
 * 仍 export `serviceInstances` 本体,便于需要直接迭代 Map 的代码(不推荐,首选 helper)。
 */
export const serviceInstances = new Map();

const HOT_WINDOW_MS = 10 * 60 * 1000; // 10 分钟内用过的算 hot
let disposedSinceStart = 0;

function hashStringForCache(input) {
    if (!input) return '';
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function buildProviderKey(config) {
    const provider = config.MODEL_PROVIDER;
    const baseProviderKey = config.uuid ? provider + config.uuid : provider;
    const proxyNode = config?.proxyNode;
    const proxySignature = proxyNode
        ? `${proxyNode.id ?? ''}:${proxyNode.protocol ?? ''}:${proxyNode.host ?? ''}:${proxyNode.port ?? ''}`
        : '';
    const enabledProviders = Array.isArray(config?.PROXY_ENABLED_PROVIDERS) ? config.PROXY_ENABLED_PROVIDERS : [];
    const hasGlobalProxy = !proxySignature
        && typeof config?.PROXY_URL === 'string'
        && config.PROXY_URL.trim() !== ''
        && enabledProviders.includes(provider);
    const globalProxySignature = hasGlobalProxy ? `global:${hashStringForCache(config.PROXY_URL.trim())}` : '';
    const proxyCacheKey = proxySignature || globalProxySignature;
    const providerKey = proxyCacheKey ? `${baseProviderKey}::proxy::${proxyCacheKey}` : baseProviderKey;
    return { providerKey, proxyCacheKey };
}

function instantiateAdapter(provider, config) {
    switch (provider) {
        case MODEL_PROVIDER.OPENAI_CUSTOM:
            return new OpenAIApiServiceAdapter(config);
        case MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES:
            return new OpenAIResponsesApiServiceAdapter(config);
        case MODEL_PROVIDER.OPENAI_CODEX:
            return new CodexApiServiceAdapter(config);
        case MODEL_PROVIDER.OPENAI_XAI:
            return new XaiApiServiceAdapter(config);
        case MODEL_PROVIDER.OPENAI_DROID:
            return new DroidOpenAIChatServiceAdapter(config);
        case MODEL_PROVIDER.OPENAI_RESPONSES_DROID:
            return new DroidOpenAIResponsesServiceAdapter(config);
        case MODEL_PROVIDER.GEMINI_CLI:
            return new GeminiApiServiceAdapter(config);
        case MODEL_PROVIDER.ANTIGRAVITY:
            return new AntigravityApiServiceAdapter(config);
        case MODEL_PROVIDER.CLAUDE_ANTIGRAVITY:
            return new ClaudeAntigravityApiServiceAdapter(config);
        case MODEL_PROVIDER.CLAUDE_CUSTOM:
            return new ClaudeCustomApiServiceAdapter(config);
        case MODEL_PROVIDER.CLAUDE_OFFICAL:
            return new ClaudeOfficialApiServiceAdapter(config);
        case MODEL_PROVIDER.CLAUDE_DROID:
            return new DroidClaudeServiceAdapter(config);
        case MODEL_PROVIDER.KIRO_API:
            return new KiroApiServiceAdapter(config);
        case MODEL_PROVIDER.AMI_API:
            return new AmiApiServiceAdapter(config);
        case MODEL_PROVIDER.QWEN_API:
            return new QwenApiServiceAdapter(config);
        case MODEL_PROVIDER.IFLOW_API:
            return new IFlowApiServiceAdapter(config);
        case MODEL_PROVIDER.ORCHIDS_API:
            return new OrchidsApiServiceAdapter(config);
        case MODEL_PROVIDER.WARP_API:
            return new WarpApiServiceAdapter(config);
        case MODEL_PROVIDER.WINDSURF_API:
            return new WindsurfApiServiceAdapter(config);
        case MODEL_PROVIDER.WINDSURF_CLAUDE:
            return new WindsurfClaudeApiServiceAdapter(config);
        default:
            throw new Error(`Unsupported model provider: ${provider}`);
    }
}

// 服务适配器工厂:读取或懒创建 adapter,始终刷新 lastUsedAt 作为 idle sweeper 依据
export function getServiceAdapter(config) {
    const provider = config.MODEL_PROVIDER;
    const { providerKey } = buildProviderKey(config);

    const existing = serviceInstances.get(providerKey);
    if (existing) {
        existing.lastUsedAt = Date.now();
        return existing.adapter;
    }

    // 原来这里 log 每次 create —— 单条便宜但一天 30k 次,churn 监控看 AdapterIdleSweeper
    // 的 swept=N 聚合行就够了。
    const adapter = instantiateAdapter(provider, config);
    const now = Date.now();
    serviceInstances.set(providerKey, {
        adapter,
        uuid: config.uuid || null,
        providerType: provider,
        createdAt: now,
        lastUsedAt: now
    });
    return adapter;
}

/**
 * 只读:不更新 lastUsedAt。用于 usage 查询、UI 统计等被动读场景。
 */
export function peekServiceAdapter(providerKey) {
    const entry = serviceInstances.get(providerKey);
    return entry ? entry.adapter : undefined;
}

/**
 * 安全 dispose 一个 adapter(吞异常,保证 Map 清理)
 */
function safeDisposeAdapter(adapter) {
    if (!adapter) return;
    try {
        if (typeof adapter.dispose === 'function') {
            adapter.dispose();
        }
    } catch (error) {
        console.warn('[Adapter] dispose error:', error?.message || error);
    }
    disposedSinceStart++;
}

/**
 * 删除单个 adapter 缓存条目并释放底层资源
 * @returns {boolean} 是否有命中被删除
 */
export function deleteServiceInstance(providerKey) {
    const entry = serviceInstances.get(providerKey);
    if (!entry) return false;
    safeDisposeAdapter(entry.adapter);
    serviceInstances.delete(providerKey);
    return true;
}

/**
 * 删除所有属于某个 uuid 的 adapter(同 uuid 可能因为不同 proxy 有多条)
 * @returns {number} 实际删除数量
 */
export function deleteServiceInstancesByUuid(uuid) {
    if (!uuid) return 0;
    let count = 0;
    for (const [key, entry] of serviceInstances) {
        if (entry.uuid === uuid) {
            safeDisposeAdapter(entry.adapter);
            serviceInstances.delete(key);
            count++;
        }
    }
    if (count > 0) {
        console.log(`[Adapter] deleteServiceInstancesByUuid(${String(uuid).slice(0, 8)}): removed ${count}`);
    }
    return count;
}

/**
 * 删除某个 providerType 下的全部 adapter 缓存（渠道级配置变更时用）
 * @returns {number} 实际删除数量
 */
export function deleteServiceInstancesByProviderType(providerType) {
    if (!providerType) return 0;
    let count = 0;
    for (const [key, entry] of serviceInstances) {
        if (entry.providerType === providerType) {
            safeDisposeAdapter(entry.adapter);
            serviceInstances.delete(key);
            count++;
        }
    }
    if (count > 0) {
        console.log(`[Adapter] deleteServiceInstancesByProviderType(${providerType}): removed ${count}`);
    }
    return count;
}

/**
 * 全量清空(reload/热重载用)
 */
export function wipeAllServiceInstances() {
    const count = serviceInstances.size;
    for (const entry of serviceInstances.values()) {
        safeDisposeAdapter(entry.adapter);
    }
    serviceInstances.clear();
    if (count > 0) {
        console.log(`[Adapter] wipeAllServiceInstances: removed ${count}`);
    }
    return count;
}

/**
 * 扫描并 dispose 超过 idleMs 未被 get 的 adapter
 *
 * 安全性保证:
 *   1) 若 adapter 实现了 isBusy() 方法且返回 true(当前有 in-flight 调用),跳过本轮
 *      例如长流式请求(SSE 长连)持有 adapter 超过 30 分钟,避免中途被 dispose
 *   2) 若 adapter 是最近刚创建且 lastUsedAt === createdAt(从未被 touch 过),保护一轮,
 *      避免刚 warmup 完还没收到流量就被扫
 *   3) 单次扫描 try/catch,某条失败不影响其他
 *
 * @param {number} idleMs 空闲阈值,默认 30 分钟
 * @returns {number} 本轮清理数
 */
export function sweepIdleServiceInstances(idleMs = 30 * 60 * 1000) {
    const threshold = Date.now() - idleMs;
    let swept = 0;
    let skippedBusy = 0;
    let skippedYoung = 0;
    for (const [key, entry] of serviceInstances) {
        if (entry.lastUsedAt >= threshold) continue;
        // 保护期:刚创建 < idleMs 的 adapter 不扫(即便 lastUsedAt 因某种原因没更新)
        if (Date.now() - entry.createdAt < idleMs) {
            skippedYoung++;
            continue;
        }
        // busy 保护:adapter 自报仍在处理请求(例如持有长流)
        try {
            if (entry.adapter && typeof entry.adapter.isBusy === 'function' && entry.adapter.isBusy()) {
                skippedBusy++;
                continue;
            }
        } catch (_error) { /* isBusy 异常当作 not busy */ }

        try {
            safeDisposeAdapter(entry.adapter);
            serviceInstances.delete(key);
            swept++;
        } catch (error) {
            console.warn(`[Adapter] sweep dispose error for ${key}:`, error?.message || error);
        }
    }
    if (swept > 0 || skippedBusy > 0) {
        console.log(`[Adapter] sweepIdleServiceInstances: swept=${swept} skippedBusy=${skippedBusy} skippedYoung=${skippedYoung} idle=${Math.round(idleMs / 60000)}min`);
    }
    return swept;
}

/**
 * 当前 live / hot(10 min 内用过) / disposedSinceStart 指标,供 worker-runtime-stats 使用
 */
export function getServiceInstanceMetrics() {
    const now = Date.now();
    let hot = 0;
    for (const entry of serviceInstances.values()) {
        if (entry.lastUsedAt >= now - HOT_WINDOW_MS) hot++;
    }
    return {
        live: serviceInstances.size,
        hot,
        disposedSinceStart
    };
}

/**
 * 快照所有条目,供管理端点/调试工具使用
 */
export function listServiceInstanceEntries() {
    const out = [];
    for (const [key, entry] of serviceInstances) {
        out.push({
            key,
            uuid: entry.uuid,
            providerType: entry.providerType,
            createdAt: entry.createdAt,
            lastUsedAt: entry.lastUsedAt,
            ageSec: Math.round((Date.now() - entry.createdAt) / 1000),
            idleSec: Math.round((Date.now() - entry.lastUsedAt) / 1000)
        });
    }
    return out;
}
