// Ledger UI: after-the-fact recording only. No control here contacts a marketplace;
// "Record buy/sell" writes the user's own entry to local storage (P0-1).

import { escapeHtml, formatBpsPct, formatCents, formatCountdown, formatIsoUtc } from "../js/format.js";
import { LEDGER_LABEL, selectFifoLots } from "../js/ledger.js";
import { dollarsStringToCents, MoneyError, rateToBps } from "../js/money.js";
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
  el.innerHTML = r.ok ? escapeHtml(okText) : `<ul>${r.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
}

export function mount(root, app) {
  root.innerHTML = `
    <h2>Ledger</h2>
    <p class="banner">${escapeHtml(LEDGER_LABEL)} Stored only in this browser — export regularly; there is no server backup.</p>
    <div id="ledger-load-error"></div>
    <div class="grid-2">
      <form id="f-buy" class="panel form">
        <h3>Record buy <span class="muted">(after you bought elsewhere)</span></h3>
        <label>Item (exact market_hash_name)<input name="item" list="dl-items" required maxlength="200"></label>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Market<select name="market">${marketOptions()}</select></label>
        <label>Price per unit, USD (what you paid)<input name="price" inputmode="decimal" placeholder="12.34" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Paid from<select name="funding"><option value="usd_cash">USD cash</option><option value="steam_wallet">Steam Wallet (Steam buys only)</option></select></label>
        <button type="submit">Record buy</button>
        <div class="result" aria-live="polite"></div>
      </form>
      <form id="f-sell" class="panel form">
        <h3>Record sell <span class="muted">(after you sold elsewhere)</span></h3>
        <label>Item<input name="item" list="dl-open" required maxlength="200"></label>
        <p class="hint" id="fifo-hint">FIFO, whole lots only.</p>
        <label>Quantity<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label>Market<select name="market">${marketOptions()}</select></label>
        <label>Gross sale price per unit, USD<input name="price" inputmode="decimal" placeholder="15.00" required></label>
        <label>Time (UTC)<input name="ts" type="datetime-local" required></label>
        <label>Skinport fee<select name="schedule"><option value="standard">Standard 8%</option><option value="over_1000eur">≥ €1,000 item 6%</option><option value="private">Private listing 2%</option></select></label>
        <label>CSFloat payout rail<select name="rail"><option value="bank">Bank</option><option value="usdc">USDC</option></select></label>
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
      <div class="panel form">
        <h3>Backup</h3>
        <button type="button" id="btn-export">Export ledger (JSON)</button>
        <label>Import ledger (replaces current)<input type="file" id="file-import" accept="application/json,.json"></label>
        <div class="result" id="import-result" aria-live="polite"></div>
      </div>
    </div>
    <datalist id="dl-items"></datalist><datalist id="dl-open"></datalist>
    <section class="panel"><h3>Open lots</h3><div class="table-wrap" id="t-lots"></div></section>
    <section class="panel"><h3>Closed trades</h3><div class="table-wrap" id="t-trades"></div></section>
    <section class="panel"><h3>Adjustments</h3><div class="table-wrap" id="t-adj"></div></section>`;

  els = {
    root,
    loadError: root.querySelector("#ledger-load-error"),
    lots: root.querySelector("#t-lots"),
    trades: root.querySelector("#t-trades"),
    adj: root.querySelector("#t-adj"),
    dlItems: root.querySelector("#dl-items"),
    dlOpen: root.querySelector("#dl-open"),
    fifoHint: root.querySelector("#fifo-hint"),
    sellItem: root.querySelector('#f-sell input[name="item"]'),
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
    return { result: r, okText: r.ok ? `Recorded. Transfer-eligible from ${formatIsoUtc(r.lot.minimum_hold_until)}.` : "" };
  });

  bind("#f-sell", (fd) => {
    const price = parseDollars(fd.get("price"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!price.ok) return fail("Price must be dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const r = app.actions.recordSell({
      canonical_item_id: String(fd.get("item") ?? ""),
      quantity: Number(fd.get("qty")),
      sell_market: fd.get("market"),
      sell_price_cents: price.cents,
      sell_timestamp: ts,
      fee_schedule: fd.get("schedule"),
      payout_rail: fd.get("rail"),
    });
    if (!r.ok) return { result: r };
    const t = r.trade;
    const dest = t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "USD cash";
    const cb = r.circuit_breaker.tripped ? " CIRCUIT BREAKER TRIPPED: new opportunities are blocked for 24h." : "";
    return {
      result: r,
      okText: `Recorded. Net ${formatCents(t.net_sale_proceeds_cents)} → ${dest}; realized ${formatCents(t.realized_net_profit_cents)}; banked ${formatCents(t.banked_allocation_cents)}.${cb}`,
    };
  });

  const adjust = (kind) => (fd) => {
    const amt = parseDollars(fd.get("amount"));
    const ts = utcInputToIso(fd.get("ts"));
    if (!amt.ok || amt.cents <= 0) return fail("Amount must be positive dollars with at most 2 decimals");
    if (!ts) return fail("Time must be a valid UTC date and time");
    const sign = kind === "bank_redeploy" || fd.get("dir") === "in" ? 1 : -1;
    return {
      result: app.actions.recordAdjustment({
        kind,
        amount_cents: sign * amt.cents,
        from_banked: kind === "cash" && fd.get("from_banked") === "on",
        timestamp: ts,
        note: String(fd.get("note") ?? ""),
      }),
    };
  };
  bind("#f-cash", adjust("cash"));
  bind("#f-wallet", adjust("wallet"));
  bind("#f-redeploy", adjust("bank_redeploy"));

  root.querySelector("#btn-export").addEventListener("click", () => app.actions.exportLedger());
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
    const r = app.actions.importLedger(text);
    showResult(out, r, "Imported and validated.");
    e.target.value = "";
    return undefined;
  });

  const updateFifoHint = () => {
    const item = els.sellItem.value.trim();
    const open = (app.ledger?.lots ?? [])
      .filter((l) => l.status === "open" && l.canonical_item_id === item)
      .sort((a, b) => Date.parse(a.buy_timestamp) - Date.parse(b.buy_timestamp) || a.seq - b.seq);
    if (!item || !open.length) {
      els.fifoHint.textContent = "FIFO, whole lots only. Partial-lot sales are not supported in v1.";
      return;
    }
    const { validQuantities } = selectFifoLots(open, -1);
    els.fifoHint.textContent = `Open lots (oldest first): ${open.map((l) => l.quantity).join(", ")}. Valid sale quantities: ${validQuantities.join(", ")}.`;
  };
  els.sellItem.addEventListener("input", updateFifoHint);
  els.updateFifoHint = updateFifoHint;
}

export function update(app, d) {
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
        a.download = "skin-arb-ledger-raw.json";
        a.click();
      });
    }
    for (const f of els.root.querySelectorAll("form")) for (const b of f.querySelectorAll("button")) b.disabled = true;
    return;
  }
  els.loadError.innerHTML = "";
  for (const f of els.root.querySelectorAll("form")) for (const b of f.querySelectorAll("button")) b.disabled = false;

  const b = d.balances;
  const lots = b.ok ? b.open_lots : [];
  els.dlItems.innerHTML = app.watchlist.map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.dlOpen.innerHTML = [...new Set(lots.map((l) => l.canonical_item_id))].map((i) => `<option value="${escapeHtml(i)}">`).join("");
  els.updateFifoHint();

  const thresholdBps = rateToBps(app.cfg.STOP_LOSS_FLAG_THRESHOLD);
  els.lots.innerHTML = lots.length
    ? `<table><thead><tr><th>Item</th><th>Qty</th><th>Bought on</th><th>Unit cost</th><th>Cost</th><th>Bought (UTC)</th><th>Transfer eligible</th><th>Valuation</th><th>Unrealized</th><th>Stop-loss flag</th></tr></thead><tbody>${lots
        .map((l) => {
          const v = b.lot_valuations.find((x) => x.lot_id === l.lot_id);
          const cost = l.quantity * l.buy_price_cents;
          const f = stopLossFlag({ acquisitionCostCents: cost, currentValueCents: v?.state === "OK" ? v.value_cents : null, thresholdBps });
          const cd = formatCountdown(l.minimum_hold_until, d.nowMs);
          return `<tr>
            <td>${escapeHtml(l.canonical_item_id)}</td><td class="num">${l.quantity}</td><td>${escapeHtml(l.buy_market)}${l.funding_source === "steam_wallet" ? " (wallet)" : ""}</td>
            <td class="num">${formatCents(l.buy_price_cents)}</td><td class="num">${formatCents(cost)}</td><td>${escapeHtml(formatIsoUtc(l.buy_timestamp))}</td>
            <td>${cd === "eligible" ? "eligible" : `Transfer eligible in ${escapeHtml(cd)}`}</td>
            <td>${v?.state === "OK" ? `${formatCents(v.value_cents)} <span class="muted">(${escapeHtml(v.market)}, depth ${v.listing_depth})</span>` : `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(v?.reason ?? "")}">INSUFFICIENT_DATA</span>`}</td>
            <td class="num">${f.state === "INSUFFICIENT_DATA" ? "—" : formatCents(f.unrealized_pnl_cents)}</td>
            <td>${f.state === "FLAGGED" ? `<span class="status s-THIN_LIQUIDITY">REVIEW</span>` : escapeHtml(f.state)}</td></tr>`;
        })
        .join("")}</tbody></table><p class="muted">Stop-loss flags are informational only; nothing is ever listed or sold by this app.</p>`
    : `<p class="muted">No open lots.</p>`;

  const trades = [...app.ledger.trades].sort((x, y) => Date.parse(y.sell_timestamp) - Date.parse(x.sell_timestamp));
  els.trades.innerHTML = trades.length
    ? `<table><thead><tr><th>Sold (UTC)</th><th>Item</th><th>Qty</th><th>Market</th><th>Gross</th><th>Sell fee</th><th>Payout fee</th><th>Net proceeds</th><th>Cost</th><th>Realized</th><th>Margin</th><th>Hold</th><th>Banked</th><th>Deployable at close</th></tr></thead><tbody>${trades
        .map(
          (t) => `<tr><td>${escapeHtml(formatIsoUtc(t.sell_timestamp))}</td><td>${escapeHtml(t.canonical_item_id)}</td><td class="num">${t.quantity}</td><td>${escapeHtml(t.sell_market)}</td>
          <td class="num">${formatCents(t.gross_sale_cents)}</td><td class="num">${formatCents(t.sell_fee_cents)}</td><td class="num">${formatCents(t.payout_fee_cents)}</td>
          <td class="num">${formatCents(t.net_sale_proceeds_cents)} <span class="muted">→ ${t.proceeds_currency === "steam_wallet" ? "Steam Wallet" : "cash"}</span></td>
          <td class="num">${formatCents(t.acquisition_cost_cents)}</td><td class="num ${t.realized_net_profit_cents < 0 ? "neg" : "pos"}">${formatCents(t.realized_net_profit_cents)}</td>
          <td class="num">${formatBpsPct(t.net_margin_bps)}</td><td class="num">${t.hold_duration_hours}h</td><td class="num">${formatCents(t.banked_allocation_cents)}</td>
          <td class="num">${formatCents(t.deployable_capital_at_close_cents)}${t.deployable_capital_complete ? "" : " (lower bound)"}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No closed trades.</p>`;

  const adj = [...app.ledger.adjustments].sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp));
  els.adj.innerHTML = adj.length
    ? `<table><thead><tr><th>Time (UTC)</th><th>Kind</th><th>Amount</th><th>Note</th></tr></thead><tbody>${adj
        .map(
          (a) => `<tr><td>${escapeHtml(formatIsoUtc(a.timestamp))}</td><td>${escapeHtml(a.kind === "cash" ? (a.from_banked ? "cash (from banked)" : "cash") : a.kind === "wallet" ? "Steam Wallet" : "banked → free cash")}</td>
          <td class="num">${formatCents(a.amount_cents)}</td><td>${escapeHtml(a.note)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No adjustments. Record a USD cash deposit to set your starting balance.</p>`;
}
