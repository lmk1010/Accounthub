-- 添加 available_models 字段到 providers 表
-- 用于存储从 Kiro ListAvailableModels API 获取的可用模型列表

ALTER TABLE providers
ADD COLUMN available_models JSON DEFAULT NULL COMMENT '可用模型列表(从API获取)';
