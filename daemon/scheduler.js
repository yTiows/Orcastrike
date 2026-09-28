// Sampling scheduler. Builds the job list from tracked items and configured intervals, runs at
// most one in-flight request per rate-limit group, always picks the most overdue job, and lets
// the per-host token bucket (and its 429 backoff) decide when a request may go out. Configured
// intervals are targets; the plan reports when a host's documented capacity makes them
// infeasible, and coverage is measured against the feasible number.

import { ENDPOINTS } from "./sources.js";
import { runJob } from "./pipeline.js";

export function trackedItems(db, settings) {
  const fromSettings = Array.isArray(settings["watchlist.items"]) ? settings["watchlist.items"] : [];
  const fromDb = db.prepare("SELECT market_hash_name FROM items WHERE in_watchlist = 1").all().map((r) => r.market_hash_name);
  return new Set([...fromSettings, ...fromDb].filter((s) => typeof s === "string" && s.trim()).slice(0, 500));
}

export function planJobs({ db, cfg, env, tracked, nowMs }) {
  const jobs = [];
  const add = (job) => jobs.push({ ...job, rateLimit: ENDPOINTS[job.endpoint].rateLimit, interval_s: ENDPOINTS[job.endpoint].interval(cfg) });
  add({ key: "frankfurter_latest", endpoint: "frankfurter_latest", priority: 0 });
  const lastCycle = db.prepare("SELECT max(completed_at) AS t FROM discovery_cycles").get().t;
  const universeCycle = !lastCycle || nowMs - Date.parse(lastCycle) >= cfg.sampling.catalog_s * 1000;
  add({ key: "skinport_items", endpoint: "skinport_items", universeCycle, priority: 1 });
  const names = [...tracked];
  const batch = ENDPOINTS.skinport_sales_history.batchSize;
  for (let i = 0; i < names.length; i += batch) {
    add({ key: `skinport_sales_history|${i / batch}`, endpoint: "skinport_sales_history", items: names.slice(i, i + batch), priority: 2 });
  }
  const hasKey = Boolean((env.CSFLOAT_API_KEY ?? "").trim());
  for (const name of names) {
    const row = db.prepare("SELECT steam_item_nameid FROM items WHERE market_hash_name = ?").get(name);
    const nameid = row?.steam_item_nameid ?? null;
    add({ key: `steam_listing_page|${name}`, endpoint: "steam_listing_page", item: name, priority: nameid ? 3 : 1, urgent: !nameid });
    if (nameid) add({ key: `steam_histogram|${name}`, endpoint: "steam_histogram", item: name, nameid, priority: 2 });
    add({ key: `steam_priceoverview|${name}`, endpoint: "steam_priceoverview", item: name, priority: 3 });
    if (hasKey) add({ key: `csfloat_listings|${name}`, endpoint: "csfloat_listings", item: name, priority: 2 });
  }
  if (!hasKey && names.length) add({ key: "csfloat_listings|__auth_check", endpoint: "csfloat_listings", item: names[0], priority: 9 });
  return jobs;
}

// Per source: requests/day the configuration asks for vs what the rate limit allows.
export function capacityPlan(jobs, cfg) {
  const bySource = {};
  for (const j of jobs) {
    const d = ENDPOINTS[j.endpoint];
    if (d.requiresKey && j.key.endsWith("__auth_check")) continue;
    const rl = cfg.ratelimit[d.rateLimit];
    const s = (bySource[d.source] ??= { demanded_per_day: 0, capacity_per_day: Math.floor((rl.capacity * 86400) / rl.per_seconds), host: rl.host });
    s.demanded_per_day += Math.floor(86400 / j.interval_s);
  }
  for (const s of Object.values(bySource)) s.feasible = s.demanded_per_day <= s.capacity_per_day;
  return bySource;
}

export class Scheduler {
  constructor({ db, client, getCfg, getSettings, env, log, onAfterJob = () => {}, now = () => Date.now() }) {
    Object.assign(this, { db, client, getCfg, getSettings, env, log, onAfterJob, now });
    this.lastRun = new Map();
    this.inflight = new Set();
    this.timer = null;
    this.stats = { runs: 0, deferred: 0 };
  }

  due(jobs, nowMs) {
    return jobs
      .filter((j) => {
        const last = this.lastRun.get(j.key);
        return last === undefined || nowMs - last >= (j.urgent ? 60000 : j.interval_s * 1000);
      })
      .sort((a, b) => a.priority - b.priority || (this.lastRun.get(a.key) ?? 0) - (this.lastRun.get(b.key) ?? 0));
  }

  async tick() {
    const nowMs = this.now();
    const cfg = this.getCfg();
    const tracked = trackedItems(this.db, this.getSettings());
    const jobs = planJobs({ db: this.db, cfg, env: this.env, tracked, nowMs });
    const started = [];
    for (const job of this.due(jobs, nowMs)) {
      if (this.inflight.has(job.rateLimit)) continue;
      this.inflight.add(job.rateLimit);
      this.lastRun.set(job.key, nowMs);
      started.push(
        runJob({ db: this.db, client: this.client, job, cfg, env: this.env, nowMs, tracked, log: this.log })
          .then((r) => {
            this.stats.runs += 1;
            if (r.outcome === "DEFERRED") {
              this.stats.deferred += 1;
              this.lastRun.delete(job.key); // no request went out; try again when tokens refill
            }
            return this.onAfterJob(job, r);
          })
          .catch((err) => this.log("error", `job ${job.key} failed: ${err?.message ?? err}`))
          .finally(() => this.inflight.delete(job.rateLimit)),
      );
    }
    await Promise.all(started);
    return started.length;
  }

  start(intervalMs = 1000) {
    const loop = async () => {
      try {
        await this.tick();
      } finally {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
