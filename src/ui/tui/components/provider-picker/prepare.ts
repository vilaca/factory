import type { ModelDisplayInfo } from './types.js';
import type { ModelTier } from '../../../../providers/types.js';

const TIER_RANK: Record<ModelTier, number> = { strong: 3, medium: 2, weak: 1 };

function rankFor(tier: ModelTier | undefined): number {
  return tier ? TIER_RANK[tier] : 0;
}

export function prepareModels(
  models: readonly string[],
  getModelInfo?: (model: string) => ModelDisplayInfo | undefined,
): string[] {
  return [...models].sort((a, b) => {
    const tierA = rankFor(getModelInfo?.(a)?.tier);
    const tierB = rankFor(getModelInfo?.(b)?.tier);
    if (tierA !== tierB) return tierB - tierA;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}
