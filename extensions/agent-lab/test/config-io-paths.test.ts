import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { localConfigDir, sharedDbPath } from "../src/config-io.ts";

const HOME = homedir();
const KEYS = ["AGENT_LAB_CONFIG_DIR", "AGENT_LAB_DB_PATH", "PI_TRIPLE_HOME", "PI_TEMPLATE"];

function clearEnv() {
  for (const k of KEYS) delete (process.env as Record<string,string|undefined>)[k];
}

afterEach(clearEnv);

test("localConfigDir: AGENT_LAB_CONFIG_DIR 最高优先", () => {
  process.env.AGENT_LAB_CONFIG_DIR = "/x/cfg";
  process.env.PI_TEMPLATE = "t1";
  assert.equal(localConfigDir(), "/x/cfg");
});

test("localConfigDir: 有 PI_TEMPLATE → pitHome/data/pi-config/<t>/agent-lab", () => {
  delete process.env.AGENT_LAB_CONFIG_DIR;
  process.env.PI_TEMPLATE = "uuid-1";
  assert.equal(localConfigDir(), join(HOME, ".pi-triple", "data", "pi-config", "uuid-1", "agent-lab"));
});

test("localConfigDir: 裸 pi（无 env）→ ~/.pi/agent/agent-lab", () => {
  assert.equal(localConfigDir(), join(HOME, ".pi", "agent", "agent-lab"));
});

test("sharedDbPath: AGENT_LAB_DB_PATH 最高优先", () => {
  process.env.AGENT_LAB_DB_PATH = "/x/db";
  process.env.PI_TEMPLATE = "t1";
  assert.equal(sharedDbPath(), "/x/db");
});

test("sharedDbPath: 有 PI_TEMPLATE → pitHome/data/shared/agent-lab/agent-lab.db", () => {
  delete process.env.AGENT_LAB_DB_PATH;
  process.env.PI_TEMPLATE = "uuid-1";
  assert.equal(sharedDbPath(), join(HOME, ".pi-triple", "data", "shared", "agent-lab", "agent-lab.db"));
});

test("sharedDbPath: 裸 pi → localConfigDir()/agent-lab.db", () => {
  assert.equal(sharedDbPath(), join(HOME, ".pi", "agent", "agent-lab", "agent-lab.db"));
});
