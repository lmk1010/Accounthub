-- 坏号记录表 (bad_accounts)
-- 用于记录被检测为坏号的账号，与pool_id绑定

CREATE TABLE IF NOT EXISTS bad_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    provider_uuid VARCHAR(64) DEFAULT NULL COMMENT '原提供商UUID',
    oauth_credential_id INT DEFAULT NULL COMMENT 'OAuth凭据ID',
    display_name VARCHAR(255) DEFAULT NULL COMMENT '显示名称(邮箱等)',
    error_type VARCHAR(64) NOT NULL COMMENT '错误类型: 403_forbidden, 429_rate_limit, quota_exceeded, auth_failed, etc',
    error_message TEXT DEFAULT NULL COMMENT '错误信息',
    error_code INT DEFAULT NULL COMMENT '错误状态码',
    detection_source VARCHAR(64) DEFAULT 'kiro' COMMENT '检测来源: kiro, gemini, codex',
    credentials_snapshot JSON DEFAULT NULL COMMENT '凭据快照(脱敏)',
    metadata JSON DEFAULT NULL COMMENT '额外元数据',
    is_recoverable BOOLEAN DEFAULT FALSE COMMENT '是否可恢复',
    recovery_time DATETIME DEFAULT NULL COMMENT '预计恢复时间',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
    INDEX idx_provider_type (provider_type),
    INDEX idx_pool_id (pool_id),
    INDEX idx_error_type (error_type),
    INDEX idx_detection_source (detection_source),
    INDEX idx_created_at (created_at),
    INDEX idx_type_pool (provider_type, pool_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坏号记录表';
