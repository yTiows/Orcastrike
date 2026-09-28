# DATA_SOURCE_MATRIX

Verification status meanings:
- **VERIFIED**: a LIVE fixture exists under `tests/fixtures/live/` and the parser passed on it.
- **UNVERIFIED**: the format comes from documentation, third-party clients or search results and
  hasn't been checked against a live response.
- **BLOCKED**: the endpoint couldn't be reached from the measuring machine.

**State on 2026-09-28** (`tests/fixtures/live/CONTRACT_REPORT.json`,
`reports/netcheck/2026-09-28T03-04-07-458Z.json`): the build container's egress proxy returns
HTTP 403 for every source host. **Nothing below is VERIFIED.** To verify, run where the network
allows: `node scripts/contract_test.mjs`. `CSFLOAT_API_KEY` is optional and read from the
environment.

Category key: **OBSERVED** = recorded from the source as-is. **OBSERVED-AGG** = an aggregate the
source computes and reports (a count or median), which we observe but can't audit. **SIGNAL** = a
third party's model output. **DERIVED** = computed by us from our own observations.

| # | Data | Source | Endpoint | Authority | Category | Historical | Live | Executable / informational | Freshness requirement (max age) | Rate limit | Auth | Failure state | Fallback | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Lowest ask, Steam (buyer-pays USD) | Steam Community Market | `/market/itemordershistogram?currency=1&item_nameid=` | First-party for the Steam market | OBSERVED | No | Yes, anonymous | Executable (entry leg only; Steam sale proceeds are Steam Wallet) | quote 180s | Not documented; community-reported aggressive per-IP throttling (unverified) | None (no cookies — P0) | RATE_LIMITED / UNAVAILABLE / INVALID | Worker `/api/quote?source=steam` | BLOCKED |
| 2 | Listing supply near quote, Steam | Steam | same histogram `sell_order_graph` (cumulative) | First-party | OBSERVED (supply only) | No | Yes | Informational | depth 300s | as #1 | None | INVALID on non-monotonic graph | — | BLOCKED |
| 3 | `item_nameid` | Steam listing page | `/market/listings/730/{name}` (`Market_LoadOrderSpread(id)`) | First-party | OBSERVED (static id) | n/a | Yes | Informational | cached 7 days | as #1 | None | UNAVAILABLE | — | BLOCKED |
| 4 | Lowest price, 24h median, 24h volume | Steam | `/market/priceoverview/?appid=730&currency=1` | First-party | OBSERVED (price) / OBSERVED-AGG (median, volume) | No | Yes | Informational (Steam isn't an exit leg) | quote 180s, sales 1800s | as #1 | None | UNAVAILABLE / INVALID (non-`$` format) | — | BLOCKED |
| 5 | Median sale price + units sold, hourly (~30d) / daily (older) | Steam listing page | `var line1=` embedded in `/market/listings/730/{name}` | First-party | OBSERVED-AGG | Yes, years | Yes | Informational (Steam-only historical context) | history 3600s | as #1 | None | INVALID if currency ≠ `$` | — | BLOCKED |
| 6 | Steam `pricehistory` API | Steam | `/market/pricehistory/` | First-party | — | Yes | Needs a login cookie | — | — | — | Steam session | **NOT USED** (P0: no Steam credentials) | #5 | — |
| 7 | Minimum ask, Skinport (EUR → USD cents at ingestion) | Skinport | `/v1/items?app_id=730&currency=EUR&tradable=1` (bulk) | First-party | OBSERVED | No | Yes | Executable (entry and exit) | quote 180s, **plus up to 300s upstream cache** | 8 req / 5 min per endpoint group (third-party client docs; unverified); responses cached 5 min | None; `Accept-Encoding: br` required | UNAVAILABLE (FX missing) / STALE / INVALID | Worker `/api/quote?source=skinport` | BLOCKED |
| 8 | Full-market catalog (UMBRA universe) | Skinport | same `/v1/items` bulk | First-party | OBSERVED | No | Yes | Informational (universe discovery) | catalog 3600s | as #7 | None | discovery cycle incomplete → UMBRA universe unavailable | — | BLOCKED |
| 9 | Total listing count per item | Skinport | `/v1/items` `quantity` | First-party | OBSERVED (all prices) | No | Yes | Informational; **never** used as ±10% supply | as #7 | as #7 | None | — | — | BLOCKED |
| 10 | ±10% listing supply | Skinport | — | — | — | — | **Not exposed by the public API** | — | — | — | — | Always unavailable | — | IMPOSSIBLE |
| 11 | Sale counts and medians for 24h / 7d / 30d / 90d | Skinport | `/v1/sales/history?market_hash_name=a,b` | First-party | OBSERVED-AGG (counts); medians EUR → USD | Rolling windows only; no time series | Yes | Informational → `observed_sale_velocity` on the Skinport exit leg | sales 1800s | shared with #7; cached 5 min | None; `br` required | INVALID / UNAVAILABLE | — | BLOCKED |
| 12 | Individual sales feed | Skinport | WebSocket `saleFeed` (socket.io + msgpack) | First-party | OBSERVED | From connect time only | Yes | Informational | — | — | None | — | #11 | UNVERIFIED, **not implemented** |
| 13 | Lowest buy-now ask, CSFloat (USD cents) | CSFloat | `/api/v1/listings?market_hash_name=&sort_by=lowest_price&type=buy_now&limit=50` | First-party | OBSERVED | No | Yes | Executable (entry and exit) | quote 180s | Not documented to us; `x-ratelimit-*` headers read if present | API key (Worker secret / daemon env) | NOT_CONFIGURED / RATE_LIMITED / INVALID | Worker | UNVERIFIED (no key; docs unreachable) |
| 14 | Listing supply near quote, CSFloat (first 50) | CSFloat | same | First-party | OBSERVED (supply; lower bound when capped) | No | Yes | Informational | depth 300s | as #13 | Key | as #13 | — | UNVERIFIED |
| 15 | Reference price (`reference.predicted_price`, `base_price`, `float_factor`, `quantity`) | CSFloat | embedded in listing objects | CSFloat's pricing model | **SIGNAL**: never truth, never an exit price | No | Yes | Informational only | reference 900s | as #13 | Key | missing → no signal | — | UNVERIFIED (field names from the third-party Go client `csfloat_go`) |
| 16 | Float value, paint seed, paint index, stickers | CSFloat | listing `item.*` | First-party per listing | OBSERVED | No | Yes | Identity (Doppler phase via paint index) / informational | as #13 | as #13 | Key | missing → identity stays name+wear | — | UNVERIFIED |
| 17 | Buy orders (demand-side quantity at price) | CSFloat | `/api/v1/listings/{id}/buy-orders` (assumed) | First-party | OBSERVED | No | Unknown | Informational → `buyer_side_liquidity` | quote 180s | Unknown | Key | — | none: `buyer_side_liquidity = UNVERIFIED` | UNVERIFIED (existence unconfirmed) |
| 18 | Individual sales | CSFloat | `/api/v1/history/{name}/sales` (assumed) | First-party | OBSERVED | Recent only | Unknown | Informational → velocity on the CSFloat exit leg | sales 1800s | Unknown | Key? | — | none: CSFloat exit velocity is INSUFFICIENT / UNKNOWN | UNVERIFIED |
| 19 | Purchase a listing (API) | CSFloat | unknown | — | — | — | Unknown | Would be executable | — | — | Key | — | L2/L3 **not implemented** | UNVERIFIED |
| 20 | Create / edit / delete listing (reprice) | CSFloat | unknown (`POST/PATCH/DELETE /api/v1/listings`, assumed) | — | — | — | Unknown | Would be executable | — | — | Key | — | L3 auto-reprice **not implemented** | UNVERIFIED |
| 21 | Instant-sale (bot) quotes | Third-party bot sites | none identified with documented public API and terms | — | OBSERVED if it existed | — | — | Informational ("instant sale reference quote") | quote 180s | — | — | Always UNAVAILABLE | — | UNVERIFIED, **isolated** |
| 22 | EUR→USD reference rate | Frankfurter (ECB) | `/v1/latest?base=EUR&symbols=USD` | ECB reference rate, via a free mirror | OBSERVED (daily fixing) | Yes, since 1999 | Yes | Conversion only | 1h cache; STALE if the ECB date is > 4 days old | Unspecified "abuse" limit, no quota | None | UNAVAILABLE / INVALID / STALE | none: Skinport quotes become UNAVAILABLE | BLOCKED |
| 23 | Own snapshot time series (asks, supply) | Daemon SQLite | `market_observations` | Ours | DERIVED from OBSERVED | From daemon start (forward only) | Yes | Feeds `hold_adverse_move`; the only source for any future synchronized "backtest" | — | — | — | coverage < 80% → SIGNAL_EVIDENCE fails | — | Runs locally; see Phase 1 tests |
| 24 | Trade Protection hold (7 days) | Valve | policy (July 2025 update) | First-party policy | Rule | — | — | Hold minimum | — | — | — | — | — | Confirmed by multiple 2025 sources (search snippets) |

## Consequences that drive the design

- The only exit markets with measurable pieces are **Skinport** (price #7 plus sale counts #11, no
  supply metric) and **CSFloat** (price and supply #13/#14, velocity UNVERIFIED #18). Until #18 is
  verified, a CSFloat exit leg's `observed_sale_velocity` is INSUFFICIENT, its
  `estimated_exit_days` is UNKNOWN, and it is excluded from ranking. UMBRA can show it only when
  the user allows THIN items, and then still labeled.
- Skinport quotes are upstream-cached for up to 300s, so their effective age is `now −
  observed_at + 300s`. Under the default 180s quote limit they are **STALE by construction**. The
  limit is a bounded user setting; raising it is a documented dangerous combination
  (CONFIGURATION.md).
- `buyer_side_liquidity`, the instant-sale reference, pattern-premium amounts, and L2/L3
  execution have no verified data source. They are isolated and report UNVERIFIED / UNAVAILABLE.
