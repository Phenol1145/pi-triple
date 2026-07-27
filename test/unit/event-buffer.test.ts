// test/unit/event-buffer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBuffer } from "../../src/tui/event-buffer.js";

describe("EventBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("accumulates events and flushes on interval", () => {
    const flushed: any[][] = [];
    const buf = new EventBuffer((batch) => flushed.push(batch), 30);

    buf.accumulate({ seq: 1, type: "a", data: {}, timestamp: "" });
    buf.accumulate({ seq: 2, type: "b", data: {}, timestamp: "" });
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(34);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);

    buf.destroy();
  });

  it("does not flush when empty", () => {
    const flushed: any[][] = [];
    const buf = new EventBuffer((batch) => flushed.push(batch), 30);
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(0);
    buf.destroy();
  });

  it("destroy flushes remaining pending events", () => {
    const flushed: any[][] = [];
    const buf = new EventBuffer((batch) => flushed.push(batch), 30);
    buf.accumulate({ seq: 1, type: "x", data: {}, timestamp: "" });
    buf.destroy();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(1);
  });

  it("does not flush after destroy", () => {
    const flushed: any[][] = [];
    const buf = new EventBuffer((batch) => flushed.push(batch), 30);
    buf.destroy();
    buf.accumulate({ seq: 1, type: "x", data: {}, timestamp: "" });
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(0); // destroy already flushed empty, this accumulate is post-destroy
  });
});
