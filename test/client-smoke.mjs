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
const reactStub = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
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
function renderTree(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { for (const c of node) renderTree(c); return }
  if (typeof node === 'string' || typeof node === 'number') return
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
  locale: { register(ns, dict) { registered.locales.push({ ns, dict }) } },
  settingsScope: {
    bind({ namespace }) {
      registered.scopeNamespaces.push(namespace)
      const state = { status: 'ready', writable: true, value: { enabled: true, skillNudgeInterval: 3, notifyMode: 'on' }, user: {} }
      const listeners = new Set()
      const scope = {
        getSnapshot: () => state,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        set(key, value) { state.user = { ...state.user, [key]: value }; state.value = { ...state.value, [key]: value }; listeners.forEach((fn) => fn()); return Promise.resolve() },
        unset(key) { const u = { ...state.user }; delete u[key]; state.user = u; listeners.forEach((fn) => fn()); return Promise.resolve() }
      }
      registered.scope = scope
      return scope
    }
  },
  slots: {
    inject(slotName, gen) {
      assert.equal(slotName, 'settings.plugin.item', 'slot name')
      const iterator = gen()
      for (const reg of iterator) slotRegistrations.push({ slotName, reg })
    },
    register(def, component) { return { def, component } }
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
assert.equal(captured.inject.join(','), 'slots,locale,settingsScope', 'inject services')
captured.apply(ctxStub)
ok('bundle id + apply executed')

// ---- 断言 ----
assert.equal(registered.scopeNamespaces[0], 'skill-curator', 'settingsScope namespace')
assert.equal(slotRegistrations.length, 1, 'one slot registration')
const slot = slotRegistrations[0].reg.def
assert.equal(slot.name, 'settings.plugin.item', 'slot name')
assert.equal(slot.key, 'skill-curator', 'slot key')
assert.equal(slot.locale, 'skill-curator', 'slot locale')
const Component = slotRegistrations[0].reg.component
assert.equal(typeof Component, 'function', 'component captured')
const injected = slot.inject()
assert.ok(injected.hooks && injected.hooks.curator && typeof injected.hooks.curator.getSnapshot === 'function', 'hooks.curator store')
for (const fn of ['edit', 'toggle', 'resetField', 'discard', 'save']) {
  assert.equal(typeof injected[fn], 'function', `action ${fn}`)
}
ok('settingsScope + slot + actions')

assert.equal(registered.locales.length, 1, 'one locale registration')
const dict = registered.locales[0].dict
const zhKeys = Object.keys(dict.zh)
const enKeys = Object.keys(dict.en)
assert.deepEqual(enKeys.sort(), zhKeys.sort(), 'zh/en key parity')
const fieldKeys = ['enabled', 'skillNudgeInterval', 'digestTail', 'digestMaxChars', 'reviewTimeoutMs', 'reviewProvider', 'reviewModel', 'adoptSkills', 'notifyMode']
for (const k of fieldKeys) {
  assert.ok(zhKeys.includes('field.' + k), `field.${k} label`)
  assert.ok(zhKeys.includes('hint.' + k), `hint.${k} hint`)
}
ok('locale parity + all field labels/hints')

// ---- 渲染树真实执行（默认折叠态也要执行子组件路径）----
const store = injected.hooks.curator
const tree = makeElement(Component, {
  t: (key) => dict.zh[key] || key,
  hooks: { curator: store },
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
  locale: { register() {} },
  settingsScope: { bind({ namespace }) { return registered.scope } },
  slots: {
    inject(name, gen) {
      const reg = gen().next().value
      registered.inject2 = reg.def.inject
      registered.Component2 = reg.component
    },
    register(def, component) { return { def, component } }
  }
}
captured2.apply(ctxStub2)
const injected2Actions = registered.inject2()
const tree2 = makeElement(registered.Component2, { t: (key) => dict.zh[key] || key, hooks: { curator: injected2Actions.hooks.curator }, ...injected2Actions })
renderTree(tree2)
assert.ok(renderedTags.includes('input'), 'expanded: inputs rendered')
assert.ok(renderedTags.includes('select'), 'expanded: select rendered (enum field)')
assert.ok(renderedTags.includes('button'), 'expanded: buttons rendered')
assert.ok(renderedTags.includes('ul') || renderedTags.includes('p'), 'expanded: status panel rendered')
const json = JSON.stringify(tree2)
assert.ok(!json.includes('undefined'), 'no undefined leakage in render')
ok('expanded render (FieldRow all branches, status panel)')

// ---- 保存流程（staged → scope.set）----
await injected.edit('skillNudgeInterval', '5')
await injected.save()
const user = registered.scope.getSnapshot().user
assert.equal(user.skillNudgeInterval, 5, 'saved value lands in user layer')
const proj = injected.hooks.curator.getSnapshot()
assert.equal(proj.shell.dirty, false, 'dirty cleared after save')
ok('save flow writes user layer')

console.log(`\nclient smoke OK: ${PASS.length + 1} groups passed`)
process.exit(0)