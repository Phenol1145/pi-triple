import { describe, it, expect } from "vitest";
import {
  loadConfig,
  startPtlSession,
  emitJson,
  installWarningFilter,
  loadRegistry,
  classifySession,
  checkForUpdates,
  renderTemplateAgents,
} from "@pi-triple/shared";

describe("@pi-triple/shared barrel", () => {
  it("exposes the migrated leaf modules", () => {
    expect(loadConfig).toBeDefined();
    expect(startPtlSession).toBeDefined();
    expect(emitJson).toBeDefined();
    expect(installWarningFilter).toBeDefined();
    expect(loadRegistry).toBeDefined();
    expect(classifySession).toBeDefined();
    expect(checkForUpdates).toBeDefined();
    expect(renderTemplateAgents).toBeDefined();
  });
});
