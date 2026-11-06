# dsh 0.2.2-rc.1 适配调研

日期：2026-11-06
对象：桌面端 `D:\DeepSeek Harness\`，运行时包 `@deepseek-ai/dsh-desktop-runtime` **0.2.2-rc.1**
（dsh 版本只读 `resources/app.asar/dsh/package.json`；exe 的 `FileVersion` 是 Electron `44.7.0`，不是 dsh 版本）
本仓适配基线：0.2.1-rc.2（上一轮）

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容区间 | 4 个 dsh-* peer 与 `dsh.engines.dsh` 各追加 `\|\| >=0.2.2-alpha.0 <0.3.0` |
| `src/*` / `lib/client.js` / `cordis.patch.yml` | **零改动** |
| schemastery | peer `~3.18.4 \|\| ~3.19.0`，devDep pin `3.19.0`（宿主自带 3.19.0） |
| cordis 夹具 | 随 dsh 依赖升到 **4.1.0**，与宿主一致 |
| 真闸 | `0.2.2-rc.1` **PASS**，`0.3.0` **REJECT** |
| 测试 | 221 例全绿 / **0 跳过**（全套 entry + 单测 + smoke + client-smoke + preset） |

## 二、方法面 diff（为什么不改代码）

对 0.2.1-rc.2（旧夹具）与 0.2.2-rc.1（宿主实装）逐类比对方法名：

- `LlmAdapter`：7 个方法两边完全一致
  （`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `imageRequestTarget` /
  `listModels` / `resolveModel` / `prepareCall`）→ 0.2.1 的"抽象基类新增方法"类 P0 不复发。
- `SubagentRuntime`：20 个方法两边完全一致（含 `startActivation`，仍无 `start`）。
- 包根导出：`settleRunResult` / `attributionHeaders` / `defineTool` 仍在；
  `settleRun` 仍不在 `dsh-subagent` 根（内联结算继续是唯一活路）。

夹具升级后全套测试**一次通过，零夹具漂移**——这也是"零改码"的独立证据：
旧依赖下的绿不算数，新依赖下的绿才算。

## 三、pnpm 发布冷却期

`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 追加 **278 条** `@deepseek-ai/*@0.2.2-rc.1`
（从 `dsh-prompt-injector` 同轮清单取并集，重复项已去重）。漏这一步，`pnpm install` 会卡在
"新版本刚发布、冷却期未过"而不是卡在判定闸。

## 四、schemastery 3.19.0 的双重坑

宿主 0.2.2 自带 `@deepseek-ai/schemastery` **3.19.0**，`dsh-settings@0.2.2-rc.1` 的 peer 是 `~3.19.0`。

只改 peer 不够：pnpm 会**自动装 3.18.4** 满足旧的 `~3.18.4`，于是本地测试全部跑在旧夹具上，
"绿"没有意义。处置：

1. peer 写析取 `~3.18.4 || ~3.19.0`（兼容旧宿主安装）；
2. devDependencies **显式 pin** `3.19.0`；
3. 装完确认 `.volatile()` 契约仍成立（`test/entry.test.mjs` 的 volatile 计数断言覆盖）。

## 五、顺手修掉的假绿守护

`test/entry.test.mjs` 的 `inject` 服务名核验原写法：

```js
const HOST = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
```

该绝对路径在本机（Windows）从不存在 → `hostChecked` 恒为 0 → 走 `ok('宿主源码不可读，跳过…')`
分支。**这条守护自诞生起从未真正执行过**，属"静默跳过 = 假绿"。

改法：从 devDependencies 解析包入口（`req.resolve('@deepseek-ai/dsh-settings')`），
并用 `super(<任意上下文变量>, "<服务名>")` 匹配。注意 0.2.2 把变量名从 `ctx` 改成了
`ownerContext`（`dsh-settings/lib/index.js:330`）——写死 `super(ctx, "settings")` 会把正常
注册误报成漂移。改完 `hostChecked === 2`，断言升级为硬失败（不再允许静默跳过）。
`dsh-tools` 侧的注册点是 `super(ctx, "tools")`（`:417`）。

## 六、判定闸（0.2.2-rc.1 行号）

`dsh-app-boot/lib/index.js`：

- `:1097-1116` `unmetRequirements()`：顶层 `engines.dsh` 存在则单独判定、peers 被忽略；否则逐条 peer。
- `:1094` `satisfies()` 带 `{ includePrerelease: true }`。
- `:1129` `evaluatePluginCompatibility()`，返回 `undefined` = PASS。
- `:1089` `getDshRuntimeVersion()`。

严格 vs 宿主闸实测（宿主自带 semver）：

| 版本 | 旧五段 strict | 旧五段 host | 新六段 strict | 新六段 host |
|---|---|---|---|---|
| 0.2.2-rc.1 | false | **true** | true | true |
| 0.2.2-alpha.0 | false | true | true | true |
| 0.3.0 | false | false | false | false |

⇒ 不补也能加载，补的理由是 **pnpm 安装期严格 semver**。

## 七、验证命令

```powershell
cd D:\DSH\dsh-skill-curator
npm test                                                  # 221 绿 / 0 跳过
node D:\DSH\_tools\gate-manifest-022.mjs .\package.json   # VERDICT: PASS
```
