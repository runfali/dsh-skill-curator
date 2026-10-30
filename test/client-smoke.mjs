/**
 * dsh-skill-curator client bundle 结构加载测试。
 *
 * 运行：node test/client-smoke.mjs
 * 构造最小 window.__ModuleLoader__ + require stub（react/jsx-runtime / primitives），
 * 加载 lib/client.js，执行 apply，验证：
 * 1. bundle id 与包名一致（dsh-client-modules 契约）
 * 2. locale 词典注册（zh/en 键集合一致、覆盖全部字段 label/hint/分组）
 * 3. settingsScope 绑定 namespace=skill-curator
 * 4. settings.plugin.item 槽位注册：key/locale 正确，inject() 提供 hooks+actions
 * 5. 组件渲染树真实执行（FieldRow 的 t 传递等装配缺陷在此暴露）
 * 6. save 流程把暂存值写进 scope user 层
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const PASS = []
const ok = (label) => { PASS.push(label); console.log('  ✓ ' + label) }

// ---- react stub ----
function makeElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined) }
}
// hooks 调用签名记录器（审计第六路盲区）：组件里任何早退都会让两次渲染的
// hooks 数量/顺序不同，真机 React 抛 "Rendered fewer hooks than expected"。
const hookLog = []
const reactStub = {
  useState: (init) => { hookLog.push('useState'); return [typeof init === 'function' ? init() : init, () => {}] },
  useEffect: () => { hookLog.push('useEffect') },
  useSyncExternalStore: (subscribe, getSnapshot) => { hookLog.push('useSyncExternalStore'); return getSnapshot() }
}
function makeJsx() {
  return (...args) => {
    const type = args[0]
    const props = args[1] || {}
    const children = args.slice(2).flat().filter((c) => c !== null && c !== undefined)
    return makeElement(type, props, ...children)
  }
}
const jsxStub = { jsx: makeJsx(), jsxs: makeJsx() }

let renderDepth = 0
const renderedTags = []
// 渲染出来的文本节点（字符串子节点）。tree2 只是**元素树**（组件未执行），
// 断言「面板上真的出现了这一组」必须看渲染产物，不是元素树。
let renderedText = []
// usage 分组 <ul hidden> 的可见性快照（折叠契约只能从这里断言，见 .SCc_lcUsage）
let lcUsageHidden = []
function renderTree(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { for (const c of node) renderTree(c); return }
  if (typeof node === 'string' || typeof node === 'number') { renderedText.push(String(node)); return }
  if (typeof node.type === 'function') {
    renderDepth += 1
    if (renderDepth > 60) throw new Error('component tree too deep — likely infinite recursion')
    const children = node.type(node.props)
    renderDepth -= 1
    if (children !== null && children !== undefined) renderTree(children)
    return
  }
  if (typeof node.type === 'string') renderedTags.push(node.type)
  if (node.props && typeof node.props.className === 'string' && node.props.className.includes('SCc_lcUsage')) {
    lcUsageHidden.push(node.props.hidden)
  }
  if (Array.isArray(node.children)) for (const c of node.children) renderTree(c)
  if (node.props && node.props.children !== undefined) renderTree(node.props.children)
}

// ---- ctx stub ----
const registered = { locales: [], slots: [], scopeNamespaces: [], scope: null }
const slotRegistrations = []
const ctxStub = {
  effect: (fn) => { fn(); return () => {} },
  locale: {
    register(ns, dict) { registered.locales.push({ ns, dict }) },
    // 0.1.7：卡片 label 走 locale thunk（ctx.locale.bind(NS)）
    bind(ns) { return (key) => (registered.locales.find((l) => l.ns === ns)?.dict?.zh[key]) || key }
  },
  slots: {
    // 0.1.7 槽位契约："settings.plugin.item"（keyed）→ "plugins.item"（list）。
    // 注册回调返回 disposer（不是 generator）；whileServed 决定何时注册。
    inject(slotName, register) {
      assert.equal(slotName, 'plugins.item', 'slot name')
      const reg = register()
      slotRegistrations.push({ slotName, reg })
      return () => {}
    },
    register(def, component) { return { def, component } }
  },
  configForms: {
    // 0.1.7：settingsScope.bind → configForms.get(ns)，快照同形（status/value/user/writable）
    // 且多出 base/revision/mode——Form 只读它认识的那几个键。
    get(ns) {
      registered.scopeNamespaces.push(ns)
      if (registered.scope) return registered.scope
      const state = { status: 'ready', writable: true, value: { enabled: true, skillNudgeInterval: 3, notifyMode: 'on' }, user: {}, revision: 0, mode: 'host' }
      const listeners = new Set()
      const scope = {
        getSnapshot: () => state,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        set(key, value) { state.user = { ...state.user, [key]: value }; state.value = { ...state.value, [key]: value }; listeners.forEach((fn) => fn()); return Promise.resolve() },
        unset(key) { const u = { ...state.user }; delete u[key]; state.user = u; listeners.forEach((fn) => fn()); return Promise.resolve() }
      }
      registered.scope = scope
      return scope
    },
    // 宿主开始服务本命名空间才注册卡片（真实环境由 settings.describe 驱动）
    whileServed(namespaces, register) { registered.served = namespaces.slice(); return register(new Set(namespaces)) }
  }
}

// ---- 加载 bundle（沙箱）----
const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(bundleSource, /id: "dsh-skill-curator"/, 'bundle id equals package name')
const sandboxRequire = (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxStub
  throw new Error('unexpected require: ' + name)
}
const loaderStore = {}
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) { loaderStore.entry = entry },
    _last: null
  }
}
fakeWindow.window = fakeWindow
vm.createContext(fakeWindow)
vm.runInContext(bundleSource, fakeWindow, { filename: 'lib/client.js' })
// 捕获 factory 内导出的 apply/inject：factory 通过 require('react') 闭包执行
const captured = loaderStore.entry.factory.call(null, sandboxRequire)
assert.equal(typeof captured.apply, 'function', 'apply exported')
assert.equal(captured.inject.join(','), 'slots,locale,configForms', 'inject services (0.1.7)')
captured.apply(ctxStub)
ok('bundle id + apply executed')

// ---- 断言 ----
assert.equal(registered.scopeNamespaces[0], 'skill-curator', 'configForms namespace')
// 注意：bundle 在 vm 沙箱里执行，拿到的数组属于另一个 realm——用 JSON 比内容，不比原型
assert.equal(JSON.stringify(registered.served), '["skill-curator"]', 'whileServed follows the skill-curator namespace')
assert.equal(slotRegistrations.length, 2, 'two slot registrations: settings card + lifecycle panel')
const slot = slotRegistrations[0].reg.def
assert.equal(slot.name, 'plugins.item', 'slot name')
assert.equal(slot.id, 'skill-curator', 'slot id')
assert.equal(slot.locale, 'skill-curator', 'slot locale')
assert.equal(typeof slot.order, 'number', 'slot order (list slot needs a stable sort key)')
assert.equal(slot.label(), '技能策展（Skill Curator）', 'label is a locale-driven thunk')
// 第二个条目：独立的生命周期面板（不挤进设置卡，否则卡片越滚越长）
const lcSlot = slotRegistrations[1].reg.def
assert.equal(lcSlot.name, 'plugins.item', 'lifecycle slot name')
assert.equal(lcSlot.id, 'skill-curator-lifecycle', 'lifecycle slot id (distinct from the card)')
assert.equal(lcSlot.label(), '技能生命周期', 'lifecycle label')
assert.ok(lcSlot.order > slot.order, 'lifecycle panel sorts after the settings card')
assert.equal(typeof slotRegistrations[1].reg.component, 'function', 'lifecycle component captured')
const Component = slotRegistrations[0].reg.component
assert.equal(typeof Component, 'function', 'component captured')
const injected = slot.inject()
assert.ok(injected.hooks && injected.hooks.curator && typeof injected.hooks.curator.getSnapshot === 'function', 'hooks.curator store')
for (const fn of ['edit', 'toggle', 'resetField', 'discard', 'save']) {
  assert.equal(typeof injected[fn], 'function', `action ${fn}`)
}
ok('configForms + plugins.item slot + actions')

assert.equal(registered.locales.length, 1, 'one locale registration')
const dict = registered.locales[0].dict
const zhKeys = Object.keys(dict.zh)
const enKeys = Object.keys(dict.en)
assert.deepEqual(enKeys.sort(), zhKeys.sort(), 'zh/en key parity')
const fieldKeys = ['enabled', 'skillNudgeInterval', 'digestTail', 'digestMaxChars', 'reviewTimeoutMs', 'reviewProvider', 'reviewModel', 'reviewBaseUrl', 'reviewApiKey', 'reviewRetryCount', 'reviewRetryDelayMs', 'excludedSkills', 'notifyMode', 'staleDays', 'archiveDays', 'archiveEnabled']
for (const k of fieldKeys) {
  assert.ok(zhKeys.includes('field.' + k), `field.${k} label`)
  assert.ok(zhKeys.includes('hint.' + k), `hint.${k} hint`)
}
ok('locale parity + all field labels/hints')

// ---- 渲染树真实执行（默认折叠态也要执行子组件路径）----
// 契约：注册的 hooks 键转成 use<Name> observable hook（selector 形式）
const makeUseCurator = (store) => (selector) => selector(store.getSnapshot())
const store = injected.hooks.curator
const tree = makeElement(Component, {
  t: (key) => dict.zh[key] || key,
  useCurator: makeUseCurator(store),
  ...injected
})
renderTree(tree)
ok('component tree renders (default collapsed state)')

// 展开态渲染（执行 FieldRow 全分支）
const expanded = makeElement(Component, {
  t: (key) => dict.zh[key] || key,
  hooks: { curator: store },
  ...injected
})
// 折叠态由组件内部 useState 控制（reactStubOpen 把首个 useState 顶成 true），
// 这里不再往 props 上塞 open（那是死代码，组件根本不读）。
let controlState = null
// 只把**第一个** useState 顶成 true（设置卡/面板的折叠开关），其余一律返回真实初值。
// 旧版对所有 hook 都返回 true：busy/restoreBusy/notice 全是 true，整场卡在
// 「归档中…/恢复中…」，交互分支等于从没被测过（审计发现，2026-10-30）。
let openStubCalls = 0
const hookSeq = []
const reactStubOpen = {
  useState: (init) => {
    openStubCalls += 1
    hookSeq.push('useState')
    const value = openStubCalls === 1 ? true : (typeof init === 'function' ? init() : init)
    if (openStubCalls === 1) controlState = value
    return [value, () => {}]
  },
  useEffect: () => { hookSeq.push('useEffect') },
  useSyncExternalStore: (s, g) => { hookSeq.push('useSyncExternalStore'); return g() }
}
const sandboxRequire2 = (name) => {
  if (name === 'react') return reactStubOpen
  if (name === 'react/jsx-runtime') return jsxStub
  throw new Error('unexpected require: ' + name)
}
const loaderStore2 = {}
vm.runInContext(bundleSource, (() => { const w = { __ModuleLoader__: { load(e) { loaderStore2.entry = e } } }; w.window = w; vm.createContext(w); return w })(), { filename: 'lib/client.js' })
const captured2 = loaderStore2.entry.factory.call(null, sandboxRequire2)
const injected2 = (() => {
  const r = { slots: { inject(name, gen) { registered.slots.length = 0; const reg = gen().next().value; registered.slots.push(reg) } } }
  return r
})()
// 展开态组件的槽位注册需要完整 ctx——复用第一个 ctx 但 replace slot 捕获
const ctxStub2 = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register() {}, bind(ns) { return (key) => (registered.locales.find((l) => l.ns === ns)?.dict?.zh[key]) || key } },
  configForms: {
    get() { return registered.scope },
    whileServed(namespaces, register) { register(new Set(namespaces)); return () => {} }
  },
  slots: {
    inject(name, register) {
      const reg = register()
      // 现在有两次注册：设置卡（有 inject）与生命周期面板（无 inject）。
      // 只认第一次带 inject 的作为「设置卡」，第二个单独留档。
      if (reg.def.inject && registered.inject2 === undefined) {
        registered.inject2 = reg.def.inject
        registered.Component2 = reg.component
      } else if (!reg.def.inject) {
        registered.lifecycleComponent = reg.component
        registered.lifecycleDef = reg.def
      }
      return () => {}
    },
    register(def, component) { return { def, component } }
  }
}
captured2.apply(ctxStub2)
const injected2Actions = registered.inject2()
const tree2 = makeElement(registered.Component2, { t: (key) => dict.zh[key] || key, useCurator: makeUseCurator(injected2Actions.hooks.curator), ...injected2Actions })
renderTree(tree2)
assert.ok(renderedTags.includes('input'), 'expanded: inputs rendered')
assert.ok(renderedTags.includes('button'), 'expanded: buttons rendered (save/discard + enum segments)')
assert.ok(renderedTags.includes('select') === false, 'enum rendered as segmented buttons, not select')
assert.ok(renderedTags.includes('ul') || renderedTags.includes('p'), 'expanded: status panel rendered')
const json = JSON.stringify(tree2)
assert.ok(!json.includes('undefined'), 'no undefined leakage in render')
// 分组真的要渲染出来：只查 FIELDS/GROUPS 数组存在（entry.test.mjs 已查）不等于
// 面板上有这一组——组标题不进 GROUPS 就静默消失，用户永远看不到这三个开关。
const text2 = renderedText.join(' | ')
assert.ok(text2.includes('技能生命周期'), 'expanded: lifecycle group title rendered')
for (const label of ['多久未用标记为 stale（天）', '多久未用够格归档（天）', '允许自动归档']) {
  assert.ok(text2.includes(label), `expanded: lifecycle field rendered — ${label}`)
}
ok('expanded render (FieldRow all branches, status panel)')

// ---- hooks 顺序守护：summary / detail 视图切换不得改变 hooks 数量 ----
// 注：useCurator 是框架注入的 selector hook（不经 react 模块），这里只记录真实 react hooks
const detailHooks = hookLog.length
const detailSeq = hookLog.join(',')
assert.ok(detailHooks >= 1, 'detail view calls the component hooks (' + detailHooks + ')')
hookLog.length = 0
const summaryTree = makeElement(Component, {
  t: (key) => dict.zh[key] || key,
  useCurator: makeUseCurator(store),
  ...injected,
  view: 'summary'
})
renderTree(summaryTree)
assert.equal(hookLog.join(','), detailSeq, 'summary view must call the SAME hook sequence (no early return before hooks, no reordering)')
ok('hooks order stable across summary/detail views')

// ---- 保存流程（staged → scope.set）----
await injected.edit('skillNudgeInterval', '5')
await injected.save()
const user = registered.scope.getSnapshot().user
assert.equal(user.skillNudgeInterval, 5, 'saved value lands in user layer')
const proj = injected.hooks.curator.getSnapshot()
assert.equal(proj.shell.dirty, false, 'dirty cleared after save')
ok('save flow writes user layer')

// ---- 生命周期面板：独立条目真的渲染出候选与归档/恢复 ----
// 判据：数据有（status 返回 wouldArchive / archived）≠ 面板画了。上一轮的教训是
// 「删掉整块渲染也全绿」，所以这里**喂真实形状的数据**再看渲染产物。
// 不喂数据的话面板停在 error/空分支，断言「没渲染」可能是"没数据"造成的假绿。
{
  const lifecycleComponent = registered.lifecycleComponent
  assert.equal(typeof lifecycleComponent, 'function', 'lifecycle panel component captured')
  const lcDict = (key) => dict.zh[key] || key

  const fakeStatus = {
    ok: true,
    archiveEnabled: false,
    reviews: [],
    lifecycle: {
      active: ['alpha-skill'],
      stale: ['beta-skill'],
      archived: ['gone-one', 'gone-two'],
      neverUsed: ['never-a'],
      pinned: [],
      wouldArchive: ['alpha-skill'],
      lastPassAt: Date.now(),
      // 面板三组年龄数字：阈值跟随设置（这里给非默认值 14/45，
      // 任何写死 30/90 的实现都会被断言抓住）
      usage: {
        staleDays: 14,
        archiveDays: 45,
        neverUsed: [{ name: 'never-a', days: 9, lastUsedAt: null }],
        idle: [{ name: 'old-b', days: 40, lastUsedAt: Date.now() - 40 * 86400000 }],
        archiveable: [{ name: 'old-c', days: 120, lastUsedAt: Date.now() - 120 * 86400000 }]
      }
    }
  }
  // CSS 契约：折叠靠 [hidden]，而 .SCc_lcList 自带 display:flex —— 作者样式压过
  // 浏览器默认的 [hidden]{display:none}，缺少下面这条规则折叠等于没做，而且
  // 任何渲染断言都发现不了（树里节点一直在）。只能钉源码规则。
  assert.match(
    bundleSource,
    /\.SCc_lcList\[hidden\]\{display:none\}/,
    'collapsed usage list must actually hide (display:flex overrides UA [hidden])'
  )

  const realFetch = globalThis.fetch
  // 面板在 useEffect 里 load()：返回已 resolve 的 promise。
  // 组件渲染是同步的，首帧拿不到数据 → 只能断言**折叠态标题**。
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(fakeStatus) })
  try {
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: fakeStatus, open: true } }))
    const text = renderedText.join(' | ')
    assert.ok(text.includes('技能生命周期'), 'panel title rendered through locale')
    // 关键：不能出现未解析的 locale key（渲染时 t() 必须命中字典）
    assert.ok(!/\blc\.[a-zA-Z]+\b/.test(text), 'no unresolved locale keys in the render tree')

    // 三组年龄数字：数量、阈值（必须来自 usage，不能写死 30/90）、名单与天数
    assert.ok(text.includes('从未使用（1）'), 'never-used group with count')
    assert.ok(text.includes('14 天未用（1）'), 'idle group bound to settings staleDays (14)')
    assert.ok(text.includes('45 天够格归档（1）'), 'archiveable group bound to settings archiveDays (45)')
    assert.ok(text.includes('never-a'), 'never-used name rendered')
    assert.ok(text.includes('old-b · 40 天'), 'idle name + age rendered')
    assert.ok(text.includes('old-c · 120 天'), 'archiveable name + age rendered')
    // 旧的「久未用」状态桶必须消失（与年龄分组重复，会给出两个互相矛盾的数字）
    assert.ok(!text.includes('久未用'), 'legacy stale bucket removed from the panel')
    // 归档候选与「够格归档」分组同源：夹具里 wouldArchive 是状态机旧值（alpha-skill），
    // 现算的 usage.archiveable 是 old-c —— 面板必须用后者，否则两处数字互相矛盾。
    assert.ok(text.includes('old-c'), 'archive list uses live usage.archiveable')
    assert.ok(!text.includes('alpha-skill'), 'stale wouldArchive must not drive the archive list')
    ok('lifecycle panel renders usage groups (counts + names + ages)')

    // 折叠契约的第二半：CSS 规则在，但 JSX 真得绑了 hidden。删掉 hidden: !open
    // 后名字仍会出现在渲染树里（renderTree 不读 props.hidden），所以必须直接看属性。
    assert.equal(lcUsageHidden.length, 3, 'three usage lists rendered (never / idle / archiveable)')
    assert.ok(lcUsageHidden.every((v) => v === true), 'usage lists are collapsed by default')

    // 静止态的按钮文案：busy 必须是 false（旧夹具恒 true，永远显示「归档中…」）
    assert.ok(text.includes('归档选中（0）'), 'archive button reflects idle state + selection count')
    assert.ok(text.includes('恢复选中（0）'), 'restore button reflects idle state')
    assert.ok(!text.includes('归档中…') && !text.includes('恢复中…'), 'buttons must not be stuck in busy state')

    // 面板 hooks 顺序：detail 与 summary 必须调用完全相同的序列（early-return 之前）
    hookSeq.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: fakeStatus, open: true } }))
    const panelDetailSeq = hookSeq.join(',')
    hookSeq.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, view: 'summary', __debug: { status: fakeStatus, open: true } }))
    assert.equal(hookSeq.join(','), panelDetailSeq, 'panel must call the same hook sequence in both views')
    ok('lifecycle panel hook sequence stable across views')

    // 列表页一行摘要：不点进去也能看到三个数
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, view: 'summary', __debug: { status: fakeStatus, open: true } }))
    const summary = renderedText.join(' ')
    assert.ok(summary.includes('从未用 1'), 'summary line shows never-used count')
    assert.ok(summary.includes('14 天未用 1'), 'summary line shows idle count with setting threshold')
    assert.ok(summary.includes('45 天够格 1'), 'summary line shows archiveable count')
    ok('lifecycle summary line shows three counts')

    // 半旧版 status（有桶没阈值）必须退回旧摘要，而不是渲染 "undefined 天未用"
    const legacy = JSON.parse(JSON.stringify(fakeStatus))
    delete legacy.lifecycle.usage.staleDays
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, view: 'summary', __debug: { status: legacy, open: true } }))
    const legacyText = renderedText.join(' ')
    assert.ok(!legacyText.includes('undefined'), 'bad status must not leak undefined into copy')
    assert.ok(legacyText.includes('够格归档'), 'falls back to the legacy one-line summary')

    // 详情视图同样不能泄 undefined（守卫原先只加在 summary 一行）
    renderedText.length = 0
    lcUsageHidden = []
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: legacy, open: true } }))
    const legacyDetail = renderedText.join(' | ')
    assert.ok(!legacyDetail.includes('undefined'), 'detail view must not leak undefined either')
    assert.ok(!legacyDetail.includes(' 天未用（'), 'no empty-threshold group title')
    // 缺 staleDays：never-used（无阈值）与 archiveable（自带 45）照常显示，
    // 只有 idle 那一组没有阈值可写 → 整组不渲染（不是渲染成 "undefined 天"）
    assert.equal(lcUsageHidden.length, 2, 'groups without a threshold are dropped, not rendered with undefined')
    ok('lifecycle panel degrades on partial status (summary + detail)')

    // 首帧（status 还没回来）与失败（status.error）必须说清楚，
    // 不能都显示「没有够格归档的技能」——那是谎报平安
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, view: 'summary' }))
    assert.equal(renderedText.join(''), '加载中…', 'loading state has its own copy')

    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, view: 'summary', __debug: { status: { error: true }, open: true } }))
    assert.equal(renderedText.join(''), '状态获取失败', 'error state is not reported as "nothing to do"')
    ok('lifecycle summary distinguishes loading / error / idle')

    // 展开态：夹具 setter 是空函数，只能靠 __debug.openUsage 注入。
    // 没有这条，hidden: true（永远收起）也能全绿 —— 复审抓到的假绿。
    renderedText.length = 0
    lcUsageHidden = []
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: fakeStatus, open: true, openUsage: { idle: true } } }))
    assert.deepEqual(lcUsageHidden, [true, false, true], 'only the idle group is expanded')
    assert.ok(renderedText.join(' | ').includes('收起'), 'expanded group offers collapse')
    ok('usage group can actually expand (hidden=false)')

    // 阈值倒置（archive < stale）：「是它的子集」是假话，必须换文案
    const inverted = JSON.parse(JSON.stringify(fakeStatus))
    inverted.lifecycle.usage.staleDays = 90
    inverted.lifecycle.usage.archiveDays = 30
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: inverted, open: true } }))
    const invertedText = renderedText.join(' | ')
    assert.ok(invertedText.includes('90 天未用（1）') && invertedText.includes('30 天够格归档（1）'), 'thresholds rendered from status')
    assert.ok(!invertedText.includes('是它的子集'), 'inverted thresholds must not claim a subset')
    assert.ok(invertedText.includes('不是'), 'inverted copy explains the relationship')
    ok('inverted thresholds get their own copy')

    // 空桶：不渲染「展开」按钮，也不渲染列表
    const emptyBucket = JSON.parse(JSON.stringify(fakeStatus))
    emptyBucket.lifecycle.usage.archiveable = []
    renderedText.length = 0
    lcUsageHidden = []
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: emptyBucket, open: true } }))
    const emptyText = renderedText.join(' | ')
    assert.equal(lcUsageHidden.length, 2, 'empty bucket renders no list')
    assert.equal((emptyText.match(/展开/g) || []).length, 2, 'empty bucket renders no expand button')
    assert.ok(emptyText.includes('45 天够格归档（0）'), 'count still shown for empty bucket')
    ok('empty bucket has no expand affordance')

    // 坏阈值类型（字符串 "14"）：整组不渲染，也不许写出 "14 天未用"
    const badType = JSON.parse(JSON.stringify(fakeStatus))
    badType.lifecycle.usage.staleDays = '14'
    renderedText.length = 0
    lcUsageHidden = []
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: badType, open: true } }))
    const badTypeText = renderedText.join(' | ')
    assert.equal(lcUsageHidden.length, 2, 'string threshold drops the idle group instead of coercing')
    assert.ok(!badTypeText.includes('14 天未用'), 'no coerced threshold in copy')
    ok('non-numeric thresholds are dropped, not coerced')

    // 详情页头部：加载中 / 失败 两条新文案（之前只有 summary 分支有用例）
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { open: true } }))
    assert.ok(renderedText.join(' | ').includes('加载中…'), 'detail header shows loading copy')
    renderedText.length = 0
    renderTree(makeElement(lifecycleComponent, { t: lcDict, __debug: { status: { error: true }, open: true } }))
    assert.ok(renderedText.join(' | ').includes('状态获取失败'), 'detail header shows error copy')
    ok('detail header distinguishes loading / error')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`\nclient smoke OK: ${PASS.length + 1} groups passed`)
process.exit(0)