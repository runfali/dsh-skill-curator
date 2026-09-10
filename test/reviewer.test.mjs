import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runSkillReview, ensureCustomAdapter, isEndpointModelFailure, CUSTOM_REVIEW_ROUTE, createReviewLog, routeIsMounted
} from '../src/reviewer.js'
import { createCustomAdapter, blocksToOpenAiText, openAiRole, streamChunksFromOpenAi } from '../src/custom-adapter.js'

const completedRun = (text = '已更新 skill demo。') => ({
  result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
  dispose: async () => {}
})
const failedRun = (detail) => ({
  result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: detail }),
  dispose: async () => {}
})

function makeCtx({ failFirst, firstDetail = 'custom review endpoint HTTP 401', secondText = '回退后完成' }) {
  const starts = []
  const subagents = {
    getProvider: () => ({ name: 'spawn' }),
    list: () => ['spawn'],
    async start(provider, request) {
      starts.push(request)
      const isFallback = !request.agentOptions
      if (!isFallback && failFirst) return failedRun(firstDetail)
      return completedRun(isFallback ? secondText : '主路径完成')
    }
  }
  // 保真的 llm 桩：真实 dsh-llm 既有 registerAdapter 也有 listProviders
  // （lib/index.js:1780 / 1846）；只模拟 registerAdapter 会让「路由存活判据」失真。
  const llm = {
    routes: [],
    registerAdapter(providers, adapter) {
      for (const p of providers) if (!llm.routes.includes(p)) llm.routes.push(p)
      llm.registered = { providers, adapter }
    },
    listProviders() { return llm.routes.map((id) => ({ id, name: id })) }
  }
  const ctx = {
    get(key) {
      if (key === 'subagents') return subagents
      if (key === 'llm') return llm
      return undefined
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }
  return { ctx, subagents: starts, llm }
}

const agent = { id: 'sess-1', session: { id: 'sess-1', events: [] } }
const spec = (extra = {}) => ({
  enabled: true, skillNudgeInterval: 3, digestTail: 24, digestMaxChars: 30000,
  reviewTimeoutMs: 5000, reviewProvider: '', reviewModel: '', reviewBaseUrl: '', reviewApiKey: '', adoptSkills: [], notifyMode: 'on',
  ...extra
})

test('isEndpointModelFailure matrix', () => {
  for (const fail of [
    'custom review endpoint HTTP 401', 'custom review endpoint not configured',
    'review endpoint ECONNREFUSED', 'fetch failed: ETIMEDOUT', 'ENOTFOUND example.com',
    'HTTP 429 too many requests', 'unauthorized', 'model "x" not found', 'no such model'
  ]) assert.equal(isEndpointModelFailure(fail), true, `fail=${fail}`)
  for (const keep of ['random plugin bug', 'skill-library-patch denied', 'subagent provider missing', 'undefined']) {
    assert.equal(isEndpointModelFailure(keep), false, `keep=${keep}`)
  }
})

test('custom endpoint failure falls back to session model exactly once', async () => {
  const { ctx, subagents } = makeCtx({ failFirst: true })
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1', reviewApiKey: 'k' }), getSpec: () => spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1', reviewApiKey: 'k' }) })
  assert.equal(subagents.length, 2, 'two attempts')
  assert.deepEqual(subagents[0].agentOptions, { provider: CUSTOM_REVIEW_ROUTE, model: 'm1' }, 'first attempt uses custom route')
  assert.equal(subagents[1].agentOptions, undefined, 'fallback drops agentOptions')
  assert.equal(out.ok, true, 'fallback completed')
  assert.equal(out.summary.includes('回退后完成'), true, 'fallback summary')
  assert.ok(out.fallback && out.fallback.reason.includes('401'), 'fallback reason recorded')
})

test('custom endpoint success runs once, no fallback', async () => {
  const { ctx, subagents } = makeCtx({ failFirst: false })
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1' }), getSpec: () => spec() })
  assert.equal(subagents.length, 1, 'single attempt')
  assert.equal(out.fallback, undefined, 'no fallback marker')
  assert.equal(out.ok, true)
})

test('non-endpoint failure does NOT fall back (rethrows start errors)', async () => {
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start() { throw new Error('subagent provider missing — deployment misconfigured') }
  }
  const llmStub = {
    routes: [],
    registerAdapter(providers) { for (const p of providers) if (!llmStub.routes.includes(p)) llmStub.routes.push(p) },
    listProviders() { return llmStub.routes.map((id) => ({ id, name: id })) }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : k === 'llm' ? llmStub : undefined), logger: { info() {}, warn() {} } }
  await assert.rejects(
    runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1' }), getSpec: () => spec() }),
    /provider missing/
  )
})

test('non-endpoint settleRun failure does NOT fall back', async () => {
  const { ctx, subagents } = makeCtx({ failFirst: true, firstDetail: 'skill-library-patch anchor ambiguous' })
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1' }), getSpec: () => spec() })
  assert.equal(subagents.length, 1, 'no retry for non-endpoint failure')
  assert.equal(out.ok, false)
  assert.equal(out.fallback, undefined)
})

test('registered-route override still works without custom endpoint', async () => {
  const { ctx, subagents } = makeCtx({ failFirst: false })
  await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewProvider: 'opencode', reviewModel: 'm2' }), getSpec: () => spec() })
  assert.deepEqual(subagents[0].agentOptions, { provider: 'opencode', model: 'm2' })
})

test('ensureCustomAdapter registers once; llm missing throws', async () => {
  const seen = []
  const llm = { routes: [], registerAdapter(p, a) { seen.push(p); for (const r of p) llm.routes.push(r) }, listProviders() { return llm.routes.map((id) => ({ id, name: id })) } }
  const ctx = { get: (k) => (k === 'llm' ? llm : undefined), logger: { info() {} } }
  const getSpec = () => ({})
  ensureCustomAdapter(ctx, 'route-a', getSpec)
  ensureCustomAdapter(ctx, 'route-a', getSpec) // 幂等：不再注册
  assert.deepEqual(seen, [['route-a']], 'registered once')
  const noLlm = { get: () => undefined, logger: { info() {} } }
  assert.throws(() => ensureCustomAdapter(noLlm, 'route-b', getSpec), /llm service unavailable/)
})

test('blocksToOpenAiText + role mapping', () => {
  assert.equal(blocksToOpenAiText([{ type: 'text', text: 'hi' }, { type: 'tool-result', toolCallId: 'c1', content: 'ok' }]), 'hi\n[tool result c1: ok]')
  assert.equal(blocksToOpenAiText([{ type: 'image', src: 'x' }]), '[image block]')
  assert.equal(openAiRole('assistant'), 'assistant')
  assert.equal(openAiRole('tool'), 'user')
})

test('streamChunksFromOpenAi: text + tool calls + finish mapping', async () => {
  const chunks = []
  for await (const c of streamChunksFromOpenAi({
    choices: [{
      message: {
        content: '我来更新 skill。',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'skill-library-list', arguments: '{}' } }]
      },
      finish_reason: 'tool_calls'
    }]
  })) chunks.push(c)
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[1].type, 'text-delta')
  assert.equal(chunks[1].text, '我来更新 skill。')
  const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(toolEnd.block.id, 't1')
  assert.equal(toolEnd.block.name, 'skill-library-list')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason, 'tool-calls')
})

test('custom adapter stream: wire shape + auth + error path', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('fail')) return { ok: false, status: 502, text: async () => 'bad gateway' }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '完成', tool_calls: [] }, finish_reason: 'stop' }] })
    }
  }
  try {
    let specValue = { reviewBaseUrl: 'http://rev.example/v1', reviewApiKey: 'sk-1', reviewModel: 'rm' }
    const adapter = createCustomAdapter(() => specValue, 'skill-curator-review')
    const chunks = []
    for await (const c of adapter.stream({
      provider: 'skill-curator-review', model: 'rm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      tools: [{ name: 'skill-library-list', description: 'd', parameters: {} }],
      maxTokens: 100
    })) chunks.push(c)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://rev.example/v1/chat/completions')
    const payload = JSON.parse(calls[0].init.body)
    assert.equal(payload.model, 'rm')
    assert.equal(payload.stream, false)
    assert.equal(payload.messages[0].content, '你好')
    assert.equal(payload.tools[0].function.name, 'skill-library-list')
    assert.equal(payload.max_tokens, 100)
    assert.equal(calls[0].init.headers.authorization, 'Bearer sk-1')
    assert.equal(chunks.at(-1).reason, 'stop')
    // 失败路径
    specValue = { reviewBaseUrl: 'http://rev.example/v1/fail', reviewApiKey: 'sk-1', reviewModel: 'rm' }
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({ provider: 'p', model: 'rm', messages: [] })) { /* drain */ }
    }, /HTTP 502/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('custom adapter: baseUrl already containing /chat/completions preserved', async () => {
  const realFetch = globalThis.fetch
  let seenUrl = ''
  globalThis.fetch = async (url) => { seenUrl = String(url); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }) } }
  try {
    const adapter = createCustomAdapter(() => ({ reviewBaseUrl: 'http://h/v1/chat/completions', reviewApiKey: '', reviewModel: 'm' }), 'r')
    for await (const _ of adapter.stream({ provider: 'r', model: 'm', messages: [] })) { /* drain */ }
    assert.equal(seenUrl, 'http://h/v1/chat/completions')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('reviewLog bounds at 50', () => {
  const log = createReviewLog()
  for (let i = 0; i < 60; i++) log.record({ at: String(i) })
  assert.equal(log.recent().length, 50)
})
test('killed (timeout) on custom endpoint falls back even with empty detail', async () => {
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start(provider, request) {
      // 真实链路：超时 abort 后 SubagentResult.stopReason='aborted'，settleRun 映射为 status:'killed'
      if (request.agentOptions) return { result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: async () => {} }
      return completedRun('主模型兜底完成')
    }
  }
  const llmStub = {
    routes: [],
    registerAdapter(providers) { for (const p of providers) if (!llmStub.routes.includes(p)) llmStub.routes.push(p) },
    listProviders() { return llmStub.routes.map((id) => ({ id, name: id })) }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : k === 'llm' ? llmStub : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm1' }), getSpec: () => spec() })
  assert.equal(out.ok, true)
  assert.ok(out.fallback && /killed/.test(out.fallback.reason), 'fallback recorded for killed')
})

test('session-model connection blip (killed) is retried and succeeds', async () => {
  // 发哥场景：评审跟随主模型时主模型瞬断 → 重试一次后成功
  let calls = 0
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start(provider, request) {
      calls += 1
      // alpha.3 settleRun 语义：aborted 且 diagnostic 缺席(undefined) 才映射 killed（空串也算 failed）
      if (calls === 1) return { result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: async () => {} }
      return completedRun('重试后完成')
    }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewRetryCount: 1, reviewRetryDelayMs: 0 }), getSpec: () => spec() })
  assert.equal(out.ok, true)
  assert.equal(calls, 2)
  assert.match(out.summary, /重试后完成/)
})

test('endpoint-class failed outcome is retried up to reviewRetryCount', async () => {
  let calls = 0
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start() {
      calls += 1
      if (calls <= 2) return { result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'fetch failed: ECONNRESET' }), dispose: async () => {} }
      return completedRun('第三次成功')
    }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewRetryCount: 2, reviewRetryDelayMs: 0 }), getSpec: () => spec() })
  assert.equal(out.ok, true)
  assert.equal(calls, 3)
})

test('non-endpoint failure is NOT retried', async () => {
  let calls = 0
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start() {
      calls += 1
      return { result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'random plugin bug' }), dispose: async () => {} }
    }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewRetryCount: 3, reviewRetryDelayMs: 0 }), getSpec: () => spec() })
  assert.equal(out.ok, false)
  assert.equal(calls, 1) // 工具层/未知错误不重试
})

test('reviewRetryCount=0 disables retry entirely', async () => {
  let calls = 0
  const subagents = {
    getProvider: () => ({ name: 'spawn' }), list: () => ['spawn'],
    async start() {
      calls += 1
      return { result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: async () => {} }
    }
  }
  const ctx = { get: (k) => (k === 'subagents' ? subagents : undefined), logger: { info() {}, warn() {} } }
  const out = await runSkillReview(ctx, agent, { prompt: 'P', spec: spec({ reviewRetryCount: 0, reviewRetryDelayMs: 0 }), getSpec: () => spec() })
  assert.equal(out.ok, false)
  assert.equal(calls, 1)
})

test('custom adapter sends attribution user-agent header', async () => {
  const realFetch = globalThis.fetch
  let headers = null
  globalThis.fetch = async (url, init) => { headers = init.headers; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }) } }
  try {
    const adapter = createCustomAdapter(() => ({ reviewBaseUrl: 'http://h/v1', reviewApiKey: '', reviewModel: 'm' }), 'r')
    for await (const _ of adapter.stream({ provider: 'r', model: 'm', messages: [] })) { /* drain */ }
    assert.match(headers['user-agent'], /^deepseek-harness\//)
  } finally {
    globalThis.fetch = realFetch
  }
})
// ---------------------------------------------------------------------------
// 适配面守护：鸭子 adapter 必须自备 LlmAdapter 的**全部**方法
// （2026-09-10 0.1.5-rc.1 适配实证的 P1：缺 imageRequestPricing）
//
// 背景：宿主 ctx.llm.registerAdapter 存的是原对象（prepareRoutes 只读 providerInfo/
// providerRetryPolicy，其余方法在调用期直接取 adapter.<name>）。抽象类只有 stream() 是
// abstract，但基类实现了 providerInfo/providerRetryPolicy/imageRequestPricing/
// listModels/resolveModel/prepareCall —— 鸭子对象拿不到这些默认实现，缺一个就是
// TypeError。imageRequestPricing 更是被 dsh-token-meter 的 measure() 无条件调用。
//
// 断言形状：① 静态列表逐个在实例上存在；② 与宿主真实 LlmAdapter.prototype 的
// 方法名集合逐名对齐（宿主可读时；不可读则显式跳过，不假绿）。
// ---------------------------------------------------------------------------
test('adapter surface: every LlmAdapter base-class method is implemented', async () => {
  const adapter = createCustomAdapter(() => ({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm' }), 'probe-route')
  // 基类的六个具体实现 + 唯一的 abstract stream = 宿主可能调用的全集
  const BASE_METHODS = ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']
  for (const name of BASE_METHODS) {
    assert.equal(typeof adapter[name], 'function', 'adapter 缺方法 ' + name + '（鸭子对象不会继承 LlmAdapter 基类实现）')
  }
  // 交叉验证：宿主真实 LlmAdapter.prototype 的自身方法名必须被上述集合覆盖
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  let LlmAdapter = null
  try {
    const mod = req('@deepseek-ai/dsh-llm')
    LlmAdapter = mod.LlmAdapter ?? mod.default?.LlmAdapter ?? null
  } catch { /* 宿主/依赖不可解析则跳过交叉验证 */ }
  if (LlmAdapter && typeof LlmAdapter === 'function' && LlmAdapter.prototype) {
    const hostMethods = Object.getOwnPropertyNames(LlmAdapter.prototype).filter((n) => n !== 'constructor' && typeof LlmAdapter.prototype[n] === 'function')
    assert.ok(hostMethods.length > 0, '宿主 LlmAdapter.prototype 方法集为空（探针失效）')
    for (const name of hostMethods) {
      assert.ok(BASE_METHODS.includes(name), '宿主 LlmAdapter 新增了方法 ' + name + ' — 请同步补进 adapter 与本次断言')
      assert.equal(typeof adapter[name], 'function', 'adapter 缺宿主方法 ' + name)
    }
  } else {
    assert.equal(typeof adapter.imageRequestPricing, 'function', '静态兜底：imageRequestPricing 必须存在')
  }
  // 行为断言：宿主 facade 的调用表达式不得抛错（dsh-llm 内部即 ?.adapter.<m>(...)）
  const registry = new Map([['probe-route', { adapter }]])
  assert.equal(registry.get('probe-route')?.adapter.imageRequestPricing('probe-route', 'm'), undefined, 'imageRequestPricing 必须同步返回 undefined（不声明图片计费）')
})

test('adapter surface: imageRequestPricing regression — missing method breaks token metering', async () => {
  // 反证：删掉该方法即复现宿主 TypeError（证明这条守护不是装饰）
  const adapter = createCustomAdapter(() => ({ reviewBaseUrl: 'http://x/v1', reviewModel: 'm' }), 'probe-route-2')
  delete adapter.imageRequestPricing
  const registry = new Map([['probe-route-2', { adapter }]])
  assert.throws(
    () => registry.get('probe-route-2')?.adapter.imageRequestPricing('probe-route-2', 'm'),
    /is not a function/,
    '宿主 facade 表达式在方法缺失时必须抛 TypeError（守护有效性反证）'
  )
})
// ---------------------------------------------------------------------------
// 路由存活守护：插件 fiber 卸载后必须能**重注册**（2026-09-10 适配轮抓到的存量缺陷）
//
// 背景：宿主 registerAdapter 的服务代理把 ctx 绑到**调用方 fiber**，返回的 handle 是
// ctx.effect 的 disposer → 本插件 fiber 卸载（patch 热重载 / 卸载重挂）时宿主自动摘掉路由。
// 原实现只做「Map 有就跳过」的存在性判断 → 卸载后同进程重 apply 永不重注册 →
// 自定义端点评审在该进程内 100% 失败（provider 路由不存在）。
// ---------------------------------------------------------------------------
test('route liveness: re-registers after the host drops the route (fiber unload)', () => {
  const seen = []
  const llm = {
    routes: [],
    registerAdapter(providers) { for (const r of providers) { llm.routes.push(r); seen.push(r) } },
    listProviders() { return llm.routes.map((id) => ({ id, name: id })) }
  }
  const ctx = { get: (k) => (k === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } }
  const getSpec = () => ({})
  const route = 'reload-probe-route'

  ensureCustomAdapter(ctx, route, getSpec)
  assert.equal(llm.routes.filter((r) => r === route).length, 1, '首次注册')
  ensureCustomAdapter(ctx, route, getSpec)
  assert.equal(seen.length, 1, '仍挂载时幂等：不重复注册')

  // 模拟宿主在本插件 fiber 卸载时撤销路由（dsh-llm registerAdapter 的 yield 清理）
  llm.routes = []
  ensureCustomAdapter(ctx, route, getSpec)
  assert.equal(llm.routes.filter((r) => r === route).length, 1, '卸载后必须重注册（原实现在此永久失效）')
  assert.equal(seen.length, 2, '重注册发生且只发生一次')
})

test('route liveness: stale cache must not mask a missing route (regression counter-proof)', () => {
  // 反证：若判据退回「Map 里有过就跳过」，卸载后重注册不会发生——证明该守护有效
  const llm = {
    routes: [],
    registerAdapter(providers) { for (const r of providers) llm.routes.push(r) },
    listProviders() { return llm.routes.map((id) => ({ id, name: id })) }
  }
  const ctx = { get: (k) => (k === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } }
  const route = 'stale-probe-route'
  ensureCustomAdapter(ctx, route, () => ({}))
  llm.routes = []
  assert.equal(routeIsMounted(llm, route), false, '宿主已摘掉路由时存活判据必须为 false')
  ensureCustomAdapter(ctx, route, () => ({}))
  assert.equal(routeIsMounted(llm, route), true, '重注册后路由重新可解析')
})
