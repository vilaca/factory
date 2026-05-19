import { appendProviderLog } from '../utils/provider-log.js';

export type ChatCheck<T> = (item: T) => true | string;

export function filterChatModels<T extends { id: string }>(
  provider: string,
  items: readonly T[],
  isChat: ChatCheck<T>,
): T[] {
  const kept: T[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const item of items) {
    const verdict = isChat(item);
    if (verdict === true) {
      kept.push(item);
    } else {
      dropped.push({ id: item.id, reason: verdict });
    }
  }
  if (dropped.length > 0) {
    appendProviderLog({
      provider,
      category: 'diagnostic',
      action: 'list-models-filter',
      detail: JSON.stringify({ kept: kept.length, dropped }),
    });
  }
  return kept;
}

export function matchedPattern(modelId: string, patterns: readonly string[]): string | null {
  const lower = modelId.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) return p;
  }
  return null;
}
