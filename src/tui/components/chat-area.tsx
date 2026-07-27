import React from "react";
import { Box, Static, Text } from "ink";
import { MessageBubble } from "./message-bubble.js";
import { theme } from "../theme.js";
import type { TuiMessage } from "../types.js";

interface ChatAreaProps {
  /** Completed messages (rendered in <Static>, terminal-native scrollback) */
  messages: TuiMessage[];
  /** Current streaming message (dynamic area, ≤30fps refresh) */
  streamingMessage: TuiMessage | null;
  showThinking: boolean;
  /** Key for remounting Static on session switch */
  sessionKey: string;
}

export function ChatArea({
  messages,
  streamingMessage,
  showThinking,
  sessionKey,
}: ChatAreaProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Static region: completed messages, terminal-native scrollback.
          key={sessionKey} forces remount on session switch so old
          content is cleared and new session's history renders fresh. */}
      <Static key={sessionKey} items={messages}>
        {(msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            showThinking={showThinking}
          />
        )}
      </Static>

      {/* Dynamic region: current streaming message.
          Content is plain text during streaming — final markdown
          rendering is applied when the message moves to the messages
          array (completed). */}
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
