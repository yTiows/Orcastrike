// Portfolio (the ledger): after-the-fact recording only. No control here contacts a marketplace;
// "Record a buy/sale" writes your own entry to this browser's storage (P0-1).

import { escapeHtml, formatBpsPct, formatCents, formatCountdown, formatIsoUtc } from "../js/format.js";
import { LEDGER_LABEL, allocateFifo } from "../js/ledger.js";
import { dollarsStringToCents, MoneyError, rateToBps } from "../js/money.js";
import { BASE_FEE_MODEL, steamFeeComparison } from "../js/research/fee-model.js";
import { quoteKey } from "../js/scanner.js";
import { stopLossFlag } from "../js/tiers.js";
import { cents, chip, code, market, stat, tag } from "./components.js";

// C4: Valve's exact fee-on-top result beside the model that was used, for every Steam sale.
function steamC4Note(model, unitGrossCents) {
  const c = steamFeeComparison(model ?? BASE_FEE_MODEL, unitGrossCents);
  const exactUsed = c.default_model === "valve_fee_on_top";
  const exact = c.valve_exact_net_cents === null ? "n/a" : formatCents(c.valve_exact_net_cents);
  return `Per unit: 15%-of-gross ${formatCents(c.conservative_net_cents)}${exactUsed ? "" : " (used)"} vs Valve exact ${exact}${exactUsed ? " (used)" : ""}.`;
}

const MARKETS = [
  ["csfloat", "CSFloat"],
  ["skinport", "Skinport"],
  ["steam", "Steam"],
];
let els = {};

const nowUtcLocalValue = () => new Date().toISOString().slice(0, 16);
// <input type="datetime-local"> has no zone; the form labels it UTC and we treat it so.
function utcInputToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const iso = `${value}:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
function parseDollars(text) {
  try {
    return { ok: true, cents: dollarsStringToCents(String(text).replace(/^\$/, "").trim()) };
  } catch (err) {
    if (err instanceof MoneyError) return { ok: false };
    throw err;
  }
}
const marketOptions = () => MARKETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
const timeField = () => `<label>When (UTC)<span class="row"><input name="ts" type="datetime-local" required><button type="button" class="small ghost" data-now>Now</button></span></label>`;
function showResult(el, r, okText) {
  el.className = `result ${r.ok ? "ok-text" : "error-text"}`;
  el.innerHTML = r.ok ? escapeHtml(okText) : `<ul>${(r.errors ?? []).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
}

const FORMS = {
  buy: `<form id="f-buy" class="card form" data-form="buy">
      <div class="card-head"><h3>Record a buy</h3><span class="muted small">after you bought on a marketplace</span></div>
      <div class="form-grid">
        <label>Item<input name="item" list="dl-items" required maxlength="200" placeholder="AK-47 | Redline (Field-Tested)"></label>
        <label>Bought on<select name="market">${marketOptions()}</select></label>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Price paid per unit, USD<input name="price" inputmode="decimal" placeholder="12.34" required><span class="quickfill" data-quickfill="buy"></span></label>
        ${timeField()}
        <label>Paid from<select name="funding"><option value="usd_cash">USD cash</option><option value="steam_wallet">Steam Wallet (Steam buys only)</option></select></label>
      </div>
      <p class="hint" id="buy-version"></p>
      <div class="row-buttons"><button type="submit" class="primary">Save buy</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  sell: `<form id="f-sell" class="card form" data-form="sell">
      <div class="card-head"><h3>Record a sale</h3><span class="muted small">after you sold on a marketplace</span></div>
      <div class="form-grid">
        <label>Item<input name="item" list="dl-open" required maxlength="200"></label>
        <label>Sold on<select name="market">${marketOptions()}</select></label>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Sale price per unit (before fees), USD<input name="price" inputmode="decimal" placeholder="15.00" required><span class="quickfill" data-quickfill="sell"></span></label>
        ${timeField()}
        <label>Received, USD <span class="hint">optional: what actually arrived; lets the app check its fee model</span><input name="receipt" inputmode="decimal" placeholder="leave empty if unknown"></label>
      </div>
      <p class="hint" id="fifo-hint">Oldest units are sold first (FIFO); a holding can be split.</p>
      <details class="inline"><summary>Fee details</summary><div class="form-grid">
        <label>Skinport fee<select name="schedule"><option value="standard">Standard 8%</option><option value="over_1000eur">Item ≥ €1,000: 6%</option><option value="private">Private listing 2%</option></select></label>
        <label>CSFloat payout<select name="rail"><option value="bank">Bank</option><option value="usdc">USDC</option></select></label>
      </div></details>
      <p class="hint">Steam sales pay into your Steam Wallet, never into cash.</p>
      <div class="row-buttons"><button type="submit" class="primary">Save sale</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  cash: `<form id="f-cash" class="card form" data-form="cash">
      <div class="card-head"><h3>Add or withdraw cash</h3><span class="muted small">your USD trading balance</span></div>
      <div class="form-grid">
        <label>Type<select name="dir"><option value="in">Add (deposit)</option><option value="out">Withdraw</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required placeholder="500.00"></label>
        ${timeField()}
        <label>Note<input name="note" maxlength="500" placeholder="optional"></label>
      </div>
      <label class="check"><input type="checkbox" name="from_banked"> The withdrawal comes out of banked profit</label>
      <div class="row-buttons"><button type="submit" class="primary">Save</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  reserve: `<form id="f-reserve" class="card form" data-form="reserve">
      <div class="card-head"><h3>Reserve cash for an open buy order</h3></div>
      <p class="hint">Sets cash aside for an order you placed on a marketplace. Release it before recording the fill.</p>
      <div class="form-grid">
        <label>Action<select name="dir"><option value="reserve">Reserve</option><option value="release">Release</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        ${timeField()}
        <label>Note<input name="note" maxlength="500" placeholder="e.g. CSFloat buy order #"></label>
      </div>
      <div class="row-buttons"><button type="submit" class="primary">Save</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  wallet: `<form id="f-wallet" class="card form" data-form="wallet">
      <div class="card-head"><h3>Steam Wallet adjustment</h3></div>
      <div class="form-grid">
        <label>Type<select name="dir"><option value="in">Add</option><option value="out">Remove</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        ${timeField()}
        <label>Note<input name="note" maxlength="500"></label>
      </div>
      <div class="row-buttons"><button type="submit" class="primary">Save</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  redeploy: `<form id="f-redeploy" class="card form" data-form="redeploy">
      <div class="card-head"><h3>Move banked profit back to cash</h3></div>
      <p class="hint">Banked profit only grows by itself (30% of profit once capital passes $100). Moving it back is always your explicit choice.</p>
      <div class="form-grid"><label>Amount, USD<input name="amount" inputmode="decimal" required></label>${timeField()}</div>
      <div class="row-buttons"><button type="submit" class="primary">Move to cash</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
  incident: `<form id="f-incident" class="card form" data-form="incident">
      <div class="card-head"><h3>Log a trade reversal</h3></div>
      <p class="hint">Recorded for calibrating the reversal reserve later. Nothing is adjusted automatically.</p>
      <div class="form-grid"><label>Trade<select name="trade"></select></label>${timeField()}<label>Note<input name="note" maxlength="500"></label></div>
      <div class="row-buttons"><button type="submit" class="primary">Log reversal</button></div>
      <div class="result" aria-live="polite"></div>
    </form>`,
};

export function mount(root, app) {
  root.innerHTML = `
    <div class="page-head">
      <div><h2>Portfolio</h2><p>${escapeHtml(LEDGER_LABEL)}</p></div>
      <p class="small muted" id="ledger-storage"></p>
    </div>
    <div id="ledger-load-error"></div>
    <section class="card"><div class="stats" id="pf-stats"></div>
      <details class="inline"><summary>All balances and limits</summary><div class="stats" id="pf-more"></div></details></section>
    <div class="actions-bar" role="group" aria-label="Record">
      <button type="button" class="primary" data-open="buy">Record a buy</button>
      <button type="button" class="primary" data-open="sell">Record a sale</button>
      <button type="button" data-open="cash">Add or withdraw cash</button>
      <button type="button" data-open="reserve">Reserve cash</button>
      <button type="button" data-open="wallet">Steam Wallet</button>
      <button type="button" data-open="redeploy">Banked → cash</button>
      <button type="button" data-open="incident">Log reversal</button>
    </div>
    <div id="pf-forms">${Object.values(FORMS).join("")}</div>
    <datalist id="dl-items"></datalist><datalist id="dl-open"></datalist>
    <section class="card"><div class="card-head"><h3>Holdings</h3><span class="muted small">valued at the lowest qualified cash-market ask ${tag("OBSERVED")}</span></div><div class="table-wrap" id="t-lots"></div></section>
    <section class="card"><div class="card-head"><h3>Sales</h3>${tag("REAL")}</div><div class="table-wrap" id="t-trades"></div></section>
    <details class="section"><summary><span>Cash activity and reversals</span></summary><div class="section-body table-wrap" id="t-adj"></div></details>
    <details class="section" id="pf-backup"><summary><span>Backup and data <span class="muted" id="pf-backup-label"></span></span></summary>
      <div class="section-body form">
        <p class="hint" id="backup-state"></p>
        <div class="row-buttons">
          <button type="button" id="btn-backup-dir">Choose daily backup folder</button>
          <button type="button" id="btn-backup-now">Back up now</button>
          <button type="button" id="btn-export">Export (checksummed JSON)</button>
        </div>
        <label>Import a ledger file (replaces the current one; checksum verified)<input type="file" id="file-import" accept="application/json,.json"></label>
        <div class="result" id="import-result" aria-live="polite"></div>
      </div></details>`;

  els = {
    root,
    loadError: root.querySelector("#ledger-load-error"),
    storage: root.querySelector("#ledger-storage"),
    stats: root.querySelector("#pf-stats"),
    more: root.querySelector("#pf-more"),
    lots: root.querySelector("#t-lots"),
    trades: root.querySelector("#t-trades"),
    adj: root.querySelector("#t-adj"),
    dlItems: root.querySelector("#dl-items"),
    dlOpen: root.querySelector("#dl-open"),
    fifoHint: root.querySelector("#fifo-hint"),
    sellItem: root.querySelector('#f-sell input[name="item"]'),
    sellQty: root.querySelector('#f-sell input[name="qty"]'),
    incidentTrade: root.querySelector('#f-incident select[name="trade"]'),
    backupState: root.querySelector("#backup-state"),
    backupLabel: root.querySelector("#pf-backup-label"),
    buyVersion: root.querySelector("#buy-version"),
    forms: root.querySelectorAll("[data-form]"),
    openers: root.querySelectorAll("[data-open]"),
  };
  for (const input of root.querySelectorAll('input[type="datetime-local"]')) input.value = nowUtcLocalValue();
  showForm(null);
  for (const b of els.openers) b.addEventListener("click", () => showForm(els.current === b.dataset.open ? null : b.dataset.open));
  root.addEventListener("click", (e) => {
    const now = e.target.closest("[data-now]");
    if (now) now.parentElement.querySelector("input").value = nowUtcLocalValue();
    const fill = e.target.closest("[data-fill]");
    if (fill) {
      fill.closest("label").querySelector("input").value = fill.dataset.fill;
      fill.closest("form").querySelector('[name="price"]').dispatchEvent(new Event("input"));
    }
  });
  for (const f of ["#f-buy", "#f-sell"]) {
    const form = root.querySelector(f);
    for (const n of ["item", "market"]) form.querySelector(`[name="${n}"]`).addEventListener("input", () => quickFill(app, form));
    form.querySelector('[name="market"]').addEventListener("change", () => quickFill(app, form));
  }

  const bind = (id, handler) => {
    const form = root.querySelector(id);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const out = form.querySelector(".result");
      const r = handler(new FormData(form));
      showResult(out, r.result, r.okText ?? "Saved.");
      if (r.result.ok) for (const input of form.querySelectorAll('input[type="datetime-local"]')) input.value = nowUtcLocalValue();
    });
  };
  const fail = (msg) => ({ result: { ok: false, errors: [msg] } });

  bind("#f-buy", (fd) => {
    const price = parseDollars(fd.get("price"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!price.ok) return fail("Price must be dollars with at most 2 decimals, e.g. 12.34");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const r = app.actions.recordBuy({
      canonical_item_id: String(fd.get("item") ?? "").trim(),
      quantity: Number(fd.get("qty")),
      buy_market: fd.get("market"),
      buy_price_cents: price.cents,
      buy_timestamp: ts,
      funding_source: fd.get("funding"),
    });
    return { result: r, okText: r.ok ? `Recorded. Tradable from ${formatIsoUtc(r.lot.minimum_hold_until)} (Trade Protection).` : "" };
  });

  bind("#f-sell", (fd) => {
    const price = parseDollars(fd.get("price"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!price.ok) return fail("Price must be dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const receiptText = String(fd.get("receipt") ?? "").trim();
    const receipt = receiptText ? parseDollars(receiptText) : { ok: true, cents: null };
    if (!receipt.ok) return fail("Received amount must be dollars with at most 2 decimals, or empty");
    const r = app.actions.recordSell({
      canonical_item_id: String(fd.get("item") ?? "").trim(),
      quantity: Number(fd.get("qty")),
      sell_market: fd.get("market"),
      sell_price_cents: price.cents,
      sell_timestamp: ts,
      fee_schedule: fd.get("schedule"),
      payout_rail: fd.get("rail"),
      receipt_net_cents: receipt.cents,
    });
    if (!r.ok) return { result: r };
    const t = r.trade;
    const dest = t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "cash";
    const cb = r.circuit_breaker.tripped ? " Daily loss limit reached: new opportunities are paused for 24h." : "";
    const split = t.lot_allocations.length > 1 || t.lot_allocations.some((a) => a.quantity !== t.quantity) ? ` Taken oldest first: ${t.lot_allocations.map((a) => a.quantity).join(" + ")} unit(s).` : "";
    const c4 = t.sell_market === "steam" ? ` ${steamC4Note(app.feeModels[t.fee_model_version], t.sell_price_cents)}` : "";
    return { result: r, okText: `Recorded. ${formatCents(t.net_sale_proceeds_cents)} net to ${dest}; profit ${formatCents(t.realized_net_profit_cents)}; banked ${formatCents(t.banked_allocation_cents)}.${split}${c4}${cb}` };
  });

  const adjust = (kind) => (fd) => {
    const amt = parseDollars(fd.get("amount"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!amt.ok || amt.cents <= 0) return fail("Amount must be positive dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const k = kind === "reserve" ? fd.get("dir") : kind;
    const sign = ["bank_redeploy", "reserve", "release"].includes(k) || fd.get("dir") === "in" ? 1 : -1;
    return { result: app.actions.recordAdjustment({ kind: k, amount_cents: sign * amt.cents, from_banked: kind === "cash" && fd.get("from_banked") === "on", timestamp: ts, note: String(fd.get("note") ?? "") }) };
  };
  bind("#f-cash", adjust("cash"));
  bind("#f-reserve", adjust("reserve"));
  bind("#f-wallet", adjust("wallet"));
  bind("#f-redeploy", adjust("bank_redeploy"));
  bind("#f-incident", (fd) => {
    const ts = utcInputToIso(fd.get("ts"));
    if (!ts) return fail("Time must be a valid UTC date and time");
    if (!fd.get("trade")) return fail("Choose a trade");
    return { result: app.actions.recordIncident({ trade_id: fd.get("trade"), timestamp: ts, note: String(fd.get("note") ?? "") }), okText: "Reversal logged." };
  });

  root.querySelector("#btn-export").addEventListener("click", () => app.actions.exportLedger());
  root.querySelector("#btn-backup-dir").addEventListener("click", () => app.actions.chooseBackupDir());
  root.querySelector("#btn-backup-now").addEventListener("click", () => app.actions.backupNow());
  root.querySelector("#file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const out = root.querySelector("#import-result");
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return showResult(out, { ok: false, errors: ["file larger than 10 MB"] }, "");
    const text = await file.text();
    if (app.ledger && (app.ledger.lots.length || app.ledger.adjustments.length) && !confirm("Replace the current ledger with this file? Export first if unsure.")) {
      e.target.value = "";
      return undefined;
    }
    const r = await app.actions.importLedger(text);
    showResult(out, r, `Imported and validated. Checksum: ${r.checksum === "VERIFIED" ? "VERIFIED" : "ABSENT (older export without checksum)"}${r.migrated_from ? `; upgraded from schema v${r.migrated_from}` : ""}.`);
    e.target.value = "";
    return undefined;
  });

  const updateFifoHint = () => {
    const item = els.sellItem.value.trim();
    const open = (app.lastOpenLots ?? []).filter((l) => l.canonical_item_id === item).sort((a, b) => Date.parse(a.buy_timestamp) - Date.parse(b.buy_timestamp) || a.seq - b.seq);
    if (!item || !open.length) {
      els.fifoHint.textContent = "Oldest units are sold first (FIFO); a holding can be split.";
      return;
    }
    const qty = Number(els.sellQty.value);
    const alloc = Number.isSafeInteger(qty) && qty > 0 ? allocateFifo(open, qty) : null;
    els.fifoHint.textContent = `You hold ${open.reduce((s, l) => s + l.remaining_quantity, 0)} (oldest first: ${open.map((l) => l.remaining_quantity).join(", ")}). ${alloc?.ok ? `Selling ${qty} takes ${alloc.allocations.map((a) => a.quantity).join(" + ")}.` : alloc ? "That's more than you hold." : ""}`;
  };
  els.sellItem.addEventListener("input", updateFifoHint);
  els.sellQty.addEventListener("input", updateFifoHint);
  els.updateFifoHint = updateFifoHint;
  app.actions.onNavigate?.("portfolio", (opts) => opts?.form && showForm(opts.form, true));
}

function showForm(name, focus = false) {
  els.current = name;
  for (const f of els.forms) f.hidden = f.dataset.form !== name;
  for (const b of els.openers) b.setAttribute("aria-pressed", String(b.dataset.open === name));
  if (name && focus) els.root.querySelector(`[data-form="${name}"] input:not([type=hidden])`)?.focus();
}

// Offers the latest observed ask on the chosen market as a one-click fill (never automatic: the
// ledger must hold what you actually paid or received).
function quickFill(app, form) {
  const item = form.querySelector('[name="item"]').value.trim();
  const m = form.querySelector('[name="market"]').value;
  const slot = form.querySelector("[data-quickfill]");
  const q = item ? app.quotes.get(quoteKey(m, item)) : null;
  slot.innerHTML = q?.state === "AVAILABLE" && Number.isSafeInteger(q.price_usd_cents) ? `Current ${market(m)} ask ${formatCents(q.price_usd_cents)} · <button type="button" class="link" data-fill="${(q.price_usd_cents / 100).toFixed(2)}">use it</button>` : "";
}

export function update(app, d) {
  els.storage.textContent = `Storage: ${app.storageKind}${app.migration ? ` · migrated from ${app.migration.from} (v${app.migration.schema_from}) at ${app.migration.at}; the original was kept` : ""}${app.storageWarnings.length ? ` · ${app.storageWarnings.join(" · ")}` : ""}`;
  const b0 = app.backup.state;
  els.backupState.textContent = !app.actions.fsaSupported()
    ? "Daily backup: UNVERIFIED in this browser (the File System Access API exists only in Chromium browsers). Use Export."
    : b0
      ? `Daily backup: ${b0.state}${b0.day ? ` (${b0.day})` : ""}${b0.reason ? `: ${b0.reason}` : ""}`
      : "Daily backup: not configured.";
  els.backupLabel.textContent = ["CHOSEN", "WRITTEN", "SKIPPED_TODAY"].includes(b0?.state) ? "daily backup on" : "daily backup off";
  els.buyVersion.textContent = `Tagged with strategy ${app.research.opportunities.standard?.strategy_version ?? "unversioned"} (unversioned trades never count as evidence).`;

  if (!app.ledger) {
    els.loadError.innerHTML = `<div class="error-box"><strong>The stored ledger failed validation and was not loaded.</strong> Nothing was overwritten.
      <ul>${app.ledgerErrors.slice(0, 20).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      ${app.ledgerRaw ? `<button type="button" id="btn-raw">Download raw stored data</button>` : ""}
      <p>Fix the file and use Import, or clear site data to start over.</p></div>`;
    const raw = els.loadError.querySelector("#btn-raw");
    if (raw) {
      raw.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([app.ledgerRaw], { type: "application/json" }));
        a.download = "orcastrike-ledger-raw.json";
        a.click();
      });
    }
    for (const f of els.root.querySelectorAll("form")) for (const btn of f.querySelectorAll("button")) btn.disabled = true;
    return;
  }
  els.loadError.innerHTML = "";
  for (const f of els.root.querySelectorAll("form")) for (const btn of f.querySelectorAll("button")) btn.disabled = false;

  const b = d.balances;
  const cap = d.ctx.capital;
  const tier = cap?.tier;
  if (b.ok) {
    els.stats.innerHTML = [
      stat("Available cash", formatCents(b.available_cash_cents), "Cash minus banked and reserved"),
      stat("Holdings value", formatCents(b.inventory_value_cents), b.inventory_complete ? "At current qualified asks" : `${b.unvalued_lot_ids.length} holding(s) unvalued`),
      stat("Total capital", formatCents(b.deployable_capital_cents), b.deployable_capital_complete ? "Drives tiers and sizing" : "Lower bound", "emph"),
      stat("Banked profit", formatCents(b.banked_profit_cents), "Part of cash, set aside"),
      stat("Steam Wallet", formatCents(b.steam_wallet_balance_cents), "Not cash", "wallet"),
    ].join("");
    els.more.innerHTML = [
      stat("USD cash balance", formatCents(b.usd_cash_balance_cents), "Includes banked profit"),
      stat("Free cash", formatCents(b.free_cash_cents), "Cash − banked"),
      stat("Reserved cash", formatCents(b.reserved_cash_cents), "For open buy orders"),
      stat("Open exposure", formatCents(b.current_open_exposure_cents), "Cost of holdings"),
      stat("Tier", tier ? `Tier ${tier.tier}` : "None", tier ? `Items ${formatCents(tier.band_min_cents)}–${tier.band_max_cents === null ? "∞" : formatCents(tier.band_max_cents)}` : `Needs ${formatCents(app.cfg.TIERS[0].capital_min_cents)} capital`),
      stat("Max position", cap ? formatCents(cap.position.max_position_size_cents) : "—", "Smallest of your limits"),
      stat("Loss limit", escapeHtml(d.breaker.state), d.breaker.active && d.breaker.expires_at ? `Paused until ${escapeHtml(d.breaker.expires_at)}` : "Daily circuit breaker"),
    ].join("");
  }

  const lots = b.ok ? b.open_lots : [];
  app.lastOpenLots = lots;
  els.dlItems.innerHTML = [...new Set([...app.watchlist, ...lots.map((l) => l.canonical_item_id)])].map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.dlOpen.innerHTML = [...new Set(lots.map((l) => l.canonical_item_id))].map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.updateFifoHint();
  const sel = els.incidentTrade.value;
  els.incidentTrade.innerHTML = `<option value="">Choose a sale</option>${app.ledger.trades
    .map((t) => `<option value="${escapeHtml(t.trade_id)}"${t.trade_id === sel ? " selected" : ""}>${escapeHtml(formatIsoUtc(t.sell_timestamp))} ${escapeHtml(t.canonical_item_id)} ×${t.quantity}</option>`)
    .join("")}`;

  const thresholdBps = rateToBps(app.cfg.STOP_LOSS_FLAG_THRESHOLD);
  const est = new Map((app.research.estimatedExit?.lots ?? []).map((l) => [l.lot_id, l]));
  els.lots.innerHTML = lots.length
    ? `<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Value ${tag("OBSERVED")}</th><th class="num">Unrealized</th><th>Tradable</th><th>Signals</th><th class="num">If sold now ${tag("ESTIMATED")}</th></tr></thead><tbody>${lots
        .map((l) => {
          const v = b.lot_valuations.find((x) => x.lot_id === l.lot_id);
          const cost = l.remaining_quantity * l.buy_price_cents;
          const f = stopLossFlag({ acquisitionCostCents: cost, currentValueCents: v?.state === "OK" ? v.value_cents : null, thresholdBps });
          const cd = formatCountdown(l.minimum_hold_until, d.nowMs);
          const e = est.get(l.lot_id);
          const st = e?.stop_trigger;
          const signals = [f.state === "FLAGGED" ? chip("Down 20%+: review", "warn") : "", st?.state === "TRIGGERED" ? chip("Stop trigger", "bad", st.reason ?? "") : ""].filter(Boolean).join(" ") || `<span class="muted small">${escapeHtml(f.state === "INSUFFICIENT_DATA" ? "no price" : "none")}</span>`;
          return `<tr title="Bought ${escapeHtml(formatIsoUtc(l.buy_timestamp))} on ${escapeHtml(l.buy_market)} · strategy ${escapeHtml(l.strategy_version)}">
            <td class="item">${escapeHtml(l.canonical_item_id)}<div class="small muted">${market(l.buy_market)}${l.funding_source === "steam_wallet" ? " (wallet)" : ""} · ${formatCents(l.buy_price_cents)} each</div></td>
            <td class="num">${l.remaining_quantity}${l.remaining_quantity !== l.quantity ? ` / ${l.quantity}` : ""}</td>
            <td class="num">${formatCents(cost)}</td>
            <td class="num">${v?.state === "OK" ? `${formatCents(v.value_cents)}<div class="small muted">${market(v.market)}, ${v.listing_depth} listings</div>` : `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(v?.reason ?? "")}">INSUFFICIENT_DATA</span>`}</td>
            <td class="num ${f.unrealized_pnl_cents < 0 ? "neg" : f.unrealized_pnl_cents > 0 ? "pos" : ""}">${f.state === "INSUFFICIENT_DATA" ? "—" : formatCents(f.unrealized_pnl_cents)}</td>
            <td>${cd === "eligible" ? chip("now", "ok") : `in ${escapeHtml(cd)}`}</td>
            <td>${signals}</td>
            <td class="num">${e ? (e.state === "ESTIMATED" ? `${formatCents(e.estimated_exit_profit_cents)}<div class="small muted">via ${market(e.market)}</div>` : `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(e.reason ?? "")}">UNKNOWN</span>`) : "—"}</td></tr>`;
        })
        .join("")}</tbody></table><p class="small muted">Signals are information only; nothing is ever listed, repriced or sold by this app.</p>`
    : `<div class="empty"><strong>No holdings</strong>Record a buy after you purchase an item on a marketplace.</div>`;

  const trades = [...app.ledger.trades].sort((x, y) => Date.parse(y.sell_timestamp) - Date.parse(x.sell_timestamp));
  const incidents = new Set((app.ledger.incidents ?? []).map((i) => i.trade_id));
  els.trades.innerHTML = trades.length
    ? `<table><thead><tr><th>Sold</th><th>Item</th><th class="num">Qty</th><th>Market</th><th class="num">Gross</th><th class="num">Fees</th><th class="num">Net received</th><th class="num">Profit</th><th class="num">Margin</th><th>Details</th></tr></thead><tbody>${trades
        .map(
          (t) => `<tr><td>${escapeHtml(formatIsoUtc(t.sell_timestamp))}${incidents.has(t.trade_id) ? ` ${chip("reversal", "bad")}` : ""}</td><td class="item">${escapeHtml(t.canonical_item_id)}</td>
          <td class="num">${t.quantity}${t.lot_allocations.length > 1 ? `<div class="small muted">${t.lot_allocations.map((a) => a.quantity).join("+")}</div>` : ""}</td><td>${escapeHtml(t.sell_market)}</td>
          <td class="num">${formatCents(t.gross_sale_cents)}</td><td class="num">${formatCents(t.sell_fee_cents + t.payout_fee_cents)}</td>
          <td class="num">${formatCents(t.net_sale_proceeds_cents)}<div class="small muted">to ${t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "cash"}</div>${t.receipt_net_cents === null ? "" : `<div class="small muted">received ${formatCents(t.receipt_net_cents)}</div>`}</td>
          <td class="num ${t.realized_net_profit_cents < 0 ? "neg" : "pos"}">${formatCents(t.realized_net_profit_cents)}</td>
          <td class="num">${formatBpsPct(t.net_margin_bps)}</td>
          <td class="small muted">held ${t.hold_duration_hours}h · banked ${formatCents(t.banked_allocation_cents)} · ${code(t.fee_model_version)}${t.sell_market === "steam" ? `<br>${escapeHtml(steamC4Note(app.feeModels[t.fee_model_version], t.sell_price_cents))}` : ""}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<div class="empty"><strong>No sales yet</strong>Sales you record appear here, with fees and profit worked out.</div>`;

  const kindLabel = (a) => ({ cash: a.from_banked ? "cash (from banked)" : "cash", wallet: "Steam Wallet", bank_redeploy: "banked → cash", reserve: "reserved", release: "reservation released" })[a.kind];
  const adj = [...app.ledger.adjustments].sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp));
  const inc = app.ledger.incidents ?? [];
  els.adj.innerHTML =
    adj.length || inc.length
      ? `<table class="compact"><thead><tr><th>When</th><th>What</th><th class="num">Amount</th><th>Note</th></tr></thead><tbody>${[
          ...adj.map((a) => `<tr><td>${escapeHtml(formatIsoUtc(a.timestamp))}</td><td>${escapeHtml(kindLabel(a))}</td><td class="num">${cents(a.amount_cents)}</td><td>${escapeHtml(a.note)}</td></tr>`),
          ...inc.map((i) => `<tr><td>${escapeHtml(formatIsoUtc(i.timestamp))}</td><td>reversal</td><td class="num">—</td><td>${escapeHtml(i.note)}</td></tr>`),
        ].join("")}</tbody></table>`
      : `<p class="muted">Nothing yet. Start with "Add or withdraw cash".</p>`;
}
