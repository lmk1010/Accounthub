#!/usr/bin/env node
/**
 * Kiro Speed Test - 通过代理 API 测试
 *
 * 对比直连 Kiro 和通过代理的延迟差异
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
    // 直接请求反代（不经过 NewAPI）
    baseUrl: process.env.PROXY_URL || 'https://accounthub.example.com/claude-kiro-oauth',
    authToken: process.env.PROXY_TOKEN || '',
    model: 'claude-sonnet-4-5-20250929',
    contextSize: 70000,  // 70K tokens
    rounds: 2
};

function generateUuid() {
    return crypto.randomUUID();
}

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================================================
// 生成测试上下文
// ============================================================================

function generateLargeContext(targetTokens) {
    const charsPerToken = 4;
    const targetChars = targetTokens * charsPerToken;

    const sampleTexts = [
        "This is a test message to fill the context window. ",
        "The quick brown fox jumps over the lazy dog. ",
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ",
        "Testing large context performance with Kiro API. ",
        "Measuring SSE streaming latency and throughput. ",
    ];

    let content = '';
    let i = 0;
    while (content.length < targetChars) {
        content += sampleTexts[i % sampleTexts.length];
        i++;
    }
    return content.substring(0, targetChars);
}

// ============================================================================
// 构建 Claude API 请求
// ============================================================================

function buildClaudeRequest(contextContent) {
    return {
        model: CONFIG.model,
        max_tokens: 1024,
        stream: true,
        messages: [
            {
                role: 'user',
                content: `Here is some context:\n\n${contextContent}\n\nPlease summarize the above context in one sentence.`
            }
        ]
    };
}

// ============================================================================
// SSE 流式请求
// ============================================================================

function streamRequest(requestBody) {
    return new Promise((resolve, reject) => {
        const metrics = {
            requestStart: Date.now(),
            ttft: null,
            totalTime: null,
            totalChars: 0,
            events: 0
        };

        const url = new URL(CONFIG.baseUrl + '/v1/messages');
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const postData = JSON.stringify(requestBody);

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CONFIG.authToken,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = client.request(options, (res) => {
            let buffer = '';
            let firstToken = false;

            res.on('data', (chunk) => {
                buffer += chunk.toString();

                // 解析 SSE 事件
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const event = JSON.parse(data);
                            metrics.events++;

                            // 检测首字 - 兼容多种事件类型
                            if (!firstToken) {
                                // content_block_delta 或 message_start 或任何有内容的事件
                                if (event.type === 'content_block_delta' ||
                                    event.type === 'content_block_start' ||
                                    event.type === 'message_start' ||
                                    event.delta?.text ||
                                    event.content_block) {
                                    firstToken = true;
                                    metrics.ttft = Date.now() - metrics.requestStart;
                                    log(`首字时间 (TTFT): ${metrics.ttft}ms`);
                                }
                            }

                            // 统计字符
                            if (event.delta?.text) {
                                metrics.totalChars += event.delta.text.length;
                            }
                        } catch (e) {}
                    }
                }
            });

            res.on('end', () => {
                metrics.totalTime = Date.now() - metrics.requestStart;
                resolve(metrics);
            });

            res.on('error', reject);
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
    console.log('\n========================================');
    console.log('  Kiro Speed Test - 代理 API');
    console.log('========================================\n');

    log(`配置:`);
    log(`  - API: ${CONFIG.baseUrl}`);
    log(`  - 模型: ${CONFIG.model}`);
    log(`  - 上下文: ${CONFIG.contextSize} tokens`);
    log(`  - 轮数: ${CONFIG.rounds}`);
    console.log('');

    // 生成上下文
    log(`生成 ${CONFIG.contextSize} tokens 上下文...`);
    const context = generateLargeContext(CONFIG.contextSize);
    log(`上下文字符数: ${context.length}`);

    const results = [];

    for (let i = 1; i <= CONFIG.rounds; i++) {
        log(`\n===== 第 ${i} 轮 =====`);

        const request = buildClaudeRequest(context);

        try {
            const metrics = await streamRequest(request);
            results.push(metrics);
            log(`完成: TTFT=${metrics.ttft}ms, 总耗时=${metrics.totalTime}ms, 字符数=${metrics.totalChars}`);
        } catch (err) {
            log(`失败: ${err.message}`);
            results.push({ error: err.message });
        }

        if (i < CONFIG.rounds) {
            log('等待 2 秒...');
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // 汇总
    console.log('\n========================================');
    console.log('       测试结果汇总');
    console.log('========================================\n');

    results.forEach((m, i) => {
        console.log(`  第 ${i + 1} 轮:`);
        if (m.error) {
            console.log(`    错误: ${m.error}`);
        } else {
            console.log(`    TTFT: ${m.ttft} ms`);
            console.log(`    总耗时: ${m.totalTime} ms`);
        }
    });

    const valid = results.filter(m => m.ttft);
    if (valid.length > 0) {
        const avgTtft = valid.reduce((s, m) => s + m.ttft, 0) / valid.length;
        const avgTotal = valid.reduce((s, m) => s + m.totalTime, 0) / valid.length;
        console.log(`\n  平均 TTFT: ${avgTtft.toFixed(0)} ms`);
        console.log(`  平均总耗时: ${avgTotal.toFixed(0)} ms`);
    }

    console.log('\n========================================\n');
}

main().catch(console.error);
