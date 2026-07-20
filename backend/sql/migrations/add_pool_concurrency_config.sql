-- 添加号池并发控制配置字段
-- 1. user_max_concurrency: 同一用户最大并发数（0=不限制）
-- 2. account_max_concurrency: 单账号最大并发数（0=不限制）
-- 3. enable_user_concurrency_limit: 是否启用用户并发限制
-- 4. enable_account_concurrency_limit: 是否启用账号并发限制（超过不分配）

ALTER TABLE provider_pools
ADD COLUMN user_max_concurrency INT DEFAULT 0 COMMENT '同一用户最大并发数(0=不限制)' AFTER not_supported_models,
ADD COLUMN account_max_concurrency INT DEFAULT 0 COMMENT '单账号最大并发数(0=不限制)' AFTER user_max_concurrency,
ADD COLUMN enable_user_concurrency_limit TINYINT(1) DEFAULT 0 COMMENT '是否启用用户并发限制' AFTER account_max_concurrency,
ADD COLUMN enable_account_concurrency_limit TINYINT(1) DEFAULT 0 COMMENT '是否启用账号并发限制' AFTER enable_user_concurrency_limit;
