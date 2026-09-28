# EVIDENCE

How a strategy earns trust, what each gate requires, and where things stand. The system
promotes a strategy only when evidence supports it. Until then the correct output is **no
opportunity**.

## Current status (2026-09-28)

| Level | Name | Status | Why |
|---|---|---|---|
| 0 | observed data | **NOT_REACHED** | No parser is VERIFIED against a LIVE fixture (every source was unreachable from the build environment). |
| 1 | observed cross-market discrepancy | **NOT_REACHED** | No COMPLETE, non-synthetic snapshot group exists. |
| 2 | simulated or historical evaluation | **NOT_REACHED** | No replay of synchronized historical cross-market data; the "backtest" label is reserved. The Steam-only simulation is Level-2 *context* for single-market drift only and doesn't reach this level (BACKTEST_RESULTS.md). |
| 3 | forward paper trading evaluation | **NOT_REACHED** | SIGNAL_EVIDENCE fails (0 paper trades, 0 days of observation). |
| 4 | real execution evidence | **NOT_REACHED** | EXECUTION_EVIDENCE fails (0 versioned REAL trades). |
| 5 | strategy validation | **NOT_REACHED** | Both gates fail. |
| 6 | automation | **NOT_REACHED** | No verified execution API; L2/L3 can't be enabled. |

Market regime coverage: **UNKNOWN**. The metric isn't defined and is never claimed.

Nothing here supports a claim that any strategy is profitable, validated or supported.

## Rules

- **No inheritance.** Each level is decided only by evidence of its own kind
  (`js/research/evidence.js: evidenceLadder`). Passing SIGNAL_EVIDENCE says nothing about
  Levels 0–2 or 4.
- **Paper never counts as real.** `executionEvidence` throws if a paper trade is passed in.
  Paper and real statistics are separate objects, rows and endpoints (`/api/v2/paper-trades`,
  `/api/v2/real-trades`) and are never pooled.
- **SYNTHETIC never counts.** Rows produced against a SYNTHETIC upstream are flagged, excluded
  from every gate, and can't become ELIGIBLE (their parsers are never VERIFIED).
- **Per strategy_version.** A strategy_version is a hash of every parameter that changes what
  counts as an opportunity or how it is sized (`strategyParams`). Changing any of them starts
  evidence from zero.

## Gates

| Gate | Requirement (all must hold) | Implementation |
|---|---|---|
| **SIGNAL_EVIDENCE** | ≥ 30 completed (CLOSED, non-synthetic) paper trades of this strategy_version; ≥ 14 days since the first non-synthetic observation; for each of the last 14 complete UTC days and each contributing source (steam, csfloat, skinport, fx), snapshot coverage ≥ 80% of the feasible expected requests; no unresolved HIGH-severity data-quality event | `signalEvidence` |
| **EXECUTION_EVIDENCE** (was the v1 "30-flip gate"; real-only semantics kept) | ≥ 30 completed REAL trades recorded in the ledger and synced, under this strategy_version | `executionEvidence` |
| **STRATEGY_VALIDATION** | Both gates pass under the same strategy_version. Reported separately by marketplace and by holding period (`<7d`, `7–13d`, `14–29d`, `≥30d`), paper and real apart. | `strategyValidation` |

Coverage means OK, non-synthetic requests per source per day ÷ min(configured demand,
rate-limit capacity). It doesn't mean the data was correct or the market liquid.

## Forward paper trading evaluation (not a "backtest")

**Sample selection rule, stated before any result:** every opportunity that is rank-eligible
(complete, fresh, verified snapshot group; defined math; positive `expected_net_profit`;
liquidity gate passed; minimum filters or UMBRA floor) under a strategy_version, while the
daemon runs in PAPER mode or UMBRA autopilot, opens one 1-unit paper trade. At most one is OPEN
per item, buy market, sell market and strategy_version. There is no selection by outcome.

**Pessimistic fills:**
- **Entry:** the observed ask plus buy-side fees.
- **Exit:** the first COMPLETE exit-market quote at or after the planned close (hold_days later)
  within a 24h grace, ×(1 + entry-time hold_adverse_move). The adverse-move haircut is applied
  again on purpose, which is conservative. Then fees per the fee model in force at close, then
  the entry-time reversal reserve.
- **VOID:** no fresh exit quote in the grace period, or the exit parser is UNVERIFIED. VOID
  trades are excluded from the gate and reported.

## The five profit figures

These are never summed or merged (`js/research/profit-figures.js`, definitions in
`js/research/semantics.js`):

| Figure | Category | Source |
|---|---|---|
| REALIZED_NET_PROFIT | REAL | ledger trades |
| PAPER_NET_PROFIT | PAPER | daemon paper trades (CLOSED only) |
| HISTORICAL_SIMULATED_PROFIT | SIMULATED | Steam-only simulation loaded in the session |
| MARK_TO_MARKET_UNREALIZED_PNL | OBSERVED | open lots at the depth-qualified lowest cash ask (lower bound when lots are unvalued) |
| ESTIMATED_EXIT_PROFIT | ESTIMATED | daemon pessimistic exit per open lot; UNKNOWN without hold_adverse_move |

## Kelly

ADVISORY display only. Disabled until ≥ 30 completed REAL trades exist under the current
strategy_version. Computed from real results only, at a 0.25 fraction, capped at the 20% per-item
cap. It never sizes an order.
