# dsh 0.2.0-rc.1 适配调研（本仓 0.2.0 适配轮）

日期：2026-09-29
对象：本机桌面端 `D:\DeepSeek Harness\`（`DeepSeek Harness.exe` `FileVersion 0.2.0-rc.1`）
本仓适配基线：dsh 0.1.7-rc.2

> 调研方式：0.2.0-rc.1 是二进制安装版，没有源码 diff 可读。本轮走
> 「解包 `resources/app.asar` → 调用宿主真实判定函数 → 真机闸实测」三步取证，结论均可复现。

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容闸判定口径 | **未变**（仍只认 peerDependencies） ⚠️ |
| 兼容区间 | **必须新增 0.2.0 clause**（唯一必改项） ⚠️ |
| 宿主 setList / hook 契约 | 未变 ✅ |
| `reviewer` 的 `outcome.result` 字段 | 未变（0.1.7-rc.2 起就是 `result`） ✅ |

## 二、失效证据（真机启动闸 stderr，修复前）

本插件在 **web 与 desktop 两个 profile 同时失效**，整个 bundle 不加载：

```
dsh: skipping profile bundle "dsh-skill-curator": Error: Plugin dsh-skill-curator@0.1.7-rc.2
is incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh-llm":">=0.1.2-alpha.3
<0.1.8 || ...", "@deepseek-ai/dsh-settings":..., "@deepseek-ai/dsh-subagent":..., "@deepseek-ai/dsh-tools":...}.
```

## 三、重要订正：`dsh.engines.dsh` 是死声明

全树 grep 确认 0.2.0-rc.1 里**没有任何 `dsh.engines` 的消费者**。判定函数
（`dsh-app-boot/lib/index.js:286-313` 的 `evaluatePluginCompatibility`）**只遍历
`peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目**（`:294`），
判据是 `semver.satisfies(runtime, range, { includePrerelease: true })`（`:300`）。

→ **peer 决定插件生死；`engines` 只影响 pnpm 安装期。** 两者必须逐字一致。
本仓 4 个 dsh-* peer 与 `engines` 现已由测试守护逐字一致。

## 四、两种 semver 模式（本轮实测订正）

| | 规则 | 谁在用 |
|---|---|---|
| 严格模式（默认） | 纯比较器 **AND** 预发布可见性规则 | `pnpm install` |
| 宿主闸模式 | **纯比较器**，可见性规则被绕过 | `dsh-app-boot:300`（决定加载） |

可见性规则 = 「预发布版本只被区间内含同 `[major,minor,patch]` 元组的预发布所满足」。
`includePrerelease: true` 绕过它，于是**上界自身的预发布也被放行**：

| 运行时 | 严格（pnpm） | 宿主闸（加载） |
|---|---|---|
| `0.1.8-rc.1` | ❌ | **✅** |
| `0.3.0-alpha.0` | ❌ | **✅** |
| `0.2.0`（正式版） | ✅ | ✅ |
| `0.3.0`（正式版） | ❌ | ❌ |

**推论**：上界 `<0.3.0` 拦的是 `0.3.0` **正式版**，**不拦** `0.3.0-*` 预发布。
若要连预发布一起拒，上界须写成 `<0.3.0-0`。本轮保持 `<0.3.0`（与家族其余插件一致）。

验证：用宿主自带 semver 7.8.5 对 280 个版本比对「宿主闸模式」与「纯比较器」模型——零分歧。

## 五、改动清单

1. `package.json`：版本 `0.1.7-rc.2` → `0.2.0-rc.1`；`dsh.engines.dsh` 与 4 个 dsh-* peer
   各追加 `|| >=0.2.0-alpha.0 <0.3.0`；devDeps 从 `^0.1.5-rc.1` 改为精确 `0.2.0-rc.1`
   （去掉 caret，避免被 dsh 的旧依赖树牵连降级）。
2. `test/entry.test.mjs`：
   - 判定表从 14 行扩到 19 行，把原先「0.2.0 = false」翻转为覆盖（未验证→已验证，有意翻转）；
   - 新增旧三段区间的 0.2.0 反证；
   - 新增「4 个 peer 区间必须与 `dsh.engines.dsh` 逐字一致」断言；
   - semver 交叉验证的解析路径修正为 pnpm 实际落点
     （`node_modules/.pnpm/semver@<ver>/`），**此前该步一直静默跳过**。
3. `pnpm-workspace.yaml`：`minimumReleaseAgeExclude` 从 0.1.5-rc.1 批刷到 0.2.0-rc.1。
4. `README.md` / `README.zh-CN.md`：声明区间文本更新。

**未改**：`src/*`、`lib/client.js`、`cordis.patch.yml` —— 运行期契约无漂移。

## 六、测试与验证

- `node --test test/*.test.mjs`：**87 例全绿**；`test/smoke.mjs` 11 组通过；
  `test/client-smoke.mjs` 8 组通过。
- `test/entry.test.mjs`：11 组守护通过，判定表 19 行 × 宿主真实 semver 交叉验证一致。
- 测试现运行在 **0.2.0-rc.1 真实开发依赖**下（devDeps 真升级）。
- 宿主真实判定函数：`evaluatePluginCompatibility(<本仓 manifest>, {}, '0.2.0-rc.1')` → `undefined`（放行）。
- 真机 profile 加载：desktop 与 web 的 `skippedBundles` **均已归零**。

## 七、诚实缺口

1. `src/` 的运行时行为只做了源码级比对，**未在真机上跑一次完整的策展子代理回合**——
   建议手动触发一次策展并确认 SKILL.md 写入正常。
2. 判定表中「上界预发布」的行为是**推导 + 宿主真实 semver/判定函数实测**得出，
   未安装对应历史宿主真机验证。
