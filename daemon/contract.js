// Upstream contracts: the response shape each parser relies on, the parser runners used by
// the live contract test, and payload sanitization. Shapes marked here are ASSUMPTIONS until a
// LIVE fixture proves them (tests/fixtures/live + scripts/contract_test.mjs).
//
// Sanitization: bodies are stored without seller identity (steam ids, avatars, usernames) and
// with any credential-looking key redacted. Request auth headers are never stored.

import { normalizeSkinportItems, parseCsfloatListings, parseFx, parseSteamHistogram, parseSteamListingPage } from "../worker/lib.js";
import { parseSkinportSalesHistory, parseSteamPriceOverview } from "./parsers.js";

// Type descriptors: "string" | "number" | "boolean" | "null" | "object" | "array" or a union
// "number|null"; arrays are written [elementShape]; objects {key: descriptor}.
export const EXPECTED_SHAPES = Object.freeze({
  frankfurter_latest: { base: "string", date: "string", rates: { USD: "number" } },
  steam_priceoverview: { success: "boolean", lowest_price: "string", volume: "string", median_price: "string" },
  steam_histogram: { success: "number", lowest_sell_order: "string|null", sell_order_graph: "array" },
  skinport_items: [{ market_hash_name: "string", currency: "string", min_price: "number|null", quantity: "number" }],
  skinport_sales_history: [
    {
      market_hash_name: "string",
      currency: "string",
      last_7_days: { volume: "number", median: "number|null" },
    },
  ],
  csfloat_listings: [{ id: "string", price: "number", type: "string", item: { market_hash_name: "string" } }],
});

export function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [describeShape(value[0])] : ["empty"];
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeShape(v)]));
  return typeof value;
}

// Only expected paths are checked; extra upstream fields are allowed.
export function diffShape(expected, actual, path = "$", out = { missing: [], type_mismatch: [] }) {
  if (typeof expected === "string") {
    const allowed = expected.split("|");
    const got = typeof actual === "string" ? actual : Array.isArray(actual) ? "array" : actual && typeof actual === "object" ? "object" : String(actual);
    if (!allowed.includes(got)) out.type_mismatch.push({ path, expected, actual: got });
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) out.type_mismatch.push({ path, expected: "array", actual: typeof actual === "string" ? actual : "object" });
    else if (actual[0] !== "empty") diffShape(expected[0], actual[0], `${path}[0]`, out);
    return out;
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    out.type_mismatch.push({ path, expected: "object", actual: Array.isArray(actual) ? "array" : String(actual) });
    return out;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) out.missing.push(`${path}.${k}`);
    else diffShape(v, actual[k], `${path}.${k}`, out);
  }
  return out;
}

const SENSITIVE_KEY = /^(seller|steam_?id|avatar|username|token|secret|api_?key|authorization|cookie|session|email|obfuscated_id)$/i;

export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

function listingPageExcerpt(html) {
  const parts = [];
  const line1Start = html.indexOf("var line1=");
  if (line1Start !== -1) {
    const end = html.indexOf("];", line1Start);
    if (end !== -1) parts.push(html.slice(line1Start, end + 2));
  }
  for (const re of [/var strFormatPrefix\s*=\s*"[^"]*"\s*;/, /var strFormatSuffix\s*=\s*"[^"]*"\s*;/, /Market_LoadOrderSpread\(\s*\d+\s*\)/]) {
    const m = re.exec(html);
    if (m) parts.push(m[0]);
  }
  return parts.join("\n");
}

// Returns { body, notes }. body is what gets stored and what parsers run on.
export function sanitizeBody(endpoint, text, { items = [] } = {}) {
  if (endpoint === "steam_listing_page") {
    const excerpt = listingPageExcerpt(text);
    const id = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(text);
    return {
      body: { html_excerpt: excerpt, extracted: { item_nameid: id ? id[1] : null } },
      notes: ["HTML reduced to the fragments the parser reads (line1, strFormatPrefix/Suffix, Market_LoadOrderSpread); body_sha256 covers the full page"],
    };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { body: { non_json_excerpt: text.slice(0, 500) }, notes: ["body was not JSON; first 500 chars kept"] };
  }
  const notes = ["seller identity and credential-like keys removed"];
  json = redactDeep(json);
  if (endpoint === "skinport_items" && Array.isArray(json)) {
    const subset = json.filter((it) => items.includes(it?.market_hash_name));
    notes.push(`catalog reduced to the ${subset.length} probe item(s); total_count is the full catalog size`);
    return { body: { json: subset, total_count: json.length }, notes };
  }
  if (endpoint === "csfloat_listings") {
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    return { body: { json, first_listing_id: list[0]?.id ?? null }, notes };
  }
  return { body: { json }, notes };
}

// Contract-test runners around the production parsers. Each returns { ok, summary | reason }.
export const PARSERS = Object.freeze({
  frankfurter_latest: {
    version: "frankfurter_latest@1",
    run(body) {
      const r = parseFx(body.json, Date.now());
      return { ok: true, summary: r };
    },
  },
  steam_priceoverview: {
    version: "steam_priceoverview@1",
    run(body) {
      const r = parseSteamPriceOverview(body.json);
      return r.state === "AVAILABLE" ? { ok: true, summary: r } : { ok: false, reason: `${r.state}: ${r.reason}` };
    },
  },
  steam_listing_page: {
    version: "steam_listing_page@1",
    run(body) {
      const r = parseSteamListingPage(body.html_excerpt);
      if (!r.item_nameid) return { ok: false, reason: "item_nameid not found" };
      return { ok: true, summary: { item_nameid: r.item_nameid, history_state: r.history.state, points: r.history.points?.length ?? 0 } };
    },
  },
  steam_histogram: {
    version: "steam_histogram@1",
    run(body) {
      const r = parseSteamHistogram(body.json);
      return r.state === "AVAILABLE" ? { ok: true, summary: r } : { ok: false, reason: `${r.state}: ${r.reason}` };
    },
  },
  skinport_items: {
    version: "skinport_items@1",
    run(body, ctx) {
      if (!Number.isSafeInteger(ctx.fxRateMicros)) return { ok: false, reason: "DEPENDENCY_UNVERIFIED: no live EUR→USD rate in this run" };
      const items = normalizeSkinportItems(body.json, { rate_micros: ctx.fxRateMicros });
      const states = Object.values(items).map((i) => i.state);
      return { ok: states.length > 0 && !states.includes("INVALID"), summary: { items: states.length, states }, reason: "INVALID item(s) or empty subset" };
    },
  },
  skinport_sales_history: {
    version: "skinport_sales_history@1",
    run(body) {
      const r = parseSkinportSalesHistory(body.json);
      const states = Object.values(r).map((x) => x.state);
      return { ok: states.length > 0 && !states.includes("INVALID"), summary: r, reason: "INVALID item(s) or empty" };
    },
  },
  csfloat_listings: {
    version: "csfloat_listings@1",
    run(body, ctx) {
      const r = parseCsfloatListings(body.json, ctx.item);
      return r.state === "AVAILABLE" ? { ok: true, summary: r } : { ok: false, reason: `${r.state}: ${r.reason}` };
    },
  },
});
