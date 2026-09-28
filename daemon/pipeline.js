// One scheduled job end to end: raw observation → normalizer → validator → append-only store,
// plus data-quality events. Returns a small summary; never throws for upstream problems.

import { insertListingObservation, insertMarketObservation, insertSalesObservation, insertSourceRequest, latestObservation, setSteamNameId, tx, upsertItem } from "./db.js";
import { recordEventOnce, resolveOnRecovery } from "./quality.js";
import { ENDPOINTS } from "./sources.js";
import { validateRecord } from "./validate.js";

export const PIPELINE_CONTRACT = "raw_observation@1 → normalized_observation@1 → validated_observation@1";

function authHeaders(desc, env) {
  if (desc.requiresKey === "CSFLOAT_API_KEY") return { authorization: env.CSFLOAT_API_KEY.trim() };
  return {};
}

export function latestUsableFx(db, nowMs, cfg) {
  const fx = latestObservation(db, null, "fx", "fx");
  if (!fx) return null;
  const age = (nowMs - Date.parse(fx.observed_at)) / 1000;
  // An FX observation older than 2× its sampling interval is not used for conversion.
  return age <= 2 * cfg.sampling.fx_s ? fx : { ...fx, quality_state: "STALE" };
}

// job: { endpoint, item?, items?, nameid?, universeCycle? }
export async function runJob({ db, client, job, cfg, env, nowMs, tracked, log = () => {} }) {
  const desc = ENDPOINTS[job.endpoint];
  const nowIso = new Date(nowMs).toISOString();
  if (desc.requiresKey && !(env[desc.requiresKey] ?? "").trim()) {
    recordEventOnce(db, { code: "AUTH_MISSING", source: desc.source, endpoint: job.endpoint, detail: `${desc.requiresKey} not set; ${desc.source} reports NOT_CONFIGURED`, occurred_at: nowIso });
    return { outcome: "NOT_CONFIGURED" };
  }
  const url = desc.scope === "batch" ? desc.url(job.items) : desc.scope === "item" ? desc.url(job.item, job.nameid) : desc.url();
  const raw = await client.get(job.endpoint, url, { headers: { ...(desc.headers ?? {}), ...authHeaders(desc, env) }, items: [...tracked] });
  if (raw.local) return { outcome: "DEFERRED" }; // no request was made

  let records = [];
  let outcome = raw.outcome;
  let parseError = null;
  let redirectError = raw.outcome === "REDIRECT" ? raw.error : null;
  // A followed redirect that ends on a different page is not the requested resource: nothing
  // from that page is stored under this item.
  if (raw.outcome === "OK" && raw.final_url && !samePage(url, raw.final_url)) {
    outcome = "REDIRECT";
    redirectError = `redirected to ${raw.final_url}, which is not the requested page; nothing stored`;
  }
  if (outcome === "OK") {
    const fx = latestUsableFx(db, nowMs, cfg);
    records = desc.normalize(raw.text, {
      item: job.item,
      items: job.items,
      nowMs,
      fx,
      tracked,
      universeCycle: Boolean(job.universeCycle),
      universeFloorCents: cfg.umbra.price_floor_cents,
    });
    const invalid = records.find((r) => r.type === "invalid_body");
    if (records.some((r) => r.type === "rate_limited_body")) {
      outcome = "RATE_LIMITED";
      client.bucketFor(new URL(url).hostname).onRateLimited(nowMs);
    } else if (invalid) {
      outcome = "PARSE_ERROR";
      parseError = invalid;
    }
  }

  const summary = { outcome, stored: 0 };
  tx(db, () => {
    const requestId = insertSourceRequest(db, {
      source: desc.source,
      endpoint: job.endpoint,
      request_params: job.items ? { items: job.items } : job.item ? { item: job.item } : {},
      requested_at: raw.requested_at,
      received_at: raw.received_at,
      http_status: raw.http_status,
      // The request log's outcome set is fixed (append-only audit table): an unfollowed or
      // off-page redirect is stored as HTTP_ERROR with its 3xx status and target in `error`.
      outcome: outcome === "REDIRECT" ? "HTTP_ERROR" : outcome,
      response_hash: raw.response_hash,
      parser_version: desc.parser_version,
      raw_payload: raw.outcome === "OK" ? JSON.stringify({ sanitization: raw.sanitization_notes, body: raw.sanitized }) : null,
      error: parseError ? parseError.reason : (redirectError ?? raw.error),
      synthetic: raw.synthetic,
    });
    const base = {
      request_id: requestId,
      source: desc.source,
      endpoint: job.endpoint,
      observed_at: raw.requested_at, // conservative: the state observed is at least this old
      received_at: raw.received_at,
      response_hash: raw.response_hash,
      parser_version: desc.parser_version,
      synthetic: raw.synthetic,
    };
    for (const r of records) {
      if (r.type === "side_effect" && r.steam_item_nameid) {
        setSteamNameId(db, upsertItem(db, r.item, { nowIso }), r.steam_item_nameid);
      } else if (r.type === "universe") {
        for (const name of r.items) upsertItem(db, name, { universe: true, nowIso });
        db.prepare("INSERT INTO discovery_cycles (started_at, completed_at, universe_size, items_skipped_json, source_request_id) VALUES (?, ?, ?, ?, ?)").run(
          raw.requested_at,
          raw.received_at,
          r.items.length,
          JSON.stringify({ below_price_floor_or_unavailable: r.catalog_size - r.items.length }),
          requestId,
        );
      } else if (r.type === "quality") {
        recordEventOnce(db, { code: r.code, source: desc.source, endpoint: job.endpoint, detail: r.detail, occurred_at: nowIso, synthetic: raw.synthetic, severity: r.severity });
      } else if (r.type === "market" || r.type === "sales" || r.type === "listing") {
        const v = validateRecord(r);
        const itemId = v.item ? upsertItem(db, v.item, { nowIso }) : null;
        if (v.type === "market") {
          insertMarketObservation(db, {
            ...base,
            item_id: itemId,
            kind: v.kind,
            request_params: job.items ? { items: job.items } : job.item ? { item: job.item } : {},
            source_timestamp: v.source_timestamp ?? null,
            price_usd_cents: v.price_usd_cents ?? null,
            listing_supply: v.listing_supply ?? null,
            listing_supply_capped: v.listing_supply_capped === undefined ? null : v.listing_supply_capped ? 1 : 0,
            reference_price_usd_cents: v.reference_price_usd_cents ?? null,
            reference_sample_size: v.reference_sample_size ?? null,
            fx_rate_micros: v.fx_rate_micros ?? null,
            fx_rate_date: v.fx_rate_date ?? null,
            normalized: v.normalized ?? {},
            quality_state: v.quality_state,
            quality_reason: v.quality_reason ?? null,
          });
        } else if (v.type === "sales") {
          insertSalesObservation(db, { ...base, item_id: itemId, window_days: v.window_days, sales_count: v.sales_count, median_usd_cents: v.median_usd_cents ?? null, count_basis: v.count_basis, quality_state: v.quality_state });
        } else if (v.quality_state !== "INVALID") {
          insertListingObservation(db, { ...base, item_id: itemId, listing_id: v.listing_id, price_usd_cents: v.price_usd_cents, float_value: v.float_value, paint_seed: v.paint_seed, paint_index: v.paint_index, stickers_json: JSON.stringify(v.stickers ?? []) });
        }
        summary.stored += 1;
      }
    }
    if (outcome === "OK") resolveOnRecovery(db, { source: desc.source, endpoint: job.endpoint, nowIso, fxResolved: !records.some((r) => r.type === "quality" && r.code === "FX_UNAVAILABLE") });
    else if (outcome === "REDIRECT") {
      recordEventOnce(db, { code: desc.source === "steam" ? "STEAM_REDIRECT" : "HTTP_REDIRECT", source: desc.source, endpoint: job.endpoint, detail: redirectError, occurred_at: nowIso, synthetic: raw.synthetic });
    } else if (outcome === "PARSE_ERROR") {
      recordEventOnce(db, { code: "PARSER_FAILURE", source: desc.source, endpoint: job.endpoint, detail: `${desc.parser_version}: ${parseError.reason}`, occurred_at: nowIso, synthetic: raw.synthetic, severity: parseError.severity });
    } else {
      recordEventOnce(db, { code: outcome === "RATE_LIMITED" ? "RATE_LIMITED" : outcome, source: desc.source, endpoint: job.endpoint, detail: raw.error ?? outcome, occurred_at: nowIso, synthetic: raw.synthetic });
    }
  });
  if (outcome !== "OK") log("warn", `${job.endpoint}${job.item ? ` [${job.item}]` : ""}: ${outcome}${redirectError ? ` (${redirectError})` : ""}`);
  return Object.assign(summary, {
    http_status: raw.http_status ?? null,
    elapsed_ms: raw.elapsed_ms ?? null,
    redirects: raw.redirects ?? [],
    error: parseError ? parseError.reason : (redirectError ?? raw.error ?? null),
    records: countRecords(records),
    notes: [...new Set(records.map((r) => r.quality_reason ?? (r.type === "quality" ? `${r.code}: ${r.detail}` : null)).filter(Boolean))].slice(0, 3),
  });
}

function samePage(requested, final) {
  const norm = (u) => {
    const x = new URL(u);
    return `${x.hostname}${decodeURIComponent(x.pathname).replace(/\/+$/, "").toLowerCase()}`;
  };
  return norm(requested) === norm(final);
}

// What the normalizer produced, by record type and quality state (for diagnostics).
function countRecords(records) {
  const out = {};
  for (const r of records) {
    const k = r.type === "market" || r.type === "sales" || r.type === "listing" ? `${r.type}:${r.kind ?? `${r.window_days ?? ""}d`}:${r.quality_state}` : r.type;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
