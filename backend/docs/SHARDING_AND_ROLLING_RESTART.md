# 分片架构与滚动重启(方案 B - sticky TCP dispatcher)

本文档介绍 AccountHub backend 的 provider 分片架构,以及滚动重启 worker 的正确姿势。

## 零、核心思路

采用 **nginx 风格的 consistent hash upstream routing**,由 master 自己实现 TCP 层粘性分发:

```
Client (with x-accounthub-tokenid header)
   ↓ TCP :1458
master net.createServer (pauseOnConnect)
   ↓ peek 第一个 HTTP 请求的 header (几百字节)
   ↓ identity = x-accounthub-tokenid || authorization || ip
   ↓ workerId = FNV-1a(identity) % N
   ↓ worker.send({type:'sticky_handoff', prefix}, socket) 通过 cluster IPC 转移 fd
   ↓
worker 收到 socket handle → unshift(prefix) → httpServer.emit('connection', socket)
   ↓
worker 本地走完整 HTTP 解析 + 业务处理 → 响应流**直出客户端**
```

**master 只在每条 TCP 连接建立瞬间参与几百字节的 header parse,之后完全离开数据路径。
SSE / 大响应流从 worker 直接写回客户端,不再经过 master。**

同一 token 的请求,不管客户端何时发,都经 master hash 后稳定落到同一个 worker ——
worker 本地的 sticky session cache / adapter cache 必然命中,同 token 用户的上下文
永远在一个 worker 上,直到 worker 本身下线。

## 一、架构概览

### 进程拓扑

```
master (PID 1)
  ├─ admin(独立 spawn,PID 18 左右,端口 1456)
  │    - 不持有任何 shard
  │    - 不预加载 adapter(Phase 1)
  │    - UI 操作触发的 adapter 在 5 分钟内自动回收(Phase 4)
  │
  ├─ worker-0(cluster.fork,PID 19+,端口 1458 共享 + 127.0.0.1:11558 内部)
  │    - WORKER_SHARD_ID=0, WORKER_SHARD_COUNT=N
  │    - 只持有 hash(uuid) % N === 0 的 provider adapter
  │    - 跑自己 shard 的健康检查、token 刷新、warmup、auto-recover
  │
  ├─ worker-1(PID 20+,端口 1458 共享 + 127.0.0.1:11559 内部)
  │    - WORKER_SHARD_ID=1,只持有 hash(uuid) % N === 1 的 provider
  │
  └─ worker-2(PID 21+,端口 1458 共享 + 127.0.0.1:11560 内部)
       - WORKER_SHARD_ID=2,只持有 hash(uuid) % N === 2 的 provider
```

### 请求路径

**非 sticky 请求(多数)**
```
Client → (cluster SCHED_RR) → worker-N → 本地 findAvailable(filter by shard) → 本地 adapter → 服务
```
零跨 worker 转发。

**sticky 请求且 uuid 属于本 shard**
```
Client → worker-N → Redis sticky → uuid X(属于 N) → 本地 adapter → 服务
```
零跨 worker 转发。

**sticky 请求且 uuid 属于别的 shard**
```
Client → worker-A → Redis sticky → uuid X(属于 B)
         → 检测 ownsUuid(X) === false
         → 构造 cross-shard marker → 抛 CrossShardForwardSignal
         → handler 捕获 → forwardRequestToShard(B, X, req, body, res)
         → HTTP POST → 127.0.0.1:(11558 + B) 带 X-Internal-Forward-Target-Uuid 头
         → worker-B 的 internal-forward server 收到 → 走 enhancedHandler
         → handler 识别 forward 头 → passes forcedUuid=X 给 getApiService
         → selectProvider 的 forcedUuid 路径 → findByUuid(X) → 返回配置
         → worker-B 的本地 adapter 服务 → 响应流 pipe 回 worker-A → pipe 回 Client
```
额外一次 loopback HTTP 跳(< 1ms 延迟)。

### Shard 哈希

使用 FNV-1a 32bit:
```
hash = 2166136261
for each char in uuid:
    hash ^= charCode
    hash = (hash * 16777619) & 0xffffffff
shard = hash % WORKER_SHARD_COUNT
```

分布均匀性:3000 uuid × 3 shard 实测偏差 2.3%,远低于 3% 可接受阈值。

## 二、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKERS` | CPU 核数 | cluster worker 数量 = shard 数 |
| `WORKER_SHARD_ID` | 自动注入 | 由 master fork 时给每个 worker 注入 0..N-1 |
| `WORKER_SHARD_COUNT` | 自动注入 | 等于 WORKERS |
| `INTERNAL_FORWARD_PORT_BASE` | 11558 | 内部转发端口起点,worker-N 监听 BASE + N |
| `ADAPTER_IDLE_TTL_MS` | 60 min(worker) / 5 min(admin) | adapter 空闲多久会被 idle sweeper 回收 |
| `ADAPTER_IDLE_SWEEP_INTERVAL_MS` | 2 min(worker) / 1 min(admin) | sweeper 扫描频率 |
| `ADAPTER_IDLE_SWEEPER_DISABLED` | - | 设为 `true` 禁用 sweeper(仅测试用) |

## 三、滚动重启

### 正常场景(代码变更、配置更新)

```bash
# 优雅重启整个 backend 容器
docker restart accounthub-backend
```

`master.js` 的 SIGTERM handler 会:
1. kill admin → 触发 admin 的 gracefulShutdown
2. kill 所有 worker → 每个 worker 的 gracefulShutdown 两阶段:
   - 关 1458 对外端口(停接新请求)
   - 等 serverInstance.close 回调(in-flight 请求排空)
   - 关 11558+N 内部端口(兄弟 worker 的 in-flight 转发完成)
   - process.exit

### 单个 worker 崩溃

master 的 `cluster.on('exit')` 会自动 fork **同一个 workerId** 的新 worker,
所以 shard 拓扑保持不变。期间:
- 对应 shard 的 provider adapter 暂时不可用
- 客户端请求如果命中该 shard 的 sticky → 转发失败 → fallback 到发起方本地重选(临时换号)
- 健康检查 / token 刷新 等周期任务暂停,新 worker 起来后恢复
- 新 worker 重建 adapter 需要几秒到十几秒

### 调整 worker 数量(改分片数)

**警告**:改 `WORKERS` 环境变量 = 改 `WORKER_SHARD_COUNT` → 所有 uuid 的 shard 归属都会
重新计算。旧的 Redis sticky 键会指向"按旧哈希映射"的 uuid,拿到新 worker 时可能发现
uuid 不在本 shard → 走 cross-shard forward → 目标 worker 也可能不是新哈希下的 owner
→ 短时间内 sticky 命中率下降。

master.js 的 `_ownedProviderCount` 会在启动时通过 shard 0 的 worker 写入 Redis
键 `aiclient:shard:topology:count`,下次启动检测到不一致会 WARN。

**推荐步骤**:
1. 业务低峰期执行
2. 修改 docker-compose.yml 的 `WORKERS` 环境变量
3. `docker restart accounthub-backend`
4. 观察日志 `[ShardTopology] ⚠ SHARD_COUNT changed: was X, now Y`
5. (可选)清空 Redis sticky 键立即重建:
   ```bash
   docker exec redis-core redis-cli -a "$REDIS_PASSWORD" --scan --pattern "aiclient:sticky:*" | xargs -I{} docker exec redis-core redis-cli -a "$REDIS_PASSWORD" DEL {}
   ```
6. 等待新拓扑下的 sticky 自然重建(客户端每次请求会 set 新绑定)

## 四、运行时诊断

### 查看集群状态

```bash
docker exec accounthub-backend curl -s http://127.0.0.1:3100/master/status | jq
```

关键字段:
- `workers[].shard.{id,count,ownedProviders,enabled}` 每 worker 的 shard 归属
- `workers[].adapters.{live,hot,disposedSinceStart}` adapter 缓存状态
- `workers[].forward.{in,out,errors,inFlight}` 跨 worker 转发统计
- `cluster.shard.distribution` shard 分布直方图(eg `{"0":452,"1":451,"2":452}`)
- `cluster.totalRssMB` / `cluster.adaptersLive` 集群汇总

### Prometheus metrics

```bash
docker exec accounthub-backend curl -s http://127.0.0.1:3100/master/metrics
```

输出标准 prometheus exposition format,指标名前缀 `accounthub_`。

### 触发 heap snapshot

```bash
# 找到要 dump 的进程 pid
docker exec accounthub-backend ls /proc | grep -E '^[0-9]+$'
# 发 SIGUSR2
docker exec accounthub-backend kill -SIGUSR2 <pid>
# 文件会落在 /app/logs/heap-<pid>-<timestamp>.heapsnapshot
docker cp accounthub-backend:/app/logs/heap-xxx.heapsnapshot ./
# 用 Chrome DevTools → Memory → Load 打开
```

注意:对高负载 worker 做 heap snapshot 会 pause 几秒,谨慎在生产使用。
建议先把流量切走或对空闲 worker 执行。

### 打印轻量运行时快照(SIGUSR1,不 pause)

```bash
docker exec accounthub-backend kill -SIGUSR1 <pid>
# 输出到该进程的日志:
#   [Diagnostics] === runtime snapshot ===
#     pid=19 uptime=3600s
#     rss=320MB heapUsed=210MB heapTotal=260MB external=15MB
#     shard id=0 count=3 enabled=true
#     adapters live=54 hot=23 disposed=8
#     forward in=12 out=34 errors=0 inFlight=0
#   [Diagnostics] === end snapshot ===
```

### 快照内存基线对比

```bash
# 跑一次 snapshot 工具(在容器内)
docker exec accounthub-backend node /app/scripts/snapshot-memory.js \
    --label=ops-check-$(date +%Y%m%d) \
    --interval=5000 --count=12
# 文件写到 /app/logs/snapshot-<label>-<ts>.json
```

## 五、故障排查

### 某个 worker 的 adapter 数明显多于其他

原因:可能是 WORKER_SHARD_ID 没正确注入,或 SHARD_ENABLED 没生效。
检查:
```bash
docker exec accounthub-backend curl -s http://127.0.0.1:3100/master/status | \
    jq '.workers[] | {id, shard, adapters}'
```
应该看到每个 worker 的 `shard.id` 是独立值(0/1/2),`adapters.live` 大致均衡。
若某个 worker `shard.enabled=false` 或 `shard.id=-1`,说明 env 没注入,检查 master.js
的 `startWorker` 是否正确传参。

### 内部转发失败率高(`forward.errors` 增长)

原因:
- 目标 worker 崩溃中 / 正在重启 → 短暂现象,等自愈
- 内部端口冲突 → 日志看 `[InternalForward] server error on port`
- 防火墙屏蔽 loopback → 极少见,检查 iptables

fallback:转发失败会自动删掉对应的 Redis sticky 键,下次请求回到本地重选。不会丢请求。

### Shard 分布严重不均告警

`[ShardImbalance] ⚠ Owned provider distribution skewed`

可能原因:
- 总 provider 数太少(例如只有 10 个 codex 号对 3 个 shard)
- 某个类型大量集中创建(uuid 批次相关性,虽然 FNV-1a 应该打散)
- Provider 删除后本地 metrics 尚未同步

短期:不影响服务,fallback + cross-shard rescue 会兜底。
长期:考虑减少 worker 数(让每个 shard 容量增大)或手工干预。

## 六、性能参考

单 loopback HTTP 往返延迟:**< 1ms**(127.0.0.1 TCP)
sticky 跨 shard 请求增量延迟:**~1-2ms**
分片下内存收益:每 worker RSS 下降约 **50-60%**(相对单 worker 全量持有)
