/**
 * 公共测试 fixture——底层原子 helper（plan Task 6）。
 *
 * 收敛各测试私有 fresh() 里的 mkdtempSync/tmpdir/rmSync/DatabaseSync 样板
 *（审计发现 ≥18 处各自造轮子）。**不统一 fresh() 签名**——各测试返回结构
 * 不同（store/ledger/…），仅共享这三个最小公共原子，fresh() 在内部组合。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 创建一次性临时目录。
 *
 * @param prefix 目录名前缀（自动拼接随机后缀，例：tmpDir("mem-store-")
 *   → `${tmpdir()}/mem-store-XXXXXX`）
 * @returns `{ dir, cleanup }`——`dir` 为实际目录；`cleanup()` 幂等递归删除
 *   （`rmSync(dir, { recursive: true, force: true })`）。
 */
export function tmpDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 创建内存数据库（`:memory:`）——无需文件清理，close 后自动释放。
 * 适用纯逻辑测试（economy-escrow 等无持久化断言的文件型独立测试）。
 */
export function freshDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

/**
 * 在指定目录下创建文件数据库（默认文件名 `ledger.db`）。
 *
 * @param dir 已存在的目录（通常来自 `tmpDir()`）
 * @param name 数据库文件名（默认 `"ledger.db"`）
 * @returns 以 `dir/name` 为路径的 DatabaseSync 实例；由调用方负责 close，
 *   目录清理交由 tmpDir 返回的 `cleanup()`。
 */
export function tmpDbFile(dir: string, name = "ledger.db"): DatabaseSync {
  return new DatabaseSync(path.join(dir, name));
}
