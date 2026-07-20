-- 添加 credit_usage 字段到 request_logs 表
-- 用于记录 Kiro 等提供商返回的 credit 消耗

ALTER TABLE request_logs
ADD COLUMN credit_usage DECIMAL(20, 10) DEFAULT NULL COMMENT 'Credit消耗(Kiro等提供商)'
AFTER output_tokens;
