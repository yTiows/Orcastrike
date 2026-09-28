// Marketplace fee constants. Sources, check dates and caveats: FEES.md.
// Rates are decimal fractions as published; js/money.js converts them to integer
// basis points (rateToBps) before any arithmetic. Never do math on these directly.

export const FEES = Object.freeze({
  // Steam: 5% Steam fee + 10% CS2 game fee. Applied per spec as a flat fraction of
  // the buyer-paid price. Valve actually computes both fees on the seller-received
  // amount (fee-on-top), so the real seller credit is higher; see FEES.md.
  STEAM_SELL_FEE: 0.15,
  // "flat_on_gross" (spec v3 canonical formula, default) | "valve_fee_on_top"
  STEAM_FEE_MODEL: "flat_on_gross",
  STEAM_VALVE_WALLET_FEE_PCT: 0.05,
  STEAM_VALVE_PUBLISHER_FEE_PCT: 0.10,
  STEAM_MIN_BUYER_PRICE_CENTS: 3,

  CSFLOAT_SELL_FEE: 0.02,
  CSFLOAT_DEFAULT_PAYOUT_RAIL: "bank",
  // Percentage rates, pinned mid-range inside CSFloat's published 0.5–2.5% tiered band.
  // Not flat fees. Unverified against the exact tier for a given account; FEES.md.
  CSFLOAT_PAYOUT_FEE_RATE: Object.freeze({ bank: 0.015, usdc: 0.010 }),

  SKINPORT_SELL_FEE_STANDARD: 0.08,
  SKINPORT_SELL_FEE_OVER_1000EUR: 0.06,
  SKINPORT_SELL_FEE_PRIVATE_LISTING: 0.02,
  SKINPORT_HIGH_TIER_THRESHOLD_EUR_CENTS: 100000, // "items listed at 1,000 or more"
  SKINPORT_SOURCE_CURRENCY: "EUR",
  // Skinport states no payout fee; the seller's bank/FX costs are out of scope (FEES.md).
  SKINPORT_PAYOUT_FEE_RATE: 0,
});

export const MARKETS = Object.freeze(["steam", "csfloat", "skinport"]);
// Markets whose proceeds are USD cash. Steam proceeds are Steam Wallet only (P0-5).
export const CASH_SELL_MARKETS = Object.freeze(["csfloat", "skinport"]);
export const SKINPORT_FEE_SCHEDULES = Object.freeze(["standard", "over_1000eur", "private"]);
export const CSFLOAT_PAYOUT_RAILS = Object.freeze(["bank", "usdc"]);
