import type { StandardToolHandler, ToolDefinition, ToolResult } from './types.js';
import type { InvokeContext } from '../core/skills/invoke.js';
import { invokeSkill } from '../core/skills/invoke.js';

const TOOL_NAME = 'invoke_skill';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Invoke a registered skill by name. Skills are reusable instructions, workflows, and ' +
      "domain-knowledge packages that extend your capabilities. Use this tool when the user's " +
      "request matches a skill's description or `when_to_use` field from the Skills catalog in " +
      "your system prompt. The skill's rendered content will be injected into the current " +
      'context or executed in a sub-agent, depending on the skill configuration.',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'The kebab-case skill name exactly as listed in the Skills catalog.',
        },
        arguments: {
          type: 'string',
          description:
            'Optional arguments passed to the skill. Positional: space-separated tokens. ' +
            'Available as $ARGUMENTS (full string), $0, $1, … or named params defined by the skill.',
        },
      },
    },
  },
};

/**
 * Build an `invoke_skill` tool bound to the current session's invoke context.
 * Called once per session setup; the context is captured in the closure so
 * the tool handler signature stays pure (args → result).
 */
export function createInvokeSkillTool(ctx: InvokeContext): StandardToolHandler {
  async function execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return { success: false, output: 'invoke_skill: "name" is required.' };
    }
    const skillArgs = typeof args.arguments === 'string' ? args.arguments : '';

    const result = await invokeSkill(name, skillArgs, ctx);

    switch (result.kind) {
      case 'not-found':
        return {
          success: false,
          output: `invoke_skill: no skill named "${name}". Use /skills to list available skills.`,
        };
      case 'path-restricted':
        return {
          success: false,
          output: `invoke_skill: skill "${name}" is restricted to different paths.`,
        };
      case 'model-invocation-disabled':
        return {
          success: false,
          output: `invoke_skill: skill "${name}" has model invocation disabled — use /${name} to invoke it manually.`,
        };
      case 'injected':
        return {
          success: true,
          output: `Skill "${name}" injected into context.`,
        };
      case 'delegated':
        return {
          success: true,
          output: result.summary,
        };
    }
  }

  return {
    name: TOOL_NAME,
    description: definition.function.description,
    category: 'read-only',
    definition,
    execute,
  };
}
