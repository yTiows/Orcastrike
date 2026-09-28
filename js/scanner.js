// Scanner: turns Worker quotes into cross-market opportunities, each resolved to exactly
// one eligibility status, with a full calculation trace. Read-only: it displays, never acts.
//
// Prime directive (P0-10): when data quality, depth evidence or calculation validity is
// insufficient, the correct output is no opportunity — never a filled-in number.

import { DEFAULTS } from "../config/defaults.js";
import { CASH_SELL_MARKETS } from "../config/fees.js";
import { computeTrade, pctToBps, resolvePayoutFeeBps, resolveSellFee, MoneyError } from "./money.js";
import { formatAge, formatBpsPct, formatCents, formatMicros } from "./format.js";
import { isPositionEligible, isPriceInBand, maxPositionSize, tierForCapital, validateRiskConfig } from "./tiers.js";

export const ELIGIBILITY = Object.freeze({
  HIGHLIGHTED: "HIGHLIGHTED",
  THIN_LIQUIDITY: "THIN_LIQUIDITY",
  STALE: "STALE",
  BLOCKED_BY_TIER: "BLOCKED_BY_TIER",
  BLOCKED_BY_POSITION_SIZE: "BLOCKED_BY_POSITION_SIZE",
  BLOCKED_BY_CIRCUIT_BREAKER: "BLOCKED_BY_CIRCUIT_BREAKER",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
});

export const LISTING_DEPTH_TOOLTIP =
  "listing_depth: listings available near this price, not verified buyer demand. " +
  "Supply-side proxy — count of active listings within ±10% of the quoted price, same market, same snapshot.";

// Buy anywhere; resale for cash on CSFloat/Skinport only. Steam sales pay Steam Wallet
// (not cash), so Steam is never a scanner sell leg (P0-5).
export const PAIRS = Object.freeze([
  ["steam", "csfloat"],
  ["steam", "skinport"],
  ["csfloat", "skinport"],
  ["skinport", "csfloat"],
]);

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CLOCK_SKEW_MS = 60000;

export function quoteKey(source, item) {
  return `${source}|${item}`;
}

// Data sanity + freshness for one quote. status: FRESH | STALE | MISSING | INVALID |
// UNAVAILABLE | RATE_LIMITED | NOT_CONFIGURED. Only FRESH may enter a calculation.
// parserStatus: { steam|csfloat|skinport: "VERIFIED" | ... } from static/parser-verification.json
// (Worker path) or the daemon's per-quote parser_status. Unverified parsers never feed a claim
// (DECISIONS D-38).
export function assessQuote(q, nowMs, cfg = DEFAULTS, parserStatus = {}) {
  if (!q) return { status: "MISSING", reason: "no quote fetched" };
  if (["UNAVAILABLE", "RATE_LIMITED", "NOT_CONFIGURED", "INVALID"].includes(q.state)) {
    return { status: q.state, reason: q.reason ?? q.state };
  }
  const pStatus = q.parser_status ?? parserStatus[q.source] ?? "UNVERIFIED";
  if (pStatus !== "VERIFIED") return { status: "UNVERIFIED", reason: `PARSER_UNVERIFIED for ${q.source} (${pStatus}): not yet verified against a live response. The local app checks daily (Overview → Verify now)` };
  if (q.synthetic) return { status: "INVALID", reason: "SYNTHETIC data is never evidence" };
  if (q.state !== "AVAILABLE" && q.state !== "STALE") return { status: "INVALID", reason: `unknown state ${String(q.state)}` };
  if (typeof q.canonical_item_id !== "string" || q.canonical_item_id.trim() === "") return { status: "INVALID", reason: "canonical_item_id empty" };
  if (!Number.isSafeInteger(q.price_usd_cents) || q.price_usd_cents <= 0) return { status: "INVALID", reason: "price must be integer USD cents > 0" };
  if (q.listing_depth !== null && (!Number.isSafeInteger(q.listing_depth) || q.listing_depth < 0)) {
    return { status: "INVALID", reason: "listing_depth must be an integer >= 0" };
  }
  if (typeof q.captured_at !== "string" || !ISO_UTC_RE.test(q.captured_at) || Number.isNaN(Date.parse(q.captured_at))) {
    return { status: "INVALID", reason: "captured_at is not ISO 8601 UTC" };
  }
  const ageMs = nowMs - Date.parse(q.captured_at);
  if (ageMs < -CLOCK_SKEW_MS) return { status: "INVALID", reason: "captured_at is in the future" };
  const age_seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (q.source === "skinport") {
    if (!Number.isSafeInteger(q.fx_rate_micros) || q.fx_rate_micros <= 0) {
      return { status: "INVALID", reason: "Skinport quote lacks the FX rate used at ingestion", age_seconds };
    }
    if (q.fx_state === "STALE") return { status: "STALE", reason: "EUR→USD rate is stale", age_seconds };
    if (q.fx_state !== "AVAILABLE") return { status: "INVALID", reason: `FX state ${String(q.fx_state)}`, age_seconds };
  }
  if (q.state === "STALE") return { status: "STALE", reason: q.reason ?? "source reported STALE", age_seconds };
  if (age_seconds > cfg.QUOTE_MAX_AGE_SECONDS) {
    return { status: "STALE", reason: `older than ${cfg.QUOTE_MAX_AGE_SECONDS}s`, age_seconds };
  }
  return { status: "FRESH", age_seconds };
}

// Everything the scanner needs from settings, ledger and breaker, validated once per scan.
export function buildScanContext({ cfg = DEFAULTS, balances, circuitBreaker, nowMs, payoutRail, parserStatus = {} }) {
  const risk = validateRiskConfig(cfg.risk);
  if (!risk.ok) throw new Error(`invalid risk config: ${risk.errors.join("; ")}`);
  const f = cfg.filters;
  if (!Number.isSafeInteger(f.MIN_NET_PROFIT_CENTS) || !Number.isSafeInteger(f.MIN_LISTING_DEPTH) || f.MIN_LISTING_DEPTH < 0) {
    throw new Error("invalid filter config");
  }
  const filters = {
    minProfitCents: f.MIN_NET_PROFIT_CENTS,
    minMarginBps: pctToBps(f.MIN_NET_MARGIN_PCT),
    minDepth: f.MIN_LISTING_DEPTH,
  };
  let capital = null;
  if (balances && balances.ok) {
    const tier = tierForCapital(balances.deployable_capital_cents, cfg.TIERS);
    const position = maxPositionSize({
      deployableCents: balances.deployable_capital_cents,
      usdCashCents: balances.usd_cash_balance_cents,
      bankedCents: balances.banked_profit_cents,
      openExposureCents: balances.current_open_exposure_cents,
      riskBps: risk.bps,
    });
    capital = {
      deployable_capital_cents: balances.deployable_capital_cents,
      deployable_capital_complete: balances.deployable_capital_complete,
      tier,
      position,
    };
  }
  return {
    cfg,
    nowMs,
    parserStatus,
    filters,
    capital,
    circuitBreaker: circuitBreaker ?? { active: false, state: "INACTIVE" },
    payoutRail: payoutRail ?? cfg.CSFLOAT_PAYOUT_RAIL,
  };
}

function transferEligibleIfBoughtAt(nowMs, cfg) {
  return new Date(nowMs + cfg.TRANSFER_HOLD_DAYS * 86400000).toISOString();
}

function row(base, status, reasons, extra = {}) {
  return { ...base, eligibility_status: status, reasons, ...extra };
}

// One buy-market → sell-market evaluation for one unit.
export function evaluatePair({ item, buyMarket, sellMarket, buyQuote, sellQuote, ctx }) {
  const { cfg, nowMs, filters } = ctx;
  const a = assessQuote(buyQuote, nowMs, cfg, ctx.parserStatus);
  const b = assessQuote(sellQuote, nowMs, cfg, ctx.parserStatus);
  const base = {
    item,
    buy_market: buyMarket,
    sell_market: sellMarket,
    buy_price_cents: a.status === "FRESH" || a.status === "STALE" ? buyQuote.price_usd_cents : null,
    sell_price_cents: b.status === "FRESH" || b.status === "STALE" ? sellQuote.price_usd_cents : null,
    listing_depth: b.status === "FRESH" || b.status === "STALE" ? sellQuote.listing_depth : null,
    buy_listing_depth: a.status === "FRESH" || a.status === "STALE" ? buyQuote.listing_depth : null,
    buy_age_seconds: a.age_seconds ?? null,
    sell_age_seconds: b.age_seconds ?? null,
    price_age_seconds: Math.max(a.age_seconds ?? 0, b.age_seconds ?? 0),
    buy_quote_status: a.status,
    sell_quote_status: b.status,
    transfer_eligible_if_bought_now: transferEligibleIfBoughtAt(nowMs, cfg),
    net_profit_cents: null,
    net_margin_bps: null,
    calc: null,
    trace: [],
  };
  const trace = base.trace;
  trace.push({ step: "buy quote", display: quoteLine(buyMarket, buyQuote, a) });
  trace.push({ step: "sell quote", display: quoteLine(sellMarket, sellQuote, b) });

  const unusable = [a, b].filter((x) => x.status !== "FRESH" && x.status !== "STALE");
  if (unusable.length) {
    const reasons = [
      ...(a.status !== "FRESH" && a.status !== "STALE" ? [`buy (${buyMarket}): ${a.status} — ${a.reason}`] : []),
      ...(b.status !== "FRESH" && b.status !== "STALE" ? [`sell (${sellMarket}): ${b.status} — ${b.reason}`] : []),
    ];
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: ${reasons.join("; ")} — no calculation performed` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, reasons);
  }
  if (a.status !== b.status) {
    const reason = `mixed freshness (buy ${a.status}, sell ${b.status}): prices are not from a comparable snapshot`;
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: ${reason} — no calculation performed` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, [reason]);
  }
  if (sellQuote.listing_depth === null) {
    const reason = `sell-side listing_depth unavailable on ${sellMarket} (the ±10% depth metric cannot be measured from its API)`;
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: ${reason}` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, [reason]);
  }
  if (a.status === "STALE") {
    const reason = `both quotes stale (buy: ${a.reason}; sell: ${b.reason})`;
    trace.push({ step: "decision", display: `STALE: ${reason} — no calculation performed` });
    return row(base, ELIGIBILITY.STALE, [reason]);
  }

  // ---- calculation (all math in money.js) ----
  let fee;
  let payoutBps;
  try {
    fee = resolveSellFee({ market: sellMarket, schedule: "auto", unitGrossCents: sellQuote.price_usd_cents, fxRateMicros: sellQuote.fx_rate_micros });
    payoutBps = resolvePayoutFeeBps(sellMarket, ctx.payoutRail);
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: fee resolution failed — ${err.message}` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, [`INVALID fee inputs: ${err.message}`]);
  }
  const calc = computeTrade({
    quantity: 1,
    unitBuyPriceCents: buyQuote.price_usd_cents,
    unitSellPriceCents: sellQuote.price_usd_cents,
    sellFeeBps: fee.bps,
    payoutFeeBps: payoutBps,
    sellFeeModel: fee.model,
  });
  if (calc.state !== "OK") {
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: calculation INVALID — ${calc.reason}` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, [`INVALID: ${calc.reason}`]);
  }

  base.calc = { ...calc, sell_fee_schedule: fee.schedule, payout_rail: sellMarket === "csfloat" ? ctx.payoutRail : "none" };
  base.net_profit_cents = calc.net_profit_cents;
  base.net_margin_bps = calc.net_margin_bps;
  base.required_acquisition_cost_cents = calc.acquisition_cost_cents;
  trace.push({ step: "buy price", display: `${formatCents(calc.unit_buy_price_cents)} on ${buyMarket} (acquisition cost, 1 unit)` });
  for (const [leg, q] of [["buy", buyQuote], ["sell", sellQuote]]) {
    if (q.source !== "skinport") continue;
    trace.push({
      step: "FX",
      display: `${leg} leg: Skinport EUR price converted to USD at ingestion at ${formatMicros(q.fx_rate_micros)} USD/EUR (ECB ${q.fx_rate_date})` +
        (leg === "sell" ? `; Skinport fee tier: ${fee.schedule}` : ""),
    });
  }
  trace.push({
    step: "seller fee",
    display: `${formatCents(calc.gross_sale_price_cents)} × (1 − ${formatBpsPct(calc.sell_fee_bps)}) = ${formatCents(calc.after_seller_fee_cents)} (fee ${formatCents(calc.sell_fee_cents)})`,
  });
  trace.push({
    step: "payout fee",
    display: `${formatCents(calc.after_seller_fee_cents)} × ${formatBpsPct(calc.payout_fee_bps)} = ${formatCents(calc.payout_fee_cents)}${sellMarket === "csfloat" ? ` (${ctx.payoutRail} rail)` : ""}`,
  });
  trace.push({ step: "net proceeds", display: `${formatCents(calc.after_seller_fee_cents)} − ${formatCents(calc.payout_fee_cents)} = ${formatCents(calc.net_sale_proceeds_cents)}` });
  trace.push({ step: "net profit", display: `${formatCents(calc.net_sale_proceeds_cents)} − ${formatCents(calc.acquisition_cost_cents)} = ${formatCents(calc.net_profit_cents)}` });
  trace.push({ step: "net margin", display: `${formatCents(calc.net_profit_cents)} / ${formatCents(calc.acquisition_cost_cents)} = ${formatBpsPct(calc.net_margin_bps)}` });
  trace.push({
    step: "listing_depth",
    display: `${sellQuote.listing_depth}${sellQuote.listing_depth_capped ? "+ (lower bound: first page)" : ""} sell-side listings within ±10% on ${sellMarket} (min ${filters.minDepth}); buy-side ${buyQuote.listing_depth ?? "unavailable"}`,
  });
  trace.push({ step: "freshness", display: `buy ${formatAge(a.age_seconds)} old, sell ${formatAge(b.age_seconds)} old (max ${cfg.QUOTE_MAX_AGE_SECONDS}s)` });

  if (calc.net_profit_cents < filters.minProfitCents || calc.net_margin_bps < filters.minMarginBps) {
    trace.push({
      step: "decision",
      display: `below minimum viable filter (profit ≥ ${formatCents(filters.minProfitCents)} and margin ≥ ${formatBpsPct(filters.minMarginBps)}) — not an opportunity`,
    });
    return { ...base, eligibility_status: null, below_threshold: true, reasons: ["below minimum viable opportunity filter"] };
  }

  if (sellQuote.listing_depth < filters.minDepth) {
    const reason = `sell-side listing_depth ${sellQuote.listing_depth} < MIN_LISTING_DEPTH ${filters.minDepth}`;
    trace.push({ step: "decision", display: `THIN_LIQUIDITY: ${reason}` });
    return row(base, ELIGIBILITY.THIN_LIQUIDITY, [reason]);
  }
  if (ctx.circuitBreaker.active) {
    const reason = `circuit breaker ${ctx.circuitBreaker.state}${ctx.circuitBreaker.expires_at ? ` until ${ctx.circuitBreaker.expires_at}` : ""}`;
    trace.push({ step: "decision", display: `BLOCKED_BY_CIRCUIT_BREAKER: ${reason}` });
    return row(base, ELIGIBILITY.BLOCKED_BY_CIRCUIT_BREAKER, [reason]);
  }
  if (!ctx.capital) {
    const reason = "deployable capital unknown (ledger invalid or not loaded) — cannot apply tier/position rules";
    trace.push({ step: "decision", display: `INSUFFICIENT_DATA: ${reason}` });
    return row(base, ELIGIBILITY.INSUFFICIENT_DATA, [reason]);
  }
  const { tier, position, deployable_capital_cents: deployable, deployable_capital_complete: complete } = ctx.capital;
  const capNote = complete ? "" : " (lower bound: some inventory lots unvalued)";
  if (!tier || !isPriceInBand(tier, calc.unit_buy_price_cents)) {
    const reason = tier
      ? `buy price ${formatCents(calc.unit_buy_price_cents)} outside Tier ${tier.tier} band [${formatCents(tier.band_min_cents)}, ${tier.band_max_cents === null ? "∞" : formatCents(tier.band_max_cents)})`
      : `deployable capital ${formatCents(deployable)}${capNote} is below Tier 1 (${formatCents(cfg.TIERS[0].capital_min_cents)})`;
    trace.push({ step: "tier", display: reason });
    trace.push({ step: "decision", display: `BLOCKED_BY_TIER: ${reason}` });
    return row(base, ELIGIBILITY.BLOCKED_BY_TIER, [reason]);
  }
  trace.push({ step: "tier", display: `Tier ${tier.tier} (deployable ${formatCents(deployable)}${capNote}); price within band` });
  trace.push({
    step: "position-size cap",
    display:
      `max_position = min(${formatCents(position.cap_by_position_pct_cents)} per-position, ` +
      `${formatCents(position.cap_by_exposure_cents)} exposure headroom, ${formatCents(position.cap_by_free_cash_cents)} free cash above reserve) ` +
      `= ${formatCents(position.max_position_size_cents)}; required ${formatCents(calc.acquisition_cost_cents)}`,
  });
  base.max_position_size_cents = position.max_position_size_cents;
  if (!isPositionEligible(calc.acquisition_cost_cents, position.max_position_size_cents)) {
    const reason = `required ${formatCents(calc.acquisition_cost_cents)} > max position ${formatCents(position.max_position_size_cents)}`;
    trace.push({ step: "decision", display: `BLOCKED_BY_POSITION_SIZE: ${reason}` });
    return row(base, ELIGIBILITY.BLOCKED_BY_POSITION_SIZE, [reason]);
  }
  trace.push({ step: "decision", display: "HIGHLIGHTED: passes data, filter, depth, breaker, tier and position checks" });
  return row(base, ELIGIBILITY.HIGHLIGHTED, []);
}

function quoteLine(market, q, assessment) {
  if (!q) return `${market}: no quote`;
  const price = Number.isSafeInteger(q.price_usd_cents) ? formatCents(q.price_usd_cents) : "—";
  return `${market}: ${assessment.status}${assessment.reason ? ` (${assessment.reason})` : ""}, price ${price}, captured ${q.captured_at ?? "?"}`;
}

const STATUS_ORDER = [
  ELIGIBILITY.HIGHLIGHTED,
  ELIGIBILITY.BLOCKED_BY_POSITION_SIZE,
  ELIGIBILITY.BLOCKED_BY_TIER,
  ELIGIBILITY.BLOCKED_BY_CIRCUIT_BREAKER,
  ELIGIBILITY.THIN_LIQUIDITY,
  ELIGIBILITY.STALE,
  ELIGIBILITY.INSUFFICIENT_DATA,
];

// quotes: Map(quoteKey(source, item) → canonical quote)
export function scan({ items, quotes, ctx }) {
  const rows = [];
  const belowThreshold = [];
  for (const item of items) {
    for (const [buyMarket, sellMarket] of PAIRS) {
      const r = evaluatePair({
        item,
        buyMarket,
        sellMarket,
        buyQuote: quotes.get(quoteKey(buyMarket, item)),
        sellQuote: quotes.get(quoteKey(sellMarket, item)),
        ctx,
      });
      if (r.below_threshold) belowThreshold.push(r);
      else rows.push(r);
    }
  }
  rows.sort(
    (x, y) =>
      STATUS_ORDER.indexOf(x.eligibility_status) - STATUS_ORDER.indexOf(y.eligibility_status) ||
      (y.net_profit_cents ?? -Infinity) - (x.net_profit_cents ?? -Infinity),
  );
  const counts = Object.fromEntries(Object.values(ELIGIBILITY).map((s) => [s, 0]));
  for (const r of rows) counts[r.eligibility_status] += 1;
  return { rows, below_threshold: belowThreshold, counts, evaluated: rows.length + belowThreshold.length };
}

// Inventory valuation rule: lowest current listing across cash sell markets, counted only
// where that market's listing_depth meets MIN_LISTING_DEPTH and the quote is fresh.
// Otherwise INSUFFICIENT_DATA — never zero, never acquisition cost.
export function valuationFromQuotes(quotes, item, nowMs, cfg = DEFAULTS, parserStatus = {}) {
  const candidates = [];
  const why = [];
  for (const market of CASH_SELL_MARKETS) {
    const q = quotes.get(quoteKey(market, item));
    const a = assessQuote(q, nowMs, cfg, parserStatus);
    if (a.status !== "FRESH") {
      why.push(`${market}: ${a.status}`);
      continue;
    }
    if (q.listing_depth === null) {
      why.push(`${market}: depth unavailable`);
      continue;
    }
    if (q.listing_depth < cfg.filters.MIN_LISTING_DEPTH) {
      why.push(`${market}: depth ${q.listing_depth} < ${cfg.filters.MIN_LISTING_DEPTH}`);
      continue;
    }
    candidates.push({ market, price: q.price_usd_cents, depth: q.listing_depth });
  }
  if (!candidates.length) return { state: "INSUFFICIENT_DATA", reason: why.join("; ") };
  const best = candidates.reduce((m, c) => (c.price < m.price ? c : m));
  return { state: "OK", unit_value_cents: best.price, market: best.market, listing_depth: best.depth };
}
