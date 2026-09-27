# CHANGELOG

## 1.0.0 — 2026-09-27 (build, not deployed)

### Added
- `js/money.js`: integer-cents / basis-point / FX-micros math with BigInt round-half-up; spec
  canonical fee formula; multi-lot `computeSale`; Valve fee-on-top reference model.
- `config/fees.js`, `config/defaults.js` (deep-frozen); FEES.md with sources and caveats.
- `js/ledger.js`: FIFO whole-lot ledger, replay validation, balances (cash / banked / Steam Wallet /
  inventory / deployable), reinvestment rule, circuit-breaker snapshot, JSON export/import.
- `js/tiers.js`: tiers and bands, position-size formula, risk-config validation, stop-loss flag,
  circuit breaker (timestamp-derived), tier-compression ≥ 30-flip gate.
- `worker/`: read-only proxy for Steam (listing page + histogram), Skinport (bulk, EUR→USD at
  ingestion), CSFloat (key-gated, NOT_CONFIGURED without key), Frankfurter FX; canonical schema,
  cache keys, TTLs, 8s timeout, 429 → RATE_LIMITED without retry, CORS allow-list.
- `js/scanner.js`: quote sanity/freshness, one eligibility status per opportunity, full calculation
  trace, inventory valuation rule.
- `js/backtest.js` + BACKTEST_RESULTS.md: pre-registered single-market methodology; cross-market
  verdict INSUFFICIENT DATA.
- `js/events.js` + `static/events.json`: sourced events, 7d before/after delta.
- UI: dashboard, scanner (expandable trace, status filters, watchlist editor), ledger (record
  buy/sell/adjustments, export/import), events, settings; Chart.js 4.5.1 with SRI, async and
  isolated; CSP `_headers`.
- Tooling: ESLint flat config, node:test suites (65 tests), `scripts/secret-scan.mjs`,
  `scripts/package-pages.mjs`.

### Fixed during build
- The Worker entry module exported named constants, and workerd refused to start it. Split into
  `worker/index.js` (default export only) + `worker/lib.js`, with a regression test (found under
  `wrangler dev`).
- Ledger form lookup `form.elements.item` resolved to the collection's `item()` method; result
  messages lost their `.result` class; one view's mount failure blocked the others (found by a
  headless-browser smoke test).

### Not done
- Deploy (Step 12) and production smoke test (Step 13): no Cloudflare credentials in the build
  environment, and api.cloudflare.com was unreachable.
