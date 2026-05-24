import { formatTokenCount } from '../shared.js';
import {
  estimateContextWindow,
  estimateMaxOutput,
  isReasoningModel,
  lookupFamily,
  supportsParallelToolCalls,
  supportsToolsByName,
  supportsVisionByName,
} from './model-families.js';

/** Picker `detail` line: paid · vision · tools · reasoning · max out · ctx. */
export function buildModelDetail(modelId: string): string {
  const details: string[] = [];
  details.push('paid');
  details.push(supportsVisionByName(modelId) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(modelId) ? 'tools' : 'no tools');
  if (isReasoningModel(modelId)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(modelId))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(modelId))} ctx`);
  return details.join(' · ');
}

/** Picker `warning` flag: 'preview' / 'deprecated' / undefined. */
export function buildModelWarning(modelId: string): string | undefined {
  if (modelId.includes('preview')) return 'preview';
  if (lookupFamily(modelId)?.deprecated) return 'deprecated';
  return undefined;
}

/** Capability labels surfaced via getModelInfo (vision/tool-use/reasoning/parallel-tools). */
export function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model)) capabilities.push('tool-use');
  if (isReasoningModel(model)) capabilities.push('reasoning');
  if (supportsParallelToolCalls(model)) capabilities.push('parallel-tools');
  return capabilities;
}
