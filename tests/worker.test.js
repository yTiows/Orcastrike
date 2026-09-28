import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import * as entryModule from "../worker/index.js";
import {
  STATES,
  TTL_SECONDS,
  UPSTREAM,
  aggregateSteamHistory,
  cacheKey,
  resetCacheForTests,
} from "../worker/lib.js";

const SECRET = "TEST_ONLY_fake_csfloat_key_0000"; // dummy; never a real credential
const ITEM = "AK-47 | Redline (Field-Tested)";
const CANONICAL_KEYS = ["source", "canonical_item_id", "price_usd_cents", "listing_depth", "captured_at", "expires_at", "state"];
const realFetch = globalThis.fetch;
let calls;

function install(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function get(path, { env = {}, origin } = {}) {
  const headers = origin ? { origin } : {};
  return worker.fetch(new Request(`https://proxy.test${path}`, { headers }), env, undefined);
}

async function getJson(path, opts) {
  const res = await get(path, opts);
  const text = await res.text();
  return { res, text, body: text ? JSON.parse(text) : null };
}

function assertCanonical(body) {
  for (const k of CANONICAL_KEYS) assert.ok(k in body, `missing canonical key ${k}`);
  assert.ok(Object.values(STATES).includes(body.state));
  assert.ok(!Number.isNaN(Date.parse(body.captured_at)) && body.captured_at.endsWith("Z"));
  assert.ok(!Number.isNaN(Date.parse(body.expires_at)) && body.expires_at.endsWith("Z"));
}

function assertNoSecret(res, text) {
  assert.ok(!text.includes(SECRET), "secret leaked into body");
  for (const [, v] of res.headers) assert.ok(!v.includes(SECRET), "secret leaked into headers");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("authorization"), null);
}

beforeEach(() => resetCacheForTests());
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

// ---- routing / method policy --------------------------------------------------------

test("entry module exports only the default handler (workerd treats named exports as entrypoints)", () => {
  assert.deepEqual(Object.keys(entryModule), ["default"]);
  assert.equal(typeof worker.fetch, "function");
});

test("read-only: non-GET methods rejected, no trade routes exist", async () => {
  install(() => json({}));
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await worker.fetch(new Request("https://proxy.test/api/quote?source=steam&item=x", { method }), {}, undefined);
    assert.equal(res.status, 405);
  }
  for (const path of ["/api/buy", "/api/sell", "/api/list", "/api/order", "/"]) {
    assert.equal((await get(path)).status, 404);
  }
  assert.equal(calls.length, 0);
});

test("parameter validation", async () => {
  install(() => json({}));
  assert.equal((await get("/api/quote?source=steam")).status, 400);
  assert.equal((await get(`/api/quote?source=buff&item=${encodeURIComponent(ITEM)}`)).status, 400);
  assert.equal((await get(`/api/quote?source=steam&item=${"x".repeat(201)}`)).status, 400);
  assert.equal((await get(`/api/quote?source=steam&item=a%00b`)).status, 400);
  assert.equal((await get(`/api/history?source=csfloat&item=x`)).status, 400);
  assert.equal(calls.length, 0);
});

test("CORS: allow-listed origin echoed, others get no ACAO header", async () => {
  install(() => json({}));
  const env = { ALLOWED_ORIGINS: "https://skin-arb-terminal.pages.dev" };
  const ok = await get("/api/health", { env, origin: "https://skin-arb-terminal.pages.dev" });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://skin-arb-terminal.pages.dev");
  const bad = await get("/api/health", { env, origin: "https://evil.example" });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const pre = await worker.fetch(
    new Request("https://proxy.test/api/quote", { method: "OPTIONS", headers: { origin: "https://skin-arb-terminal.pages.dev" } }),
    env,
    undefined,
  );
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("cache key format {source}:{canonical_item_id}:{currency}:{endpoint_type}", () => {
  assert.equal(cacheKey("csfloat", ITEM, "USD", "quote"), `csfloat:${ITEM}:USD:quote`);
  assert.ok(TTL_SECONDS.quote >= 60 && TTL_SECONDS.quote <= 120);
  assert.equal(TTL_SECONDS.history, 3600);
  assert.equal(TTL_SECONDS.fx, 3600);
});

// ---- CSFloat ------------------------------------------------------------------------

test("CSFloat without key → NOT_CONFIGURED, no upstream call, health reports it", async () => {
  install(() => json([]));
  const { body } = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`);
  assertCanonical(body);
  assert.equal(body.state, "NOT_CONFIGURED");
  assert.equal(body.price_usd_cents, null);
  assert.equal(calls.length, 0);
  const health = await getJson("/api/health");
  assert.equal(health.body.sources.csfloat, "NOT_CONFIGURED");
  const blank = await getJson(`/api/quote?source=csfloat&item=x`, { env: { CSFLOAT_API_KEY: "   " } });
  assert.equal(blank.body.state, "NOT_CONFIGURED");
});

test("CSFloat with key: lowest price, ±10% depth, exact-name identity, key never leaks", async () => {
  const listing = (price, name = ITEM, extra = {}) => ({ id: String(price), type: "buy_now", state: "listed", price, item: { market_hash_name: name }, ...extra });
  install((url, init) => {
    assert.equal(url, UPSTREAM.csfloatListings(ITEM));
    assert.equal(init.headers.authorization, SECRET);
    return json([
      listing(1000),
      listing(1050),
      listing(1100), // exactly +10% → counted
      listing(1101), // outside
      listing(1500),
      listing(900, "AK-47 | Redline (Minimal Wear)"), // different canonical id → excluded
      listing(800, ITEM, { type: "auction" }), // not buy-now → excluded
    ]);
  });
  const env = { CSFLOAT_API_KEY: SECRET };
  const { res, text, body } = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assertCanonical(body);
  assertNoSecret(res, text);
  assert.equal(body.state, "AVAILABLE");
  assert.equal(body.price_usd_cents, 1000);
  assert.equal(body.listing_depth, 3);
  assert.equal(body.listing_depth_basis, "within_10pct_of_lowest");
  const health = await getJson("/api/health", { env });
  assert.equal(health.body.sources.csfloat, "CONFIGURED");
  assertNoSecret(health.res, health.text);
});

test("CSFloat {data: [...]} envelope accepted; malformed price → INVALID", async () => {
  install(() => json({ data: [{ type: "buy_now", price: 1234, item: { market_hash_name: ITEM } }] }));
  const env = { CSFLOAT_API_KEY: SECRET };
  const ok = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(ok.body.price_usd_cents, 1234);
  resetCacheForTests();
  install(() => json([{ type: "buy_now", price: -5, item: { market_hash_name: ITEM } }]));
  const bad = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(bad.body.state, "INVALID");
  assert.equal(bad.body.price_usd_cents, null);
  resetCacheForTests();
  install(() => new Response("<html>oops</html>", { status: 200 }));
  const notJson = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(notJson.body.state, "INVALID");
});

test("upstream errors never echo upstream body or auth material", async () => {
  install(() => new Response(`{"error":"bad key ${SECRET}","debug":"Authorization: ${SECRET}"}`, { status: 500 }));
  const env = { CSFLOAT_API_KEY: SECRET };
  const { res, text, body } = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(body.state, "UNAVAILABLE");
  assert.equal(body.reason, "upstream HTTP 500");
  assertNoSecret(res, text);
  resetCacheForTests();
  install(() => new Response("forbidden", { status: 403 }));
  const f = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(f.body.state, "UNAVAILABLE");
  assertNoSecret(f.res, f.text);
});

test("429 → RATE_LIMITED immediately, no retry; cached for the normal TTL", async () => {
  install(() => new Response("slow down", { status: 429 }));
  const env = { CSFLOAT_API_KEY: SECRET };
  const a = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(a.body.state, "RATE_LIMITED");
  assert.equal(a.body.price_usd_cents, null);
  assert.equal(calls.length, 1);
  const b = await getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env });
  assert.equal(b.body.state, "RATE_LIMITED");
  assert.equal(calls.length, 1); // served from cache; no aggressive retry
});

test("8s upstream timeout → UNAVAILABLE (no indefinite hang)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  install(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  );
  const pending = getJson(`/api/quote?source=csfloat&item=${encodeURIComponent(ITEM)}`, { env: { CSFLOAT_API_KEY: SECRET } });
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(7999);
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(1);
  const { body } = await pending;
  assert.equal(body.state, "UNAVAILABLE");
  assert.match(body.reason, /timeout \(8s\)/);
});

// ---- Steam --------------------------------------------------------------------------

const steamPage = ({ nameid = "176118270", prefix = "$", line1 } = {}) => `
<html><script>
  var line1=${line1 ?? JSON.stringify([
    ["Sep 01 2026 01: +0", 10.0, "10"],
    ["Sep 01 2026 02: +0", 11.0, "30"],
    ["Sep 02 2026 01: +0", 1.234, "1"],
  ])};
  $J(document).ready(function(){
    var strFormatPrefix = "${prefix}";
    var strFormatSuffix = "";
    Market_LoadOrderSpread( ${nameid} );
  });
</script></html>`;

const histogram = (over = {}) => ({
  success: 1,
  lowest_sell_order: "1000",
  price_prefix: "$",
  price_suffix: "",
  sell_order_graph: [
    [10.0, 2, "2 at $10.00"],
    [10.5, 5, "3 more at $10.50"],
    [11.0, 9, "4 more at $11.00"],
    [11.01, 12, "3 more"],
    [20.0, 50, "..."],
  ],
  ...over,
});

function steamRoutes({ page = steamPage(), hist = histogram() } = {}) {
  return (url, init) => {
    assert.equal(init.headers.cookie, undefined, "no Steam cookies may be sent");
    assert.equal(init.headers.Cookie, undefined);
    if (url === UPSTREAM.steamListing(ITEM)) return new Response(page, { status: 200 });
    if (url === UPSTREAM.steamHistogram("176118270")) return json(hist);
    throw new Error(`unexpected url ${url}`);
  };
}

test("Steam quote: lowest sell order + cumulative depth within ±10%, anonymous requests", async () => {
  install(steamRoutes());
  const { body } = await getJson(`/api/quote?source=steam&item=${encodeURIComponent(ITEM)}`);
  assertCanonical(body);
  assert.equal(body.state, "AVAILABLE");
  assert.equal(body.price_usd_cents, 1000);
  assert.equal(body.listing_depth, 9); // cumulative count at $11.00 (= +10%)
  assert.equal(calls.length, 2);
  await getJson(`/api/history?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(calls.length, 2); // history came from the same page fetch
});

test("Steam history: daily volume-weighted mean in integer cents", async () => {
  install(steamRoutes());
  const { body } = await getJson(`/api/history?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(body.state, "AVAILABLE");
  assert.deepEqual(body.points, [
    { date: "2026-09-01", price_usd_cents: 1075, volume: 40 }, // (1000×10 + 1100×30) / 40
    { date: "2026-09-02", price_usd_cents: 123, volume: 1 },
  ]);
  assert.throws(() => aggregateSteamHistory([["Sep 01 2026 01: +2", 1, "1"]]));
});

test("Steam: non-USD page → history INVALID; bad histogram → INVALID; no listings → UNAVAILABLE", async () => {
  install(steamRoutes({ page: steamPage({ prefix: "€" }) }));
  const h = await getJson(`/api/history?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(h.body.state, "INVALID");
  assert.deepEqual(h.body.points, []);

  resetCacheForTests();
  install(steamRoutes({ hist: histogram({ sell_order_graph: [[10.5, 2, ""]] }) }));
  const q = await getJson(`/api/quote?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(q.body.state, "INVALID");
  assert.equal(q.body.price_usd_cents, null);

  resetCacheForTests();
  install(steamRoutes({ hist: histogram({ lowest_sell_order: null, sell_order_graph: [] }) }));
  const none = await getJson(`/api/quote?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(none.body.state, "UNAVAILABLE");

  resetCacheForTests();
  install(steamRoutes({ hist: histogram({ price_prefix: "CDN$ " }) }));
  const cad = await getJson(`/api/quote?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(cad.body.state, "INVALID");

  resetCacheForTests();
  install(() => new Response("<html>You've made too many requests recently.</html>", { status: 200 }));
  const rl = await getJson(`/api/quote?source=steam&item=${encodeURIComponent(ITEM)}`);
  assert.equal(rl.body.state, "RATE_LIMITED");
});

// ---- Skinport + FX ------------------------------------------------------------------

function skinportRoutes({ fx = { amount: 1, base: "EUR", date: new Date().toISOString().slice(0, 10), rates: { USD: 1.0834 } }, fxStatus = 200, items } = {}) {
  return (url, init) => {
    if (url === UPSTREAM.fx) return json(fx, fxStatus);
    if (url === UPSTREAM.skinportItems) {
      assert.equal(init.headers["accept-encoding"], "br");
      return json(
        items ?? [
          { market_hash_name: ITEM, currency: "EUR", min_price: 10.0, quantity: 42 },
          { market_hash_name: "Empty", currency: "EUR", min_price: null, quantity: 0 },
          { market_hash_name: "Broken", currency: "EUR", min_price: -1, quantity: 3 },
        ],
      );
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test("Skinport: EUR converted to USD cents at ingestion; depth unavailable, never total_listings", async () => {
  install(skinportRoutes());
  const { body, text } = await getJson(`/api/quote?source=skinport&item=${encodeURIComponent(ITEM)}`);
  assertCanonical(body);
  assert.equal(body.state, "AVAILABLE");
  assert.equal(body.price_usd_cents, 1083); // 1000 EUR cents × 1.0834
  assert.equal(body.listing_depth, null);
  assert.equal(body.listing_depth_basis, "unavailable");
  assert.equal(body.total_listings, 42);
  assert.equal(body.fx_rate_micros, 1083400);
  assert.ok(!/EUR cents|eur_cents|min_price/.test(text), "no EUR amount leaves ingestion");

  const empty = await getJson(`/api/quote?source=skinport&item=Empty`);
  assert.equal(empty.body.state, "UNAVAILABLE");
  const broken = await getJson(`/api/quote?source=skinport&item=Broken`);
  assert.equal(broken.body.state, "INVALID");
  const missing = await getJson(`/api/quote?source=skinport&item=Nope`);
  assert.equal(missing.body.state, "UNAVAILABLE");
  assert.equal(calls.length, 2); // one FX + one bulk fetch served all four
});

test("FX: unavailable → Skinport UNAVAILABLE (no price); stale → STALE; malformed → INVALID", async () => {
  install(skinportRoutes({ fxStatus: 503 }));
  const down = await getJson(`/api/quote?source=skinport&item=${encodeURIComponent(ITEM)}`);
  assert.equal(down.body.state, "UNAVAILABLE");
  assert.equal(down.body.price_usd_cents, null);

  resetCacheForTests();
  install(skinportRoutes({ fx: { amount: 1, base: "EUR", date: "2020-01-02", rates: { USD: 1.1 } } }));
  const stale = await getJson(`/api/quote?source=skinport&item=${encodeURIComponent(ITEM)}`);
  assert.equal(stale.body.state, "STALE");
  const fx = await getJson("/api/fx");
  assert.equal(fx.body.state, "STALE");

  resetCacheForTests();
  install(skinportRoutes({ fx: { base: "EUR", date: "2026-09-25", rates: { USD: "1.08" } } }));
  const bad = await getJson("/api/fx");
  assert.equal(bad.body.state, "INVALID");
  assert.equal(bad.body.rate_micros, null);
});
