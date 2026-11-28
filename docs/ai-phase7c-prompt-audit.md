# Phase 7C — prompt consumption audit

The prior production benchmark has actual provider input totals, but no retained prompt snapshots or provider-issued section-level token counts. Do not reconstruct historical section totals or log raw prompts.

The audit measures the final message content after all existing projection, compaction, fitting and streaming configuration. The original provider request, billing, permissions, model, token caps and public API response remain unchanged.

| Category | Exact UTF-8 byte definition |
|---|---|
| System | Whole system-message string |
| Question, history, knowledge, account | Canonical serialized value of each top-level field (null has no category bytes) |
| Candles | Closed tuples, active candle and column definitions |
| Analysis | Observations, advanced evidence, price context, quote range location and deterministic sizing |
| Quote/session | Quote, quote status, clocks, ranges and historical day references |
| Calendar | Economic calendar snapshot |
| Instrument | Instrument specifications |
| Metadata | Remaining content bytes including keys, separators, quality, coverage, freshness, projection markers, null markers and shared limitations |

The categories sum exactly to actual message-content bytes. Full JSON wire bytes and response schema bytes are separately measured; JSON wire escaping and request options are not equivalent to model tokens. The provider-reported aggregate input/output token counts remain the authority for actual usage. The offline script produces a **byte-weighted token proxy**, not actual per-section tokenizer counts. Density varies across prose, numbers, JSON and languages; provider framing/schema overhead is not independently attributable. Never label the proxy as precise token usage or use it as a billing estimate for a section.

Completion logs record only fixed numeric counts and a bounded server-selected profile. No prompts, answers, prices, symbols, account values, identifiers, credentials, or new egress are recorded. Audit measurement failure does not block authorized generation; missing audit records are counted separately.

## Production acceptance

After the acceptance workflows pass and deployment succeeds, use an authorized staff workspace to submit ordinary operator-selected questions, covering fresh structure, in-thread BOS/FVG/liquidity, a genuine follow-up and account risk. No automatic retries or additional provider calls. Record the actual projected profile, exact content bytes, provider input tokens and counts. Report each category's byte share separately from the proxy. Compare like-for-like profiles, not unrelated snapshots. Do not change prompts or compress further until the measurements have been reviewed.

Run the offline script on sanitized flattened completion records:

`node scripts/ai-workspace-prompt-audit.js sanitized-completions.json`

Previous completion records without versioned audit fields are intentionally excluded from the breakdown.
