#!/usr/bin/env bash
#
# 清理 DSH 已归档会话（不装插件，直接跑脚本）。
#
# 用法：
#   ./purge-archived-sessions.sh              列出所有已归档会话及其占用
#   ./purge-archived-sessions.sh <会话id>...   彻底删除指定的已归档会话
#   ./purge-archived-sessions.sh --all         删除【全部】已归档会话（会二次确认）
#
# 为什么需要这个脚本：
#   DSH 自带「归档」但没有「删除」——归档只是把会话从列表里收起来，
#   磁盘上的对话数据一直留着。DSH 的 Service 里也没有删除会话的方法
#   （sessionPersistence 只有 create/open/flush/stat/list；
#    workspaceRegistry.delete 删的是整个工作区，会连带没归档的会话）。
#
# 一次彻底删除要清三处：
#   1. storages/workspace.json
#        global.archivedSessionIds          归档标记
#        global.pinnedSessionIds            置顶标记（若有）
#        tables.workspaces[*].sessionIds    所属工作区的列表（重要！归档不会摘掉它，
#                                           不清就会留下指向已删数据的悬空引用）
#   2. sessions/<编码cwd>/<会话id>/          会话数据本身
#   3. storages/session_projcache/sessions/<会话id>.json   派生投影缓存
#
# 安全措施：
#   - 只删【已归档】的会话，活跃会话即使写错 id 也会被拒绝
#   - 改注册表用临时文件+改名（写一半崩溃会让整个会话列表读不出来）
#   - 注册表读不到就中止，不在状态不明时删数据
#   - 删数据前先把注册表改好（反过来会留下悬空引用）
#   - 删之前自动备份注册表到 $DSH_HOME/storages/workspace.json.bak-<时间戳>

set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REGISTRY="$DSH_HOME/storages/workspace.json"
SESSIONS_DIR="$DSH_HOME/sessions"
CACHE_DIR="$DSH_HOME/storages/session_projcache/sessions"

if [ ! -f "$REGISTRY" ]; then
  echo "找不到注册表：$REGISTRY" >&2
  echo "请设置 DSH_HOME 指向你的 DSH 主目录。" >&2
  exit 1
fi

# 用 python3 处理 JSON：bash 改 JSON 既不可靠也不可读。
# 传参用环境变量，避免会话 id 里的特殊字符被 shell 解释。
export REGISTRY SESSIONS_DIR CACHE_DIR

PY_LIST='
import json, os, sys
reg = json.load(open(os.environ["REGISTRY"]))
arch = reg.get("global", {}).get("archivedSessionIds") or []
root = os.environ["SESSIONS_DIR"]
cache = os.environ["CACHE_DIR"]
rows = []
for sid in arch:
    d = None
    if os.path.isdir(root):
        for bucket in os.listdir(root):
            cand = os.path.join(root, bucket, sid)
            if os.path.isdir(cand):
                d = cand
                break
    size = 0
    if d:
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if os.path.isfile(p):
                size += os.path.getsize(p)
    rows.append((sid, size, d is not None, os.path.isfile(os.path.join(cache, sid + ".json"))))
print(f"已归档会话：{len(rows)} 个")
print()
total = 0
for sid, size, _, _ in rows:
    total += size
    print(f"  {sid}  {size:>9,} B")
print()
print(f"合计占用：{total:,} B（{total/1024:.1f} KB）")
'

PY_PURGE='
import json, os, shutil, sys, time
reg_path = os.environ["REGISTRY"]
targets = [a for a in sys.argv[1:] if a]
reg = json.load(open(reg_path))
g = reg.setdefault("global", {})
arch = g.get("archivedSessionIds") or []

# 闸门：只允许删已归档的会话
not_archived = [t for t in targets if t not in arch]
if not_archived:
    print("以下会话不在归档列表里，已中止（不会删任何东西）：", file=sys.stderr)
    for t in not_archived:
        print("  " + t, file=sys.stderr)
    sys.exit(2)

# 备份注册表
backup = reg_path + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(reg_path, backup)
print(f"已备份注册表 → {backup}")

# 1) 先改注册表（顺序不能反：先删数据会留下悬空引用）
def drop(lst):
    return [x for x in lst if x not in targets] if isinstance(lst, list) else lst

g["archivedSessionIds"] = drop(g.get("archivedSessionIds"))
g["pinnedSessionIds"] = drop(g.get("pinnedSessionIds"))
for rec in (reg.get("tables", {}).get("workspaces") or {}).values():
    if isinstance(rec, dict):
        rec["sessionIds"] = drop(rec.get("sessionIds"))

tmp = reg_path + f".{os.getpid()}.tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(reg, f, ensure_ascii=False, indent=2)
os.replace(tmp, reg_path)
print("已从注册表移除（归档标记 / 置顶标记 / 工作区列表）")

# 2) 删会话数据目录
root = os.environ["SESSIONS_DIR"]
removed = 0
for sid in targets:
    if os.path.isdir(root):
        for bucket in os.listdir(root):
            cand = os.path.join(root, bucket, sid)
            if os.path.isdir(cand):
                shutil.rmtree(cand)
                removed += 1
                break
print(f"已删除 {removed} 个会话数据目录")

# 3) 删投影缓存
cache = os.environ["CACHE_DIR"]
n = 0
for sid in targets:
    p = os.path.join(cache, sid + ".json")
    if os.path.isfile(p):
        os.remove(p)
        n += 1
print(f"已删除 {n} 个投影缓存")
'

if [ $# -eq 0 ]; then
  python3 -c "$PY_LIST"
  echo
  echo "要删除某个会话，把它的 id 作为参数传进来："
  echo "  $0 <会话id>"
  echo "要全部删掉："
  echo "  $0 --all"
  exit 0
fi

if [ "$1" = "--all" ]; then
  python3 -c "$PY_LIST"
  echo
  read -r -p "确认删除以上全部已归档会话？不可撤销，输入 yes： " ans
  if [ "$ans" != "yes" ]; then
    echo "已取消。"
    exit 0
  fi
  mapfile -t IDS < <(python3 -c '
import json, os
reg = json.load(open(os.environ["REGISTRY"]))
for sid in (reg.get("global", {}).get("archivedSessionIds") or []):
    print(sid)
')
  python3 -c "$PY_PURGE" "${IDS[@]}"
  exit 0
fi

python3 -c "$PY_PURGE" "$@"
