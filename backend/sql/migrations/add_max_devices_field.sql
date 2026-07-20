-- 添加 max_devices 字段到 providers 表
-- 用于控制每个账号最多支持几个设备槽位，避免 Kiro 风控

ALTER TABLE providers
ADD COLUMN max_devices INT DEFAULT 3 COMMENT '最大设备数(用于隔离用户上下文)';
