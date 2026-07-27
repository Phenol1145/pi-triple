// src/tui/event-buffer.ts
import type { AgentEvent } from "../core/types.js";

/**
 * Streaming event throttle.
 * Accumulates events from the agent prompt loop and flushes them
 * in batches at a capped frame-rate (default 30fps) to prevent
 * React setState / Ink rendering from overwhelming the event loop.
 *
 * - timer is unref'd so it doesn't keep the process alive.
 * - destroy() flushes any remaining events before clearing the timer.
 * - accumulate() is a no-op after destroy().
 */
export class EventBuffer {
  private pending: AgentEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private onFlush: (events: AgentEvent[]) => void,
    fps = 30,
  ) {
    this.timer = setInterval(() => {
      if (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        this.onFlush(batch);
      }
    }, 1000 / fps);
    this.timer.unref();
  }

  accumulate(event: AgentEvent): void {
    if (this.destroyed) return;
    this.pending.push(event);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      this.onFlush(batch);
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
