// Tiers, position sizing, stop-loss flag, circuit breaker, tier-compression gate.
// Pure functions; all percentages are converted to integer bps before use.

import { DEFAULTS } from "../config/defaults.js";
import { BPS, medianInt, mulDivFloor, rateToBps } from "./money.js";

const HOUR_MS = 3600000;

// ---- Tiers ------------------------------------------------------------------------

function inRange(value, min, max) {
  return value >= min && (max === null || value < max);
}

// Lower bound inclusive, upper exclusive, top tier unbounded. Below tier 1 → null.
export function tierForCapital(deployableCents, tiers = DEFAULTS.TIERS) {
  if (!Number.isSafeInteger(deployableCents)) return null;
  return tiers.find((t) => inRange(deployableCents, t.capital_min_cents, t.capital_max_cents)) ?? null;
}

export function isPriceInBand(tierRow, priceCents) {
  if (!tierRow || !Number.isSafeInteger(priceCents)) return false;
  return inRange(priceCents, tierRow.band_min_cents, tierRow.band_max_cents);
}

// Which tier's item price band a unit price falls in (used to bucket ledger flips).
export function tierForItemPrice(priceCents, tiers = DEFAULTS.TIERS) {
  return tiers.find((t) => isPriceInBand(t, priceCents)) ?? null;
}

// ---- Risk config ------------------------------------------------------------------

// 0 < position <= 1; 0 < exposure <= 1; 0 <= reserve < 1; exposure + reserve <= 1.
export function validateRiskConfig(risk) {
  const errors = [];
  const bps = {};
  const fields = [
    ["positionBps", "MAX_PCT_CAPITAL_PER_POSITION", (v) => v > 0 && v <= BPS, "0 < value <= 1"],
    ["exposureBps", "MAX_AGGREGATE_OPEN_EXPOSURE", (v) => v > 0 && v <= BPS, "0 < value <= 1"],
    ["reserveBps", "MIN_FREE_CASH_RESERVE", (v) => v >= 0 && v < BPS, "0 <= value < 1"],
  ];
  for (const [key, name, ok, rule] of fields) {
    try {
      const v = rateToBps(risk?.[name], { allowOne: true });
      if (!ok(v)) errors.push(`${name} must satisfy ${rule}`);
      else bps[key] = v;
    } catch {
      errors.push(`${name} must be a number with at most 4 decimal places (${rule})`);
    }
  }
  if (errors.length === 0 && bps.exposureBps + bps.reserveBps > BPS) {
    errors.push("MAX_AGGREGATE_OPEN_EXPOSURE + MIN_FREE_CASH_RESERVE must be <= 1");
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], bps };
}

// ---- Position sizing --------------------------------------------------------------

// max_position_size = min(
//   floor(D × position_pct),
//   floor(D × exposure_pct) − open_exposure,
//   cash − banked − floor(D × reserve_pct))
export function maxPositionSize({ deployableCents, usdCashCents, bankedCents, openExposureCents, riskBps }) {
  for (const [k, v] of Object.entries({ deployableCents, usdCashCents, bankedCents, openExposureCents })) {
    if (!Number.isSafeInteger(v)) throw new Error(`${k} must be integer cents`);
  }
  const byPosition = mulDivFloor(deployableCents, riskBps.positionBps, BPS);
  const byExposure = mulDivFloor(deployableCents, riskBps.exposureBps, BPS) - openExposureCents;
  const byFreeCash = usdCashCents - bankedCents - mulDivFloor(deployableCents, riskBps.reserveBps, BPS);
  return {
    max_position_size_cents: Math.min(byPosition, byExposure, byFreeCash),
    cap_by_position_pct_cents: byPosition,
    cap_by_exposure_cents: byExposure,
    cap_by_free_cash_cents: byFreeCash,
  };
}

export function isPositionEligible(requiredCostCents, maxPositionCents) {
  return maxPositionCents > 0 && requiredCostCents <= maxPositionCents;
}

// ---- Stop-loss flag (informational only; never triggers any action) ---------------

export function stopLossFlag({ acquisitionCostCents, currentValueCents, thresholdBps }) {
  if (!Number.isSafeInteger(currentValueCents)) {
    return { state: "INSUFFICIENT_DATA", reason: "no depth-qualified current listing price" };
  }
  if (!Number.isSafeInteger(acquisitionCostCents) || acquisitionCostCents <= 0) {
    return { state: "INVALID", reason: "acquisition cost must be > 0" };
  }
  const loss = acquisitionCostCents - currentValueCents;
  // loss / cost >= threshold  ⇔  loss × BPS >= cost × thresholdBps (exact, BigInt)
  const flagged = loss > 0 && BigInt(loss) * BigInt(BPS) >= BigInt(acquisitionCostCents) * BigInt(thresholdBps);
  return {
    state: flagged ? "FLAGGED" : "OK",
    unrealized_pnl_cents: -loss,
  };
}

// ---- Circuit breaker --------------------------------------------------------------

// Gross (not net) realized loss over closed trades with sell_timestamp in
// (close − window, close]. Trips when gross_loss >= loss_pct × deployable_at_close.
export function evaluateCircuitBreaker({ trades, closeTimestampIso, deployableAtCloseCents, lossBps, windowHours }) {
  const close = Date.parse(closeTimestampIso);
  if (Number.isNaN(close)) throw new Error("closeTimestampIso must be ISO 8601");
  const start = close - windowHours * HOUR_MS;
  let gross = 0;
  for (const t of trades) {
    const ts = Date.parse(t.sell_timestamp);
    if (ts > start && ts <= close && t.realized_net_profit_cents < 0) gross += -t.realized_net_profit_cents;
  }
  const tripped = gross > 0 && BigInt(gross) * BigInt(BPS) >= BigInt(deployableAtCloseCents) * BigInt(lossBps);
  return {
    tripped,
    gross_realized_loss_cents: gross,
    threshold_cents: mulDivFloor(Math.max(deployableAtCloseCents, 0), lossBps, BPS),
    window_start: new Date(start).toISOString(),
    window_end: new Date(close).toISOString(),
  };
}

// Status derived from the stored ISO timestamp on every load — never a stored boolean.
// A corrupt stored value is treated as ACTIVE (capital-protective) until the user clears it.
export function circuitBreakerStatus(triggeredAtIso, nowMs, cooldownHours = DEFAULTS.CIRCUIT_BREAKER_COOLDOWN_HOURS) {
  if (triggeredAtIso === null || triggeredAtIso === undefined || triggeredAtIso === "") {
    return { state: "INACTIVE", active: false, triggered_at: null, expires_at: null };
  }
  const t = typeof triggeredAtIso === "string" ? Date.parse(triggeredAtIso) : Number.NaN;
  if (Number.isNaN(t)) {
    return { state: "INVALID", active: true, triggered_at: String(triggeredAtIso), expires_at: null };
  }
  const expires = t + cooldownHours * HOUR_MS;
  const active = nowMs < expires;
  return {
    state: active ? "ACTIVE" : "EXPIRED",
    active,
    triggered_at: new Date(t).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
}

// ---- Tier compression gate --------------------------------------------------------

// Per item-price-band tier: fewer than minFlips recorded flips → INSUFFICIENT_DATA.
export function tierCompressionStats(trades, minFlips = DEFAULTS.TIER_COMPRESSION_MIN_FLIPS, tiers = DEFAULTS.TIERS) {
  return tiers.map((tier) => {
    const inTier = trades.filter((t) => {
      const unit = t.quantity > 0 ? Math.floor(t.acquisition_cost_cents / t.quantity) : null;
      return tierForItemPrice(unit, tiers)?.tier === tier.tier;
    });
    if (inTier.length < minFlips) {
      return { tier: tier.tier, state: "INSUFFICIENT_DATA", flips: inTier.length, required: minFlips };
    }
    return {
      tier: tier.tier,
      state: "OK",
      flips: inTier.length,
      median_net_margin_bps: medianInt(inTier.map((t) => t.net_margin_bps)),
    };
  });
}
