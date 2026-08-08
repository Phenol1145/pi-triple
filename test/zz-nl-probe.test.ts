import { describe, it } from "vitest";
import { translateTask } from "../src/pth/kernel/execution/nl-translator.js";
import { createKernelModelRouter } from "../src/pth/kernel/execution/model-router.js";
import { createLlmFn } from "../src/pth/kernel/interpreter/llm-fn.js";

describe("nl probe", () => {
  it("转译 fib 任务并查看代码", async () => {
    const router = await createKernelModelRouter();
    const llm = createLlmFn({ modelRouter: router });
    const r = await translateTask({ llm }, { title: "nl-斐波那契", text: "用 python 计算斐波那契数列第 25 项，返回数值" });
    console.log("RESULT:", JSON.stringify(r));
    if (r.ok) console.log("CODE:\n" + r.code);
  }, 60000);
});
