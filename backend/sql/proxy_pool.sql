-- 代理池数据库表结构
-- 生成时间: 2026-01-23

-- ============================================
-- 1. 代理厂商表 (proxy_providers)
-- ============================================
CREATE TABLE IF NOT EXISTS proxy_providers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(128) NOT NULL COMMENT '厂商名称',
    type VARCHAR(32) NOT NULL COMMENT '厂商类型: ipmars/custom/clash/trojan',
    api_url VARCHAR(512) DEFAULT NULL COMMENT 'API地址',
    api_key VARCHAR(512) DEFAULT NULL COMMENT 'API密钥',
    username VARCHAR(255) DEFAULT NULL COMMENT '用户名',
    password VARCHAR(255) DEFAULT NULL COMMENT '密码',
    config JSON DEFAULT NULL COMMENT '额外配置(JSON)',
    is_enabled BOOLEAN DEFAULT TRUE COMMENT '是否启用',
    fetch_interval INT DEFAULT 300 COMMENT '节点刷新间隔(秒)',
    last_fetch_time DATETIME DEFAULT NULL COMMENT '最后获取时间',
    last_fetch_error TEXT DEFAULT NULL COMMENT '最后获取错误',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_type (type),
    INDEX idx_is_enabled (is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='代理厂商表';

-- ============================================
-- 2. 代理节点表 (proxy_nodes)
-- ============================================
CREATE TABLE IF NOT EXISTS proxy_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_id INT DEFAULT NULL COMMENT '所属厂商ID(NULL表示手动添加)',
    name VARCHAR(128) NOT NULL COMMENT '节点名称',
    protocol VARCHAR(32) NOT NULL COMMENT '协议: http/https/socks5/clash/trojan',
    host VARCHAR(255) NOT NULL COMMENT '主机地址',
    port INT NOT NULL COMMENT '端口',
    username VARCHAR(255) DEFAULT NULL COMMENT '用户名',
    password VARCHAR(512) DEFAULT NULL COMMENT '密码',
    config JSON DEFAULT NULL COMMENT '额外配置(trojan密码等)',
    is_enabled BOOLEAN DEFAULT TRUE COMMENT '是否启用',
    is_healthy BOOLEAN DEFAULT TRUE COMMENT '是否健康',
    priority INT DEFAULT 0 COMMENT '优先级(越大越优先)',
    success_count INT DEFAULT 0 COMMENT '成功次数',
    fail_count INT DEFAULT 0 COMMENT '失败次数',
    avg_latency INT DEFAULT NULL COMMENT '平均延迟(ms)',
    last_used DATETIME DEFAULT NULL COMMENT '最后使用时间',
    last_check_time DATETIME DEFAULT NULL COMMENT '最后检测时间',
    last_error TEXT DEFAULT NULL COMMENT '最后错误信息',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_provider_id (provider_id),
    INDEX idx_protocol (protocol),
    INDEX idx_is_enabled (is_enabled),
    INDEX idx_is_healthy (is_healthy),
    INDEX idx_priority (priority DESC),
    FOREIGN KEY (provider_id) REFERENCES proxy_providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='代理节点表';

-- ============================================
-- 3. 代理使用记录表 (proxy_usage_logs)
-- ============================================
CREATE TABLE IF NOT EXISTS proxy_usage_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    node_id INT NOT NULL COMMENT '节点ID',
    provider_uuid VARCHAR(64) DEFAULT NULL COMMENT '使用的账号UUID',
    target_host VARCHAR(255) DEFAULT NULL COMMENT '目标主机',
    latency INT DEFAULT NULL COMMENT '延迟(ms)',
    is_success BOOLEAN DEFAULT TRUE COMMENT '是否成功',
    error_message TEXT DEFAULT NULL COMMENT '错误信息',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_node_id (node_id),
    INDEX idx_created_at (created_at),
    INDEX idx_is_success (is_success)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='代理使用记录表';
