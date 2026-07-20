-- 添加请求日志的错误详情字段

ALTER TABLE request_logs
ADD COLUMN error_stack TEXT DEFAULT NULL COMMENT '错误堆栈' AFTER error_message,
ADD COLUMN error_detail TEXT DEFAULT NULL COMMENT '错误详情' AFTER error_stack;
