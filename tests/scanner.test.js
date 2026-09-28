import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../config/defaults.js";
import {
  ELIGIBILITY,
  LISTING_DEPTH_TOOLTIP,
  assessQuote,
  buildScanContext,
  evaluatePair,
  quoteKey,
  scan,
  valuationFromQuotes,
} from "../js/scanner.js";
import { CROSS_MARKET_VERDICT, HISTORICAL_LABEL, crossMarketBacktest, simulateSingleMarket } from "../js/backtest.js";
import { DELTA_METHODOLOGY, eventPriceDelta, validateEvent, validateEventsFile } from "../js/events.js";
import { normalizeWatchlist, validateSettings } from "../js/state.js";
import { circuitBreakerStatus } from "../js/tiers.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const ITEM = "AK-47 | Redline (Field-Tested)";

function q(source, price, { depth = 10, ageSec = 10, item = ITEM, ...extra } = {}) {
  const base = {
    source,
    canonical_item_id: item,
    price_usd_cents: price,
    listing_depth: source === "skinport" ? null : depth,
    captured_at: new Date(NOW - ageSec * 1000).toISOString(),
    expires_at: new Date(NOW - ageSec * 1000 + 90000).toISOString(),
    state: "AVAILABLE",
  };
  if (source === "skinport") Object.assign(base, { fx_rate_micros: 1100000, fx_rate_date: "2026-09-25", fx_state: "AVAILABLE" });
  return { ...base, ...extra };
}

function balances(deployable, { cash = deployable, banked = 0, exposure = 0, complete = true } = {}) {
  return {
    ok: true,
    deployable_capital_cents: deployable,
    usd_cash_balance_cents: cash,
    banked_profit_cents: banked,
    current_open_exposure_cents: exposure,
    deployable_capital_complete: complete,
  };
}

// SYNTHETIC quotes below are hand-written; parsers are marked VERIFIED only for these unit tests.
const VERIFIED = { steam: "VERIFIED", csfloat: "VERIFIED", skinport: "VERIFIED" };

function ctx({ bal = balances(20000), breaker, cfg = DEFAULTS, parserStatus = VERIFIED } = {}) {
  return buildScanContext({ cfg, balances: bal, circuitBreaker: breaker, nowMs: NOW, payoutRail: "bank", parserStatus });
}

const pair = (buyQuote, sellQuote, c = ctx(), buyMarket = "steam", sellMarket = "csfloat") =>
  evaluatePair({ item: ITEM, buyMarket, sellMarket, buyQuote, sellQuote, ctx: c });

test("ACCEPTANCE: data freshness gating — one fresh, one stale → INSUFFICIENT_DATA, no partial calc", () => {
  const r = pair(q("steam", 1000), q("csfloat", 1500, { ageSec: DEFAULTS.QUOTE_MAX_AGE_SECONDS + 1 }));
  assert.equal(r.eligibility_status, "INSUFFICIENT_DATA");
  assert.equal(r.calc, null);
  assert.equal(r.net_profit_cents, null);
  assert.equal(r.net_margin_bps, null);
  assert.match(r.reasons[0], /mixed freshness/);
  const reverse = pair(q("steam", 1000, { ageSec: 9999 }), q("csfloat", 1500));
  assert.equal(reverse.eligibility_status, "INSUFFICIENT_DATA");
});

test("both quotes stale → STALE, still no calculation", () => {
  const r = pair(q("steam", 1000, { ageSec: 9999 }), q("csfloat", 1500, { state: "STALE" }));
  assert.equal(r.eligibility_status, "STALE");
  assert.equal(r.calc, null);
});

test("ACCEPTANCE: position eligibility — D=5000, cash=5000, banked=0, exposure=0", () => {
  const c = ctx({ bal: balances(5000) });
  assert.equal(c.capital.position.max_position_size_cents, 750);
  assert.equal(c.capital.tier.tier, 1);

  // The spec's literal case (item $20.00): 2000 > 750, so position-size fails; the $20 price is
  // also outside Tier 1's $1–$15 band, and tier is evaluated first → BLOCKED_BY_TIER.
  const literalCtx = pair(q("steam", 2000), q("csfloat", 3000), c);
  assert.equal(literalCtx.eligibility_status, "BLOCKED_BY_TIER");
  assert.ok(literalCtx.required_acquisition_cost_cents > c.capital.position.max_position_size_cents);

  // Isolate the position rule with an in-band price.
  const blocked = pair(q("steam", 1000), q("csfloat", 1500), c);
  assert.equal(blocked.eligibility_status, "BLOCKED_BY_POSITION_SIZE");
  assert.equal(blocked.max_position_size_cents, 750);
  const ok = pair(q("steam", 700), q("csfloat", 1100), c);
  assert.equal(ok.eligibility_status, "HIGHLIGHTED");
  assert.equal(ok.max_position_size_cents, 750);
});

test("tier and breaker precedence; zero/negative max position never highlights", () => {
  const inBandT2 = pair(q("steam", 2000), q("csfloat", 3000)); // D=20000 → Tier 2
  assert.equal(inBandT2.eligibility_status, "HIGHLIGHTED");
  const lowCapital = pair(q("steam", 500), q("csfloat", 900), ctx({ bal: balances(2000) }));
  assert.equal(lowCapital.eligibility_status, "BLOCKED_BY_TIER");
  const noFree = pair(q("steam", 2000), q("csfloat", 3000), ctx({ bal: balances(20000, { cash: 7000, exposure: 13000 }) }));
  assert.equal(noFree.eligibility_status, "BLOCKED_BY_POSITION_SIZE");
  assert.ok(noFree.max_position_size_cents <= 0);

  const breaker = circuitBreakerStatus(new Date(NOW - 3600000).toISOString(), NOW);
  const cb = pair(q("steam", 2000), q("csfloat", 3000), ctx({ breaker }));
  assert.equal(cb.eligibility_status, "BLOCKED_BY_CIRCUIT_BREAKER");
  const expired = circuitBreakerStatus(new Date(NOW - 25 * 3600000).toISOString(), NOW);
  assert.equal(pair(q("steam", 2000), q("csfloat", 3000), ctx({ breaker: expired })).eligibility_status, "HIGHLIGHTED");
});

test("THIN_LIQUIDITY when sell-side depth < MIN_LISTING_DEPTH", () => {
  const thin = pair(q("steam", 2000), q("csfloat", 3000, { depth: 4 }));
  assert.equal(thin.eligibility_status, "THIN_LIQUIDITY");
  assert.equal(pair(q("steam", 2000), q("csfloat", 3000, { depth: 5 })).eligibility_status, "HIGHLIGHTED");
  assert.match(LISTING_DEPTH_TOOLTIP, /not verified buyer demand/);
});

test("Skinport: sell leg → INSUFFICIENT_DATA (depth unmeasurable); buy leg computes with FX", () => {
  const sp = pair(q("steam", 2000), q("skinport", 3000), ctx(), "steam", "skinport");
  assert.equal(sp.eligibility_status, "INSUFFICIENT_DATA");
  assert.match(sp.reasons[0], /listing_depth unavailable/);
  const buySp = pair(q("skinport", 2000), q("csfloat", 3000), ctx(), "skinport", "csfloat");
  assert.equal(buySp.eligibility_status, "HIGHLIGHTED");
  assert.ok(buySp.trace.some((t) => t.step === "FX" && /1\.100000 USD\/EUR/.test(t.display)));
  const noFx = pair(q("skinport", 2000, { fx_rate_micros: null }), q("csfloat", 3000), ctx(), "skinport", "csfloat");
  assert.equal(noFx.eligibility_status, "INSUFFICIENT_DATA");
  const staleFx = pair(q("skinport", 2000, { fx_state: "STALE" }), q("csfloat", 3000), ctx(), "skinport", "csfloat");
  assert.equal(staleFx.eligibility_status, "INSUFFICIENT_DATA"); // mixed freshness
});

test("non-AVAILABLE worker states and sanity failures → INSUFFICIENT_DATA, never NaN", () => {
  const bad = [
    { state: "NOT_CONFIGURED", price_usd_cents: null },
    { state: "RATE_LIMITED", price_usd_cents: null },
    { state: "UNAVAILABLE", price_usd_cents: null },
    { state: "INVALID", price_usd_cents: null },
    { price_usd_cents: 0 },
    { price_usd_cents: -100 },
    { price_usd_cents: 12.5 },
    { price_usd_cents: Number.NaN },
    { listing_depth: -1 },
    { captured_at: "yesterday" },
    { captured_at: new Date(NOW + 3600000).toISOString() },
    { canonical_item_id: "" },
    { state: "WHATEVER" },
  ];
  for (const patch of bad) {
    const r = pair(q("steam", 1000), q("csfloat", 1500, patch));
    assert.equal(r.eligibility_status, "INSUFFICIENT_DATA", JSON.stringify(patch));
    assert.equal(r.calc, null);
    assert.ok(!JSON.stringify(r).includes("NaN"));
  }
  assert.equal(pair(q("steam", 1000), undefined).eligibility_status, "INSUFFICIENT_DATA");
  assert.equal(assessQuote(q("csfloat", 1500), NOW, DEFAULTS, VERIFIED).status, "FRESH");
});

test("D-38: quotes from UNVERIFIED parsers or SYNTHETIC sources never enter a calculation", () => {
  const unverified = pair(q("steam", 2000), q("csfloat", 3000), ctx({ parserStatus: { steam: "VERIFIED", csfloat: "UNVERIFIED" } }));
  assert.equal(unverified.eligibility_status, "INSUFFICIENT_DATA");
  assert.equal(unverified.calc, null);
  assert.match(unverified.reasons.join(" "), /PARSER_UNVERIFIED for csfloat/);
  assert.equal(pair(q("steam", 2000), q("csfloat", 3000), ctx({ parserStatus: {} })).eligibility_status, "INSUFFICIENT_DATA");
  assert.equal(pair(q("steam", 2000), q("csfloat", 3000, { parser_status: "VERIFIED", synthetic: true })).eligibility_status, "INSUFFICIENT_DATA");
  assert.equal(pair(q("steam", 2000), q("csfloat", 3000, { parser_status: "UNVERIFIED" })).eligibility_status, "INSUFFICIENT_DATA", "daemon per-quote status wins");
});

test("below the minimum viable filter → not an opportunity (excluded from rows)", () => {
  const items = [ITEM];
  const quotes = new Map([
    [quoteKey("steam", ITEM), q("steam", 2000)],
    [quoteKey("csfloat", ITEM), q("csfloat", 2100)], // net 2027 → profit 27 < 50
  ]);
  const res = scan({ items, quotes, ctx: ctx() });
  assert.equal(res.rows.filter((r) => r.buy_market === "steam" && r.sell_market === "csfloat").length, 0);
  assert.equal(res.below_threshold.length, 1);
  assert.equal(res.below_threshold[0].eligibility_status, null);
  // margin filter: profit 116 on 5000 = 2.32% < 3% (profit alone would pass)
  const r = pair(q("steam", 5000), q("csfloat", 5300));
  assert.equal(r.calc.net_profit_cents, 116);
  assert.equal(r.below_threshold, true);
});

test("every evaluated opportunity resolves to exactly one eligibility status", () => {
  const items = ["A", "B", "C"];
  const quotes = new Map([
    [quoteKey("steam", "A"), q("steam", 2000, { item: "A" })],
    [quoteKey("csfloat", "A"), q("csfloat", 3000, { item: "A" })],
    [quoteKey("skinport", "A"), q("skinport", 2500, { item: "A" })],
    [quoteKey("steam", "B"), q("steam", 2000, { item: "B", ageSec: 9999 })],
    [quoteKey("csfloat", "B"), q("csfloat", 3000, { item: "B" })],
  ]);
  const res = scan({ items, quotes, ctx: ctx() });
  const values = Object.values(ELIGIBILITY);
  for (const row of res.rows) assert.ok(values.includes(row.eligibility_status));
  assert.equal(Object.values(res.counts).reduce((s, n) => s + n, 0), res.rows.length);
  assert.equal(res.evaluated, items.length * 4);
  assert.equal(res.rows[0].eligibility_status, "HIGHLIGHTED");
});

test("calculation trace exposes every step in order", () => {
  const r = pair(q("steam", 2000), q("csfloat", 3000));
  const steps = r.trace.map((t) => t.step);
  const required = ["buy price", "seller fee", "payout fee", "net proceeds", "net profit", "net margin", "listing_depth", "freshness", "position-size cap", "decision"];
  let last = -1;
  for (const s of required) {
    const i = steps.indexOf(s);
    assert.ok(i > last, `trace step "${s}" missing or out of order`);
    last = i;
  }
  assert.equal(r.calc.after_seller_fee_cents, 2940);
  assert.equal(r.calc.payout_fee_cents, 44); // 44.1
  assert.equal(r.calc.net_profit_cents, 896);
  assert.match(r.trace.find((t) => t.step === "seller fee").display, /\$30\.00 × \(1 − 2\.00%\) = \$29\.40/);
});

test("inventory valuation: lowest depth-qualified listing; single anomalous listing ignored", () => {
  const quotes = new Map([
    [quoteKey("csfloat", ITEM), q("csfloat", 900, { depth: 1 })], // anomalous cheap single listing
    [quoteKey("skinport", ITEM), q("skinport", 950)], // depth unmeasurable
  ]);
  const v = valuationFromQuotes(quotes, ITEM, NOW, DEFAULTS, VERIFIED);
  assert.equal(v.state, "INSUFFICIENT_DATA");
  quotes.set(quoteKey("csfloat", ITEM), q("csfloat", 1000, { depth: 6 }));
  const ok = valuationFromQuotes(quotes, ITEM, NOW, DEFAULTS, VERIFIED);
  assert.deepEqual(ok, { state: "OK", unit_value_cents: 1000, market: "csfloat", listing_depth: 6 });
  assert.equal(valuationFromQuotes(quotes, ITEM, NOW).state, "INSUFFICIENT_DATA", "unverified parsers never value inventory");
  quotes.set(quoteKey("csfloat", ITEM), q("csfloat", 1000, { depth: 6, ageSec: 9999 }));
  assert.equal(valuationFromQuotes(quotes, ITEM, NOW, DEFAULTS, VERIFIED).state, "INSUFFICIENT_DATA"); // stale never values
});

test("watchlist capped at MAX_TRACKED_ITEMS (100), deduplicated", () => {
  const many = Array.from({ length: 105 }, (_, i) => `Item ${i}`);
  const n = normalizeWatchlist([...many, "Item 0", "  "]);
  assert.equal(n.items.length, 100);
  assert.equal(n.dropped, 5);
  assert.ok(n.errors.length >= 1);
  const starter = JSON.parse(readFileSync(new URL("../static/watchlist-starter.json", import.meta.url), "utf8"));
  assert.ok(starter.items.length >= 15 && starter.items.length <= 20);
  assert.equal(normalizeWatchlist(starter.items).items.length, starter.items.length);
});

test("settings overrides are validated, defaults stay immutable", () => {
  assert.equal(validateSettings({}).ok, true);
  assert.equal(validateSettings({ risk: { MAX_AGGREGATE_OPEN_EXPOSURE: 0.8 } }).ok, false); // 0.8 + 0.4 > 1
  assert.equal(validateSettings({ filters: { MIN_NET_MARGIN_PCT: 2.5 } }).ok, true);
  assert.equal(validateSettings({ filters: { MIN_LISTING_DEPTH: 0 } }).ok, false);
  assert.equal(validateSettings({ WORKER_BASE_URL: "http://evil.example" }).ok, false);
  assert.equal(validateSettings({ WORKER_BASE_URL: "https://x.workers.dev/" }).effective.WORKER_BASE_URL, "https://x.workers.dev");
  assert.throws(() => {
    DEFAULTS.risk.MAX_PCT_CAPITAL_PER_POSITION = 1;
  });
});

// ---- backtest ------------------------------------------------------------------------

function series(days, fn) {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(NOW - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
    price_usd_cents: fn(i),
    volume: 100,
  }));
}

test("backtest labels: historical context, never a forecast or cross-market evidence", () => {
  assert.match(HISTORICAL_LABEL, /historical context/i);
  assert.match(HISTORICAL_LABEL, /not a forecast/i);
  assert.match(HISTORICAL_LABEL, /not evidence of cross-market/i);
  assert.doesNotMatch(HISTORICAL_LABEL, /expected/i);
  assert.equal(CROSS_MARKET_VERDICT, "INSUFFICIENT DATA TO VALIDATE CROSS-MARKET STRATEGY.");
  const b = crossMarketBacktest();
  assert.equal(b.state, "INSUFFICIENT_DATA");
  assert.equal(b.verdict, CROSS_MARKET_VERDICT);
});

test("single-market simulation: flat prices → net ≈ −15% after Steam fee; too few samples → INSUFFICIENT_DATA", () => {
  const flat = simulateSingleMarket(series(120, () => 1000), { nowMs: NOW });
  assert.equal(flat.state, "OK");
  assert.equal(flat.samples, 120 - 7);
  assert.equal(flat.median_gross_change_bps, 0);
  assert.equal(flat.median_net_margin_bps, -1500);
  assert.equal(flat.positive_net_share_bps, 0);
  assert.equal(flat.kind, "single_market_historical_simulation");

  const short = simulateSingleMarket(series(30, () => 1000), { nowMs: NOW });
  assert.equal(short.state, "INSUFFICIENT_DATA");
  assert.equal(short.samples, 23);
  assert.equal(simulateSingleMarket(null, { nowMs: NOW }).state, "INSUFFICIENT_DATA");
  assert.equal(simulateSingleMarket([{ date: "x", price_usd_cents: 1 }], { nowMs: NOW }).state, "INSUFFICIENT_DATA");
});

// ---- events --------------------------------------------------------------------------

test("static/events.json: every entry has source_url, retrieval_date, methodology and valid schema", () => {
  const events = JSON.parse(readFileSync(new URL("../static/events.json", import.meta.url), "utf8"));
  const v = validateEventsFile(events);
  assert.deepEqual(v.rejected, []);
  assert.ok(v.events.length > 0);
  assert.equal(validateEvent({ type: "major", name: "x" }).ok, false);
  assert.equal(validateEvent({ ...events[0], confidence: "certain" }).ok, false);
  assert.equal(validateEvent({ ...events[0], predicted_impact: "+20%" }).ok, false);
});

test("event price delta: 7d before vs 7d after; missing history → INSUFFICIENT_DATA", () => {
  const start = "2026-09-10";
  const pts = [];
  for (let i = -7; i < 7; i += 1) {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    pts.push({ date: d, price_usd_cents: i < 0 ? 1000 : 1100, volume: 5 });
  }
  const r = eventPriceDelta(pts, start);
  assert.equal(r.state, "OK");
  assert.equal(r.before_mean_cents, 1000);
  assert.equal(r.after_mean_cents, 1100);
  assert.equal(r.change_bps, 1000);
  assert.equal(r.methodology, DELTA_METHODOLOGY);
  assert.equal(eventPriceDelta([], start).state, "INSUFFICIENT_DATA");
  assert.equal(eventPriceDelta(pts.slice(0, 10), start).state, "INSUFFICIENT_DATA"); // only 3 days after
});
