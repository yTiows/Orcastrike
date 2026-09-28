// Operating mode, UMBRA, automation level, kill switch, staged actions and notifications.
// Engaging the kill switch is always accepted (safe direction), even cross-origin. Releasing
// it, activating UMBRA or changing levels requires this origin (server.js CSRF guard).

import { LEVELS, levelAvailability } from "../js/research/automation.js";
import { OVERRIDE_PHRASE, UMBRA_RAILS, UMBRA_RANKING_CHANGES, umbraActivation } from "../js/research/umbra.js";
import { getSettings, putSettings } from "./db.js";
import { evidenceReport } from "./api-evidence.js";
import { HttpError } from "./server.js";

export function killSwitchState(db) {
  return getSettings(db)["automation.kill_switch"] ?? { engaged: false, at: null, reason: null };
}

export function setKillSwitch(db, state, origin) {
  const nowIso = new Date().toISOString();
  putSettings(db, { "automation.kill_switch": state }, origin, nowIso);
  db.prepare("INSERT INTO automation_events (occurred_at, kind, detail) VALUES (?, ?, ?)").run(nowIso, state.engaged ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_RELEASED", state.reason ?? "");
}

function applySettings(ctx, flat, origin) {
  putSettings(ctx.db, flat, origin, new Date().toISOString());
  ctx.reloadSettings();
  const errs = ctx.settingsErrors();
  if (errs.length) throw new HttpError(422, errs.join("; "));
}

export function controlRoutes(ctx) {
  const { db } = ctx;
  const state = () => {
    const cfg = ctx.getCfg();
    return {
      contract: "control@1",
      mode: cfg.mode.operating,
      umbra: {
        active: cfg.umbra.active,
        unproven: cfg.umbra.active && cfg.umbra.override_unproven,
        bankroll_cents: cfg.umbra.bankroll_cents,
        allow_thin: cfg.umbra.allow_thin,
        rails: UMBRA_RAILS,
        ranking_changes: UMBRA_RANKING_CHANGES,
        grants_execution: false,
      },
      automation: {
        level: cfg.automation.level,
        levels: LEVELS.map((l) => ({ level: l, ...levelAvailability(l) })),
        kill_switch: killSwitchState(db),
        limits: cfg.automation.limits,
      },
      staged: db.prepare("SELECT s.*, o.item_id FROM staged_actions s JOIN opportunities o USING (opportunity_id) ORDER BY staged_id DESC LIMIT 50").all(),
      notifications: db.prepare("SELECT * FROM notifications ORDER BY notification_id DESC LIMIT 50").all(),
      push_notifications: { state: "BLOCKED", reason: "ntfy is enabled only after Phases 0–5 are verified; Phase 0 is BLOCKED (no live contract verification)" },
    };
  };
  return [
    { method: "GET", path: "/api/v2/control", handler: state },
    {
      method: "POST",
      path: "/api/v2/mode",
      handler: ({ body }) => {
        applySettings(ctx, { "mode.operating": body?.operating }, "ui");
        return state();
      },
    },
    {
      method: "POST",
      path: "/api/v2/umbra",
      handler: ({ body }) => {
        if (body?.action === "deactivate") {
          applySettings(ctx, { "umbra.active": false, "umbra.override_unproven": false }, "ui");
          return state();
        }
        if (body?.action !== "activate") throw new HttpError(400, "action must be activate or deactivate");
        const signal = evidenceReport(ctx, "standard").gates.SIGNAL_EVIDENCE.pass;
        const a = umbraActivation({ bankrollCents: body.bankroll_cents, signalEvidencePass: signal, typedOverride: body.override_phrase });
        if (!a.ok) return { status: 422, body: { errors: a.errors, override_phrase: OVERRIDE_PHRASE } };
        applySettings(ctx, { ...a.settings, "umbra.allow_thin": Boolean(body.allow_thin) }, "ui");
        return state();
      },
    },
    {
      method: "POST",
      path: "/api/v2/automation",
      handler: ({ body }) => {
        const level = body?.level;
        if (!LEVELS.includes(level)) throw new HttpError(400, "level must be L0–L3");
        const avail = levelAvailability(level);
        if (!avail.available) return { status: 422, body: { errors: [avail.reason] } };
        applySettings(ctx, { "automation.level": level }, "ui");
        return state();
      },
    },
    {
      method: "POST",
      path: "/api/v2/kill-switch",
      allowCrossOrigin: true, // engaging is always safe; releasing is re-checked below
      handler: ({ body, headers }) => {
        if (body?.engaged === true) {
          setKillSwitch(db, { engaged: true, at: new Date().toISOString(), reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "manual" }, "ui");
          return state();
        }
        if (body?.engaged === false) {
          if (!headers.sameOrigin) throw new HttpError(403, "releasing the kill switch is accepted only from this origin");
          if (body.confirm !== true) throw new HttpError(422, "explicit confirmation required to release the kill switch");
          setKillSwitch(db, { engaged: false, at: new Date().toISOString(), reason: "released by user" }, "ui");
          return state();
        }
        throw new HttpError(400, "engaged must be true or false");
      },
    },
  ];
}
