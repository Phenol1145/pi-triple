import React, { Component, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <ErrorDetail error={this.state.error} />;
    }
    return this.props.children;
  }
}

/** Renders inside Ink context so useInput is available */
function ErrorDetail({ error }: { error: Error }) {
  const [expanded, setExpanded] = useState(false);

  useInput((input, _key) => {
    if (input === "e") {
      setExpanded((v) => !v);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        ✖ TUI Error: {error.message}
      </Text>
      {expanded && <Text dimColor>{error.stack}</Text>}
      <Text dimColor>
        Press 'e' to {expanded ? "collapse" : "expand"} details
      </Text>
    </Box>
  );
}
