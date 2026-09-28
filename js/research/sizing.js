// Position sizing for one opportunity. All limits apply; the smallest wins (DECISIONS C7):
//   1. per-item cap: 20% of capital at cost (cash + open cost basis; reserved cash is part of cash)
//   2. velocity cap: configured share of one day's observed_sale_velocity on the exit market
//   3. the existing v1 position-size formula (tiers.maxPositionSize), unchanged
//   4. cash actually available (cash − banked − reserved)
// Kelly is ADVISORY display only and disabled until ≥ 30 completed REAL trades under the
// current strategy_version; paper results are never used.

import { mulDivFloor } from "../money.js";
import { maxPositionSize, validateRiskConfig } from "../tiers.js";

export function capitalAtCost(capital) {
  return capital.usd_cash_balance_cents + capital.open_cost_basis_cents;
}

export function sizeOpportunity({ entryCostCents, capital, riskConfig, velocity, perItemCapPct = 20, velocitySharePct = 10 }) {
  if (!capital) return { state: "UNKNOWN", reason: "no capital snapshot synced from the ledger", units: 0 };
  const cac = capitalAtCost(capital);
  const perItemCap = mulDivFloor(cac, perItemCapPct, 100);
  const risk = validateRiskConfig(riskConfig);
  const v1 = maxPositionSize({
    deployableCents: capital.deployable_capital_cents,
    usdCashCents: capital.usd_cash_balance_cents,
    bankedCents: capital.banked_profit_cents,
    openExposureCents: capital.open_cost_basis_cents,
    riskBps: risk.bps,
  });
  const available = capital.usd_cash_balance_cents - capital.banked_profit_cents - capital.reserved_cash_cents;
  const units = {
    per_item_cap: Math.floor(Math.max(0, perItemCap) / entryCostCents),
    v1_position_formula: Math.floor(Math.max(0, v1.max_position_size_cents) / entryCostCents),
    available_cash: Math.floor(Math.max(0, available) / entryCostCents),
    velocity_cap: velocity?.state === "OBSERVED" ? mulDivFloor(velocity.sales_count, velocitySharePct, 100 * 7) : null,
  };
  const known = Object.values(units).filter((u) => u !== null);
  const result = Math.min(...known);
  const binding = Object.entries(units).filter(([, u]) => u === result).map(([k]) => k);
  return {
    state: units.velocity_cap === null ? "UNKNOWN_VELOCITY" : "OK",
    units: units.velocity_cap === null ? 0 : result,
    units_by_limit: units,
    binding_limits: binding,
    capital_at_cost_cents: cac,
    per_item_cap_cents: perItemCap,
    v1_max_position_cents: v1.max_position_size_cents,
    available_cash_cents: available,
    reason: units.velocity_cap === null ? "velocity cap unknown (observed_sale_velocity INSUFFICIENT); no size recommended" : undefined,
  };
}

// realTrades: closed REAL trades (net_margin_bps) under the current strategy_version.
export function kellyAdvisory(realTrades, { fraction = 0.25, capPct = 20, minTrades = 30 }) {
  if (realTrades.length < minTrades) return { state: "DISABLED", reason: `${realTrades.length} completed REAL trades < ${minTrades} under this strategy_version` };
  const wins = realTrades.filter((t) => t.net_margin_bps > 0);
  const losses = realTrades.filter((t) => t.net_margin_bps <= 0);
  if (!wins.length || !losses.length) return { state: "DISABLED", reason: "needs both winning and losing REAL trades" };
  const avg = (xs) => Math.floor(xs.reduce((s, t) => s + Math.abs(t.net_margin_bps), 0) / xs.length);
  const b = avg(wins); // average fractional gain, bps
  const a = Math.max(1, avg(losses)); // average fractional loss, bps
  const pBps = Math.floor((wins.length * 10000) / realTrades.length);
  const qBps = 10000 - pBps;
  // f* = p/a − q/b (fractions of bankroll), in bps.
  const fullBps = Math.floor((pBps * 10000) / a) - Math.floor((qBps * 10000) / b);
  const fracBps = Math.floor(fullBps * fraction);
  return { state: "ADVISORY", full_kelly_bps: fullBps, fractional_kelly_bps: Math.max(0, Math.min(fracBps, capPct * 100)), fraction, trades: realTrades.length, note: "ADVISORY display only; never sizes an order" };
}
