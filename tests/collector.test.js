// Collector regressions found on a real Windows machine (2026-09-28): the daemon answered
// "online" but no quote, history or snapshot ever arrived. Causes, each pinned here:
//   1. a UMBRA engine cycle ran synchronously for 70–90 s (full-table scan per evaluation) and
//      blocked HTTP and the sampling scheduler;
//   2. Steam listing pages answered 302; failing pages were retried every minute for every item
//      and used Steam's whole request budget;
//   3. Skinport ran before the first FX rate existed, stored nothing usable, and its
//      FX_UNAVAILABLE event never resolved;
//   4. coverage showed 0.0% for days before the app ever ran.
// Upstream responses here are SYNTHETIC (hand-written in the documented shapes), flagged
// synthetic, and never evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { insertMarketObservation, insertSourceRequest, openDb, putSettings, upsertItem } from "../daemon/db.js";
import { Engine } from "../daemon/engine.js";
import { redirectDecision, UpstreamClient } from "../daemon/http-client.js";
import { runJob } from "../daemon/pipeline.js";
import { coverageForDay } from "../daemon/quality.js";
import { planJobs, Scheduler } from "../daemon/scheduler.js";
import { effectiveConfig } from "../daemon/main.js";
import { RESEARCH_DEFAULTS } from "../config/settings-schema.js";

const SYN_ENV = { ORCASTRIKE_SYNTHETIC: "1", ORCASTRIKE_UPSTREAM_OVERRIDE: "http://127.0.0.1:9" };
const freshDb = () => openDb(join(mkdtempSync(join(tmpdir(), "orca-col-")), "t.sqlite"));
const ITEM = "AK-47 | Redline (Field-Tested)";

// fetch double: routes by the upstream host/path embedded in the loopback override URL.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    for (const [prefix, respond] of routes) if (u.pathname.startsWith(prefix)) return respond(u);
    return new Response("{}", { status: 404 });
  };
  return { impl, calls };
}

test("regression: a UMBRA-sized engine cycle yields to the event loop and uses the pair index", async () => {
  const db = freshDb();
  const nowIso = new Date().toISOString();
  putSettings(db, { "umbra.active": true, "umbra.bankroll_cents": 10000, "umbra.override_unproven": true }, "test", nowIso);
  const req = insertSourceRequest(db, { source: "skinport", endpoint: "skinport_items", requested_at: nowIso, outcome: "OK", synthetic: true });
  for (let i = 0; i < 1500; i += 1) {
    const id = upsertItem(db, `Synthetic Item ${i}`, { universe: true, nowIso });
    insertMarketObservation(db, {
      request_id: req, item_id: id, source: "skinport", endpoint: "skinport_items", kind: "quote", request_params: {}, observed_at: nowIso, received_at: nowIso,
      response_hash: "h", parser_version: "skinport_items@1", price_usd_cents: 1500 + i, normalized: {}, quality_state: "COMPLETE", synthetic: true,
    });
  }
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT eligibility, computed_at FROM opportunities WHERE item_id = 1 AND buy_source = 'a' AND sell_source = 'b' AND strategy_version = 's' ORDER BY opportunity_id DESC LIMIT 1").all();
  assert.match(plan.map((r) => r.detail).join(" "), /USING (COVERING )?INDEX opportunities_pair/);

  const engine = new Engine({ db, getCfg: () => effectiveConfig(db).cfg, env: SYN_ENV });
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 5);
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const cycles = [];
  engine.onCycle((c) => cycles.push(c.evaluated));
  const [a, b] = await Promise.all([engine.cycleAsync(), engine.cycleAsync()]);
  h.disable();
  clearInterval(ticker);
  assert.equal(a.mode, "UMBRA");
  assert.ok(a.evaluated >= 1500 * 4, `evaluated ${a.evaluated}`);
  assert.equal(b, null, "a second cycle never overlaps a running one");
  assert.deepEqual(cycles, [a.evaluated], "listeners run once, after the cycle's writes are committed");
  assert.ok(ticks > 0, "timers ran during the cycle");
  assert.ok(h.max / 1e6 < 500, `event loop blocked for ${(h.max / 1e6).toFixed(0)} ms`);
});

test("redirects: only same-host pages that are not sign-in, age-check or consent pages are followed", () => {
  const from = "https://steamcommunity.com/market/listings/730/AK-47";
  assert.equal(redirectDecision(from, "/market/listings/730/AK-47/").follow, true);
  assert.equal(redirectDecision(from, "https://steamcommunity.com/login/home/?goto=market%2Flistings").follow, false);
  assert.equal(redirectDecision(from, "https://steamcommunity.com/agecheck/app/730").follow, false);
  assert.equal(redirectDecision(from, "https://store.steampowered.com/").follow, false);
  assert.equal(redirectDecision(from, "http://steamcommunity.com/market/").follow, false);
  assert.equal(redirectDecision(from, null).follow, false);
});

test("regression: a Steam 302 to a sign-in page is not followed; STEAM_REDIRECT names the target; nothing stored", async () => {
  const db = freshDb();
  const target = "https://steamcommunity.com/login/home/?goto=market%2Flistings%2F730%2FAK-47";
  const f = fakeFetch([["/steamcommunity.com/market/listings/", () => new Response(null, { status: 302, headers: { location: target } })]]);
  const logs = [];
  const client = new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env: SYN_ENV, fetchImpl: f.impl, log: (lvl, msg) => logs.push(msg) });
  const r = await runJob({ db, client, job: { endpoint: "steam_listing_page", item: ITEM }, cfg: RESEARCH_DEFAULTS, env: SYN_ENV, nowMs: Date.now(), tracked: new Set([ITEM]) });
  assert.equal(r.outcome, "REDIRECT");
  assert.equal(r.http_status, 302);
  assert.equal(r.redirects[0].location, target);
  assert.equal(f.calls.length, 1, "a sign-in redirect is never followed");
  assert.ok(logs.some((m) => m.includes(target)), "the Location header is logged");
  const ev = db.prepare("SELECT code, detail FROM data_quality_events WHERE resolved_at IS NULL").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].code, "STEAM_REDIRECT");
  assert.ok(ev[0].detail.includes(target));
  const row = db.prepare("SELECT outcome, http_status, error FROM source_requests").get();
  assert.deepEqual([row.outcome, row.http_status], ["HTTP_ERROR", 302]);
  assert.ok(row.error.includes(target));
  assert.equal(db.prepare("SELECT count(*) AS n FROM market_observations").get().n, 0);
});

test("a same-host redirect is followed once (each hop costs a token); landing on another page stores nothing", async () => {
  const db = freshDb();
  const f = fakeFetch([
    ["/steamcommunity.com/market/listings/", () => new Response(null, { status: 302, headers: { location: "https://steamcommunity.com/market/" } })],
    ["/steamcommunity.com/market/", () => new Response("<html>market home</html>", { status: 200 })],
  ]);
  const client = new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env: SYN_ENV, fetchImpl: f.impl });
  const tokensBefore = client.bucketFor("steamcommunity.com").tokens;
  const r = await runJob({ db, client, job: { endpoint: "steam_listing_page", item: ITEM }, cfg: RESEARCH_DEFAULTS, env: SYN_ENV, nowMs: Date.now(), tracked: new Set([ITEM]) });
  assert.equal(f.calls.length, 2);
  assert.ok(tokensBefore - client.bucketFor("steamcommunity.com").tokens >= 1.9, "the followed hop took its own token");
  assert.equal(r.outcome, "REDIRECT");
  assert.match(r.error, /not the requested page/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM market_observations").get().n, 0);
  assert.deepEqual(db.prepare("SELECT code FROM data_quality_events").all().map((e) => e.code), ["STEAM_REDIRECT"], "not reported as a parser failure");
});

test("a redirect to the same listing (canonical path) is followed and parsed", async () => {
  const db = freshDb();
  const page = '<script>var line1=[["Sep 01 2026 01: +0",20.5,"12"]];Market_LoadOrderSpread( 555 );</script>';
  const f = fakeFetch([
    ["/steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)/", () => new Response(page, { status: 200 })],
    ["/steamcommunity.com/market/listings/", () => new Response(null, { status: 301, headers: { location: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(ITEM)}/` } })],
  ]);
  const client = new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env: SYN_ENV, fetchImpl: f.impl });
  const r = await runJob({ db, client, job: { endpoint: "steam_listing_page", item: ITEM }, cfg: RESEARCH_DEFAULTS, env: SYN_ENV, nowMs: Date.now(), tracked: new Set([ITEM]) });
  assert.equal(r.outcome, "OK");
  assert.equal(db.prepare("SELECT steam_item_nameid FROM items WHERE market_hash_name = ?").get(ITEM).steam_item_nameid, "555");
});

test("regression: a failing urgent job backs off exponentially instead of retrying every minute", () => {
  const s = new Scheduler({ db: null, client: null, getCfg: () => RESEARCH_DEFAULTS, getSettings: () => ({}), env: {}, log: () => {} });
  const job = { key: "steam_listing_page|X", urgent: true, interval_s: 21600 };
  const delays = [0, 1, 2, 3, 4, 12].map((n) => (s.failures.set(job.key, n), s.retryDelayMs(job) / 60000));
  assert.deepEqual(delays, [1, 1, 2, 4, 8, 360], "1, 1, 2, 4, 8 … minutes, capped at the job interval");
  assert.equal(s.retryDelayMs({ key: "k", urgent: false, interval_s: 60 }), 60000);
});

test("regression: Skinport waits for a usable FX rate, then stores USD quotes; FX_UNAVAILABLE resolves", async () => {
  const db = freshDb();
  const nowMs = Date.now();
  const tracked = new Set([ITEM]);
  const blocked = planJobs({ db, cfg: RESEARCH_DEFAULTS, env: {}, tracked, nowMs }).filter((j) => j.endpoint.startsWith("skinport"));
  assert.ok(blocked.length > 0 && blocked.every((j) => j.blocked), "no Skinport request before FX");
  const s = new Scheduler({ db, client: null, getCfg: () => RESEARCH_DEFAULTS, getSettings: () => ({}), env: {}, log: () => {} });
  assert.equal(s.due(blocked, nowMs).length, 0);

  // An FX-less Skinport run (e.g. FX failed earlier) records FX_UNAVAILABLE…
  const f = fakeFetch([
    ["/api.frankfurter.dev/", () => new Response(JSON.stringify({ amount: 1, base: "EUR", date: new Date(nowMs).toISOString().slice(0, 10), rates: { USD: 1.1 } }), { status: 200 })],
    ["/api.skinport.com/v1/items", () => new Response(JSON.stringify([{ market_hash_name: ITEM, currency: "EUR", min_price: 20, quantity: 9 }]), { status: 200 })],
  ]);
  const client = new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env: SYN_ENV, fetchImpl: f.impl });
  const run = (endpoint) => runJob({ db, client, job: { endpoint }, cfg: RESEARCH_DEFAULTS, env: SYN_ENV, nowMs, tracked });
  await run("skinport_items");
  assert.equal(db.prepare("SELECT count(*) AS n FROM data_quality_events WHERE code = 'FX_UNAVAILABLE' AND resolved_at IS NULL").get().n, 1);
  // …then FX arrives: Skinport is due again, stores a USD quote, and the event resolves.
  assert.equal((await run("frankfurter_latest")).outcome, "OK");
  assert.ok(planJobs({ db, cfg: RESEARCH_DEFAULTS, env: {}, tracked, nowMs }).filter((j) => j.endpoint.startsWith("skinport")).every((j) => !j.blocked));
  const r = await run("skinport_items");
  assert.equal(r.outcome, "OK");
  assert.equal(r.records["market:quote:COMPLETE"], 1);
  const q = db.prepare("SELECT price_usd_cents, quality_state FROM market_observations WHERE source = 'skinport' AND quality_state = 'COMPLETE'").get();
  assert.deepEqual([q.price_usd_cents, q.quality_state], [2200, "COMPLETE"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM data_quality_events WHERE code = 'FX_UNAVAILABLE' AND resolved_at IS NULL").get().n, 0);
});

test("regression: coverage never shows 0% for days the app wasn't running; the first day and today are prorated", () => {
  const db = freshDb();
  // Test rows marked synthetic = 0 only because coverage counts nothing else; temp database.
  const plan = { fx: { demanded_per_day: 24, capacity_per_day: 14400 } };
  const first = Date.parse("2026-09-28T12:00:00.000Z");
  for (let h = 0; h < 6; h += 1) insertSourceRequest(db, { source: "fx", endpoint: "frankfurter_latest", requested_at: new Date(first + h * 3600000).toISOString(), outcome: "OK", synthetic: false });
  const before = coverageForDay(db, "2026-09-27", plan).fx;
  assert.equal(before.state, "NOT_RUNNING");
  assert.equal(before.coverage_pct_x100, null);
  const firstDay = coverageForDay(db, "2026-09-28", plan).fx;
  assert.equal(firstDay.expected, 12, "prorated to the 12 h the app was running");
  assert.equal(firstDay.actual, 6);
  assert.equal(firstDay.state, "PARTIAL_DAY");
  const today = coverageForDay(db, "2026-09-28", plan, { nowMs: first + 6 * 3600000 }).fx;
  assert.equal(today.expected, 6);
  assert.equal(today.coverage_pct_x100, 10000);
  assert.equal(coverageForDay(freshDb(), "2026-09-28", plan).fx.state, "NOT_RUNNING");
});

test("diagnostics: one real request per source, reporting status, redirect target, elapsed time, parser result and the write verdict", async () => {
  const { runDiagnostics } = await import("../daemon/diagnostics.js");
  const { probeLine } = await import("../scripts/orca.mjs");
  const db = freshDb();
  const login = "https://steamcommunity.com/login/home/?goto=market";
  const f = fakeFetch([
    ["/api.frankfurter.dev/", () => new Response(JSON.stringify({ amount: 1, base: "EUR", date: new Date().toISOString().slice(0, 10), rates: { USD: 1.1 } }), { status: 200 })],
    ["/api.skinport.com/v1/items", () => new Response(JSON.stringify([{ market_hash_name: ITEM, currency: "EUR", min_price: 20, quantity: 9 }]), { status: 200 })],
    ["/steamcommunity.com/market/listings/", () => new Response(null, { status: 302, headers: { location: login } })],
    ["/steamcommunity.com/market/priceoverview/", () => new Response(JSON.stringify({ success: true, lowest_price: "$21.00", volume: "150", median_price: "$20.50" }), { status: 200 })],
  ]);
  const client = new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env: SYN_ENV, fetchImpl: f.impl });
  const report = await runDiagnostics({ db, client, cfg: RESEARCH_DEFAULTS, env: SYN_ENV, tracked: new Set([ITEM]) });
  const by = Object.fromEntries(report.probes.map((p) => [p.endpoint, p]));
  assert.equal(report.synthetic, true);
  assert.equal(by.frankfurter_latest.outcome, "OK");
  assert.equal(by.frankfurter_latest.written, true);
  assert.ok(Number.isFinite(by.frankfurter_latest.elapsed_ms));
  assert.equal(by.skinport_items.outcome, "OK", "Skinport ran after FX, so it had a rate");
  assert.match(by.skinport_items.reason, /1 usable/);
  assert.equal(by.steam_listing_page.outcome, "REDIRECT");
  assert.equal(by.steam_listing_page.http_status, 302);
  assert.equal(by.steam_listing_page.redirects[0].location, login);
  assert.equal(by.steam_listing_page.written, false);
  assert.match(by.steam_listing_page.reason, /nothing written: HTTP 302 redirect to https:\/\/steamcommunity\.com\/login/);
  assert.equal(by.steam_priceoverview.outcome, "OK");
  assert.equal(by.csfloat_listings.outcome, "NOT_CONFIGURED");
  assert.match(by.csfloat_listings.reason, /no request sent/);
  assert.equal(f.calls.filter((c) => c.includes("csfloat")).length, 0, "no key → no request");
  const line = probeLine(by.steam_listing_page);
  assert.equal(line.status, "WARN");
  assert.match(line.detail, /HTTP 302 · → https:\/\/steamcommunity\.com\/login\/home\/\?goto=market \(not followed: sign-in, age-check or consent page\) · \d+ ms/);
  assert.equal(probeLine(by.frankfurter_latest).status, "OK");
  assert.equal(probeLine(by.csfloat_listings).status, "INFO");
});

test("regression: a watchlist item with no data yet is not called untracked; missing prices state the collector's last answer", async () => {
  const { v1Quote } = await import("../daemon/api.js");
  const db = freshDb();
  const nowIso = new Date().toISOString();
  putSettings(db, { "watchlist.items": [ITEM] }, "test", nowIso);
  const ctx = { db, env: {}, parserStatus: () => ({}), getCfg: () => RESEARCH_DEFAULTS };
  assert.equal(v1Quote(ctx, "steam", "Some Other Item").reason, "item is not on the app's watchlist (add it in Markets → Watchlist)");
  assert.equal(v1Quote(ctx, "steam", ITEM).reason, "on the watchlist; nothing stored for it yet; the collector has not sent steam_listing_page yet");
  insertSourceRequest(db, {
    source: "steam", endpoint: "steam_listing_page", request_params: { item: ITEM }, requested_at: nowIso, http_status: 302, outcome: "HTTP_ERROR", synthetic: true,
    error: "HTTP 302 redirect to https://steamcommunity.com/login/home/: not followed (sign-in, age-check or consent page)",
  });
  upsertItem(db, ITEM, { nowIso });
  const q = v1Quote(ctx, "steam", ITEM);
  assert.equal(q.state, "UNAVAILABLE");
  assert.match(q.reason, /^Steam prices need the item's id from its Steam listing page.*HTTP_ERROR \(HTTP 302\): HTTP 302 redirect to https:\/\/steamcommunity\.com\/login\/home\//);
});
