import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore, defaultHistoryPath } from '../src/history-store.js'

test('defaultHistoryPath respects DSH_HOME', () => {
  process.env.DSH_HOME = '/tmp/sc-hist-home'
  assert.equal(defaultHistoryPath(), join('/tmp/sc-hist-home', 'skill-curator', 'reviews.json'))
  delete process.env.DSH_HOME
})

test('missing file starts empty; record persists atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const file = join(dir, 'reviews.json')
  const log = createHistoryStore({ file })
  assert.deepEqual(log.recent(), [], 'empty start')
  log.record({ at: 't1', ok: true, actions: ['a'] })
  // 新实例同文件 → 持久化往返
  const again = createHistoryStore({ file })
  assert.equal(again.recent().length, 1)
  assert.equal(again.recent()[0].at, 't1')
})

test('record caps at max (newest kept)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const file = join(dir, 'reviews.json')
  const log = createHistoryStore({ file, max: 3 })
  for (let i = 0; i < 5; i++) log.record({ at: `t${i}` })
  assert.deepEqual(log.recent().map((e) => e.at), ['t4', 't3', 't2'], 'newest 3 kept')
  const again = createHistoryStore({ file })
  assert.equal(again.recent().length, 3)
})

test('corrupted file tolerated as empty (and first record overwrites)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const file = join(dir, 'reviews.json')
  writeFileSync(file, '{not json', { mode: 0o600 })
  const log = createHistoryStore({ file })
  assert.deepEqual(log.recent(), [], 'corrupt → empty')
  log.record({ at: 'after-corrupt' })
  const again = createHistoryStore({ file })
  assert.equal(again.recent().length, 1)
})

test('non-array json tolerated as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const file = join(dir, 'reviews.json')
  writeFileSync(file, '{"oops": true}', { mode: 0o600 })
  const log = createHistoryStore({ file })
  assert.deepEqual(log.recent(), [])
})

test('raw file content is a JSON array on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const file = join(dir, 'reviews.json')
  const log = createHistoryStore({ file })
  log.record({ at: 'x' })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(raw))
  assert.equal(raw[0].at, 'x')
})