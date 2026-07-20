-- Outlook邮箱管理表
-- 用于存储Outlook OAuth邮箱信息

CREATE TABLE IF NOT EXISTS outlook_emails (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱地址',
    password VARCHAR(255) DEFAULT NULL COMMENT '邮箱密码',
    client_id VARCHAR(255) NOT NULL COMMENT 'OAuth Client ID',
    refresh_token TEXT NOT NULL COMMENT 'OAuth Refresh Token',
    access_token TEXT DEFAULT NULL COMMENT 'OAuth Access Token',
    token_expires_at DATETIME DEFAULT NULL COMMENT 'Token过期时间',
    display_name VARCHAR(255) DEFAULT NULL COMMENT '显示名称',
    status ENUM('active', 'disabled', 'error') DEFAULT 'active' COMMENT '状态',
    last_error TEXT DEFAULT NULL COMMENT '最后错误信息',
    last_used_at DATETIME DEFAULT NULL COMMENT '最后使用时间',
    usage_count INT DEFAULT 0 COMMENT '使用次数',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_status (status),
    INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Outlook邮箱管理表';
