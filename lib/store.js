/**
 * DSH 归档会话删除的存储操作。
 *
 * ## 分工：注册表走 DSH 的 API，磁盘文件由插件删
 *
 * 上一版直接改 `storages/workspace.json`，踩了一个架构级坑：
 * `workspaceRegistry` 服务把注册表**常驻内存**（`this.state`），写操作
 * 走 `global.set()` 落盘。插件绕过它直接改文件的话：
 *
 * ```text
 * 内存态（旧）  ← 前端列表从这里读 → 删了还在
 *      ↑
 *      └─ 下次宿主任何写操作会用旧内存态覆盖磁盘 → 白删
 * ```
 *
 * 现在的分工：
 *
 * ```text
 * 注册表（归档标记 / 工作区列表）→ ctx.workspaceRegistry 的正规 API
 *   - unarchiveSession(id)      摘归档标记（内存+盘同步）
 *   - entity.detachSession(id)  从工作区列表摘掉（内存+盘同步）
 * 磁盘文件（会话数据 / 投影缓存）→ 本模块用 fs 删（DSH 没有这层 API）
 * ```
 *
 * ## 为什么归档标记要用 unarchiveSession「绕一下」
 *
 * 它会把会话放回工作区列表——但这正是下一步 detachSession 的输入，
 * 顺序是：unarchive（摘归档标记）→ detach（从工作区摘掉）→ 删文件。
 * 每一步都走正规写路径，内存与磁盘始终一致。
 */

import { rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 会话数据的根目录（相对 DSH 主目录）。 */
const SESSIONS_DIR = 'sessions'
/** 投影缓存目录。 */
const PROJECTION_CACHE = 'storages/session_projcache/sessions'

/**
 * 在磁盘上定位一个会话目录。
 *
 * 会话按「工作目录」分桶：`sessions/<编码后的 cwd>/<session-id>/`。
 * 编码规则不在插件侧复现（DSH 内部细节，会变），改为**遍历一层目录**
 * 找同名子目录——精确匹配目录名，不做模糊匹配。
 *
 * @param {string} dshHome DSH 主目录
 * @param {string} sessionId 会话 id
 * @returns {Promise<string|undefined>} 会话目录的绝对路径
 */
export async function findSessionDir(dshHome, sessionId) {
  const root = join(dshHome, SESSIONS_DIR)
  let buckets
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const candidate = join(root, bucket.name, sessionId)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      // 这个桶里没有，继续找下一个
    }
  }
  return undefined
}

/**
 * 单个归档会话的可删除信息（供界面展示）。
 *
 * @typedef {object} ArchivedSessionInfo
 * @property {string} sessionId
 * @property {boolean} hasData 磁盘上是否有实质数据（按字节数判断，
 *   只有 0 字节 session.lock 的目录不算）
 * @property {number} bytes 会话数据的字节数
 */

/**
 * 列出归档会话及其数据量。
 *
 * 归档列表从 `ctx.workspaceRegistry.archivedSessionIds` 读（内存态，
 * 与前端看到的一致），数据量从磁盘统计。
 *
 * @param {object} registry ctx.workspaceRegistry
 * @param {string} dshHome DSH 主目录
 * @returns {Promise<ArchivedSessionInfo[]>}
 */
export async function describeArchived(registry, dshHome) {
  const ids = [...registry.archivedSessionIds]
  const out = []
  for (const sessionId of ids) {
    const dir = await findSessionDir(dshHome, sessionId)
    let bytes = 0
    if (dir !== undefined) {
      try {
        for (const entry of await readdir(dir)) {
          const info = await stat(join(dir, entry))
          if (info.isFile()) bytes += info.size
        }
      } catch {
        // 读不到就算 0：展示信息不值得因此失败
      }
    }
    // hasData 按字节数判断：只有 session.lock（0 字节）的目录不占空间。
    out.push({ sessionId, hasData: bytes > 0, bytes })
  }
  return out
}

/**
 * 删除会话的磁盘数据与投影缓存。
 *
 * 注册表的清理（归档标记 / 工作区列表）由调用方走 DSH 正规 API 完成，
 * 这里只负责 DSH 没有对应 API 的磁盘部分。
 *
 * @param {string} dshHome DSH 主目录
 * @param {string} sessionId 会话 id
 * @returns {Promise<{removedData:boolean, removedCache:boolean}>}
 */
export async function purgeFiles(dshHome, sessionId) {
  const dir = await findSessionDir(dshHome, sessionId)
  let removedData = false
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    removedData = true
  }

  const cachePath = join(dshHome, PROJECTION_CACHE, `${sessionId}.json`)
  let removedCache = false
  try {
    await rm(cachePath, { force: true })
    removedCache = true
  } catch {
    // 缓存本来就没有，或删不掉——不影响主流程
  }
  return { removedData, removedCache }
}

/**
 * 彻底删除一个**已归档**会话：注册表走正规 API，磁盘走文件删除。
 *
 * @param {object} deps 依赖集合
 * @param {object} deps.registry ctx.workspaceRegistry（内存态注册表）
 * @param {string} deps.dshHome DSH 主目录
 * @param {string} sessionId 会话 id
 * @returns {Promise<{removedData:boolean, removedCache:boolean, detachedFrom:number}>}
 * @throws {Error} 当该会话不在归档列表里（防止误删活跃会话）
 */
export async function purgeArchivedSession({ registry, dshHome }, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('会话 id 无效')
  }

  // 前置校验：只有归档过的会话允许删。这是防误删的最后一道闸。
  const archived = [...registry.archivedSessionIds]
  if (!archived.includes(sessionId)) {
    throw new Error('只能删除已归档的会话')
  }

  // 1) 摘归档标记（走正规写路径：内存与磁盘同步）。
  //    归档会话可能还留在工作区的 sessionIds 里，unarchive 后它会
  //    回到「未归档」状态——下一步 detach 把它从工作区摘掉。
  await registry.unarchiveSession(sessionId)

  // 2) 从所有含它的工作区摘掉（防悬空引用）
  let detachedFrom = 0
  for (const workspace of registry.list()) {
    if ((workspace.sessionIds ?? []).includes(sessionId)) {
      await workspace.detachSession(sessionId)
      detachedFrom++
    }
  }

  // 3) 删磁盘数据与投影缓存
  const { removedData, removedCache } = await purgeFiles(dshHome, sessionId)

  return { removedData, removedCache, detachedFrom }
}
