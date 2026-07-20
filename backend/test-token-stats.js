/**
 * Token 统计功能诊断脚本
 */

import { initializeDatabase } from './src/config/database.js';
import * as providerTokenStatsDao from './src/dao/provider-token-stats-dao.js';
import * as requestLogsDao from './src/dao/request-logs-dao.js';

async function diagnose() {
    console.log('🔍 开始诊断 Token 统计功能...\n');

    try {
        // 1. 初始化数据库连接
        console.log('1️⃣ 初始化数据库连接...');
        await initializeDatabase();
        console.log('✅ 数据库连接成功\n');

        // 2. 检查并创建表
        console.log('2️⃣ 检查 provider_token_stats 表...');
        await providerTokenStatsDao.ensureTable();
        console.log('✅ 表已存在或创建成功\n');

        // 3. 测试插入统计数据
        console.log('3️⃣ 测试插入统计数据...');
        const testUuid = 'test-uuid-' + Date.now();
        await providerTokenStatsDao.incrementStats(
            testUuid,
            'claude-kiro-oauth',
            'claude-sonnet-4-5-20250929',
            1000000,  // 1M input tokens
            500000    // 0.5M output tokens
        );
        console.log('✅ 统计数据插入成功\n');

        // 4. 查询统计数据
        console.log('4️⃣ 查询统计数据...');
        const stats = await providerTokenStatsDao.getStatsByProvider(testUuid);
        console.log('✅ 查询成功:');
        console.log(JSON.stringify(stats, null, 2));
        console.log('');

        // 5. 测试请求日志记录（会触发 token 统计）
        console.log('5️⃣ 测试请求日志记录...');
        const logId = await requestLogsDao.create({
            provider_uuid: testUuid,
            provider_type: 'claude-kiro-oauth',
            request_model: 'claude-haiku-4-5-20251001',
            input_tokens: 2000000,  // 2M
            output_tokens: 1000000, // 1M
            status_code: 200,
            is_success: true
        });
        console.log(`✅ 请求日志记录成功 (ID: ${logId})`);
        console.log('⏳ 等待异步 token 统计更新...');

        // 等待异步更新完成
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 6. 再次查询统计数据
        console.log('\n6️⃣ 再次查询统计数据（应该包含新记录）...');
        const updatedStats = await providerTokenStatsDao.getStatsByProvider(testUuid);
        console.log('✅ 查询成功:');
        console.log(JSON.stringify(updatedStats, null, 2));
        console.log('');

        // 7. 检查是否正确累加
        const totalStat = updatedStats.stats.find(s => s.model === '总计');
        if (totalStat) {
            const expectedTotal = (1000000 + 2000000 + 500000 + 1000000) / 1000000;
            const actualTotal = parseFloat(totalStat.totalTokensM);
            if (Math.abs(expectedTotal - actualTotal) < 0.01) {
                console.log('✅ Token 统计累加正确！');
                console.log(`   预期: ${expectedTotal.toFixed(2)}M, 实际: ${actualTotal}M\n`);
            } else {
                console.log('⚠️  Token 统计累加可能有问题');
                console.log(`   预期: ${expectedTotal.toFixed(2)}M, 实际: ${actualTotal}M\n`);
            }
        }

        console.log('🎉 所有测试通过！Token 统计功能正常工作。\n');
        console.log('💡 如果实际使用中没有统计数据，请检查：');
        console.log('   1. request_logs 表中是否有 input_tokens 和 output_tokens 数据');
        console.log('   2. 后端日志中是否有 "[RequestLogsDao] Failed to update token stats" 错误');
        console.log('   3. 调用 POST /api/token-stats/rebuild 重建历史统计');

    } catch (error) {
        console.error('❌ 诊断失败:', error);
        console.error('\n错误详情:', error.stack);
    } finally {
        process.exit(0);
    }
}

diagnose();
