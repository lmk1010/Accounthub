-- 添加代理商（provider）独立并发控制配置字段
-- 代理商通过 x-accounthub-user-type: provider 标识，按 key(tokenId) 和 账号 分别限制并发
-- 1. provider_max_concurrency: 代理商按key最大并发数（0=不限制）
-- 2. provider_account_max_concurrency: 代理商单账号最大并发数（0=不限制）
-- 3. enable_provider_concurrency_limit: 是否启用代理商key并发限制
-- 4. enable_provider_account_concurrency_limit: 是否启用代理商账号并发限制

ALTER TABLE provider_pools
ADD COLUMN provider_max_concurrency INT DEFAULT 0 COMMENT '代理商按key最大并发数(0=不限制)' AFTER enable_account_concurrency_limit,
ADD COLUMN provider_account_max_concurrency INT DEFAULT 0 COMMENT '代理商单账号最大并发数(0=不限制)' AFTER provider_max_concurrency,
ADD COLUMN enable_provider_concurrency_limit TINYINT(1) DEFAULT 0 COMMENT '是否启用代理商key并发限制' AFTER provider_account_max_concurrency,
ADD COLUMN enable_provider_account_concurrency_limit TINYINT(1) DEFAULT 0 COMMENT '是否启用代理商账号并发限制' AFTER enable_provider_concurrency_limit;
