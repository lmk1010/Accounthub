-- 代理池集成迁移脚本
-- 1. 给provider_pools表添加use_proxy字段
ALTER TABLE provider_pools
ADD COLUMN use_proxy BOOLEAN DEFAULT FALSE COMMENT '是否使用代理池'
AFTER is_default;
