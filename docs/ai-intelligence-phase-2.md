# Phase 2 — Intelligence & Quality Engine

## Product contract

All supported capabilities remain available without a mandatory subscription. Compute will be funded by the user's API allowance or prepaid credits (Phase 3). No model provider or AI inference is introduced here. Phase 1 authorization, financial safety, governance, and default-off activation are unchanged. The system does not establish a profitable edge merely by calculating market features.

## Phase 2A: offline evidence and deterministic facts

The existing backend uses MarketHistoryService, canonical UTC history for D1/W1, a candle engine with complete/synthetic/source/provider fields, QuoteStore, instrument schedules, and a shared decimal implementation. Reuse these contracts, not screenshot inference or a second market feed. The market history path can perform provider fetches and local fallback; future integration must explicitly resolve identity, freshness and entitlement before consuming it.

New pure modules under src/modules/ai/intelligence:
- candle-evidence: bounded 256-bar strictly chronological input with exact symbol/timeframe, explicit closure/synthetic state, valid OHLC, known source/provider labels, as-of timestamp and hash. Exclude synthetic and incomplete bars, fail on malformed eligible bars. Segment at missing intervals and provider transitions. No invented data or implicit bridging. Historical session gaps are not classified as valid closures in this increment. A recent closed candle is not a fresh executable quote. Provenance labels and content hashes are not proof of authentic origin.
- market-facts: last closed price, range high/low on the final contiguous segment, 20-close SMA, simple mean true range over 14 periods (not Wilder ATR), latest confirmed strict two-left/two-right high/low pivots, latest strict three-bar wick gap geometry. Arithmetic uses existing decimal helpers; averaging rounded to 12 decimal places. Pivots only confirmed after right-hand bars close. Gap direction is geometry, not mitigation, institutional activity, entry quality or a forecast. No liquidity sweep, BOS/MSS, strategy recommendation or backtested edge yet.
- fact-verifier: recompute from the same trusted server input and accept only exact typed evidence/fact/value references. Reject unknown, altered, duplicated or cross-snapshot claims. Returned facts include original deterministic metadata. It does not verify natural language, subjective interpretation, forecasts, or omitted context. No cryptographic signature, database record, network access, public route, provider, tool registry changes or execution permission.

The input is internal trusted-server data, not a model-supplied envelope. Must not expose these functions directly via HTTP/MCP. Snapshot IDs include the as-of timestamp; reuse a pinned immutable input when comparing claims, and use a separate freshness check at presentation time. The module is not yet connected to market runtime; schedule and complete coverage validation, data licensing, and quote freshness remain unresolved. This conservative version deliberately stops indicators at any gap, even a legitimate market closure. Initial methodology and thresholds are proposed engineering defaults subject to review and benchmark.

## Remaining Phase 2 sequence

2B. Trusted context assembly: canonical symbol identity, calendar/session and expected-bar coverage, authoritative quote freshness, read-only source adapters, explicit account/workspace scope, bounded multi-timeframe snapshots, evidence retention/expiry and provenance checks. Do not make provider requests as a side effect of untrusted model input. Extend Phase 1 allowlists only after dedicated acceptance.
2C. Versioned feature library: liquidity references, confirmed BOS/MSS and sweep definitions, gap mitigation/invalidation, session ranges, common indicators and cross-timeframe context. Separate objective facts from methodology-dependent interpretations. Test using causal replay and labelled datasets; no lookahead.
2D. Knowledge/prompt assembly: curated versioned references with source permissions, untrusted content boundaries, context budget, strategy/version selection, prompt injection resistance, no credentials.
2E. Verification and response: numeric/risk checks using authoritative engines, data freshness, evidence completeness, contradiction detection, claim-to-fact linkage, distinguish interpretation and uncertainty, no unsupported recommendation/execution.
2F. Evaluation: versioned golden datasets and adversarial cases; replay without future leakage, measured feature accuracy, abstention, calibration, tool/claim correctness; separate predictive research and cost/latency evaluation; no claims of trading profitability. Define acceptance thresholds before benchmarking.
2G. Integration, isolated acceptance and deployment disabled. Verify regressions, failure modes, limits and live source entitlement; active AI requires separate gates.

Phase 2A acceptance: deterministic fixtures, evidence reproducibility, exclusions, malformed inputs, no future closed bars, no gap bridging, no unconfirmed pivots, explicit limitation labels, exact structured claim verification. Run fresh CI; no production change.
