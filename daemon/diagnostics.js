// Live diagnostics: one real request per source, through the same rate-limited client, pipeline
// and parsers the collector uses, reported step by step: HTTP status, redirect target, elapsed
// time, parser result, and the exact reason observations were or were not written. Results are
// what the upstream actually returned; nothing is simulated. Requests that the local rate-limit
// budget does not allow are not sent (reported as such), never forced.

import { itemByName } from "./db.js";
import { latestUsableFx, runJob } from "./pipeline.js";
import { ENDPOINTS } from "./sources.js";

export const DIAGNOSTICS_CONTRACT = "diagnostics@1";

const PROBES = [
  { endpoint: "frankfurter_latest", label: "FX rate (Frankfurter/ECB)" },
  { endpoint: "skinport_items", label: "Skinport prices" },
  { endpoint: "steam_listing_page", label: "Steam listing page", item: true },
  { endpoint: "steam_priceoverview", label: "Steam price overview", item: true },
  { endpoint: "csfloat_listings", label: "CSFloat listings", item: true },
];

// Plain-language verdict on what was written, from the pipeline's own summary.
export function writeVerdict(r, desc) {
  const notes = r.notes?.length ? ` (${r.notes.join("; ")})` : "";
  switch (r.outcome) {
    case "OK": {
      if (!r.stored) return { written: false, reason: `the response parsed, but it held no rows for the tracked items${notes}` };
      const usable = Object.entries(r.records ?? {}).filter(([k]) => /:(COMPLETE|PARTIAL)$/.test(k)).reduce((n, [, c]) => n + c, 0);
      return usable
        ? { written: true, reason: `${r.stored} observation(s) written, ${usable} usable (COMPLETE/PARTIAL)` }
        : { written: true, reason: `${r.stored} observation(s) written, none usable${notes}` };
    }
    case "NOT_CONFIGURED":
      return { written: false, reason: `no request sent: ${desc.requiresKey} is not set on the app, so ${desc.source} is NOT_CONFIGURED` };
    case "DEFERRED":
      return { written: false, reason: "no request sent: the local rate-limit budget for this host is used up; the collector will try again when it refills" };
    case "BLOCKED":
      return { written: false, reason: `no request sent: ${r.error}` };
    case "PARSE_ERROR":
      return { written: false, reason: `nothing written: parser ${desc.parser_version} rejected the response: ${r.error}` };
    default:
      return { written: false, reason: `nothing written: ${r.error ?? r.outcome}` };
  }
}

// ctx: { db, client, cfg, env, tracked:Set, scheduler? }. Probes run one after another.
export async function runDiagnostics({ db, client, cfg, env, tracked, scheduler = null, now = () => Date.now() }) {
  const startedAt = new Date(now()).toISOString();
  const item = [...tracked][0] ?? null;
  const probes = [];
  for (const p of PROBES) {
    const desc = ENDPOINTS[p.endpoint];
    const base = { source: desc.source, endpoint: p.endpoint, label: p.label, item: p.item ? item : null, parser_version: desc.parser_version };
    if (p.item && !item) {
      probes.push({ ...base, outcome: "SKIPPED", written: false, reason: "no tracked item to probe: add one to the watchlist" });
      continue;
    }
    if (desc.source === "skinport") {
      const fx = latestUsableFx(db, now(), cfg);
      if (!fx || fx.quality_state !== "COMPLETE") {
        const r = { outcome: "BLOCKED", error: "Skinport prices are EUR and are stored only as USD; there is no usable EUR→USD rate yet (see the FX line)" };
        probes.push({ ...base, ...r, ...writeVerdict(r, desc) });
        continue;
      }
    }
    const job = { endpoint: p.endpoint, ...(p.item ? { item } : {}) };
    if (p.endpoint === "steam_listing_page" && item) {
      const row = itemByName(db, item);
      if (row?.steam_item_nameid) base.steam_item_nameid = row.steam_item_nameid;
    }
    await waitForGroup(scheduler, desc.rateLimit);
    scheduler?.inflight.add(desc.rateLimit);
    let r;
    try {
      // Wait (briefly) for the host's own rate-limit budget instead of skipping the probe:
      // two tokens, so a redirect can be followed. Never bypassed.
      if (!(desc.requiresKey && !(env[desc.requiresKey] ?? "").trim())) await waitForBudget(client, desc.url(item, base.steam_item_nameid), 2);
      r = await runJob({ db, client, job, cfg, env, nowMs: now(), tracked });
    } finally {
      scheduler?.inflight.delete(desc.rateLimit);
    }
    const last = scheduler?.lastResult.get(p.item ? `${p.endpoint}|${item}` : p.endpoint) ?? null;
    probes.push({
      ...base,
      outcome: r.outcome,
      http_status: r.http_status ?? null,
      elapsed_ms: r.elapsed_ms ?? null,
      redirects: r.redirects ?? [],
      parser: r.outcome === "OK" || r.outcome === "PARSE_ERROR" ? { version: desc.parser_version, records: r.records ?? {}, notes: r.notes ?? [] } : null,
      error: r.error ?? null,
      ...writeVerdict(r, desc),
      collector_last_run: last,
    });
  }
  return { contract: DIAGNOSTICS_CONTRACT, started_at: startedAt, finished_at: new Date(now()).toISOString(), item, synthetic: env.ORCASTRIKE_SYNTHETIC === "1", probes };
}

async function waitForBudget(client, url, tokens, maxMs = 20000) {
  const bucket = client.bucketFor(new URL(url).hostname);
  const end = Date.now() + maxMs;
  for (;;) {
    const t = client.now();
    bucket.refill(t);
    if ((t >= bucket.blockedUntil && bucket.tokens >= Math.min(tokens, bucket.capacity)) || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// The scheduler sends one request per rate-limit group at a time; a probe waits its turn.
async function waitForGroup(scheduler, group, maxMs = 15000) {
  const end = Date.now() + maxMs;
  while (scheduler?.inflight.has(group) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}
