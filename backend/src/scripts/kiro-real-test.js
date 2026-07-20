#!/usr/bin/env node
/**
 * Kiro 真实场景速度测试
 *
 * 模拟 Claude Code 的真实请求：
 * - 复杂的 system prompt
 * - 大量 tools 定义
 * - 多轮对话历史（包含 tool_use/tool_result）
 *
 * 对比：
 * 1. 直连 AWS Kiro API
 * 2. 通过反代 API
 */

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
    // 反代 API 配置
    proxyUrl: process.env.PROXY_URL || 'https://accounthub.example.com/claude-kiro-oauth',
    proxyToken: process.env.PROXY_TOKEN || '',

    // 直连 Kiro 配置
    kiroRegion: 'us-east-1',
    kiroBaseUrl: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
    kiroRefreshUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken',

    // 测试配置
    model: 'claude-sonnet-4-5-20250929',
    targetTokens: 100000,  // 目标上下文大小
    rounds: 3,

    // 凭证（从环境变量或文件加载）
    credsPath: process.env.KIRO_CREDS_PATH || null,
};

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function generateUuid() {
    return crypto.randomUUID();
}

// ============================================================================
// 生成真实的 Claude Code 风格请求
// ============================================================================

/**
 * 生成 Claude Code 风格的 system prompt
 */
function generateSystemPrompt() {
    return `You are Claude, made by Anthropic. You are an AI assistant helping with software development tasks.

<environment_info>
Working directory: /Users/test/project
Platform: darwin
Today's date: ${new Date().toISOString().split('T')[0]}
</environment_info>

<tool_usage_guidelines>
- Use the Read tool to read files before editing
- Use the Bash tool for shell commands
- Use the Edit tool for file modifications
- Always verify changes after making them
</tool_usage_guidelines>

<code_style>
- Follow existing code conventions
- Add comments for complex logic
- Use meaningful variable names
- Keep functions small and focused
</code_style>`;
}

/**
 * 生成 Claude Code 风格的 tools 定义
 */
function generateTools() {
    return [
        {
            name: "Read",
            description: "Reads a file from the local filesystem. You can access any file directly by using this tool. The file_path parameter must be an absolute path. By default, it reads up to 2000 lines starting from the beginning of the file. You can optionally specify a line offset and limit.",
            input_schema: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "The absolute path to the file to read" },
                    offset: { type: "number", description: "The line number to start reading from" },
                    limit: { type: "number", description: "The number of lines to read" }
                },
                required: ["file_path"]
            }
        },
        {
            name: "Write",
            description: "Writes content to a file. This will overwrite existing content. Use with caution.",
            input_schema: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "The absolute path to the file" },
                    content: { type: "string", description: "The content to write" }
                },
                required: ["file_path", "content"]
            }
        },
        {
            name: "Edit",
            description: "Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file.",
            input_schema: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "The absolute path to the file" },
                    old_string: { type: "string", description: "The text to replace" },
                    new_string: { type: "string", description: "The replacement text" },
                    replace_all: { type: "boolean", description: "Replace all occurrences" }
                },
                required: ["file_path", "old_string", "new_string"]
            }
        },
        {
            name: "Bash",
            description: "Executes a bash command in a persistent shell session. Use for git, npm, docker, etc.",
            input_schema: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command to execute" },
                    timeout: { type: "number", description: "Timeout in milliseconds" },
                    description: { type: "string", description: "Description of what this command does" }
                },
                required: ["command"]
            }
        },
        {
            name: "Glob",
            description: "Fast file pattern matching tool. Supports glob patterns like **/*.js",
            input_schema: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "The glob pattern" },
                    path: { type: "string", description: "The directory to search in" }
                },
                required: ["pattern"]
            }
        },
        {
            name: "Grep",
            description: "A powerful search tool built on ripgrep. Supports full regex syntax.",
            input_schema: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "The regex pattern to search" },
                    path: { type: "string", description: "File or directory to search" },
                    glob: { type: "string", description: "Glob pattern to filter files" }
                },
                required: ["pattern"]
            }
        },
        {
            name: "Task",
            description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
            input_schema: {
                type: "object",
                properties: {
                    description: { type: "string", description: "Short description of the task" },
                    prompt: { type: "string", description: "The task for the agent" },
                    subagent_type: { type: "string", description: "Type of agent to use" }
                },
                required: ["description", "prompt", "subagent_type"]
            }
        },
        {
            name: "WebFetch",
            description: "Fetches content from a URL and processes it using an AI model.",
            input_schema: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The URL to fetch" },
                    prompt: { type: "string", description: "The prompt to run on the content" }
                },
                required: ["url", "prompt"]
            }
        }
    ];
}

/**
 * 生成模拟的代码文件内容（用于 tool_result）
 */
function generateFakeFileContent(lines = 200) {
    const codeLines = [];
    codeLines.push('import React, { useState, useEffect, useCallback } from "react";');
    codeLines.push('import axios from "axios";');
    codeLines.push('import { useRouter } from "next/router";');
    codeLines.push('');

    for (let i = 0; i < lines - 10; i++) {
        const indent = '    ';
        if (i % 20 === 0) {
            codeLines.push(`\nfunction Component${Math.floor(i/20)}() {`);
        } else if (i % 20 === 19) {
            codeLines.push(`${indent}return <div>Component ${Math.floor(i/20)}</div>;`);
            codeLines.push('}');
        } else {
            codeLines.push(`${indent}const value${i} = processData(${i}, "${generateUuid().substring(0,8)}");`);
        }
    }

    codeLines.push('');
    codeLines.push('export default Component0;');
    return codeLines.join('\n');
}

/**
 * 生成多轮对话历史
 */
function generateConversationHistory(targetTokens) {
    const messages = [];
    let estimatedTokens = 0;
    const charsPerToken = 4;

    // 第一轮：用户请求
    messages.push({
        role: 'user',
        content: 'Help me understand this codebase. Start by reading the main entry file.'
    });
    estimatedTokens += 20;

    // 模拟多轮工具调用
    let turnCount = 0;
    while (estimatedTokens < targetTokens && turnCount < 50) {
        turnCount++;

        // Assistant 使用工具
        const toolUseId = `toolu_${generateUuid().replace(/-/g, '').substring(0, 24)}`;
        const toolName = ['Read', 'Grep', 'Glob', 'Bash'][turnCount % 4];

        let toolInput;
        if (toolName === 'Read') {
            toolInput = { file_path: `/Users/test/project/src/file${turnCount}.tsx` };
        } else if (toolName === 'Grep') {
            toolInput = { pattern: `function.*Component${turnCount}`, path: '/Users/test/project/src' };
        } else if (toolName === 'Glob') {
            toolInput = { pattern: `**/*.tsx`, path: '/Users/test/project' };
        } else {
            toolInput = { command: `git log --oneline -${turnCount}`, description: 'Show git history' };
        }

        messages.push({
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: `Let me ${toolName === 'Read' ? 'read' : 'search'} the ${toolName === 'Read' ? 'file' : 'codebase'}...`
                },
                {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: toolInput
                }
            ]
        });
        estimatedTokens += 50;

        // User 返回工具结果
        let resultContent;
        if (toolName === 'Read') {
            resultContent = generateFakeFileContent(100 + turnCount * 10);
        } else if (toolName === 'Grep') {
            resultContent = Array(20).fill(0).map((_, i) =>
                `/Users/test/project/src/file${i}.tsx:${i*10}: function Component${i}() {`
            ).join('\n');
        } else if (toolName === 'Glob') {
            resultContent = Array(30).fill(0).map((_, i) =>
                `/Users/test/project/src/components/Component${i}.tsx`
            ).join('\n');
        } else {
            resultContent = Array(10).fill(0).map((_, i) =>
                `abc${i}def feat: Add feature ${turnCount}-${i}`
            ).join('\n');
        }

        messages.push({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: resultContent
                }
            ]
        });
        estimatedTokens += resultContent.length / charsPerToken;

        // 偶尔加入 assistant 的分析
        if (turnCount % 3 === 0) {
            const analysis = `Based on my analysis of the codebase so far:

1. The project uses React with TypeScript
2. There are ${turnCount * 5} components identified
3. The main patterns include:
   - Functional components with hooks
   - Custom hooks for data fetching
   - Context for state management

Let me continue exploring to understand the data flow better.`;

            messages.push({
                role: 'assistant',
                content: analysis
            });
            estimatedTokens += analysis.length / charsPerToken;

            messages.push({
                role: 'user',
                content: 'Continue analyzing. Focus on the API integration.'
            });
            estimatedTokens += 15;
        }
    }

    // 最后一条用户消息
    messages.push({
        role: 'user',
        content: 'Now give me a brief summary of what you found.'
    });

    log(`生成了 ${messages.length} 条消息, 估算 ${Math.round(estimatedTokens)} tokens`);
    return messages;
}

// ============================================================================
// 反代 API 测试（Claude 格式）
// ============================================================================

async function testProxyApi(messages, tools, systemPrompt) {
    const metrics = {
        name: '反代 API',
        requestStart: Date.now(),
        ttft: null,
        totalTime: null,
        totalChars: 0,
        events: 0,
        error: null
    };

    const requestBody = {
        model: CONFIG.model,
        max_tokens: 1024,
        stream: true,
        system: systemPrompt,
        tools: tools,
        messages: messages,
        metadata: {
            user_id: `user_test_account__session_${generateUuid()}`
        }
    };

    const requestSize = JSON.stringify(requestBody).length;
    log(`反代请求体大小: ${(requestSize / 1024).toFixed(1)} KB`);

    try {
        const response = await axios.post(
            `${CONFIG.proxyUrl}/v1/messages`,
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CONFIG.proxyToken,
                    'anthropic-version': '2023-06-01'
                },
                responseType: 'stream',
                timeout: 300000
            }
        );

        let buffer = '';
        let firstToken = false;

        for await (const chunk of response.data) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);
                    metrics.events++;

                    if (!firstToken && (
                        event.type === 'content_block_delta' ||
                        event.type === 'content_block_start' ||
                        event.delta?.text
                    )) {
                        firstToken = true;
                        metrics.ttft = Date.now() - metrics.requestStart;
                    }

                    if (event.delta?.text) {
                        metrics.totalChars += event.delta.text.length;
                    }
                } catch (e) {}
            }
        }

        metrics.totalTime = Date.now() - metrics.requestStart;
    } catch (error) {
        metrics.totalTime = Date.now() - metrics.requestStart;
        metrics.error = error.response?.data || error.message;
    }

    return metrics;
}

// ============================================================================
// 直连 Kiro API 测试
// ============================================================================

const MODEL_MAPPING = {
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
};

// 内置凭证（用于测试）
const BUILTIN_CREDENTIALS = {
    accessToken: 'aoaAAAAAGl5tSUw99kqcl1sfjmxTazkCH6usDIB8ERPuRN0V9flGK5SMbKS-94GusAUbLeSEi2BeB5Fvg4xaP4INwBkc0:MGYCMQCF/96+4/s/NrFoEQKEmMY0EayQeNSyQlJDjL3v9wH6QMOtvW3po2I+oLbsrQ2vc5ICMQCPK6iVdU0hikce3qryEGI5xcV2kIlEkhios55m2WA+ebEyqlrRK5dWWEXO3MxmTFw',
    refreshToken: 'aorAAAAAGndUm4S-6BbDGPxhRnxhlWW4qbt7030OAfQyZeIS9Ng0kwz2OaEFDKx1acbDSDXljgYJ7AddHPFbThnEIBkc0:MGUCMH0a3cI763GsYaF99NKKClErxo1DZEhzZeBmy+CcSElWJdLHMpbhzuQmZU2m2xoHFQIxAIhkBVuyDH4owxNniAKX63fYoTBSY42iiQeijBdh3A5siDMM0Hmd3MQ+JTaid7Q7IA',
    profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
    region: 'us-east-1'
};

let kiroCredentials = null;

async function loadKiroCredentials() {
    if (kiroCredentials) return kiroCredentials;

    // 从文件加载
    if (CONFIG.credsPath && fs.existsSync(CONFIG.credsPath)) {
        const content = fs.readFileSync(CONFIG.credsPath, 'utf8');
        kiroCredentials = JSON.parse(content);
        log(`从文件加载 Kiro 凭证: ${CONFIG.credsPath}`);
        return kiroCredentials;
    }

    // 从环境变量加载
    const base64 = process.env.KIRO_OAUTH_CREDS_BASE64;
    if (base64) {
        kiroCredentials = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
        log('从环境变量加载 Kiro 凭证');
        return kiroCredentials;
    }

    // 使用内置凭证
    log('使用内置凭证');
    kiroCredentials = { ...BUILTIN_CREDENTIALS };
    return kiroCredentials;
}

async function refreshKiroToken() {
    const creds = await loadKiroCredentials();
    log('刷新 Kiro token...');

    const response = await axios.post(CONFIG.kiroRefreshUrl, {
        refreshToken: creds.refreshToken
    }, { timeout: 20000 });

    if (response.data?.accessToken) {
        creds.accessToken = response.data.accessToken;
        creds.refreshToken = response.data.refreshToken || creds.refreshToken;
        log('Token 刷新成功');
    }
    return creds;
}

/**
 * 简化版：直接构建 Kiro 请求（不转换复杂历史）
 * 用于对比测试，和 kiro-speed-test.js 保持一致
 */
function buildSimpleKiroRequest(contextContent, model) {
    const kiroModel = MODEL_MAPPING[model] || 'claude-sonnet-4.5';
    return {
        conversationState: {
            agentContinuationId: generateUuid(),
            agentTaskType: 'vibe',
            chatTriggerType: 'MANUAL',
            conversationId: generateUuid(),
            currentMessage: {
                userInputMessage: {
                    content: `You are a helpful assistant.\n\n${contextContent}\n\nPlease summarize briefly.`,
                    modelId: kiroModel,
                    origin: 'AI_EDITOR'
                }
            }
        },
        profileArn: kiroCredentials?.profileArn
    };
}

/**
 * 将 Claude 格式消息转换为 Kiro 格式（完整版）
 */
function convertToKiroFormat(messages, tools, systemPrompt, model) {
    const kiroModel = MODEL_MAPPING[model] || 'claude-sonnet-4.5';
    const conversationId = generateUuid();

    const history = [];
    let startIndex = 0;

    // 处理 system prompt + 第一条用户消息
    if (messages[0]?.role === 'user') {
        const firstContent = typeof messages[0].content === 'string'
            ? messages[0].content
            : messages[0].content.map(b => b.text || '').join('');

        history.push({
            userInputMessage: {
                content: `${systemPrompt}\n\n${firstContent}`,
                modelId: kiroModel,
                origin: 'AI_EDITOR'
            }
        });
        startIndex = 1;
    }

    // 处理历史消息
    for (let i = startIndex; i < messages.length - 1; i++) {
        const msg = messages[i];

        if (msg.role === 'user') {
            let content = '';
            let toolResults = [];

            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') content += part.text;
                    else if (part.type === 'tool_result') {
                        const resultText = typeof part.content === 'string'
                            ? part.content : JSON.stringify(part.content);
                        toolResults.push({
                            content: [{ text: resultText }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    }
                }
            } else {
                content = msg.content;
            }

            const userMsg = {
                userInputMessage: {
                    content: content || 'Tool results provided.',
                    modelId: kiroModel,
                    origin: 'AI_EDITOR'
                }
            };
            if (toolResults.length > 0) {
                userMsg.userInputMessage.userInputMessageContext = { toolResults };
            }
            history.push(userMsg);

        } else if (msg.role === 'assistant') {
            let content = '';
            let toolUses = [];

            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') content += part.text;
                    else if (part.type === 'tool_use') {
                        toolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    }
                }
            } else {
                content = msg.content;
            }

            const assistantMsg = { assistantResponseMessage: { content } };
            if (toolUses.length > 0) {
                assistantMsg.assistantResponseMessage.toolUses = toolUses;
            }
            history.push(assistantMsg);
        }
    }

    // 当前消息
    const lastMsg = messages[messages.length - 1];
    const currentContent = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : lastMsg.content.map(b => b.text || '').join('');

    // 转换 tools
    const kiroTools = tools.map(t => ({
        toolSpecification: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.input_schema || {} }
        }
    }));

    return {
        conversationState: {
            agentContinuationId: generateUuid(),
            agentTaskType: 'vibe',
            chatTriggerType: 'MANUAL',
            conversationId,
            history,
            currentMessage: {
                userInputMessage: {
                    content: currentContent,
                    modelId: kiroModel,
                    origin: 'AI_EDITOR',
                    userInputMessageContext: { tools: kiroTools }
                }
            }
        },
        profileArn: kiroCredentials?.profileArn
    };
}

/**
 * 解析 Kiro SSE 流
 */
function parseKiroEvents(buffer) {
    const events = [];
    let remaining = buffer;
    const regex = /\{"(?:content|contextUsagePercentage)"/g;

    let match;
    let lastEnd = 0;

    while ((match = regex.exec(remaining)) !== null) {
        const start = match.index;
        let braceCount = 0, end = -1, inStr = false, esc = false;

        for (let i = start; i < remaining.length; i++) {
            const c = remaining[i];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) {
                if (c === '{') braceCount++;
                else if (c === '}' && --braceCount === 0) { end = i; break; }
            }
        }

        if (end < 0) break;

        try {
            const parsed = JSON.parse(remaining.substring(start, end + 1));
            if (parsed.content && !parsed.followupPrompt) {
                events.push({ type: 'content', data: parsed.content });
            }
            lastEnd = end + 1;
            regex.lastIndex = end + 1;
        } catch (e) {
            regex.lastIndex = start + 1;
        }
    }

    return { events, remaining: lastEnd > 0 ? remaining.substring(lastEnd) : remaining };
}

async function testDirectKiro(messages, tools, systemPrompt) {
    const metrics = {
        name: '直连 Kiro',
        requestStart: Date.now(),
        ttft: null,
        totalTime: null,
        totalChars: 0,
        events: 0,
        error: null
    };

    try {
        const creds = await loadKiroCredentials();

        // 生成和反代相同大小的上下文内容
        const contextContent = messages.map(m => {
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) {
                return m.content.map(b => b.text || b.content || '').join('');
            }
            return '';
        }).join('\n');

        // 使用简化请求格式（和 kiro-speed-test.js 一致）
        const requestBody = buildSimpleKiroRequest(contextContent, CONFIG.model);

        const requestSize = JSON.stringify(requestBody).length;
        log(`直连请求体大小: ${(requestSize / 1024).toFixed(1)} KB`);

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${creds.accessToken}`,
            'amz-sdk-invocation-id': generateUuid(),
            'amz-sdk-request': 'attempt=1; max=1',
            'x-amzn-kiro-agent-mode': 'vibe'
        };

        const response = await axios.post(CONFIG.kiroBaseUrl, requestBody, {
            headers,
            responseType: 'stream',
            timeout: 300000
        });

        let buffer = '';
        let firstToken = false;

        for await (const chunk of response.data) {
            buffer += chunk.toString();
            const { events, remaining } = parseKiroEvents(buffer);
            buffer = remaining;

            for (const event of events) {
                if (event.type === 'content') {
                    metrics.events++;
                    metrics.totalChars += event.data.length;
                    if (!firstToken) {
                        firstToken = true;
                        metrics.ttft = Date.now() - metrics.requestStart;
                    }
                }
            }
        }

        metrics.totalTime = Date.now() - metrics.requestStart;
    } catch (error) {
        metrics.totalTime = Date.now() - metrics.requestStart;
        if (error.response?.status === 401) {
            log('Token 过期，刷新后重试...');
            await refreshKiroToken();
            return testDirectKiro(messages, tools, systemPrompt);
        }
        metrics.error = error.message;
    }

    return metrics;
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('  Kiro 真实场景速度测试');
    console.log('  对比：反代 API vs 直连 Kiro');
    console.log('='.repeat(60) + '\n');

    // 解析命令行参数
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--tokens') CONFIG.targetTokens = parseInt(args[++i]);
        if (args[i] === '--rounds') CONFIG.rounds = parseInt(args[++i]);
        if (args[i] === '--proxy') CONFIG.proxyUrl = args[++i];
        if (args[i] === '--creds') CONFIG.credsPath = args[++i];
        if (args[i] === '--proxy-only') CONFIG.skipDirect = true;
        if (args[i] === '--direct-only') CONFIG.skipProxy = true;
    }

    log(`配置:`);
    log(`  目标上下文: ${CONFIG.targetTokens} tokens`);
    log(`  测试轮数: ${CONFIG.rounds}`);
    log(`  反代 URL: ${CONFIG.proxyUrl}`);
    console.log('');

    // 生成测试数据
    log('生成测试数据...');
    const systemPrompt = generateSystemPrompt();
    const tools = generateTools();
    const messages = generateConversationHistory(CONFIG.targetTokens);

    log(`System prompt: ${systemPrompt.length} 字符`);
    log(`Tools: ${tools.length} 个`);
    log(`Messages: ${messages.length} 条`);
    console.log('');

    const results = { proxy: [], direct: [] };

    for (let round = 1; round <= CONFIG.rounds; round++) {
        console.log('-'.repeat(40));
        log(`第 ${round}/${CONFIG.rounds} 轮测试`);
        console.log('-'.repeat(40));

        // 测试反代
        if (!CONFIG.skipProxy) {
            log('测试反代 API...');
            const proxyResult = await testProxyApi(messages, tools, systemPrompt);
            results.proxy.push(proxyResult);
            if (proxyResult.error) {
                log(`反代错误: ${JSON.stringify(proxyResult.error).substring(0, 200)}`);
            } else {
                log(`反代: TTFT=${proxyResult.ttft}ms, 总耗时=${proxyResult.totalTime}ms`);
            }
        }

        // 测试直连
        if (!CONFIG.skipDirect) {
            log('测试直连 Kiro...');
            const directResult = await testDirectKiro(messages, tools, systemPrompt);
            results.direct.push(directResult);
            if (directResult.error) {
                log(`直连错误: ${directResult.error}`);
            } else {
                log(`直连: TTFT=${directResult.ttft}ms, 总耗时=${directResult.totalTime}ms`);
            }
        }

        if (round < CONFIG.rounds) {
            log('等待 3 秒...');
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    printSummary(results);
}

function printSummary(results) {
    console.log('\n' + '='.repeat(60));
    console.log('  测试结果汇总');
    console.log('='.repeat(60) + '\n');

    const calcAvg = (arr, key) => {
        const valid = arr.filter(r => r[key] && !r.error);
        if (valid.length === 0) return null;
        return Math.round(valid.reduce((s, r) => s + r[key], 0) / valid.length);
    };

    if (results.proxy.length > 0) {
        console.log('【反代 API】');
        results.proxy.forEach((r, i) => {
            if (r.error) console.log(`  第${i+1}轮: 错误`);
            else console.log(`  第${i+1}轮: TTFT=${r.ttft}ms, 总耗时=${r.totalTime}ms`);
        });
        const avgTtft = calcAvg(results.proxy, 'ttft');
        const avgTotal = calcAvg(results.proxy, 'totalTime');
        if (avgTtft) console.log(`  平均: TTFT=${avgTtft}ms, 总耗时=${avgTotal}ms`);
        console.log('');
    }

    if (results.direct.length > 0) {
        console.log('【直连 Kiro】');
        results.direct.forEach((r, i) => {
            if (r.error) console.log(`  第${i+1}轮: 错误 - ${r.error}`);
            else console.log(`  第${i+1}轮: TTFT=${r.ttft}ms, 总耗时=${r.totalTime}ms`);
        });
        const avgTtft = calcAvg(results.direct, 'ttft');
        const avgTotal = calcAvg(results.direct, 'totalTime');
        if (avgTtft) console.log(`  平均: TTFT=${avgTtft}ms, 总耗时=${avgTotal}ms`);
        console.log('');
    }

    // 对比
    const proxyAvg = calcAvg(results.proxy, 'ttft');
    const directAvg = calcAvg(results.direct, 'ttft');
    if (proxyAvg && directAvg) {
        const diff = proxyAvg - directAvg;
        const pct = ((diff / directAvg) * 100).toFixed(1);
        console.log('【对比】');
        console.log(`  反代比直连慢: ${diff}ms (${pct}%)`);
    }

    console.log('\n' + '='.repeat(60) + '\n');
}

main().catch(err => {
    console.error('错误:', err);
    process.exit(1);
});
