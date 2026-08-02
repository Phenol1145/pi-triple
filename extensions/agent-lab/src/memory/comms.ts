// sdk.comms 通讯（spec §8 / plan Task 10）：消息 / 幂等 / 身份映射 / 纸带注入。
//
// 语义（spec 逐字 + 第四轮 R4，钉死）：
// - 通讯 = 纸带交换：comms 与用户消息同通道——tapeFragment 由调用方（Task 12）作为
//   user 消息追加进接收方纸带（带来源标记 peer:<id>），不冒充记忆、不绕过校验链；
//   v1 只提供注入回调注册，真实纸带注入由 Task 12 挂到 WorkLoopSDK
// - msgId 由发送方生成（randomUUID）；去重范围 = 接收 agent 全局
// - 去重状态随 checkpoint 水位同步（R4）：dedup 记录 {msgId, watermark}；
//   pruneDedup(seq) 丢弃 watermark > seq 的记录——resume 后允许重复投递，
//   防"已投递但被拒收"的幽灵拒收（纸带 append-only + 内容比对兜底）
// - 打点水位：v1 以通道当前水位为基准（默认 0，pruneDedup 推进到 seq）——
//   精确的 nextCheckpointSeq 打点需装配层在转移开始时喂入（留 Task 12 接线，
//   未接线时全 0 → pruneDedup 为保守 no-op，绝不误删）
// - 持久化：dir/dedup.jsonl（接收时 append-only 追加；prune 时 tmp+rename 原子重写；
//   构造时加载——重启去重状态不丢，防崩溃窗口后重复注入）
// - 自我打点：send 时把自身 msgId 记入去重表（先于 transport.send）——
//   传输回环/广播不会把自己注入纸带（"接收 agent 全局"含自身消息）
// - 路由兜底：onMessage 只处理 to === 自身 agentId 的消息（transport 负责投递，
//   channel 防御性过滤非本人消息）
// - 大小上限：tapeFragment ≤ 4096 字节（UTF-8 字节计，超限拒绝）
// - 离线排队：v1 由 transport 层 pending 语义承担（内存队列在桥接层）；
//   IdentityMap.resolve 缺 sessionId = 离线信号（调用方判定排队）
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** tapeFragment 大小上限（spec §8：默认 4KB）。 */
export const MAX_TAPE_FRAGMENT_BYTES = 4096;

export interface CommsMessage {
  msgId: string;
  from: string;
  to: string;
  tapeFragment: string;
  type?: string;
  timestamp: number;
}

export interface CommsTransport {
  send(msg: CommsMessage): void;
  onReceive(cb: (msg: CommsMessage) => void): void;
  activePeers(): string[];              // presence
}

export interface CommsIdentity {
  agentId: string;
  tenantId: string;
  sessionId: string;
}

/** dedup 记录（spec R4：{msgId, watermark}）。 */
interface DedupRecord {
  msgId: string;
  watermark: number;
}

export class CommsChannel {
  private transport: CommsTransport;
  private identity: CommsIdentity;
  /** 去重持久化目录（可选：缺省 = 纯内存去重，不落盘——brief 二参构造兼容）。 */
  private dir?: string;
  /** 去重表（msgId → 记录；接收 agent 全局）。 */
  private dedup = new Map<string, DedupRecord>();
  /** 当前 checkpoint 水位（打点基准；默认 0，pruneDedup 推进）。 */
  private currentWatermark = 0;
  /** 纸带注入回调（调用方注册；Task 12 挂到 WorkLoopSDK）。 */
  private injectors: Array<(msg: CommsMessage) => void> = [];

  constructor(transport: CommsTransport, identity: CommsIdentity, dir?: string) {
    this.transport = transport;
    this.identity = identity;
    this.dir = dir;
    if (dir !== undefined) this.loadDedup(dir);
    transport.onReceive((m) => this.onMessage(m));
  }

  private dedupPath(): string {
    return join(this.dir!, "dedup.jsonl");
  }

  /** 重启加载：构造时恢复 dedup.jsonl（损坏行跳过——崩溃尾部，新记录继续追加）。 */
  private loadDedup(dir: string): void {
    const filePath = join(dir, "dedup.jsonl");
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as DedupRecord;
        if (typeof rec?.msgId === "string" && typeof rec?.watermark === "number") {
          this.dedup.set(rec.msgId, rec);
        }
      } catch {
        // 损坏行跳过（append-only 日志语义；不阻塞启动）
      }
    }
  }

  /** 记录 msgId（打点当前水位）；dir 存在时 append-only 追加 dedup.jsonl。 */
  private record(msgId: string): void {
    const rec: DedupRecord = { msgId, watermark: this.currentWatermark };
    this.dedup.set(msgId, rec);
    if (this.dir !== undefined) {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.dedupPath(), JSON.stringify(rec) + "\n");
    }
  }

  /** prune 后原子重写 dedup.jsonl（tmp+rename；按 msgId 排序保证确定性）。 */
  private persistDedup(): void {
    const filePath = this.dedupPath();
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const lines = [...this.dedup.values()]
      .sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0))
      .map((r) => JSON.stringify(r))
      .join("\n");
    writeFileSync(tmpPath, lines.length > 0 ? lines + "\n" : "");
    renameSync(tmpPath, filePath);
  }

  /**
   * 发送：msgId = randomUUID；fragment ≤ 4096 字节（UTF-8 字节计，超限拒绝）。
   * 自我打点先于 transport.send——传输回环/广播不把自己注入纸带。
   */
  send(to: string, tapeFragment: string, type?: string): CommsMessage {
    const bytes = new TextEncoder().encode(tapeFragment).length;
    if (bytes > MAX_TAPE_FRAGMENT_BYTES) {
      throw new Error(`tapeFragment exceeds ${MAX_TAPE_FRAGMENT_BYTES} bytes (got ${bytes})`);
    }
    const msg: CommsMessage = {
      msgId: randomUUID(),
      from: this.identity.agentId,
      to,
      tapeFragment,
      timestamp: Date.now(),
      ...(type !== undefined ? { type } : {}),
    };
    this.record(msg.msgId);
    this.transport.send(msg);
    return msg;
  }

  /** 接收：路由兜底（只处理给自己的）→ msgId 去重（接收 agent 全局）→ 纸带注入回调。 */
  private onMessage(msg: CommsMessage): void {
    if (msg.to !== this.identity.agentId) return;   // 非本人消息（transport 路由兜底）
    if (this.isDuplicate(msg.msgId)) return;        // 重复投递 → 去重（幂等）
    this.record(msg.msgId);
    for (const cb of this.injectors) cb(msg);       // 注入点：调用方追加进纸带
  }

  /** 注入点注册：调用方把 tapeFragment 作为 user 消息追加进纸带（Task 12 挂 WorkLoopSDK）。 */
  onTapeInjection(cb: (msg: CommsMessage) => void): void {
    this.injectors.push(cb);
  }

  isDuplicate(msgId: string): boolean {
    return this.dedup.has(msgId);
  }

  /**
   * 随 checkpoint 水位修剪去重表（R4）：resume 到 S 时丢弃 watermark > S 的记录
   * （这些消息在旧时间线"已投递但未在 S 之后处理"——允许重复投递，防幽灵拒收）；
   * 同时把打点水位推进到 S（之后收到的消息以 S 为基准打点）。调用方：Task 12（resume 时）。
   */
  pruneDedup(seq: number): void {
    this.currentWatermark = Math.max(this.currentWatermark, seq);
    for (const [id, rec] of this.dedup) {
      if (rec.watermark > seq) this.dedup.delete(id);
    }
    if (this.dir !== undefined) this.persistDedup();
  }
}

export interface IdentityRecord {
  tenantId: string;
  sessionId?: string;
}

/**
 * 身份映射（agentId → {tenantId, sessionId?}）：dir/identity.json 持久化（tmp+rename 原子写）。
 * sessionId 易失（会话级）——refreshSession 刷新；resolve 缺 sessionId = 离线
 * （排队语义由调用方判定：transport 层 pending，v1 内存队列）。
 */
export class IdentityMap {
  private dir: string;
  private map: Record<string, IdentityRecord> = {};

  constructor(dir: string) {
    this.dir = dir;
    this.map = this.load();
  }

  private identityPath(): string {
    return join(this.dir, "identity.json");
  }

  /** 重启加载 identity.json；损坏 → 视为空（不阻塞；下次 set 原子重写）。 */
  private load(): Record<string, IdentityRecord> {
    if (!existsSync(this.identityPath())) return {};
    try {
      return JSON.parse(readFileSync(this.identityPath(), "utf-8")) as Record<string, IdentityRecord>;
    } catch {
      return {};
    }
  }

  private persist(): void {
    const filePath = this.identityPath();
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.map, null, 2));
    renameSync(tmpPath, filePath);
  }

  set(agentId: string, tenantId: string, sessionId: string): void {
    this.map[agentId] = { tenantId, sessionId };
    this.persist();
  }

  /** 返回副本（外部改动不影响内存态；落盘仍经 set/refreshSession）。 */
  resolve(agentId: string): { tenantId: string; sessionId?: string } | undefined {
    const rec = this.map[agentId];
    if (!rec) return undefined;
    return { tenantId: rec.tenantId, ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}) };
  }

  /** 刷新易失 sessionId；未映射 agent → no-op（不发明映射）。 */
  refreshSession(agentId: string, sessionId: string): void {
    const rec = this.map[agentId];
    if (!rec) return;
    rec.sessionId = sessionId;
    this.persist();
  }
}
