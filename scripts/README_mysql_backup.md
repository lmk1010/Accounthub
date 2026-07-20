# MySQL Binlog 实时备份方案

## 特点

| 项目 | 说明 |
|------|------|
| 性能影响 | < 1% |
| RPO | 秒级 |
| 内存占用 | < 10MB |
| 原理 | 实时复制 binlog 增量日志 |

---

## 前置条件

### 主库开启 binlog（my.cnf）

```ini
[mysqld]
server-id = 1
log-bin = mysql-bin
binlog-format = ROW
```

修改后重启 MySQL：
```bash
systemctl restart mysql
```

验证：
```sql
SHOW VARIABLES LIKE 'log_bin';  -- 应该是 ON
SHOW MASTER STATUS;             -- 查看当前 binlog 文件
```

---

## 使用方法

### 1. 配置脚本

编辑 `binlog_realtime_backup.sh`，修改以下变量：

```bash
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_USER="root"
MYSQL_PASS="your_password"
BACKUP_DIR="/data/binlog_backup"
```

### 2. 启动备份

```bash
chmod +x binlog_realtime_backup.sh
./binlog_realtime_backup.sh start
```

### 3. 查看状态

```bash
./binlog_realtime_backup.sh status
```

### 4. 停止备份

```bash
./binlog_realtime_backup.sh stop
```

---

## 开机自启

### 方法一：rc.local

```bash
echo "/path/to/binlog_realtime_backup.sh start" >> /etc/rc.local
```

### 方法二：systemd

创建 `/etc/systemd/system/binlog-backup.service`：

```ini
[Unit]
Description=MySQL Binlog Realtime Backup
After=mysql.service

[Service]
Type=forking
ExecStart=/path/to/binlog_realtime_backup.sh start
ExecStop=/path/to/binlog_realtime_backup.sh stop
PIDFile=/tmp/binlog_backup.pid

[Install]
WantedBy=multi-user.target
```

启用：
```bash
systemctl daemon-reload
systemctl enable binlog-backup
systemctl start binlog-backup
```

---

## 数据恢复

### 恢复到最新状态

```bash
mysqlbinlog /data/binlog_backup/mysql-bin.* | mysql -uroot -p
```

### 恢复到指定时间点

```bash
mysqlbinlog --stop-datetime="2026-02-04 10:30:00" \
  /data/binlog_backup/mysql-bin.* | mysql -uroot -p
```

### 恢复到指定位置

```bash
mysqlbinlog --stop-position=12345 \
  /data/binlog_backup/mysql-bin.000001 | mysql -uroot -p
```

### 跳过某个错误操作

```bash
# 跳过 pos 1000-1100 之间的操作
mysqlbinlog --stop-position=1000 mysql-bin.000001 | mysql -uroot -p
mysqlbinlog --start-position=1100 mysql-bin.000001 | mysql -uroot -p
```

---

## 配合全量备份（推荐）

建议每天做一次全量备份，配合 binlog 增量：

```bash
# 每天凌晨 3 点全量备份（crontab）
0 3 * * * /path/to/mysql_backup.sh full
```

恢复流程：
1. 先恢复最近的全量备份
2. 再用 binlog 恢复到目标时间点

---

## 常见问题

### Q: binlog 文件会越来越大吗？

A: 会。建议定期清理旧的 binlog：

```sql
-- 保留最近 7 天
PURGE BINARY LOGS BEFORE DATE_SUB(NOW(), INTERVAL 7 DAY);
```

或在 my.cnf 设置自动过期：
```ini
expire_logs_days = 7
```

### Q: 备份目录磁盘满了怎么办？

A: 定期清理旧备份：
```bash
find /data/binlog_backup -name "mysql-bin.*" -mtime +7 -delete
```

### Q: 如何验证备份是否正常？

A:
```bash
# 查看备份文件是否在增长
ls -lh /data/binlog_backup/

# 查看进程是否存活
./binlog_realtime_backup.sh status
```

---

## 方案对比

| 方案 | 性能影响 | RPO | 内存 | 适用场景 |
|------|---------|-----|------|---------|
| mysqldump 定时 | 中 | 小时级 | 低 | 小库 |
| **binlog 实时流** | **极低** | **秒级** | **极低** | **推荐** |
| 主从复制 | 极低 | 毫秒级 | 需从库 | 高可用 |
| Canal | 低 | 毫秒级 | 中 | 数据同步 |
