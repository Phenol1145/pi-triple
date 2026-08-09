import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA } from "./schema.ts";

export interface VersionedValue<T = unknown> {
  value: T;
  version: number;
}

export class VersionConflictError extends Error {}

export class NamespacedStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
  }

  get<T = unknown>(namespace: string, key: string): VersionedValue<T> | undefined {
    if (!namespace || !key) throw new Error("namespace and key are required");

    const row = this.db.prepare(
      `SELECT value_json, version FROM lab_namespace_kv WHERE namespace = ? AND key = ?`
    ).get(namespace, key) as { value_json: string; version: number } | undefined;

    if (!row) return undefined;

    return {
      value: JSON.parse(row.value_json) as T,
      version: row.version,
    };
  }

  put<T>(namespace: string, key: string, value: T, expectedVersion: number): VersionedValue<T> {
    if (!namespace || !key) throw new Error("namespace and key are required");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative integer");
    }

    const valueJson = JSON.stringify(value);
    const now = Date.now();

    if (expectedVersion === 0) {
      const result = this.db.prepare(
        `INSERT INTO lab_namespace_kv (namespace, key, value_json, version, updated_ts)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(namespace, key) DO NOTHING`
      ).run(namespace, key, valueJson, now);

      if (result.changes !== 1) {
        throw new VersionConflictError("version conflict: expected 0 but row already exists");
      }

      return { value, version: 1 };
    }

    const result = this.db.prepare(
      `UPDATE lab_namespace_kv
       SET value_json = ?, version = version + 1, updated_ts = ?
       WHERE namespace = ? AND key = ? AND version = ?`
    ).run(valueJson, now, namespace, key, expectedVersion);

    if (result.changes !== 1) {
      throw new VersionConflictError(
        `version conflict: expected ${expectedVersion} but row does not exist or version differs`
      );
    }

    return { value, version: expectedVersion + 1 };
  }

  delete(namespace: string, key: string, expectedVersion: number): void {
    if (!namespace || !key) throw new Error("namespace and key are required");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative integer");
    }

    const result = this.db.prepare(
      `DELETE FROM lab_namespace_kv WHERE namespace = ? AND key = ? AND version = ?`
    ).run(namespace, key, expectedVersion);

    if (result.changes !== 1) {
      throw new VersionConflictError(
        `version conflict: expected ${expectedVersion} but row does not exist or version differs`
      );
    }
  }
}
