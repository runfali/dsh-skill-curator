/**
 * 契约守护：评审子代理的启动/结算面（dsh 0.2.1-rc.2 适配轮）。
 *
 * 本文件守护三个真实故障点（全部由「本地依赖夹具是旧版」掩盖）：
 *
 *   1. 0.2.1 起 `@deepseek-ai/dsh-subagent` 包根**不再导出 `settleRun`**
 *      （只剩 `settleRunResult`；实现搬进 lib/types/run-settlement.js 但
 *      package.json 的 exports 无该子路径 → 外部拿不到）。
 *      插件在模块顶层 `import { settleRun }` → ESM 链接期抛 SyntaxError →
 *      **apply() 从未执行**，整个插件全死，而本地夹具（0.2.0-rc.1）有该导出，
 *      所以 `npm test` 永远绿。→ 断言源码里不得再出现该 import。
 *
 *   2. 0.2.1 起 `subagents.start()` **整个方法被移除**，改为
 *      `startActivation(spec)`（continuable 语义，spec 多一层 `request`）。
 *      旧调用 → `TypeError: subagents.start is not a function`。
 *
 *   3. 0.2.1 起 `startLocal` 只把 `agentPreset` 写进 composition，
 *      `request.toolFilter` 全树零读取点 → 白名单被静默吞掉，
 *      评审子代理拿到全量工具（含 shell/fs），而它读的是完整会话内容。
 *      官方给的替代路径 = Agent Preset（dsh-tool-subagent 对 config.toolFilter
 *      直接抛错并指明 "configure persona and tool plugins in an Agent Preset"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const { settleRun, runOutcome } = await import('../src/run-settlement.js')
const { REVIEW_AGENT_PRESET, runSkillReview } = await import('../src/reviewer.js')

// ---------------------------------------------------------------------------
// 1. 不得再从宿主导入 settleRun（本地夹具掩盖的那个 P0）
// ---------------------------------------------------------------------------

test('契约：src 不得从 @deepseek-ai/dsh-subagent 导入 settleRun', () => {
  for (const file of ['reviewer.js', 'run-settlement.js']) {
    const text = readFileSync(join(SRC, file), 'utf8')
    const offenders = text
      .split('\n')
      .filter((line) => /import\s*\{[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-subagent['"]/.test(line))
      .filter((line) => /[{,\s]settleRun[,}\s]/.test(line))
    assert.deepEqual(
      offenders, [],
      `${file} 仍从宿主包根导入 settleRun —— 0.2.1-rc.2 已移除该导出，` +
      '模块顶层 import 会在 ESM 链接期抛 SyntaxError，apply() 永不执行'
    )
  }
})

// ---------------------------------------------------------------------------
// 2. 内联的 settleRun 必须与宿主 0.2.1 语义逐条一致
// ---------------------------------------------------------------------------

const runWith = (result, dispose = async () => {}) => ({ result: Promise.resolve(result), dispose })

test('settleRun：completed 带文本字段 result（0.2.1 字段名）', async () => {
  const outcome = await settleRun(runWith({
    output: [{ type: 'text', text: '已更新 skill demo。' }], stopReason: 'completed'
  }))
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.result, '已更新 skill demo。')
})

test('settleRun：aborted 无 diagnostic → killed', async () => {
  const outcome = await settleRun(runWith({ output: [], stopReason: 'aborted' }))
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, undefined)
})

test('settleRun：aborted 带 diagnostic → failed（空串也算 failed）', async () => {
  const withText = await settleRun(runWith({ output: [], stopReason: 'aborted', diagnostic: 'provider said no' }))
  assert.equal(withText.status, 'failed')
  assert.match(String(withText.detail), /aborted; diagnostic: provider said no/)

  const withEmpty = await settleRun(runWith({ output: [], stopReason: 'aborted', diagnostic: '' }))
  assert.equal(withEmpty.status, 'failed')
})

test('settleRun：error / max-tokens / refusal → failed，带 diagnostic', async () => {
  for (const stopReason of ['error', 'max-tokens', 'refusal']) {
    const outcome = await settleRun(runWith({ output: [], stopReason, diagnostic: 'boom' }))
    assert.equal(outcome.status, 'failed', stopReason)
    assert.match(String(outcome.detail), /boom/)
  }
})

test('settleRun：result 拒绝 → failed 而非抛出（永不 reject）', async () => {
  const outcome = await settleRun({
    result: Promise.reject(new Error('child exploded')),
    dispose: async () => {}
  })
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /child exploded/)
})

test('settleRun：dispose 失败 → failed，且原 detail 保留', async () => {
  const outcome = await settleRun({
    result: Promise.resolve({ output: [{ type: 'text', text: 'x' }], stopReason: 'completed' }),
    dispose: async () => { throw new Error('teardown wedged') }
  })
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /teardown wedged/)
})

test('settleRun：无论成败都调用 dispose（资源必须释放）', async () => {
  for (const result of [
    { output: [], stopReason: 'completed' },
    { output: [], stopReason: 'error' }
  ]) {
    let disposed = 0
    await settleRun({ result: Promise.resolve(result), dispose: async () => { disposed++ } })
    assert.equal(disposed, 1, `stopReason=${result.stopReason}`)
  }
})

test('runOutcome：非文本块不计入最终文本', async () => {
  const outcome = await runOutcome({
    output: [
      { type: 'text', text: '前半' },
      { type: 'tool-call', id: 't1' },
      { type: 'text', text: '后半' }
    ],
    stopReason: 'completed'
  })
  assert.equal(outcome.result, '前半后半')
})

// ---------------------------------------------------------------------------
// 3. 启动面：0.2.1 走 startActivation(spec)
// ---------------------------------------------------------------------------

const agent = { id: 'sess-1', session: { id: 'sess-1' } }
const spec = (extra = {}) => ({
  enabled: true, skillNudgeInterval: 3, digestTail: 24, digestMaxChars: 30000,
  reviewTimeoutMs: 5000, reviewRetryCount: 0, reviewRetryDelayMs: 0,
  reviewProvider: '', reviewModel: '', reviewBaseUrl: '', reviewApiKey: '',
  excludedSkills: [], notifyMode: 'on',
  ...extra
})

/** 只提供 0.2.1 面的 subagents 桩：有 startActivation，没有 start。 */
function modernSubagents(handler) {
  const calls = []
  return {
    calls,
    service: {
      getProvider: () => ({ name: 'spawn' }),
      list: () => ['spawn'],
      async startActivation(specArg) {
        calls.push(specArg)
        return handler(specArg)
      }
    }
  }
}

const okRun = (text = '完成') => ({
  childId: 'child-1',
  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
  dispose: async () => {}
})

test('启动面：0.2.1 用 startActivation(spec)，spec 形状正确', async () => {
  const { service, calls } = modernSubagents(() => okRun())
  const ctx = { get: (k) => (k === 'subagents' ? service : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec(), getSpec: () => spec() })

  assert.equal(calls.length, 1, '一次启动')
  const s = calls[0]
  assert.equal(s.provider, 'spawn')
  assert.equal(s.delivery, 'caller', 'delivery=caller：结算通知不得回灌父会话')
  assert.equal(s.request.parent, agent)
  assert.deepEqual(s.request.prompt, [{ type: 'text', text: 'P' }])
  assert.equal(s.request.agentPreset, REVIEW_AGENT_PRESET, '工具白名单经 agent preset 生效')
  assert.equal(s.request.toolFilter, undefined, '0.2.1 不再接受 request.toolFilter')
  assert.ok(s.signal, 'admission 可取消')
  assert.equal(out.ok, true)
  assert.equal(out.summary, '完成')
})

test('启动面：0.2.1 不再传 request.toolFilter（宿主已静默丢弃该字段）', async () => {
  const { service, calls } = modernSubagents(() => okRun())
  const ctx = { get: (k) => (k === 'subagents' ? service : undefined), logger: { info() {}, warn() {} } }
  await runSkillReview(ctx, agent, { prompt: 'P', spec: spec(), getSpec: () => spec() })
  assert.equal(Object.hasOwn(calls[0].request, 'toolFilter'), false)
})

test('启动面：0.2.0 回退路径仍用 start(name, request)', async () => {
  const seen = []
  const service = {
    getProvider: () => ({ name: 'spawn' }),
    list: () => ['spawn'],
    async start(name, request) {
      seen.push({ name, request })
      return okRun('旧宿主')
    }
  }
  const ctx = { get: (k) => (k === 'subagents' ? service : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec(), getSpec: () => spec() })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'spawn')
  assert.deepEqual(seen[0].request.toolFilter, { allow: (await import('../src/skill-tools.js')).TOOL_NAMES })
  assert.equal(out.ok, true)
})

test('启动面：模型覆盖经 agentOptions 进入 request', async () => {
  const { service, calls } = modernSubagents(() => okRun())
  const ctx = { get: (k) => (k === 'subagents' ? service : undefined), logger: { info() {}, warn() {} } }
  await runSkillReview(ctx, agent, {
    prompt: 'P', spec: spec({ reviewProvider: 'opencode', reviewModel: 'm2' }), getSpec: () => spec()
  })
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'opencode', model: 'm2' })
})

// ---------------------------------------------------------------------------
// 4. 超时：必须真的拆掉子会话，不能只 abort admission
// ---------------------------------------------------------------------------

/** 给异步断言加截止时间：突变导致挂起时必须以**失败**收场，而不是把测试跑挂。 */
async function withDeadline(promise, ms, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: 超过 ${ms}ms 未结算（疑似丢掉了超时拆会话）`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

test('超时：到点 dispose 子会话，结算为 killed', async () => {
  // 桩按宿主契约保真：`activation.dispose()` 是 memoized 的 close 事务
  // （dsh-subagent lib/index.js:1703-1713，closing 已存在时返回同一个 promise）。
  // 非幂等的桩会把「超时拆会话」+「结算时释放」记成两次，测出假故障。
  let teardowns = 0
  let closing
  let resolveResult
  const { service } = modernSubagents(() => ({
    childId: 'child-slow',
    result: new Promise((res) => { resolveResult = res }),
    dispose() {
      closing ??= (async () => {
        teardowns++
        resolveResult({ output: [], stopReason: 'aborted' })
      })()
      return closing
    }
  }))
  const ctx = { get: (k) => (k === 'subagents' ? service : undefined), logger: { info() {}, warn() {} } }
  // withDeadline 是必需的：若实现丢掉「abort → dispose」，settleRun 会永远等
  // 一个不会收敛的 result，测试将**挂起**而不是变红（变异测试 M7 实测）。
  const out = await withDeadline(
    runSkillReview(ctx, agent, {
      prompt: 'P', spec: spec({ reviewTimeoutMs: 30 }), getSpec: () => spec()
    }),
    2000, 'review'
  )
  assert.equal(teardowns, 1, '超时必须 dispose（startActivation 的 signal 只覆盖 admission）')
  assert.equal(out.ok, false)
  assert.equal(out.stopReason, 'killed')
})

// ---------------------------------------------------------------------------
// 5. preset 常量
// ---------------------------------------------------------------------------

test('preset 名是稳定字面量（设置卡与文档据此引用）', () => {
  assert.equal(REVIEW_AGENT_PRESET, 'skill-curator-review')
})
