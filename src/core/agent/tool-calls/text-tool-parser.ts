import type { ToolCallMessage } from '../../../providers/types.js';
import { extractAllJsonObjects } from '../../../utils/json-extract.js';
import { TOOL_NAMES } from '../../../tools/host.js';

const TOOL_CALL_TAG_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const JSON_FENCE_PATTERN = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
const SHELL_FENCE_PATTERN = /```(?:bash|sh|shell|console)\s*\n([\s\S]*?)\n```/g;
// Hermes/Llama-style: <function=Name><parameter=key>value</parameter>...</function>
// Also supports whitespace around tags: <function=Name>\n<parameter=key>\nvalue\n</parameter>
const FUNCTION_TAG_PATTERN = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/g;
const PARAMETER_TAG_PATTERN = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

type ParseSource = 'tag' | 'fence' | 'bare' | 'shell-fence' | 'function-tag';

interface ParseResult {
  toolCalls: ToolCallMessage[];
  cleanedContent: string;
  malformedCount: number;
  sources: ParseSource[];
}

function tryParseToolCall(
  jsonText: string,
  knownToolNames?: ReadonlySet<string>,
  knownToolNamesLower?: ReadonlyMap<string, string>,
): ToolCallMessage | null {
  try {
    const parsed = JSON.parse(jsonText.trim());
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.name === 'string' &&
      parsed.name.length > 0
    ) {
      // Reject names that aren't actual tools — common false positive when the
      // model emits JSON describing data (e.g. package.json content with a
      // "name" field). Only enforce when we know what tools exist.
      // Case-insensitive: small models routinely lowercase ("read" instead of
      // "Read"); the registry's `get()` and the validator's unknown-tool
      // check are both case-insensitive, so the parser must be too — otherwise
      // a lowercase call is silently dropped before either gets to see it.
      // We canonicalize to the registered name so downstream consumers (which
      // assume exact-case) stay happy.
      let resolvedName = parsed.name;
      if (knownToolNames && !knownToolNames.has(resolvedName)) {
        const canonical = knownToolNamesLower?.get(resolvedName.toLowerCase());
        if (!canonical) return null;
        resolvedName = canonical;
      }
      const args =
        typeof parsed.arguments === 'object' && parsed.arguments !== null
          ? (parsed.arguments as Record<string, unknown>)
          : {};
      return { function: { name: resolvedName, arguments: args } };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Build a lowercase→canonical map once per parse call. The parser is hot
 *  on every assistant turn; building this on each tryParseToolCall would
 *  be O(N*M) for N tools and M JSON blobs in the response. */
function buildLowerNameMap(known: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of known) out.set(n.toLowerCase(), n);
  return out;
}

function stripObjects(content: string, objects: string[]): string {
  let out = content;
  for (const obj of objects) {
    out = out.replace(obj, '');
  }
  return out;
}

export function parseTextToolCalls(
  content: string,
  knownToolNames?: ReadonlySet<string>,
): ParseResult {
  const toolCalls: ToolCallMessage[] = [];
  const sources: ParseSource[] = [];
  let malformedCount = 0;
  const knownToolNamesLower = knownToolNames ? buildLowerNameMap(knownToolNames) : undefined;

  let cleaned = content.replace(TOOL_CALL_TAG_PATTERN, (_match, body: string) => {
    // Check if the body contains <function> tags (Hermes-style inside <tool_call>)
    // In that case, don't try to parse as JSON; let the FUNCTION_TAG_PATTERN handle it
    if (/<function=/.test(body)) {
      // Return the body as-is so FUNCTION_TAG_PATTERN can process it below
      return _match;
    }

    const call = tryParseToolCall(body, knownToolNames, knownToolNamesLower);
    if (call) {
      toolCalls.push(call);
      sources.push('tag');
    } else {
      malformedCount++;
    }
    return '';
  });

  // Hermes/Llama style: <function=Name><parameter=k>v</parameter></function>
  cleaned = cleaned.replace(FUNCTION_TAG_PATTERN, (_match, name: string, body: string) => {
    let resolvedName = name;
    if (knownToolNames && !knownToolNames.has(resolvedName)) {
      const canonical = knownToolNamesLower?.get(resolvedName.toLowerCase());
      if (!canonical) {
        malformedCount++;
        return '';
      }
      resolvedName = canonical;
    }
    const args: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    PARAMETER_TAG_PATTERN.lastIndex = 0;
    while ((paramMatch = PARAMETER_TAG_PATTERN.exec(body)) !== null) {
      const key = paramMatch[1]!;
      const raw = paramMatch[2]!.trim();
      // Try to parse the value as JSON (handles numbers, bools, arrays, objects).
      // Fall back to the raw string if it isn't valid JSON.
      try {
        args[key] = JSON.parse(raw);
      } catch {
        args[key] = raw;
      }
    }
    toolCalls.push({ function: { name: resolvedName, arguments: args } });
    sources.push('function-tag');
    return '';
  });
  // Some models emit stray tags — strip both opening and closing so they don't show as text.
  cleaned = cleaned.replace(/<\/?tool_call>/g, '');

  cleaned = cleaned.replace(JSON_FENCE_PATTERN, (match, body: string) => {
    const call = tryParseToolCall(body, knownToolNames, knownToolNamesLower);
    if (call) {
      toolCalls.push(call);
      sources.push('fence');
      return '';
    }
    return match;
  });

  if (toolCalls.length === 0) {
    const objects = extractAllJsonObjects(cleaned);
    if (objects.length > 0) {
      // TODO: when a bare JSON object has no `name` field but its keys exactly
      // match the required parameters of exactly one registered tool, infer the
      // tool name rather than dropping the recovery. This covers the case where
      // the model emits only the arguments (e.g. `{"url":"https://..."}` instead
      // of `{"name":"WebFetch","arguments":{"url":"..."}}`) — seen in the wild
      // after auto-retry injection. Requires passing tool definitions into this
      // function so the key-set comparison can be done. Consider prompting the
      // user to confirm the inferred tool before executing, since the mapping is
      // a guess (even if unambiguous) rather than an explicit model intent.
      let allMatched = true;
      const recovered: ToolCallMessage[] = [];
      for (const obj of objects) {
        const call = tryParseToolCall(obj, knownToolNames, knownToolNamesLower);
        if (!call) {
          allMatched = false;
          break;
        }
        recovered.push(call);
      }
      // Only commit if EVERY top-level object parses as a tool call AND the
      // residual content (after stripping objects) has no prose — only
      // whitespace and stray punctuation like an extra "}" from a model typo.
      // Models occasionally emit one too many closing braces; don't lose the
      // recovery to that.
      const nonObjectContent = stripObjects(cleaned, objects).replace(/[\s{}\[\],]/g, '');
      if (allMatched && nonObjectContent.length === 0) {
        for (const call of recovered) {
          toolCalls.push(call);
          sources.push('bare');
        }
        cleaned = '';
      }
    }
  }

  // Last-resort: shell fences (```bash / ```sh) become Bash tool calls when no
  // structured call was recovered AND the Bash tool is registered. Treats the
  // model's "I'll run X" code block as the call instead of just narration.
  if (toolCalls.length === 0 && (!knownToolNames || knownToolNames.has(TOOL_NAMES.Bash))) {
    const shellCommands: string[] = [];
    const stripped = cleaned.replace(SHELL_FENCE_PATTERN, (_match, body: string) => {
      const trimmed = body.trim();
      if (trimmed) shellCommands.push(trimmed);
      return '';
    });
    if (shellCommands.length > 0 && stripped.trim().length === 0) {
      for (const cmd of shellCommands) {
        toolCalls.push({ function: { name: TOOL_NAMES.Bash, arguments: { command: cmd } } });
        sources.push('shell-fence');
      }
      cleaned = '';
    }
  }

  return {
    toolCalls,
    cleanedContent: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    malformedCount,
    sources,
  };
}
