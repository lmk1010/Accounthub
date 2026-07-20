ALTER TABLE provider_usage_details
    ADD COLUMN image_usage_json JSON DEFAULT NULL COMMENT '图片额度归一化数据' AFTER raw_usage_json,
    ADD COLUMN image_usage_summary_json JSON DEFAULT NULL COMMENT '图片额度汇总' AFTER image_usage_json,
    ADD COLUMN raw_image_usage_json JSON DEFAULT NULL COMMENT '图片额度原始数据' AFTER image_usage_summary_json;
