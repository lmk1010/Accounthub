#!/bin/bash
# binlog 实时备份脚本
# 性能影响：极低（只是复制日志文件）
# RPO：秒级

# ========== 配置 ==========
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_USER="root"
MYSQL_PASS="your_password"
BACKUP_DIR="/data/binlog_backup"
LOG_FILE="/var/log/binlog_backup.log"

# ========== 脚本 ==========
mkdir -p "$BACKUP_DIR"

# 获取当前最新的 binlog 文件名
get_latest_binlog() {
    mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASS" -N -e \
        "SHOW MASTER STATUS" 2>/dev/null | awk '{print $1}'
}

# 启动实时备份
start_backup() {
    BINLOG_FILE=$(get_latest_binlog)
    if [ -z "$BINLOG_FILE" ]; then
        echo "错误：无法获取 binlog 文件名，请检查 MySQL 是否开启 binlog"
        exit 1
    fi

    echo "[$(date)] 开始实时备份，从 $BINLOG_FILE" | tee -a "$LOG_FILE"

    # 实时流式备份（后台运行）
    mysqlbinlog \
        --read-from-remote-server \
        --host="$MYSQL_HOST" \
        --port="$MYSQL_PORT" \
        --user="$MYSQL_USER" \
        --password="$MYSQL_PASS" \
        --raw \
        --stop-never \
        --result-file="$BACKUP_DIR/" \
        "$BINLOG_FILE" >> "$LOG_FILE" 2>&1 &

    echo $! > /tmp/binlog_backup.pid
    echo "备份进程已启动，PID: $(cat /tmp/binlog_backup.pid)"
}

# 停止备份
stop_backup() {
    if [ -f /tmp/binlog_backup.pid ]; then
        kill $(cat /tmp/binlog_backup.pid) 2>/dev/null
        rm -f /tmp/binlog_backup.pid
        echo "备份进程已停止"
    else
        echo "没有运行中的备份进程"
    fi
}

# 查看状态
status() {
    if [ -f /tmp/binlog_backup.pid ] && kill -0 $(cat /tmp/binlog_backup.pid) 2>/dev/null; then
        echo "✅ 备份进程运行中，PID: $(cat /tmp/binlog_backup.pid)"
        echo "备份目录: $BACKUP_DIR"
        ls -lh "$BACKUP_DIR" | tail -5
    else
        echo "❌ 备份进程未运行"
    fi
}

case "$1" in
    start)  start_backup ;;
    stop)   stop_backup ;;
    status) status ;;
    *)
        echo "用法: $0 {start|stop|status}"
        exit 1
        ;;
esac
