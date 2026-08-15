#!/bin/bash
# release.sh —— 一键发布（0.8.0 发布事故复盘——2026-08-10 9.2 工程加固）
#
# 事故教训（本脚本断言的根源）：
#   ① 0.8.0 tgz 打进改名前旧内容（@pi-triple 依赖）——> 阶段 4 内容断言：tgz 内 package.json
#     name/version 必须与工作区一致
#   ② 改名横切改动导致容器镜像依赖陈旧崩溃 16h——> 阶段 6 docker 回归（build+health+冒烟）
#   ③ npm file: 依赖手工临替/还原易错——> 阶段 5 trap 兜底还原 + dist-tags 验证
#
# 阶段（0-4 安全默认；5-7 需显式 flag 开启）：
#   0 环境检查：工作区干净 / main 分支 / 与 origin 同步
#   1 版本一致性：根 == 7 子包；git tag v<ver> 未占用
#   2 残留检查：@pi-triple 旧 scope 零残留 + check-release-clean.sh（npm pack + tar 噪音双门禁）
#   3 测试：vitest 全量（--skip-tests 跳过）
#   4 打包：release-pack.sh + tgz 内容断言（name/version 与根一致）
#   5 npm：--npm 开启。topo 序发布 7 子包 + 根包（file: → ^ver 临替 → 还原 → dist-tags 验证）
#   6 docker 回归：--docker 开启。build + force-recreate + health + kernel/status + 冒烟任务
#   7 GitHub：--gh 开启。gh release create + tgz 附件（--notes <file> 自定义发布笔记）
#
# 用法：
#   scripts/release.sh                          # 检查 + 打包（安全默认）
#   scripts/release.sh --npm --docker --gh --notes /tmp/notes.md   # 全量发布
set -euo pipefail
cd "$(dirname "$0")/.."

# ── 参数 ─────────────────────────────────────────────
DO_NPM=0; DO_DOCKER=0; DO_GH=0; SKIP_TESTS=0; NOTES_FILE=""
for arg in "$@"; do
  case "$arg" in
    --npm) DO_NPM=1 ;;
    --docker) DO_DOCKER=1 ;;
    --gh) DO_GH=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --notes=*) NOTES_FILE="${arg#*=}" ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

say()  { echo ""; echo "═══ $* ═══"; }
fail() { echo "❌ $*"; exit 1; }
ok()   { echo "✅ $*"; }

json_get() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }

ROOT_NAME=$(json_get package.json name)
ROOT_VER=$(json_get package.json version)
SUBPACKAGES=(shared infra pth-memory pth-sandbox mailbox framework dev-container)
TGZ="pi-triple-v${ROOT_VER}.tgz"

# ── 阶段 0：环境检查 ──────────────────────────────────
say "阶段 0：环境检查"
[ -z "$(git status -s)" ] || fail "工作区不干净——先提交（git status 有未提交改动）"
[ "$(git branch --show-current)" = "main" ] || fail "不在 main 分支"
git fetch origin main -q
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "本地与 origin/main 未同步——先 push"
ok "工作区干净 / main / 与 origin 同步（$(git rev-parse --short HEAD)）"

# ── 阶段 1：版本一致性 ────────────────────────────────
say "阶段 1：版本一致性（根=${ROOT_NAME}@${ROOT_VER}）"
[ "$ROOT_NAME" = "@away_from/pi-triple" ] || fail "根包 name 异常：${ROOT_NAME}（期望 @away_from/pi-triple）"
for pkg in "${SUBPACKAGES[@]}"; do
  P="packages/$pkg/package.json"
  N=$(json_get "$P" name); V=$(json_get "$P" version)
  [ "$N" = "@away_from/$pkg" ] || fail "$P name 异常：$N"
  [ "$V" = "$ROOT_VER" ] || fail "$P version=$V 与根 $ROOT_VER 不一致"
done
if git tag -l "v${ROOT_VER}" | grep -q .; then
  echo "⚠️  tag v${ROOT_VER} 已存在（--gh 阶段将失败——增量发布请先 bump version）"
fi
ok "${#SUBPACKAGES[@]} 子包 name/version 与根一致"

# ── 阶段 2：残留检查 ──────────────────────────────────
say "阶段 2：残留检查"
HITS=$(grep -rn "@pi-triple" src/ packages/*/src packages/*/package.json package.json toolstore/ 2>/dev/null | grep -v "\.test\." || true)
[ -z "$HITS" ] || fail "@pi-triple 旧 scope 残留：\n$HITS"
ok "@pi-triple 零残留"
bash scripts/check-release-clean.sh || fail "check-release-clean 门禁未过"

# ── 阶段 3：测试 ─────────────────────────────────────
if [ "$SKIP_TESTS" = "1" ]; then
  say "阶段 3：测试（--skip-tests 跳过）"
else
  say "阶段 3：测试（vitest 全量）"
  OUT=$(npx vitest run 2>&1 | tail -4) || { echo "$OUT"; fail "测试未全绿"; }
  echo "$OUT" | grep -E "Tests|Files" | sed 's/^/  /'
  ok "测试全绿"
fi

# ── 阶段 4：打包 + 内容断言 ──────────────────────────
say "阶段 4：打包 + 内容断言"
rm -f "$TGZ"
bash scripts/release-pack.sh || fail "release-pack 失败"
[ -f "$TGZ" ] || fail "$TGZ 未生成"
TMPD=$(mktemp -d)
tar xzf "$TGZ" -C "$TMPD" ./package.json
PKG_NAME=$(json_get "$TMPD/package.json" name)
PKG_VER=$(json_get "$TMPD/package.json" version)
rm -rf "$TMPD"
[ "$PKG_NAME" = "$ROOT_NAME" ] || fail "tgz 内 name=$PKG_NAME ≠ 工作区 ${ROOT_NAME}（0.8.0 旧包事故防线）"
[ "$PKG_VER" = "$ROOT_VER" ] || fail "tgz 内 version=$PKG_VER ≠ 工作区 $ROOT_VER"
ok "$TGZ 内容断言通过（name/version 一致）"

# ── 阶段 5：npm 发布（--npm）─────────────────────────
if [ "$DO_NPM" = "1" ]; then
  say "阶段 5：npm 发布（topo 序：${SUBPACKAGES[*]} + 根包）"
  # file: 依赖临替为 ^version；trap 兜底还原（发布中断不脏工作区）
  restore_pkgjson() { git checkout -- package.json packages/*/package.json 2>/dev/null || true; }
  trap restore_pkgjson EXIT
  sed -i '' -E "s|\"(@away_from/[a-z-]+)\": \"file:[^\"]+\"|\"\1\": \"^${ROOT_VER}\"|g" package.json packages/*/package.json
  echo "  file: 依赖已临替为 ^${ROOT_VER}"
  for pkg in "${SUBPACKAGES[@]}"; do
    echo "  → 发布 @away_from/$pkg"
    (cd "packages/$pkg" && npm publish --access public 2>&1 | tail -1) || fail "@away_from/$pkg 发布失败"
  done
  echo "  → 发布根包 @away_from/pi-triple"
  npm publish --access public 2>&1 | tail -1 || fail "根包发布失败"
  restore_pkgjson
  trap - EXIT
  ok "npm 发布完成（file: 依赖已还原）"
  echo "  dist-tags 验证（registry 传播可能延迟数分钟——失败可稍后 npm view 复查）:"
  for pkg in "${SUBPACKAGES[@]}" pi-triple; do
    V=$(npm view "@away_from/$pkg" version 2>/dev/null || echo "?")
    echo "    @away_from/$pkg: $V"
  done
fi

# ── 阶段 6：docker 回归（--docker）────────────────────
if [ "$DO_DOCKER" = "1" ]; then
  say "阶段 6：docker 回归（build + 健康 + 冒烟）"
  docker compose build pi-platform || fail "镜像构建失败"
  docker compose up -d --force-recreate pi-platform || fail "容器重建失败"
  # 健康等待（最长 90s）
  HEALTHY=0
  for i in $(seq 1 18); do
    sleep 5
    if curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"status":"ok"'; then HEALTHY=1; break; fi
  done
  [ "$HEALTHY" = "1" ] || fail "健康检查超时（90s）"
  ok "健康检查通过"
  # 冒烟任务（NL + 角色标签 → agent 完成）
  TOKEN="${PTH_SMOKE_TOKEN:-test-token-123}"
  RESP=$(curl -s -X POST http://localhost:3000/api/v1/kernel/tasks \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"title":"release-smoke","text":"计算 6 乘以 7 并返回答案。","tags":["test"],"createdBy":"release"}')
  TID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  [ -n "$TID" ] || fail "冒烟任务提交失败：$RESP"
  DONE=0
  for i in $(seq 1 24); do
    sleep 5
    ST=$(curl -s "http://localhost:3000/api/v1/kernel/tasks/$TID" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [ "$ST" = "completed" ]; then DONE=1; break; fi
    if [ "$ST" = "rejected" ]; then fail "冒烟任务被拒绝（${TID}）"; fi
  done
  [ "$DONE" = "1" ] || fail "冒烟任务超时未完成（${TID}）"
  ok "冒烟任务 completed（${TID}）"
fi

# ── 阶段 7：GitHub release（--gh）─────────────────────
if [ "$DO_GH" = "1" ]; then
  say "阶段 7：GitHub release v${ROOT_VER}"
  git tag -l "v${ROOT_VER}" | grep -q . && fail "tag v${ROOT_VER} 已存在"
  if [ -n "$NOTES_FILE" ]; then
    gh release create "v${ROOT_VER}" "$TGZ" --title "Pi-Triple v${ROOT_VER}" --notes-file "$NOTES_FILE" || fail "gh release 失败"
  else
    gh release create "v${ROOT_VER}" "$TGZ" --title "Pi-Triple v${ROOT_VER}" --generate-notes || fail "gh release 失败"
  fi
  ok "GitHub release v${ROOT_VER} 已创建（附件 ${TGZ}）"
fi

say "发布流程完成"
echo "  版本: $ROOT_NAME@$ROOT_VER"
echo "  包:   $TGZ$([ -f "$TGZ" ] && echo "（$(du -h "$TGZ" | cut -f1)）")"
[ "$DO_NPM" = "1" ] && echo "  npm:  6 包已发布"
[ "$DO_DOCKER" = "1" ] && echo "  docker: 回归通过"
[ "$DO_GH" = "1" ] && echo "  github: v${ROOT_VER} 已发布"
