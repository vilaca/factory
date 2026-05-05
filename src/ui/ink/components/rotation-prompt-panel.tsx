import React from 'react';
import { Box, Text } from 'ink';

export interface RotationPromptPanelProps {
  provider: string;
  model: string;
  reason: 'rate-limit' | 'auth';
}

export function RotationPromptPanel({ provider, model, reason }: RotationPromptPanelProps): React.ReactElement {
  const reasonLabel = reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color="yellow">
        ⚠ {provider}/{model} {reasonLabel} — no rotation chain set.
      </Text>
      <Text color="yellow">
        Add a fallback now? <Text dimColor>[y]es / [n]o, just fail</Text>
      </Text>
    </Box>
  );
}

export function parseRotationPromptInput(s: string): 'set-up' | 'decline' {
  const lower = s.trim().toLowerCase();
  if (lower === 'y' || lower === 'yes' || lower === '') return 'set-up';
  return 'decline';
}
