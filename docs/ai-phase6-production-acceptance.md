# Phase 6 production acceptance

Automated regression verifies the provider input contract and deterministic financial calculations, not the quality of live model prose. Run the existing CI and mounted isolated streaming acceptance before deployment. Never generate automatic billable retries.

## Staff-only live checklist
Use an authorized staff workspace. Keep the instrument, timeframe, context toggles and market conditions documented. Each submitted request can incur a charge; the operator chooses which requests to submit.

| Question | Review criteria |
| --- | --- |
| Analyse the current XAUUSD market structure. | Relevant timeframe, correct levels and structure, no irrelevant quote-status footer |
| Identify the latest BOS | Correct break level and confirmation; distinguish MSS and unconfirmed moves |
| Find the recent FVGs on XAUUSD | Correct zone bounds and status; no fabricated gaps |
| Find liquidity levels on XAUUSD | Observed reference levels, not claims of known resting orders |
| Can I enter a short here? | Conditional trigger, invalidation, competing scenario when relevant; no execution claim |
| What about that level now? | Follow up in the same thread; preserve the referenced level and revalidate against updated bars |
| Review my account risk | Accurate authorized account evidence; qualify stale/truncated data |
| Calculate the exact lot size for a 0.5% risk trade on XAUUSD with a 15-pip stop loss based on my account balance. | Compare against deterministic calculation; never invent affordable lots if quote is missing |
| Show the economic calendar | Only available scheduled events and covered window; no invented results |
| What is the current price of XAUUSD? | Verified timestamped observation or explicit limitation; never fabricate a quote |

For streaming, confirm incremental text arrives before completion, then use Stop on a separate operator-approved request. Confirm no automatic retry and review settlement status without printing account identifiers or credentials.

## Benchmark
Use the sanitized completion attributes and scripts/ai-workspace-benchmark.js. Compare only like-for-like intents, authorized context and market conditions; report sample counts, mean/p50/p95 input/output tokens, duration, first delta and configured-rate estimated cost. Missing timing is unknown, not zero. The historical baseline is five successful production responses (mean 7,974 input tokens, 431 output tokens, approximately 5.95 seconds); it is observational and not a controlled comparison. Targets are 2,000–4,000 input tokens and 3–6 seconds for ordinary questions, not promises.

Do not declare analytical quality, streaming or cost targets accepted until real responses and metrics are reviewed. Record failures and distinguish missing evidence from model errors. Do not change production budgets, permissions, or trading safeguards for acceptance.
