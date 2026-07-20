/**
 * Sticky TCP Dispatcher
 *
 * Phase 2+3 方案 B。master 进程监听对外 HTTP 端口(1458),对每条新的 TCP 连接:
 *   1) pauseOnConnect → 不让 socket 进入 flowing 模式
 *   2) 读 socket 数据直到见到 HTTP 头结束符 (\r\n\r\n)
 *   3) 解析 request-line + header,抽出客户端身份标识(优先 x-accounthub-tokenid 链)
 *   4) hash(identity) % workerCount → 目标 worker
 *   5) 通过 cluster IPC `worker.send({type:'sticky_handoff',prefix}, socket)` 把 socket handle
 *      和已经读出的前缀字节一起传给 worker
 *   6) worker 那边 `socket.unshift(prefix)` 把前缀 push 回流,再 `httpServer.emit('connection', socket)`
 *      让本进程的 HTTP parser 从头开始处理,完全透明
 *
 * 这样得到的效果和 nginx `upstream { hash $http_authorization consistent; }` 等价:
 *   - 同一 token 的客户端请求永远打到同一个 worker
 *   - worker 本地 sticky session 缓存必然命中,adapter cache 始终热
 *   - SSE 响应流从 worker 直接写回 client,master 完全不在数据路径上
 *   - master 只在每条 TCP 连接的"连接建立瞬间"介入几百字节的 header,一次性工作
 *
 * 故障处理:
 *   - header 超过 64 KB 未结束 → 判定非法 HTTP,销毁连接
 *   - 5 秒读不完 header → 超时,销毁连接
 *   - 没有任何可用 worker → 销毁连接(等同于 502,让客户端自行重试)
 *   - IPC handoff 失败 → 销毁连接
 *   - 识别不出身份(OPTIONS preflight 等)→ fallback 到轮询 RR
 *
 * 该模块只导出纯函数(解析 + 哈希),不持有状态。真正的 net 服务器在 sticky-dispatcher-server.js。
 */

import { fnv1a32 } from '../utils/shard.js';

/**
 * HTTP header 解析的最大前缀字节数。超过此值认为不是合法 HTTP。
 * 64 KB 远大于任何正常请求的 header 段(通常 < 4 KB)。
 */
export const MAX_HEADER_BYTES = 64 * 1024;

/**
 * header 读完超时。超过此值 client 还没发完 header,认为客户端异常,销毁。
 */
export const HEADER_READ_TIMEOUT_MS = 5000;

/**
 * 客户端身份识别头优先级列表。全部小写,匹配 Node HTTP header 的标准化形态。
 *
 * 这里的顺序决定哈希的稳定性 —— 把最可信、最不易变的 token 排在前面。
 * x-accounthub-tokenid 是 AccountHub 的首选 user token 头,由各客户端显式传入;
 * 其次是 Authorization(bearer token);再次是各渠道的 api-key 头;
 * 最后 fallback 到 user-id 之类的业务身份。
 *
 * 注意:OPTIONS 预检请求通常不带任何 auth 头,会 fallback 到 RR,不影响粘性 ——
 * 因为 OPTIONS 之后真正的请求才带 token,而真正的请求会新开一条连接(或复用同连接)。
 */
const IDENTITY_HEADER_PRIORITY = [
    'x-accounthub-tokenid',
    'x-accounthub-token-id',
    'x-account-hub-token-id',
    'x-token-id',
    'authorization',
    'x-api-key',
    'x-goog-api-key',
    'x-accounthub-userid',
    'x-accounthub-user-id',
    'x-account-hub-user-id',
    'x-newapi-userid',
    'x-newapi-user-id',
    'x-user-id',
    'x-uid'
];

/**
 * 从累积的字节 buffer 里尝试解析 HTTP request-line + headers。
 *
 * 返回:
 *   - null: header 还没收完,caller 继续累积
 *   - {method, path, headers, headerEnd}: 解析成功,headerEnd 是 `\r\n\r\n` 之后的 offset
 *   - {error}: 认为是非法 HTTP,caller 应当销毁连接
 *
 * 这里手写一个极简的 HTTP/1.x header parser,避免引入依赖或使用 Node 内部 API。
 * 只在 master 进程的连接入口用一次,worker 侧仍然走 Node 完整的 http.Server 解析。
 */
export function parseHttpPrefix(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return null;

    // 找到 header 结束符 \r\n\r\n
    const sep = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]); // \r\n\r\n
    const endIdx = buf.indexOf(sep);
    if (endIdx === -1) {
        // 还没读完,但如果已经超过 MAX_HEADER_BYTES,判定非法
        if (buf.length >= MAX_HEADER_BYTES) {
            return { error: 'header_too_large' };
        }
        return null;
    }

    const headerSection = buf.slice(0, endIdx).toString('latin1');
    const lines = headerSection.split('\r\n');
    if (lines.length === 0 || !lines[0]) {
        return { error: 'empty_request_line' };
    }

    // request-line:METHOD SP PATH SP VERSION
    const requestLine = lines[0];
    const firstSpace = requestLine.indexOf(' ');
    if (firstSpace < 0) return { error: 'malformed_request_line' };
    const lastSpace = requestLine.lastIndexOf(' ');
    if (lastSpace <= firstSpace) return { error: 'malformed_request_line' };
    const method = requestLine.slice(0, firstSpace);
    const path = requestLine.slice(firstSpace + 1, lastSpace);
    const version = requestLine.slice(lastSpace + 1);
    if (!/^HTTP\/\d\.\d$/.test(version)) return { error: 'not_http' };

    // headers
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const colon = line.indexOf(':');
        if (colon <= 0) continue; // 忽略畸形行
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name && value !== undefined) {
            headers[name] = value;
        }
    }

    return {
        method,
        path,
        headers,
        headerEnd: endIdx + sep.length
    };
}

/**
 * 从 header 表里抽取客户端身份字符串。
 *
 * 优先顺序见 IDENTITY_HEADER_PRIORITY。所有都缺失时 fallback 到 remoteAddress(socket IP)。
 * 如果 remoteAddress 也拿不到,返回 null,上游会走 RR。
 *
 * 注意:对 Authorization: Bearer xxx 这种格式,我们保留完整字符串作为哈希输入,
 * 这样同一个 bearer token 会稳定哈希到同一个 worker。
 */
export function extractClientIdentity(headers, remoteAddress = null) {
    if (headers && typeof headers === 'object') {
        for (const key of IDENTITY_HEADER_PRIORITY) {
            const value = headers[key];
            if (typeof value === 'string' && value.length > 0) {
                return value;
            }
        }
    }
    if (remoteAddress && typeof remoteAddress === 'string') {
        return `ip:${remoteAddress}`;
    }
    return null;
}

/**
 * 给定身份 identity 和 worker 数量,返回 [0, workerCount-1] 中的 index。
 * identity 为空 → 返回 null,caller 应走 round-robin 兜底。
 */
export function stickyWorkerIndex(identity, workerCount) {
    if (!Number.isFinite(workerCount) || workerCount <= 0) return 0;
    if (workerCount === 1) return 0;
    if (!identity) return null;
    return fnv1a32(String(identity)) % workerCount;
}
