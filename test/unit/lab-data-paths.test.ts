// test/unit/lab-data-paths.test.ts — phase 0 Task 2: pit lab-data path resolution
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const KEYS = ["AGENT_LAB_DB_PATH", "AGENT_LAB_CONFIG_DIR", "PI_TRIPLE_HOME", "DATA_DIR", "PI_TENANT"];
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: [string, string | undefined][] = KEYS.map((k) => [k, process.env[k]] as const);
  KEYS.forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; });
  try {
    fn();
  } finally {
    saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
}
// open-db reads env at call time (not import time), so a plain import is fine
import { sharedDbPath, localDbPath } from "../../src/ptl/lab-data/open-db.js";

describe("lab-data path resolution", () => {
  it("sharedDbPath: AGENT_LAB_DB_PATH 优先", () =>
    withEnv({ AGENT_LAB_DB_PATH: "/x/db" }, () => expect(sharedDbPath()).toBe("/x/db")));

  it("sharedDbPath: 默认 pitHome/data/shared（非 ./.pi-platform-data）", () =>
    withEnv({ PI_TRIPLE_HOME: "/ph" }, () =>
      expect(sharedDbPath()).toBe(join("/ph", "data", "shared", "agent-lab", "agent-lab.db"))));

  it("sharedDbPath: 无 PI_TRIPLE_HOME → ~/.pi-triple/data/shared", () =>
    withEnv({}, () =>
      expect(sharedDbPath()).toBe(join(HOME, ".pi-triple", "data", "shared", "agent-lab", "agent-lab.db"))));

  it("localDbPath: AGENT_LAB_CONFIG_DIR 优先", () =>
    withEnv({ AGENT_LAB_CONFIG_DIR: "/cfg" }, () =>
      expect(localDbPath("t1")).toBe(join("/cfg", "agent-lab.db"))));

  it("localDbPath: 默认 pitHome/data/pi-config/<t>/agent-lab", () =>
    withEnv({ PI_TRIPLE_HOME: "/ph" }, () =>
      expect(localDbPath("uuid-9")).toBe(join("/ph", "data", "pi-config", "uuid-9", "agent-lab", "agent-lab.db"))));

  it("不再使用 ./.pi-platform-data 默认", () =>
    withEnv({}, () => {
      expect(sharedDbPath()).not.toContain(".pi-platform-data");
      expect(localDbPath("t")).not.toContain(".pi-platform-data");
    }));
});
