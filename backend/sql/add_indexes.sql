-- 添加复合索引优化分页查询性能
-- 执行时间: 2026-01-22

-- 优化 provider_type + created_at DESC 排序查询
ALTER TABLE providers
ADD INDEX idx_type_created (provider_type, created_at DESC);

-- 优化 provider_type + pool_id + created_at DESC 排序查询
ALTER TABLE providers
ADD INDEX idx_type_pool_created (provider_type, pool_id, created_at DESC);

-- 邮箱关联字段
ALTER TABLE outlook_emails
ADD COLUMN linked_provider_type VARCHAR(64) DEFAULT NULL COMMENT '关联的提供商类型' AFTER usage_count,
ADD COLUMN linked_provider_uuid VARCHAR(64) DEFAULT NULL COMMENT '关联的提供商UUID' AFTER linked_provider_type,
ADD COLUMN linked_credential_id INT DEFAULT NULL COMMENT '关联的OAuth凭据ID' AFTER linked_provider_uuid,
ADD INDEX idx_linked_provider (linked_provider_type);
