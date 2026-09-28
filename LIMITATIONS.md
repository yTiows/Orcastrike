# LIMITATIONS

1. **No pattern, float or sticker awareness.** Item identity in v1 is the exact `market_hash_name`
   (name + wear + StatTrak™/Souvenir). Two listings with the same name are treated as identical even
   when float, pattern (e.g. Case Hardened blue gems, Doppler phases) or applied stickers make one
   worth far more. The lowest listing may be a low-demand float or pattern; the app can't see
   pattern premiums and never implies it can.
2. **Single-market backtest only; cross-market strategy unvalidated.** The only historical
   simulation is Steam→Steam over a 7-day hold using Steam median sale prices. It is historical
   context, not a forecast, and not evidence of cross-market arbitrage performance. Verdict:
   **INSUFFICIENT DATA TO VALIDATE CROSS-MARKET STRATEGY.** The simulation (a) was **not run**
   at build time because Steam was unreachable from the build environment (BACKTEST_RESULTS.md).
3. ~~**No partial-lot sales.**~~ *Superseded in v2 (C6):* sales allocate FIFO across lots and may
   split the last lot.
4. **Watchlist-only discovery (standard mode).** The scanner evaluates only the user's watchlist
   (max 100 items), so opportunities outside the watchlist are invisible. *v2 (C3):* UMBRA ranks
   the full Skinport catalog (≥ $10) from the last completed discovery cycle.
5. **Skinport can never be a qualifying sell leg.** Its public API exposes no price distribution,
   so the ±10% `listing_depth` can't be measured. Skinport→sell rows are always `INSUFFICIENT_DATA`.
   Skinport works as a buy leg and shows `total_listings` (any price) for information only.
6. **Without a CSFloat API key nothing can be highlighted.** CSFloat is then the only cash sell leg
   with measurable depth, so with `CSFLOAT_API_KEY` unset every pair is `INSUFFICIENT_DATA`, and
   inventory valuation (CSFloat/Skinport, depth-qualified) is `INSUFFICIENT_DATA` for every lot.
7. **`listing_depth` is supply, not demand.** It counts active listings within ±10% of the quoted
   price. It is not verified buyer demand, fill probability or sales volume. CSFloat depth counts
   only the first 50 listings (`capped` marks a lower bound).
8. **Upstream formats not verified live.** Steam, Skinport, CSFloat and Frankfurter were unreachable
   from the build container. Parsers follow the known formats and fail closed (`INVALID` /
   `UNAVAILABLE`) on any mismatch, but may need adjusting against real responses. In particular:
   Steam listing-page history is only accepted when the page declares `strFormatPrefix = "$"`; the
   Skinport `tradable=1` parameter form; the CSFloat response envelope (array or `{data: []}`).
9. **Steam rate limits.** Steam market endpoints throttle aggressively, and Cloudflare egress IPs
   are shared. Expect `RATE_LIMITED` for some items on a full-watchlist refresh. The client paces
   Steam at 1 request per 1.5s, and the Worker caches the result for 90s without retrying.
10. **Cloudflare free plan CPU.** The Skinport bulk item list (tens of thousands of items) is
    parsed in the Worker. On the free plan's 10 ms CPU limit this can fail (surfaced as
    `UNAVAILABLE`); Workers Paid avoids it. The Cache API is a no-op on `*.workers.dev`, so caching
    is per-isolate memory there.
11. **Fees partly unverified.** CSFloat payout rates are pinned mid-range defaults inside a
    published 0.5–2.5% tiered band. Buy-side deposit fees, Steam Wallet funding and bank FX are not
    modeled; each of these overstates profit when it applies. Steam's fee is the spec's 15%-of-gross
    approximation, which understates wallet credit by about 2.2% (FEES.md).
12. **Transfer and reversal risk.** `minimum_hold_until = buy + 7 days` follows Valve Trade
    Protection (July 2025). During those 7 days the counterparty of a trade can reverse it; the app
    does not model reversal risk or price moves during the hold beyond the labeled historical
    context.
13. **Ledger is local and user-entered.** It is not an authoritative or verified record, and there
    is no server backup. *v2:* stored in IndexedDB (localStorage fallback), with a checksummed daily
    backup to a folder you choose (Chromium only) and checksummed export. Export regularly.
    Fees on recorded sales are computed from the configured constants, not read from receipts; use
    cash adjustments to reconcile.
14. **Valuation snapshots.** "Deployable capital at close" (reinvestment and breaker) values the
    remaining lots with quotes at *record* time, not at the historical sell time, so backfilled
    trades use current prices for that snapshot.
15. **Price precision.** Upstream decimal prices are rounded half-up to whole cents at ingestion,
    which loses sub-cent precision in Steam's medians for sub-$1 items.
16. **CSP and custom domains.** `_headers` allows `connect-src` to `*.workers.dev` and localhost
    only. A Worker on a custom domain needs that header updated.
17. **Events.** Dates were confirmed through web-search summaries of the cited sources, not by
    fetching the pages (see each entry's `methodology`). Price deltas need Steam history for the
    item; without it the result is `INSUFFICIENT_DATA`.
18. **Deployment not performed.** No Cloudflare credentials were available in the build
    environment. Neither the Worker nor Pages is live, and the production smoke test has not run.

## v2 (2026-09-28)

19. **Nothing is VERIFIED, so nothing can be ELIGIBLE yet.** Every live endpoint returned 403
    from the build container. A parser counts as VERIFIED only after a LIVE fixture passes it
    (D-38), so every opportunity is `INSUFFICIENT (PARSER_UNVERIFIED)` until you run
    `node scripts/contract_test.mjs` on a normal network and every probe passes.
20. **Skinport quotes are STALE by construction** at the default 180 s quote age, because Skinport
    documents a 300 s response cache that is added to effective age (D-40). Raising
    `snapshot.max_age_quote_s` above 300 admits them, with a warning.
21. **CSFloat exit liquidity is UNKNOWN.** Exit-market velocity needs ≥ 10 observed sales from a
    verified endpoint. The CSFloat sales-history endpoint is unverified, so CSFloat exit legs are
    `LIQUIDITY_UNKNOWN` and excluded from standard ranking.
22. **No execution path.** L2, L3, auto-reprice, AUTOMATION mode and in-app ASSISTED approvals are
    BLOCKED: no verified purchase or listing-edit API (DATA_SOURCE_MATRIX #19/#20). The permission
    controller is tested with a SYNTHETIC mock only.
23. **L1 staging happens only in the UMBRA autopilot.** Setting L1 in standard mode stages nothing
    (RESEARCH = no staging; D-46).
24. **Push notifications (ntfy) are not implemented.** The spec gates them on Phases 0–5 being
    verified, and Phase 0 isn't. Notifications are in-app only.
25. **Unavailable metrics.** `instant_sale_reference` is always UNAVAILABLE (no verified source).
    `buyer_side_liquidity` is always UNVERIFIED (the CSFloat buy-orders endpoint is unverified).
    Market regime coverage is UNKNOWN and never claimed.
26. **Pattern premiums: Doppler phases only.** Case Hardened, Fade and Marble Fade tables are
    empty because no citable source could be fetched. Those items stay UNKNOWN, and UNKNOWN never
    enters a profit figure.
27. **Evidence takes calendar time.** `hold_adverse_move` needs ≥ 30 snapshot pairs H days apart
    within 30 days. SIGNAL_EVIDENCE needs ≥ 14 days of observation and ≥ 30 closed paper trades.
    A fresh daemon ranks nothing for at least H days (7 by default).
28. **One copy of the daemon database.** A corrupt `orcastrike.sqlite` means a fresh start or a
    restore from your own copy of the data directory (FAILURE_STATES.md). The daemon doesn't back
    itself up. The browser ledger, the only record of real trades, is separate and has its own
    backups.
29. **Ledger → daemon sync is one-way.** Real trades, capital and breaker state go from the
    browser to the daemon for evidence. The daemon never edits the ledger.
30. **Browser coverage.** Only Chromium was run. Firefox/Safari behaviour (IndexedDB, no File
    System Access backup) is labeled UNVERIFIED in the UI.
31. **The browser test layer isn't in `npm test`.** It needs Playwright and Chromium
    (`npm run smoke:browser`, D-44).
32. **`node:sqlite` is experimental in Node 22.** Its warning is suppressed in the npm scripts, and
    the API may change in a later Node release.
33. **Daemon placement is provisional.** The container's network measured UNSUITABLE. The local
    machine is the provisional choice (D-39) until `node scripts/netcheck.mjs` runs there.
