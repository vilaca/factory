import chalk from 'chalk';
import type { SessionErrorStatus } from '../../../core/session-log.js';

/**
 * 0–9, A–Z jump shortcuts for picker rows. Indices beyond 35 silently
 * fall back to no shortcut — the row is still selectable via arrows.
 */
export function shortcutFor(index: number): string {
  if (index < 10) return index.toString();
  if (index < 36) return String.fromCharCode('A'.charCodeAt(0) + index - 10);
  return '';
}

/** Inverse of shortcutFor: returns -1 when the input doesn't match. */
export function indexForShortcut(input: string): number {
  if (/^[0-9]$/.test(input)) return Number.parseInt(input, 10);
  const upper = input.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return 10 + (upper.charCodeAt(0) - 'A'.charCodeAt(0));
  return -1;
}

export const STATUS_LABELS: Record<SessionErrorStatus, string> = {
  throttle: 'throttled',
  quota: 'out of quota',
  permission: 'permission denied',
  error: 'error',
};

export const STATUS_COLORS: Record<SessionErrorStatus, (s: string) => string> = {
  throttle: chalk.yellow,
  quota: chalk.red,
  permission: chalk.red,
  error: chalk.red,
};

/** Renders the parenthesised colored badge for a session status. */
export function renderStatusBadge(status: SessionErrorStatus): string {
  return STATUS_COLORS[status](`(${STATUS_LABELS[status]})`);
}
