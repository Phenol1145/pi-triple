/**
 * @away_from/mailbox 包导入测试
 * Task 1 验收：pit-communicate 独立化为 packages/mailbox 后可经包名导入。
 */
import { describe, it, expect } from "vitest";
import { Mailbox } from "@away_from/mailbox";
import pitMail from "@away_from/mailbox";

describe("@away_from/mailbox", () => {
  it("Mailbox 类可从包入口导入", () => {
    expect(Mailbox).toBeDefined();
  });

  it("默认导出为扩展工厂函数（/mail 命令注册入口）", () => {
    expect(typeof pitMail).toBe("function");
  });
});
