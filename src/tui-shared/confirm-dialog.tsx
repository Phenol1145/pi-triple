import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const [choice, setChoice] = useState<boolean>(false);

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setChoice((c) => !c);
      return;
    }
    if (key.return) {
      if (choice) onConfirm();
      else onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (_input === "y" || _input === "Y") {
      onConfirm();
      return;
    }
    if (_input === "n" || _input === "N") {
      onCancel();
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="yellow">
        ⚠ {message}
      </Text>
      <Box marginTop={1} gap={4}>
        <Text color={choice ? "green" : undefined} bold={choice}>
          {choice ? "▶ " : "  "}
          Yes
        </Text>
        <Text color={!choice ? "red" : undefined} bold={!choice}>
          {!choice ? "▶ " : "  "}
          No
        </Text>
      </Box>
      <Text dimColor>← → to switch · Enter to confirm · Esc to cancel</Text>
    </Box>
  );
}
