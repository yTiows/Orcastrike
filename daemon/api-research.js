// Research routes: opportunities, ledger sync (capital, breaker, v1 settings, real trades).

import { isIsoUtc } from "../js/ledger.js";
import { validateRiskConfig } from "../js/tiers.js";
import { itemByName, putSettings } from "./db.js";
import { HttpError } from "./server.js";

const CAPITAL_FIELDS = ["usd_cash_balance_cents", "banked_profit_cents", "reserved_cash_cents", "open_cost_basis_cents", "deployable_capital_cents", "steam_wallet_balance_cents"];

export function validateCapital(c) {
  if (!c || typeof c !== "object") return "capital must be an object";
  for (const f of CAPITAL_FIELDS) if (!Number.isSafeInteger(c[f])) return `capital.${f} must be integer cents`;
  for (const f of ["banked_profit_cents", "reserved_cash_cents", "open_cost_basis_cents", "steam_wallet_balance_cents", "usd_cash_balance_cents"]) if (c[f] < 0) return `capital.${f} must be ≥ 0`;
  if (typeof c.deployable_capital_complete !== "boolean") return "capital.deployable_capital_complete must be boolean";
  return null;
}

function slimOpportunity(o) {
  return { ...o, trace: o.trace, contributing: o.contributing };
}

export function researchRoutes(ctx) {
  const { db } = ctx;
  return [
    {
      method: "GET",
      path: "/api/v2/opportunities",
      handler: ({ query }) => {
        const mode = query.get("mode") === "umbra" ? "umbra" : "standard";
        const r = ctx.engine?.latest[mode];
        if (!r) return { contract: "opportunity_cycle@1", mode: mode.toUpperCase(), computed_at: null, ranked: [], all: [], counts: {}, note: "no engine cycle yet" };
        const limit = Math.min(2000, Number(query.get("limit")) || 500);
        return { ...r, ranked: r.ranked.slice(0, limit).map(slimOpportunity), all: query.get("all") === "1" ? r.all.slice(0, limit).map(slimOpportunity) : [] };
      },
    },
    {
      method: "GET",
      path: "/api/v2/opportunities/history",
      handler: ({ query }) => {
        const row = itemByName(db, String(query.get("item") ?? ""));
        if (!row) return { contract: "opportunity_history@1", rows: [] };
        return {
          contract: "opportunity_history@1",
          rows: db.prepare("SELECT * FROM opportunities WHERE item_id = ? ORDER BY opportunity_id DESC LIMIT 200").all(row.item_id),
        };
      },
    },
    {
      method: "POST",
      path: "/api/v2/ledger/sync",
      handler: ({ body }) => {
        const err = validateCapital(body?.capital);
        if (err) throw new HttpError(422, err);
        const cb = body.circuit_breaker_triggered_at ?? null;
        if (cb !== null && !isIsoUtc(cb)) throw new HttpError(422, "circuit_breaker_triggered_at must be ISO 8601 UTC or null");
        const risk = body.v1_settings?.risk;
        if (risk && !validateRiskConfig(risk).ok) throw new HttpError(422, "v1_settings.risk invalid");
        const nowIso = new Date().toISOString();
        putSettings(db, { "ledger.capital_snapshot": { capital: body.capital, circuit_breaker_triggered_at: cb, synced_at: nowIso } }, "ledger-sync", nowIso);
        if (body.v1_settings) putSettings(db, { "ledger.v1_settings": { risk: body.v1_settings.risk, filters: body.v1_settings.filters } }, "ledger-sync", nowIso);
        if (body.csfloat_payout_rail === "bank" || body.csfloat_payout_rail === "usdc") putSettings(db, { "ui.csfloat_payout_rail": body.csfloat_payout_rail }, "ledger-sync", nowIso);
        const trades = ctx.syncRealTrades ? ctx.syncRealTrades(body.real_trades ?? []) : { inserted: 0 };
        return { ok: true, synced_at: nowIso, real_trades: trades };
      },
    },
  ];
}
