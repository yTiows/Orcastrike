# BACKTEST_RESULTS

## Verdict

**(a) Single-market historical simulation: INSUFFICIENT_DATA — not run.** Steam price history could
not be retrieved from the build environment (the container's egress policy blocks
steamcommunity.com). No result exists, and none is shown.

**(b) Cross-market arbitrage backtest: INSUFFICIENT DATA TO VALIDATE CROSS-MARKET STRATEGY.**

Nothing in this repository is evidence that the cross-market strategy is profitable.

## Why (b) cannot be done with free data

A cross-market backtest needs synchronized historical *listing* prices, with listing depth, on
Steam, CSFloat and Skinport for the same instants. The free sources don't provide that:

| Source | What is freely available | What a cross-market backtest needs |
|---|---|---|
| Steam | Median *sale* price per hour (last ~30 days) / per day (older), plus units sold (listing-page `line1`) | Historical lowest listing + depth |
| CSFloat | Current listings only (API key required) | Historical listings |
| Skinport | Current min/median per item; aggregated sales history for 24h/7d/30d/90d windows | Historical listings at matching timestamps |

A sale-price median on one market can't be compared with listing prices on another market at the
same moment. Any "cross-market backtest" built from these would be fabricated alignment, which
P0-4 and P0-7 prohibit.

## (a) Pre-registered methodology

Defined before any data was examined (no data was examined; none could be fetched).

- **Sample (fixed in advance):** the items in `static/watchlist-starter.json` whose current Steam price
  falls in the Tier 1–2 item bands ($1.00–$74.99). Items were chosen for trading volume only (see
  DECISIONS.md D-15), never for how their results look. Items outside the bands are excluded
  up front, whatever their results would have been.
- **Data:** Steam listing-page price history via the Worker `/api/history`: daily volume-weighted
  mean of Steam's reported median sale prices, integer USD cents.
- **Simulation:** for every day *d* in the last 180 days that has data, buy at day *d*'s price
  and sell on Steam at day *d* + 7 (Valve Trade Protection floor), if that day has data. Steam
  fee per `config/fees.js` (spec: 15% of gross; see FEES.md for Valve's actual fee-on-top model).
  One unit, no slippage, no depth check (sale medians carry no depth information).
- **Reported per item:** paired-day sample count, median gross 7-day price change, median net
  margin after the Steam fee, share of positive-net samples.
- **Minimum evidence:** at least 30 paired days per item; fewer → `INSUFFICIENT_DATA` for that item.
- **Interpretation limits:** a Steam→Steam round trip pays Steam's fee on exit and returns
  **Steam Wallet funds, not cash**. The result describes past 7-day price drift on one market.
  It is not a forecast (P0-8) and not evidence about CSFloat/Skinport spreads (P0-7).

## Where the numbers appear in the app

The live UI computes (a) per item on demand (scanner row → "Load historical context"), labeled
**"Historical simulated margin (Steam-only, 7-day hold) — historical context only. Not a
forecast and not evidence of cross-market arbitrage performance."** It sits in its own column,
separate from **"Observed net margin"** (the live cross-market calculation), and the two are
never combined into any "expected" figure.

## Tier-compression claims

Per-tier margin comparisons show `INSUFFICIENT_DATA` until the user's own ledger holds at least 30
completed flips in that tier (`js/tiers.js` `tierCompressionStats`). At build time the ledger is
empty, so every tier is `INSUFFICIENT_DATA`.

## Re-running (a)

With network access to a deployed Worker: open the app, load historical context for each
pre-registered item, and record per-item results here, including every `INSUFFICIENT_DATA`
item. Do not add or drop items after seeing the results.
