import type { ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent } from './types.js';
import { parseTextToolCalls } from '../tool-call/text-tool-parser.js';
import { stripImitatedToolResults } from '../tool-call/tool-result-format.js';

interface ParsedResponse {
  storedContent: string;
  toolCalls: ToolCallMessage[];
  recoveredFromText: boolean;
}

/**
 * Clean up the model's text output and recover tool calls from it when the
 * provider didn't return any structured tool_calls:
 *  - strip fabricated tool-result blocks the model emitted as if they were real
 *  - parse <tool_call>/code-fence/bare-JSON tool calls out of plain text
 */
export async function* parseModelResponse(
  fullContent: string,
  initialToolCalls: ToolCallMessage[],
  knownToolNames: ReadonlySet<string>,
): AsyncGenerator<AgentEvent, ParsedResponse> {
  let toolCalls = initialToolCalls;
  let recoveredFromText = false;
  let storedContent = fullContent;

  if (fullContent) {
    const stripped = stripImitatedToolResults(fullContent);
    if (stripped.strippedCount > 0) {
      storedContent = stripped.cleaned;
      yield { type: 'tool-result-imitation-stripped', count: stripped.strippedCount };
    }
  }

  if (toolCalls.length === 0 && storedContent) {
    const parsed = parseTextToolCalls(storedContent, knownToolNames);
    if (parsed.toolCalls.length > 0) {
      toolCalls = parsed.toolCalls;
      recoveredFromText = true;
      storedContent = parsed.cleanedContent;
      yield {
        type: 'tool-call-recovered',
        count: parsed.toolCalls.length,
        source: parsed.sources[0]!,
      };
    }
  }

  return { storedContent, toolCalls, recoveredFromText };
}
