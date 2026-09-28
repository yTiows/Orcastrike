# FEES

Constants live in `config/fees.js`. `js/money.js` converts them to integer basis points and is the
only place fee math happens. **Checked on 2026-09-27**, but only through web-search result
snippets: the vendors' own fee pages (skinport.com, csfloat.com, docs.csfloat.com) were blocked
by the build container's egress policy. Re-verify each row against the vendor page before relying
on it.

| Constant | Value | Status | Source |
|---|---|---|---|
| `STEAM_SELL_FEE` | 0.15 (5% Steam + 10% CS2) | Rates confirmed; **how they are applied is approximated** (see below) | Valve market fee structure; algorithm in Steam's public `economy_common.js` (`CalculateFeeAmount`) |
| `CSFLOAT_SELL_FEE` | 0.02 | Consistent with 2026 sources: "2% seller fee, no buyer fees" | Search snippets from steamanalyst.com/guides/marketplaces/csfloat, cs2central.gg/blog/csfloat-review, blog.csfloat.com/changes-to-fees-on-csgofloat-market |
| `CSFLOAT_PAYOUT_FEE_RATE.bank` | 0.015 | **Pinned mid-range**, not exact | Sources state "tiered payout fee of 0.5% to 2.5% depending on method and amount"; the rate falls with the seller's sales volume. A new seller may pay more than 1.5%. |
| `CSFLOAT_PAYOUT_FEE_RATE.usdc` | 0.010 | **Pinned mid-range**, not exact | Same band; USDC on Polygon reported as "no gas fee" |
| `SKINPORT_SELL_FEE_STANDARD` | 0.08 | Confirmed: Skinport lowered it from 12% to 8% (Skinport on X, status 1945934661168881859) | skinport.com/faq/sales-fee (snippet) |
| `SKINPORT_SELL_FEE_OVER_1000EUR` | 0.06 | Confirmed: "items listed at 1,000 USD/EUR or more … 6%" | skinport.com/blog/reduced-fee-high-tier-items (snippet) |
| `SKINPORT_SELL_FEE_PRIVATE_LISTING` | 0.02 | Confirmed | skinport.com/blog/lower-fees-private-listings (snippet) |
| `SKINPORT_PAYOUT_FEE_RATE` | 0 | Skinport states no payout fee; the seller's bank transfer/FX costs are **not modeled** | Search snippet (steamdb.com/en/markets/skinport, cs2.io) |
| `SKINPORT_SOURCE_CURRENCY` | EUR → USD at ingestion | FX: Frankfurter v1 (`api.frankfurter.dev/v1/latest?base=EUR&symbols=USD`), ECB reference rate, free, no key, 1h cache, STALE if the ECB date is more than 4 days old | frankfurter.dev |

## Canonical formula (spec v3), per `js/money.js`

```
after_seller_fee_cents = round(gross × (1 − sell_fee))        // half-up, integer bps
payout_fee_cents       = round(after_seller_fee × payout_fee)  // 0 where N/A
net_sale_proceeds      = after_seller_fee − payout_fee
net_profit             = net_sale_proceeds − quantity × unit_buy_price
net_margin_bps         = round(net_profit × 10000 / acquisition_cost)
```

All multiplication and division runs in BigInt with explicit round-half-up; rates are integer basis
points parsed from decimal strings, so no float ever decides a cent. For quantity > 1 the formula
is applied to the total gross, as the spec states (marketplaces actually fee each listing
separately, so results can differ by ≤ quantity/2 cents).

## Steam: the 0.15 approximation (explicit, not exact)

Valve does **not** take 15% of the buyer price. Both fees are computed on the amount the seller
receives and added on top:

```
buyer_pays = received + max(floor(received × 5%), 1) + max(floor(received × 10%), 1)
```

So for a buyer price of $20.00 the seller receives **$17.39** (86.95%), not $17.00. The spec's
canonical formula and its "Steam Wallet separation" acceptance test pin `round(2000 × 0.85) =
1700`, so the default model is `STEAM_FEE_MODEL = "flat_on_gross"`. This **understates Steam Wallet
credit by about 2.2% of gross** (conservative direction). Valve's exact algorithm is implemented
and tested as `steamValveSellerReceives()` (`valve_fee_on_top` model); switching the config
constant makes it the default. This only affects Steam sales, which pay into Steam Wallet, never
cash, and are never a scanner sell leg.

## Not modeled (overstate profit if they apply)

- Buy-side deposit / payment-method fees on CSFloat and Skinport (card top-ups etc.).
- Adding cash to Steam Wallet (the funding path for Steam buys).
- Bank-side FX when Skinport EUR balances are withdrawn to a USD account.
- The CSFloat payout tier for a specific account (see the pinned mid-range above).
- Steam's minimum-fee floor at very low prices under the default flat model (the Valve model
  handles it).

## Fee model versions and calibration (v2, 2026-09-28)

- **Base version** `fees-v1@2026-09-27` is exactly `config/fees.js` as documented above
  (`js/research/fee-model.js` `BASE_FEE_MODEL`). Buy-side fees are 0 bps on every market, because
  every observed entry price is already the buyer-pays listing price. Deposit and payment-method
  fees stay unmodeled (above).
- Every opportunity, paper trade and recorded sale stores the `fee_model_version` in force at its
  timestamp. Old records are never recomputed with a newer model.
- **Calibration** (`js/research/fee-calibration.js`) compares the net you actually received (the
  optional receipt field on a sale) with the net the model computed. With ≥ 3 receipts for one
  market it writes a PROPOSED_CALIBRATION with observed, expected, difference and possible
  reasons:
  - **Steam:** if the receipts match Valve's exact fee-on-top method, it proposes
    `STEAM_FEE_MODEL = valve_fee_on_top` (C4).
  - **CSFloat / Skinport:** if every difference has the same sign, it reports the implied total
    fee rate and a candidate override.
- **Nothing changes until you accept.** Acceptance (POST `/api/v2/fee-models/accept`) requires
  `confirm: true` and a same-origin request, and accepts only these keys: `STEAM_FEE_MODEL`,
  `CSFLOAT_SELL_FEE`, `CSFLOAT_PAYOUT_FEE_RATE`, `SKINPORT_SELL_FEE_STANDARD`,
  `SKINPORT_SELL_FEE_OVER_1000EUR`, `SKINPORT_SELL_FEE_PRIVATE_LISTING`,
  `SKINPORT_PAYOUT_FEE_RATE`. It creates a new dated version
  (`fees-<date>-<overridden keys>`) with its parent and source recorded. Earlier versions are
  never edited.
- **C4 (Steam):** the conservative 15%-of-gross default stays. Wherever a Steam sale appears
  (every closed-trade row and the sell confirmation), Valve's exact result is shown beside the
  model that was used. The default changes only
  through an accepted calibration.
