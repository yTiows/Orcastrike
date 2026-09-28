// Integration across the daemon ↔ UI boundary: a real daemon process, a real HTTP client, and
// a loopback upstream that serves SYNTHETIC responses (documented shapes, invented values).
// The daemon flags every row synthetic and parsers stay UNVERIFIED, so nothing here can become
// evidence or an ELIGIBLE opportunity.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ITEM = "AK-47 | Redline (Field-Tested)";
const FAKE_KEY = "TEST_ONLY_integration_key_000";
let upstream;
let daemon;
let base;
let daemonLog = "";

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const SYNTHETIC = {
  "/api.frankfurter.dev/v1/latest": () => ({ amount: 1, base: "EUR", date: new Date().toISOString().slice(0, 10), rates: { USD: 1.1 } }),
  "/api.skinport.com/v1/items": () => [{ market_hash_name: ITEM, currency: "EUR", min_price: 20.0, quantity: 9 }],
  "/api.skinport.com/v1/sales/history": () => [
    { market_hash_name: ITEM, currency: "EUR", last_24_hours: { volume: 4, median: 20 }, last_7_days: { volume: 30, median: 20 }, last_30_days: { volume: 100, median: 20 }, last_90_days: { volume: 300, median: 20 } },
  ],
  "/csfloat.com/api/v1/listings": (req) => {
    if (req.headers.authorization !== FAKE_KEY) return { __status: 401 };
    return [1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i), type: "buy_now", state: "listed", price: 2400 + i * 10, item: { market_hash_name: ITEM, float_value: 0.2, paint_seed: i, paint_index: 282 } }));
  },
  "/steamcommunity.com/market/priceoverview/": () => ({ success: true, lowest_price: "$21.00", volume: "150", median_price: "$20.50" }),
  "/steamcommunity.com/market/itemordershistogram": () => ({ success: 1, lowest_sell_order: "2100", price_prefix: "$", price_suffix: "", sell_order_graph: [[21.0, 3, ""], [22.0, 8, ""], [30.0, 20, ""]] }),
};

before(async () => {
  upstream = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/steamcommunity.com/market/listings/730/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<script>var line1=[["Sep 01 2026 01: +0",20.5,"12"]];var strFormatPrefix = "$";var strFormatSuffix = "";Market_LoadOrderSpread( 555 );</script>');
      return;
    }
    const h = SYNTHETIC[u.pathname];
    const body = h ? h(req) : { __status: 404 };
    res.writeHead(body.__status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "daemon/main.js"], {
    env: {
      PATH: process.env.PATH,
      ORCASTRIKE_PORT: String(port),
      ORCASTRIKE_DATA_DIR: mkdtempSync(join(tmpdir(), "orca-int-")),
      ORCASTRIKE_UPSTREAM_OVERRIDE: `http://127.0.0.1:${upstream.address().port}`,
      ORCASTRIKE_SYNTHETIC: "1",
      ORCASTRIKE_CONTRACT_REPORT: join(tmpdir(), "no-such-report.json"),
      CSFLOAT_API_KEY: FAKE_KEY,
      ORCASTRIKE_ENGINE_INTERVAL_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (d) => (daemonLog += d));
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/v2/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not start: ${daemonLog}`);
});

after(() => {
  daemon?.kill("SIGTERM");
  upstream?.close();
});

const post = (path, body, origin = base) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out; daemon log:\n${daemonLog}`);
}

test("health reports synthetic upstream and UNVERIFIED parsers", async () => {
  const h = await (await fetch(`${base}/api/v2/health`)).json();
  assert.equal(h.synthetic_upstream, true);
  assert.equal(h.sources.csfloat, "CONFIGURED");
  assert.ok(Object.values(h.parsers).every((s) => s !== "VERIFIED"));
});

test("UI contract: v1 quotes come back in the canonical schema, flagged synthetic and UNVERIFIED", async () => {
  assert.equal((await post("/api/v2/watchlist", { items: [ITEM] })).status, 200);
  const q = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`)).json();
    return r.state === "AVAILABLE" ? r : null;
  });
  for (const k of ["source", "canonical_item_id", "price_usd_cents", "listing_depth", "captured_at", "expires_at", "state"]) assert.ok(k in q, k);
  assert.equal(q.price_usd_cents, 2410);
  assert.equal(q.listing_depth, 6);
  assert.equal(q.synthetic, true);
  assert.equal(q.parser_status, "UNVERIFIED");
  const sp = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/quote?source=skinport&item=${encodeURIComponent(ITEM)}`)).json();
    return r.state === "AVAILABLE" ? r : null;
  });
  assert.equal(sp.price_usd_cents, 2200); // 20.00 EUR × 1.1, converted at ingestion
  assert.equal(sp.listing_depth, null);
});

test("secrets never leave the daemon; write guards hold", async () => {
  for (const path of ["/api/v2/health", "/api/v2/quality", "/api/v2/settings", `/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`]) {
    const text = await (await fetch(`${base}${path}`)).text();
    assert.ok(!text.includes(FAKE_KEY), `${path} leaked the key`);
  }
  assert.ok(!daemonLog.includes(FAKE_KEY), "log leaked the key");
  assert.equal((await post("/api/v2/watchlist", { items: [] }, null)).status, 403);
  assert.equal((await post("/api/v2/watchlist", { items: [] }, "https://evil.example")).status, 403);
  const bad = await fetch(`${base}/api/v2/watchlist`, { method: "POST", headers: { "content-type": "text/plain", origin: base }, body: "{}" });
  assert.equal(bad.status, 415);
  const invalid = await post("/api/v2/settings", { settings: { "automation.level": "L3" } });
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).errors.join(" "), /no verified execution API/);
});

test("coverage and quality contracts are served", async () => {
  const cov = await (await fetch(`${base}/api/v2/coverage?days=2`)).json();
  assert.equal(cov.contract, "coverage_report@1");
  assert.ok(cov.plan.steam && cov.plan.skinport);
  const q = await (await fetch(`${base}/api/v2/quality`)).json();
  assert.equal(q.contract, "data_quality_event@1");
});

test("engine: SYNTHETIC data with UNVERIFIED parsers never yields an ELIGIBLE opportunity", async () => {
  const cycle = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/v2/opportunities?all=1`)).json();
    return r.evaluated > 0 && r.all.some((o) => o.sell_source === "csfloat" && o.buy_source === "steam") ? r : null;
  });
  assert.equal(cycle.ranked.length, 0);
  assert.equal(cycle.counts.ELIGIBLE ?? 0, 0);
  const o = cycle.all.find((x) => x.buy_source === "steam" && x.sell_source === "csfloat");
  assert.equal(o.math, null, "no calculation from unverified inputs");
  assert.match(o.blocked_reasons.join(" "), /PARSER_UNVERIFIED|no quote|STALE|effective age/);
  assert.equal(o.synthetic, true);
});

test("ledger sync validates capital and stores it", async () => {
  const bad = await post("/api/v2/ledger/sync", { capital: { usd_cash_balance_cents: 1.5 } });
  assert.equal(bad.status, 422);
  const ok = await post("/api/v2/ledger/sync", {
    capital: { usd_cash_balance_cents: 9000, banked_profit_cents: 0, reserved_cash_cents: 0, open_cost_basis_cents: 0, deployable_capital_cents: 9000, steam_wallet_balance_cents: 0, deployable_capital_complete: true },
    circuit_breaker_triggered_at: null,
  });
  assert.equal(ok.status, 200);
  const cycle = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/v2/opportunities`)).json();
    return r.capital_synced_at ? r : null;
  });
  assert.ok(cycle.capital_synced_at);
});

test("evidence report over HTTP: SYNTHETIC runs reach no evidence level; regime coverage UNKNOWN", async () => {
  const r = await (await fetch(`${base}/api/v2/evidence`)).json();
  assert.equal(r.contract, "evidence_report@1");
  assert.ok(r.ladder.every((l) => l.status === "NOT_REACHED"));
  assert.equal(r.gates.SIGNAL_EVIDENCE.pass, false);
  assert.equal(r.gates.EXECUTION_EVIDENCE.pass, false);
  assert.equal(r.market_regime_coverage.state, "UNKNOWN");
  const p = await (await fetch(`${base}/api/v2/paper-trades`)).json();
  assert.equal(p.kind, "PAPER");
  assert.match(p.label, /forward paper trading evaluation \(not a backtest\)/);
  const real = await (await fetch(`${base}/api/v2/real-trades`)).json();
  assert.equal(real.kind, "REAL");
});

test("regression: daemon state rows (ledger sync, watchlist) are not validated as settings", async () => {
  const s = await (await fetch(`${base}/api/v2/settings`)).json();
  assert.deepEqual(s.errors, [], "ledger.capital_snapshot / watchlist.items must not invalidate user settings");
  const h = await (await fetch(`${base}/api/v2/health`)).json();
  assert.deepEqual(h.settings_errors, []);
});

test("control API: L2/L3 rejected; kill switch engage is always accepted, release needs origin + confirm; UMBRA needs the phrase", async () => {
  const l3 = await post("/api/v2/automation", { level: "L3" });
  assert.equal(l3.status, 422);
  assert.match((await l3.json()).errors[0], /UNVERIFIED/);
  assert.equal((await post("/api/v2/automation", { level: "L1" })).status, 200);
  const engage = await post("/api/v2/kill-switch", { engaged: true, reason: "test" }, "https://elsewhere.example");
  assert.equal(engage.status, 200);
  assert.equal((await engage.json()).automation.kill_switch.engaged, true);
  assert.equal((await post("/api/v2/kill-switch", { engaged: false, confirm: true }, "https://elsewhere.example")).status, 403);
  assert.equal((await post("/api/v2/kill-switch", { engaged: false })).status, 422);
  assert.equal((await post("/api/v2/kill-switch", { engaged: false, confirm: true })).status, 200);
  const noPhrase = await post("/api/v2/umbra", { action: "activate", bankroll_cents: 50000 });
  assert.equal(noPhrase.status, 422);
  const u = await post("/api/v2/umbra", { action: "activate", bankroll_cents: 50000, override_phrase: "unproven edge" });
  assert.equal(u.status, 200);
  const st = await u.json();
  assert.equal(st.umbra.active, true);
  assert.equal(st.umbra.unproven, true);
  assert.equal(st.umbra.grants_execution, false);
  assert.equal(st.push_notifications.state, "BLOCKED");
  assert.equal((await post("/api/v2/umbra", { action: "deactivate" })).status, 200);
});
