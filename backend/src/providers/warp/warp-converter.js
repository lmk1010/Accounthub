/**
 * Warp <-> Claude 格式转换器
 * 基于抓包数据分析实现正确的格式转换
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

// 会话存储目录
const SESSION_STORE_DIR = '/tmp/warp-sessions';

// 确保会话存储目录存在
try {
    if (!fs.existsSync(SESSION_STORE_DIR)) {
        fs.mkdirSync(SESSION_STORE_DIR, { recursive: true });
    }
} catch (e) {
    logger.warn('[WarpSession] Failed to create session store directory:', e.message);
}

/**
 * 跨进程共享的会话存储
 * 使用文件系统实现进程间共享
 */
class SharedSessionStore {
    /**
     * 生成会话文件路径
     */
    static getSessionFilePath(sessionKey) {
        // 将路径转换为安全的文件名
        const safeKey = sessionKey.replace(/[^a-zA-Z0-9-_]/g, '_');
        return path.join(SESSION_STORE_DIR, `session_${safeKey}.json`);
    }

    /**
     * 加载会话状态
     */
    static load(sessionKey) {
        try {
            const filePath = this.getSessionFilePath(sessionKey);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(data);
                // 检查会话是否过期（1小时）
                if (parsed.lastUpdated && Date.now() - parsed.lastUpdated > 3600000) {
                    logger.info('[WarpSession] Session expired, removing:', sessionKey);
                    this.remove(sessionKey);
                    return null;
                }
                return parsed;
            }
        } catch (e) {
            logger.warn('[WarpSession] Failed to load session:', sessionKey, e.message);
        }
        return null;
    }

    /**
     * 保存会话状态
     */
    static save(sessionKey, data) {
        try {
            const filePath = this.getSessionFilePath(sessionKey);
            const saveData = {
                ...data,
                lastUpdated: Date.now()
            };
            fs.writeFileSync(filePath, JSON.stringify(saveData), 'utf8');
            logger.info('[WarpSession] Saved session to:', filePath,
                'conversationId:', data.conversationId,
                'taskId:', data.taskId,
                'pendingToolCalls:', data.pendingToolCalls?.length || 0);
        } catch (e) {
            logger.error('[WarpSession] Failed to save session:', sessionKey, e.message);
        }
    }

    /**
     * 删除会话
     */
    static remove(sessionKey) {
        try {
            const filePath = this.getSessionFilePath(sessionKey);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            logger.warn('[WarpSession] Failed to remove session:', sessionKey, e.message);
        }
    }
}

/**
 * Claude 工具名称到 Warp ToolType 枚举的映射
 */
const TOOL_TYPE_ENUM = {
    RUN_SHELL_COMMAND: 0,
    SEARCH_CODEBASE: 1,
    READ_FILES: 2,
    APPLY_FILE_DIFFS: 3,
    SUGGEST_PLAN: 4,
    SUGGEST_CREATE_PLAN: 5,
    GREP: 6,
    FILE_GLOB: 7,
    READ_MCP_RESOURCE: 8,
    CALL_MCP_TOOL: 9,
    WRITE_TO_LONG_RUNNING_SHELL_COMMAND: 10,
    SUGGEST_NEW_CONVERSATION: 11,
    FILE_GLOB_V2: 12
};

/**
 * Claude Code 工具名称到 Warp ToolType 的映射
 */
const CLAUDE_TOOL_TO_WARP_TYPE = {
    'Bash': TOOL_TYPE_ENUM.RUN_SHELL_COMMAND,
    'Read': TOOL_TYPE_ENUM.READ_FILES,
    'Edit': TOOL_TYPE_ENUM.APPLY_FILE_DIFFS,
    'Write': TOOL_TYPE_ENUM.APPLY_FILE_DIFFS,
    'Grep': TOOL_TYPE_ENUM.GREP,
    'Glob': TOOL_TYPE_ENUM.FILE_GLOB_V2,
};

/**
 * 获取支持的工具类型列表
 */
export function getSupportedToolTypes(tools) {
    const supportedTools = new Set();

    if (!tools || !Array.isArray(tools)) {
        return [];
    }

    for (const tool of tools) {
        const toolName = tool.name || tool.function?.name;
        if (toolName && CLAUDE_TOOL_TO_WARP_TYPE[toolName] !== undefined) {
            supportedTools.add(CLAUDE_TOOL_TO_WARP_TYPE[toolName]);
        }
    }

    return Array.from(supportedTools);
}

/**
 * 将 Claude 消息格式转换为 Warp userInputs 格式
 * @param {Array} messages - Claude 格式的消息列表
 * @param {Object} context - 上下文信息 (pwd, home 等)
 * @returns {Array} Warp 格式的 userInputs
 */
export function convertClaudeMessagesToWarpInputs(messages, context) {
    const inputs = [];

    if (!messages || !Array.isArray(messages)) {
        return inputs;
    }

    // 找到最后一条用户消息或工具结果
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage) {
        return inputs;
    }

    // 处理用户消息
    if (lastMessage.role === 'user') {
        const content = lastMessage.content;

        // 检查是否包含工具结果
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_result') {
                    // 这是工具结果
                    const toolResult = convertClaudeToolResultToWarp(block);
                    if (toolResult) {
                        inputs.push({ toolCallResult: toolResult });
                    }
                } else if (block.type === 'text' && block.text) {
                    // 这是文本消息
                    inputs.push({
                        userQuery: {
                            query: block.text,
                            referencedAttachments: {}
                        }
                    });
                }
            }
        } else if (typeof content === 'string') {
            // 简单的文本消息
            inputs.push({
                userQuery: {
                    query: content,
                    referencedAttachments: {}
                }
            });
        }
    }

    return inputs;
}

/**
 * 将 Claude 工具结果转换为 Warp 格式
 * @param {Object} toolResult - Claude 格式的工具结果
 * @returns {Object} Warp 格式的 ToolCallResult
 */
export function convertClaudeToolResultToWarp(toolResult) {
    if (!toolResult || !toolResult.tool_use_id) {
        return null;
    }

    const result = {
        toolCallId: toolResult.tool_use_id
    };

    // 解析工具名称和结果内容
    const content = toolResult.content;
    let resultText = '';

    if (typeof content === 'string') {
        resultText = content;
    } else if (Array.isArray(content)) {
        resultText = content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
    }

    // 检查是否有错误
    const isError = toolResult.is_error === true;

    // 根据工具类型构建结果
    // 由于我们无法从 tool_use_id 直接获取工具类型，需要从上下文中获取
    // 这里我们先尝试解析内容来判断工具类型

    // 默认作为 shell 命令结果处理（最常见的情况）
    result.runShellCommand = {
        command: '',  // 命令会在上下文中
        commandFinished: {
            output: resultText,
            exitCode: isError ? 1 : 0
        }
    };

    return result;
}

/**
 * 根据工具名称和参数，将 Claude 工具结果转换为 Warp 格式
 * @param {string} toolName - 工具名称 (Bash, Read, Edit, Write, Grep, Glob)
 * @param {string} toolCallId - 工具调用 ID
 * @param {Object} args - 工具参数
 * @param {string|Object} result - 工具执行结果
 * @param {boolean} isError - 是否为错误
 * @param {Object} context - 上下文信息 {pwd, home}
 * @returns {Object} Warp 格式的 ToolCallResult
 */
export function buildWarpToolResult(toolName, toolCallId, args, result, isError = false, context = {}) {
    const pwd = context.pwd || process.cwd();
    const home = context.home || process.env.HOME || '~';

    const warpResult = {
        toolCallId: toolCallId,
        // 添加 context 字段，这是 Warp 要求的
        context: {
            directory: {
                pwd: pwd,
                home: home,
                pwdFileSymbolsIndexed: false
            },
            operatingSystem: {
                platform: process.platform === 'darwin' ? 'MacOS' : process.platform,
                distribution: ''
            },
            shell: {
                name: process.env.SHELL || 'bash',
                version: ''
            },
            currentTime: {
                seconds: Math.floor(Date.now() / 1000),
                nanos: (Date.now() % 1000) * 1000000
            }
        }
    };

    // 获取结果文本
    let resultText = '';
    if (typeof result === 'string') {
        resultText = result;
    } else if (result && typeof result === 'object') {
        if (result.content) {
            if (typeof result.content === 'string') {
                resultText = result.content;
            } else if (Array.isArray(result.content)) {
                resultText = result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
            }
        }
    }

    switch (toolName) {
        case 'Bash':
            warpResult.runShellCommand = {
                command: args?.command || '',
                commandFinished: {
                    output: resultText,
                    exitCode: isError ? 1 : 0
                }
            };
            break;

        case 'Read':
            if (isError) {
                warpResult.readFiles = {
                    error: {
                        message: resultText
                    }
                };
            } else {
                // 解析文件内容
                const filePath = args?.file_path || '';
                warpResult.readFiles = {
                    success: {
                        files: [{
                            filePath: filePath,
                            content: resultText
                        }]
                    }
                };
            }
            break;

        case 'Edit':
        case 'Write':
            if (isError) {
                warpResult.applyFileDiffs = {
                    error: {
                        message: resultText
                    }
                };
            } else {
                const filePath = args?.file_path || '';
                warpResult.applyFileDiffs = {
                    success: {
                        updatedFilesV2: [{
                            file: {
                                filePath: filePath,
                                content: resultText
                            }
                        }]
                    }
                };
            }
            break;

        case 'Grep':
            if (isError) {
                warpResult.grep = {
                    error: {
                        message: resultText
                    }
                };
            } else {
                // 解析 grep 结果
                // 格式通常是 "file:line_number:content"
                const matchedFiles = [];
                const lines = resultText.split('\n');
                const fileMatches = new Map();

                for (const line of lines) {
                    const match = line.match(/^([^:]+):(\d+):/);
                    if (match) {
                        const [, filePath, lineNum] = match;
                        if (!fileMatches.has(filePath)) {
                            fileMatches.set(filePath, []);
                        }
                        fileMatches.get(filePath).push({ lineNumber: parseInt(lineNum) });
                    }
                }

                for (const [filePath, matchedLines] of fileMatches) {
                    matchedFiles.push({
                        filePath,
                        matchedLines
                    });
                }

                warpResult.grep = {
                    success: {
                        matchedFiles
                    }
                };
            }
            break;

        case 'Glob':
            if (isError) {
                warpResult.fileGlobV2 = {
                    error: {
                        message: resultText
                    }
                };
            } else {
                // 解析 glob 结果（每行一个文件路径）
                const matchedFiles = resultText
                    .split('\n')
                    .filter(line => line.trim())
                    .map(filePath => ({ filePath: filePath.trim() }));

                warpResult.fileGlobV2 = {
                    success: {
                        matchedFiles
                    }
                };
            }
            break;

        default:
            // 默认作为 shell 命令结果
            warpResult.runShellCommand = {
                command: '',
                commandFinished: {
                    output: resultText,
                    exitCode: isError ? 1 : 0
                }
            };
    }

    return warpResult;
}

/**
 * 构建内部工具调用的结果（如 server 类型）
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} toolName - 工具名称（如 _WarpServerInit）
 * @param {Object} context - 上下文信息
 * @returns {Object} Warp 格式的 ToolCallResult
 */
export function buildInternalToolResult(toolCallId, toolName, context = {}) {
    const pwd = context.pwd || process.cwd();
    const home = context.home || process.env.HOME || '~';

    const warpResult = {
        toolCallId: toolCallId,
        context: {
            directory: {
                pwd: pwd,
                home: home,
                pwdFileSymbolsIndexed: false
            },
            operatingSystem: {
                platform: process.platform === 'darwin' ? 'MacOS' : process.platform,
                distribution: ''
            },
            shell: {
                name: process.env.SHELL || 'bash',
                version: ''
            },
            currentTime: {
                seconds: Math.floor(Date.now() / 1000),
                nanos: (Date.now() % 1000) * 1000000
            }
        }
    };

    // 根据内部工具类型返回对应的结果
    if (toolName === '_WarpServerInit') {
        // server 类型需要返回 server 结果
        // payload "IgA=" 是空的 Protobuf 消息，我们返回相同格式
        warpResult.server = {
            payload: 'IgA='  // 空的 Protobuf 消息
        };
    } else if (toolName === '_WarpSuggestNewConversation') {
        // suggestNewConversation 类型
        warpResult.suggestNewConversation = {
            accepted: false
        };
    } else {
        // 未知内部工具，返回空的 server 结果
        warpResult.server = {
            payload: 'IgA='
        };
    }

    return warpResult;
}

/**
 * 将 Warp 工具调用转换为 Claude 格式
 * @param {Object} toolCall - Warp 格式的工具调用
 * @returns {Object} Claude 格式的工具调用
 */
export function convertWarpToolCallToClaude(toolCall) {
    if (!toolCall) return null;

    const claudeToolCall = {
        id: toolCall.toolCallId,
        type: 'tool_use'
    };

    if (toolCall.runShellCommand) {
        claudeToolCall.name = 'Bash';
        const command = toolCall.runShellCommand.command || '';
        // 如果命令为空，返回 null（等待 updateTaskMessage 提供完整参数）
        if (!command.trim()) {
            logger.info('[WarpConverter] Bash tool call with empty command, waiting for update');
            return null;
        }
        claudeToolCall.input = {
            command: command,
            description: toolCall.runShellCommand.description || ''
        };
    } else if (toolCall.readFiles) {
        claudeToolCall.name = 'Read';
        const files = toolCall.readFiles.files || [];
        const filePath = files[0]?.name || '';
        // 如果文件路径为空，返回 null（等待 updateTaskMessage 提供完整参数）
        if (!filePath.trim()) {
            logger.info('[WarpConverter] Read tool call with empty file_path, waiting for update');
            return null;
        }
        claudeToolCall.input = {
            file_path: filePath
        };
    } else if (toolCall.applyFileDiffs) {
        // 判断是 Edit 还是 Write
        const diffs = toolCall.applyFileDiffs.diffs || [];
        const newFiles = toolCall.applyFileDiffs.newFiles || [];

        if (newFiles.length > 0) {
            claudeToolCall.name = 'Write';
            const filePath = newFiles[0]?.filePath || '';
            if (!filePath.trim()) {
                logger.info('[WarpConverter] Write tool call with empty file_path, waiting for update');
                return null;
            }
            claudeToolCall.input = {
                file_path: filePath,
                content: newFiles[0]?.content || ''
            };
        } else if (diffs.length > 0) {
            claudeToolCall.name = 'Edit';
            const filePath = diffs[0]?.filePath || '';
            if (!filePath.trim()) {
                logger.info('[WarpConverter] Edit tool call with empty file_path, waiting for update');
                return null;
            }
            claudeToolCall.input = {
                file_path: filePath,
                old_string: diffs[0]?.search || '',
                new_string: diffs[0]?.replace || ''
            };
        } else {
            // 没有 diffs 也没有 newFiles，等待更新
            logger.info('[WarpConverter] applyFileDiffs tool call with no diffs/newFiles, waiting for update');
            return null;
        }
    } else if (toolCall.grep) {
        claudeToolCall.name = 'Grep';
        const pattern = (toolCall.grep.queries || [])[0] || '';
        if (!pattern.trim()) {
            logger.info('[WarpConverter] Grep tool call with empty pattern, waiting for update');
            return null;
        }
        claudeToolCall.input = {
            pattern: pattern,
            path: toolCall.grep.path || ''
        };
    } else if (toolCall.fileGlobV2 || toolCall.fileGlob) {
        claudeToolCall.name = 'Glob';
        const glob = toolCall.fileGlobV2 || toolCall.fileGlob;
        const pattern = (glob.patterns || [])[0] || '';
        if (!pattern.trim()) {
            logger.info('[WarpConverter] Glob tool call with empty pattern, waiting for update');
            return null;
        }
        claudeToolCall.input = {
            pattern: pattern,
            path: glob.searchDir || glob.path || ''
        };
    } else if (toolCall.server) {
        // server 类型是 Warp 内部初始化工具调用
        // payload 是 Base64 编码的 Protobuf 数据，目前观察到都是空字符串 "IgA="
        // 这是 Warp 在创建新任务时发送的占位符，需要返回一个特殊响应
        logger.info('[WarpConverter] Server tool call detected, payload:', toolCall.server.payload);

        // 解析 server payload
        const payload = toolCall.server.payload || '';
        let serverData = null;

        if (payload) {
            try {
                // Base64 解码
                const decoded = Buffer.from(payload, 'base64');
                // payload "IgA=" 解码后是 [0x22, 0x00]，表示 field 4 (string), 长度 0
                // 这是一个空的 Protobuf 消息
                if (decoded.length >= 2 && decoded[0] === 0x22 && decoded[1] === 0x00) {
                    serverData = { type: 'init', empty: true };
                } else {
                    // 尝试解析其他格式的 payload
                    serverData = { type: 'unknown', raw: decoded.toString('hex') };
                }
            } catch (e) {
                logger.warn('[WarpConverter] Failed to decode server payload:', e.message);
                serverData = { type: 'error', error: e.message };
            }
        }

        // 返回一个特殊的内部工具调用，标记为 server 类型
        // 这样上层代码可以识别并正确处理
        claudeToolCall.name = '_WarpServerInit';
        claudeToolCall.input = {
            payload: payload,
            serverData: serverData
        };
        // 标记为内部工具，不应该发送给 Claude Code
        claudeToolCall._internal = true;
    } else if (toolCall.suggestNewConversation) {
        // suggestNewConversation 是 Warp 建议开始新对话的工具调用
        logger.info('[WarpConverter] SuggestNewConversation tool call detected');
        claudeToolCall.name = '_WarpSuggestNewConversation';
        claudeToolCall.input = {
            messageId: toolCall.suggestNewConversation.messageId || ''
        };
        claudeToolCall._internal = true;
    } else {
        // 未知工具类型或空的工具调用对象
        const keys = Object.keys(toolCall).filter(k => k !== 'toolCallId');
        if (keys.length === 0) {
            // 完全空的工具调用，等待更新
            logger.info('[WarpConverter] Empty tool call object, waiting for update');
            return null;
        }
        logger.warn('[WarpConverter] Unknown tool call type:', keys);
        return null;
    }

    return claudeToolCall;
}

/**
 * 构建 Warp 请求的上下文
 * @param {string} workingDir - 工作目录
 * @param {string} homeDir - 用户主目录
 * @returns {Object} Warp InputContext
 */
export function buildWarpContext(workingDir, homeDir) {
    return {
        directory: {
            pwd: workingDir || process.cwd(),
            home: homeDir || process.env.HOME || '~',
            pwdFileSymbolsIndexed: false
        },
        operatingSystem: {
            platform: process.platform === 'darwin' ? 'MacOS' : process.platform,
            distribution: ''
        },
        shell: {
            name: process.env.SHELL || 'bash',
            version: ''
        },
        currentTime: {
            seconds: Math.floor(Date.now() / 1000).toString(),
            nanos: (Date.now() % 1000) * 1000000
        }
    };
}

/**
 * 构建 Warp 请求的设置
 * @param {string} modelName - 模型名称
 * @param {Array} tools - 工具列表
 * @returns {Object} Warp Settings
 */
export function buildWarpSettings(modelName = 'auto', tools = []) {
    const supportedTools = getSupportedToolTypes(tools);

    return {
        modelConfig: {
            base: modelName,
            planning: '',
            coding: ''
        },
        rulesEnabled: false,
        webContextRetrievalEnabled: false,
        supportsParallelToolCalls: false,
        useAnthropicTextEditorTools: false,
        planningEnabled: false,
        warpDriveContextEnabled: false,
        supportsCreateFiles: false,
        supportedTools: supportedTools,
        supportsLongRunningCommands: false,
        shouldPreserveFileContentInHistory: false,
        supportsTodosUi: false,
        supportsLinkedCodeBlocks: false
    };
}

/**
 * Warp 会话状态管理（支持跨进程共享）
 */
export class WarpSessionState {
    constructor(sessionKey = null) {
        this.maxMessages = 1000;
        this.maxMessageIds = 2000;
        this.maxPendingToolCalls = 512;
        this.maxTrackedToolIds = 2000;

        // 会话标识符（用于跨进程共享）
        this._sessionKey = sessionKey;

        // 会话 ID（由 Warp 响应中的 init 事件返回）
        this.conversationId = null;

        // 任务 ID（由 createTask 事件返回）
        this.taskId = null;

        // 任务描述
        this.taskDescription = null;

        // 历史消息（Warp Message 对象列表）
        this.messages = [];

        // 消息 ID 集合（用于去重）
        this.messageIds = new Set();

        // 待处理的工具调用（toolCallId -> toolCall）
        this.pendingToolCalls = new Map();

        // 已发送给 Warp 的工具结果 ID（用于去重）
        this.sentToolResults = new Set();

        // 已输出给 Claude Code 的工具调用 ID
        this.emittedToolCalls = new Set();

        // 缓存的工具定义
        this.cachedTools = null;

        // 从共享存储加载状态
        if (sessionKey) {
            this._loadFromSharedStore();
        }
    }

    _trimSet(setObj, maxSize) {
        if (!(setObj instanceof Set) || setObj.size <= maxSize) return;
        const overflow = setObj.size - maxSize;
        const toRemove = Array.from(setObj).slice(0, overflow);
        for (const key of toRemove) {
            setObj.delete(key);
        }
    }

    _trimMap(mapObj, maxSize) {
        if (!(mapObj instanceof Map) || mapObj.size <= maxSize) return;
        const overflow = mapObj.size - maxSize;
        const toRemove = Array.from(mapObj.keys()).slice(0, overflow);
        for (const key of toRemove) {
            mapObj.delete(key);
        }
    }

    _trimSessionState() {
        if (Array.isArray(this.messages) && this.messages.length > this.maxMessages) {
            this.messages = this.messages.slice(-this.maxMessages);
        }

        // 重新构建 messageIds，确保与 messages 一致，避免长期累计。
        const recentMessageIds = this.messages
            .map((m) => m?.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
        this.messageIds = new Set(recentMessageIds.slice(-this.maxMessageIds));

        this._trimMap(this.pendingToolCalls, this.maxPendingToolCalls);
        this._trimSet(this.sentToolResults, this.maxTrackedToolIds);
        this._trimSet(this.emittedToolCalls, this.maxTrackedToolIds);
    }

    /**
     * 设置会话标识符
     */
    setSessionKey(key) {
        this._sessionKey = key;
        this._loadFromSharedStore();
    }

    /**
     * 从共享存储加载状态
     */
    _loadFromSharedStore() {
        if (!this._sessionKey) return;

        const data = SharedSessionStore.load(this._sessionKey);
        if (data) {
            this.conversationId = data.conversationId || null;
            this.taskId = data.taskId || null;
            this.taskDescription = data.taskDescription || null;
            this.messages = data.messages || [];
            this.messageIds = new Set(data.messageIds || []);
            // 恢复 pendingToolCalls（从数组转换为 Map）
            this.pendingToolCalls = new Map(data.pendingToolCalls || []);
            // 恢复 sentToolResults 和 emittedToolCalls
            this.sentToolResults = new Set(data.sentToolResults || []);
            this.emittedToolCalls = new Set(data.emittedToolCalls || []);
            // 恢复 cachedTools
            if (data.cachedTools && data.cachedTools.length > 0) {
                this.cachedTools = data.cachedTools;
            }
            this._trimSessionState();
            logger.info('[WarpSession] Loaded session from shared store:', this._sessionKey,
                'conversationId:', this.conversationId, 'taskId:', this.taskId,
                'pendingToolCalls:', this.pendingToolCalls.size,
                'cachedTools:', this.cachedTools?.length || 0);
        }
    }

    /**
     * 保存到共享存储
     */
    _saveToSharedStore() {
        if (!this._sessionKey) return;
        this._trimSessionState();

        const data = {
            conversationId: this.conversationId,
            taskId: this.taskId,
            taskDescription: this.taskDescription,
            messages: this.messages.slice(-this.maxMessages),
            messageIds: Array.from(this.messageIds).slice(-this.maxMessageIds),
            pendingToolCalls: Array.from(this.pendingToolCalls.entries()),
            sentToolResults: Array.from(this.sentToolResults),
            emittedToolCalls: Array.from(this.emittedToolCalls),
            cachedTools: this.cachedTools || [] // 保存工具缓存
        };
        SharedSessionStore.save(this._sessionKey, data);
    }

    /**
     * 添加消息
     */
    addMessage(message) {
        if (!message || !message.id) return;

        if (this.messageIds.has(message.id)) {
            logger.info('[WarpSession] Skipping duplicate message:', message.id);
            return;
        }

        this.messageIds.add(message.id);
        this.messages.push(message);
        this._trimSessionState();
        this._saveToSharedStore();
    }

    /**
     * 更新消息
     */
    updateMessage(messageId, updates) {
        const index = this.messages.findIndex(m => m.id === messageId);
        if (index >= 0) {
            this.messages[index] = { ...this.messages[index], ...updates };
            this._saveToSharedStore();
        }
    }

    /**
     * 添加待处理的工具调用
     */
    addPendingToolCall(toolCall) {
        if (!toolCall || !toolCall.toolCallId) return;
        this.pendingToolCalls.set(toolCall.toolCallId, toolCall);
        this._trimSessionState();
        this._saveToSharedStore();
        logger.info('[WarpSession] Added pending tool call:', toolCall.toolCallId,
            'total pending:', this.pendingToolCalls.size);
    }

    /**
     * 获取待处理的工具调用（不删除）
     */
    getPendingToolCall(toolCallId) {
        // 先尝试从当前内存获取
        let toolCall = this.pendingToolCalls.get(toolCallId);

        // 如果内存中没有，尝试从共享存储重新加载
        if (!toolCall && this._sessionKey) {
            this._loadFromSharedStore();
            toolCall = this.pendingToolCalls.get(toolCallId);
        }

        if (toolCall) {
            logger.info('[WarpSession] Got pending tool call:', toolCallId);
        } else {
            logger.warn('[WarpSession] Tool call not found:', toolCallId);
        }
        return toolCall;
    }

    /**
     * 获取并移除待处理的工具调用
     * @param {string} toolCallId - 工具调用 ID
     * @param {boolean} keepInStore - 是否保留在存储中（默认 false，即删除）
     */
    consumePendingToolCall(toolCallId, keepInStore = false) {
        // 先尝试从当前内存获取
        let toolCall = this.pendingToolCalls.get(toolCallId);

        // 如果内存中没有，尝试从共享存储重新加载
        if (!toolCall && this._sessionKey) {
            this._loadFromSharedStore();
            toolCall = this.pendingToolCalls.get(toolCallId);
        }

        if (toolCall) {
            if (!keepInStore) {
                this.pendingToolCalls.delete(toolCallId);
                this._saveToSharedStore();
                logger.info('[WarpSession] Consumed and removed pending tool call:', toolCallId);
            } else {
                logger.info('[WarpSession] Consumed pending tool call (kept in store):', toolCallId);
            }
        } else {
            logger.warn('[WarpSession] Tool call not found:', toolCallId);
        }
        return toolCall;
    }

    /**
     * 删除指定的待处理工具调用
     */
    removePendingToolCall(toolCallId) {
        if (this.pendingToolCalls.has(toolCallId)) {
            this.pendingToolCalls.delete(toolCallId);
            this._saveToSharedStore();
            logger.info('[WarpSession] Removed pending tool call:', toolCallId);
            return true;
        }
        return false;
    }

    /**
     * 清空会话
     */
    clear() {
        this.conversationId = null;
        this.taskId = null;
        this.taskDescription = null;
        this.messages = [];
        this.messageIds.clear();
        this.pendingToolCalls.clear();
        this.sentToolResults.clear();
        this.emittedToolCalls.clear();
        this.cachedTools = null;
        if (this._sessionKey) {
            SharedSessionStore.remove(this._sessionKey);
        }
    }

    /**
     * 标记工具调用已输出给 Claude Code
     */
    markToolCallEmitted(toolCallId) {
        this.emittedToolCalls.add(toolCallId);
        this._trimSet(this.emittedToolCalls, this.maxTrackedToolIds);
        this._saveToSharedStore();
        logger.info('[WarpSession] Marked tool call as emitted:', toolCallId);
    }

    /**
     * 检查工具调用是否已输出
     */
    isToolCallEmitted(toolCallId) {
        return this.emittedToolCalls.has(toolCallId);
    }

    /**
     * 标记工具结果已发送给 Warp
     */
    markToolResultSent(toolCallId) {
        this.sentToolResults.add(toolCallId);
        this._trimSet(this.sentToolResults, this.maxTrackedToolIds);
        this._saveToSharedStore();
        logger.info('[WarpSession] Marked tool result as sent:', toolCallId);
    }

    /**
     * 检查工具结果是否已发送
     */
    isToolResultSent(toolCallId) {
        return this.sentToolResults.has(toolCallId);
    }

    /**
     * 获取所有未输出的待处理工具调用
     */
    getUnemittedToolCalls() {
        const result = [];
        for (const [id, toolCall] of this.pendingToolCalls) {
            if (!this.emittedToolCalls.has(id)) {
                result.push(toolCall);
            }
        }
        return result;
    }

    /**
     * 检查会话是否有效
     */
    isValid() {
        return !!this.conversationId && !!this.taskId;
    }
}
