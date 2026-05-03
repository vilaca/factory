import type { Provider, ToolCallMessage } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';

const SYSTEM_PROMPT = `You are a tool-call corrector. The main coding agent attempted a tool call that failed. Given the original call, the error, and any relevant context, produce a single corrected tool call.

Output rules:
- Reply with ONLY a single JSON object on a single line, no prose, no code fences.
- Format: {"name": "ToolName", "arguments": {...}}
- ToolName must be one of the listed tools.
- If you cannot determine a fix that has a real chance of succeeding, reply with: {"action": "abort"}
- Never invent file content. Use the file content provided.
- Never repeat the original call unchanged — that would just fail again.`;

export interface CorrectionRequest {
  originalCall: ToolCallMessage;
  errorMessage: string;
  /** User's most recent substantive task description, for intent. */
  userIntent?: string;
  /** Optional file content the corrector should consider (e.g., target of an Edit). */
  fileContent?: { path: string; content: string };
}

export interface CorrectionResult {
  kind: 'corrected';
  call: ToolCallMessage;
}

export interface AbortResult {
  kind: 'abort';
  reason: string;
}

export type CorrectorOutcome = CorrectionResult | AbortResult;

export async function correctToolCall(
  request: CorrectionRequest,
  provider: Provider,
  model: string,
  toolRegistry: ToolRegistry,
  signal?: AbortSignal,
): Promise<CorrectorOutcome> {
  const validNames = toolRegistry.getNames();
  const toolDescriptions = toolRegistry.getAll()
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n');

  const userMessage = buildUserMessage(request, toolDescriptions);

  try {
    const response = await provider.chatNoStream(
      model,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      undefined,
      { signal, temperature: 0 },
    );

    const text = (response.content ?? '').trim();
    if (!text) return { kind: 'abort', reason: 'corrector returned empty response' };

    const parsed = extractFirstJsonObject(text);
    if (!parsed) return { kind: 'abort', reason: 'corrector output was not parseable JSON' };

    if (parsed.action === 'abort') {
      return { kind: 'abort', reason: typeof parsed.reason === 'string' ? parsed.reason : 'corrector said abort' };
    }

    if (typeof parsed.name !== 'string' || !validNames.includes(parsed.name)) {
      return { kind: 'abort', reason: `corrector returned unknown tool name: ${parsed.name}` };
    }

    const args = (typeof parsed.arguments === 'object' && parsed.arguments !== null)
      ? parsed.arguments as Record<string, unknown>
      : {};

    return {
      kind: 'corrected',
      call: { function: { name: parsed.name, arguments: args } },
    };
  } catch (err: any) {
    // Propagate user aborts so the agent loop can exit via its AbortError
    // handler instead of treating it as a corrector failure.
    if (signal?.aborted || err?.name === 'AbortError') throw err;
    return { kind: 'abort', reason: `corrector call threw: ${err.message}` };
  }
}

function buildUserMessage(request: CorrectionRequest, toolDescriptions: string): string {
  const parts: string[] = [];
  parts.push('## Available tools');
  parts.push(toolDescriptions);

  if (request.userIntent) {
    parts.push('\n## User intent');
    parts.push(request.userIntent);
  }

  parts.push('\n## Failed tool call');
  parts.push('```json');
  parts.push(JSON.stringify({
    name: request.originalCall.function.name,
    arguments: request.originalCall.function.arguments,
  }, null, 2));
  parts.push('```');

  parts.push('\n## Error returned');
  parts.push(request.errorMessage);

  if (request.fileContent) {
    const truncated = request.fileContent.content.length > 8000
      ? request.fileContent.content.slice(0, 8000) + '\n...(truncated)'
      : request.fileContent.content;
    parts.push(`\n## Current content of ${request.fileContent.path}`);
    parts.push('```');
    parts.push(truncated);
    parts.push('```');
  }

  parts.push('\nReturn the corrected tool call now as a single JSON object.');
  return parts.join('\n');
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  // Strip a leading code fence if present.
  const stripped = text
    .replace(/^```(?:json)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();

  // Find first balanced top-level object.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
