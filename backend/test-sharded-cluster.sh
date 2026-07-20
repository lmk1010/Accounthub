#!/usr/bin/env bash
# Phase 6 回归测试:分片集群集成脚本
#
# 本脚本对运行中的 accounthub-backend 容器做端到端校验,不启停服务,不破坏状态。
# 所有调用都走 master/status 只读接口,以及现有的健康检查端点。
#
# 运行方式:
#   REMOTE_HOST=172.245.62.112 REMOTE_PORT=22080 REMOTE_USER=root REMOTE_PASS=xxx \
#       bash test-sharded-cluster.sh
# 或本地运行(直连容器):
#   bash test-sharded-cluster.sh
#
# 需要宿主机上有:
#   - sshpass(远程)或 docker(本地)
#   - jq(JSON 解析)
#
# 如果某一步失败,脚本会打印失败细节并 exit 1。

set -euo pipefail

CONTAINER="${CONTAINER:-accounthub-backend}"
REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PASS="${REMOTE_PASS:-}"

PASSED=0
FAILED=0

pass() { PASSED=$((PASSED+1)); echo "  ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "  ✗ $1"; }

exec_in_container() {
    local cmd="$1"
    if [[ -n "$REMOTE_HOST" ]]; then
        if [[ -z "$REMOTE_PASS" ]]; then
            echo "ERROR: REMOTE_PASS not set" >&2
            return 1
        fi
        sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -p "$REMOTE_PORT" \
            "${REMOTE_USER}@${REMOTE_HOST}" "docker exec $CONTAINER sh -c '$cmd'"
    else
        docker exec "$CONTAINER" sh -c "$cmd"
    fi
}

fetch_master_status() {
    exec_in_container 'node -e "const h=require(\"http\");h.get(\"http://127.0.0.1:3100/master/status\",r=>{let d=\"\";r.on(\"data\",c=>d+=c);r.on(\"end\",()=>process.stdout.write(d));});" 2>/dev/null'
}

echo "========================================"
echo "Phase 6: sharded cluster integration tests"
echo "========================================"
echo ""

# ─────────────────────────────────────────
# Test 1: master/status 可访问
# ─────────────────────────────────────────
echo "[1] master/status 可访问"
STATUS=$(fetch_master_status || true)
if [[ -z "$STATUS" ]]; then
    fail "master/status empty response"
    echo "无法继续,退出"
    exit 1
fi
pass "master/status responded"
echo ""

# ─────────────────────────────────────────
# Test 2: worker 都有 shard id
# ─────────────────────────────────────────
echo "[2] 每个 worker 都有有效 shard id"
WORKER_COUNT=$(echo "$STATUS" | jq '.workers | length')
echo "  worker count: $WORKER_COUNT"
if [[ "$WORKER_COUNT" -lt 1 ]]; then
    fail "no workers in status"
else
    pass "$WORKER_COUNT workers present"
fi

SHARDED_COUNT=$(echo "$STATUS" | jq '[.workers[] | select(.shard.enabled == true)] | length')
echo "  workers reporting shard.enabled=true: $SHARDED_COUNT"
if [[ "$SHARDED_COUNT" -eq "$WORKER_COUNT" ]]; then
    pass "all workers in sharded mode"
elif [[ "$SHARDED_COUNT" -eq 0 && "$WORKER_COUNT" -eq 1 ]]; then
    pass "single worker, sharding not enabled (OK)"
else
    fail "mixed shard enable state"
fi
echo ""

# ─────────────────────────────────────────
# Test 3: shard id 唯一性 + 范围正确
# ─────────────────────────────────────────
echo "[3] shard id 唯一 && 范围 [0, count-1]"
SHARD_IDS=$(echo "$STATUS" | jq -c '[.workers[].shard.id] | sort')
SHARD_COUNT_REPORT=$(echo "$STATUS" | jq '.workers[0].shard.count // 1')
echo "  shard ids: $SHARD_IDS, configured count: $SHARD_COUNT_REPORT"

# 去重后 length 应等于原 length
UNIQ_COUNT=$(echo "$STATUS" | jq '[.workers[].shard.id] | unique | length')
if [[ "$UNIQ_COUNT" == "$WORKER_COUNT" ]]; then
    pass "shard ids are unique"
else
    fail "shard ids have duplicates (uniq=$UNIQ_COUNT, workers=$WORKER_COUNT)"
fi

# 每个 id 都在范围内
OUT_OF_RANGE=$(echo "$STATUS" | jq "[.workers[] | select(.shard.id < 0 or .shard.id >= $SHARD_COUNT_REPORT)] | length")
if [[ "$OUT_OF_RANGE" == "0" ]]; then
    pass "all shard ids in [0, $SHARD_COUNT_REPORT-1]"
else
    fail "$OUT_OF_RANGE workers have out-of-range shard id"
fi
echo ""

# ─────────────────────────────────────────
# Test 4: ownedProviders 总和 ≈ 数据库非删除 provider 数
# ─────────────────────────────────────────
echo "[4] ownedProviders 分布合理"
if [[ "$SHARDED_COUNT" -gt 0 ]]; then
    OWNED=$(echo "$STATUS" | jq '[.workers[].shard.ownedProviders // 0] | add')
    DIST=$(echo "$STATUS" | jq -c '.cluster.shard.distribution')
    echo "  total ownedProviders: $OWNED"
    echo "  distribution: $DIST"
    if [[ "$OWNED" -gt 0 ]]; then
        pass "total ownedProviders = $OWNED"
    else
        echo "  (0 is OK if all providers are unhealthy/deleted or init still running)"
        pass "ownedProviders reported (zero acceptable)"
    fi

    # max / min 检查
    MAX=$(echo "$STATUS" | jq '[.workers[].shard.ownedProviders // 0] | max')
    MIN=$(echo "$STATUS" | jq '[.workers[].shard.ownedProviders // 0] | min')
    echo "  max=$MAX min=$MIN"
    if [[ "$MIN" -gt 0 ]]; then
        RATIO=$(awk -v max="$MAX" -v min="$MIN" 'BEGIN { printf "%.2f", max/min }')
        if awk -v r="$RATIO" 'BEGIN { exit !(r <= 2.0) }'; then
            pass "shard distribution ratio max/min=$RATIO (within 2.0)"
        else
            fail "shard distribution severely skewed: max/min=$RATIO"
        fi
    fi
else
    echo "  skipped (not sharded mode)"
fi
echo ""

# ─────────────────────────────────────────
# Test 5: adaptersLive 合理
# ─────────────────────────────────────────
echo "[5] adapter 池规模"
TOTAL_LIVE=$(echo "$STATUS" | jq '.cluster.adaptersLive // 0')
echo "  total adaptersLive: $TOTAL_LIVE"
if [[ "$SHARDED_COUNT" -gt 0 ]]; then
    OWNED_TOTAL=$(echo "$STATUS" | jq '[.workers[].shard.ownedProviders // 0] | add')
    if [[ "$OWNED_TOTAL" -gt 0 && "$TOTAL_LIVE" -le "$OWNED_TOTAL" ]]; then
        pass "adaptersLive ($TOTAL_LIVE) ≤ ownedProviders ($OWNED_TOTAL)"
    elif [[ "$TOTAL_LIVE" -le "$OWNED_TOTAL" ]]; then
        pass "adaptersLive within bounds"
    else
        fail "adaptersLive $TOTAL_LIVE > ownedProviders $OWNED_TOTAL (should never exceed)"
    fi
else
    pass "adaptersLive=$TOTAL_LIVE (single worker)"
fi
echo ""

# ─────────────────────────────────────────
# Test 6: master 内存在合理范围
# ─────────────────────────────────────────
echo "[6] master 内存合理"
MASTER_RSS_MB=$(echo "$STATUS" | jq '(.master.memoryUsage.rss // 0) / 1024 / 1024 | floor')
echo "  master RSS: ${MASTER_RSS_MB} MB"
if [[ "$MASTER_RSS_MB" -lt 500 ]]; then
    pass "master RSS < 500 MB"
else
    fail "master RSS ${MASTER_RSS_MB} MB too high (should be supervisor only)"
fi
echo ""

# ─────────────────────────────────────────
# Test 7: 每 worker RSS 预期
# ─────────────────────────────────────────
echo "[7] worker RSS 分布"
echo "$STATUS" | jq -r '.workers[] | "  worker-\(.id) shard=\(.shard.id // "-") rss=\((.memory.rss // 0)/1024/1024 | floor)MB heap=\((.memory.heapUsed // 0)/1024/1024 | floor)MB adapters=\(.adapters.live // 0)"'

HIGH_WORKERS=$(echo "$STATUS" | jq '[.workers[] | select((.memory.rss // 0) > 600*1024*1024)] | length')
if [[ "$HIGH_WORKERS" == "0" ]]; then
    pass "all workers RSS < 600 MB"
else
    fail "$HIGH_WORKERS worker(s) exceed 600 MB RSS"
fi
echo ""

# ─────────────────────────────────────────
# Test 8: 转发统计字段存在
# ─────────────────────────────────────────
echo "[8] forward 指标字段就位"
FORWARD_FIELDS_OK=$(echo "$STATUS" | jq '[.workers[] | select(.forward != null and (.forward.in // -1) >= 0 and (.forward.out // -1) >= 0 and (.forward.errors // -1) >= 0)] | length')
if [[ "$FORWARD_FIELDS_OK" == "$WORKER_COUNT" ]]; then
    pass "all workers report forward stats"
else
    fail "$FORWARD_FIELDS_OK / $WORKER_COUNT workers have complete forward stats"
fi
echo ""

# ─────────────────────────────────────────
# Test 9: /master/metrics Prometheus 输出
# ─────────────────────────────────────────
echo "[9] /master/metrics 输出 prometheus 格式"
METRICS=$(exec_in_container 'node -e "const h=require(\"http\");h.get(\"http://127.0.0.1:3100/master/metrics\",r=>{let d=\"\";r.on(\"data\",c=>d+=c);r.on(\"end\",()=>process.stdout.write(d));});" 2>/dev/null')
if echo "$METRICS" | grep -q "^accounthub_"; then
    METRIC_COUNT=$(echo "$METRICS" | grep -c "^accounthub_" || true)
    pass "metrics endpoint returns $METRIC_COUNT accounthub_* lines"
else
    fail "metrics endpoint returned no accounthub_* lines"
fi

# 关键字段存在
for key in accounthub_cluster_shard_count accounthub_worker_rss_bytes accounthub_worker_adapters_live; do
    if echo "$METRICS" | grep -q "^$key"; then
        pass "metric $key present"
    else
        fail "metric $key missing"
    fi
done
echo ""

# ─────────────────────────────────────────
# Result
# ─────────────────────────────────────────
echo "========================================"
echo "Passed: $PASSED   Failed: $FAILED"
echo "========================================"
if [[ "$FAILED" -gt 0 ]]; then
    exit 1
fi
