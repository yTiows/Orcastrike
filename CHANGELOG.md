# CHANGELOG

## 2.2.0 — 2026-09-28 (less manual work, clearer UI)

### Changed
- **UI redesigned around five pages** (DECISIONS D-55): **Overview** (what the app is doing, a self-ticking Next steps checklist, top opportunities, balances, the five profit figures, evidence progress), **Opportunities**, **Portfolio**, **Markets** (price gaps, watchlist, Steam price history, events) and **Settings**. Old links (`#dashboard`, `#research`, `#ledger`, `#scanner`, `#events`) redirect.
  - Status appears in plain words beside the exact code (D-56); secondary material is in collapsible sections; Portfolio opens one form at a time.
  - Header: brand, pages, a status pill (Live / Test data / Read-only / App not running) and the kill switch; notices (kill switch, loss limit, storage, settings) sit under it.
  - New visual system: spacing and radius tokens, cards, chips, checklists and meters. The UMBRA palette is unchanged, and reduced motion is still honoured. Works at 390 px without horizontal scrolling.
  - Settings: risk limits in percent; operating mode and automation level as described choices; advanced daemon settings grouped and collapsed.

### Added
- **Automatic live verification** (D-57): the daemon runs the contract test at startup when the report is missing or over 24 h old, re-checks hourly, and offers **Verify now** (POST `/api/v2/verify`). Results go to `<data dir>/contract/`, never to tracked files. `ORCASTRIKE_AUTO_VERIFY=0` turns it off; it is always off with a SYNTHETIC upstream. A live format change shows per source as `FORMAT_CHANGED`.
- `/api/v2/health` gains `parser_status_by_source`, `verify` (state and outcome), `data` (observations, tracked items, per-source request health) and `key_setup`.
- Automation of one-right-answer steps (D-58): quotes refresh every 60 s (daemon) or 300 s (Worker); price history loads for the selected item; the event price change computes on selection; form times default to now; the current ask is a one-click fill.
- CSFloat key setup commands on Overview, served by the daemon, with a Copy button (D-59).

### Fixed
- An opportunity metric was labelled "Expected net profit" (P0-8 wording); it now reads "Estimated net profit". Found by the no-git secret scan, which also checks untracked files.

## 2.1.0 — 2026-09-28 (setup automation and Windows support)

### Added
- **One-command operation:** `scripts/orca.mjs` (zero dependencies), with `Orcastrike.cmd` (double-click on Windows), `orcastrike.sh`, and `npm start` / `npm run stop|setup|update|doctor`.
  - `start` needs no install. It opens the browser, detects an already running instance, and reports port conflicts.
  - `stop` stops the daemon cleanly from any window.
  - `setup` checks Node ≥ 22.13 and SQLite, installs dev tools only when `package-lock.json` changed, and runs the tests.
  - `update` fast-forwards only, backs up the database first, refuses over local edits, diverged history or a running daemon, and prints rollback steps. `--convert` turns a ZIP folder into an updatable checkout, copying differing files aside first.
  - `doctor` diagnoses the installation without printing secrets.
  - On start, a git checkout checks in the background for a newer version and prints a notice. It never updates by itself.
- Daemon POST `/api/v2/shutdown` (same-origin JSON + confirmation), used by `stop`.
- **SETUP.md**, a detailed Windows-first guide: prerequisites, CSFloat key as a user environment variable, live verification, daily use, data locations, updates, troubleshooting.
- **README.md**: quick start and a documentation map.
- **CI:** GitHub Actions on ubuntu-latest and windows-latest, running lint, tests, the secret scan, the config-doc check, and both launchers.
- `.gitattributes`: LF everywhere, CRLF kept for `.cmd`.

### Fixed (found by the first run on Windows, each with a regression test)
- Two tests built filesystem paths from `URL.pathname` (`/C:/…` on Windows). Four tests failed, and the LIVE-fixture test would have silently found no fixtures.
- The secret scan crashed without git (ZIP downloads) and mis-parsed CRLF files. It now scans the working tree, honouring `.gitignore`, and reports "git history SKIPPED".
- Generated-doc and CSS checks compared CRLF-sensitive bytes.

## 2.0.0 — 2026-09-28 (research and evidence system; not deployed, not live-verified)

### Added
- **Phase 0:**
  - `scripts/contract_test.mjs` stores sanitized LIVE fixtures, diffs them against every parser, and writes `CONTRACT_REPORT.json` and `static/parser-verification.json`.
  - `scripts/netcheck.mjs` measures daemon placement.
  - New docs: DATA_SOURCE_MATRIX.md, ARCHITECTURE_DELTA.md.
- **Daemon** (`daemon/`, Node ≥ 22.13, `node:sqlite`, no new npm dependencies):
  - Append-only SQLite with versioned migrations.
  - Per-host token buckets with 429 backoff.
  - Sanitized raw store with retention.
  - Normalizers, validator, data-quality events, snapshot groups (COMPLETE / PARTIAL / STALE / CONFLICTING / INSUFFICIENT / INVALID).
  - Scheduler, including a capacity-vs-demand plan.
  - Loopback-only HTTP with Host allow-list, same-origin JSON POSTs and CSP.
  - Serves the UI and the v1 Worker contract.
- **Opportunity engine** (`js/research/`):
  - The defined math: hold_adverse_move, reversal_reserve, entry_cost, pessimistic_proceeds, expected_net_profit, rank_metric.
  - Pattern premiums KNOWN / ESTIMATED / UNKNOWN (Doppler phases cited).
  - Sizing with Kelly as advisory only; stop trigger.
  - Metric semantics: every metric states what it DOES and DOES NOT mean.
  - Versions: strategy, signal, fee model, parser.
  - Parsers without a passing LIVE fixture can't produce an ELIGIBLE opportunity (D-38).
- **Evidence:**
  - Ladder 0–6 and the SIGNAL_EVIDENCE / EXECUTION_EVIDENCE / STRATEGY_VALIDATION gates (the v1 30-flip gate was renamed, and stays real-only).
  - Forward paper trading evaluation.
  - Five separate profit figures.
  - Fee calibration proposals and dated fee model versions (accepted only with explicit confirmation).
  - New doc: EVIDENCE.md.
- **Ledger v2:**
  - FIFO partial-lot splitting.
  - Reserve/release, receipts, reversal incidents, version tags.
  - IndexedDB storage with a non-destructive localStorage migration.
  - Checksummed export/import, and a daily File System Access backup (Chromium; UNVERIFIED elsewhere).
  - Explicit buckets.
- **Control:**
  - Operating modes.
  - Automation ladder L0–L3 (L2/L3 can't be enabled: no verified execution API).
  - Kill switch in the header.
  - UMBRA ranking mode and theme:
    - Declared bankroll; SIGNAL_EVIDENCE or the typed "unproven edge" override, labeled UNPROVEN.
    - Full-catalog universe report and $10 floor; rails always on.
    - Autopilot that stages L1 links and notifies in-app, and never executes.
- **UI:**
  - Research tab (evidence, opportunities with labels and traces, paper vs real, data quality, coverage, staged actions, fee calibration, glossary).
  - Dashboard with the five figures.
  - Ledger v2 forms.
  - Daemon settings.
  - UMBRA palette, crossfade, drift, heartbeat, row flash and tickers, all off under reduced motion.
- **Config and docs:**
  - CONFIGURATION.md, generated from `config/settings-schema.js` and tested for drift.
  - FAILURE_STATES.md; a test checks that every cited test exists.
  - REQUIREMENTS.md now has a status per row and the 10 acceptance tests in GIVEN/WHEN/THEN/FAILURE form.
- **Tests:**
  - 165 in `npm test` (164 pass; 1 skipped until LIVE fixtures exist): unit, contract, a real daemon process against a SYNTHETIC loopback upstream, security, contrast, docs.
  - `scripts/browser-smoke.mjs`: 44 checks in real Chromium, desktop and 390 px, with screenshots.
- `npm run daemon`, `npm run smoke:browser`.

### Fixed during v2 (each with a regression test)
- The daemon didn't serve `/api/health`, so the UI's quotes probe got a 404 on every load (found by the browser smoke run).
- Settings-table state rows (ledger sync, watchlist) were validated as user settings and invalidated them.
- A garbage database file crashed the daemon with a stack trace. It now exits with code 2, prints recovery steps, and leaves the file untouched.
- A damaged but openable database made `integrity_check` throw and crash start-up. It now runs DEGRADED: read-only, no sampling, POSTs refused.
- Mobile overflow on the Research and Events tabs: tables weren't wrapped, and a long select didn't shrink.
- UMBRA accent text and white-on-accent/loss buttons failed WCAG AA. Added `--accent-text`, `--on-accent` and `--on-neg`; the palette is unchanged.
- The C4 Steam comparison appeared only in the sell confirmation. It now appears on every Steam trade row.
- The ASSISTED mode hint claimed in-app approvals that don't exist. The UI now says it behaves like RESEARCH.
- Secret-scan wording finding (P0-8) was committed once, because a pipe hid the exit code. Fixed, and the scan now runs inside `npm test`.

### Not done
- Live verification (every endpoint 403 from the build container), daemon placement measurement on a real host, deploy, L2/L3 execution, ASSISTED approvals, ntfy notifications. See REQUIREMENTS.md.

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
