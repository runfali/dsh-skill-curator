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
      state.skills[name] = {
        state: 'active',
        firstSeenAt: now,
        lastUsedAt: null,
        archivedAt: null,
        pinned: false,
        // 来源标记：'disk' = 由 syncWith 从技能库磁盘登记；'runtime' = 只被
        // markUsed 记过、磁盘上没有目录（插件 skills.register 的运行时技能）。
        // 缺它的话 syncWith 的 dropped 循环分不清「运行时技能」与「真被删掉的技能」，
        // 会把 skill-curator 每轮评审都清掉（2026-10-20 真机实测）。
        origin: 'runtime'
      }
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
      // 被使用即从 stale/archived 复活（archived = 目录已被放回技能库）
      if (rec.state === 'stale' || rec.state === 'archived') {
        rec.state = 'active'
        rec.archivedAt = null
      }
      if (now - lastFlushAt >= FLUSH_THROTTLE_MS) persist()
    },

    /**
     * 与磁盘同步：登记新技能、清理已消失的技能。
     * @param {string} root - 技能库根。
     * @param {string[]} [names] - 已知技能名；**省略时自己 readdir**（两种调用形态都必须成立）。
     * @returns {{seeded: number, dropped: number, restored: number}}
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
      let restored = 0
      for (const name of list) {
        const rec = state.skills[name]
        if (!rec) {
          ensure(name).origin = 'disk'
          seeded += 1
          continue
        }
        // 磁盘上出现过 = 它是磁盘技能（可能是运行时技能同名，但以磁盘为准）
        rec.origin = 'disk'
        // 目录重新出现而状态仍是 archived = 已被恢复（技能库是 git 工作树，
        // `git checkout` 就能把归档目录放回来，绕过 restore 工具）。
        // 不重置的话：transitions() 只按 ageDays 判定，而 archived 记录既不会
        // 被 stale/active 分支改回（两分支都要求 state 恰好匹配），也不会被
        // dropped 清掉（archived 有豁免）→ 状态永久卡在 archived。
        if (rec.state === 'archived') {
          rec.state = 'active'
          rec.archivedAt = null
          rec.lastUsedAt = Date.now()
          restored += 1
        }
      }
      let dropped = 0
      for (const name of Object.keys(state.skills)) {
        const rec = state.skills[name]
        // 只清「曾经是磁盘技能、现在磁盘上没有」的条目。
        // 运行时技能（origin === 'runtime'，如 skill-curator）在磁盘上**永远没有**
        // 目录，不能因为它不在 list 里就删 —— 那会让它每轮评审都消失（2026-10-20
        // 真机实测：加载 skill-curator → 下一轮 syncWith 后状态表里查不到）。
        // archived 同样豁免：归档目录在技能库之外，本来就不在 list 里。
        if (rec.origin === 'runtime') continue
        if (!seen.has(name) && rec.state !== 'archived') {
          delete state.skills[name]
          dropped += 1
        }
      }
      if (seeded > 0 || dropped > 0 || restored > 0) persist()
      return { seeded, dropped, restored }
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
      // 非有限数字必须响亮失败：不校验时 `ageDays > undefined` 恒 false →
      // 静默「什么都不标」，看起来像生命周期在工作，实际空转。
      const stale = Number(staleDays)
      const archive = Number(archiveDays)
      if (!Number.isFinite(stale) || !Number.isFinite(archive)) {
        throw new Error(
          `lifecycle.transitions: staleDays/archiveDays must be finite numbers (got ${staleDays}/${archiveDays})`
        )
      }
      const counts = { checked: 0, markedStale: 0, reactivated: 0, wouldArchive: 0, archived: 0 }
      for (const [name, rec] of Object.entries(state.skills)) {
        counts.checked += 1
        if (rec.pinned) continue
        // 已归档记录短路：目录已不在技能库里，既不该再判 stale，也不该再计
        // wouldArchive。少了这条，归档后每轮评审都报「1 个够格归档」而归档必然
        // 失败（目录不在）→ 永久虚报。
        if (rec.state === 'archived') continue
        const anchor = rec.lastUsedAt ?? rec.firstSeenAt
        const ageDays = (now - anchor) / DAY_MS
        const isStale = ageDays > stale
        const archiveable = ageDays > archive
        if (archiveable) {
          counts.wouldArchive += 1
          if (archiveEnabled && typeof archiveFn === 'function' && archiveFn(name)) {
            counts.archived += 1
            continue
          }
        }
        if (isStale && rec.state === 'active') {
          rec.state = 'stale'
          counts.markedStale += 1
        } else if (!isStale && rec.state === 'stale') {
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
