-- 添加请求日志的调用端用户信息字段

ALTER TABLE request_logs
ADD COLUMN user_id VARCHAR(64) DEFAULT NULL COMMENT '调用端User ID' AFTER client_token_id,
ADD COLUMN user_email VARCHAR(128) DEFAULT NULL COMMENT '调用端User Email' AFTER user_id,
ADD COLUMN username VARCHAR(128) DEFAULT NULL COMMENT '调用端Username' AFTER user_email;
