-- 添加 Kiro 用量信息字段到 providers 表
-- 用于存储订阅等级、额度、重置时间等信息

ALTER TABLE providers
ADD COLUMN subscription_title VARCHAR(64) DEFAULT NULL COMMENT '订阅等级(KIRO FREE/KIRO PRO等)',
ADD COLUMN usage_limit DECIMAL(20, 4) DEFAULT NULL COMMENT '额度上限',
ADD COLUMN current_usage DECIMAL(20, 4) DEFAULT NULL COMMENT '当前使用量',
ADD COLUMN next_reset_time DATETIME DEFAULT NULL COMMENT '下次重置时间',
ADD COLUMN free_trial_expiry DATETIME DEFAULT NULL COMMENT '免费试用到期时间',
ADD COLUMN usage_info_updated_at DATETIME DEFAULT NULL COMMENT '用量信息更新时间';
