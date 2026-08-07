import { getRandomValues } from "node:crypto";

/** UUIDv7（时间有序，与 pi 官方 createSessionId 一致）。node 无原生 v7，自实现。 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  const rnd = getRandomValues(new Uint8Array(10));
  bytes[6] = (rnd[0]! & 0x0f) | 0x70; // version 7（byte6 高半字节）
  bytes[7] = rnd[1]!;
  bytes[8] = (rnd[2]! & 0x3f) | 0x80; // variant 10（byte8 高半字节）
  bytes[9] = rnd[3]!;
  bytes[10] = rnd[4]!;
  bytes[11] = rnd[5]!;
  bytes[12] = rnd[6]!;
  bytes[13] = rnd[7]!;
  bytes[14] = rnd[8]!;
  bytes[15] = rnd[9]!;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
