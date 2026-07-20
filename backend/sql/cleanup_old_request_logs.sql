-- 清理 request_logs 历史数据，只保留今天的日志
-- 警告：此操作不可逆，建议先备份数据

-- 删除今天之前的所有日志
DELETE FROM request_logs
WHERE DATE(created_at) < CURDATE();

-- 查看删除结果（可选）
-- SELECT COUNT(*) as remaining_logs FROM request_logs;
-- SELECT MIN(created_at) as earliest_log, MAX(created_at) as latest_log FROM request_logs;
