-- ============================================
-- 查看索引状态和性能监控
-- ============================================

-- 1. 查看 providers 表的所有索引
SHOW INDEX FROM providers;

-- 2. 查看 request_logs 表的所有索引
SHOW INDEX FROM request_logs;

-- 3. 查看 provider_pools 表的所有索引
SHOW INDEX FROM provider_pools;

-- 4. 查看 oauth_credentials 表的所有索引
SHOW INDEX FROM oauth_credentials;

-- 5. 查看表的大小和行数
SELECT
    table_name AS '表名',
    table_rows AS '行数',
    ROUND(data_length / 1024 / 1024, 2) AS '数据大小(MB)',
    ROUND(index_length / 1024 / 1024, 2) AS '索引大小(MB)',
    ROUND((data_length + index_length) / 1024 / 1024, 2) AS '总大小(MB)'
FROM information_schema.tables
WHERE table_schema = DATABASE()
AND table_name IN ('providers', 'request_logs', 'provider_pools', 'oauth_credentials')
ORDER BY (data_length + index_length) DESC;
