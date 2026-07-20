-- 号池模型路由功能迁移脚本
-- 为 provider_pools 表添加模型路由字段

ALTER TABLE provider_pools
ADD COLUMN supported_models JSON DEFAULT NULL COMMENT '支持的模型列表(白名单,为空表示支持所有)' AFTER is_default,
ADD COLUMN not_supported_models JSON DEFAULT NULL COMMENT '不支持的模型列表(黑名单)' AFTER supported_models;
