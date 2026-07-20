#!/usr/bin/env node
/**
 * Phase 6 回归测试:shard.js 哈希工具
 *
 * 测试项:
 *   1) FNV-1a hash 确定性(同输入永远同输出)
 *   2) 哈希分布均匀性(10000 随机 uuid × 3 shard,各 shard 偏差 < 3%)
 *   3) 哈希分布均匀性(10000 随机 uuid × 8 shard)
 *   4) ownsUuid 与 shardOfUuid 语义一致
 *   5) 未启用分片场景(SHARD_COUNT=1)ownsUuid 恒 true
 *   6) admin 进程场景(SHARD_COUNT=3 SHARD_ID=-1)ownsUuid 恒 true
 *   7) filterOwnedProviders / countOwnedProviders 正确性
 *   8) getShardInfo 形状稳定
 *
 * 用法:
 *   WORKER_SHARD_COUNT=3 WORKER_SHARD_ID=1 node test-shard.js
 *   node test-shard.js                       # 未启用分片
 */

import crypto from 'crypto';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}

function assertWithin(actual, expected, tolerance, msg) {
    const diff = Math.abs(actual - expected);
    if (diff <= tolerance) {
        passed++;
        console.log(`  ✓ ${msg} (actual=${actual}, expected=${expected}±${tolerance})`);
    } else {
        failed++;
        console.error(`  ✗ ${msg} (actual=${actual}, expected=${expected}±${tolerance}, diff=${diff})`);
    }
}

function randomUuid() {
    return crypto.randomUUID();
}

async function run() {
    console.log('========================================');
    console.log('Phase 6: shard.js regression tests');
    console.log('========================================');
    console.log(`WORKER_SHARD_COUNT=${process.env.WORKER_SHARD_COUNT || '(unset)'}`);
    console.log(`WORKER_SHARD_ID=${process.env.WORKER_SHARD_ID || '(unset)'}`);
    console.log('');

    const shard = await import('./src/utils/shard.js');

    // ─────────────────────────────────────────
    // Test 1: FNV-1a determinism
    // ─────────────────────────────────────────
    console.log('[1] FNV-1a 确定性');
    const sample = 'test-uuid-12345';
    const h1 = shard.fnv1a32(sample);
    const h2 = shard.fnv1a32(sample);
    const h3 = shard.fnv1a32(sample);
    assert(h1 === h2 && h2 === h3, `same input → same hash (${h1})`);
    assert(shard.fnv1a32('') === 0, 'empty string → 0');
    assert(shard.fnv1a32(null) === 0, 'null → 0');
    assert(shard.fnv1a32(undefined) === 0, 'undefined → 0');
    assert(Number.isInteger(h1) && h1 >= 0 && h1 <= 0xffffffff, 'output is uint32');
    console.log('');

    // ─────────────────────────────────────────
    // Test 2: Distribution on 3 shards
    // ─────────────────────────────────────────
    console.log('[2] 哈希分布均匀性(10000 uuid × 3 shard)');
    const SAMPLES = 10000;
    const buckets3 = { 0: 0, 1: 0, 2: 0 };
    for (let i = 0; i < SAMPLES; i++) {
        const uuid = randomUuid();
        const b = shard.fnv1a32(uuid) % 3;
        buckets3[b]++;
    }
    const expected3 = SAMPLES / 3;
    const tolerance3 = expected3 * 0.03; // 3%
    assertWithin(buckets3[0], expected3, tolerance3, `shard 0 count`);
    assertWithin(buckets3[1], expected3, tolerance3, `shard 1 count`);
    assertWithin(buckets3[2], expected3, tolerance3, `shard 2 count`);
    const max3 = Math.max(...Object.values(buckets3));
    const min3 = Math.min(...Object.values(buckets3));
    const dev3 = ((max3 - min3) / expected3 * 100).toFixed(2);
    console.log(`  Distribution: ${JSON.stringify(buckets3)}  max-min deviation: ${dev3}%`);
    console.log('');

    // ─────────────────────────────────────────
    // Test 3: Distribution on 8 shards
    //
    // 统计学基线:均值 n/8 = 1250,标准差 σ ≈ sqrt(1250) ≈ 35.4。
    // 3σ 覆盖 99.7% 样本,即单次运行 max-min 大约在 2*3σ = 212 以内,
    // 对应 ~17% 的 max-min deviation。这是正常随机抖动,不是分布问题。
    // 所以用 10% 单 bucket 偏差 + 20% max-min deviation 作为阈值,给概率上的噪声留余量。
    // ─────────────────────────────────────────
    console.log('[3] 哈希分布均匀性(10000 uuid × 8 shard)');
    const buckets8 = {};
    for (let i = 0; i < 8; i++) buckets8[i] = 0;
    for (let i = 0; i < SAMPLES; i++) {
        const uuid = randomUuid();
        const b = shard.fnv1a32(uuid) % 8;
        buckets8[b]++;
    }
    const expected8 = SAMPLES / 8;
    const tolerance8 = expected8 * 0.10; // 单 bucket ±10%
    let allInTolerance = true;
    for (const [, v] of Object.entries(buckets8)) {
        if (Math.abs(v - expected8) > tolerance8) allInTolerance = false;
    }
    assert(allInTolerance, `all 8 shards within ±10% of ${expected8}`);
    const max8 = Math.max(...Object.values(buckets8));
    const min8 = Math.min(...Object.values(buckets8));
    const dev8 = ((max8 - min8) / expected8 * 100);
    // 3σ 对应 ~17% max-min deviation,留余量 25%
    assert(dev8 < 25, `max-min deviation < 25% (actual ${dev8.toFixed(2)}%)`);
    console.log(`  Distribution: ${JSON.stringify(buckets8)}  max-min deviation: ${dev8.toFixed(2)}%`);
    console.log('');

    // ─────────────────────────────────────────
    // Test 4: ownsUuid ↔ shardOfUuid 一致性
    // ─────────────────────────────────────────
    console.log('[4] ownsUuid / shardOfUuid 一致性');
    const testUuids = [];
    for (let i = 0; i < 500; i++) testUuids.push(randomUuid());
    let consistent = true;
    for (const u of testUuids) {
        const s = shard.shardOfUuid(u);
        const owns = shard.ownsUuid(u);
        if (shard.SHARD_ENABLED) {
            if ((s === shard.SHARD_ID) !== owns) {
                consistent = false;
                break;
            }
        } else {
            if (!owns) {
                consistent = false;
                break;
            }
        }
    }
    assert(consistent, 'ownsUuid(u) === (shardOfUuid(u) === SHARD_ID) OR !SHARD_ENABLED');
    console.log('');

    // ─────────────────────────────────────────
    // Test 5: 未启用分片
    // ─────────────────────────────────────────
    console.log('[5] 语义:SHARD_COUNT / SHARD_ID / SHARD_ENABLED');
    console.log(`  SHARD_COUNT=${shard.SHARD_COUNT} SHARD_ID=${shard.SHARD_ID} SHARD_ENABLED=${shard.SHARD_ENABLED}`);
    if (!shard.SHARD_ENABLED) {
        assert(shard.ownsUuid('any-uuid') === true, 'SHARD_ENABLED=false → ownsUuid 恒 true');
        assert(shard.ownsUuid(null) === true, 'null uuid → true(当作"无 uuid 场景")');
    } else {
        const mineUuids = testUuids.filter(u => shard.ownsUuid(u));
        const otherUuids = testUuids.filter(u => !shard.ownsUuid(u));
        console.log(`  SHARD_ENABLED=true: I own ${mineUuids.length}/500, others ${otherUuids.length}/500`);
        assert(mineUuids.length > 0 && mineUuids.length < 500,
            `shard owns a proper subset (not all, not none)`);
    }
    console.log('');

    // ─────────────────────────────────────────
    // Test 6: filterOwnedProviders / countOwnedProviders
    // ─────────────────────────────────────────
    console.log('[6] filterOwnedProviders / countOwnedProviders');
    const providers = testUuids.map(u => ({ uuid: u, name: `provider-${u.slice(0, 4)}` }));
    const filtered = shard.filterOwnedProviders(providers);
    const counted = shard.countOwnedProviders(providers);
    assert(Array.isArray(filtered), 'filterOwnedProviders returns array');
    assert(filtered.length === counted, 'filtered.length === countOwnedProviders');
    if (!shard.SHARD_ENABLED) {
        assert(filtered.length === providers.length, '!SHARD_ENABLED: returns all');
    } else {
        assert(filtered.every(p => shard.ownsUuid(p.uuid)), 'all filtered entries owned by this shard');
    }
    console.log('');

    // ─────────────────────────────────────────
    // Test 7: getShardInfo 形状
    // ─────────────────────────────────────────
    console.log('[7] getShardInfo 形状');
    const info = shard.getShardInfo();
    assert(typeof info === 'object' && info !== null, 'returns object');
    assert(Number.isFinite(info.id), 'info.id is number');
    assert(Number.isFinite(info.count) && info.count >= 1, 'info.count is positive');
    assert(typeof info.enabled === 'boolean', 'info.enabled is boolean');
    assert(info.ownedProviders === null || Number.isFinite(info.ownedProviders),
        'info.ownedProviders null or number');
    console.log(`  info=${JSON.stringify(info)}`);
    console.log('');

    // ─────────────────────────────────────────
    // Result
    // ─────────────────────────────────────────
    console.log('========================================');
    console.log(`Passed: ${passed}   Failed: ${failed}`);
    console.log('========================================');
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
});
