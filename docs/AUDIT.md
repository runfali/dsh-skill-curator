# dsh-skill-curator 审计报告

> 审计时间：2026-09-01 · 审计对象：v0.2.0（commit 52b62c8，dsh 0.1.2-alpha.3 适配收尾后）
> 方法：代码级逐文件通读（host 9 模块 + client bundle + 8 测试文件）+ 契约级源码对照（dsh-settings / dsh-tools / dsh-subagent / dsh-llm / dsh-commands / dsh-agent / dsh-agent-loop / webServer）+ 测试执行（60/60 + smoke 11 groups 全绿）

## 一、总体结论

**无 P0/P1**；发现 2 个 P2、3 个 P3。测试 60 项 + smoke 11 组全绿；entry-smoke 以 `test/apply.test.mjs` 形式入库（真实加载 src/index.js + mock ctx 驱动全链路）——五仓中测试纪律最好。

## 二、契约级核实（通过 ✅）

| 契约点 | 核实结果 |
|---|---|
| `settings.installSection` | 同前几仓，接线一致 ✅ |
| `agent/created` 载荷带 agent | dsh-agent `announce()` 真实 emit `{agent}`（lib/index.js:669）✅；插件在 agent 级 `agent.ctx` 上注册 `agent/turn-stopping`（载荷 `{turn, signal}` 无 agent 字段，注释准确）✅ |
| `commands.register` 返回契约 | dsh-commands `normalizeResult`：kind 必须 success/error，success 可带 text/sourceEventSeq，error 必须非空 text——插件返回 `{kind:'success', text}` ✅ |
| `subagents.start` + `settleRun` | dsh-subagent 真实导出；settleRun 语义：aborted 无 diagnostic → killed；有 diagnostic → failed；completed 带 output ✅（测试 mock 已对齐 alpha.3 语义） |
| `llm.registerAdapter` | dsh-llm 真实存在，provider 路由可注册自定义 adapter；`attributionHeaders` 导出确认 ✅ |
| `defineTool` + skill-library-* 六工具 | 白名单 `TOOL_NAMES` 与工具注册名一一对应 ✅；`isConcurrencySafe` ✅ |
| `webServer.register` exact 路由 + 同源守卫 | 与 config-center 同款守卫（loopback-only 更严）✅ |

## 三、发现的问题

### 🟠 P2-1 `reviewLog` 模块级单例 + `config.historyPath` 覆盖无效

- **事实**（`src/index.js:53-68`）：`reviewLog` 是模块级单例，apply 时 `config.historyPath` 若与当前 path 不同，**只打日志「下次启动生效」**——本次运行的覆盖配置不生效。
- **影响**：用户在 patch config 里设了 `historyPath`，本进程内不生效（历史仍写默认路径）；重启后才生效。行为可接受（有日志），但体验割裂。
- **修复**：apply 时若 `config.historyPath` 不同，用新路径重建 store（`createHistoryStore` 重载）或文档明确「需重启」。

### 🟠 P2-2 评审触发计数按 agent 而非按会话

- **事实**（`src/index.js:179-194`）：`agent/created` 时 `createCounter()`，`agent/turn-stopping` 时 `counter.bump()`。同一会话若 agent 被 dispose 重建（如 `/compact`、会话恢复），计数清零重计。
- **影响**：压缩/恢复后触发间隔被重置，评审频率略低于预期；非缺陷但属行为漂移。
- **修复**：可选——把计数挂到 session id（Map<sessionId, counter>），agent 重建时继承。

### 🟡 P3 杂项

| # | 问题 | 说明 |
|---|---|---|
| P3-1 | `digest.js` 的 `assistantMaxChars`/`userMaxChars` 截断用 `slice`（码元） | 会切半 emoji 代理对；摘要场景低影响，建议 `Array.from` 码点截断 |
| P3-2 | `custom-adapter` 非流式端点假设 | `streamChunksFromOpenAi` 只处理一次性 `choices[0].message`（非 SSE）；若自定义端点返回流式/分块响应会解析失败——README 已注明「OpenAI 兼容 /chat/completions 非流式」，可接受 |
| P3-3 | `reviewer.js` 回退判定正则含 `404` | `HTTP 404` 命中端点失败回退（模型不存在），但也可能把「工具 404」误判——toolFilter 白名单下子代理无其他工具，风险低 |

## 四、行为模拟与极端输入

- 触发链路：agent/created → turn-stopping ×N → scheduleReview（互斥 running WeakSet、子代理排除、enabled=false 不触发、interval 动态生效）——apply.test 覆盖 ✅
- 失败路径：start 抛错（端点特征 → 回退主模型；非端点 → 上抛）→ settleRun 失败（killed → 回退；failed+端点特征 → 回退）→ 有限重试（reviewRetryCount，非端点失败不重试）——reviewer.test 覆盖 ✅
- 历史持久化：原子写、上限 50、损坏容错——history-store.test 覆盖 ✅
- 写盘守卫：越界防护（assertInside）、SKILL_ID 校验、产权守卫（managed/adopt 才可写）、frontmatter 盖章——skill-tools.test 覆盖 ✅

## 五、处置

无 P0/P1。P2-1/P2-2 建议修复；P3 顺手。修复后按停止线开新一轮复核（换角度：持久化自引用环、并发评审互斥、卸载还原）。

> ## 修复记录（2026-09-01 执行后追加）
> - **P2-1 已修复**（commit 1c3fc01）：`reviewLog` 改 `export let` + `createReviewLog` 工厂，apply 检测 historyPath 差异即重建 store 立即生效；补回归。
> - **P2-2 已修复**：计数改 `countersBySession` Map（sessionId 键），agent 重建继承；补回归。
> - **P2-2 竞态修复**（复盘轮 f149f55）：stale agent disposed 仅在本 agent 首次创建且引用相等时清理，不误删继承计数；补回归。
> - 复核轮未清零项：P3-1 digest 码元截断（低影响，摘要场景）；P3-2 非流式端点假设（README 已注明）。
