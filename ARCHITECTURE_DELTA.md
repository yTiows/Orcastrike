# ARCHITECTURE_DELTA

What changes compared with the v1 build (commit `bb64dbe`), why, what current APIs make impossible,
and where the new requirements contradict existing rules.

## Starting point (inspected 2026-09-28)

- Static browser app (`index.html`, `js/`, `ui/`) with integer-cent money math, a FIFO whole-lot
  localStorage ledger, tiers/position/stop-loss/circuit breaker, a scanner with calculation
  trace, events, and a Steam-only historical simulation.
- Cloudflare Worker (`worker/index.js` → `worker/lib.js`): stateless GET proxy with per-isolate
  cache. Verified running under workerd; never deployed.
- 65 passing tests, ESLint clean, secret scan passing. Dev dependencies: eslint, @eslint/js,
  globals, wrangler. No runtime dependency except Chart.js from CDN.
- Upstream parsers never verified against live data (build egress blocked).

## Target pipeline

```
raw observation ─► normalizer ─► validator ─► snapshot ─► data quality layer ─► opportunity engine
   (daemon/http)    (parsers)    (quality)   (grouping)   (quality events,       (defined math,
                                                           coverage)              traces, ranking)
                                                                                      │
                          ┌──────────────────────────┬────────────────────────────────┤
                          ▼                          ▼                                ▼
                     live signal               paper trade                    research outputs
                          └──────────────► evidence engine (gates) ◄──────────────────┘
                                                     │
                                          human / automation permission
```

Each stage is its own module and has a versioned contract in `daemon/contracts.js`: request,
response, required fields, types, units, error schema.

| Stage | Module | Contract |
|---|---|---|
| Raw observation | `daemon/http-client.js` | `raw_observation@1` |
| Normalizer | `daemon/normalize.js` (parsers from `worker/lib.js` + `daemon/parsers.js`) | `normalized_observation@1` |
| Validator + quality state | `daemon/validate.js` | `validated_observation@1` |
| Snapshot grouping | `js/research/snapshot.js` (pure, shared) | `snapshot_group@1` |
| Data quality layer | `daemon/quality.js` | `data_quality_event@1`, `coverage_report@1` |
| Opportunity engine | `js/research/opportunity.js` (pure) + `daemon/engine.js` | `opportunity@1` |
| Paper trades | `daemon/paper.js` | `paper_trade@1` |
| Evidence engine | `js/research/evidence.js` (pure) | `evidence_report@1` |
| Permission | `js/research/automation.js` (pure) | `permission_decision@1` |

## What changes and why

| Change | Why |
|---|---|
| **New local daemon** (`daemon/`, Node 22, `node:sqlite`, `node:http`), bound to `127.0.0.1`. It serves the static UI **and** the JSON contract from one origin. | Continuous sampling, append-only history and paper trading need a long-running process with storage. Serving the UI from the same origin avoids CORS, Private Network Access and mixed-content problems, and keeps localhost write endpoints CSRF-safe via exact Origin/Host checks. |
| **SQLite via built-in `node:sqlite`** | No native build and no new dependency. Trade-off: the module is flagged experimental in Node 22 (warning printed); pinned by `engines.node >=22` and wrapped in `daemon/db.js` so it can be swapped. |
| Worker kept as a thin fallback | Pages-hosted UI still works without the daemon (Level 0–1 only). |
| Append-only observations with triggers that abort UPDATE/DELETE | "Never overwrite an observation." The only permitted update is purging a raw payload after retention. |
| Opportunity engine in the daemon, pure math in `js/research/` | The same code runs in tests, the daemon and the browser. |
| Old scanner kept, relabeled "Level 1: observed cross-market discrepancy" | Preserves working code. It never shows ESTIMATED figures. |
| Ledger → IndexedDB, partial-lot FIFO splitting, reserved cash, receipts, strategy_version tags | Required. Accounting rules (banking, Steam Wallet separation, breaker) are kept. |
| Fee model versions + calibration proposals | Constants change only after the user accepts a proposal. |
| Evidence engine with three gates; the existing 30-flip gate renamed EXECUTION_EVIDENCE (real trades only) | Required (conflict C2). |
| UMBRA = ranking mode + theme only; automation ladder L0–L3 as separate settings, default OFF | Required (conflicts C1, C3). |

## Impossible or unverified with current APIs (isolated, not implemented as working features)

| Feature | Blocking data | Behavior |
|---|---|---|
| `buyer_side_liquidity` | CSFloat buy-orders endpoint unverified (matrix #17) | Always `UNVERIFIED`; never gates or ranks |
| Velocity on a CSFloat exit leg | CSFloat sales endpoint unverified (#18) | `INSUFFICIENT` → `estimated_exit_days = UNKNOWN` → excluded from ranking |
| ±10% supply on Skinport | Not exposed (#10) | `listing_supply` UNAVAILABLE for Skinport |
| Instant-sale reference quote | No documented source (#21) | Shows UNAVAILABLE with reason |
| L2 user-approved execution, L3 automated execution, L3 auto-reprice | CSFloat purchase/listing APIs unverified (#19, #20) | Settings exist, default OFF. L2/L3 can't be enabled: "UNVERIFIED: no verified execution API". The permission controller, kill switch and STOP logic are implemented and tested with a SYNTHETIC mock executor only. |
| Pattern-premium amounts (Case Hardened, Fade, Marble Fade) | No citable numeric source | Premium is always UNKNOWN and never enters profit. Doppler **phase identity** (paint index 415–421) is KNOWN from a cited source, but only listing-level CSFloat data (unverified) carries paint index. |
| Synchronized cross-market "backtest" | No historical listing data for CSFloat/Skinport | Label reserved. It activates only once the daemon's own synchronized snapshots meet the sample minimums. |
| Market regime coverage | Undefined metric | Reported as `UNKNOWN`; never claimed |
| Push notifications (ntfy) | Requires Phases 0–5 verified; Phase 0 is BLOCKED | Not implemented (BLOCKED). In-app notifications only. |

## Contradictions with existing rules (resolved in DECISIONS.md)

- **C1** "no auto buy/sell" vs automation levels → a separately gated tier, default OFF. L2/L3 are
  also unimplementable without a verified API.
- **C2** 30-flip gate vs paper trades → renamed EXECUTION_EVIDENCE, real trades only.
- **C3** watchlist-only discovery vs full market → watchlist stays the standard-mode universe;
  full-market universe applies to UMBRA ranking only.
- **C4** Steam fee → keep the conservative 15%-of-gross default, show Valve's exact result
  beside it, and change it only through an accepted calibration proposal.
- **C5** P0-8 ("never phrase as expected margin") vs the new defined metric
  `expected_net_profit` → the metric keeps its defined identifier but is always displayed as
  "expected_net_profit (ESTIMATED, pessimistic, not a forecast)". Historical simulation never
  feeds it. The secret scan's wording rule stays.
- **C6** v1 "no partial-lot sales" (a documented limitation, not a P0 rule) vs FIFO partial-lot
  splitting → replaced; FIFO order and whole-ledger replay validation are kept.
- **C7** existing position-size formula (15% of deployable, exposure, reserve) vs new sizing
  (20% of capital at cost, velocity cap) → both apply, and the smallest wins.
- **C8** v1 listing-depth gate (MIN_LISTING_DEPTH) vs the new rule "liquidity is a gate via
  observed sale velocity" → the Level 1 scanner keeps its depth gate; the opportunity engine
  gates on exit-market velocity and reports `listing_supply` as a label only.

## Daemon placement

Measured with `scripts/netcheck.mjs` (4 source hosts, 2 samples each, 5s spacing):

| Candidate | Result | Report |
|---|---|---|
| Build container (this session) | **UNSUITABLE**: all four source hosts return 403 from the egress proxy | `reports/netcheck/2026-09-28T03-04-07-458Z.json` |
| User's local machine | **UNVERIFIED**: run `NETCHECK_LABEL=local node scripts/netcheck.mjs` | — |
| Small VPS | **UNVERIFIED**: run `NETCHECK_LABEL=vps node scripts/netcheck.mjs` | — |

**Decision (provisional, UNVERIFIED):** run the daemon on the **local machine**. It's the only
candidate needing no new infrastructure, it keeps the SQLite ledger evidence on user hardware,
and it avoids datacenter IP ranges, which Steam's community endpoints are widely reported to
throttle harder (a community report, not verified here). Switch to a VPS only if its netcheck
reports `SUITABLE` and the local one doesn't. One daemon, one IP, one account per marketplace; no
proxy rotation or multi-account sampling. Token buckets per host stay below the documented limits
(DATA_SOURCE_MATRIX.md).
