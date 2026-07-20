-- ============================================
-- 账号 Token 使用统计表
-- ============================================
CREATE TABLE IF NOT EXISTS provider_token_stats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    model VARCHAR(128) NOT NULL COMMENT '模型名称（"_total" 表示总计）',
    input_tokens BIGINT DEFAULT 0 COMMENT '输入Token总数',
    output_tokens BIGINT DEFAULT 0 COMMENT '输出Token总数',
    total_tokens BIGINT DEFAULT 0 COMMENT '总Token数（输入+输出）',
    request_count INT DEFAULT 0 COMMENT '请求次数',
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    UNIQUE KEY uk_provider_model (provider_uuid, model),
    INDEX idx_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_model (model),
    INDEX idx_last_updated (last_updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号Token使用统计表';
