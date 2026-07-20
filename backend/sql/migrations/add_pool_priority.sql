-- 添加池子优先级字段
-- priority 值越小优先级越高，默认为 100

ALTER TABLE provider_pools
ADD COLUMN priority INT NOT NULL DEFAULT 100 COMMENT '优先级(值越小优先级越高)' AFTER strategy;

-- 添加索引以支持按优先级排序
CREATE INDEX idx_priority ON provider_pools (provider_type, priority);
