# 配置迁移指南

## 背景

旧版本将所有配置存储在 `app_config` 的单个JSON字段中。新版本将配置拆分为独立的键值对，以提高可维护性和查询效率。

## 迁移前后对比

### 迁移前（旧格式）
```
meta_key: app_config
meta_value: {"REQUIRED_API_KEY":"123456","SERVER_PORT":3000,"HOST":"0.0.0.0",...}
```

### 迁移后（新格式）
```
meta_key: REQUIRED_API_KEY
meta_value: 123456

meta_key: SERVER_PORT
meta_value: 3000

meta_key: HOST
meta_value: 0.0.0.0
...
```

## 迁移步骤

### 1. 备份数据库
```bash
# 连接到线上服务器
ssh -p 22080 root@YOUR_SERVER_IP

# 备份数据库
docker exec paddyai-mysql mysqldump -u root -p aiclient app_meta > app_meta_backup_$(date +%Y%m%d).sql
```

### 2. 运行迁移脚本

在后端项目目录下运行：

```bash
cd backend
npm run migrate:config
```

### 3. 验证迁移结果

迁移脚本会显示：
- 成功迁移的配置项数量
- 跳过的已存在配置项

检查数据库：
```sql
SELECT meta_key FROM app_meta ORDER BY meta_key;
```

应该看到所有独立的配置键（REQUIRED_API_KEY, SERVER_PORT等）

## 注意事项

1. **安全性**：迁移脚本不会删除原有的 `app_config`，保持向后兼容
2. **幂等性**：可以安全地多次运行，已存在的键不会被覆盖
3. **新代码优先读取独立键**：如果独立键存在，将优先使用；否则回退到 `app_config`

## 回滚

如果需要回滚到旧格式：

```sql
-- 删除独立的配置键
DELETE FROM app_meta WHERE meta_key IN (
  'REQUIRED_API_KEY', 'SERVER_PORT', 'HOST', 'MODEL_PROVIDER',
  'SYSTEM_PROMPT_MODE', 'PROXY_URL', 'PROXY_ENABLED_PROVIDERS',
  'OAUTH_CALLBACK_HOST', 'PROMPT_LOG_BASE_NAME', 'PROMPT_LOG_MODE',
  'REQUEST_MAX_RETRIES', 'REQUEST_BASE_DELAY', 'CREDENTIAL_SWITCH_MAX_RETRIES',
  'CRON_NEAR_MINUTES', 'CRON_REFRESH_TOKEN', 'MAX_ERROR_COUNT',
  'providerFallbackChain', 'modelFallbackMapping'
);

-- app_config 仍然保留，旧代码可以继续使用
```

## 迁移的配置项

- REQUIRED_API_KEY
- SERVER_PORT
- HOST
- MODEL_PROVIDER
- SYSTEM_PROMPT_MODE
- PROXY_URL
- PROXY_ENABLED_PROVIDERS
- OAUTH_CALLBACK_HOST
- PROMPT_LOG_BASE_NAME
- PROMPT_LOG_MODE
- REQUEST_MAX_RETRIES
- REQUEST_BASE_DELAY
- CREDENTIAL_SWITCH_MAX_RETRIES
- CRON_NEAR_MINUTES
- CRON_REFRESH_TOKEN
- MAX_ERROR_COUNT
- providerFallbackChain
- modelFallbackMapping

## 新增表与字段：provider_pools / pool_id / provider_bindings.pool_id

用于池子分组与 token_id 绑定，避免并发请求窜号。请在数据库中执行：

```sql
-- 池子表
CREATE TABLE `provider_pools` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `provider_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '提供商类型',
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '池子名称',
  `is_default` tinyint(1) DEFAULT '0' COMMENT '是否默认池',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_provider_type` (`provider_type`),
  KEY `idx_provider_default` (`provider_type`,`is_default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号池子表';

-- providers 表新增 pool_id
ALTER TABLE `providers`
  ADD COLUMN `pool_id` bigint DEFAULT NULL COMMENT '池子ID' AFTER `provider_type`,
  ADD KEY `idx_pool_id` (`pool_id`);

-- provider_bindings 表（如已存在请先删除或按需调整索引）
CREATE TABLE `provider_bindings` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `provider_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '提供商类型',
  `token_id` bigint NOT NULL COMMENT '上游 token_id',
  `pool_id` bigint NOT NULL DEFAULT '0' COMMENT '池子ID（0表示默认池）',
  `provider_uuid` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '绑定的账号 uuid',
  `last_used` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后使用时间',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_provider_token` (`provider_type`,`token_id`,`pool_id`),
  KEY `idx_provider_uuid` (`provider_uuid`),
  KEY `idx_last_used` (`last_used`),
  KEY `idx_pool_id` (`pool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账号绑定表';
```

如 provider_bindings 已存在，可执行：
```sql
ALTER TABLE `provider_bindings`
  ADD COLUMN `pool_id` bigint NOT NULL DEFAULT '0' COMMENT '池子ID（0表示默认池）' AFTER `token_id`,
  DROP INDEX `uniq_provider_token`,
  ADD UNIQUE KEY `uniq_provider_token` (`provider_type`,`token_id`,`pool_id`),
  ADD KEY `idx_pool_id` (`pool_id`);
```
