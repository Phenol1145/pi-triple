/**
 * Pi-Triple CLI — 多租户 pi 启动器
 *
 * 用法：
 *   npm run tui                          # 本地模式，启动 pi
 *   npm run tui -- --project myapp       # 指定项目
 *   npm run tui -- --model gpt-4o        # 指定模型
 *   npm run tui -- -c                    # 继续上次会话
 *   npm run tui -- -r                    # 选择历史会话
 *
 * 所有 pi 支持的参数都可以透传。
 */

import { launchPi } from "./launcher.js";

async function main() {
  const args = process.argv.slice(2);

  // 解析 Pi-Triple 自有参数
  let tenantId = process.env.PI_TENANT ?? "local";
  let project = "default";
  let provider: string | undefined;
  let model: string | undefined;
  let thinking: string | undefined;
  let tools: string | undefined;
  let excludeTools: string | undefined;
  let continueSession = false;
  let resumeSession: string | undefined;
  const extraArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--tenant":
        tenantId = args[++i];
        break;
      case "--project":
        project = args[++i];
        break;
      case "--provider":
        provider = args[++i];
        break;
      case "--model":
        model = args[++i];
        break;
      case "--thinking":
        thinking = args[++i];
        break;
      case "--tools":
        tools = args[++i];
        break;
      case "--exclude-tools":
        excludeTools = args[++i];
        break;
      case "-c":
      case "--continue":
        continueSession = true;
        break;
      case "-r":
      case "--resume":
        resumeSession = args[++i] ?? "";
        break;
      default:
        // 透传给 pi
        extraArgs.push(args[i]);
        break;
    }
  }

  const code = await launchPi({
    tenantId,
    project,
    provider,
    model,
    thinking,
    tools,
    excludeTools,
    continueSession,
    resumeSession: resumeSession || undefined,
    extraArgs,
  });

  process.exit(code);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
