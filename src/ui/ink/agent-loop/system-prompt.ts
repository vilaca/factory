import {
  getTextToolFallbackPrompt,
  getPlanModePrompt,
  getLineCountHintPrompt,
  getSubagentsPrompt,
  getGitStatusSnippet,
} from '../../../core/system-prompt.js';

export interface SystemPromptParts {
  baseSystemPrompt: string;
  useTextToolFallback: boolean;
  planMode: boolean;
  lineCountHint: boolean;
  subagents: boolean;
  gitDirty: boolean | null;
}

export function composeSystemPrompt(p: SystemPromptParts): string {
  const parts = [p.baseSystemPrompt];
  if (p.useTextToolFallback) parts.push(getTextToolFallbackPrompt());
  if (p.planMode) parts.push(getPlanModePrompt());
  if (p.lineCountHint) parts.push(getLineCountHintPrompt());
  if (p.subagents) parts.push(getSubagentsPrompt());
  const git = getGitStatusSnippet(p.gitDirty);
  if (git) parts.push(git);
  return parts.join('\n\n');
}
