import type { AgentLoopApi } from '../use-agent-loop.js';
import { listStatsForProvider } from '../../../core/key-stats.js';
import { keyFingerprint, listKeys } from '../../../core/credentials.js';
import { descriptorByAlias } from '../../../providers/descriptors.js';
import { loadGlobalConfig } from '../../../core/config.js';

function relativeAge(ts: string | undefined): string {
  if (!ts) return 'never';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Cache hit rate as a 0-100 integer percent, or null if no input tokens
 *  have been recorded yet. */
function cacheHitRate(
  s: { cachedInputTokens?: number; uncachedInputTokens?: number } | undefined,
): number | null {
  if (!s) return null;
  const cached = s.cachedInputTokens ?? 0;
  const uncached = s.uncachedInputTokens ?? 0;
  const total = cached + uncached;
  if (total === 0) return null;
  return Math.round((cached / total) * 100);
}

/** Anthropic's default cache TTL is 5 minutes. A `lastCacheReadAt` newer
 *  than that means the key is "warm" — the next turn is likely to hit. */
const CACHE_WARM_TTL_MS = 5 * 60 * 1000;
function isWarm(ts: string | undefined): boolean {
  if (!ts) return false;
  const ms = Date.now() - new Date(ts).getTime();
  return Number.isFinite(ms) && ms >= 0 && ms < CACHE_WARM_TTL_MS;
}

export async function dispatchKeys(arg: string, agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;

  const targetProvider = arg.trim() || refs.provider.name;
  const descriptor = descriptorByAlias(targetProvider);
  if (!descriptor) {
    agent.addNotice('warn', `Unknown provider "${targetProvider}".`);
    return;
  }

  const cfg = await loadGlobalConfig();
  const keys = listKeys(cfg, descriptor.name);
  if (keys.length === 0) {
    agent.addNotice('info', `No saved keys for ${descriptor.name}.`);
    return;
  }
  const stats = await listStatsForProvider(descriptor.name);

  const lines: { level: 'cyan' | 'info' | 'warn'; text: string; bold?: boolean }[] = [
    { level: 'cyan', text: `Saved keys for ${descriptor.name}:`, bold: true },
  ];
  for (const k of keys) {
    const s = stats[k.id];
    const okCount = s?.successCount ?? 0;
    const warnCount = (s?.rateLimitCount ?? 0) + (s?.authErrorCount ?? 0);
    const labelPart = (k.label ? `${k.label} · ` : '') + `…${keyFingerprint(k.token)}`;
    const usagePart =
      okCount === 0 && warnCount === 0 ? 'never used' : `${okCount} ok / ${warnCount} ⚠`;
    const hit = cacheHitRate(s);
    const cachePart =
      hit === null ? '' : `cache: ${hit}%${isWarm(s?.lastCacheReadAt) ? ' 🔥' : ''}`;
    const lastOk = s?.lastSuccessAt ? `last ok: ${relativeAge(s.lastSuccessAt)}` : '';
    const lastFail = s?.lastFailureAt ? `last ⚠: ${relativeAge(s.lastFailureAt)}` : '';
    const tail = [cachePart, lastOk, lastFail].filter(Boolean).join('  ');
    const text = `  ${labelPart.padEnd(40)}  ${usagePart.padEnd(18)}${tail ? '  ' + tail : ''}`;
    lines.push({ level: warnCount > 0 ? 'warn' : 'info', text });
  }
  lines.push({ level: 'info', text: '' });
  lines.push({ level: 'info', text: '  Manage keys via /pick (or Ctrl+K).' });
  agent.addNoticeBlock(lines);
}
