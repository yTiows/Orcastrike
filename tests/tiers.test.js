import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../config/defaults.js";
import {
  circuitBreakerStatus,
  evaluateCircuitBreaker,
  isPositionEligible,
  isPriceInBand,
  maxPositionSize,
  stopLossFlag,
  tierCompressionStats,
  tierForCapital,
  validateRiskConfig,
} from "../js/tiers.js";

const HOUR = 3600000;

test("ACCEPTANCE: tier boundary — $100.00 exactly is Tier 2", () => {
  assert.equal(tierForCapital(10000).tier, 2);
  assert.equal(tierForCapital(9999).tier, 1);
  assert.equal(tierForCapital(2500).tier, 1);
  assert.equal(tierForCapital(2499), null);
  assert.equal(tierForCapital(49999).tier, 2);
  assert.equal(tierForCapital(50000).tier, 3);
  assert.equal(tierForCapital(199999).tier, 3);
  assert.equal(tierForCapital(200000).tier, 4);
  assert.equal(tierForCapital(10 ** 12).tier, 4);
  assert.equal(tierForCapital(Number.NaN), null);
});

test("item price bands use the same lower-inclusive / upper-exclusive convention", () => {
  const t1 = tierForCapital(5000);
  assert.equal(isPriceInBand(t1, 100), true);
  assert.equal(isPriceInBand(t1, 1499), true);
  assert.equal(isPriceInBand(t1, 1500), false);
  assert.equal(isPriceInBand(t1, 99), false);
  const t4 = tierForCapital(300000);
  assert.equal(isPriceInBand(t4, 30000), true);
  assert.equal(isPriceInBand(t4, 10 ** 9), true);
  assert.equal(isPriceInBand(null, 500), false);
});

test("ACCEPTANCE: position eligibility — computed max and resulting status", () => {
  const risk = validateRiskConfig(DEFAULTS.risk);
  assert.equal(risk.ok, true);
  const p = maxPositionSize({
    deployableCents: 5000,
    usdCashCents: 5000,
    bankedCents: 0,
    openExposureCents: 0,
    riskBps: risk.bps,
  });
  assert.equal(p.cap_by_position_pct_cents, 750); // floor(5000 × 0.15)
  assert.equal(p.cap_by_exposure_cents, 3000); // floor(5000 × 0.60) − 0
  assert.equal(p.cap_by_free_cash_cents, 3000); // 5000 − 0 − floor(5000 × 0.40)
  assert.equal(p.max_position_size_cents, 750);
  // 2000 > 750 → not eligible → BLOCKED_BY_POSITION_SIZE (asserted end-to-end in scanner tests)
  assert.equal(isPositionEligible(2000, p.max_position_size_cents), false);
  assert.equal(isPositionEligible(750, p.max_position_size_cents), true);
  assert.equal(isPositionEligible(751, p.max_position_size_cents), false);
  assert.equal(isPositionEligible(0, 0), false); // max must be > 0
});

test("position size: exposure and free-cash caps bind when they are smaller", () => {
  const { bps } = validateRiskConfig(DEFAULTS.risk);
  const p = maxPositionSize({ deployableCents: 10000, usdCashCents: 5000, bankedCents: 500, openExposureCents: 5500, riskBps: bps });
  assert.equal(p.cap_by_position_pct_cents, 1500);
  assert.equal(p.cap_by_exposure_cents, 500);
  assert.equal(p.cap_by_free_cash_cents, 500);
  assert.equal(p.max_position_size_cents, 500);
  const neg = maxPositionSize({ deployableCents: 10000, usdCashCents: 3000, bankedCents: 0, openExposureCents: 7000, riskBps: bps });
  assert.equal(neg.max_position_size_cents, -1000);
  assert.equal(isPositionEligible(100, neg.max_position_size_cents), false);
});

test("risk override validation rejects invalid combinations", () => {
  const ok = (r) => validateRiskConfig({ ...DEFAULTS.risk, ...r }).ok;
  assert.equal(ok({}), true);
  assert.equal(ok({ MAX_PCT_CAPITAL_PER_POSITION: 1 }), true);
  assert.equal(ok({ MAX_PCT_CAPITAL_PER_POSITION: 0 }), false);
  assert.equal(ok({ MAX_PCT_CAPITAL_PER_POSITION: 1.2 }), false);
  assert.equal(ok({ MAX_AGGREGATE_OPEN_EXPOSURE: 0 }), false);
  assert.equal(ok({ MIN_FREE_CASH_RESERVE: 0 }), true);
  assert.equal(ok({ MIN_FREE_CASH_RESERVE: 1 }), false);
  assert.equal(ok({ MAX_AGGREGATE_OPEN_EXPOSURE: 0.7, MIN_FREE_CASH_RESERVE: 0.4 }), false); // sum > 1
  assert.equal(ok({ MAX_AGGREGATE_OPEN_EXPOSURE: 0.6, MIN_FREE_CASH_RESERVE: 0.4 }), true); // sum = 1
  assert.equal(ok({ MAX_PCT_CAPITAL_PER_POSITION: 0.12345 }), false);
  assert.equal(ok({ MAX_PCT_CAPITAL_PER_POSITION: "0.1" }), false);
});

test("stop-loss flag: >= 20% unrealized loss flags; missing valuation is INSUFFICIENT_DATA", () => {
  assert.equal(stopLossFlag({ acquisitionCostCents: 1000, currentValueCents: 800, thresholdBps: 2000 }).state, "FLAGGED");
  assert.equal(stopLossFlag({ acquisitionCostCents: 1000, currentValueCents: 801, thresholdBps: 2000 }).state, "OK");
  assert.equal(stopLossFlag({ acquisitionCostCents: 1000, currentValueCents: 1500, thresholdBps: 2000 }).state, "OK");
  assert.equal(stopLossFlag({ acquisitionCostCents: 1000, currentValueCents: null, thresholdBps: 2000 }).state, "INSUFFICIENT_DATA");
});

test("ACCEPTANCE: circuit breaker persistence — triggered_at now−25h reports expired", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const s = circuitBreakerStatus(new Date(now - 25 * HOUR).toISOString(), now);
  assert.equal(s.state, "EXPIRED");
  assert.equal(s.active, false);
  assert.equal(s.expires_at, new Date(now - HOUR).toISOString());

  const active = circuitBreakerStatus(new Date(now - 23 * HOUR).toISOString(), now);
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.active, true);

  assert.equal(circuitBreakerStatus(null, now).state, "INACTIVE");
  // Only the timestamp is meaningful; a stored boolean is not a valid state.
  assert.equal(circuitBreakerStatus(true, now).state, "INVALID");
  assert.equal(circuitBreakerStatus("garbage", now).active, true); // capital-protective
});

test("circuit breaker sums GROSS losses in the trailing 24h; gains do not offset", () => {
  const close = "2026-09-27T12:00:00.000Z";
  const at = (h) => new Date(Date.parse(close) - h * HOUR).toISOString();
  const trades = [
    { sell_timestamp: at(1), realized_net_profit_cents: -200 },
    { sell_timestamp: at(5), realized_net_profit_cents: 1000 }, // gain: ignored
    { sell_timestamp: at(23), realized_net_profit_cents: -100 },
    { sell_timestamp: at(24), realized_net_profit_cents: -5000 }, // exactly 24h ago: outside (window is (t−24h, t])
    { sell_timestamp: at(-1), realized_net_profit_cents: -5000 }, // after close: outside
  ];
  const r = evaluateCircuitBreaker({ trades, closeTimestampIso: close, deployableAtCloseCents: 3000, lossBps: 1000, windowHours: 24 });
  assert.equal(r.gross_realized_loss_cents, 300);
  assert.equal(r.threshold_cents, 300);
  assert.equal(r.tripped, true);
  const r2 = evaluateCircuitBreaker({ trades, closeTimestampIso: close, deployableAtCloseCents: 3001, lossBps: 1000, windowHours: 24 });
  assert.equal(r2.tripped, false);
  const none = evaluateCircuitBreaker({ trades: [], closeTimestampIso: close, deployableAtCloseCents: 0, lossBps: 1000, windowHours: 24 });
  assert.equal(none.tripped, false);
});

test("tier compression claims need >= 30 recorded flips in that tier", () => {
  const flip = (unit, margin) => ({ quantity: 1, acquisition_cost_cents: unit, net_margin_bps: margin });
  const t1 = Array.from({ length: 29 }, (_, i) => flip(500, i));
  const stats29 = tierCompressionStats(t1);
  assert.equal(stats29[0].state, "INSUFFICIENT_DATA");
  assert.equal(stats29[0].flips, 29);
  const stats30 = tierCompressionStats([...t1, flip(500, 29)]);
  assert.equal(stats30[0].state, "OK");
  assert.equal(stats30[0].median_net_margin_bps, 15); // median of 0..29 = 14.5 → 15
  assert.equal(stats30[1].state, "INSUFFICIENT_DATA");
});
