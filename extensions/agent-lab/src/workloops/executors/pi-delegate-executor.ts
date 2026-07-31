/**
 * pi-delegate-executor.ts — 委托式执行器（PiSubagentsAdapter 事件源）
 *
 * 把 pi 进程内官方循环的事件流（onUpdate 回调）映射为 MachineEvent 流：
 *   - onUpdate → { type: "pi_update", payload: update }
 *   - terminal response → { type: "pi_terminal", payload: terminal }
 *
 * 回调 → async generator 桥：delegate 的 onUpdate 推入队列，generator 拉取。
 * 中断恢复：resume 后重新 delegate 用新 requestId（spec §5.2）。
 */
import type { PiSubagentsAdapter } from "../../runtime/pi-subagents-adapter.ts";
import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2Update,
  SubagentDelegationV2TerminalResponse,
} from "../../runtime/delegation-v2.ts";
import type { Executor, ExecutorContext, MachineEvent } from "../../workloop/machine.ts";
import type { WorkLoopInput, WorkLoopSDK } from "../../workloop/contracts.ts";

/** pi 进程内 onUpdate → pi_update 事件（payload 保留 update 全量，不改写） */
export function updateToEvent(update: SubagentDelegationV2Update): MachineEvent {
  return { type: "pi_update", payload: update };
}

/**
 * 委托式执行器：把 PiSubagentsAdapter.delegate 的 onUpdate 回调流
 * 桥接为 async generator 事件流。terminal 响应 → pi_terminal 后终止。
 */
export class PiDelegateExecutor implements Executor {
  // 注：不用 TS 参数属性（parameter properties）——项目以 --experimental-strip-types
  // 运行，strip-only 模式不支持该语法，须显式声明字段。
  private readonly adapter: PiSubagentsAdapter;
  private readonly buildRequest: (
    input: WorkLoopInput,
    ectx: ExecutorContext,
  ) => SubagentDelegationV2Request;

  constructor(
    adapter: PiSubagentsAdapter,
    buildRequest: (input: WorkLoopInput, ectx: ExecutorContext) => SubagentDelegationV2Request,
  ) {
    this.adapter = adapter;
    this.buildRequest = buildRequest;
  }

  async *start(
    input: WorkLoopInput,
    sdk: WorkLoopSDK,
    ectx: ExecutorContext,
  ): AsyncIterable<MachineEvent> {
    const pending: SubagentDelegationV2Update[] = [];
    let notify: (() => void) | null = null;
    let terminal: SubagentDelegationV2TerminalResponse | null = null;

    const v2req = this.buildRequest(input, ectx);
    const terminalPromise = this.adapter.delegate(v2req, {
      onUpdate: (update) => {
        pending.push(update);
        notify?.();
      },
    });

    while (true) {
      // 先排空已到达的更新（FIFO），再产出 terminal —— 顺序稳定
      if (pending.length > 0) {
        yield updateToEvent(pending.shift()!);
        continue;
      }
      if (terminal) {
        yield { type: "pi_terminal", payload: terminal };
        return;
      }
      // 等待：terminal 完成 或 下一次 onUpdate（任一先到即醒）
      const wait = new Promise<void>((resolve) => { notify = resolve; });
      const terminalResult = await Promise.race([
        terminalPromise.then((t) => { terminal = t; return t; }),
        wait.then(() => null),
      ]);
      notify = null;
      if (terminalResult) terminal = terminalResult;
    }
  }

  dispose(): void {
    // adapter 生命周期由 runner 管理（现有 dispose 语义）
  }
}
