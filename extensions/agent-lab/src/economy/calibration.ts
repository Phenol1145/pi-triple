// 校准任务池与合成执行者（plan Task 6 / spec §7a.7）。
// operator 注入预制校准任务集；announce 校准分支 draw 取任务；合成执行者短路产出
// 预制交付物（无 LLM/不耗凭证——execute 节点对 calibration-executor 短路，不 spawnAgent）。
//
// 钉死（spec M-R5）：
//   - stake_cal=0：escrow 项池内自抵省略（无执行者 stake 项——market-effects.ts 校准分支）；
//   - settle 直接入池（执行者 settle=0，评审负 settle/税入中央池）；
//   - 校准事件带 isCalibration:true（effect 层按任务标记透传）；
//   - ground truth 评定：执行者 c=groundTruthScore；评审者 a_i=1−|r_i−groundTruthScore|
//     （settlement.ts planSettlement groundTruthScore 路径）。
export interface CalibrationTask {
  taskId: string;
  brief: string;
  groundTruthArtifact: string;
  groundTruthScore: number;
}

/** 合成执行者保留 ID（RESERVED_IDS 黑名单——central-pool.ts，禁止外部开户/竞价）。 */
export const CALIBRATION_EXECUTOR_ID = "calibration-executor";

/**
 * 校准任务池（operator 注入的预制校准任务集）。
 * draw：announce 校准分支取任务——均匀随机取一（rng 注入可测）；空池返回 undefined
 * （回退普通任务——与 Task 2 占位回退语义一致）。
 */
export class CalibrationPool {
  private readonly tasks: CalibrationTask[] = [];

  /** 注入预制校准任务（operator 装配期调用）。 */
  add(t: CalibrationTask): void {
    this.tasks.push(t);
  }

  draw(rng: () => number): CalibrationTask | undefined {
    if (this.tasks.length === 0) return undefined;
    const idx = Math.min(this.tasks.length - 1, Math.floor(rng() * this.tasks.length));
    return this.tasks[idx];
  }

  /**
   * 按 taskId 取回校准任务（只读）。Task 11 集成需要：announce 只返回
   * { taskId, isCalibration }，不暴露 groundTruthScore——runner/结算侧按 taskId 回查。
   */
  find(taskId: string): CalibrationTask | undefined {
    return this.tasks.find((t) => t.taskId === taskId);
  }
}

/**
 * 合成执行者：短路产出预制交付物（groundTruthArtifact 原文返回）——无 LLM/不耗凭证。
 * execute 节点对 calibration-executor 短路（不 spawnAgent），直接调用本函数取输出。
 */
export function calibrationExecutorRun(task: CalibrationTask): { output: string } {
  return { output: task.groundTruthArtifact };
}
