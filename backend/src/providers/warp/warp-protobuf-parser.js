/**
 * Warp Protobuf SSE 响应解析器 - 使用官方 proto 定义
 * 重构版本：使用 protobufjs 和官方 proto 文件
 */

import { logger } from '../../utils/logger.js';
import {
    getTypes,
    decodeResponseEvent,
    decodeMessage
} from './warp-proto.js';

/**
 * 解析 Warp SSE 响应
 * 返回结构化的响应数据
 */
export function parseWarpSSEResponse(base64Data) {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        const responseEvent = decodeResponseEvent(buffer);

        const result = {
            type: null,
            data: null,
            conversationId: null,
            requestId: null,
            text: '',
            messages: [],
            finished: false,
            finishReason: null,
            rawEvent: responseEvent,
            // 用于追踪消息 ID
            messageId: null,
            taskId: null,
            // 用于会话管理的额外 ID
            metadata_id: null,
            task_id: null,
            // 原始消息 bytes（用于多轮对话）
            rawMessages: []
        };

        // 判断事件类型
        if (responseEvent.init) {
            result.type = 'init';
            result.data = responseEvent.init;
            result.conversationId = responseEvent.init.conversationId || null;
            result.requestId = responseEvent.init.requestId || null;
            // 提取 StreamInit 的 ID 字段
            result.metadata_id = responseEvent.init.conversationId || null;
            result.task_id = responseEvent.init.requestId || null;
        } else if (responseEvent.clientActions) {
            result.type = 'actions';
            result.data = responseEvent.clientActions;

            // 处理所有 actions
            if (responseEvent.clientActions.actions) {
                const actions = responseEvent.clientActions.actions;
                result.messages = extractMessagesFromActions(actions);

                // 提取 task_id（从 AddMessagesToTask）
                for (const action of actions) {
                    if (action.addMessagesToTask && action.addMessagesToTask.taskId) {
                        result.task_id = action.addMessagesToTask.taskId;
                        break;
                    }
                }

                // 提取所有消息的文本、工具调用和 ID
                if (result.messages.length > 0) {
                    const textChunks = [];
                    const toolCalls = [];

                    for (const message of result.messages) {
                        // 提取文本
                        const text = extractTextFromMessage(message);
                        if (text) {
                            textChunks.push({
                                messageId: message.id || null,
                                taskId: message.taskId || null,
                                text: text
                            });
                        }

                        // 提取工具调用
                        const toolCall = extractToolCallFromMessage(message);
                        if (toolCall) {
                            toolCalls.push(toolCall);
                        }

                        // 保存原始消息 bytes（用于多轮对话）
                        if (message) {
                            try {
                                const types = getTypes();
                                const msgBytes = types.Message.encode(message).finish();
                                result.rawMessages.push(msgBytes);
                            } catch (e) {
                                // 忽略编码错误
                            }
                        }
                    }

                    // 如果有文本块，使用第一个的 ID
                    if (textChunks.length > 0) {
                        result.messageId = textChunks[0].messageId;
                        result.taskId = textChunks[0].taskId;
                        result.text = textChunks.map(chunk => chunk.text).join('');
                        result.textChunks = textChunks;
                    }

                    // 保存工具调用
                    if (toolCalls.length > 0) {
                        result.tool_calls = toolCalls;
                    }
                }
            }
        } else if (responseEvent.finished) {
            result.type = 'finished';
            result.data = responseEvent.finished;
            result.finished = true;
            result.finishReason = extractFinishReason(responseEvent.finished);
        }

        return result;
    } catch (error) {
        logger.error('[parseWarpSSEResponse] Failed to parse:', error);
        throw error;
    }
}

/**
 * 从 actions 中提取所有消息
 */
function extractMessagesFromActions(actions) {
    const messages = [];

    for (const action of actions) {
        // AddMessagesToTask
        if (action.addMessagesToTask && action.addMessagesToTask.messages) {
            messages.push(...action.addMessagesToTask.messages);
        }

        // AppendToMessageContent
        if (action.appendToMessageContent && action.appendToMessageContent.message) {
            messages.push(action.appendToMessageContent.message);
        }

        // UpdateTaskMessage
        if (action.updateTaskMessage && action.updateTaskMessage.message) {
            messages.push(action.updateTaskMessage.message);
        }
    }

    return messages;
}

/**
 * 从单个消息中提取文本
 */
function extractTextFromMessage(message) {
    if (!message) return '';

    // AgentOutput
    if (message.agentOutput && message.agentOutput.text) {
        return message.agentOutput.text;
    }

    return '';
}

/**
 * 从单个消息中提取工具调用
 */
function extractToolCallFromMessage(message) {
    if (!message || !message.toolCall) return null;

    const toolCall = message.toolCall;
    const result = {
        tool_call_id: toolCall.toolCallId || '',
        tool_type: null,
        tool_name: null,
        tool_input: {}
    };

    // 检查各种工具类型
    if (toolCall.runShellCommand) {
        result.tool_type = 'Bash';
        result.tool_name = 'Bash';
        result.tool_input = {
            command: toolCall.runShellCommand.command || ''
        };
    } else if (toolCall.readFiles) {
        result.tool_type = 'Read';
        result.tool_name = 'Read';
        // ReadFiles.files 是一个数组，每个元素有 name 字段
        const firstFile = toolCall.readFiles.files?.[0];
        result.tool_input = {
            file_path: firstFile?.name || ''
        };
    } else if (toolCall.grep) {
        result.tool_type = 'Grep';
        result.tool_name = 'Grep';
        // Grep.queries 是一个数组，取第一个
        result.tool_input = {
            pattern: toolCall.grep.queries?.[0] || '',
            path: toolCall.grep.path || ''
        };
    } else if (toolCall.fileGlobV2) {
        result.tool_type = 'Glob';
        result.tool_name = 'Glob';
        // FileGlobV2.patterns 是一个数组，取第一个
        result.tool_input = {
            pattern: toolCall.fileGlobV2.patterns?.[0] || '',
            path: toolCall.fileGlobV2.searchDir || ''
        };
    } else if (toolCall.callMcpTool) {
        result.tool_type = toolCall.callMcpTool.name || 'unknown';
        result.tool_name = toolCall.callMcpTool.name || 'unknown';
        // MCP 工具的参数是 google.protobuf.Struct 格式
        result.tool_input = convertStructToObject(toolCall.callMcpTool.args);
    } else if (toolCall.applyFileDiffs) {
        // ApplyFileDiffs → Edit/Write 工具
        const diffs = toolCall.applyFileDiffs.diffs || [];
        const newFiles = toolCall.applyFileDiffs.newFiles || [];

        if (diffs.length > 0) {
            // 有 diff，使用 Edit 工具
            const firstDiff = diffs[0];
            result.tool_type = 'Edit';
            result.tool_name = 'Edit';
            result.tool_input = {
                file_path: firstDiff.filePath || '',
                old_string: firstDiff.search || '',
                new_string: firstDiff.replace || ''
            };
        } else if (newFiles.length > 0) {
            // 创建新文件，使用 Write 工具
            const firstFile = newFiles[0];
            result.tool_type = 'Write';
            result.tool_name = 'Write';
            result.tool_input = {
                file_path: firstFile.filePath || '',
                content: firstFile.content || ''
            };
        }
    } else if (toolCall.searchCodebase) {
        // SearchCodebase → Grep 工具（近似映射）
        result.tool_type = 'Grep';
        result.tool_name = 'Grep';
        result.tool_input = {
            pattern: toolCall.searchCodebase.query || '',
            path: toolCall.searchCodebase.codebasePath || ''
        };
    } else if (toolCall.readMcpResource) {
        // ReadMCPResource
        result.tool_type = 'ReadMCPResource';
        result.tool_name = 'ReadMCPResource';
        result.tool_input = {
            uri: toolCall.readMcpResource.uri || ''
        };
    } else if (toolCall.writeToLongRunningShellCommand) {
        // WriteToLongRunningShellCommand → Bash 工具
        result.tool_type = 'Bash';
        result.tool_name = 'Bash';
        const inputBytes = toolCall.writeToLongRunningShellCommand.input;
        result.tool_input = {
            command: inputBytes ? Buffer.from(inputBytes).toString('utf-8') : ''
        };
    } else if (toolCall.fileGlob) {
        // 旧版 FileGlob（已废弃但仍需支持）
        result.tool_type = 'Glob';
        result.tool_name = 'Glob';
        result.tool_input = {
            pattern: toolCall.fileGlob.patterns?.[0] || '',
            path: toolCall.fileGlob.path || ''
        };
    }

    return result;
}

/**
 * 将 google.protobuf.Struct 转换为普通对象
 */
function convertStructToObject(struct) {
    if (!struct || !struct.fields) return {};

    const result = {};
    for (const [key, value] of Object.entries(struct.fields)) {
        result[key] = convertValueToPlain(value);
    }
    return result;
}

/**
 * 将 google.protobuf.Value 转换为普通值
 */
function convertValueToPlain(value) {
    if (!value) return null;

    if (value.nullValue !== undefined) return null;
    if (value.numberValue !== undefined) return value.numberValue;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.boolValue !== undefined) return value.boolValue;

    if (value.structValue) {
        return convertStructToObject(value.structValue);
    }

    if (value.listValue && value.listValue.values) {
        return value.listValue.values.map(v => convertValueToPlain(v));
    }

    return null;
}

/**
 * 从消息数组中提取文本（已废弃，保留用于兼容）
 */
function extractTextFromMessages(messages) {
    let text = '';

    for (const message of messages) {
        // AgentOutput
        if (message.agentOutput && message.agentOutput.text) {
            text += message.agentOutput.text;
        }

        // UserQuery
        if (message.userQuery && message.userQuery.query) {
            // 通常不需要用户查询的文本，但保留以防需要
            // text += message.userQuery.query;
        }
    }

    return text;
}

/**
 * 提取结束原因
 */
function extractFinishReason(finished) {
    if (finished.done) return 'done';
    if (finished.maxTokenLimit) return 'max_token_limit';
    if (finished.quotaLimit) return 'quota_limit';
    if (finished.contextWindowExceeded) return 'context_window_exceeded';
    if (finished.llmUnavailable) return 'llm_unavailable';
    if (finished.internalError) return 'internal_error';
    if (finished.other) return 'other';
    return 'unknown';
}

/**
 * 从 SSE 响应中提取文本（简化版本）
 */
export function extractTextFromSSE(base64Data) {
    try {
        const parsed = parseWarpSSEResponse(base64Data);
        return parsed.text || '';
    } catch (error) {
        logger.error('[extractTextFromSSE] Failed:', error);
        return '';
    }
}

/**
 * 从 SSE 响应中提取会话信息
 */
export function extractSessionInfoFromSSE(base64Data) {
    try {
        const parsed = parseWarpSSEResponse(base64Data);
        return {
            conversationId: parsed.conversationId,
            requestId: parsed.requestId
        };
    } catch (error) {
        logger.error('[extractSessionInfoFromSSE] Failed:', error);
        return {
            conversationId: null,
            requestId: null
        };
    }
}

/**
 * 调试用：解析并打印 protobuf 结构
 */
export function debugParseProtobuf(base64Data, maxDepth = 10) {
    try {
        const parsed = parseWarpSSEResponse(base64Data);
        logger.info('[debugParseProtobuf] Parsed response:', JSON.stringify(parsed, null, 2));
        return parsed;
    } catch (error) {
        logger.error('[debugParseProtobuf] Failed:', error);
        return null;
    }
}
