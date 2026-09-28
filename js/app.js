// App controller: loads state, derives balances/scan results, and routes UI actions to the
// pure modules. Every "record" action writes to the local ledger only (P0-1). When the UI is
// served by the local daemon, research data (opportunities, evidence, paper trades, quality)
// comes from its same-origin API and the ledger's capital state + REAL trades are synced to it.

import { WorkerClient } from "./api.js";
import { chooseBackupDirectory, dailyBackup, fsaSupported, makeBackup, verifyBackup } from "./backup.js";
import { simulateSingleMarket } from "./backtest.js";
import { DaemonClient } from "./daemon-client.js";
import { validateEventsFile } from "./events.js";
import {
  computeBalances,
  exportLedger,
  importLedger,
  migrateLedger,
  realTradesForSync,
  recordAdjustment,
  recordBuy,
  recordIncident,
  recordSell,
  replayLedger,
  UNVERSIONED,
} from "./ledger.js";
import { calibrate, modelNet } from "./research/fee-calibration.js";
import { BASE_FEE_MODEL, deriveFeeModel } from "./research/fee-model.js";
import { profitFigures } from "./research/profit-figures.js";
import { buildScanContext, quoteKey, scan, valuationFromQuotes } from "./scanner.js";
import * as store from "./state.js";
import { openStorage } from "./storage.js";
import { circuitBreakerStatus } from "./tiers.js";
import * as dashboard from "../ui/dashboard.js";
import * as researchView from "../ui/research-view.js";
import * as scannerView from "../ui/scanner-table.js";
import * as ledgerView from "../ui/ledger-view.js";
import * as eventsView from "../ui/events-view.js";
import * as settingsView from "../ui/settings-view.js";

const SOURCES = ["steam", "csfloat", "skinport"];
const VIEWS = { dashboard, research: researchView, scanner: scannerView, ledger: ledgerView, events: eventsView, settings: settingsView };
const RESEARCH_POLL_MS = 30000;

export const app = {
  cfg: null,
  settingsErrors: [],
  overrides: {},
  client: null,
  storageOk: true,
  storage: null,
  storageKind: "unknown",
  storageWarnings: [],
  migration: null,
  watchlist: [],
  watchlistErrors: [],
  starter: { items: [], selection_criteria: "" },
  ledger: null,
  ledgerErrors: [],
  ledgerRaw: null,
  feeModels: { [BASE_FEE_MODEL.fee_model_version]: BASE_FEE_MODEL },
  feeModelCurrent: BASE_FEE_MODEL.fee_model_version,
  parserVerification: {},
  quotes: new Map(),
  histories: new Map(),
  sims: new Map(),
  events: { events: [], rejected: [] },
  eventsError: null,
  health: null,
  daemon: new DaemonClient(),
  research: { control: null, opportunities: { standard: null, umbra: null }, evidence: null, paper: null, real: null, quality: null, coverage: null, feeModels: null, estimatedExit: null, lastSyncAt: null, syncError: null, lastPollAt: null },
  backup: { state: null },
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
  // Served by the daemon and no Worker configured → the daemon serves the same v1 quote contract.
  const base = app.cfg.WORKER_BASE_URL || (app.daemon.available ? location.origin : "");
  app.client = new WorkerClient(base);
}

export function currentFeeModel() {
  return app.feeModels[app.feeModelCurrent] ?? BASE_FEE_MODEL;
}

function currentVersions() {
  const cycle = app.research.opportunities[app.research.control?.umbra?.active ? "umbra" : "standard"];
  return {
    strategy_version: cycle?.strategy_version ?? UNVERSIONED,
    signal_version: cycle ? "signal-v1" : UNVERSIONED,
  };
}

export function derive() {
  const nowMs = Date.now();
  const parserStatus = app.parserVerification;
  const valuation = (id) => valuationFromQuotes(app.quotes, id, nowMs, app.cfg, parserStatus);
  const balances = app.ledger ? computeBalances(app.ledger, { valuation, cfg: app.cfg, feeModels: app.feeModels }) : { ok: false, errors: app.ledgerErrors };
  const breaker = circuitBreakerStatus(store.loadCircuitBreakerTriggeredAt(), nowMs, app.cfg.CIRCUIT_BREAKER_COOLDOWN_HOURS);
  const ctx = buildScanContext({ cfg: app.cfg, balances, circuitBreaker: breaker, nowMs, payoutRail: app.cfg.CSFLOAT_PAYOUT_RAIL, parserStatus });
  const scanResult = scan({ items: app.watchlist, quotes: app.quotes, ctx });
  const simulatedTrades = [...app.sims.values()].filter((s) => s.state === "OK").flatMap((s) => s.samples_detail ?? []);
  const figures = profitFigures({
    realTrades: app.ledger?.trades ?? [],
    paperTrades: app.daemon.available ? (app.research.paper?.rows ?? []) : null,
    simulatedTrades,
    balances,
    estimatedExit: app.research.estimatedExit,
  });
  const proposals = app.ledger ? calibrationProposals() : [];
  return { nowMs, balances, breaker, ctx, scanResult, valuation, figures, proposals };
}

function calibrationProposals() {
  const model = currentFeeModel();
  const receipts = app.ledger.trades
    .filter((t) => Number.isSafeInteger(t.receipt_net_cents))
    .map((t) => ({
      trade_id: t.trade_id,
      market: t.sell_market,
      quantity: t.quantity,
      gross_sale_cents: t.gross_sale_cents,
      payout_rail: t.payout_rail,
      receipt_net_cents: t.receipt_net_cents,
      computed_net_cents: modelNet(model, { market: t.sell_market, quantity: t.quantity, unitSellPriceCents: t.sell_price_cents, feeSchedule: t.fee_schedule, payoutRail: t.payout_rail }),
    }));
  return calibrate(receipts, model);
}

let renderQueued = false;
export function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const d = derive();
    const umbra = Boolean(app.research.control?.umbra?.active);
    document.documentElement.dataset.mode = umbra ? "umbra" : "standard";
    const unproven = umbra && app.research.control?.umbra?.unproven;
    document.documentElement.dataset.unproven = unproven ? "true" : "false";
    const banner = document.getElementById("umbra-banner");
    if (banner) {
      banner.hidden = !umbra;
      banner.textContent = umbra ? `UMBRA · ranking mode${unproven ? " · UNPROVEN (typed override; SIGNAL_EVIDENCE not passed)" : ""} · no execution` : "";
    }
    const ks = document.getElementById("kill-switch");
    if (ks) {
      const engaged = Boolean(app.research.control?.automation?.kill_switch?.engaged);
      ks.disabled = !app.daemon.available;
      ks.textContent = !app.daemon.available ? "Kill switch (no daemon: nothing to stop)" : engaged ? "Kill switch ENGAGED · release" : "Kill switch";
      ks.classList.toggle("engaged", engaged);
    }
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
  const daemon = app.daemon.available
    ? app.daemon.health?.db?.degraded
      ? "Daemon: DEGRADED (database integrity check failed; read-only, no sampling)"
      : `Daemon: online${app.daemon.health?.synthetic_upstream ? " (SYNTHETIC upstream)" : ""}`
    : "Daemon: not connected (research features off)";
  const worker = app.client.configured ? (app.health ? (app.health.ok ? "Quotes backend: online" : `Quotes backend: ${app.health.reason}`) : "Quotes backend: checking…") : "Quotes backend: not configured";
  const cb = `Circuit breaker: ${d.breaker.state}${d.breaker.active && d.breaker.expires_at ? ` until ${d.breaker.expires_at}` : ""}`;
  const ks = app.research.control?.automation?.kill_switch?.engaged ? "KILL SWITCH ENGAGED" : null;
  const refresh = app.refreshing ? `Refreshing ${app.progress.done}/${app.progress.total}` : app.lastRefreshIso ? `Quotes fetched ${app.lastRefreshIso}` : "Quotes not fetched";
  const storage = `Ledger storage: ${app.storageKind}`;
  const parts = [daemon, worker, cb, ks, refresh, storage, ...app.storageWarnings].filter(Boolean);
  el.replaceChildren(
    ...parts.map((t) => {
      const s = document.createElement("span");
      s.textContent = t;
      if (/breaker: (ACTIVE|INVALID)|not configured|NOT_CONFIGURED|KILL SWITCH|memory|not be|lost|SYNTHETIC|failed/.test(t)) s.className = "warn";
      return s;
    }),
  );
}

// ---- persistence -----------------------------------------------------------------------

async function commitLedger(next) {
  app.ledger = next;
  try {
    await app.storage.set("ledger", next);
  } catch {
    app.storageOk = false;
    app.storageWarnings = [...new Set([...app.storageWarnings, "ledger write failed — export now"])];
  }
  syncLedger();
  maybeDailyBackup();
}

function ledgerExportDoc() {
  return JSON.parse(exportLedger(app.ledger, { nowIso: new Date().toISOString(), circuitBreakerTriggeredAt: store.loadCircuitBreakerTriggeredAt() }));
}

async function maybeDailyBackup(force = false) {
  if (!app.ledger || !app.storage) return;
  app.backup.state = await dailyBackup(app.storage, ledgerExportDoc, new Date().toISOString(), { force });
  render();
}

// ---- daemon research -------------------------------------------------------------------

export async function syncLedger() {
  if (!app.daemon.available || !app.ledger) return;
  const d = derive();
  if (!d.balances.ok) return;
  const b = d.balances;
  const capital = {
    usd_cash_balance_cents: b.usd_cash_balance_cents,
    banked_profit_cents: b.banked_profit_cents,
    reserved_cash_cents: b.reserved_cash_cents,
    open_cost_basis_cents: b.current_open_exposure_cents,
    deployable_capital_cents: b.deployable_capital_cents,
    steam_wallet_balance_cents: b.steam_wallet_balance_cents,
    deployable_capital_complete: b.deployable_capital_complete,
  };
  const breakerAt = store.loadCircuitBreakerTriggeredAt();
  const r = await app.daemon.post("/api/v2/ledger/sync", {
    capital,
    circuit_breaker_triggered_at: breakerAt && !Number.isNaN(Date.parse(breakerAt)) ? breakerAt : null,
    v1_settings: { risk: app.cfg.risk, filters: app.cfg.filters },
    csfloat_payout_rail: app.cfg.CSFLOAT_PAYOUT_RAIL,
    real_trades: realTradesForSync(app.ledger),
  });
  app.research.lastSyncAt = r.ok ? r.body.synced_at : app.research.lastSyncAt;
  app.research.syncError = r.ok ? null : r.error;
  const lots = b.open_lots.map((l) => ({ lot_id: l.lot_id, canonical_item_id: l.canonical_item_id, remaining_quantity: l.remaining_quantity, cost_basis_cents: l.remaining_quantity * l.buy_price_cents }));
  const est = lots.length ? await app.daemon.post("/api/v2/estimated-exit", { lots }) : { ok: true, body: { lots: [] } };
  app.research.estimatedExit = est.ok ? est.body : null;
  render();
}

export async function refreshResearch() {
  if (!app.daemon.available) return;
  const [control, std, umb, evidence, paper, real, quality, coverage, fees, settings] = await Promise.all([
    app.daemon.get("/api/v2/control"),
    app.daemon.get("/api/v2/opportunities?all=1&limit=400"),
    app.daemon.get("/api/v2/opportunities?mode=umbra&all=1&limit=400"),
    app.daemon.get("/api/v2/evidence"),
    app.daemon.get("/api/v2/paper-trades"),
    app.daemon.get("/api/v2/real-trades"),
    app.daemon.get("/api/v2/quality"),
    app.daemon.get("/api/v2/coverage?days=14"),
    app.daemon.get("/api/v2/fee-models"),
    app.daemon.get("/api/v2/settings"),
  ]);
  const r = app.research;
  if (control.ok) r.control = control.body;
  if (std.ok) r.opportunities.standard = std.body;
  if (umb.ok) r.opportunities.umbra = umb.body;
  if (evidence.ok) r.evidence = evidence.body;
  if (paper.ok) r.paper = paper.body;
  if (real.ok) r.real = real.body;
  if (quality.ok) r.quality = quality.body;
  if (coverage.ok) r.coverage = coverage.body;
  if (fees.ok) r.feeModels = fees.body;
  if (settings.ok) r.settings = settings.body;
  r.lastPollAt = new Date().toISOString();
  render();
}

async function daemonAction(path, body) {
  const r = await app.daemon.post(path, body);
  if (r.ok && r.body?.contract === "control@1") app.research.control = r.body;
  await refreshResearch();
  return r;
}

// ---- actions ---------------------------------------------------------------------------

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
  app.sims.set(item, simulateSingleMarket(h.state === "AVAILABLE" ? h.points : null, { nowMs: Date.now(), cfg: app.cfg, detail: true }));
  render();
  return h;
}

export function doRecordBuy(input) {
  const r = recordBuy(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg, feeModels: app.feeModels, strategyVersion: currentVersions().strategy_version });
  if (r.ok) commitLedger(r.ledger);
  render();
  return r;
}

export function doRecordSell(input) {
  const valuation = derive().valuation;
  const parserFor = app.daemon.health?.parser_for_source?.[input.sell_market] ?? UNVERSIONED;
  const r = recordSell(app.ledger, input, {
    nowIso: new Date().toISOString(),
    cfg: app.cfg,
    valuation,
    feeModel: currentFeeModel(),
    feeModels: app.feeModels,
    versions: { signal_version: currentVersions().signal_version, parser_version: parserFor },
  });
  if (r.ok) {
    commitLedger(r.ledger);
    if (r.circuit_breaker.tripped) store.persistCircuitBreakerTrip(r.circuit_breaker.triggered_at);
  }
  render();
  return r;
}

export function doRecordAdjustment(input) {
  const r = recordAdjustment(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg, feeModels: app.feeModels });
  if (r.ok) commitLedger(r.ledger);
  render();
  return r;
}

export function doRecordIncident(input) {
  const r = recordIncident(app.ledger, input, { nowIso: new Date().toISOString(), cfg: app.cfg, feeModels: app.feeModels });
  if (r.ok) commitLedger(r.ledger);
  render();
  return r;
}

export async function doExportLedger() {
  const backup = await makeBackup(ledgerExportDoc(), new Date().toISOString());
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `orcastrike-ledger-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function doImportLedger(text) {
  const v = await verifyBackup(text);
  if (!v.ok) return v;
  const r = importLedger(JSON.stringify(v.payload), { cfg: app.cfg, feeModels: app.feeModels });
  if (r.ok) {
    await commitLedger(r.ledger);
    app.ledgerErrors = [];
    if (r.circuit_breaker_triggered_at) store.persistCircuitBreakerTrip(r.circuit_breaker_triggered_at);
  }
  render();
  return { ...r, checksum: v.checksum };
}

export async function doChooseBackupDir() {
  try {
    app.backup.state = await chooseBackupDirectory(app.storage);
  } catch (err) {
    app.backup.state = { state: "ERROR", reason: err?.message ?? "cancelled" };
  }
  await maybeDailyBackup(true);
}

export async function doAcceptCalibration(proposal) {
  if (!proposal?.proposed_overrides) return { ok: false, errors: ["this proposal has no concrete change to accept"] };
  const next = deriveFeeModel(currentFeeModel(), { overrides: proposal.proposed_overrides, created_at: new Date().toISOString(), source: `user-accepted calibration (${proposal.market}, ${proposal.receipts} receipts)` });
  app.feeModels = { ...app.feeModels, [next.fee_model_version]: next };
  app.feeModelCurrent = next.fee_model_version;
  await app.storage.set("fee_models", app.feeModels);
  await app.storage.set("fee_model_current", app.feeModelCurrent);
  if (app.daemon.available) await app.daemon.post("/api/v2/fee-models/accept", { proposal, confirm: true });
  render();
  return { ok: true, fee_model_version: next.fee_model_version };
}

export function doSaveSettings(overrides) {
  const r = store.saveSettings(overrides);
  if (r.ok) {
    applySettings();
    app.health = null;
    if (app.client.configured) app.client.health().then((h) => ((app.health = h), render()));
    syncLedger();
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
  if (app.daemon.available) app.daemon.post("/api/v2/watchlist", { items: n.items });
  render();
  return n;
}

// ---- boot --------------------------------------------------------------------------

function showTab(name) {
  const tab = VIEWS[name] ? name : "dashboard";
  for (const section of document.querySelectorAll("[data-view]")) section.hidden = section.dataset.view !== tab;
  for (const link of document.querySelectorAll("[data-tab]")) link.setAttribute("aria-current", link.dataset.tab === tab ? "page" : "false");
}

async function loadLedgerFromStorage() {
  const stored = await app.storage.get("ledger");
  if (stored !== undefined) {
    const r = replayLedger(stored, { cfg: app.cfg, feeModels: app.feeModels });
    if (r.ok) return { ok: true, ledger: r.ledger, errors: [] };
    return { ok: false, ledger: null, errors: r.errors, raw: JSON.stringify(stored) };
  }
  // Fallback stores (localStorage/memory) start from the v1 key when present.
  const legacy = store.loadLedger(app.cfg);
  if (!legacy.ok) return legacy;
  return { ok: true, ledger: migrateLedger(legacy.ledger), errors: [] };
}

async function boot() {
  await app.daemon.detect();
  applySettings();

  const opened = await openStorage();
  app.storage = opened.store;
  app.storageKind = opened.store.kind;
  app.storageWarnings = opened.warnings;
  app.migration = opened.migration;
  app.storageOk = opened.store.kind !== "memory";
  const fm = await app.storage.get("fee_models");
  if (fm && typeof fm === "object") app.feeModels = { ...app.feeModels, ...fm };
  app.feeModelCurrent = (await app.storage.get("fee_model_current")) ?? app.feeModelCurrent;

  const [starter, events, pv] = await Promise.all([loadStatic("static/watchlist-starter.json"), loadStatic("static/events.json"), loadStatic("static/parser-verification.json")]);
  if (starter.ok && Array.isArray(starter.value.items)) app.starter = starter.value;
  if (events.ok) app.events = validateEventsFile(events.value);
  else app.eventsError = events.error;
  app.parserVerification = pv.ok && pv.value?.sources ? pv.value.sources : {};

  const wl = store.loadWatchlist(app.starter.items);
  app.watchlist = wl.items;
  app.watchlistErrors = wl.errors;

  const led = await loadLedgerFromStorage();
  app.ledger = led.ok ? led.ledger : null;
  app.ledgerErrors = led.errors;
  app.ledgerRaw = led.raw ?? null;

  app.actions = {
    refreshQuotes,
    loadHistory,
    recordBuy: doRecordBuy,
    recordSell: doRecordSell,
    recordAdjustment: doRecordAdjustment,
    recordIncident: doRecordIncident,
    exportLedger: doExportLedger,
    importLedger: doImportLedger,
    chooseBackupDir: doChooseBackupDir,
    backupNow: () => maybeDailyBackup(true),
    acceptCalibration: doAcceptCalibration,
    saveSettings: doSaveSettings,
    clearInvalidBreaker: doClearInvalidBreaker,
    setWatchlist: doSetWatchlist,
    refreshResearch,
    setMode: (operating) => daemonAction("/api/v2/mode", { operating }),
    activateUmbra: (bankroll_cents, override_phrase, allow_thin) => daemonAction("/api/v2/umbra", { action: "activate", bankroll_cents, override_phrase, allow_thin }),
    deactivateUmbra: () => daemonAction("/api/v2/umbra", { action: "deactivate" }),
    setAutomationLevel: (level) => daemonAction("/api/v2/automation", { level }),
    engageKillSwitch: () => daemonAction("/api/v2/kill-switch", { engaged: true, reason: "manual (UI)" }),
    releaseKillSwitch: () => daemonAction("/api/v2/kill-switch", { engaged: false, confirm: true }),
    saveDaemonSettings: (settings) => daemonAction("/api/v2/settings", { settings }),
    fsaSupported: () => fsaSupported(),
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
  document.getElementById("kill-switch")?.addEventListener("click", async () => {
    if (!app.daemon.available) return;
    if (app.research.control?.automation?.kill_switch?.engaged) {
      if (confirm("Release the kill switch? Staging (and any automation you enabled) can resume.")) await app.actions.releaseKillSwitch();
    } else await app.actions.engageKillSwitch();
  });
  // Chart.js loads async from the CDN; re-render when (if) it arrives. Its absence never blocks.
  document.getElementById("chartjs")?.addEventListener("load", render);
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  showTab(location.hash.slice(1));
  render();

  if (app.client.configured) {
    app.health = await app.client.health();
    render();
  }
  if (app.daemon.available) {
    if (app.watchlist.length) await app.daemon.post("/api/v2/watchlist", { items: app.watchlist });
    await refreshResearch();
    await syncLedger();
    setInterval(refreshResearch, RESEARCH_POLL_MS);
    setInterval(syncLedger, 5 * 60000);
  }
  await maybeDailyBackup();
  // Countdowns and breaker expiry are derived from timestamps; re-derive every 30s.
  setInterval(render, 30000);
}

boot();
