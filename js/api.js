// Worker client. The browser talks only to our Worker (never to upstream markets and
// never with credentials). Failures become explicit states, never placeholder numbers.

const CLIENT_TIMEOUT_MS = 20000;

// Per-source pacing: Steam market endpoints rate-limit aggressively, so one request at a
// time with spacing; Skinport is served from the Worker's bulk cache.
const PACING = Object.freeze({
  steam: { concurrency: 1, minIntervalMs: 1500 },
  csfloat: { concurrency: 2, minIntervalMs: 250 },
  skinport: { concurrency: 4, minIntervalMs: 0 },
  history: { concurrency: 1, minIntervalMs: 1500 },
  default: { concurrency: 2, minIntervalMs: 0 },
});

class Lane {
  constructor({ concurrency, minIntervalMs }) {
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) {
      setTimeout(() => this.pump(), wait);
      return;
    }
    const { task, resolve, reject } = this.queue.shift();
    this.active += 1;
    this.lastStart = Date.now();
    task()
      .then(resolve, reject)
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
    this.pump();
  }
}

function localStateQuote(source, item, state, reason) {
  const now = new Date().toISOString();
  return {
    source,
    canonical_item_id: item,
    price_usd_cents: null,
    listing_depth: null,
    captured_at: now,
    expires_at: now,
    state,
    reason,
  };
}

export class WorkerClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || "";
    this.lanes = new Map();
  }

  get configured() {
    return this.baseUrl !== "";
  }

  lane(name) {
    if (!this.lanes.has(name)) this.lanes.set(name, new Lane(PACING[name] ?? PACING.default));
    return this.lanes.get(name);
  }

  async getJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { method: "GET", signal: ctrl.signal, credentials: "omit", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") return { ok: false, reason: `Worker returned non-JSON (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, reason: body.error ? `Worker: ${String(body.error)}` : `Worker HTTP ${res.status}` };
      return { ok: true, body };
    } catch (err) {
      return { ok: false, reason: err && err.name === "AbortError" ? "Worker request timed out" : "Worker unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    if (!this.configured) return { ok: false, reason: "Worker URL not set (Settings)" };
    return this.getJson("/api/health");
  }

  async quote(source, item) {
    if (!this.configured) return localStateQuote(source, item, "NOT_CONFIGURED", "Worker URL not set (Settings)");
    const r = await this.lane(source).run(() =>
      this.getJson(`/api/quote?source=${encodeURIComponent(source)}&item=${encodeURIComponent(item)}`),
    );
    if (!r.ok) return localStateQuote(source, item, "UNAVAILABLE", r.reason);
    if (r.body.source !== source || r.body.canonical_item_id !== item) {
      return localStateQuote(source, item, "INVALID", "Worker response does not match the requested source/item");
    }
    return r.body;
  }

  async history(item) {
    if (!this.configured) return { state: "NOT_CONFIGURED", reason: "Worker URL not set (Settings)", points: [] };
    const r = await this.lane("history").run(() => this.getJson(`/api/history?source=steam&item=${encodeURIComponent(item)}`));
    if (!r.ok) return { state: "UNAVAILABLE", reason: r.reason, points: [] };
    if (r.body.canonical_item_id !== item || !Array.isArray(r.body.points)) {
      return { state: "INVALID", reason: "Worker history response malformed", points: [] };
    }
    return r.body;
  }
}
