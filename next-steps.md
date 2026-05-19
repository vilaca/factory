# Reliability Layer for Small-Model Tool Calling — Feature Inventory

A deep dive into a Python framework that takes an 8B local model from ~38% to ~99% on multi-step tool-calling workflows. This document captures every feature, the algorithm behind it, and the small-model failure mode it removes. Aim: reproduce this on our own stack.

The framework targets self-hosted models in the 8B–14B class on consumer GPUs (12–32GB VRAM), running against Ollama, llama-server, Llamafile, or Anthropic as backends. The reliability gain comes from a layered guardrail stack plus aggressive context management — none of the layers are individually clever; the value is in stacking them and in turning every reliability decision into structured text manipulation rather than a model judgement call.

---

## Design Principles That Drive Everything Else

1. **Fail fast, fail loud.** No `try/except` swallowing. A swallowed error at step 3 silently corrupts every later step. Every retry path raises a typed exception with the attempt count and the last raw response attached.
2. **Explicit over implicit.** Cloud APIs absorb ambiguity; a 14B Q4 does not. All schemas are Pydantic, all outputs are validated before execution, all hardware/budget choices are logged.
3. **Control flow is not memory.** Step completion is tracked in a separate `StepTracker` that lives on the runner — outside the message history. Compaction can rewrite the chat log; it can't invalidate which steps completed.
4. **The client adapter is the abstraction boundary.** The runner never sees raw text from a backend. Clients return `list[ToolCall] | TextResponse` and only that. Native FC, prompt-injected JSON, vendor-specific XML — all collapsed at the edge.
5. **Context is a first-class resource.** A 15-step workflow easily hits 10–20K tokens; pushing a 14B Q4 off GPU is 5–20× slower. Context budgeting is load-bearing infrastructure, not optional polish.

---

## 1. Two-Half Loop Architecture

The agentic loop is intentionally split. Both the in-process runner and the OpenAI-compatible proxy reuse the same front half:

| Half | Owns | Reused by |
|---|---|---|
| **Front** (`run_inference`) | compaction → reasoning fold → serialize → send → validate → retry-with-nudge | Runner + Proxy |
| **Back** (`WorkflowRunner.run`) | step enforcement → prerequisite check → tool execution → terminal detection → bookkeeping | Runner only |

`run_inference` is a self-contained async function that takes mutable `messages: list[Message]`, a client, a `ContextManager`, a `ResponseValidator`, an `ErrorTracker`, and a `tool_specs` list. It loops up to `max_retries + 1` times. Each iteration:

1. `context_manager.maybe_compact(messages, step_index, step_hint)` — may mutate `messages` in place
2. `context_manager.check_thresholds(messages)` — returns optional warning string
3. If warning: append a transient `{"role": "user", "content": warning}` to the API payload only (not persisted)
4. `fold_and_serialize(messages, api_format)` — collapses orphan REASONING messages into the following TOOL_CALL's `content`
5. `client.send(...)` or `client.send_stream(...)` → `LLMResponse`
6. `_sync_token_count(client, context_manager)` — pulls real usage if backend reported it
7. `validator.validate(response)` → `ValidationResult` (tool calls OR nudge)
8. If `needs_retry`: emit the failed assistant text/tool call + the nudge message into `messages` and `new_messages`, increment `error_tracker.record_retry()`, raise `ToolCallError` if budget exhausted, otherwise loop
9. Otherwise: `error_tracker.reset_retries()` and return `InferenceResult(response, new_messages, tool_call_counter, attempts)`

**Why this matters for reliability.** The proxy needed the same reliability ladder as the runner — earlier prototypes that reimplemented compaction/folding/serialization in the proxy produced Jinja template errors (consecutive same-role messages) and 8% completion drops. Single-source `run_inference` eliminates the divergence.

**Replication note.** Build the front half as a pure function over messages. The back half (tool dispatch, step gates) should be replaceable — that's how the same reliability stack gets reused by an HTTP proxy without leaking workflow semantics into the wire protocol.

---

## 2. The Inner Loop (Back Half)

```
while iteration < max_iterations:
    if cancel_event.is_set(): raise WorkflowCancelledError
    result = await run_inference(messages, ..., max_attempts=max_iterations - iteration)
    if result is None: break                          # budget spent
    iteration += result.attempts                      # retries consume iterations
    if isinstance(result.response, TextResponse):
        emit text_response, continue                  # intentional text turn
    tool_calls = result.response
    if step_enforcer.check(tool_calls).needs_nudge:   # premature terminal?
        if step_enforcer.premature_exhausted: raise StepEnforcementError
        emit reasoning + tool_call (skeleton) + step_nudge, continue
    if step_enforcer.check_prerequisites(tool_calls).needs_nudge:
        if step_enforcer.prereq_exhausted: raise PrerequisiteError
        emit reasoning + tool_call (skeleton) + prereq_nudge, continue
    execute every tool in batch sequentially:
        ToolResolutionError → feed message back, no error counter, no step record
        other Exception → feed back as [ToolError], batch_had_error=True
        success → step_enforcer.record(name, args)
    if batch_had_error: error_tracker.record_result(success=False)
        if error_tracker.tool_errors_exhausted: raise ToolExecutionError
    else: reset all consecutive counters
    if terminal in batch and succeeded: return terminal_result
raise MaxIterationsError(...)
```

Concrete invariants:
- A retry inside `run_inference` consumes one iteration. The runner passes `max_attempts = max_iterations - iteration` so a runaway retry loop can't exceed the global cap.
- Reasoning from `tool_calls[0].reasoning` is emitted as a separate `REASONING` message *before* the `TOOL_CALL`. The internal list keeps them separate (cheap compaction); only on the wire are they folded into one assistant message.
- Tool call IDs are generated as `call_{counter:09d}` and shared across the batch, threading through `TOOL_CALL` → `TOOL_RESULT` pairing.
- Step nudges and prereq nudges emit `tool_call (empty result)` + nudge — the assistant sees its own attempted call back in history alongside the corrective message, which empirically corrects faster than just the nudge alone.

---

## 3. Message Model and Compaction-Aware Tagging

Every message carries `MessageMeta` with a `MessageType` tag. The runner never serializes the metadata; `to_api_dict(format=...)` strips it at the wire boundary. Compaction strategies key off the tag.

`MessageType` enum:
- `SYSTEM_PROMPT` — never cut
- `USER_INPUT` — never cut
- `TOOL_CALL` — preserved across all phases
- `TOOL_RESULT` — truncated phase 1, dropped phase 2
- `REASONING` — preserved through phase 2, dropped phase 3
- `TEXT_RESPONSE` — failed tool call attempt; dropped phase 3
- `STEP_NUDGE`, `PREREQUISITE_NUDGE`, `RETRY_NUDGE` — dropped phase 1
- `CONTEXT_WARNING` — transient (not persisted in history; the warning is injected only into the outbound API payload)
- `SUMMARY` — reserved for future model-assisted compaction

`Message` is a dataclass with `role`, `content`, `metadata`, `tool_name`, `tool_call_id`, `tool_calls: list[ToolCallInfo] | None`. The wire format diverges by client:

| Field | `ollama` format | `openai` format |
|---|---|---|
| `tool_calls[i].arguments` | dict | JSON-encoded string |
| `tool_calls[i].type` | omitted | `"function"` |
| `tool_calls[i].id` | omitted | call_id required |
| Tool result key | `tool_name` | `name` + `tool_call_id` |

**Replication note.** Tag every message with semantic type, not just role. Compaction only works if you can drop "the nudge from step 2" without dropping the actual reasoning. Plain role-only message dicts are an API-compatibility bomb the moment you try to compact.

---

## 4. Response Validator + Nudge

`ResponseValidator` is stateless. Input: `LLMResponse`. Output: `ValidationResult(tool_calls, nudge, needs_retry)`.

Algorithm:
```python
def validate(response):
    if isinstance(response, TextResponse):
        if rescue_enabled:
            rescued = rescue_tool_call(response.content, tool_names)
            if rescued: return ValidationResult(tool_calls=rescued, needs_retry=False)
        return ValidationResult(nudge=Nudge("user", retry_nudge(...), kind="retry"), needs_retry=True)
    unknown = [tc for tc in response if tc.tool not in tool_names]
    if unknown:
        return ValidationResult(nudge=Nudge("user", unknown_tool_nudge(unknown[0].tool, tool_names), kind="unknown_tool"), needs_retry=True)
    return ValidationResult(tool_calls=response, needs_retry=False)
```

`Nudge` is a frozen dataclass: `role`, `content`, `kind ∈ {retry, unknown_tool, step, prerequisite}`, `tier`. Kept deliberately framework-agnostic — no dependency on the internal `Message` type, so foreign loops can inject it as `{"role": ..., "content": ...}` directly.

**Reliability mechanism.** Small models routinely produce text-shaped tool calls when the JSON template gets long. The rescue path catches 30–60% of those before any retry is wasted; the retry nudge corrects the rest.

---

## 5. Rescue Parsing — Three Strategies, One Function

`rescue_tool_call(text, available_tools)` returns `list[ToolCall]`. Tries strategies in order, returns first non-empty:

**Strategy 1 — JSON extraction.** Strips ```` ``` ```` code fences, then walks the cleaned text looking for `{`, tracks brace depth, attempts `json.loads` on each balanced substring. Accepts both `{"tool": "...", "args": {...}}` (the prompt-injected format) and `{"name": "...", "arguments": {...}}` (OpenAI format that Granite 4.0 emits inside `<tool_call>` tags). Only returns calls where the tool name is in `available_tools`.

**Strategy 2 — Rehearsal syntax.** Reasoning models sometimes "rehearse" tool calls inside their thinking blocks using `tool_name[ARGS]{...json...}`. Regex `(\w+)\[ARGS\](\{.*\})` with `DOTALL`.

**Strategy 3 — Qwen Coder XML.** Pattern adapted from Qwen3-Coder's reference parser:
```
<function=name>
  <parameter=key>value</parameter>
  ...
</function>
```
Whitespace handling matches the upstream parser exactly: one leading and one trailing newline stripped per parameter value. Type coercion is deferred to Pydantic at `ToolCall(args=...)` construction.

Before any strategy runs, think tags (`[THINK]...[/THINK]` for Mistral Reasoning, `<think>...</think>` for Qwen3/DeepSeek) are stripped — the tool call may appear *after* the thinking block, and feeding raw think tokens into a JSON extractor produces noise.

**Replication note.** Rescue parsing is the single highest-leverage feature for sub-12B models. Build it as a plain text pipeline — three lossy regex/state-machine passes, no LLM in the loop — and gate it behind `rescue_enabled` so ablation can measure its lift.

---

## 6. Nudge Templates — Escalating Pressure

All nudges are short, declarative strings with named callables so consumers can override them:

- `retry_nudge(raw)` — *"Your previous response was not a valid tool call. You must respond with a tool call, not free text. Please try again with a valid tool call."*
- `unknown_tool_nudge(tool_name, available)` — *"Tool 'X' does not exist. Available tools: A, B, C. Call one of them."*
- `prerequisite_nudge(tool, missing)` — *"You cannot call X yet. You must first call: read_file. Call the prerequisite tool now."*
- `step_nudge(terminal, pending, tier)` — three-tier escalation:
  - **Tier 1 (polite):** "You cannot call X yet. You must first complete these required steps: A, B. Call one of them now."
  - **Tier 2 (direct):** "You must call one of these tools now: A, B. Pick one."
  - **Tier 3 (aggressive caps):** "STOP. You MUST call one of: A, B. Do NOT call X. Your next response MUST be a tool call to one of: A, B."

`tier` is clamped to `[1, 3]` and increments on each premature terminal attempt. After tier-3 still fails, `StepEnforcementError` raises.

**Empirical finding** (from the framework's ablation paper): tier escalation lifts completion ~10pts on small models vs a single-tier nudge. The aggressive third tier saves runs where polite phrasing was being ignored.

---

## 7. Step Enforcer — Premature Terminal + Prerequisites

`StepEnforcer` is stateful, lives for one workflow run. Constructor:
```python
StepEnforcer(
    required_steps: list[str],
    terminal_tools: frozenset[str],
    tool_prerequisites: dict[str, list[str | dict[str, str]]] | None,
    max_premature_attempts: int = 3,
    max_prereq_violations: int = 2,
)
```

Two checks both consume `list[ToolCall]` and return `StepCheck(nudge, needs_nudge)`:

**`check(tool_calls)`** — Premature terminal:
```python
has_terminal = any(tc.tool in terminal_tools for tc in tool_calls)
if has_terminal and not tracker.is_satisfied():
    premature_attempts += 1
    tier = min(premature_attempts, 3)
    return StepCheck(nudge=step_nudge(attempted_terminal, tracker.pending(), tier), needs_nudge=True)
return StepCheck(needs_nudge=False)
```

**`check_prerequisites(tool_calls)`** — For each tool with prereqs:
- **Name-only** (`"read_file"`): satisfied if any prior successful call to `read_file` exists in `executed_tools`.
- **Arg-matched** (`{"tool": "read_file", "match_arg": "path"}`): satisfied if any prior call to `read_file` had `args["path"] == this_call.args["path"]`.

Evaluated against pre-batch state. Any violation in a parallel batch blocks the entire batch with a single nudge (whole-batch blocking — Phase 2 partial execution is deferred).

`StepTracker` underneath holds `completed_steps: dict[str, None]` and `executed_tools: dict[str, list[dict]]`. The dict-as-ordered-set keeps insertion order for `pending()`. `summary_hint()` returns `"[Steps completed: A, B]"` — fed to `TieredCompact` as `step_hint` for compaction summaries.

**Reliability mechanism.** Small models guess at the terminal tool early because it's the most "natural-sounding" name. The premature-terminal nudge is the highest-impact step-related guardrail — disabling it (`no_steps` ablation) drops completion by 30+ points on small models.

**Replication note.** Track step completion *outside* the message history. The model may lose track of what it called; the framework must not.

---

## 8. Tool Prerequisites — Conditional Dependencies

Declared on `ToolDef`:
```python
ToolDef(spec=..., callable=edit_file, prerequisites=["read_file"])
ToolDef(spec=..., callable=edit_file, prerequisites=[{"tool": "read_file", "match_arg": "path"}])
ToolDef(spec=..., callable=edit_file, prerequisites=["authenticate", {"tool": "read_file", "match_arg": "path"}])
```

`Workflow.__post_init__` validates that every prerequisite tool name exists in the workflow. Prerequisites are *not* surfaced in the tool schema sent to the LLM — the model discovers them via nudge-on-violation, same as required steps. Rationale: adding them to the prompt is noise the model often ignores; nudge-on-violation is loud and corrective.

When violated:
1. Emit the model's `TOOL_CALL` (the attempt happened) + a `PREREQUISITE_NUDGE` (the call was blocked, not executed). Compaction can drop the pair as a unit.
2. After `max_prereq_violations` (default 2) consecutive violations, raise `PrerequisiteError`.
3. Counter resets on any fully clean batch.

**Why this exists.** Small (and frontier) models routinely hallucinate file contents and skip the read-before-edit pattern. Making `read_file` a required step breaks investigation-only workflows. Conditional dependencies thread the needle.

---

## 9. Error Tracker — 4xx vs 5xx for Tools

`ErrorTracker` separates two failure modes that look the same to a naive loop:

| Failure | Counter | Recovery |
|---|---|---|
| **Hard error** (`Exception` from tool callable) | `consecutive_tool_errors++` | Fed back as `[ToolError] TypeName: msg`. After `max_tool_errors` (default 2), raise `ToolExecutionError`. |
| **Resolution error** (`ToolResolutionError` raised by tool author) | Not counted | Fed back as `[ToolResolutionError] msg`. No counter increment, no step recorded. Bounded only by `max_iterations`. |
| **Formatting failure** (text response, unknown tool name) | `consecutive_retries++` | Fed back as nudge. After `max_retries` (default 3), raise `ToolCallError`. |

`ToolResolutionError` is the framework's idiom for "valid call, bad data — try again." Wrong key, empty result set, unknown ID. Mental model: HTTP 4xx (request was valid, resource doesn't exist) versus 5xx (server broken). It inherits from `Exception`, not the framework error hierarchy — it's a *tool-author* exception, the caller raises it from their callable, the runner catches it explicitly *before* the generic `except Exception` branch.

Counters reset on clean progress:
- `reset_retries()` on any valid `ToolCall` (known tool name)
- `reset_errors()` after a fully clean batch (zero tool errors across all calls)
- `reset_premature()` and `reset_prereq_violations()` after a clean batch too

**Reliability mechanism.** Without `ToolResolutionError`, a model that guessed three wrong IDs in a row would trip `ToolExecutionError` and kill the workflow even though the tool is healthy. Separating the two error classes lets you set `max_tool_errors=2` (tight, catches real bugs) while letting the model fumble through 8+ wrong-data attempts within the iteration budget.

---

## 10. Compaction — Tiered, Sliding, None

The `ContextManager` doesn't compact; it owns the budget and delegates to a `CompactStrategy`. Strategies own their own thresholds, so you can plug a custom one.

### Threshold mechanics
- `budget_tokens` — the hard ceiling
- `compact_threshold` (default 0.75) — fraction of budget at which compaction fires
- `phase_thresholds: (p1, p2, p3)` — optional per-phase fractions (e.g. `(0.60, 0.75, 0.90)`). Phase N fires only if estimated tokens exceed `budget * p_N`.

Token estimation:
- If the backend reported `usage.total_tokens` for the last call (via `client.last_usage[slot_id]`), use that.
- Otherwise fall back to `sum(len(m.content) for m in messages) // 4` (~20% error).

### `TieredCompact` — 3 phases

`keep_recent: int = 2` — number of *iteration* boundaries to preserve fully. Iterations are identified by `step_index` on message metadata, so a parallel batch with one `TOOL_CALL` + N `TOOL_RESULT` messages counts as one iteration. Critical for not splitting batches mid-compaction.

`_find_eligible_end(messages, keep_recent)`:
1. Collect distinct `step_index` values from `messages[2:]` (skip system + user)
2. If `len(seen_steps) <= keep_recent`, return 2 (nothing eligible)
3. Otherwise `cutoff_step = seen_steps[-keep_recent]`; return the first index `i` with `messages[i].step_index >= cutoff_step`

`messages[0:2]` (system + first user) are never cut. Indices `[2, eligible_end)` are eligible.

**Phase 1.** For each eligible message:
- If type ∈ {step_nudge, prereq_nudge, retry_nudge}: drop entirely.
- If type == tool_result and `len(content) > 200` (`TRUNCATE_CHARS`): replace content with `content[:200] + "\n[Truncated — N chars removed]"`.
- Else: keep.

**Phase 2.** Everything in Phase 1, plus drop tool_results entirely.

**Phase 3.** Everything in Phase 2, plus drop reasoning and text_response. Only `tool_call` skeletons remain in the eligible range. Emergency cutoff.

After each phase, re-estimate tokens. If below the next phase's trigger, stop. Return `(compacted_messages, phase_reached)`. Phase 0 = no compaction.

**Compaction priority intent:**
1. Cut first: ephemeral nudges (no long-term value)
2. Cut second: raw tool data (recoverable — model can re-call)
3. Cut third: text response (failed attempt, already corrected)
4. Cut fourth: reasoning (interpretive context — kills decisions if lost)
5. Preserved: tool_call skeletons (cheap, anchors the conversation arc)
6. Never cut: system + user_input + recent iterations

**Key insight:** reasoning traces survive through phase 2. The model's chain-of-thought from step 3 is what informs step 5+; losing raw tool data is recoverable, losing the interpretation is not.

### `SlidingWindowCompact`

Simpler. Drops everything between `messages[2]` and `eligible_end` when over threshold. Uses the same `step_index` boundary detection. Single phase, predictable, decent baseline.

### `NoCompact`

Passthrough. For workflows that won't hit the budget anyway, or for ablation runs.

**All three strategies are deterministic text manipulation — no LLM calls, sub-millisecond.** Lossy by design, but the loss is structured.

---

## 11. Context Threshold Warnings — Mid-Conversation Pressure Signal

Separate from compaction triggers. `ContextManager` accepts:
- `context_thresholds: list[float]` — e.g. `[0.5, 0.65, 0.8]`
- `on_context_threshold: Callable[(tokens, budget, pct), str | None]`

Each threshold fires *at most once per session* (tracked in `_fired_thresholds: set[float]`). If usage drops below a threshold after compaction, that threshold becomes re-fireable.

When a threshold crosses, `check_thresholds(messages)` returns a string. `run_inference` appends it as a `{"role": "user", "content": warning}` to the outbound API payload *only* — it doesn't persist in `messages`, so it doesn't pollute future requests. It is also emitted as a `CONTEXT_WARNING` Message to the `on_message` callback so UIs can surface it.

The default warning template escalates:
- ≥65%: "Context is filling up. When compaction triggers, older tool results and reasoning will be condensed. Be concise in your responses and front-load important information."
- ≥80%: "Context is nearly full. Older tool results and reasoning will be compacted soon — key information may be lost. Summarize critical findings now and prioritize completing the current task."

Uses `"user"` role rather than `"system"` mid-conversation because Jinja chat templates on llama-server reject mid-conversation system messages.

**Reliability mechanism.** Small models do better when warned that the next turn will hurt. The framework's compaction is lossy by design; the warning lets the model proactively front-load important conclusions before phase 2 drops the tool results that informed them.

---

## 12. Token Accounting — Trust Backend, Fall Back to Char/4

`_sync_token_count(client, context_manager)` after every send:
- Reads `client.last_usage[slot_id]` (TokenUsage dataclass with `prompt_tokens`, `completion_tokens`, `total_tokens`)
- Calls `context_manager.update_token_count(total_tokens)`
- Subsequent `estimate_tokens()` returns this exact value until next update

Each client reports usage differently:
- **Ollama** — `prompt_eval_count` + `eval_count` from `/api/chat` response
- **llama-server / Llamafile** — top-level `usage` field on the OpenAI-style response, including SSE `stream_options: {include_usage: true}` chunks
- **Anthropic** — `response.usage.input_tokens` + `output_tokens` from the SDK

For multi-slot llama-server: `last_usage` is `dict[int, TokenUsage]` keyed by slot.

**Why** — char/4 is ~20% off, which is the difference between compacting at 75% and crossing the actual 100% mark with no warning.

---

## 13. The Synthetic Respond Tool — Killing Text/Tool Ambiguity

The single most important small-model trick. When tools are present in a request, the model has two ways to reply: text or tool call. Small models pick wrong frequently. Eval testing showed that trusting the model's `finish_reason` dropped workflow completion from 100% to as low as **4%** on reasoning-heavy scenarios.

**Solution.** Inject a synthetic tool `respond(message: str)`. The model calls it instead of producing bare text. From the framework's perspective, every response is now a valid tool call — no retries wasted on conversational turns, no completion drops on tool-calling turns.

Three injection paths:
- **Runner mode** — caller sets `respond_tool()` as the terminal tool and includes it in `tools`. Callable just returns the message string.
- **Proxy mode** — auto-injected when the inbound request has `tools` set and doesn't already include `respond`. The proxy strips outbound respond calls, converting them to a plain text response with `finish_reason: "stop"`. The downstream client never sees the tool.
- **Middleware mode** — caller includes `"respond"` in `tool_names` and handles the tool call in their own execution code.

The tool's description is carefully worded to give the model a structured choice:
> "Respond to the user with a message. Use this when the user is chatting, asking a question, when you need to ask a clarifying question before proceeding, or when no other tool action is needed. Also use this after completing the user's request to report the result."

**Why this works for small models.** Small models struggle with open-ended decisions ("should I use tools or chat?") but are good at structured choices ("which tool should I call?"). The respond tool converts an open-ended decision into a structured one. The model stays in tool-calling grammar/template at all times.

**Replication note.** This is a 60-line feature with outsized impact. Implementing it is the highest-leverage single change for a small-model loop.

---

## 14. Reasoning Fold — Wire Compatibility Without Losing Structure

Internally, the framework keeps `REASONING` messages as separate `Message` objects so compaction can drop them independently. On the wire, this is wrong — OpenAI/llama-server expect one assistant message per turn with both `content` (reasoning) and `tool_calls`.

`fold_and_serialize(messages, api_format)`:
```python
pending_reasoning = None
for m in messages:
    if m.metadata.type == REASONING and m.role == ASSISTANT:
        pending_reasoning = m.content
        continue
    d = m.to_api_dict(format=api_format)
    if pending_reasoning is not None and m.tool_calls is not None:
        d["content"] = pending_reasoning           # fold into the following tool_call
        pending_reasoning = None
    elif pending_reasoning is not None:
        emit a standalone assistant msg with the reasoning, then pending_reasoning = None
    emit d
if pending_reasoning is not None: emit standalone trailing assistant msg
```

**Why** — without folding, the wire format has a standalone assistant text message followed by an assistant tool-call message. Two consecutive assistant messages break the Jinja parity checker on llama-server's Mistral template, which returns a 500.

---

## 15. Thinking-Tag Handling

Three formats supported:
- `[THINK]...[/THINK]` — Mistral Ministral Reasoning
- `<think>...</think>` — Qwen3, DeepSeek
- Server-side `reasoning_content` field — llama-server with `--reasoning-format auto`

`_extract_think_tags(text) -> (reasoning, remaining)` uses a single combined regex with `re.DOTALL` and two capture groups (one per format), returning all reasoning blocks joined with `\n\n` plus the rest of the content with tags stripped.

`_resolve_reasoning(accumulated_reasoning, accumulated_content)` priority:
1. If `_think` flag is False → return `None` (discard everything)
2. Server-parsed `reasoning_content` wins
3. Otherwise extract `[THINK]`/`<think>` tags from content
4. Otherwise fall back to raw content (instruct model narrating before tool call)

The `_think` flag has tri-state handling:
- `True` — always send `think=True` to backend; raise `ThinkingNotSupportedError` if backend rejects
- `False` — never request thinking; *also discard* any thinking that leaks through `<think>` tags in content
- `None` (auto) — heuristic: enable for models whose name contains "reason" or "think"; on first 400 error from backend, set `_think=False` and retry

**Why the discard path matters.** Qwen3 emits `<think>` tags inside `content` even when `think=False` is requested — server can't always suppress them. Without the gate, the eval verbose printer shows `[thinking]` lines for users who explicitly opted out.

---

## 16. Client Adapters — Three Failure-Tolerant Wire Formats

### `OllamaClient`
- `api_format = "ollama"` (args as dict, no `type`/`id` fields)
- `/api/chat` with `tools` parameter
- Tri-state `think` (above)
- `set_num_ctx(n)` injects `options.num_ctx` on every request
- Catches `httpx.ReadTimeout` → re-raises as `BackendError(408, ...)`; eval runner handles that gracefully

### `LlamafileClient`
- `api_format = "openai"`
- `mode ∈ {"native", "prompt", "auto"}`. Auto resolves on first send with tools:
  - Try `_send_native()`; if backend returns `HTTPStatusError` or `BackendError`, set `resolved_mode = "prompt"` and retry through `_send_prompt()`.
  - A *TextResponse* in native mode is NOT a fallback signal — it means native FC is supported but the model chose not to call a tool. Retry logic handles that.
  - `resolved_mode` is inspectable by callers.
- `slot_id` — routes requests to a specific llama-server slot (for multi-agent)
- `cache_prompt: bool = True` — sets llama-server prompt-cache flag
- `_downgrade_messages(messages)` — for prompt-injected mode:
  - `role="tool"` → `role="user"`
  - Structured `tool_calls` on assistant → flattened to JSON string matching the prompt format (history becomes a few-shot example)
- `_merge_consecutive(messages)` — strict alternation for Jinja template parity:
  - Walk messages; for each plain user/assistant (no tool_calls), find the previous *visible* (plain user/assistant) message
  - If same role at consecutive visible positions, merge contents with `"\n\n"`
  - Messages with `tool_calls` or `role="tool"` are "invisible" — they don't trigger merging but they don't break a same-role chain either
- `get_context_length()` queries `/props` (strips `/v1` suffix from base_url) and reads `default_generation_settings.n_ctx`

### `AnthropicClient`
- `api_format = "openai"` (runner serializes OpenAI-style; client converts)
- `_convert_messages(messages)` does the heavy lifting:
  - System messages → separate `system=` kwarg
  - Assistant with `tool_calls` → content blocks: `[{type:"text", text:content}, {type:"tool_use", id, name, input}, ...]`. `pending_tool_use_ids` gets the new IDs.
  - `role="tool"` → `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}`. Remove ID from pending.
  - `role="user"` — if `pending_tool_use_ids` is non-empty, inject synthetic `tool_result` blocks with `{is_error: True, content: "Not executed."}` for each — these are the unpaired `tool_use` from step/unknown-tool nudges where the tool was never executed. Anthropic requires every `tool_use` to be answered.
  - Final pass merges consecutive same-role messages (strict alternation requirement). Normalizes string content to list-of-blocks before merging.
- `tool_choice ∈ {"auto", "any", None}` — `"any"` forces a tool call (used by ablation to test if forcing replaces structural guardrails — finding: it helps Haiku from 43% → 89% bare, but doesn't reach the 100% that full guardrails do)

**The "synthetic error tool_result" injection is non-obvious and load-bearing.** When the framework emits a step nudge, the model has already produced a `tool_use` block that the framework refused to execute. Anthropic's API rejects messages with unpaired `tool_use`. The shim makes the failed-but-blocked call look like a tool that errored to the API.

---

## 17. Per-Model Sampling Defaults

`MODEL_SAMPLING_DEFAULTS` is a flat dict of `model_name -> {temperature, top_p, top_k, min_p, repeat_penalty, presence_penalty}`. Each entry has an inline URL comment to the HuggingFace model card it was pulled from, verified one model at a time.

Two functions separate lookup from policy:
- `get_sampling_defaults(model)` — pure lookup, returns `{}` for unknown. No logging, no raising.
- `apply_sampling_defaults(model, *, strict)` — policy layer used by client constructors:

| `strict` | model in map | behavior |
|---|---|---|
| True | yes | return dict copy |
| True | no | raise `UnsupportedModelError` |
| False | yes | one-shot INFO log: "Recommended sampling params exist for X; pass recommended_sampling=True to use them." |
| False | no | silent `{}` |

Clients accept `recommended_sampling: bool = False`. Strict mode is opt-in by design — most consumers want backend defaults, and silent application would change behavior on upgrade. Strict + unknown raises because falling through silently would defeat the intent.

Per-call sampling overrides (added later) flow through `send(messages, tools, sampling=...)`. A `sampling` dict from per-call kwargs wins over instance fields for that one call only — the instance is not mutated. Recognized fields: `temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `presence_penalty`, `seed`. `seed` is per-call-only.

**Why this exists.** A previous version hardcoded `temperature=0.7`. The 0.6.x release found that this was a real ~3-8 point handicap on most 8B-class models in eval — different families want different temperatures (Ministral Instruct: 0.05; Qwen3 thinking: 0.6; Granite 4.0: 0.0 greedy; Gemma 4: 1.0). The single-default era was hiding real model capability.

**Notably absent:**
- `llama3.1:*` — Meta's HF card / llama.com / llama-recipes are all silent on recommended sampling
- `mistral:7b-instruct-v0.3` — card has no recommended-settings section; demo code uses `T=0`

Unknown rows fall through to backend defaults. No values are made up.

---

## 18. Hardware Detection + Budget Resolution

`detect_hardware()` shells out to `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` with a 10s timeout. Returns `HardwareProfile(gpu_name, vram_total_mb)` or `None` if anything fails. Uses *total* VRAM only — a stable number that doesn't change with allocations.

`BudgetMode` enum:
- `BACKEND` — trust the backend's default. No `-c` override sent.
- `MANUAL` — caller supplies `manual_tokens`.
- `FULL` — max safe context. For Ollama, VRAM-tier lookup. For llama-server, the auto-tuned `n_ctx` read from `/props`.
- `FAST` — half of full. Trades context for faster attention (quadratic).

**Ollama VRAM tier** (matches Ollama's own internal defaults):
- `< 24 GB` → 4,096 tokens
- `24–48 GB` → 32,768 tokens
- `≥ 48 GB` → 262,144 tokens

**llama-server / Llamafile** — `/props` endpoint returns `default_generation_settings.n_ctx`. Without `--kv-unified`, this is *per-slot* context (`total / n_parallel`). With `--kv-unified`, it's the full pool (each slot can use all of it).

`FAST` is a two-phase dance:
1. Start backend with no `-c` to discover its auto-tuned max from `/props`
2. Compute `half_total` (accounting for `n_slots` × per-slot or unified)
3. Restart backend with `-c half_total`

`ServerManager.start()` is idempotent — if the same `(model, mode, ctx, flags, cache_type_k, cache_type_v, n_slots, kv_unified)` is already running, it's a no-op. Saves the model-reload time on repeated runs.

Health polling uses `/props` rather than `/health` because `/health` is gated behind the same `is_ready` middleware as `/props` — polling `/props` directly confirms the model is fully loaded and serving.

`setup_backend()` is the one-call setup that wires `ServerManager` + `ContextManager`:
- Returns `(ServerManager, ContextManager)` ready to plug into `WorkflowRunner`
- Ollama path: also calls `client.set_num_ctx(budget)` so the resolved budget appears in every request

---

## 19. KV Cache Quantization

`ServerManager.start()` accepts `cache_type_k` and `cache_type_v` (e.g. `"q8_0"`, `"q4_0"`), passed to llama-server as `--cache-type-k`/`--cache-type-v`.

Measured: on Ministral 8B Q4, Q8 KV cache lifted usable context from 36,864 → 68,608 tokens (1.86×) with no eval regression. Q4 KV cache lifts further (~3-4×) with measurable quality drop on hard scenarios.

**Replication.** Plumb the flags through to the backend launcher. Q8 is essentially free; Q4 is workload-dependent.

---

## 20. Multi-Slot llama-server (Concurrent Agents on One GPU)

`ServerManager.start(..., n_slots=N, kv_unified=False)` passes `--parallel N` to llama-server. Each slot gets its own KV cache slice.

`LlamafileClient(slot_id=K)` injects `slot_id: K` into every request body. Lets multiple `WorkflowRunner` instances share one server, each pinned to a slot.

`kv_unified=True` adds `--kv-unified`, sharing a single KV pool across all slots. Trades isolation for headroom — any slot can use the full context. Without it, context is hard-partitioned (`per-slot = total / n_slots`).

**Architecture pattern:** a home-assistant style consumer might run a long-lived conversational session on slot 0, with specialist workflows (calendar lookup, HVAC control) sharing slot 1 via a `SlotWorker`. Vision model on slot 2 if VRAM allows.

---

## 21. SlotWorker — Priority Queue with Auto-Preemption

`SlotWorker` wraps a `WorkflowRunner` and serializes execution behind an `asyncio.PriorityQueue`. Each `submit(workflow, user_message, priority=0)` returns a future awaited by the caller.

Priority is an `int` — lower runs first. No semantics imposed; consumer defines what the levels mean. Default 0 = pure FIFO.

**Auto-preemption.** On submit:
```python
if current_priority is not None and priority < current_priority and cancel_event is not None:
    cancel_event.set()
```
The running task receives the cancel signal at the start of its next iteration → raises `WorkflowCancelledError` → its future receives that exception. The higher-priority task takes over.

Worker loop:
- Pulls from queue, sets `_current_priority`, builds a fresh `cancel_event`, calls `runner.run(workflow, user_message, cancel_event=...)`.
- On any exception, the future receives the exception (still completes).
- `cancel_current()` lets the consumer manually cancel.

Use case: shared specialist slot in a multi-agent architecture. Routine workflows submit at low priority, user-initiated requests preempt them.

---

## 22. WorkflowRunner — Cancellation, Multi-Turn, Observability

### Cancellation
`run(workflow, user_message, cancel_event=asyncio.Event())`. The event is checked once per iteration, before the inference call. Cooperative — if a model is mid-inference, the runner waits. On set, raises `WorkflowCancelledError(messages, completed_steps, iteration)` — the full conversation state for the caller to resume, discard, or log.

### Multi-turn via `initial_messages`
```python
turn_messages = []
runner = WorkflowRunner(..., on_message=turn_messages.append)
await runner.run(workflow, "follow-up", initial_messages=conversation_history)
conversation_history.extend(turn_messages)
```

The runner doesn't rebuild the system prompt when `initial_messages` is provided — caller is responsible for including it. `on_message` fires only for NEW messages created during this turn, not the replayed history. `StepEnforcer` and `tool_call_counter` reset per `run()` call.

### Filter transient messages on persist
Long-running sessions accumulate retry/step nudges and failed text responses. The model sees its own past failures every turn — degrades coherence, especially on 8-14B. The framework provides the message tagging; the consumer filters:
```python
TRANSIENT = {RETRY_NUDGE, STEP_NUDGE, PREREQUISITE_NUDGE, TEXT_RESPONSE}
def on_message(msg):
    if msg.metadata.type not in TRANSIENT:
        self.messages.append(msg)
```
Not done in the framework because the within-turn behavior wants those nudges visible (model needs to see them to correct).

### Async `on_chunk`
Streaming callback is `Callable[[StreamChunk], Awaitable[None]]` — awaited per chunk inside the SSE loop. Sync callbacks block the stream; async lets a websocket consumer push tokens out as they arrive.

### Sync `on_message`
One callback per message-append, fires outside the hot SSE loop. Stays sync because blocking cost is negligible. Used by the eval harness for `_verbose_printer` and history collection.

---

## 23. Streaming Semantics

`StreamChunk` has four types:
- `TEXT_DELTA` — partial text (reasoning, refusal, etc.)
- `TOOL_CALL_DELTA` — partial tool call (name or args building up)
- `FINAL` — stream complete, `response: LLMResponse` set
- `RETRY` — previous stream was malformed; client is retrying

The runner only acts on `FINAL`. Streaming is a *side channel* for UI/logging, not a control-flow change. If a stream ends without a `FINAL`, the runner raises `StreamError`.

Per-client streaming bookkeeping:
- **Ollama** — NDJSON stream. Tracks `done` flag. `pending_tool_calls` carries tool calls that arrived in the same chunk as `done: true`.
- **Llamafile/llama-server** — SSE. Tracks `tool_call_parts: dict[int, {name, args}]` keyed by `delta.tool_calls[N].index` so it can reassemble parallel tool calls from streaming deltas. Bad JSON args at end → `TextResponse(content=accumulated_content)`.
- **Anthropic** — SDK events (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_stop`). Tracks `_current_tool_idx` for `input_json_delta` accumulation.

The eval harness retries on `StreamError` (default 2 retries) — a malformed stream is treated as a transient transport bug rather than a model failure, so it doesn't count toward the run.

---

## 24. Parallel Tool Calls

All three clients now return `list[ToolCall]` (single tool calls are just a 1-element list). `LLMResponse = list[ToolCall] | TextResponse`.

Runner batch semantics:
1. Validate every tool name; any unknown → nudge for the first unknown
2. If any terminal tool in batch and steps unsatisfied → step nudge (escalates as usual)
3. If any prereq violated → prerequisite nudge, whole batch blocked
4. Emit one `TOOL_CALL` message with N `ToolCallInfo` entries, plus a leading `REASONING` message from `tool_calls[0].reasoning`
5. Execute every tool sequentially, emitting one `TOOL_RESULT` per call
6. If any tool errors, `batch_had_error=True`, increments `consecutive_tool_errors` by 1 (not N)
7. `step_enforcer.record(tool, args)` per successful call
8. If terminal in batch and succeeded → return its result

`TieredCompact` treats a parallel batch as one iteration via `step_index` boundary detection. Compaction never splits the `TOOL_CALL` from its `TOOL_RESULT`s.

**Design choice — no enforcement guardrails on parallelism.** The framework's philosophy is *structural correctness*, not *intent validation*. It validates that the call is well-formed and the tool exists; it does not validate "did you call this tool the right number of times" or "in the right order." If a model batches three calls, three calls execute. The "model forgot the second call" failure mode is a model quality problem solved by `required_steps`, not by counting calls.

---

## 25. Tool Definition — Dynamic Pydantic Models

`ToolSpec` holds `name`, `description`, `parameters: type[BaseModel]`. `get_json_schema()` returns `parameters.model_json_schema()` for the wire format.

`ToolSpec.from_json_schema(name, description, schema)` builds a Pydantic model dynamically from a raw JSON Schema. `_json_schema_to_type(prop, field_name, model_name_prefix)` recursively maps:
- `enum` → `Literal[*values]` (takes priority)
- `string` → `str`, `integer` → `int`, `number` → `float`, `boolean` → `bool`
- `object` with `properties` → recursive sub-model via `_build_model`
- `array` with `items` → `list[item_type]`
- Otherwise → `Any`

`_build_model(properties, required, model_name)`:
- Required + has description: `(type, Field(description=...))`
- Required + no description: `(type, ...)` (ellipsis = required)
- Optional + has default: `(type | None, Field(default=..., description=...))`
- Optional, no default: `(type | None, Field(default=None, description=...))`

Critical for the proxy and BFCL integration — both receive raw OpenAI-style JSON schemas from external callers and need to materialize them as Pydantic models on the fly.

`Workflow.__post_init__` validates everything at construction:
- `tools` keys match `tool_def.name`
- Every `required_steps` entry is in `tools`
- Every terminal tool is in `tools` and NOT in `required_steps`
- Every `prerequisites` reference is in `tools`

`terminal_tool` accepts `str | list[str]` and normalizes to `terminal_tools: frozenset[str]` for O(1) membership.

---

## 26. The Guardrails Facade — Two-Method API for Foreign Loops

For consumers who own their own loop (BFCL harness, LangChain, custom agent), the framework exposes `Guardrails`:

```python
guardrails = Guardrails(
    tool_names=["search", "lookup", "answer"],
    required_steps=["search", "lookup"],
    terminal_tool="answer",
    max_retries=3, max_tool_errors=2, max_premature_attempts=3,
)
result = guardrails.check(response)
# result.action ∈ {"execute", "retry", "step_blocked", "fatal"}
# result.tool_calls if execute; result.nudge if retry/step_blocked; result.reason if fatal
if result.action == "execute":
    execute(result.tool_calls)
    done = guardrails.record([tc.tool for tc in result.tool_calls])
```

Internally composes `ResponseValidator + StepEnforcer + ErrorTracker`. Granular API (the components directly) is also exported for full control.

The facade returns a minimal `Nudge` dataclass with `role`/`content`/`kind` and no dependency on the internal `Message` type. Consumers map it to their own framework's message format:
```python
# OpenAI-style:
messages.append({"role": nudge.role, "content": nudge.content})
# LangChain:
msg_cls = HumanMessage if nudge.role == "user" else SystemMessage
```

**Why the split** — the standalone runner is opinionated (it owns the loop, tool execution, terminal detection). The facade is non-opinionated (you own the loop; it tells you what to do at each checkpoint). Both compose the same components.

---

## 27. The OpenAI-Compatible Proxy

A standalone proxy entrypoint (`--backend-url ... --port 8081` external mode, or `--backend llamaserver --gguf ...` managed mode) drops in between any OpenAI-compatible client and a local model server.

Architecture:
- **Raw `asyncio.start_server`** — no FastAPI, no Uvicorn. Reads request line, headers (`Content-Length` check, 16MB max), body. Routes:
  - `GET /health` → `{"status": "ok"}`
  - `GET /v1/models` → minimal model list
  - `POST /v1/chat/completions` → main path
  - `OPTIONS` → CORS preflight
- **Request serialization** — single `asyncio.Queue` + one worker task. Managed mode defaults `serialize=True` (single GPU = one inference at a time); external mode defaults `False`.
- **SSE header sent immediately** when `stream=true` — client knows the proxy is alive while waiting in the queue.
- **Client disconnect detection** — `_await_with_disconnect` polls `writer.is_closing()` every 1s with `asyncio.shield(future)` so a disconnect cancels the queued request. The worker still processes the request if already in flight (no mid-LLM-call interruption), but the result is discarded and the inference lock is released.
- **Per-call sampling** — request body's `temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `presence_penalty`, `seed` are extracted and threaded as a `sampling` dict through `client.send()` for this call only.
- **Buffer-then-stream** — proxy fully buffers the backend response, runs validation/rescue/retry, *then* streams the (clean) result back to the client. From the client's view, the proxy is just a slow LLM. Real token-by-token streaming during inference is incompatible with rescue parsing (which needs the full response).

`handle_chat_completions`:
1. Convert inbound OpenAI messages → internal `Message` list
2. Extract tool specs via `ToolSpec.from_json_schema`
3. Auto-inject `respond` tool if tools present and `respond` not already there
4. If no tools → plain passthrough to backend (no guardrails needed)
5. Build `ResponseValidator + ErrorTracker`; call `run_inference`
6. On `ToolCallError` (retries exhausted): pass the last raw text through to the client rather than erroring. The client's own loop can decide what to do.
7. Strip outbound `respond` calls — convert to plain text response (`finish_reason: "stop"`)
8. Otherwise convert tool calls to OpenAI format (`function.arguments` as JSON string, `id` as `call_{uuid8}`, `finish_reason: "tool_calls"`)

What the proxy applies vs not:

| Applies | Skips |
|---|---|
| Rescue parsing | Step enforcement (no workflow knowledge) |
| Retry nudges | Tool prerequisites |
| Unknown tool nudges | Max iterations (one `run_inference` per request, bounded by `max_retries`) |
| Context compaction | Context threshold warnings (stateless per-request) |
| Reasoning folding | Real per-token streaming |
| Message merging | Cancellation on disconnect mid-LLM call |

---

## 28. Server Lifecycle — Managed + External

Two `ProxyServer` modes mirror the eval/runner story:

**Managed** — proxy starts and manages the backend via `ServerManager`. Reuses existing process if same `(model, mode, ctx, flags, cache_type_k, cache_type_v, n_slots, kv_unified)`. On `stop()`, `terminate()` then `wait(timeout=10)`, then `kill()` if still alive, then `asyncio.sleep(3)` to let VRAM clear before any subsequent start.

**External** — caller manages the backend; proxy is just an HTTP layer.

Identity rules in `setup_backend()`:
- `backend="ollama"` requires `model`, rejects `gguf_path` (Ollama runtime keyed by name)
- `backend in ("llamaserver", "llamafile")` requires `gguf_path`, rejects `model` (GGUF *is* the identity — used for filesystem path equality, sampling lookup, JSONL eval rows)

`ServerManager` for Llamafile uses `_find_llamafile_runtime(directory)` to locate the `llamafile-*` binary alongside the GGUF (highest version wins).

---

## 29. Ablation Framework

Six independent guardrails, six presets:

```python
@dataclass(frozen=True)
class AblationConfig:
    name: str
    rescue_enabled: bool = True
    max_retries_per_step: int = 5        # 0 = no retry/unknown-tool nudge
    step_enforcement_enabled: bool = True
    max_tool_errors: int = 2             # 0 = no error recovery
    compaction_enabled: bool = True

ABLATION_PRESETS = {
    "baseline": AblationConfig(name="baseline"),
    "no_rescue": AblationConfig(name="no_rescue", rescue_enabled=False),
    "no_nudge": AblationConfig(rescue_enabled=False, max_retries_per_step=0),
    "no_steps": AblationConfig(step_enforcement_enabled=False),
    "no_recovery": AblationConfig(max_tool_errors=0),
    "no_compact": AblationConfig(compaction_enabled=False),
    "bare": AblationConfig(all-off),
}
```

`no_steps` is implemented by setting `required_steps=[]` on the per-run workflow — the step enforcer becomes a no-op rather than being absent. `no_recovery` sets `max_tool_errors=0` so the first tool error raises. `no_compact` forces `NoCompact` strategy; compaction-only scenarios are skipped entirely for ablations that disable compaction (they'd fail by definition).

**Headline numbers** from the reference paper / eval dashboard:
- Haiku bare: 100% → 43% (completeness); recovers to 100% with full guardrails. The frontier model needs the framework too.
- Sonnet bare: drops to 89%.
- Mistral 8B bare: ~38%; full: ~99%.
- `bare+any` variant (bare + Anthropic `tool_choice: "any"`) tested on Claude — Haiku recovers to 89%, showing forced-tool-choice helps but doesn't replace structural guardrails.

---

## 30. Eval Harness — Scenarios + Metrics

`EvalScenario` dataclass:
- `name`, `description`, `user_message`
- `workflow: Workflow` OR `build_workflow: Callable[[], (Workflow, validate_state_fn)]` (stateful scenarios get a fresh backend per run)
- `budget_tokens` (default 8192) — compaction scenarios use tight values (925, 2048) to force compaction
- `max_iterations` (default 15)
- `max_retries_per_step` (default 5), `max_tool_errors` (default 2)
- `validate: Callable[args, bool]` — terminal-args validator (substring AND-check)
- `validate_state: Callable[[], bool]` — backend end-state validator (stateful scenarios)
- `tags: list[str]`, `ideal_iterations: int | None`

Scenarios split into 30 cases:

**Plumbing** (3): basic_2step, sequential_3step, error_recovery — does the loop work?

**Model quality** (6): tool_selection, argument_fidelity, sequential_reasoning, conditional_routing, data_gap_recovery, relevance_detection.

**Advanced reasoning** (4): data_gap_recovery_extended (5 facts to assemble, misleading-by-name traps, status-marker lures), argument_transformation, inconsistent_api_recovery, grounded_synthesis.

**Compaction chain** (4): 10-step medical investigation, dependency-chained IDs threading through every call (`patient_lookup → pull_records → order_labs → review_imaging → request_referral → check_pharmacy → verify_insurance → request_prior_auth → schedule_appointment → submit_treatment_plan`). Four budget variants exercise no compaction, phase 1, phase 2, phase 3. Tool results are 500-800 char realistic medical detail — model must preserve interpretation through compaction.

**Stateful variants** (13): one per non-compaction scenario. Same intent, but tools route through a backend class where arguments mutate state. Wrong arguments cascade — pass `entity_id="999"` instead of `"42"` and the next call breaks instead of returning a generic "not found" string. Validation checks backend end state.

`RunResult` captures:
- `completeness` (reached terminal), `accuracy` (validator passed), `iterations_used`
- `compaction_events: list[CompactEvent]`, `messages: list[Message]` (for history analysis)
- `elapsed_seconds`, `stream_retries`, `input_tokens`, `output_tokens`, `cost_usd`

`CountingClientWrapper` wraps the underlying `LLMClient` to count `send()` calls and accumulate `last_usage` for token tallies — `iterations_used` is the wrapper's `call_count`.

`compute_metrics(scenario, results)`:
- Score = `correct / total` (primary sort key — blended success including incorrect-but-completed)
- Accuracy = `correct / validated`
- Completion rate = `completed / total`
- Efficiency = `ideal_iterations / actual_iterations`
- Wasted calls = `max(0, iterations_used - ideal)` averaged
- Speed = avg seconds per run

`analyze_history(messages)` extracts per-run `HistoryStats` (retry nudges, step nudges, tool errors, reasoning messages) for diagnostic breakdowns. Also correlates `correctness_with_reasoning` vs `correctness_without_reasoning` to detect whether reasoning traces help on this scenario.

---

## 31. Statistical Significance — Pooled McNemar + Wilson CI

`tests/eval/significance.py` runs the proper statistics on ablation tables:

**Pairing.** Baseline run `i` on scenario `S` vs ablation run `i` on scenario `S`. Because ablation runs reuse the same `(scenario, run)` index space, each trial has a matched pair — McNemar's test is exactly the right tool.

**McNemar p-value.** `b` = pairs where baseline correct + ablation wrong; `c` = the opposite. Under H₀, each discordant pair is a fair coin flip. The implementation picks:
- **Exact binomial tail** when `b + c ≤ 25` — computes via log-sum-exp to avoid underflow
- **Continuity-corrected χ²** otherwise: `χ² = (|b-c| - 1)² / (b+c)`, then `p = erfc(sqrt(χ²/2))`

**Wilson 95% CI** (better than naive ± for small `n`):
```
center = (p + z²/2n) / (1 + z²/n)
half  = z·sqrt(p(1-p)/n + z²/(4n²)) / (1 + z²/n)
CI = (center - half, center + half)
```

Reports configs as a table per `(model, backend, mode)`:
```
ablation       score    95% CI            delta    disc(b/c)    p   sig
baseline       86.50%   [83.45,89.55]
bare           42.30%   [38.41,46.19]   -44.20pt   85/13     1.23e-12  ***
no_rescue      78.40%   [74.83,81.97]    -8.10pt   55/30     1.45e-03  **
```

**Why this matters.** Eval numbers without significance are guesses. Reliability-framework eval data without McNemar can't tell you whether a 3-point lift is real or noise. Replicate the test harness with proper pairing before shipping ablation results.

---

## 32. Reporting + Dashboard

`report.py` generates ASCII tables, phone-friendly list views, HTML dashboards, and Markdown views from a JSONL results file. Markdown snapshots (`all.md`, `ollama.md`, `by-family.md`, `ablation.md`, `native-vs-prompt.md`, etc.) are pre-filtered persistent slices.

HTML dashboard is a single self-contained file:
- Pico CSS (~10KB, classless — semantic HTML looks good automatically)
- ~100-150 lines of vanilla JS for filter dropdowns (backend, mode, model family, quant, ablation, scenario multi-select)
- Filters compose with AND
- Click columns to sort
- Compare mode: checkbox column, max 2 selectable, comparison panel shows colored delta (green better / red worse)

Built from the same `compute_config_metrics()` aggregation as the ASCII table. Embedded as `const DATA = [...]` in a `<script>` tag.

---

## 33. Multi-Model Routing (Concept — Not Yet Built)

Concept doc proposes `ModelPool` that wraps multiple `ServerManager`-like instances. Each named pool entry has its own process, health check, and budget. Consumer picks a client by name, threads it into a runner.

Key design choice: **`WorkflowRunner` stays single-client.** No multi-client registry in the runner, no routing logic. Routing decisions live in consumer code. The runner is simple; the pool is infrastructure.

Per-model budgets resolve independently (Ollama tier, llama-server `/props`, Anthropic hardcoded 200K). Multi-model VRAM partitioning is not automatic — consumer manages loading order or sets explicit budgets via `MANUAL` mode.

Deferred features:
- Mid-workflow model switching (chain `runner.run()` calls instead)
- VRAM-aware auto-partitioning (backends auto-tune; consumer manages order)
- Eviction policies (LRU, priority-based — consumer-level orchestration)

---

## 34. Test Strategy

865 unit tests, deterministic, no LLM/backend required. Coverage by component:

| Component | Key cases |
|---|---|
| `Message` serialization | Metadata never in API dict; both wire formats; tool_calls list with 1+ entries |
| `StepTracker` | Empty/partial/satisfied; duplicate records; arg-matched prereqs |
| `CompactStrategy` | System always preserved; nudges dropped first; tool_results truncated then dropped; reasoning preserved through P2 then dropped P3; `keep_recent` boundary |
| `CompactEvent` / `on_compact` | Fires when compaction triggers; not when under budget; before/after counts correct |
| `WorkflowRunner` (mocked client) | Escalating nudge tiers 1/2/3 → StepEnforcementError; rescue salvages TextResponse; counter resets on progress; max iterations → exception; tool raises → ToolExecutionError; `rescue_enabled=False`; async `on_chunk` awaited; parallel batches emit 1 TOOL_CALL + N TOOL_RESULT |
| `OllamaClient` | Mocked HTTP send/stream; reasoning gated by `_think`; think auto-detect/fallback; `set_num_ctx`; `BackendError`/`ThinkingNotSupportedError`; `httpx.ReadTimeout` → `BackendError(408)` |
| `LlamafileClient` | Native/prompt/auto mode resolution; `_downgrade_messages` format; `_merge_consecutive` alternation; think tag extraction; `/props` context discovery |
| `AnthropicClient` | OpenAI → Anthropic conversion; system extraction; unpaired tool_use → synthetic error; consecutive same-role merging; `tool_choice` wiring |
| `ServerManager` | VRAM tier lookup; FULL/FAST/MANUAL/BACKEND modes; `n_slots` math with/without `kv_unified` |
| `Templates` | Prompt format; JSON extraction from code fences; rehearsal `tool[ARGS]{...}`; Qwen XML |
| `Nudges` | Tier 1/2/3 content; available tools listed; prerequisite missing-list |
| `ResponseValidator` | Rescue + retry + unknown tool paths |
| `StepEnforcer` | Premature terminal escalation; reset on clean batch; prereq arg-matched |
| `ErrorTracker` | Retry budget vs tool error budget; soft-error pass-through |

Tests use mocked HTTP responses (httpx mocks, async iterators for streaming) so the entire stack runs in CI without any model server.

---

## 35. Build Sequence for Replication

If we wanted to stand up the same reliability layer on our own stack, the dependency order is:

1. **Message model + tagging** (`MessageType`, `MessageMeta`, `Message`, `to_api_dict(format=...)`) — the foundation. Compaction and the wire-format split both key off this.
2. **`ToolSpec` + `ToolDef` + `Workflow`** with `__post_init__` validation. `ToolSpec.from_json_schema` for proxy/BFCL paths.
3. **One client adapter** (start with the OpenAI-compatible one). Just `send()` and `send_stream()`, returning `LLMResponse`. No retry logic in the client.
4. **`run_inference` shared front half** (single function, no class). Take messages, client, `ContextManager`, `ResponseValidator`, `ErrorTracker`. Loop with `max_attempts`. Return `InferenceResult`.
5. **`ResponseValidator` + `Nudge`** with the three rescue strategies. Stateless. This alone gets you maybe 30% of the lift.
6. **`StepTracker` + `StepEnforcer`** with the three-tier escalation. Lives outside the message history. This is the next ~30% of the lift.
7. **`ErrorTracker`** with separate retry / tool error counters. Plus `ToolResolutionError` as a 4xx-equivalent for tools.
8. **`TieredCompact` + `ContextManager`** with `step_index`-based iteration boundaries. Without this, long workflows hit the context wall.
9. **Synthetic `respond` tool.** 60 lines. Massive small-model UX win.
10. **`WorkflowRunner` back half** (step enforcement, prereq check, tool execution, terminal detection, cancellation).
11. **Tool prerequisites** (name-only first, arg-matched if you need it).
12. **`ServerManager` + `BudgetMode`** for managed-mode backends, plus `setup_backend()` one-call wiring.
13. **Per-model sampling defaults map** with opt-in `recommended_sampling=True` flag. Source values from HF cards one model at a time with inline URL comments.
14. **`SlotWorker`** if you need multi-agent slot sharing.
15. **Proxy** if you want a drop-in for existing OpenAI-compatible clients.
16. **Ablation framework + eval harness + McNemar significance** before you trust any number.

Each layer is independently toggleable so the ablation harness can isolate its contribution. The framework's published results show clean signal on every guardrail; replicating without ablation means you can't prove yours work.

---

## 36. Anti-Patterns the Framework Explicitly Rejects

- **Model-assisted compaction.** Tempting but adds latency + token cost + a new failure mode. Heuristic three-phase tiered compaction is "good enough" on real workloads.
- **Trusting `finish_reason` from small models.** Empirically catastrophic — 100% → 4% on hard scenarios. The synthetic `respond` tool sidesteps the question.
- **Defensive `try/except` wrapping.** Silent failures in agentic loops corrupt every subsequent step. Every retry path raises a typed exception with full context.
- **Tool-author exceptions in the framework error hierarchy.** `ToolResolutionError` deliberately inherits from `Exception`, not the framework's base error, because it's a *tool-author* signal, not a framework failure.
- **Validating tool argument types/values against the schema.** Schema validation is deferred to Pydantic at `ToolCall(args=...)` construction. The framework doesn't add a second validation layer — tool callables can validate further if needed.
- **Routing logic in the runner.** The runner takes one client. Multi-model routing is consumer code (a pool plus consumer-defined routing rules).
- **Auto-applying recommended sampling.** Opt-in only, with a one-shot INFO log if the consumer is missing free wins. Silent application would change behavior on upgrade.
- **Mid-workflow model switching as a runner feature.** Chain `runner.run()` calls with history handoff via `initial_messages` instead.
- **Token-by-token streaming in the proxy.** Incompatible with rescue parsing, which needs the full response. Buffer-then-stream is the right tradeoff for a guardrail-first proxy.

---

## 37. Numbers Worth Stealing

From the published eval and ablation runs:

- **Best 8B config:** Ministral-3 8B Instruct Q8_0 on llama-server / prompt-injected — 86.5% across 26 scenarios (91.1% OG-18, 76.0% hard advanced_reasoning). 4.7s per workflow.
- **Best stable config:** Ministral-3 14B Reasoning Q4_K_M on llama-server / native — 81.5% overall, nothing at 0%.
- **Five 8B configs hit 100% on OG-18** after per-model sampling defaults landed (vs ~95% with hardcoded `T=0.7`).
- **Backend choice is worth ~8 points** on the same model (llama-server vs Ollama for Ministral 14B Q4 Instruct: 84.7% vs 76.8%).
- **Q8 vs Q4** is a wash on OG-18 but ~7 points on hard scenarios.
- **Native FC wins OG-18; prompt-injected wins hard.** Same model, different wire format, different strengths.
- **Default retry budget:** 3 consecutive formatting failures.
- **Default tool error budget:** 2 consecutive execution errors.
- **Default premature terminal budget:** 3 attempts before raising.
- **Default prereq violation budget:** 2 consecutive.
- **Default compaction trigger:** 75% of budget.
- **Default `keep_recent`:** 2 iterations preserved fully.
- **Truncation length in phase 1:** 200 chars per tool result.
- **KV cache Q8:** 1.86× context lift, no eval regression measured.

---

## 38. What to Build First (Recommended Order)

Tight 60-90 day plan for our own stack, prioritized by reliability lift per line of code:

1. **Synthetic respond tool** (~60 lines, immediate ~60-point lift on small models in conversational settings).
2. **`ResponseValidator` + three rescue strategies + retry nudge** (~300 lines, ~30-point lift on tool-calling reliability).
3. **`StepEnforcer` with tiered nudges** (~200 lines, ~30-point lift on multi-step completion).
4. **Message tagging by type + `TieredCompact` three-phase compaction** (~400 lines, prevents context-wall failures on long workflows; without it, anything past 4-5 steps degrades).
5. **`ErrorTracker` + `ToolResolutionError`** (~150 lines, lets the model fumble through wrong-data attempts without killing the workflow).
6. **Per-model sampling defaults map** (~lookup table + 30 lines of policy code, ~3-8 point lift on most 8B-class models).
7. **`run_inference` extraction** (refactor — set up the shared front half so the eventual proxy can reuse it).
8. **Ablation framework + 6 presets** (gates everything above with proof-by-disabling).
9. **Eval harness + McNemar significance** (essential before claiming any of the above works).

Steps 1-5 alone should land an 8B-class local model into the 70-90% range on multi-step tool workflows. Steps 6-9 are how we know it actually worked and how we keep it from regressing.
