/**
 * Canonical names for every built-in tool. String literals were sprinkled
 * across security checks, the text-tool parser, system prompts, the agent
 * loop, and permission gates — a typo at any of those sites silently broke
 * behavior (no match, fallthrough). Routing call sites through this const
 * makes typos a compile error and gives `grep TOOL_NAMES.X` exhaustive
 * coverage when reasoning about a tool's wiring.
 */
export const TOOL_NAMES = {
  Bash: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  WebFetch: 'WebFetch',
  Delegate: 'Delegate',
  Respond: 'Respond',
} as const;
