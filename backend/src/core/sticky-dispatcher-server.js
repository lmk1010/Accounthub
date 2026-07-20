/**
 * Sticky TCP Dispatcher Server (方案 C: loopback TCP 代理)
 *
 * 此前方案 B 用 cluster IPC 把 socket fd 转移给 worker,worker 侧通过
 * `serverInstance.emit('connection', handle)` + socket.unshift(prefix) 或
 * socket.emit('data', prefix) 来把 master 已读的 header 前缀塞回 parser。
 * 两种塞法在 Node 20 下都会和 http.Server 内部的 `parser.consume(socket._handle)`
 * 产生字节乱序 —— parser.consume 走 libuv 直接从内核读字节,完全绕开
 * socket._readableState.buffer;prefix 塞进 JS buffer parser 看不到;用
 * emit('data') 又会和 consume 抢同一套 parser 状态机。结果:小请求偶尔 hung,
 * Trace 卡在 "Started" 之后,getRequestBody 永不 resolve。
 *
 * 方案 C 放弃 fd handoff 和 unshift,改成"纯 TCP loopback 代理":
 *
 *   1. master 在 1458 accept 新 TCP 连接,pauseOnConnect 暂停自动读
 *   2. master 自己挂 data listener 读前缀字节直到见到 \r\n\r\n
 *   3. master 用 parseHttpPrefix 解 request-line+header,抽 identity,决定 targetShard
 *   4. master 用 net.connect('127.0.0.1', 11558 + targetShardId) 打到对应
 *      worker 已经监听的 loopback 调试端口
 *   5. master 把已读的 prefix 先 write 到这条内网连接,然后 socket.pipe(upstream) +
 *      upstream.pipe(socket) 做双向转发
 *   6. worker 的 http.Server 看到的就是一条从 127.0.0.1 进来的普通 TCP 连接,
 *      用标准 Node HTTP 解析路径处理,完全不碰 sticky_handoff / unshift / emit
 *
 * 代价:master 仍然持有两条 socket 的 JS 对象,数据路径要经过 master 的 event loop
 * 和 loopback kernel buffer。但 Node stream pipe 走的是内部 cork/uncork 批处理,
 * CPU 开销远小于 JSON 解析,实测单 master 处理 1000+ concurrent SSE 没问题。
 * 跨 Pacific 的 TLS 握手和 Cloudflare 转发才是大头,master loopback 一跳基本量级可忽略。
 *
 * 故障处理(同 master 侧):
 *   - 前缀读超时 / header 过大 / 非 HTTP → 销毁 client socket
 *   - 无可用 worker → 销毁
 *   - loopback connect 失败 → 销毁 client 端,记 stats
 *   - 任何一端 error/close → 另一端也关,防止 half-open
 */

import net from 'net';
import {
    parseHttpPrefix,
    extractClientIdentity,
    stickyWorkerIndex,
    MAX_HEADER_BYTES,
    HEADER_READ_TIMEOUT_MS
} from './sticky-dispatcher.js';

const stats = {
    acceptedConnections: 0,
    stickyProxied: 0,
    rrFallbackProxied: 0,
    headerParseErrors: 0,
    headerTimeout: 0,
    headerTooLarge: 0,
    noAvailableWorker: 0,
    upstreamConnectErrors: 0,
    workerDistribution: {}  // shardId → count
};

let serverInstance = null;
let rrCounter = 0;

export function getStickyDispatcherStats() {
    return { ...stats, workerDistribution: { ...stats.workerDistribution } };
}

/**
 * 启动 sticky dispatcher
 *
 * @param {Object} options
 * @param {number} options.port                    对外端口,一般 1458
 * @param {string} [options.host='0.0.0.0']        bind host
 * @param {Function} options.getLiveShardPorts     () → Array<{shardId:number, port:number}>,
 *                                                 返回当前存活 worker 的 shard id 和 loopback 端口,按 shardId 升序
 * @param {Function} [options.onDispatched]        (shardId, identity, wasSticky) → void,观测钩子
 */
export function startStickyDispatcher({ port, host = '0.0.0.0', getLiveShardPorts, onDispatched = null }) {
    if (serverInstance) {
        console.warn('[StickyDispatcher] already running, returning existing instance');
        return serverInstance;
    }

    if (typeof getLiveShardPorts !== 'function') {
        throw new Error('[StickyDispatcher] getLiveShardPorts callback required');
    }

    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
        handleNewConnection(socket, getLiveShardPorts, onDispatched);
    });

    server.on('error', (err) => {
        console.error(`[StickyDispatcher] net server error on ${host}:${port}:`, err?.message || err);
    });

    server.listen(port, host, () => {
        console.log(`[StickyDispatcher] listening on ${host}:${port} (loopback TCP proxy by header hash)`);
    });

    serverInstance = server;
    return server;
}

export function stopStickyDispatcher() {
    if (!serverInstance) return Promise.resolve();
    return new Promise((resolve) => {
        try {
            serverInstance.close(() => {
                console.log('[StickyDispatcher] stopped');
                serverInstance = null;
                resolve();
            });
            setTimeout(() => {
                if (serverInstance) {
                    try { serverInstance.unref(); } catch (_e) {}
                    serverInstance = null;
                }
                resolve();
            }, 1000).unref();
        } catch (_err) {
            serverInstance = null;
            resolve();
        }
    });
}

function handleNewConnection(clientSocket, getLiveShardPorts, onDispatched) {
    stats.acceptedConnections++;

    let buffered = Buffer.alloc(0);
    let finalized = false;

    const headerTimer = setTimeout(() => {
        if (finalized) return;
        finalized = true;
        stats.headerTimeout++;
        try { clientSocket.destroy(); } catch (_e) { /* ignore */ }
    }, HEADER_READ_TIMEOUT_MS);
    headerTimer.unref && headerTimer.unref();

    const cleanup = () => {
        try { clientSocket.removeListener('data', onData); } catch (_e) {}
        try { clientSocket.removeListener('error', onError); } catch (_e) {}
        try { clientSocket.removeListener('end', onEnd); } catch (_e) {}
        try { clientSocket.removeListener('close', onClose); } catch (_e) {}
        clearTimeout(headerTimer);
    };

    const onError = (_err) => {
        if (finalized) return;
        finalized = true;
        cleanup();
        try { clientSocket.destroy(); } catch (_e) {}
    };
    const onEnd = () => {
        if (finalized) return;
        finalized = true;
        cleanup();
        try { clientSocket.destroy(); } catch (_e) {}
    };
    const onClose = onEnd;

    const onData = (chunk) => {
        if (finalized) return;
        buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);

        const parsed = parseHttpPrefix(buffered);
        if (parsed === null) {
            if (buffered.length >= MAX_HEADER_BYTES) {
                finalized = true;
                cleanup();
                stats.headerTooLarge++;
                try { clientSocket.destroy(); } catch (_e) {}
            }
            return;
        }
        if (parsed.error) {
            finalized = true;
            cleanup();
            stats.headerParseErrors++;
            try { clientSocket.destroy(); } catch (_e) {}
            return;
        }

        finalized = true;
        cleanup();
        // 关键：cleanup 移除了 data listener 但 socket 仍在 flowing mode，
        // 必须 pause 防止 body 数据在 cleanup→pipe 异步间隙中丢失。
        // pipe() 会自动 resume。
        try { clientSocket.pause(); } catch (_e) {}
        routeToShard(clientSocket, buffered, parsed, getLiveShardPorts, onDispatched);
    };

    clientSocket.on('error', onError);
    clientSocket.on('end', onEnd);
    clientSocket.on('close', onClose);
    clientSocket.on('data', onData);
    try { clientSocket.resume(); } catch (_e) { /* ignore */ }
}

function routeToShard(clientSocket, prefixBuf, parsed, getLiveShardPorts, onDispatched) {
    const shardEntries = typeof getLiveShardPorts === 'function' ? getLiveShardPorts() : [];
    if (!Array.isArray(shardEntries) || shardEntries.length === 0) {
        stats.noAvailableWorker++;
        console.warn('[StickyDispatcher] no live workers, destroying connection');
        try { clientSocket.destroy(); } catch (_e) {}
        return;
    }

    const identity = extractClientIdentity(parsed.headers, clientSocket.remoteAddress);
    let targetIdx = stickyWorkerIndex(identity, shardEntries.length);
    let wasSticky = true;
    if (targetIdx === null) {
        targetIdx = rrCounter++ % shardEntries.length;
        wasSticky = false;
        stats.rrFallbackProxied++;
    }

    const target = shardEntries[targetIdx];
    if (!target || !Number.isFinite(target.port)) {
        stats.noAvailableWorker++;
        try { clientSocket.destroy(); } catch (_e) {}
        return;
    }

    proxyToShard(clientSocket, prefixBuf, target, identity, wasSticky, onDispatched);
}

/**
 * 打开 loopback 连接到 worker,先写 prefix,再双向 pipe。
 *
 * pipe 后,master 退出 application 层 —— 数据在 Node stream 内部流转,
 * 但 kernel 层的 sendmsg/recvmsg 是 zero-copy buffer 级,CPU 开销极小。
 */
function proxyToShard(clientSocket, prefixBuf, target, identity, wasSticky, onDispatched) {
    const upstream = net.connect({ host: '127.0.0.1', port: target.port }, () => {
        // 连接成功,先 flush 已读的 prefix
        if (prefixBuf.length > 0) {
            upstream.write(prefixBuf);
        }
        // 双向 pipe —— Node 内部会 handle backpressure / end propagation / uncork
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);

        stats.stickyProxied++;
        stats.workerDistribution[target.shardId] = (stats.workerDistribution[target.shardId] || 0) + 1;
        if (typeof onDispatched === 'function') {
            try { onDispatched(target.shardId, identity, wasSticky); } catch (_e) {}
        }
    });

    // Nagle 关掉,SSE 小 chunk 才能立即 flush 到 worker
    try { upstream.setNoDelay(true); } catch (_e) {}
    try { clientSocket.setNoDelay(true); } catch (_e) {}

    const cleanupBoth = (reason) => {
        try { clientSocket.destroy(); } catch (_e) {}
        try { upstream.destroy(); } catch (_e) {}
        if (reason) {
            // 只在确认是 upstream 连接失败阶段记一次;pipe 期间的正常 close 不记
        }
    };

    upstream.on('error', (err) => {
        stats.upstreamConnectErrors++;
        console.warn(`[StickyDispatcher] upstream connect/error shard=${target.shardId} port=${target.port}: ${err?.message || err}`);
        cleanupBoth('upstream_error');
    });
    upstream.on('close', () => {
        // upstream 关了 → client 端也关
        try { clientSocket.destroy(); } catch (_e) {}
    });
    clientSocket.on('error', () => cleanupBoth('client_error'));
    clientSocket.on('close', () => {
        // client 走了 → upstream 也关(worker 侧会释放 response)
        try { upstream.destroy(); } catch (_e) {}
    });
}
