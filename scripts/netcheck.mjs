#!/usr/bin/env node
// Daemon placement measurement. Run on each candidate host (local machine, VPS) and compare.
// Per source host: DNS time, HTTP status and latency over a few samples spaced to stay far
// below every documented rate limit (default 4 samples, 5s apart = 12 requests/min total).
// Writes reports/netcheck/<timestamp>.json. Never prints proxy URLs or credentials.
//
//   node scripts/netcheck.mjs            # 4 samples per host
//   node scripts/netcheck.mjs --samples 2
import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argSamples = process.argv.indexOf("--samples");
const SAMPLES = argSamples > -1 ? Math.max(1, Math.min(10, Number(process.argv[argSamples + 1]) || 4)) : 4;
const SPACING_MS = 5000;

const TARGETS = [
  { source: "steam", url: "https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=Revolution%20Case" },
  { source: "skinport", url: "https://api.skinport.com/v1/sales/history?app_id=730&currency=EUR&market_hash_name=Revolution%20Case", headers: { "accept-encoding": "br" } },
  { source: "csfloat", url: "https://csfloat.com/api/v1/listings?limit=1" }, // unauthenticated: 401/403 still proves reachability
  { source: "frankfurter", url: "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1)] : null);

async function sample(t) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(t.url, { headers: t.headers ?? {}, signal: ctrl.signal, redirect: "manual" });
    await res.arrayBuffer();
    return { status: res.status, ms: Date.now() - started, ratelimit_remaining: res.headers.get("x-ratelimit-remaining") };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: err?.name === "AbortError" ? "timeout" : err?.cause?.code ?? err?.name ?? "error" };
  } finally {
    clearTimeout(timer);
  }
}

const report = {
  measured_at: new Date().toISOString(),
  host_label: process.env.NETCHECK_LABEL ?? hostname(),
  platform: platform(),
  node: process.version,
  egress_proxy_configured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
  samples_per_target: SAMPLES,
  targets: [],
};

for (const t of TARGETS) {
  const host = new URL(t.url).hostname;
  let dns;
  const d0 = Date.now();
  try {
    const r = await lookup(host);
    dns = { ok: true, ms: Date.now() - d0, family: r.family };
  } catch (err) {
    dns = { ok: false, ms: Date.now() - d0, error: err?.code ?? "error" };
  }
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    samples.push(await sample(t));
    if (i < SAMPLES - 1) await sleep(SPACING_MS);
  }
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const statuses = samples.reduce((m, s) => ((m[s.status] = (m[s.status] ?? 0) + 1), m), {});
  const reachable = t.source === "csfloat" ? samples.some((s) => [200, 401, 403].includes(s.status)) && !samples.every((s) => s.status === 403) : ok.length === samples.length;
  report.targets.push({
    source: t.source,
    host,
    dns,
    statuses,
    latency_ms_p50: pct(samples.map((s) => s.ms), 0.5),
    latency_ms_p90: pct(samples.map((s) => s.ms), 0.9),
    rate_limited: samples.some((s) => s.status === 429),
    verdict: reachable ? "REACHABLE" : "BLOCKED",
  });
}

report.placement_verdict = report.targets.every((t) => t.verdict === "REACHABLE" && !t.rate_limited)
  ? "SUITABLE: every source reachable, no 429 in samples"
  : `UNSUITABLE: ${report.targets.filter((t) => t.verdict !== "REACHABLE" || t.rate_limited).map((t) => t.source).join(", ")} not cleanly reachable`;

const dir = join(ROOT, "reports", "netcheck");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${report.measured_at.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
for (const t of report.targets) console.log(`${t.verdict.padEnd(9)} ${t.source.padEnd(12)} statuses=${JSON.stringify(t.statuses)} p50=${t.latency_ms_p50}ms`);
console.log(report.placement_verdict);
console.log(`report: ${file.slice(ROOT.length + 1)}`);
