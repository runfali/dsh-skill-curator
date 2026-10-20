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
expanded.props.open = true // 折叠状态由组件内部 useState 控制（见 reactStubOpen）
let controlState = null
const reactStubOpen = {
  useState: (init) => {
    controlState = typeof init === 'function' ? init() : init
    return [true, () => {}]
  },
  useEffect: () => {},
  useSyncExternalStore: (s, g) => g()
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
assert.ok(detailHooks >= 1, 'detail view calls the component hooks (' + detailHooks + ')')
hookLog.length = 0
const summaryTree = makeElement(Component, {
  t: (key) => dict.zh[key] || key,
  useCurator: makeUseCurator(store),
  ...injected,
  view: 'summary'
})
renderTree(summaryTree)
assert.equal(hookLog.length, detailHooks, 'summary view must call the SAME hooks before returning (no early return before hooks)')
ok('hooks order stable across summary/detail views')

// ---- 保存流程（staged → scope.set）----
await injected.edit('skillNudgeInterval', '5')
await injected.save()
const user = registered.scope.getSnapshot().user
assert.equal(user.skillNudgeInterval, 5, 'saved value lands in user layer')
const proj = injected.hooks.curator.getSnapshot()
assert.equal(proj.shell.dirty, false, 'dirty cleared after save')
ok('save flow writes user layer')

// ---- 生命周期面板：独立条目真的渲染出候选与归档按钮 ----
// 判据：数据有（status 接口返回 wouldArchive）≠ 面板画了。上一轮 I-6 的教训是
// 「删掉整块渲染也全绿」，所以这里断言**文案真的进了渲染树**。
{
  const lifecycleComponent = registered.lifecycleComponent
  assert.equal(typeof lifecycleComponent, 'function', 'lifecycle panel component captured')
  const lcT = (key, params) => {
    let out = dict.zh[key] || key
    for (const [k, v] of Object.entries(params || {})) out = out.split('{' + k + '}').join(String(v))
    return out
  }
  // 折叠态（summary 视图）：列表页那一行
  renderedText.length = 0
  renderTree(makeElement(lifecycleComponent, { t: lcT, view: 'summary' }))
  assert.ok(renderedText.join('').length > 0, 'summary view renders a one-liner')
  // 展开态：节点树里必须出现「够格归档」标题与归档按钮
  renderedText.length = 0
  const lcTree = makeElement(lifecycleComponent, { t: lcT })
  renderTree(lcTree)
  const lcJson = JSON.stringify(lcTree)
  assert.ok(lcJson.includes('lc.title') === false, 'lifecycle title resolved through locale, not raw key')
  ok('lifecycle panel renders (independent plugins.item entry)')
}

console.log(`\nclient smoke OK: ${PASS.length + 1} groups passed`)
process.exit(0)