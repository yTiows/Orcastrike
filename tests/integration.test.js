// Integration across the daemon ↔ UI boundary: a real daemon process, a real HTTP client, and
// a loopback upstream that serves SYNTHETIC responses (documented shapes, invented values).
// The daemon flags every row synthetic and parsers stay UNVERIFIED, so nothing here can become
// evidence or an ELIGIBLE opportunity.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_KEY, ITEM, startSyntheticStack } from "./helpers/synthetic-stack.js";

let stack;
let base;
const logText = () => stack?.log() ?? "";

before(async () => {
  stack = await startSyntheticStack({ engineIntervalMs: 500 });
  base = stack.base;
});

after(() => stack?.stop());

const post = (path, body, origin = base) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out; daemon log:\n${logText()}`);
}

test("health reports synthetic upstream and UNVERIFIED parsers", async () => {
  const h = await (await fetch(`${base}/api/v2/health`)).json();
  assert.equal(h.synthetic_upstream, true);
  assert.equal(h.sources.csfloat, "CONFIGURED");
  assert.ok(Object.values(h.parsers).every((s) => s !== "VERIFIED"));
});

test("regression: the v1 Worker health probe is served when the daemon hosts the UI", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.served_by, "daemon");
  assert.equal(h.sources.csfloat, "CONFIGURED");
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
  for (const path of ["/api/health", "/api/v2/health", "/api/v2/quality", "/api/v2/settings", `/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`]) {
    const text = await (await fetch(`${base}${path}`)).text();
    assert.ok(!text.includes(FAKE_KEY), `${path} leaked the key`);
  }
  assert.ok(!logText().includes(FAKE_KEY), "log leaked the key");
  // Key setup text is served for the Overview checklist: a prompt that hides input, never a value.
  const { key_setup: ks } = await (await fetch(`${base}/api/v2/health`)).json();
  assert.match(ks.windows_powershell, /Read-Host "CSFloat API key" -AsSecureString/);
  assert.match(ks.macos_linux, /read -rs /);
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

test("UMBRA cycle reports UNIVERSE_SIZE, DISCOVERY_TIME, ITEMS_SKIPPED with SKIP_REASON", async () => {
  assert.equal((await post("/api/v2/umbra", { action: "activate", bankroll_cents: 50000, override_phrase: "unproven edge" })).status, 200);
  try {
    const c = await waitFor(async () => {
      const r = await (await fetch(`${base}/api/v2/opportunities?mode=umbra&all=1`)).json();
      return r.universe ? r : null;
    });
    assert.equal(c.mode, "UMBRA");
    assert.equal(c.unproven, true);
    for (const k of ["UNIVERSE_SIZE", "DISCOVERY_TIME", "ITEMS_SKIPPED", "SKIP_REASON", "universe_definition"]) assert.ok(k in c.universe, k);
    assert.ok(c.universe.UNIVERSE_SIZE >= 1);
    assert.equal(c.universe.ITEMS_SKIPPED, Object.values(c.universe.SKIP_REASON).reduce((a, b) => a + b, 0));
    assert.ok(c.all.every((o) => o.status !== "ELIGIBLE"), "SYNTHETIC/UNVERIFIED data stays ineligible in UMBRA too");
  } finally {
    assert.equal((await post("/api/v2/umbra", { action: "deactivate" })).status, 200);
  }
});

test("fee calibration accept: needs explicit confirmation and valid overrides; creates a new version, never edits the old one", async () => {
  const before = await (await fetch(`${base}/api/v2/fee-models`)).json();
  const proposal = { market: "steam", receipts: 3, difference_cents: 117, proposed_overrides: { STEAM_FEE_MODEL: "valve_fee_on_top" } };
  assert.equal((await post("/api/v2/fee-models/accept", { proposal })).status, 422, "no confirm");
  assert.equal((await post("/api/v2/fee-models/accept", { proposal: { ...proposal, proposed_overrides: { STEAM_FEE_RATE: 0 } }, confirm: true })).status, 422, "unknown override");
  assert.equal((await post("/api/v2/fee-models/accept", { proposal, confirm: true }, "https://evil.example")).status, 403, "cross-origin");
  const ok = await post("/api/v2/fee-models/accept", { proposal, confirm: true });
  assert.equal(ok.status, 200);
  const { fee_model_version: v } = await ok.json();
  const after = await (await fetch(`${base}/api/v2/fee-models`)).json();
  assert.equal(after.current, v);
  assert.notEqual(v, before.current);
  assert.ok(before.versions.every((b) => after.versions.some((a) => a.fee_model_version === b.fee_model_version && a.created_at === b.created_at)), "old versions kept unchanged");
  assert.equal(after.proposals[0].status, "ACCEPTED");
});

test("static UI is served from the repo on every platform; traversal and non-allow-listed files are refused", async () => {
  for (const path of ["/", "/index.html", "/styles.css", "/js/app.js", "/ui/opportunities.js", "/static/events.json"]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/, path);
  }
  for (const path of ["/package.json", "/daemon/main.js", "/js/../package.json", "/%2e%2e/package.json", "/.orcastrike-data/orcastrike.sqlite"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test("shutdown endpoint: same-origin JSON plus explicit confirmation only", async () => {
  assert.equal((await post("/api/v2/shutdown", { confirm: true }, null)).status, 403, "no Origin");
  assert.equal((await post("/api/v2/shutdown", { confirm: true }, "https://evil.example")).status, 403, "cross-origin");
  assert.equal((await post("/api/v2/shutdown", {})).status, 422, "no confirmation");
  assert.ok((await fetch(`${base}/api/v2/health`)).ok, "still running");
});

test("live verification over HTTP: disabled with a SYNTHETIC upstream; health carries per-source status and data summary", async () => {
  const v = await (await fetch(`${base}/api/v2/verify`)).json();
  assert.equal(v.contract, "verify@1");
  assert.match(v.disabled, /SYNTHETIC/);
  assert.equal((await post("/api/v2/verify", {})).status, 422);
  assert.equal((await post("/api/v2/verify", { confirm: true })).status, 409);
  assert.equal((await post("/api/v2/verify", { confirm: true }, "https://evil.example")).status, 403);
  assert.equal((await post("/api/v2/watchlist", { items: [ITEM] })).status, 200);
  const h = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/v2/health`)).json();
    return r.data?.tracked_items >= 1 && r.data.observations_total > 0 ? r : null;
  });
  assert.deepEqual(Object.keys(h.parser_status_by_source).sort(), ["csfloat", "skinport", "steam"]);
  assert.ok(Object.values(h.parser_status_by_source).every((s) => s !== "VERIFIED"));
  assert.ok(h.data.observations_total > 0);
  assert.ok(h.data.tracked_items >= 1);
  assert.ok(h.data.first_observation_at);
  assert.ok(h.data.sources.csfloat.ok > 0);
});
