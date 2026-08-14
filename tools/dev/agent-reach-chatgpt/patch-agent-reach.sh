#!/bin/bash
# 在 dev 容器内（重新）安装 chatgpt-share 后端到 agent-reach。
# agent-reach pip 升级会覆盖 site-packages 补丁，升级后重跑本脚本即可。
# 用法：bash ~/.agent-reach/tools/chatgpt-share/patch-agent-reach.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="${AR_COMPOSE:-/Users/anzhize/pi-platform/deploy/docker-compose.yaml}"
CID=$(docker compose -f "$COMPOSE" ps -q dev)
[ -n "$CID" ] || { echo "dev 容器未运行"; exit 1; }

# 定位容器内 agent_reach 包路径
SITE=$(docker compose -f "$COMPOSE" exec -T dev python3 -c \
  "import agent_reach,os;print(os.path.dirname(agent_reach.__file__))")
echo "agent_reach @ $SITE"

# 1. CLI
docker cp "$HERE/chatgpt-share" "$CID:/home/jovyan/.local/bin/chatgpt-share"
docker compose -f "$COMPOSE" exec -T dev chmod +x /home/jovyan/.local/bin/chatgpt-share

# 2. channel 插件 + skill 参考文档
docker cp "$HERE/chatgpt_share.py" "$CID:$SITE/channels/chatgpt_share.py"
docker cp "$HERE/chatgpt.md" "$CID:$SITE/skill/references/chatgpt.md"

# 3. 注册 channel + SKILL.md 路由（幂等）
docker compose -f "$COMPOSE" exec -T dev python3 - "$SITE" <<'EOF'
import pathlib, sys
site = pathlib.Path(sys.argv[1])

init = site / "channels/__init__.py"
s = init.read_text(encoding="utf-8")
if "chatgpt_share" not in s:
    s = s.replace(
        "from .bilibili import BilibiliChannel",
        "from .bilibili import BilibiliChannel\nfrom .chatgpt_share import ChatGPTShareChannel")
    s = s.replace(
        "    ExaSearchChannel(),\n    WebChannel(),",
        "    ExaSearchChannel(),\n    ChatGPTShareChannel(),\n    WebChannel(),")
    init.write_text(s, encoding="utf-8")

sk = site / "skill/SKILL.md"
s = sk.read_text(encoding="utf-8")
changed = False
if "references/chatgpt.md" not in s:
    s = s.replace("雪球/股票行情, RSS feeds, or any web URL.",
                  "雪球/股票行情, RSS feeds, ChatGPT 分享会话, or any web URL.")
    s = s.replace("| 网页/文章/RSS | web | [references/web.md](references/web.md) |",
                  "| ChatGPT 分享会话 | chatgpt | [references/chatgpt.md](references/chatgpt.md) |\n"
                  "| 网页/文章/RSS | web | [references/web.md](references/web.md) |")
    s = s.replace("# 通用网页阅读\ncurl -s \"https://r.jina.ai/URL\"",
                  "# 通用网页阅读\ncurl -s \"https://r.jina.ai/URL\"\n\n"
                  "# ChatGPT 分享会话解码（share 页是 JS 渲染，Jina 读不到）\n"
                  "chatgpt-share read \"https://chatgpt.com/share/<id>\"")
    changed = True
if "- chatgpt:" not in s:
    s = s.replace("  - finance: 雪球/股票/stock/xueqiu/行情/基金",
                  "  - finance: 雪球/股票/stock/xueqiu/行情/基金\n"
                  "  - chatgpt: chatgpt.com/share/chatgpt分享/GPT会话/分享会话")
    changed = True
if changed:
    sk.write_text(s, encoding="utf-8")
print("注册完成")
EOF

# 4. 同步宿主机 skill 文档（若宿主机 skill 目录存在且未打补丁）
HOST_SKILL="$HOME/.agents/skills/agent-reach"
if [ -d "$HOST_SKILL" ]; then
  cp "$HERE/chatgpt.md" "$HOST_SKILL/references/chatgpt.md"
  python3 - "$HOST_SKILL/SKILL.md" <<'EOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
changed = False
if "references/chatgpt.md" not in s:
    s = s.replace("雪球/股票行情, RSS feeds, or any web URL.",
                  "雪球/股票行情, RSS feeds, ChatGPT 分享会话, or any web URL.")
    s = s.replace("| 网页/文章/RSS | web | [references/web.md](references/web.md) |",
                  "| ChatGPT 分享会话 | chatgpt | [references/chatgpt.md](references/chatgpt.md) |\n"
                  "| 网页/文章/RSS | web | [references/web.md](references/web.md) |")
    s = s.replace("# 通用网页阅读\ncurl -s \"https://r.jina.ai/URL\"",
                  "# 通用网页阅读\ncurl -s \"https://r.jina.ai/URL\"\n\n"
                  "# ChatGPT 分享会话解码（share 页是 JS 渲染，Jina 读不到）\n"
                  "chatgpt-share read \"https://chatgpt.com/share/<id>\"")
    changed = True
if "- chatgpt:" not in s:
    s = s.replace("  - finance: 雪球/股票/stock/xueqiu/行情/基金",
                  "  - finance: 雪球/股票/stock/xueqiu/行情/基金\n"
                  "  - chatgpt: chatgpt.com/share/chatgpt分享/GPT会话/分享会话")
    changed = True
if changed:
    p.write_text(s, encoding="utf-8")
print("宿主 skill 已同步")
EOF
fi

echo "✅ 完成。验证：agent-reach doctor | grep -i chatgpt"
