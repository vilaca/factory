import { filterChatModels, matchedPattern } from '../list-models-filter.js';

const NON_CHAT_PATTERNS = [
  'whisper',
  'tts',
  'embedding',
  'dall-e',
  'moderation',
  'davinci',
  'babbage',
  'realtime',
  'audio',
  'image',
  'transcribe',
  'search',
  'computer-use',
] as const;

/** Returns the alias base when `id` looks like a dated pin
 * (`o3-mini-2025-01-31` → `o3-mini`, `gpt-4-0613` → `gpt-4`). Caller decides
 * whether the base actually exists in the catalog before treating it as a dup. */
function stripDateSuffix(id: string): string | null {
  const ymd = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(id);
  if (ymd?.[1]) return ymd[1];
  const mmdd = /^(.+)-\d{4}$/.exec(id);
  if (mmdd?.[1]) return mmdd[1];
  return null;
}

export interface OpenAiModel {
  id: string;
  owned_by?: string;
}

interface CatalogItem {
  id?: string;
  owned_by?: string;
}

/**
 * Filter raw `/v1/models` items to chat-capable, non-aliased models. Strips:
 *   - non-chat modalities (whisper/tts/embedding/dall-e/…)
 *   - dated-pin aliases whose base id is already in the catalog
 *     (`o3-mini-2025-01-31` when `o3-mini` is also present)
 */
export function filterOpenAiCatalog(items: unknown[]): OpenAiModel[] {
  const valid = items.filter(
    (item: unknown): item is CatalogItem & { id: string } =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as CatalogItem).id === 'string' &&
      !!(item as CatalogItem).id,
  );
  const allIds = new Set(valid.map(item => item.id));
  return filterChatModels('openai', valid, item => {
    const matched = matchedPattern(item.id, NON_CHAT_PATTERNS);
    if (matched) return `non-chat: matches '${matched}'`;
    const aliasBase = stripDateSuffix(item.id);
    if (aliasBase && allIds.has(aliasBase)) return `alias of '${aliasBase}'`;
    return true;
  }).map(item => ({
    id: item.id,
    owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
  }));
}
