# Install / Start / Uninstall Evidence (Disposable Profile)

> 一次性 Profile 安装、启动、全链路验证证据。初版 2026-09-10（dsh **0.1.5-rc.1** 适配轮），
> 隔离 `DSH_HOME` + 独立端口，**未触碰任何已部署的 dsh 实例**（线上 3080 全程 mtime/状态核对未变）。

## Environment

| Item | Value |
|---|---|
| dsh host | @deepseek-ai/dsh **0.1.5-rc.1** |
| Node.js | v24.19.0 |
| pnpm | 11.22.0（由 `dsh plugin` 转发） |
| 隔离 home | `DSH_HOME=/tmp/dsh-iso15`（绝不写 /root/.dsh） |
| 隔离端口 | 3099 / 3101 / 3102 / 3105–3109（线上 3080 不动） |
| 被测插件 | dsh-skill-curator **0.1.5-rc.1**（本地目录安装） |
| 插件依赖副本 | @deepseek-ai/dsh-{llm,settings,subagent,tools} **0.1.5-rc.1** + schemastery 3.18.2 |

## Manifest compatibility declaration

`package.json` 中的机器可读声明：

```jsonc
"engines": { "node": ">=22" },
"dependencies": {
  "@deepseek-ai/dsh-llm": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-settings": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-subagent": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-tools": "^0.1.5-rc.1",
  "@deepseek-ai/schemastery": "^3.18.2"
},
"dsh": {
  "engines": { "dsh": ">=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

- **DSH 区间析取是承重的**：npm semver 只从「区间组自身含同 `[major,minor,patch]` 元组预发布」的组里满足预发布，故单区间 `>=0.1.2-alpha.3 <0.2.0` **覆盖不了 `0.1.5-rc.1`**。`test/entry.test.mjs` 用 10 行判定表 + 反证（改回旧区间即红）+ 宿主真实 `semver.satisfies` 交叉验证钉住。
- **运行时依赖钉在发布号**：四个 `@deepseek-ai/dsh-*` 全部 `^0.1.5-rc.1`（家族惯例：版本号跟宿主发布号）。插件是 bundle 宿主入口，这些是真运行时依赖（不是 peer）——settings/tools/subagent 是注入面，dsh-llm 供 `attributionHeaders`。
- **依赖卫生**：无 `install`/`postinstall`/`prepare` 等安装脚本；依赖树纯 JS、无 gyp/原生编译；依赖面仅 `@deepseek-ai/*`（`test/entry.test.mjs` 守护）。

## 1. Install（隔离实例）

```console
$ DSH_HOME=/tmp/dsh-iso15 dsh --profile iso --from-default-profile web --dump-config
（自 web 模板初始化独立 profile）

$ DSH_HOME=/tmp/dsh-iso15 dsh plugin --profile iso add /data/dsh-workspace/dsh-skill-curator
dependencies:
+ dsh-skill-curator link:/data/dsh-workspace/dsh-skill-curator
Done in 1.7s using pnpm v11.22.0
```

挂载三面（装 ≠ 挂：只有声明 `dsh.bundle.patch` 的包才进组合树）：

```jsonc
// profiles/iso/package.json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-skill-curator"
], "patchReload": "live" } }
```

```yaml
# dsh --profile iso --dump-config 末层
- id: skill-curator
  name: dsh-skill-curator
  config:
    skillsRoot: ''
```

## 2. Start

```console
$ DSH_HOME=/tmp/dsh-iso15 setsid nohup dsh --profile iso --port 3109 --no-open --host 127.0.0.1 > run.log 2>&1 < /dev/null &
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3109/
401   # 宿主 trust fence 生效（无 cookie 拒绝）
```

启动日志零插件加载错误（`grep -iE 'error|fail|curator|pending' run.log` 无输出）。

## 3. 真机全链路验证（隔离实例实测输出）

| # | 检查项 | 方法 | 实测结果 |
|---|---|---|---|
| E2E-1 | **挂载层** | `--dump-config` 末层出现 `id: skill-curator` | ✅ |
| E2E-2 | **前端下发** | 首页 `__DSH_BOOT__` entries 含 `dsh-skill-curator` | ✅ 54 条 entries 中在列 |
| E2E-3 | **client bundle** | 从 HTML 抠 combo URL 再 curl | ✅ 200 / 30788 B / `id: "dsh-skill-curator"` 工厂在列 |
| E2E-4 | **settings 命名空间** | `settings/describe` RPC | ✅ `skill-curator` 在列；`enabled=true, skillNudgeInterval=3, notifyMode=on`；`base={skillsRoot:""}`；14 键 |
| E2E-5 | **斜杠命令注册** | `session/create` → `commands/list {agentId}` | ✅ `skill-refine` 在 4 条命令中，descriptor 文本正确 |
| E2E-6 | **host 服务注册** | `pluginInventory/list` | ✅ `skill-curator` 在设备清单中 |
| E2E-7 | **状态接口** | `GET /api/skill-curator/status` | ✅ 200 + `{"ok":true,"name":"skill-curator","version":"0.1.5-rc.1","enabled":true,"interval":3,"reviews":[]}` |
| E2E-8 | **同源守卫** | 伪造 `Host: example.com` 打状态接口 | ✅ 403（跨源拒绝，loopback-only） |
| E2E-9 | **skill-library-* 工具** | 工具注册面（见下「诚实缺口」） | ⚠️ 未用 RPC 直接枚举（链路上无 tools/list 端点） |

**RPC 探针坑（0.1.5-rc.1 实测，都是「看着像插件坏」）**：

- 客户端 RPC 信封是 `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args:{…}}}`；
  **`payload` 必须恰好一个 plain object `args` 键**，平铺字段会被网关拒：
  `gateway/arguments-invalid: Remote payload must contain exactly one plain-object args field`。
  端点 URL 是 `POST /api/<ns>/<method>`。
- 首次访问要**先走一次 token 交换（303）拿 cookie**，否则一律 401。
- `commands/list` 按描述符要求 `{agentId}`，须先 `session/create` 拿 sessionId。
- 裸 `curl /plugins/<包名>/client.js` 返回 404 ≠ 未部署——bundle 走 combo URL（`/plugins/??<id>/client.js&rev=…`）。

## 4. Uninstall（隔离实例）

```console
$ DSH_HOME=/tmp/dsh-iso15 dsh plugin --profile iso remove dsh-skill-curator
```

隔离 home 整目录 `rm -rf`，线上 `/root/.dsh` 全程未写：

| 文件 | 动测前 mtime | 动测后 mtime |
|---|---|---|
| `/root/.dsh/settings.yaml` | 2026-09-10 21:08:40 | **2026-09-10 21:08:40（未变）** |
| `/root/.dsh/.credentials.yaml` | 2026-09-10 10:25:53 | **2026-09-10 10:25:53（未变）** |
| `/root/.dsh/skill-curator/reviews.json` | 2026-09-10 14:52 | **2026-09-10 14:52（未变）** |

线上实例 `curl 127.0.0.1:3080` → 401（健康，未受影响）。

## 5. 诚实缺口

- **E2E-6 用 pluginInventory 代替 tools/list**：0.1.5-rc.1 的 HTTP RPC 面**没有** tools/list 端点（会话级工具面由会话上下文投影，非独立 RPC）。
  故 skill-library-* 六件工具的注册以**单元/集成层**证据为主：`test/smoke.mjs` 用宿主真实 `defineTool` 编译 6 个定义并断言白名单一一对应；
  `test/apply.test.mjs` 用真实 `dsh-tools` 走 apply 注册并用 stub 驱动执行。真机侧只证到「host 半已挂载并执行 apply」（pluginInventory + status 接口 + 命令注册三证）。
- **未做真 LLM 端到端触发**（3 轮对话自动起评审子代理）：需要真实模型调用与多轮交互，隔离实例未跑；
  评审链路以 `reviewer.test.mjs`（mock subagents，覆盖回退/重试/settleRun 形状）为证据。
- **client 渲染**未在真实浏览器验证：以 `client-smoke.mjs`（真实组件树执行 + hooks 键转换 + save 流程）为证据。
