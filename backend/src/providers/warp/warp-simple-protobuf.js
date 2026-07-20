/**
 * Warp Protobuf 编码/解码器 - 使用官方 proto 定义
 * 重构版本：使用 protobufjs 和官方 proto 文件
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import {
    initProto,
    getTypes,
    encodeRequest,
    decodeResponseEvent,
    decodeMessage
} from './warp-proto.js';

// Warp ToolType 枚举映射（来自 task.proto）
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

// Claude Code 工具名称到 Warp ToolType 的映射
const TOOL_NAME_TO_TYPE = {
    'Bash': TOOL_TYPE_ENUM.RUN_SHELL_COMMAND,
    'Read': TOOL_TYPE_ENUM.READ_FILES,
    'Edit': TOOL_TYPE_ENUM.APPLY_FILE_DIFFS,
    'Write': TOOL_TYPE_ENUM.APPLY_FILE_DIFFS,
    'Grep': TOOL_TYPE_ENUM.GREP,
    'Glob': TOOL_TYPE_ENUM.FILE_GLOB_V2,
    // MCP 工具
    'mcp__zai-mcp-server__ui_to_artifact': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__extract_text_from_screenshot': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__diagnose_error_screenshot': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__understand_technical_diagram': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__analyze_data_visualization': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__ui_diff_check': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__analyze_image': TOOL_TYPE_ENUM.CALL_MCP_TOOL,
    'mcp__zai-mcp-server__analyze_video': TOOL_TYPE_ENUM.CALL_MCP_TOOL
};

/**
 * Warp 会话状态管理
 * 保留原有的 WarpSession 类，因为它管理会话状态很有用
 */
export class WarpSession {
    constructor() {
        // conversationId 和 taskId 在 Warp 中是同一个 ID
        this.conversationId = null;
        this.taskId = null;  // 与 conversationId 相同

        // messageTaskId 是另一个 ID，用于 Message.taskId
        this.messageTaskId = null;

        // metadataId 用于 Metadata.conversationId
        this.metadataId = null;

        this.taskDescription = null;
        // 保存原始的 Message protobuf bytes，用于多轮对话
        this.rawMessages = [];
        // 用于去重的 Message ID 集合
        this.messageIds = new Set();
        // 缓存工具定义，用于多轮对话
        this.cachedTools = null;
    }

    /**
     * 添加原始消息 bytes（带去重）
     */
    addRawMessage(messageBytes) {
        if (!messageBytes || messageBytes.length === 0) return;

        try {
            // 使用 protobuf 解码来提取 Message ID
            const message = decodeMessage(messageBytes);
            const messageId = message.id;

            if (messageId && this.messageIds.has(messageId)) {
                logger.info('[WarpSession] Skipping duplicate message:', messageId);
                return;
            }

            if (messageId) {
                this.messageIds.add(messageId);
            }

            this.rawMessages.push(messageBytes);
        } catch (e) {
            logger.warn('[WarpSession] Failed to extract message ID, adding anyway:', e.message);
            // 如果提取失败，仍然保存（避免丢失数据）
            this.rawMessages.push(messageBytes);
        }
    }

    /**
     * 清空会话
     */
    clear() {
        this.conversationId = null;
        this.taskId = null;
        this.messageTaskId = null;
        this.metadataId = null;
        this.taskDescription = null;
        this.rawMessages = [];
        this.messageIds.clear();
        this.cachedTools = null;
    }
}

/**
 * 构建简单的 Protobuf 请求（新会话）
 */
export function buildSimpleProtobufRequest(
    message,
    workingDir = process.cwd(),
    homeDir = process.env.HOME || '~',
    modelName = 'claude-sonnet-4-5',
    tools = null
) {
    const types = getTypes();

    // 转换工具定义为 Warp ToolType 枚举
    const supportedTools = [];
    const toolNames = [];
    if (tools && Array.isArray(tools) && tools.length > 0) {
        for (const tool of tools) {
            const toolName = tool.name || tool.function?.name;
            if (toolName && TOOL_NAME_TO_TYPE[toolName] !== undefined) {
                const toolType = TOOL_NAME_TO_TYPE[toolName];
                if (!supportedTools.includes(toolType)) {
                    supportedTools.push(toolType);
                    toolNames.push(toolName);
                }
            }
        }
        logger.info('[buildSimpleProtobufRequest] supportedTools:', toolNames.join(', '));
    }

    const requestData = {
        input: {
            context: {
                directory: {
                    pwd: workingDir,
                    home: homeDir,
                    pwdFileSymbolsIndexed: false
                },
                operatingSystem: {
                    platform: process.platform,
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
            },
            userInputs: {
                inputs: [{
                    userQuery: {
                        query: message,
                        referencedAttachments: {}
                    }
                }]
            }
        },
        settings: {
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
        },
        metadata: {
            conversationId: '',
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

/**
 * 构建多轮对话请求（使用原始 Message bytes）
 */
export function buildMultiTurnProtobufRequestWithRawMessages(
    message,
    session,
    workingDir = process.cwd(),
    homeDir = process.env.HOME || '~',
    modelName = 'claude-sonnet-4-5',
    tools = null
) {
    // 添加调试日志
    logger.info('[buildMultiTurnProtobufRequestWithRawMessages] session.conversationId:', session.conversationId);
    logger.info('[buildMultiTurnProtobufRequestWithRawMessages] session.taskId:', session.taskId);
    logger.info('[buildMultiTurnProtobufRequestWithRawMessages] session.messageTaskId:', session.messageTaskId);
    logger.info('[buildMultiTurnProtobufRequestWithRawMessages] session.metadataId:', session.metadataId);
    logger.info('[buildMultiTurnProtobufRequestWithRawMessages] tools:', tools ? `${tools.length} tools` : 'null');

    if (!session || !session.conversationId || !session.taskId) {
        throw new Error('Invalid session: missing conversationId or taskId');
    }

    const types = getTypes();

    // 转换工具定义为 Warp ToolType 枚举
    const supportedTools = [];
    const toolNames = [];
    if (tools && Array.isArray(tools) && tools.length > 0) {
        for (const tool of tools) {
            const toolName = tool.name || tool.function?.name;
            if (toolName && TOOL_NAME_TO_TYPE[toolName] !== undefined) {
                const toolType = TOOL_NAME_TO_TYPE[toolName];
                if (!supportedTools.includes(toolType)) {
                    supportedTools.push(toolType);
                    toolNames.push(toolName);
                }
            }
        }
        logger.info('[buildMultiTurnProtobufRequestWithRawMessages] supportedTools:', toolNames.join(', '));
    }

    // 多轮对话的后续请求：不发送 taskContext，只发送新的 input
    // Warp 会自动将新消息添加到现有的 conversation 中
    const requestData = {
        input: {
            context: {
                directory: {
                    pwd: workingDir,
                    home: homeDir,
                    pwdFileSymbolsIndexed: false
                },
                operatingSystem: {
                    platform: process.platform,
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
            },
            userInputs: {
                inputs: [{
                    userQuery: {
                        query: message,
                        referencedAttachments: {}
                    }
                }]
            }
        },
        settings: {
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
        },
        metadata: {
            conversationId: session.metadataId || session.conversationId,
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

/**
 * 解析 Base64 编码的 Protobuf 响应
 */
export function parseBase64Protobuf(base64Data) {
    const buffer = Buffer.from(base64Data, 'base64');
    return decodeResponseEvent(buffer);
}

/**
 * 解析 Base64 编码的 Protobuf 响应（带 UUID 提取）
 */
export function parseBase64ProtobufWithUUIDs(base64Data) {
    const responseEvent = parseBase64Protobuf(base64Data);
    const result = {
        event: responseEvent,
        conversationId: null,
        requestId: null
    };

    // 提取 StreamInit 中的 ID
    if (responseEvent.init) {
        result.conversationId = responseEvent.init.conversationId || null;
        result.requestId = responseEvent.init.requestId || null;
    }

    return result;
}

/**
 * 解析 Warp 响应，提取文本和消息
 */
export function parseWarpResponse(base64Data) {
    const responseEvent = parseBase64Protobuf(base64Data);
    const result = {
        text: '',
        messages: [],
        conversationId: null,
        requestId: null,
        finished: false,
        finishReason: null
    };

    // 处理 StreamInit
    if (responseEvent.init) {
        result.conversationId = responseEvent.init.conversationId || null;
        result.requestId = responseEvent.init.requestId || null;
    }

    // 处理 ClientActions
    if (responseEvent.clientActions && responseEvent.clientActions.actions) {
        for (const action of responseEvent.clientActions.actions) {
            // 处理 AddMessagesToTask
            if (action.addMessagesToTask && action.addMessagesToTask.messages) {
                for (const message of action.addMessagesToTask.messages) {
                    result.messages.push(message);

                    // 提取 AgentOutput 文本
                    if (message.agentOutput && message.agentOutput.text) {
                        result.text += message.agentOutput.text;
                    }
                }
            }

            // 处理 AppendToMessageContent
            if (action.appendToMessageContent && action.appendToMessageContent.message) {
                const message = action.appendToMessageContent.message;
                if (message.agentOutput && message.agentOutput.text) {
                    result.text += message.agentOutput.text;
                }
            }
        }
    }

    // 处理 StreamFinished
    if (responseEvent.finished) {
        result.finished = true;

        // 提取结束原因
        if (responseEvent.finished.done) {
            result.finishReason = 'done';
        } else if (responseEvent.finished.maxTokenLimit) {
            result.finishReason = 'max_token_limit';
        } else if (responseEvent.finished.quotaLimit) {
            result.finishReason = 'quota_limit';
        } else if (responseEvent.finished.contextWindowExceeded) {
            result.finishReason = 'context_window_exceeded';
        } else if (responseEvent.finished.llmUnavailable) {
            result.finishReason = 'llm_unavailable';
        } else if (responseEvent.finished.internalError) {
            result.finishReason = 'internal_error';
        } else if (responseEvent.finished.other) {
            result.finishReason = 'other';
        }
    }

    return result;
}

/**
 * 从文本数组中提取并合并文本
 */
export function extractText(texts) {
    if (!Array.isArray(texts)) return '';
    return texts.join('');
}

/**
 * 将 Claude 格式的工具结果转换为 Warp 的 ToolCallResult 格式
 * @param {Object} toolResult - Claude 格式的工具结果
 * @param {string} toolName - 工具名称（从消息历史中提取）
 */
function convertClaudeToolResultToWarp(toolResult, toolName = null) {
    const toolUseId = toolResult.tool_use_id || '';
    let content = '';

    // 处理 content 可能是字符串或数组的情况
    if (typeof toolResult.content === 'string') {
        content = toolResult.content;
    } else if (Array.isArray(toolResult.content)) {
        content = toolResult.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
    }

    const result = { toolCallId: toolUseId };

    // 根据工具名称选择正确的结果类型
    switch (toolName) {
        case 'Bash':
            result.runShellCommand = {
                commandFinished: {
                    output: content,
                    exitCode: 0
                }
            };
            break;
        case 'Read':
            result.readFiles = {
                success: {
                    files: [{
                        content: content,
                        path: ''
                    }]
                }
            };
            break;
        case 'Grep':
            result.grep = {
                success: {
                    matchedFiles: []
                }
            };
            break;
        case 'Glob':
            result.fileGlobV2 = {
                success: {
                    matchedFiles: content.split('\n').filter(Boolean).map(f => ({ filePath: f }))
                }
            };
            break;
        case 'Edit':
        case 'Write':
            result.applyFileDiffs = {
                success: {}
            };
            break;
        default:
            // 默认使用 runShellCommand 作为通用结果格式
            result.runShellCommand = {
                commandFinished: {
                    output: content,
                    exitCode: 0
                }
            };
    }

    return result;
}

/**
 * 构建包含工具结果的请求（新实现）
 * 支持将 Claude 格式的消息（包括工具结果）转换为 Warp 格式
 */
export function buildRequestWithToolResults(
    messages,
    workingDir = process.cwd(),
    homeDir = process.env.HOME || '~',
    conversationId = null,
    modelName = 'claude-sonnet-4-5',
    tools = null
) {
    const types = getTypes();

    // 转换工具定义为 Warp ToolType 枚举
    const supportedTools = [];
    const toolNames = [];
    if (tools && Array.isArray(tools) && tools.length > 0) {
        for (const tool of tools) {
            const toolName = tool.name || tool.function?.name;
            if (toolName && TOOL_NAME_TO_TYPE[toolName] !== undefined) {
                const toolType = TOOL_NAME_TO_TYPE[toolName];
                if (!supportedTools.includes(toolType)) {
                    supportedTools.push(toolType);
                    toolNames.push(toolName);
                }
            }
        }
        logger.info('[buildRequestWithToolResults] supportedTools:', toolNames.join(', '));
    }

    // 构建 UserInputs
    const userInputs = [];

    // 从消息历史中提取 tool_use_id -> tool_name 的映射
    const toolIdToName = new Map();
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_use' && block.id && block.name) {
                    toolIdToName.set(block.id, block.name);
                }
            }
        }
    }
    logger.info('[buildRequestWithToolResults] Found', toolIdToName.size, 'tool_use mappings');

    // 遍历消息，提取工具结果和用户查询
    for (const msg of messages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_result') {
                    // 获取工具名称
                    const toolName = toolIdToName.get(block.tool_use_id) || null;
                    // 添加工具结果
                    const toolCallResult = convertClaudeToolResultToWarp(block, toolName);
                    userInputs.push({
                        toolCallResult: toolCallResult
                    });
                } else if (block.type === 'text' && block.text && !block.text.includes('<system-reminder>')) {
                    // 添加用户查询（排除 system-reminder）
                    userInputs.push({
                        userQuery: {
                            query: block.text,
                            referencedAttachments: {}
                        }
                    });
                }
            }
        } else if (msg.role === 'user' && typeof msg.content === 'string') {
            // 简单文本消息
            userInputs.push({
                userQuery: {
                    query: msg.content,
                    referencedAttachments: {}
                }
            });
        }
    }

    // 如果没有提取到任何输入，添加一个空查询
    if (userInputs.length === 0) {
        const lastMessage = messages[messages.length - 1];
        let query = '';
        if (typeof lastMessage?.content === 'string') {
            query = lastMessage.content;
        } else if (Array.isArray(lastMessage?.content)) {
            query = lastMessage.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('');
        }
        userInputs.push({
            userQuery: {
                query: query || 'Continue',
                referencedAttachments: {}
            }
        });
    }

    logger.info('[buildRequestWithToolResults] Generated', userInputs.length, 'user inputs');

    const requestData = {
        input: {
            context: {
                directory: {
                    pwd: workingDir,
                    home: homeDir,
                    pwdFileSymbolsIndexed: false
                },
                operatingSystem: {
                    platform: process.platform,
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
            },
            userInputs: {
                inputs: userInputs
            }
        },
        settings: {
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
        },
        metadata: {
            conversationId: conversationId || '',
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

/**
 * 构建多轮对话请求（兼容旧版本接口）
 */
export function buildMultiTurnProtobufRequest(
    messages,
    workingDir = process.cwd(),
    homeDir = process.env.HOME || '~',
    conversationId = null,
    messageTaskId = null,
    metadataId = null,
    tools = null,
    modelName = 'claude-sonnet-4-5'
) {
    // 提取消息文本
    let message;
    if (typeof messages === 'string') {
        // 如果是字符串，直接使用
        message = messages;
    } else if (Array.isArray(messages)) {
        // 如果是数组，提取最后一条消息的内容
        const lastMessage = messages[messages.length - 1];
        if (typeof lastMessage === 'string') {
            message = lastMessage;
        } else if (lastMessage && typeof lastMessage.content === 'string') {
            message = lastMessage.content;
        } else if (lastMessage && Array.isArray(lastMessage.content)) {
            // 处理复杂的 content 数组
            message = lastMessage.content
                .map(item => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item.text === 'string') return item.text;
                    return '';
                })
                .join('');
        } else {
            throw new Error('Unable to extract message text from messages array');
        }
    } else {
        throw new Error('Invalid messages parameter: expected string or array');
    }

    // 如果没有 conversationId，说明是新会话，使用简单请求
    if (!conversationId) {
        logger.info('[warp-simple-protobuf] No conversationId, using buildSimpleProtobufRequest');
        return buildSimpleProtobufRequest(message, workingDir, homeDir, modelName, tools);
    }

    // 有 conversationId，使用多轮对话请求
    logger.warn('[warp-simple-protobuf] buildMultiTurnProtobufRequest is deprecated, use buildMultiTurnProtobufRequestWithRawMessages instead');

    // 创建一个临时 session
    const session = new WarpSession();
    session.conversationId = conversationId;
    session.taskId = conversationId;
    session.messageTaskId = messageTaskId;
    session.metadataId = metadataId;

    return buildMultiTurnProtobufRequestWithRawMessages(
        message,
        session,
        workingDir,
        homeDir,
        modelName,
        tools
    );
}
