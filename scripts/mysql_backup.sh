#!/bin/bash
# MySQL 备份脚本：全量 + binlog 增量
# 使用方法：配置下方变量后，添加到 crontab

# ========== 配置区 ==========
MYSQL_HOST="localhost"
MYSQL_PORT="3306"
MYSQL_USER="root"
MYSQL_PASS="your_password"
MYSQL_DB="your_database"          # 要备份的数据库，多个用空格分隔
BACKUP_DIR="/data/mysql_backup"
BINLOG_DIR="/var/lib/mysql"       # MySQL binlog 目录
KEEP_DAYS=7                       # 保留天数

# ========== 脚本开始 ==========
DATE=$(date +%Y%m%d_%H%M%S)
FULL_BACKUP_DIR="$BACKUP_DIR/full"
BINLOG_BACKUP_DIR="$BACKUP_DIR/binlog"

mk

mkdir -p "$FULL_BACKUP_DIR" "$BINLOG_BACKUP_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 全量备份（带 binlog 位置，方便增量恢复）
full_backup() {
    log "开始全量备份..."
    mysqldump -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASS" \
        --single-transaction \
        --master-data=2 \
        --flush-logs \
        --routines \
        --triggers \
        --databases $MYSQL_DB \
        | gzip > "$FULL_BACKUP_DIR/${MYSQL_DB}_full_${DATE}.sql.gz"

    if [ $? -eq 0 ]; then
        log "全量备份完成: ${MYSQL_DB}_full_${DATE}.sql.gz"
    else
        log "全量备份失败!"
        exit 1
    fi
}

# 备份 binlog（增量）
backup_binlog() {
    log "备份 binlog..."
    # 刷新 binlog 并获取当前 binlog 文件列表
    mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASS" -e "FLUSH LOGS;"

    # 复制 binlog 文件
    cp "$BINLOG_DIR"/mysql-bin.* "$BINLOG_BACKUP_DIR/" 2>/dev/null
    log "binlog 备份完成"
}

# 清理旧备份
cleanup() {
    log "清理 ${KEEP_DAYS} 天前的备份..."
    find "$FULL_BACKUP_DIR" -name "*.sql.gz" -mtime +$KEEP_DAYS -delete
    find "$BINLOG_BACKUP_DIR" -name "mysql-bin.*" -mtime +$KEEP_DAYS -delete
}

# 主流程
case "${1:-full}" in
    full)
        full_backup
        backup_binlog
        cleanup
        ;;
    binlog)
        backup_binlog
        ;;
    *)
        echo "用法: $0 {full|binlog}"
        exit 1
        ;;
esac

log "备份任务完成"
