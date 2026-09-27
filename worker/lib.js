// Worker implementation: CORS-safe, read-only proxy + cache for Steam / Skinport / CSFloat
// quotes, Steam price history and the EUR→USD reference rate. worker/index.js is the entry
// point; it must export only the default handler (workerd treats every named export of the
// entry module as an entrypoint), so helpers live here.
//
// Invariants enforced here:
// - GET only; there is no route that places, lists, buys or sells anything (P0-1).
// - Steam is queried anonymously; no cookies or Steam credentials exist in this code (P0-2).
// - CSFLOAT_API_KEY is read from the Worker secret binding only and is never echoed in a
//   response body, header, log line or error (P0-3, P0-9).
// - Upstream responses are never forwarded: every response is a new object built from
//   validated fields, so upstream headers (auth, cookies) cannot leak.
// - Any non-USD value is converted to USD cents at ingestion, before caching (P0-6).
// - Missing/invalid data → explicit state; never a placeholder number (P0-4).

import { DEFAULTS } from "../config/defaults.js";
import { BPS, MoneyError, eurCentsToUsdCents, majorUnitsToCents, mulDivRoundHalfUp, parseRateMicros, rateToBps } from "../js/money.js";

export const STATES = Object.freeze({
  AVAILABLE: "AVAILABLE",
  STALE: "STALE",
  UNAVAILABLE: "UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  INVALID: "INVALID",
});

export const TTL_SECONDS = Object.freeze({
  quote: 90, // spec: 60–120s
  history: 3600,
  fx: 3600,
  steam_item_nameid: 7 * 86400, // static per item; see DECISIONS.md
});

export const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_ITEM_LEN = 200;
const CSFLOAT_PAGE_LIMIT = 50;
const MEM_CACHE_MAX = 5000;
const DEPTH_WINDOW_BPS = rateToBps(DEFAULTS.LISTING_DEPTH_WINDOW_PCT);

export const UPSTREAM = Object.freeze({
  steamListing: (item) => `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item)}`,
  steamHistogram: (nameid) =>
    `https://steamcommunity.com/market/itemordershistogram?country=US&language=english&currency=1&item_nameid=${nameid}&two_factor=0`,
  skinportItems: "https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=1",
  csfloatListings: (item) =>
    `https://csfloat.com/api/v1/listings?market_hash_name=${encodeURIComponent(item)}&sort_by=lowest_price&limit=${CSFLOAT_PAGE_LIMIT}&type=buy_now`,
  fx: "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD",
});

class UpstreamDataError extends Error {}

// ---- Cache (per-isolate memory + Cache API when available) ------------------------

const mem = new Map();
const inflight = new Map();

export function cacheKey(source, item, currency, endpointType) {
  return `${source}:${item}:${currency}:${endpointType}`;
}

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheRequest(key) {
  return new Request(`https://cache.skin-arb-terminal.internal/${encodeURIComponent(key)}`);
}

async function cacheGet(key, nowMs) {
  const hit = mem.get(key);
  if (hit && hit.expiresAtMs > nowMs) return hit.value;
  if (hit) mem.delete(key);
  const c = cacheApi();
  if (!c) return null;
  try {
    const res = await c.match(cacheRequest(key));
    if (!res) return null;
    const entry = await res.json();
    if (entry.expiresAtMs <= nowMs) return null;
    mem.set(key, entry);
    return entry.value;
  } catch {
    return null;
  }
}

async function cachePut(key, value, ttlSec, nowMs, ctx) {
  const entry = { value, expiresAtMs: nowMs + ttlSec * 1000 };
  if (mem.size >= MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
  mem.set(key, entry);
  const c = cacheApi();
  if (!c) return;
  const put = c
    .put(
      cacheRequest(key),
      new Response(JSON.stringify(entry), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSec}` } }),
    )
    .catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
}

// Read-through with in-flight coalescing so concurrent misses make one upstream call.
async function cached(key, ttlFor, nowMs, ctx, produce) {
  const hit = await cacheGet(key, nowMs);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await produce();
      const ttl = ttlFor(value);
      if (ttl > 0) await cachePut(key, value, ttl, nowMs, ctx);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function resetCacheForTests() {
  mem.clear();
  inflight.clear();
}

// ---- Upstream fetch (8s timeout, no retry) ----------------------------------------

async function fetchUpstream(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal, redirect: "manual" });
    if (res.status === 429) return { kind: STATES.RATE_LIMITED, reason: "upstream returned 429" };
    if (res.status === 401 || res.status === 403) return { kind: STATES.UNAVAILABLE, reason: `upstream refused (HTTP ${res.status})` };
    if (res.status < 200 || res.status >= 300) return { kind: STATES.UNAVAILABLE, reason: `upstream HTTP ${res.status}` };
    const text = await res.text();
    return { kind: "OK", text };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    return { kind: STATES.UNAVAILABLE, reason: timedOut ? `upstream timeout (${UPSTREAM_TIMEOUT_MS / 1000}s)` : "upstream network error" };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamDataError("upstream body is not JSON");
  }
}

// ---- Canonical response builders ---------------------------------------------------

function iso(ms) {
  return new Date(ms).toISOString();
}

export function canonicalQuote({ source, item, state, nowMs, ttlSec, price = null, depth = null, reason, extras = {} }) {
  const available = state === STATES.AVAILABLE || state === STATES.STALE;
  return {
    source,
    canonical_item_id: item,
    price_usd_cents: available ? price : null,
    listing_depth: available ? depth : null,
    captured_at: iso(nowMs),
    expires_at: iso(nowMs + ttlSec * 1000),
    state,
    ...(reason ? { reason } : {}),
    ...extras,
  };
}

// Count of listings priced within ±10% of `lowestCents`. Every listing is >= lowest, so
// only the upper edge binds: price × BPS <= lowest × (BPS + window).
export function withinDepthWindow(priceCents, lowestCents) {
  return BigInt(priceCents) * BigInt(BPS) <= BigInt(lowestCents) * BigInt(BPS + DEPTH_WINDOW_BPS);
}

// ---- FX (Frankfurter / ECB reference rate) -----------------------------------------

export function parseFx(body, nowMs) {
  if (!body || typeof body !== "object") throw new UpstreamDataError("FX body not an object");
  if (body.base !== "EUR") throw new UpstreamDataError("FX base is not EUR");
  if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || Number.isNaN(Date.parse(`${body.date}T00:00:00Z`))) {
    throw new UpstreamDataError("FX date missing or malformed");
  }
  const raw = body.rates && body.rates.USD;
  if (typeof raw !== "number" || !(raw > 0)) throw new UpstreamDataError("FX USD rate missing or not positive");
  const rateMicros = parseRateMicros(raw);
  const ageMs = nowMs - Date.parse(`${body.date}T00:00:00Z`);
  const stale = ageMs > DEFAULTS.FX_MAX_RATE_AGE_DAYS * 86400000 || ageMs < -86400000;
  return { rate_micros: rateMicros, rate_date: body.date, state: stale ? STATES.STALE : STATES.AVAILABLE };
}

async function getFx(nowMs, ctx) {
  // Failures are cached only for the quote TTL so recovery follows the normal cycle.
  const ttlFor = (v) => (v.state === STATES.AVAILABLE || v.state === STATES.STALE ? TTL_SECONDS.fx : TTL_SECONDS.quote);
  return cached(cacheKey("fx", "EUR-USD", "USD", "rate"), ttlFor, nowMs, ctx, async () => {
    const base = { source: "frankfurter_ecb", pair: "EUR/USD", captured_at: iso(nowMs), expires_at: iso(nowMs + TTL_SECONDS.fx * 1000) };
    const up = await fetchUpstream(UPSTREAM.fx, { accept: "application/json" });
    if (up.kind !== "OK") return { ...base, rate_micros: null, rate_date: null, state: up.kind, reason: up.reason };
    try {
      return { ...base, ...parseFx(parseJson(up.text), nowMs) };
    } catch (err) {
      if (err instanceof UpstreamDataError || err instanceof MoneyError) {
        return { ...base, rate_micros: null, rate_date: null, state: STATES.INVALID, reason: err.message };
      }
      throw err;
    }
  });
}

// ---- Steam ------------------------------------------------------------------------

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function looksRateLimited(html) {
  return /too many requests/i.test(html);
}

function extractJsString(html, name) {
  const m = new RegExp(`var ${name}\\s*=\\s*"([^"]*)"\\s*;`).exec(html);
  return m ? m[1] : null;
}

// Listing page → { item_nameid, history } (history may carry its own error state).
export function parseSteamListingPage(html) {
  const idMatch = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(html);
  const itemNameId = idMatch ? idMatch[1] : null;

  let history;
  const start = html.indexOf("var line1=");
  if (start === -1) {
    history = { state: STATES.UNAVAILABLE, reason: "no price history on listing page" };
  } else {
    const prefix = extractJsString(html, "strFormatPrefix");
    const suffix = extractJsString(html, "strFormatSuffix");
    const end = html.indexOf("];", start);
    if (prefix !== "$" || suffix !== "") {
      history = { state: STATES.INVALID, reason: "price history currency could not be verified as USD" };
    } else if (end === -1) {
      history = { state: STATES.INVALID, reason: "price history array not terminated" };
    } else {
      try {
        history = { state: STATES.AVAILABLE, points: aggregateSteamHistory(parseJson(html.slice(start + "var line1=".length, end + 1))) };
      } catch (err) {
        if (err instanceof UpstreamDataError || err instanceof MoneyError) history = { state: STATES.INVALID, reason: err.message };
        else throw err;
      }
    }
  }
  return { item_nameid: itemNameId, history };
}

// line1 rows: ["Sep 01 2026 01: +0", 1.234, "17"] (median sale price, units sold).
// Daily value = volume-weighted mean of the day's rows, integer cents, round-half-up.
export function aggregateSteamHistory(rows) {
  if (!Array.isArray(rows)) throw new UpstreamDataError("price history is not an array");
  const days = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) throw new UpstreamDataError("price history row malformed");
    const [label, price, volText] = row;
    const m = /^([A-Z][a-z]{2}) (\d{2}) (\d{4}) (\d{2}): \+0$/.exec(label);
    if (!m || !(m[1] in MONTHS)) throw new UpstreamDataError("price history date malformed");
    if (typeof price !== "number" || !(price > 0)) throw new UpstreamDataError("price history price not positive");
    if (typeof volText !== "string" || !/^\d+$/.test(volText)) throw new UpstreamDataError("price history volume malformed");
    const date = new Date(Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]))).toISOString().slice(0, 10);
    const cents = majorUnitsToCents(price);
    const vol = Number(volText);
    const d = days.get(date) ?? { weighted: 0, volume: 0 };
    d.weighted += cents * vol;
    d.volume += vol;
    days.set(date, d);
  }
  return [...days.entries()]
    .filter(([, d]) => d.volume > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, d]) => ({ date, price_usd_cents: mulDivRoundHalfUp(d.weighted, 1, d.volume), volume: d.volume }));
}

// itemordershistogram → { lowest, depth } in USD cents.
export function parseSteamHistogram(body) {
  if (!body || typeof body !== "object") throw new UpstreamDataError("histogram body not an object");
  if (body.success !== 1) return { state: STATES.UNAVAILABLE, reason: "Steam histogram success != 1" };
  if ("price_prefix" in body && (body.price_prefix !== "$" || (body.price_suffix ?? "") !== "")) {
    throw new UpstreamDataError("histogram currency is not USD");
  }
  if (body.lowest_sell_order === null || body.lowest_sell_order === undefined) {
    return { state: STATES.UNAVAILABLE, reason: "no active sell listings on Steam" };
  }
  if (typeof body.lowest_sell_order !== "string" || !/^\d+$/.test(body.lowest_sell_order)) {
    throw new UpstreamDataError("lowest_sell_order malformed");
  }
  const lowest = Number(body.lowest_sell_order);
  if (!(lowest > 0)) throw new UpstreamDataError("lowest_sell_order not positive");
  const graph = body.sell_order_graph;
  if (!Array.isArray(graph) || graph.length === 0) throw new UpstreamDataError("sell_order_graph missing");
  let prevPrice = 0;
  let prevQty = 0;
  let depth = 0;
  for (const point of graph) {
    if (!Array.isArray(point) || typeof point[0] !== "number" || !Number.isSafeInteger(point[1])) {
      throw new UpstreamDataError("sell_order_graph point malformed");
    }
    const price = majorUnitsToCents(point[0]);
    const qty = point[1];
    if (price < prevPrice || qty < prevQty || qty < 0) throw new UpstreamDataError("sell_order_graph not monotonic");
    prevPrice = price;
    prevQty = qty;
    if (withinDepthWindow(price, lowest)) depth = qty; // cumulative count
  }
  if (majorUnitsToCents(graph[0][0]) !== lowest) throw new UpstreamDataError("sell_order_graph does not start at lowest_sell_order");
  return { state: STATES.AVAILABLE, lowest, depth };
}

async function steamListingData(item, nowMs, ctx) {
  // One page fetch feeds both the item_nameid cache and the history cache.
  const pageKey = cacheKey("steam", item, "USD", "listing_page");
  return cached(pageKey, (v) => (v.state === "OK" ? TTL_SECONDS.history : TTL_SECONDS.quote), nowMs, ctx, async () => {
    const up = await fetchUpstream(UPSTREAM.steamListing(item), { accept: "text/html" });
    if (up.kind !== "OK") return { state: up.kind, reason: up.reason };
    if (looksRateLimited(up.text)) return { state: STATES.RATE_LIMITED, reason: "Steam rate limit page" };
    const parsed = parseSteamListingPage(up.text);
    if (parsed.item_nameid) {
      await cachePut(cacheKey("steam", item, "USD", "item_nameid"), parsed.item_nameid, TTL_SECONDS.steam_item_nameid, nowMs, ctx);
    }
    return { state: "OK", captured_at: iso(nowMs), ...parsed };
  });
}

async function steamQuote(item, nowMs, ctx) {
  const q = (state, fields = {}) => canonicalQuote({ source: "steam", item, state, nowMs, ttlSec: TTL_SECONDS.quote, ...fields });
  return cached(cacheKey("steam", item, "USD", "quote"), () => TTL_SECONDS.quote, nowMs, ctx, async () => {
    let nameid = await cacheGet(cacheKey("steam", item, "USD", "item_nameid"), nowMs);
    if (!nameid) {
      const page = await steamListingData(item, nowMs, ctx);
      if (page.state !== "OK") return q(page.state, { reason: page.reason });
      nameid = page.item_nameid;
      if (!nameid) return q(STATES.UNAVAILABLE, { reason: "item_nameid not found (unknown item or page format changed)" });
    }
    const up = await fetchUpstream(UPSTREAM.steamHistogram(nameid), { accept: "application/json" });
    if (up.kind !== "OK") return q(up.kind, { reason: up.reason });
    try {
      const h = parseSteamHistogram(parseJson(up.text));
      if (h.state !== STATES.AVAILABLE) return q(h.state, { reason: h.reason });
      return q(STATES.AVAILABLE, {
        price: h.lowest,
        depth: h.depth,
        extras: { listing_depth_basis: "within_10pct_of_lowest", listing_depth_capped: false, price_basis: "lowest sell listing, buyer-pays USD" },
      });
    } catch (err) {
      if (err instanceof UpstreamDataError || err instanceof MoneyError) return q(STATES.INVALID, { reason: err.message });
      throw err;
    }
  });
}

async function steamHistory(item, nowMs, ctx) {
  const key = cacheKey("steam", item, "USD", "history");
  const base = { source: "steam", canonical_item_id: item, currency: "USD" };
  const ttlFor = (v) => (v.state === STATES.AVAILABLE ? TTL_SECONDS.history : TTL_SECONDS.quote);
  return cached(key, ttlFor, nowMs, ctx, async () => {
    const page = await steamListingData(item, nowMs, ctx);
    const meta = { captured_at: page.captured_at ?? iso(nowMs), expires_at: iso(nowMs + TTL_SECONDS.history * 1000) };
    if (page.state !== "OK") return { ...base, ...meta, points: [], state: page.state, reason: page.reason };
    const h = page.history;
    if (h.state !== STATES.AVAILABLE) return { ...base, ...meta, points: [], state: h.state, reason: h.reason };
    return {
      ...base,
      ...meta,
      basis: "daily volume-weighted mean of Steam's reported median sale prices (USD cents)",
      points: h.points,
      state: h.points.length ? STATES.AVAILABLE : STATES.UNAVAILABLE,
      ...(h.points.length ? {} : { reason: "price history empty" }),
    };
  });
}

// ---- Skinport ----------------------------------------------------------------------

// Bulk /v1/items (EUR) → per-item USD-cents map, converted at ingestion with the ECB rate.
export function normalizeSkinportItems(body, fx) {
  if (!Array.isArray(body)) throw new UpstreamDataError("Skinport items body is not an array");
  const items = {};
  for (const it of body) {
    if (!it || typeof it.market_hash_name !== "string") continue;
    const name = it.market_hash_name;
    try {
      if (it.currency !== "EUR") throw new UpstreamDataError("currency is not EUR");
      if (!Number.isSafeInteger(it.quantity) || it.quantity < 0) throw new UpstreamDataError("quantity malformed");
      if (it.min_price === null || it.quantity === 0) {
        items[name] = { state: STATES.UNAVAILABLE, reason: "no active listings on Skinport", total_listings: it.quantity };
        continue;
      }
      if (typeof it.min_price !== "number" || !(it.min_price > 0)) throw new UpstreamDataError("min_price not positive");
      const eurCents = majorUnitsToCents(it.min_price);
      items[name] = { state: STATES.AVAILABLE, price_usd_cents: eurCentsToUsdCents(eurCents, fx.rate_micros), total_listings: it.quantity };
    } catch (err) {
      if (err instanceof UpstreamDataError || err instanceof MoneyError) items[name] = { state: STATES.INVALID, reason: err.message };
      else throw err;
    }
  }
  return items;
}

async function skinportBulk(nowMs, ctx) {
  return cached(cacheKey("skinport", "*", "USD", "items_bulk"), () => TTL_SECONDS.quote, nowMs, ctx, async () => {
    const fx = await getFx(nowMs, ctx);
    const meta = { captured_at: iso(nowMs), fx: { rate_micros: fx.rate_micros, rate_date: fx.rate_date, state: fx.state, source: fx.source } };
    if (fx.state !== STATES.AVAILABLE && fx.state !== STATES.STALE) {
      return { ...meta, state: STATES.UNAVAILABLE, reason: `EUR→USD rate ${fx.state}` };
    }
    const up = await fetchUpstream(UPSTREAM.skinportItems, { accept: "application/json", "accept-encoding": "br" });
    if (up.kind !== "OK") return { ...meta, state: up.kind, reason: up.reason };
    try {
      return { ...meta, state: "OK", items: normalizeSkinportItems(parseJson(up.text), fx) };
    } catch (err) {
      if (err instanceof UpstreamDataError || err instanceof MoneyError) return { ...meta, state: STATES.INVALID, reason: err.message };
      throw err;
    }
  });
}

async function skinportQuote(item, nowMs, ctx) {
  const bulk = await skinportBulk(nowMs, ctx);
  const capturedMs = Date.parse(bulk.captured_at);
  const extras = {
    listing_depth_basis: "unavailable",
    fx_rate_micros: bulk.fx.rate_micros,
    fx_rate_date: bulk.fx.rate_date,
    fx_state: bulk.fx.state,
    fx_source: bulk.fx.source,
  };
  const q = (state, fields = {}) =>
    canonicalQuote({ source: "skinport", item, state, nowMs: capturedMs, ttlSec: TTL_SECONDS.quote, ...fields, extras: { ...extras, ...fields.extras } });
  if (bulk.state !== "OK") return q(bulk.state, { reason: bulk.reason });
  const it = bulk.items[item];
  if (!it) return q(STATES.UNAVAILABLE, { reason: "item not listed on Skinport" });
  if (it.state !== STATES.AVAILABLE) return q(it.state, { reason: it.reason, extras: { total_listings: it.total_listings ?? null } });
  const state = bulk.fx.state === STATES.STALE ? STATES.STALE : STATES.AVAILABLE;
  return q(state, {
    price: it.price_usd_cents,
    // Skinport's public API exposes only a total listing count, not a price distribution,
    // so the ±10% depth metric cannot be measured. Never substitute total_listings.
    depth: null,
    ...(state === STATES.STALE ? { reason: "EUR→USD rate is stale" } : {}),
    extras: { total_listings: it.total_listings, price_basis: "min listing price, EUR converted to USD at ingestion" },
  });
}

// ---- CSFloat -----------------------------------------------------------------------

export function parseCsfloatListings(body, item) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
  if (!list) throw new UpstreamDataError("CSFloat listings body malformed");
  const prices = [];
  for (const l of list) {
    if (!l || typeof l !== "object") throw new UpstreamDataError("CSFloat listing malformed");
    // Canonical identity v1 = exact market_hash_name; anything else is excluded.
    if (!l.item || l.item.market_hash_name !== item) continue;
    if (l.type !== undefined && l.type !== "buy_now") continue;
    if (l.state !== undefined && l.state !== "listed") continue;
    if (!Number.isSafeInteger(l.price) || l.price <= 0) throw new UpstreamDataError("CSFloat listing price malformed");
    prices.push(l.price);
  }
  if (prices.length === 0) return { state: STATES.UNAVAILABLE, reason: "no buy-now listings on CSFloat" };
  const lowest = Math.min(...prices);
  const depth = prices.filter((p) => withinDepthWindow(p, lowest)).length;
  return { state: STATES.AVAILABLE, lowest, depth, capped: list.length >= CSFLOAT_PAGE_LIMIT && depth === prices.length };
}

async function csfloatQuote(item, nowMs, ctx, env) {
  const q = (state, fields = {}) => canonicalQuote({ source: "csfloat", item, state, nowMs, ttlSec: TTL_SECONDS.quote, ...fields });
  const key = typeof env.CSFLOAT_API_KEY === "string" ? env.CSFLOAT_API_KEY.trim() : "";
  if (!key) return q(STATES.NOT_CONFIGURED, { reason: "CSFLOAT_API_KEY is not set on the Worker" });
  return cached(cacheKey("csfloat", item, "USD", "quote"), () => TTL_SECONDS.quote, nowMs, ctx, async () => {
    const up = await fetchUpstream(UPSTREAM.csfloatListings(item), { accept: "application/json", authorization: key });
    if (up.kind !== "OK") return q(up.kind, { reason: up.reason });
    try {
      const r = parseCsfloatListings(parseJson(up.text), item);
      if (r.state !== STATES.AVAILABLE) return q(r.state, { reason: r.reason });
      return q(STATES.AVAILABLE, {
        price: r.lowest,
        depth: r.depth,
        extras: {
          listing_depth_basis: "within_10pct_of_lowest",
          listing_depth_capped: r.capped, // true → depth is a lower bound (first page only)
          price_basis: "lowest buy-now listing, USD",
        },
      });
    } catch (err) {
      if (err instanceof UpstreamDataError || err instanceof MoneyError) return q(STATES.INVALID, { reason: err.message });
      throw err;
    }
  });
}

// ---- HTTP --------------------------------------------------------------------------

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  const list = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) return "*";
  return origin && list.includes(origin) ? origin : null;
}

function respond(body, status, request, env) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-max-age"] = "600";
    if (origin !== "*") headers.vary = "Origin";
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function validItem(raw) {
  if (typeof raw !== "string") return null;
  const item = raw.trim();
  if (item.length === 0 || item.length > MAX_ITEM_LEN) return null;
  if (/[\u0000-\u001f\u007f]/.test(item)) return null; // eslint-disable-line no-control-regex
  return item;
}

export async function handleRequest(request, env = {}, ctx = undefined) {
  try {
    if (request.method === "OPTIONS") return respond(null, 204, request, env);
    if (request.method !== "GET") return respond({ error: "method not allowed; this proxy is read-only" }, 405, request, env);

    const url = new URL(request.url);
    const nowMs = Date.now();

    if (url.pathname === "/api/health") {
      return respond(
        {
          time: iso(nowMs),
          sources: {
            steam: "CONFIGURED",
            skinport: "CONFIGURED",
            csfloat: typeof env.CSFLOAT_API_KEY === "string" && env.CSFLOAT_API_KEY.trim() ? "CONFIGURED" : STATES.NOT_CONFIGURED,
            fx: "CONFIGURED",
          },
          ttl_seconds: TTL_SECONDS,
          upstream_timeout_ms: UPSTREAM_TIMEOUT_MS,
        },
        200,
        request,
        env,
      );
    }

    if (url.pathname === "/api/fx") return respond(await getFx(nowMs, ctx), 200, request, env);

    if (url.pathname === "/api/quote" || url.pathname === "/api/history") {
      const source = url.searchParams.get("source");
      const item = validItem(url.searchParams.get("item"));
      if (!item) return respond({ error: "item must be a market_hash_name of 1–200 printable characters" }, 400, request, env);
      if (url.pathname === "/api/history") {
        if (source !== "steam") return respond({ error: "history is only available for source=steam" }, 400, request, env);
        return respond(await steamHistory(item, nowMs, ctx), 200, request, env);
      }
      if (source === "steam") return respond(await steamQuote(item, nowMs, ctx), 200, request, env);
      if (source === "skinport") return respond(await skinportQuote(item, nowMs, ctx), 200, request, env);
      if (source === "csfloat") return respond(await csfloatQuote(item, nowMs, ctx, env), 200, request, env);
      return respond({ error: "source must be steam, skinport or csfloat" }, 400, request, env);
    }

    return respond({ error: "not found" }, 404, request, env);
  } catch {
    // Deliberately no error detail: messages/stacks could carry upstream or secret material.
    return respond({ error: "internal error" }, 500, request, env);
  }
}
