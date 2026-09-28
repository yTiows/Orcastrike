// Ledger UI: after-the-fact recording only. No control here contacts a marketplace;
// "Record buy/sell" writes the user's own entry to local storage (P0-1).

import { escapeHtml, formatBpsPct, formatCents, formatCountdown, formatIsoUtc } from "../js/format.js";
import { LEDGER_LABEL, allocateFifo } from "../js/ledger.js";
import { dollarsStringToCents, MoneyError, rateToBps } from "../js/money.js";
import { steamFeeComparison } from "../js/research/fee-model.js";
import { stopLossFlag } from "../js/tiers.js";

const MARKETS = [
  ["steam", "Steam"],
  ["csfloat", "CSFloat"],
  ["skinport", "Skinport"],
];
let els = {};

function nowUtcLocalValue() {
  return new Date().toISOString().slice(0, 16);
}

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

function marketOptions() {
  return MARKETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}

function showResult(el, r, okText) {
  el.className = `result ${r.ok ? "ok-text" : "error-text"}`;
  el.innerHTML = r.ok ? escapeHtml(okText) : `<ul>${(r.errors ?? []).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
}

export function mount(root, app) {
  root.innerHTML = `
    <h2>Ledger</h2>
    <p class="banner">${escapeHtml(LEDGER_LABEL)} Stored in this browser only; there is no server backup. Back up daily or export.</p>
    <div id="ledger-load-error"></div>
    <p class="muted" id="ledger-storage"></p>
    <div class="grid-2">
      <form id="f-buy" class="panel form">
        <h3>Record buy <span class="muted">(after you bought elsewhere)</span></h3>
        <label>Item (exact market_hash_name)<input name="item" list="dl-items" required maxlength="200"></label>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Market<select name="market">${marketOptions()}</select></label>
        <label>Price per unit, USD (what you paid)<input name="price" inputmode="decimal" placeholder="12.34" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Paid from<select name="funding"><option value="usd_cash">USD cash</option><option value="steam_wallet">Steam Wallet (Steam buys only)</option></select></label>
        <p class="hint" id="buy-version"></p>
        <button type="submit">Record buy</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-sell" class="panel form">
        <h3>Record sell <span class="muted">(after you sold elsewhere)</span></h3>
        <label>Item<input name="item" list="dl-open" required maxlength="200"></label>
        <p class="hint" id="fifo-hint">FIFO across lots; the last lot may be split.</p>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Market<select name="market">${marketOptions()}</select></label>
        <label>Gross sale price per unit, USD<input name="price" inputmode="decimal" placeholder="15.00" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Skinport fee<select name="schedule"><option value="standard">Standard 8%</option><option value="over_1000eur">≥ €1,000 item 6%</option><option value="private">Private listing 2%</option></select></label>
        <label>CSFloat payout rail<select name="rail"><option value="bank">Bank</option><option value="usdc">USDC</option></select></label>
        <label>Receipt: actual net received, USD <span class="muted">(optional; used only to propose fee calibrations)</span><input name="receipt" inputmode="decimal" placeholder="leave empty if unknown"></label>
        <p class="hint">Steam sales pay into your Steam Wallet, never into USD cash.</p>
        <button type="submit">Record sell</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-cash" class="panel form">
        <h3>USD cash deposit / withdrawal</h3>
        <label>Direction<select name="dir"><option value="in">Deposit</option><option value="out">Withdrawal</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        <label class="check"><input type="checkbox" name="from_banked"> Withdrawal comes out of banked profit</label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Note<input name="note" maxlength="500"></label>
        <button type="submit">Record</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-reserve" class="panel form">
        <h3>Reserved cash (open buy orders)</h3>
        <p class="hint">Earmarks cash for an order you placed on a marketplace. Release it before recording the fill.</p>
        <label>Action<select name="dir"><option value="reserve">Reserve</option><option value="release">Release</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Note<input name="note" maxlength="500" placeholder="e.g. CSFloat buy order #"></label>
        <button type="submit">Record</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-wallet" class="panel form">
        <h3>Steam Wallet adjustment</h3>
        <label>Direction<select name="dir"><option value="in">Add</option><option value="out">Remove</option></select></label>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Note<input name="note" maxlength="500"></label>
        <button type="submit">Record</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-redeploy" class="panel form">
        <h3>Redeploy banked profit</h3>
        <p class="hint">Banked profit only grows automatically. Moving it back into free cash is this explicit action.</p>
        <label>Amount, USD<input name="amount" inputmode="decimal" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <button type="submit">Redeploy</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-incident" class="panel form">
        <h3>Log a reversal incident</h3>
        <p class="hint">Logged for future calibration of the reversal reserve (USER_ASSUMPTION). Nothing is adjusted automatically.</p>
        <label>Trade<select name="trade"></select></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Note<input name="note" maxlength="500"></label>
        <button type="submit">Log incident</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <div class="panel form">
        <h3>Backup</h3>
        <p class="hint" id="backup-state"></p>
        <div class="row-buttons">
          <button type="button" id="btn-backup-dir">Choose daily backup folder</button>
          <button type="button" id="btn-backup-now">Back up now</button>
        </div>
        <button type="button" id="btn-export">Export ledger (checksummed JSON)</button>
        <label>Import ledger (replaces current; checksum verified)<input type="file" id="file-import" accept="application/json,.json"></label>
        <div class="result" id="import-result" aria-live="polite"></div>
      </div>
    </div>
    <datalist id="dl-items"></datalist><datalist id="dl-open"></datalist>
    <section class="panel"><h3>Open lots</h3><div class="table-wrap" id="t-lots"></div></section>
    <section class="panel"><h3>Closed trades <span class="muted">(REAL)</span></h3><div class="table-wrap" id="t-trades"></div></section>
    <section class="panel"><h3>Adjustments and incidents</h3><div class="table-wrap" id="t-adj"></div></section>`;

  els = {
    root,
    loadError: root.querySelector("#ledger-load-error"),
    storage: root.querySelector("#ledger-storage"),
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
    buyVersion: root.querySelector("#buy-version"),
  };
  for (const input of root.querySelectorAll('input[type="datetime-local"]')) input.value = nowUtcLocalValue();

  const bind = (id, handler) => {
    const form = root.querySelector(id);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const out = form.querySelector(".result");
      const r = handler(new FormData(form));
      showResult(out, r.result, r.okText ?? "Recorded.");
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
      canonical_item_id: String(fd.get("item") ?? ""),
      quantity: Number(fd.get("qty")),
      buy_market: fd.get("market"),
      buy_price_cents: price.cents,
      buy_timestamp: ts,
      funding_source: fd.get("funding"),
    });
    return { result: r, okText: r.ok ? `Recorded under ${r.lot.strategy_version}. Transfer-eligible from ${formatIsoUtc(r.lot.minimum_hold_until)}.` : "" };
  });

  bind("#f-sell", (fd) => {
    const price = parseDollars(fd.get("price"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!price.ok) return fail("Price must be dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const receiptText = String(fd.get("receipt") ?? "").trim();
    const receipt = receiptText ? parseDollars(receiptText) : { ok: true, cents: null };
    if (!receipt.ok) return fail("Receipt must be dollars with at most 2 decimals, or empty");
    const r = app.actions.recordSell({
      canonical_item_id: String(fd.get("item") ?? ""),
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
    const dest = t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "USD cash";
    const cb = r.circuit_breaker.tripped ? " CIRCUIT BREAKER TRIPPED: new opportunities are blocked for 24h." : "";
    const split = t.lot_allocations.length > 1 || t.lot_allocations.some((a) => a.quantity !== t.quantity) ? ` FIFO: ${t.lot_allocations.map((a) => a.quantity).join(" + ")} unit(s).` : "";
    let c4 = "";
    if (t.sell_market === "steam") {
      const c = steamFeeComparison(app.feeModels[t.fee_model_version], t.sell_price_cents);
      c4 = ` Per unit: conservative model ${formatCents(c.conservative_net_cents)} (used) vs Valve exact ${c.valve_exact_net_cents === null ? "n/a" : formatCents(c.valve_exact_net_cents)}.`;
    }
    return {
      result: r,
      okText: `Recorded. Net ${formatCents(t.net_sale_proceeds_cents)} → ${dest}; realized ${formatCents(t.realized_net_profit_cents)}; banked ${formatCents(t.banked_allocation_cents)}.${split}${c4}${cb}`,
    };
  });

  const adjust = (kind) => (fd) => {
    const amt = parseDollars(fd.get("amount"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!amt.ok || amt.cents <= 0) return fail("Amount must be positive dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const k = kind === "reserve" ? fd.get("dir") : kind;
    const sign = ["bank_redeploy", "reserve", "release"].includes(k) || fd.get("dir") === "in" ? 1 : -1;
    return {
      result: app.actions.recordAdjustment({
        kind: k,
        amount_cents: sign * amt.cents,
        from_banked: kind === "cash" && fd.get("from_banked") === "on",
        timestamp: ts,
        note: String(fd.get("note") ?? ""),
      }),
    };
  };
  bind("#f-cash", adjust("cash"));
  bind("#f-reserve", adjust("reserve"));
  bind("#f-wallet", adjust("wallet"));
  bind("#f-redeploy", adjust("bank_redeploy"));
  bind("#f-incident", (fd) => {
    const ts = utcInputToIso(fd.get("ts"));
    if (!ts) return fail("Time must be a valid UTC date and time");
    if (!fd.get("trade")) return fail("Choose a trade");
    return { result: app.actions.recordIncident({ trade_id: fd.get("trade"), timestamp: ts, note: String(fd.get("note") ?? "") }), okText: "Incident logged." };
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
    showResult(out, r, `Imported and validated. Checksum: ${r.checksum === "VERIFIED" ? "VERIFIED" : "ABSENT (legacy export without checksum)"}${r.migrated_from ? `; migrated from schema v${r.migrated_from}` : ""}.`);
    e.target.value = "";
    return undefined;
  });

  const updateFifoHint = () => {
    const item = els.sellItem.value.trim();
    const open = (app.lastOpenLots ?? []).filter((l) => l.canonical_item_id === item).sort((a, b) => Date.parse(a.buy_timestamp) - Date.parse(b.buy_timestamp) || a.seq - b.seq);
    if (!item || !open.length) {
      els.fifoHint.textContent = "FIFO across lots; the last lot may be split.";
      return;
    }
    const qty = Number(els.sellQty.value);
    const alloc = Number.isSafeInteger(qty) && qty > 0 ? allocateFifo(open, qty) : null;
    els.fifoHint.textContent =
      `Open lots (oldest first): ${open.map((l) => l.remaining_quantity).join(", ")} (${open.reduce((s, l) => s + l.remaining_quantity, 0)} total). ` +
      (alloc?.ok ? `Selling ${qty} takes ${alloc.allocations.map((a) => a.quantity).join(" + ")}.` : alloc ? "Quantity exceeds open units." : "");
  };
  els.sellItem.addEventListener("input", updateFifoHint);
  els.sellQty.addEventListener("input", updateFifoHint);
  els.updateFifoHint = updateFifoHint;
}

export function update(app, d) {
  els.storage.textContent = `Storage: ${app.storageKind}${app.migration ? ` · migrated from ${app.migration.from} (v${app.migration.schema_from}) at ${app.migration.at}; the original was kept` : ""}${app.storageWarnings.length ? ` · ${app.storageWarnings.join(" · ")}` : ""}`;
  const b0 = app.backup.state;
  els.backupState.textContent = !app.actions.fsaSupported()
    ? "Daily backup: UNVERIFIED in this browser (File System Access API unavailable outside Chromium). Use Export."
    : b0
      ? `Daily backup: ${b0.state}${b0.day ? ` (${b0.day})` : ""}${b0.reason ? ` — ${b0.reason}` : ""}`
      : "Daily backup: not configured.";
  els.buyVersion.textContent = `New lots are tagged with strategy_version ${app.research.opportunities.standard?.strategy_version ?? "unversioned"}; unversioned trades never count as evidence.`;

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
  const lots = b.ok ? b.open_lots : [];
  app.lastOpenLots = lots;
  els.dlItems.innerHTML = app.watchlist.map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.dlOpen.innerHTML = [...new Set(lots.map((l) => l.canonical_item_id))].map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.updateFifoHint();
  const sel = els.incidentTrade.value;
  els.incidentTrade.innerHTML = `<option value="">—</option>${app.ledger.trades
    .map((t) => `<option value="${escapeHtml(t.trade_id)}"${t.trade_id === sel ? " selected" : ""}>${escapeHtml(formatIsoUtc(t.sell_timestamp))} ${escapeHtml(t.canonical_item_id)} ×${t.quantity}</option>`)
    .join("")}`;

  const thresholdBps = rateToBps(app.cfg.STOP_LOSS_FLAG_THRESHOLD);
  const est = new Map((app.research.estimatedExit?.lots ?? []).map((l) => [l.lot_id, l]));
  els.lots.innerHTML = lots.length
    ? `<table><thead><tr><th>Item</th><th>Remaining / bought</th><th>Bought on</th><th>Unit cost</th><th>Open cost</th><th>Bought (UTC)</th><th>Transfer eligible</th><th>Valuation <span class="tag">OBSERVED</span></th><th>Unrealized</th><th>Stop-loss flag</th><th>Stop trigger</th><th>Estimated exit <span class="tag">ESTIMATED</span></th><th>Strategy</th></tr></thead><tbody>${lots
        .map((l) => {
          const v = b.lot_valuations.find((x) => x.lot_id === l.lot_id);
          const cost = l.remaining_quantity * l.buy_price_cents;
          const f = stopLossFlag({ acquisitionCostCents: cost, currentValueCents: v?.state === "OK" ? v.value_cents : null, thresholdBps });
          const cd = formatCountdown(l.minimum_hold_until, d.nowMs);
          const e = est.get(l.lot_id);
          const st = e?.stop_trigger;
          return `<tr>
            <td>${escapeHtml(l.canonical_item_id)}</td><td class="num">${l.remaining_quantity} / ${l.quantity}</td><td>${escapeHtml(l.buy_market)}${l.funding_source === "steam_wallet" ? " (wallet)" : ""}</td>
            <td class="num">${formatCents(l.buy_price_cents)}</td><td class="num">${formatCents(cost)}</td><td>${escapeHtml(formatIsoUtc(l.buy_timestamp))}</td>
            <td>${cd === "eligible" ? "eligible" : `Transfer eligible in ${escapeHtml(cd)}`}</td>
            <td>${v?.state === "OK" ? `${formatCents(v.value_cents)} <span class="muted">(${escapeHtml(v.market)}, depth ${v.listing_depth})</span>` : `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(v?.reason ?? "")}">INSUFFICIENT_DATA</span>`}</td>
            <td class="num">${f.state === "INSUFFICIENT_DATA" ? "—" : formatCents(f.unrealized_pnl_cents)}</td>
            <td>${f.state === "FLAGGED" ? `<span class="status s-THIN_LIQUIDITY">REVIEW</span>` : escapeHtml(f.state)}</td>
            <td>${st ? `<span class="${st.state === "TRIGGERED" ? "status s-BLOCKED_BY_CIRCUIT_BREAKER" : "muted"}" title="${escapeHtml(st.reason ?? "")}">${escapeHtml(st.state)}</span>` : "<span class=\"muted\">no daemon</span>"}</td>
            <td>${e ? (e.state === "ESTIMATED" ? `${formatCents(e.estimated_exit_profit_cents)} <span class="muted">via ${escapeHtml(e.market)}</span>` : `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(e.reason ?? "")}">UNKNOWN</span>`) : "<span class=\"muted\">—</span>"}</td>
            <td class="small">${escapeHtml(l.strategy_version)}</td></tr>`;
        })
        .join("")}</tbody></table><p class="muted">Stop-loss flags and stop triggers are informational only; nothing is ever listed, repriced or sold by this app.</p>`
    : `<p class="muted">No open lots.</p>`;

  const trades = [...app.ledger.trades].sort((x, y) => Date.parse(y.sell_timestamp) - Date.parse(x.sell_timestamp));
  const incidents = new Set((app.ledger.incidents ?? []).map((i) => i.trade_id));
  els.trades.innerHTML = trades.length
    ? `<table><thead><tr><th>Sold (UTC)</th><th>Item</th><th>Qty (lots)</th><th>Market</th><th>Gross</th><th>Sell fee</th><th>Payout fee</th><th>Net proceeds</th><th>Receipt</th><th>Cost</th><th>Realized</th><th>Margin</th><th>Hold</th><th>Banked</th><th>Deployable at close</th><th>Versions</th></tr></thead><tbody>${trades
        .map(
          (t) => `<tr><td>${escapeHtml(formatIsoUtc(t.sell_timestamp))}${incidents.has(t.trade_id) ? ' <span class="status s-BLOCKED_BY_CIRCUIT_BREAKER">REVERSAL</span>' : ""}</td><td>${escapeHtml(t.canonical_item_id)}</td>
          <td class="num">${t.quantity} (${t.lot_allocations.map((a) => a.quantity).join("+")})</td><td>${escapeHtml(t.sell_market)}</td>
          <td class="num">${formatCents(t.gross_sale_cents)}</td><td class="num">${formatCents(t.sell_fee_cents)}</td><td class="num">${formatCents(t.payout_fee_cents)}</td>
          <td class="num">${formatCents(t.net_sale_proceeds_cents)} <span class="muted">→ ${t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "cash"}</span></td>
          <td class="num">${t.receipt_net_cents === null ? "—" : `${formatCents(t.receipt_net_cents)}${t.receipt_net_cents !== t.net_sale_proceeds_cents ? ` <span class="muted">(Δ ${formatCents(t.receipt_net_cents - t.net_sale_proceeds_cents)})</span>` : ""}`}</td>
          <td class="num">${formatCents(t.acquisition_cost_cents)}</td><td class="num ${t.realized_net_profit_cents < 0 ? "neg" : "pos"}">${formatCents(t.realized_net_profit_cents)}</td>
          <td class="num">${formatBpsPct(t.net_margin_bps)}</td><td class="num">${t.hold_duration_hours}h</td><td class="num">${formatCents(t.banked_allocation_cents)}</td>
          <td class="num">${formatCents(t.deployable_capital_at_close_cents)}${t.deployable_capital_complete ? "" : " (lower bound)"}</td>
          <td class="small">${escapeHtml(t.strategy_version)} · ${escapeHtml(t.fee_model_version)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No closed trades.</p>`;

  const kindLabel = (a) => ({ cash: a.from_banked ? "cash (from banked)" : "cash", wallet: "Steam Wallet", bank_redeploy: "banked → free cash", reserve: "reserve cash", release: "release reservation" })[a.kind];
  const adj = [...app.ledger.adjustments].sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp));
  const inc = app.ledger.incidents ?? [];
  els.adj.innerHTML =
    adj.length || inc.length
      ? `<table><thead><tr><th>Time (UTC)</th><th>Kind</th><th>Amount</th><th>Note</th></tr></thead><tbody>${[
          ...adj.map((a) => `<tr><td>${escapeHtml(formatIsoUtc(a.timestamp))}</td><td>${escapeHtml(kindLabel(a))}</td><td class="num">${formatCents(a.amount_cents)}</td><td>${escapeHtml(a.note)}</td></tr>`),
          ...inc.map((i) => `<tr><td>${escapeHtml(formatIsoUtc(i.timestamp))}</td><td>reversal incident</td><td class="num">—</td><td>${escapeHtml(i.note)}</td></tr>`),
        ].join("")}</tbody></table>`
      : `<p class="muted">No adjustments. Record a USD cash deposit to set your starting balance.</p>`;
}
