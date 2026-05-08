import fs from 'fs/promises';
import type { AgentLoopApi } from '../use-agent-loop.js';

interface SessionStats {
  turns: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheCreationTokens: number;
  perTurnHitRate: number[];
  compactionTurns: number[];
  largestToolResults: { tool: string; tokens: number }[];
}

const TOKENS_PER_CHAR = 0.25;

/** /stats — read the current session JSONL and report cache + cost
 *  diagnostics. Lives next to /keys: the JSONL is already on disk
 *  (see `core/session-log.ts`), so we don't need any new persistence. */
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
    agent.addNotice('warn', `Could not read session log: ${(err as Error).message}`);
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
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
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
        tokens: Math.round(output.length * TOKENS_PER_CHAR),
      });
    }
  }

  toolResults.sort((a, b) => b.tokens - a.tokens);
  stats.largestToolResults = toolResults.slice(0, 5);
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
    text: `  Input tokens: ${formatNum(totalInput)} total · ${formatNum(s.cachedInputTokens)} cached (${overallHit}%) · ${formatNum(s.uncachedInputTokens)} fresh`,
  });
  if (s.cacheCreationTokens > 0) {
    lines.push({
      level: 'info',
      text: `  Cache creation: ${formatNum(s.cacheCreationTokens)} tokens written this session`,
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
        text: `    ${r.tool.padEnd(10)} ~${formatNum(r.tokens)} tokens`,
      });
    }
  }

  if (totalInput === 0) {
    lines.push({ level: 'warn', text: '  No usage recorded yet — run a turn first.' });
  } else if (overallHit < 30 && s.turns >= 3) {
    lines.push({
      level: 'warn',
      text: '  ⚠ Low cache hit rate — provider may not support caching, or prefix is volatile.',
    });
  }

  return lines;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
