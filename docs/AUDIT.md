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

---

# 第三轮：适配 dsh 0.1.7-rc.2（2026-09-28）

> 审计对象：v0.1.7-rc.2（适配轮）· 宿主：`@deepseek-ai/dsh 0.1.7-rc.2`（Node v24）· 参考实现：`D:\DSH\dsh-prompt-injector`

**契约核查方法**：逐包读宿主实码（运行时无 `.d.ts`，结论全部以 `lib/index.js` 行号为准），关键节点另经直接 import 实跑（`defineTool` 编译、`attributionHeaders()`、schemastery `~standard.validate`）。

| 契约 | 0.1.7-rc.2 结论 | 处置 |
|---|---|---|
| `ctx.tools.register(defineTool(...))` 全字段 | 兼容（`dsh-tools/lib/index.js:838/848`，裸对象 `required:true` 仍支持） | 不改 |
| `subagents.start('spawn', …)` / `toolFilter.allow` / `settleRun` 形状 | 兼容（`dsh-subagent/lib/index.js:2720`、`dsh-base/cordis.patch.yml:351`） | 不改 |
| `agent/created` · `agent/turn-stopping` · `header.origin/delegationDepth` · `agents.list` · `commands` · `webServer` | 兼容 | 不改 |
| `agent.session.snapshotEvents()` | 兼容但已 `@deprecated`（`dsh-session/lib/index.js:1330`） | P2 迁移项（现可用） |
| `llm.registerAdapter` / `listProviders` / 鸭子方法面 / `attributionHeaders` | 兼容（六方法 0.1.5 与 0.1.7 逐条同名同序） | 不改 |
| **`settings.installSection`** | **已移除**（全库 874 个运行时 .js 零命中） | P0 重写 `src/settings.js` |
| **client `settingsScope`** | **已移除** | P0 改 `configForms.get(ns)` |
| **client 槽位 `settings.plugin.item`** | **已移除** | P0 改 `plugins.item`（list 槽：id/order/label thunk）+ `whileServed` |

**P0 修复**：
1. `src/settings.js`：`Config` 全字段 `.volatile()` 并从模块导出；`apply` 内 `settings.configure({auto:false}, ctx.fiber)`；`mergeDefaults()` 用 schema 默认值补宿主未注入的缺省键——**漏了它 `enabled` 会是 undefined，自动评审被静默关掉**（本轮实测：单测从 20/24 直接红）。
2. `src/index.js`：re-export `Config`（宿主按 `entry.fiber.runtime.Config` 枚举设置视图，不导出 = 插件页无入口）。
3. `lib/client.js`：`configForms` + `plugins.item` + `view==='summary'` 分支；`adoptSkills` → `excludedSkills`。
4. `package.json`：版本 `0.1.7-rc.2`；四个 `@deepseek-ai/dsh-*` 由 `dependencies` 移到 `peerDependencies`（宿主运行时是唯一事实来源），dev 保留本地副本；schemastery 提到 `~3.18.4`（`.volatile()` 3.18.4 才有）。

**同轮功能需求（发哥提出）**：
- **全库可改**：`writeGuard` 从「产权制」改为「保护名单制」——默认任何带 frontmatter 的 skill 均可增删改，只挡 `excludedSkills` 成员与无 frontmatter 文件。
- **先读后改**：`skill-library-read` 返回 sha256；`patch/write-file/delete` 必须回传 `expectedSha256`（缺了连 SDK 参数校验都过不了；对不上直接拒）。
- **新增 `skill-library-delete`**（第 7 个工具）：写前把整个技能目录备份到 `<DSH_HOME>/skill-curator/backups/`（保留 30 份）。
- **评审提示词改为减法优先**：第 0 档 = 删/合并/精简，再加篇幅契约（≤150 行；>250 行必须下沉 `references/`）与通俗条款；工具返回值在正文超阈值时附下沉提醒。

**验证**：`npm test` 全绿 —— 单测 71/71、smoke 11 组、client-smoke 7 组（覆盖 volatile 活引用、sha256 守卫、写前备份、删除、保护名单、0.1.7 槽位/服务接线）。

---

# 第二轮：适配 dsh 0.1.5-rc.1（2026-09-10）

> 审计时间：2026-09-10 · 对象：v0.1.5-rc.1（适配轮）· 宿主：@deepseek-ai/dsh **0.1.5-rc.1**
> 方法：**先证改动面**（隔离读新版宿主真实源码逐条对照契约，含依赖副本整段 diff）+ 代码级逐文件通读 + 隔离实例真机 E2E + 开发依赖真升级复跑 + 换角度复核轮。

## 零、先证改动面（不预设要改代码）

在隔离探针目录读 0.1.5-rc.1 宿主真实源码，把插件依赖的每个契约逐条对照：

| 契约 | 判据（宿主文件:行） | 结论 |
|---|---|---|
| `settings.installSection(owner,ns,schema,entry,hooks)` | `dsh-settings/lib/index.js:327-343`，与插件依赖副本 **0 diff** | **不变** |
| `ctx.tools.register(definition)` / `defineTool` 导出 | `dsh-tools/lib/index.js:2773-2781,3589`；`isConcurrencySafe` 仍定义(:878)并被调度读取(:2953) | **不变** |
| `agent/created` 载荷 `{agent}` / `agents.list()` / `agent/disposed` | `dsh-agent/lib/index.js:541,581,514` | **不变** |
| `agent.ctx` / `session.id` / `session.header.origin·delegationDepth` | `dsh-agent/lib/types/runtime-types.d.ts:149`；`dsh-session` types:117,81,87 | **不变** |
| `agent/turn-stopping` emit + 载荷 | `dsh-agent-loop/lib/index.js:967-970`（agent-scoped dispatch，`fused()` 注入 agent → 载荷 `{agent,turn,signal}`） | **不变**（插件注释过时，已更正） |
| `commands.register` handler 入参/返回 | `dsh-commands/lib/index.js:142-164,257`；invocation `{commandId,agent,rawInput,attachments,signal}`，结果 `{kind,text?}` | **不变** |
| `webServer.register({kind:'exact',path,handler})` | `dsh-host-webserver/lib/types/index.d.ts:30-38,90` | **不变** |
| `subagents.start` 字段 / `settleRun` 形状 / `getProvider·list` | `dsh-subagent` types:136-183；`run-settlement`→`JobOutcome{status,detail?,output?}`；`spawn` 由 dsh-base 注册且 `toolFilter:true` | **不变** |
| `llm.registerAdapter` / `attributionHeaders` 导出 | `dsh-llm/lib/index.js:1780,2326` | 签名不变，**adapter 方法面变严**（见 P1-1） |
| `session.snapshotEvents()` + 事件信封 + user/assistant/tool 形状 | `dsh-session` types:187,460-483,281,309,333 | **不变** |
| client：`locale.register`/`settingsScope.bind`/`slots.inject·register` + hooks→use<Name> | `dsh-client-locale/lib/client.js:1256`；`dsh-client-ui-settings` scope d.ts:139；`dsh-client-ui-renderer/lib/client.js:342-357`；`standardHookPropName`= `'use'+首字母大写`；`settings.plugin.item` 为 `kind:'keyed', scope:'root'` | **不变** |

**判据**：契约表全绿 → 宿主契约**零改动**。动作面收敛为：① 全字段版本区间（`dsh.engines.dsh` + 运行时依赖）；② 鸭子 adapter 的方法面（P1-1）；③ 自定义路由的注册生命周期（P1-2，换角度审计抓到）。

## 一、发现与修复

### 🔴 P1-1 adapter 缺 `imageRequestPricing` → token 计量 TypeError

- **事实**：`src/custom-adapter.js` 的 adapter 是**鸭子对象**（非 extends LlmAdapter）。宿主 `dsh-llm/lib/index.js:1996-1998` 存的是原对象并在调用期直接取 `adapter.imageRequestPricing(...)`——**无 optional-call 保护**。抽象类只有 `stream()` 是 abstract，其余六个方法（providerInfo/providerRetryPolicy/**imageRequestPricing**/listModels/resolveModel/prepareCall）由基类给默认实现——**鸭子对象拿不到**。
- **调用链**：`dsh-token-meter` 的 `measure()`(:646) **无条件** `_routeImagePricing()`(:688-691) → `llm.imageRequestPricing()` → `adapter.imageRequestPricing()`。
- **复现（实测）**：
  ```
  facade THREW: TypeError: registry.get(...)?.adapter.imageRequestPricing is not a function
  ```
- **影响分级**：走自定义端点评审过的子代理，其 session 头部**长存**该路由，之后每次计量都会炸。`agent/pre-step` 的压实路径有 try/catch → 每步刷 `step compaction failed`、该子代理自动压实**静默失效**；`compactNow()`(:951) 与 dsh-acp 计量路径无兜底 → **直接抛**。
- **修复**：`createCustomAdapter` 返回对象补 `imageRequestPricing() { return undefined }`（与基类默认语义一致：本路由不声明图片计费）；并把文件头「六个方法」说明改为「基类全体方法必须逐个自备」。
- **回归**：`test/reviewer.test.mjs` 新增两组 —— ① adapter 面守护（静态七方法存在 + 与宿主真实 `LlmAdapter.prototype` 方法名集合逐名对齐，宿主不可解析则显式跳过）；② 反证（删掉该方法即复现宿主 TypeError）。
- **诚实说明**：该缺口在 0.1.2-alpha.3 依赖副本里**同样存在**（两侧 `imageRequestPricing` 调用点逐行相同）——不是 0.1.5 新引入的断裂，而是**从未被发现的存量缺陷**，本轮换角度审计才抓到。属「声明适配轮顺带清零存量 P1」。

### 🔴 P1-2 adapter 注册缓存用「注册过一次」当「仍挂载」→ 插件重载后自定义端点评审 100% 失败

- **事实**（`src/reviewer.js` 原 `ensureCustomAdapter`）：模块级 `customAdapters: Map<route, adapter>` 只做存在性判断——`if (customAdapters.has(route)) return`。
- **根因**：宿主 `registerAdapter` 的**服务代理把 `this.ctx` 绑到调用方 fiber**（cordis `Service` 语义），返回 handle 是 `ctx.effect(...)` 的 disposer，`yield` 里 `adapters.delete(provider)`——**本插件 fiber 卸载（profile `patchReload: live` 的 patch 热重载 / 卸载重挂）时路由被宿主自动摘掉**。而模块级 Map 不受 fiber 生命周期约束，仍留着过期条目 → 同进程重新 apply 时直接 return、**永不重注册**。
- **复现（实测）**：
  ```
  after 1st ensure: routes = [ 'skill-curator-review' ]
  after unload   : routes = []
  after 2nd ensure: routes = []   <-- BUG if empty
  RESULT: route MISSING -> custom-endpoint reviews would fail to resolve provider
  ```
- **影响**：「首次评审后发生过一次插件重载」的进程里，所有自定义端点评审的 provider 路由解析失败（回退主模型兜住 → 用户只看到「⚠️已回退主模型」，不会想到是路由注册问题）。
- **修复**：判据从「注册过一次」改为「**当下仍挂载**」——用 `llm.listProviders()`（服务端权威读，dsh-llm `lib/index.js:1846`）核验 route 在列；不在列即重注册。`listProviders` 缺席（极简桩）时退回「已注册即存活」，不制造重注册抖动。新增导出 `canProbeRoutes`/`routeIsMounted`。
- **回归**：`test/reviewer.test.mjs` 新增两组 —— ① 卸载后必须重注册（且仍挂载时幂等）；② 反证（存活判据在宿主摘掉路由后必须为 false）。
- **修测试的保真度**：修复暴露了**两个测试桩失真**——它们用**不带 `llm`** 的 ctx 跑自定义端点路径，此前「通过」只是因为**跨用例的模块级缓存泄漏**掩盖了路由缺失。已给这些桩补上保真的 `llm`（含 `registerAdapter` + `listProviders`，与真实 dsh-llm 一致）。这正是 dsh-plugin-audit「夹具形状 ≠ 运行时形状」盲区的又一实例。

### 🟡 P3（承接上轮，未清零）

- P3-1 digest 码元截断（低影响，摘要场景）；P3-2 非流式端点假设（README 已注明）。

## 二、换角度复核轮（第二轮，新角度）

按停止线机制开第二轮，**不复核上一轮修复面**，换下列角度深挖：

| 角度 | 检查方法 | 结论 |
|---|---|---|
| 并发/乱序 | `running` WeakSet 互斥 + `countersBySession` 生命周期 | `.finally(done)` 保证任意异常路径释放锁；`agent/disposed` 清理计数（含 stale agent 引用相等守卫）✅ |
| 持久化自引用环 | history 记录字段与 `reviews.json` 上限 50 | 记录不含自身来源引用，无环 ✅ |
| 短路路径污染 | `scheduleReview` 的 catch/finally | 计数消耗在触发时（设计如此，配 `/skill-refine` 手动补跑）✅ |
| 只读端点 | status 路由 `GET/HEAD` + 同源守卫 | 真机伪造 Host → 403（E2E-8）✅ |
| 写盘安全 | `assertInside`/`writeGuard`/SKILL_ID | 越界、穿越、未托管写入均被拒（smoke 11 组）✅ |
| adapter 真实契约 | 七个方法返回值形状逐个核对宿主消费点 | **抓到 P1-1** |
| 生命周期/注册面 | 服务 fiber 绑定语义 + 路由存活 | **抓到 P1-2** |

**复核轮结论：新增 1 条 P1（route 存活，见上）——两个 P1 均由换角度审计在不同角度抓到（adapter 方法面 / 生命周期面），合计零 P0、零 P2。**

## 三、声明面（三面收敛 + 区间承重）

- 版本号跟发布号：`0.1.5-rc.1`；运行时依赖四个 `@deepseek-ai/dsh-*` 钉 `^0.1.5-rc.1`。
- `dsh.engines.dsh` = `>=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6`。**析取承重**：npm semver 只从「含同元组预发布」的组满足预发布，单区间覆盖不了 `0.1.5-rc.1`。
- **全字段审计**：本插件无 `peerDependencies` 版本区间（依赖是真运行时依赖），故「同一坑第二处」不适用；已逐个列出带版本区间的字段（`dsh.engines.dsh` / `engines.node` / `dependencies`）过判定表。
- 新增 `test/entry.test.mjs`：入口直载（P0 守卫）+ 声明面 + **10 行 engines 判定表** + 反证 + 宿主 `semver.satisfies` 交叉验证 + 服务名真实性 + **键集合一致性**（host Config ↔ client FIELDS，13 键）+ 依赖卫生。
- 键集合一致性：host schema 13 键 ↔ client FIELDS 13 键逐键相等；`notifyMode` 枚举三字面量三处一致。

## 四、开发依赖真升级 + 复跑

`rm -rf node_modules pnpm-lock.yaml` → 带代理 + 独立 store 重装 → **断言装到 0.1.5-rc.1**（四个包逐一核对）→ 全套测试在新依赖下全绿：**66 项 + smoke 11 组 + client-smoke 7 组**。
（旧依赖下跑的绿 = 未适配；本轮已排除该假绿。）

## 五、隔离实例真机 E2E

独立 `DSH_HOME=/tmp/dsh-iso15` + 独立端口（3099–3109），`dsh --profile iso --from-default-profile web` + `dsh plugin add`。完整 9 项见 `docs/EVIDENCE.md`；核心：挂载层 ✅ / boot entries ✅ / combo URL 200 + 工厂 id ✅ / settings 命名空间值正确 ✅ / `skill-refine` 命令在列 ✅ / 状态接口 200 ✅ / 同源守卫 403 ✅。线上 `/root/.dsh` 三个文件 mtime 全程未变。

## 六、诚实缺口

- 未做真 LLM 端到端触发（3 轮自动起子代理）——需真实模型与多轮交互；评审链路以 `reviewer.test.mjs` mock 为证据。
- skill-library-* 六工具的**真机**注册未用 RPC 直接枚举（0.1.5-rc.1 HTTP 面无 tools/list 端点），以 `smoke.mjs`（宿主真实 `defineTool` 编译）+ `apply.test.mjs`（真实 dsh-tools 走 apply）为证据。
- client 渲染未在真实浏览器验证；以 `client-smoke.mjs` 为证据。
- 子系统代理核查报出的两条「低危」经实测为**误报**，未采纳：① `truncateDigest` 被判「重复拼接」实为三元表达式（`(cond ? a : b) + suffix`），实测无重复片段；② client `cleared` 分支被判「徽标不消失」，实测清空→保存后 `overridden` 回落 false、`dirty` 归零。