// Daemon side of the opportunity engine: builds snapshot groups from stored observations,
// runs the pure engine, persists results (append-only; on status change, or ELIGIBLE refresh),
// and keeps the latest cycle in memory for the API.

import { DEFAULTS } from "../config/defaults.js";
import { BASE_FEE_MODEL } from "../js/research/fee-model.js";
import { PAIRS, computeOpportunity, rankOpportunities, strategyParams, strategyVersion } from "../js/research/opportunity.js";
import { buildSnapshotGroup } from "../js/research/snapshot.js";
import { circuitBreakerStatus } from "../js/tiers.js";
import { getSettings, latestObservation, latestSales, observationsSince, parserStatuses } from "./db.js";
import { trackedItems } from "./scheduler.js";

const REQUIREMENTS = (buy, sell) => [
  { role: "entry_quote", source: buy, kind: "quote", required: true },
  { role: "exit_quote", source: sell, kind: "quote", required: true },
  { role: "exit_depth", source: sell, kind: "depth", required: false },
  { role: "exit_reference", source: sell, kind: "reference", required: false },
];

export function currentFeeModel(db) {
  const row = db.prepare("SELECT model_json FROM fee_model_versions WHERE accepted_by_user = 1 ORDER BY created_at DESC LIMIT 1").get();
  if (!row) return BASE_FEE_MODEL;
  try {
    return JSON.parse(row.model_json);
  } catch {
    return BASE_FEE_MODEL;
  }
}

// Ledger state synced from the browser (the user's only financial record lives there).
export function syncedLedgerState(settings) {
  const snap = settings["ledger.capital_snapshot"] ?? null;
  const v1 = settings["ledger.v1_settings"] ?? null;
  return {
    capital: snap?.capital ?? null,
    capital_synced_at: snap?.synced_at ?? null,
    breaker_triggered_at: snap?.circuit_breaker_triggered_at ?? null,
    v1: { risk: v1?.risk ?? DEFAULTS.risk, filters: v1?.filters ?? DEFAULTS.filters, tiers: DEFAULTS.TIERS },
  };
}

export function umbraMode(cfg) {
  return { umbra: Boolean(cfg.umbra.active), unproven: Boolean(cfg.umbra.override_unproven), bankroll_cents: cfg.umbra.bankroll_cents };
}

export class Engine {
  constructor({ db, getCfg, env, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { db, getCfg, env, log, now });
    this.latest = { standard: null, umbra: null };
    this.listeners = [];
  }

  onCycle(fn) {
    this.listeners.push(fn);
  }

  registerVersions(cfg, feeModel, sv, params, nowIso) {
    this.db.prepare("INSERT INTO strategy_versions (strategy_version, created_at, signal_version, params_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(sv, nowIso, params.signal_version, JSON.stringify(params));
    this.db
      .prepare("INSERT INTO fee_model_versions (fee_model_version, created_at, source, model_json, accepted_by_user) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING")
      .run(feeModel.fee_model_version, feeModel.created_at, feeModel.source, JSON.stringify(feeModel));
  }

  evaluateItem(itemRow, pair, ctx, parserStatus) {
    const [buy, sell] = pair;
    const obs = {
      entry_quote: latestObservation(this.db, itemRow.item_id, buy, "quote"),
      exit_quote: latestObservation(this.db, itemRow.item_id, sell, "quote"),
      exit_depth: latestObservation(this.db, itemRow.item_id, sell, "depth"),
      exit_reference: latestObservation(this.db, itemRow.item_id, sell, "reference"),
    };
    const group = buildSnapshotGroup({ requirements: REQUIREMENTS(buy, sell), observations: obs, nowMs: ctx.nowMs, snapshotCfg: ctx.cfg.snapshot, parserStatus });
    const synthetic = group.synthetic;
    const snaps =
      group.state === "COMPLETE"
        ? observationsSince(this.db, itemRow.item_id, sell, "quote", new Date(ctx.nowMs - ctx.cfg.math.hold_adverse_window_days * 86400000).toISOString()).filter((r) => Boolean(r.synthetic) === synthetic)
        : [];
    const sales = latestSales(this.db, itemRow.item_id, sell, 7);
    return computeOpportunity({ item: itemRow.market_hash_name, buyMarket: buy, sellMarket: sell, group, obs, exitSales: sales && Boolean(sales.synthetic) === synthetic ? sales : null, exitSnapshots: snaps, ctx });
  }

  // Unconditional append (a paper trade must reference the exact computed opportunity).
  persistForce(o, itemId) {
    return this.insertOpportunity(o, itemId);
  }

  persist(o, itemId) {
    const last = this.db
      .prepare("SELECT eligibility, computed_at FROM opportunities WHERE item_id = ? AND buy_source = ? AND sell_source = ? AND strategy_version = ? ORDER BY opportunity_id DESC LIMIT 1")
      .get(itemId, o.buy_source, o.sell_source, o.versions.strategy_version);
    const refreshMs = this.getCfg().sampling.market_quote_s * 1000;
    const changed = !last || last.eligibility !== o.status;
    const refresh = o.status === "ELIGIBLE" && last && Date.parse(o.computed_at) - Date.parse(last.computed_at) >= refreshMs;
    if (!changed && !refresh) return null;
    return this.insertOpportunity(o, itemId);
  }

  insertOpportunity(o, itemId) {
    const m = o.math ?? {};
    const id = this.db
      .prepare(
        `INSERT INTO opportunities (computed_at, item_id, buy_source, sell_source, eligibility, blocked_reasons_json, quality_state, quality_reason,
           entry_cost_cents, executable_exit_price_cents, hold_adverse_move_ppm, pessimistic_proceeds_cents, reversal_reserve_cents,
           expected_net_profit_cents, rank_metric_ppm_per_day, hold_days, contributing_observations_json, trace_json, strategy_version,
           signal_version, fee_model_version, parser_versions_json, umbra, unproven, synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.computed_at, itemId, o.buy_source, o.sell_source, o.status, JSON.stringify(o.blocked_reasons), o.quality.state,
        o.quality.sufficiency ?? o.quality.reasons.join("; ") ?? "", m.entry_cost_cents ?? null, m.executable_exit_price_cents ?? null,
        m.hold_adverse_move_ppm ?? null, m.pessimistic_proceeds_cents ?? null, m.reversal_reserve_cents ?? null, m.expected_net_profit_cents ?? null,
        m.rank_metric_ppm_per_day ?? null, o.hold_days, JSON.stringify(o.contributing), JSON.stringify(o.trace), o.versions.strategy_version,
        o.versions.signal_version, o.versions.fee_model_version, JSON.stringify(o.versions.parser_versions), o.umbra ? 1 : 0, o.unproven ? 1 : 0, o.synthetic ? 1 : 0,
      ).lastInsertRowid;
    return Number(id);
  }

  cycle() {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const cfg = this.getCfg();
    const settings = getSettings(this.db);
    const ledger = syncedLedgerState(settings);
    const mode = umbraMode(cfg);
    const feeModel = currentFeeModel(this.db);
    const params = strategyParams(cfg, { v1Filters: ledger.v1.filters, v1Risk: ledger.v1.risk, umbra: mode.umbra });
    const sv = strategyVersion(cfg, { v1Filters: ledger.v1.filters, v1Risk: ledger.v1.risk, umbra: mode.umbra });
    this.registerVersions(cfg, feeModel, sv, params, nowIso);
    const parserStatus = parserStatuses(this.db);
    const ctx = {
      nowMs,
      cfg,
      feeModel,
      capital: ledger.capital,
      v1: ledger.v1,
      breaker: circuitBreakerStatus(ledger.breaker_triggered_at, nowMs),
      mode,
      rail: settings["ui.csfloat_payout_rail"] ?? "bank",
      strategyVersion: sv,
      synthetic: this.env.ORCASTRIKE_SYNTHETIC === "1",
    };
    const tracked = trackedItems(this.db, settings);
    const universeRows = mode.umbra ? this.db.prepare("SELECT * FROM items WHERE in_universe = 1").all() : [];
    const trackedRows = [...tracked].map((n) => this.db.prepare("SELECT * FROM items WHERE market_hash_name = ?").get(n)).filter(Boolean);
    const rows = mode.umbra ? [...new Map([...trackedRows, ...universeRows].map((r) => [r.item_id, r])).values()] : trackedRows;
    const all = [];
    const persisted = [];
    for (const row of rows) {
      for (const pair of PAIRS) {
        const o = this.evaluateItem(row, pair, ctx, parserStatus);
        const id = this.persist(o, row.item_id);
        if (id) persisted.push({ id, o });
        o.opportunity_id = id;
        all.push(o);
      }
    }
    const counts = all.reduce((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {});
    const lastCycle = this.db.prepare("SELECT * FROM discovery_cycles WHERE completed_at IS NOT NULL ORDER BY cycle_id DESC LIMIT 1").get();
    const result = {
      contract: "opportunity_cycle@1",
      computed_at: nowIso,
      mode: mode.umbra ? "UMBRA" : "STANDARD",
      unproven: mode.umbra && mode.unproven,
      strategy_version: sv,
      fee_model_version: feeModel.fee_model_version,
      capital_synced_at: ledger.capital_synced_at,
      breaker: ctx.breaker,
      evaluated: all.length,
      counts,
      ranked: rankOpportunities(all),
      all,
      universe: mode.umbra
        ? {
            UNIVERSE_SIZE: universeRows.length,
            DISCOVERY_TIME: lastCycle?.completed_at ?? null,
            ITEMS_SKIPPED: Object.entries(counts).filter(([s]) => s !== "ELIGIBLE").reduce((n, [, c]) => n + c, 0),
            SKIP_REASON: Object.fromEntries(Object.entries(counts).filter(([s]) => s !== "ELIGIBLE")),
            universe_definition: "every item with a valid Skinport observation ≥ $10 in the last completed discovery cycle, plus the watchlist",
          }
        : null,
    };
    this.latest[mode.umbra ? "umbra" : "standard"] = result;
    for (const fn of this.listeners) {
      try {
        fn(result, persisted, ctx);
      } catch (err) {
        this.log("error", `cycle listener failed: ${err?.message ?? err}`);
      }
    }
    return result;
  }
}
