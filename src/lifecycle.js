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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DAY_MS = 86400000

/**
 * 合法技能名（白名单）。
 *
 * 为什么必须有：`state.skills` 是普通对象，`state.skills['__proto__']` 命中的是
 * **Object.prototype**，ensure() 会把 lastUsedAt 直接写到整个进程共享的原型上
 * （2026-10-30 审计实测：markUsed('__proto__') 之后 ({}) .lastUsedAt 就有值了）。
 * 规则与 harness 自己的技能名（skill-tools.js 的 SKILL_ID）同源：小写 kebab。
 * 放宽的代价是「记录能进、归档时被判非法名」的僵尸条目（archive 路由用严格规则）；
 * `__proto__` / `__defineGetter__` 因为首字符是下划线，在入口就被挡掉。
 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 名字能否用作状态表键（非字符串 / 空串 / 原型魔法名一律拒绝）。 */
export function isValidSkillName(name) {
  return typeof name === 'string' && SKILL_NAME.test(name)
}

/**
 * 判定锚点：最后一次使用，没有就用首次登记。
 *
 * lastUsedAt === 0 / 非数字是**坏数据**，不是「1970 年用过」——不归一的话
 * transitions() 会拿 1970 算年龄（≈20000 天）并真的把目录归档进 archived/，
 * 而同一时刻 usageReport 说「从未使用」。三处判定必须共用这一个函数。
 *
 * @returns {number|null} 有效时间戳；都不可用时返回 null（按「刚登记」处理）
 */
function anchorOf(rec) {
  if (Number.isFinite(rec.lastUsedAt) && rec.lastUsedAt > 0) return rec.lastUsedAt
  if (Number.isFinite(rec.firstSeenAt) && rec.firstSeenAt > 0) return rec.firstSeenAt
  return null
}

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
export function createLifecycleStore({ file, archiveRoot, log = () => {}, flushThrottleMs = FLUSH_THROTTLE_MS } = {}) {
  const path = file || defaultLifecyclePath()
  const archivedRoot = archiveRoot || defaultArchiveRoot()
  /** 落盘节流窗口（测试可缩短；生产用 FLUSH_THROTTLE_MS）。 */
  const throttle = Number.isFinite(flushThrottleMs) && flushThrottleMs >= 0 ? flushThrottleMs : FLUSH_THROTTLE_MS

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
  /** 尾随 flush 定时器：节流窗口内最后一次使用必须在窗口结束时补写。 */
  let flushTimer = null
  /** 两条诊断各用一个一次性开关（共用一个会让后出现的那条永远不报）。 */
  let rootUnreadableWarned = false
  let rootDegradedWarned = false

  function persist() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
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
    if (!Object.hasOwn(state.skills, name)) {
      // defineProperty 而不是 state.skills[name] = ...：对象字面量对 __proto__
      // 会走原型 setter（等于改 Object.prototype），defineProperty 建的是自有属性。
      Object.defineProperty(state.skills, name, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
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
      })
    }
    return state.skills[name]
  }

  return {
    /** 全量快照（深拷贝，调用方改它不会污染内部状态）。 */
    snapshot() {
      return JSON.parse(JSON.stringify(state))
    },

    /** 这个技能是否已在状态表里（免去 snapshot() 的整表深拷贝）。 */
    has(name) {
      // Object.hasOwn 而不是 state.skills[name] !== undefined：后者会命中原型链，
      // 于是 has('__proto__') 恒为 true，名字白名单形同虚设。
      return isValidSkillName(name) && Object.hasOwn(state.skills, name)
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
      // 名字白名单在这里也要挡：markUsed 是唯一会被工具参数直接驱动的写入口。
      if (!isValidSkillName(name)) return
      const rec = ensure(name, now)
      rec.lastUsedAt = now
      // 被使用即从 stale/archived 复活（archived = 目录已被放回技能库）
      if (rec.state === 'stale' || rec.state === 'archived') {
        rec.state = 'active'
        rec.archivedAt = null
      }
      if (now - lastFlushAt >= throttle) persist()
      // 节流窗口内：安排尾随 flush。没有它，进程正好在窗口内退出（重启/热重载）
      // 就会永久丢掉这次使用 —— 2026-10-30 查到的 cloud-cost-estimation 即此形态。
      else if (!flushTimer) {
        // clamp 到 [0, throttle]：回填会传**历史**时间戳，now - lastFlushAt 为负会让
        // delay 大到超过 2^31-1ms，node 打 TimeoutOverflowWarning 并把 timer 压成 1ms。
        const delay = Math.min(Math.max(0, throttle - (now - lastFlushAt)), throttle)
        flushTimer = setTimeout(() => { flushTimer = null; persist() }, delay)
        if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref()
      }
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

      // 运行时技能的过期清理：它们磁盘上没有目录，下面的 dropped 循环**永不**删它们
      // （那是为了让 skill-curator 这类运行时技能活下来）。代价是一次写错名字的
      // skill 工具调用会永久留在名单里 ——「在用 N」只增不减。这里给一条时间上限：
      // 超过 180 天没再命中就丢掉（真被使用时 markUsed 会重新登记）。
      // 技能根读不到 / 临时为空时 listSkills 会返回 []：绝不能当成「全被删了」。
      // 否则一次 readdir 失败就会清空所有 firstSeenAt/lastUsedAt（/status 每 30s
      // 轮询一次，随时可能撞上），目录恢复后重新登记为「首见=当下」，历史不可恢复。
      // origin 字段是 2026-10-20 才引入的；更早的 lifecycle.json（v0.2.0-rc.1）没有它。
      // 只数 origin==='disk' 会让旧格式整条绕过下面的守卫（diskKnown=0 → 直接清表）——
      // 判据必须与 toDrop 的「origin==='runtime' 才豁免」口径一致。
      const diskKnown = Object.values(state.skills).filter((r) => r.origin !== 'runtime' && r.state !== 'archived').length
      // 空列表触发的清理必须格外小心：三种情况长得一模一样，但只有一种是真的删光了。
      let emptyRootPrune = false
      if (list.length === 0 && diskKnown > 0) {
        let entries = null
        try { entries = readdirSync(root, { withFileTypes: true }) } catch { entries = null }
        if (entries === null) {
          // ① 根读不到（权限/挂载/DSH_HOME 指错）→ 绝不能清表
          if (!rootUnreadableWarned) {
            rootUnreadableWarned = true
            log('warn', `skill-curator: skill root unreadable (${root}) while ${diskKnown} skills are known; skip pruning (warned once)`)
          }
          return { seeded: 0, dropped: 0, restored: 0, skippedEmpty: true }
        }
        // ② 根里还有**目录类条目**，却一个技能都没认出来：判据不完整 ——
        //    SKILL.md 读不到（云同步脱水/权限/原子写窗口）、技能目录是 junction/软链
        //    （skill-tools 的 listSkills 用 Dirent.isDirectory() 过滤，junction 会被
        //    漏掉 —— 这是已知未修的根因，这里只保证「漏掉时不至于清库」）、
        //    或 skillsRoot 指到了别的目录。
        //    「可读」不能证明「删光了」，此时清表就是不可逆的数据损失。
        //    只排除点条目：技能库常是 git 工作树，只剩 .git 时仍应算「真删光」。
        // 只认「目录类」条目（stat 会跟随 junction/软链）。普通文件（README/LICENSE）
        // 不算存活，否则删光技能后留一个 README 就永远清不掉僵尸记录。
        const survivorCount = entries.filter((e) => {
          if (e.name.startsWith('.')) return false
          if (e.isDirectory()) return true
          try { return statSync(join(root, e.name)).isDirectory() } catch { return true }
        }).length
        if (survivorCount > 0) {
          if (!rootDegradedWarned) {
            rootDegradedWarned = true
            log('warn', `skill-curator: root ${root} has ${survivorCount} dir(s) but 0 recognized skills while ${diskKnown} known; skip pruning (warned once)`)
          }
          return { seeded: 0, dropped: 0, restored: 0, skippedEmpty: true }
        }
        // ③ 根里连一个目录都没有 = 用户真删光了 → 正常清理（但仍先写 .bak）
        emptyRootPrune = true
      }

      let seeded = 0
      let restored = 0
      for (const name of list) {
        // 目录名也要过白名单：磁盘上真有个叫 __proto__ 的目录时，普通赋值会把
        // origin='disk' 写到原型上（defineProperty 不会，但没必要登记这种名字）。
        if (!isValidSkillName(name)) continue
        const rec = Object.hasOwn(state.skills, name) ? state.skills[name] : null
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
          // ⚠️ **不要**在这里写 lastUsedAt = now。
          // 「目录重现」只证明它回到了技能库，**不代表它被使用过** ——
          // 面板/判定看的是「最后一次被 skill 工具加载」，不是「最后一次被恢复」。
          // 写成 now 会把一个 200 天没用过的技能刷成「刚刚用过」，
          // 于是它永远不进 stale、永远不进归档候选（2026-10-20 真机踩到：
          // 对账复活两条 200 天前的实验技能后，lastUsedAt 变成对账时刻，
          // wouldArchive 立刻空了）。真正被加载时 markUsed() 会自己写入。
          restored += 1
        }
      }
      // 运行时技能的过期清理必须在「提升为 disk」之后：同一个名字可能这次才刚回到
      // 技能库（seen 里有它），先清后提会把一条真实技能当成幽灵删掉，然后重新登记
      // 成「首见=当下」——历史直接归零（2026-10-30 自测过：面板候选突然消失）。
      const RUNTIME_TTL_MS = 180 * DAY_MS
      let expired = 0
      for (const [name, rec] of Object.entries(state.skills)) {
        if (seen.has(name)) continue
        if (rec.origin !== 'runtime' || rec.pinned || rec.state === 'archived') continue
        // 用同一个 anchorOf（第 4 处拷贝曾把 0 当 1970，进而把记录**删掉** —— 比误判
        // 更不可逆）。锚点无效就不判过期。
        const last = anchorOf(rec)
        if (last === null) continue
        if (Date.now() - last > RUNTIME_TTL_MS) {
          delete state.skills[name]
          expired += 1
        }
      }

      // 先算出这一轮要删谁，删得多就先留一份 .bak —— 一次大规模误删（技能库被挂载
      // 到别处、DSH_HOME 指错）是**不可逆**的数据损失，而 backups/ 只服务回填脚本。
      const toDrop = Object.keys(state.skills).filter((name) => {
        const rec = state.skills[name]
        // 只清「曾经是磁盘技能、现在磁盘上没有」的条目。
        // 运行时技能（origin === 'runtime'，如 skill-curator）在磁盘上**永远没有**
        // 目录，不能因为它不在 list 里就删 —— 那会让它每轮评审都消失（2026-10-20
        // 真机实测：加载 skill-curator → 下一轮 syncWith 后状态表里查不到）。
        // archived 同样豁免：归档目录在技能库之外，本来就不在 list 里。
        if (rec.origin === 'runtime') return false
        return !seen.has(name) && rec.state !== 'archived'
      })
      let dropped = expired
      // 空列表触发的清理无条件留快照：这类误判往往是「指错根 / 读不到」，一次就能清空历史。
      if (toDrop.length >= 5 || (emptyRootPrune && toDrop.length > 0)) {
        try {
          copyFileSync(path, `${path}.bak`)
          log('warn', `skill-curator: pruning ${toDrop.length} skills; snapshot saved to ${path}.bak`)
        } catch (error) {
          // 备份失败不阻塞清理，但必须留痕（否则「写前留快照」这条承诺是空话）
          log('warn', `skill-curator: lifecycle .bak snapshot failed: ${(error && error.message) || error}`)
        }
      }
      for (const name of toDrop) {
        delete state.skills[name]
        dropped += 1
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
        const anchor = anchorOf(rec)
        const ageDays = anchor === null ? 0 : (now - anchor) / DAY_MS
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
      // 技能库已有同名 → 拒绝（绝不覆盖，与 archive() 的「不覆盖旧归档」对称）
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
      // ⚠️ **不要**写 lastUsedAt = now。恢复只证明它回到技能库，**不代表被使用过**。
      // 写成 now 会把一个 200 天没用过的技能刷成「刚刚用过」→ 永远不进 stale、
      // 永远不进归档候选（2026-10-20 真机在 syncWith 的复活分支踩过一次，
      // 这里是同一 bug 的第二处；两处都已由测试钉死）。
      rec.origin = 'disk'
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

    /**
     * 状态摘要（状态面板 / 工具回显 / UI 面板用）。
     *
     * @param {object} [opts]
     * @param {number} [opts.archiveDays] - 传入则额外算出 `wouldArchive`
     *   （超过该天数、非 pinned、非 archived、且磁盘上还在的技能）。
     *   不传则不含该字段 —— 调用方拿不到阈值时宁可不给名单，也不给错的。
     */
    summary({ archiveDays } = {}) {
      const out = { active: [], stale: [], archived: [], neverUsed: [] }
      for (const [name, rec] of Object.entries(state.skills)) {
        const bucket = out[rec.state] || out.active
        bucket.push(name)
        if (!rec.lastUsedAt) out.neverUsed.push(name)
      }
      for (const key of Object.keys(out)) out[key].sort()
      const result = {
        ...out,
        lastPassAt: state.lastPassAt,
        pinned: Object.entries(state.skills).filter(([, r]) => r.pinned).map(([n]) => n).sort()
      }
      const days = Number(archiveDays)
      if (Number.isFinite(days)) {
        // 「够格归档」= UI 一键归档的候选集，必须与 transitions() 的判定同源，
        // 否则面板会推荐一个 archive() 拒绝做的动作。
        const now = Date.now()
        result.wouldArchive = Object.entries(state.skills)
          .filter(([, rec]) => {
            if (rec.pinned || rec.state === 'archived') return false
            // 运行时技能不在磁盘上，归档它只会失败 —— 不进候选集。
            if (rec.origin === 'runtime') return false
            const anchor = anchorOf(rec)
            return anchor !== null && (now - anchor) / DAY_MS > days
          })
          .map(([n]) => n)
          .sort()
      }
      return result
    },

    /**
     * 面板用的年龄分桶（三个数字 + 名单）。
     *
     * 与 summary() 的分工：summary() 是状态机快照（state 桶要等下一轮评审才刷新），
     * 这里是**现算**的年龄视图，面板点开看到的就是当下的真实年龄，不滞后。
     * 也刻意不塞进 summary()：`skill-library-lifecycle` 工具的输出契约写死在
     * review-prompt 里（"不含逐技能时间戳"），改它会污染评审子代理的上下文。
     *
     * 过滤规则（三个桶共用）：排除运行时技能（origin==='runtime'）、已归档、钉住。
     * 注意用「排除 runtime」而不是「只要 disk」：origin 字段是后来才加的，
     * 旧格式（无 origin）记录在第一次 syncWith 之前也得能算进来。
     * 运行时技能不在磁盘上，归档必失败，出现只会误导。
     *
     * 语义关系：`neverUsed ⊆ idle`（首见时间够老时）、`archiveable ⊆ idle`。
     * 面板必须把这点写出来，否则用户会奇怪"三个数加起来不对"。
     *
     * @param {object} opts
     * @param {number} opts.staleDays - 多久未用算"久未用"
     * @param {number} opts.archiveDays - 多久未用算"够格归档"
     * @param {number} [opts.now] - 时间基准（测试注入）
     * @returns {{staleDays: number, archiveDays: number, generatedAt: number,
     *   neverUsed: Array<{name: string, lastUsedAt: number|null, days: number}>,
     *   idle: Array<{name: string, lastUsedAt: number|null, days: number}>,
     *   archiveable: Array<{name: string, lastUsedAt: number|null, days: number}>}}
     */
    usageReport({ staleDays, archiveDays, now = Date.now() } = {}) {
      const stale = Number(staleDays)
      const archive = Number(archiveDays)
      if (!Number.isFinite(stale) || !Number.isFinite(archive)) {
        throw new Error(
          `lifecycle.usageReport: staleDays/archiveDays must be finite numbers (got ${staleDays}/${archiveDays})`
        )
      }
      const rows = []
      for (const [name, rec] of Object.entries(state.skills)) {
        if (rec.origin === 'runtime') continue
        if (rec.state === 'archived') continue
        if (rec.pinned) continue
        // 坏数据兜底：手改/半写的 lifecycle.json 里 firstSeenAt 可能缺失或非数字，
        // 直接相减会得到 NaN，NaN 参与排序与 JSON 序列化后变成 null / 乱序。
        // 与 transitions()/summary() 共用 anchorOf：0 与非数字一律视为坏数据。
        const last = Number.isFinite(rec.lastUsedAt) && rec.lastUsedAt > 0 ? rec.lastUsedAt : null
        const anchor = anchorOf(rec)
        rows.push({ name, lastUsedAt: last, ageDays: anchor === null ? 0 : Math.max(0, (now - anchor) / DAY_MS) })
      }
      const bucket = (predicate) =>
        rows
          .filter(predicate)
          .map((r) => ({ name: r.name, lastUsedAt: r.lastUsedAt, days: Math.floor(r.ageDays) }))
          .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name))
      return {
        staleDays: stale,
        archiveDays: archive,
        generatedAt: now,
        neverUsed: bucket((r) => !r.lastUsedAt),
        idle: bucket((r) => r.ageDays > stale),
        archiveable: bucket((r) => r.ageDays > archive)
      }
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
