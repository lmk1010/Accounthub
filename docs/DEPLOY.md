# AccountHub 部署教程

## 环境要求

- Node.js >= 18
- MySQL 8.0

## 一、本地部署

### 1. 安装依赖

```bash
# 后端
cd backend
npm install

# 前端
cd frontend
npm install
```

### 2. 配置数据库

创建 MySQL 数据库，导入 `backend/sql/init.sql`（如有）。

### 3. 启动服务

```bash
# 后端 (端口 3000)
cd backend
npm run start:dev

# 前端 (端口 5173)
cd frontend
npm run dev
```

访问：http://localhost:5173

---

## 二、Docker 部署

### 1. 拉取镜像

```bash
docker pull YOUR_DOCKERHUB/accounthub-backend:latest
docker pull YOUR_DOCKERHUB/accounthub-frontend:latest
```

### 2. 启动后端

```bash
docker run -d \
  --name accounthub-backend \
  --restart unless-stopped \
  -p 13000:3000 \
  -v /opt/AccountHub/configs:/app/configs \
  -v /opt/AccountHub/logs:/app/logs \
  YOUR_DOCKERHUB/accounthub-backend:latest
```

### 3. 启动前端

```bash
docker run -d \
  --name accounthub-frontend \
  --restart unless-stopped \
  -p 13001:80 \
  YOUR_DOCKERHUB/accounthub-frontend:latest
```

访问：http://localhost:13001

---

## 常用命令

```bash
# 查看日志
docker logs -f accounthub-backend

# 重启服务
docker restart accounthub-backend accounthub-frontend

# 停止服务
docker stop accounthub-backend accounthub-frontend
```
