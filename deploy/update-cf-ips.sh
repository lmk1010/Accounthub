#!/bin/bash
# 自动更新 Cloudflare IP 白名单到 nginx 配置
# 用法：crontab 定期执行，例如每周一次
# 0 3 * * 1 /path/to/update-cf-ips.sh

CF_IPS_V4_URL="https://www.cloudflare.com/ips-v4"
CF_CONF="/etc/nginx/conf.d/cloudflare-ips.conf"
CF_CONF_TMP="${CF_CONF}.tmp"

echo "# Auto-generated Cloudflare IP config" > "$CF_CONF_TMP"
echo "# Updated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >> "$CF_CONF_TMP"
echo "# Source: $CF_IPS_V4_URL" >> "$CF_CONF_TMP"
echo "" >> "$CF_CONF_TMP"

# 拉取 CF IPv4 列表
CF_IPS=$(curl -sf "$CF_IPS_V4_URL")
if [ -z "$CF_IPS" ]; then
    echo "[ERROR] Failed to fetch Cloudflare IPs, keeping existing config"
    rm -f "$CF_CONF_TMP"
    exit 1
fi

# 生成 set_real_ip_from
echo "# Real IP from CF" >> "$CF_CONF_TMP"
for ip in $CF_IPS; do
    echo "set_real_ip_from $ip;" >> "$CF_CONF_TMP"
done
echo 'real_ip_header CF-Connecting-IP;' >> "$CF_CONF_TMP"
echo "" >> "$CF_CONF_TMP"

# 生成 geo 变量
echo 'geo $is_cloudflare {' >> "$CF_CONF_TMP"
echo '    default 0;' >> "$CF_CONF_TMP"
for ip in $CF_IPS; do
    echo "    $ip 1;" >> "$CF_CONF_TMP"
done
echo '    # 容器内网' >> "$CF_CONF_TMP"
echo '    172.16.0.0/12 1;' >> "$CF_CONF_TMP"
echo '    10.0.0.0/8 1;' >> "$CF_CONF_TMP"
echo '    127.0.0.0/8 1;' >> "$CF_CONF_TMP"
echo '}' >> "$CF_CONF_TMP"

# 对比是否有变化
if [ -f "$CF_CONF" ] && diff -q "$CF_CONF" "$CF_CONF_TMP" > /dev/null 2>&1; then
    echo "[INFO] No changes in Cloudflare IPs"
    rm -f "$CF_CONF_TMP"
    exit 0
fi

# 替换并 reload
mv "$CF_CONF_TMP" "$CF_CONF"
echo "[INFO] Cloudflare IPs updated, testing nginx config..."

nginx -t 2>&1
if [ $? -eq 0 ]; then
    nginx -s reload
    echo "[OK] nginx reloaded with new Cloudflare IPs"
else
    echo "[ERROR] nginx config test failed!"
    exit 1
fi
