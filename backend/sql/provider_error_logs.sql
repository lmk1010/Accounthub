-- 账号错误历史表
-- 记录每个账号的所有请求错误历史

CREATE TABLE IF NOT EXISTS provider_error_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    request_model VARCHAR(128) DEFAULT NULL COMMENT '请求模型',
    error_code INT DEFAULT NULL COMMENT '错误状态码',
    error_type VARCHAR(64) DEFAULT NULL COMMENT '错误类型',
    error_message TEXT DEFAULT NULL COMMENT '错误信息',
    request_id VARCHAR(64) DEFAULT NULL COMMENT '请求ID',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
    INDEX idx_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_pool_id (pool_id),
    INDEX idx_error_code (error_code),
    INDEX idx_created_at (created_at),
    INDEX idx_uuid_created (provider_uuid, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号错误历史表';
