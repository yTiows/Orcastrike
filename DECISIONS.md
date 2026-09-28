# DECISIONS

Ambiguities resolved during the build, each with a one-line reason. "Spec" = Build Specification v3.

| ID | Decision | Reason |
|---|---|---|
| D-01 | Kept the existing repo `yTiows/Orcastrike`; npm package, Worker (`skin-arb-terminal-proxy`) and Pages project (`skin-arb-terminal`) use the spec name. | The spec's repo-name default applies only when no repo exists. |
| D-02 | Money = integer cents; fee/risk rates = integer basis points parsed from decimal *strings*; FX = integer micros; all mul/div in BigInt with round-half-up. | Removes every float from money decisions (P0-6), including `1200 × 0.98 = 1175.9999…`. |
| D-03 | Steam fee default = spec formula (15% of gross → 1700 on 2000). Valve's fee-on-top algorithm (→ 1739) is implemented and selectable by config. | Canonical formula ("no exceptions") and the literal acceptance test both pin 1700, and it is the conservative direction. See FEES.md. |
| D-04 | Scanner sell legs are CSFloat and Skinport only; Steam is a buy leg only. | Steam sale proceeds are Steam Wallet, never cash (P0-5); spec: resale defaults to CSFloat/Skinport. |
| D-05 | `listing_depth` of an opportunity = **sell-side** depth at the sell quote; buy-side depth is shown in the trace only. | The risk being gated is that the sell price is one anomalous listing and not a real market level. |
| D-06 | Skinport `listing_depth` = null (`listing_depth_basis: "unavailable"`); a Skinport sell leg → `INSUFFICIENT_DATA`. `total_listings` is shown but never used as depth. | Skinport's public API returns only min price and total count, no price distribution. Using the total as ±10% depth would be fabricating (P0-4). |
| D-07 | Item price bands use the capital-tier convention: lower bound inclusive, upper exclusive, Tier 4 unbounded. Opportunities must be inside the **current** tier's band (strict). | The table's stated convention; the literal reading of "Item price band". |
| D-08 | Eligibility precedence: INSUFFICIENT_DATA → STALE → (below min filter: not an opportunity) → THIN_LIQUIDITY → BLOCKED_BY_CIRCUIT_BREAKER → BLOCKED_BY_TIER → BLOCKED_BY_POSITION_SIZE → HIGHLIGHTED. | Data validity first, then market quality, then the global kill switch, then structural gates. Exactly one status per row. |
| D-09 | Mixed freshness (one fresh, one stale) → INSUFFICIENT_DATA; both stale → STALE. Neither calculates. | The acceptance test pins the mixed case; STALE is reserved for a consistent-but-old snapshot. |
| D-10 | Quote-level `INVALID` maps to opportunity `INSUFFICIENT_DATA`. | The eligibility enum has no INVALID; the row still says which input was INVALID and why. |
| D-11 | Pairs below `MIN_NET_PROFIT_CENTS` / `MIN_NET_MARGIN_PCT` are not opportunities: excluded from rows, counted, and viewable behind a toggle. | "Minimum viable opportunity filter"; the enum has no below-threshold status. |
| D-12 | Freshness: a quote older than `QUOTE_MAX_AGE_SECONDS` = 300 is STALE. Worker quote TTL = 90s. | 90s is inside the spec's 60–120s; 300s lets a Steam-paced refresh of a full watchlist finish without going stale mid-run. |
| D-13 | FX staleness uses the ECB rate *date*: older than 4 calendar days → STALE; a stale FX rate makes the Skinport quote STALE. | ECB publishes on TARGET working days only; 4 days covers a long weekend. |
| D-14 | Skinport fee tier (≥ €1,000) is decided in USD: the €1,000 threshold is converted with the same rate used at ingestion. | No computation in EUR after ingestion (P0-6). |
| D-15 | Starter watchlist: 10 weapon cases + 8 long-standing Field-Tested rifle/pistol skins, chosen for volume before any prices were seen (none were reachable). | Cases are the highest unit-volume class (weekly drops for every account). Volume rank was not verified live; this is recorded here and in the JSON. |
| D-16 | Deployable capital with unvalued lots = explicit **lower bound** (flagged), used for tier/position gating and the reinvestment check. | The spec forbids zero-filling or cost-filling unvalued lots; a lower bound is conservative for sizing and is labeled everywhere it appears. |
| D-17 | Inventory valuation uses cash sell markets only (CSFloat, Skinport), gross lowest listing that meets MIN_LISTING_DEPTH and is fresh; no fee deduction. | Including Steam would put wallet-only value into deployable capital. The spec defines valuation as the listing price. |
| D-18 | Reinvestment "deployable capital at the moment the trade closes" = state just after the sale's proceeds, before the banking allocation; open lots valued with quotes at *record* time. Stored on the trade. | Removes the circularity; the value is snapshotted so replay and import are deterministic. |
| D-19 | Banking applies only to `usd_cash` proceeds; Steam Wallet profits bank 0. | Banked profit is an earmark on cash; wallet funds are not cash. |
| D-20 | Buys cannot spend banked profit (rejected until an explicit "redeploy"); cash withdrawals cannot dip into banked unless flagged "from banked profit". | "Redeploying it requires an explicit separate user action, never automatic." |
| D-21 | Circuit breaker: window (t−24h, t] around each trade's `sell_timestamp`; trigger time = that sell timestamp; stored as the later of existing/new ISO values. A corrupt stored value is treated as ACTIVE until the user clears it; an ACTIVE breaker cannot be cleared early. | Faithful to when the losses happened; fails safe on corrupt storage. |
| D-22 | Ledger replay validates everything in timestamp order (backdated entries included): no negative cash/wallet, FIFO lot ids, hold period, recomputed fees/profit/banking. Invalid imports are rejected whole. | The ledger is the only financial record; a silently inconsistent ledger is worse than a rejected one. |
| D-23 | Sell is rejected if `sell_timestamp` < `minimum_hold_until` of any consumed lot. | A recorded sale before transfer eligibility is inconsistent data. |
| D-24 | `hold_duration_hours` = floor((sell − earliest consumed lot's buy) / 1h). | Deterministic and verifiable on replay. |
| D-25 | Steam buys can be funded from Steam Wallet (`funding_source`); the lot then counts as inventory (an item, not wallet). | This is the real-world wallet→item→cash path; the wallet balance itself never enters deployable capital. |
| D-26 | Steam data comes from anonymous public pages: `item_nameid` + price history from the listing page (`var line1`, USD verified via `strFormatPrefix == "$"`), quote + depth from `itemordershistogram` (`currency=1`). | `/market/pricehistory` requires a login cookie, which P0-2 forbids. |
| D-27 | CSFloat depth is counted within the first 50 buy-now listings sorted by price; `listing_depth_capped: true` marks a lower bound. | One request per quote; the cap is disclosed. |
| D-28 | Worker caches in per-isolate memory plus Cache API when available; failures (429/timeout) are cached for the quote TTL. No retry. | Cache API is a no-op on `*.workers.dev`; negative caching implements "let the normal TTL cycle recover". |
| D-29 | `worker/index.js` exports only `default`; the implementation lives in `worker/lib.js`. | workerd treats every named export of the entry module as an entrypoint; found by running under `wrangler dev`. |
| D-30 | Added files beyond the spec's list: `js/app.js` (controller), `worker/lib.js` (D-29), `_headers` (CSP), `eslint.config.js`, `scripts/package-pages.mjs`, `scripts/secret-scan.mjs`, `BACKTEST_RESULTS.md`. | Needed for the bootstrap, a working Worker, a safe Pages upload (only shipped files, never `.env`) and the P0-9 audit. |
| D-31 | Chart.js 4.5.1 loads `async` with SRI (hash computed from the npm tarball of the same version; cdnjs serves the npm files). Charts fall back to a data table. | `defer` would let a slow CDN delay the app; `async` never blocks it. |
| D-32 | CORS allow-list via `ALLOWED_ORIGINS` (Pages URL + localhost). | CORS is not auth, but it stops other sites' browsers from spending the CSFloat quota. |
| D-33 | Datetime inputs are labeled and interpreted as UTC. | Spec: all timestamps ISO 8601 UTC. |
| D-34 | Event `confidence` = medium for dates confirmed by search summaries citing Liquipedia/Wikipedia/case lists, low for a single secondary source; each entry has a `methodology` field. | Pages couldn't be fetched directly; the confidence reflects that. |
| D-35 | Tier-compression buckets use the item-price band of the trade's average unit buy price. | "Higher tiers = thinner margins" is a claim about item price levels. |
| D-36 | Implementation order: tiers/breaker core was built with the ledger (Step 3) because the ledger's close logic needs the breaker evaluation; BACKTEST_RESULTS.md was written before the tier UI. No tier constant was tuned on backtest output (none exists). | Dependency order; the spec's intent (no tuning on results) is preserved. |

## v2 — research/evidence system (2026-09-28)

### Conflicts (P0 rules win)

| ID | CONFLICT old X | new Y | Resolution | Alternatives considered → trade-off |
|---|---|---|---|---|
| C1 | P0-1 "NO auto-execute, auto-sell, auto-buy" | Automation levels L1–L3 | Automation is a separately gated tier, **default OFF** at every level. UMBRA or any mode never enables it. L1 only stages external links. L2/L3 need a verified execution API; none exists (DATA_SOURCE_MATRIX #19/#20), so they stay unimplemented and can't be switched on. The permission controller is built and tested with a SYNTHETIC mock executor only. | Drop automation entirely → loses the tested safety controller the user asked for. Implement against unverified endpoints → violates "no feature without verified data". |
| C2 | 30-flip gate (tier compression, ledger flips) | Paper trades | The gate is renamed **EXECUTION_EVIDENCE** and counts completed **REAL** ledger trades only. Paper trades feed SIGNAL_EVIDENCE only. | Counting paper at a discount → pools distributions, which the spec forbids. |
| C3 | Watchlist-only discovery (v1 limitation 4) | Full-market universe | The watchlist stays the standard-mode universe. The full-market universe (last completed Skinport catalog cycle, price ≥ $10) applies only to UMBRA ranking. | Full market everywhere → unbounded request volume under rate limits. |
| C4 | Steam fee: spec formula (15% of gross, → 1700 on 2000) | Valve's exact method (→ 1739) | Keep the conservative default. The exact method is computed and shown beside it wherever a Steam sale appears. The default changes only through an accepted fee-calibration proposal, which creates a new fee_model_version. | Switch to exact now → silent change of a documented default. |
| C5 | P0-8: never phrase a historical simulated margin as "expected margin"; the secret scan flags "expected margin/return/profit" wording | New defined metric `expected_net_profit` | The identifier is kept exactly as defined. Every display renders it as `expected_net_profit (ESTIMATED, pessimistic, not a forecast)` in code form; free-text "expected profit/margin" stays banned by the scan. Historical simulation never feeds it. | Renaming the metric → breaks traceability to the spec. |
| C6 | v1 "no partial-lot sales" (documented limitation, not P0) | FIFO partial-lot splitting | Replaced. Sales allocate FIFO across lots with explicit per-lot quantities; replay validation is unchanged in strictness. Old whole-lot records migrate losslessly. | Keep whole lots → contradicts a direct requirement; no P0 rule protects it. |
| C7 | Position-size formula (15% of deployable, 60% exposure, 40% reserve) | 20% of capital-at-cost cap and velocity cap | All limits apply and the **smallest wins**. Existing definitions are unchanged. | Replace the old formula → the spec says keep existing tier limits. |
| C8 | v1 gate `MIN_LISTING_DEPTH` (supply) | "Liquidity is a gate via observed sale velocity; listing_supply is a label" | The Level 1 scanner (observed discrepancy) keeps its depth gate. The Level 2+ opportunity engine gates on exit-market `observed_sale_velocity` and shows `listing_supply` as a label. | Drop the depth gate → weakens a working v1 control. |

### Phase 0 decisions

| ID | Decision | Alternatives → trade-off |
|---|---|---|
| D-37 | Contract test stores sanitized LIVE fixtures (seller identity and credential-like keys removed; Steam HTML reduced to parser-read fragments; Skinport catalog reduced to probe items plus total count, with the full-body SHA-256 kept). | Store full bodies → personal data of other users and multi-MB fixtures. |
| D-38 | A parser counts as VERIFIED only when a LIVE fixture passes it. Opportunities from observations whose parser is UNVERIFIED carry `PARSER_UNVERIFIED` and are **not ELIGIBLE**. | Trust documented formats → the claim would rest on unchecked inputs. Trade-off: nothing is ELIGIBLE until the user runs the contract test once. |
| D-39 | Daemon placement: local machine (provisional, UNVERIFIED). See ARCHITECTURE_DELTA.md. | VPS → datacenter IPs, extra infrastructure; revisit with netcheck data. |
| D-40 | Skinport effective quote age = age since our observation + 300s upstream cache. | Ignore the upstream cache → understates staleness. Trade-off: under the default 180s limit, Skinport quotes are STALE by construction. |
