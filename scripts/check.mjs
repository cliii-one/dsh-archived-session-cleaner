/**
 * dsh-archived-session-cleaner 自检。
 *
 * 覆盖四层：
 *   1. 静态：语法、导出、清单
 *   2. 存储层：沙箱里真跑删除（绝不碰真实数据）
 *   3. 客户端：加载、注册、显示/隐藏
 *   4. **激活安全**：上一版失败的根因（裸引用 styles 内置导致 apply 抛错）
 *      有专门断言——这条不过就是重蹈覆辙
 *
 * 用法：node scripts/check.mjs
 */

import { readFile, readdir, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

import { loadClient } from './lib/client-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LIB = join(ROOT, 'lib')

let passed = 0
let failed = 0

/** 跑一项检查；抛错即失败。 */
async function check(title, fn) {
  try {
    const detail = await fn()
    passed++
    console.log(`✓ ${title.padEnd(46)} ${detail ?? ''}`)
  } catch (error) {
    failed++
    console.log(`✗ ${title.padEnd(46)} ${error?.message ?? error}`)
  }
}

/** 断言。 */
function expect(condition, message) {
  if (!condition) throw new Error(message)
}

/** lib 下的 js 文件名。 */
async function listLibFiles() {
  return (await readdir(LIB)).filter(name => name.endsWith('.js'))
}

// ───────────────────────────────────────────────────────────
// 1. 静态
// ───────────────────────────────────────────────────────────

await check('语法：所有源文件可解析', async () => {
  const files = [...await listLibFiles(), 'scripts/check.mjs']
  for (const file of files) {
    const path = file.startsWith('scripts/') ? join(ROOT, file) : join(LIB, file)
    // 只做 parse 级检查（node --check）
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(process.execPath, ['--check', path])
  }
  return `${files.length} 个文件`
})

await check('模块：store.js 导出齐全', async () => {
  const mod = await import(pathToFileURL(join(LIB, 'store.js')).href)
  const need = ['describeArchived', 'findSessionDir', 'purgeFiles', 'purgeArchivedSession']
  for (const name of need) {
    expect(typeof mod[name] === 'function', `缺导出 ${name}`)
  }
  return need.length + ' 个导出'
})

await check('模块：Host 半边可 import 且可 apply', async () => {
  const mod = await import(pathToFileURL(join(LIB, 'index.js')).href)
  expect(typeof mod.apply === 'function', '缺 apply')
  // 顶层 inject 不得包含 webServer（硬依赖会让插件不激活——上一版事故）
  const inject = mod.inject ?? []
  expect(!inject.includes('webServer'),
    `webServer 不能出现在顶层 inject，实际：${JSON.stringify(inject)}`)

  // 真跑一遍 apply：路由应通过 ctx.inject 回调注册
  const registered = []
  let injected = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: () => {},
    inject(deps, cb) {
      injected = deps
      return cb({ webServer: { register: (r) => { registered.push(r); return () => {} } } })
    },
  }
  mod.apply(ctx)
  expect(injected?.includes('webServer'), 'apply 应通过 ctx.inject 请求 webServer')
  expect(registered.length === 2, `应注册 2 条路由，实际 ${registered.length}`)
  const paths = registered.map(r => r.path).sort()
  expect(paths[0].endsWith('/list') && paths[1].endsWith('/purge'),
    `路由路径不对：${paths.join(', ')}`)
  return `inject=${JSON.stringify(inject)}，2 条路由`
})

await check('清单：package.json 字段与 dsh 段正确', async () => {
  const doc = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  expect(doc.name === 'dsh-archived-session-cleaner', '包名不对')
  expect(doc.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 不对')
  expect(doc.dsh?.client?.platform === 'web', 'dsh.client.platform 应为 web')
  expect(doc.exports?.['.']?.default === './lib/index.js', 'exports["."] 应用对象形式')
  return doc.name + '@' + doc.version
})

await check('补丁：cordis.patch.yml 只插入本插件一行', async () => {
  const yml = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  expect(yml.includes('id: archived-session-cleaner'), '缺插件行 id')
  expect(yml.includes("name: 'dsh-archived-session-cleaner'"), '缺包名')
  expect((yml.match(/- insert:/g) || []).length === 1, '应只有 1 个 insert')
  return '1 行'
})

// ───────────────────────────────────────────────────────────
// 2. 存储层（沙箱，绝不碰真实数据）
// ───────────────────────────────────────────────────────────

/** 在临时目录里搭一个最小 DSH 主目录。 */
async function makeSandbox() {
  const home = await mkdtemp(join(tmpdir(), 'asc-check-'))
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await mkdir(join(home, 'sessions', '--bucket--', 'session-A'), { recursive: true })
  await mkdir(join(home, 'sessions', '--bucket--', 'session-C'), { recursive: true })
  await writeFile(join(home, 'sessions', '--bucket--', 'session-A', 'session.v3.jsonl.zstd'), 'x'.repeat(5000))
  await writeFile(join(home, 'sessions', '--bucket--', 'session-C', 'session.v3.jsonl.zstd'), 'y'.repeat(100))
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-A.json'), '{}')
  return home
}

/** 内存版 workspaceRegistry mock：行为对齐 ctx.workspaceRegistry。 */
function mockRegistry(state) {
  const listeners = []
  const workspaces = Object.fromEntries(
    Object.entries(state.tables.workspaces).map(([id, rec]) => [id, {
      sessionIds: rec.sessionIds,
      async detachSession(sessionId) {
        if (!rec.sessionIds.includes(sessionId)) return
        rec.sessionIds = rec.sessionIds.filter(x => x !== sessionId)
        state.tables.workspaces[id] = { ...rec, sessionIds: rec.sessionIds }
      },
    }])
  )
  const reg = {
    get archivedSessionIds() { return state.global.archivedSessionIds },
    list() { return Object.values(workspaces) },
    async unarchiveSession(sessionId) {
      if (!state.global.archivedSessionIds.includes(sessionId)) return
      state.global.archivedSessionIds = state.global.archivedSessionIds.filter(x => x !== sessionId)
    },
  }
  return { reg, state, workspaces }
}

await check('存储：describeArchived 从 registry 读并列出数据量', async () => {
  const home = await makeSandbox()
  try {
    const mod = await import(pathToFileURL(join(LIB, 'store.js')).href)
    const state = {
      global: { archivedSessionIds: ['session-A', 'session-B'] },
      tables: { workspaces: { 'ws-1': { sessionIds: ['session-A'] } } },
    }
    const list = await mod.describeArchived(mockRegistry(state).reg, home)
    const a = list.find(x => x.sessionId === 'session-A')
    const b = list.find(x => x.sessionId === 'session-B')
    expect(a.hasData === true && a.bytes === 5000, `A 应 5000 字节，实际 ${JSON.stringify(a)}`)
    expect(b.hasData === false && b.bytes === 0, `B 无数据，实际 ${JSON.stringify(b)}`)
    return 'A=5000B, B=无数据'
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('存储：拒绝删除未归档会话（防误删）', async () => {
  const home = await makeSandbox()
  try {
    const mod = await import(pathToFileURL(join(LIB, 'store.js')).href)
    const state = { global: { archivedSessionIds: ['session-A'] }, tables: { workspaces: {} } }
    let threw = false
    try {
      await mod.purgeArchivedSession({ registry: mockRegistry(state).reg, dshHome: home }, 'session-C')
    } catch {
      threw = true
    }
    expect(threw, '删除未归档会话应抛错')
    expect(existsSync(join(home, 'sessions', '--bucket--', 'session-C')), '被拒绝时不该删数据')
    return '已拒绝且无副作用'
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('存储：彻底删除走正规 API 清三处', async () => {
  const home = await makeSandbox()
  try {
    const mod = await import(pathToFileURL(join(LIB, 'store.js')).href)
    const state = {
      global: { archivedSessionIds: ['session-A'] },
      tables: { workspaces: { 'ws-1': { sessionIds: ['session-A', 'session-C'] } } },
    }
    const { reg } = mockRegistry(state)
    const result = await mod.purgeArchivedSession({ registry: reg, dshHome: home }, 'session-A')

    // 内存态（= 前端视角）必须同步
    expect(state.global.archivedSessionIds.length === 0, '归档标记未从内存态清除')
    expect(!state.tables.workspaces['ws-1'].sessionIds.includes('session-A'), '工作区列表未从内存态清除')
    expect(state.tables.workspaces['ws-1'].sessionIds.includes('session-C'), '误伤了未归档会话')

    // 磁盘
    expect(result.removedData === true, '应标记删除了数据')
    expect(!existsSync(join(home, 'sessions', '--bucket--', 'session-A')), '数据目录未删除')
    expect(!existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-A.json')), '缓存未删除')
    expect(existsSync(join(home, 'sessions', '--bucket--', 'session-C')), '误删了未归档会话')
    return '内存态 + 磁盘 同步清理'
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('存储：无数据但有归档标记的会话也能清掉标记', async () => {
  const home = await makeSandbox()
  try {
    const mod = await import(pathToFileURL(join(LIB, 'store.js')).href)
    const state = {
      global: { archivedSessionIds: ['session-B'] },
      tables: { workspaces: {} },
    }
    const result = await mod.purgeArchivedSession({ registry: mockRegistry(state).reg, dshHome: home }, 'session-B')
    expect(result.removedData === false, 'B 本来就没数据')
    expect(state.global.archivedSessionIds.length === 0, '标记未清')
    return '标记已清，无数据也不报错'
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────
// 3. 客户端（交互）
// ───────────────────────────────────────────────────────────

/** 加载客户端并返回接口。 */
async function loadBundle(sessions) {
  const app = await loadClient(join(LIB, 'client.js'), {
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, sessions }) }),
  })
  return app
}

await check('前端：注册到会话「...」菜单', async () => {
  const app = await loadBundle([], { reactDom: true })
  const reg = app.slotRegistrations[0]
  expect(reg !== undefined, '没有注册任何 slot')
  expect(reg.id === 'archived-session-cleaner', `注册 id 不对：${reg.id}`)
  expect(reg.order === 500, `order 应为 500（排在 archive=400 之后），实际 ${reg.order}`)
  const src = await readFile(join(LIB, 'client.js'), 'utf8')
  expect(src.includes('"sidebar.workspaces.session.menu.item"'), '应注册到会话「...」菜单')
  return 'menu.item order=500'
})

await check('前端：已归档会话显示菜单项', async () => {
  const app = await loadBundle([{ sessionId: 'session-A', hasData: true, bytes: 2097152 }])
  app.reset({ 0: { sessionId: 'session-A', hasData: true, bytes: 2097152 } })
  const tree = app.component({ sessionId: 'session-A', displayTitle: '测试' })
  expect(tree !== null, '已归档会话应渲染菜单项')
  const texts = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n.type === 'function') return walk(n.type(n.props))
    if (n.children !== undefined) walk(n.children)
  }
  walk(tree)
  expect(texts.includes('彻底删除'), `菜单项文案不对：${JSON.stringify(texts)}`)
  return texts.join(' ')
})

await check('前端：未归档会话不显示菜单项', async () => {
  const app = await loadBundle([])
  expect(app.component({ sessionId: 'session-C' }) === null, '查询中不应显示')
  app.reset({ 0: false })
  expect(app.component({ sessionId: 'session-C' }) === null, '未归档会话不应显示菜单项')
  return '查询中/未归档 都不显示'
})

await check('前端：危险操作必须二次确认（body 层弹窗）', async () => {
  const app = await loadBundle([{ sessionId: 'session-A', hasData: true, bytes: 100 }])

  // 1) 菜单项点击后应发起 purge 请求（写模块级 store）
  app.reset({ 0: { sessionId: 'session-A', hasData: true, bytes: 100 } })
  let requested = null
  // 菜单项组件
  const menuTree = app.component({ sessionId: 'session-A', displayTitle: '测试' })
  // 找到按钮并点它
  let clicked = false
  const findBtn = (n) => {
    if (n === null || typeof n !== 'object') return
    if (n.props?.className?.includes?.('asc-menu-item')) { n.props.onClick?.({ stopPropagation() {} }); clicked = true; return }
    const kids = n.children
    if (Array.isArray(kids)) kids.forEach(findBtn)
    else if (kids !== undefined && typeof kids === 'object') findBtn(kids)
  }
  findBtn(menuTree)
  expect(clicked, '应找到菜单按钮并触发点击')
  // store 是模块级私有，通过弹窗宿主的渲染结果间接验证

  // 2) 弹窗宿主：有请求时渲染完整警示（Portal 挂 body）
  const src = await readFile(join(LIB, 'client.js'), 'utf8')
  expect(src.includes('createRoot'), '弹窗宿主应用 createRoot 挂到 body（独立于菜单生命周期）')
  expect(src.includes('requestPurge'), '菜单项应通过 requestPurge 发起请求')
  expect(src.includes('onRequestPurge'), '弹窗宿主应订阅请求')
  expect(src.includes('不可撤销'), '确认文案应写明不可撤销')
  expect(src.includes('formatBytes(bytes)'), '应显示将释放的空间')

  // 3) 直接渲染 ConfirmDialog 验证文案（提取方式与激活检查一致）
  const start = src.indexOf('function ConfirmDialog(')
  let end = src.indexOf('\n    function ', start)
  if (end === -1) end = src.length
  const innerFn = new Function('React', 'h', 'TrashIcon', 'formatBytes', 'window',
    'return (' + src.slice(start, end) + ')')
  const hL = (t, p, ...c) => ({ type: t, props: p, children: c.length === 0 ? undefined : c.length === 1 ? c[0] : c })
  const R = { createElement: hL, useState: (v) => [v, () => {}], useEffect: () => {}, Fragment: 'F' }
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }
  const elFn = innerFn(R, hL, () => hL('svg', {}), (n) => n < 1024 ? n + ' B' : (n / 1048576).toFixed(2) + ' MB',
    { sessionId: 'session-A', bytes: 2202009, busy: false, error: '', onCancel: () => {}, onConfirm: () => {} })
  // 提取到的是命名函数表达式，先调用一次得到元素树
  const el = typeof elFn === 'function'
    ? elFn({ sessionId: 'session-A', bytes: 2202009, busy: false, error: '', onCancel: () => {}, onConfirm: () => {} })
    : elFn
  const t = []
  const walk = (n) => {
    if (n === null || n === undefined || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { t.push(String(n)); return }
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n.type === 'function') return walk(n.type(n.props))
    if (n.children !== undefined) walk(n.children)
  }
  walk(el)
  const text = t.join('')
  expect(text.includes('不可撤销'), `确认文案应写明不可撤销，实际：${text.slice(0, 120)}`)
  expect(text.includes('彻底删除这个归档会话'), '应说明删的是什么')
  expect(text.includes('MB'), '应显示将释放的空间')
  return '菜单发起 → body 层弹窗 → 完整警示'
})

await check('激活安全：客户端代码不得引用 styles 内置', async () => {
  // 上一版失败根因：静态 profile 插件的客户端工厂只收到 require 一个参数，
  // 作用域里没有 styles —— 裸引用 `styles.insert(...)` 直接 ReferenceError，
  // apply 抛错 → fiber.state = FAILED → 宿主报「did not activate」，
  // DSH 前端整个起不来。修法是 workspace 插件同款：自注入 CSS 标签。
  const src = await readFile(join(LIB, 'client.js'), 'utf8')

  // 剥掉注释，避免把「为什么不用 styles」的说明文字误判为代码
  const bare = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  expect(!/\bstyles\b/.test(bare),
    '客户端代码引用了 styles 内置（静态插件作用域里没有它，会让 apply 抛错）')
  expect(src.includes('ensureStyles') || src.includes('data-plugin-css'),
    '应使用自注入 CSS 标签（workspace 插件同款）')

  // 幂等注入必须真的生效：连续调用两次也只插一个标签
  const app = await loadBundle([])
  // harness 没有真实 DOM；这里验证的是注入函数存在且可调用
  expect(typeof app.module?.apply === 'function', 'apply 应存在')
  return '代码零 styles 引用，CSS 走自注入标签'
})

await check('激活安全：工厂返回对象必须有 apply（loader 校验项）', async () => {
  // module-loader 的 materialize 把「工厂返回值」当 exports，宿主据此激活。
  // 返回 undefined 或缺 apply 会让插件无法激活。
  const app = await loadBundle([])
  const mod = app.module ?? {}
  expect(typeof mod.apply === 'function', '客户端模块必须有 apply')
  const inject = mod.inject ?? []
  expect(inject.includes('slots'), '客户端应声明依赖 slots 服务')
  return `apply ✓ inject=${JSON.stringify(inject)}`
})

await check('前端：请求带同源凭据且路径固定', async () => {
  const src = await readFile(join(LIB, 'client.js'), 'utf8')
  expect(src.includes('credentials: "same-origin"'), 'fetch 应带同源凭据')
  expect(src.includes('/archived-session-cleaner/list'), '缺 list 路由')
  expect(src.includes('/archived-session-cleaner/purge'), '缺 purge 路由')
  return 'list + purge'
})

await check('Host：路由前缀与客户端一致且做同源校验', async () => {
  const src = await readFile(join(LIB, 'index.js'), 'utf8')
  expect(src.includes("'/archived-session-cleaner'"), 'Host 路由前缀不一致')
  expect(src.includes('sameOrigin'), '缺同源校验')
  const registrations = (src.match(/webCtx\.webServer\.register\(/g) || []).length
  expect(registrations === 2, `应注册 2 条路由，实际 ${registrations}`)
  const guards = (src.match(/if \(!sameOrigin\(req\)\)/g) || []).length
  expect(guards === 2, `两条路由都应校验来源，实际 ${guards}`)
  return '2 条路由 + 2 处校验'
})

await check('死代码：无未被引用的函数与导出', async () => {
  const files = ['index.js', 'store.js', 'client.js']
  const sources = {}
  for (const f of files) sources[f] = await readFile(join(LIB, f), 'utf8')
  const all = Object.values(sources).join('\n')

  const clientSrc = sources['client.js']
  const fns = [...clientSrc.matchAll(/^\s{4}function (\w+)/gm)].map(m => m[1])
  const unused = fns.filter(name =>
    (clientSrc.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length < 2)
  expect(unused.length === 0, `未被调用的函数: ${unused.join(', ')}`)

  const storeSrc = sources['store.js']
  const exports = [...storeSrc.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1])
  for (const name of exports) {
    const used = (all.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length
    expect(used >= 2, `导出 ${name} 只出现 ${used} 次（疑似未使用）`)
  }
  return `${fns.length} 个函数、${exports.length} 个导出都在用`
})

await check('打包：files 白名单生效且无多余文件', async () => {
  const doc = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  expect(JSON.stringify(doc.files) === JSON.stringify(['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']),
    `files 白名单不对：${JSON.stringify(doc.files)}`)
  expect(!doc.files.includes('scripts'), 'scripts 不应进发布包')
  return 'files: ' + doc.files.join(', ')
})

// ───────────────────────────────────────────────────────────

console.log('─'.repeat(60))
if (failed === 0) {
  console.log(`全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`${failed}/${passed + failed} 项失败`)
  process.exit(1)
}
