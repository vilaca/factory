import type { Provider, ToolCallMessage } from '../../../providers/types.js';
import type { ToolHost } from '../../../tools/host.js';
import { parseFirstJsonObject } from '../../../utils/json-extract.js';
import { errorMessage, isError } from '../../../utils/errors.js';
import * as fs from 'fs/promises';
import { CORRECTOR_FILE_READ_CAP_BYTES, CORRECTOR_FILE_SNIPPET_CHARS } from './constants.js';

const SYSTEM_PROMPT = `You are a tool-call corrector. The main coding agent attempted a tool call that failed. Given the original call, the error, and any relevant context, produce a single corrected tool call.

Output rules:
- Reply with ONLY a single JSON object on a single line, no prose, no code fences.
- Format: {"name": "ToolName", "arguments": {...}}
- ToolName must be one of the listed tools.
- If you cannot determine a fix that has a real chance of succeeding, reply with: {"action": "abort"}
- Never invent file content. Use the file content provided.
- Never repeat the original call unchanged — that would just fail again.`;

interface CorrectionRequest {
  originalCall: ToolCallMessage;
  errorMessage: string;
  /** User's most recent substantive task description, for intent. */
  userIntent?: string;
  /** Optional file content the corrector should consider (e.g., target of an Edit). */
  fileContent?: { path: string; content: string };
}

interface CorrectionResult {
  kind: 'corrected';
  call: ToolCallMessage;
}

interface AbortResult {
  kind: 'abort';
  reason: string;
}

type CorrectorOutcome = CorrectionResult | AbortResult;

export async function correctToolCall(
  request: CorrectionRequest,
  provider: Provider,
  model: string,
  toolRegistry: ToolHost,
  signal?: AbortSignal,
): Promise<CorrectorOutcome> {
  const validNames = toolRegistry.getNames();
  const toolDescriptions = toolRegistry
    .getAll()
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
      { signal, temperature: 0, _requestSource: 'corrector' },
    );

    const text = (response.content ?? '').trim();
    if (!text) return { kind: 'abort', reason: 'corrector returned empty response' };

    const parsed = extractFirstJsonObject(text);
    if (!parsed) return { kind: 'abort', reason: 'corrector output was not parseable JSON' };

    if (parsed.action === 'abort') {
      return {
        kind: 'abort',
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'corrector said abort',
      };
    }

    if (typeof parsed.name !== 'string' || !validNames.includes(parsed.name)) {
      return { kind: 'abort', reason: `corrector returned unknown tool name: ${parsed.name}` };
    }

    const args =
      typeof parsed.arguments === 'object' && parsed.arguments !== null
        ? (parsed.arguments as Record<string, unknown>)
        : {};

    return {
      kind: 'corrected',
      call: { function: { name: parsed.name, arguments: args } },
    };
  } catch (err: unknown) {
    // Propagate user aborts so the agent loop can exit via its AbortError
    // handler instead of treating it as a corrector failure.
    if (signal?.aborted || (isError(err) && err.name === 'AbortError')) throw err;
    return { kind: 'abort', reason: `corrector call threw: ${errorMessage(err)}` };
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
  parts.push(
    JSON.stringify(
      {
        name: request.originalCall.function.name,
        arguments: request.originalCall.function.arguments,
      },
      null,
      2,
    ),
  );
  parts.push('```');

  parts.push('\n## Error returned');
  parts.push(request.errorMessage);

  if (request.fileContent) {
    const truncated =
      request.fileContent.content.length > CORRECTOR_FILE_SNIPPET_CHARS
        ? request.fileContent.content.slice(0, CORRECTOR_FILE_SNIPPET_CHARS) + '\n...(truncated)'
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
  // Strip a leading code fence if present, then delegate to the shared
  // brace-depth scanner. Code-fence stripping stays local because no other
  // caller of the scanner needs it.
  const stripped = text
    .replace(/^```(?:json)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
  return parseFirstJsonObject(stripped);
}

/** Read up to 32KB of the file the failed call targeted (when the call has
 *  a `file_path` arg) so the corrector model can ground its fix on real
 *  content. The corrector slices to 8000 chars before sending anyway —
 *  reading more is just memory waste on large files. */
export async function readFileForCorrector(
  call: ToolCallMessage,
): Promise<{ path: string; content: string } | undefined> {
  const args = call.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return undefined;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const buf = Buffer.alloc(CORRECTOR_FILE_READ_CAP_BYTES);
    const { bytesRead } = await handle.read(buf, 0, CORRECTOR_FILE_READ_CAP_BYTES, 0);
    return { path, content: buf.toString('utf-8', 0, bytesRead) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {
      /* ignore */
    });
  }
}
