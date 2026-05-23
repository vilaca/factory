# Paper Findings — Empirical Evidence for the Reliability Stack

Companion to `next-steps.md`. That document inventories the _features_ of the reliability framework — this one captures the _empirical findings_ from the published IEEE preprint that motivate each feature. Read this first if you want to understand the size of the prize; read `next-steps.md` if you want to understand how to claim it.

The preprint reports 50+ model/backend configurations across **9 agentic scenarios run 50 times each** (an earlier suite than the 26-scenario expansion shipped in current code). The numbers below are headline results from that study. The framework name is omitted throughout — we replicate the substance, not the brand.

---

## The Motivating Math: Compounding Per-Step Failure

A 90% per-step success rate yields **59% completion over five steps** (0.9⁵). 95% per-step yields **77%**. The single-turn function-calling benchmarks the industry reports do not capture multi-step reliability: a model that scores 95% on a function-calling leaderboard is barely a coin flip on a 13-step workflow.

This is the empirical reason every guardrail exists. Each layer claws back fractional per-step accuracy that compounds out into double-digit completion gain on multi-step workflows.

| Per-step accuracy | 3 steps | 5 steps | 10 steps |
| ----------------: | ------: | ------: | -------: |
|               90% |   72.9% |   59.0% |    34.9% |
|               95% |   85.7% |   77.4% |    59.9% |
|               99% |   97.0% |   95.1% |    90.4% |
|             99.5% |   98.5% |   97.5% |    95.1% |

The framework's published results take an 8B local model from 38–53% bare to 99% with the full guardrail stack. On a 10-step workflow, that's roughly a 40× improvement in expected completion.

---

## Finding 1 — Reliability-Framework Local Matches Frontier

Ministral 8B Reasoning Q4 on llama-server / native + full guardrails: **99.3% score**. The frontier APIs with the same guardrails:

| Config                                  |     Score |  Accuracy | Completion |    Speed |
| --------------------------------------- | --------: | --------: | ---------: | -------: |
| Sonnet 4.6 native + guardrails          |    100.0% |    100.0% |     100.0% |     6.5s |
| Opus 4.6 native + guardrails            |    100.0% |    100.0% |     100.0% |     8.5s |
| Haiku 4.5 native + guardrails           |     99.6% |    100.0% |      99.6% |     4.0s |
| **Ministral 8B-R Q4 LS/N + guardrails** | **99.3%** | **99.3%** | **100.0%** | **3.7s** |
| Ministral 8B-R Q8 LS/N + guardrails     |     99.2% |     99.2% |     100.0% |     4.6s |
| Ministral 14B-I Q4 LS/N + guardrails    |     98.8% |     98.8% |     100.0% |     3.5s |

The gap between a free 8B model on a $600 consumer GPU and a commercial frontier API, _both with the same framework_, is **less than one percentage point**. And the 8B model is _faster_ than Haiku — 3.7s vs 4.0s per workflow.

**Implication.** If a workflow doesn't require frontier reasoning, the local 8B isn't a degraded substitute — it's a peer.

---

## Finding 2 — Reliability-Framework Local Beats Frontier Bare

The same Ministral 8B Reasoning (99.3% with framework) outperforms every bare-frontier configuration:

| Config                                  |     Score |
| --------------------------------------- | --------: |
| **Ministral 8B-R Q4 LS/N + guardrails** | **99.3%** |
| Opus 4.6 bare + `tool_choice="any"`     |     88.9% |
| Sonnet 4.6 bare + `tool_choice="any"`   |     88.9% |
| Haiku 4.5 bare + `tool_choice="any"`    |     88.9% |
| Opus 4.6 bare                           |     88.6% |
| Sonnet 4.6 bare                         |     87.2% |
| Haiku 4.5 bare                          |     43.8% |

An 8B local model with the right framework beats the **best result a consumer can achieve through the frontier API alone**, including Anthropic's `tool_choice="any"` forced-tool-call mode.

**Implication.** "Just use Sonnet" is a worse default than "build the framework once, deploy 8B locally." This reframes the cloud-vs-self-hosted economics for any team doing repeated tool-calling work.

---

## Finding 3 — Every Model Needs Guardrails. Frontier Included.

Ablation deltas from the same paper:

| Model      | Full guardrails |        Bare |        Delta |
| ---------- | --------------: | ----------: | -----------: |
| Haiku 4.5  |     99.6% (cmp) | 43.8% (cmp) | **−55.8 pt** |
| Sonnet 4.6 |    100.0% (cmp) | 87.3% (cmp) |     −12.7 pt |
| Opus 4.6   |    100.0% (cmp) | 88.6% (cmp) |     −11.4 pt |

**Error recovery scenario: 0% completion for every model tested, local and frontier, without the retry mechanism.**

This is not a model capability gap; it is an **architectural absence**. No framework feeding errors back to the model means no model can self-correct, regardless of parameter count. The intelligence gap between 8B local and frontier is real — but it manifests only where multi-step _reasoning_ is the bottleneck, not where mechanical reliability is.

The `bare+any` variant (`tool_choice="any"` + framework otherwise disabled) is a useful intermediate: forcing tool choice recovers Haiku from 43.8% to 88.9%. Forcing helps but does _not_ replace structural guardrails — the remaining 11-point gap to 100% is what step enforcement, error recovery, and rescue parsing provide.

**Per-scenario breakdown (bare, no framework):**

| Scenario                   | Sonnet bare | Haiku bare | Opus bare |
| -------------------------- | ----------: | ---------: | --------: |
| Relevance detection (rel)  |        100% |         0% |      100% |
| Argument extraction (arg)  |        100% |        92% |      100% |
| Tool selection (tsl)       |         84% |        98% |      100% |
| Basic 2-step (b2s)         |        100% |         2% |      100% |
| Sequential 3-step (s3s)    |        100% |       100% |      100% |
| Conditional routing (crt)  |        100% |       100% |      100% |
| Sequential reasoning (srn) |        100% |         0% |      100% |
| **Error recovery (err)**   |      **0%** |     **0%** |    **0%** |
| Data gap recovery (dgr)    |        100% |         0% |      100% |

Even Opus — at the top of Anthropic's reasoning ladder — fails error recovery without the framework. The retry mechanism that feeds the error message back is the missing piece.

**Implication.** Build the framework first, _then_ decide on the model. The framework is the load-bearing infrastructure; the model is interchangeable.

---

## Finding 4 — The Serving Backend Is a Hidden Variable

Same model weights, dramatically different outcomes when only the backend changes. From the paper's Table II (all with full guardrails, all Q4_K_M):

| Model            | Backend / Mode     |     Score | Accuracy | Completion | Speed | `srnₛ` | `dgrₛ` |
| ---------------- | ------------------ | --------: | -------: | ---------: | ----: | -----: | -----: |
| Ministral 8B-R   | LS / native        |     99.3% |    99.3% |     100.0% |  3.7s |   100% |    98% |
| Ministral 8B-R   | LS / prompt        |     98.1% |    98.1% |     100.0% |  2.5s |   100% |    88% |
| Qwen3 14B        | Ollama / native    |     96.3% |    96.3% |     100.0% | 19.6s |   100% |    78% |
| Qwen3 14B        | LS / prompt        |     93.3% |    93.3% |     100.0% | 15.2s |   100% |    74% |
| Qwen3 14B        | LS / native        |     88.4% |    88.5% |      99.9% | 19.2s |    78% |    20% |
| Mistral-Nemo 12B | Llamafile / prompt | **82.6%** |    83.2% |      99.2% |  4.2s |    84% |     6% |
| Mistral-Nemo 12B | LS / prompt        |     75.0% |    93.5% |      80.2% |  3.7s |    24% |    74% |
| Mistral-Nemo 12B | Ollama / native    |     44.6% |    62.3% |      71.6% |  7.9s |    44% |    66% |
| Mistral-Nemo 12B | **LS / native**    |  **7.2%** |   100.0% |       7.2% |  2.0s |     0% |     0% |

The Mistral-Nemo swing is **75 points across backends with identical weights** — from 82.6% on Llamafile/prompt to 7.2% on llama-server/native. This is bigger than most model-to-model deltas in published benchmarks.

Qwen3 14B's range is 8 points (88.4% → 96.3%). Ministral 8B Reasoning is the most backend-stable at ~1.2 points of variance.

**Implication.** Any evaluation of self-hosted model capabilities that does not specify the serving backend may be producing misleading results. When we replicate, the eval config key must be `{model, backend, mode, ablation}` — not just `{model}`. Pin all four before comparing.

---

## Finding 5 — Bigger Is Not Always Better

Within the same model family, the smaller variant routinely beats the larger one _with the framework_:

| Comparison                          |  8B score |    14B score | Winner                                        |
| ----------------------------------- | --------: | -----------: | --------------------------------------------- |
| Ministral Reasoning Q4 LS/N         | **99.3%** | 95.7% (LS/P) | 8B                                            |
| Ministral Reasoning Q8 LS/N         | **99.2%** | 95.7% (LS/P) | 8B                                            |
| Ministral Instruct Q4 LS/N          |         — |        98.8% | (no 8B-instruct directly comparable in table) |
| Qwen3 Q8 LS/P (8B) vs Q4 OL/N (14B) |     95.7% |        96.3% | 14B by 0.6pt                                  |

Reasoning-oriented fine-tuning at 8B may produce better tool-calling discipline than scale alone at 14B. This matches the framework's "small models with structured choices > small models with open-ended choices" thesis.

**Reversal under bare conditions:** without the framework, the 14B _does_ sometimes win — Ministral 14B Reasoning bare scores 81.7% vs Ministral 8B Reasoning bare at 67.1%. So:

- **Bare:** larger model is more robust (14B > 8B by ~15pt)
- **With framework:** smaller, reasoning-tuned model wins (8B > 14B by ~3pt)

The framework levels reliability variance more than scale does. Once mechanical reliability is solved, fine-tuning quality matters more than parameter count.

**Implication.** Don't default to the largest model the GPU can hold. Test both sizes against the same scenarios; pick by reliability, not by parameter count. With consumer GPUs (12–32GB), the 8B-with-framework often dominates the 14B-with-framework while leaving headroom for KV cache and context.

---

## Finding 6 — Compaction Strategy Comparison

A 10-step sequential medical-investigation chain where each step's output feeds the next, but data from steps 1–2 is referenced by later steps throughout the workflow. Without budget pressure, baseline accuracy is **96%** — establishing that any failures under compaction are attributable to information loss, not model quality.

Three strategies tested at progressively tighter token budgets:

|                   Budget | None | Sliding Window |  Tiered |
| -----------------------: | ---: | -------------: | ------: |
| 3600 tokens (P1 trigger) |   0% |            58% | **76%** |
| 2200 tokens (P2 trigger) |   0% |            45% |     44% |
| 1536 tokens (P3 trigger) |   0% |            15% |     18% |

Three observations:

1. **Without compaction, every budget-constrained run fails entirely.** Context overflows, model errors out, workflow dies. No partial credit.
2. **Tiered beats sliding window by 18 points at moderate pressure** (P1). Tiered's advantage: it preserves the model's reasoning traces (interpretive context) while dropping the raw tool outputs that informed those conclusions. Sliding window drops the oldest messages indiscriminately — including the reasoning that later steps need to cross-reference early findings.
3. **At extreme pressure (P3), strategies converge** because there isn't enough room for even compressed reasoning.

**Implication.** Sliding-window compaction is easier to build but leaves real reliability on the table. The type-aware tiered strategy (drop nudges first, truncate tool results, preserve reasoning, last-resort drop reasoning) is the right default. Compaction has to know _what_ a message is, not just how old.

---

## Finding 7 — Speed vs Accuracy Is Not the Tradeoff People Think

The 99%-tier configs cluster at very different speeds:

| Config                    |  Score |    Speed |
| ------------------------- | -----: | -------: |
| Ministral 14B-I Q4 LS/N   |  98.8% | **3.5s** |
| Ministral 8B-R Q4 LS/N    |  99.3% |     3.7s |
| Haiku 4.5 (frontier API)  |  99.6% |     4.0s |
| Ministral 8B-R Q8 LS/N    |  99.2% |     4.6s |
| Sonnet 4.6 (frontier API) | 100.0% |     6.5s |
| Opus 4.6 (frontier API)   | 100.0% |     8.5s |
| Qwen3 14B Q4 OL/N         |  96.3% |    19.6s |
| Qwen3 8B Q8 LS/P          |  95.7% |    17.8s |

The top-tier local configs are **2× faster than the frontier API** at parity reliability (3.5–4.7s vs 6.5–8.5s for Sonnet/Opus). Qwen3 is slow not because of size — it's slow because of `thinking` mode generation overhead on llama-server (the `<think>...</think>` block adds tokens before the tool call).

**Implication.** Latency-sensitive deployments don't have a speed-vs-reliability dilemma. The Ministral configs are both faster _and_ nearly as accurate as frontier. The hard tradeoff is reasoning depth, not latency.

---

## The Closing Argument — "A Production AI Solution Is Not a Model"

From the paper's conclusion, paraphrased:

> An 8B model that scores 53% bare and 99% with the full framework is not two different models. It is the same model in two different systems. The 46-point gap is entirely infrastructure.
>
> The industry's focus on model capabilities obscures the degree to which orchestration infrastructure determines real-world performance. Claude Code is not Opus with a terminal — it is Opus embedded in a sophisticated harness of retry logic, context management, tool validation, and error recovery.

**Build-vs-buy reframe.** The choice between self-hosted and frontier should be driven by the _reasoning complexity of the target workflow_, not by concerns about tool-calling reliability. Reliability is a solved problem at the framework level — the empirical numbers above are the proof.

For our stack:

- **Workflows dominated by mechanical reliability** (multi-step retrieval, tool routing, validation chains, error recovery) — 8B local + framework is competitive with frontier and substantially cheaper / lower-latency / private.
- **Workflows dominated by reasoning depth** (open-ended planning, novel problem decomposition, code generation from sparse intent) — frontier still wins, framework or not.

Most real workflows are 70%+ mechanical with reasoning sprinkled in. That ratio is where the framework pays for itself.

---

## Numbers Worth Memorizing

For quick reference and for sanity-checking our own replication results:

| Metric                                                  |                   Number | Source                 |
| ------------------------------------------------------- | -----------------------: | ---------------------- |
| Per-step accuracy needed for 95% completion at 10 steps |                    99.5% | math                   |
| 8B + framework, hardest 10-step chain                   |                    99.3% | Ministral 8B-R Q4 LS/N |
| 8B bare, same chain                                     |                   53–67% | depending on model     |
| Improvement attributable to framework alone             |        **+32 to +46 pt** | finding 3              |
| Frontier (Haiku) bare drop                              |               100% → 44% | finding 3              |
| Frontier (Sonnet/Opus) bare drop                        |            100% → 87–89% | finding 3              |
| Error recovery scenario, any model bare                 |                   **0%** | finding 3              |
| Backend swing on Mistral-Nemo 12B                       | **75 pt** (7.2% → 82.6%) | finding 4              |
| Backend swing on Qwen3 14B                              |     8 pt (88.4% → 96.3%) | finding 4              |
| Tiered vs sliding compaction, P1 pressure               |               **+18 pt** | finding 6              |
| No compaction, any budget pressure                      |                   **0%** | finding 6              |
| Local 8B speed vs Sonnet at parity                      |           **~2× faster** | finding 7              |

---

## What This Means For Our Replication

1. **Build the framework first, then pick the model.** Most teams do this in the wrong order. The framework is the load-bearing piece. A wrong-framework setup makes the best models look mediocre; a right-framework setup makes 8B models look frontier.
2. **Pin the backend.** When we run our own evals, the config key must include `{model, backend, mode, ablation}`. Single-variable reports will mislead. The Mistral-Nemo 75-point backend swing is the reason.
3. **Build error recovery first.** It's the only guardrail where every model — local and frontier — drops to 0% without it. It's the highest-leverage single feature. Per-step accuracy in error scenarios goes from 0 → 99 with the right retry semantics.
4. **Build tiered compaction, not sliding.** 18 points of reliability lift at moderate pressure, free.
5. **Don't default to the biggest model.** 8B with the framework often beats 14B with the framework on consumer GPUs, while leaving VRAM for KV cache and context.
6. **Expect 95% → 99% to be expensive.** The headline 99% comes from stacking all guardrails. Each individual layer is worth a few points; the value is in the stack.
7. **Measure with McNemar.** Single-config eval numbers without significance testing are guesses. The paper's findings are credible because the harness pairs runs by `(scenario, run_index)` across ablations and tests significance properly. Replicate the harness, not just the framework.

---

## Citations

Preprint:

> Zambelli, A. _Closing the Agentic Reliability Gap Between Self-Hosted and Frontier Language Models._ IEEE preprint, 2026.

Related work cited by the preprint:

- Yao et al. (2023) — ReAct, ICLR
- Schick et al. (2023) — Toolformer, NeurIPS
- Patil et al. (2025) — Berkeley Function Calling Leaderboard (BFCL), ICML
- Jiang et al. (2023) — Mistral 7B
- Yang et al. (2025) — Qwen3 Technical Report
- Touvron et al. (2023) — LLaMA

The companion document `next-steps.md` covers the technical mechanism behind each finding — what each guardrail does, the algorithm, and the small-model failure mode it removes.
