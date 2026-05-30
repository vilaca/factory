import type { ModelDisplayInfo } from './types.js';
import type { ModelTier } from '../../../../providers/types.js';

const TIER_RANK: Record<ModelTier, number> = { strong: 3, medium: 2, weak: 1 };

function rankFor(tier: ModelTier | undefined): number {
  return tier ? TIER_RANK[tier] : 0;
}

function rankToolSupport(toolSupport: string | undefined): number {
  if (toolSupport === 'native') return 3;
  if (toolSupport === 'basic') return 2;
  return 1; // none
}

export function prepareModels(
  models: readonly string[],
  getModelInfo?: (model: string) => ModelDisplayInfo | undefined,
): string[] {
  return [...models].sort((a, b) => {
    const infoA = getModelInfo?.(a);
    const infoB = getModelInfo?.(b);

    // 1. Tier (strong > medium > weak)
    const tierDiff = rankFor(infoB?.tier) - rankFor(infoA?.tier);
    if (tierDiff !== 0) return tierDiff;

    // 2. Coding specialist (coding models > generic models)
    const codingDiff =
      Number(infoB?.codingSpecialist ?? false) - Number(infoA?.codingSpecialist ?? false);
    if (codingDiff !== 0) return codingDiff;

    // 3. Tool support (native > basic > none)
    const toolDiff = rankToolSupport(infoB?.toolSupport) - rankToolSupport(infoA?.toolSupport);
    if (toolDiff !== 0) return toolDiff;

    // 4. Context window (larger > smaller)
    const ctxDiff = (infoB?.contextWindow ?? 0) - (infoA?.contextWindow ?? 0);
    if (ctxDiff !== 0) return ctxDiff;

    // 5. Max output tokens (larger > smaller)
    const outDiff = (infoB?.maxOutputTokens ?? 0) - (infoA?.maxOutputTokens ?? 0);
    if (outDiff !== 0) return outDiff;

    // 6. Alphabetical
    return b.localeCompare(a, undefined, { numeric: true });
  });
}
