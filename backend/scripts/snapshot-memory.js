#!/usr/bin/env node
/**
 * snapshot-memory.js
 *
 * 定时拉 master/status,输出一份结构化内存基线快照,用于各重构阶段对比。
 * 每个快照包含:master/admin/每个 worker 的 RSS/heap、adapter 数、shard 归属、
 * forward 计数、集群汇总。
 *
 * 用法:
 *   node scripts/snapshot-memory.js [--url=http://127.0.0.1:3100/master/status]
 *                                   [--interval=5000]      # ms,默认 5000
 *                                   [--count=12]           # 采样次数,默认 12(=1 分钟@5s)
 *                                   [--out=logs/snapshot-YYYYMMDD-HHMMSS.json]
 *                                   [--label=phase0-before]
 *                                   [--verbose]
 *
 * 也可设环境变量 MASTER_STATUS_URL 覆盖 --url。
 *
 * 一次运行结束后在控制台打印紧凑汇总表(可直接贴进 PR/commit body)。
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
    const out = {};
    for (const raw of argv.slice(2)) {
        if (!raw.startsWith('--')) continue;
        const eq = raw.indexOf('=');
        if (eq === -1) {
            out[raw.slice(2)] = true;
        } else {
            out[raw.slice(2, eq)] = raw.slice(eq + 1);
        }
    }
    return out;
}

const args = parseArgs(process.argv);
const url = args.url || process.env.MASTER_STATUS_URL || 'http://127.0.0.1:3100/master/status';
const intervalMs = parseInt(args.interval, 10) || 5000;
const sampleCount = parseInt(args.count, 10) || 12;
const label = args.label || 'unlabeled';
const verbose = Boolean(args.verbose);

function tsForFilename(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const defaultOut = path.join(__dirname, '..', 'logs', `snapshot-${label}-${tsForFilename()}.json`);
const outPath = args.out || defaultOut;

function fetchStatus(targetUrl) {
    return new Promise((resolve, reject) => {
        const lib = targetUrl.startsWith('https:') ? https : http;
        const req = lib.get(targetUrl, { timeout: 5000 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
    });
}

function toMB(bytes) {
    if (!Number.isFinite(bytes)) return null;
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function sumBy(arr, keyFn) {
    let total = 0;
    let seen = false;
    for (const item of arr) {
        const v = keyFn(item);
        if (Number.isFinite(v)) {
            total += v;
            seen = true;
        }
    }
    return seen ? total : null;
}

function flattenSample(raw, sampledAt) {
    const workers = Array.isArray(raw?.workers) ? raw.workers : [];
    const flatWorkers = workers.map((w) => ({
        id: w.id,
        pid: w.pid,
        state: w.state,
        restartCount: w.restartCount,
        rssMB: toMB(w.memory?.rss),
        heapUsedMB: toMB(w.memory?.heapUsed),
        heapTotalMB: toMB(w.memory?.heapTotal),
        externalMB: toMB(w.memory?.external),
        activeConn: w.concurrency?.active ?? null,
        peakConn: w.concurrency?.peak ?? null,
        totalReq: w.concurrency?.total ?? null,
        adaptersLive: w.adapters?.live ?? null,
        adaptersHot: w.adapters?.hot ?? null,
        disposedSinceStart: w.adapters?.disposedSinceStart ?? null,
        shardId: w.shard?.id ?? null,
        shardCount: w.shard?.count ?? null,
        shardEnabled: w.shard?.enabled ?? false,
        ownedProviders: w.shard?.ownedProviders ?? null,
        forwardEnabled: w.forward?.enabled ?? false,
        forwardIn: w.forward?.in ?? 0,
        forwardOut: w.forward?.out ?? 0,
        forwardErrors: w.forward?.errors ?? 0
    }));

    // 汇总字段优先用 master.js 返回的 cluster 汇总;缺失时从 workers 数组重算,保证对旧版 master 兼容
    const clusterTotals = {
        workers: flatWorkers.length,
        totalRssMB: Number.isFinite(raw?.cluster?.totalRssMB)
            ? raw.cluster.totalRssMB
            : (() => {
                const v = sumBy(flatWorkers, (w) => w.rssMB);
                return v === null ? null : Math.round(v * 10) / 10;
            })(),
        totalHeapUsedMB: Number.isFinite(raw?.cluster?.totalHeapUsedMB)
            ? raw.cluster.totalHeapUsedMB
            : (Number.isFinite(raw?.cluster?.totalMemoryMB)
                ? raw.cluster.totalMemoryMB
                : (() => {
                    const v = sumBy(flatWorkers, (w) => w.heapUsedMB);
                    return v === null ? null : Math.round(v * 10) / 10;
                })()),
        activeConnections: raw?.cluster?.activeConnections ?? null,
        peakConnections: raw?.cluster?.peakConnections ?? null,
        totalRequests: raw?.cluster?.totalRequests ?? null,
        adaptersLive: Number.isFinite(raw?.cluster?.adaptersLive)
            ? raw.cluster.adaptersLive
            : sumBy(flatWorkers, (w) => w.adaptersLive),
        adaptersHot: raw?.cluster?.adaptersHot ?? null,
        ownedProviders: raw?.cluster?.ownedProviders ?? null,
        shardEnabled: raw?.cluster?.shard?.enabled ?? false,
        shardDistribution: raw?.cluster?.shard?.distribution ?? {},
        forward: raw?.cluster?.forward ?? null
    };

    return {
        sampledAt,
        label,
        master: {
            pid: raw?.master?.pid ?? null,
            rssMB: toMB(raw?.master?.memoryUsage?.rss),
            heapUsedMB: toMB(raw?.master?.memoryUsage?.heapUsed),
            heapTotalMB: toMB(raw?.master?.memoryUsage?.heapTotal),
            uptimeSec: raw?.master?.uptime ? Math.round(raw.master.uptime) : null,
            loadAvg: raw?.master?.loadAvg ?? null
        },
        admin: raw?.admin ?? null,
        clusterTotals,
        system: raw?.system ?? null,
        workers: flatWorkers
    };
}

function summarize(samples) {
    if (samples.length === 0) return null;
    const avg = (key) => {
        const values = samples
            .map((s) => s.clusterTotals?.[key])
            .filter((v) => Number.isFinite(v));
        if (values.length === 0) return null;
        return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    };

    const perWorkerAvg = {};
    const lastSample = samples[samples.length - 1];
    for (const w of lastSample.workers) {
        const rssSeries = samples
            .map((s) => s.workers.find((wx) => wx.id === w.id)?.rssMB)
            .filter((v) => Number.isFinite(v));
        const heapSeries = samples
            .map((s) => s.workers.find((wx) => wx.id === w.id)?.heapUsedMB)
            .filter((v) => Number.isFinite(v));
        perWorkerAvg[`worker-${w.id}`] = {
            rssMB: rssSeries.length ? Math.round((rssSeries.reduce((a, b) => a + b, 0) / rssSeries.length) * 10) / 10 : null,
            heapUsedMB: heapSeries.length ? Math.round((heapSeries.reduce((a, b) => a + b, 0) / heapSeries.length) * 10) / 10 : null,
            adaptersLive: w.adaptersLive,
            shardId: w.shardId,
            ownedProviders: w.ownedProviders
        };
    }

    const masterRssSeries = samples
        .map((s) => s.master?.rssMB)
        .filter((v) => Number.isFinite(v));
    const masterAvg = masterRssSeries.length
        ? Math.round((masterRssSeries.reduce((a, b) => a + b, 0) / masterRssSeries.length) * 10) / 10
        : null;

    return {
        samples: samples.length,
        intervalMs,
        label,
        clusterAvg: {
            totalRssMB: avg('totalRssMB'),
            totalHeapUsedMB: avg('totalHeapUsedMB'),
            activeConnections: avg('activeConnections'),
            adaptersLive: avg('adaptersLive')
        },
        master: { avgRssMB: masterAvg },
        workers: perWorkerAvg
    };
}

function printSummary(summary) {
    if (!summary) {
        console.error('no samples collected');
        return;
    }
    console.log('');
    console.log('============================================================');
    console.log(` Memory snapshot summary  [label=${summary.label}]`);
    console.log('============================================================');
    console.log(` samples      : ${summary.samples} @ ${summary.intervalMs}ms`);
    console.log(` cluster rss  : ${summary.clusterAvg.totalRssMB} MB (avg)`);
    console.log(` cluster heap : ${summary.clusterAvg.totalHeapUsedMB} MB (avg)`);
    console.log(` active conn  : ${summary.clusterAvg.activeConnections} (avg)`);
    console.log(` adapters live: ${summary.clusterAvg.adaptersLive} (avg)`);
    console.log(` master rss   : ${summary.master.avgRssMB} MB`);
    console.log('------------------------------------------------------------');
    for (const [name, w] of Object.entries(summary.workers)) {
        const shardTag = Number.isFinite(w.shardId) && w.shardId >= 0
            ? ` [shard ${w.shardId}]` : '';
        const ownedTag = Number.isFinite(w.ownedProviders)
            ? ` owned=${w.ownedProviders}` : '';
        console.log(` ${name}${shardTag}: rss=${w.rssMB}MB heap=${w.heapUsedMB}MB adapters=${w.adaptersLive}${ownedTag}`);
    }
    console.log('============================================================');
}

async function main() {
    console.log(`[snapshot] target=${url} interval=${intervalMs}ms count=${sampleCount} label=${label}`);
    console.log(`[snapshot] out=${outPath}`);

    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
        try {
            const raw = await fetchStatus(url);
            const sample = flattenSample(raw, new Date().toISOString());
            samples.push(sample);
            if (verbose) {
                console.log(`[${i + 1}/${sampleCount}] rss=${sample.clusterTotals.totalRssMB}MB heap=${sample.clusterTotals.totalHeapUsedMB}MB adapters=${sample.clusterTotals.adaptersLive}`);
            } else {
                process.stdout.write('.');
            }
        } catch (err) {
            console.error(`\n[snapshot] fetch error: ${err.message}`);
        }
        if (i < sampleCount - 1) {
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }
    if (!verbose) console.log('');

    const summary = summarize(samples);
    const payload = {
        label,
        generatedAt: new Date().toISOString(),
        source: url,
        sampleCount: samples.length,
        intervalMs,
        summary,
        samples
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`[snapshot] wrote ${outPath}`);
    printSummary(summary);
}

main().catch((err) => {
    console.error('[snapshot] fatal:', err);
    process.exit(1);
});
