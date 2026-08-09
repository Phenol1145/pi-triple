// elo 系统（spec §3 / plan Task 4）——公式注册表 + 默认公式 + 选择函数。
//
// 数值钉死（spec §3.1/§3.3）：initial=1500；FLOOR=100；K=32；odds→taskRating 线性映射
// taskRating = 1500 + 200×(O−1)（I13）；stake-elo-power = stake^α × max(elo/1500, 0.01)^β（α=1.0/β=0.5 tunable）。
//
// RegistryPattern：注册表 register/get（未注册 get 抛错；同 id 注册 = 替换——spec §12「公式注册替换」）。
// 本模块纯函数无状态：结算双写 eloGlobal + eloByDomain 由消费方（apply_settlement effect）调用公式完成，
// 持久化经 repository elo_global / elo_by_domain 列（本任务 ⑦ 迁移）。

export type EloUpdateContext = { taskRating: number; outcome: number; weight?: number };

export interface EloFormula {
  readonly id: string;
  initial(context: { isOrg: boolean }): number;
  update(rating: number, ctx: EloUpdateContext): number;
}

export interface SelectionFormula {
  readonly id: string;
  score(candidate: { stake: number; elo: number }, ctx: { taskRating: number }): number;
}

/** 数值钉死常量（spec §3.1：initial 1500 / FLOOR 100 / K=32）。 */
export const ELO_DEFAULTS = { INITIAL: 1500, FLOOR: 100, K: 32 } as const;

/**
 * odds → taskRating 线性映射（I13 钉死）：`1500 + 200×(O−1)`。
 * O=1（义务性任务）→ 1500；O=2 → 1700；O=4 → 2100。
 */
export function taskRatingFromOdds(odds: number): number {
  return 1500 + 200 * (odds - 1);
}

export class EloFormulaRegistry {
  private readonly formulas = new Map<string, EloFormula>();

  /** 注册公式；同 id 再注册 = 替换（spec §12）。 */
  register(f: EloFormula): void {
    this.formulas.set(f.id, f);
  }

  /** 取公式；未注册抛错。 */
  get(id: string): EloFormula {
    const f = this.formulas.get(id);
    if (!f) throw new Error(`elo formula not registered: ${id}`);
    return f;
  }
}

export class SelectionFormulaRegistry {
  private readonly formulas = new Map<string, SelectionFormula>();

  /** 注册选择公式；同 id 再注册 = 替换。 */
  register(f: SelectionFormula): void {
    this.formulas.set(f.id, f);
  }

  /** 取选择公式；未注册抛错。 */
  get(id: string): SelectionFormula {
    const f = this.formulas.get(id);
    if (!f) throw new Error(`selection formula not registered: ${id}`);
    return f;
  }
}

/**
 * 默认 elo 公式（spec §3.1）：`R' = max(FLOOR, R + K×(outcome − expected))`，
 * `expected = 1/(1+10^((taskRating−R)/400))`。initial=1500（组织与个人同分）；weight 预留。
 */
export const simpleElo: EloFormula = {
  id: "simple-elo",
  initial(): number {
    return ELO_DEFAULTS.INITIAL;
  },
  update(rating, ctx): number {
    const expected = 1 / (1 + 10 ** ((ctx.taskRating - rating) / 400));
    const updated = rating + ELO_DEFAULTS.K * (ctx.outcome - expected);
    return Math.max(ELO_DEFAULTS.FLOOR, updated);
  },
};

/**
 * stake-elo-power 构造工厂（spec §3.3）——α/β 构造参数可覆盖（默认 α=1.0 / β=0.5）。
 * `score = stake^α × max(elo/1500, 0.01)^β`；同分判定由消费方处理（stake 高 → agentId 字典序，§3.3）。
 */
export function createStakeEloPower(params: { alpha?: number; beta?: number } = {}): SelectionFormula {
  const alpha = params.alpha ?? 1.0;
  const beta = params.beta ?? 0.5;
  return {
    id: "stake-elo-power",
    score(candidate): number {
      const norm = Math.max(candidate.elo / ELO_DEFAULTS.INITIAL, 0.01);
      return candidate.stake ** alpha * norm ** beta;
    },
  };
}

/** 默认选择公式（spec §3.3）：stake^1.0 × max(elo/1500, 0.01)^0.5。 */
export const stakeEloPower: SelectionFormula = createStakeEloPower();
