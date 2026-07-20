# Kiro API 协议分析报告

## 概述

分析了 Kiro IDE 的 4 次抓包请求，包括：
- **第一个窗口会话**：request-1, resp-1, request-2, resp-2
- **新开窗口会话**：new_session_1, new_session_resp-1, newsession_req_2, newsession_resp_2

---

## 一、Session ID 对比分析

### 关键发现：每个窗口有独立的 Session 标识

| 字段 | 第一个窗口 | 新开窗口 | 结论 |
|------|-----------|----------|------|
| **conversationId** | `495a464d-f0de-4fcf-a089-8616882c30f3` | `ca4a968f-3b66-4ae8-bdb8-f6798605d939` | **不同** - 每个窗口独立 |
| **agentContinuationId** | `38e6215b-4d37-4039-ab8e-d66b6575f777` | `271c697a-d4c6-4de7-8ac5-640ee6ef2a8d` | **不同** - 每个窗口独立 |
| **amz-sdk-invocation-id** | 每次请求都不同 | 每次请求都不同 | **每次请求唯一** |
| **Authorization Bearer** | 相同 | 相同 | **账号级别共享** |
| **profileArn** | `arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK` | 相同 | **账号级别共享** |

### 多窗口架构关键点

```
单账号
├── profileArn (账号唯一标识)
├── Authorization Bearer Token (账号认证)
│
├── 窗口1 (Session A)
│   ├── conversationId: UUID-A
│   ├── agentContinuationId: UUID-A'
│   ├── 请求1: amz-sdk-invocation-id: UUID-1
│   └── 请求2: amz-sdk-invocation-id: UUID-2
│
└── 窗口2 (Session B)
    ├── conversationId: UUID-B
    ├── agentContinuationId: UUID-B'
    ├── 请求1: amz-sdk-invocation-id: UUID-3
    └── 请求2: amz-sdk-invocation-id: UUID-4
```

---

## 二、请求 Headers 详细分析

### 完整 Headers 列表

```http
POST /generateAssistantResponse HTTP/1.1
content-type: application/json
content-length: [动态]
x-amzn-codewhisperer-optout: true
x-amzn-kiro-agent-mode: intent-classification | vibe
x-amz-user-agent: aws-sdk-js/1.0.27 KiroIDE-0.8.140-[MachineID]
user-agent: aws-sdk-js/1.0.27 ua/2.1 os/darwin#24.6.0 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.8.140-[MachineID]
host: q.us-east-1.amazonaws.com
amz-sdk-invocation-id: [UUID - 每次请求唯一]
amz-sdk-request: attempt=1; max=3
Authorization: Bearer [Token]
Connection: close
```

### Header 详解

| Header | 用途 | 值特点 |
|--------|------|--------|
| `x-amzn-kiro-agent-mode` | 请求模式 | `intent-classification` (意图分类) 或 `vibe` (实际对话) |
| `x-amzn-codewhisperer-optout` | 数据隐私 | 固定 `true` |
| `amz-sdk-invocation-id` | 请求追踪 | 每次请求 UUID |
| `amz-sdk-request` | 重试配置 | `attempt=1; max=3` |
| `x-amz-user-agent` | 客户端标识 | 包含版本和 MachineID |

---

## 三、请求流程分析

### 每次用户输入触发两个请求

```
用户输入 "你是谁"
    │
    ├─► 请求1: intent-classification (意图分类)
    │   ├── x-amzn-kiro-agent-mode: intent-classification
    │   ├── modelId: simple-task
    │   ├── content-length: ~4KB
    │   └── 响应: {"chat": 0.9, "do": 0.1, "spec": 0.0}
    │
    └─► 请求2: vibe (实际对话)
        ├── x-amzn-kiro-agent-mode: vibe
        ├── modelId: claude-sonnet-4.5
        ├── content-length: ~110KB (包含完整工具定义)
        └── 响应: 流式文本回复
```

---

## 四、请求体结构分析

### 核心字段

```json
{
  "conversationState": {
    "agentContinuationId": "UUID - 会话连续性ID",
    "agentTaskType": "vibe",
    "chatTriggerType": "MANUAL",
    "conversationId": "UUID - 会话ID",
    "currentMessage": {
      "userInputMessage": {
        "content": "用户输入内容 + EnvironmentContext",
        "modelId": "claude-sonnet-4.5",
        "origin": "AI_EDITOR",
        "userInputMessageContext": {
          "tools": [...] // 完整工具定义列表
        }
      }
    },
    "history": [...] // 对话历史
  },
  "profileArn": "arn:aws:codewhisperer:us-east-1:XXX:profile/XXX"
}
```

### 工具定义 (tools) 特点

Kiro 在每个 vibe 请求中携带完整的工具定义 (~100KB+)，包括：
- `executeBash` - 命令执行
- `fsWrite` / `strReplace` - 文件操作
- `readFile` / `readMultipleFiles` - 文件读取
- `grepSearch` / `fileSearch` - 搜索
- `controlBashProcess` - 后台进程管理
- `remote_web_search` / `webFetch` - 网络搜索
- `invokeSubAgent` - 子代理调用
- `kiroPowers` - 扩展能力
- 等 17+ 工具

---

## 五、响应格式分析 (SSE 事件流)

### 响应 Headers

```http
HTTP/1.1 200 OK
Content-Type: application/json
Transfer-Encoding: chunked
x-amzn-RequestId: [UUID]
x-amzn-codewhisperer-conversation-id: [空]
Cache-Control: no-cache
```

### SSE 事件类型

```
事件1: assistantResponseEvent
{
  "content": "流式文本片段"
}

事件2: meteringEvent (计费)
{
  "unit": "credit",
  "unitPlural": "credits",
  "usage": 0.15067652112769486
}

事件3: contextUsageEvent (上下文使用)
{
  "contextUsagePercentage": 15.258500099182129
}
```

### 流式响应格式详解

Kiro 使用的是 AWS EventStream 二进制协议，不是标准 SSE：

```
[4字节长度前缀][事件头][事件体]

事件头示例:
:event-type assistantResponseEvent
:content-type application/json
:message-type event

事件体:
{"content":"我是 K"}
```

---

## 六、与你们系统的差距分析

### 1. Session 管理差距

**Kiro 实现**:
- `conversationId` + `agentContinuationId` 双层会话管理
- 单账号支持多窗口独立会话
- 每个窗口有独立的上下文

**你们需要实现**:
```typescript
interface SessionManager {
  // 账号级别
  accountId: string;
  authToken: string;

  // 窗口/会话级别
  sessions: Map<string, {
    conversationId: string;
    agentContinuationId: string;
    history: Message[];
  }>;

  // 创建新会话
  createSession(): string;

  // 获取会话
  getSession(sessionId: string): Session;
}
```

### 2. 缓存策略差距

**Kiro 实现**:
- 请求体包含完整工具定义，不依赖服务端缓存
- 每次请求都是自包含的
- `Cache-Control: no-cache` 禁用 HTTP 缓存

**你们的问题**:
- 可能在服务端缓存了大量上下文
- 缓存重建导致延迟

**建议**:
```typescript
// 不要在服务端缓存工具定义
// 让客户端每次请求都带上完整上下文
// 只缓存账号认证和计费信息
```

### 3. 流式响应差距

**Kiro 实现**:
- AWS EventStream 二进制协议
- 小片段快速推送 (3-6 个中文字符一个事件)
- 每个事件独立编码

**你们可能的问题**:
- 使用标准 SSE 但缓冲区太大
- 服务端等待更多内容再推送
- 网络层有中间缓存

**优化建议**:
```java
// 禁用输出缓冲
response.setBufferSize(0);
response.flushBuffer();

// 每收到 token 立即推送
for (String token : stream) {
    writer.write(formatSSE(token));
    writer.flush(); // 关键：立即刷新
}
```

### 4. 请求流程差距

**Kiro 实现**:
- 两阶段请求：意图分类 → 实际对话
- 意图分类使用轻量模型 (simple-task)
- 实际对话使用重量模型 (claude-sonnet-4.5)

**优化建议**:
```
用户输入
    │
    ├─► 快速意图分类 (小模型，低延迟)
    │   判断：chat / do / spec
    │
    └─► 根据意图路由到不同处理流程
        ├── chat: 简单问答，可用更快模型
        └── do: 代码操作，用完整模型
```

---

## 七、多开窗口实现方案

### 核心设计

```typescript
// 1. 账号管理层
class AccountManager {
  private accounts: Map<string, Account> = new Map();

  authenticate(token: string): Account {
    // 验证 Bearer Token
    // 返回账号信息
  }
}

// 2. 会话管理层
class SessionManager {
  private sessions: Map<string, Session> = new Map();

  createSession(accountId: string): Session {
    const session = {
      id: uuidv4(),
      conversationId: uuidv4(),
      agentContinuationId: uuidv4(),
      accountId,
      history: [],
      createdAt: Date.now()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId);
  }
}

// 3. API 路由
app.post('/api/chat', async (req, res) => {
  const { accountToken, sessionId, message } = req.body;

  // 验证账号
  const account = accountManager.authenticate(accountToken);

  // 获取或创建会话
  let session = sessionManager.getSession(sessionId);
  if (!session) {
    session = sessionManager.createSession(account.id);
  }

  // 构建请求
  const apiRequest = {
    conversationState: {
      conversationId: session.conversationId,
      agentContinuationId: session.agentContinuationId,
      currentMessage: {
        content: message,
        modelId: 'claude-sonnet-4.5'
      },
      history: session.history
    }
  };

  // 调用上游 API 并流式返回
  await streamResponse(apiRequest, res);

  // 更新会话历史
  session.history.push(...);
});
```

### 客户端实现

```typescript
// 每个窗口维护自己的 sessionId
class ChatWindow {
  private sessionId: string | null = null;

  async sendMessage(message: string) {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        accountToken: getAccountToken(),
        sessionId: this.sessionId, // 可能为 null (新窗口)
        message
      })
    });

    // 从响应头获取新的 sessionId
    this.sessionId = response.headers.get('X-Session-Id');

    // 处理流式响应
    await handleStream(response.body);
  }
}
```

---

## 八、性能优化建议

### 1. 减少首包延迟

```java
// 在开始生成前立即发送心跳
writer.write(": heartbeat\n\n");
writer.flush();

// 设置 TCP_NODELAY
socket.setTcpNoDelay(true);
```

### 2. 禁用 Nginx 缓冲

```nginx
location /api/chat {
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;

    # 禁用 gzip 压缩流式响应
    gzip off;
}
```

### 3. 优化上下文管理

```typescript
// 只在必要时发送完整工具定义
// 使用 hash 检测工具定义是否变化
const toolsHash = hash(tools);
if (toolsHash !== lastToolsHash) {
  request.tools = tools;
  request.toolsHash = toolsHash;
} else {
  request.toolsHash = toolsHash; // 服务端使用缓存
}
```

---

## 九、总结

### Kiro 的关键设计

1. **双层 ID 设计**: `conversationId` (会话) + `agentContinuationId` (延续)
2. **两阶段请求**: 意图分类 → 实际对话
3. **自包含请求**: 每次请求携带完整上下文，不依赖服务端状态
4. **AWS EventStream**: 二进制流式协议，小片段快速推送

### 你们需要改进

1. **多会话支持**: 实现 Session 管理器，每个窗口独立会话
2. **流式优化**: 禁用缓冲，立即刷新，考虑使用 EventStream
3. **减少依赖**: 减少服务端状态依赖，让请求自包含
4. **分离模型**: 意图分类用轻量模型，实际对话用重量模型
