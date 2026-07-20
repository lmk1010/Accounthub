-- 添加池子级别健康检测开关
ALTER TABLE provider_pools
ADD COLUMN enable_health_check TINYINT(1) DEFAULT 1 COMMENT '是否启用健康检测(1=启用,0=禁用)' AFTER not_supported_models;
