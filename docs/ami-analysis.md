# AMI 反代分析文档

## 1. AMI 请求格式

### 请求 URL
```
POST https://app.ami.dev/api/v1/agent/v2
```

### 关键 Headers
```http
host: app.ami.dev
content-type: application/json
content-encoding: gzip
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ami/0.0.8 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36
origin: https://app.ami.dev
referer: https://app.ami.dev/chat/{chatId}?chat={conversationId}
cookie: wos-session=... (认证 cookie)
sec-ch-ua-platform: "macOS"
sec-ch-ua: "Not_A Brand";v="99", "Chromium";v="142"
sec-ch-ua-mobile: ?0
accept: */*
accept-encoding: gzip, deflate, br, zstd
accept-language: zh-CN
priority: u=1, i
```

### 请求 Body 结构
```json
{
  "messages": [
    {
      "id": "消息ID",
      "role": "user",
      "parts": [
        {"type": "text", "text": "用户消息内容"}
      ]
    },
    {
      "id": "消息ID",
      "role": "assistant",
      "parts": [
        {"type": "step-start"},
        {"type": "reasoning", "text": "推理内容", "providerMetadata": {...}, "state": "done"},
        {"type": "text", "text": "回复内容", "state": "done"},
        {"type": "tool-Bash_021025", "toolCallId": "xxx", "state": "output-available", "input": {...}, "output": {...}},
        {"type": "data-context-window", "data": {"used": 12930, "limit": 200000}},
        {"type": "data-otel", "data": {"traceId": "xxx"}},
        {"type": "data-lifecycle", "data": {"status": "stop"}}
      ],
      "metadata": {
        "createdAt": "1770032787861",
        "updatedAt": "1770032787861",
        "model": "anthropic/claude-opus-4.5"
      }
    }
  ],
  "agentUrl": "https://app.ami.dev",
  "context": {
    "environment": {
      "cwd": "/Users/xxx/project",
      "homeDir": "/Users/xxx",
      "workingDirectory": "/Users/xxx/project",
      "isGitRepo": false,
      "allFiles": ["file1.js", "file2.ts", "..."]
    }
  }
}
```

## 2. AMI SSE 响应格式

### 响应 Headers
```http
HTTP/2 200
content-type: text/event-stream
access-control-allow-origin: *
cache-control: no-cache
x-vercel-ai-ui-message-stream: v1
```

### SSE 事件类型

#### 2.1 开始事件
```
data: {"type":"start","messageMetadata":{"createdAt":"1770032937827","updatedAt":"1770032937827","model":"anthropic/claude-opus-4.5"},"messageId":"qVnSsOUgW8CxgGaXN_JSu"}
data: {"type":"start-step"}
```

#### 2.2 推理事件 (Reasoning/Thinking)
```
data: {"type":"reasoning-start","id":"0"}
data: {"type":"reasoning-delta","id":"0","delta":"思考内容片段"}
data: {"type":"reasoning-delta","id":"0","delta":"","providerMetadata":{"anthropic":{"signature":"..."}}}
data: {"type":"reasoning-end","id":"0"}
```

#### 2.3 文本输出事件
```
data: {"type":"text-start","id":"1"}
data: {"type":"text-delta","id":"1","delta":"回复内容片段"}
data: {"type":"text-end","id":"1"}
```

#### 2.4 工具调用事件
```
data: {"type":"tool-input-start","toolCallId":"toolu_vrtx_01GzumrrqTKTX6fij9Z17x71","toolName":"Bash_021025"}
data: {"type":"tool-input-delta","toolCallId":"toolu_vrtx_01GzumrrqTKTX6fij9Z17x71","inputTextDelta":"{\"command\": \"ls"}
data: {"type":"tool-input-delta","toolCallId":"toolu_vrtx_01GzumrrqTKTX6fij9Z17x71","inputTextDelta":" -la\"}"}
data: {"type":"tool-input-available","toolCallId":"toolu_vrtx_01GzumrrqTKTX6fij9Z17x71","toolName":"Bash_021025","input":{"command":"ls -la","description":"List files"}}
```

#### 2.5 工具输出事件
```
data: {"type":"tool-output-available","toolCallId":"toolu_vrtx_01GzumrrqTKTX6fij9Z17x71","output":{"type":"success","result":{"stdout":"...","stderr":"","interrupted":false},"context":[{"type":"TodosEmpty"}]}}
```

#### 2.6 结束事件
```
data: {"type":"data-context-window","data":{"used":21576,"limit":200000}}
data: {"type":"finish-step"}
data: {"type":"finish","finishReason":"stop"}
data: {"type":"data-otel","data":{"traceId":"7dc68a8164c71bc44910e4466f581792"}}
data: {"type":"data-lifecycle","data":{"status":"stop"}}
data: [DONE]
```

## 3. 与 Claude Code 格式对比

| 特性 | Claude Code (Anthropic格式) | AMI 格式 |
|------|---------------------------|----------|
| 消息结构 | `messages[].content[]` | `messages[].parts[]` |
| 思考内容 | `type: "thinking"` | `reasoning-start/delta/end` |
| 工具调用 | `type: "tool_use"` | `tool-{ToolName}` part |
| 工具结果 | `type: "tool_result"` | `tool-output-available` |
| 流式格式 | Anthropic SSE | 自定义 SSE (Vercel AI) |
| 认证方式 | OAuth/Cookie | Cookie (wos-session) |

## 4. 转换策略

### 4.1 Claude Code → AMI 请求转换

1. **消息格式转换**
   - `content[{type:"text"}]` → `parts[{type:"text"}]`
   - `content[{type:"thinking"}]` → `parts[{type:"reasoning", state:"done"}]`
   - `content[{type:"tool_use"}]` → `parts[{type:"tool-{ToolName}", state:"output-available"}]`
   - `content[{type:"tool_result"}]` → 合并到对应的 tool part 的 output 字段

2. **添加环境上下文**
   ```json
   "context": {
     "environment": {
       "cwd": "当前工作目录",
       "homeDir": "用户主目录",
       "workingDirectory": "工作目录",
       "isGitRepo": true/false,
       "allFiles": ["文件列表..."]
     }
   }
   ```

3. **认证处理**
   - 使用 `wos-session` Cookie 进行认证

### 4.2 AMI → Claude Code 响应转换

1. **SSE 事件映射**
   - `reasoning-delta` → `type: "thinking"` 内容块
   - `text-delta` → `type: "text"` 内容块
   - `tool-input-available` → `type: "tool_use"` 内容块
   - `finish` → `stop_reason: "end_turn"` 或 `"tool_use"`

2. **流式输出格式**
   ```
   event: content_block_start
   data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

   event: content_block_delta
   data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考内容"}}

   event: content_block_stop
   data: {"type":"content_block_stop","index":0}
   ```

## 5. AMI 工具名称映射

AMI 使用带版本号的工具名称格式：`{ToolName}_{版本号}`

| Claude Code 工具 | AMI 工具名称 |
|-----------------|-------------|
| Bash | Bash_021025 |
| Read | Read_021025 |
| Write | Write_021025 |
| Edit | Edit_021025 |
| Glob | Glob_021025 |
| Grep | Grep_021025 |
| TodoWrite | TodoWrite_021025 |
| WebSearch | WebSearch_021025 |
| WebFetch | WebFetch_021025 |
| BrowserSnapshot | BrowserSnapshot_021025 |
| BrowserExecute | BrowserExecute_021025 |
| ReadLints | ReadLints_021025 |

## 6. 注意事项

1. **多轮对话**: AMI 需要完整的历史消息，包括 assistant 的 parts 中的所有内容
2. **工具状态**: assistant 消息中的工具调用需要包含 `state: "output-available"` 和完整的 output
3. **消息 ID**: 每条消息需要唯一的 ID
4. **模型名称**: AMI 使用 `anthropic/claude-opus-4.5` 格式
5. **Cookie 认证**: `wos-session` 是主要认证凭证，需要定期刷新

## 7. 认证详情

### 认证方式
AMI 使用 Cookie 认证，只需要 `wos-session` 一个 Cookie。

### wos-session 格式
```
Fe26.2*版本*密钥ID*IV*加密数据*HMAC
```
这是 hapi.js 框架的 iron 加密格式。

### 请求时携带方式
```http
cookie: wos-session=Fe26.2*1*...
```

### 注意
- `ph_phc_...posthog` cookie 是 PostHog 分析追踪，**不需要**携带
- 只需要 `wos-session` 即可完成认证
