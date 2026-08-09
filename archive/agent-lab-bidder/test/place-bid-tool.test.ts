import { test } from "node:test";
import assert from "node:assert/strict";
import { getBidBoard } from "../../agent-lab/src/arena/bid-board.ts";
import register from "../index.ts";

// 捕获 registerTool 注册的工具
function captureTool(): { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details: unknown }> } {
  let tool: never;
  const fakeApi = { registerTool: (t: unknown) => { tool = t as never; } } as never;
  return (register(fakeApi) as unknown as void, tool) as never;
}

test("place_bid records stake into shared BidBoard", async () => {
  const tool = captureTool();
  assert.equal(tool.name, "place_bid");
  const board = getBidBoard();
  board.openToken("tok-1", "agent-a");
  const res = await tool.execute("call-1", { token: "tok-1", stake: 42, reasoning: "good" });
  assert.match(res.content[0]!.text, /已记录/);
  assert.deepEqual(board.collect("tok-1"), { agentId: "agent-a", stake: 42, reasoning: "good" });
  board.close("tok-1");
});

test("place_bid rejects negative stake", async () => {
  const tool = captureTool();
  const board = getBidBoard();
  board.openToken("tok-2", "agent-b");
  const res = await tool.execute("call-2", { token: "tok-2", stake: -5, reasoning: "x" });
  assert.match(res.content[0]!.text, /拒绝/);
  assert.equal(board.collect("tok-2"), undefined);
  board.close("tok-2");
});

test("place_bid rejects unknown token", async () => {
  const tool = captureTool();
  const res = await tool.execute("call-3", { token: "ghost", stake: 10, reasoning: "x" });
  assert.match(res.content[0]!.text, /拒绝/);
});
