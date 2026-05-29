import fs from 'fs/promises';
import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { errorMessage } from '../../../utils/errors.js';
import { formatTokenCount } from '../../../utils/format-tokens.js';
import {
  LOW_CACHE_HIT_WARN_PCT,
  LOW_CACHE_MIN_TURNS,
  MAX_LARGEST_TOOL_RESULTS,
  TOKENS_PER_CHAR_ESTIMATE,
} from './stats-constants.js';

interface SessionStats {
  turns: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheCreationTokens: number;
  perTurnHitRate: number[];
  compactionTurns: number[];
  largestToolResults: { tool: string; tokens: number }[];
}

/** JSONL line schema we read from the session log. We only consume the
 *  `agent-event` flavour; other types (e.g. `session-start`, `model-change`)
 *  are skipped via the `type !== 'agent-event'` guard. */
interface AgentEventUsage {
  promptTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationTokens?: number;
}
interface AgentEvent {
  type: string;
  usage?: AgentEventUsage;
  toolName?: string;
  result?: { output?: string };
}
interface SessionLogEntry {
  type: string;
  event?: AgentEvent;
}

/** /stats — read the current session JSONL and report cache + cost
 *  diagnostics. Lives next to /keys: the JSONL is already on disk
 *  (see `core/session/session-log.ts`), so we don't need any new persistence. */
export async function dispatchStats(_arg: string, agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;
  const logger = refs.sessionLogger;
  if (!logger) {
    agent.addNotice('info', 'Session logging is disabled — /stats has nothing to read.');
    return;
  }

  let raw: string;
  try {
    raw = await fs.readFile(logger.filePath, 'utf-8');
  } catch (err) {
    agent.addNotice('warn', `Could not read session log: ${errorMessage(err)}`);
    return;
  }

  const stats = parseSession(raw);
  agent.addNoticeBlock(formatStats(stats, logger.filePath));
}

function parseSession(raw: string): SessionStats {
  const stats: SessionStats = {
    turns: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheCreationTokens: 0,
    perTurnHitRate: [],
    compactionTurns: [],
    largestToolResults: [],
  };

  const toolResults: { tool: string; tokens: number }[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: SessionLogEntry;
    try {
      entry = JSON.parse(trimmed) as SessionLogEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'agent-event') continue;
    const ev = entry.event;
    if (!ev) continue;

    if (ev.type === 'turn-complete') {
      stats.turns++;
      const usage = ev.usage;
      if (usage) {
        const cached = usage.cachedPromptTokens ?? 0;
        const total = usage.promptTokens ?? 0;
        const uncached = Math.max(0, total - cached);
        stats.cachedInputTokens += cached;
        stats.uncachedInputTokens += uncached;
        stats.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
        const turnTotal = cached + uncached;
        stats.perTurnHitRate.push(turnTotal > 0 ? cached / turnTotal : 0);
      } else {
        stats.perTurnHitRate.push(0);
      }
    } else if (ev.type === 'compaction') {
      stats.compactionTurns.push(stats.turns);
    } else if (ev.type === 'tool-call-result') {
      const output: string = ev.result?.output ?? '';
      toolResults.push({
        tool: ev.toolName ?? '<unknown>',
        tokens: Math.round(output.length * TOKENS_PER_CHAR_ESTIMATE),
      });
    }
  }

  toolResults.sort((a, b) => b.tokens - a.tokens);
  stats.largestToolResults = toolResults.slice(0, MAX_LARGEST_TOOL_RESULTS);
  return stats;
}

function formatStats(
  s: SessionStats,
  filePath: string,
): { level: 'cyan' | 'info' | 'warn'; text: string; bold?: boolean }[] {
  const lines: { level: 'cyan' | 'info' | 'warn'; text: string; bold?: boolean }[] = [
    { level: 'cyan', text: `Session stats — ${filePath.split('/').pop()}`, bold: true },
  ];

  const totalInput = s.cachedInputTokens + s.uncachedInputTokens;
  const overallHit = totalInput === 0 ? 0 : Math.round((s.cachedInputTokens / totalInput) * 100);

  lines.push({ level: 'info', text: `  Turns: ${s.turns}` });
  lines.push({
    level: 'info',
    text: `  Input tokens: ${formatTokenCount(totalInput)} total · ${formatTokenCount(s.cachedInputTokens)} cached (${overallHit}%) · ${formatTokenCount(s.uncachedInputTokens)} fresh`,
  });
  if (s.cacheCreationTokens > 0) {
    lines.push({
      level: 'info',
      text: `  Cache creation: ${formatTokenCount(s.cacheCreationTokens)} tokens written this session`,
    });
  }

  if (s.perTurnHitRate.length > 0) {
    lines.push({ level: 'info', text: `  Per-turn hit rate: ${sparkline(s.perTurnHitRate)}` });
  }

  if (s.compactionTurns.length > 0) {
    lines.push({
      level: 'info',
      text: `  Compactions: ${s.compactionTurns.length} (turns ${s.compactionTurns.join(', ')})`,
    });
  }

  if (s.largestToolResults.length > 0) {
    lines.push({ level: 'cyan', text: '  Largest tool results:' });
    for (const r of s.largestToolResults) {
      lines.push({
        level: 'info',
        text: `    ${r.tool.padEnd(10)} ~${formatTokenCount(r.tokens)} tokens`,
      });
    }
  }

  if (totalInput === 0) {
    lines.push({ level: 'warn', text: '  No usage recorded yet — run a turn first.' });
  } else if (overallHit < LOW_CACHE_HIT_WARN_PCT && s.turns >= LOW_CACHE_MIN_TURNS) {
    lines.push({
      level: 'warn',
      text: '  ⚠ Low cache hit rate — provider may not support caching, or prefix is volatile.',
    });
  }

  return lines;
}

const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function sparkline(values: number[]): string {
  return values
    .map(v => {
      const clamped = Math.max(0, Math.min(1, v));
      const idx = Math.min(SPARK_BARS.length - 1, Math.floor(clamped * SPARK_BARS.length));
      return SPARK_BARS[idx];
    })
    .join('');
}
