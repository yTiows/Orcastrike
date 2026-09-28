// Forward paper trading (not a "backtest"). Sample selection rule, stated before any result:
// EVERY opportunity that is rank-eligible under a strategy_version while the daemon runs in
// PAPER mode (or UMBRA autopilot) opens one 1-unit paper trade, at most one OPEN per
// (item, buy market, sell market, strategy_version). No selection by outcome, no cherry picking.
//
// Pessimistic fills: entry at the observed ask (+ buy-side fees); exit at planned close uses the
// DEFINED MATH item 4 on the exit market's observed ask at that time, with the entry-time
// hold_adverse_move haircut still applied (deliberately conservative), fees per the fee model in
// force at close, minus the entry-time reversal reserve. No fresh exit snapshot within the grace
// period → VOID (excluded from evidence, reported).

import { mulDivRoundHalfUp } from "../js/money.js";
import { sellSideNet } from "../js/research/fee-model.js";
import { currentFeeModel } from "./engine.js";
import { parserStatuses } from "./db.js";

export const PAPER_CONTRACT = "paper_trade@1";

export function shouldPaperTrade(cfg) {
  return cfg.mode.operating === "PAPER" || Boolean(cfg.umbra.active);
}

export function openPaperTrades(db, cycle, persistForce, nowMs) {
  const opened = [];
  for (const o of cycle.all) {
    if (!o.rank_eligible || !o.math) continue;
    const item = db.prepare("SELECT item_id FROM items WHERE market_hash_name = ?").get(o.item);
    if (!item) continue;
    const open = db
      .prepare("SELECT 1 FROM paper_trades WHERE item_id = ? AND buy_source = ? AND sell_source = ? AND strategy_version = ? AND status = 'OPEN'")
      .get(item.item_id, o.buy_source, o.sell_source, o.versions.strategy_version);
    if (open) continue;
    const oppId = o.opportunity_id ?? persistForce(o, item.item_id);
    const opened_at = new Date(nowMs).toISOString();
    const planned = new Date(nowMs + o.hold_days * 86400000).toISOString();
    const r = db
      .prepare(
        `INSERT INTO paper_trades (opportunity_id, item_id, buy_source, sell_source, quantity, opened_at, planned_close_at, hold_days, entry_cost_cents,
           entry_hold_adverse_move_ppm, entry_reversal_reserve_cents, status, strategy_version, signal_version, fee_model_version, parser_version, synthetic)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
      )
      .run(
        oppId, item.item_id, o.buy_source, o.sell_source, opened_at, planned, o.hold_days, o.math.entry_cost_cents, o.math.hold_adverse_move_ppm,
        o.math.reversal_reserve_cents, o.versions.strategy_version, o.versions.signal_version, o.versions.fee_model_version, o.versions.parser_versions.join(","), o.synthetic ? 1 : 0,
      );
    opened.push(Number(r.lastInsertRowid));
  }
  return opened;
}

export function closePaperTrades(db, cfg, nowMs, { rail = "bank" } = {}) {
  const due = db.prepare("SELECT * FROM paper_trades WHERE status = 'OPEN' AND planned_close_at <= ?").all(new Date(nowMs).toISOString());
  const feeModel = currentFeeModel(db);
  const parserStatus = parserStatuses(db);
  const graceMs = cfg.paper.close_grace_hours * 3600000;
  const nowIso = new Date(nowMs).toISOString();
  const voidTrade = (p, reason) => {
    db.prepare("UPDATE paper_trades SET status = 'VOID', closed_at = ?, void_reason = ? WHERE paper_trade_id = ?").run(nowIso, reason, p.paper_trade_id);
    return { id: p.paper_trade_id, status: "VOID", reason };
  };
  const results = [];
  for (const p of due) {
    const windowEnd = new Date(Date.parse(p.planned_close_at) + graceMs).toISOString();
    // The exit snapshot is the first COMPLETE exit-market quote at/after planned close, within grace.
    const exit = db
      .prepare(
        `SELECT * FROM market_observations WHERE item_id = ? AND source = ? AND kind = 'quote' AND quality_state = 'COMPLETE'
           AND observed_at >= ? AND observed_at <= ? AND synthetic = ? ORDER BY observed_at ASC LIMIT 1`,
      )
      .get(p.item_id, p.sell_source, p.planned_close_at, windowEnd, p.synthetic);
    if (!exit) {
      if (nowMs > Date.parse(windowEnd)) results.push(voidTrade(p, "no exit-market quote within the grace period after planned close"));
      continue;
    }
    if (parserStatus[exit.parser_version] !== "VERIFIED") {
      results.push(voidTrade(p, `exit observation parser ${exit.parser_version} UNVERIFIED`));
      continue;
    }
    const adj = mulDivRoundHalfUp(exit.price_usd_cents, 1000000 + p.entry_hold_adverse_move_ppm, 1000000);
    const sell = sellSideNet(feeModel, p.sell_source, adj, { fxRateMicros: exit.fx_rate_micros, rail });
    if (sell.state !== "OK") {
      results.push(voidTrade(p, `fee computation INVALID: ${sell.reason}`));
      continue;
    }
    const net = sell.net_cents - p.entry_cost_cents - p.entry_reversal_reserve_cents;
    db.prepare(
      "UPDATE paper_trades SET status = 'CLOSED', closed_at = ?, exit_observation_id = ?, exit_price_cents = ?, paper_proceeds_cents = ?, paper_net_profit_cents = ?, exit_fee_model_version = ? WHERE paper_trade_id = ?",
    ).run(nowIso, exit.observation_id, exit.price_usd_cents, sell.net_cents, net, feeModel.fee_model_version, p.paper_trade_id);
    results.push({ id: p.paper_trade_id, status: "CLOSED", paper_net_profit_cents: net });
  }
  return results;
}
