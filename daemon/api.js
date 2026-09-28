// JSON contract served by the daemon. v1 routes (/api/quote, /api/history, /api/fx) keep the
// Worker's canonical schema so the existing UI works unchanged against either backend.
// v2 routes expose the research system. Every response states its contract version.

import { getSettings, itemByName, latestObservation, openQualityEvents, putSettings } from "./db.js";
import { coverageForDay, lastCompleteDays } from "./quality.js";
import { capacityPlan, planJobs, trackedItems } from "./scheduler.js";
import { DIAGNOSTICS_CONTRACT, runDiagnostics } from "./diagnostics.js";
import { HttpError } from "./server.js";
import { normalizeWatchlist } from "../js/state.js";
import { SCHEMA, validateResearchSettings } from "../config/settings-schema.js";

export const API_VERSION = "orcastrike-daemon-api@1";
const QUOTE_TTL_S = 90;
const PARSER_FOR_SOURCE = { steam: "steam_histogram@1", csfloat: "csfloat_listings@1", skinport: "skinport_items@1" };
// Setup text for the Overview checklist. It lives server-side so shipped client files never
// carry a credential name (secret scan rule 4); it holds names only, never a value.
const KEY_SETUP = {
  windows_powershell: [
    '$s = Read-Host "CSFloat API key" -AsSecureString',
    "$k = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))",
    '[Environment]::SetEnvironmentVariable("CSFLOAT_API_KEY", $k, "User"); Remove-Variable s, k',
  ].join("\n"),
  macos_linux: "./orcastrike.sh stop\nread -rs CSFLOAT_API_KEY && export CSFLOAT_API_KEY && ./orcastrike.sh",
};

function item(query) {
  const raw = query.get("item");
  if (typeof raw !== "string" || !raw.trim() || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) { // eslint-disable-line no-control-regex
    throw new HttpError(400, "item must be a market_hash_name of 1–200 printable characters");
  }
  return raw.trim();
}

// The collector's last request for this source/endpoint (and item), in words: the reason a
// value is missing is always the upstream's actual answer, never a guess.
function lastRequestText(db, source, endpoint, name = null) {
  const r = db
    .prepare("SELECT outcome, http_status, error, requested_at FROM source_requests WHERE source = ? AND endpoint = ? AND request_params_json = ? ORDER BY requested_at DESC LIMIT 1")
    .get(source, endpoint, JSON.stringify(name ? { item: name } : {}));
  if (!r) return `the collector has not sent ${endpoint} yet`;
  return `last ${endpoint} request at ${r.requested_at}: ${r.outcome}${r.http_status ? ` (HTTP ${r.http_status})` : ""}${r.error ? `: ${r.error}` : ""}`;
}

// No items row yet: either the item really isn't on the watchlist, or it is and nothing has
// been stored for it so far (rows are created with the first observation).
function untrackedOrPending(db, name, source) {
  if (!trackedItems(db, getSettings(db)).has(name)) return "item is not on the app's watchlist (add it in Markets → Watchlist)";
  const endpoint = source === "steam" ? "steam_listing_page" : source === "skinport" ? "skinport_items" : `${source}_listings`;
  return `on the watchlist; nothing stored for it yet; ${lastRequestText(db, source, endpoint, source === "skinport" ? null : name)}`;
}

function missingQuoteReason(db, source, name, row) {
  if (source === "steam") {
    return row.steam_item_nameid
      ? `no observation yet; ${lastRequestText(db, "steam", "steam_histogram", name)}`
      : `Steam prices need the item's id from its Steam listing page, which hasn't been read yet; ${lastRequestText(db, "steam", "steam_listing_page", name)}`;
  }
  if (source === "skinport") return `no observation yet; ${lastRequestText(db, "skinport", "skinport_items")}`;
  return `no observation yet; ${lastRequestText(db, source, `${source}_listings`, name)}`;
}

export function v1Quote(ctx, source, name) {
  const { db, env } = ctx;
  const nowIso = new Date().toISOString();
  const base = { source, canonical_item_id: name, price_usd_cents: null, listing_depth: null, captured_at: nowIso, expires_at: nowIso };
  if (source === "csfloat" && !(env.CSFLOAT_API_KEY ?? "").trim()) return { ...base, state: "NOT_CONFIGURED", reason: "CSFLOAT_API_KEY is not set on the daemon" };
  const row = itemByName(db, name);
  if (!row) return { ...base, state: "UNAVAILABLE", reason: untrackedOrPending(db, name, source) };
  const q = latestObservation(db, row.item_id, source, "quote");
  if (!q) return { ...base, state: "UNAVAILABLE", reason: missingQuoteReason(db, source, name, row) };
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

function diagnosticsState(ctx) {
  const d = ctx.diagnostics ?? { running: false, report: null, error: null };
  return { contract: DIAGNOSTICS_CONTRACT, running: d.running, error: d.error, report: d.report };
}

// Cheap activity summary for the UI's status and "collecting data" progress. Reads recent rows
// by primary key only, so it stays fast on large databases.
export function dataSummary(db) {
  try {
    const first = db.prepare("SELECT observed_at FROM market_observations ORDER BY observation_id ASC LIMIT 1").get();
    const last = db.prepare("SELECT observed_at FROM market_observations ORDER BY observation_id DESC LIMIT 1").get();
    const total = db.prepare("SELECT MAX(observation_id) AS n FROM market_observations").get()?.n ?? 0;
    const tracked = trackedItems(db, getSettings(db)).size;
    const recent = db
      .prepare(
        `SELECT source, outcome, MAX(requested_at) AS last_at, COUNT(*) AS n FROM source_requests
         WHERE request_id > (SELECT COALESCE(MAX(request_id), 0) - 2000 FROM source_requests) GROUP BY source, outcome`,
      )
      .all();
    const sources = {};
    for (const r of recent) {
      const s = (sources[r.source] ??= { ok: 0, failed: 0, last_ok_at: null, last_failure: null, last_failure_at: null });
      if (r.outcome === "OK") {
        s.ok += r.n;
        s.last_ok_at = r.last_at;
      } else {
        s.failed += r.n;
        if (!s.last_failure_at || r.last_at > s.last_failure_at) Object.assign(s, { last_failure: r.outcome, last_failure_at: r.last_at });
      }
    }
    return { first_observation_at: first?.observed_at ?? null, last_observation_at: last?.observed_at ?? null, observations_total: total, tracked_items: tracked, sources };
  } catch {
    return null; // DEGRADED database: the UI shows the DEGRADED state instead
  }
}

function verifyState(ctx) {
  const v = ctx.verification();
  return {
    ...ctx.verifier.state,
    disabled: ctx.verifier.disabledReason(),
    report_run_at: v.report_run_at,
    results: v.results,
    by_source: ctx.sourceStatus(),
  };
}

export function coreRoutes(ctx) {
  const { db } = ctx;
  return [
    {
      method: "GET",
      path: "/api/v2/verify",
      handler: () => ({ contract: "verify@1", ...verifyState(ctx) }),
    },
    {
      // Runs the live contract test now (the daemon also runs it by itself once a day).
      method: "POST",
      path: "/api/v2/verify",
      handler: ({ body }) => {
        if (body?.confirm !== true) throw new HttpError(422, "explicit confirmation required");
        const why = ctx.verifier.disabledReason();
        if (why) throw new HttpError(409, `live verification is ${why}`);
        ctx.verifier.run("manual");
        return { contract: "verify@1", started: true, ...verifyState(ctx) };
      },
    },
    {
      method: "GET",
      path: "/api/v2/diagnostics",
      handler: () => diagnosticsState(ctx),
    },
    {
      // One real request per source, through the collector's own client, rate limits and
      // parsers. Runs in the background; the UI polls GET.
      method: "POST",
      path: "/api/v2/diagnostics",
      handler: ({ body }) => {
        if (body?.confirm !== true) throw new HttpError(422, "explicit confirmation required");
        const d = (ctx.diagnostics ??= { running: false, report: null, error: null });
        if (!d.running) {
          d.running = true;
          d.error = null;
          runDiagnostics({ db, client: ctx.client, cfg: ctx.getCfg(), env: ctx.env, tracked: trackedItems(db, getSettings(db)), scheduler: ctx.scheduler })
            .then((r) => (d.report = r))
            .catch((err) => (d.error = String(err?.message ?? err)))
            .finally(() => (d.running = false));
        }
        return diagnosticsState(ctx);
      },
    },
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
        parser_status_by_source: ctx.sourceStatus(),
        verify: verifyState(ctx),
        data: dataSummary(db),
        key_setup: KEY_SETUP,
        settings_errors: ctx.settingsErrors(),
      }),
    },
    {
      // v1 Worker contract: the UI's quotes client probes this when the daemon serves it.
      method: "GET",
      path: "/api/health",
      handler: () => ({
        time: new Date().toISOString(),
        served_by: "daemon",
        sources: { steam: "CONFIGURED", skinport: "CONFIGURED", fx: "CONFIGURED", csfloat: (ctx.env.CSFLOAT_API_KEY ?? "").trim() ? "CONFIGURED" : "NOT_CONFIGURED" },
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
        if (!h) return { ...base, points: [], captured_at: new Date().toISOString(), expires_at: new Date().toISOString(), state: "UNAVAILABLE", reason: row ? `no history observation yet; ${lastRequestText(db, "steam", "steam_listing_page", name)}` : untrackedOrPending(db, name, "steam") };
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
        const nowMs = Date.now();
        return {
          contract: "coverage_report@1",
          plan,
          days: lastCompleteDays(nowMs, days).map((d) => coverageForDay(db, d, plan)),
          today: coverageForDay(db, new Date(nowMs).toISOString().slice(0, 10), plan, { nowMs }),
        };
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
        const userKeys = new Set(SCHEMA.filter((e) => e.class === "user_setting").map((e) => e.key));
        const stored = Object.fromEntries(Object.entries(getSettings(db)).filter(([k]) => userKeys.has(k)));
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
