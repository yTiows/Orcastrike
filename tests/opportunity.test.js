// Opportunity engine, defined math, metrics, sizing, premiums. All observation rows here are
// SYNTHETIC test inputs; they exercise the math and never serve as evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../config/defaults.js";
import { RESEARCH_DEFAULTS, validateResearchSettings } from "../config/settings-schema.js";
import { BASE_FEE_MODEL, deriveFeeModel, steamFeeComparison } from "../js/research/fee-model.js";
import { estimatedExitDays, holdAdverseMove, observedSaleVelocity, stopTrigger } from "../js/research/metrics.js";
import { computeOpportunity, rankOpportunities, strategyVersion } from "../js/research/opportunity.js";
import { identityFor, premiumContributionCents, premiumFor } from "../js/research/premium.js";
import { kellyAdvisory, sizeOpportunity } from "../js/research/sizing.js";
import { buildSnapshotGroup } from "../js/research/snapshot.js";
import { METRICS } from "../js/research/semantics.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const H = 3600000;
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const VERIFIED = { "steam_histogram@1": "VERIFIED", "csfloat_listings@1": "VERIFIED", "skinport_items@1": "VERIFIED" };
const PV = { steam: "steam_histogram@1", csfloat: "csfloat_listings@1", skinport: "skinport_items@1" };

const quote = (id, source, price, secAgo = 10, over = {}) => ({ observation_id: id, source, observed_at: at(secAgo), parser_version: PV[source], quality_state: "COMPLETE", price_usd_cents: price, synthetic: 1, ...over });
const sales7 = (count, secAgo = 60, source = "csfloat") => ({ sales_observation_id: 99, source, window_days: 7, sales_count: count, observed_at: at(secAgo), quality_state: "COMPLETE", count_basis: "SOURCE_AGGREGATE" });
// Hourly snapshots over 30 days with price fn(hoursAgo).
const series = (fn) => Array.from({ length: 30 * 24 }, (_, i) => ({ observed_at: new Date(NOW - i * H).toISOString(), price_usd_cents: fn(i) }));

const CAPITAL = { usd_cash_balance_cents: 9000, banked_profit_cents: 0, reserved_cash_cents: 0, open_cost_basis_cents: 0, deployable_capital_cents: 9000 };

function run({ buy = "steam", sell = "csfloat", entry = 1000, exit = 1300, exitAge = 10, reference = null, sales = sales7(70), snaps = series(() => 1300), capital = CAPITAL, cfg = RESEARCH_DEFAULTS, umbra = false, breaker = { active: false }, item = "AK-47 | Redline (Field-Tested)", parserStatus = VERIFIED } = {}) {
  const obs = {
    entry_quote: quote(1, buy, entry),
    exit_quote: quote(2, sell, exit, exitAge, sell === "skinport" ? { fx_rate_micros: 1100000 } : {}),
    exit_depth: sell === "csfloat" ? quote(3, sell, exit, exitAge, { listing_supply: 7 }) : null,
    exit_reference: reference ? quote(4, sell, null, 10, { reference_price_usd_cents: reference, reference_sample_size: 40 }) : null,
  };
  const requirements = [
    { role: "entry_quote", source: buy, kind: "quote", required: true },
    { role: "exit_quote", source: sell, kind: "quote", required: true },
    { role: "exit_depth", source: sell, kind: "depth", required: false },
    { role: "exit_reference", source: sell, kind: "reference", required: false },
  ];
  const group = buildSnapshotGroup({ requirements, observations: obs, nowMs: NOW, snapshotCfg: cfg.snapshot, parserStatus });
  const ctx = {
    nowMs: NOW,
    cfg,
    feeModel: BASE_FEE_MODEL,
    capital,
    v1: { risk: DEFAULTS.risk, filters: DEFAULTS.filters, tiers: DEFAULTS.TIERS },
    breaker,
    mode: { umbra, unproven: false, bankroll_cents: 100000 },
    rail: "bank",
    strategyVersion: "strat-test",
  };
  return computeOpportunity({ item, buyMarket: buy, sellMarket: sell, group, obs, exitSales: sales, exitSnapshots: snaps, ctx });
}

test("defined math end to end → ELIGIBLE with every intermediate recorded", () => {
  const o = run();
  assert.equal(o.status, "ELIGIBLE", o.blocked_reasons.join("; "));
  assert.deepEqual(
    { e: o.math.entry_cost_cents, x: o.math.executable_exit_price_cents, ham: o.math.hold_adverse_move_ppm, adj: o.math.exit_adjusted_cents, sf: o.math.sell_fee_cents, pf: o.math.payout_fee_cents, pp: o.math.pessimistic_proceeds_cents, rr: o.math.reversal_reserve_cents, enp: o.math.expected_net_profit_cents, rank: o.math.rank_metric_ppm_per_day },
    { e: 1000, x: 1300, ham: 0, adj: 1300, sf: 26, pf: 19, pp: 1255, rr: 10, enp: 245, rank: 35000 },
  );
  assert.equal(o.sizing.units, 1);
  assert.deepEqual(o.versions.parser_versions.sort(), ["csfloat_listings@1", "steam_histogram@1"]);
  assert.ok(o.trace.find((s) => s.step === "reversal_reserve").display.includes("USER_ASSUMPTION"));
  assert.ok(o.trace.find((s) => s.step === "expected_net_profit").display.includes("ESTIMATED, pessimistic, not a forecast"));
});

test("hold_adverse_move is applied: a falling exit market lowers proceeds", () => {
  // Price 1% lower every 7 days → every 7-day pair ≈ −1%.
  const o = run({ snaps: series((h) => Math.round(1300 * (1 + (0.01 * h) / 168))) });
  assert.ok(o.math.hold_adverse_move_ppm < 0);
  assert.ok(o.math.exit_adjusted_cents < 1300);
});

test("ACCEPTANCE 1: stale CSFloat quote → ineligible, STALE, no calculation uses it", () => {
  const o = run({ exitAge: 181 });
  assert.equal(o.status, "STALE");
  assert.equal(o.math, null);
  assert.equal(o.rank_eligible, false);
  assert.match(o.trace.at(-1).display, /^STALE/);
  assert.deepEqual(rankOpportunities([o]), []);
});

test("ACCEPTANCE 4: reference $200, entry ask $150, exit ask $155 → profit from the exit ask", () => {
  const o = run({ entry: 15000, exit: 15500, reference: 20000, snaps: series(() => 15500) });
  assert.equal(o.math.executable_exit_price_cents, 15500);
  assert.equal(o.math.pessimistic_proceeds_cents, 14962); // 15500 × 0.98 = 15190; payout round(227.85) = 228
  assert.equal(o.math.expected_net_profit_cents, 14962 - 15000 - 150);
  assert.equal(o.status, "NON_POSITIVE");
  assert.deepEqual(o.metrics.reference_price, { state: "SIGNAL", value_cents: 20000, sample_size: 40, observed_at: at(10), source: "csfloat" });
  assert.ok(!JSON.stringify(o.math).includes("20000"), "reference price must not enter the math");
});

test("ACCEPTANCE 5: velocity from 9 observed sales → INSUFFICIENT and estimated_exit_days UNKNOWN", () => {
  const v = observedSaleVelocity(sales7(9), { exitMarket: "csfloat" });
  assert.equal(v.state, "INSUFFICIENT");
  assert.equal(estimatedExitDays(1, v).state, "UNKNOWN");
  const o = run({ sales: sales7(9) });
  assert.equal(o.metrics.observed_sale_velocity.state, "INSUFFICIENT");
  assert.equal(o.metrics.estimated_exit_days.state, "UNKNOWN");
  assert.equal(o.status, "LIQUIDITY_THIN");
  assert.equal(o.rank_eligible, false);
});

test("velocities are never pooled across markets", () => {
  assert.equal(observedSaleVelocity(sales7(50, 60, "skinport"), { exitMarket: "csfloat" }).state, "INVALID");
  assert.equal(run({ sales: null }).status, "LIQUIDITY_UNKNOWN");
  assert.equal(run({ sales: sales7(70, 3600) }).status, "LIQUIDITY_UNKNOWN"); // older than max_age_sales_s
});

test("ACCEPTANCE 9: UNKNOWN pattern premium never appears in any profit figure", () => {
  const o = run();
  assert.equal(o.metrics.premium.state, "UNKNOWN");
  assert.equal(o.math.premium_contribution_cents, 0);
  assert.equal(o.math.expected_net_profit_cents, o.math.pessimistic_proceeds_cents - o.math.entry_cost_cents - o.math.reversal_reserve_cents);
  assert.equal(premiumContributionCents(premiumFor("AK-47 | Case Hardened (Field-Tested)", { paint_seed: 661 })), 0);
});

test("phase-dependent names are identity-AMBIGUOUS without a KNOWN phase", () => {
  assert.equal(run({ item: "★ Karambit | Doppler (Factory New)" }).status, "IDENTITY_AMBIGUOUS");
  assert.equal(identityFor("★ Karambit | Doppler (Factory New)", { paint_index: 415 }).key, "★ Karambit | Doppler (Factory New) | Ruby");
  assert.equal(identityFor("★ Karambit | Gamma Doppler (Factory New)", { paint_index: 569 }).state, "AMBIGUOUS");
  assert.equal(identityFor("AK-47 | Redline (Field-Tested)").state, "KNOWN");
});

test("hold_adverse_move needs ≥ 30 pairs; nearest-rank 25th percentile", () => {
  const short = holdAdverseMove(series(() => 1000).slice(0, 7 * 24 + 20), { holdDays: 7, nowMs: NOW });
  assert.equal(short.state, "INSUFFICIENT");
  assert.equal(run({ snaps: series(() => 1300).slice(0, 7 * 24 + 20) }).status, "HOLD_ADVERSE_INSUFFICIENT");
  const pts = [];
  for (let i = 0; i < 40; i += 1) {
    pts.push({ observed_at: new Date(NOW - (8 * 24 + i) * H).toISOString(), price_usd_cents: 1000 });
    pts.push({ observed_at: new Date(NOW - (1 * 24 + i) * H).toISOString(), price_usd_cents: 1000 + (i - 10) * 10 }); // ratios −10%…+29%
  }
  const r = holdAdverseMove(pts, { holdDays: 7, nowMs: NOW });
  assert.equal(r.state, "ESTIMATED");
  assert.equal(r.pairs, 40);
  assert.equal(r.ppm, -10000); // 40 ratios −100000…+290000 ppm; nearest-rank p25 = ceil(10)th value = −10000
});

test("capital rails: unknown capital, circuit breaker, tier, position size", () => {
  assert.equal(run({ capital: null }).status, "CAPITAL_UNKNOWN");
  assert.equal(run({ capital: null }).rank_eligible, true, "data-eligible opportunities still rank; staging needs capital");
  assert.equal(run({ breaker: { active: true, state: "ACTIVE" } }).status, "BLOCKED_BY_CIRCUIT_BREAKER");
  assert.equal(run({ capital: { ...CAPITAL, usd_cash_balance_cents: 20000, deployable_capital_cents: 20000 } }).status, "BLOCKED_BY_TIER"); // $10 outside Tier 2 band
  assert.equal(run({ capital: { ...CAPITAL, usd_cash_balance_cents: 5000, deployable_capital_cents: 5000 } }).status, "BLOCKED_BY_POSITION_SIZE"); // v1 formula 750 < 1000
  const slow = run({ sales: sales7(20) }); // 20/7 per day × 10% → 0 units
  assert.equal(slow.status, "BLOCKED_BY_POSITION_SIZE");
  assert.equal(slow.sizing.units_by_limit.velocity_cap, 0);
});

test("minimum filters apply in standard mode only; UMBRA uses its $10 floor", () => {
  // exit 1070: 1070 × 0.98 → 1049, payout 16 → 1033; reserve 10 → expected 23 cents < 50
  const std = run({ exit: 1070, snaps: series(() => 1070) });
  assert.equal(std.math.expected_net_profit_cents, 23);
  assert.equal(std.status, "BELOW_MINIMUM");
  assert.equal(run({ exit: 1070, snaps: series(() => 1070), umbra: true }).status, "ELIGIBLE"); // no minimum margin in UMBRA
  assert.equal(run({ entry: 900, exit: 1070, snaps: series(() => 1070), umbra: true }).status, "BELOW_UMBRA_FLOOR");
});

test("sizing: smallest limit wins and is reported", () => {
  const s = sizeOpportunity({ entryCostCents: 1000, capital: { usd_cash_balance_cents: 100000, banked_profit_cents: 0, reserved_cash_cents: 0, open_cost_basis_cents: 0, deployable_capital_cents: 100000 }, riskConfig: DEFAULTS.risk, velocity: { state: "OBSERVED", sales_count: 700 } });
  assert.deepEqual(s.units_by_limit, { per_item_cap: 20, v1_position_formula: 15, available_cash: 100, velocity_cap: 10 });
  assert.equal(s.units, 10);
  assert.deepEqual(s.binding_limits, ["velocity_cap"]);
});

test("Kelly is advisory, real-only, disabled below 30 trades, capped at 20%", () => {
  const t = (bps) => ({ net_margin_bps: bps });
  assert.equal(kellyAdvisory(Array.from({ length: 29 }, () => t(500)), {}).state, "DISABLED");
  const k = kellyAdvisory([...Array.from({ length: 20 }, () => t(1000)), ...Array.from({ length: 10 }, () => t(-1000))], {});
  assert.equal(k.state, "ADVISORY");
  assert.ok(k.fractional_kelly_bps <= 2000);
  assert.match(k.note, /never sizes an order/);
});

test("stop trigger: drop confirmed by rising supply, or absolute floor", () => {
  const s = (minAgo, p, q) => ({ observed_at: new Date(NOW - minAgo * 60000).toISOString(), price_usd_cents: p, listing_supply: q });
  assert.equal(stopTrigger([s(14, 1000, 5), s(1, 910, 9)], { nowMs: NOW, dropPct: 8, windowMin: 15 }).state, "TRIGGERED");
  assert.equal(stopTrigger([s(14, 1000, 9), s(1, 910, 5)], { nowMs: NOW, dropPct: 8, windowMin: 15 }).state, "OK"); // supply falling: not confirmed
  assert.equal(stopTrigger([s(1, 400, 5)], { nowMs: NOW, dropPct: 8, windowMin: 15, floorCents: 500 }).kind, "FLOOR");
  assert.equal(stopTrigger([s(1, 900, 5)], { nowMs: NOW, dropPct: 8, windowMin: 15 }).state, "INSUFFICIENT");
});

test("strategy_version changes with any strategy parameter", () => {
  const opts = { v1Filters: DEFAULTS.filters, v1Risk: DEFAULTS.risk, umbra: false };
  const a = strategyVersion(RESEARCH_DEFAULTS, opts);
  const b = strategyVersion(validateResearchSettings({ "math.reversal_reserve_pct": 2 }).effective, opts);
  assert.notEqual(a, b);
  assert.notEqual(a, strategyVersion(RESEARCH_DEFAULTS, { ...opts, umbra: true }));
  assert.equal(a, strategyVersion(RESEARCH_DEFAULTS, opts));
});

test("fee model versions: base unchanged; derived version records overrides; C4 comparison", () => {
  const d = deriveFeeModel(BASE_FEE_MODEL, { overrides: { CSFLOAT_SELL_FEE: 0.025 }, created_at: "2026-10-01T00:00:00.000Z", source: "accepted proposal #1" });
  assert.equal(BASE_FEE_MODEL.fees.CSFLOAT_SELL_FEE, 0.02);
  assert.equal(d.fees.CSFLOAT_SELL_FEE, 0.025);
  assert.equal(d.parent_version, BASE_FEE_MODEL.fee_model_version);
  const c = steamFeeComparison(BASE_FEE_MODEL, 2000);
  assert.deepEqual([c.conservative_net_cents, c.valve_exact_net_cents, c.default_model], [1700, 1739, "flat_on_gross"]);
});

test("every metric states what it DOES and DOES NOT mean", () => {
  for (const [k, m] of Object.entries(METRICS)) {
    assert.ok(m.does && m.does_not && m.category, k);
  }
});
