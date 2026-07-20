#!/usr/bin/env node
/**
 * Kiro Speed Test Script
 *
 * 用于测试大上下文（100K+ tokens）请求到 Kiro 的 SSE 响应速度
 * 可在服务器和本地运行，对比延迟差异
 *
 * 使用方法:
 *   node kiro-speed-test.js [options]
 *
 * 选项:
 *   --context-size <size>  上下文大小 (tokens), 默认 100000
 *   --model <model>        模型名称, 默认 claude-sonnet-4-5-20250929
 *   --creds <path>         凭证文件路径
 *   --region <region>      AWS 区域, 默认 us-east-1
 *   --thinking             启用 thinking 模式
 *   --no-stream            禁用流式传输（使用非流式 API）
 *   --verbose              详细输出
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// 用 Node 内置 crypto 生成 UUID
function generateUuid() {
    return crypto.randomUUID();
}

// ============================================================================
// 常量定义
// ============================================================================

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    DEFAULT_MODEL: 'claude-sonnet-4.5',
    AXIOS_TIMEOUT: 300000, // 5 minutes for large context
    TOTAL_CONTEXT_TOKENS: 172500,
};

// 内置凭证
const BUILTIN_CREDENTIALS = {
    accessToken: 'aoaAAAAAGl4iDEhMl6iWXzfzB3NtKSqz1-hJri7O-d0JB4mvBAnAVCaf4ox7YP0wuEjmIqIGKXMqhjilZvSPRcejgBkc0:MGYCMQC7jx8SqN49HYHP+jvalcOoV9MJuLBqFdFQCFr/m/J+/tTJ4SUcVSaLfBA4yGGdzsoCMQCDKZRbxXgSi5lpYURefi208+P1vdtVYOWpFZ+hnMKv7Yg9x9xWtR5S6chL1wmUlXE',
    refreshToken: 'aorAAAAAGnfGqYTL_fZDhJ9GdjGZ9r2rC0DeO2C97puoobY57gEwmOX90iVwRYhl4mNtRYXX-Pf3RqU72f_VCD5QsBkc0:MGUCMQCDcIWJLJvyrl2XQttU6EIRNy5mxwaEHUotwf7HF1q9cRTW0N+NolLiAdZ6fRqUEHQCMFsnK4SbhkKDIqebmKxqgKb7IcnrVnQPqoPBiVxAxqVUq804s9d/9hASYNZQ9QIo1A',
    profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
    region: 'us-east-1'
};

const MODEL_MAPPING = {
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-3-7-sonnet-20250219": "claude-sonnet-3.7"
};

// ============================================================================
// 工具函数
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        contextSize: 120000,
        model: 'claude-sonnet-4-5-20250929',
        credsPath: null,
        region: 'us-east-1',
        thinking: false,
        stream: true,
        verbose: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--context-size':
                options.contextSize = parseInt(args[++i], 10);
                break;
            case '--model':
                options.model = args[++i];
                break;
            case '--creds':
                options.credsPath = args[++i];
                break;
            case '--region':
                options.region = args[++i];
                break;
            case '--thinking':
                options.thinking = true;
                break;
            case '--no-stream':
                options.stream = false;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            case '--help':
                printHelp();
                process.exit(0);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
Kiro Speed Test - 测试大上下文 SSE 响应速度

使用方法:
  node kiro-speed-test.js [options]

选项:
  --context-size <size>  上下文大小 (tokens), 默认 100000
  --model <model>        模型名称, 默认 claude-sonnet-4-5-20250929
  --creds <path>         凭证文件路径 (JSON 格式)
  --region <region>      AWS 区域, 默认 us-east-1
  --thinking             启用 thinking 模式
  --no-stream            禁用流式传输
  --verbose              详细输出
  --help                 显示帮助

示例:
  # 测试 100K 上下文
  node kiro-speed-test.js --creds ./kiro-creds.json

  # 测试 150K 上下文，启用 thinking
  node kiro-speed-test.js --context-size 150000 --thinking --creds ./kiro-creds.json

  # 非流式测试
  node kiro-speed-test.js --no-stream --creds ./kiro-creds.json
`);
}

function log(message, verbose = false) {
    if (!verbose || options.verbose) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }
}

function generateLargeContext(targetTokens) {
    // 估算：1 token ≈ 4 字符
    const charsPerToken = 4;
    const targetChars = targetTokens * charsPerToken;

    // 生成有意义的填充文本
    const sampleTexts = [
        "This is a test message to fill the context window. ",
        "The quick brown fox jumps over the lazy dog. ",
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ",
        "Testing large context performance with Kiro API. ",
        "Measuring SSE streaming latency and throughput. ",
    ];

    let content = '';
    let textIndex = 0;

    while (content.length < targetChars) {
        content += sampleTexts[textIndex % sampleTexts.length];
        textIndex++;
    }

    return content.substring(0, targetChars);
}

// ============================================================================
// Kiro API 客户端
// ============================================================================

class KiroTestClient {
    constructor(options) {
        this.options = options;
        this.accessToken = null;
        this.refreshToken = null;
        this.profileArn = null;
        this.region = options.region;
        this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);
        this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
    }

    async loadCredentials() {
        // 优先使用内置凭证
        if (!this.options.credsPath) {
            log('使用内置凭证...');
            this.accessToken = BUILTIN_CREDENTIALS.accessToken;
            this.refreshToken = BUILTIN_CREDENTIALS.refreshToken;
            this.profileArn = BUILTIN_CREDENTIALS.profileArn;
            this.region = BUILTIN_CREDENTIALS.region;
            this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);
            this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
            log(`凭证加载成功, region=${this.region}`);
            return;
        }

        // 从文件加载凭证
        const credsContent = fs.readFileSync(this.options.credsPath, 'utf8');
        const creds = JSON.parse(credsContent);

        this.accessToken = creds.accessToken;
        this.refreshToken = creds.refreshToken;
        this.profileArn = creds.profileArn;

        if (creds.region) {
            this.region = creds.region;
            this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', this.region);
            this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region);
        }

        log(`凭证加载成功, region=${this.region}`);
    }

    async refreshAccessToken() {
        log('刷新 access token...');

        try {
            const response = await axios.post(this.refreshUrl, {
                refreshToken: this.refreshToken
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            });

            if (response.data?.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;
                log('Token 刷新成功');
            } else {
                throw new Error('刷新响应中缺少 accessToken');
            }
        } catch (error) {
            log(`Token 刷新失败: ${error.message}`);
            throw error;
        }
    }

    buildRequest(contextContent, model) {
        const conversationId = generateUuid();
        const kiroModel = MODEL_MAPPING[model] || KIRO_CONSTANTS.DEFAULT_MODEL;

        let systemPrompt = 'You are a helpful assistant. Please respond briefly.';

        if (this.options.thinking) {
            systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>20000</max_thinking_length>\n${systemPrompt}`;
        }

        const request = {
            conversationState: {
                agentContinuationId: generateUuid(),
                agentTaskType: 'vibe',
                chatTriggerType: 'MANUAL',
                conversationId: conversationId,
                currentMessage: {
                    userInputMessage: {
                        content: `${systemPrompt}\n\nHere is some context:\n\n${contextContent}\n\nPlease summarize the above context in one sentence.`,
                        modelId: kiroModel,
                        origin: 'AI_EDITOR'
                    }
                }
            },
            profileArn: this.profileArn
        };

        return request;
    }

    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        const jsonStartRegex = /\{"(?:content|name|followupPrompt|contextUsagePercentage)"/g;

        let match;
        let lastProcessedEnd = 0;

        while ((match = jsonStartRegex.exec(remaining)) !== null) {
            const jsonStart = match.index;
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;

            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (char === '\\') { escapeNext = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (!inString) {
                    if (char === '{') braceCount++;
                    else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) { jsonEnd = i; break; }
                    }
                }
            }

            if (jsonEnd < 0) {
                remaining = remaining.substring(jsonStart);
                return { events, remaining };
            }

            const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    events.push({ type: 'content', data: parsed.content });
                } else if (parsed.contextUsagePercentage !== undefined) {
                    events.push({ type: 'contextUsage', data: parsed.contextUsagePercentage });
                }
                lastProcessedEnd = jsonEnd + 1;
                jsonStartRegex.lastIndex = jsonEnd + 1;
            } catch (e) {
                jsonStartRegex.lastIndex = jsonStart + 1;
            }
        }

        if (lastProcessedEnd > 0) {
            remaining = remaining.substring(lastProcessedEnd);
        }
        return { events, remaining };
    }

    async testStream(request) {
        const metrics = {
            requestStart: Date.now(),
            ttft: null,           // Time To First Token
            totalTime: null,
            totalChars: 0,
            totalEvents: 0,
            contextUsage: null,
        };

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': generateUuid(),
            'amz-sdk-request': 'attempt=1; max=1',
            'x-amzn-kiro-agent-mode': 'vibe',
        };

        log(`发送流式请求到 ${this.baseUrl}...`);

        try {
            const response = await axios.post(this.baseUrl, request, {
                headers,
                responseType: 'stream',
                timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
            });

            const stream = response.data;
            let buffer = '';
            let firstTokenReceived = false;

            for await (const chunk of stream) {
                buffer += chunk.toString();
                const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
                buffer = remaining;

                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        if (!firstTokenReceived) {
                            firstTokenReceived = true;
                            metrics.ttft = Date.now() - metrics.requestStart;
                            log(`首字时间 (TTFT): ${metrics.ttft}ms`);
                        }
                        metrics.totalChars += event.data.length;
                        metrics.totalEvents++;

                        if (this.options.verbose) {
                            process.stdout.write(event.data);
                        }
                    } else if (event.type === 'contextUsage') {
                        metrics.contextUsage = event.data;
                    }
                }
            }

            metrics.totalTime = Date.now() - metrics.requestStart;
            return metrics;

        } catch (error) {
            metrics.totalTime = Date.now() - metrics.requestStart;
            metrics.error = error.message;

            // 打印详细错误信息
            if (error.response) {
                log(`HTTP 状态码: ${error.response.status}`);
                log(`响应头: ${JSON.stringify(error.response.headers, null, 2)}`);
                log(`响应体: ${JSON.stringify(error.response.data, null, 2)}`);
            }

            if (error.response?.status === 401) {
                log('Token 过期，尝试刷新...');
                await this.refreshAccessToken();
                return this.testStream(request);
            }
            throw error;
        }
    }

    async testNonStream(request) {
        const metrics = {
            requestStart: Date.now(),
            ttft: null,
            totalTime: null,
            totalChars: 0,
            contextUsage: null,
        };

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
            'amz-sdk-invocation-id': generateUuid(),
            'amz-sdk-request': 'attempt=1; max=1',
            'x-amzn-kiro-agent-mode': 'vibe',
        };

        log(`发送非流式请求到 ${this.baseUrl}...`);

        try {
            const response = await axios.post(this.baseUrl, request, {
                headers,
                timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
            });

            metrics.ttft = Date.now() - metrics.requestStart;
            metrics.totalTime = metrics.ttft;

            const rawStr = typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data);
            metrics.totalChars = rawStr.length;

            if (this.options.verbose) {
                console.log('\n响应内容:', rawStr.substring(0, 500), '...');
            }

            return metrics;

        } catch (error) {
            metrics.totalTime = Date.now() - metrics.requestStart;
            metrics.error = error.message;
            if (error.response?.status === 401) {
                log('Token 过期，尝试刷新...');
                await this.refreshAccessToken();
                return this.testNonStream(request);
            }
            throw error;
        }
    }
}

// ============================================================================
// 主函数
// ============================================================================

let options;

async function main() {
    options = parseArgs();

    console.log('\n========================================');
    console.log('       Kiro Speed Test');
    console.log('========================================\n');

    log(`配置:`);
    log(`  - 上下文大小: ${options.contextSize} tokens`);
    log(`  - 模型: ${options.model}`);
    log(`  - 区域: ${options.region}`);
    log(`  - 流式传输: ${options.stream ? '是' : '否'}`);
    log(`  - Thinking: ${options.thinking ? '是' : '否'}`);
    console.log('');

    // 创建客户端
    const client = new KiroTestClient(options);

    // 加载凭证
    try {
        await client.loadCredentials();
    } catch (error) {
        console.error(`\n错误: ${error.message}`);
        console.error('请确保凭证文件存在且格式正确');
        process.exit(1);
    }

    // 生成大上下文
    log(`生成 ${options.contextSize} tokens 的测试上下文...`);
    const contextContent = generateLargeContext(options.contextSize);
    log(`上下文生成完成, 字符数: ${contextContent.length}`);

    // 构建请求
    const request = client.buildRequest(contextContent, options.model);
    const requestSize = JSON.stringify(request).length;
    log(`请求体大小: ${(requestSize / 1024).toFixed(2)} KB`);

    console.log('\n----------------------------------------');
    log('开始测试 (共2轮)...');
    console.log('----------------------------------------\n');

    const allResults = [];

    for (let round = 1; round <= 2; round++) {
        log(`===== 第 ${round} 轮测试 =====`);

        // 每轮重新构建请求（新的 conversationId）
        const request = client.buildRequest(contextContent, options.model);

        try {
            let metrics;
            if (options.stream) {
                metrics = await client.testStream(request);
            } else {
                metrics = await client.testNonStream(request);
            }

            allResults.push(metrics);

            console.log(`  第 ${round} 轮: TTFT=${metrics.ttft}ms, 总耗时=${metrics.totalTime}ms`);

            // 两轮之间等待 2 秒
            if (round < 2) {
                log('等待 2 秒...');
                await new Promise(r => setTimeout(r, 2000));
            }

        } catch (error) {
            console.error(`第 ${round} 轮失败: ${error.message}`);
            allResults.push({ error: error.message });
        }
    }

    // 输出汇总结果
    console.log('\n========================================');
    console.log('       测试结果汇总');
    console.log('========================================\n');

    allResults.forEach((m, i) => {
        console.log(`  第 ${i + 1} 轮:`);
        if (m.error) {
            console.log(`    错误: ${m.error}`);
        } else {
            console.log(`    TTFT: ${m.ttft} ms`);
            console.log(`    总耗时: ${m.totalTime} ms`);
            console.log(`    上下文使用率: ${m.contextUsage?.toFixed(1) || 'N/A'}%`);
        }
        console.log('');
    });

    // 计算平均值
    const validResults = allResults.filter(m => !m.error && m.ttft);
    if (validResults.length > 0) {
        const avgTtft = validResults.reduce((s, m) => s + m.ttft, 0) / validResults.length;
        const avgTotal = validResults.reduce((s, m) => s + m.totalTime, 0) / validResults.length;
        console.log(`  平均 TTFT: ${avgTtft.toFixed(0)} ms`);
        console.log(`  平均总耗时: ${avgTotal.toFixed(0)} ms`);
    }

    console.log('\n========================================\n');
}

// 运行主函数
main().catch(error => {
    console.error('未捕获的错误:', error);
    process.exit(1);
});
