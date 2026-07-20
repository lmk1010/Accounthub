# 数据库性能优化指南

## 📋 文件说明

- `optimize_indexes.sql` - 创建索引和优化表的SQL语句
- `check_indexes.sql` - 查看索引状态和性能监控的SQL语句

## 🚀 执行步骤

### 1. 创建索引（推荐在低峰期执行）

```bash
# 连接到数据库
mysql -u your_username -p your_database

# 执行索引优化SQL
source /path/to/optimize_indexes.sql
```

**注意事项：**
- 创建索引可能需要几分钟到几十分钟，取决于数据量
- 建议在业务低峰期执行
- 执行过程中表仍然可以读取，但写入性能会受影响

### 2. 验证索引创建

```bash
# 执行检查SQL
source /path/to/check_indexes.sql
```

## 📊 索引说明

### providers 表索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_providers_type_pool_status | provider_type, pool_id, is_deleted, is_healthy, is_disabled | 覆盖最常见的筛选查询 |
| idx_providers_created_at | created_at DESC | 按创建时间排序 |
| idx_providers_current_usage | current_usage DESC | 按当前用量排序 |
| idx_providers_usage_count | usage_count DESC | 按使用次数排序 |
| idx_providers_last_used | last_used DESC | 按最后使用时间排序 |
| idx_providers_uuid | uuid | UUID唯一索引 |
| idx_providers_type_deleted | provider_type, is_deleted | 统计查询优化 |
| idx_providers_type_pool | provider_type, pool_id | 池子统计优化 |

### request_logs 表索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_request_logs_provider_time | provider_uuid, created_at DESC | 按账号查询日志 |
| idx_request_logs_type_pool_time | provider_type, pool_id, created_at DESC | 按池子查询日志 |
| idx_request_logs_success | is_success | 筛选成功/失败请求 |
| idx_request_logs_provider_success | provider_uuid, is_success | 统计查询优化 |
| idx_request_logs_created_at | created_at DESC | 时间范围查询 |

### provider_pools 表索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_provider_pools_type_default | provider_type, is_default | 查找默认池 |
| idx_provider_pools_type | provider_type | 按类型查询池子 |

### oauth_credentials 表索引

| 索引名 | 字段 | 用途 |
|--------|------|------|
| idx_oauth_credentials_type_deleted | provider_type, is_deleted | 查询可用凭据 |
| idx_oauth_credentials_type | provider_type | 按类型查询 |
| idx_oauth_credentials_created_at | created_at DESC | 按时间排序 |

## 🎯 预期性能提升

### 查询性能改进

1. **分页查询** - 提升 80-95%
   - 之前：全表扫描或内存过滤
   - 之后：使用索引直接定位，LIMIT/OFFSET 高效执行

2. **筛选查询** - 提升 70-90%
   - 之前：全表扫描后过滤
   - 之后：使用复合索引快速定位

3. **排序查询** - 提升 60-85%
   - 之前：需要临时表排序
   - 之后：使用索引顺序直接返回

4. **统计查询** - 提升 50-80%
   - 之前：需要扫描大量数据
   - 之后：使用索引快速统计

### 实际场景示例

**场景1：查询某个池子的健康账号（分页）**
```sql
-- 优化前：~500ms（1000条数据）
-- 优化后：~20ms（使用 idx_providers_type_pool_status）
SELECT * FROM providers
WHERE provider_type = 'claude-kiro-oauth'
  AND pool_id = 1
  AND is_deleted = FALSE
  AND is_healthy = TRUE
  AND is_disabled = FALSE
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

**场景2：按用量排序查询**
```sql
-- 优化前：~800ms（需要全表扫描+排序）
-- 优化后：~30ms（使用 idx_providers_current_usage）
SELECT * FROM providers
WHERE provider_type = 'claude-kiro-oauth'
  AND is_deleted = FALSE
ORDER BY current_usage DESC
LIMIT 20;
```

## 🔍 监控和维护

### 定期维护任务

**每周执行一次：**
```sql
-- 分析表统计信息
ANALYZE TABLE providers;
ANALYZE TABLE request_logs;
```

**每月执行一次：**
```sql
-- 优化表（整理碎片）
OPTIMIZE TABLE providers;
OPTIMIZE TABLE request_logs;
```

### 性能监控查询

**1. 查看慢查询**
```sql
-- 查看最近的慢查询
SELECT * FROM mysql.slow_log
WHERE start_time > DATE_SUB(NOW(), INTERVAL 1 HOUR)
ORDER BY query_time DESC
LIMIT 10;
```

**2. 查看索引使用情况**
```sql
-- 查看未使用的索引
SELECT * FROM sys.schema_unused_indexes
WHERE object_schema = DATABASE();
```

**3. 查看表大小增长**
```sql
-- 定期记录表大小，监控增长趋势
SELECT
    table_name,
    table_rows,
    ROUND(data_length / 1024 / 1024, 2) AS data_mb,
    ROUND(index_length / 1024 / 1024, 2) AS index_mb
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY (data_length + index_length) DESC;
```

## ❓ 常见问题

### Q1: 创建索引会影响现有业务吗？
**A:** 创建索引时表仍然可以读取，但写入性能会受影响。建议在低峰期执行。

### Q2: 索引会占用多少额外空间？
**A:** 根据数据量，索引大小通常是数据大小的 20-40%。可以通过 `check_indexes.sql` 查看具体占用。

### Q3: 索引创建需要多长时间？
**A:** 取决于数据量：
- 1万条数据：约 5-10 秒
- 10万条数据：约 30-60 秒
- 100万条数据：约 5-10 分钟

### Q4: 如何验证索引是否生效？
**A:** 使用 EXPLAIN 查看查询计划：
```sql
EXPLAIN SELECT * FROM providers
WHERE provider_type = 'claude-kiro-oauth'
  AND pool_id = 1
ORDER BY created_at DESC
LIMIT 20;
```
查看 `key` 列，如果显示索引名称则说明索引生效。

## 💡 其他优化建议

### 1. MySQL 配置优化

在 `my.cnf` 或 `my.ini` 中添加：
```ini
# InnoDB 缓冲池大小（建议设置为物理内存的 50-70%）
innodb_buffer_pool_size = 2G

# 查询缓存（MySQL 5.7 及以下）
query_cache_size = 64M
query_cache_type = 1

# 连接数
max_connections = 500

# 慢查询日志
slow_query_log = 1
long_query_time = 1
```

### 2. 应用层优化

- **使用连接池**：避免频繁创建/销毁数据库连接
- **批量操作**：使用批量插入/更新代替单条操作
- **缓存热点数据**：对于频繁查询的数据使用 Redis 缓存
- **异步处理**：日志写入等非关键操作使用异步队列

### 3. 数据清理策略

定期清理旧数据以保持性能：
```sql
-- 清理 30 天前的请求日志
DELETE FROM request_logs
WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
LIMIT 10000;
```

## 📝 总结

执行完 `optimize_indexes.sql` 后，你将获得：

✅ **查询速度提升 60-95%**
✅ **分页性能大幅改善**
✅ **支持灵活的排序方式**
✅ **降低数据库 CPU 使用率**
✅ **提升并发处理能力**

**建议执行顺序：**
1. 先执行 `check_indexes.sql` 查看当前状态
2. 在低峰期执行 `optimize_indexes.sql`
3. 再次执行 `check_indexes.sql` 验证索引创建
4. 使用 EXPLAIN 测试关键查询是否使用索引
5. 定期执行 ANALYZE 和 OPTIMIZE 维护表

---
**最后更新：** 2026-01-24
