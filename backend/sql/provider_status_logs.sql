-- 账号状态流转记录表

CREATE TABLE IF NOT EXISTS provider_status_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    action VARCHAR(64) NOT NULL COMMENT '动作: mark_unhealthy/mark_deleted/reset_health/enable/disable等',
    from_status VARCHAR(32) DEFAULT NULL COMMENT '变更前状态',
    to_status VARCHAR(32) DEFAULT NULL COMMENT '变更后状态',
    reason TEXT DEFAULT NULL COMMENT '原因',
    source VARCHAR(64) DEFAULT NULL COMMENT '来源: manual/system/health_check等',
    metadata JSON DEFAULT NULL COMMENT '扩展信息',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
    INDEX idx_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_pool_id (pool_id),
    INDEX idx_created_at (created_at),
    INDEX idx_uuid_created (provider_uuid, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号状态流转记录表';
