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
    const infoA = getModelInfo?.(a);
    const infoB = getModelInfo?.(b);
    const tierDiff = rankFor(infoB?.tier) - rankFor(infoA?.tier);
    if (tierDiff !== 0) return tierDiff;
    const codingDiff =
      Number(infoB?.codingSpecialist ?? false) - Number(infoA?.codingSpecialist ?? false);
    if (codingDiff !== 0) return codingDiff;
    const ctxDiff = (infoB?.contextWindow ?? 0) - (infoA?.contextWindow ?? 0);
    if (ctxDiff !== 0) return ctxDiff;
    const outDiff = (infoB?.maxOutputTokens ?? 0) - (infoA?.maxOutputTokens ?? 0);
    if (outDiff !== 0) return outDiff;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}
