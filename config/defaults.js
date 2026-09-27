// Immutable shipped defaults. User overrides (localStorage, js/state.js) layer on
// top after validation; this object is deep-frozen and never mutated.

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const DEFAULTS = deepFreeze({
  // Base URL of the deployed Worker, e.g. "https://skin-arb-terminal-proxy.<acct>.workers.dev".
  // Empty = not configured; every quote then reports NOT_CONFIGURED. Overridable in Settings.
  WORKER_BASE_URL: "",

  risk: {
    MAX_PCT_CAPITAL_PER_POSITION: 0.15,
    MAX_AGGREGATE_OPEN_EXPOSURE: 0.60,
    MIN_FREE_CASH_RESERVE: 0.40,
  },

  filters: {
    MIN_NET_PROFIT_CENTS: 50,
    MIN_NET_MARGIN_PCT: 3.0,
    MIN_LISTING_DEPTH: 5,
  },

  // listing_depth window: ±10% of the quoted price, same market, same snapshot.
  LISTING_DEPTH_WINDOW_PCT: 0.10,

  STOP_LOSS_FLAG_THRESHOLD: 0.20,

  CIRCUIT_BREAKER_LOSS_PCT: 0.10,
  CIRCUIT_BREAKER_WINDOW_HOURS: 24,
  CIRCUIT_BREAKER_COOLDOWN_HOURS: 24,

  REINVEST_BANK_PCT: 0.30,
  REINVEST_THRESHOLD_CENTS: 10000,

  MAX_TRACKED_ITEMS: 100,

  // A quote older than this (captured_at → now) is STALE and never enters a calculation.
  QUOTE_MAX_AGE_SECONDS: 300,
  // ECB publishes once per TARGET working day; 4 calendar days covers a long weekend.
  FX_MAX_RATE_AGE_DAYS: 4,

  // Valve Trade Protection floor (July 2025 update): 7 days.
  TRANSFER_HOLD_DAYS: 7,

  CSFLOAT_PAYOUT_RAIL: "bank",

  // Deployable capital tiers: lower bound inclusive, upper bound exclusive, top tier unbounded.
  // Item price bands use the same convention (DECISIONS.md D-07).
  TIERS: [
    { tier: 1, capital_min_cents: 2500, capital_max_cents: 10000, band_min_cents: 100, band_max_cents: 1500 },
    { tier: 2, capital_min_cents: 10000, capital_max_cents: 50000, band_min_cents: 1500, band_max_cents: 7500 },
    { tier: 3, capital_min_cents: 50000, capital_max_cents: 200000, band_min_cents: 7500, band_max_cents: 30000 },
    { tier: 4, capital_min_cents: 200000, capital_max_cents: null, band_min_cents: 30000, band_max_cents: null },
  ],

  // Tier-compression claims need this many ledger-recorded flips in the tier.
  TIER_COMPRESSION_MIN_FLIPS: 30,

  // Single-market historical simulation (js/backtest.js).
  BACKTEST_HOLD_DAYS: 7,
  BACKTEST_LOOKBACK_DAYS: 180,
  BACKTEST_MIN_SAMPLES: 30,

  // Event price-delta: 7 days either side, each side needs this many days with data.
  EVENT_DELTA_WINDOW_DAYS: 7,
  EVENT_DELTA_MIN_DAYS_PER_SIDE: 5,
});
