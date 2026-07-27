import React from "react";
import { Box, Text } from "ink";
import { MessageBubble } from "./message-bubble.js";
import { theme } from "../theme.js";
import type { TuiMessage } from "../types.js";

interface ChatAreaProps {
  /** All completed messages */
  messages: TuiMessage[];
  /** Current streaming message (dynamic, ≤30fps refresh) */
  streamingMessage: TuiMessage | null;
  showThinking: boolean;
  /** Available rows for the chat viewport (computed by App) */
  height: number;
}

/**
 * Chat area with simple viewport.
 *
 * Instead of <Static> (which renders to terminal scrollback above all
 * dynamic content and breaks two-column layout), we keep everything in
 * the Ink dynamic area. Only the last ~N messages that fit in `height`
 * are shown.
 */
export function ChatArea({
  messages,
  streamingMessage,
  showThinking,
  height,
}: ChatAreaProps) {
  // Build the visible list: completed messages + optional streaming message.
  // Estimate each message at ~3 lines (content + padding).
  // Messages near the end have priority — slice from the tail.
  const ESTIMATED_MSG_HEIGHT = 3;
  const streamingOverhead = streamingMessage ? 2 : 0; // content line + cursor
  const maxVisible = Math.max(
    3,
    Math.floor((height - streamingOverhead) / ESTIMATED_MSG_HEIGHT),
  );

  // If too many messages, only show the last maxVisible.
  const visibleMessages =
    messages.length > maxVisible
      ? messages.slice(-maxVisible)
      : messages;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleMessages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          showThinking={showThinking}
        />
      ))}

      {/* Streaming message: plain text during streaming (final
          markdown rendering happens when it moves to completed). */}
      {streamingMessage && (
        <Box flexDirection="column">
          {streamingMessage.thinking && showThinking && (
            <Text italic dimColor>
              {theme.icons.thinking} {streamingMessage.thinking}
            </Text>
          )}
          <Text>{streamingMessage.content}</Text>
          <Text color={theme.colors.primary}>▌</Text>
        </Box>
      )}
    </Box>
  );
}
