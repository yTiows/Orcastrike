# PLAN — Skin Arbitrage Terminal (spec v3)

## 0a. Preflight (2026-09-27, build container)

| Check | Result |
|---|---|
| node | v22.22.2 |
| npm | 10.9.7 |
| git | 2.43.0 |
| gh CLI | **absent** (GitHub reached via MCP integration instead) |
| wrangler (global) | **absent** — pinned as devDependency `wrangler@4.141.0`, run via `npx` |
| `CLOUDFLARE_API_TOKEN` | **absent** |
| `CLOUDFLARE_ACCOUNT_ID` | **absent** |
| `CSFLOAT_API_KEY` | **absent** |
| Network: registry.npmjs.org | reachable |
| Network: steamcommunity.com, api.skinport.com, csfloat.com, docs.*, cdnjs.cloudflare.com, api.frankfurter.dev, api.cloudflare.com | **blocked by the build container's egress policy** |

Consequences, decided up front:
- **Step 12 (deploy) and Step 13 (live smoke test) are blocked** by the missing Cloudflare credentials
  and by egress to api.cloudflare.com. That is a stop condition only for those steps. Every other
  step is built and tested locally.
- Upstream API shapes (Steam, Skinport, CSFloat, Frankfurter) could not be exercised live. Parsers
  are written against the published/known formats and fail closed (`INVALID`/`UNAVAILABLE`) on any
  mismatch. See LIMITATIONS.md.
- Fee constants were cross-checked via web-search snippets only (vendor fee pages were unreachable).
  See FEES.md.
- CSFloat will report `NOT_CONFIGURED` until the key is set as a Worker secret.

## 0b. Existing repo

`/home/user/Orcastrike` — git repo, remote `github.com/yTiows/Orcastrike`, branch
`claude/skin-arb-terminal-spec-rtocat`, **no commits, no files**. Nothing to preserve. The existing
repo name is kept (spec's `skin-arb-terminal` default applies only when no repo exists); the npm
package, Worker and Pages project are named `skin-arb-terminal`.

## Files

Shipped app (static, no framework, no bundler):
- `index.html`, `styles.css`, `_headers` (Pages security headers / CSP)
- `js/money.js` — integer-cents + basis-point math. **All fee/margin math lives here.**
- `js/format.js` — display formatting (cents → "$x.yy", bps → "x.yy%", countdowns)
- `js/state.js` — localStorage wrapper, settings overlay on immutable defaults, validation
- `js/api.js` — Worker client (throttled, per-source concurrency)
- `js/scanner.js` — quote validation, pair evaluation, eligibility enum, calc trace, inventory valuation
- `js/tiers.js` — tiers, position-size formula, stop-loss flag, circuit breaker, tier-compression gate
- `js/ledger.js` — lots/trades/adjustments, FIFO whole-lot accounting, replay validation, balances,
  reinvestment rule, export/import
- `js/backtest.js` — single-market historical simulation (historical context only); cross-market verdict
- `js/events.js` — event schema validation, 7d-before/after price delta
- `js/app.js` — controller/bootstrap (loads state, derives views, routes UI actions)
- `ui/dashboard.js`, `ui/scanner-table.js`, `ui/ledger-view.js`, `ui/events-view.js`, `ui/settings-view.js`
- `config/defaults.js` (deep-frozen), `config/fees.js`
- `static/events.json`, `static/watchlist-starter.json`

Backend:
- `worker/index.js` — Worker entry; exports only the default handler (DECISIONS D-29).
- `worker/lib.js` — implementation: `/api/health`, `/api/quote`, `/api/history`, `/api/fx`.
  Imports `js/money.js` (wrangler/esbuild bundles it) so ingestion conversion uses the same code.
- `wrangler.toml`

Tests (node:test): `tests/money.test.js`, `tests/scanner.test.js`, `tests/tiers.test.js`,
`tests/ledger.test.js`, `tests/worker.test.js`.

Dev tooling (not shipped): `package.json`, `eslint.config.js`,
`scripts/secret-scan.mjs` (pre-deploy credential grep), `scripts/package-pages.mjs` (copies only
shipped files into `dist/` so `wrangler pages deploy` can never upload `.env`, `node_modules`,
tests or the Worker source).

Docs: `PLAN.md`, `REQUIREMENTS.md`, `DECISIONS.md`, `CHANGELOG.md`, `LIMITATIONS.md`, `FEES.md`,
`BACKTEST_RESULTS.md`.

## Dependencies

Runtime: Chart.js 4.5.1 from cdnjs (`chart.umd.min.js`, SRI sha384 computed from the npm tarball
of the same version). Chart failure is isolated in the chart helper; the scanner and ledger don't
depend on it.
Dev: eslint 10.11.0, @eslint/js 10.0.1, globals 17.12.0, wrangler 4.141.0 (all pinned exactly).

## Env vars

| Var | Where | Status | Required for |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy shell | absent | Step 12 deploy (blocking) |
| `CLOUDFLARE_ACCOUNT_ID` | deploy shell | absent | Step 12 deploy (blocking) |
| `CSFLOAT_API_KEY` | Worker secret only | absent | CSFloat quotes (optional; `NOT_CONFIGURED` without it) |
| `ALLOWED_ORIGINS` | wrangler.toml `[vars]` | set (non-secret) | CORS allow-list |

## Sequence

1. Preflight + PLAN.md + REQUIREMENTS.md — this file
2. money.js + tests
3. ledger data model + tests
4. Worker + tests
5. scanner + tests
6. backtest module → BACKTEST_RESULTS.md
7. tiers / stop-loss / circuit breaker + tests
8. Ledger UI
9. Events UI
10. Frontend assembly + Chart.js isolation
11. Full suite from clean checkout + lint + secret scan
12. Deploy — **blocked (credentials)**
13. Live smoke test — **blocked (depends on 12)**
14. Finalize docs, check REQUIREMENTS.md rows

## Status (2026-09-27)

Steps 1–11 and 14 done. Steps 12–13 blocked on credentials (see REQUIREMENTS.md). CHANGELOG.md
lists what changed.

## Deploy runbook (Steps 12–13, run where credentials and network exist)

```sh
npm ci
npm run check && npm run audit:secrets        # lint + 65 tests + P0-9 audit; must all pass
export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...   # shell only, never a file in the repo
npx wrangler secret put CSFLOAT_API_KEY        # optional; omit → CSFloat reports NOT_CONFIGURED
npm run deploy:worker                          # prints https://skin-arb-terminal-proxy.<acct>.workers.dev
# set DEFAULTS.WORKER_BASE_URL in config/defaults.js to that URL (or set it per browser in Settings)
npx wrangler pages project create skin-arb-terminal --production-branch main   # first time only
npm run deploy:pages                           # uploads dist/ only → https://skin-arb-terminal.pages.dev
```

Smoke test against the live Worker (`W=https://…workers.dev`):

```sh
curl -s "$W/api/health"                                   # csfloat: CONFIGURED | NOT_CONFIGURED
curl -s "$W/api/quote?source=steam&item=AK-47%20%7C%20Redline%20(Field-Tested)"     # AVAILABLE or explicit state
curl -s "$W/api/quote?source=skinport&item=AK-47%20%7C%20Redline%20(Field-Tested)"  # price_usd_cents in USD, listing_depth null
curl -s "$W/api/quote?source=csfloat&item=AK-47%20%7C%20Redline%20(Field-Tested)"   # NOT_CONFIGURED when no key; AVAILABLE with key
curl -s "$W/api/history?source=steam&item=AK-47%20%7C%20Redline%20(Field-Tested)"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$W/api/quote"                     # 405
curl -s -i "$W/api/health" | grep -i -E "authorization|set-cookie" && echo LEAK || echo "no auth headers"
```

# v2: research and evidence system (2026-09-28)

## Architecture in one paragraph

The **daemon** (`daemon/`, Node ≥ 22.13, built-in `node:sqlite`, no new npm dependencies) is the primary data plane. It samples Steam, Skinport, CSFloat and Frankfurter within per-host token buckets, stores append-only observations in `.orcastrike-data/orcastrike.sqlite`, builds snapshot groups, computes opportunities with a full trace, runs forward paper trading, and serves the UI plus a JSON contract on `http://127.0.0.1:8790`. The Cloudflare **Worker** stays as the thin v1 fallback. The **browser** keeps the ledger (IndexedDB) and syncs real trades and capital to the daemon for evidence. ARCHITECTURE_DELTA.md has the details, EVIDENCE.md the gates, CONFIGURATION.md every setting, and FAILURE_STATES.md what happens when things break.

## Install, run, update

SETUP.md is the step-by-step guide. In short: `scripts/orca.mjs` (wrapped by `Orcastrike.cmd`, `orcastrike.sh` and `npm start` / `npm run setup|update|stop|doctor`) starts the daemon and opens the UI, updates by fast-forward with a database backup first, and diagnoses the installation. Evidence needs calendar time: `hold_adverse_move` needs 30 snapshot pairs H days apart (7 days minimum), and SIGNAL_EVIDENCE needs ≥ 14 days plus ≥ 30 closed paper trades. Until `node scripts/contract_test.mjs` passes on a real network, every parser is UNVERIFIED and **no opportunity can be ELIGIBLE** (D-38).

## Browser smoke test (not in `npm test`, D-44)

```sh
npm i -g playwright@1.56.1 && npx playwright install chromium   # once, if not installed
npm run smoke:browser                       # real Chromium against a SYNTHETIC daemon; 44 checks
```

Screenshots go to `reports/browser-smoke/` (git-ignored). `report.json` is committed.

## Dedicated trading account (security)

Use a **separate Steam account and separate marketplace accounts that hold only the inventory being traded**, never your main inventory. The app never stores Steam credentials, cookies or authenticator data (P0-2), and it can't execute anything (C1). A dedicated account still limits the damage of a compromised marketplace session, a mis-click on a staged link, or a trade reversal. Give the CSFloat API key only to the daemon's environment (or `wrangler secret put` for the Worker). Never paste it into the UI, a file in the repo, or a chat.

## Env vars (v2 additions)

CONFIGURATION.md ("Environment variables") is generated from the code and is authoritative: `CSFLOAT_API_KEY` (daemon env or Worker secret), `ORCASTRIKE_PORT`, `ORCASTRIKE_DATA_DIR`, `ORCASTRIKE_ENGINE_INTERVAL_MS`, `ORCASTRIKE_CONTRACT_REPORT`. Test only: `ORCASTRIKE_SYNTHETIC` and `ORCASTRIKE_UPSTREAM_OVERRIDE`, which is loopback-only and refuses to start without `ORCASTRIKE_SYNTHETIC=1`. `NTFY_TOPIC` is read by nothing (notifications BLOCKED).

## Status (2026-09-28)

Phases 0–5 are implemented and tested against SYNTHETIC inputs. Live verification (PH0-LIVE), daemon placement (PH0-PLACE), deploy, L2/L3 and ntfy are BLOCKED or UNVERIFIED. REQUIREMENTS.md has one status per row.
