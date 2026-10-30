#!/usr/bin/env node
/**
 * dsh-skill-curator — 一次性历史回填：从会话日志重建 lastUsedAt。
 *
 * 为什么需要：插件从 2026-10-20 才开始记使用，之前的加载全没有记录，
 * 于是面板上 48 个「从未使用」里大部分其实是活技能。
 *
 * 判据与线上**同源**（./src/usage-scan.js）：skill 工具（含子代理，评审会话除外）
 * + 参数里命中技能目录。两套逻辑一旦漂移，面板数字和回填结果就会互相矛盾。
 *
 * 用法：
 *   node scripts/backfill-usage.mjs                 # 干跑（默认，只打印 diff）
 *   node scripts/backfill-usage.mjs --write         # 备份后写入 lifecycle.json
 *   node scripts/backfill-usage.mjs --home D:\\x\\.dsh   # 指定 DSH_HOME
 *
 * 安全：
 *   - 只增不减：新时间戳必须**晚于**已记录的 lastUsedAt 才会写（max 语义）
 *   - 已归档技能、状态表里不存在的技能一律跳过（不制造 runtime 幽灵记录）
 *   - --write 前把 lifecycle.json 复制到 backups/lifecycle-backfill-<ts>.json
 */
import { existsSync, readdirSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { usageCandidates } from '../src/usage-scan.js'
import { createLifecycleStore, defaultLifecyclePath } from '../src/lifecycle.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DAY = 86400000

function parseArgs(argv) {
  const out = { write: false, force: false, port: 31102, home: process.env.DSH_HOME || join(homedir(), '.dsh') }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--write') out.write = true
    else if (a === '--dry-run') out.write = false
    else if (a === '--force') out.force = true
    else if (a === '--port') out.port = Number(argv[++i]) || 31102
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/backfill-usage.mjs [--write] [--home <DSH_HOME>]')
      process.exit(0)
    }
  }
  return out
}

/** 多帧 zstd：按帧魔数切片逐帧解压（整文件解压只出第一帧）。 */
function readEvents(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  let text = ''
  let failed = 0
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      failed += 1
    }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* 尾部半行 */ }
  }
  return { events, failed }
}

function scanSessions(home) {
  const root = join(home, 'sessions')
  const out = new Map() // skill -> ts
  let sessions = 0
  let reviewSessions = 0
  let failedFrames = 0
  if (!existsSync(root)) return { map: out, sessions, reviewSessions, failedFrames }
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let entries = []
    try { entries = readdirSync(wsDir) } catch { continue }
    for (const session of entries) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const { events, failed } = readEvents(file)
      failedFrames += failed
      if (events.length === 0) continue
      sessions += 1
      const header = events[0] && events[0].type === 'session' ? events[0] : {}
      const descriptor = events.find((e) => e.type === 'subagent/descriptor')
      const label = descriptor && descriptor.data ? descriptor.data.label : undefined
      const agent = { session: { header } }
      for (const e of events) {
        if (e.type !== 'tool/call' && e.type !== 'tool/ptc-dispatch') continue
        const tool = e.data && e.data.name
        const args = e.data && e.data.arguments
        const names = usageCandidates({ tool, args, agent, label })
        if (names.length === 0) continue
        const ts = e.time || header.createdAt || 0
        for (const name of names) {
          const prev = out.get(name) || 0
          if (ts > prev) out.set(name, ts)
        }
      }
      if (label === 'skill review' || (header && header.agentPreset === 'skill-curator-review')) reviewSessions += 1
    }
  }
  return { map: out, sessions, reviewSessions, failedFrames }
}

function fmt(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : 'null'
}

const opts = parseArgs(process.argv.slice(2))
const file = defaultLifecyclePath()
if (!existsSync(file)) {
  console.error('lifecycle.json 不存在：' + file)
  process.exit(1)
}
const store = createLifecycleStore({ file })
const snapshot = store.snapshot()
const { map, sessions, reviewSessions, failedFrames } = scanSessions(opts.home)

const updates = []
let skippedArchived = 0
let skippedUnknown = 0
const now = Date.now()
for (const [name, ts] of map) {
  const rec = snapshot.skills[name]
  if (!rec) { skippedUnknown += 1; continue }
  if (rec.state === 'archived') { skippedArchived += 1; continue }
  if (rec.lastUsedAt && rec.lastUsedAt >= ts) continue
  updates.push({ name, ts, prev: rec.lastUsedAt || 0 })
}
updates.sort((a, b) => b.ts - a.ts)

const before = Object.values(snapshot.skills).filter((r) => r.origin === 'disk' && r.state !== 'archived' && !r.lastUsedAt).length
const after = before - updates.filter((u) => !snapshot.skills[u.name].lastUsedAt).length

console.log('DSH_HOME      :', opts.home)
console.log('会话          :', sessions, '（其中评审会话', reviewSessions, '，已排除）')
if (failedFrames > 0) console.log('解压失败帧    :', failedFrames)
console.log('技能记录      :', Object.keys(snapshot.skills).length)
console.log('可更新条目    :', updates.length, '（状态表里不存在而跳过', skippedUnknown, '，已归档跳过', skippedArchived, '）')
console.log('从未使用      :', before, '→', after)
console.log('')
if (updates.length === 0) {
  console.log('没有需要更新的记录。')
  process.exit(0)
}
console.log('技能'.padEnd(34), '原 lastUsedAt'.padEnd(18), '回填后'.padEnd(18), '年龄')
for (const u of updates) {
  const age = Math.floor((now - u.ts) / DAY)
  console.log(u.name.padEnd(34), fmt(u.prev).padEnd(18), fmt(u.ts).padEnd(18), age + ' 天')
}

if (!opts.write) {
  console.log('')
  console.log('（干跑）加 --write 才会写入。')
  process.exit(0)
}

// 护栏：dsh 正在运行时**绝不能**写。运行中的插件把 lifecycle.json 整表读进内存，
// 之后任意一次 markUsed / 评审都会把内存态整份写回，把回填结果静默覆盖掉。
// 这里探活失败（端口不通 = 没在跑）才放行；确需覆盖用 --force。
if (!opts.force) {
  const port = opts.port
  let alive = false
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/skill-curator/status', { signal: AbortSignal.timeout(1500) })
    alive = res.ok
  } catch {
    alive = false
  }
  if (alive) {
    console.error('')
    console.error('拒绝写入：dsh 正在运行（127.0.0.1:' + port + ' 可访问）。')
    console.error('运行中的插件会把内存里的 lifecycle 整份写回，覆盖掉本次回填。')
    console.error('请先完全退出 dsh，再运行： node scripts/backfill-usage.mjs --write')
    process.exit(2)
  }
}

const backupDir = join(dirname(file), 'backups')
mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(backupDir, 'lifecycle-backfill-' + stamp + '.json')
copyFileSync(file, backup)
console.log('')
console.log('已备份 ->', backup)
for (const u of updates) store.markUsed(u.name, { now: u.ts })
store.flush()
console.log('已写入', updates.length, '条 lastUsedAt（只增不减）')
