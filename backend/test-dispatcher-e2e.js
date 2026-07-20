#!/usr/bin/env node
/**
 * End-to-end 测试:模拟 newapi → master:1458 → sticky handoff → worker 的完整链路
 *
 * 验证:
 *   1) master 能正确解析 newapi 风格的 HTTP 请求头
 *   2) X-AccountHub-TokenId / X-AccountHub-UserEmail / X-AccountHub-UserId /
 *      X-AccountHub-Username / X-AccountHub-ClientIP / X-AccountHub-UserType
 *      全部在 worker 端以正确的 lowercase 形式可读
 *   3) URL 路径 `/openai-codex/v1/chat/completions` 在 worker 端无损
 *   4) 请求 body 在 worker 端可完整读出
 *   5) 同 tokenId 多次连接稳定路由到同一个 worker
 *   6) 不同 tokenId 有机会路由到不同 worker
 *   7) worker 的响应流直接写回客户端(master 不参与)
 *
 * 不依赖真实 provider,只做 HTTP + socket 层验证。
 */

import cluster from 'cluster';
import net from 'net';
import http from 'http';
import { parseHttpPrefix, extractClientIdentity, stickyWorkerIndex } from './src/core/sticky-dispatcher.js';

const NUM_WORKERS = 3;
const DISPATCHER_PORT = 0; // 0 = let OS assign

if (cluster.isPrimary) {
    console.log('[Master] starting e2e test with', NUM_WORKERS, 'workers');
    const workers = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
        const w = cluster.fork({ WORKER_SHARD_ID: String(i) });
        workers.push(w);
    }

    // 等待所有 worker ready
    let readyCount = 0;
    for (const w of workers) {
        w.on('message', (m) => {
            if (m && m.type === 'ready') {
                readyCount++;
                if (readyCount === NUM_WORKERS) startDispatcher();
            }
        });
    }

    function startDispatcher() {
        const dispatcher = net.createServer({ pauseOnConnect: true }, (socket) => {
            let buf = Buffer.alloc(0);
            let done = false;
            socket.on('data', (chunk) => {
                if (done) return;
                buf = Buffer.concat([buf, chunk]);
                const parsed = parseHttpPrefix(buf);
                if (!parsed || parsed.error) return;
                done = true;
                socket.removeAllListeners('data');

                const identity = extractClientIdentity(parsed.headers, socket.remoteAddress);
                let idx = stickyWorkerIndex(identity, workers.length);
                if (idx === null) idx = 0;
                const target = workers[idx];

                console.log(`[Master] connection → worker ${idx} (identity=${identity}, path=${parsed.path})`);

                const msg = {
                    type: 'sticky_handoff',
                    prefix: buf.toString('base64')
                };
                target.send(msg, socket, { keepOpen: false }, (err) => {
                    if (err) console.error('[Master] handoff error:', err.message);
                });
            });
            socket.resume();
        });

        dispatcher.listen(DISPATCHER_PORT, '127.0.0.1', () => {
            const port = dispatcher.address().port;
            console.log(`[Master] dispatcher on 127.0.0.1:${port}`);
            runTestClients(port).then((success) => {
                dispatcher.close();
                for (const w of workers) w.kill();
                process.exit(success ? 0 : 1);
            });
        });
    }

    async function runTestClients(port) {
        let ok = true;
        const workerHits = {};

        // Test A: 同 tokenId 10 次请求必须稳定到同一个 worker
        console.log('\n[Test A] sticky stability: 10 requests with same tokenId');
        const tokenA = 'test_user_alpha_12345';
        const workersSeenA = new Set();
        for (let i = 0; i < 10; i++) {
            const res = await httpRequest(port, {
                method: 'POST',
                path: '/openai-codex/v1/chat/completions',
                headers: {
                    'Host': 'accounthub-backend:1458',
                    'X-AccountHub-TokenId': tokenA,
                    'X-AccountHub-UserEmail': 'alpha@test.com',
                    'X-AccountHub-UserId': '999',
                    'X-AccountHub-Username': 'alpha',
                    'X-AccountHub-ClientIP': '10.0.0.5',
                    'X-AccountHub-UserType': 'user',
                    'Authorization': 'Bearer sk-test-abc',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
            });
            if (res.statusCode !== 200) { console.error('  ✗ got status', res.statusCode); ok = false; break; }
            const parsed = JSON.parse(res.body);
            workersSeenA.add(parsed.workerId);
            workerHits[parsed.workerId] = (workerHits[parsed.workerId] || 0) + 1;
            // 验证每次请求的 headers 都完整到达 worker
            if (parsed.echo.tokenId !== tokenA) { console.error('  ✗ tokenId lost:', parsed.echo); ok = false; break; }
            if (parsed.echo.userEmail !== 'alpha@test.com') { console.error('  ✗ email lost'); ok = false; break; }
            if (parsed.echo.userId !== '999') { console.error('  ✗ userId lost'); ok = false; break; }
            if (parsed.echo.username !== 'alpha') { console.error('  ✗ username lost'); ok = false; break; }
            if (parsed.echo.clientIp !== '10.0.0.5') { console.error('  ✗ clientIp lost'); ok = false; break; }
            if (parsed.echo.userType !== 'user') { console.error('  ✗ userType lost'); ok = false; break; }
            if (parsed.echo.path !== '/openai-codex/v1/chat/completions') { console.error('  ✗ path mismatch:', parsed.echo.path); ok = false; break; }
            if (parsed.echo.method !== 'POST') { console.error('  ✗ method mismatch'); ok = false; break; }
            if (parsed.echo.bodyParsed?.model !== 'gpt-5') { console.error('  ✗ body mismatch:', parsed.echo.bodyParsed); ok = false; break; }
        }
        if (ok) {
            if (workersSeenA.size === 1) {
                console.log(`  ✓ all 10 requests hit same worker (id=${[...workersSeenA][0]})`);
                console.log(`  ✓ all 6 X-AccountHub-* headers preserved`);
                console.log(`  ✓ path /openai-codex/v1/chat/completions preserved`);
                console.log(`  ✓ POST body {model,messages} preserved`);
            } else {
                console.error(`  ✗ sticky broken: saw ${workersSeenA.size} workers:`, [...workersSeenA]);
                ok = false;
            }
        }

        // Test B: 不同 tokenId 应该有机会落到不同 worker(至少覆盖 2 个)
        if (ok) {
            console.log('\n[Test B] distribution: 30 requests with different tokenIds');
            const workersSeenB = new Set();
            for (let i = 0; i < 30; i++) {
                const res = await httpRequest(port, {
                    method: 'GET',
                    path: '/openai-codex/health',
                    headers: {
                        'Host': 'accounthub-backend:1458',
                        'X-AccountHub-TokenId': `test_user_${i}`
                    }
                });
                if (res.statusCode !== 200) { console.error('  ✗ status'); ok = false; break; }
                const parsed = JSON.parse(res.body);
                workersSeenB.add(parsed.workerId);
            }
            if (ok) {
                console.log(`  ✓ 30 different tokens → ${workersSeenB.size} unique workers:`, [...workersSeenB].sort());
                if (workersSeenB.size < 2) {
                    console.error('  ✗ distribution too poor');
                    ok = false;
                }
            }
        }

        // Test C: 大 body(分多段到达)
        if (ok) {
            console.log('\n[Test C] large body handling');
            const bigBody = JSON.stringify({ model: 'gpt-5', messages: Array(100).fill({ role: 'user', content: 'x'.repeat(500) }) });
            const res = await httpRequest(port, {
                method: 'POST',
                path: '/openai-codex/v1/chat/completions',
                headers: {
                    'Host': 'accounthub-backend:1458',
                    'X-AccountHub-TokenId': 'large_body_test',
                    'Content-Type': 'application/json'
                },
                body: bigBody
            });
            if (res.statusCode !== 200) { console.error('  ✗ status', res.statusCode); ok = false; }
            else {
                const parsed = JSON.parse(res.body);
                if (parsed.echo.bodyLength !== bigBody.length) {
                    console.error(`  ✗ body length mismatch: sent ${bigBody.length}, received ${parsed.echo.bodyLength}`);
                    ok = false;
                } else {
                    console.log(`  ✓ ${bigBody.length} byte body preserved through handoff`);
                }
            }
        }

        console.log('\n=== Result:', ok ? 'ALL PASS' : 'FAIL');
        return ok;
    }
} else {
    // Worker 侧
    const workerId = parseInt(process.env.WORKER_SHARD_ID, 10);

    const server = http.createServer((req, res) => {
        // 收集 request body
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString('utf8'); });
        req.on('end', () => {
            // echo 所有关键信息回去,让测试验证
            const echo = {
                workerId,
                pid: process.pid,
                echo: {
                    method: req.method,
                    path: req.url,
                    tokenId: req.headers['x-accounthub-tokenid'] || null,
                    userEmail: req.headers['x-accounthub-useremail'] || null,
                    userId: req.headers['x-accounthub-userid'] || null,
                    username: req.headers['x-accounthub-username'] || null,
                    clientIp: req.headers['x-accounthub-clientip'] || null,
                    userType: req.headers['x-accounthub-usertype'] || null,
                    authorization: req.headers['authorization'] || null,
                    bodyLength: body.length,
                    bodyParsed: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null
                }
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(echo));
        });
    });

    // 接收 master 的 sticky handoff
    process.on('message', (message, handle) => {
        if (message && message.type === 'sticky_handoff' && handle) {
            try {
                if (message.prefix) {
                    const prefix = Buffer.from(message.prefix, 'base64');
                    if (prefix.length > 0) handle.unshift(prefix);
                }
                server.emit('connection', handle);
            } catch (e) {
                console.error(`[Worker ${workerId}] handoff inject error:`, e.message);
                try { handle.destroy(); } catch (_e) {}
            }
        }
    });

    // 告诉 master 已准备好
    process.send({ type: 'ready' });
}

// ===== helper =====
function httpRequest(port, { method, path, headers, body }) {
    return new Promise((resolve, reject) => {
        const opts = {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: { ...headers, Connection: 'close' },  // 强制每次新 TCP 连接,模拟 newapi 每请求一条
            agent: false
        };
        if (body) {
            opts.headers['Content-Length'] = Buffer.byteLength(body).toString();
        }
        const req = http.request(opts, (res) => {
            let resBody = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { resBody += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: resBody }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}
