-- ============================================
-- providers 表索引优化
-- ============================================
-- 注意：如果索引已存在会报错，可以忽略该错误继续执行

-- 1. 复合索引：用于常见的筛选查询（provider_type + pool_id + 状态字段）
-- 这个索引覆盖了最常见的查询模式
CREATE INDEX idx_providers_type_pool_status
ON providers(provider_type, pool_id, is_deleted, is_healthy, is_disabled);

-- 2. 排序字段索引：创建时间（最常用的排序字段）
CREATE INDEX idx_providers_created_at
ON providers(created_at DESC);

-- 3. 排序字段索引：用量相关
CREATE INDEX idx_providers_current_usage
ON providers(current_usage DESC);

-- 4. 排序字段索引：使用次数
CREATE INDEX idx_providers_usage_count
ON providers(usage_count DESC);

-- 5. 排序字段索引：最后使用时间
CREATE INDEX idx_providers_last_used
ON providers(last_used DESC);

-- 6. UUID 唯一索引（如果还没有的话）
CREATE UNIQUE INDEX idx_providers_uuid
ON providers(uuid);

-- 7. 复合索引：provider_type + is_deleted（用于统计查询）
CREATE INDEX idx_providers_type_deleted
ON providers(provider_type, is_deleted);

-- 8. 复合索引：provider_type + pool_id（用于池子统计）
CREATE INDEX idx_providers_type_pool
ON providers(provider_type, pool_id);

-- ============================================
-- request_logs 表索引优化
-- ============================================

-- 1. 复合索引：provider_uuid + created_at（用于按账号查询日志）
CREATE INDEX idx_request_logs_provider_time
ON request_logs(provider_uuid, created_at DESC);

-- 2. 复合索引：provider_type + pool_id + created_at（用于按池子查询日志）
CREATE INDEX idx_request_logs_type_pool_time
ON request_logs(provider_type, pool_id, created_at DESC);

-- 3. 索引：is_success（用于筛选成功/失败的请求）
CREATE INDEX idx_request_logs_success
ON request_logs(is_success);

-- 4. 复合索引：provider_uuid + is_success（用于统计查询）
CREATE INDEX idx_request_logs_provider_success
ON request_logs(provider_uuid, is_success);

-- 5. 索引：created_at（用于时间范围查询和清理旧日志）
CREATE INDEX idx_request_logs_created_at
ON request_logs(created_at DESC);

-- ============================================
-- provider_pools 表索引优化
-- ============================================

-- 1. 复合索引：provider_type + is_default（用于查找默认池）
CREATE INDEX idx_provider_pools_type_default
ON provider_pools(provider_type, is_default);

-- 2. 索引：provider_type（用于按类型查询池子）
CREATE INDEX idx_provider_pools_type
ON provider_pools(provider_type);

-- ============================================
-- oauth_credentials 表索引优化
-- ============================================
-- 注意：oauth_credentials 表没有 is_deleted 字段

-- 1. 索引：provider_type（用于按类型查询）
CREATE INDEX idx_oauth_credentials_type
ON oauth_credentials(provider_type);

-- 2. 索引：created_at（用于排序）
CREATE INDEX idx_oauth_credentials_created_at
ON oauth_credentials(created_at DESC);

-- 3. 复合索引：provider_type + is_used（用于查询可用凭据）
CREATE INDEX idx_oauth_credentials_type_used
ON oauth_credentials(provider_type, is_used);

-- ============================================
-- 表分析和优化命令
-- ============================================

-- 分析表以更新统计信息（提升查询优化器性能）
ANALYZE TABLE providers;
ANALYZE TABLE request_logs;
ANALYZE TABLE provider_pools;
ANALYZE TABLE oauth_credentials;

-- 优化表（整理碎片，重建索引）
OPTIMIZE TABLE providers;
OPTIMIZE TABLE request_logs;
OPTIMIZE TABLE provider_pools;
OPTIMIZE TABLE oauth_credentials;
