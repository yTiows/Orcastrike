// JSON contract served by the daemon. v1 routes (/api/quote, /api/history, /api/fx) keep the
// Worker's canonical schema so the existing UI works unchanged against either backend.
// v2 routes expose the research system. Every response states its contract version.

import { getSettings, itemByName, latestObservation, openQualityEvents, putSettings } from "./db.js";
import { coverageForDay, lastCompleteDays } from "./quality.js";
import { capacityPlan, planJobs, trackedItems } from "./scheduler.js";
import { HttpError } from "./server.js";
import { normalizeWatchlist } from "../js/state.js";
import { SCHEMA, validateResearchSettings } from "../config/settings-schema.js";

export const API_VERSION = "orcastrike-daemon-api@1";
const QUOTE_TTL_S = 90;
const PARSER_FOR_SOURCE = { steam: "steam_histogram@1", csfloat: "csfloat_listings@1", skinport: "skinport_items@1" };

function item(query) {
  const raw = query.get("item");
  if (typeof raw !== "string" || !raw.trim() || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) { // eslint-disable-line no-control-regex
    throw new HttpError(400, "item must be a market_hash_name of 1–200 printable characters");
  }
  return raw.trim();
}

export function v1Quote(ctx, source, name) {
  const { db, env } = ctx;
  const nowIso = new Date().toISOString();
  const base = { source, canonical_item_id: name, price_usd_cents: null, listing_depth: null, captured_at: nowIso, expires_at: nowIso };
  if (source === "csfloat" && !(env.CSFLOAT_API_KEY ?? "").trim()) return { ...base, state: "NOT_CONFIGURED", reason: "CSFLOAT_API_KEY is not set on the daemon" };
  const row = itemByName(db, name);
  if (!row) return { ...base, state: "UNAVAILABLE", reason: "item is not tracked by the daemon (add it to the watchlist)" };
  const q = latestObservation(db, row.item_id, source, "quote");
  if (!q) return { ...base, state: "UNAVAILABLE", reason: "no observation yet" };
  const depth = latestObservation(db, row.item_id, source, "depth");
  const sameReq = depth && depth.request_id === q.request_id ? depth : null;
  const state = q.quality_state === "INVALID" ? "INVALID" : q.quality_state === "STALE" ? "STALE" : q.quality_state === "INSUFFICIENT" ? "UNAVAILABLE" : "AVAILABLE";
  const out = {
    source,
    canonical_item_id: name,
    price_usd_cents: state === "AVAILABLE" || state === "STALE" ? q.price_usd_cents : null,
    listing_depth: source === "skinport" ? null : sameReq ? sameReq.listing_supply : null,
    captured_at: q.observed_at,
    expires_at: new Date(Date.parse(q.observed_at) + QUOTE_TTL_S * 1000).toISOString(),
    state,
    ...(q.quality_reason ? { reason: q.quality_reason } : {}),
    listing_depth_basis: source === "skinport" ? "unavailable" : "within_10pct_of_lowest",
    listing_depth_capped: Boolean(sameReq?.listing_supply_capped),
    observation_id: q.observation_id,
    parser_version: q.parser_version,
    parser_status: ctx.parserStatus()[q.parser_version] ?? "UNVERIFIED",
    synthetic: Boolean(q.synthetic),
  };
  if (source === "skinport") {
    Object.assign(out, {
      fx_rate_micros: q.fx_rate_micros,
      fx_rate_date: q.fx_rate_date,
      fx_state: Number.isSafeInteger(q.fx_rate_micros) ? "AVAILABLE" : "UNAVAILABLE",
      fx_source: "frankfurter_ecb",
      upstream_cache_s: ctx.getCfg().snapshot.upstream_cache_skinport_s,
    });
  }
  return out;
}

export function coreRoutes(ctx) {
  const { db } = ctx;
  return [
    {
      method: "GET",
      path: "/api/v2/health",
      handler: () => ({
        contract: API_VERSION,
        time: new Date().toISOString(),
        started_at: ctx.startedAt,
        db: ctx.dbHealth(),
        synthetic_upstream: ctx.env.ORCASTRIKE_SYNTHETIC === "1",
        sources: { steam: "CONFIGURED", skinport: "CONFIGURED", fx: "CONFIGURED", csfloat: (ctx.env.CSFLOAT_API_KEY ?? "").trim() ? "CONFIGURED" : "NOT_CONFIGURED" },
        parsers: ctx.parserStatus(),
        contract_report_run_at: ctx.verification().report_run_at,
        parser_for_source: PARSER_FOR_SOURCE,
        settings_errors: ctx.settingsErrors(),
      }),
    },
    {
      method: "GET",
      path: "/api/quote",
      handler: ({ query }) => {
        const source = query.get("source");
        if (!["steam", "csfloat", "skinport"].includes(source)) throw new HttpError(400, "source must be steam, skinport or csfloat");
        return v1Quote(ctx, source, item(query));
      },
    },
    {
      method: "GET",
      path: "/api/history",
      handler: ({ query }) => {
        if (query.get("source") !== "steam") throw new HttpError(400, "history is only available for source=steam");
        const name = item(query);
        const row = itemByName(db, name);
        const h = row ? latestObservation(db, row.item_id, "steam", "history") : null;
        const base = { source: "steam", canonical_item_id: name, currency: "USD" };
        if (!h) return { ...base, points: [], captured_at: new Date().toISOString(), expires_at: new Date().toISOString(), state: "UNAVAILABLE", reason: row ? "no history observation yet" : "item not tracked" };
        const n = JSON.parse(h.normalized_json);
        return {
          ...base,
          basis: n.basis,
          points: n.points ?? [],
          captured_at: h.observed_at,
          expires_at: new Date(Date.parse(h.observed_at) + 3600000).toISOString(),
          state: h.quality_state === "COMPLETE" ? "AVAILABLE" : h.quality_state === "INVALID" ? "INVALID" : "UNAVAILABLE",
          ...(h.quality_reason ? { reason: h.quality_reason } : {}),
          parser_status: ctx.parserStatus()[h.parser_version] ?? "UNVERIFIED",
        };
      },
    },
    {
      method: "GET",
      path: "/api/fx",
      handler: () => {
        const fx = latestObservation(db, null, "fx", "fx");
        if (!fx) return { source: "frankfurter_ecb", pair: "EUR/USD", rate_micros: null, rate_date: null, state: "UNAVAILABLE", reason: "no observation yet" };
        return { source: "frankfurter_ecb", pair: "EUR/USD", rate_micros: fx.fx_rate_micros, rate_date: fx.fx_rate_date, captured_at: fx.observed_at, state: fx.quality_state === "COMPLETE" ? "AVAILABLE" : fx.quality_state, parser_status: ctx.parserStatus()[fx.parser_version] ?? "UNVERIFIED" };
      },
    },
    {
      method: "GET",
      path: "/api/v2/quality",
      handler: ({ query }) => ({
        contract: "data_quality_event@1",
        open: openQualityEvents(db),
        recent: db.prepare("SELECT * FROM data_quality_events ORDER BY occurred_at DESC LIMIT ?").all(Math.min(500, Number(query.get("limit")) || 100)),
      }),
    },
    {
      method: "GET",
      path: "/api/v2/coverage",
      handler: ({ query }) => {
        const days = Math.min(60, Math.max(1, Number(query.get("days")) || 14));
        const cfg = ctx.getCfg();
        const jobs = planJobs({ db, cfg, env: ctx.env, tracked: trackedItems(db, getSettings(db)), nowMs: Date.now() });
        const plan = capacityPlan(jobs, cfg);
        return { contract: "coverage_report@1", plan, days: lastCompleteDays(Date.now(), days).map((d) => coverageForDay(db, d, plan)) };
      },
    },
    {
      method: "GET",
      path: "/api/v2/observations",
      handler: ({ query }) => {
        const row = itemByName(db, item(query));
        if (!row) return { contract: "observations@1", rows: [] };
        const rows = db
          .prepare(
            `SELECT observation_id, source, kind, observed_at, price_usd_cents, listing_supply, reference_price_usd_cents, quality_state, quality_reason, parser_version, synthetic
             FROM market_observations WHERE item_id = ? AND observed_at >= ? ORDER BY observed_at DESC LIMIT 2000`,
          )
          .all(row.item_id, new Date(Date.now() - 30 * 86400000).toISOString());
        return { contract: "observations@1", rows };
      },
    },
    {
      method: "GET",
      path: "/api/v2/settings",
      handler: () => ({ contract: "settings@1", stored: getSettings(db), effective: ctx.getCfg(), errors: ctx.settingsErrors(), schema: SCHEMA }),
    },
    {
      method: "POST",
      path: "/api/v2/settings",
      handler: ({ body }) => {
        const incoming = body?.settings;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new HttpError(400, "body.settings must be an object");
        const stored = getSettings(db);
        delete stored["watchlist.items"];
        const merged = { ...stored, ...incoming };
        const v = validateResearchSettings(merged);
        if (!v.ok) return { status: 422, body: { errors: v.errors, warnings: v.warnings } };
        putSettings(db, incoming, "ui", new Date().toISOString());
        ctx.reloadSettings();
        return { ok: true, warnings: v.warnings };
      },
    },
    {
      method: "POST",
      path: "/api/v2/watchlist",
      handler: ({ body }) => {
        const n = normalizeWatchlist(body?.items);
        putSettings(db, { "watchlist.items": n.items }, "ui", new Date().toISOString());
        return { ok: true, items: n.items, errors: n.errors };
      },
    },
  ];
}
