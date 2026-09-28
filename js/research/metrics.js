// Measured metrics (pure, integer math). Each returns a state; an unmeasurable metric is
// INSUFFICIENT / UNKNOWN / UNVERIFIED, never a guessed number. Definitions: semantics.js.

import { mulDivRoundHalfUp } from "../money.js";

const DAY_MS = 86400000;
export const MIN_VELOCITY_SALES = 10;
export const VELOCITY_WINDOW_DAYS = 7;

// sales: a sales observation for the exit market (window_days = 7) or null.
export function observedSaleVelocity(sales, { exitMarket }) {
  if (!sales) return { state: "INSUFFICIENT", reason: `no 7-day sales observation for ${exitMarket}`, market: exitMarket };
  if (sales.source !== exitMarket) return { state: "INVALID", reason: "velocity must come from the exit market itself; markets are never pooled" };
  if (sales.window_days !== VELOCITY_WINDOW_DAYS) return { state: "INVALID", reason: "velocity window must be 7 days" };
  if (sales.sales_count < MIN_VELOCITY_SALES) {
    return { state: "INSUFFICIENT", reason: `${sales.sales_count} observed sales < ${MIN_VELOCITY_SALES} required`, market: exitMarket, sales_count: sales.sales_count };
  }
  return {
    state: "OBSERVED",
    market: exitMarket,
    sales_count: sales.sales_count,
    window_days: VELOCITY_WINDOW_DAYS,
    // Display value, hundredths of a sale per day (floor): never fed back into money math.
    per_day_x100: Math.floor((sales.sales_count * 100) / VELOCITY_WINDOW_DAYS),
    count_basis: sales.count_basis,
    observation_id: sales.sales_observation_id ?? null,
  };
}

// quantity ÷ velocity of the same market. Hundredths of a day, rounded UP (pessimistic).
export function estimatedExitDays(quantity, velocity) {
  if (!velocity || velocity.state !== "OBSERVED") return { state: "UNKNOWN", reason: "observed_sale_velocity is INSUFFICIENT" };
  const x100 = Math.ceil((quantity * VELOCITY_WINDOW_DAYS * 100) / velocity.sales_count);
  return { state: "ESTIMATED", days_x100: x100, market: velocity.market };
}

// CSFloat buy orders: endpoint UNVERIFIED (DATA_SOURCE_MATRIX #17) → never measured here.
export function buyerSideLiquidity() {
  return { state: "UNVERIFIED", reason: "CSFloat buy-orders endpoint not verified against a live response" };
}

export function instantSaleReference() {
  return { state: "UNAVAILABLE", reason: "no verified instant-sale quote source (DATA_SOURCE_MATRIX #21)" };
}

// snapshots: [{ observed_at, price_usd_cents }] for one item on one market (non-synthetic
// unless the whole computation is synthetic), any order. Pairs (t, t') with |t' − t − H| ≤
// tolerance, both inside the trailing window, t' ≤ now. Nearest-rank 25th percentile.
export function holdAdverseMove(snapshots, { holdDays, nowMs, windowDays = 30, toleranceS = 3600, minPairs = 30, percentile = 25 }) {
  const H = holdDays * DAY_MS;
  const tol = toleranceS * 1000;
  const start = nowMs - windowDays * DAY_MS;
  const pts = snapshots
    .map((s) => ({ t: Date.parse(s.observed_at), p: s.price_usd_cents }))
    .filter((s) => Number.isSafeInteger(s.p) && s.p > 0 && s.t >= start && s.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  const ratios = [];
  let j = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const target = pts[i].t + H;
    if (target - tol > nowMs) break;
    while (j < pts.length - 1 && Math.abs(pts[j + 1].t - target) <= Math.abs(pts[j].t - target)) j += 1;
    if (j <= i) continue;
    if (Math.abs(pts[j].t - target) <= tol) ratios.push(mulDivRoundHalfUp(pts[j].p - pts[i].p, 1000000, pts[i].p));
  }
  if (ratios.length < minPairs) {
    return { state: "INSUFFICIENT", reason: `${ratios.length} snapshot pairs ${holdDays}d apart < ${minPairs} required`, pairs: ratios.length };
  }
  ratios.sort((a, b) => a - b);
  const idx = Math.ceil((percentile / 100) * ratios.length) - 1;
  return { state: "ESTIMATED", ppm: ratios[idx], pairs: ratios.length, percentile, method: "nearest-rank", window_days: windowDays, hold_days: holdDays };
}

// Stop trigger: rolling drop ≥ drop_pct within window confirmed by rising listing_supply, or
// price at/below the per-item absolute floor. series: [{ observed_at, price_usd_cents, listing_supply }].
export function stopTrigger(series, { nowMs, dropPct, windowMin, floorCents = null }) {
  const start = nowMs - windowMin * 60000;
  const pts = series
    .map((s) => ({ t: Date.parse(s.observed_at), p: s.price_usd_cents, q: s.listing_supply }))
    .filter((s) => s.t >= start && s.t <= nowMs && Number.isSafeInteger(s.p))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return { state: "INSUFFICIENT", reason: "no snapshots in the window" };
  const last = pts[pts.length - 1];
  if (Number.isSafeInteger(floorCents) && last.p <= floorCents) return { state: "TRIGGERED", reason: `price ${last.p} ≤ floor ${floorCents}`, kind: "FLOOR" };
  if (pts.length < 2) return { state: "INSUFFICIENT", reason: "fewer than 2 snapshots in the window" };
  const peak = Math.max(...pts.map((x) => x.p));
  const dropBps = mulDivRoundHalfUp(peak - last.p, 10000, peak);
  const supplyRising = Number.isSafeInteger(pts[0].q) && Number.isSafeInteger(last.q) && last.q > pts[0].q;
  if (dropBps >= dropPct * 100 && supplyRising) return { state: "TRIGGERED", reason: `drop ${dropBps} bps ≥ ${dropPct * 100} bps with listing_supply ${pts[0].q} → ${last.q}`, kind: "DROP" };
  return { state: "OK", drop_bps: dropBps, supply_rising: supplyRising };
}
