/**
 * dsh-archived-session-cleaner — Host 半边入口。
 *
 * 职责：
 *   1. 提供两条 HTTP 路由给 Web 半边
 *        GET  /archived-session-cleaner/list    列出已归档会话及其占用
 *        POST /archived-session-cleaner/purge   彻底删除一个已归档会话
 *   2. 实际的文件与注册表操作交给 lib/store.js
 *
 * 为什么走插件自己的路由而不是 DSH 的 Remote：
 * 「删除会话」在 DSH 里没有对应的 Service 方法（详见 lib/store.js 的说明），
 * 所以这里必须自己落地。
 *
 * ## 关于 webServer 的获取方式（踩过的坑）
 *
 * **顶层 `export const inject = ['webServer']` 会让插件完全不激活**：
 * 顶层 inject 是硬依赖，插件必须等该服务就绪才 apply，而 webServer 由
 * dsh-host-webserver 提供，在 profile bundle 的加载顺序里可能晚于本插件行——
 * 结果宿主的启动检查报 `did not activate`，DSH 前端整个起不来。
 *
 * 正确做法（account-pool 用的也是这个）：顶层不声明依赖，在 apply 内用
 * `ctx.inject(['webServer'], cb)` 延迟获取——服务就绪时才执行 cb 注册路由。
 *
 * 安全：所有文件操作都限定在 $DSH_HOME 内，且只允许删除**已归档**的会话；
 * 路由只放行同源请求，避免被别的站点（CSRF）调用去删数据。
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { describeArchived, purgeArchivedSession } from './store.js'

/** 插件标识，用于路由前缀与日志。 */
export const name = 'archived-session-cleaner'

/**
 * 顶层 inject 留空。
 *
 * 见文件头「关于 webServer 的获取方式」——顶层声明会让插件不激活。
 */
export const inject = []

/** 路由前缀，改动要同步 lib/client.js。 */
const ROUTE_BASE = '/archived-session-cleaner'

/**
 * 请求来源校验：只放行同源请求。
 *
 * 这些接口会**删除磁盘数据**，必须是同源页面发起的。
 * 判据用「Origin 与本次请求的 Host 是否一致」——因为 DSH 可能装在其他
 * 机器上、通过局域网地址访问，只认 127.0.0.1 会把用户自己的请求也拒掉
 * （早期 account-pool 就踩过：NAS 地址访问时接口全 403）。
 *
 * 没有 Origin 头时放行（非浏览器客户端，如 curl）。
 *
 * @param {object} req Node 请求对象
 * @returns {boolean} 是否放行
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined || origin === '') return true

  // 反代会把原始 Host 放在 x-forwarded-host，优先用它
  const host = req.headers?.['x-forwarded-host'] ?? req.headers?.host
  if (host === undefined || host === '') return false

  try {
    const originHost = new URL(origin).host
    const targetHost = String(host).split(',')[0].trim()
    if (originHost === targetHost) return true
    // 回环地址一律放行：本机工具、DSH 自身的健康检查
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    // Origin 不是合法 URL（例如 file://）→ 拒绝
    return false
  }
}

/** 回一个 JSON 响应。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读请求体（有大小上限，防滥用）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // 请求体只是 { sessionId }，4KB 绰绰有余
    if (size > 4096) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 日志前缀，便于在宿主日志里检索本插件的问题。 */
function log(logger, message) {
  logger?.info?.(`[${name}] ${message}`)
}

export function apply(ctx) {
  const logger = ctx.logger
  const dshHome = resolveDshHome()
  log(logger, `就绪，DSH 主目录：${dshHome}`)

  // 路由在 webServer 就绪后才注册（顶层 inject 是硬依赖，不能用它等——
  // 见文件头「关于 webServer 的获取方式」）。
  ctx.inject(['webServer', 'workspaceRegistry'], (webCtx) => {
    /** 取消订阅时逐条摘掉路由。 */
    const routes = []

    routes.push(webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/list`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) { json(res, 403, { ok: false, error: '仅允许同源访问' }); return }
        try {
          const sessions = await describeArchived(webCtx.workspaceRegistry, dshHome)
          json(res, 200, { ok: true, sessions })
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message ?? String(error) })
        }
      },
    }))

    routes.push(webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/purge`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) { json(res, 403, { ok: false, error: '仅允许同源访问' }); return }
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          log(logger, `收到删除请求：${sessionId}`)
          const result = await purgeArchivedSession(
            { registry: webCtx.workspaceRegistry, dshHome },
            sessionId,
          )
          log(logger, `已删除 ${sessionId}（数据:${result.removedData ? "删" : "无"}`
            + ` 缓存:${result.removedCache ? "删" : "无"} 工作区摘除:${result.detachedFrom}）`)
          json(res, 200, { ok: true, ...result })
        } catch (error) {
          // 不删任何东西时也要给出明确原因（例如"只能删除已归档的会话"）
          json(res, 400, { ok: false, error: error?.message ?? String(error) })
        }
      },
    }))

    // 返回 disposer：webServer 失效或插件卸载时摘掉路由
    return () => {
      for (const dispose of routes) {
        try {
          dispose()
        } catch {
          // 路由可能已随服务一起销毁，忽略
        }
      }
    }
  })
}
