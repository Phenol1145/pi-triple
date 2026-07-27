import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { renderMarkdown } from "./markdown.js";
import { ToolCallView } from "./tool-call-view.js";
import type { TuiMessage } from "../types.js";

interface MessageBubbleProps {
  message: TuiMessage;
  showThinking?: boolean;
}

export function MessageBubble({ message, showThinking = false }: MessageBubbleProps) {
  switch (message.role) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color={theme.colors.user} bold>{"> "}</Text>
          <Text>{message.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1}>
          {message.thinking && showThinking && (
            <Box marginBottom={0}>
              <Text italic dimColor>
                {theme.icons.thinking} {message.thinking}
              </Text>
            </Box>
          )}
          <Text>{renderMarkdown(message.content)}</Text>
        </Box>
      );

    case "tool-call":
      return (
        <Box marginBottom={0}>
          <ToolCallView
            toolName={message.toolName ?? "?"}
            args={message.toolArgs}
            isError={message.isError}
            durationMs={message.durationMs}
          />
        </Box>
      );

    case "bash-output":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.colors.tool}>$ {message.toolName}</Text>
          <Box marginLeft={2}>
            <Text dimColor>{message.content.slice(0, 500)}</Text>
          </Box>
        </Box>
      );

    case "error":
      return (
        <Box marginBottom={1}>
          <Text color={theme.colors.error} bold>
            {theme.icons.error} {message.content}
          </Text>
        </Box>
      );

    case "system":
      return (
        <Box marginBottom={0}>
          <Text dimColor italic>
            {message.content}
          </Text>
        </Box>
      );

    default:
      return null;
  }
}
