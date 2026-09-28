/**
 * 自动提交流程的真实沙箱验证：临时 git 技能库 + 真插件入口 + mock 子代理。
 * 断言：评审结束后 git log 里出现一条提交，message 带评审摘要；不含 push。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CURATOR_HISTORY = join(mkdtempSync(join(tmpdir(), 'sc-ac-hist-')), 'reviews.json')
const mod = await import('../src/index.js')
const { runGit } = await import('../src/skill-tools.js')

function host(skillsRoot) {
  const seen = { tools: [], listeners: new Map(), presentations: [] }
  const ctx = {
    fiber: { state: 2 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect: (fn) => { const d = fn(); return d },
    on(evt, cb) { if (!seen.listeners.has(evt)) seen.listeners.set(evt, []); seen.listeners.get(evt).push(cb); return () => {} },
    inject: (_s, cb) => cb(ctx),
    settings: { configure: (p) => { seen.presentations.push(p); return () => {} } },
    tools: { register: (d) => seen.tools.push(d) },
    get: (k) => (k === 'commands' ? { register: () => () => {} } : undefined)
  }
  mkdirSync(skillsRoot, { recursive: true })
  mod.apply(ctx, { skillsRoot, backupRoot: mkdtempSync(join(tmpdir(), 'sc-ac-bk-')) })
  return seen
}

test('review completion auto-commits the skill library (real git, real plugin entry)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sc-ac-'))
  const skills = join(repo, 'skills')
  const seen = host(skills)
  const init = await runGit(skills, ['init'])
  if (init.code !== 0) { assert.ok(true, 'git unavailable — skipped'); return }
  await runGit(skills, ['config', 'user.email', 'curator@test.local'])
  await runGit(skills, ['config', 'user.name', 'curator-test'])

  // 评审子代理：先把一个技能写进库（模拟它的真实动作），再返回摘要
  const subagents = {
    getProvider: (n) => (n === 'spawn' ? { name: n } : undefined),
    list: () => ['spawn'],
    async start(_p, _req) {
      const create = seen.tools.find((d) => d.name === 'skill-library-create')
      await create.execute(
        { name: 'auto-commit-demo', description: 'Auto-commit demo skill', content: '# 自动提交演示' },
        { signal: new AbortController().signal }
      )
      return {
        result: Promise.resolve({ output: [{ type: 'text', text: '已创建 skill auto-commit-demo。' }], stopReason: 'completed' }),
        dispose: async () => {}
      }
    }
  }

  // 用命令入口直接触发一次评审（绕过计数），更贴近真实调用
  const commands = { register(def) { seen.__cmd = def; return () => {} } }
  const ctxWithCmd = { get: (k) => (k === 'subagents' ? subagents : k === 'commands' ? commands : undefined) }
  // 直接调 scheduleReview 的公开入口：/skill-refine handler
  const agent = {
    session: { id: 'sess-auto', snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '写点什么' }] } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '好' }] } } }
    ] },
    ctx: { on: () => () => {} }
  }
  // 清空并重新 apply，确保 ctx.get 能拿到 subagents
  seen.tools.length = 0
  seen.listeners.clear()
  const ctx2 = {
    fiber: { state: 2 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect: (fn) => fn(),
    on(evt, cb) { if (!seen.listeners.has(evt)) seen.listeners.set(evt, []); seen.listeners.get(evt).push(cb); return () => {} },
    inject: (_s, cb) => cb(ctx2),
    settings: { configure: () => () => {} },
    tools: { register: (d) => seen.tools.push(d) },
    get: (k) => (k === 'subagents' ? subagents : k === 'commands' ? { register: (d) => { seen.__cmd = d; return () => {} } } : undefined)
  }
  mod.apply(ctx2, { skillsRoot: skills, backupRoot: mkdtempSync(join(tmpdir(), 'sc-ac-bk2-')) })
  assert.ok(seen.__cmd, '/skill-refine registered')
  seen.__cmd.handler({ agent, rawInput: '', signal: new AbortController().signal })

  // 等评审 + 自动提交完成
  const deadline = Date.now() + 8000
  let log = { stdout: '' }
  while (Date.now() < deadline) {
    log = await runGit(skills, ['log', '--oneline', '-n', '5'])
    if (log.stdout.trim()) break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(log.stdout.trim(), 'auto-commit landed')
  assert.ok(log.stdout.includes('auto-commit-demo') || log.stdout.includes('skill review') || log.stdout.includes('skill-curator'), 'commit message carries the review summary')
  const status = await runGit(skills, ['status', '--porcelain', '--untracked-files=all'])
  assert.equal(status.stdout.trim(), '', 'work tree clean after auto-commit')
  // 技能内容确实入库
  const show = await runGit(skills, ['show', '--stat', 'HEAD'])
  assert.ok(show.stdout.includes('auto-commit-demo'), 'the skill file is in the commit')
  // 无 remote → 不可能 push
  const remote = await runGit(skills, ['remote'])
  assert.equal(remote.stdout.trim(), '', 'no remote configured — nothing can be pushed')
})
