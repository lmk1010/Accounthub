-- 优化 request_logs 慢查询
-- 问题：SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ? 耗时 48s
-- 原因：SELECT * 包含大字段（curl_command MEDIUMTEXT, error_stack TEXT 等）

-- ============================================
-- 方案1：只查询必要字段（推荐）
-- ============================================
-- 列表页不需要 curl_command, error_stack, error_detail 等大字段
SELECT
    id,
    provider_uuid,
    provider_type,
    pool_id,
    request_model,
    status_code,
    is_success,
    error_type,
    error_message,  -- 保留简短错误信息
    request_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    credit_usage,
    duration_ms,
    ttft_ms,
    client_ip,
    user_agent,
    client_token_id,
    user_id,
    user_email,
    username,
    created_at
FROM request_logs
ORDER BY created_at DESC
LIMIT 20;

-- ============================================
-- 方案2：检查索引是否存在
-- ============================================
SHOW INDEX FROM request_logs WHERE Key_name = 'idx_created_at';

-- 如果索引不存在或被删除，重新创建：
-- ALTER TABLE request_logs ADD INDEX idx_created_at (created_at);

-- ============================================
-- 方案3：分析执行计划
-- ============================================
EXPLAIN SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 20;

-- 预期结果：
-- - type: index 或 ALL
-- - key: idx_created_at
-- - Extra: Using index 或 Using filesort

-- ============================================
-- 方案4：如果数据量巨大，考虑分区表（高级）
-- ============================================
-- 按月分区，加速历史数据查询
-- ALTER TABLE request_logs PARTITION BY RANGE (TO_DAYS(created_at)) (
--     PARTITION p202601 VALUES LESS THAN (TO_DAYS('2026-02-01')),
--     PARTITION p202602 VALUES LESS THAN (TO_DAYS('2026-03-01')),
--     PARTITION p_future VALUES LESS THAN MAXVALUE
-- );
