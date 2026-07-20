CREATE TABLE IF NOT EXISTS provider_usage_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    usage_json JSON DEFAULT NULL COMMENT '归一化用量数据',
    usage_summary_json JSON DEFAULT NULL COMMENT '用量汇总',
    raw_usage_json JSON DEFAULT NULL COMMENT '原始用量数据',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_usage_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提供商用量明细缓存';
