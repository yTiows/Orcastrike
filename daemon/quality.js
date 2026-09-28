// Data quality layer: deduplicated quality events and snapshot coverage.
//
// Coverage DOES mean: successful (outcome OK, non-synthetic) requests per source per UTC day,
// divided by the number the scheduler should have achieved (configured intervals, capped by the
// host's rate-limit capacity). It DOES NOT mean the data was correct, fresh at use time, or that
// markets were liquid.

import { recordQualityEvent, resolveQualityEvent } from "./db.js";

export const SEVERITY_BY_CODE = Object.freeze({
  PARSER_FAILURE: "HIGH",
  DB_INTEGRITY: "HIGH",
  FX_UNAVAILABLE: "MEDIUM",
  AUTH_MISSING: "MEDIUM",
  HTTP_ERROR: "MEDIUM",
  TIMEOUT: "MEDIUM",
  NETWORK_ERROR: "MEDIUM",
  COVERAGE_LOW: "MEDIUM",
  RATE_LIMITED: "LOW",
});

export function recordEventOnce(db, { code, source = null, endpoint = null, item_id = null, detail, occurred_at, synthetic = false, severity }) {
  const open = db
    .prepare("SELECT event_id FROM data_quality_events WHERE resolved_at IS NULL AND code = ? AND source IS ? AND endpoint IS ? AND item_id IS ? LIMIT 1")
    .get(code, source, endpoint, item_id);
  if (open) return open.event_id;
  return recordQualityEvent(db, { code, source, endpoint, item_id, detail, occurred_at, synthetic, severity: severity ?? SEVERITY_BY_CODE[code] ?? "MEDIUM" });
}

// A successful request/parse resolves the open transport and parser events of that endpoint.
export function resolveOnRecovery(db, { source, endpoint, nowIso }) {
  const open = db
    .prepare("SELECT event_id FROM data_quality_events WHERE resolved_at IS NULL AND source IS ? AND endpoint IS ? AND code IN ('PARSER_FAILURE','HTTP_ERROR','TIMEOUT','NETWORK_ERROR','RATE_LIMITED','AUTH_MISSING')")
    .all(source, endpoint);
  for (const e of open) resolveQualityEvent(db, e.event_id, `recovered: successful request and parse at ${nowIso}`, nowIso);
  return open.length;
}

function dayBounds(dayIso) {
  const start = Date.parse(`${dayIso}T00:00:00.000Z`);
  return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
}

// plan: { [source]: { demanded_per_day, capacity_per_day } } from the scheduler.
export function coverageForDay(db, dayIso, plan) {
  const [from, to] = dayBounds(dayIso);
  const out = {};
  for (const [source, p] of Object.entries(plan)) {
    const actual = db
      .prepare("SELECT count(*) AS n FROM source_requests WHERE source = ? AND outcome = 'OK' AND synthetic = 0 AND requested_at >= ? AND requested_at < ?")
      .get(source, from, to).n;
    const expected = Math.min(p.demanded_per_day, p.capacity_per_day);
    out[source] = {
      day: dayIso,
      actual,
      expected,
      coverage_pct_x100: expected > 0 ? Math.min(10000, Math.floor((actual * 10000) / expected)) : null,
      basis: "OK non-synthetic requests / min(configured demand, rate-limit capacity)",
    };
  }
  return out;
}

export function lastCompleteDays(nowMs, n) {
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) => new Date(today - (i + 1) * 86400000).toISOString().slice(0, 10)).reverse();
}
