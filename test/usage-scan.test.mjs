/**
 * dsh-skill-curator — 「什么算一次使用」判据单测。
 * 运行：node --test test/usage-scan.test.mjs
 *
 * 背景（2026-10-30 真机统计，484 个会话）：
 *   旧判据只认 `skill` 工具 + 只算主会话，于是
 *   - test-driven-development 追踪期内被 28 次子代理加载 → 仍被判「从未使用」；
 *   - llm-wiki 10 天内 22 次直接被 read/grep/脚本执行 → 全部漏记。
 * 这里把新判据钉死在纯函数上：路径命中算使用、子代理算使用（评审会话除外）、
 * 维护动作（skill-library-*）不算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageCandidates, skillsInArguments, isReviewSession, REVIEW_AGENT_PRESET } from '../src/usage-scan.js'

const main = { session: { header: {} } }
const sub = { session: { header: { origin: 'subagent', delegationDepth: 1 } } }
const review = { session: { header: { origin: 'subagent', delegationDepth: 1, agentPreset: REVIEW_AGENT_PRESET } } }

test('skill 工具：主会话算一次使用', () => {
  assert.deepEqual(usageCandidates({ tool: 'skill', args: { name: 'alpha' }, agent: main }), ['alpha'])
})

test('skill 工具：普通子代理也算（评审以外）', () => {
  assert.deepEqual(
    usageCandidates({ tool: 'skill', args: { name: 'test-driven-development' }, agent: sub }),
    ['test-driven-development'],
    '子代理加载必须计数，否则 TDD 族技能永远是「从未使用」'
  )
})

test('skill 工具：评审会话不计（否则全库被刷成新鲜）', () => {
  assert.deepEqual(usageCandidates({ tool: 'skill', args: { name: 'alpha' }, agent: review }), [])
  // 0.2.1 之前的评审会话没有 preset，只有 label
  assert.deepEqual(
    usageCandidates({ tool: 'skill', args: { name: 'alpha' }, agent: sub, label: 'skill review' }),
    []
  )
})

test('维护动作 skill-library-* 一律不计（哪怕参数里有 name）', () => {
  for (const tool of ['skill-library-read', 'skill-library-tree', 'skill-library-patch', 'skill-library-delete']) {
    assert.deepEqual(usageCandidates({ tool, args: { name: 'alpha' }, agent: main }), [], tool + ' 不该算使用')
  }
})

test('路径命中：read 技能目录下的文件算一次使用', () => {
  const args = { file_path: 'C:\\Users\\Doctor\\.dsh\\skills\\llm-wiki\\SKILL.md' }
  assert.deepEqual(usageCandidates({ tool: 'read', args, agent: main }), ['llm-wiki'])
})

test('路径命中：一次调用里多个技能目录 → 去重且有序', () => {
  const args = {
    command: 'diff ~/.dsh/skills/alpha/SKILL.md ~/.dsh/skills/beta/SKILL.md && cat ~/.dsh/skills/alpha/references/x.md'
  }
  assert.deepEqual(usageCandidates({ tool: 'ops_bash', args, agent: main }), ['alpha', 'beta'])
})

test('路径命中：脚本在技能目录里跑（run_code / bash）同样算', () => {
  const args = { code: "await tools.ops_bash({command:'python3 /home/u/.dsh/skills/llm-wiki/scripts/wiki-ingest.py status'})" }
  assert.deepEqual(usageCandidates({ tool: 'run_code', args, agent: main }), ['llm-wiki'])
})

test('路径命中：只有技能根、没有具体技能名时不算', () => {
  assert.deepEqual(usageCandidates({ tool: 'ops_bash', args: { command: 'ls ~/.dsh/skills' }, agent: main }), [])
  assert.deepEqual(usageCandidates({ tool: 'ops_bash', args: { command: 'ls ~/.dsh/skills-backup/x' }, agent: main }), [])
})

test('arguments 是 JSON 字符串（会话日志形态）也能解析', () => {
  assert.deepEqual(
    usageCandidates({ tool: 'skill', args: '{"name":"beta"}', agent: main }),
    ['beta'],
    'tool/call 事件里 arguments 是字符串，回填要用同一函数'
  )
  assert.deepEqual(usageCandidates({ tool: 'skill', args: '{oops', agent: main }), [], '坏 JSON 不抛错')
})

test('超大参数跳过扫描（run_code 大脚本防抖）', () => {
  const big = 'x'.repeat(5000) + '/.dsh/skills/alpha/SKILL.md'
  assert.deepEqual(skillsInArguments({ code: big }, { maxBytes: 1000 }), [], '超限直接跳过，不做正则')
})

test('工具名缺失/未知类型不炸', () => {
  assert.deepEqual(usageCandidates({ tool: '', args: {}, agent: main }), [])
  assert.deepEqual(usageCandidates({ tool: 'skill', args: null, agent: main }), [])
  assert.deepEqual(isReviewSession(undefined), false)
  assert.equal(isReviewSession({ agentPreset: REVIEW_AGENT_PRESET }), true)
})
