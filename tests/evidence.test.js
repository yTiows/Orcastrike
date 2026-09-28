// Evidence gates, paper trading lifecycle, profit figures, fee calibration.
// Every trade/observation below is SYNTHETIC test input and flagged as such where stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEES } from "../config/fees.js";
import { RESEARCH_DEFAULTS, validateResearchSettings } from "../config/settings-schema.js";
import { insertMarketObservation, insertSourceRequest, openDb, registerParser, upsertItem } from "../daemon/db.js";
import { Engine } from "../daemon/engine.js";
import { closePaperTrades, openPaperTrades } from "../daemon/paper.js";
import { validateOverrides } from "../daemon/api-evidence.js";
import { breakdown, evidenceLadder, executionEvidence, signalEvidence, strategyValidation } from "../js/research/evidence.js";
import { calibrate, modelNet } from "../js/research/fee-calibration.js";
import { BASE_FEE_MODEL, deriveFeeModel } from "../js/research/fee-model.js";
import { profitFigures } from "../js/research/profit-figures.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const SV = "strat-test";

const paper = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ paper_trade_id: i + 1, status: "CLOSED", synthetic: 0, strategy_version: SV, ...over }));
const real = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ trade_id: `t${i}`, strategy_version: SV, realized_net_profit_cents: 10, ...over }));
const coverage = (days, pct = 9000) => Array.from({ length: days }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, sources: { steam: pct, csfloat: pct, skinport: pct, fx: pct } }));
const SIG = { strategyVersion: SV, firstObservationAt: iso(NOW - 20 * 86400000), nowMs: NOW, coverage: coverage(14), contributingSources: ["steam", "csfloat", "skinport", "fx"], openHighEvents: [] };

test("ACCEPTANCE 3: 29 real trades and 500 paper trades → EXECUTION_EVIDENCE fails", () => {
  const e = executionEvidence({ strategyVersion: SV, realTrades: real(29) });
  assert.equal(e.pass, false);
  assert.equal(e.checks[0].actual, 29);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(500) }).pass, true); // paper helps SIGNAL only
  assert.throws(() => executionEvidence({ strategyVersion: SV, realTrades: [...real(29), ...paper(500)] }), /paper trades never count/);
  assert.equal(executionEvidence({ strategyVersion: SV, realTrades: real(30) }).pass, true);
  assert.equal(executionEvidence({ strategyVersion: SV, realTrades: real(30, { strategy_version: "other" }) }).pass, false);
});

test("SIGNAL_EVIDENCE requires paper count, days, coverage and no open HIGH event", () => {
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(30) }).pass, true);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(29) }).pass, false);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(40, { synthetic: 1 }) }).pass, false, "synthetic paper trades never count");
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(40, { status: "VOID" }) }).pass, false);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(30), firstObservationAt: iso(NOW - 13 * 86400000) }).pass, false);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(30), coverage: coverage(14, 7999) }).pass, false);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(30), coverage: coverage(13) }).pass, false);
  assert.equal(signalEvidence({ ...SIG, paperTrades: paper(30), openHighEvents: [{ code: "PARSER_FAILURE" }] }).pass, false);
});

test("STRATEGY_VALIDATION needs both gates under the same strategy_version", () => {
  const s = signalEvidence({ ...SIG, paperTrades: paper(30) });
  const e = executionEvidence({ strategyVersion: SV, realTrades: real(30) });
  assert.equal(strategyValidation({ signal: s, execution: e, paperRows: [], realRows: [] }).pass, true);
  const e2 = executionEvidence({ strategyVersion: "other", realTrades: real(30, { strategy_version: "other" }) });
  assert.equal(strategyValidation({ signal: s, execution: e2, paperRows: [], realRows: [] }).pass, false);
});

test("ACCEPTANCE 10: paper and real trades are reported in separate rows with separate statistics", () => {
  const paperRows = [{ market: "csfloat", hold_hours: 170, net_profit_cents: 100 }];
  const realRows = [{ market: "csfloat", hold_hours: 170, net_profit_cents: -40 }, { market: "skinport", hold_hours: 400, net_profit_cents: 5 }];
  const v = strategyValidation({ signal: signalEvidence({ ...SIG, paperTrades: [] }), execution: executionEvidence({ strategyVersion: SV, realTrades: [] }), paperRows, realRows });
  assert.deepEqual(v.paper.by_marketplace, { csfloat: { n: 1, total_net_profit_cents: 100, wins: 1 } });
  assert.deepEqual(v.real.by_marketplace, { csfloat: { n: 1, total_net_profit_cents: -40, wins: 0 }, skinport: { n: 1, total_net_profit_cents: 5, wins: 1 } });
  assert.deepEqual(Object.keys(v.real.by_holding_period).sort(), ["14–29d", "7–13d"]);
  assert.deepEqual(breakdown([]), { by_marketplace: {}, by_holding_period: {} });
});

test("evidence ladder: no level inherits from a lower one", () => {
  const s = signalEvidence({ ...SIG, paperTrades: paper(30) });
  const e = executionEvidence({ strategyVersion: SV, realTrades: real(0) });
  const v = strategyValidation({ signal: s, execution: e, paperRows: [], realRows: [] });
  const ladder = evidenceLadder({ verifiedObservations: 0, observedDiscrepancies: 0, syncedBacktest: null, signal: s, execution: e, validation: v, automationEnabled: false });
  const st = Object.fromEntries(ladder.map((l) => [l.level, l.status]));
  assert.deepEqual(st, { 0: "NOT_REACHED", 1: "NOT_REACHED", 2: "NOT_REACHED", 3: "REACHED", 4: "NOT_REACHED", 5: "NOT_REACHED", 6: "NOT_REACHED" });
});

test("ACCEPTANCE 8: fee receipts differing from constants → proposal; constants unchanged until accepted", () => {
  const before = JSON.stringify(FEES);
  const receipts = [1000, 2000, 3000].map((g, i) => ({
    trade_id: `r${i}`,
    market: "csfloat",
    quantity: 1,
    gross_sale_cents: g,
    payout_rail: "bank",
    computed_net_cents: modelNet(BASE_FEE_MODEL, { market: "csfloat", quantity: 1, unitSellPriceCents: g, payoutRail: "bank" }),
    receipt_net_cents: modelNet(BASE_FEE_MODEL, { market: "csfloat", quantity: 1, unitSellPriceCents: g, payoutRail: "bank" }) - Math.round(g / 100), // 1% worse
  }));
  const [p] = calibrate(receipts, BASE_FEE_MODEL);
  assert.equal(p.kind, "PROPOSED_CALIBRATION");
  assert.equal(p.status, "PROPOSED");
  assert.ok(p.difference_cents < 0);
  assert.ok(p.possible_reasons.length > 0);
  assert.ok(p.proposed_overrides.CSFLOAT_PAYOUT_FEE_RATE.bank > FEES.CSFLOAT_PAYOUT_FEE_RATE.bank);
  assert.equal(JSON.stringify(FEES), before, "constants untouched by calibration");
  assert.equal(BASE_FEE_MODEL.fees.CSFLOAT_PAYOUT_FEE_RATE.bank, 0.015);
  assert.equal(validateOverrides(p.proposed_overrides), null);
  const accepted = deriveFeeModel(BASE_FEE_MODEL, { overrides: p.proposed_overrides, created_at: iso(NOW), source: "user accepted" });
  assert.notEqual(accepted.fee_model_version, BASE_FEE_MODEL.fee_model_version);
  assert.equal(accepted.fees.CSFLOAT_PAYOUT_FEE_RATE.bank, p.proposed_overrides.CSFLOAT_PAYOUT_FEE_RATE.bank);
  assert.equal(JSON.stringify(FEES), before);
  assert.equal(calibrate(receipts.slice(0, 2), BASE_FEE_MODEL).length, 0, "fewer than 3 receipts → no proposal");
  assert.equal(validateOverrides({ MIN_NET_PROFIT_CENTS: 1 }), "override MIN_NET_PROFIT_CENTS not allowed");
});

test("C4 via calibration: Steam receipts matching Valve's exact method propose switching the model", () => {
  const receipts = [2000, 3000, 4000].map((g, i) => ({ trade_id: `s${i}`, market: "steam", quantity: 1, gross_sale_cents: g, computed_net_cents: Math.round(g * 0.85), receipt_net_cents: { 2000: 1739, 3000: 2609, 4000: 3479 }[g] }));
  const [p] = calibrate(receipts, BASE_FEE_MODEL);
  assert.deepEqual(p.proposed_overrides, { STEAM_FEE_MODEL: "valve_fee_on_top" });
  assert.equal(FEES.STEAM_FEE_MODEL, "flat_on_gross");
});

function seedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "orca-ev-")), "t.sqlite"));
  const itemId = upsertItem(db, "A", { nowIso: iso(NOW) });
  registerParser(db, { parser_version: "csfloat_listings@1", endpoint: "csfloat_listings", verification_status: "UNVERIFIED" }, iso(NOW));
  return { db, itemId };
}

function fakeOpportunity(extra = {}) {
  return {
    item: "A", buy_source: "steam", sell_source: "csfloat", rank_eligible: true, status: "ELIGIBLE", hold_days: 7, computed_at: iso(NOW),
    quality: { state: "COMPLETE", reasons: [], sufficiency: "SYNTHETIC" }, blocked_reasons: [], contributing: [], trace: [], synthetic: true, umbra: false, unproven: false,
    math: { entry_cost_cents: 1000, hold_adverse_move_ppm: -20000, reversal_reserve_cents: 10, executable_exit_price_cents: 1300, expected_net_profit_cents: 200 },
    versions: { strategy_version: SV, signal_version: "signal-v1", fee_model_version: BASE_FEE_MODEL.fee_model_version, parser_versions: ["csfloat_listings@1"] },
    ...extra,
  };
}

function exitObs(db, itemId, observedMs) {
  const req = insertSourceRequest(db, { source: "csfloat", endpoint: "csfloat_listings", requested_at: iso(observedMs), outcome: "OK", response_hash: "h", synthetic: true });
  insertMarketObservation(db, { request_id: req, item_id: itemId, source: "csfloat", endpoint: "csfloat_listings", kind: "quote", observed_at: iso(observedMs), received_at: iso(observedMs), response_hash: "h", parser_version: "csfloat_listings@1", price_usd_cents: 1400, quality_state: "COMPLETE", synthetic: true });
}

test("paper trades: one OPEN per pair; closes on the first exit quote after planned close; VOIDs on unverified/missing", () => {
  const { db, itemId } = seedDb();
  const engine = new Engine({ db, getCfg: () => RESEARCH_DEFAULTS, env: {} });
  const cycle = { all: [fakeOpportunity(), fakeOpportunity({ rank_eligible: false, math: null, sell_source: "skinport" })] };
  assert.equal(openPaperTrades(db, cycle, (o, id) => engine.persistForce(o, id), NOW).length, 1);
  assert.equal(openPaperTrades(db, cycle, (o, id) => engine.persistForce(o, id), NOW + 1000).length, 0, "no second OPEN trade for the same pair");
  const p = db.prepare("SELECT * FROM paper_trades").get();
  assert.equal(p.synthetic, 1);
  assert.equal(p.opportunity_id, 1);

  exitObs(db, itemId, NOW + 7 * 86400000 + 60000);
  let r = closePaperTrades(db, RESEARCH_DEFAULTS, NOW + 7 * 86400000 + 120000);
  assert.equal(r[0].status, "VOID", "exit observation from an UNVERIFIED parser cannot close a paper trade");

  const s2 = seedDb();
  registerParser(s2.db, { parser_version: "csfloat_listings@1", endpoint: "csfloat_listings", verification_status: "VERIFIED" }, iso(NOW));
  const e2 = new Engine({ db: s2.db, getCfg: () => RESEARCH_DEFAULTS, env: {} });
  openPaperTrades(s2.db, cycle, (o, id) => e2.persistForce(o, id), NOW);
  assert.deepEqual(closePaperTrades(s2.db, RESEARCH_DEFAULTS, NOW + 7 * 86400000 - 1), [], "not due yet");
  exitObs(s2.db, s2.itemId, NOW + 7 * 86400000 + 60000);
  r = closePaperTrades(s2.db, RESEARCH_DEFAULTS, NOW + 7 * 86400000 + 120000);
  // exit 1400 × (1 − 2%) = 1372; fees: 1372 × 0.98 → 1345 (1344.56); payout round(20.175) = 20 → 1325; − 1000 − 10
  assert.deepEqual(r[0], { id: 1, status: "CLOSED", paper_net_profit_cents: 315 });

  const s3 = seedDb();
  const e3 = new Engine({ db: s3.db, getCfg: () => RESEARCH_DEFAULTS, env: {} });
  openPaperTrades(s3.db, cycle, (o, id) => e3.persistForce(o, id), NOW);
  const late = NOW + 7 * 86400000 + (RESEARCH_DEFAULTS.paper.close_grace_hours + 1) * 3600000;
  assert.equal(closePaperTrades(s3.db, RESEARCH_DEFAULTS, late)[0].status, "VOID");
  assert.throws(() => s3.db.prepare("UPDATE paper_trades SET status = 'CLOSED'").run(), /only OPEN/);
});

test("five profit figures stay separate; missing inputs are UNAVAILABLE, never zero-filled", () => {
  const figs = profitFigures({
    realTrades: [{ realized_net_profit_cents: 158 }],
    paperTrades: [{ status: "CLOSED", synthetic: 0, paper_net_profit_cents: 300 }, { status: "VOID", synthetic: 0, paper_net_profit_cents: null }],
    simulatedTrades: [],
    balances: { ok: true, open_lots: [{ lot_id: "l1", quantity: 1, buy_price_cents: 1000 }], lot_valuations: [{ lot_id: "l1", state: "OK", value_cents: 1100 }] },
    estimatedExit: null,
  });
  assert.deepEqual(figs.map((f) => [f.name, f.category, f.value_cents, f.state]), [
    ["REALIZED_NET_PROFIT", "REAL", 158, "COMPLETE"],
    ["PAPER_NET_PROFIT", "PAPER", 300, "COMPLETE"],
    ["HISTORICAL_SIMULATED_PROFIT", "SIMULATED", null, "UNAVAILABLE"],
    ["MARK_TO_MARKET_UNREALIZED_PNL", "OBSERVED", 100, "COMPLETE"],
    ["ESTIMATED_EXIT_PROFIT", "ESTIMATED", null, "UNAVAILABLE"],
  ]);
});

test("research settings: dangerous combinations warn; L2/L3 and AUTOMATION rejected", () => {
  assert.ok(validateResearchSettings({ "umbra.allow_thin": true }).warnings.length > 0);
  assert.equal(validateResearchSettings({ "automation.level": "L2" }).ok, false);
  assert.equal(validateResearchSettings({ "mode.operating": "AUTOMATION" }).ok, false);
  assert.equal(validateResearchSettings({ "umbra.active": true }).ok, false, "bankroll required");
  assert.equal(validateResearchSettings({ "umbra.active": true, "umbra.bankroll_cents": 50000 }).ok, true);
  assert.equal(validateResearchSettings({ "math.hold_adverse_min_pairs": 5 }).ok, false, "invariants are not user settings");
});
