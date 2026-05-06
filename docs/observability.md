# Observability cookbook

Factory writes every session to `~/.factory/sessions/<timestamp>-<id>.jsonl`. Each line is one event (`session-start`, `user-input`, `command`, `agent-event`, `system-prompt`, `model-change`, `session-end`, …). Token usage rides on `agent-event` payloads of type `turn-complete`:

```json
{
  "ts": "2026-05-06T14:22:31.012Z",
  "type": "agent-event",
  "event": {
    "type": "turn-complete",
    "stopReason": "completed",
    "turnsUsed": 1,
    "usage": {
      "promptTokens": 8421,
      "completionTokens": 312,
      "totalTokens": 8733,
      "cachedPromptTokens": 7980,
      "cacheCreationTokens": 0
    }
  }
}
```

The `cachedPromptTokens` and `cacheCreationTokens` fields are optional — providers that don't surface a cache split leave them undefined.

## `jq` recipes

Run from any directory; the path glob expands to all session logs.

### Session-aggregate input tokens (cached vs. fresh)

```bash
jq -s '
  [.[] | select(.type == "agent-event" and .event.type == "turn-complete") | .event.usage // empty]
  | { cached: (map(.cachedPromptTokens // 0) | add),
      fresh:  (map((.promptTokens // 0) - (.cachedPromptTokens // 0)) | add),
      total:  (map(.promptTokens // 0) | add) }
' ~/.factory/sessions/<file>.jsonl
```

### Hit-rate trend per turn (latest session)

```bash
jq -c '
  select(.type == "agent-event" and .event.type == "turn-complete") | .event.usage // {}
  | { promptTokens: (.promptTokens // 0), cached: (.cachedPromptTokens // 0) }
  | { rate: (if .promptTokens > 0 then (.cached / .promptTokens) else 0 end) }
' "$(ls -t ~/.factory/sessions/*.jsonl | head -1)"
```

Pipe the output to `awk '{print $0}' | column` if you want a quick eyeball pass.

### Tool-result size distribution

```bash
jq -s '
  [.[] | select(.type == "agent-event" and .event.type == "tool-call-result")
       | { tool: .event.toolName, len: (.event.result.output | length) }]
  | group_by(.tool)
  | map({tool: .[0].tool,
         count: length,
         avg_chars: (map(.len) | add / length | floor),
         max_chars: (map(.len) | max)})
' ~/.factory/sessions/*.jsonl
```

### Compaction frequency across recent sessions

```bash
jq -s '
  [.[] | select(.type == "agent-event" and .event.type == "compaction")] | length
' ~/.factory/sessions/*.jsonl
```

### Outlier turns (largest input, largest single tool result)

```bash
jq -c '
  select(.type == "agent-event" and .event.type == "turn-complete") | .event.usage // {}
  | select((.promptTokens // 0) > 50000)
' ~/.factory/sessions/*.jsonl
```

### Tool results that hit the elision cap

`agent.maxToolResultTokens` rewrites oversized tool output to a stub with a stable prefix, so a string match catches both insertion-time and aging-time elisions:

```bash
jq -r '
  select(.type == "agent-event" and .event.type == "tool-call-result")
  | select(.event.result.output | startswith("[elided:"))
  | .event.toolName
' ~/.factory/sessions/*.jsonl | sort | uniq -c | sort -rn
```

A high count from one tool means either its output is genuinely outsized (raise the cap) or the tool is being called with too-broad arguments (narrow the call).

## Failure modes worth eyeballing

- **Hit rate stuck at ~0% across turns.** Prefix isn't stable (volatile content leaked in) or the provider doesn't support caching at all.
- **Hit rate high but `cacheCreationTokens` is also high every turn.** Markers placed wrong — the cache is being rewritten every turn instead of read.
- **Specific turn drops hit rate to 0%.** Something mutated the prefix at that turn. Diff `system-prompt` events around that turn.
- **Per-turn `promptTokens` keeps climbing.** Compaction isn't firing or its threshold is too high; tool results may be dominating context.
- **Elision cap firing on >50% of tool calls.** Cap is too low or the agent is making sweeping calls. Either raise `agent.maxToolResultTokens` or add a "use offset/limit" hint to the system prompt.
- **Compaction firing every few turns.** Either `agent.compactionThreshold` is too low for this workload, or `agent.toolResultAgingTurns` should be smaller so old results get pruned before full compaction is needed.

## Adding new recipes

The JSONL is append-only and stable across versions; new event types can appear but old ones don't get rewritten. Build recipes against the shape you need and store them here. CLI binaries for stats are explicitly not part of factory — `jq` is the surface.
