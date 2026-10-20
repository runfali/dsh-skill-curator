# 吸收 dsh-learn 升级方案（dsh-skill-curator 0.2.1-rc.2）

> **For agentic workers:** 用 subagent-driven-development 或 executing-plans 逐任务实现。步骤用 `- [ ]` 跟踪。
>
> 本方案是 **architectural** 路径产物：先拿批准，再开工。批准前不写任何代码。

**Goal:** 把 dsh-learn 里真正有价值的两条机制吸收进 dsh-skill-curator：①技能使用观测 + 生命周期状态机（含归档/恢复/pin），②注册运行时 skill 让主会话模型知道这组工具怎么用；顺带修一个我们自己的名字正则缺口。

**Architecture:** 新增 `src/lifecycle.js`（纯函数状态机 + 原子 JSON 持久化），在 `src/index.js` 用 `tools/pre-execute` 做使用观测（内存更新 + 60s 节流落盘，**不引入 timer 服务**），生命周期迁移挂在既有评审流程上（**不加独立定时器**）。归档走 `<DSH_HOME>/skill-curator/archived/`，可恢复，**默认不自动归档**。新增一个白名单工具 `skill-library-lifecycle`，并把 `ctx.inject(['skills'])` 注册的运行时技能作为工具的用法说明书。

**Tech Stack:** Node ESM、cordis 插件契约、`@deepseek-ai/dsh-tools`（defineTool）、`@deepseek-ai/schemastery`、node:test。

**Spec:** 本文件。调研依据 `D:\DSH\_research\dsh-learn\REPORT.md`。

## Global Constraints

- **不改 dsh 源码**（硬红线）。只改本仓库。
- **零新增依赖**：`peerDependencies` 只允许 `@deepseek-ai/*`；不得引入第三方包、不得有安装脚本（`test/entry.test.mjs:276-284` 守护）。
- **不改 `cordis.patch.yml` 的行 id `skill-curator`**（设置命名空间 = 行 id）。
- **`inject` 保持 `['settings','tools']`**：不引入 `timer`。理由：生命周期迁移挂在评审流程上，避免改动 `test/smoke.mjs:20`、`test/entry.test.mjs:234-247` 两处服务面断言。
- **所有新增 Config 字段必须 `.volatile()`**（`test/entry.test.mjs:263-265` 守护：volatile 数必须等于字段数）。
- **host Config 键集合 ↔ `lib/client.js` FIELDS 键集合逐键相等**（`test/entry.test.mjs:261` 守护）。
- **归档目录必须在技能库之外**：`<DSH_HOME>/skill-curator/archived/`，绝不能放进 `<DSH_HOME>/skills/`（否则宿主 provider 会把归档技能当正常技能发现）。
- **默认不自动归档**（`archiveEnabled` 默认 `false`）：我们技能库 68 个技能且是 git 仓库，自动移动目录属破坏性动作，必须显式开启。

---

## 事实基线（本方案已实测核验，2026-10-20）

| 事实 | 证据 |
|---|---|
| 我们的 `SKILL_ID` 比宿主宽松 | `src/skill-tools.js:31` `/^[a-z0-9][a-z0-9-]*$/` vs 宿主 `dsh-skill/lib/index.js:17` `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`；`foo-`/`foo--bar` 我们放行、宿主拒收 |
| 收紧正则**零误伤** | `D:\DSH\_research\dsh-learn\tighten-impact.mjs`：现有 68 个技能目录，被新正则拒绝数 = 0 |
| 宿主发现技能时会校验名字 | `dsh-skill-filesystem/lib/index.js:685` `if (!isSkillName(name)) { logger.warn(...); return }` —— 静默忽略 |
| 宿主按 **名字** 排序取唯一赢家 | `dsh-skill/lib/index.js:314` `entries.sort(compareIndexedCandidates)` + `:519` `rank → providerOrder → localOrder` |
| 运行时技能 rank = 250，用户目录 rank = 400 | `dsh-skill/lib/index.js:21` `RUNTIME_RANK=250`；`dsh-skill-filesystem/lib/index.js:174` `USER_DSH_RANK=400` |
| `skills.register()` 契约 | `dsh-skill/lib/index.js:193-215`：只校验 `name` 匹配 SKILL_NAME、`description` 非空、`invocation` 可省；返回 disposer |
| **技能目录被 watcher 监听，热刷新** | `dsh-skill-filesystem/lib/index.js:172`（`join(dshHome,'skills')`）+ `:372` `chokidar.watch(...)` |
| **catalog 只渲染 name + description** | `dsh-tool-skill/lib/index.js:42-47` `catalogSourceEntries` 只取 `name`/`description`（上限 500 字符）—— `whenToUse` **不进**模型可见目录 |
| `tools/pre-execute` 签名 | `(exec, next)`，waterfall；`exec` 含 `name`/`arguments`/`agent`（`dsh-tools/lib/index.js:3143-3168`、`:3225`） |
| `tools/pre-execute` 有多个宿主先例 | `dsh-tool-jobs:235`、`dsh-experimental-auto-review:462`、`dsh-hooks-claude-code:248` |
| 宿主 0.2.1 无 `subagents.start` | asar 实测：`startActivation` 25 次、`async start(name, request)` 0 次 |
| 技能库是 git 工作树 | `C:/Users/Doctor/.dsh/skills`（`git rev-parse --show-toplevel`） |

---

## 设计决策（含被否方案）

| 决策 | 选择 | 理由 / 被否的替代 |
|---|---|---|
| 使用观测点 | `tools/pre-execute` 里判 `exec.name === 'skill'` | 否掉 `ctx.tools.guard()`：guard 语义是「同步拒绝」，且每个工具调用都跑；观测不该占用拒绝通道 |
| 落盘时机 | markUsed 更新内存 + **60s 节流**落盘；评审/状态接口读时强制落盘 | 否掉 `ctx.interval`：要 `inject:['timer']` 并改 2 处服务面断言；否掉「每次调用都落盘」：`skill` 可能高频 |
| 生命周期迁移触发 | **挂在既有评审流程上**（评审每 3 轮必跑） | 否掉独立 6h 定时器：同上的 inject 代价，且语义上「评审顺带维护生命周期」更自然 |
| 自动归档 | **默认关**（`archiveEnabled=false`）；默认只标 `stale` 并报告 | 否掉 dsh-learn 的「90 天自动归档」：我们的技能库是 git 回滚底座 + 68 个技能，自动移动目录是不可逆的破坏性动作，必须显式开 |
| `lastUsedAt` 初值 | `null`（从未使用），且「从未使用」有 `staleDays` 宽限期 | **明确否掉 dsh-learn 用文件 mtime 当 last_used**：mtime 是「最后修改」不是「最后使用」，这正是它生命周期空转的根因 |
| 归档位置 | `<DSH_HOME>/skill-curator/archived/<name>/` | 否掉放技能库内：宿主 provider 会把归档技能当正常技能发现 |
| pin 存哪 | `lifecycle.json` 数据（不是 Config） | pin 是数据不是配置；也避免再多一个 Config 字段 |
| 归档后是否可被工具读回 | `skill-library-list` 增列 archived；`skill-library-lifecycle` 支持 restore | 与 dsh-learn「归档可恢复，绝不删除」同义，但修掉它 `rmSync(dst)` 先删旧归档的缺陷 |
| 运行时技能关键信息放哪 | **全部进 `description`**（因为 catalog 只渲染 description），`whenToUse` 只作补充 | 实测 `catalogSourceEntries` 不渲染 whenToUse；照 dsh-learn 那样把用法只写进 whenToUse = 模型看不到 |
| 运行时技能名 | `skill-curator`（已核：技能库无同名） | 若日后有同名用户技能，rank 400 > 250，用户版胜出（不是报错，是遮蔽） |

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/skill-tools.js` | 改 | ①`SKILL_ID` 收紧对齐宿主；②`TOOL_NAMES` 加第 11 个；③新增 `skill-library-lifecycle` 工具定义 |
| `src/lifecycle.js` | **新建** | 使用观测存储 + 状态机迁移 + 归档/恢复/pin（纯函数为主，可单测） |
| `src/index.js` | 改 | ①`tools/pre-execute` 使用观测；②评审流程里跑生命周期迁移；③status 接口回显生命周期；④注册运行时技能 |
| `src/settings.js` | 改 | 新增 3 个 volatile 字段：`staleDays`/`archiveDays`/`archiveEnabled` |
| `src/runtime-skill.js` | **新建** | 运行时技能的 name/description/content 常量（可单测长度与必备信息） |
| `lib/client.js` | 改 | FIELDS + GROUPS + locale 增加 3 个字段的标签与提示 |
| `test/lifecycle.test.mjs` | **新建** | 状态机 + 观测 + 归档/恢复/pin 单测 |
| `test/smoke.mjs` | 改 | 工具数 10 → 11 |
| `test/apply.test.mjs` | 改 | 工具数/注册顺序/白名单长度断言 10 → 11；新增 pre-execute 观测与生命周期回显断言 |
| `test/entry.test.mjs` | 改 | Config 键数 13 → 16 |
| `test/client-smoke.mjs` | 改 | fieldKeys 增 3 项 |
| `docs/COMPARISON.md` | 改 | 记录本轮吸收与「不吸收」理由 |

---

## Task 1: 收紧 SKILL_ID 对齐宿主（一行修复 + 回归测试）

**Files:**
- Modify: `src/skill-tools.js:31`
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `SKILL_ID`（正则，仍导出，签名不变）

- [ ] **Step 1: 写失败测试**

在 `test/smoke.mjs` 的「3. 工具定义真实编译」之后追加：

```js
// 3b. SKILL_ID 必须与宿主 dsh-skill 的 SKILL_NAME 逐字等价。
// 背景：我们原来的 /^[a-z0-9][a-z0-9-]*$/ 比宿主宽松 —— `foo-` / `foo--bar`
// 我们能建、宿主 isSkillName() 拒收 → 技能落盘但被静默忽略（dsh-skill-filesystem:685）。
const HOST_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
assert.equal(
  tools.SKILL_ID.source,
  HOST_SKILL_NAME.source,
  'SKILL_ID 必须与宿主 SKILL_NAME 同源（否则能建出宿主看不见的技能）'
)
for (const bad of ['foo-', 'foo--bar', '-foo', 'Foo', 'a b']) {
  assert.equal(tools.SKILL_ID.test(bad), false, `SKILL_ID 必须拒绝 ${bad}`)
}
for (const good of ['fs-troubleshooting', 'a-b-c', 'f', '9', '9a']) {
  assert.equal(tools.SKILL_ID.test(good), true, `SKILL_ID 必须接受 ${good}`)
}
ok('SKILL_ID 与宿主 SKILL_NAME 同源（拒 foo- / foo--bar）')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/smoke.mjs`
Expected: FAIL —— `SKILL_ID 必须与宿主 SKILL_NAME 同源`（当前 source 是 `^[a-z0-9][a-z0-9-]*$`）

- [ ] **Step 3: 改实现**

`src/skill-tools.js:30-31` 改为：

```js
/**
 * skill 名合法格式。
 *
 * 必须与宿主 `dsh-skill` 的 `SKILL_NAME`（lib/index.js:17）**逐字同源**：
 * `dsh-skill-filesystem` 在 parseSkillFile 里用 `isSkillName()` 校验，
 * 不通过就 `logger.warn` 后**静默忽略**（lib/index.js:685）——技能写进磁盘却
 * 永远不出现在会话目录里，且零报错。原实现 `/^[a-z0-9][a-z0-9-]*$/` 比宿主宽松，
 * 会放行 `foo-` / `foo--bar` 这类宿主拒收的名字。
 * @see test/smoke.mjs 「SKILL_ID 与宿主 SKILL_NAME 同源」
 */
export const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smoke.mjs && node --test test/skill-tools.test.mjs`
Expected: PASS（含既有 68 个技能目录零误伤的旁证 `node D:\DSH\_research\dsh-learn\tighten-impact.mjs`）

- [ ] **Step 5: 提交**

```bash
git add src/skill-tools.js test/smoke.mjs
git commit -m "fix(names): SKILL_ID 对齐宿主 SKILL_NAME（拒 foo- / foo--bar，防静默不可见）"
```

---

## Task 2: 生命周期存储与状态机（纯逻辑 + 单测）

**Files:**
- Create: `src/lifecycle.js`
- Test: `test/lifecycle.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `defaultLifecyclePath()` → `string`（`<DSH_HOME>/skill-curator/lifecycle.json`）
  - `createLifecycleStore({ file, log })` → `{ snapshot(), markUsed(name), syncWith(root), transitions({ staleDays, archiveDays, archiveEnabled }), archive(name, root), restore(name, root), setPinned(name, pinned), summary(), flush(), get path() }`
  - `DAY_MS` → `86400000`

- [ ] **Step 1: 写失败测试**

新建 `test/lifecycle.test.mjs`：

```js
/**
 * dsh-skill-curator — 技能生命周期状态机单测。
 * 运行：node --test test/lifecycle.test.mjs
 *
 * 关键反例（来自 dsh-learn 的实测缺陷，见 _research/dsh-learn/REPORT.md 3.1）：
 * 「最后使用时间」绝不能拿 SKILL.md 的 mtime 当代理 —— 那是「最后修改」。
 * 本测试用「文件 mtime 很老、但 markUsed 刚打过」的技能钉死这一点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleStore, DAY_MS } from '../src/lifecycle.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-life-'))
  const root = join(home, 'skills')
  const file = join(home, 'skill-curator', 'lifecycle.json')
  // 必须把 DSH_HOME 指向临时 home：否则 archiveRoot 会落到真实的
  // ~/.dsh/skill-curator/archived，测试就把垃圾写进用户真技能库旁边
  //（执行期实测踩到，已清理）。
  process.env.DSH_HOME = home
  mkdirSync(root, { recursive: true })
  return { home, root, file, store: createLifecycleStore({ file }) }
}

function addSkill(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`)
  return dir
}

test('新技能被登记为 active，lastUsedAt 为 null（从未使用）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  const counts = store.syncWith(root)
  assert.equal(counts.seeded, 1)
  const rec = store.snapshot().skills['alpha-skill']
  assert.equal(rec.state, 'active')
  assert.equal(rec.lastUsedAt, null, '绝不能拿文件 mtime 当 lastUsedAt')
})

test('从未使用的技能在宽限期内不会被标 stale（反 dsh-learn 的空转缺陷）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  // 把登记时间推到 10 天前，但 staleDays=30 → 仍在宽限期
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 10 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 0, '从未使用 + 未过宽限期 → 不标 stale')
})

test('从未使用的技能超过宽限期才标 stale', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 40 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 1)
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'stale')
})

test('markUsed 后超过 staleDays 也不标 stale（mtime 老不算数）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  store.markUsed('alpha-skill') // 刚刚使用
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 0, 'lastUsedAt 是现在 → 不该 stale')
  assert.equal(counts.archived, 0)
})

test('超过 archiveDays 时：archiveEnabled=false 只标 stale，不动磁盘', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.archived, 0, '默认不自动归档')
  assert.equal(counts.wouldArchive, 1, '但要报告「够格归档」')
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')), '磁盘必须原样不动')
})

test('archiveEnabled=true 时才真的移动目录，且可 restore', () => {
  const { home, root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  // archiveFn 由调用方注入（保持「判定」与「执行」解耦），这里显式接上真实归档动作。
  const counts = store.transitions({
    staleDays: 30,
    archiveDays: 90,
    archiveEnabled: true,
    archiveFn: (n) => store.archive(n, root)
  })
  assert.equal(counts.archived, 1)
  const archived = join(home, 'skill-curator', 'archived', 'alpha-skill', 'SKILL.md')
  assert.ok(existsSync(archived), '归档到技能库之外')
  assert.equal(existsSync(join(root, 'alpha-skill')), false, '原目录已移走')
  assert.equal(store.restore('alpha-skill', root), true)
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')), 'restore 回到技能库')
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'active')
})

test('pinned 技能永不被标 stale 或归档', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  store.setPinned('alpha-skill', true)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 999 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: true })
  assert.equal(counts.markedStale, 0)
  assert.equal(counts.archived, 0)
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')))
})

test('落盘是原子的，且损坏文件按空表容错（绝不抛）', () => {
  const { file, store } = fixture()
  store.markUsed('ghost-skill')
  store.flush()
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(parsed.skills['ghost-skill'], 'markUsed 后落盘')
  writeFileSync(file, '{ not json')
  const reopened = createLifecycleStore({ file })
  assert.deepEqual(reopened.snapshot().skills, {}, '损坏 → 空表，不抛')
})

test('归档目标已存在时返回 false 且绝不覆盖（避开 dsh-learn 的 rmSync 缺陷）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  assert.equal(store.archive('alpha-skill', root), true)
  // 再次造同名技能并尝试归档：目标已存在 → 必须返回 false，且旧归档完好
  addSkill(root, 'alpha-skill')
  assert.equal(store.archive('alpha-skill', root), false, '目标已存在时不得覆盖')
  assert.ok(existsSync(join(store.archiveRoot, 'alpha-skill', 'SKILL.md')), '旧归档必须还在')
})

test('markUsed 节流：60s 内多次调用只落盘一次', () => {
  const { file, store } = fixture()
  const t0 = Date.now()
  store.markUsed('a-skill', { now: t0 })
  const firstMtime = readFileSync(file, 'utf8')
  store.markUsed('a-skill', { now: t0 + 1000 })
  store.markUsed('b-skill', { now: t0 + 2000 })
  const secondMtime = readFileSync(file, 'utf8')
  assert.equal(secondMtime, firstMtime, '60s 窗口内不再落盘')
  store.markUsed('b-skill', { now: t0 + 61_000 })
  assert.notEqual(readFileSync(file, 'utf8'), firstMtime, '过了窗口才落盘')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/lifecycle.test.mjs`
Expected: FAIL —— `Cannot find module '../src/lifecycle.js'`

- [ ] **Step 3: 写实现**

新建 `src/lifecycle.js`：

```js
/**
 * dsh-skill-curator — 技能生命周期状态机（使用观测 + active/stale/archived + pin）。
 *
 * 吸收自 dsh-learn 的「Hermes curator 同款生命周期」，但**修掉它的两处硬缺陷**
 * （取证见 D:\DSH\_research\dsh-learn\REPORT.md）：
 *   1. dsh-learn 的 `markUsed()` 是死代码（全文件只出现 1 次），`last_used_at` 只能由
 *      `SKILL.md` 的 mtime 兜底 → 所谓「30 天未用标 stale」实际是「30 天没改过文件」，
 *      天天被加载的技能照样归档。本实现把 lastUsedAt 初值设为 **null**，
 *      由真实的 `skill` 工具调用（tools/pre-execute）驱动。
 *   2. dsh-learn 的 dry-run 预览会真的 rename 目录（archiveSkillInner 改真 FS）。
 *      本实现把「判定」与「执行」分离：transitions() 返回 counts，归档动作只在
 *      archiveEnabled=true 时执行，且 dry-run 是默认。
 *
 * 存储：<DSH_HOME>/skill-curator/lifecycle.json（原子写 tmp+rename；损坏按空表容错）。
 * 归档目录：<DSH_HOME>/skill-curator/archived/<name>/（**技能库之外**，
 * 否则宿主 provider 会把归档技能当正常技能发现）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DAY_MS = 86400000

/** markUsed 的落盘节流窗口（毫秒）。 */
export const FLUSH_THROTTLE_MS = 60_000

/** 默认生命周期文件：<DSH_HOME>/skill-curator/lifecycle.json。 */
export function defaultLifecyclePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skill-curator', 'lifecycle.json')
}

/** 默认归档目录：<DSH_HOME>/skill-curator/archived。 */
export function defaultArchiveRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skill-curator', 'archived')
}

const emptyState = () => ({ skills: {}, lastPassAt: null })

/**
 * 创建生命周期存储。
 * @param {object} [opts]
 * @param {string} [opts.file] - 状态文件（缺省 defaultLifecyclePath()）。
 * @param {string} [opts.archiveRoot] - 归档根（缺省 defaultArchiveRoot()）。
 * @param {(level: string, message: string) => void} [opts.log] - 告警钩子。
 */
export function createLifecycleStore({ file, archiveRoot, log = () => {} } = {}) {
  const path = file || defaultLifecyclePath()
  const archivedRoot = archiveRoot || defaultArchiveRoot()

  let state = emptyState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.skills && typeof parsed.skills === 'object') {
      state = { ...emptyState(), ...parsed }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      log('warn', `skill-curator: lifecycle load failed (${(error && error.message) || error}); starting empty`)
    }
  }

  let lastFlushAt = 0

  function persist() {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
      lastFlushAt = Date.now()
      return true
    } catch (error) {
      log('warn', `skill-curator: lifecycle write failed: ${(error && error.message) || error}`)
      return false
    }
  }

  /** 登记一个技能（已存在则不动）。 */
  function ensure(name, now = Date.now()) {
    if (!state.skills[name]) {
      state.skills[name] = { state: 'active', firstSeenAt: now, lastUsedAt: null, archivedAt: null, pinned: false }
    }
    return state.skills[name]
  }

  return {
    /** 全量快照（深拷贝，调用方改它不会污染内部状态）。 */
    snapshot() {
      return JSON.parse(JSON.stringify(state))
    },

    /** 测试专用：整表替换（生产代码不要用）。 */
    __replaceForTest(next) {
      state = next
    },

    /**
     * 记一次真实使用（由 tools/pre-execute 在 skill 工具被调用时驱动）。
     * 内存立即更新；落盘按 FLUSH_THROTTLE_MS 节流。
     * @param {string} name - skill 名。
     * @param {object} [opts]
     * @param {number} [opts.now] - 时间戳（测试注入）。
     */
    markUsed(name, { now = Date.now() } = {}) {
      if (typeof name !== 'string' || !name) return
      const rec = ensure(name, now)
      rec.lastUsedAt = now
      // 被使用即从 stale 复活（与 dsh-learn 的 reactivated 语义一致）
      if (rec.state === 'stale') rec.state = 'active'
      if (now - lastFlushAt >= FLUSH_THROTTLE_MS) persist()
    },

    /**
     * 与磁盘同步：登记新技能、清理已消失的技能。
     * @param {string} root - 技能库根。
     * @param {string[]} [names] - 已知技能名；**省略时自己 readdir**（两种调用形态都必须成立）。
     * @returns {{seeded: number, dropped: number}}
     */
    syncWith(root, names) {
      let list = names
      if (!Array.isArray(list)) {
        // 未显式传名单时自己读盘：技能库里有 SKILL.md 的目录才算技能。
        // 省略 names 时返回 [] 会让 seeded 恒为 0（计划原稿的缺陷，执行期实测抓出）。
        try {
          list = readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
            .map((e) => e.name)
        } catch {
          list = []
        }
      }
      const seen = new Set(list)
      let seeded = 0
      for (const name of list) {
        if (!state.skills[name]) {
          ensure(name)
          seeded += 1
        }
      }
      let dropped = 0
      for (const name of Object.keys(state.skills)) {
        if (!seen.has(name) && state.skills[name].state !== 'archived') {
          delete state.skills[name]
          dropped += 1
        }
      }
      if (seeded > 0 || dropped > 0) persist()
      return { seeded, dropped }
    },

    /**
     * 状态迁移（判定与执行分离）。
     * @param {object} opts
     * @param {number} opts.staleDays - 多久未用标 stale。
     * @param {number} opts.archiveDays - 多久未用够格归档。
     * @param {boolean} opts.archiveEnabled - false（默认）= 只报告不动磁盘。
     * @returns {{checked: number, markedStale: number, reactivated: number, wouldArchive: number, archived: number}}
     */
    transitions({ staleDays, archiveDays, archiveEnabled = false, now = Date.now(), archiveFn } = {}) {
      const counts = { checked: 0, markedStale: 0, reactivated: 0, wouldArchive: 0, archived: 0 }
      for (const [name, rec] of Object.entries(state.skills)) {
        counts.checked += 1
        if (rec.pinned) continue
        const anchor = rec.lastUsedAt ?? rec.firstSeenAt
        const ageDays = (now - anchor) / DAY_MS
        const stale = ageDays > staleDays
        const archiveable = ageDays > archiveDays
        if (archiveable) {
          counts.wouldArchive += 1
          if (archiveEnabled && typeof archiveFn === 'function' && archiveFn(name)) {
            counts.archived += 1
            continue
          }
        }
        if (stale && rec.state === 'active') {
          rec.state = 'stale'
          counts.markedStale += 1
        } else if (!stale && rec.state === 'stale') {
          rec.state = 'active'
          counts.reactivated += 1
        }
      }
      state.lastPassAt = now
      persist()
      return counts
    },

    /** 归档一个技能（移动到技能库之外）。返回是否真的移动了。 */
    archive(name, root) {
      const src = join(root, name)
      const dst = join(archivedRoot, name)
      try {
        mkdirSync(dirname(dst), { recursive: true })
        // 不用 rmSync 覆盖旧归档：重名时明确报错，保证「可恢复」承诺成立
        // （dsh-learn 在这里 rmSync(dst, force) 先删旧归档，恢复就没有对象了）。
        if (existsSync(dst)) {
          log('warn', `skill-curator: archive target exists for '${name}'; 先 restore 或手工处理`)
          return false
        }
        renameSync(src, dst)
      } catch (error) {
        log('warn', `skill-curator: archive '${name}' failed: ${(error && error.message) || error}`)
        return false
      }
      const rec = ensure(name)
      rec.state = 'archived'
      rec.archivedAt = Date.now()
      persist()
      return true
    },

    /** 从归档恢复。 */
    restore(name, root) {
      const src = join(archivedRoot, name)
      const dst = join(root, name)
      if (!existsSync(join(src, 'SKILL.md'))) return false
      if (existsSync(dst)) return false
      try {
        mkdirSync(dirname(dst), { recursive: true })
        renameSync(src, dst)
      } catch (error) {
        log('warn', `skill-curator: restore '${name}' failed: ${(error && error.message) || error}`)
        return false
      }
      const rec = ensure(name)
      rec.state = 'active'
      rec.archivedAt = null
      rec.lastUsedAt = Date.now()
      persist()
      return true
    },

    /** 钉住 / 取消钉住。 */
    setPinned(name, pinned) {
      const rec = ensure(name)
      rec.pinned = Boolean(pinned)
      persist()
      return rec.pinned
    },

    /** 状态摘要（状态面板/工具回显用）。 */
    summary() {
      const out = { active: [], stale: [], archived: [], neverUsed: [] }
      for (const [name, rec] of Object.entries(state.skills)) {
        const bucket = out[rec.state] || out.active
        bucket.push(name)
        if (!rec.lastUsedAt) out.neverUsed.push(name)
      }
      for (const key of Object.keys(out)) out[key].sort()
      return { ...out, lastPassAt: state.lastPassAt, pinned: Object.entries(state.skills).filter(([, r]) => r.pinned).map(([n]) => n).sort() }
    },

    /** 立即落盘。 */
    flush() {
      return persist()
    },

    /** 归档根路径（状态接口回显用）。 */
    get archiveRoot() {
      return archivedRoot
    },

    /** 状态文件路径。 */
    get path() {
      return path
    }
  }
}
```

> ⚠️ 实现细节：本模块不定义 `existsSyncSafe` 之类的本地包装，直接用 `node:fs` 的 `existsSync`（上面的 import 已含）。归档**不做任何删除**——目标已存在就报错返回 false。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/lifecycle.test.mjs`
Expected: PASS（9 个 test 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/lifecycle.js test/lifecycle.test.mjs
git commit -m "feat(lifecycle): 技能生命周期状态机（使用观测 + active/stale/archived + pin，默认不自动归档）"
```

---

## Task 3: 接线使用观测（tools/pre-execute）

**Files:**
- Modify: `src/index.js`（在工具注册之后、`ctx.provide` 之前或之后均可，但必须在 `apply` 内）
- Test: `test/apply.test.mjs`

**Interfaces:**
- Consumes: `createLifecycleStore`（Task 2）
- Produces: mock ctx 需支持 `on('tools/pre-execute', cb)`；`src/index.js` 导出的 `createLifecycleStore` 供测试注入

- [ ] **Step 1: 写失败测试**

在 `test/apply.test.mjs` 追加：

```js
test('tools/pre-execute 观测 skill 工具调用 → 记 lastUsedAt（子代理不计数）', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const t = env.__test
  const cbs = t.listeners.get('tools/pre-execute')
  assert.ok(cbs && cbs.length === 1, '必须注册一个 tools/pre-execute 监听')

  // 模拟宿主 waterfall 签名 (exec, next)
  const next = async () => ({ kind: 'allow' })
  await cbs[0]({ name: 'skill', arguments: { name: 'alpha-skill' }, agent: { session: { header: {} } } }, next)
  const life = env.__test.lifecycle
  assert.ok(life, 'apply 必须暴露 lifecycle store 供状态接口复用')
  assert.ok(life.snapshot().skills['alpha-skill'].lastUsedAt > 0, 'skill 调用必须记 lastUsedAt')

  // 其他工具不动状态
  await cbs[0]({ name: 'bash', arguments: { command: 'ls' }, agent: { session: { header: {} } } }, next)
  assert.equal(life.snapshot().skills['bash'], undefined, '非 skill 工具不记')

  // 子代理调用不计数（评审子代理读技能不是「使用」）
  await cbs[0]({ name: 'skill', arguments: { name: 'beta-skill' }, agent: { session: { header: { origin: 'subagent' } } } }, next)
  assert.equal(life.snapshot().skills['beta-skill'], undefined, '子代理不计数')

  // 必须放行（waterfall 语义：返回 next() 的结果）
  const decision = await cbs[0]({ name: 'skill', arguments: { name: 'alpha-skill' }, agent: { session: { header: {} } } }, next)
  assert.deepEqual(decision, { kind: 'allow' }, 'pre-execute 必须放行，不能拦工具')
})
```

`makeCtx` 需补两处桩：`ctx.on` 已存在（`listeners`）；`env.__test` 需暴露 `lifecycle`。在 `makeCtx` 的 `__test` 返回对象里加 `lifecycle` 字段（由 `apply` 通过 `config.__lifecycle` 或模块导出注入——见 Step 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/apply.test.mjs`
Expected: FAIL —— `必须注册一个 tools/pre-execute 监听`

- [ ] **Step 3: 改实现**

`src/index.js` 顶部 import 增加：

```js
import { createLifecycleStore } from './lifecycle.js'
```

在 `apply()` 内、`ctx.provide(TOOLS_READY_SERVICE, ...)` 之后加：

```js
  // ---------------------------------------------------------------------
  // 使用观测：skill 工具被调用 = 该技能「被使用」
  // ---------------------------------------------------------------------
  // 为什么用 tools/pre-execute 而不是 ctx.tools.guard()：
  //   guard 的语义是「同步拒绝」（返回字符串即拦下工具），而观测是纯副作用，
  //   不该占用拒绝通道；pre-execute 是官方扩展点（宿主先例：dsh-tool-jobs:235、
  //   dsh-experimental-auto-review:462、dsh-hooks-claude-code:248），签名 (exec, next)。
  // 为什么必须 return next()：这是 waterfall，不返回等于把工具拦掉。
  //
  // 这一步修的是 dsh-learn 的核心缺陷：它的 last_used_at 只能由 SKILL.md 的 mtime
  // 兜底（markUsed 是死代码），于是「30 天未用」实际是「30 天没改过文件」。
  const lifecycle = config.__lifecycle || createLifecycleStore({
    file: config.lifecyclePath || undefined,
    log: (level, message) => (level === 'warn' ? ctx.logger.warn(message) : ctx.logger.info(message))
  })
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec && exec.name === 'skill') {
        const header = exec.agent && exec.agent.session && exec.agent.session.header
        const isSubagent = header && (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0))
        const name = exec.arguments && exec.arguments.name
        if (!isSubagent && typeof name === 'string') lifecycle.markUsed(name)
      }
    } catch (error) {
      ctx.logger.warn('skill-curator: usage observation failed: %s', (error && error.message) || error)
    }
    return next()
  }), 'skill-curator: usage observation')
```

并在 `apply` 末尾（或 `ctx.provide` 附近）暴露给测试与状态接口：把 `lifecycle` 放进 status 接口闭包（Task 4 使用），并在 `apply` 里 `ctx.provide('skillCuratorLifecycle', { store: lifecycle })`——**或**更简单：`apply` 接受 `config.__lifecycle` 注入，测试直接传。选后者（不改服务面）。

`test/apply.test.mjs` 的 `applyIn` 里传入测试用 store：

```js
import { createLifecycleStore } from '../src/lifecycle.js'
// 在 applyIn 内：
const life = createLifecycleStore({ file: join(env.__test.home, 'lifecycle.json') })
env.__test.lifecycle = life
return apply(env, { skillsRoot: ..., backupRoot: ..., __lifecycle: life, ...real })
```

`makeCtx` 需建一个临时 `home` 并放进 `__test`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/apply.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.js test/apply.test.mjs
git commit -m "feat(observe): tools/pre-execute 观测 skill 工具调用，驱动技能 lastUsedAt"
```

---

## Task 4: 新增设置字段 + 生命周期工具 + 状态接口回显

**Files:**
- Modify: `src/settings.js`（+3 字段）
- Modify: `src/skill-tools.js`（`TOOL_NAMES` +1，新增工具定义）
- Modify: `src/index.js`（评审流程跑迁移；status 接口回显）
- Modify: `lib/client.js`（FIELDS + GROUPS + locale）
- Test: `test/entry.test.mjs`、`test/smoke.mjs`、`test/apply.test.mjs`、`test/client-smoke.mjs`
- Modify（Task 3 评审转来的隔离修复，见 3c-2）: `test/e2e-lifecycle.test.mjs`、`test/auto-commit.test.mjs`

**Interfaces:**
- Consumes: `createLifecycleStore`（Task 2）、`lifecycle` 实例（Task 3）
- Produces: `TOOL_NAMES` 长度 11；Config 键数 16

- [ ] **Step 1: 写失败测试**

`test/entry.test.mjs:262` 改为：

```js
assert.equal(hostKeys.length, 16, 'host Config 键数为 16（漂移则同步本断言与文档）')
```

`test/smoke.mjs:39` 改为：

```js
assert.equal(definitions.length, 11, 'eleven skill-library tools')
```

`test/apply.test.mjs` 三处 `10` 改为 `11`（`:195`、`:232`、`:354`），并追加：

```js
test('新增 skill-library-lifecycle 工具：archive/restore/pin/list 四动作', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const def = env.__test.tools.find((d) => d.name === 'skill-library-lifecycle')
  assert.ok(def, 'skill-library-lifecycle 必须注册')
  // defineTool 编译后是标准 JSON Schema：枚举在 parameters.properties.<key>.enum
  // （实测 probe-enum.mjs；parameters.<key>.enum 恒为 undefined）。
  assert.deepEqual(def.parameters.properties.action.enum, ['list', 'archive', 'restore', 'pin'])
  const listed = await def.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.ok(listed.data.lifecycle, 'list 返回生命周期摘要')
})

test('status 接口回显生命周期摘要', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true })
  const route = env.__test.routes.find((r) => r.path === '/api/skill-curator/status')
  const body = await new Promise((resolve) => {
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } }
    route.handler({ method: 'GET', headers: { host: '127.0.0.1:7009' } }, res)
  })
  assert.ok(body.lifecycle, 'status 必须带 lifecycle')
  assert.equal(typeof body.lifecycle.stale.length, 'number')
})

// summary() 的形状守护（Task 2 评审指出的零覆盖缺口：Task 4 是它的第一个消费者，
// 必须在依赖它之前钉住分桶与 pinned 字段，否则 Task 2 的 `out[rec.state] || out.active`
// 把未知 state 静默归入 active 这类缺陷会一路带到面板上）。
test('lifecycle.summary() 的分桶与 pinned 字段形状', () => {
  const env = makeCtx({})
  applyIn(env, {})
  const life = env.__test.lifecycle
  const now = Date.now()
  life.markUsed('used-skill', { now })
  life.markUsed('pinned-skill', { now })
  life.setPinned('pinned-skill', true)
  const s = life.summary()
  for (const bucket of ['active', 'stale', 'archived', 'neverUsed', 'pinned']) {
    assert.ok(Array.isArray(s[bucket]), `summary().${bucket} 必须是数组`)
  }
  assert.ok(s.active.includes('used-skill'), '刚用过的技能在 active')
  assert.ok(s.pinned.includes('pinned-skill'), 'pinned 列表含被钉住的技能')
  assert.deepEqual(s.active, [...s.active].sort(), 'active 必须有序（面板输出稳定）')
})
```

`test/client-smoke.mjs:155` 的 `fieldKeys` 数组追加 `'staleDays'`、`'archiveDays'`、`'archiveEnabled'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/entry.test.mjs && node test/smoke.mjs && node --test test/apply.test.mjs && node test/client-smoke.mjs`
Expected: FAIL —— 键数 13≠16、工具数 10≠11、`skill-library-lifecycle` 未注册

- [ ] **Step 3: 写实现**

**3a. `src/settings.js`** —— 在 `notifyMode` 之后追加：

```js
  /** 生命周期：多久未用标 stale（天）。 */
  staleDays: z.number().step(1).min(1).max(3650).default(30).volatile(),
  /** 生命周期：多久未用够格归档（天）。 */
  archiveDays: z.number().step(1).min(1).max(3650).default(90).volatile(),
  /** 生命周期：是否允许自动归档（默认关；开启后目录会被移到 skill-curator/archived/）。 */
  archiveEnabled: z.boolean().default(false).volatile()
```

**3b. `src/skill-tools.js`** —— `TOOL_NAMES` 追加 `'skill-library-lifecycle'`（放 `'skill-library-git'` 之前）；在 `createSkillToolDefinitions` 的返回数组末尾（`skill-library-git` 之后）追加：

```js
    tool(
      'skill-library-lifecycle',
      'Inspect or maintain the lifecycle of skills in the library: list (per-skill state active/stale/archived, ' +
        'last-used time, pinned), archive (move a skill out of the library into the curator archive — recoverable, ' +
        'never deleted), restore (bring an archived skill back), pin (exempt a skill from stale/archive forever). ' +
        'Use this instead of deleting a skill that merely looks unused — archiving is reversible.',
      {
        action: { type: 'string', required: true, enum: ['list', 'archive', 'restore', 'pin'] },
        name: { type: 'string', description: 'Target skill name (required for archive/restore/pin).' },
        pinned: { type: 'boolean', description: 'For action=pin: true to pin, false to unpin.' }
      },
      async (args) => {
        const life = lifeOf()
        const action = String(args.action || '')
        if (action === 'list') return ok({ lifecycle: life.summary(), archiveRoot: life.archiveRoot })
        const name = String(args.name || '')
        if (!SKILL_ID.test(name)) throw new Error(`invalid skill name (must match ${SKILL_ID}): ${name}`)
        if (action === 'archive') {
          if (excludedOf().includes(name)) throw new Error(`skill '${name}' 在 excludedSkills 保护名单里，禁止归档。`)
          const moved = life.archive(name, rootOf())
          if (!moved) throw new Error(`归档失败：'${name}' 不存在，或归档目录已有同名（先 restore 或手工处理）`)
          return ok({ archived: name, archiveRoot: life.archiveRoot })
        }
        if (action === 'restore') {
          const moved = life.restore(name, rootOf())
          if (!moved) throw new Error(`恢复失败：归档里没有 '${name}'，或技能库已有同名`)
          return ok({ restored: name })
        }
        if (action === 'pin') return ok({ name, pinned: life.setPinned(name, args.pinned !== false) })
        throw new Error(`unknown action: ${action}`)
      }
    )
```

`createSkillToolDefinitions(getConfig)` 签名需扩展为 `createSkillToolDefinitions(getConfig, getLifecycle = () => undefined)`；`lifeOf()` 取 `getLifecycle()`，缺失时抛 `new Error('skill-library-lifecycle 需要 lifecycle store（apply 注入）')`（只在 execute 时抛，不影响其它工具与 smoke 编译）。

**3c. `src/index.js`** —— 注册工具处传入 lifecycle（并把 `listSkills` 加进 `skill-tools.js` 的既有导入）：

```js
for (const definition of createSkillToolDefinitions(() => settings.spec(), () => lifecycle)) {
  ctx.tools.register(definition)
}
```

在评审流程 `scheduleReview` 的 `runSkillReview` **之后**、`autoCommit` **之前**加生命周期迁移：

```js
        // 生命周期迁移挂在评审流程上（评审每 N 轮必跑，无需独立定时器）。
        // 判定与执行分离：archiveEnabled 默认 false → 只报告不动磁盘。
        let lifecycleCounts = null
        try {
          const names = (await listSkills(skillsRoot(s), s.excludedSkills || [])).map((k) => k.name)
          lifecycle.syncWith(skillsRoot(s), names)
          lifecycleCounts = lifecycle.transitions({
            staleDays: s.staleDays,
            archiveDays: s.archiveDays,
            archiveEnabled: s.archiveEnabled,
            archiveFn: (name) => lifecycle.archive(name, skillsRoot(s))
          })
        } catch (error) {
          ctx.logger.warn('skill-curator: lifecycle pass failed: %s', (error && error.message) || error)
        }
```

并把 `lifecycleCounts` 写进 `reviewLog.record({ ..., lifecycle: lifecycleCounts || undefined })`。

status 接口 body 增加：

```js
            lifecycle: lifecycle.summary(),
            archiveEnabled: settings.spec().archiveEnabled,
```

**3c-2（Task 3 评审转来的硬要求）**：`test/e2e-lifecycle.test.mjs:58,156` 与 `test/auto-commit.test.mjs:37,99` 调 `apply()` 时**只隔离了 `skillsRoot`/`backupRoot`**，没隔离 lifecycle store → 会构造指向**真实** `~/.dsh/skill-curator/lifecycle.json` 的 store。Task 3 时无害（store 只读盘且容忍 ENOENT），但本任务在 apply 期接上 `syncWith()`/`transitions()` 后就会**写真实用户目录**。

修法：给这 4 处 `apply()` 调用补 lifecycle 隔离（与 `test/apply.test.mjs` 同款：显式传 `file` + `archiveRoot` 落在临时目录；或直接传 `__lifecycle`）：

```js
mod.apply(ctx, {
  skillsRoot,
  backupRoot,
  lifecyclePath: join(mkdtempSync(join(tmpdir(), 'sc-e2e-life-')), 'lifecycle.json')
})
```

判据：跑完全仓测试后，真实 `~/.dsh/skill-curator/` 仍只有 `backups/` 与 `reviews.json`，且整个 `~/.dsh` 递归扫 `lifecycle.json` 零命中。**必须把这条对照写进报告。**

**3d. `lib/client.js`** —— `FIELDS` 追加三行：

```js
      { key: "staleDays", type: "number" },
      { key: "archiveDays", type: "number" },
      { key: "archiveEnabled", type: "bool" },
```

`GROUPS` 追加一组：

```js
      { titleKey: "group.lifecycle", keys: ["staleDays", "archiveDays", "archiveEnabled"] }
```

locale `zh` 增加：

```js
        "group.lifecycle": "技能生命周期",
        "field.staleDays": "多久未用标记为 stale（天）",
        "hint.staleDays": "按「最后一次被 skill 工具加载」计算，不是文件修改时间。",
        "field.archiveDays": "多久未用够格归档（天）",
        "hint.archiveDays": "归档 = 移到 skill-curator/archived/，可随时恢复，不会删除。",
        "field.archiveEnabled": "允许自动归档",
        "hint.archiveEnabled": "默认关闭：只在评审报告里提示，不动磁盘。开启后超期技能会被移出技能库。",
```

locale `en` 增加对应英文键（键名必须与 zh 完全一致，`test/client-smoke.mjs:154` 守护 parity）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（entry + unit + smoke + client-smoke + preset 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/settings.js src/skill-tools.js src/index.js lib/client.js test/
git commit -m "feat(lifecycle): 生命周期设置项 + skill-library-lifecycle 工具 + 状态面板回显"
```

---

## Task 5: 注册运行时 skill（教主会话模型用这组工具）

**Files:**
- Create: `src/runtime-skill.js`
- Modify: `src/index.js`（`ctx.inject(['skills'], ...)`）
- Test: `test/runtime-skill.test.mjs`、`test/apply.test.mjs`

**Interfaces:**
- Consumes: `TOOL_NAMES`（Task 4）
- Produces: `CURATOR_SKILL`（`{ name, description, whenToUse, content }`）

- [ ] **Step 1: 写失败测试**

新建 `test/runtime-skill.test.mjs`：

```js
/**
 * 运行时技能的形态守卫。
 * 关键：宿主 catalog 只渲染 name + description（dsh-tool-skill:42-47），
 * whenToUse 不进模型可见目录 —— 所以「怎么用」必须写进 description。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CURATOR_SKILL } from '../src/runtime-skill.js'
import { TOOL_NAMES } from '../src/skill-tools.js'

test('运行时技能名符合宿主 SKILL_NAME', () => {
  assert.match(CURATOR_SKILL.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('description 非空且 ≤500 字符（catalog 渲染上限）', () => {
  assert.ok(CURATOR_SKILL.description.length > 0)
  assert.ok(CURATOR_SKILL.description.length <= 500, `实际 ${CURATOR_SKILL.description.length}`)
})

test('description 必须自带用法（because catalog 不渲染 whenToUse）', () => {
  // 至少要提到核心动作与「先读后改」，否则模型看到目录也不知道怎么用
  for (const needle of ['read', 'sha256', 'delete', 'lifecycle']) {
    assert.ok(CURATOR_SKILL.description.toLowerCase().includes(needle), `description 必须提到 ${needle}`)
  }
})

test('content 覆盖全部白名单工具名', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(CURATOR_SKILL.content.includes(name), `content 必须说明 ${name}`)
  }
})

test('content 写明「先读后改」与「归档优先于删除」', () => {
  assert.ok(CURATOR_SKILL.content.includes('sha256'))
  assert.ok(CURATOR_SKILL.content.includes('归档'))
})
```

`test/apply.test.mjs` 追加：

```js
test('apply 注册运行时技能（skills.register）', async () => {
  const env = makeCtx({ __skillsReady: true })
  applyIn(env, {})
  const regs = env.__test.runtimeSkills
  assert.equal(regs.length, 1, '注册一个运行时技能')
  assert.equal(regs[0].name, 'skill-curator')
  assert.equal(typeof regs[0].description, 'string')
  assert.ok(regs[0].content.length > 0)
})
```

`makeCtx` 需支持 `inject(['skills'], cb)` 与 `__test.runtimeSkills`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/runtime-skill.test.mjs`
Expected: FAIL —— `Cannot find module '../src/runtime-skill.js'`

- [ ] **Step 3: 写实现**

新建 `src/runtime-skill.js`：

```js
/**
 * dsh-skill-curator — 注册给主会话的运行时技能（工具的用法说明书）。
 *
 * 为什么需要：插件注册了 11 个 skill-library-* 工具，但主会话里**没有任何一行**
 * 说明这组工具该怎么用 —— 模型只能靠工具描述猜。dsh-learn 用
 * `skills.register()` 解决了这一点，本文件是同一形态的采纳。
 *
 * ⚠️ 关键约束（实测）：宿主把技能渲染进会话目录时只取 name + description
 * （dsh-tool-skill/lib/index.js:42-47 `catalogSourceEntries`，description 上限 500 字符），
 * `whenToUse` **不进**模型可见目录。所以「怎么用」必须写进 description，
 * 不能像 dsh-learn 那样只写在 whenToUse 里（那样模型看不到）。
 *
 * rank 说明：运行时技能 rank=250，用户目录 rank=400（dsh-skill-filesystem:174）。
 * 若技能库里日后出现同名 `skill-curator`，用户版胜出（遮蔽，不是报错）。
 */
import { TOOL_NAMES } from './skill-tools.js'

export const CURATOR_SKILL = {
  name: 'skill-curator',
  description:
    'Curate the local DSH skill library with the skill-library-* tools: list/read/tree/create/patch/write-file/' +
    'delete-file/delete/adopt/lifecycle/git. Always read first — every write must echo the sha256 returned by ' +
    'skill-library-read (read-before-write is enforced, not advisory). Prefer patching an existing umbrella over ' +
    'creating a new skill; prefer archiving (skill-library-lifecycle, recoverable) over delete; put long detail in ' +
    'references/ and leave one pointer line in SKILL.md.',
  whenToUse:
    '当你要新建、改写、合并、精简或退役一个技能时；当用户提到「沉淀成技能 / 更新技能库 / 技能库整理 / 这个技能过时了」时。',
  content: [
    '## 用途',
    '',
    'skill-curator 让你直接维护本机技能库（`<DSH_HOME>/skills/<name>/SKILL.md`）：读、写、合并、精简、归档。',
    '',
    '## 工具速览',
    '',
    ...TOOL_NAMES.map((name) => `- \`${name}\``),
    '',
    '## 铁律',
    '',
    '1. **先读后改**：任何 patch / write-file / delete 之前，先用 `skill-library-read` 拿 `sha256`，',
    '   再把它作为 `expectedSha256` 回传。没读过就写会被直接拒绝；读完后文件被别人改过也会被拒绝。',
    '2. **写前自动备份**：每次写入/删除前，原件（删除时整个目录）会备份到 `<DSH_HOME>/skill-curator/backups/`，',
    '   保留最近 30 份。这条保险是让你**敢改**的，不是让你事后补救的。',
    '3. **归档优先于删除**：看起来没用的技能先用 `skill-library-lifecycle` 的 `archive`（可 restore），',
    '   别直接 `skill-library-delete`。',
    '4. **保护名单**：`excludedSkills` 里的技能只读，写入会被拒绝。',
    '',
    '## 形态',
    '',
    '- 类级 umbrella，不是「一会话一技能」：名字必须类级（绝不是 PR 号、错误串、库名或今天才成立的名字）。',
    '- 短正文 + 厚 references/：正文只留「什么时候用 + 怎么做 + 坑 + 边界」，',
    '  实录/长清单/长代码下沉到 `references/<topic>.md`，正文留一行指针。',
    '- 正文一律中文；`description` 中英双语（英文在前，便于模型按描述发现）。',
    '',
    '## 生命周期',
    '',
    '`skill-library-lifecycle` 可查每个技能的状态与最后使用时间（active / stale / archived / pinned）。',
    '「最后使用」按 `skill` 工具真实加载计算，不是文件修改时间。'
  ].join('\n')
}
```

`src/index.js` 在 `ctx.provide(TOOLS_READY_SERVICE, ...)` 之后加：

```js
  // ---------------------------------------------------------------------
  // 运行时技能：把这 11 个工具的用法写进主会话的技能目录
  // ---------------------------------------------------------------------
  // 等待式注入：skills 服务由 dsh-base 的 dsh-skill 行提供，与本插件 apply 时序不保证。
  // 一次性 ctx.get('skills') 在服务未就绪时拿到 undefined → 静默不注册（第七路盲区同源）。
  ctx.inject(['skills'], (sctx) => {
    try {
      if (typeof sctx.skills.register !== 'function') {
        ctx.logger.warn('skill-curator: skills.register unavailable; runtime skill not registered')
        return
      }
      sctx.effect(() => sctx.skills.register({
        name: CURATOR_SKILL.name,
        description: CURATOR_SKILL.description,
        whenToUse: CURATOR_SKILL.whenToUse,
        source: 'custom',
        content: CURATOR_SKILL.content
      }), 'skill-curator: runtime skill')
    } catch (error) {
      ctx.logger.warn('skill-curator: runtime skill registration failed: %s', (error && error.message) || error)
    }
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/runtime-skill.js src/index.js test/runtime-skill.test.mjs test/apply.test.mjs
git commit -m "feat(skill): 注册运行时技能 skill-curator，把 skill-library-* 的用法写进会话目录"
```

---

## Task 6: 文档收口

**Files:**
- Modify: `docs/COMPARISON.md`
- Modify: `README.md`、`README.zh-CN.md`

> 本任务**不**改 `package.json`（版本 bump 留到发版时单独做，见 Step 3 的 Ruling）。

- [ ] **Step 1: 更新 `docs/COMPARISON.md`**

在矩阵后追加一节：

```markdown
## 吸收 dsh-learn（kouyichi/dsh-plugins）的机制（2026-10-20）

调研档案：`D:\DSH\_research\dsh-learn\REPORT.md`（含上游 4 个源码级缺陷取证）。

**吸收的两条**：

| 机制 | 采纳形态 | 与上游的关键差异 |
|---|---|---|
| 技能生命周期状态机 | `src/lifecycle.js` + `skill-library-lifecycle` 工具 + status 面板回显 | 上游 `markUsed()` 是死代码，`last_used_at` 只能由 SKILL.md mtime 兜底（「30 天未用」实为「30 天没改过文件」）。本实现用 `tools/pre-execute` 观测真实的 `skill` 工具调用，初值 `null` |
| 运行时技能（工具用法说明书） | `src/runtime-skill.js` + `ctx.inject(['skills'])` 注册 | 上游把用法写在 `whenToUse`；实测宿主 catalog 只渲染 name+description（`dsh-tool-skill:42-47`），所以我们把用法写进 description |

**不吸收的**：inbox→draft→promote 三段手动流程（与自动评审形态冲突）、`learn_record` 手工记录、周报、单文件 730 行无测试形态、`learn_review` 默认 dry-run（上游 dry-run 有真实磁盘副作用）。

**顺带修的自己的缺口**：`SKILL_ID` 收紧对齐宿主 `SKILL_NAME`（原正则放行 `foo-`/`foo--bar`，宿主静默忽略）。
```

- [ ] **Step 2: 更新 README（中英双语）**

英文 README 的 Settings 列表追加三项，并新增一节：

```markdown
## Skill lifecycle

Each skill is tracked as `active → stale → archived` by **real use** (a `skill` tool load), not by file mtime:

- `staleDays` (default 30) / `archiveDays` (default 90) — windows
- `archiveEnabled` (default **off**) — off means the review only *reports* which skills are eligible; nothing on disk moves
- `pinnedSkills` — pin a skill via `skill-library-lifecycle` and it is exempt forever
- Archived skills move to `<DSH_HOME>/skill-curator/archived/<name>/` — **outside** the library, so the host does not discover them, and `restore` brings them back

The plugin also registers a runtime skill named `skill-curator` so the model knows how to use the eleven `skill-library-*` tools.
```

中文 README 加对应段落（含「最后使用按 skill 工具真实加载计算，不是文件修改时间」这句判据）。

- [ ] **Step 3: 自检（本任务不 bump 版本）**

> **Ruling（执行期，Lead）**：本任务**不改** `package.json` 的 `version`，也**不**动 `peerDependencies`。
> 依据：本仓历史里 feature commit 不 bump 版本（`89886e0`/`15edb7c`/`0031578`/`6644b56` 四个 feature commit 的 version 都保持 `0.1.7-rc.2`）；bump 只发生在 release/适配点，且 tag 与 version 逐字一致。本轮改动尚未经真机重启验证，先写死新版本号会造出「版本已发但没验过」的状态。
> 发版时再单独 bump + 打 tag。

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add docs/COMPARISON.md README.md README.zh-CN.md
git commit -m "docs: 记录 dsh-learn 机制吸收（生命周期 + 运行时技能）与不吸收清单"
```

---

## 验收清单（全部满足才算完成）

| # | 判据 | 验证方式 |
|---|---|---|
| 1 | `SKILL_ID` 与宿主 `SKILL_NAME` 同源，且 68 个现存技能零误伤 | `node test/smoke.mjs`；`node D:\DSH\_research\dsh-learn\tighten-impact.mjs` |
| 2 | 生命周期按**真实使用**判定，不按文件 mtime | `node --test test/lifecycle.test.mjs` 中「markUsed 后超过 staleDays 也不标 stale」 |
| 3 | 默认**不**动磁盘 | `transitions({archiveEnabled:false})` 后 `existsSync(SKILL.md)` 为真 |
| 4 | 归档在技能库之外、可 restore | `archive` 后原目录不存在、`<DSH_HOME>/skill-curator/archived/<name>/SKILL.md` 存在、`restore` 后回到技能库 |
| 5 | 归档不覆盖旧归档（修掉上游 `rmSync(dst,force)` 缺陷） | 同名归档两次，第二次返回 false 且不删旧归档 |
| 6 | pinned 免疫 | 「pinned 技能永不被标 stale 或归档」测试 |
| 7 | 使用观测放行工具（waterfall 语义） | 「必须放行」断言 `{kind:'allow'}` |
| 8 | 子代理调用不计数 | 「子代理不计数」断言 |
| 9 | 运行时技能 description 自带用法且 ≤500 字符 | `test/runtime-skill.test.mjs` |
| 10 | 全套测试绿 | `npm test` |
| 11 | 零新增依赖、无安装脚本、仅 `@deepseek-ai/*` | `test/entry.test.mjs` 依赖卫生段 |

## 真机验收（需重启 dsh，由发哥执行）

1. `dsh plugin --profile web add ./` 后重启 dsh。
2. 设置 → 插件 → 技能策展卡片：应出现「技能生命周期」分组，3 个新字段可热改。
3. 随便加载一个技能（`/` 触发或让模型调 `skill` 工具），然后：

```powershell
curl.exe -s http://127.0.0.1:7009/api/skill-curator/status | python -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('lifecycle'),ensure_ascii=False,indent=1))"
```

Expected: `lifecycle.active` 含刚用过的技能名，且该技能**不在** `stale` 里。

4. 技能目录里应出现 `skill-curator` 这一项（运行时技能，来源 `runtime`）。

## 明确不做（YAGNI）

- **不加独立定时器**（`ctx.interval` / `inject:['timer']`）：生命周期跟着评审节奏走已足够，加定时器要改两处服务面断言。
- **不加 `learn_record` / inbox / draft / promote**：与自动评审形态冲突（见 COMPARISON 的「不吸收」段）。
- **不做学习周报**：评审记录 + 状态面板已覆盖，再加一份是重复信息。
- **不做 `dry-run` 开关**：`archiveEnabled=false` 本身就是默认 dry-run，再加一层是冗余。
- **不动 `cordis.patch.yml`**：本次无新服务、无新 preset。
