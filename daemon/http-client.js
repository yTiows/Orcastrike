// Raw observation stage: rate-limited upstream GETs. One token bucket per host sized below
// the documented/observed limit; 429 → exponential backoff for that host (no retry of the
// failed request). 8s timeout. Request auth headers are never stored or logged; stored
// payloads are sanitized (daemon/contract.js).

import { createHash } from "node:crypto";
import { sanitizeBody } from "./contract.js";
import { redact } from "./redact.js";

export const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export class TokenBucket {
  constructor({ capacity, per_seconds }, nowMs = Date.now()) {
    this.capacity = capacity;
    this.refillPerMs = capacity / (per_seconds * 1000);
    this.tokens = capacity;
    this.last = nowMs;
    this.blockedUntil = 0;
    this.backoffMs = 0;
  }

  refill(nowMs) {
    this.tokens = Math.min(this.capacity, this.tokens + (nowMs - this.last) * this.refillPerMs);
    this.last = nowMs;
  }

  tryTake(nowMs) {
    if (nowMs < this.blockedUntil) return false;
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // Host said 429: stop using it for an exponentially growing period.
  onRateLimited(nowMs) {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : 60000);
    this.blockedUntil = nowMs + this.backoffMs;
    this.tokens = 0;
  }

  onSuccess() {
    this.backoffMs = 0;
  }
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Test-only redirection of upstream hosts to a local SYNTHETIC server. Refused unless the
// target is loopback AND ORCASTRIKE_SYNTHETIC=1, and everything recorded is flagged synthetic.
export function resolveUpstream(url, env = process.env) {
  const override = env.ORCASTRIKE_UPSTREAM_OVERRIDE;
  if (!override) return { url, synthetic: false };
  const o = new URL(override);
  if (env.ORCASTRIKE_SYNTHETIC !== "1" || !["127.0.0.1", "localhost"].includes(o.hostname)) {
    throw new Error("ORCASTRIKE_UPSTREAM_OVERRIDE requires ORCASTRIKE_SYNTHETIC=1 and a loopback host");
  }
  const u = new URL(url);
  return { url: `${o.origin}/${u.hostname}${u.pathname}${u.search}`, synthetic: true };
}

export class UpstreamClient {
  constructor({ rateLimits, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.buckets = new Map();
    for (const rl of Object.values(rateLimits)) this.buckets.set(rl.host, new TokenBucket(rl, now()));
  }

  bucketFor(host) {
    if (!this.buckets.has(host)) this.buckets.set(host, new TokenBucket({ capacity: 5, per_seconds: 60 }, this.now()));
    return this.buckets.get(host);
  }

  canRequest(url) {
    const b = this.bucketFor(new URL(url).hostname);
    b.refill(this.now());
    return this.now() >= b.blockedUntil && b.tokens >= 1;
  }

  // Returns a raw observation. Never throws for upstream problems; outcome says what happened.
  async get(endpoint, url, { headers = {}, items = [] } = {}) {
    const host = new URL(url).hostname;
    const bucket = this.bucketFor(host);
    const requestedMs = this.now();
    const base = { endpoint, url_host: host, requested_at: new Date(requestedMs).toISOString() };
    if (!bucket.tryTake(requestedMs)) return { ...base, outcome: "RATE_LIMITED", local: true, error: "local token bucket empty or host in backoff" };
    const { url: target, synthetic } = resolveUpstream(url, this.env);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await this.fetch(target, { method: "GET", headers, signal: ctrl.signal, redirect: "manual" });
      const text = await res.text();
      const receivedAt = new Date(this.now()).toISOString();
      if (res.status === 429) {
        bucket.onRateLimited(this.now());
        return { ...base, synthetic, received_at: receivedAt, http_status: 429, outcome: "RATE_LIMITED", error: "upstream 429" };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ...base, synthetic, received_at: receivedAt, http_status: res.status, outcome: "HTTP_ERROR", error: `upstream HTTP ${res.status}` };
      }
      bucket.onSuccess();
      const { body, notes } = sanitizeBody(endpoint, text, { items });
      return {
        ...base,
        synthetic,
        received_at: receivedAt,
        http_status: res.status,
        outcome: "OK",
        response_hash: sha256(text),
        text,
        sanitized: body,
        sanitization_notes: notes,
      };
    } catch (err) {
      const timedOut = err?.name === "AbortError";
      return {
        ...base,
        synthetic,
        received_at: new Date(this.now()).toISOString(),
        outcome: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        error: timedOut ? `timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s` : redact(`network error: ${err?.cause?.code ?? err?.name ?? "unknown"}`),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
