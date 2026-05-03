import {
  getTextToolFallbackPrompt,
  getPlanModePrompt,
  getLineCountHintPrompt,
  getGitStatusSnippet,
} from '../../../core/system-prompt.js';

export interface SystemPromptParts {
  baseSystemPrompt: string;
  useTextToolFallback: boolean;
  planMode: boolean;
  lineCountHint: boolean;
  gitDirty: boolean | null;
}

export function composeSystemPrompt(p: SystemPromptParts): string {
  const parts = [p.baseSystemPrompt];
  if (p.useTextToolFallback) parts.push(getTextToolFallbackPrompt());
  if (p.planMode) parts.push(getPlanModePrompt());
  if (p.lineCountHint) parts.push(getLineCountHintPrompt());
  const git = getGitStatusSnippet(p.gitDirty);
  if (git) parts.push(git);
  return parts.join('\n\n');
}
