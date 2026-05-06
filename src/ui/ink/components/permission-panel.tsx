import React from 'react';
import { Box, Text } from 'ink';
import type { PermissionDecision } from '../../../permissions.js';

export interface PermissionPanelProps {
  toolName: string;
  /** When the tool is `WebFetch`, surface the URL's hostname inline so the
   *  user knows what they're allowing without scrolling up to the tool-call
   *  panel. The whitelist option references it explicitly. */
  args?: Record<string, unknown>;
}

function webFetchHostname(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const url = typeof args.url === 'string' ? args.url : '';
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function PermissionPanel({ toolName, args }: PermissionPanelProps): React.ReactElement {
  if (toolName === 'WebFetch') {
    const host = webFetchHostname(args);
    return (
      <Box paddingX={1}>
        <Text color="yellow">Allow WebFetch{host ? ` to ${host}` : ''}? </Text>
        <Text dimColor>[y]es / [n]o / [w]hitelist {host ?? 'this domain'} / [a]llow all WebFetch</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text color="yellow">Allow {toolName}? </Text>
      <Text dimColor>[y]es / [n]o / [a]llow all</Text>
    </Box>
  );
}

/** Parses single-letter (or word) input from the permission prompt. The
 *  set of accepted inputs depends on the tool — WebFetch additionally
 *  accepts `w` (whitelist domain). Unknown input → deny, matching the
 *  existing fail-safe default. */
export function parsePermissionInput(s: string, toolName?: string): PermissionDecision {
  const n = s.trim().toLowerCase();
  if (n === 'y' || n === 'yes' || n === '') return 'allow';
  if (n === 'a' || n === 'allow' || n === 'allow all') return 'allow-all';
  if (toolName === 'WebFetch' && (n === 'w' || n === 'whitelist')) return 'allow-domain';
  return 'deny';
}
