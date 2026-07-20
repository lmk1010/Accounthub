-- 优化 request_logs 查询性能
-- 问题：按 provider_type + pool_id + is_success 查询慢
-- 原因：现有索引 idx_type_pool_created 缺少 is_success 字段

-- 添加包含 is_success 的复合索引
ALTER TABLE request_logs
ADD INDEX idx_type_pool_success_created (provider_type, pool_id, is_success, created_at DESC);

-- 说明：
-- 1. 该索引覆盖查询条件：provider_type, pool_id, is_success, created_at
-- 2. 适用于池子日志查询（/api/request-logs?providerType=xxx&poolId=xxx&isSuccess=false）
-- 3. 索引顺序按查询选择性从高到低排列
-- 4. created_at DESC 支持倒序排序，避免 filesort
