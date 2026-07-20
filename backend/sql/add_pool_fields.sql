-- 添加号池启用/禁用和策略字段
ALTER TABLE provider_pools
ADD COLUMN is_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
ADD COLUMN strategy VARCHAR(32) NOT NULL DEFAULT 'round-robin' COMMENT '路由策略: round-robin, random, least-used';


