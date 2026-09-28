// UMBRA autopilot: after each engine cycle, the top ELIGIBLE deals are STAGED (L1: an external
// link, no submission) and NOTIFIED in-app; paper trades are logged by paper.js. It executes
// nothing: no executor exists in this build, and execution would require L2/L3 anyway, which
// UMBRA never grants. The kill switch stops staging.

import { permissionDecision } from "../js/research/automation.js";
import { killSwitchState } from "./api-control.js";

export const STAGE_TOP_N = 3;
const DEDUPE_MS = 3600000;

// Buy-leg listing links. Link formats are UNVERIFIED (they only open a page for the user).
export function externalUrl(market, item) {
  const q = encodeURIComponent(item);
  if (market === "steam") return `https://steamcommunity.com/market/listings/730/${q}`;
  if (market === "csfloat") return `https://csfloat.com/search?market_hash_name=${q}&sort_by=lowest_price&type=buy_now`;
  return `https://skinport.com/market?search=${q}`;
}

export function runAutopilot(db, cycle, cfg, nowMs, persistForce) {
  const out = { staged: [], notified: [], executed: [] };
  if (cycle.mode !== "UMBRA" || !cfg.umbra.active) return out;
  const state = { level: cfg.automation.level, killSwitch: killSwitchState(db), umbra: { active: true, unproven: cfg.umbra.override_unproven } };
  const top = cycle.ranked.filter((o) => o.status === "ELIGIBLE").slice(0, STAGE_TOP_N);
  for (const o of top) {
    const item = db.prepare("SELECT item_id FROM items WHERE market_hash_name = ?").get(o.item);
    if (!item) continue;
    const recent = db
      .prepare(
        `SELECT 1 FROM staged_actions s JOIN opportunities p USING (opportunity_id)
         WHERE p.item_id = ? AND p.buy_source = ? AND p.sell_source = ? AND s.created_at >= ? LIMIT 1`,
      )
      .get(item.item_id, o.buy_source, o.sell_source, new Date(nowMs - DEDUPE_MS).toISOString());
    if (recent) continue;
    const decision = permissionDecision({ action: "stage" }, state);
    const nowIso = new Date(nowMs).toISOString();
    const oppId = o.opportunity_id ?? persistForce(o, item.item_id);
    const unproven = cycle.unproven ? 1 : 0;
    const label = `${unproven ? "UNPROVEN · " : ""}${o.item}: ${o.buy_source} → ${o.sell_source}, expected_net_profit ${o.math.expected_net_profit_cents}¢ (ESTIMATED)`;
    if (decision.allowed) {
      const url = externalUrl(o.buy_source, o.item);
      db.prepare("INSERT INTO staged_actions (created_at, opportunity_id, level, action, external_url, unproven) VALUES (?, ?, 'L1', ?, ?, ?)").run(nowIso, oppId, `open ${o.buy_source} listing (no submission)`, url, unproven);
      out.staged.push(oppId);
    }
    db.prepare("INSERT INTO notifications (created_at, channel, title, body, opportunity_id) VALUES (?, 'in_app', ?, ?, ?)").run(
      nowIso,
      decision.allowed ? "UMBRA: deal staged" : "UMBRA: deal found (not staged)",
      decision.allowed ? label : `${label} — ${decision.reason}`,
      oppId,
    );
    out.notified.push(oppId);
  }
  return out;
}
