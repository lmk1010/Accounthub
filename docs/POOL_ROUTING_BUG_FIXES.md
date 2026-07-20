# 池子路由策略问题修复清单 (Pool Routing Bug Fixes)

## 池子路由策略问题 (Pool Routing Issues)

### 1. 渠道路由配置只在未指定poolId时生效

**位置**: `provider-pool-manager-db.js:644`

```javascript
if (resolvedPoolId === null) {
    const poolRouting = await this._getChannelPoolRouting(providerType);
    // ... 渠道路由逻辑
}
```

**问题**: 当请求头或查询参数中指定了poolId时，完全跳过渠道路由配置。这意味着：
- 用户指定的poolId会覆盖所有渠道级别的路由规则
- 可能导致请求被路由到不支持该模型的池子

**建议**: 考虑在指定poolId时也验证该池子是否符合渠道路由规则。

**状态**: [x] 暂不修复 - 设计预留，目前newapi不传poolId参数，等有渠道细分池子需求再处理

---

### 2. 池子模型支持检查的逻辑顺序问题

**位置**: `provider-pool-manager-db.js:689-708`

```javascript
if (requestedModel) {
    const poolSupported = isPoolModelSupported(poolId);
    if (!poolSupported && poolConfigs.length > 0) {
        const candidateIds = routingPoolIds.length > 0 ? routingPoolIds : poolConfigs.map(pc => pc.id);
        const alternativeId = candidateIds.find(id => isPoolModelSupported(id));
        if (alternativeId) {
            console.log(`[ProviderPoolManagerDB] Pool ${poolId} doesn't support model ${requestedModel}, routing to pool ${alternativeId}`);
            poolId = alternativeId;
        } else {
            console.log(`[ProviderPoolManagerDB] No pool supports model ${requestedModel} for ${providerType}`);
            return null;
        }
    }
}
```

**问题**:
1. 此检查发生在渠道路由已经选择池子之后
2. 如果选中的池子不支持模型，它会尝试找替代池子
3. 但替代搜索使用的routingPoolIds可能为空（如果没有配置渠道路由）
4. 如果routingPoolIds为空，会回退到所有池子配置，可能违反路由意图
5. 没有考虑备选池子是否有可用账号

**状态**: [x] 暂不修复 - 符合预期行为。路由策略本质是"找到能用的池子"，回退到所有池子是合理的兜底逻辑

---

### 3. Round-Robin计数器的键值设计问题

**位置**: `provider-pool-manager-db.js:446, 249`

```javascript
// 账号级别
const counterKey = poolId !== null ? `${providerType}:${poolId}` : providerType;

// 池子级别
const counterKey = `pool-route:${providerType}:${ruleKey}`;
```

**问题**:
- 计数器存储在内存中，多进程/多实例部署时会导致轮询不均匀
- 没有持久化机制，重启后计数器重置

**状态**: [x] 已修复

**修复方案**:
1. 新增 `backend/src/services/redis-client.js` Redis客户端模块
2. 修改 `provider-pool-manager-db.js`:
   - 新增 `_nextRoundRobinIndexAsync()` 方法，优先使用Redis的INCR原子操作
   - `_selectPoolByStrategy()` 和 `_selectRoundRobinProvider()` 改为async，使用Redis计数器
   - `initialize()` 中初始化Redis连接
3. 环境变量配置: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_KEY_PREFIX`
4. 支持降级：Redis不可用时自动降级到内存模式

---

## 账号路由策略问题 (Account Routing Issues)

### 4. 账号过滤顺序可能导致性能问题

**位置**: `provider-pool-manager-db.js:593-633`

```javascript
// 2. 从数据库读取提供商列表
const providers = await providerDao.findAll(providerType, { includeDeleted: true });

// 3. 过滤健康且未禁用的提供商
let availableProviders = providers.filter(p => p.is_healthy && !p.is_disabled && !p.is_deleted);

// 4. 如果指定了模型，排除不支持该模型的提供商
if (requestedModel && availableProviders.length > 0) {
    availableProviders = availableProviders.filter(p => {
        if (!p.not_supported_models || p.not_supported_models.length === 0) {
            return true;
        }
        return !p.not_supported_models.includes(requestedModel);
    });
}

// ... later ...

// 7. 根据池子过滤
const providersByPoolId = new Map();
for (const provider of availableProviders) {
    const providerPoolId = this._resolveProviderPoolId(provider, providerType, pools);
    if (!providersByPoolId.has(providerPoolId)) {
        providersByPoolId.set(providerPoolId, []);
    }
    providersByPoolId.get(providerPoolId).push(provider);
}
```

**问题**:
- 从数据库加载所有提供商（包括已删除的），然后在内存中过滤
- 如果提供商数量很大，会影响性能
- 应该在数据库查询层面就过滤掉不需要的记录

**状态**: [x] 已修复

**修复方案**:
1. 新增 `providerDao.findAvailable()` 方法，SQL层面直接过滤：
   - `is_healthy = TRUE`
   - `is_disabled = FALSE`
   - `is_deleted = FALSE`
   - 同时支持 `requestedModel` 参数过滤不支持的模型
2. 新增 `providerDao.findScheduledRecovery()` 方法，只查询需要恢复的账号
3. 重构 `_checkAndRecoverScheduledProviders()` 使用优化查询
4. `selectProvider()` 改用 `findAvailable()` 替代 `findAll() + 内存过滤`

**性能提升**:
- 1万账号场景：从加载全部 → 只加载可用账号（预计减少 50-80% 数据传输）
- 减少 JSON 解析开销
- 减少内存占用

---

### 5. 账号模型支持检查的逻辑缺陷

**位置**: `provider-pool-manager-db.js:603-610`

```javascript
if (requestedModel && availableProviders.length > 0) {
    availableProviders = availableProviders.filter(p => {
        if (!p.not_supported_models || p.not_supported_models.length === 0) {
            return true;  // 没有配置不支持模型列表，默认支持所有模型
        }
        return !p.not_supported_models.includes(requestedModel);
    });
}
```

**问题**:
- 只检查not_supported_models（黑名单），没有检查supported_models（白名单）
- 如果账号同时配置了黑名单和白名单，逻辑可能不一致
- 没有考虑池子级别的模型支持配置

**状态**: [x] 已修复

**修复方案（方案B：白名单优先）**:
```javascript
// 1. 如果有白名单(available_models)，模型必须在白名单中
if (availableModels && availableModels.length > 0) {
    if (!availableModels.includes(requestedModel)) {
        continue;
    }
} else {
    // 2. 没有白名单，检查黑名单
    if (notSupportedModels && notSupportedModels.includes(requestedModel)) {
        continue;
    }
}
// 3. 都没配置，默认支持
```

**逻辑说明**:
- `available_models`：健康检查时从 API 获取的实际可用模型（白名单）
- `not_supported_models`：手动配置的不支持模型（黑名单）
- 白名单优先：有白名单时只看白名单，没有才看黑名单

---

### 6. Least-Used策略的实现问题

**位置**: `provider-pool-manager-db.js:459-478`

```javascript
_selectLeastUsedProvider(providers) {
    // ...
    let bestUsage = Number.isFinite(best.usage_count) ? best.usage_count : 0;
    let bestLastUsed = best.last_used ? new Date(best.last_used).getTime() : 0;

    for (let i = 1; i < providers.length; i++) {
        const candidate = providers[i];
        const usage = Number.isFinite(candidate.usage_count) ? candidate.usage_count : 0;
        const lastUsed = candidate.last_used ? new Date(candidate.last_used).getTime() : 0;
        if (usage < bestUsage || (usage === bestUsage && lastUsed < bestLastUsed)) {
            // ...
        }
    }
}
```

**问题**:
- usage_count是累积值，永远递增，不会重置
- 长期运行后，所有账号的usage_count都会很大，差异变小
- 应该考虑时间窗口内的使用次数，或定期重置计数器

**状态**: [x] 已修复

**修复方案（方案D：改用 last_used 优先）**:
```javascript
// 改前：优先比较 usage_count
if (usage < bestUsage || (usage === bestUsage && lastUsed < bestLastUsed))

// 改后：优先比较 last_used（选最久未使用的）
if (lastUsed < bestLastUsed || (lastUsed === bestLastUsed && usage < bestUsage))
```

**优点**:
- 性能最好：不需要额外查询或定时任务
- 效果好：选最久未使用的账号 ≈ 使用次数最少，天然均匀分布
- 无累积问题：时间戳不会溢出

---

### 7. 池子策略选择的回退逻辑

**位置**: `provider-pool-manager-db.js:229-254`

```javascript
_selectPoolByStrategy(providerType, ruleKey, strategy, candidates, poolStatsById) {
    if (!candidates || candidates.length === 0) return null;
    const safeStrategy = strategy || 'priority';
    if (safeStrategy === 'random') {
        return candidates[Math.floor(Math.random() * candidates.length)]?.id ?? null;
    }
    if (safeStrategy === 'least-used') {
        // ... least-used logic
    }
    if (safeStrategy === 'round-robin') {
        // ... round-robin logic
    }
    return candidates[0]?.id ?? null;  // Default: priority (first candidate)
}
```

**问题**:
- 默认策略是'priority'，但实际上只是返回第一个候选池子
- 没有真正的优先级字段或排序逻辑
- 策略名称容易误导
- 没有显式处理'priority'策略，而是通过默认返回实现

**状态**: [ ] 待修复

---

## 请求处理层面的问题 (Request Handler Issues)

### 8. PoolId提取的优先级不明确

**位置**: `request-handler.js:54-68`

```javascript
function getPoolId(req, requestUrl) {
    const headerValue =
        req.headers['x-accounthub-poolid'] ||
        req.headers['x-accounthub-pool-id'] ||
        req.headers['x-account-hub-pool-id'] ||
        req.headers['x-pool-id'];
    if (headerValue) {
        // ... 返回header值
    }
    const queryPoolId = requestUrl.searchParams.get('poolId') || requestUrl.searchParams.get('pool');
    return queryPoolId ? String(queryPoolId).trim() : null;
}
```

**问题**:
- Header优先级高于Query参数，但没有文档说明
- 支持多个header名称，可能导致混淆
- 没有验证poolId的有效性（是否存在、是否有权限访问）

**状态**: [ ] 待修复

---

### 9. 缺少池子访问权限控制

**位置**: `request-handler.js:276-279`

```javascript
const poolId = getPoolId(req, requestUrl);
if (poolId) {
    currentConfig.POOL_ID = poolId;
}
```

**问题**:
- 直接使用用户提供的poolId，没有验证
- 没有检查用户是否有权限访问该池子
- 可能导致越权访问其他池子的账号

**状态**: [ ] 待修复

---

## 总结与建议

### 关键问题优先级

#### 高优先级:
- [ ] **#9** 池子访问权限控制缺失（安全问题）
- [ ] **#3** Round-Robin计数器在多实例环境下不一致
- [ ] **#6** Least-Used策略的累积计数问题

#### 中优先级:
- [ ] **#1** 渠道路由被用户指定poolId完全覆盖
- [ ] **#4** 账号过滤性能问题
- [ ] **#2** 池子模型支持检查的备选逻辑

#### 低优先级:
- [ ] **#7** 策略命名和文档问题
- [ ] **#8** PoolId提取优先级文档化
- [ ] **#5** 账号模型支持检查逻辑完善

### 建议的改进方向

1. 添加池子访问权限验证机制
2. 考虑使用Redis等外部存储来同步Round-Robin计数器
3. 实现基于时间窗口的使用计数，或定期重置
4. 优化数据库查询，减少内存过滤
5. 完善模型支持检查的逻辑（同时考虑黑白名单）
