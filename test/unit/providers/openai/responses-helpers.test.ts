import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildResponsesBody,
  toResponsesInput,
  toResponsesTools,
  appendArgsDelta,
  finalizeResponsesToolCalls,
  noteArgsDone,
  noteFunctionCallItem,
  extractResponsesUsage,
} from '../../../../src/providers/openai/index.js';

describe('toResponsesInput', () => {
  it('hoists the first system message to instructions and emits the rest as input', () => {
    const result = toResponsesInput([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);
    assert.strictEqual(result.instructions, 'be helpful');
    assert.deepStrictEqual(result.input, [{ type: 'message', role: 'user', content: 'hi' }]);
  });

  it('keeps later system messages inline (only the first is hoisted)', () => {
    const result = toResponsesInput([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'B' },
    ]);
    assert.strictEqual(result.instructions, 'A');
    assert.deepStrictEqual(result.input, [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'system', content: 'B' },
    ]);
  });

  it('splits assistant tool_calls into function_call items', () => {
    const result = toResponsesInput([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'Read', arguments: { file: 'x' } } },
          { id: 'call_2', function: { name: 'Grep', arguments: { q: 'y' } } },
        ],
      },
    ]);
    assert.deepStrictEqual(result.input, [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file":"x"}' },
      { type: 'function_call', call_id: 'call_2', name: 'Grep', arguments: '{"q":"y"}' },
    ]);
  });

  it('preserves an assistant text prefix before tool_calls', () => {
    const result = toResponsesInput([
      {
        role: 'assistant',
        content: 'Reading first.',
        tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: {} } }],
      },
    ]);
    assert.deepStrictEqual(result.input, [
      { type: 'message', role: 'assistant', content: 'Reading first.' },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
    ]);
  });

  it('maps tool messages to function_call_output items keyed by call_id', () => {
    const result = toResponsesInput([
      { role: 'tool', content: 'file contents', tool_call_id: 'call_1' },
    ]);
    assert.deepStrictEqual(result.input, [
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ]);
  });
});

describe('toResponsesTools', () => {
  it('flattens chat-completions tool shape to the Responses API shape', () => {
    const flat = toResponsesTools(
      [
        {
          type: 'function',
          function: { name: 'Read', description: 'read file', parameters: { type: 'object' } },
        },
      ],
      false,
    );
    assert.deepStrictEqual(flat, [
      {
        type: 'function',
        name: 'Read',
        description: 'read file',
        parameters: { type: 'object' },
        strict: false,
      },
    ]);
  });

  it('sets strict=true only when the schema is strict-compatible', () => {
    // Closed-form schema → strict turns on.
    const compatible = toResponsesTools(
      [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'read file',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['path'],
              properties: { path: { type: 'string' } },
            },
          },
        },
      ],
      true,
    );
    assert.strictEqual((compatible[0] as Record<string, unknown>).strict, true);

    // Loose schema → strict stays off even though the caller requested it.
    // Sending strict:true here would 400 server-side, so the gate is the
    // safer wire format.
    const loose = toResponsesTools(
      [
        {
          type: 'function',
          function: { name: 'Read', description: 'read file', parameters: { type: 'object' } },
        },
      ],
      true,
    );
    assert.strictEqual((loose[0] as Record<string, unknown>).strict, false);
  });
});

describe('buildResponsesBody', () => {
  it('uses input/instructions/store/stream and never emits messages or temperature', () => {
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
    });
    assert.strictEqual(body.model, 'gpt-5-codex');
    assert.strictEqual(body.stream, true);
    // store:true is mandatory for previous_response_id continuation, even
    // when no chain pointer is active on this call (we're seeding for next).
    assert.strictEqual(body.store, true);
    assert.strictEqual(body.instructions, 'sys');
    assert.ok(Array.isArray(body.input));
    assert.strictEqual('messages' in body, false);
    assert.strictEqual('temperature' in body, false);
    assert.strictEqual('previous_response_id' in body, false);
  });

  it('honors responsesStore override', () => {
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      options: { responsesStore: false },
    });
    assert.strictEqual(body.store, false);
  });

  it('drops chain pointer when responsesStore is false', () => {
    // Chaining requires the prior response to be retained server-side. With
    // store=false the prior response wasn't kept either, so previous_response_id
    // would 404 and message slicing would drop turns the server never saw.
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'turn 1 user' },
      { role: 'assistant' as const, content: 'turn 1 assistant' },
      { role: 'user' as const, content: 'turn 2 user' },
    ];
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages,
      stream: false,
      options: {
        responsesStore: false,
        responsesChain: { lastResponseId: 'resp_stale', messageCount: 3 },
      },
    });
    assert.strictEqual(body.store, false);
    assert.strictEqual('previous_response_id' in body, false);
    // Full conversation goes through (no slicing); first system message is
    // hoisted to instructions per the API's preferred shape.
    assert.strictEqual(body.instructions, 'sys');
    assert.deepStrictEqual(body.input, [
      { type: 'message', role: 'user', content: 'turn 1 user' },
      { type: 'message', role: 'assistant', content: 'turn 1 assistant' },
      { type: 'message', role: 'user', content: 'turn 2 user' },
    ]);
  });

  it('with responsesChain set, slices input and emits previous_response_id', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'turn 1 user' },
      { role: 'assistant' as const, content: 'turn 1 assistant' },
      { role: 'user' as const, content: 'turn 2 user' },
    ];
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages,
      stream: false,
      options: { responsesChain: { lastResponseId: 'resp_abc', messageCount: 3 } },
    });
    assert.strictEqual(body.previous_response_id, 'resp_abc');
    assert.strictEqual(body.store, true);
    assert.strictEqual('instructions' in body, false);
    // Only messages[3..] should map to input — the prior turns and system
    // prompt are already retained server-side under previous_response_id.
    assert.deepStrictEqual(body.input, [{ type: 'message', role: 'user', content: 'turn 2 user' }]);
  });

  it('flattens tools and sets parallel_tool_calls only when tools are present', () => {
    const withTools = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'X', description: '', parameters: {} } }],
      stream: false,
      parallelToolCalls: true,
    });
    assert.ok(Array.isArray(withTools.tools));
    assert.strictEqual((withTools.tools as Array<Record<string, unknown>>)[0]!.type, 'function');
    assert.strictEqual((withTools.tools as Array<Record<string, unknown>>)[0]!.name, 'X');
    assert.strictEqual(withTools.parallel_tool_calls, true);

    const noTools = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    assert.strictEqual('tools' in noTools, false);
    assert.strictEqual('parallel_tool_calls' in noTools, false);
  });

  it('maps maxTokens to max_output_tokens (not max_completion_tokens)', () => {
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      options: { maxTokens: 1024 },
    });
    assert.strictEqual(body.max_output_tokens, 1024);
    assert.strictEqual('max_completion_tokens' in body, false);
  });

  it('emits a reasoning block when reasoningEffort is supplied', () => {
    const body = buildResponsesBody({
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      reasoningEffort: 'high',
    });
    assert.deepStrictEqual(body.reasoning, { effort: 'high' });
  });
});

describe('responses tool-call accumulator', () => {
  it('finalises a single tool call from output_item.added + arg deltas + done', () => {
    const acc = new Map();
    noteFunctionCallItem(acc, 0, { call_id: 'call_42', name: 'Read' });
    appendArgsDelta(acc, 0, '{"fi');
    appendArgsDelta(acc, 0, 'le":"x"}');
    noteArgsDone(acc, 0, { name: 'Read', arguments: '{"file":"x"}' });
    assert.deepStrictEqual(finalizeResponsesToolCalls(acc), [
      { id: 'call_42', function: { name: 'Read', arguments: { file: 'x' } } },
    ]);
  });

  it('handles multiple parallel tool calls keyed by output_index', () => {
    const acc = new Map();
    noteFunctionCallItem(acc, 0, { call_id: 'a', name: 'A' });
    noteFunctionCallItem(acc, 1, { call_id: 'b', name: 'B' });
    appendArgsDelta(acc, 0, '{}');
    appendArgsDelta(acc, 1, '{}');
    const finalized = finalizeResponsesToolCalls(acc);
    assert.strictEqual(finalized.length, 2);
    assert.strictEqual(finalized[0].id, 'a');
    assert.strictEqual(finalized[1].id, 'b');
  });

  it('drops entries that never received a name', () => {
    const acc = new Map();
    appendArgsDelta(acc, 0, '{}');
    assert.deepStrictEqual(finalizeResponsesToolCalls(acc), []);
  });

  it('falls back to the done event arguments when deltas are absent', () => {
    const acc = new Map();
    noteFunctionCallItem(acc, 0, { call_id: 'c', name: 'C' });
    noteArgsDone(acc, 0, { arguments: '{"k":1}' });
    assert.deepStrictEqual(finalizeResponsesToolCalls(acc), [
      { id: 'c', function: { name: 'C', arguments: { k: 1 } } },
    ]);
  });

  it('preserves _raw when arguments fail to JSON-parse', () => {
    const acc = new Map();
    noteFunctionCallItem(acc, 0, { call_id: 'c', name: 'C' });
    appendArgsDelta(acc, 0, 'not-json');
    assert.deepStrictEqual(finalizeResponsesToolCalls(acc), [
      { id: 'c', function: { name: 'C', arguments: { _raw: 'not-json' } } },
    ]);
  });
});

describe('extractResponsesUsage', () => {
  it('maps input_tokens/output_tokens/total_tokens to TokenUsage', () => {
    const usage = extractResponsesUsage({
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });
    assert.deepStrictEqual(usage, {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it('extracts cachedPromptTokens from input_tokens_details', () => {
    const usage = extractResponsesUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 80 },
      },
    });
    assert.strictEqual(usage?.cachedPromptTokens, 80);
  });

  it('extracts reasoningTokens from output_tokens_details', () => {
    const usage = extractResponsesUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        total_tokens: 210,
        output_tokens_details: { reasoning_tokens: 150 },
      },
    });
    assert.strictEqual(usage?.reasoningTokens, 150);
  });

  it('returns undefined when usage is missing or null', () => {
    assert.strictEqual(extractResponsesUsage(undefined), undefined);
    assert.strictEqual(extractResponsesUsage({}), undefined);
    assert.strictEqual(extractResponsesUsage({ usage: null }), undefined);
  });

  it('defaults missing token counters to 0', () => {
    const usage = extractResponsesUsage({ usage: { input_tokens: 5 } });
    assert.deepStrictEqual(usage, { promptTokens: 5, completionTokens: 0, totalTokens: 0 });
  });
});
