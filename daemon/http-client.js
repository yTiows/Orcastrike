// Raw observation stage: rate-limited upstream GETs. One token bucket per host sized below
// the documented/observed limit; 429 → exponential backoff for that host (no retry of the
// failed request). 8s timeout. Redirects are never followed blindly: each hop is logged, and
// only same-host targets that are not sign-in/consent pages are followed (each hop costs a
// token); anything else is outcome REDIRECT with the target. Request auth headers are never stored or logged; stored
// payloads are sanitized (daemon/contract.js).

import { createHash } from "node:crypto";
import { sanitizeBody } from "./contract.js";
import { redact } from "./redact.js";

export const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MAX_REDIRECTS = 2;
// Redirect targets that mean "sign in / confirm something": never followed, never worked around.
const GATE_PATH = /\/(login|openid|signin|join|agecheck|consent|checkout)(\/|$|\?)/i;

// A redirect is followed only when it stays on the requested host and is not a sign-in,
// age-check or consent page. Returns { follow, target, why }.
export function redirectDecision(fromUrl, location) {
  if (!location) return { follow: false, target: null, why: "redirect without a Location header" };
  let target;
  try {
    target = new URL(location, fromUrl);
  } catch {
    return { follow: false, target: String(location).slice(0, 300), why: "unparseable Location header" };
  }
  const from = new URL(fromUrl);
  if (target.protocol !== "https:" || target.hostname !== from.hostname) return { follow: false, target: target.href, why: `leaves ${from.hostname}` };
  if (GATE_PATH.test(target.pathname)) return { follow: false, target: target.href, why: "sign-in, age-check or consent page" };
  return { follow: true, target: target.href, why: "same host" };
}

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
  constructor({ rateLimits, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
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
    const { synthetic } = resolveUpstream(url, this.env);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    const redirects = [];
    try {
      let current = url;
      let res = await this.fetch(resolveUpstream(current, this.env).url, { method: "GET", headers, signal: ctrl.signal, redirect: "manual" });
      while (res.status >= 300 && res.status < 400) {
        const d = redirectDecision(current, res.headers.get("location"));
        redirects.push({ status: res.status, location: d.target, followed: false, why: d.why });
        this.log("warn", redact(`${endpoint}: HTTP ${res.status} redirect to ${d.target ?? "(none)"} (${d.why})`));
        await res.body?.cancel();
        const fail = (why) => ({
          ...base,
          synthetic,
          received_at: new Date(this.now()).toISOString(),
          elapsed_ms: this.now() - requestedMs,
          http_status: redirects[0].status,
          outcome: "REDIRECT",
          redirects,
          redirect_target: d.target,
          error: redact(`HTTP ${redirects[0].status} redirect to ${d.target ?? "(no Location)"}: not followed (${why})`),
        });
        if (!d.follow) return fail(d.why);
        if (redirects.length > MAX_REDIRECTS) return fail(`more than ${MAX_REDIRECTS} redirects`);
        if (!bucket.tryTake(this.now())) return fail("no rate-limit budget left for another request");
        redirects.at(-1).followed = true;
        current = d.target;
        res = await this.fetch(resolveUpstream(current, this.env).url, { method: "GET", headers, signal: ctrl.signal, redirect: "manual" });
      }
      const text = await res.text();
      const receivedAt = new Date(this.now()).toISOString();
      Object.assign(base, { elapsed_ms: this.now() - requestedMs, ...(redirects.length ? { redirects, final_url: current } : {}) });
      if (res.status === 429) {
        bucket.onRateLimited(this.now());
        return { ...base, synthetic, received_at: receivedAt, http_status: 429, outcome: "RATE_LIMITED", error: "upstream 429" };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ...base, synthetic, received_at: receivedAt, http_status: res.status, outcome: "HTTP_ERROR", error: redact(`upstream HTTP ${res.status}${redirects.length ? ` after redirect to ${current}` : ""}`) };
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
        elapsed_ms: this.now() - requestedMs,
        ...(redirects.length ? { redirects } : {}),
        outcome: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        error: timedOut ? `timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s` : redact(`network error: ${err?.cause?.code ?? err?.name ?? "unknown"}`),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
