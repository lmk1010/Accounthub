-- AccountHub 完整数据库表结构
-- 生成时间: 2026-01-22

-- ============================================
-- 1. 提供商表 (providers)
-- ============================================
CREATE TABLE IF NOT EXISTS providers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid VARCHAR(64) NOT NULL UNIQUE COMMENT '唯一标识',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    custom_name VARCHAR(255) DEFAULT NULL COMMENT '自定义名称',
    oauth_credential_id INT DEFAULT NULL COMMENT 'OAuth凭据ID',
    credentials JSON COMMENT '凭据信息(JSON)',
    is_healthy BOOLEAN DEFAULT TRUE COMMENT '是否健康',
    is_disabled BOOLEAN DEFAULT FALSE COMMENT '是否禁用',
    is_deleted BOOLEAN DEFAULT FALSE COMMENT '是否已删除',
    usage_count INT DEFAULT 0 COMMENT '使用次数',
    error_count INT DEFAULT 0 COMMENT '错误次数',
    last_used DATETIME DEFAULT NULL COMMENT '最后使用时间',
    last_error_time DATETIME DEFAULT NULL COMMENT '最后错误时间',
    last_error_message TEXT DEFAULT NULL COMMENT '最后错误信息',
    last_health_check_time DATETIME DEFAULT NULL COMMENT '最后健康检查时间',
    scheduled_recovery_time DATETIME DEFAULT NULL COMMENT '计划恢复时间',
    check_health BOOLEAN DEFAULT TRUE COMMENT '是否检查健康',
    check_model_name VARCHAR(128) DEFAULT NULL COMMENT '检测模型名称',
    last_health_check_model VARCHAR(128) DEFAULT NULL COMMENT '最后检测使用的模型',
    not_supported_models JSON DEFAULT NULL COMMENT '不支持的模型列表',
    subscription_title VARCHAR(64) DEFAULT NULL COMMENT '订阅等级(KIRO FREE/KIRO PRO等)',
    usage_limit DECIMAL(20, 4) DEFAULT NULL COMMENT '额度上限',
    current_usage DECIMAL(20, 4) DEFAULT NULL COMMENT '当前使用量',
    next_reset_time DATETIME DEFAULT NULL COMMENT '下次重置时间',
    free_trial_expiry DATETIME DEFAULT NULL COMMENT '免费试用到期时间',
    usage_info_updated_at DATETIME DEFAULT NULL COMMENT '用量信息更新时间',
    available_models JSON DEFAULT NULL COMMENT '可用模型列表(从API获取)',
    max_devices INT DEFAULT 3 COMMENT '最大设备数(用于隔离用户上下文)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_provider_type (provider_type),
    INDEX idx_pool_id (pool_id),
    INDEX idx_is_healthy (is_healthy),
    INDEX idx_is_disabled (is_disabled),
    INDEX idx_type_created (provider_type, created_at DESC),
    INDEX idx_type_pool_created (provider_type, pool_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提供商账号表';

-- ============================================
-- 2. 提供商用量明细表 (provider_usage_details)
-- ============================================
CREATE TABLE IF NOT EXISTS provider_usage_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    usage_json JSON DEFAULT NULL COMMENT '归一化用量数据',
    usage_summary_json JSON DEFAULT NULL COMMENT '用量汇总',
    raw_usage_json JSON DEFAULT NULL COMMENT '原始用量数据',
    image_usage_json JSON DEFAULT NULL COMMENT '图片额度归一化数据',
    image_usage_summary_json JSON DEFAULT NULL COMMENT '图片额度汇总',
    raw_image_usage_json JSON DEFAULT NULL COMMENT '图片额度原始数据',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_usage_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提供商用量明细缓存';

-- ============================================
-- 3. 提供商池子表 (provider_pools)
-- ============================================
CREATE TABLE IF NOT EXISTS provider_pools (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    name VARCHAR(128) NOT NULL COMMENT '池子名称',
    is_default BOOLEAN DEFAULT FALSE COMMENT '是否默认池',
    is_enabled BOOLEAN DEFAULT TRUE COMMENT '是否启用',
    use_proxy BOOLEAN DEFAULT FALSE COMMENT '是否使用代理池',
    strategy VARCHAR(32) NOT NULL DEFAULT 'round-robin' COMMENT '路由策略: round-robin, random, least-used',
    supported_models JSON DEFAULT NULL COMMENT '支持的模型列表(白名单,为空表示支持所有)',
    not_supported_models JSON DEFAULT NULL COMMENT '不支持的模型列表(黑名单)',
    enable_health_check BOOLEAN DEFAULT TRUE COMMENT '是否启用健康检测',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_provider_type (provider_type),
    INDEX idx_is_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提供商池子表';

-- ============================================
-- 3. OAuth凭据表 (oauth_credentials)
-- ============================================
CREATE TABLE IF NOT EXISTS oauth_credentials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    credential_type VARCHAR(64) DEFAULT NULL COMMENT '凭据类型',
    credentials JSON COMMENT '凭据信息',
    display_name VARCHAR(255) DEFAULT NULL COMMENT '显示名称',
    email VARCHAR(255) DEFAULT NULL COMMENT '用户邮箱',
    subscription_tier VARCHAR(20) DEFAULT NULL COMMENT '订阅等级',
    pool_id INT DEFAULT NULL COMMENT '目标号池ID',
    source VARCHAR(50) DEFAULT NULL COMMENT '来源',
    metadata JSON DEFAULT NULL COMMENT '元数据',
    is_used BOOLEAN DEFAULT FALSE COMMENT '是否已使用',
    used_by_uuid VARCHAR(64) DEFAULT NULL COMMENT '使用者UUID',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_provider_type (provider_type),
    INDEX idx_is_used (is_used),
    INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='OAuth凭据表';

-- ============================================
-- 4. 提供商绑定表 (provider_bindings)
-- ============================================
CREATE TABLE IF NOT EXISTS provider_bindings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(128) NOT NULL COMMENT 'API Key',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_api_provider (api_key, provider_type),
    INDEX idx_provider_uuid (provider_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提供商绑定表';

-- ============================================
-- 5. 全局统计表 (global_stats)
-- ============================================
CREATE TABLE IF NOT EXISTS global_stats (
    id INT PRIMARY KEY DEFAULT 1,
    total_requests BIGINT DEFAULT 0 COMMENT '总请求数',
    successful_requests BIGINT DEFAULT 0 COMMENT '成功请求数',
    failed_requests BIGINT DEFAULT 0 COMMENT '失败请求数',
    switch_count BIGINT DEFAULT 0 COMMENT '切换次数',
    last_reset_time DATETIME DEFAULT NULL COMMENT '最后重置时间',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全局统计表';

-- ============================================
-- 6. 错误历史表 (error_history)
-- ============================================
CREATE TABLE IF NOT EXISTS error_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL,
    provider_uuid VARCHAR(64) DEFAULT NULL,
    error_type VARCHAR(64) DEFAULT NULL,
    error_message TEXT,
    request_model VARCHAR(128) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_provider_type (provider_type),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='错误历史表';

-- ============================================
-- 7. 消费统计表 (consumption_stats)
-- ============================================
CREATE TABLE IF NOT EXISTS consumption_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL UNIQUE,
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    total_cost DECIMAL(10,4) DEFAULT 0,
    request_count INT DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='消费统计表';

-- ============================================
-- 8. 消费元数据表 (consumption_meta)
-- ============================================
CREATE TABLE IF NOT EXISTS consumption_meta (
    id INT PRIMARY KEY DEFAULT 1,
    start_time DATETIME DEFAULT NULL,
    last_update_time DATETIME DEFAULT NULL,
    last_sync_time DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='消费元数据表';

-- ============================================
-- 9. 应用元数据表 (app_meta)
-- ============================================
CREATE TABLE IF NOT EXISTS app_meta (
    meta_key VARCHAR(128) PRIMARY KEY,
    meta_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='应用元数据表';

-- ============================================
-- 10. 认证令牌表 (auth_tokens)
-- ============================================
CREATE TABLE IF NOT EXISTS auth_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(128) NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiry_time DATETIME NOT NULL,
    INDEX idx_token (token),
    INDEX idx_expiry (expiry_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='认证令牌表';

-- ============================================
-- 11. API Potluck 配置表 (api_potluck_config)
-- ============================================
CREATE TABLE IF NOT EXISTS api_potluck_config (
    id INT PRIMARY KEY DEFAULT 1,
    enabled BOOLEAN DEFAULT FALSE,
    max_users INT DEFAULT 100,
    default_quota INT DEFAULT 1000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='API Potluck配置表';

-- ============================================
-- 12. API Potluck 用户表 (api_potluck_users)
-- ============================================
CREATE TABLE IF NOT EXISTS api_potluck_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(128) NOT NULL UNIQUE,
    quota INT DEFAULT 1000,
    used_quota INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_api_key (api_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='API Potluck用户表';

-- ============================================
-- 13. API Potluck 用户凭据表 (api_potluck_user_credentials)
-- ============================================
CREATE TABLE IF NOT EXISTS api_potluck_user_credentials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(128) NOT NULL,
    credential_id INT NOT NULL,
    credential_path VARCHAR(255) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_api_credential (api_key, credential_id),
    INDEX idx_api_key (api_key),
    INDEX idx_credential_path (credential_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='API Potluck用户凭据表';

-- ============================================
-- 14. API Potluck 凭据奖励表 (api_potluck_credential_bonuses)
-- ============================================
CREATE TABLE IF NOT EXISTS api_potluck_credential_bonuses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(128) NOT NULL,
    credential_id INT NOT NULL,
    bonus_quota INT DEFAULT 0,
    used_count INT DEFAULT 0,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_api_credential (api_key, credential_id),
    INDEX idx_api_key (api_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='API Potluck凭据奖励表';

-- ============================================
-- 15. Outlook邮箱管理表 (outlook_emails)
-- ============================================
CREATE TABLE IF NOT EXISTS outlook_emails (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱地址',
    password VARCHAR(255) DEFAULT NULL COMMENT '邮箱密码',
    auth_type ENUM('oauth2', 'password') DEFAULT 'oauth2' COMMENT '认证方式',
    client_id VARCHAR(255) DEFAULT NULL COMMENT 'OAuth Client ID',
    refresh_token TEXT DEFAULT NULL COMMENT 'OAuth Refresh Token',
    access_token TEXT DEFAULT NULL COMMENT 'OAuth Access Token',
    token_expires_at DATETIME DEFAULT NULL COMMENT 'Token过期时间',
    display_name VARCHAR(255) DEFAULT NULL COMMENT '显示名称',
    status ENUM('active', 'disabled', 'error') DEFAULT 'active' COMMENT '状态',
    last_error TEXT DEFAULT NULL COMMENT '最后错误信息',
    last_used_at DATETIME DEFAULT NULL COMMENT '最后使用时间',
    usage_count INT DEFAULT 0 COMMENT '使用次数',
    linked_provider_type VARCHAR(64) DEFAULT NULL COMMENT '关联的提供商类型',
    linked_provider_uuid VARCHAR(64) DEFAULT NULL COMMENT '关联的提供商UUID',
    linked_credential_id INT DEFAULT NULL COMMENT '关联的OAuth凭据ID',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_email (email),
    INDEX idx_linked_provider (linked_provider_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Outlook邮箱管理表';

-- ============================================
-- 16. 坏号记录表 (bad_accounts)
-- ============================================
CREATE TABLE IF NOT EXISTS bad_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    provider_uuid VARCHAR(64) DEFAULT NULL COMMENT '原提供商UUID',
    oauth_credential_id INT DEFAULT NULL COMMENT 'OAuth凭据ID',
    display_name VARCHAR(255) DEFAULT NULL COMMENT '显示名称',
    error_type VARCHAR(64) NOT NULL COMMENT '错误类型',
    error_message TEXT DEFAULT NULL COMMENT '错误信息',
    error_code INT DEFAULT NULL COMMENT '错误状态码',
    detection_source VARCHAR(64) DEFAULT 'kiro' COMMENT '检测来源',
    credentials_snapshot JSON DEFAULT NULL COMMENT '凭据快照',
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

-- ============================================
-- 17. 请求日志表 (request_logs)
-- ============================================
CREATE TABLE IF NOT EXISTS request_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    provider_uuid VARCHAR(64) NOT NULL COMMENT '提供商UUID',
    provider_type VARCHAR(64) NOT NULL COMMENT '提供商类型',
    pool_id INT DEFAULT 0 COMMENT '所属池子ID',
    request_model VARCHAR(128) DEFAULT NULL COMMENT '请求模型',
    status_code INT DEFAULT NULL COMMENT 'HTTP状态码',
    is_success BOOLEAN DEFAULT TRUE COMMENT '是否成功',
    error_type VARCHAR(64) DEFAULT NULL COMMENT '错误类型',
    error_message TEXT DEFAULT NULL COMMENT '错误信息',
    error_stack TEXT DEFAULT NULL COMMENT '错误堆栈',
    error_detail TEXT DEFAULT NULL COMMENT '错误详情',
    request_id VARCHAR(64) DEFAULT NULL COMMENT '请求ID',
    input_tokens INT DEFAULT 0 COMMENT '输入Token数',
    output_tokens INT DEFAULT 0 COMMENT '输出Token数',
    credit_usage DECIMAL(20, 10) DEFAULT NULL COMMENT 'Credit消耗(Kiro等提供商)',
    duration_ms INT DEFAULT 0 COMMENT '请求耗时(毫秒)',
    client_ip VARCHAR(64) DEFAULT NULL COMMENT '客户端IP',
    user_agent VARCHAR(255) DEFAULT NULL COMMENT 'User-Agent',
    client_token_id VARCHAR(128) DEFAULT NULL COMMENT '调用端Token ID',
    user_id VARCHAR(64) DEFAULT NULL COMMENT '调用端User ID',
    user_email VARCHAR(128) DEFAULT NULL COMMENT '调用端User Email',
    username VARCHAR(128) DEFAULT NULL COMMENT '调用端Username',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
    INDEX idx_provider_uuid (provider_uuid),
    INDEX idx_provider_type (provider_type),
    INDEX idx_pool_id (pool_id),
    INDEX idx_is_success (is_success),
    INDEX idx_status_code (status_code),
    INDEX idx_created_at (created_at),
    INDEX idx_uuid_created (provider_uuid, created_at DESC),
    INDEX idx_pool_created (pool_id, created_at DESC),
    INDEX idx_type_pool_created (provider_type, pool_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='请求日志表';

-- ============================================
-- 18. 账号错误历史表 (provider_error_logs)
-- ============================================
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

-- ============================================
-- 19. 账号状态流转记录表 (provider_status_logs)
-- ============================================
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

-- ============================================
-- 20. 渠道配置表 (channel_configs)
-- ============================================
CREATE TABLE IF NOT EXISTS channel_configs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_type VARCHAR(64) NOT NULL UNIQUE COMMENT '渠道类型',
    default_model VARCHAR(128) DEFAULT NULL COMMENT '默认模型',
    config JSON DEFAULT NULL COMMENT '其他配置(JSON)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='渠道配置表';
