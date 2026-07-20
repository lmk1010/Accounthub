/**
 * Warp Protobuf 消息定义和工具
 * 使用 protobufjs 动态加载官方 proto 文件
 */

import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Proto 文件目录
const PROTO_DIR = path.join(__dirname, 'proto');

let root = null;
let types = null;

/**
 * 初始化 protobuf 类型定义
 */
export async function initProto() {
    if (root) return types;

    try {
        // 使用 protobufjs 的 loadSync 方法，它会自动处理 Google 标准类型
        // 配置搜索路径
        const loadOptions = {
            keepCase: false,
            alternateComments: false,
            preferTrailingComment: false
        };

        // 创建一个新的 Root 实例
        root = new protobuf.Root();

        // 配置路径解析
        root.resolvePath = (origin, target) => {
            // 如果是绝对路径，直接返回
            if (path.isAbsolute(target)) {
                return target;
            }
            // Google 标准 proto 文件：从本地 proto 目录加载
            if (target.startsWith('google/protobuf/')) {
                return path.join(PROTO_DIR, target);
            }
            // 相对路径：如果 origin 存在且是绝对路径，相对于 origin 解析
            if (origin && path.isAbsolute(origin)) {
                return path.join(path.dirname(origin), target);
            }
            // 否则从我们的 proto 目录加载
            return path.join(PROTO_DIR, target);
        };

        // 加载主 proto 文件（依赖会自动加载）
        root = await root.load([
            path.join(PROTO_DIR, 'request.proto'),
            path.join(PROTO_DIR, 'response.proto')
        ], loadOptions);

        // 获取所有需要的类型
        types = {
            // Request 相关
            Request: root.lookupType('warp.multi_agent.v1.Request'),

            // Response 相关
            ResponseEvent: root.lookupType('warp.multi_agent.v1.ResponseEvent'),
            ClientAction: root.lookupType('warp.multi_agent.v1.ClientAction'),

            // Task 相关
            Task: root.lookupType('warp.multi_agent.v1.Task'),
            TaskStatus: root.lookupType('warp.multi_agent.v1.TaskStatus'),
            Message: root.lookupType('warp.multi_agent.v1.Message'),

            // 其他
            InputContext: root.lookupType('warp.multi_agent.v1.InputContext'),
            Attachment: root.lookupType('warp.multi_agent.v1.Attachment'),
            FileContent: root.lookupType('warp.multi_agent.v1.FileContent')
        };

        logger.info('[WarpProto] Proto types initialized successfully');
        return types;
    } catch (error) {
        logger.error('[WarpProto] Failed to load proto files:', error);
        throw error;
    }
}

/**
 * 获取 proto 类型（确保已初始化）
 */
export function getTypes() {
    if (!types) {
        throw new Error('Proto types not initialized. Call initProto() first.');
    }
    return types;
}

/**
 * 编码 Request 消息
 */
export function encodeRequest(requestData) {
    const types = getTypes();
    const errMsg = types.Request.verify(requestData);
    if (errMsg) {
        logger.warn('[WarpProto] Request validation warning:', errMsg);
        // 继续编码，不中断
    }
    const message = types.Request.create(requestData);
    return types.Request.encode(message).finish();
}

/**
 * 解码 ResponseEvent 消息
 */
export function decodeResponseEvent(buffer) {
    const types = getTypes();
    return types.ResponseEvent.decode(buffer);
}

/**
 * 解码 Message 消息（用于解析嵌套的消息）
 */
export function decodeMessage(buffer) {
    const types = getTypes();
    return types.Message.decode(buffer);
}

/**
 * 构建新会话的首次请求
 * @param {string} query - 用户查询
 * @param {Object} context - 上下文 {pwd, home}
 * @param {string} modelName - 模型名称
 * @param {Array} supportedTools - 支持的工具类型枚举
 */
export function buildNewSessionRequest(query, context = {}, modelName = 'auto', supportedTools = []) {
    const pwd = context.pwd || process.cwd();
    const home = context.home || process.env.HOME || '~';

    const requestData = {
        taskContext: {
            tasks: []  // 新会话，空任务列表
        },
        input: {
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
            },
            userInputs: {
                inputs: [{
                    userQuery: {
                        query: query,
                        referencedAttachments: {}
                    }
                }]
            }
        },
        settings: {
            modelConfig: {
                base: modelName,
                planning: '',
                coding: '',
                cliAgentModel: 'claude-4-sonnet'
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
            supportsLinkedCodeBlocks: false,
            supportsFileGlobV2: true,
            supportsSearchCodebaseV2: true,
            supportsReadFilesV2: true,
            supportsApplyFileDiffsV2: true,
            supportsSuggestNewConversation: true,
            supportedAutoRunTools: [],  // 不自动执行任何工具
            supportsAutoRun: false      // 禁用自动执行，让 Claude Code 执行工具
        },
        metadata: {
            conversationId: '',  // 新会话，空 conversationId
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

/**
 * 构建多轮对话的后续请求（用户消息）
 * @param {string} query - 用户查询
 * @param {Object} session - 会话状态 {conversationId, taskId, taskDescription, messages}
 * @param {Object} context - 上下文 {pwd, home}
 * @param {string} modelName - 模型名称
 * @param {Array} supportedTools - 支持的工具类型枚举
 */
export function buildContinueRequest(query, session, context = {}, modelName = 'auto', supportedTools = []) {
    if (!session || !session.conversationId || !session.taskId) {
        throw new Error('Invalid session: missing conversationId or taskId');
    }

    const pwd = context.pwd || process.cwd();
    const home = context.home || process.env.HOME || '~';

    const requestData = {
        taskContext: {
            tasks: [{
                id: session.taskId,
                description: session.taskDescription || 'Conversation',
                dependencies: {},
                status: {
                    inProgress: {}
                },
                messages: session.messages || [],
                summary: ''
            }],
            activeTaskId: session.taskId
        },
        input: {
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
            },
            userInputs: {
                inputs: [{
                    userQuery: {
                        query: query,
                        referencedAttachments: {}
                    }
                }]
            }
        },
        settings: {
            modelConfig: {
                base: modelName,
                planning: '',
                coding: '',
                cliAgentModel: 'claude-4-sonnet'
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
            supportsLinkedCodeBlocks: false,
            supportsFileGlobV2: true,
            supportsSearchCodebaseV2: true,
            supportsReadFilesV2: true,
            supportsApplyFileDiffsV2: true,
            supportsSuggestNewConversation: true,
            supportedAutoRunTools: [],  // 不自动执行任何工具
            supportsAutoRun: false      // 禁用自动执行，让 Claude Code 执行工具
        },
        metadata: {
            conversationId: session.conversationId,
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

/**
 * 构建工具结果请求
 * @param {Array} toolResults - 工具结果列表 [{toolCallId, result}]
 * @param {Object} session - 会话状态
 * @param {Object} context - 上下文
 * @param {string} modelName - 模型名称
 * @param {Array} supportedTools - 支持的工具类型枚举
 */
export function buildToolResultRequest(toolResults, session, context = {}, modelName = 'auto', supportedTools = []) {
    if (!session || !session.conversationId || !session.taskId) {
        throw new Error('Invalid session: missing conversationId or taskId');
    }

    const pwd = context.pwd || process.cwd();
    const home = context.home || process.env.HOME || '~';

    // 构建 userInputs
    const inputs = toolResults.map(tr => ({
        toolCallResult: tr
    }));

    const requestData = {
        taskContext: {
            tasks: [{
                id: session.taskId,
                description: session.taskDescription || 'Conversation',
                dependencies: {},
                status: {
                    inProgress: {}
                },
                messages: session.messages || [],
                summary: ''
            }],
            activeTaskId: session.taskId
        },
        input: {
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
            },
            userInputs: {
                inputs: inputs
            }
        },
        settings: {
            modelConfig: {
                base: modelName,
                planning: '',
                coding: '',
                cliAgentModel: 'claude-4-sonnet'
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
            supportsLinkedCodeBlocks: false,
            supportsFileGlobV2: true,
            supportsSearchCodebaseV2: true,
            supportsReadFilesV2: true,
            supportsApplyFileDiffsV2: true,
            supportsSuggestNewConversation: true,
            supportedAutoRunTools: [],  // 不自动执行任何工具
            supportsAutoRun: false      // 禁用自动执行，让 Claude Code 执行工具
        },
        metadata: {
            conversationId: session.conversationId,
            logging: {}
        }
    };

    return encodeRequest(requestData);
}

// 旧版兼容函数
export function buildSimpleRequest(query, conversationId = null) {
    return buildNewSessionRequest(query, {}, 'auto', []);
}

export function buildMultiTurnRequest(query, session) {
    return buildContinueRequest(query, session, {}, 'auto', []);
}

export { root };
