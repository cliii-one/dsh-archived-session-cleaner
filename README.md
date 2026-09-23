# dsh-archived-session-cleaner

彻底删除 [DSH](https://github.com/deepseek-ai/deepseek-harness) 里**已归档的会话**。

DSH 自带「归档」但没有「删除」——归档只是把会话从列表里收起来，磁盘上
的对话数据（`session.v3.jsonl.zstd`）一直留着。这个插件补上那一刀：
在已归档会话的「⋯」菜单里加一项「彻底删除」，二次确认后一次清干净。

## 它做什么

| 清除位置 | 内容 |
|---|---|
| `workspaceRegistry`（内存态 + 磁盘） | 归档标记、所属工作区列表里的条目 |
| `sessions/<编码cwd>/<会话id>/` | 会话数据本身 |
| `storages/session_projcache/sessions/<id>.json` | 派生投影缓存 |

删除后侧栏的归档列表**立即减少**——注册表走 DSH 的正规写路径，
内存态与磁盘同步，不需要重启或手动刷新。

## 为什么需要插件自己做

DSH 的 Service 里没有删除会话的方法：

```text
sessionPersistence  create / open / flush / stat / list        ← 无 delete
sessionController   list / search / create / rename /
                    fork / cancel / page / follow              ← 无 delete
workspaceRegistry   … / delete(workspace) / archiveSession …   ← 删的是工作区，不是会话
```

所以只能组合 DSH 现有的正规 API + 直接删文件：

```text
1. registry.unarchiveSession(id)   摘归档标记（正规写路径）
2. workspace.detachSession(id)     从工作区列表摘掉（正规写路径）
3. 插件删除磁盘数据与投影缓存      DSH 没有这层 API
```

第 2 步很关键：**归档不会把会话从工作区的 `sessionIds` 里摘掉**
（实测 21 个归档会话里有 10 个还挂着），只删数据不清这个列表，
会留下指向已删数据的悬空引用，点开就报错。

## 为什么注册表必须走 DSH 的 API

`workspaceRegistry` 把注册表**常驻内存**（`this.state`），写操作经
`global.set()` 落盘。插件绕过它直接改 `workspace.json` 文件的话：

```text
内存态（旧） ← 前端列表从这里读 → 删了还在
     ↑
     └─ 宿主下次任何写操作会用旧内存态覆盖磁盘 → 白删
```

上一版就是这么做的，结果「删除没生效」。正确顺序：

```text
unarchiveSession（摘归档标记）
  → detachSession（从工作区摘掉）
    → 删磁盘数据
```

每一步都走正规写路径，内存与磁盘始终一致。

## 安全设计

破坏性操作，几道闸都是必要的：

- **只删归档过的会话**：id 必须在 `archivedSessionIds` 里，否则拒绝。
  即使前端传错也不会误删活跃会话。
- **先走注册表 API、再删文件**：顺序反了会留下悬空引用。
- **确认对话框**：写明会话 id、将释放的空间、以及「不可撤销」。
  通过 Portal 挂在 `document.body` 顶层——挂在菜单里会被菜单容器
  约束成窄长一条，菜单关闭还会把它一起卸载。
- **同源校验**：两条路由只放行同源请求，防止别的站点（CSRF）调用删数据。

## 安装

```bash
dsh plugin --profile <你的 profile> install dsh-archived-session-cleaner
```

或用 Harness 的插件管理器装入本地目录。

## 用法

1. 在会话列表里把不要的会话**归档**（「⋯」→ 归档）
2. 再打开同一个「⋯」菜单 → **彻底删除**（红色项，仅归档会话可见）
3. 确认对话框 → 删除

⚠️ **不可撤销**。删除后对话历史和磁盘占用一并释放，没有回收站。

不想装插件的话，仓库里还有一个等价的命令行脚本
（`purge-archived-sessions.sh`，用法见文件头注释），效果相同。

## 环境要求

- DSH 0.1.6+（依赖 `webServer` / `workspaceRegistry` Service 与
  `sidebar.workspaces.session.menu.item` 插槽）
- Node.js `^22.19.0 || >=24.0.0`

## 开发自检

```bash
npm run check
```

19 项，覆盖四层：

- **静态**：语法、导出齐全、清单与补丁正确
- **存储层**：在**临时沙箱**里用内存版 registry 真跑删除，验证
  内存态与磁盘同步、未归档会话不被误删
- **客户端**：加载、注册到正确的插槽、按归档状态显示/隐藏、
  确认文案完整
- **激活安全**：客户端代码不得引用 `styles` 内置（静态插件的作用域里
  没有它，裸引用会让 `apply` 抛错、插件激活失败——上一版失败的原因，
  有专门断言）

自检**不碰真实数据**（全部在 `mkdtemp` 出来的临时目录里）。

## 已知限制

- 只能删除**已归档**的会话（这是刻意的：活跃会话一律拒绝，防误删）
- 删除不可逆，没有回收站
- 上游 DSH 更新存储布局后，磁盘路径可能需要跟进

## 免责声明

删除操作不可逆。请确认要删的是自己不再需要的归档会话。
因使用本项目造成的任何数据丢失由使用者自行承担。

## 许可

[MIT](LICENSE) © 2026 cliii-one
