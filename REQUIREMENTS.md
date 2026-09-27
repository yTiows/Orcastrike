# REQUIREMENTS — traceability

One row per P0 invariant and major feature. `[x]` = implemented and covered by the named test (or
by the named audit where a unit test can't cover it). `[ ]` = not done; the build is incomplete
while any row is unchecked.

| ✓ | ID | Requirement | Implementing file(s) | Test / verification |
|---|---|---|---|---|
| [ ] | P0-1 | No auto-execute/buy/sell; only after-the-fact "record buy/sell" | ui/ledger-view.js, js/ledger.js, worker/index.js (GET-only, no trade endpoints) | tests/worker.test.js (non-GET rejected, no trade routes); tests/ledger.test.js |
| [ ] | P0-2 | No Steam cookies / credentials / Mobile Authenticator data anywhere | worker/index.js (anonymous Steam requests only) | tests/worker.test.js (no Cookie header sent upstream); scripts/secret-scan.mjs |
| [ ] | P0-3 | CSFloat key server-side only (Worker secret) | worker/index.js, wrangler.toml, .env.example | tests/worker.test.js (key never in body/headers; NOT_CONFIGURED without key); scripts/secret-scan.mjs |
| [ ] | P0-4 | Never fabricate prices/liquidity/history/trades; missing → INSUFFICIENT_DATA/UNAVAILABLE | js/scanner.js, worker/index.js, js/backtest.js, js/events.js | tests/scanner.test.js, tests/worker.test.js |
| [ ] | P0-5 | Steam Wallet separate, never in cash/deployable | js/ledger.js | tests/ledger.test.js "Steam Wallet separation" |
| [ ] | P0-6 | Integer USD cents; EUR→USD at ingestion | js/money.js, worker/index.js | tests/money.test.js, tests/worker.test.js (Skinport ingestion) |
| [ ] | P0-7 | Single-market sim never labeled as cross-market evidence | js/backtest.js, ui/scanner-table.js, BACKTEST_RESULTS.md | tests/scanner.test.js (backtest labels) |
| [ ] | P0-8 | Historical margin never phrased as expected/forecast | js/backtest.js, ui/* | tests/scanner.test.js (label text); grep audit for "expected margin" |
| [ ] | P0-9 | No secrets in tracked files/history/client/responses/logs | scripts/secret-scan.mjs, .gitignore, worker/index.js | secret scan run (Step 11); tests/worker.test.js |
| [ ] | P0-10 | Show nothing rather than a false positive | js/scanner.js | tests/scanner.test.js |
| [ ] | F-BAL | Balance definitions (cash, banked, wallet, inventory, deployable) | js/ledger.js | tests/ledger.test.js |
| [ ] | F-REINV | Reinvestment rule (30% banked at ≥ $100; losses never reduce banked; explicit redeploy) | js/ledger.js | tests/ledger.test.js |
| [ ] | F-POS | Position-size formula + BLOCKED_BY_POSITION_SIZE | js/tiers.js, js/scanner.js | tests/tiers.test.js "position eligibility" |
| [ ] | F-RISKCFG | Risk config defaults + override validation | config/defaults.js, js/state.js | tests/tiers.test.js |
| [ ] | F-STOP | Stop-loss flag (informational only) | js/tiers.js | tests/tiers.test.js |
| [ ] | F-CB | Circuit breaker (gross 24h loss ≥ 10%; timestamp persistence) | js/tiers.js, js/ledger.js, js/state.js | tests/tiers.test.js "circuit breaker persistence" |
| [ ] | F-TIER | Tier table, boundary convention, price bands | js/tiers.js, config/defaults.js | tests/tiers.test.js "tier boundary" |
| [ ] | F-VAL | Inventory valuation (lowest depth-qualified listing; else INSUFFICIENT_DATA) | js/scanner.js, js/ledger.js | tests/scanner.test.js, tests/ledger.test.js |
| [ ] | F-HOLD | minimum_hold_until = buy + 7d; live countdown | js/ledger.js, js/format.js, ui/ledger-view.js | tests/ledger.test.js |
| [ ] | F-ID | Canonical identity = exact market_hash_name | worker/index.js, js/scanner.js | tests/worker.test.js (CSFloat name mismatch → excluded) |
| [ ] | F-FIFO | FIFO whole-lot accounting; partial-lot sales rejected | js/ledger.js | tests/ledger.test.js |
| [ ] | F-LEDGER | Ledger schema; labeled user-recorded; export/import JSON | js/ledger.js, ui/ledger-view.js | tests/ledger.test.js (round-trip, invalid import rejected) |
| [ ] | F-WATCH | User watchlist, cap 100, starter list | js/state.js, static/watchlist-starter.json | tests/scanner.test.js (cap) |
| [ ] | F-DEPTH | listing_depth ±10% window, MIN_LISTING_DEPTH, supply-side label | worker/index.js, js/scanner.js, ui/scanner-table.js | tests/worker.test.js, tests/scanner.test.js |
| [ ] | F-ELIG | Eligibility enum, exactly one per opportunity | js/scanner.js | tests/scanner.test.js |
| [ ] | F-TRACE | Expandable calculation trace per row | js/scanner.js, ui/scanner-table.js | tests/scanner.test.js (trace fields) |
| [ ] | F-SANITY | Input sanity validation → INVALID, no NaN | js/scanner.js, js/money.js | tests/scanner.test.js, tests/money.test.js |
| [ ] | F-FEES | Fee constants + canonical cents formula | config/fees.js, js/money.js, FEES.md | tests/money.test.js "CSFloat fee-adjusted margin" |
| [ ] | F-FX | EUR→USD via cited free source, 1h TTL, STALE/UNAVAILABLE | worker/index.js | tests/worker.test.js |
| [ ] | F-FRESH | Freshness gating (mixed → INSUFFICIENT_DATA) | js/scanner.js | tests/scanner.test.js "data freshness gating" |
| [ ] | F-WORKER | Canonical schema, cache keys, TTLs, 8s timeout, 429 → RATE_LIMITED, header stripping | worker/index.js | tests/worker.test.js |
| [ ] | F-EVENTS | Event schema, source_url + retrieval_date, delta methodology | js/events.js, static/events.json, ui/events-view.js | tests/scanner.test.js (event validation + delta) |
| [ ] | F-BT | Backtest (a)/(b) distinction; verdict; pre-registered sample; ≥30 flips gate | js/backtest.js, js/tiers.js, BACKTEST_RESULTS.md | tests/tiers.test.js (≥30 gate), tests/scanner.test.js |
| [ ] | F-UI | Full frontend; Chart.js pinned + SRI; chart failure isolated | index.html, ui/*, styles.css | manual/headless load with CDN blocked |
| [ ] | F-TS | ISO 8601 UTC timestamps everywhere | js/ledger.js, worker/index.js | tests/ledger.test.js, tests/worker.test.js |
| [ ] | OPS-TEST | Full suite from clean checkout + lint | package.json | Step 11 |
| [ ] | OPS-SEC | Pre-deploy security audit | scripts/secret-scan.mjs | Step 11 |
| [ ] | OPS-DEPLOY | Worker + Pages deployed | wrangler.toml, package.json | Step 12 |
| [ ] | OPS-SMOKE | Production smoke test (Steam + Skinport; CSFloat NOT_CONFIGURED assertion) | — | Step 13 |
