-- 添加号池模型路由配置字段
ALTER TABLE provider_pools
ADD COLUMN supported_models JSON DEFAULT NULL COMMENT '支持的模型白名单',
ADD COLUMN not_supported_models JSON DEFAULT NULL COMMENT '不支持的模型黑名单';
