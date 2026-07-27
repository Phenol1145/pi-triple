import React, { Component, type ReactNode } from "react";
import { Box, Text } from "ink";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  expanded: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, expanded: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column">
          <Text color="red" bold>
            ✖ TUI Error: {this.state.error.message}
          </Text>
          {this.state.expanded && (
            <Text dimColor>{this.state.error.stack}</Text>
          )}
          <Text dimColor>
            Press 'e' to{" "}
            {this.state.expanded ? "collapse" : "expand"} details
          </Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
