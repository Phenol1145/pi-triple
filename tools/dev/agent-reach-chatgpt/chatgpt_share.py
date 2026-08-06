# -*- coding: utf-8 -*-
"""ChatGPT 分享会话 — 解码 chatgpt.com/share/<id> 链接。

分享页是 JS 渲染的 React Router 应用，会话内容嵌在 HTML 的 turbo-stream
payload 里，通用网页阅读器拿不到；chatgpt-share CLI 负责抓取+解码。
"""

import re
import subprocess

from agent_reach.probe import probe_command

from .base import Channel

_URL_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)/(?:share|s)/",
    re.I,
)


class ChatGPTShareChannel(Channel):
    name = "chatgpt_share"
    description = "ChatGPT 分享会话解码"
    backends = ["chatgpt-share CLI"]
    tier = 0

    def can_handle(self, url: str) -> bool:
        return bool(_URL_RE.match(url.strip()))

    def check(self, config=None):
        r = probe_command("chatgpt-share", ("--version",), timeout=10)
        if r.ok:
            self.active_backend = self.backends[0]
            return "ok", (
                f"{r.output.strip()} — 用法：chatgpt-share read "
                "<chatgpt.com/share/...>（输出 md/json/jsonl）；"
                "meta 子命令看标题/消息数/模型"
            )
        self.active_backend = None
        if r.status == "missing":
            return "off", (
                "chatgpt-share CLI 未安装。安装：将 chatgpt-share 脚本"
                "（~/.agent-reach/tools/chatgpt-share/）复制到 ~/.local/bin/ "
                "并 chmod +x"
            )
        return "warn", f"chatgpt-share CLI 探测异常（{r.status}）。{r.hint}"

    def read(self, url: str) -> str:
        """抓取并解码分享链接，返回 Markdown transcript。"""
        out = subprocess.run(
            ["chatgpt-share", "read", url],
            capture_output=True, text=True, timeout=120,
        )
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip() or f"exit {out.returncode}")
        return out.stdout
