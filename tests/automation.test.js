// Automation ladder, kill switch, UMBRA activation and autopilot. The executor used here is a
// SYNTHETIC mock: no real execution API exists in this build (EXECUTION_API_VERIFIED = false).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_DEFAULTS, validateResearchSettings } from "../config/settings-schema.js";
import { killSwitchState, setKillSwitch } from "../daemon/api-control.js";
import { runAutopilot } from "../daemon/autopilot.js";
import { openDb, upsertItem } from "../daemon/db.js";
import { Engine } from "../daemon/engine.js";
import { AutomationController, EXECUTION_API_VERIFIED, L3_CONFIRMATION_PHRASE, levelAvailability, permissionDecision } from "../js/research/automation.js";
import { OVERRIDE_PHRASE, umbraActivation } from "../js/research/umbra.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const LIMITS = { per_item_cents: 5000, per_day_cents: 20000, total_exposure_cents: 50000, max_concurrent_orders: 3, max_loss_cents: 3000 };
const L3_STATE = { level: "L3", killSwitch: { engaged: false }, umbra: { active: false, unproven: false }, strategyValidated: true, limits: LIMITS, confirmation: L3_CONFIRMATION_PHRASE };

test("production build: no verified execution API; L2/L3 unavailable", () => {
  assert.equal(EXECUTION_API_VERIFIED, false);
  assert.equal(levelAvailability("L1").available, true);
  assert.match(levelAvailability("L2").reason, /UNVERIFIED/);
  assert.match(levelAvailability("L3").reason, /UNVERIFIED/);
  assert.equal(permissionDecision({ action: "execute", dataState: "COMPLETE", approvedByUser: true }, { ...L3_STATE, level: "L2" }).allowed, false);
});

test("permission matrix (execution API assumed verified for the controller logic only)", () => {
  const v = { executionApiVerified: true };
  const req = { action: "execute", dataState: "COMPLETE", amountCents: 1000 };
  assert.equal(permissionDecision({ action: "alert" }, { ...L3_STATE, killSwitch: { engaged: true } }).allowed, true);
  assert.equal(permissionDecision({ action: "stage" }, { level: "L0", killSwitch: { engaged: false }, umbra: { active: false } }).allowed, false);
  assert.equal(permissionDecision({ action: "stage" }, { level: "L0", killSwitch: { engaged: false }, umbra: { active: true } }).allowed, true);
  assert.equal(permissionDecision({ action: "stage" }, { level: "L1", killSwitch: { engaged: true } }).allowed, false);
  assert.equal(permissionDecision(req, L3_STATE, v).allowed, true);
  assert.match(permissionDecision(req, { ...L3_STATE, umbra: { active: true, unproven: true } }, v).reason, /never unlocks L2\/L3/);
  assert.match(permissionDecision(req, { ...L3_STATE, strategyValidated: false }, v).reason, /STRATEGY_VALIDATION/);
  assert.match(permissionDecision(req, { ...L3_STATE, confirmation: "yes" }, v).reason, /confirmation phrase/);
  assert.match(permissionDecision(req, { ...L3_STATE, limits: { ...LIMITS, max_loss_cents: 0 } }, v).reason, /hard limits/);
  assert.match(permissionDecision({ ...req, amountCents: 6000 }, L3_STATE, v).reason, /per-item/);
  assert.match(permissionDecision({ ...req, dataState: "STALE" }, L3_STATE, v).reason, /STOP/);
  assert.match(permissionDecision({ action: "reprice", dataState: "COMPLETE", amountCents: 100 }, L3_STATE, v).reason, /floor price/);
  assert.equal(permissionDecision({ ...req, approvedByUser: false }, { ...L3_STATE, level: "L2" }, v).allowed, false);
  assert.equal(permissionDecision({ ...req, approvedByUser: true }, { ...L3_STATE, level: "L2" }, v).allowed, true);
});

function controller(executor) {
  const events = [];
  let kill = { engaged: false };
  const c = new AutomationController({
    executor,
    getState: () => ({ ...L3_STATE, killSwitch: kill }),
    setKillSwitch: async (s) => {
      kill = s;
      events.push(s);
    },
    executionApiVerified: true,
  });
  return { c, events, kill: () => kill };
}

test("ACCEPTANCE 7: unexpected API response in L3 → STOP and kill switch set", async () => {
  const SYNTHETIC_EXECUTOR = { execute: async () => ({ status: "SOMETHING_ELSE" }) };
  const { c, kill } = controller(SYNTHETIC_EXECUTOR);
  const r = await c.act({ action: "execute", dataState: "COMPLETE", amountCents: 1000 });
  assert.deepEqual(r, { status: "STOPPED", reason: "unexpected API response" });
  assert.equal(kill().engaged, true);
  const after = await c.act({ action: "execute", dataState: "COMPLETE", amountCents: 1000 });
  assert.equal(after.status, "DENIED");
  assert.equal(after.reason, "kill switch engaged");
});

test("API failure and stale data also STOP; a well-formed response executes (mock)", async () => {
  const fail = controller({ execute: async () => { throw new Error("503"); } });
  assert.equal((await fail.c.act({ action: "execute", dataState: "COMPLETE", amountCents: 1000 })).status, "STOPPED");
  const stale = controller({ execute: async () => ({ status: "ACCEPTED", order_id: "x", amount_cents: 1000 }) });
  assert.equal((await stale.c.act({ action: "execute", dataState: "STALE", amountCents: 1000 })).status, "STOPPED");
  assert.equal(stale.kill().engaged, true);
  const ok = controller({ execute: async () => ({ status: "ACCEPTED", order_id: "SYNTHETIC-1", amount_cents: 1000 }) });
  assert.deepEqual(await ok.c.act({ action: "execute", dataState: "COMPLETE", amountCents: 1000 }), { status: "EXECUTED", order_id: "SYNTHETIC-1" });
  const wrongAmount = controller({ execute: async () => ({ status: "ACCEPTED", order_id: "x", amount_cents: 999 }) });
  assert.equal((await wrongAmount.c.act({ action: "execute", dataState: "COMPLETE", amountCents: 1000 })).status, "STOPPED");
});

test("UMBRA activation: bankroll required; without SIGNAL_EVIDENCE only the exact typed override works", () => {
  assert.equal(umbraActivation({ bankrollCents: null, signalEvidencePass: true }).ok, false);
  assert.equal(umbraActivation({ bankrollCents: 50000, signalEvidencePass: false, typedOverride: "yes" }).ok, false);
  const u = umbraActivation({ bankrollCents: 50000, signalEvidencePass: false, typedOverride: OVERRIDE_PHRASE });
  assert.equal(u.ok, true);
  assert.equal(u.settings["umbra.override_unproven"], true);
  assert.equal(umbraActivation({ bankrollCents: 50000, signalEvidencePass: true }).settings["umbra.override_unproven"], false);
  assert.equal(validateResearchSettings({ ...u.settings, "automation.level": "L3" }).ok, false, "UMBRA never grants execution");
});

function autopilotDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "orca-ap-")), "t.sqlite"));
  upsertItem(db, "A", { nowIso: new Date(NOW).toISOString() });
  return db;
}

const deal = {
  item: "A", buy_source: "csfloat", sell_source: "skinport", status: "ELIGIBLE", rank_eligible: true, hold_days: 7, computed_at: new Date(NOW).toISOString(),
  quality: { state: "COMPLETE", reasons: [], sufficiency: "SYNTHETIC" }, blocked_reasons: [], contributing: [], trace: [], synthetic: true, umbra: true, unproven: true,
  math: { entry_cost_cents: 2000, expected_net_profit_cents: 300, rank_metric_ppm_per_day: 21428 },
  versions: { strategy_version: "s-umbra", signal_version: "signal-v1", fee_model_version: "f", parser_versions: [] },
};
const cfgUmbra = validateResearchSettings({ "umbra.active": true, "umbra.bankroll_cents": 50000, "umbra.override_unproven": true }).effective;

test("ACCEPTANCE 6: UMBRA active + automation off (L0) → top deal staged and notified; nothing executed", () => {
  const db = autopilotDb();
  const engine = new Engine({ db, getCfg: () => cfgUmbra, env: {} });
  assert.equal(cfgUmbra.automation.level, "L0");
  const r = runAutopilot(db, { mode: "UMBRA", unproven: true, ranked: [deal] }, cfgUmbra, NOW, (o, id) => engine.persistForce(o, id));
  assert.equal(r.staged.length, 1);
  assert.equal(r.notified.length, 1);
  assert.deepEqual(r.executed, []);
  const staged = db.prepare("SELECT * FROM staged_actions").get();
  assert.equal(staged.level, "L1");
  assert.match(staged.action, /no submission/);
  assert.equal(staged.unproven, 1);
  assert.match(db.prepare("SELECT body FROM notifications").get().body, /^UNPROVEN · /);
  assert.equal(runAutopilot(db, { mode: "UMBRA", unproven: true, ranked: [deal] }, cfgUmbra, NOW + 1000, (o, id) => engine.persistForce(o, id)).staged.length, 0, "deduplicated within an hour");
});

test("kill switch stops UMBRA staging (still notifies); non-UMBRA cycles do nothing", () => {
  const db = autopilotDb();
  const engine = new Engine({ db, getCfg: () => cfgUmbra, env: {} });
  setKillSwitch(db, { engaged: true, at: new Date(NOW).toISOString(), reason: "test" }, "test");
  assert.equal(killSwitchState(db).engaged, true);
  const r = runAutopilot(db, { mode: "UMBRA", unproven: true, ranked: [deal] }, cfgUmbra, NOW, (o, id) => engine.persistForce(o, id));
  assert.equal(r.staged.length, 0);
  assert.match(db.prepare("SELECT body FROM notifications").get().body, /kill switch engaged/);
  assert.deepEqual(runAutopilot(db, { mode: "STANDARD", ranked: [deal] }, RESEARCH_DEFAULTS, NOW, () => 1), { staged: [], notified: [], executed: [] });
});
