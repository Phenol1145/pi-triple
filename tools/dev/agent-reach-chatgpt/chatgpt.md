# ChatGPT 分享会话解码

ChatGPT 分享链接（`chatgpt.com/share/<id>`、`chatgpt.com/s/<id>`）是 JS 渲染页面，
会话内容嵌在 HTML 的 turbo-stream payload 里——**Jina Reader 只能看到登录壳，
必须用专用后端 `chatgpt-share`**。零配置（纯 stdlib，无需登录）。

## 基本用法

```bash
# Markdown transcript（默认仅 user/assistant）
chatgpt-share read "https://chatgpt.com/share/<id>"

# 纯文本 / JSON / JSONL
chatgpt-share read URL -f text
chatgpt-share read URL -f json      # 数组：id/role/text/model/create_time
chatgpt-share read URL -f jsonl

# 会话元信息（标题、消息数、角色分布、模型、时间范围）
chatgpt-share meta URL
```

## 选项

```bash
--all                  # 包含 system/tool 消息（默认过滤）
--roles user,assistant # 自定义角色过滤
-o FILE                # 写入文件
--timeout 45           # 抓取超时（秒）
```

URL 和裸 share id 都可以：`chatgpt-share meta 6a7363bb-...`。

## 示例

```bash
chatgpt-share read "https://chatgpt.com/share/6a7363bb-e58c-83e8-a7e3-9ad147a2cf2f" | head -50
```

## 输出约定

- Markdown 每条消息为 `### [role] 时间 (模型)` + 正文，`---` 分隔。
- 退出码：0 成功；2 网络/抓取失败；3 页面结构解码失败（分享被删或 ChatGPT 改版）。

## 故障排查

| 现象 | 处理 |
|-----|------|
| `网络错误 ... CERTIFICATE_VERIFY_FAILED` | 工具会自动降级证书校验（带警告）；容器内一般无此问题 |
| HTTP 403/503 | Cloudflare 拦截，工具自动重试一次；仍失败则稍后再试 |
| `未找到 streamController.enqueue` | 分享已删除、链接无效，或 ChatGPT 前端改版——改版时更新解码器 |
| 长会话输出太大 | 用 `meta` 先看规模，再 `-f jsonl \| head` 或按 `--roles` 过滤 |

## 安装

脚本位于 `~/.agent-reach/tools/chatgpt-share/chatgpt-share`（单文件、纯 stdlib），
软链或复制到 PATH（如 `~/.local/bin/`）即可。Agent Reach doctor 会探测 `chatgpt_share` 渠道。
