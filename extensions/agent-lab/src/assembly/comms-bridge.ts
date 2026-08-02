// CommsBridge —— comms 桥接（spec §4 契约⑥⑨⑩ / plan Task 9）。
//
// 职责：
// 1. 收件缓冲（契约⑥）：inboxDir/inbox.jsonl（持久化、容量默认 100、溢出 drop-oldest）；
//    条目格式 {msgId, from, to, tapeFragment, type?, timestamp, mergedAtSeq?}——
//    mergedAtSeq 缺省 = 未并入
// 2. drainInto(seq)：未并入条目 → 标记 mergedAtSeq=seq → 返回（调用方并入纸带/
//    任务文本前缀拼接）；resume 重并入"已并入未 ack"条目按 msgId 去重（防重复注入）
// 3. ack(seq)：mergedAtSeq ≤ seq 的条目删除（compact，tmp+rename 原子重写）——
//    checkpoint seq ≥ mergedAtSeq 落盘后才删（防 resume 回滚后消息丢失）；
//    未并入条目永不删除（无 mergedAtSeq）
// 4. 身份权威（契约⑨）：registerIdentity（装配时 IdentityMap.set——IdentityMap 为
//    权威源，落盘 identity.json）+ registerSessionRefresh（session_start 刷新回调
//    注册，返回反注册）+ refreshSession（刷新触发：IdentityMap 刷新 + 回调通知）
//
// 去重裁决（对 brief"复用 CommsChannel.isDuplicate 或桥接内 Set——以可测为准"的落实）：
// 双源 OR —— 桥接内 Set（本实例已并入的 msgId；重启丢失）∪ channel.isDuplicate
// （通道去重表已记录——R4 语义：pruneDedup(S) 丢弃 watermark > S 的记录 → 允许重复
// 投递，未 ack 条目可重并入；保留的记录 = 已投递 → 跳过，防重复注入）。
// 未并入条目（mergedAtSeq 未定）不受通道去重门控——"入队即保证最终并入"（崩溃窗口
// 内已收未并的消息不丢）；仅本实例 Set 命中的重复副本（同 msgId 双入队）被消费
// （标记 mergedAtSeq 不返回——上游去重失效兜底，防重复注入且不滞留）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommsChannel, CommsMessage, IdentityMap } from "../memory/comms.ts";

/** inbox 文件名（spec §4 契约⑥：comms-inbox.jsonl，收件缓冲）。 */
export const INBOX_FILE = "inbox.jsonl";

/** 落盘条目 = CommsMessage + mergedAtSeq（缺省 = 未并入）。 */
interface InboxEntry extends CommsMessage {
  mergedAtSeq?: number;
}

export class CommsBridge {
  private readonly inboxPath: string;
  private readonly channel: CommsChannel;
  private readonly identityMap: IdentityMap;
  private readonly capacity: number;
  /** 本实例已并入纸带的 msgId（去重源 1；重启丢失 → 通道去重表兜底）。 */
  private mergedMsgIds = new Set<string>();
  /** session_start 刷新回调（契约⑨）。 */
  private sessionRefreshCbs: Array<(agentId: string, sessionId: string) => void> = [];

  constructor(deps: { inboxDir: string; channel: CommsChannel; identityMap: IdentityMap; capacity?: number }) {
    this.inboxPath = join(deps.inboxDir, INBOX_FILE);
    this.channel = deps.channel;
    this.identityMap = deps.identityMap;
    this.capacity = deps.capacity ?? 100; // 默认 100（spec 契约⑥）
    if (this.capacity < 1) {
      throw new Error(`comms inbox capacity must be >= 1 (got ${this.capacity})`);
    }
  }

  /** 入 inbox（inbox.jsonl 追加）；溢出 drop-oldest（保留最新 capacity 条）。 */
  enqueue(msg: CommsMessage): void {
    mkdirSync(dirname(this.inboxPath), { recursive: true });
    appendFileSync(this.inboxPath, JSON.stringify(msg) + "\n");
    if (this.readAll().length > this.capacity) {
      const entries = this.readAll();
      this.rewrite(entries.slice(entries.length - this.capacity));
    }
  }

  /**
   * 取未并入条目（mergedAtSeq 未定）→ 标记 mergedAtSeq=seq → 返回（调用方并入纸带）；
   * resume 重并入"已并入未 ack"条目（去重双源均未命中 → 当前时间线未含）→ 更新
   * mergedAtSeq=seq 并返回；去重命中的已并入条目跳过（不重复注入）。
   */
  drainInto(seq: number): CommsMessage[] {
    const entries = this.readAll();
    let changed = false;
    const merged: CommsMessage[] = [];
    for (const entry of entries) {
      const inSet = this.mergedMsgIds.has(entry.msgId);
      if (entry.mergedAtSeq === undefined) {
        if (inSet) {
          // 本实例已并入的同 msgId 重复副本（双入队兜底）→ 消费（标记）不注入
          entry.mergedAtSeq = seq;
          changed = true;
        } else {
          // 正常未并入 → 并入
          entry.mergedAtSeq = seq;
          this.mergedMsgIds.add(entry.msgId);
          changed = true;
          merged.push(this.toMessage(entry));
        }
      } else if (!inSet && !this.channel.isDuplicate(entry.msgId)) {
        // resume 重并入未 ack（Set 与通道去重均未命中 → 不在当前时间线）→ 重新并入
        entry.mergedAtSeq = seq;
        this.mergedMsgIds.add(entry.msgId);
        changed = true;
        merged.push(this.toMessage(entry));
      }
      // 其余：已并入未 ack 且去重命中 → 跳过（防重复注入，等 ack 清理）
    }
    if (changed) this.rewrite(entries);
    return merged;
  }

  /** checkpoint seq ≥ mergedAtSeq → 删除（compact inbox.jsonl，tmp+rename 原子）。 */
  ack(seq: number): void {
    if (!existsSync(this.inboxPath)) return;
    const entries = this.readAll();
    const kept = entries.filter((e) => !(typeof e.mergedAtSeq === "number" && e.mergedAtSeq <= seq));
    if (kept.length !== entries.length) this.rewrite(kept);
  }

  /** 未 ack 条目数（= inbox 现存条目；ack 已删/溢出已丢不计）。 */
  pending(): number {
    if (!existsSync(this.inboxPath)) return 0;
    return this.readAll().length;
  }

  /** 契约⑨：装配时注册身份（IdentityMap = 权威源，落盘 identity.json）。 */
  registerIdentity(agentId: string, tenantId: string, sessionId: string): void {
    this.identityMap.set(agentId, tenantId, sessionId);
  }

  /** 契约⑨：session_start 刷新回调注册（返回反注册；pit-communicate session_start 时接线）。 */
  registerSessionRefresh(cb: (agentId: string, sessionId: string) => void): () => void {
    this.sessionRefreshCbs.push(cb);
    return () => {
      this.sessionRefreshCbs = this.sessionRefreshCbs.filter((c) => c !== cb);
    };
  }

  /** 契约⑨：session_start 触发刷新——IdentityMap 刷新 + 回调通知；未映射 agent → no-op。 */
  refreshSession(agentId: string, sessionId: string): void {
    if (this.identityMap.resolve(agentId) === undefined) return;
    this.identityMap.refreshSession(agentId, sessionId);
    for (const cb of this.sessionRefreshCbs) cb(agentId, sessionId);
  }

  // ---- 内部 ----

  /** 读全量条目（损坏行跳过——append-only 日志语义；重写时自然清理）。 */
  private readAll(): InboxEntry[] {
    if (!existsSync(this.inboxPath)) return [];
    const entries: InboxEntry[] = [];
    for (const line of readFileSync(this.inboxPath, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const e = JSON.parse(line) as InboxEntry;
        if (
          typeof e?.msgId === "string" &&
          typeof e?.from === "string" &&
          typeof e?.to === "string" &&
          typeof e?.tapeFragment === "string" &&
          typeof e?.timestamp === "number"
        ) {
          entries.push(e);
        }
      } catch {
        // 损坏行跳过（崩溃尾部；不阻塞）
      }
    }
    return entries;
  }

  /** tmp+rename 原子重写（对齐 dedup.jsonl 先例）。 */
  private rewrite(entries: InboxEntry[]): void {
    mkdirSync(dirname(this.inboxPath), { recursive: true });
    const tmpPath = `${this.inboxPath}.tmp`;
    const lines = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(tmpPath, lines.length > 0 ? lines + "\n" : "");
    renameSync(tmpPath, this.inboxPath);
  }

  /** 返回 CommsMessage（剥离内部字段 mergedAtSeq；type 透传保留）。 */
  private toMessage(entry: InboxEntry): CommsMessage {
    return {
      msgId: entry.msgId,
      from: entry.from,
      to: entry.to,
      tapeFragment: entry.tapeFragment,
      timestamp: entry.timestamp,
      ...(entry.type !== undefined ? { type: entry.type } : {}),
    };
  }
}
