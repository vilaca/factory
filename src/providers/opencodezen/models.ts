// Model metadata + route detection for OpenCode Zen. Pure functions —
// no I/O, no class state — so they can be unit-tested in isolation and
// shared between the route-specific adapters and the public catalog.

import type { ModelTier } from '../types.js';

export type OpenCodeZenRoute =
  | 'chat-completions'
  | 'anthropic-messages'
  | 'google-native'
  | 'openai-responses';

export interface OpenCodeZenModel {
  id: string;
  owned_by?: string;
  route: OpenCodeZenRoute;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function isSupportedOpenCodeZenModel(
  item: unknown,
): item is { id: string; owned_by?: string } {
  if (!item || typeof item !== 'object') return false;
  const i = item as { id?: unknown };
  if (typeof i.id !== 'string' || !i.id) return false;
  return detectOpenCodeZenRoute(i.id) !== 'openai-responses';
}

export function detectOpenCodeZenRoute(model: string): OpenCodeZenRoute {
  const id = model.toLowerCase();
  if (id.startsWith('claude-')) {
    return 'anthropic-messages';
  }
  if (id.startsWith('gemini-')) {
    return 'google-native';
  }
  // TODO: Add Zen /responses support for GPT models once the provider layer can
  // preserve Responses API streaming items and tool events without flattening
  // them into chat-completions semantics.
  if (id.startsWith('gpt-')) {
    return 'openai-responses';
  }
  return 'chat-completions';
}

export function unsupportedOpenCodeZenRouteError(model: string): Error {
  return new Error(
    `OpenCode Zen model "${model}" uses the /responses API, which this CLI does not support yet.`,
  );
}

export function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(isFreeModel(lower) ? 'free' : 'paid');
  details.push(supportsVisionByName(lower) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(lower) ? 'tools' : 'no tools');
  if (supportsReasoningByName(lower)) {
    details.push('reasoning');
  }
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

export function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('preview')) return 'preview';
  if (lower.includes('deprecated')) return 'deprecated';
  return undefined;
}

export function buildCapabilities(model: string, route: OpenCodeZenRoute): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model) && route !== 'openai-responses') {
    capabilities.push('tool-use');
  }
  if (supportsReasoningByName(model)) {
    capabilities.push('reasoning');
  }
  if (isFreeModel(model)) {
    capabilities.push('free');
  }
  return capabilities;
}

export function estimateModelTier(model: string): ModelTier {
  if (
    model.includes('qwen3.6-plus') ||
    model.includes('kimi-k2.6') ||
    model.includes('glm-5.1') ||
    model.includes('big-pickle') ||
    model.includes('claude-opus') ||
    model.includes('claude-sonnet') ||
    model.includes('gemini-3.1-pro')
  ) {
    return 'strong';
  }
  if (
    model.includes('qwen3.5-plus') ||
    model.includes('kimi-k2.5') ||
    model.includes('minimax-m2.7') ||
    model.includes('minimax-m2.5') ||
    model.includes('ling-2.6') ||
    model.includes('claude-haiku') ||
    model.includes('gemini-3-flash')
  ) {
    return 'medium';
  }
  return 'weak';
}

export function estimateContextWindow(model: string): number {
  if (model.includes('qwen3.6-plus') || model.includes('qwen3.5-plus')) return 262144;
  if (model.includes('claude-')) return 200000;
  if (model.includes('gemini-3.1-pro')) return 1048576;
  if (model.includes('gemini-3-flash')) return 1048576;
  if (model.includes('glm-5.1') || model.includes('glm-5')) return 128000;
  if (model.includes('kimi-k2.6') || model.includes('kimi-k2.5')) return 256000;
  if (model.includes('big-pickle')) return 256000;
  if (model.includes('minimax-m2.7') || model.includes('minimax-m2.5')) return 128000;
  return 128000;
}

export function estimateMaxOutput(model: string): number {
  if (model.includes('qwen3.6-plus')) return 65536;
  if (model.includes('claude-opus')) return 32000;
  if (model.includes('claude-sonnet')) return 16000;
  if (model.includes('claude-haiku')) return 8192;
  if (model.includes('gemini-')) return 65536;
  if (model.includes('qwen3.5-plus') || model.includes('kimi-k2.6') || model.includes('kimi-k2.5'))
    return 32768;
  if (model.includes('glm-5.1') || model.includes('glm-5') || model.includes('big-pickle'))
    return 32768;
  return 8192;
}

export function supportsToolsByName(_model: string): boolean {
  return true;
}

export function supportsVisionByName(model: string): boolean {
  return model.includes('hy3') || model.includes('gemini-');
}

export function supportsReasoningByName(model: string): boolean {
  return (
    model.includes('qwen') ||
    model.includes('kimi') ||
    model.includes('glm') ||
    model.includes('nemotron') ||
    model.includes('trinity') ||
    model.includes('claude') ||
    model.includes('gemini')
  );
}

export function isFreeModel(model: string): boolean {
  return model.includes('free') || model === 'big-pickle';
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
