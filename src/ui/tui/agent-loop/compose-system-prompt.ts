import {
  getTextToolFallbackPrompt,
  getPlanModePrompt,
  getLineCountHintPrompt,
  getSubagentsPrompt,
  getGitStatusSnippet,
  getScopedProjectInstructionsPrompt,
} from '../../../core/context/system-prompt.js';

interface SystemPromptParts {
  baseSystemPrompt: string;
  useTextToolFallback: boolean;
  planMode: boolean;
  lineCountHint: boolean;
  subagents: boolean;
  gitDirty: boolean | null;
  /** Pre-rendered alwaysOn skills section, or empty string. */
  alwaysOnSkills?: string;
  /** Directory-scoped AGENTS/CLAUDE/.cursorrules discovered at runtime. */
  scopedProjectInstructions?: string | null;
}

export function composeSystemPrompt(p: SystemPromptParts): string {
  const parts = [p.baseSystemPrompt];
  if (p.useTextToolFallback) parts.push(getTextToolFallbackPrompt());
  if (p.planMode) parts.push(getPlanModePrompt());
  if (p.lineCountHint) parts.push(getLineCountHintPrompt());
  if (p.subagents) parts.push(getSubagentsPrompt());
  const git = getGitStatusSnippet(p.gitDirty);
  if (git) parts.push(git);
  const scoped = getScopedProjectInstructionsPrompt(p.scopedProjectInstructions ?? null);
  if (scoped) parts.push(scoped);
  if (p.alwaysOnSkills && p.alwaysOnSkills.trim().length > 0) parts.push(p.alwaysOnSkills);
  return parts.join('\n\n');
}
