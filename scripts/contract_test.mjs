#!/usr/bin/env node
// Live contract test (Phase 0). Calls every upstream endpoint the system depends on,
// stores SANITIZED live responses under tests/fixtures/live/<endpoint>/ with the retrieval
// timestamp, and diffs each response against (a) the shape the parser relies on and (b) the
// parser itself. Nothing here is invented: an unreachable endpoint is recorded as BLOCKED and
// its parser stays UNVERIFIED.
//
// Usage (run where the network allows; the key is optional and read from the environment only):
//   node scripts/contract_test.mjs
//   CSFLOAT_API_KEY=... node scripts/contract_test.mjs
// Exit code: 0 all reachable endpoints PASS, 1 any FAIL, 2 anything BLOCKED/UNVERIFIED.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARSERS, EXPECTED_SHAPES, describeShape, diffShape, sanitizeBody } from "../daemon/contract.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tests", "fixtures", "live");
const TIMEOUT_MS = 15000;
const ITEMS = ["AK-47 | Redline (Field-Tested)", "Revolution Case"];
const COMMAND = "node scripts/contract_test.mjs   # optional: CSFLOAT_API_KEY=... in the environment";

const key = (process.env.CSFLOAT_API_KEY ?? "").trim();
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");

async function get(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "manual" });
    const text = await res.text();
    return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "", text, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "timeout" : `${err?.name ?? "Error"}: ${err?.cause?.code ?? err?.message ?? "network error"}`, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Never persist the request's auth header; the URL of these endpoints carries no secret.
function storeFixture(endpoint, url, res, sanitized, notes) {
  const dir = join(OUT, endpoint);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        fixture_kind: "LIVE",
        endpoint,
        retrieved_at: now.toISOString(),
        request: { url },
        response: { status: res.status, content_type: res.contentType, body_sha256: sha256(res.text), latency_ms: res.ms },
        sanitization: notes,
        body: sanitized,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const results = [];

async function probe(endpoint, url, { headers = {}, parseCtx = {}, requiresKey = false } = {}) {
  if (requiresKey && !key) {
    results.push({ endpoint, status: "UNVERIFIED", reason: "CSFLOAT_API_KEY not set in this environment" });
    return null;
  }
  const res = await get(url, headers);
  if (!res.ok) {
    results.push({ endpoint, status: "BLOCKED", reason: res.error, latency_ms: res.ms });
    return null;
  }
  if (res.status === 429) {
    results.push({ endpoint, status: "UNVERIFIED", reason: "HTTP 429 rate limited; retry later", latency_ms: res.ms });
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    results.push({ endpoint, status: "BLOCKED", reason: `HTTP ${res.status} (upstream or egress proxy)`, latency_ms: res.ms });
    return null;
  }
  const { body, notes } = sanitizeBody(endpoint, res.text, { items: ITEMS });
  const file = storeFixture(endpoint, url, res, body, notes);
  const shapeDiff = EXPECTED_SHAPES[endpoint] ? diffShape(EXPECTED_SHAPES[endpoint], describeShape(body.json ?? body)) : null;
  const parser = PARSERS[endpoint];
  let parse = { status: "NO_PARSER" };
  if (parser) {
    try {
      const out = parser.run(body, parseCtx);
      parse = out.ok ? { status: "PASS", parser_version: parser.version, summary: out.summary } : { status: "FAIL", parser_version: parser.version, reason: out.reason };
    } catch (err) {
      parse = { status: "FAIL", parser_version: parser.version, reason: String(err?.message ?? err) };
    }
  }
  const status = parse.status === "FAIL" || (shapeDiff && shapeDiff.missing.length) ? "FAIL" : parse.status === "PASS" ? "PASS" : "CAPTURED";
  results.push({ endpoint, status, fixture: file.slice(ROOT.length + 1), shape_diff: shapeDiff, parse, latency_ms: res.ms });
  return body;
}

const enc = encodeURIComponent;
const fx = await probe("frankfurter_latest", "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD");
await probe("steam_priceoverview", `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${enc(ITEMS[0])}`);
const page = await probe("steam_listing_page", `https://steamcommunity.com/market/listings/730/${enc(ITEMS[0])}`);
const nameid = page?.extracted?.item_nameid ?? null;
if (nameid) {
  await probe("steam_histogram", `https://steamcommunity.com/market/itemordershistogram?country=US&language=english&currency=1&item_nameid=${nameid}&two_factor=0`);
} else {
  results.push({ endpoint: "steam_histogram", status: page ? "FAIL" : "BLOCKED", reason: page ? "item_nameid not found on listing page" : "depends on steam_listing_page" });
}
// The Skinport parser converts EUR at ingestion, so it can only be exercised with a LIVE rate.
const fxRateMicros = fx ? PARSERS.frankfurter_latest.run(fx).summary?.rate_micros ?? null : null;
await probe("skinport_items", "https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=1", {
  headers: { "accept-encoding": "br" },
  parseCtx: { fxRateMicros },
});
await probe("skinport_sales_history", `https://api.skinport.com/v1/sales/history?app_id=730&currency=EUR&market_hash_name=${enc(ITEMS.join(","))}`, {
  headers: { "accept-encoding": "br" },
});
const csf = await probe("csfloat_listings", `https://csfloat.com/api/v1/listings?market_hash_name=${enc(ITEMS[0])}&sort_by=lowest_price&limit=50&type=buy_now`, {
  headers: { authorization: key },
  requiresKey: true,
  parseCtx: { item: ITEMS[0] },
});
const listingId = csf?.first_listing_id ?? null;
if (listingId) {
  await probe("csfloat_buy_orders", `https://csfloat.com/api/v1/listings/${enc(listingId)}/buy-orders?limit=10`, { headers: { authorization: key }, requiresKey: true });
} else {
  results.push({ endpoint: "csfloat_buy_orders", status: "UNVERIFIED", reason: key ? "no listing id to probe with" : "CSFLOAT_API_KEY not set" });
}
await probe("csfloat_sales_history", `https://csfloat.com/api/v1/history/${enc(ITEMS[0])}/sales`, { headers: { authorization: key }, requiresKey: true });

const report = { run_at: now.toISOString(), command: COMMAND, node: process.version, results };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "CONTRACT_REPORT.json"), `${JSON.stringify(report, null, 2)}\n`);
// Shipped summary for the browser (Level 1 scanner via the Worker): a source's quotes count only
// when its parsers passed on a LIVE fixture in this run.
const status = (ep) => {
  const r = results.find((x) => x.endpoint === ep);
  return r?.status === "PASS" ? "VERIFIED" : r?.status === "BLOCKED" ? "BLOCKED" : "UNVERIFIED";
};
const both = (a, b) => (status(a) === "VERIFIED" && status(b) === "VERIFIED" ? "VERIFIED" : status(a) === "VERIFIED" ? status(b) : status(a));
writeFileSync(
  join(ROOT, "static", "parser-verification.json"),
  `${JSON.stringify(
    {
      generated_at: now.toISOString(),
      generated_by: "scripts/contract_test.mjs",
      sources: {
        steam: both("steam_listing_page", "steam_histogram"),
        csfloat: status("csfloat_listings"),
        skinport: both("skinport_items", "frankfurter_latest"),
      },
    },
    null,
    2,
  )}\n`,
);

for (const r of results) console.log(`${r.status.padEnd(10)} ${r.endpoint.padEnd(24)} ${r.reason ?? r.parse?.status ?? ""}`);
const blocked = results.filter((r) => r.status === "BLOCKED" || r.status === "UNVERIFIED");
const failed = results.filter((r) => r.status === "FAIL");
if (blocked.length) {
  console.log(`\n${blocked.length} endpoint(s) BLOCKED/UNVERIFIED from this machine. Their parsers stay UNVERIFIED.`);
  console.log(`Run locally where the network allows:\n  ${COMMAND}`);
}
process.exit(failed.length ? 1 : blocked.length ? 2 : 0);
