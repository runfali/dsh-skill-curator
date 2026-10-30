/**
 * scripts/backfill-usage.mjs 端到端测试（会写用户的 lifecycle.json，必须钉死）。
 *
 * 为什么单独测：这个脚本是全仓库唯一「批量改写真实状态文件」的路径，
 * 不进任何测试套件的话，写坏一次就是 87 条 lastUsedAt 全错（或全丢）。
 * 这里用临时 DSH_HOME 跑真实子进程，覆盖：干跑不动盘 / 写入生效 / 写前备份 /
 * 未知技能跳过 / 回读核验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

function frame(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n'))
}

/** 造一个最小 DSH_HOME：1 个会话（主会话 skill 加载 alpha）+ 1 个评审会话（应被排除）。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-backfill-'))
  const ts = 1793000000000 // 2026-10-26 附近
  const day = 86400000

  const session = (id, head, events) => {
    const dir = join(home, 'sessions', 'ws1', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame(head), ...events.map(frame)]))
  }
  session('s1', { type: 'session', id: 's1', createdAt: ts - 3 * day }, [
    { type: 'tool/call', time: ts, data: { name: 'skill', arguments: '{"name":"alpha"}' } }
  ])
  session('s2', { type: 'session', id: 's2', createdAt: ts, agentPreset: 'skill-curator-review' }, [
    { type: 'tool/call', time: ts + day, data: { name: 'skill', arguments: '{"name":"reviewed"}' } }
  ])

  const stateDir = join(home, 'skill-curator')
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'lifecycle.json')
  const state = {
    skills: {
      alpha: { state: 'active', firstSeenAt: ts, lastUsedAt: null, archivedAt: null, pinned: false, origin: 'disk' },
      beta: { state: 'active', firstSeenAt: ts, lastUsedAt: null, archivedAt: null, pinned: false, origin: 'disk' },
      reviewed: { state: 'active', firstSeenAt: ts, lastUsedAt: null, archivedAt: null, pinned: false, origin: 'disk' },
      archivedOne: { state: 'archived', firstSeenAt: ts, lastUsedAt: null, archivedAt: ts, pinned: false, origin: 'disk' }
    },
    lastPassAt: null
  }
  writeFileSync(file, JSON.stringify(state, null, 2))
  return { home, file, ts, day }
}

function run(home, extra = []) {
  return spawnSync(process.execPath, [join(REPO, 'scripts', 'backfill-usage.mjs'), '--home', home, ...extra], {
    encoding: 'utf8'
  })
}

test('干跑：只打印 diff，绝不改盘', () => {
  const { home, file } = fixture()
  const before = readFileSync(file, 'utf8')
  const res = run(home)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(readFileSync(file, 'utf8'), before, '干跑不得写盘')
  assert.match(res.stdout, /alpha/, '干跑要列出可更新的技能')
  assert.match(res.stdout, /干跑/)
})

test('--write：写入生效 + 写前备份 + 回读核验 + 评审会话被排除', () => {
  const { home, file, ts } = fixture()
  const res = run(home, ['--write', '--force'])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.skills.alpha.lastUsedAt, ts, '主会话的 skill 加载必须回填')
  assert.equal(written.skills.beta.lastUsedAt, null, '没有使用证据的技能保持 null')
  assert.equal(written.skills.reviewed.lastUsedAt, null, '评审会话不得回填（否则全库被刷新鲜）')
  assert.equal(written.skills.archivedOne.lastUsedAt, null, '已归档技能跳过')

  const backups = readdirSync(join(home, 'skill-curator', 'backups'))
  assert.equal(backups.length, 1, '写前必须备份')
  assert.match(backups[0], /^lifecycle-backfill-.*\.json$/)
  const backup = JSON.parse(readFileSync(join(home, 'skill-curator', 'backups', backups[0]), 'utf8'))
  assert.equal(backup.skills.alpha.lastUsedAt, null, '备份必须是写前状态')
})

test('--write 只增不减：已有更晚的时间戳不被回退', () => {
  const { home, file, ts, day } = fixture()
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.skills.alpha.lastUsedAt = ts + day // 比会话里那次更新
  writeFileSync(file, JSON.stringify(state, null, 2))
  const res = run(home, ['--write', '--force'])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).skills.alpha.lastUsedAt, ts + day, '不得回退到更早的时间')
})

test('参数缺值必须报错退出，不能把下一个开关当值', () => {
  fixture()
  for (const args of [['--home'], ['--port', '--write']]) {
    const res = spawnSync(process.execPath, [join(REPO, 'scripts', 'backfill-usage.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(res.status, 2, args.join(' ') + ' 必须 exit 2')
    assert.match(res.stderr, /需要一个/)
  }
})

test('状态表里出现 __proto__ 条目时必须跳过（不许把回填写到原型上）', () => {
  const { home, file } = fixture()
  // 手改/旧版本写坏的状态表：JSON.parse 会把 "__proto__" 建成**自有属性**
  // （这是 JSON.parse 的特例），随后 Object.hasOwn 为真 —— 少了名字白名单就会
  // 把它当正常记录写下去，回读核验也会失败（写不进去）。
  const ts = 1793000000000
  writeFileSync(file, '{"skills":{"__proto__":{"state":"active","firstSeenAt":' + ts +
    ',"lastUsedAt":null,"archivedAt":null,"pinned":false,"origin":"disk"}},"lastPassAt":null}')
  const dir = join(home, 'sessions', 'ws1', 's-proto')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    frame({ type: 'session', id: 's-proto', createdAt: ts - 1000 }),
    frame({ type: 'tool/call', time: ts, data: { name: 'ops_bash', arguments: '{"command":"ls ~/.dsh/skills/__proto__/"}' } })
  ]))
  const res = run(home, ['--write', '--force'])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.ok(!res.stdout.includes('__proto__'), '不得出现在可更新列表里')
  assert.equal(({}).lastUsedAt, undefined, 'Object.prototype 不得被污染')
})

test('lifecycle.lock 指向存活进程时 --write 必须拒绝（端口可配也能拦住）', () => {
  const { home, file } = fixture()
  writeFileSync(join(home, 'skill-curator', 'lifecycle.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
  const before = readFileSync(file, 'utf8')
  // --port 1 保证端口探活失败：拦住写入的只能是锁
  const res = run(home, ['--write', '--port', '1'])
  assert.equal(res.status, 2, res.stdout + res.stderr)
  assert.match(res.stderr, /lifecycle\.lock/)
  assert.equal(readFileSync(file, 'utf8'), before, '拒绝时不得改盘')
})

test('lifecycle.lock 是死 pid（崩溃残留）时放行', () => {
  const { home, file } = fixture()
  writeFileSync(join(home, 'skill-curator', 'lifecycle.lock'), JSON.stringify({ pid: 2147483647, at: 0 }))
  const res = run(home, ['--write', '--port', '1'])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.notEqual(readFileSync(file, 'utf8'), '', '死锁必须放行，否则崩溃后永远写不了')
})

test('dsh 在运行（端口可访问）时 --write 必须拒绝', async () => {
  const { home, file } = fixture()
  const before = readFileSync(file, 'utf8')
  // 指向一个确定在监听的本机端口：用它自己这次 spawn 拿不到的端口更稳 —— 直接用一个
  // 一定有人听的端口不现实，所以这里换个角度：给一个必然连不上的端口验证「放行」，
  // 连接失败的语义已在实现里（探活失败才放行）；拒绝分支由下面的假服务覆盖。
  const res = run(home, ['--write', '--force'])
  assert.equal(res.status, 0)

  // 起一个临时 HTTP 服务冒充 dsh，再跑一次不带 --force 的写入
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    writeFileSync(file, before)
    // 必须用异步 spawn：spawnSync 会把父进程的事件循环堵死，假服务永远回不了包，
    // 探活就恒失败 —— 测试自己把被测的护栏给绕过去了（本用例第一版就是这么假绿的）。
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [join(REPO, 'scripts', 'backfill-usage.mjs'), '--home', home, '--write', '--port', String(port)], { encoding: 'utf8' })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    const code = await new Promise((resolve) => child.on('close', resolve))
    assert.equal(code, 2, '运行中必须拒绝写入（退出码 2）')
    assert.match(stderr, /拒绝写入/)
    assert.equal(readFileSync(file, 'utf8'), before, '拒绝时不得改盘')
  } finally {
    server.close()
  }
})
