// Daemon data layer: storage invariants, pipeline stages, rate limiting, quality events.
// Upstream responses here are SYNTHETIC (hand-written in the documented shapes) and are used
// only to exercise code paths; they are flagged synthetic and never count as evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMarketObservation, insertSourceRequest, migrate, openDb, purgeRawPayloads, tx, upsertItem } from "../daemon/db.js";
import { TokenBucket, UpstreamClient, resolveUpstream } from "../daemon/http-client.js";
import { runJob } from "../daemon/pipeline.js";
import { capacityPlan, planJobs } from "../daemon/scheduler.js";
import { redact } from "../daemon/redact.js";
import { RESEARCH_DEFAULTS } from "../config/settings-schema.js";
import { startDaemon } from "../daemon/main.js";
import { freePort } from "./helpers/synthetic-stack.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "orca-")), "t.sqlite"));
}

function obs(db, over = {}) {
  const req = insertSourceRequest(db, { source: "csfloat", endpoint: "csfloat_listings", requested_at: iso(NOW), outcome: "OK", response_hash: "h", raw_payload: "{}", synthetic: true });
  const itemId = upsertItem(db, "A", { nowIso: iso(NOW) });
  return insertMarketObservation(db, {
    request_id: req, item_id: itemId, source: "csfloat", endpoint: "csfloat_listings", kind: "quote", request_params: {}, observed_at: iso(NOW), received_at: iso(NOW),
    response_hash: "h", parser_version: "csfloat_listings@1", price_usd_cents: 1000, normalized: {}, quality_state: "COMPLETE", synthetic: true, ...over,
  });
}

test("migrations are versioned and idempotent", () => {
  const db = freshDb();
  assert.equal(migrate(db), 2);
  assert.equal(migrate(db), 2);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ["items", "source_requests", "market_observations", "listing_observations", "sales_observations", "opportunities", "paper_trades", "real_trades", "data_quality_events", "parser_versions", "fee_model_versions", "strategy_versions"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test("observations are append-only: UPDATE and DELETE abort", () => {
  const db = freshDb();
  const id = obs(db);
  assert.throws(() => db.prepare("UPDATE market_observations SET price_usd_cents = 1 WHERE observation_id = ?").run(id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM market_observations WHERE observation_id = ?").run(id), /append-only/);
  assert.throws(() => db.prepare("UPDATE source_requests SET outcome = 'HTTP_ERROR'").run(), /only purging/);
  assert.throws(() => db.prepare("DELETE FROM source_requests").run(), /append-only/);
});

test("raw payload retention purges payloads but keeps hashes and rows", () => {
  const db = freshDb();
  obs(db);
  assert.equal(purgeRawPayloads(db, 30, NOW + 29 * 86400000), 0);
  assert.equal(purgeRawPayloads(db, 30, NOW + 31 * 86400000), 1);
  const r = db.prepare("SELECT raw_payload, response_hash, raw_payload_purged_at FROM source_requests").get();
  assert.equal(r.raw_payload, null);
  assert.equal(r.response_hash, "h");
  assert.ok(r.raw_payload_purged_at);
  assert.equal(purgeRawPayloads(db, 30, NOW + 40 * 86400000), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM market_observations").get().n, 1);
});

test("paper trades may only transition OPEN → CLOSED/VOID once", () => {
  const db = freshDb();
  const itemId = upsertItem(db, "A", { nowIso: iso(NOW) });
  db.prepare(
    `INSERT INTO opportunities (computed_at, item_id, buy_source, sell_source, eligibility, blocked_reasons_json, quality_state, quality_reason, hold_days, contributing_observations_json, trace_json, strategy_version, signal_version, fee_model_version, parser_versions_json)
     VALUES (?, ?, 'steam', 'csfloat', 'ELIGIBLE', '[]', 'COMPLETE', 'ok', 7, '[]', '[]', 's', 'sig', 'f', '[]')`,
  ).run(iso(NOW), itemId);
  db.prepare(
    `INSERT INTO paper_trades (opportunity_id, item_id, buy_source, sell_source, quantity, opened_at, planned_close_at, hold_days, entry_cost_cents, entry_hold_adverse_move_ppm, entry_reversal_reserve_cents, status, strategy_version, signal_version, fee_model_version, parser_version)
     VALUES (1, ?, 'steam', 'csfloat', 1, ?, ?, 7, 1000, -20000, 10, 'OPEN', 's', 'sig', 'f', 'p')`,
  ).run(itemId, iso(NOW), iso(NOW + 7 * 86400000));
  assert.throws(() => db.prepare("UPDATE paper_trades SET entry_cost_cents = 1").run(), /only OPEN/);
  db.prepare("UPDATE paper_trades SET status = 'CLOSED', closed_at = ?, paper_net_profit_cents = 5").run(iso(NOW));
  assert.throws(() => db.prepare("UPDATE paper_trades SET status = 'VOID'").run(), /only OPEN/);
  assert.throws(() => db.prepare("DELETE FROM paper_trades").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE opportunities SET eligibility = 'X'").run(), /append-only/);
});

test("token bucket: capacity, refill, 429 backoff", () => {
  const b = new TokenBucket({ capacity: 2, per_seconds: 60 }, 0);
  assert.equal(b.tryTake(0), true);
  assert.equal(b.tryTake(0), true);
  assert.equal(b.tryTake(0), false);
  assert.equal(b.tryTake(30000), true); // 1 token per 30s
  b.onRateLimited(30000);
  assert.equal(b.tryTake(30000 + 59999), false);
  assert.equal(b.tryTake(30000 + 3600000), true);
});

test("upstream override is refused unless synthetic and loopback", () => {
  assert.throws(() => resolveUpstream("https://csfloat.com/x", { ORCASTRIKE_UPSTREAM_OVERRIDE: "http://127.0.0.1:1" }));
  assert.throws(() => resolveUpstream("https://csfloat.com/x", { ORCASTRIKE_UPSTREAM_OVERRIDE: "http://evil.example", ORCASTRIKE_SYNTHETIC: "1" }));
  const r = resolveUpstream("https://csfloat.com/api/v1/listings?x=1", { ORCASTRIKE_UPSTREAM_OVERRIDE: "http://127.0.0.1:9", ORCASTRIKE_SYNTHETIC: "1" });
  assert.equal(r.url, "http://127.0.0.1:9/csfloat.com/api/v1/listings?x=1");
  assert.equal(r.synthetic, true);
});

function mockClient(routes, env = { ORCASTRIKE_UPSTREAM_OVERRIDE: "http://127.0.0.1:9", ORCASTRIKE_SYNTHETIC: "1" }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = routes(url);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { client: new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env, fetchImpl, now: () => NOW }), calls, env };
}

const listing = (id, price, name = "A") => ({ id: String(id), type: "buy_now", state: "listed", price, item: { market_hash_name: name, float_value: 0.25, paint_seed: 7, paint_index: 12 }, reference: { predicted_price: 1500, base_price: 1400, quantity: 42 }, seller: { steam_id: "7656" } });

test("pipeline: CSFloat listings → quote, depth, reference, listings; auth header used, never stored", async () => {
  const db = freshDb();
  const secretEnv = { CSFLOAT_API_KEY: "TEST_ONLY_fake_key_123456" };
  const { client, calls, env } = mockClient(() => ({ body: [listing(1, 1000), listing(2, 1050), listing(3, 1100), listing(4, 1200)] }));
  const r = await runJob({ db, client, job: { endpoint: "csfloat_listings", item: "A" }, cfg: RESEARCH_DEFAULTS, env: { ...env, ...secretEnv }, nowMs: NOW, tracked: new Set(["A"]) });
  assert.equal(r.outcome, "OK");
  assert.equal(calls[0].headers.authorization, secretEnv.CSFLOAT_API_KEY);
  const rows = db.prepare("SELECT kind, price_usd_cents, listing_supply, reference_price_usd_cents, reference_sample_size, quality_state, synthetic FROM market_observations ORDER BY observation_id").all();
  assert.deepEqual(rows.map((x) => x.kind), ["quote", "depth", "reference"]);
  assert.equal(rows[0].price_usd_cents, 1000);
  assert.equal(rows[1].listing_supply, 3);
  assert.equal(rows[2].reference_price_usd_cents, 1500);
  assert.equal(rows[2].reference_sample_size, 42);
  assert.ok(rows.every((x) => x.synthetic === 1));
  assert.equal(db.prepare("SELECT count(*) AS n FROM listing_observations").get().n, 4);
  const stored = JSON.stringify(db.prepare("SELECT * FROM source_requests").all());
  assert.ok(!stored.includes(secretEnv.CSFLOAT_API_KEY), "key must never be stored");
  assert.ok(!stored.includes("7656"), "seller identity must be sanitized");
});

test("pipeline: malformed body → PARSE_ERROR + HIGH quality event; recovery resolves it", async () => {
  const db = freshDb();
  let body = { unexpected: true };
  const { client, env } = mockClient(() => ({ body }));
  await runJob({ db, client, job: { endpoint: "frankfurter_latest" }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW, tracked: new Set() });
  const ev = db.prepare("SELECT severity, code, resolved_at FROM data_quality_events").get();
  assert.deepEqual({ severity: ev.severity, code: ev.code, resolved: ev.resolved_at }, { severity: "HIGH", code: "PARSER_FAILURE", resolved: null });
  assert.equal(db.prepare("SELECT outcome FROM source_requests").get().outcome, "PARSE_ERROR");
  body = { amount: 1, base: "EUR", date: "2026-09-25", rates: { USD: 1.0834 } };
  await runJob({ db, client, job: { endpoint: "frankfurter_latest" }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW + 1000, tracked: new Set() });
  assert.ok(db.prepare("SELECT resolved_at FROM data_quality_events").get().resolved_at);
  assert.equal(db.prepare("SELECT fx_rate_micros FROM market_observations WHERE kind = 'fx'").get().fx_rate_micros, 1083400);
});

test("pipeline: upstream 429 → RATE_LIMITED, host backoff, no retry", async () => {
  const db = freshDb();
  const { client, calls, env } = mockClient(() => ({ status: 429, body: "slow down" }));
  const r = await runJob({ db, client, job: { endpoint: "steam_priceoverview", item: "A" }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW, tracked: new Set(["A"]) });
  assert.equal(r.outcome, "RATE_LIMITED");
  assert.equal(calls.length, 1);
  const again = await runJob({ db, client, job: { endpoint: "steam_priceoverview", item: "A" }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW, tracked: new Set(["A"]) });
  assert.equal(again.outcome, "DEFERRED");
  assert.equal(calls.length, 1);
  assert.equal(db.prepare("SELECT code, severity FROM data_quality_events").get().code, "RATE_LIMITED");
});

test("pipeline: network down, timeout, missing key and 401 each store no observation and record why", async () => {
  const env = { ORCASTRIKE_UPSTREAM_OVERRIDE: "http://127.0.0.1:9", ORCASTRIKE_SYNTHETIC: "1" };
  const failing = (err) => new UpstreamClient({ rateLimits: RESEARCH_DEFAULTS.ratelimit, env, fetchImpl: async () => { throw err; }, now: () => NOW });
  const job = { endpoint: "steam_priceoverview", item: "A" };
  const run = (db, client, e = env, j = job) => runJob({ db, client, job: j, cfg: RESEARCH_DEFAULTS, env: e, nowMs: NOW, tracked: new Set(["A"]) });
  const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM market_observations").get().n;

  let db = freshDb();
  assert.equal((await run(db, failing(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })))).outcome, "NETWORK_ERROR");
  assert.equal(count(db), 0);
  assert.equal(db.prepare("SELECT code FROM data_quality_events").get().code, "NETWORK_ERROR");

  db = freshDb();
  assert.equal((await run(db, failing(Object.assign(new Error("aborted"), { name: "AbortError" })))).outcome, "TIMEOUT");
  assert.equal(count(db), 0);
  assert.deepEqual({ ...db.prepare("SELECT outcome, error FROM source_requests").get() }, { outcome: "TIMEOUT", error: "timeout after 8s" });

  db = freshDb();
  const { client, calls } = mockClient(() => ({ body: [] }));
  const nk = await run(db, client, env, { endpoint: "csfloat_listings", item: "A" });
  assert.equal(nk.outcome, "NOT_CONFIGURED");
  assert.equal(calls.length, 0, "no request without a key");
  assert.equal(db.prepare("SELECT code FROM data_quality_events").get().code, "AUTH_MISSING");

  db = freshDb();
  const unauth = mockClient(() => ({ status: 401, body: { error: "bad key" } }));
  const r401 = await run(db, unauth.client, { ...env, CSFLOAT_API_KEY: "TEST_ONLY_wrong" }, { endpoint: "csfloat_listings", item: "A" });
  assert.equal(r401.outcome, "HTTP_ERROR");
  assert.equal(count(db), 0);
});

test("pipeline: Skinport without fresh FX stores no price and never EUR", async () => {
  const db = freshDb();
  const { client, env } = mockClient(() => ({ body: [{ market_hash_name: "A", currency: "EUR", min_price: 10.0, quantity: 5 }] }));
  await runJob({ db, client, job: { endpoint: "skinport_items" }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW, tracked: new Set(["A"]) });
  const q = db.prepare("SELECT price_usd_cents, quality_state, quality_reason FROM market_observations WHERE kind = 'quote'").get();
  assert.equal(q.price_usd_cents, null);
  assert.equal(q.quality_state, "INSUFFICIENT");
  assert.match(q.quality_reason, /EUR is never stored/);
  assert.equal(db.prepare("SELECT code FROM data_quality_events").get().code, "FX_UNAVAILABLE");
});

test("pipeline: Skinport with FX converts at ingestion and builds the universe (≥ $10 floor)", async () => {
  const db = freshDb();
  const fxClient = mockClient(() => ({ body: { amount: 1, base: "EUR", date: "2026-09-27", rates: { USD: 1.1 } } }));
  await runJob({ db, client: fxClient.client, job: { endpoint: "frankfurter_latest" }, cfg: RESEARCH_DEFAULTS, env: fxClient.env, nowMs: NOW, tracked: new Set() });
  const { client, env } = mockClient(() => ({
    body: [
      { market_hash_name: "A", currency: "EUR", min_price: 10.0, quantity: 5 },
      { market_hash_name: "Cheap", currency: "EUR", min_price: 1.0, quantity: 50 },
      { market_hash_name: "Pricey", currency: "EUR", min_price: 250.5, quantity: 2 },
    ],
  }));
  await runJob({ db, client, job: { endpoint: "skinport_items", universeCycle: true }, cfg: RESEARCH_DEFAULTS, env, nowMs: NOW + 1000, tracked: new Set(["A"]) });
  const a = db.prepare("SELECT o.price_usd_cents, o.fx_rate_micros FROM market_observations o JOIN items i USING (item_id) WHERE i.market_hash_name = 'A'").get();
  assert.equal(a.price_usd_cents, 1100);
  assert.equal(a.fx_rate_micros, 1100000);
  const universe = db.prepare("SELECT market_hash_name FROM items WHERE in_universe = 1 ORDER BY market_hash_name").all().map((r) => r.market_hash_name);
  assert.deepEqual(universe, ["A", "Pricey"]);
  const cycle = db.prepare("SELECT universe_size, items_skipped_json FROM discovery_cycles").get();
  assert.equal(cycle.universe_size, 2);
  assert.deepEqual(JSON.parse(cycle.items_skipped_json), { below_price_floor_or_unavailable: 1 });
});

test("scheduler plan: capacity vs demand is reported, infeasible configs are visible", () => {
  const db = freshDb();
  const tracked = new Set(Array.from({ length: 50 }, (_, i) => `I${i}`));
  // Without item_nameids: listing page (4/day) + priceoverview (144/day) per item = 7400/day.
  const before = capacityPlan(planJobs({ db, cfg: RESEARCH_DEFAULTS, env: {}, tracked, nowMs: NOW }), RESEARCH_DEFAULTS);
  assert.equal(before.steam.capacity_per_day, 14400); // 10 per 60s
  assert.equal(before.steam.demanded_per_day, 7400);
  assert.equal(before.steam.feasible, true);
  // With item_nameids the 60s histogram adds 1440/day per item → infeasible, and reported so.
  for (const name of tracked) db.prepare("INSERT INTO items (market_hash_name, first_seen_at, steam_item_nameid) VALUES (?, ?, '1')").run(name, iso(NOW));
  const after = capacityPlan(planJobs({ db, cfg: RESEARCH_DEFAULTS, env: {}, tracked, nowMs: NOW }), RESEARCH_DEFAULTS);
  assert.equal(after.steam.demanded_per_day, 50 * (4 + 1440 + 144));
  assert.equal(after.steam.feasible, false);
  assert.equal(after.csfloat, undefined); // no key → only the auth check job, excluded from the plan
});

test("redaction scrubs env secrets and credential shapes", () => {
  const env = { CSFLOAT_API_KEY: "abcdef123456" };
  assert.equal(redact("key=abcdef123456 in url", env).includes("abcdef123456"), false);
  assert.equal(redact('{"authorization":"zzzzzzzz"}', {}).includes("zzzzzzzz"), false);
  assert.equal(redact("Bearer abc.def.ghi-123", {}), "Bearer [REDACTED]");
});

test("transactions roll back on error", () => {
  const db = freshDb();
  assert.throws(() => tx(db, () => {
    upsertItem(db, "Z", { nowIso: iso(NOW) });
    throw new Error("boom");
  }));
  assert.equal(db.prepare("SELECT count(*) AS n FROM items").get().n, 0);
});

test("unreadable database file: daemon refuses to start, prints recovery, modifies nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-corrupt-"));
  const bytes = randomBytes(8192);
  writeFileSync(join(dir, "orcastrike.sqlite"), bytes);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "daemon/main.js"], {
    env: { PATH: process.env.PATH, ORCASTRIKE_DATA_DIR: dir, ORCASTRIKE_PORT: "0" },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unreadable .*Nothing was modified.*Recovery/);
  assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
  assert.ok(readFileSync(join(dir, "orcastrike.sqlite")).equals(bytes), "file untouched");
});

test("damaged database: integrity check fails closed → DEGRADED, no sampling, writes refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-degraded-"));
  const path = join(dir, "orcastrike.sqlite");
  const db = openDb(path);
  db.exec("PRAGMA journal_mode = DELETE");
  for (let i = 0; i < 2000; i += 1) upsertItem(db, `Item ${i} ${"x".repeat(50)}`, { nowIso: iso(NOW) });
  db.close();
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.alloc(200, 0xff), 0, 200, Math.floor(statSync(path).size * 0.7));
  closeSync(fd);
  const port = await freePort();
  const logs = [];
  const d = await startDaemon({ env: { PATH: process.env.PATH }, port, dataDir: dir, startScheduler: false, log: (level, msg) => logs.push(`${level} ${msg}`) });
  try {
    const base = `http://127.0.0.1:${port}`;
    const h = await (await fetch(`${base}/api/v2/health`)).json();
    assert.equal(h.db.integrity, "CORRUPT");
    assert.equal(h.db.degraded, true);
    assert.match(logs.join("\n"), /DEGRADED \(no sampling\)/);
    const w = await fetch(`${base}/api/v2/watchlist`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{\"items\":[]}" });
    assert.equal(w.status, 503);
  } finally {
    await d.stop();
  }
});
