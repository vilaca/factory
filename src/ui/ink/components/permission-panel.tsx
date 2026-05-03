import React from 'react';
import { Box, Text } from 'ink';

export interface PermissionPanelProps {
  toolName: string;
}

export function PermissionPanel({ toolName }: PermissionPanelProps): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="yellow">Allow {toolName}? </Text>
      <Text dimColor>[y]es / [n]o / [a]llow all</Text>
    </Box>
  );
}

export function parsePermissionInput(s: string): 'allow' | 'deny' | 'allow-all' {
  const n = s.trim().toLowerCase();
  if (n === 'y' || n === 'yes' || n === '') return 'allow';
  if (n === 'a' || n === 'allow' || n === 'allow all') return 'allow-all';
  return 'deny';
}
