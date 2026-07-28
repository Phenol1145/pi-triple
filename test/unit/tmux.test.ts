import { describe, it, expect, vi } from "vitest";

// Mock spawnSync to test tmux functions without actual tmux
const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: mockSpawnSync }));

import {
  hasTmux,
  configureTmuxServer,
  tmuxSessionName,
  formatAge,
  listPitSessions,
  sessionsForTenant,
  hasPitSession,
  killPitSession,
  buildTmuxSessionArgs,
  startPitSession,
} from "../../src/tmux.js";

describe("tmux module", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  describe("tmuxSessionName", () => {
    it("prefixes with pit-", () => {
      expect(tmuxSessionName("test")).toBe("pit-test");
    });
  });

  describe("formatAge", () => {
    it("formats minutes", () => {
      expect(formatAge(3 * 60000)).toBe("3m ago");
    });
    it("formats hours", () => {
      expect(formatAge(150 * 60000)).toBe("2h 30m ago");
    });
  });

  describe("hasTmux", () => {
    it("true when tmux -V succeeds", () => {
      mockSpawnSync.mockReturnValue({ status: 0 });
      expect(hasTmux()).toBe(true);
    });
    it("false when tmux -V fails", () => {
      mockSpawnSync.mockReturnValue({ status: 1 });
      expect(hasTmux()).toBe(false);
    });
  });

  describe("hasPitSession", () => {
    it("false when tmux missing", () => {
      mockSpawnSync.mockReturnValue({ status: 1 });
      expect(hasPitSession("test")).toBe(false);
    });
    it("uses exact match =pit-<name>", () => {
      mockSpawnSync.mockReturnValue({ status: 0 });
      hasPitSession("myname");
      const calls = mockSpawnSync.mock.calls;
      const lastCall = calls[calls.length - 1];
      // Second call is has-session (first was hasTmux check)
      expect(lastCall[1]).toContain("=pit-myname");
    });
  });

  describe("sessionsForTenant", () => {
    it("prefix matches pit-<alias>-", () => {
      mockSpawnSync
        .mockReturnValueOnce({ status: 0 }) // hasTmux
        .mockReturnValueOnce({
          status: 0,
          stdout: "pit-local-xsdc\npit-local-a3f3\npit-other-123\nno-prefix\n",
        });
      expect(sessionsForTenant("local")).toEqual(["pit-local-xsdc", "pit-local-a3f3"]);
    });
  });

  describe("listPitSessions", () => {
    it("parses session list", () => {
      const ts = Math.floor(Date.now() / 1000) - 3600;
      mockSpawnSync
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce({
          status: 0,
          stdout: `pit-coder:1:${ts}\npit-reviewer:2:${ts - 60}\nnot-pit:1:${ts}\n`,
        });
      const sessions = listPitSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ name: "coder", windows: 1 });
      expect(sessions[1]).toMatchObject({ name: "reviewer", windows: 2 });
    });
  });

  describe("killPitSession", () => {
    it("kills with exact match", () => {
      mockSpawnSync
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce({ status: 0 });
      killPitSession("test");
      const calls = mockSpawnSync.mock.calls;
      const killCall = calls[calls.length - 1];
      expect(killCall[1][2]).toBe("=pit-test");
    });
  });

  describe("buildTmuxSessionArgs", () => {
    it("injects PI_ and AGENT_LAB_ env vars", () => {
      const launch = {
        cmd: "pi",
        args: ["--print", "hi"],
        env: {
          PI_TENANT: "uuid-123",
          PI_CODING_AGENT_DIR: "/data/config/uuid-123",
          AGENT_LAB_DB_PATH: "/data/shared/agent-lab.db",
          HOME: "/home/user", // should NOT be injected
          PATH: "/usr/bin",
        },
        cwd: "/workspace",
      };
      const args = buildTmuxSessionArgs(launch, "pit-test", true);
      expect(args).toContain("-d");
      expect(args).toContain("-s");
      expect(args).toContain("pit-test");
      expect(args).toContain("--");
      expect(args).toContain("pi");
      // Env vars injected
      expect(args).toContain("-e");
      expect(args).toContain("PI_TENANT=uuid-123");
      expect(args).toContain("PI_CODING_AGENT_DIR=/data/config/uuid-123");
      expect(args).toContain("AGENT_LAB_DB_PATH=/data/shared/agent-lab.db");
      // Non-PI_/AGENT_LAB_ vars NOT injected
      const allStr = args.join(" ");
      expect(allStr).not.toContain("HOME=/home/user");
      expect(allStr).not.toContain("PATH=/usr/bin");
    });
  });

  describe("startPitSession", () => {
    it("passes args to tmux with correct session name", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stderr: "" });
      const launch = { cmd: "pi", args: [], env: { PI_TENANT: "x" }, cwd: "/tmp" };
      const result = startPitSession(launch, "myname", true);
      expect(result.status).toBe(0);
      const calls = mockSpawnSync.mock.calls;
      const tmuxCall = calls[calls.length - 1];
      expect(tmuxCall[1][0]).toBe("new-session");
      expect(tmuxCall[1]).toContain("-s");
      expect(tmuxCall[1]).toContain("pit-myname");
    });
  });

  describe("configureTmuxServer", () => {
    it("skips if already csi-u", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "csi-u\n" });
      configureTmuxServer();
      expect(mockSpawnSync).toHaveBeenCalledTimes(1); // only show
    });
    it("sets options if not csi-u", () => {
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: "xterm\n" })
        .mockReturnValue({ status: 0, stdout: "" });
      configureTmuxServer();
      expect(mockSpawnSync).toHaveBeenCalledTimes(3); // show + set x2
    });
  });
});
