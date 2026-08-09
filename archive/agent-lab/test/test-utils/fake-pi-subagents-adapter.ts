/**
 * 共享 FakeAdapter（PiDelegateExecutor 桥接替身）。
 *
 * 从 test/pi-default-loop.test.ts 与 test/pi-delegate-executor.test.ts 抽取
 * 的同一实现（健康审计 F5）：delegate() 以定时轮询消费 onUpdate 队列，直至
 * terminal 注入后 resolve。测试通过 pushUpdate/finish 注入事件流。
 */
import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2Update,
  SubagentDelegationV2TerminalResponse,
} from "../../src/runtime/delegation-v2.ts";

export class FakeAdapter {
  requests: SubagentDelegationV2Request[] = [];
  private updates: SubagentDelegationV2Update[] = [];
  private terminal: SubagentDelegationV2TerminalResponse | null = null;

  pushUpdate(u: SubagentDelegationV2Update) { this.updates.push(u); }
  finish(t: SubagentDelegationV2TerminalResponse) { this.terminal = t; }

  delegate(
    request: SubagentDelegationV2Request,
    options: { onUpdate?: (u: SubagentDelegationV2Update) => void } = {},
  ): Promise<SubagentDelegationV2TerminalResponse> {
    this.requests.push(request);
    return new Promise<SubagentDelegationV2TerminalResponse>((resolve) => {
      const timer = setInterval(() => {
        if (this.updates.length > 0) {
          options.onUpdate?.(this.updates.shift()!);
        } else if (this.terminal) {
          clearInterval(timer);
          resolve(this.terminal);
        }
      }, 5);
    });
  }
}
