// App controller: loads state, derives balances/scan results, and routes UI actions to the
// pure modules. Every "record" action writes to the local ledger only (P0-1).

import { WorkerClient } from "./api.js";
import { simulateSingleMarket } from "./backtest.js";
import { validateEventsFile } from "./events.js";
import {
  computeBalances,
  exportLedger,
  importLedger,
  recordAdjustment,
  recordBuy,
  recordSell,
} from "./ledger.js";
import { buildScanContext, quoteKey, scan, valuationFromQuotes } from "./scanner.js";
import * as store from "./state.js";
import { circuitBreakerStatus } from "./tiers.js";
import * as dashboard from "../ui/dashboard.js";
import * as scannerView from "../ui/scanner-table.js";
import * as ledgerView from "../ui/ledger-view.js";
import * as eventsView from "../ui/events-view.js";
import * as settingsView from "../ui/settings-view.js";

const SOURCES = ["steam", "csfloat", "skinport"];
const VIEWS = { dashboard, scanner: scannerView, ledger: ledgerView, events: eventsView, settings: settingsView };

export const app = {
  cfg: null,
  settingsErrors: [],
  overrides: {},
  client: null,
  storageOk: true,
  watchlist: [],
  watchlistErrors: [],
  starter: { items: [], selection_criteria: "" },
  ledger: null,
  ledgerErrors: [],
  ledgerRaw: null,
  quotes: new Map(),
  histories: new Map(),
  sims: new Map(),
  events: { events: [], rejected: [] },
  eventsError: null,
  health: null,
  refreshing: false,
  progress: { done: 0, total: 0 },
  lastRefreshIso: null,
  actions: null,
};

async function loadStatic(path) {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, error: "could not load" };
  }
}

function applySettings() {
  const s = store.loadSettings();
  app.cfg = s.effective;
  app.overrides = s.overrides;
  app.settingsErrors = s.errors;
  app.client = new WorkerClient(app.cfg.WORKER_BASE_URL);
}

export function derive() {
  const nowMs = Date.now();
  const valuation = (id) => valuationFromQuotes(app.quotes, id, nowMs, app.cfg);
  const balances = app.ledger ? computeBalances(app.ledger, { valuation, cfg: app.cfg }) : { ok: false, errors: app.ledgerErrors };
  const breaker = circuitBreakerStatus(store.loadCircuitBreakerTriggeredAt(), nowMs, app.cfg.CIRCUIT_BREAKER_COOLDOWN_HOURS);
  const ctx = buildScanContext({ cfg: app.cfg, balances, circuitBreaker: breaker, nowMs, payoutRail: app.cfg.CSFLOAT_PAYOUT_RAIL });
  const scanResult = scan({ items: app.watchlist, quotes: app.quotes, ctx });
  return { nowMs, balances, breaker, ctx, scanResult, valuation };
}

let renderQueued = false;
export function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const d = derive();
    for (const view of Object.values(VIEWS)) {
      try {
        view.update(app, d);
      } catch (err) {
        console.error("view update failed", err instanceof Error ? err.message : "unknown");
      }
    }
    renderStatusBar(d);
  });
}

function renderStatusBar(d) {
  const el = document.getElementById("status-bar");
  if (!el) return;
  const worker = app.client.configured ? (app.health ? (app.health.ok ? "Worker: online" : `Worker: ${app.health.reason}`) : "Worker: checking…") : "Worker: not configured";
  const csf = app.health?.ok ? `CSFloat: ${app.health.body.sources.csfloat}` : "CSFloat: unknown";
  const cb = `Circuit breaker: ${d.breaker.state}${d.breaker.active && d.breaker.expires_at ? ` until ${d.breaker.expires_at}` : ""}`;
  const refresh = app.refreshing ? `Refreshing ${app.progress.done}/${app.progress.total}` : app.lastRefreshIso ? `Quotes fetched ${app.lastRefreshIso}` : "Quotes not fetched";
  const parts = [worker, csf, cb, refresh, app.storageOk ? null : "Browser storage unavailable — ledger will NOT persist"].filter(Boolean);
  el.replaceChildren(
    ...parts.map((t) => {
      const s = document.createElement("span");
      s.textContent = t;
      if (/breaker: (ACTIVE|INVALID)|not configured|NOT_CONFIGURED|storage unavailable/.test(t)) s.className = "warn";
      return s;
    }),
  );
}

// ---- actions -----------------------------------------------------------------------

export async function refreshQuotes() {
  if (app.refreshing) return;
  app.refreshing = true;
  const heldItems = (app.ledger?.lots ?? []).filter((l) => l.status === "open").map((l) => l.canonical_item_id);
  const items = [...new Set([...app.watchlist, ...heldItems])];
  const jobs = items.flatMap((item) => SOURCES.map((source) => ({ source, item })));
  app.progress = { done: 0, total: jobs.length };
  render();
  app.health = await app.client.health();
  await Promise.all(
    jobs.map(async ({ source, item }) => {
      const q = await app.client.quote(source, item);
      app.quotes.set(quoteKey(source, item), q);
      app.progress.done += 1;
      render();
    }),
  );
  app.refreshing = false;
  app.lastRefreshIso = new Date().toISOString();
  render();
}

export async function loadHistory(item) {
  const h = await app.client.history(item);
  app.histories.set(item, h);
  app.sims.set(item, simulateSingleMarket(h.state === "AVAILABLE" ? h.points : null, { nowMs: Date.now(), cfg: app.cfg }));
  render();
  return h;
}

function commitLedger(next) {
  app.ledger = next;
  if (!store.saveLedger(next)) app.storageOk = false;
}

export function doRecordBuy(input) {
  const r = recordBuy(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg });
  if (r.ok) commitLedger(r.ledger);
  render();
  return r;
}

export function doRecordSell(input) {
  const valuation = derive().valuation;
  const r = recordSell(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg, valuation });
  if (r.ok) {
    commitLedger(r.ledger);
    if (r.circuit_breaker.tripped) store.persistCircuitBreakerTrip(r.circuit_breaker.triggered_at);
  }
  render();
  return r;
}

export function doRecordAdjustment(input) {
  const r = recordAdjustment(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg });
  if (r.ok) commitLedger(r.ledger);
  render();
  return r;
}

export function doExportLedger() {
  const text = exportLedger(app.ledger, { nowIso: new Date().toISOString(), circuitBreakerTriggeredAt: store.loadCircuitBreakerTriggeredAt() });
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `skin-arb-ledger-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function doImportLedger(text) {
  const r = importLedger(text, { cfg: app.cfg });
  if (r.ok) {
    commitLedger(r.ledger);
    app.ledgerErrors = [];
    if (r.circuit_breaker_triggered_at) store.persistCircuitBreakerTrip(r.circuit_breaker_triggered_at);
  }
  render();
  return r;
}

export function doSaveSettings(overrides) {
  const r = store.saveSettings(overrides);
  if (r.ok) {
    applySettings();
    app.health = null;
    if (app.client.configured) app.client.health().then((h) => ((app.health = h), render()));
  }
  render();
  return r;
}

export function doClearInvalidBreaker() {
  const ok = store.clearInvalidCircuitBreaker();
  render();
  return ok;
}

export function doSetWatchlist(items) {
  const n = store.saveWatchlist(items);
  app.watchlist = n.items;
  app.watchlistErrors = n.errors;
  render();
  return n;
}

// ---- boot --------------------------------------------------------------------------

function showTab(name) {
  const tab = VIEWS[name] ? name : "dashboard";
  for (const section of document.querySelectorAll("[data-view]")) section.hidden = section.dataset.view !== tab;
  for (const link of document.querySelectorAll("[data-tab]")) link.setAttribute("aria-current", link.dataset.tab === tab ? "page" : "false");
}

async function boot() {
  app.storageOk = store.storageAvailable();
  applySettings();

  const [starter, events] = await Promise.all([loadStatic("static/watchlist-starter.json"), loadStatic("static/events.json")]);
  if (starter.ok && Array.isArray(starter.value.items)) app.starter = starter.value;
  if (events.ok) app.events = validateEventsFile(events.value);
  else app.eventsError = events.error;

  const wl = store.loadWatchlist(app.starter.items);
  app.watchlist = wl.items;
  app.watchlistErrors = wl.errors;

  const led = store.loadLedger(app.cfg);
  app.ledger = led.ok ? led.ledger : null;
  app.ledgerErrors = led.errors;
  app.ledgerRaw = led.raw ?? null;

  app.actions = {
    refreshQuotes,
    loadHistory,
    recordBuy: doRecordBuy,
    recordSell: doRecordSell,
    recordAdjustment: doRecordAdjustment,
    exportLedger: doExportLedger,
    importLedger: doImportLedger,
    saveSettings: doSaveSettings,
    clearInvalidBreaker: doClearInvalidBreaker,
    setWatchlist: doSetWatchlist,
    render,
  };
  for (const [name, view] of Object.entries(VIEWS)) {
    const root = document.querySelector(`[data-view="${name}"]`);
    try {
      view.mount(root, app);
    } catch (err) {
      // One broken view must not take the others down.
      root.innerHTML = `<p class="error-box">This section failed to load.</p>`;
      console.error(`mount ${name} failed`, err instanceof Error ? err.message : "unknown");
    }
  }
  // Chart.js loads async from the CDN; re-render when (if) it arrives. Its absence never blocks.
  document.getElementById("chartjs")?.addEventListener("load", render);
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  showTab(location.hash.slice(1));
  render();

  if (app.client.configured) {
    app.health = await app.client.health();
    render();
  }
  // Countdowns and breaker expiry are derived from timestamps; re-derive every 30s.
  setInterval(render, 30000);
}

boot();
