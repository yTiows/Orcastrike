// The five separate profit figures. Never summed, never merged, each with its own category,
// state and basis. A figure that can't be computed is UNAVAILABLE / PARTIAL, never zero-filled.

import { PROFIT_FIGURES } from "./semantics.js";

const fig = (name, value, state, basis, extra = {}) => ({ name, category: PROFIT_FIGURES[name].category, value_cents: value, state, basis, does: PROFIT_FIGURES[name].does, does_not: PROFIT_FIGURES[name].does_not, ...extra });

// inputs:
//   realTrades: ledger trades (realized_net_profit_cents)
//   paperTrades: daemon paper trades (status, paper_net_profit_cents) or null when no daemon
//   sims: Map item → Steam-only simulation result with per-sample net profits, or empty
//   balances: ledger computeBalances() result (lot_valuations, open_lots)
//   estimatedExit: daemon estimate per open lot or null
export function profitFigures({ realTrades, paperTrades, simulatedTrades, balances, estimatedExit }) {
  const out = [];
  out.push(fig("REALIZED_NET_PROFIT", realTrades.reduce((s, t) => s + t.realized_net_profit_cents, 0), "COMPLETE", `${realTrades.length} closed REAL trade(s)`, { sample_size: realTrades.length }));

  if (!paperTrades) out.push(fig("PAPER_NET_PROFIT", null, "UNAVAILABLE", "no daemon connected (paper trades live in the daemon)"));
  else {
    const closed = paperTrades.filter((p) => p.status === "CLOSED" && !p.synthetic);
    out.push(fig("PAPER_NET_PROFIT", closed.reduce((s, p) => s + p.paper_net_profit_cents, 0), "COMPLETE", `${closed.length} CLOSED paper trade(s); ${paperTrades.filter((p) => p.status === "VOID").length} VOID excluded`, { sample_size: closed.length }));
  }

  if (!simulatedTrades.length) out.push(fig("HISTORICAL_SIMULATED_PROFIT", null, "UNAVAILABLE", "no Steam-only history simulation loaded this session"));
  else out.push(fig("HISTORICAL_SIMULATED_PROFIT", simulatedTrades.reduce((s, x) => s + x.net_profit_cents, 0), "COMPLETE", `${simulatedTrades.length} simulated Steam-only 7-day round trip(s), 1 unit each`, { sample_size: simulatedTrades.length }));

  if (!balances?.ok) out.push(fig("MARK_TO_MARKET_UNREALIZED_PNL", null, "UNAVAILABLE", "ledger unavailable"));
  else {
    const valued = balances.lot_valuations.filter((v) => v.state === "OK");
    const cost = (id) => {
      const l = balances.open_lots.find((x) => x.lot_id === id);
      return l ? (l.remaining_quantity ?? l.quantity) * l.buy_price_cents : 0;
    };
    const pnl = valued.reduce((s, v) => s + v.value_cents - cost(v.lot_id), 0);
    const unvalued = balances.lot_valuations.length - valued.length;
    out.push(fig("MARK_TO_MARKET_UNREALIZED_PNL", balances.open_lots.length ? pnl : 0, unvalued ? "PARTIAL" : "COMPLETE", unvalued ? `${valued.length} lot(s) valued; ${unvalued} INSUFFICIENT_DATA excluded (lower bound)` : `${valued.length} open lot(s) valued`, { unvalued_lots: unvalued }));
  }

  if (!estimatedExit) out.push(fig("ESTIMATED_EXIT_PROFIT", null, "UNAVAILABLE", "no daemon estimate (needs hold_adverse_move on the exit market)"));
  else {
    const known = estimatedExit.lots.filter((l) => l.state === "ESTIMATED");
    const unknown = estimatedExit.lots.length - known.length;
    out.push(fig("ESTIMATED_EXIT_PROFIT", known.length || !estimatedExit.lots.length ? known.reduce((s, l) => s + l.estimated_exit_profit_cents, 0) : null, unknown ? (known.length ? "PARTIAL" : "UNKNOWN") : "COMPLETE", `${known.length} lot(s) estimated; ${unknown} UNKNOWN`, { unknown_lots: unknown }));
  }
  return out;
}
