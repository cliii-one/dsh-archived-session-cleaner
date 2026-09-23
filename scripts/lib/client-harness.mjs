/**
 * 前端测试脚手架：加载 client.js 并把组件树渲染成可检查的普通对象。
 *
 * 为什么需要它：插件的 client.js 是浏览器产物（window.__ModuleLoader__ +
 * react），Node 里跑不起来。这里提供最小的 React 替身与遍历工具，
 * 让检查脚本能真的「渲染」和「点击」，而不是只看源码字符串。
 *
 * 关键能力：
 *   - render()      渲染组件树（含函数组件的递归调用）
 *   - collectButtons() 收集所有按钮与其 onClick —— 这是抓「回调漏传」
 *     「跨作用域引用」这类 bug 的唯一办法，光看渲染输出抓不到。
 */

import { readFile } from 'node:fs/promises'

/** 进程内最初的 fetch。首次 loadClient 时记下，之后所有恢复都回到它。 */
let ORIGINAL_FETCH

/** 恢复最初的 fetch（供检查脚本在需要真实网络前调用）。 */
export function restoreOriginalFetch() {
  if (ORIGINAL_FETCH !== undefined) globalThis.fetch = ORIGINAL_FETCH
}

/**
 * 创建一个极简 React 替身。
 *
 * useState 的状态放在外部数组里（按调用序号索引），这样一次渲染的
 * 完整 hook 状态可以被检查脚本读取和预设。
 */
function createReactStub() {
  const store = []
  let index = 0

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(),
    }),
    useState: (initial) => {
      const slot = index++
      // 记录这个 slot 对应的变量名（从源码里抓的，见 setNameSource）。
      // 让 preset 能按名字而不是按数组下标传值——下标会随 hook 顺序变化
      // 而错位，改一处 hook 就要修所有测试（实测踩过）。
      if (!(slot in store)) store[slot] = initial
      return [store[slot], (next) => {
        store[slot] = typeof next === 'function' ? next(store[slot]) : next
      }]
    },
    // 检查脚本不跑副作用与 memo，直接用原函数即可
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  return {
    react,
    /** 重置 hook 序号与状态；传入 preset 可预设状态（按 slot 索引）。 */
    reset(preset = {}) {
      store.length = 0
      index = 0
      for (const [slot, value] of Object.entries(preset)) store[Number(slot)] = value
    },
    /** 供检查脚本读取被 setState 写过的值。 */
    state: store,
    /** 渲染前重置序号（每次渲染 hook 顺序都从头开始）。 */
    beginRender() { index = 0 },
  }
}

/**
 * 遍历组件树，收集文本、按钮、表格行。
 *
 * 函数组件会被调用（这是「渲染」的关键）——只走 children 是看不到
 * 子组件内部内容的。
 */
export function walk(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return
  }
  // 收集 className：布局与响应式检查需要它（内联样式写不了媒体查询）
  if (node.props?.className !== undefined) out.classes.push(node.props.className)
  // 收集样式节点：图表柱、KPI 块这类「靠内联尺寸表达」的元素
  // 必须能从这里读到，否则检查只能自己遍历树——而重复调用 component()
  // 会让函数组件的 hook 序号错乱，渲染出空树（实测踩过）。
  if (node.props?.style !== undefined) {
    out.styles.push({ type: node.type, style: node.props.style })
  }
  // 收集 title：悬停提示（tooltip）也是界面信息的一部分
  if (node.props?.title !== undefined) {
    out.titles.push({ text: out.texts[out.texts.length - 1], title: String(node.props.title) })
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props), out)
    return
  }
  if (node.type === 'button' && node.children?.[0] !== undefined) {
    out.buttons.push({ label: String(node.children[0]), onClick: node.props?.onClick })
  }
  if (node.type === 'tr') {
    const cells = []
    const collectCell = (child) => {
      if (child === null || child === undefined || typeof child === 'boolean') return
      if (Array.isArray(child)) return child.forEach(collectCell)
      if (typeof child === 'string' || typeof child === 'number') { cells.push(String(child)); return }
      if (typeof child.type === 'function') return collectCell(child.type(child.props))
      if (child.children) child.children.forEach(collectCell)
    }
    collectCell(node.children)
    out.rows.push(cells.filter(cell => cell !== ''))
  }
  if (node.children) {
    for (const child of node.children) walk(child, out)
  }
}

/** 从源码里取出组件的 props 解构名，用于交叉核对调用处是否传齐。 */
export function declaredProps(source, functionName) {
  const match = new RegExp(`function\\s+${functionName}\\s*\\(\\{([^}]*)\\}`).exec(source)
  if (match === null) return []
  return match[1].split(',').map(name => name.trim()).filter(name => name !== '')
}

/** 取出某函数名的源码块（到下一个同级 function 为止），用于静态检查。 */
export function functionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`)
  if (start === -1) return ''
  const next = source.indexOf('\n\tfunction ', start + 1)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}

/**
 * 加载插件的 client.js。
 *
 * @param {string} clientPath client.js 的绝对路径
 * @param {object} [options]
 * @param {object} [options.fetchImpl] 替换 fetch（默认全返回 {ok:true}）
 * @param {object} [options.window] 额外的 window 字段（如 confirm）
 * @returns {Promise<object>} 加载结果
 */
export async function loadClient(clientPath, options = {}) {
  const source = await readFile(clientPath, 'utf8')
  const stub = createReactStub()

  let registration = null
  const opened = []

  // 最小 document stub：有些插件在 apply 里就操作 DOM（如 Portal 容器、
  // 自注入样式标签）。没有它这类插件在自检里直接 ReferenceError。
  // 只支持 createElement/appendChild/remove/querySelector 的最小面。
  const created = []
  globalThis.document = options.document ?? {
    head: { appendChild() {} },
    body: { appendChild(el) { created.push(el) } },
    createElement(tag) {
      return {
        tagName: tag, dataset: {}, style: {}, children: [],
        appendChild() {}, remove() {},
        set textContent(v) { this._text = v },
        get textContent() { return this._text ?? '' },
        setAttribute() {}, getAttribute() { return null },
      }
    },
    querySelector() { return null },
  }

  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { registration = entry },
    },
    confirm: () => true,
    open: (url) => { opened.push(url); return null },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() {},
    ...(options.window ?? {}),
  }

  // Client 的内置注入器。真实运行时由 loader 提供；脚手架不提供的话
  // apply() 会在调用 styles.insert 时抛错，导致 slot 注册根本执行不到——
  // 那样测试会「静默通过」但什么都没验证。
  const injectedCss = []
  if (options.styles !== null) {
    globalThis.styles = options.styles ?? {
      insert(css) { injectedCss.push(css); return () => {} },
    }
  }

  // 保存并替换 fetch。**必须提供恢复手段**：不恢复会污染同一进程里
  // 后续的每一个测试——它们拿到的都是这个假 fetch，真实网络请求全废
  // （实测踩过：shim 测试因此静默失败）。
  //
  // 注意要保存「最初的」真 fetch：如果多次 loadClient 嵌套调用，
  // 每次保存的都是上一次的假 fetch，逐个恢复只会回到另一个假 fetch。
  // 所以第一次替换前就把真身记在模块级，恢复永远回到它。
  // react-dom/client stub：Portal 型插件需要 createRoot().render/unmount。
  // 无条件提供——缺它时 require('react-dom/client') 拿到 Proxy，createRoot
  // 返回 null，插件在 apply 里 `null.render` 直接 TypeError。
  {
    globalThis.ReactDOM = {
      createRoot(el) {
        return {
          render(tree) { el._tree = tree },
          unmount() { el._tree = undefined },
        }
      },
      createPortal(tree, container) { return { portal: true, tree, container } },
    }
  }
  if (ORIGINAL_FETCH === undefined) ORIGINAL_FETCH = globalThis.fetch
  const savedFetch = ORIGINAL_FETCH
  const calls = []
  globalThis.fetch = options.fetchImpl ?? (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    return { ok: true, json: async () => ({ ok: true }) }
  })

  // client.js 是 IIFE（依赖 window），用间接 eval 在全局作用域执行
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)

  if (registration === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')

  const module = registration.factory((name) => {
    if (name === 'react') return stub.react
    // Portal 型插件会 require('react-dom/client')——给 createRoot 替身
    if (name === 'react-dom/client') {
      return globalThis.ReactDOM ?? {
        createRoot(el) {
          return { render(tree) { el._tree = tree }, unmount() { el._tree = undefined } }
        },
        createPortal(tree, container) { return { portal: true, tree, container } },
      }
    }
    // 其余外部模块（ui-primitives 等）给个惰性替身，调用返回 null
    return new Proxy({}, { get: () => () => null })
  })

  let slotOptions = null
  let component = null
  /** 全部注册记录：插件现在会注册多个设置菜单，只留最后一个不够用。 */
  const slotRegistrations = []
  /** apply 期间注册的清理函数，供 dispose() 调用。 */
  const disposers = []
  if (typeof module.apply === 'function') {
    module.apply({
      // effect 是 Cordis Context 的核心方法：插件用它注册随生命周期释放的资源。
      // 脚手架必须实现，否则插件在这里抛错后面全都不执行。
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => { if (typeof dispose === 'function') dispose() }
      },
      get() { return undefined },
      on() { return () => {} },
      slots: {
        inject(_key, callback) { callback() },
        register(options_, component_) {
          slotOptions = options_
          component = component_
          // label 可能是函数（延迟求值），这里取一次快照
          slotRegistrations.push({
            id: options_.id,
            label: typeof options_.label === 'function' ? options_.label() : options_.label,
            order: options_.order,
            component: component_,
          })
          return () => {}
        },
      },
    })
  }

  return {
    module,
    slotOptions,
    component,
    /** 所有注册的设置菜单（id/label/order/component）。 */
    slotRegistrations,
    /** apply 期间注入的 CSS（供检查响应式规则）。 */
    injectedCss,
    /** 释放 apply 期间注册的资源。 */
    dispose() { for (const fn of disposers) fn() },
    /** 恢复最初的 fetch（用完务必调用，否则污染后续测试）。 */
    restoreFetch() { restoreOriginalFetch() },
    react: stub.react,
    state: stub.state,
    reset: stub.reset,
    opened,
    calls,
    /**
     * 渲染组件树，返回 {texts, buttons, rows, classes, styles}。
     *
     * 插件注册多个设置菜单时，默认渲染**第一个**（WorkBuddy）。
     * 要渲染别的菜单，传 { slotId } ——例如 Trae 的任务视图与
     * WorkBuddy 不同，必须能分别渲染才能各自断言。
     *
     * @param {object} [preset] hook 状态预设（按 slot 索引）
     * @param {string} [slotId] 指定渲染哪个已注册菜单
     */
    render(preset, slotId) {
      if (preset !== undefined) stub.reset(preset)
      else stub.beginRender()
      const target = slotId === undefined
        ? (slotRegistrations[0]?.component ?? component)
        : (slotRegistrations.find(r => r.id === slotId)?.component ?? component)
      const out = { texts: [], buttons: [], rows: [], classes: [], styles: [], titles: [] }
      walk(target(), out)
      return out
    },
  }
}
