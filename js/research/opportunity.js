// Opportunity engine (pure). Defined math only (spec "DEFINED MATH"); no other quantitative
// variable enters an economic claim. Each output records its inputs, the snapshot group it came
// from, every version, and a step-by-step trace. When any required input is missing, stale,
// conflicting or unverified, the result carries no profit figure at all.
//
//   entry_cost          = observed ask + buy-side fees (fee model)
//   exit_adj            = executable_exit_price × (1 + hold_adverse_move)
//   pessimistic_proceeds = exit_adj − sell-side fees at exit_adj (fee model)
//   reversal_reserve    = reversal_reserve_pct × entry_cost          (USER_ASSUMPTION)
//   expected_net_profit = pessimistic_proceeds − entry_cost − reversal_reserve   (ESTIMATED)
//   rank_metric         = expected_net_profit ÷ (entry_cost × hold_days)

import { mulDivRoundHalfUp, pctToBps } from "../money.js";
import { isPriceInBand, tierForCapital } from "../tiers.js";
import { entryCostCents, sellSideNet } from "./fee-model.js";
import { buyerSideLiquidity, estimatedExitDays, holdAdverseMove, instantSaleReference, observedSaleVelocity } from "./metrics.js";
import { identityFor, premiumContributionCents, premiumFor } from "./premium.js";
import { sizeOpportunity } from "./sizing.js";

export const OPPORTUNITY_CONTRACT = "opportunity@1";
export const SIGNAL_VERSION = "signal-v1";
export const EXIT_MARKETS = Object.freeze(["csfloat", "skinport"]);
export const PAIRS = Object.freeze([
  ["steam", "csfloat"],
  ["steam", "skinport"],
  ["csfloat", "skinport"],
  ["skinport", "csfloat"],
]);

// Deterministic, dependency-free hash (FNV-1a 32-bit) for version identifiers.
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

// Everything that changes what counts as an opportunity or how it is sized.
export function strategyParams(cfg, { v1Filters, v1Risk, umbra }) {
  return stable({
    signal_version: SIGNAL_VERSION,
    math: cfg.math,
    snapshot: cfg.snapshot,
    sizing: cfg.sizing,
    umbra: umbra ? { price_floor_cents: cfg.umbra.price_floor_cents, allow_thin: cfg.umbra.allow_thin } : null,
    filters: umbra ? null : v1Filters,
    risk: v1Risk,
  });
}

export function strategyVersion(cfg, opts) {
  return `strat-${fnv1a(JSON.stringify(strategyParams(cfg, opts)))}${opts.umbra ? "-umbra" : ""}`;
}

export const STATUS = Object.freeze([
  "ELIGIBLE", // rankable and stageable
  "INVALID",
  "INSUFFICIENT",
  "STALE",
  "CONFLICTING",
  "IDENTITY_AMBIGUOUS",
  "HOLD_ADVERSE_INSUFFICIENT",
  "NON_POSITIVE",
  "LIQUIDITY_THIN",
  "LIQUIDITY_UNKNOWN",
  "BELOW_MINIMUM",
  "BELOW_UMBRA_FLOOR",
  "CAPITAL_UNKNOWN",
  "BLOCKED_BY_CIRCUIT_BREAKER",
  "BLOCKED_BY_TIER",
  "BLOCKED_BY_POSITION_SIZE",
]);

function freshSales(sales, nowMs, maxAgeS) {
  if (!sales) return null;
  const age = (nowMs - Date.parse(sales.observed_at)) / 1000;
  return age <= maxAgeS && sales.quality_state !== "INVALID" ? sales : null;
}

// ctx: { nowMs, cfg (research), feeModel, capital|null, v1: { risk, filters, tiers },
//        breaker: { active, state, expires_at }, mode: { umbra, unproven }, rail }
export function computeOpportunity({ item, buyMarket, sellMarket, group, obs, exitSales, exitSnapshots, ctx }) {
  const { cfg, nowMs, feeModel } = ctx;
  const umbra = Boolean(ctx.mode?.umbra);
  const trace = [];
  const t = (step, category, display) => trace.push({ step, category, display });
  const out = {
    contract: OPPORTUNITY_CONTRACT,
    computed_at: new Date(nowMs).toISOString(),
    item,
    buy_source: buyMarket,
    sell_source: sellMarket,
    status: null,
    rank_eligible: false,
    blocked_reasons: [],
    quality: { state: group.state, reasons: group.reasons, notes: group.notes, sufficiency: group.sufficiency, skew_s: group.skew_s },
    contributing: group.contributing,
    // A daemon running against a SYNTHETIC upstream flags everything it emits.
    synthetic: group.synthetic || Boolean(ctx.synthetic),
    umbra,
    unproven: Boolean(umbra && ctx.mode?.unproven),
    hold_days: cfg.math.hold_days,
    math: null,
    metrics: {},
    sizing: null,
    trace,
    versions: {
      strategy_version: ctx.strategyVersion,
      signal_version: SIGNAL_VERSION,
      fee_model_version: feeModel.fee_model_version,
      parser_versions: [...new Set(group.contributing.map((c) => c.parser_version))],
    },
  };
  const finish = (status, reason) => {
    out.status = status;
    if (reason) out.blocked_reasons.push(reason);
    t("decision", null, `${status}${reason ? `: ${reason}` : ""}`);
    return out;
  };

  const identity = identityFor(item);
  out.identity = identity;
  t("identity", "OBSERVED", identity.state === "KNOWN" ? `${identity.key} (${identity.basis})` : `AMBIGUOUS: ${identity.reason}`);
  if (identity.state !== "KNOWN") return finish("IDENTITY_AMBIGUOUS", identity.reason);

  t("snapshot group", null, group.state === "COMPLETE" ? group.sufficiency : `${group.state}: ${group.reasons.join("; ")}`);
  if (group.state !== "COMPLETE") return finish(group.state, group.reasons[0]);

  // Signals and labels (never feed money).
  out.metrics.reference_price = obs.exit_reference
    ? { state: "SIGNAL", value_cents: obs.exit_reference.reference_price_usd_cents, sample_size: obs.exit_reference.reference_sample_size, observed_at: obs.exit_reference.observed_at, source: sellMarket }
    : { state: "UNAVAILABLE" };
  out.metrics.listing_supply = obs.exit_depth ? { state: "OBSERVED", value: obs.exit_depth.listing_supply, capped: Boolean(obs.exit_depth.listing_supply_capped), market: sellMarket } : { state: "UNAVAILABLE", market: sellMarket };
  out.metrics.buyer_side_liquidity = buyerSideLiquidity();
  out.metrics.instant_sale_reference = instantSaleReference();
  out.metrics.premium = premiumFor(item);

  const velocity = observedSaleVelocity(freshSales(exitSales, nowMs, cfg.snapshot.max_age_sales_s), { exitMarket: sellMarket });
  out.metrics.observed_sale_velocity = velocity;
  out.metrics.estimated_exit_days = estimatedExitDays(1, velocity);
  t("observed_sale_velocity", "OBSERVED", velocity.state === "OBSERVED" ? `${velocity.sales_count} sales / 7d on ${sellMarket} (${velocity.count_basis})` : `${velocity.state}: ${velocity.reason}`);

  const ham = holdAdverseMove(exitSnapshots, {
    holdDays: cfg.math.hold_days,
    nowMs,
    windowDays: cfg.math.hold_adverse_window_days,
    toleranceS: cfg.math.hold_pair_tolerance_s,
    minPairs: cfg.math.hold_adverse_min_pairs,
    percentile: cfg.math.hold_adverse_percentile,
  });
  out.metrics.hold_adverse_move = ham;
  t("hold_adverse_move", "ESTIMATED", ham.state === "ESTIMATED" ? `${ham.ppm} ppm (p${ham.percentile} of ${ham.pairs} pairs, ${ham.hold_days}d apart, trailing ${ham.window_days}d on ${sellMarket})` : `INSUFFICIENT: ${ham.reason}`);
  if (ham.state !== "ESTIMATED") return finish("HOLD_ADVERSE_INSUFFICIENT", ham.reason);

  // ---- defined math ----
  const entryAsk = obs.entry_quote.price_usd_cents;
  const exitAsk = obs.exit_quote.price_usd_cents;
  const entry = entryCostCents(feeModel, buyMarket, entryAsk);
  const exitAdj = mulDivRoundHalfUp(exitAsk, 1000000 + ham.ppm, 1000000);
  const sell = sellSideNet(feeModel, sellMarket, exitAdj, { fxRateMicros: obs.exit_quote.fx_rate_micros, rail: ctx.rail });
  if (sell.state !== "OK") return finish("INVALID", `sell-side fees: ${sell.reason}`);
  const reserveBps = pctToBps(cfg.math.reversal_reserve_pct);
  const reserve = mulDivRoundHalfUp(entry.entry_cost_cents, reserveBps, 10000);
  const premiumCents = premiumContributionCents(out.metrics.premium); // UNKNOWN → 0, by rule
  const expected = sell.net_cents - entry.entry_cost_cents - reserve + premiumCents;
  const H = cfg.math.hold_days;
  out.math = {
    entry_ask_cents: entryAsk,
    buy_side_fee_bps: entry.buy_side_fee_bps,
    entry_cost_cents: entry.entry_cost_cents,
    executable_exit_price_cents: exitAsk,
    hold_adverse_move_ppm: ham.ppm,
    exit_adjusted_cents: exitAdj,
    sell_fee_schedule: sell.schedule,
    sell_fee_bps: sell.sell_fee_bps,
    sell_fee_cents: sell.sell_fee_cents,
    payout_fee_bps: sell.payout_fee_bps,
    payout_fee_cents: sell.payout_fee_cents,
    pessimistic_proceeds_cents: sell.net_cents,
    reversal_reserve_bps: reserveBps,
    reversal_reserve_cents: reserve,
    premium_contribution_cents: premiumCents,
    expected_net_profit_cents: expected,
    expected_net_margin_bps: mulDivRoundHalfUp(expected, 10000, entry.entry_cost_cents),
    rank_metric_ppm_per_day: mulDivRoundHalfUp(expected, 1000000, entry.entry_cost_cents * H),
  };
  const m = out.math;
  t("entry_cost", "OBSERVED", `ask ${entryAsk} + buy-side ${m.buy_side_fee_bps} bps = ${m.entry_cost_cents} cents on ${buyMarket}`);
  t("executable_exit_price", "OBSERVED", `lowest ask ${exitAsk} cents on ${sellMarket} (not the reference price)`);
  t("exit × (1 + hold_adverse_move)", "ESTIMATED", `${exitAsk} × (1 + ${ham.ppm}/1e6) = ${exitAdj}`);
  t("sell-side fees", "OBSERVED", `seller ${m.sell_fee_bps} bps (${sell.schedule}) = ${m.sell_fee_cents}; payout ${m.payout_fee_bps} bps = ${m.payout_fee_cents} (fee model ${feeModel.fee_model_version})`);
  t("pessimistic_proceeds", "ESTIMATED", `${exitAdj} − ${m.sell_fee_cents} − ${m.payout_fee_cents} = ${m.pessimistic_proceeds_cents}`);
  t("reversal_reserve", "USER_ASSUMPTION", `${cfg.math.reversal_reserve_pct}% of ${m.entry_cost_cents} = ${reserve} (USER_ASSUMPTION, not measured)`);
  t("premium", out.metrics.premium.state, `${out.metrics.premium.state}: contributes ${premiumCents}`);
  t("expected_net_profit", "ESTIMATED", `${m.pessimistic_proceeds_cents} − ${m.entry_cost_cents} − ${reserve} = ${expected} cents (ESTIMATED, pessimistic, not a forecast)`);
  t("rank_metric", "ESTIMATED", `${expected} / (${m.entry_cost_cents} × ${H}d) = ${m.rank_metric_ppm_per_day} ppm/day`);

  if (expected <= 0) return finish("NON_POSITIVE", `expected_net_profit ${expected} ≤ 0`);
  const allowThin = umbra && cfg.umbra.allow_thin;
  if (velocity.state !== "OBSERVED") {
    out.liquidity_label = Number.isSafeInteger(velocity.sales_count) ? "THIN" : "UNKNOWN";
    if (!allowThin) return finish(out.liquidity_label === "THIN" ? "LIQUIDITY_THIN" : "LIQUIDITY_UNKNOWN", velocity.reason);
    t("liquidity", "OBSERVED", `${out.liquidity_label} (allowed by UMBRA setting; stays labeled)`);
  }
  if (umbra) {
    if (entryAsk < cfg.umbra.price_floor_cents) return finish("BELOW_UMBRA_FLOOR", `entry ask ${entryAsk} < UMBRA floor ${cfg.umbra.price_floor_cents}`);
  } else {
    const minProfit = ctx.v1.filters.MIN_NET_PROFIT_CENTS;
    const minMarginBps = pctToBps(ctx.v1.filters.MIN_NET_MARGIN_PCT);
    if (expected < minProfit || m.expected_net_margin_bps < minMarginBps) return finish("BELOW_MINIMUM", `needs ≥ ${minProfit} cents and ≥ ${minMarginBps} bps`);
  }
  out.rank_eligible = true;

  // ---- capital-dependent rails ----
  if (!ctx.capital) return finish("CAPITAL_UNKNOWN", "no ledger capital snapshot synced; cash check and sizing impossible");
  if (ctx.breaker?.active) return finish("BLOCKED_BY_CIRCUIT_BREAKER", `circuit breaker ${ctx.breaker.state}${ctx.breaker.expires_at ? ` until ${ctx.breaker.expires_at}` : ""}`);
  if (!umbra) {
    const tier = tierForCapital(ctx.capital.deployable_capital_cents, ctx.v1.tiers);
    if (!tier || !isPriceInBand(tier, entryAsk)) return finish("BLOCKED_BY_TIER", tier ? `entry ${entryAsk} outside Tier ${tier.tier} band` : "deployable capital below Tier 1");
  }
  const capital = umbra
    ? { ...ctx.capital, usd_cash_balance_cents: Math.min(ctx.capital.usd_cash_balance_cents, ctx.mode.bankroll_cents ?? 0), deployable_capital_cents: Math.min(ctx.capital.deployable_capital_cents, ctx.mode.bankroll_cents ?? 0) }
    : ctx.capital;
  out.sizing = sizeOpportunity({ entryCostCents: m.entry_cost_cents, capital, riskConfig: ctx.v1.risk, velocity, perItemCapPct: cfg.sizing.per_item_cap_pct, velocitySharePct: cfg.sizing.velocity_share_pct });
  t("sizing", null, out.sizing.units > 0 ? `${out.sizing.units} unit(s); binding: ${out.sizing.binding_limits.join(", ")}` : `0 units: ${out.sizing.reason ?? `binding ${out.sizing.binding_limits.join(", ")}`}`);
  if (out.sizing.units < 1) return finish("BLOCKED_BY_POSITION_SIZE", out.sizing.reason ?? `limits allow 0 units (binding: ${out.sizing.binding_limits.join(", ")})`);
  return finish("ELIGIBLE", null);
}

// Only rank-eligible opportunities are ranked, by rank_metric (ties: expected_net_profit_cents).
export function rankOpportunities(list) {
  return list
    .filter((o) => o.rank_eligible && o.math)
    .sort((a, b) => b.math.rank_metric_ppm_per_day - a.math.rank_metric_ppm_per_day || b.math.expected_net_profit_cents - a.math.expected_net_profit_cents);
}
