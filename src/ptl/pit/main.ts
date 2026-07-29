/**
 * pit/main — banner / help / version print helpers
 */

const VERSION = "0.1.0";

export function printBanner(): void {
  console.log("");
  console.log("  \x1b[36m\x1b[1mPi-Triple\x1b[0m \x1b[2mv" + VERSION + "\x1b[0m");
  console.log("");
}

export function getVersion(): string { return VERSION; }

export function printHelp(): void {
  printBanner();
  console.log("  用法: pit <command> [options]");
  console.log("");
  console.log("  命令:");
  console.log("    onboard            首次导引（检查→安装→租户→迁移→验证）");
  console.log("    start [args...]    启动 tmux 会话并接入（--bg 纯后台，--name 命名）");
  console.log("    pi [args...]       原生前台启动 pi（无 tmux）");
  console.log("    ui                 系统总控 TUI（无参数时也进入）");
  console.log("    lab                模型调试 TUI（--template/--global）");
  console.log("    attach <name>      接入后台会话（同一终端切换）");
  console.log("    switch <name>      切换会话（tmux 内瞬移，外则 attach）");
  console.log("    detach             脱离当前会话（保持运行）");
  console.log("    ls                 列出所有会话（前台+后台）");
  console.log("    stop <name>        停止后台会话");
  console.log("    status             快速健康检查");
  console.log("    doctor             完整健康检查 + 交互修复");
  console.log("    tenant ls          列出所有租户（别名 + UUID）");
  console.log("    tenant new [alias] 新建租户");
  console.log("    tenant rm <alias>  删除租户");
  console.log("    tenant rename <old> <new>  重命名租户别名");
  console.log("    update             更新 pi 本体（--extensions 扩展包，--all 全部）");
  console.log("    install <source>    安装 pi 扩展 (--shared 装到共享层)");
  console.log("    remove <source>     卸载 pi 扩展");
  console.log("    migrate            迁移 pi 扩展到当前租户");
  console.log("    shared status       查看共享层状态");
  console.log("    shared init         初始化共享层（从默认租户提升）");
  console.log("    config             显示当前配置");
  console.log("    config get <key>   读取配置项");
  console.log("    config set <key> <value>  修改配置项");
  console.log("    config unset <key> 删除租户可选配置项");
  console.log("    config init        初始化 pi-triple.json");
  console.log("    submit <dir>       提交 agent 程序到 PTH");
  console.log("    submit <dir> --dry-run  校验 + 打包（不上传）");
  console.log("    programs           列出 PTH 上已提交的程序");
  console.log("    run <name> [k=v...]  远端运行程序（SSE 流式输出）");
  console.log("    dev <dir>           本地调试程序（pi 交互会话）");
  console.log("    flow run <file> [k=v]  运行工作流");
  console.log("    flow ls                列出工作流");
  console.log("    flow show/status <id>  状态/详情");
  console.log("    flow approve/reject <id> 人工审批");
  console.log("    flow validate <file>   校验定义");
  console.log("    help               显示帮助");
  console.log("");
  console.log("  选项:");
  console.log("    --template <alias|uuid>  指定租户（别名或 UUID）");
  console.log("    --project <name>       指定项目");
  console.log("    --model <model>        覆盖模型");
  console.log("");
  console.log("  示例:");
  console.log("    pit start                          # 默认租户，tmux 接入");
  console.log("    pit start --template dev             # 指定租户（别名）");
  console.log("    pit start --bg --name coding       # 纯后台启动");
  console.log("    pit pi                             # 原生前台启动（无 tmux）");
  console.log("    pit attach coding                  # 接入后台会话");
  console.log("    pit config set pth.url http://...  # 连接 PTH");
  console.log("    pit submit my-agent                 # 提交程序");
  console.log("    pit run code-reviewer repo=./x pr=42  # 远端运行");
  console.log("    pit dev my-agent                    # 本地调试");
  console.log("    pit flow run pr-review.json pr=123  # 运行工作流");
  console.log("    pit flow ls                          # 列出工作流");
  console.log("    pit template new my-team             # 新建租户");
  console.log("    pit template ls                        # 列出租户");
  console.log("");
}
