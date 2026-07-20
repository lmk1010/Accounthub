/**
 * 号池管理性能测试脚本
 * 测试缓存命中率、选择速度、数据库查询减少等指标
 */

import dotenv from 'dotenv';
import { ProviderPoolManagerDB } from './src/providers/provider-pool-manager-db.js';
import { poolPerformanceLogger } from './src/providers/pool-performance-logger.js';
import { CONFIG } from './src/core/config-manager.js';
import { initializeDatabase, closeDatabase } from './src/config/database.js';

// 加载环境变量
dotenv.config({ path: '.env.development' });

async function testPoolPerformance() {
    console.log('========================================');
    console.log('号池管理性能测试');
    console.log('========================================\n');

    try {
        // 0. 初始化数据库连接池
        console.log('[0/6] 初始化数据库连接池...');
        await initializeDatabase(CONFIG);
        console.log('✓ 数据库连接池初始化完成\n');

        // 1. 初始化号池管理器
        const poolManager = new ProviderPoolManagerDB({
            globalConfig: CONFIG,
            maxErrorCount: 3
        });

        console.log('[1/6] 初始化号池管理器...');
        await poolManager.initialize();
        console.log('✓ 初始化完成\n');

        // 2. 获取号池统计
        console.log('[2/6] 获取号池统计信息...');
        const poolStats = poolManager.getPoolStats();
        console.log('号池统计:', JSON.stringify(poolStats, null, 2));
        console.log('');

        // 3. 性能测试 - 连续选择提供商
        console.log('[3/6] 性能测试 - 连续选择提供商 100 次...');
        const providerTypes = Object.keys(poolManager.providerPools);

        if (providerTypes.length === 0) {
            console.log('⚠ 没有可用的提供商类型，跳过性能测试');
            return;
        }

        const testProviderType = providerTypes[0];
        console.log(`测试提供商类型: ${testProviderType}`);

        const iterations = 100;
        const startTime = Date.now();

        for (let i = 0; i < iterations; i++) {
            await poolManager.selectProvider(testProviderType, null, { skipUsageCount: true });
        }

        const totalTime = Date.now() - startTime;
        const avgTime = totalTime / iterations;

        console.log(`✓ 完成 ${iterations} 次选择`);
        console.log(`  总耗时: ${totalTime}ms`);
        console.log(`  平均耗时: ${avgTime.toFixed(2)}ms`);
        console.log(`  目标: < 50ms (${avgTime < 50 ? '✓ 达标' : '✗ 未达标'})`);
        console.log('');

        // 4. 获取性能报告
        console.log('[4/6] 性能报告...');
        const report = poolPerformanceLogger.getReport();
        console.log(JSON.stringify(report, null, 2));
        console.log('');

        // 5. 验证缓存效果
        console.log('[5/6] 验证缓存效果...');
        const cacheHits = poolPerformanceLogger.metrics.cacheHits;
        const cacheMisses = poolPerformanceLogger.metrics.cacheMisses;
        const cacheTotal = cacheHits + cacheMisses;
        const hitRate = cacheTotal > 0 ? (cacheHits / cacheTotal * 100).toFixed(2) : 0;

        console.log(`缓存命中: ${cacheHits}`);
        console.log(`缓存未命中: ${cacheMisses}`);
        console.log(`缓存命中率: ${hitRate}%`);
        console.log(`目标: > 70% (${hitRate > 70 ? '✓ 达标' : '✗ 未达标'})`);
        console.log('');

        // 6. 测试 /metrics 端点数据
        console.log('[6/6] 检查监控指标集成...');
        const { metricsCollector } = await import('./src/monitoring/metrics-collector.js');

        // 更新号池指标
        metricsCollector.updatePoolMetrics(report);

        console.log('✓ 号池指标已集成到监控系统');
        console.log(`  selectProvider 调用次数: ${report.selectProvider.count}`);
        console.log(`  平均耗时: ${report.selectProvider.avgTime}`);
        console.log(`  缓存命中率: ${report.cache.hitRate}`);
        console.log('');

        // 总结
        console.log('========================================');
        console.log('测试总结');
        console.log('========================================');
        console.log(`✓ 号池初始化成功`);
        console.log(`✓ 提供商选择平均耗时: ${avgTime.toFixed(2)}ms ${avgTime < 50 ? '(优秀)' : '(需优化)'}`);
        console.log(`✓ 缓存命中率: ${hitRate}% ${hitRate > 70 ? '(优秀)' : '(需优化)'}`);
        console.log(`✓ 监控指标集成完成`);
        console.log('');

        if (avgTime < 50 && hitRate > 70) {
            console.log('🎉 所有性能指标达标！');
        } else {
            console.log('⚠ 部分性能指标未达标，建议进一步优化');
        }

        // 关闭数据库连接
        await closeDatabase();

    } catch (error) {
        console.error('测试失败:', error);
        await closeDatabase();
        process.exit(1);
    }

    process.exit(0);
}

// 运行测试
testPoolPerformance();
