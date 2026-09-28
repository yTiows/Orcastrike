// Contract tests. Layer 1: every LIVE fixture under tests/fixtures/live must pass its parser
// (skipped with an explicit UNVERIFIED note when none exist). Layer 2: sanitization and shape
// diffing. SYNTHETIC inputs below exercise the parsers' fail-closed paths only; they are
// labeled SYNTHETIC and never used as evidence of an upstream format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS, EXPECTED_SHAPES, describeShape, diffShape, redactDeep, sanitizeBody } from "../daemon/contract.js";
import { parseSkinportSalesHistory, parseSteamPriceOverview, parseUsdPriceString } from "../daemon/parsers.js";

const LIVE = new URL("./fixtures/live/", import.meta.url).pathname;

function liveFixtures() {
  if (!existsSync(LIVE)) return [];
  return readdirSync(LIVE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(LIVE, d.name)).filter((f) => f.endsWith(".json")).map((f) => join(LIVE, d.name, f)));
}

test("LIVE fixtures pass their parsers", (t) => {
  const files = liveFixtures();
  if (files.length === 0) {
    t.skip("UNVERIFIED: no LIVE fixtures present. Run `node scripts/contract_test.mjs` where the network allows.");
    return;
  }
  for (const f of files) {
    const fx = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(fx.fixture_kind, "LIVE", f);
    const parser = PARSERS[fx.endpoint];
    if (!parser) continue; // captured for a future parser
    const ctx = { item: "AK-47 | Redline (Field-Tested)", fxRateMicros: null };
    if (fx.endpoint === "skinport_items") continue; // needs the same run's LIVE FX; covered by CONTRACT_REPORT
    const r = parser.run(fx.body, ctx);
    assert.equal(r.ok, true, `${f}: ${r.reason}`);
    if (EXPECTED_SHAPES[fx.endpoint]) {
      const d = diffShape(EXPECTED_SHAPES[fx.endpoint], describeShape(fx.body.json));
      assert.deepEqual(d.missing, [], `${f}: missing ${d.missing.join(", ")}`);
    }
  }
});

test("latest CONTRACT_REPORT is recorded and honest about BLOCKED endpoints", () => {
  const p = join(LIVE, "CONTRACT_REPORT.json");
  assert.ok(existsSync(p), "run scripts/contract_test.mjs at least once");
  const r = JSON.parse(readFileSync(p, "utf8"));
  for (const x of r.results) {
    assert.ok(["PASS", "FAIL", "CAPTURED", "BLOCKED", "UNVERIFIED"].includes(x.status));
    if (x.status === "PASS") assert.ok(x.fixture, "PASS requires a stored LIVE fixture");
  }
});

test("sanitization removes seller identity and credential-like keys", () => {
  const SYNTHETIC = [{ id: "1", price: 100, seller: { steam_id: "7656", username: "x" }, item: { market_hash_name: "A", api_key: "k" } }];
  const r = redactDeep(SYNTHETIC);
  assert.equal("seller" in r[0], false);
  assert.equal("api_key" in r[0].item, false);
  const s = sanitizeBody("csfloat_listings", JSON.stringify(SYNTHETIC));
  assert.equal(JSON.stringify(s.body).includes("7656"), false);
  assert.equal(s.body.first_listing_id, "1");
  const page = sanitizeBody("steam_listing_page", '<html>secret stuff<script>var line1=[["Sep 01 2026 01: +0",1,"1"]];var strFormatPrefix = "$";var strFormatSuffix = "";Market_LoadOrderSpread( 42 );</script>');
  assert.equal(page.body.extracted.item_nameid, "42");
  assert.equal(page.body.html_excerpt.includes("secret stuff"), false);
});

test("shape diff reports missing fields and type mismatches", () => {
  const d = diffShape(EXPECTED_SHAPES.steam_priceoverview, describeShape({ success: true, lowest_price: 1.5 }));
  assert.deepEqual(d.missing, ["$.volume", "$.median_price"]);
  assert.deepEqual(d.type_mismatch, [{ path: "$.lowest_price", expected: "string", actual: "number" }]);
});

test("Steam priceoverview parser: USD strings only, fails closed", () => {
  // SYNTHETIC inputs (format per public docs; not evidence of the live format).
  assert.deepEqual(parseSteamPriceOverview({ success: true, lowest_price: "$1,234.56", volume: "1,020", median_price: "$1,200.00" }), {
    state: "AVAILABLE",
    lowest_price_cents: 123456,
    median_price_24h_cents: 120000,
    volume_24h: 1020,
  });
  assert.equal(parseSteamPriceOverview({ success: true, lowest_price: "1,23€", volume: "5" }).state, "INVALID");
  assert.equal(parseSteamPriceOverview({ success: true, lowest_price: "CDN$ 1.00" }).state, "INVALID");
  assert.equal(parseSteamPriceOverview({ success: false }).state, "UNAVAILABLE");
  assert.equal(parseSteamPriceOverview({ success: true }).state, "UNAVAILABLE");
  assert.equal(parseSteamPriceOverview(null).state, "INVALID");
  assert.equal(parseUsdPriceString("$0.03"), 3);
  assert.throws(() => parseUsdPriceString("$1.234"));
});

test("Skinport sales history parser: counts per window, EUR never leaves un-converted", () => {
  const SYNTHETIC = [
    {
      market_hash_name: "A",
      currency: "EUR",
      last_24_hours: { volume: 3, median: 1.0 },
      last_7_days: { volume: 12, median: 1.1 },
      last_30_days: { volume: 40, median: 1.2 },
      last_90_days: { volume: 90, median: null },
    },
    { market_hash_name: "B", currency: "USD", last_24_hours: {}, last_7_days: {}, last_30_days: {}, last_90_days: {} },
    { market_hash_name: "C", currency: "EUR", last_24_hours: { volume: -1 }, last_7_days: { volume: 1 }, last_30_days: { volume: 1 }, last_90_days: { volume: 1 } },
  ];
  const noFx = parseSkinportSalesHistory(SYNTHETIC);
  assert.equal(noFx.A.volume_7d, 12);
  assert.equal("median_7d_usd_cents" in noFx.A, false);
  assert.equal(noFx.B.state, "INVALID");
  assert.equal(noFx.C.state, "INVALID");
  const withFx = parseSkinportSalesHistory(SYNTHETIC, { rate_micros: 1100000 });
  assert.equal(withFx.A.median_7d_usd_cents, 121); // 110 EUR cents × 1.1
  assert.equal(withFx.A.median_90d_usd_cents, null);
  assert.equal(parseSkinportSalesHistory({}).__body.state, "INVALID");
});
