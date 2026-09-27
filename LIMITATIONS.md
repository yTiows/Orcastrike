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
3. **No partial-lot sales.** Each buy creates one lot; a sale must consume whole lots in FIFO order.
   Selling 1 unit from a lot of 3 is rejected at input.
4. **Watchlist-only discovery.** The scanner evaluates only the user's watchlist (max 100 items).
   It does not scan the whole market, so opportunities outside the watchlist are invisible.
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
13. **Ledger is local and user-entered.** It is stored in this browser's localStorage only, it is
    not an authoritative or verified record, and there is no server backup. Export regularly.
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
