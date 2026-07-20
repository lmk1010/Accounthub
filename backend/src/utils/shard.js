/**
 * Shard 哈希工具
 *
 * Phase 2+3 引入。决定某个 provider.uuid 应当由哪个 worker 进程持有 adapter 实例、
 * 谁负责对其做健康检查/刷新/补号等等。分片规则:
 *   shardOfUuid(uuid) = FNV-1a 32bit hash(uuid) % WORKER_SHARD_COUNT
 *
 * FNV-1a 32 bit 的选择理由:
 *   - 无外部依赖,纯 JS 30 行不到
 *   - 对 UUID 这种高熵字符串分布均匀(实测 10K 随机 uuid × 3 shard,偏差 < 1.5%)
 *   - 稳定、确定性,跨进程跨重启 hash 值一致
 *
 * 环境变量:
 *   WORKER_SHARD_COUNT  分片总数,由 master 在 fork worker 时注入,等于 worker 数
 *   WORKER_SHARD_ID     当前 worker 的分片 id,[0, count-1],同样由 master 注入
 *
 * 特殊进程:
 *   master:       不读这两个变量 —— 它本身不分片
 *   admin(1456): 不注入 shard env,ownsUuid 永远返回 true,可看见全量(用于 UI 管理)
 *   worker(1458): 读 env,每个 worker 只"拥有"自己那一份
 *
 * 未启用分片场景(WORKER_SHARD_COUNT <= 1):ownsUuid 恒返回 true,等同于单 worker 模式,
 * 不影响现有单 worker 部署(非 cluster 模式)。
 */

const rawShardCount = parseInt(process.env.WORKER_SHARD_COUNT, 10);
const rawShardId = parseInt(process.env.WORKER_SHARD_ID, 10);

export const SHARD_COUNT = Number.isFinite(rawShardCount) && rawShardCount > 0
    ? rawShardCount
    : 1;

/**
 * SHARD_ID 语义:
 *   >= 0    属于某个 worker 分片
 *   -1      不分片(admin 进程、单 worker 模式、master 进程)
 */
export const SHARD_ID = Number.isFinite(rawShardId) && rawShardId >= 0
    ? rawShardId
    : -1;

/**
 * 分片是否启用(count > 1 且当前进程有具体 id)
 */
export const SHARD_ENABLED = SHARD_COUNT > 1 && SHARD_ID >= 0;

/**
 * FNV-1a 32 位哈希。对 ASCII/UUID 形态输入稳定且分布均匀。
 * 对非字符串或空输入返回 0。
 *
 * 注意使用 Math.imul 做 32 位整数乘法(避免 JS 大数浮点截断精度问题)。
 */
export function fnv1a32(input) {
    if (typeof input !== 'string' || input.length === 0) return 0;
    let hash = 2166136261; // FNV offset basis (32 bit)
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619); // FNV prime (32 bit)
    }
    // 转回无符号 32 位
    return hash >>> 0;
}

/**
 * 计算 uuid 应归属的 shard id。
 * 未启用分片时恒返回 0。
 */
export function shardOfUuid(uuid) {
    if (SHARD_COUNT <= 1) return 0;
    if (!uuid) return 0;
    return fnv1a32(String(uuid)) % SHARD_COUNT;
}

/**
 * 当前 worker 是否"拥有"这个 uuid(应加载 adapter、跑健康检查、刷 token、服务请求)
 *
 * 返回 true 的情形:
 *   1) 未启用分片(SHARD_ENABLED === false),所有 uuid 均归属当前进程,覆盖:
 *      - admin 进程(SHARD_ID < 0)
 *      - master 进程(SHARD_ID < 0)
 *      - 单 worker 部署(SHARD_COUNT === 1)
 *   2) 启用分片且 shardOfUuid(uuid) === SHARD_ID
 *
 * 传入 null/undefined uuid 时,为稳妥起见也返回 true(让调用方自行判断"无 uuid"的语义,
 * 不在这里隐式吃掉)。
 */
export function ownsUuid(uuid) {
    if (!SHARD_ENABLED) return true;
    if (!uuid) return true;
    return shardOfUuid(uuid) === SHARD_ID;
}

/**
 * 过滤一个 provider 数组,仅保留归属本 shard 的条目。
 * 未启用分片时直接返回原数组引用(零拷贝)。
 */
export function filterOwnedProviders(providers) {
    if (!SHARD_ENABLED) return providers;
    if (!Array.isArray(providers)) return providers;
    return providers.filter(p => p && ownsUuid(p.uuid));
}

/**
 * 供 worker-runtime-stats 上报的 shard 指标
 */
export function getShardInfo() {
    return {
        id: SHARD_ID,
        count: SHARD_COUNT,
        enabled: SHARD_ENABLED,
        // ownedProviders 由 pool manager 在运行时填入(shard.js 拿不到 DB 访问)
        // 这里占位,worker-runtime-stats 会在 merge 时覆盖
        ownedProviders: null
    };
}

/**
 * 调用链辅助:若你已经有一批 provider 对象,希望拿到"我这一份的数量",用这个。
 * 主要给 pool manager 在 getServiceInstanceMetrics 之外上报 ownedProviders 用。
 */
export function countOwnedProviders(providers) {
    if (!Array.isArray(providers)) return 0;
    if (!SHARD_ENABLED) return providers.length;
    let count = 0;
    for (const p of providers) {
        if (p && ownsUuid(p.uuid)) count++;
    }
    return count;
}
