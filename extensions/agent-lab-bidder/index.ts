/**
 * agent-lab-bidder — 提供 place_bid 工具，供 Arena WorkLoop 竞价 subagent 出价。
 *
 * 出价写入 getBidBoard()（globalThis 单例），与 agent-lab 扩展的 arena
 * scheduler 共享同一实例。token 由 arena 生成并随竞价提示下发，一次性。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBidBoard } from "../agent-lab/src/arena/bid-board.ts";

export default function agentLabBidder(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "place_bid",
    label: "Place Arena Bid",
    description:
      "提交你对当前竞价任务的出价（credits）。token 来自竞价提示，必须原样传回。每个 token 只能出价一次。",
    promptSnippet:
      "Submit your arena bid stake for a task using the bid token from the bidding prompt",
    promptGuidelines: [
      "Call place_bid exactly once per bidding task, using the token given in the task.",
      "stake is a non-negative number of credits; reasoning is a short justification.",
      "Do not execute the task itself during bidding — only decide and place your stake.",
    ],
    parameters: {
      token: { type: "string", description: "竞价令牌（竞价提示中给出，原样传回）" },
      stake: { type: "number", description: "出价 credits（非负数）" },
      reasoning: { type: "string", description: "出价理由（简短）" },
      required: ["token", "stake", "reasoning"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const token = String(params.token ?? "");
      const stake = Number(params.stake);
      const reasoning = String(params.reasoning ?? "");
      if (!Number.isFinite(stake) || stake < 0) {
        return {
          content: [{ type: "text", text: "出价被拒绝：stake 必须是非负数" }],
          details: { ok: false, reason: "invalid-stake" },
        };
      }
      const res = getBidBoard().place(token, stake, reasoning);
      return {
        content: [
          {
            type: "text",
            text: res.ok
              ? `出价已记录：${stake} credits`
              : `出价被拒绝：${res.reason ?? "unknown"}`,
          },
        ],
        details: res,
      };
    },
  });
}
