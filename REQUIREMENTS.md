# REQUIREMENTS — traceability

One row per requirement. Status:

- **PASS**: implemented, and the named test or audit passes in this build.
- **FAIL**: implemented, but a test or audit fails.
- **UNVERIFIED**: implemented and tested against SYNTHETIC or mock inputs only. Needs live data or an environment not available here.
- **BLOCKED**: can't be done in this environment. The row says what it needs.

Test names are literal `test("…")` titles unless a file is named. "Browser smoke" is `scripts/browser-smoke.mjs` (real Chromium against a real daemon with a SYNTHETIC upstream; 44 checks; report in `reports/browser-smoke/report.json`).

## v1 (spec v3, 2026-09-27; statuses re-checked 2026-09-28)

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | P0-1 | No auto-execute/buy/sell; only after-the-fact "record buy/sell" | ui/ledger-view.js, js/ledger.js, worker/lib.js (GET-only, no trade endpoints) | tests/worker.test.js (non-GET rejected, no trade routes); tests/ledger.test.js |
| PASS | P0-2 | No Steam cookies / credentials / Mobile Authenticator data anywhere | worker/lib.js (anonymous Steam requests only) | tests/worker.test.js (no Cookie header sent upstream); scripts/secret-scan.mjs |
| PASS | P0-3 | CSFloat key server-side only (Worker secret) | worker/lib.js, wrangler.toml, .env.example | tests/worker.test.js (key never in body/headers; NOT_CONFIGURED without key); scripts/secret-scan.mjs |
| PASS | P0-4 | Never fabricate prices/liquidity/history/trades; missing → INSUFFICIENT_DATA/UNAVAILABLE | js/scanner.js, worker/lib.js, js/backtest.js, js/events.js | tests/scanner.test.js, tests/worker.test.js |
| PASS | P0-5 | Steam Wallet separate, never in cash/deployable | js/ledger.js | tests/ledger.test.js "Steam Wallet separation" |
| PASS | P0-6 | Integer USD cents; EUR→USD at ingestion | js/money.js, worker/lib.js | tests/money.test.js, tests/worker.test.js (Skinport ingestion) |
| PASS | P0-7 | Single-market sim never labeled as cross-market evidence | js/backtest.js, ui/scanner-table.js, BACKTEST_RESULTS.md | tests/scanner.test.js (backtest labels) |
| PASS | P0-8 | Historical margin never phrased as expected/forecast | js/backtest.js, ui/* | tests/scanner.test.js (label text); grep audit for "expected margin" |
| PASS | P0-9 | No secrets in tracked files/history/client/responses/logs | scripts/secret-scan.mjs, .gitignore, worker/lib.js | secret scan run (Step 11); tests/worker.test.js |
| PASS | P0-10 | Show nothing rather than a false positive | js/scanner.js | tests/scanner.test.js |
| PASS | F-BAL | Balance definitions (cash, banked, wallet, inventory, deployable) | js/ledger.js | tests/ledger.test.js |
| PASS | F-REINV | Reinvestment rule (30% banked at ≥ $100; losses never reduce banked; explicit redeploy) | js/ledger.js | tests/ledger.test.js |
| PASS | F-POS | Position-size formula + BLOCKED_BY_POSITION_SIZE | js/tiers.js, js/scanner.js | tests/tiers.test.js "position eligibility" |
| PASS | F-RISKCFG | Risk config defaults + override validation | config/defaults.js, js/state.js | tests/tiers.test.js |
| PASS | F-STOP | Stop-loss flag (informational only) | js/tiers.js | tests/tiers.test.js |
| PASS | F-CB | Circuit breaker (gross 24h loss ≥ 10%; timestamp persistence) | js/tiers.js, js/ledger.js, js/state.js | tests/tiers.test.js "circuit breaker persistence" |
| PASS | F-TIER | Tier table, boundary convention, price bands | js/tiers.js, config/defaults.js | tests/tiers.test.js "tier boundary" |
| PASS | F-VAL | Inventory valuation (lowest depth-qualified listing; else INSUFFICIENT_DATA) | js/scanner.js, js/ledger.js | tests/scanner.test.js, tests/ledger.test.js |
| PASS | F-HOLD | minimum_hold_until = buy + 7d; live countdown | js/ledger.js, js/format.js, ui/ledger-view.js | tests/ledger.test.js |
| PASS | F-ID | Canonical identity = exact market_hash_name | worker/lib.js, js/scanner.js | tests/worker.test.js (CSFloat name mismatch → excluded) |
| PASS | F-FIFO | FIFO accounting. **Superseded by v2 (C6):** partial-lot splitting across lots; v1 whole-lot ledgers migrate losslessly | js/ledger.js | "FIFO across lots with partial-lot splitting (v2)"; "v1 ledgers migrate losslessly to v2 (whole-lot trades → allocations, unversioned)" |
| PASS | F-LEDGER | Ledger schema; labeled user-recorded; export/import JSON | js/ledger.js, ui/ledger-view.js | tests/ledger.test.js (round-trip, invalid import rejected) |
| PASS | F-WATCH | User watchlist, cap 100, starter list | js/state.js, static/watchlist-starter.json | tests/scanner.test.js (cap) |
| PASS | F-DEPTH | listing_depth ±10% window, MIN_LISTING_DEPTH, supply-side label | worker/lib.js, js/scanner.js, ui/scanner-table.js | tests/worker.test.js, tests/scanner.test.js |
| PASS | F-ELIG | Eligibility enum, exactly one per opportunity | js/scanner.js | tests/scanner.test.js |
| PASS | F-TRACE | Expandable calculation trace per row | js/scanner.js, ui/scanner-table.js | tests/scanner.test.js (trace fields) |
| PASS | F-SANITY | Input sanity validation → INVALID, no NaN | js/scanner.js, js/money.js | tests/scanner.test.js, tests/money.test.js |
| PASS | F-FEES | Fee constants + canonical cents formula | config/fees.js, js/money.js, FEES.md | tests/money.test.js "CSFloat fee-adjusted margin" |
| PASS | F-FX | EUR→USD via cited free source, 1h TTL, STALE/UNAVAILABLE | worker/lib.js | tests/worker.test.js |
| PASS | F-FRESH | Freshness gating (mixed → INSUFFICIENT_DATA) | js/scanner.js | tests/scanner.test.js "data freshness gating" |
| PASS | F-WORKER | Canonical schema, cache keys, TTLs, 8s timeout, 429 → RATE_LIMITED, header stripping | worker/lib.js | tests/worker.test.js |
| PASS | F-EVENTS | Event schema, source_url + retrieval_date, delta methodology | js/events.js, static/events.json, ui/events-view.js | tests/scanner.test.js (event validation + delta) |
| PASS | F-BT | Backtest (a)/(b) distinction; verdict; pre-registered sample; ≥30 flips gate | js/backtest.js, js/tiers.js, BACKTEST_RESULTS.md | tests/tiers.test.js (≥30 gate), tests/scanner.test.js |
| PASS | F-UI | Full frontend; Chart.js pinned + SRI; chart failure isolated | index.html, ui/*, styles.css | Browser smoke 2026-09-28: CDN blocked → table fallback, no console/CSP errors, no horizontal overflow at 1280 and 390 px on every tab. (SRI acceptance with the CDN served was verified in the 2026-09-27 smoke run; the CDN is unreachable from this container.) |
| PASS | F-TS | ISO 8601 UTC timestamps everywhere | js/ledger.js, worker/lib.js | tests/ledger.test.js, tests/worker.test.js |
| PASS | OPS-TEST | Full suite from clean checkout + lint | package.json | Clean-clone run 2026-09-28 (see Final state) |
| PASS | OPS-SEC | Pre-deploy security audit | scripts/secret-scan.mjs | `npm run audit:secrets`, also run inside `npm test` (tests/security.test.js) |
| BLOCKED | OPS-DEPLOY | Worker + Pages deployed | wrangler.toml, package.json | Step 12 — **BLOCKED**: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` absent and api.cloudflare.com unreachable from the build container. Bundle verified with `wrangler deploy --dry-run`; Worker verified running under `wrangler dev` (workerd). |
| BLOCKED | OPS-SMOKE | Production smoke test (Steam + Skinport; CSFloat NOT_CONFIGURED assertion) | PLAN.md runbook | Step 13 — **BLOCKED** (depends on OPS-DEPLOY). Local workerd run confirmed: health OK, CSFloat → NOT_CONFIGURED, Steam/Skinport fail closed to UNAVAILABLE under the build egress block, POST → 405. |

## v2: research and evidence system (2026-09-28)

### P0 invariants (added; every v1 P0 row above still holds)

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | V2-P0-1 | Integer cents; fail closed on invalid/stale/conflicting/unavailable data; INSUFFICIENT_DATA never shown as a deal | js/money.js, js/research/snapshot.js, js/research/opportunity.js, js/scanner.js | "unverified parser → INSUFFICIENT (PARSER_UNVERIFIED), even with perfect data"; "D-38: quotes from UNVERIFIED parsers or SYNTHETIC sources never enter a calculation"; "engine: SYNTHETIC data with UNVERIFIED parsers never yields an ELIGIBLE opportunity"; browser smoke "research: SYNTHETIC/UNVERIFIED data never ELIGIBLE" |
| PASS | V2-P0-2 | No secrets in repo/client/logs/fixtures/screenshots/docs; no inline styles (CSP); no Steam credentials | scripts/secret-scan.mjs, daemon/redact.js, daemon/contract.js, daemon/server.js (CSP header) | tests/security.test.js (secret scan incl. daemon logging, database and backup files; CSP; loopback bind); "redaction scrubs env secrets and credential shapes"; "sanitization removes seller identity and credential-like keys"; "secrets never leave the daemon; write guards hold". Screenshots contain SYNTHETIC data only and are git-ignored. |
| PASS | V2-P0-3 | Never fabricate; blocked endpoints UNVERIFIED with the exact local command; SYNTHETIC labeled and never evidence | scripts/contract_test.mjs, daemon/verification.js, daemon/http-client.js | "latest CONTRACT_REPORT is recorded and honest about BLOCKED endpoints"; "upstream override is refused unless synthetic and loopback"; "evidence report over HTTP: SYNTHETIC runs reach no evidence level; regime coverage UNKNOWN"; browser smoke "research: SYNTHETIC label on rows" |
| PASS | V2-P0-4 | Observed/estimated/simulated/paper/real separate; five separate profit figures | js/research/semantics.js, js/research/profit-figures.js, ui/dashboard.js | "five profit figures stay separate; missing inputs are UNAVAILABLE, never zero-filled"; "ACCEPTANCE 10: paper and real trades are reported in separate rows with separate statistics"; browser smoke "dashboard: five separate profit figures" |
| PASS | V2-P0-5 | No ladder level inherits evidence from a lower level | js/research/evidence.js | "evidence ladder: no level inherits from a lower one" |
| PASS | V2-P0-6 | No mode, theme or setting grants execution; UMBRA is ranking + theme only | js/research/automation.js, js/research/umbra.js, config/settings-schema.js | "production build: no verified execution API; L2/L3 unavailable"; "research settings: dangerous combinations warn; L2/L3 and AUTOMATION rejected"; "control API: L2/L3 rejected; …"; browser smoke "UMBRA: rows evaluated, and the mode grants no eligibility" |
| PASS | V2-P0-7 | Execution default OFF; conflicts resolved for P0 and logged | config/settings-schema.js (`automation.level` = L0), DECISIONS.md C1–C8 | "production build: no verified execution API; L2/L3 unavailable"; DECISIONS.md review |

### Phase 0: reality check

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | PH0-CONTRACT | Contract test: calls live endpoints, stores sanitized LIVE fixtures with retrieval time, diffs against every parser | scripts/contract_test.mjs, daemon/contract.js | "shape diff reports missing fields and type mismatches"; "sanitization removes seller identity and credential-like keys"; ran 2026-09-28 (CONTRACT_REPORT.json) |
| BLOCKED | PH0-LIVE | Live endpoints verified | tests/fixtures/live/CONTRACT_REPORT.json | Every endpoint HTTP 403 from the build container's egress proxy. Needs: `node scripts/contract_test.mjs` (optionally with `CSFLOAT_API_KEY` in the environment) on a normal network. "LIVE fixtures pass their parsers" is skipped until then. |
| PASS | PH0-MATRIX | DATA_SOURCE_MATRIX.md with every required column and source | DATA_SOURCE_MATRIX.md | Document review (24 rows; nothing VERIFIED) |
| PASS | PH0-DELTA | ARCHITECTURE_DELTA.md: changes, reasons, impossibles, contradictions | ARCHITECTURE_DELTA.md | Document review |
| UNVERIFIED | PH0-PLACE | Daemon placement decided by measurement | scripts/netcheck.mjs, reports/netcheck/ | The container measured UNSUITABLE (all 403). Local machine is the provisional choice (D-39). Needs: `node scripts/netcheck.mjs` on the target machine. |

### Architecture, data model, sampling

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | ARCH-PIPE | Pipeline stages as separate modules with explicit, versioned contracts | daemon/http-client.js → daemon/sources.js → daemon/validate.js → js/research/snapshot.js → daemon/quality.js → daemon/engine.js → daemon/paper.js → js/research/evidence.js → js/research/automation.js | tests/daemon.test.js pipeline tests; tests/integration.test.js |
| PASS | ARCH-DAEMON | Daemon (Node, SQLite) is the primary data plane; serves the Worker's JSON contract on localhost; Worker stays as fallback | daemon/main.js, daemon/api.js | "UI contract: v1 quotes come back in the canonical schema, flagged synthetic and UNVERIFIED"; "regression: the v1 Worker health probe is served when the daemon hosts the UI"; "daemon binds to loopback only" |
| PASS | ARCH-DEPS | Every dependency has a documented reason | package.json, PLAN.md | No new runtime dependency: SQLite is Node's built-in `node:sqlite`. Playwright is used from a global install by `scripts/browser-smoke.mjs` only. |
| PASS | DM-TABLES | Required tables; observations append-only; versioned migrations | daemon/db.js | "migrations are versioned and idempotent"; "observations are append-only: UPDATE and DELETE abort"; "paper trades may only transition OPEN → CLOSED/VOID once" |
| PASS | DM-OBS | Each observation stores source, endpoint, params, observed_at, received_at, source_timestamp, response_hash, parser_version, normalized values, quality state | daemon/db.js, daemon/pipeline.js | "pipeline: CSFloat listings → quote, depth, reference, listings; auth header used, never stored" |
| PASS | DM-RETAIN | Raw sanitized payloads kept for a configurable retention (default 30 days); hashes and normalized rows forever | daemon/db.js `purgeRawPayloads`, `storage.raw_payload_retention_days` | "raw payload retention purges payloads but keeps hashes and rows" |
| PASS | DM-VERSIONS | Opportunities, paper trades and real trades store strategy/signal/fee_model/parser versions | daemon/engine.js, daemon/paper.js, js/ledger.js | "versions, receipts and reversal incidents are recorded and synced as REAL evidence rows"; "strategy_version changes with any strategy parameter" |
| PASS | SAMP-FREQ | Default sampling frequencies, configurable within bounds; per-host token buckets and backoff | config/settings-schema.js, daemon/scheduler.js, daemon/http-client.js | "token bucket: capacity, refill, 429 backoff"; "scheduler plan: capacity vs demand is reported, infeasible configs are visible" |
| PASS | SAMP-GROUP | Snapshot groups: max ages 180/300/900/1800 s, skew 120 s, contributing observations recorded; else STALE/CONFLICTING and excluded | js/research/snapshot.js | "fresh, synchronized, verified observations → COMPLETE with recorded contributions"; "ACCEPTANCE 2: …"; "Skinport's upstream cache is added to effective age" |
| PASS | SAMP-STATES | Quality states COMPLETE/PARTIAL/STALE/CONFLICTING/INSUFFICIENT/INVALID; no numeric scores; sufficiency reason recorded | js/research/snapshot.js, daemon/validate.js | "precedence: INVALID > INSUFFICIENT > STALE > CONFLICTING"; "future timestamps are INVALID, not fresh" |

### Metric semantics and defined math

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | MET-DOES | Every metric states what it DOES and DOES NOT mean (code, docs, UI) | js/research/semantics.js, ui/research-view.js (glossary) | "every metric states what it DOES and DOES NOT mean" |
| PASS | MET-VEL | observed_sale_velocity ≥ 10 sales/7 d else INSUFFICIENT; estimated_exit_days same market only, else UNKNOWN | js/research/metrics.js | "ACCEPTANCE 5: …"; "velocities are never pooled across markets" |
| UNVERIFIED | MET-BUYER | buyer_side_liquidity from CSFloat buy orders | js/research/metrics.js | The buy-orders endpoint is unverified (DATA_SOURCE_MATRIX), so the metric always reports UNVERIFIED. Needs a passing LIVE fixture for `csfloat_buy_orders`. |
| PASS | MET-REF | reference_price is a SIGNAL, never truth, never the exit price | js/research/opportunity.js | "ACCEPTANCE 4: …" |
| PASS | MET-LIQ | Liquidity is a gate and a label, not a multiplier; THIN/UNKNOWN excluded unless UMBRA allows it (still labeled) | js/research/opportunity.js | "ACCEPTANCE 5: …"; "minimum filters apply in standard mode only; UMBRA uses its $10 floor" |
| PASS | MATH-1..6 | hold_adverse_move (p25, ≥ 30 pairs), reversal_reserve (USER_ASSUMPTION), entry_cost, pessimistic_proceeds, expected_net_profit, rank_metric (ELIGIBLE only) | js/research/opportunity.js, js/research/metrics.js, js/research/fee-model.js | "defined math end to end → ELIGIBLE with every intermediate recorded"; "hold_adverse_move is applied: a falling exit market lowers proceeds"; "hold_adverse_move needs ≥ 30 pairs; nearest-rank 25th percentile" |
| PASS | MATH-7 | Pattern/float premium KNOWN/ESTIMATED/UNKNOWN; UNKNOWN never in a profit claim; identity by phase only where KNOWN | js/research/premium.js, config/pattern-seeds.js | "ACCEPTANCE 9: …"; "phase-dependent names are identity-AMBIGUOUS without a KNOWN phase" |
| UNVERIFIED | MATH-7-SEEDS | Seed tables for Case Hardened, Fade, Marble Fade, Doppler | config/pattern-seeds.js | Only Doppler phases are seeded with a cited source. The other three tables are empty because no citable source could be fetched from this environment. Every such item is UNKNOWN, so nothing is claimed. |
| PASS | MATH-8 | Sizing: 20% of capital at cost, velocity share cap, smallest wins; existing tier/stop/breaker kept; Kelly advisory, real-only, ≥ 30 trades | js/research/sizing.js | "sizing: smallest limit wins and is reported"; "Kelly is advisory, real-only, disabled below 30 trades, capped at 20%"; "capital rails: unknown capital, circuit breaker, tier, position size" |
| BLOCKED | MATH-9-INSTANT | Instant sale reference quote (source, quantity, timestamp, expiry) | js/research/metrics.js | No verified instant-sale source exists (DATA_SOURCE_MATRIX). Always UNAVAILABLE. |
| PASS | MATH-9-STOP | Stop trigger: rolling drop (8%/15 min) confirmed by rising listing_supply, plus a per-item floor, from daemon snapshots | js/research/metrics.js, daemon/api-evidence.js | "stop trigger: drop confirmed by rising supply, or absolute floor" |

### Evidence, fees, modes, storage

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | EV-LADDER | Evidence ladder 0–6 | js/research/evidence.js, EVIDENCE.md | "evidence ladder: no level inherits from a lower one" |
| PASS | EV-SIGNAL | SIGNAL_EVIDENCE: ≥ 30 paper trades, ≥ 14 days, ≥ 80% coverage per contributing source per day, no open HIGH event | js/research/evidence.js, daemon/quality.js | "SIGNAL_EVIDENCE requires paper count, days, coverage and no open HIGH event" |
| PASS | EV-EXEC | EXECUTION_EVIDENCE: ≥ 30 REAL trades; paper never counts (renamed v1 30-flip gate, C2) | js/research/evidence.js | "ACCEPTANCE 3: …" |
| PASS | EV-STRAT | STRATEGY_VALIDATION: both gates under one strategy_version, by marketplace and holding period | js/research/evidence.js | "STRATEGY_VALIDATION needs both gates under the same strategy_version" |
| PASS | EV-REGIME | Market regime coverage reported UNKNOWN, never claimed | js/research/evidence.js | "evidence report over HTTP: SYNTHETIC runs reach no evidence level; regime coverage UNKNOWN" |
| PASS | EV-PAPER | "Forward paper trading evaluation" (not "backtest"); pessimistic fills; selection rule stated before results | daemon/paper.js, EVIDENCE.md, ui/research-view.js | "paper trades: one OPEN per pair; closes on the first exit quote after planned close; VOIDs on unverified/missing" |
| PASS | FEE-CAL | Calibrator writes PROPOSED_CALIBRATION; nothing changes until accepted; acceptance creates a dated fee_model_version | js/research/fee-calibration.js, js/research/fee-model.js, daemon/api-evidence.js | "ACCEPTANCE 8: …"; "C4 via calibration: …"; "fee calibration accept: needs explicit confirmation and valid overrides; creates a new version, never edits the old one" |
| PASS | FEE-C4 | Steam: conservative default kept; Valve's exact method shown beside it | js/research/fee-model.js, ui/ledger-view.js | "fee model versions: base unchanged; derived version records overrides; C4 comparison"; browser smoke "ledger: Steam sale shows the C4 comparison (15%-of-gross used vs Valve exact)" |
| PASS | MODE-RP | Operating modes RESEARCH (no staging in standard mode) and PAPER (auto paper logging) | daemon/paper.js, daemon/api-control.js | "paper trades: one OPEN per pair; …"; "kill switch stops UMBRA staging (still notifies); non-UMBRA cycles do nothing" |
| BLOCKED | MODE-ASSISTED | ASSISTED: user approves each transaction in-app | ui/research-view.js | In-app approval needs an execution path (L2), which is BLOCKED. You approve and perform every transaction on the marketplace yourself. The mode is selectable and behaves like RESEARCH; the UI says so. |
| BLOCKED | MODE-AUTO | AUTOMATION mode | config/settings-schema.js | Requires L3 (BLOCKED). Rejected by settings validation. |
| PASS | STO-IDB | IndexedDB primary; non-destructive migration from localStorage | js/storage.js | Browser smoke "storage: IndexedDB is primary", "storage: v1 localStorage ledger migrated, original kept", "storage: localStorage source untouched", "storage: ledger survives reload from IndexedDB"; "IndexedDB unavailable → localStorage fallback, with a visible warning" |
| PASS | STO-FIFO | Partial-lot splitting with FIFO across lots | js/ledger.js, ui/ledger-view.js | "FIFO across lots with partial-lot splitting (v2)"; browser smoke "ledger: partial sell recorded (FIFO split)" |
| PASS | STO-BACKUP | Daily backup via File System Access API with checksum; verified import; manual export fallback | js/backup.js, ui/ledger-view.js | "backup round trip verifies the checksum; any modification is rejected"; "without the File System Access API, daily backup reports UNSUPPORTED (manual export fallback)"; browser smoke "backup: …" |
| UNVERIFIED | STO-NONCHROMIUM | Behaviour in Firefox/Safari | js/backup.js, js/storage.js | Labeled UNVERIFIED in the UI as the spec requires. Only Chromium was run. The no-FSA path was simulated in Chromium. |
| PASS | STO-BUCKETS | Explicit buckets: cash, wallet, inventory value, reserved cash, open exposure, deployable capital, banked profit | js/ledger.js, ui/dashboard.js | "reserved cash is an earmark inside cash: buys and withdrawals can't use it"; "ACCEPTANCE: Steam Wallet separation (P0-5)" |

### Automation, UMBRA, notifications

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | AUTO-L0L1 | L0 alert only; L1 stage (external link, no submission); default OFF; never enabled by UMBRA | js/research/automation.js, daemon/autopilot.js | "permission matrix (execution API assumed verified for the controller logic only)"; "ACCEPTANCE 6: …" |
| BLOCKED | AUTO-L2L3 | L2 user-approved execution; L3 narrow automation on CSFloat balance, with STRATEGY_VALIDATION, typed phrase, hard limits; auto-reprice with floor | js/research/automation.js (controller only) | No verified execution/listing-edit API (DATA_SOURCE_MATRIX #19/#20). Can't be enabled (`EXECUTION_API_VERIFIED = false`). The permission controller (limits, phrase, validation gate, override never unlocks L2/L3) is tested with a SYNTHETIC mock executor only. |
| PASS | AUTO-KILL | Kill switch always visible; stale data, API failure or unexpected response → STOP | index.html, js/app.js, daemon/api-control.js, js/research/automation.js | "ACCEPTANCE 7: …"; "API failure and stale data also STOP; a well-formed response executes (mock)"; browser smoke "kill switch: engages from the header", "kill switch: release needs confirmation and works" |
| PASS | UMBRA-ACT | Activation with declared bankroll; SIGNAL_EVIDENCE or typed "unproven edge" (ranking, L0, L1 only); UNPROVEN on every screen; persisted | js/research/umbra.js, daemon/api-control.js, js/app.js | "UMBRA activation: bankroll required; without SIGNAL_EVIDENCE only the exact typed override works"; browser smoke "UMBRA: refused without evidence or the typed phrase", "UMBRA: theme applied, UNPROVEN banner, no execution" |
| PASS | UMBRA-UNIV | Universe = valid observations from the last discovery cycle; UNIVERSE_SIZE, DISCOVERY_TIME, ITEMS_SKIPPED + SKIP_REASON; $10 floor, no ceiling; one ranking by rank_metric | daemon/engine.js, daemon/sources.js | "UMBRA cycle reports UNIVERSE_SIZE, DISCOVERY_TIME, ITEMS_SKIPPED with SKIP_REASON"; "pipeline: Skinport with FX converts at ingestion and builds the universe (≥ $10 floor)" |
| PASS | UMBRA-RAILS | Rails always on: circuit breaker, cash check, staleness exclusion, quality gate, fail closed | js/research/opportunity.js, js/research/umbra.js | "capital rails: unknown capital, circuit breaker, tier, position size"; "minimum filters apply in standard mode only; UMBRA uses its $10 floor" |
| PASS | UMBRA-AUTOPILOT | Autopilot scans, ranks, stages (L1), notifies, logs paper trades; executes nothing | daemon/autopilot.js, daemon/paper.js | "ACCEPTANCE 6: …"; "kill switch stops UMBRA staging (still notifies); non-UMBRA cycles do nothing" |
| PASS | UMBRA-VIS | `data-mode="umbra"`, CSS variables only, specified palette, 600 ms crossfade, CSS drift, heartbeat, row flash, tickers on the five figures, reduced motion respected | styles.css, js/app.js, ui/research-view.js, ui/dashboard.js | "UMBRA keeps the specified palette verbatim"; browser smoke "UMBRA: palette base #06060A applied", "UMBRA: background drift animates", "reduced motion: drift disabled", "reduced motion: crossfade disabled". Heartbeat, row flash and tickers are verified by code review, not asserted in the browser. |
| PASS | UMBRA-LABELS | Every opportunity shows source, timestamp, freshness, quality state, OBSERVED/ESTIMATED tag, blocked reason and trace | ui/research-view.js | Browser smoke "research: every blocked row states its reason", "research: row expands into a step-by-step trace", "research: every row shows the engine's exact status" |
| PASS | A11Y-CONTRAST | Text contrast ≥ 4.5:1 in light, dark and UMBRA | styles.css | tests/contrast.test.js |
| PASS | NOTIF-INAPP | In-app notifications for staged deals | daemon/autopilot.js, ui/research-view.js | "ACCEPTANCE 6: …" |
| BLOCKED | NOTIF-NTFY | ntfy push (P2, last; only after Phases 0–5 are verified) | — | Not implemented: Phase 0 is not verified (PH0-LIVE BLOCKED). `NTFY_TOPIC` is read by nothing. |

### Configuration, security, failure states

| Status | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| PASS | CFG-CLASS | Every value classified (invariant / developer default / user setting) with default, bounds, validation, persistence, dangerous combinations | config/settings-schema.js, CONFIGURATION.md (generated) | tests/config-doc.test.js |
| PASS | SEC-ENV | Secrets only via environment or `wrangler secret`; redacted in logs and errors | daemon/redact.js, worker/lib.js | "redaction scrubs env secrets and credential shapes"; "secrets never leave the daemon; write guards hold"; "upstream errors never echo upstream body or auth material" |
| PASS | SEC-SCAN | Secret scan extended to daemon, database and backups | scripts/secret-scan.mjs | tests/security.test.js |
| PASS | SEC-HTTP | Daemon: loopback bind, Host allow-list, same-origin JSON POSTs, CSP header | daemon/server.js | "daemon binds to loopback only"; "secrets never leave the daemon; write guards hold" |
| PASS | SEC-ACCOUNT | A dedicated trading account holding only inventory being traded is documented | PLAN.md | Document review |
| PASS | FAIL-STATES | INPUT/PROCESSING/OUTPUT/FAILURE/RECOVERY/TEST for every listed failure | FAILURE_STATES.md | tests/docs.test.js (every cited test exists) |

### Acceptance tests (GIVEN / WHEN / THEN / FAILURE)

"FAILURE" is what the test treats as a failure.

| Status | # | GIVEN | WHEN | THEN | FAILURE | Test |
|---|---|---|---|---|---|---|
| PASS | 1 | a stale CSFloat quote | scanning | ineligible; UI shows STALE; no calculation uses it | eligible, or any math field computed from the stale quote, or a status other than the engine's shown | "ACCEPTANCE 1: stale CSFloat quote → ineligible, STALE, no calculation uses it"; "ACCEPTANCE 1 (grouping part): stale CSFloat quote → STALE"; browser smoke "research: every row shows the engine's exact status" |
| PASS | 2 | observations 200 s apart across sources | grouping | CONFLICTING and excluded | COMPLETE, or the pair rankable | "ACCEPTANCE 2: observations 200s apart across sources → CONFLICTING" |
| PASS | 3 | 29 real trades and 500 paper trades | checking gates | EXECUTION_EVIDENCE fails | paper trades counted toward the gate | "ACCEPTANCE 3: 29 real trades and 500 paper trades → EXECUTION_EVIDENCE fails" |
| PASS | 4 | CSFloat reference $200, entry ask $150, exit ask $155 | computing | profit computed from the exit ask, not the reference | reference price in any profit input | "ACCEPTANCE 4: reference $200, entry ask $150, exit ask $155 → profit from the exit ask" |
| PASS | 5 | velocity from 9 observed sales | computing | INSUFFICIENT; estimated_exit_days UNKNOWN | a velocity or exit-days number | "ACCEPTANCE 5: velocity from 9 observed sales → INSUFFICIENT and estimated_exit_days UNKNOWN" |
| PASS | 6 | UMBRA active, automation off (L0) | a top deal appears | staged (L1 link) and notified; nothing executed | an executed action, or no staged row or notification | "ACCEPTANCE 6: UMBRA active + automation off (L0) → top deal staged and notified; nothing executed" |
| PASS | 7 | an unexpected API response in L3 | acting | STOP; kill switch set | any further action or a clear kill switch | "ACCEPTANCE 7: unexpected API response in L3 → STOP and kill switch set" (mock executor: L3 is BLOCKED in production) |
| PASS | 8 | fee receipts differing from constants | calibrating | proposal created; constants unchanged until accepted | a changed fee model without acceptance | "ACCEPTANCE 8: fee receipts differing from constants → proposal; constants unchanged until accepted" |
| PASS | 9 | UNKNOWN pattern premium | ranking | no premium in any profit figure | a non-zero premium contribution | "ACCEPTANCE 9: UNKNOWN pattern premium never appears in any profit figure" |
| PASS | 10 | a paper trade and a real trade | reporting | separate rows, separate statistics | pooled rows or statistics | "ACCEPTANCE 10: paper and real trades are reported in separate rows with separate statistics" |

### Testing layers

| Status | Layer | Where |
|---|---|---|
| PASS | Unit | tests/*.test.js |
| PASS / BLOCKED | Contract | Offline shape and parser tests PASS (tests/contract.test.js). LIVE fixtures BLOCKED (PH0-LIVE). |
| PASS | Integration across the daemon ↔ UI boundary | tests/integration.test.js (real daemon process, SYNTHETIC loopback upstream) |
| PASS | Real runtime | Daemon process (integration + browser smoke); Worker under workerd (`npx wrangler dev`, final audit 2026-09-28) |
| PASS | Browser, desktop + mobile, with screenshots and contrast | scripts/browser-smoke.mjs (44 checks), tests/contrast.test.js |
| PASS | Regression test per bug found | e.g. "regression: the v1 Worker health probe is served when the daemon hosts the UI"; "regression: daemon state rows (ledger sync, watchlist) are not validated as settings"; "unreadable database file: daemon refuses to start, prints recovery, modifies nothing"; "damaged database: integrity check fails closed → DEGRADED, no sampling, writes refused"; "entry module exports only the default handler (workerd treats named exports as entrypoints)" |
| PASS | Security | tests/security.test.js, scripts/secret-scan.mjs |
| PASS | Clean clone | See Final state |

### Deployment

| Status | ID | Requirement | Verification |
|---|---|---|---|
| BLOCKED | OPS-DEPLOY / OPS-SMOKE | Worker + Pages deployed; production smoke test | Unchanged from v1: no Cloudflare credentials, api.cloudflare.com unreachable. Runbook in PLAN.md. |
| BLOCKED | OPS-DAEMON-LIVE | Daemon sampling real markets | Needs a machine with normal network access (PH0-PLACE) and a passing contract test (PH0-LIVE). |

## Final state (2026-09-28)

Filled in by the final audit below.
