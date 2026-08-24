/**
 * dsh-skill-curator — 评审历史持久化存储。
 *
 * 「最近评审」记录落盘 <DSH_HOME>/skill-curator/reviews.json（可由 patch
 * config.historyPath 覆盖），插件卸载/重装/重启后记录仍在：
 *
 *   - 启动：readFileSync 同步加载（cordis 契约：apply 必须同步，启动期 IO
 *     用同步版本；文件缺失/损坏按空表容错）；
 *   - 写入：record() 后原子写（tmp + renameSync），失败仅警告不炸评审；
 *   - 上限：默认保留最近 50 条。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 默认历史文件：<DSH_HOME>/skill-curator/reviews.json。 */
export function defaultHistoryPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skill-curator', 'reviews.json')
}

/**
 * 创建持久化评审历史。
 *
 * @param {object} opts
 * @param {string} [opts.file] - 历史文件绝对路径（缺省 defaultHistoryPath()）。
 * @param {number} [opts.max=50] - 保留条数上限。
 * @param {(level: string, message: string) => void} [opts.log] - 日志钩子（写失败告警）。
 */
export function createHistoryStore({ file, max = 50, log = () => {} } = {}) {
  const path = file || defaultHistoryPath()

  let runs = []
  // 启动同步加载：缺失/损坏按空表容错（绝不炸 apply）
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) runs = parsed.filter((e) => e && typeof e === 'object').slice(0, max)
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      log('warn', `skill-curator: history load failed (${(error && error.message) || error}); starting empty`)
    }
  }

  /** 落盘（原子：tmp + renameSync）。失败仅告警。 */
  function persist() {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(runs, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (error) {
      log('warn', `skill-curator: history write failed: ${(error && error.message) || error}`)
    }
  }

  return {
    /** 记录一次评审并立即落盘。 */
    record(entry) {
      runs.unshift(entry)
      if (runs.length > max) runs.length = max
      persist()
    },
    /** 最近记录（新→旧）。 */
    recent() {
      return runs
    },
    /** 历史文件路径。 */
    get path() {
      return path
    }
  }
}
