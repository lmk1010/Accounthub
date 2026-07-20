# Warp + Claude Code 完美适配方案

## 一、问题分析

### 1.1 当前架构

```
Claude Code ←→ Warp 适配器 ←→ Warp API
```

### 1.2 核心矛盾

| 组件 | 工具调用方式 | 工具 ID 格式 |
|------|-------------|-------------|
| Claude Code | 客户端执行 | `toolu_01XYZ...` (27字符) |
| Warp | 服务端执行 | `5f840ad1-f91f-...` (UUID) |

### 1.3 已实现功能

- [x] Protobuf 协议解析 (`warp-proto.js`)
- [x] 会话状态管理 (`WarpSessionState`)
- [x] 跨进程会话共享 (`SharedSessionStore`)
- [x] 工具格式转换 (`convertWarpToolCallToClaude`)
- [x] 工具结果转换 (`buildWarpToolResult`)
- [x] 模型映射 (`warp-model-mapper.js`)

### 1.4 当前问题

1. **工具 ID 不匹配**: Claude Code 返回的 `toolu_xxx` 无法映射回 Warp 的 UUID
2. **工具调用来源混乱**: Claude Code 自主调用的工具，Warp 不知道
3. **会话状态丢失**: 任务过期后重建，丢失上下文
4. **系统请求污染**: SUGGESTION MODE 等内部请求被发送给 Warp

---

## 二、适配方案设计

### 2.1 核心原则

**让 Warp 返回工具调用，Claude Code 执行，结果返回 Warp**

```
1. Claude Code 发送用户请求
2. Warp 返回工具调用 (Warp ID)
3. 适配器转换为 Claude 格式 (保留 Warp ID 映射)
4. Claude Code 执行工具
5. Claude Code 返回结果 (Claude ID)
6. 适配器通过映射找到 Warp ID
7. 构建 Warp 格式结果发送
```

### 2.2 工具 ID 双向映射

#### 方案 A: 直接使用 Warp ID (推荐)

```javascript
// Warp 返回的工具调用
{
  toolCallId: "5f840ad1-f91f-4c28-868c-037acc42dbdc",
  runShellCommand: { command: "ls -la" }
}

// 转换为 Claude 格式时，直接使用 Warp ID
{
  id: "5f840ad1-f91f-4c28-868c-037acc42dbdc",  // 不生成新 ID
  type: "tool_use",
  name: "Bash",
  input: { command: "ls -la" }
}

// Claude Code 返回结果
{
  type: "tool_result",
  tool_use_id: "5f840ad1-f91f-4c28-868c-037acc42dbdc",  // 原样返回
  content: "..."
}

// 直接用于 Warp 请求，无需映射
```

**优点**: 简单直接，无需维护映射表
**风险**: Claude Code 可能对非 `toolu_` 前缀的 ID 有特殊处理

#### 方案 B: 可逆 ID 转换

```javascript
// Warp ID → Claude ID (可逆)
function warpIdToClaudeId(warpId) {
  // "5f840ad1-f91f-4c28-868c-037acc42dbdc"
  // → "toolu_5f840ad1f91f4c28868c037acc42dbdc"
  return 'toolu_' + warpId.replace(/-/g, '');
}

// Claude ID → Warp ID (反向)
function claudeIdToWarpId(claudeId) {
  // "toolu_5f840ad1f91f4c28868c037acc42dbdc"
  // → "5f840ad1-f91f-4c28-868c-037acc42dbdc"
  const hex = claudeId.replace('toolu_', '');
  if (hex.length !== 32) return null; // 不是我们生成的 ID
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}
```

**优点**: 兼容 Claude Code 的 ID 格式要求
**缺点**: 需要额外的转换逻辑

---

## 三、工具格式转换详细设计

### 3.1 Warp → Claude 工具调用转换

| Warp 工具 | Claude 工具 | 参数映射 |
|-----------|-------------|----------|
| `runShellCommand` | `Bash` | `command` → `command`, `description` → `description` |
| `readFiles` | `Read` | `files[0].name` → `file_path` |
| `applyFileDiffs.diffs` | `Edit` | `filePath` → `file_path`, `search` → `old_string`, `replace` → `new_string` |
| `applyFileDiffs.newFiles` | `Write` | `filePath` → `file_path`, `content` → `content` |
| `grep` | `Grep` | `queries[0]` → `pattern`, `path` → `path` |
| `fileGlobV2` | `Glob` | `patterns[0]` → `pattern`, `searchDir` → `path` |

### 3.2 Claude → Warp 工具结果转换

| Claude 工具 | Warp 结果格式 |
|-------------|---------------|
| `Bash` | `runShellCommand.commandFinished.output` |
| `Read` | `readFiles.success.files[{filePath, content}]` |
| `Edit` | `applyFileDiffs.success.updatedFilesV2` |
| `Write` | `applyFileDiffs.success.updatedFilesV2` |
| `Grep` | `grep.success.matchedFiles` |
| `Glob` | `fileGlobV2.success.matchedFiles` |

---

## 四、会话状态管理

### 4.1 状态结构

```javascript
{
  conversationId: "uuid",      // Warp 会话 ID
  taskId: "uuid",              // Warp 任务 ID
  taskDescription: "string",   // 任务描述
  messages: [],                // 消息历史
  pendingToolCalls: Map,       // 待处理工具调用
  toolIdMapping: Map,          // 工具 ID 映射 (Claude ID → Warp ID)
  cachedTools: [],             // 工具定义缓存
  lastUpdated: timestamp       // 最后更新时间
}
```

### 4.2 工具调用生命周期

```
1. Warp 返回 toolCall
   ↓
2. 存储到 pendingToolCalls (key: warpId)
   ↓
3. 转换为 Claude 格式，存储映射 (claudeId → warpId)
   ↓
4. 发送给 Claude Code
   ↓
5. Claude Code 执行并返回结果 (claudeId)
   ↓
6. 通过映射找到 warpId
   ↓
7. 从 pendingToolCalls 获取工具信息
   ↓
8. 构建 Warp 结果并发送
   ↓
9. 从 pendingToolCalls 移除
```

---

## 五、关键问题解决方案

### 5.1 Claude Code 自主工具调用

**问题**: Claude Code 可能自己决定调用工具，这些工具调用 Warp 不知道

**解决方案**:
- 检测非 Warp 发起的工具调用 (ID 无法反解为 UUID)
- 跳过这些工具结果，不发送给 Warp
- 作为"继续对话"请求处理

```javascript
function isWarpToolCall(claudeId) {
  const warpId = claudeIdToWarpId(claudeId);
  return warpId !== null;
}
```

### 5.2 会话过期恢复

**问题**: Warp 任务过期后，返回 "task not found" 错误

**解决方案**:
1. 检测错误: `"Tried to add messages to non-existent task"`
2. 清除本地会话状态
3. 从消息历史中提取用户原始问题
4. 创建新会话重新发送

```javascript
if (error.includes('non-existent task')) {
  session.clear();
  const originalQuery = extractOriginalUserQuery(messages);
  return buildNewSessionRequest(originalQuery, ...);
}
```

### 5.3 系统请求过滤

**问题**: Claude Code 内部请求 (SUGGESTION MODE, 标题生成) 被发送给 Warp

**解决方案**: 在 `getLastUserQuery` 中过滤

```javascript
const SYSTEM_REQUEST_PATTERNS = [
  '[SUGGESTION MODE:',
  'SUGGESTION MODE:',
  'Please write a title for the following conversation',
  'Respond with the title'
];

function isSystemRequest(text) {
  return SYSTEM_REQUEST_PATTERNS.some(p => text.includes(p));
}
```

---

## 六、实现清单

### 6.1 已完成

- [x] Protobuf 编解码
- [x] HTTP/2 通信
- [x] 会话状态持久化
- [x] 基础工具转换 (Bash, Read, Edit, Write, Grep, Glob)
- [x] 工具结果构建
- [x] 系统请求过滤

### 6.2 待优化

- [ ] **工具 ID 映射**: 实现可逆 ID 转换
- [ ] **映射表持久化**: 将 toolIdMapping 加入会话状态
- [ ] **会话恢复**: 完善任务过期后的恢复逻辑
- [ ] **错误处理**: 统一错误处理和重试机制

### 6.3 待验证

- [ ] 方案 A vs 方案 B 的兼容性测试
- [ ] 长时间会话的稳定性
- [ ] 并发请求的正确性

---

## 七、代码修改计划

### 7.1 warp-converter.js

```javascript
// 新增: 工具 ID 转换函数
export function warpIdToClaudeId(warpId) { ... }
export function claudeIdToWarpId(claudeId) { ... }

// 修改: convertWarpToolCallToClaude
// 使用 warpIdToClaudeId 生成 Claude ID

// 修改: WarpSessionState
// 新增 toolIdMapping 字段
```

### 7.2 warp-ai.js

```javascript
// 修改: buildRequestBody
// 使用 claudeIdToWarpId 反解工具 ID

// 修改: 工具结果处理
// 区分 Warp 工具调用和 Claude Code 自主调用
```

---

## 八、测试用例

### 8.1 基础流程

1. 用户发送 "列出当前目录文件"
2. Warp 返回 runShellCommand 工具调用
3. Claude Code 执行 Bash
4. 结果正确返回给 Warp
5. Warp 返回文本回复

### 8.2 多工具调用

1. 用户发送 "读取 package.json 并分析"
2. Warp 返回 readFiles 工具调用
3. Claude Code 执行 Read
4. 结果返回，Warp 继续分析

### 8.3 会话恢复

1. 长时间对话后任务过期
2. 检测到 "task not found" 错误
3. 自动创建新会话
4. 用户无感知继续对话

---

## 九、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Claude Code 不接受非 toolu_ ID | 高 | 使用方案 B 可逆转换 |
| Warp API 变更 | 中 | 版本检测和兼容层 |
| 会话状态丢失 | 中 | 多级缓存和恢复机制 |
| 并发冲突 | 低 | 跨进程锁已实现 |

---

---

## 十、日志分析发现的新问题

### 10.1 问题：Warp 已使用 toolu_ 格式 ID

从日志中发现：
```
toolCallId: "toolu_012vk4FoVzyxENFmNAkUhqcL"
toolCallId: "toolu_01XtFEAYw4yqZnccEECr9qwa"
```

**发现**: Warp 返回的工具调用 ID 已经是 `toolu_` 格式！不是 UUID 格式。

**影响**: 方案 B 的可逆转换不适用，因为 Warp 本身就用 toolu_ 格式。

**新方案**: 直接使用 Warp 返回的 toolCallId，无需转换。

### 10.2 问题：工具调用流式更新

日志显示工具调用是分步骤发送的：
```
1. addMessagesToTask: toolCall 初始化 (readFiles: {})
2. updateTaskMessage: 填充参数 (files: [...])
```

**当前处理**:
- 第一次收到空参数时返回 null，等待更新
- 第二次收到完整参数时才处理

**问题**: 可能导致工具调用丢失或重复

### 10.3 问题：多工具并发执行

日志显示：
```
pendingToolCalls: 2
Outputting pending tool call: toolu_01XtFEAYw4yqZnccEECr9qwa Bash
Skipping already emitted tool call: toolu_012vk4FoVzyxENFmNAkUhqcL
```

**当前处理**:
- 一次只输出一个工具调用
- 跳过已输出的工具调用

**问题**: Claude Code 可能期望一次收到所有工具调用

### 10.4 问题：工具结果累积

日志显示：
```
Tool results: 8
Tool results: 9
```

**问题**: Claude Code 发送的消息包含所有历史工具结果，不只是最新的。

**当前处理**: 遍历所有工具结果，跳过未知的

**优化**: 应该只处理最新一轮的工具结果

### 10.5 问题：空响应后重试

日志显示：
```
Stream ended. Lines: 4 hasContent: false
Empty response, retrying... (keeping session state)
```

**问题**: Warp 返回空响应后重试，但重试时发送的是相同的工具结果

**原因**: 工具结果已经被 Warp 处理，重复发送导致空响应

---

## 十一、核心问题重新梳理

### 11.1 工具调用流程问题

```
当前流程 (有问题):
┌─────────────────────────────────────────────────────────────┐
│ 1. 用户请求 → Warp                                          │
│ 2. Warp 返回工具调用 A, B                                   │
│ 3. 适配器输出工具 A → Claude Code                           │
│ 4. Claude Code 执行 A，同时自己决定执行 C, D, E             │
│ 5. Claude Code 返回 A, C, D, E 的结果                       │
│ 6. 适配器只认识 A，跳过 C, D, E                             │
│ 7. 发送 A 结果给 Warp                                       │
│ 8. Warp 返回空响应 (还在等 B 的结果)                        │
│ 9. 适配器输出工具 B → Claude Code                           │
│ 10. Claude Code 返回 A, B, C, D, E 的结果 (累积)            │
│ 11. 适配器只认识 B (A 已处理)，跳过其他                     │
│ 12. 发送 B 结果给 Warp                                      │
│ 13. Warp 返回空响应 (已处理过 B？)                          │
│ 14. 重试...死循环                                           │
└─────────────────────────────────────────────────────────────┘
```

### 11.2 根本原因

1. **Claude Code 自主调用工具**: Claude Code 不只执行 Warp 返回的工具，还会自己决定调用其他工具
2. **工具结果累积**: Claude Code 每次请求都带上所有历史工具结果
3. **一次只输出一个工具**: 适配器一次只输出一个 Warp 工具调用
4. **重复发送已处理结果**: 重试时发送已被 Warp 处理的结果

---

## 十二、完美适配方案 v2

### 12.1 方案选择

**方案 C: 混合模式 (推荐)**

让 Warp 和 Claude Code 各自执行自己的工具：
- Warp 返回的工具调用 → 由 Claude Code 执行 → 结果返回 Warp
- Claude Code 自主调用的工具 → 由 Claude Code 执行 → 不发送给 Warp

### 12.2 关键改进

#### 改进 1: 工具结果去重

```javascript
// 记录已发送给 Warp 的工具结果
session.sentToolResults = new Set();

// 只发送新的工具结果
function filterNewToolResults(toolResults, session) {
    return toolResults.filter(tr => {
        if (session.sentToolResults.has(tr.toolCallId)) {
            return false; // 已发送过
        }
        if (!session.pendingToolCalls.has(tr.toolCallId)) {
            return false; // 不是 Warp 的工具
        }
        return true;
    });
}

// 发送后标记
function markToolResultsSent(toolResults, session) {
    for (const tr of toolResults) {
        session.sentToolResults.add(tr.toolCallId);
    }
}
```

#### 改进 2: 批量输出工具调用

```javascript
// 一次输出所有待处理的工具调用
function* outputAllPendingToolCalls(session) {
    for (const [id, toolCall] of session.pendingToolCalls) {
        if (!session.emittedToolCalls.has(id)) {
            session.emittedToolCalls.add(id);
            yield convertWarpToolCallToClaude(toolCall);
        }
    }
}
```

#### 改进 3: 智能重试判断

```javascript
// 判断是否需要重试
function shouldRetry(response, session) {
    // 如果还有未处理的工具调用，不重试，等待结果
    if (session.pendingToolCalls.size > 0) {
        return false;
    }
    // 如果没有内容且没有工具调用，才重试
    return !response.hasContent;
}
```

#### 改进 4: 工具调用状态机

```javascript
const ToolCallState = {
    PENDING: 'pending',      // 等待参数完整
    READY: 'ready',          // 参数完整，待输出
    EMITTED: 'emitted',      // 已输出给 Claude Code
    RESULT_RECEIVED: 'result_received',  // 收到结果
    SENT_TO_WARP: 'sent_to_warp'  // 已发送给 Warp
};

class ToolCallTracker {
    constructor() {
        this.toolCalls = new Map(); // id → {state, data, result}
    }

    add(toolCall) {
        this.toolCalls.set(toolCall.toolCallId, {
            state: ToolCallState.PENDING,
            data: toolCall,
            result: null
        });
    }

    markReady(id) { ... }
    markEmitted(id) { ... }
    setResult(id, result) { ... }
    markSentToWarp(id) { ... }

    getReadyToolCalls() { ... }
    getResultsToSend() { ... }
}
```

---

## 十三、实现优先级

### P0 - 立即修复 (阻塞问题)

1. **工具结果去重**: 避免重复发送已处理的结果
2. **空响应判断优化**: 有待处理工具时不重试

### P1 - 短期优化 (体验问题)

3. **批量输出工具调用**: 一次输出所有工具
4. **工具调用状态跟踪**: 完整的状态机

### P2 - 中期完善 (稳定性)

5. **会话恢复增强**: 任务过期后智能恢复
6. **错误处理统一**: 各类错误的处理策略

### P3 - 长期优化 (性能)

7. **消息历史压缩**: 避免发送过多历史
8. **并发控制优化**: 更细粒度的锁

---

## 十四、下一步行动

1. **立即**: 实现工具结果去重 (`sentToolResults`)
2. **立即**: 优化空响应重试判断
3. **短期**: 实现工具调用状态机
4. **短期**: 批量输出工具调用
5. **中期**: 完善会话恢复
6. **长期**: 性能优化
