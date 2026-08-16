#!/bin/bash
# release-pack.sh —— v0.7.0 验证过的标准化发布打包（整仓库干净源码包）
#
# 背景（v0.7.0 发布事故复盘）：
#   - 误用 npm pack → 677KB 精简包（files 字段限制）——发布惯例是全仓库源码包
#   - v0.6.0 手动 tar 含 .pi-subagents（会话转录 120MB）/.pi-platform-data（生产数据）——
#     脏包绕过 npm pack 门禁
#   - 本脚本 = 唯一打包入口：排除清单 + 噪音自检（产出物内噪音计数必须为 0）
#
# v1.1.1 补丁（确定性打包——发布说明内固化 sha256 的前提）：
#   - 入口排序（os.walk + sort）；mtime 统一为当前 git commit 时间（无 git 回退 epoch 0）
#   - tar owner 固定 root/root uid/gid 0；gzip 头 mtime=0
#   - 同一 commit 重复打包 sha256 可复现（同 commit 跨机器也可复现）
#   - 打包期间产物写入仓库外临时目录，readdir 顺序不受自身写入影响
#
# 用法：
#   scripts/release-pack.sh            # 打包 pi-triple-v<version>.tgz + sha256
#   scripts/release-pack.sh --check   # 只检查（产出到 /tmp 后自检删除）——门禁集成用
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
OUT="pi-triple-v${VERSION}.tgz"

# 噪音关键词（产出物路径命中即失败——发布物不得含任何用户痕迹/生产数据）
NOISE="\.pi-subagents|\.pi-platform-data|node_modules|\.worktrees|\.superpowers|transcript\.jsonl|/sessions/|/workspaces/"

# ── 确定性 tar.gz 打包（python tarfile + 排序入口 + 固定 mtime）─────────────
# 排除清单与历史 EXCLUDES 对齐（v0.7.0 验证）：.git / node_modules / *.tgz /
# .pi-subagents / .worktrees / .superpowers / .DS_Store / deploy/generated /
# .pi-platform-data / pi-triple-*
pack() {
  local OUT_FILE="$1"
  python3 - "$OUT_FILE" <<'PY'
import fnmatch
import gzip
import io
import os
import stat
import subprocess
import sys
import tarfile

out_file = sys.argv[1]
root = os.getcwd()

# 固定时间源：当前 git commit 时间（同 commit 打包 mtime 恒定）
try:
    epoch = int(subprocess.check_output(["git", "log", "-1", "--format=%ct"], stderr=subprocess.DEVNULL).decode().strip())
except Exception:
    epoch = 0

PRUNE_BASENAMES = {".git", "node_modules", ".pi-subagents", ".worktrees", ".superpowers", ".pi-platform-data"}
NAME_GLOBS = ["*.tgz", "pi-triple-*", ".DS_Store"]

def excluded(rel):
    parts = rel.split("/")
    if any(p in PRUNE_BASENAMES for p in parts):
        return True
    if rel == "deploy/generated" or rel.startswith("deploy/generated/"):
        return True
    base = os.path.basename(rel)
    return any(fnmatch.fnmatch(base, g) for g in NAME_GLOBS)

entries = []
# 第一遍：目录 + 普通文件（os.walk 不跟 symlink 目录）
for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
    rel = os.path.relpath(dirpath, root)
    if rel != "." and excluded(rel):
        dirnames[:] = []
        continue
    dirnames.sort()
    filenames.sort()
    if rel != "." and not excluded(rel):
        entries.append(("dir", os.path.join(dirpath, rel), rel))
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        r = os.path.relpath(p, root)
        if not excluded(r):
            entries.append(("file", p, r))
# 第二遍：symlink（含 symlink 目录——旧 tar czf 保留 link 而非解引用）
for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
    rel = os.path.relpath(dirpath, root)
    if rel != "." and excluded(rel):
        dirnames[:] = []
        continue
    for fn in filenames + dirnames:
        p = os.path.join(dirpath, fn)
        if os.path.islink(p):
            r = os.path.relpath(p, root)
            if not excluded(r):
                entries.append(("symlink", p, r, os.readlink(p)))
entries.sort(key=lambda e: e[2])

def add_entry(tf, ti, kind, path=None, link=None):
    ti.mtime = epoch
    ti.uid = 0
    ti.gid = 0
    ti.uname = "root"
    ti.gname = "root"
    if kind == "dir":
        ti.type = tarfile.DIRTYPE
        ti.mode = 0o755
        tf.addfile(ti)
    elif kind == "file":
        ti.type = tarfile.REGTYPE
        st = os.lstat(path)
        ti.mode = stat.S_IMODE(st.st_mode)
        ti.size = st.st_size
        with open(path, "rb") as f:
            tf.addfile(ti, f)
    else:
        ti.type = tarfile.SYMTYPE
        ti.mode = 0o777
        ti.linkname = link
        tf.addfile(ti)

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tf:
    root_ti = tarfile.TarInfo(".")
    root_ti.type = tarfile.DIRTYPE
    root_ti.mode = 0o755
    root_ti.mtime = epoch
    root_ti.uid = 0
    root_ti.gid = 0
    root_ti.uname = "root"
    root_ti.gname = "root"
    tf.addfile(root_ti)
    for e in entries:
        ti = tarfile.TarInfo("./" + e[2])
        if e[0] == "symlink":
            add_entry(tf, ti, "symlink", link=e[3])
        elif e[0] == "dir":
            add_entry(tf, ti, "dir")
        else:
            add_entry(tf, ti, "file", path=e[1])
# gzip 头 mtime=0——tar 与 gzip 两层均确定性
data = gzip.compress(buf.getvalue(), compresslevel=9, mtime=0)
with open(out_file, "wb") as f:
    f.write(data)
PY
}

check_noise() {
  local TARBALL="$1"
  tar tzf "$TARBALL" | grep -iE "$NOISE" | head -10 || true
}

if [ "${1:-}" = "--check" ]; then
  TMP_TGZ="$(mktemp /tmp/release-check-XXXX.tgz)"
  pack "$TMP_TGZ"
  HITS=$(check_noise "$TMP_TGZ")
  rm -f "$TMP_TGZ"
  if [ -n "$HITS" ]; then
    echo "❌ 发布包含噪音（${VERSION}）:"
    echo "$HITS"
    exit 1
  fi
  echo "✅ 发布包干净（整仓库 tar 噪音检查——${VERSION}）"
  exit 0
fi

# 先删旧产物 + 产物写到仓库外临时目录（打包期间仓库根目录状态恒定——hash 可复现）
rm -f "$OUT"
TMPD=$(mktemp -d)
TMP_OUT="$TMPD/$(basename "$OUT")"
pack "$TMP_OUT"

# 自检：产出物噪音必须为 0
HITS=$(check_noise "$TMP_OUT")
if [ -n "$HITS" ]; then
  echo "❌ 打包产物含噪音——拒绝发布:"
  echo "$HITS"
  rm -rf "$TMPD"
  exit 1
fi

SHA=$(shasum -a 256 "$TMP_OUT" | awk '{print $1}')
SIZE=$(du -h "$TMP_OUT" | cut -f1)
mv "$TMP_OUT" "$OUT"
rm -rf "$TMPD"
echo "✅ ${OUT}（${SIZE}）"
echo "sha256: $SHA"
