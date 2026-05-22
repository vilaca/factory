import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../../../src/utils/chat-message.js';
import {
  runTieredCompact,
  findEligibleEnd,
  TRUNCATE_CHARS,
} from '../../../../src/core/context/tiered-compact.js';

function mkSys(): ChatMessage {
  return { role: 'system', content: 'sys', metadata: { type: 'system_prompt' } };
}
function mkUser(content: string, step?: number): ChatMessage {
  return {
    role: 'user',
    content,
    metadata: { type: 'user_input', ...(step !== undefined ? { stepIndex: step } : {}) },
  };
}
function mkToolCall(name: string, step: number): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name, arguments: {} } }],
    metadata: { type: 'tool_call', stepIndex: step },
  };
}
function mkToolResult(content: string, step: number): ChatMessage {
  return { role: 'tool', content, metadata: { type: 'tool_result', stepIndex: step } };
}
function mkReasoning(content: string, step: number): ChatMessage {
  return { role: 'assistant', content, metadata: { type: 'reasoning', stepIndex: step } };
}
function mkNudge(
  kind: 'step_nudge' | 'prerequisite_nudge' | 'retry_nudge',
  step: number,
): ChatMessage {
  return { role: 'user', content: 'nudge', metadata: { type: kind, stepIndex: step } };
}

describe('findEligibleEnd', () => {
  it('keeps the trailing N iteration boundaries (by stepIndex)', () => {
    const msgs = [
      mkSys(),
      mkUser('initial'), // index 1, kept
      mkReasoning('thought 1', 2), // step 2
      mkToolCall('Read', 2),
      mkToolResult('result', 2),
      mkReasoning('thought 2', 3), // step 3
      mkToolCall('Bash', 3),
      mkToolResult('out', 3),
      mkReasoning('thought 3', 4), // step 4
      mkToolCall('Edit', 4),
      mkToolResult('done', 4),
    ];
    // keepRecent=2 → last 2 steps (3 and 4) are preserved fully.
    // eligibleEnd is the index of the first message in step 3.
    const idx = findEligibleEnd(msgs, 2);
    assert.equal(msgs[idx]!.metadata?.stepIndex, 3);
  });

  it('returns messages.length when there are 2 or fewer messages', () => {
    assert.equal(findEligibleEnd([mkSys()], 2), 1);
    assert.equal(findEligibleEnd([mkSys(), mkUser('hi')], 2), 2);
  });
});

describe('runTieredCompact — phase escalation', () => {
  function buildLongConversation(): ChatMessage[] {
    return [
      mkSys(),
      mkUser('initial'),
      // Step 2 — a nudge plus a big tool result
      mkNudge('retry_nudge', 2),
      mkToolCall('Bash', 2),
      mkToolResult('B'.repeat(500), 2),
      mkReasoning('thinking 2', 2),
      // Step 3
      mkToolCall('Read', 3),
      mkToolResult('R'.repeat(500), 3),
      mkReasoning('thinking 3', 3),
      // Step 4 — recent
      mkToolCall('Edit', 4),
      mkToolResult('done', 4),
      // Step 5 — most recent
      mkToolCall('Bash', 5),
      mkToolResult('ok', 5),
    ];
  }

  it('Phase 0: returns no change when below threshold', () => {
    const msgs = buildLongConversation();
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => 0.5,
      stopBelow: 0.75,
    });
    assert.equal(result.phase, 0);
    assert.equal(result.changed, false);
    assert.equal(result.messages.length, msgs.length);
  });

  it('Phase 1: drops nudges + truncates long tool_results to TRUNCATE_CHARS', () => {
    const msgs = buildLongConversation();
    // Two probes: initial (over), post-P1 (under) — stop at P1.
    const probes = [0.9, 0.5];
    let i = 0;
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => probes[i++] ?? 0.5,
      stopBelow: 0.75,
      keepRecent: 2,
    });
    assert.equal(result.phase, 1);
    const nudges = result.messages.filter(m => m.metadata?.type === 'retry_nudge');
    assert.equal(nudges.length, 0, 'retry nudges should be dropped');
    const longResults = result.messages.filter(
      m => m.metadata?.type === 'tool_result' && m.content.length > TRUNCATE_CHARS + 100,
    );
    assert.equal(longResults.length, 0, 'long tool_results should be truncated');
  });

  it('Phase 2: drops tool_results entirely when Phase 1 was insufficient', () => {
    const msgs = buildLongConversation();
    // Three probes: initial (over), post-P1 (still over), post-P2 (under).
    const probes = [0.95, 0.85, 0.5];
    let i = 0;
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => probes[i++] ?? 0.5,
      stopBelow: 0.75,
      keepRecent: 2,
    });
    assert.equal(result.phase, 2);
    const eligibleToolResults = result.messages
      .slice(2)
      .filter(
        m =>
          m.metadata?.type === 'tool_result' &&
          // recent (step 4/5) survives
          m.metadata.stepIndex !== undefined &&
          m.metadata.stepIndex < 4,
      );
    assert.equal(eligibleToolResults.length, 0, 'eligible tool_results dropped at P2');
  });

  it('Phase 3: drops reasoning + text_response as last resort', () => {
    const msgs = buildLongConversation();
    // Always over; force P3
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => 0.95,
      stopBelow: 0.75,
      keepRecent: 2,
    });
    assert.equal(result.phase, 3);
    const eligibleReasoning = result.messages
      .slice(2)
      .filter(
        m =>
          m.metadata?.type === 'reasoning' &&
          m.metadata.stepIndex !== undefined &&
          m.metadata.stepIndex < 4,
      );
    assert.equal(eligibleReasoning.length, 0, 'eligible reasoning dropped at P3');
    // tool_call skeletons should still anchor the conversation arc
    const eligibleToolCalls = result.messages
      .slice(2)
      .filter(
        m =>
          m.metadata?.type === 'tool_call' &&
          m.metadata.stepIndex !== undefined &&
          m.metadata.stepIndex < 4,
      );
    assert.ok(eligibleToolCalls.length > 0, 'tool_call skeletons preserved through P3');
  });

  it('preserves system + first user message regardless of phase', () => {
    const msgs = buildLongConversation();
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => 0.99,
      stopBelow: 0.75,
      keepRecent: 2,
    });
    assert.equal(result.messages[0]!.metadata?.type, 'system_prompt');
    assert.equal(result.messages[1]!.metadata?.type, 'user_input');
    assert.equal(result.messages[1]!.content, 'initial');
  });

  it('preserves the last keepRecent boundaries fully', () => {
    const msgs = buildLongConversation();
    const result = runTieredCompact({
      messages: msgs,
      estimateFraction: () => 0.99,
      stopBelow: 0.75,
      keepRecent: 2,
    });
    // Steps 4 and 5 should be entirely intact.
    const step4 = result.messages.filter(m => m.metadata?.stepIndex === 4);
    const step5 = result.messages.filter(m => m.metadata?.stepIndex === 5);
    assert.equal(step4.length, 2, 'step 4 untouched');
    assert.equal(step5.length, 2, 'step 5 untouched');
  });
});
