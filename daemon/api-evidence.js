// Evidence, paper trades, real trades (synced from the ledger), estimated exit profit for open
// lots, and fee-model versions. Paper and real are separate rows and separate statistics.

import { FEES } from "../config/fees.js";
import { isIsoUtc } from "../js/ledger.js";
import { mulDivRoundHalfUp, pctToBps, rateToBps } from "../js/money.js";
import { MARKET_REGIME_COVERAGE, breakdown, evidenceLadder, executionEvidence, signalEvidence, strategyValidation } from "../js/research/evidence.js";
import { deriveFeeModel, sellSideNet } from "../js/research/fee-model.js";
import { holdAdverseMove, stopTrigger } from "../js/research/metrics.js";
import { buildSnapshotGroup } from "../js/research/snapshot.js";
import { getSettings, itemByName, latestObservation, observationsSince, parserStatuses } from "./db.js";
import { currentFeeModel } from "./engine.js";
import { coverageForDay, lastCompleteDays } from "./quality.js";
import { capacityPlan, planJobs, trackedItems } from "./scheduler.js";
import { HttpError } from "./server.js";

const CONTRIBUTING_SOURCES = ["steam", "csfloat", "skinport", "fx"];
const REAL_FIELDS = ["trade_id", "canonical_item_id", "sell_market", "quantity", "sell_timestamp", "hold_duration_hours", "acquisition_cost_cents", "net_sale_proceeds_cents", "realized_net_profit_cents", "net_margin_bps", "strategy_version", "signal_version", "fee_model_version", "parser_version"];

export function syncRealTrades(db, trades) {
  if (!Array.isArray(trades)) throw new HttpError(422, "real_trades must be an array");
  let inserted = 0;
  const skipped = [];
  const nowIso = new Date().toISOString();
  for (const t of trades) {
    const missing = REAL_FIELDS.filter((f) => t?.[f] === undefined || t?.[f] === null);
    if (missing.length) {
      skipped.push({ trade_id: t?.trade_id ?? null, reason: `missing ${missing.join(", ")} (unversioned trades never count as evidence)` });
      continue;
    }
    if (!isIsoUtc(t.sell_timestamp) || !Number.isSafeInteger(t.realized_net_profit_cents)) {
      skipped.push({ trade_id: t.trade_id, reason: "invalid timestamp or amount" });
      continue;
    }
    const r = db
      .prepare(
        `INSERT INTO real_trades (trade_id, synced_at, canonical_item_id, sell_market, quantity, sell_timestamp, hold_duration_hours, acquisition_cost_cents,
           net_sale_proceeds_cents, realized_net_profit_cents, net_margin_bps, receipt_net_cents, reversal_incident, strategy_version, signal_version, fee_model_version, parser_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trade_id) DO NOTHING`,
      )
      .run(
        t.trade_id, nowIso, t.canonical_item_id, t.sell_market, t.quantity, t.sell_timestamp, t.hold_duration_hours, t.acquisition_cost_cents,
        t.net_sale_proceeds_cents, t.realized_net_profit_cents, t.net_margin_bps, Number.isSafeInteger(t.receipt_net_cents) ? t.receipt_net_cents : null,
        t.reversal_incident ? 1 : 0, t.strategy_version, t.signal_version, t.fee_model_version, t.parser_version,
      );
    inserted += Number(r.changes);
  }
  return { inserted, skipped };
}

export function evidenceReport(ctx, mode) {
  const { db } = ctx;
  const nowMs = Date.now();
  const cycle = ctx.engine?.latest[mode];
  const sv = cycle?.strategy_version ?? null;
  const paper = db.prepare("SELECT * FROM paper_trades WHERE synthetic = 0").all();
  const real = db.prepare("SELECT * FROM real_trades").all();
  const first = db.prepare("SELECT min(observed_at) AS t FROM market_observations WHERE synthetic = 0").get().t;
  const cfg = ctx.getCfg();
  const plan = capacityPlan(planJobs({ db, cfg, env: ctx.env, tracked: trackedItems(db, getSettings(db)), nowMs }), cfg);
  const coverage = lastCompleteDays(nowMs, 14).map((day) => {
    const c = coverageForDay(db, day, plan);
    return { day, sources: Object.fromEntries(CONTRIBUTING_SOURCES.map((s) => [s, c[s]?.coverage_pct_x100 ?? null])) };
  });
  const openHigh = db.prepare("SELECT * FROM data_quality_events WHERE resolved_at IS NULL AND severity = 'HIGH' AND synthetic = 0").all();
  const signal = signalEvidence({ strategyVersion: sv, paperTrades: paper, firstObservationAt: first, nowMs, coverage, contributingSources: CONTRIBUTING_SOURCES, openHighEvents: openHigh });
  const execution = executionEvidence({ strategyVersion: sv, realTrades: real });
  const paperRows = paper.filter((p) => p.status === "CLOSED" && p.strategy_version === sv).map((p) => ({ market: p.sell_source, hold_hours: (Date.parse(p.closed_at) - Date.parse(p.opened_at)) / 3600000, net_profit_cents: p.paper_net_profit_cents }));
  const realRows = real.filter((t) => t.strategy_version === sv).map((t) => ({ market: t.sell_market, hold_hours: t.hold_duration_hours, net_profit_cents: t.realized_net_profit_cents }));
  const validation = strategyValidation({ signal, execution, paperRows, realRows });
  const parser = parserStatuses(db);
  const verified = new Set(Object.entries(parser).filter(([, s]) => s === "VERIFIED").map(([v]) => v));
  const verifiedObs = verified.size
    ? db.prepare(`SELECT count(*) AS n FROM market_observations WHERE synthetic = 0 AND parser_version IN (${[...verified].map(() => "?").join(",")})`).get(...verified).n
    : 0;
  const discrepancies = db.prepare("SELECT count(*) AS n FROM opportunities WHERE synthetic = 0 AND quality_state = 'COMPLETE' AND expected_net_profit_cents > 0").get().n;
  return {
    contract: "evidence_report@1",
    computed_at: new Date(nowMs).toISOString(),
    mode: mode.toUpperCase(),
    strategy_version: sv,
    gates: { SIGNAL_EVIDENCE: signal, EXECUTION_EVIDENCE: execution, STRATEGY_VALIDATION: validation },
    ladder: evidenceLadder({ verifiedObservations: verifiedObs, observedDiscrepancies: discrepancies, syncedBacktest: null, signal, execution, validation, automationEnabled: false }),
    market_regime_coverage: MARKET_REGIME_COVERAGE,
    coverage,
  };
}

// Pessimistic exit estimate for open lots (ESTIMATED_EXIT_PROFIT) + stop trigger per lot.
export function estimateExits(ctx, lots) {
  const { db } = ctx;
  const cfg = ctx.getCfg();
  const nowMs = Date.now();
  const feeModel = currentFeeModel(db);
  const parserStatus = parserStatuses(db);
  const reserveBps = pctToBps(cfg.math.reversal_reserve_pct);
  const floors = cfg.stop.floor_cents_by_item ?? {};
  return lots.map((lot) => {
    const row = itemByName(db, lot.canonical_item_id);
    if (!row) return { lot_id: lot.lot_id, state: "UNKNOWN", reason: trackedItems(db, getSettings(db)).has(lot.canonical_item_id) ? "on the watchlist, but no price stored for it yet" : "not on the app's watchlist, so it has no prices (add it in Markets → Watchlist)" };
    const options = [];
    const reasons = [];
    for (const market of ["csfloat", "skinport"]) {
      const q = latestObservation(db, row.item_id, market, "quote");
      const g = buildSnapshotGroup({ requirements: [{ role: "exit_quote", source: market, kind: "quote", required: true }], observations: { exit_quote: q }, nowMs, snapshotCfg: cfg.snapshot, parserStatus });
      if (g.state !== "COMPLETE") {
        reasons.push(`${market}: ${g.state} (${g.reasons[0]})`);
        continue;
      }
      const ham = holdAdverseMove(observationsSince(db, row.item_id, market, "quote", new Date(nowMs - 30 * 86400000).toISOString()), { holdDays: cfg.math.hold_days, nowMs, toleranceS: cfg.math.hold_pair_tolerance_s });
      if (ham.state !== "ESTIMATED") {
        reasons.push(`${market}: hold_adverse_move ${ham.reason}`);
        continue;
      }
      const adj = mulDivRoundHalfUp(q.price_usd_cents, 1000000 + ham.ppm, 1000000);
      const s = sellSideNet(feeModel, market, adj, { fxRateMicros: q.fx_rate_micros, rail: getSettings(db)["ui.csfloat_payout_rail"] ?? "bank" });
      if (s.state !== "OK") continue;
      const proceeds = s.net_cents * lot.remaining_quantity;
      const reserve = mulDivRoundHalfUp(lot.cost_basis_cents, reserveBps, 10000);
      options.push({ market, estimated_exit_profit_cents: proceeds - lot.cost_basis_cents - reserve, pessimistic_proceeds_cents: proceeds, reserve_cents: reserve, ham_ppm: ham.ppm });
    }
    const series = observationsSince(db, row.item_id, "csfloat", "depth", new Date(nowMs - cfg.stop.window_min * 60000).toISOString());
    const stop = stopTrigger(series, { nowMs, dropPct: cfg.stop.drop_pct, windowMin: cfg.stop.window_min, floorCents: floors[lot.canonical_item_id] ?? null });
    if (!options.length) return { lot_id: lot.lot_id, state: "UNKNOWN", reason: reasons.join("; "), stop_trigger: stop };
    const best = options.reduce((a, b) => (b.estimated_exit_profit_cents > a.estimated_exit_profit_cents ? b : a));
    return { lot_id: lot.lot_id, state: "ESTIMATED", ...best, stop_trigger: stop };
  });
}

const ALLOWED_OVERRIDES = new Set(["STEAM_FEE_MODEL", "CSFLOAT_SELL_FEE", "CSFLOAT_PAYOUT_FEE_RATE", "SKINPORT_SELL_FEE_STANDARD", "SKINPORT_SELL_FEE_OVER_1000EUR", "SKINPORT_SELL_FEE_PRIVATE_LISTING", "SKINPORT_PAYOUT_FEE_RATE"]);

export function validateOverrides(o) {
  if (!o || typeof o !== "object") return "proposed_overrides must be an object";
  for (const [k, v] of Object.entries(o)) {
    if (!ALLOWED_OVERRIDES.has(k)) return `override ${k} not allowed`;
    if (k === "STEAM_FEE_MODEL") {
      if (!["flat_on_gross", "valve_fee_on_top"].includes(v)) return "STEAM_FEE_MODEL invalid";
    } else if (k === "CSFLOAT_PAYOUT_FEE_RATE") {
      for (const [rail, r] of Object.entries(v ?? {})) {
        if (!(rail in FEES.CSFLOAT_PAYOUT_FEE_RATE)) return `unknown rail ${rail}`;
        try {
          rateToBps(r);
        } catch {
          return `rate for ${rail} invalid`;
        }
      }
    } else {
      try {
        rateToBps(v);
      } catch {
        return `${k} must be a rate 0 ≤ r < 1 with ≤ 4 decimals`;
      }
    }
  }
  return null;
}

export function evidenceRoutes(ctx) {
  const { db } = ctx;
  return [
    { method: "GET", path: "/api/v2/evidence", handler: ({ query }) => evidenceReport(ctx, query.get("mode") === "umbra" ? "umbra" : "standard") },
    {
      method: "GET",
      path: "/api/v2/paper-trades",
      handler: ({ query }) => {
        const rows = db.prepare("SELECT p.*, i.market_hash_name FROM paper_trades p JOIN items i USING (item_id) ORDER BY paper_trade_id DESC LIMIT ?").all(Math.min(2000, Number(query.get("limit")) || 500));
        const closed = rows.filter((p) => p.status === "CLOSED" && !p.synthetic);
        return {
          contract: "paper_trades@1",
          kind: "PAPER",
          label: "forward paper trading evaluation (not a backtest)",
          selection_rule: "every rank-eligible opportunity of a strategy_version in PAPER mode or UMBRA autopilot; one open per item/pair; no cherry picking",
          rows,
          stats: breakdown(closed.map((p) => ({ market: p.sell_source, hold_hours: (Date.parse(p.closed_at) - Date.parse(p.opened_at)) / 3600000, net_profit_cents: p.paper_net_profit_cents }))),
        };
      },
    },
    {
      method: "GET",
      path: "/api/v2/real-trades",
      handler: () => {
        const rows = db.prepare("SELECT * FROM real_trades ORDER BY sell_timestamp DESC").all();
        return { contract: "real_trades@1", kind: "REAL", rows, stats: breakdown(rows.map((t) => ({ market: t.sell_market, hold_hours: t.hold_duration_hours, net_profit_cents: t.realized_net_profit_cents }))) };
      },
    },
    {
      method: "POST",
      path: "/api/v2/estimated-exit",
      handler: ({ body }) => {
        const lots = body?.lots;
        if (!Array.isArray(lots) || lots.length > 1000) throw new HttpError(422, "lots must be an array (≤ 1000)");
        for (const l of lots) {
          if (typeof l?.canonical_item_id !== "string" || !Number.isSafeInteger(l.remaining_quantity) || l.remaining_quantity < 1 || !Number.isSafeInteger(l.cost_basis_cents)) throw new HttpError(422, "each lot needs canonical_item_id, remaining_quantity, cost_basis_cents");
        }
        return { contract: "estimated_exit@1", category: "ESTIMATED", lots: estimateExits(ctx, lots) };
      },
    },
    {
      method: "GET",
      path: "/api/v2/fee-models",
      handler: () => ({
        contract: "fee_models@1",
        current: currentFeeModel(db).fee_model_version,
        versions: db.prepare("SELECT fee_model_version, created_at, source, accepted_by_user FROM fee_model_versions ORDER BY created_at").all(),
        proposals: db.prepare("SELECT * FROM fee_calibration_proposals ORDER BY proposal_id DESC LIMIT 100").all(),
      }),
    },
    {
      method: "POST",
      path: "/api/v2/fee-models/accept",
      handler: ({ body }) => {
        const p = body?.proposal;
        const err = validateOverrides(p?.proposed_overrides);
        if (err) throw new HttpError(422, err);
        if (body?.confirm !== true) throw new HttpError(422, "explicit user confirmation required");
        const nowIso = new Date().toISOString();
        const parent = currentFeeModel(db);
        const next = deriveFeeModel(parent, { overrides: p.proposed_overrides, created_at: nowIso, source: `user-accepted calibration (${p.market}, ${p.receipts} receipts, difference ${p.difference_cents} cents)` });
        db.prepare("INSERT INTO fee_model_versions (fee_model_version, created_at, source, model_json, accepted_by_user) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING").run(next.fee_model_version, nowIso, next.source, JSON.stringify(next));
        db.prepare("INSERT INTO fee_calibration_proposals (created_at, fee_model_version, market, observed_json, status, decided_at, accepted_fee_model_version) VALUES (?, ?, ?, ?, 'ACCEPTED', ?, ?)").run(
          nowIso, parent.fee_model_version, p.market, JSON.stringify(p), nowIso, next.fee_model_version,
        );
        return { ok: true, fee_model_version: next.fee_model_version, model: next };
      },
    },
  ];
}
