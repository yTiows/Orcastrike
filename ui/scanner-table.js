// Scanner table: one row per evaluated buy→sell pair with its single eligibility status
// and an expandable calculation trace. There is no buy/sell/list control here (P0-1).

import { HISTORICAL_LABEL } from "../js/backtest.js";
import { escapeHtml, formatAge, formatBpsPct, formatCents, formatIsoUtc } from "../js/format.js";
import { ELIGIBILITY, LISTING_DEPTH_TOOLTIP } from "../js/scanner.js";

const MARKET_LABEL = { steam: "Steam", csfloat: "CSFloat", skinport: "Skinport" };
let els = {};
const ui = { statuses: new Set(Object.values(ELIGIBILITY)), expanded: new Set(), showBelow: false };

export function mount(root, app) {
  root.innerHTML = `
    <h2>Scanner</h2>
    <p class="muted">Observed cross-market spreads for your watchlist, after fees. Read-only: act on a marketplace yourself,
    then record it in the Ledger. An empty highlighted list is a valid result.</p>
    <div class="toolbar">
      <button id="scan-refresh" type="button" class="primary">Refresh quotes</button>
      <span id="scan-summary" class="muted"></span>
    </div>
    <fieldset class="filters"><legend>Show statuses</legend>
      ${Object.values(ELIGIBILITY)
        .map((s) => `<label><input type="checkbox" data-status="${s}" checked> <span class="status s-${s}">${s}</span> <span data-count="${s}"></span></label>`)
        .join("")}
      <label><input type="checkbox" id="scan-below"> evaluated pairs below the minimum filter</label>
    </fieldset>
    <div class="table-wrap"><table class="scanner">
      <thead><tr>
        <th>Item</th><th>Buy</th><th>Buy price</th><th>Sell</th><th>Sell price</th>
        <th>Net profit</th>
        <th title="Live cross-market calculation from current quotes. Descriptive, not a forecast.">Observed net margin</th>
        <th title="${escapeHtml(LISTING_DEPTH_TOOLTIP)}">listing_depth ⓘ</th>
        <th>Price age</th><th>Transfer eligible (if bought now)</th>
        <th title="${escapeHtml(HISTORICAL_LABEL)}">Historical simulated margin ⓘ</th>
        <th>Status</th>
      </tr></thead>
      <tbody id="scan-body"></tbody>
    </table></div>
    <div id="scan-below-list"></div>
    <section class="panel">
      <h3>Watchlist <span id="wl-count" class="muted"></span></h3>
      <p class="muted">Exact <code>market_hash_name</code> strings (name + wear + StatTrak™/Souvenir). Pattern, float and sticker
      premiums are not visible to this app. Max ${app.cfg.MAX_TRACKED_ITEMS} items.</p>
      <form id="wl-add" class="inline-form">
        <input id="wl-input" type="text" maxlength="200" placeholder="e.g. AK-47 | Redline (Field-Tested)" aria-label="market_hash_name">
        <button type="submit">Add</button>
        <button type="button" id="wl-reset">Reset to starter list</button>
      </form>
      <div id="wl-errors" class="error-text"></div>
      <ul id="wl-list" class="chips"></ul>
    </section>`;
  els = {
    body: root.querySelector("#scan-body"),
    summary: root.querySelector("#scan-summary"),
    refresh: root.querySelector("#scan-refresh"),
    belowList: root.querySelector("#scan-below-list"),
    wlList: root.querySelector("#wl-list"),
    wlCount: root.querySelector("#wl-count"),
    wlErrors: root.querySelector("#wl-errors"),
    root,
  };
  els.refresh.addEventListener("click", () => app.actions.refreshQuotes());
  for (const cb of root.querySelectorAll("[data-status]")) {
    cb.addEventListener("change", () => {
      if (cb.checked) ui.statuses.add(cb.dataset.status);
      else ui.statuses.delete(cb.dataset.status);
      app.actions.render();
    });
  }
  root.querySelector("#scan-below").addEventListener("change", (e) => {
    ui.showBelow = e.target.checked;
    app.actions.render();
  });
  const onRowActivate = async (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const hist = e.target.closest("[data-load-history]");
    if (hist) {
      if (e.type === "keydown") return; // the button handles its own keyboard activation
      hist.disabled = true;
      hist.textContent = "loading…";
      await app.actions.loadHistory(hist.dataset.loadHistory);
      return;
    }
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    e.preventDefault();
    if (ui.expanded.has(tr.dataset.key)) ui.expanded.delete(tr.dataset.key);
    else ui.expanded.add(tr.dataset.key);
    app.actions.render();
  };
  for (const el of [els.body, els.belowList]) {
    el.addEventListener("click", onRowActivate);
    el.addEventListener("keydown", onRowActivate);
  }
  root.querySelector("#wl-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = root.querySelector("#wl-input");
    const name = input.value.trim();
    if (!name) return;
    const n = app.actions.setWatchlist([...app.watchlist, name]);
    if (n.items.includes(name)) input.value = "";
  });
  root.querySelector("#wl-reset").addEventListener("click", () => {
    if (confirm("Replace your watchlist with the starter list?")) app.actions.setWatchlist(app.starter.items);
  });
  els.wlList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) app.actions.setWatchlist(app.watchlist.filter((i) => i !== btn.dataset.remove));
  });
}

function simCell(app, item) {
  const sim = app.sims.get(item);
  if (!sim) return `<button type="button" class="link" data-load-history="${escapeHtml(item)}">load</button>`;
  if (sim.state !== "OK") return `<span class="status s-INSUFFICIENT_DATA" title="${escapeHtml(sim.reason ?? "")}">INSUFFICIENT_DATA</span>`;
  return `<span title="${escapeHtml(HISTORICAL_LABEL)}">${formatBpsPct(sim.median_net_margin_bps)} <span class="muted">(Steam-only, n=${sim.samples})</span></span>`;
}

function depthCell(r) {
  if (r.listing_depth === null || r.listing_depth === undefined) return `<span class="muted" title="${escapeHtml(LISTING_DEPTH_TOOLTIP)}">unavailable</span>`;
  return `<span title="${escapeHtml(LISTING_DEPTH_TOOLTIP)}">${r.listing_depth}</span>`;
}

function rowHtml(app, r) {
  const key = `${r.item}|${r.buy_market}|${r.sell_market}`;
  const open = ui.expanded.has(key);
  const status = r.eligibility_status ?? "BELOW_FILTER";
  const main = `<tr data-key="${escapeHtml(key)}" class="row-${status}${open ? " open" : ""}" tabindex="0" aria-expanded="${open}">
    <td class="item">${open ? "▾" : "▸"} ${escapeHtml(r.item)}</td>
    <td>${MARKET_LABEL[r.buy_market]}</td>
    <td class="num">${r.buy_price_cents === null ? "—" : formatCents(r.buy_price_cents)}</td>
    <td>${MARKET_LABEL[r.sell_market]}</td>
    <td class="num">${r.sell_price_cents === null ? "—" : formatCents(r.sell_price_cents)}</td>
    <td class="num">${r.net_profit_cents === null ? "—" : formatCents(r.net_profit_cents)}</td>
    <td class="num">${r.net_margin_bps === null ? "—" : formatBpsPct(r.net_margin_bps)}</td>
    <td class="num">${depthCell(r)}</td>
    <td>${r.buy_age_seconds === null && r.sell_age_seconds === null ? "—" : formatAge(r.price_age_seconds)}</td>
    <td title="Valve Trade Protection: ${app.cfg.TRANSFER_HOLD_DAYS} days">${app.cfg.TRANSFER_HOLD_DAYS}d → ${escapeHtml(formatIsoUtc(r.transfer_eligible_if_bought_now))}</td>
    <td>${simCell(app, r.item)}</td>
    <td><span class="status s-${status}">${status}</span></td>
  </tr>`;
  if (!open) return main;
  return `${main}<tr class="trace-row"><td colspan="12"><ol class="trace">${r.trace
    .map((t) => `<li><span class="trace-step">${escapeHtml(t.step)}</span> ${escapeHtml(t.display)}</li>`)
    .join("")}</ol></td></tr>`;
}

export function update(app, d) {
  const res = d.scanResult;
  for (const s of Object.values(ELIGIBILITY)) {
    const el = els.root.querySelector(`[data-count="${s}"]`);
    if (el) el.textContent = `(${res.counts[s]})`;
  }
  const rows = res.rows.filter((r) => ui.statuses.has(r.eligibility_status));
  const noQuotes = app.quotes.size === 0;
  els.summary.textContent = noQuotes
    ? "No quotes fetched yet."
    : `${res.evaluated} pairs evaluated · ${res.counts.HIGHLIGHTED} highlighted · ${res.below_threshold.length} below the minimum filter`;
  els.refresh.disabled = app.refreshing;
  els.refresh.textContent = app.refreshing ? `Refreshing ${app.progress.done}/${app.progress.total}…` : "Refresh quotes";
  els.body.innerHTML = rows.length
    ? rows.map((r) => rowHtml(app, r)).join("")
    : `<tr><td colspan="12" class="muted">${noQuotes ? "Press “Refresh quotes”." : "No rows match the selected statuses."}</td></tr>`;

  els.belowList.innerHTML = ui.showBelow && res.below_threshold.length
    ? `<h3>Evaluated, below minimum filter (not opportunities)</h3><div class="table-wrap"><table class="scanner"><tbody>${res.below_threshold
        .map((r) => rowHtml(app, r))
        .join("")}</tbody></table></div>`
    : "";

  els.wlCount.textContent = `(${app.watchlist.length}/${app.cfg.MAX_TRACKED_ITEMS})`;
  els.wlErrors.textContent = app.watchlistErrors.join("; ");
  els.wlList.innerHTML = app.watchlist
    .map((i) => `<li>${escapeHtml(i)} <button type="button" class="link" data-remove="${escapeHtml(i)}" aria-label="Remove ${escapeHtml(i)}">×</button></li>`)
    .join("");
}
