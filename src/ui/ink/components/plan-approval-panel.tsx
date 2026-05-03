import React from 'react';
import { Box, Text } from 'ink';

export type PlanInputKind = 'approve' | 'cancel' | 'revise';

export interface PlanApprovalPanelProps {
  count: number;
}

export function PlanApprovalPanel({ count }: PlanApprovalPanelProps): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="cyan" bold>Plan: </Text>
      <Text color="cyan">{count} change{count === 1 ? '' : 's'} queued. </Text>
      <Text dimColor>[y] approve · [n] drop · or describe revisions</Text>
    </Box>
  );
}

/**
 * Classify a user input typed while a plan is queued. Returns 'approve' for
 * y/yes/`/approve`, 'cancel' for n/no/`/cancel`, 'revise' for anything else
 * (which the caller should treat as a follow-up prompt; non-slash inputs also
 * implicitly drop the queued plan).
 */
export function parsePlanInput(s: string): PlanInputKind {
  const lower = s.trim().toLowerCase();
  if (lower === 'y' || lower === 'yes' || lower === '/approve') return 'approve';
  if (lower === 'n' || lower === 'no' || lower === '/cancel') return 'cancel';
  return 'revise';
}
