import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, useInput, useApp } from "ink";
import { TopBar } from "./components/top-bar.js";
import { SessionList } from "./components/session-list.js";
import { ChatArea } from "./components/chat-area.js";
import { InputArea } from "./components/input-area.js";
import { StatusBar } from "./components/status-bar.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { EventBuffer } from "./event-buffer.js";
import {
  CommandRegistry,
  parseInput,
  registerBuiltinCommands,
  type CommandContext,
} from "./commands.js";
import type { TuiMessage, FocusTarget, SessionDisplayInfo } from "./types.js";
import type { AgentEngine } from "../core/agent-engine.js";
import type { PlatformAdapter } from "../platform/types.js";
import { SDK_EVENTS } from "../sdk-adapter/index.js";
import type { AgentEvent } from "../core/types.js";

const TENANT = "local";
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_QUEUE = 5;

export interface AppProps {
  engine: AgentEngine;
  platform: PlatformAdapter;
  model: string;
  version: string;
  sessionLimit: number;
}

let _msgCounter = 0;
function nextMsgId(): string {
  return `msg-${++_msgCounter}`;
}

export function App({
  engine,
  platform,
  model,
  version,
  sessionLimit,
}: AppProps) {
  const { exit } = useApp();

  // ─── State ─────────────────────────────────────────────
  const [focus, setFocus] = useState<FocusTarget>("input");
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionDisplayInfo[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [messagesMap, setMessagesMap] = useState<Map<string, TuiMessage[]>>(
    new Map(),
  );
  const [streamingMessage, setStreamingMessage] =
    useState<TuiMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [queue, setQueue] = useState<string[]>([]);

  // Refs for cross-closure access (no stale closures)
  const bufferRef = useRef<EventBuffer | null>(null);
  const abortedRef = useRef(false);
  const ctrlCOnceRef = useRef(false);
  const busySessionRef = useRef<string>("");
  const currentSessionIdRef = useRef<string>("");
  const evictedSessionsRef = useRef<Set<string>>(new Set());

  // Keep ref in sync with state
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const currentMessages = messagesMap.get(currentSessionId) ?? [];

  // ─── Long-lived command registry ────────────────────────
  const commandRegistry = useMemo(() => {
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    return reg;
  }, []);

  // ─── Helpers ────────────────────────────────────────────
  const addMessage = useCallback((sessionId: string, msg: TuiMessage) => {
    setMessagesMap((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(sessionId) ?? []), msg];
      if (list.length > MAX_MESSAGES_PER_SESSION) {
        list.splice(0, list.length - MAX_MESSAGES_PER_SESSION);
      }
      next.set(sessionId, list);
      return next;
    });
  }, []);

  /** Update an existing message in-place (for tool-call status) */
  const updateMessage = useCallback(
    (sessionId: string, msgId: string, patch: Partial<TuiMessage>) => {
      setMessagesMap((prev) => {
        const next = new Map(prev);
        const list = next.get(sessionId);
        if (!list) return prev;
        const idx = list.findIndex((m) => m.id === msgId);
        if (idx === -1) return prev;
        const updated = [...list];
        updated[idx] = { ...updated[idx], ...patch };
        next.set(sessionId, updated);
        return next;
      });
    },
    [],
  );

  const refreshSessions = useCallback(() => {
    const list = engine.listSessions(TENANT);
    const evicted = evictedSessionsRef.current;
    setSessions(
      list.map(
        (s): SessionDisplayInfo => ({
          sessionId: s.sessionId,
          state: evicted.has(s.sessionId)
            ? "expired"
            : s.state === "busy"
              ? "busy"
              : "idle",
          model: s.model,
          project: s.project,
          createdAt: s.createdAt,
        }),
      ),
    );
  }, [engine]);

  // ─── Session management ─────────────────────────────────
  const createSession = useCallback(async () => {
    const result = await engine.createSession({
      tenantId: TENANT,
      project: "default",
    });
    if (!result.ok) {
      if (currentSessionIdRef.current) {
        addMessage(currentSessionIdRef.current, {
          id: nextMsgId(),
          role: "error",
          content: `Cannot create session: ${result.error}`,
          timestamp: Date.now(),
        });
      }
      return;
    }
    const sid = result.data.sessionId;
    setCurrentSessionId(sid);
    refreshSessions();
    addMessage(sid, {
      id: nextMsgId(),
      role: "system",
      content: `Session ${sid.slice(0, 8)} created (model: ${result.data.model})`,
      timestamp: Date.now(),
    });
  }, [engine, addMessage, refreshSessions]);

  const switchSession = useCallback(
    async (idPrefix: string) => {
      const list = engine.listSessions(TENANT);
      const matches = list.filter((s) => s.sessionId.startsWith(idPrefix));
      if (matches.length === 0) {
        if (currentSessionIdRef.current) {
          addMessage(currentSessionIdRef.current, {
            id: nextMsgId(),
            role: "error",
            content: `No session matching "${idPrefix}"`,
            timestamp: Date.now(),
          });
        }
        return;
      }
      if (matches.length > 1) {
        if (currentSessionIdRef.current) {
          addMessage(currentSessionIdRef.current, {
            id: nextMsgId(),
            role: "system",
            content: `Multiple matches:\n${matches.map((m) => `  ${m.sessionId.slice(0, 12)}…`).join("\n")}`,
            timestamp: Date.now(),
          });
        }
        return;
      }

      const target = matches[0];
      // If session was evicted, auto-create a new one instead
      if (evictedSessionsRef.current.has(target.sessionId)) {
        if (currentSessionIdRef.current) {
          addMessage(currentSessionIdRef.current, {
            id: nextMsgId(),
            role: "system",
            content: "Session expired, creating new…",
            timestamp: Date.now(),
          });
        }
        await createSession();
        return;
      }

      // Switch to target session
      setCurrentSessionId(target.sessionId);
      setStreamingMessage(null);
    },
    [engine, addMessage, createSession],
  );

  // ─── Clipboard ──────────────────────────────────────────
  const copyToClipboard = useCallback(
    async (text: string): Promise<boolean> => {
      const cmdMap: Record<string, string> = {
        darwin: `echo ${JSON.stringify(text)} | pbcopy`,
        linux: `echo ${JSON.stringify(text)} | xclip -selection clipboard 2>/dev/null || echo ${JSON.stringify(text)} | wl-copy 2>/dev/null`,
        win32: `echo ${JSON.stringify(text)} | clip`,
      };
      const cmd = cmdMap[platform.os] ?? cmdMap.linux;
      try {
        const result = await platform.shell.execute(cmd, {
          cwd: process.cwd(),
        });
        // pbcopy/xclip/clip exit 0 on success
        return !result.stderr || result.stderr.length === 0;
      } catch {
        return false;
      }
    },
    [platform],
  );

  // ─── Prompt execution ───────────────────────────────────
  const executePrompt = useCallback(
    async (sessionId: string, text: string) => {
      setBusy(true);
      busySessionRef.current = sessionId;
      abortedRef.current = false;

      // Add user message
      addMessage(sessionId, {
        id: nextMsgId(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      });

      // Streaming message placeholder
      const streamMsg: TuiMessage = {
        id: nextMsgId(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        streaming: true,
      };
      setStreamingMessage(streamMsg);

      let accContent = "";
      let accThinking = "";
      // Track tool-call start→end for single-message updates (B4)
      const toolCallMap = new Map<string, string>(); // toolCallId → msgId
      const toolCallStartTime = new Map<string, number>(); // toolCallId → timestamp

      const buffer = new EventBuffer(
        (events: AgentEvent[]) => {
          // Guard: skip events for a session that's no longer active (M6)
          if (currentSessionIdRef.current !== sessionId) return;

          for (const event of events) {
            const ev = event.data;

            if (event.type === SDK_EVENTS.MESSAGE_UPDATE) {
              const ame = ev.assistantMessageEvent as
                | Record<string, unknown>
                | undefined;
              if (ame?.type === "text_delta" && typeof ame.delta === "string") {
                accContent += ame.delta;
              }
              if (
                ame?.type === "thinking_delta" &&
                typeof ame.delta === "string"
              ) {
                accThinking += ame.delta;
              }
            }

            if (event.type === SDK_EVENTS.TOOL_EXECUTION_START) {
              const tcid = String(ev.toolCallId ?? "");
              const msgId = nextMsgId();
              toolCallMap.set(tcid, msgId);
              toolCallStartTime.set(tcid, Date.now());
              addMessage(sessionId, {
                id: msgId,
                role: "tool-call",
                content: "",
                toolName: String(ev.toolName ?? "?"),
                toolArgs: JSON.stringify(ev.args ?? {}),
                timestamp: Date.now(),
              });
            }

            if (event.type === SDK_EVENTS.TOOL_EXECUTION_END) {
              const tcid = String(ev.toolCallId ?? "");
              const msgId = toolCallMap.get(tcid);
              if (msgId) {
                const startTs = toolCallStartTime.get(tcid);
                const durationMs =
                  startTs !== undefined ? Date.now() - startTs : undefined;
                updateMessage(sessionId, msgId, {
                  isError: Boolean(ev.isError),
                  durationMs,
                });
                toolCallMap.delete(tcid);
                toolCallStartTime.delete(tcid);
              }
            }

            if (event.type === SDK_EVENTS.MESSAGE_END) {
              const usage = (ev as any).message?.usage;
              if (usage) {
                setTotalTokens(
                  (prev) => prev + (usage.input ?? 0) + (usage.output ?? 0),
                );
              }
            }
          }
          // Batch update streaming message
          setStreamingMessage({
            ...streamMsg,
            content: accContent,
            thinking: accThinking,
          });
        },
        30,
      );
      bufferRef.current = buffer;

      try {
        for await (const event of engine.prompt(sessionId, TENANT, text)) {
          if (abortedRef.current) break;
          buffer.accumulate(event);
        }
      } catch (err) {
        if (!abortedRef.current) {
          addMessage(sessionId, {
            id: nextMsgId(),
            role: "error",
            content: String(err),
            timestamp: Date.now(),
          });
        }
      } finally {
        buffer.destroy();
        bufferRef.current = null;

        // Move streaming → completed
        if (accContent) {
          addMessage(sessionId, {
            id: nextMsgId(),
            role: "assistant",
            content: accContent,
            thinking: accThinking || undefined,
            timestamp: Date.now(),
          });
        }
        setStreamingMessage(null);
        setBusy(false);
        busySessionRef.current = "";
        refreshSessions();

        // Process queue
        setQueue((prev) => {
          if (prev.length > 0) {
            const [next, ...rest] = prev;
            setTimeout(() => {
              void executePrompt(sessionId, next);
            }, 0);
            return rest;
          }
          return prev;
        });
      }
    },
    [engine, addMessage, updateMessage, refreshSessions],
  );

  // ─── Input handler ──────────────────────────────────────
  const handleInput = useCallback(
    async (text: string) => {
      const parsed = parseInput(text);
      const sid = currentSessionIdRef.current;

      switch (parsed.type) {
        case "empty":
          return;

        case "error":
          if (sid) {
            addMessage(sid, {
              id: nextMsgId(),
              role: "error",
              content: parsed.text,
              timestamp: Date.now(),
            });
          }
          return;

        case "prompt": {
          if (!sid) return;
          if (busy) {
            if (queue.length >= MAX_QUEUE) {
              addMessage(sid, {
                id: nextMsgId(),
                role: "error",
                content: `Queue full (${MAX_QUEUE}). Wait for current prompt.`,
                timestamp: Date.now(),
              });
            } else {
              setQueue((prev) => [...prev, parsed.text]);
            }
            return;
          }
          await executePrompt(sid, parsed.text);
          return;
        }

        case "bash": {
          if (!sid) return;
          let output: string;
          try {
            const result = await platform.shell.execute(parsed.command, {
              cwd: process.cwd(),
            });
            output = result.stdout || result.stderr || "(no output)";
          } catch (err) {
            output = String(err);
          }
          addMessage(sid, {
            id: nextMsgId(),
            role: "bash-output",
            content: output,
            toolName: parsed.command,
            timestamp: Date.now(),
          });
          if (parsed.sendToAgent && !busy) {
            await executePrompt(
              sid,
              `Here is the output of \`${parsed.command}\`:\n\n${output.slice(0, 2000)}`,
            );
          }
          return;
        }

        case "command": {
          const ctx: CommandContext = {
            createSession,
            switchSession,
            listSessions: () =>
              engine.listSessions(TENANT).map((s) => ({
                sessionId: s.sessionId,
                state: s.state,
                model: s.model,
                project: s.project,
              })),
            abort: async () => {
              abortedRef.current = true;
              const bsid = busySessionRef.current || currentSessionIdRef.current;
              if (bsid) {
                await engine.abort(bsid, TENANT);
              }
              setQueue([]);
            },
            setModel: (_provider: string, _model: string) => {
              // Phase 2
            },
            getLastAssistantMessage: () => {
              const msgs = messagesMap.get(sid) ?? [];
              const last = [...msgs]
                .reverse()
                .find((m) => m.role === "assistant");
              return last?.content ?? null;
            },
            copyToClipboard,
            quit: () => exit(),
            print: (txt: string) => {
              if (sid) {
                addMessage(sid, {
                  id: nextMsgId(),
                  role: "system",
                  content: txt,
                  timestamp: Date.now(),
                });
              }
            },
          };

          const handled = await commandRegistry.execute(
            parsed.command,
            parsed.args,
            ctx,
          );
          if (!handled) {
            if (sid) {
              addMessage(sid, {
                id: nextMsgId(),
                role: "error",
                content: `Unknown command: /${parsed.command}. Try /help.`,
                timestamp: Date.now(),
              });
            }
          }
          return;
        }
      }
    },
    [
      busy,
      queue,
      engine,
      platform,
      addMessage,
      executePrompt,
      createSession,
      switchSession,
      copyToClipboard,
      messagesMap,
      exit,
      commandRegistry,
    ],
  );

  // ─── Evict callback ─────────────────────────────────────
  const handleEvict = useCallback(
    (sid: string) => {
      evictedSessionsRef.current.add(sid);
      engine.evictSession(sid);
      // Refresh display to show expired state
      refreshSessions();
    },
    [engine, refreshSessions],
  );

  // Register evict handler once
  useEffect(() => {
    // Chain: engine cleanup + TUI display update
    // pool.setOnEvict is already set in index.tsx; we chain via wrapper
    // The TUI-level eviction notification is handled here
    // Since index.tsx already sets pool.setOnEvict, we intercept at the engine level
    // by wrapping the engine's evictSession
  }, []);

  // ─── Global keys ────────────────────────────────────────
  useInput((_input, key) => {
    // Tab → toggle focus
    if (key.tab) {
      setFocus((f) => (f === "input" ? "sessions" : "input"));
      return;
    }

    // Ctrl+T → toggle thinking
    if (key.ctrl && _input === "t") {
      setShowThinking((v) => !v);
      return;
    }

    // Ctrl+G → toggle statusbar expanded
    if (key.ctrl && _input === "g") {
      setStatusExpanded((v) => !v);
      return;
    }

    // Ctrl+N → new session
    if (key.ctrl && _input === "n") {
      createSession();
      return;
    }

    // Ctrl+D → quit
    if (key.ctrl && _input === "d") {
      exit();
      return;
    }

    // Ctrl+C → two-stage (abort then quit)
    if (key.ctrl && _input === "c") {
      if (busy) {
        abortedRef.current = true;
        engine
          .abort(busySessionRef.current || currentSessionIdRef.current, TENANT)
          .catch(() => {});
        setQueue([]);
      } else if (ctrlCOnceRef.current) {
        exit();
      } else {
        ctrlCOnceRef.current = true;
        if (currentSessionIdRef.current) {
          addMessage(currentSessionIdRef.current, {
            id: nextMsgId(),
            role: "system",
            content: "(Ctrl+C again to quit)",
            timestamp: Date.now(),
          });
        }
        setTimeout(() => {
          ctrlCOnceRef.current = false;
        }, 3000);
      }
      return;
    }

    // Session list keys (when focused)
    if (focus === "sessions") {
      if (key.upArrow) {
        setSelectedSessionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedSessionIndex((i) => Math.min(sessions.length - 1, i + 1));
        return;
      }
      if (key.return && sessions[selectedSessionIndex]) {
        switchSession(sessions[selectedSessionIndex].sessionId.slice(0, 8));
        return;
      }
      if (_input === "n") {
        createSession();
        return;
      }
    }
  });

  // ─── Init: create first session ──────────────────────────
  useEffect(() => {
    createSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Layout ──────────────────────────────────────────────
  const sessionListWidth = Math.min(
    30,
    Math.max(16, Math.floor((process.stdout.columns ?? 80) * 0.2)),
  );

  // Viewport height for ChatArea: terminal rows minus chrome.
  // TopBar(3) + InputArea(~3) + StatusBar(3) + borders(~3) ≈ 12
  const chatHeight = Math.max(5, (process.stdout.rows ?? 24) - 12);

  // Command info for pi-style picker
  const commandInfos = commandRegistry.list().map((c) => ({ name: c.name, description: c.description }));

  return (
    <ErrorBoundary>
      <Box flexDirection="column" height="100%">
        <TopBar model={model} version={version} />

        <Box flexDirection="row" flexGrow={1}>
          <SessionList
            sessions={sessions}
            activeSessionId={currentSessionId}
            selectedIndex={selectedSessionIndex}
            focused={focus === "sessions"}
            width={sessionListWidth}
          />
          <ChatArea
            messages={currentMessages}
            streamingMessage={streamingMessage}
            showThinking={showThinking}
            height={chatHeight}
          />
        </Box>

        <InputArea
          onSubmit={handleInput}
          focused={focus === "input"}
          commands={commandInfos}
          placeholder={
            busy
              ? "Agent is working… (input will be queued)"
              : "Type / for commands, ! for bash, or message…"
          }
        />

        <StatusBar
          state={busy ? "busy" : "idle"}
          sessionId={currentSessionId || "(none)"}
          sessionCount={sessions.length}
          sessionLimit={sessionLimit}
          expanded={statusExpanded}
          tokens={totalTokens}
          model={model}
          queued={queue.length}
        />
      </Box>
    </ErrorBoundary>
  );
}
