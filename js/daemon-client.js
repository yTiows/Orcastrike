// Client for the local daemon's JSON contract. Only used when the UI is served by the daemon
// (same origin); the Pages build has no daemon and every research panel says so.

const TIMEOUT_MS = 15000;

async function call(path, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal, credentials: "same-origin", cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: body?.error ?? (body?.errors ?? []).join("; ") ?? `HTTP ${res.status}`, body };
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === "AbortError" ? "daemon request timed out" : "daemon unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export class DaemonClient {
  constructor() {
    this.available = false;
    this.health = null;
  }

  async detect() {
    const r = await call("/api/v2/health");
    this.available = r.ok && r.body?.contract === "orcastrike-daemon-api@1";
    this.health = this.available ? r.body : null;
    return this.available;
  }

  get(path) {
    return call(path);
  }

  post(path, body) {
    return call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
}
