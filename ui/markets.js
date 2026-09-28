// Markets: live cross-market spreads for your watchlist (refreshed automatically), Steam price
// history (loads by itself), and sourced events with the descriptive price change around them.
// Read-only: there is no buy/sell/list control here (P0-1).

import { HISTORICAL_LABEL } from "../js/backtest.js";
import { DELTA_METHODOLOGY, eventPriceDelta } from "../js/events.js";
import { escapeHtml, formatAge, formatBpsPct, formatCents, formatIsoUtc } from "../js/format.js";
import { ELIGIBILITY, LISTING_DEPTH_TOOLTIP } from "../js/scanner.js";
import { ago, chip, market, scanStatus } from "./components.js";

let els = {};
const ui = { expanded: new Set(), showAll: false, event: 0, histItem: null };

export function mount(root, app) {
  root.innerHTML = `
    <div class="page-head">
      <div><h2>Markets</h2><p>Current price gaps between markets for your watchlist, after fees. Updated automatically; act on a marketplace yourself.</p></div>
      <div class="row"><span id="scan-summary" class="muted small"></span><button id="scan-refresh" type="button" class="small">Refresh now</button></div>
    </div>
    <section class="card">
      <div class="card-head"><h3>Price gaps</h3>
        <div class="seg" role="group" aria-label="Rows to show">
          <button type="button" data-scan="found" aria-pressed="true">Spreads found</button>
          <button type="button" data-scan="all" aria-pressed="false">All pairs</button>
        </div></div>
      <div class="table-wrap" id="scan-table"><table class="scanner">
        <thead><tr><th>Item</th><th>Buy</th><th>Sell</th><th class="num">Net profit</th><th class="num">Margin</th><th class="num" title="${escapeHtml(LISTING_DEPTH_TOOLTIP)}">Listings ⓘ</th><th>Price age</th><th>Status</th></tr></thead>
        <tbody id="scan-body"></tbody>
      </table></div>
      <div id="scan-empty"></div>
      <details class="inline" id="scan-progress"><summary>Price refresh details <span id="scan-progress-sum" class="muted"></span></summary><div id="scan-progress-body"></div></details>
      <details class="inline"><summary>Watchlist (<span id="wl-count"></span>)</summary>
        <p class="hint">Exact market names: name + wear + StatTrak™/Souvenir. Float, pattern and sticker premiums aren't visible to the app.</p>
        <form id="wl-add" class="inline-form">
          <input id="wl-input" type="text" maxlength="200" placeholder="e.g. AK-47 | Redline (Field-Tested)" aria-label="Item to add">
          <button type="submit">Add</button>
          <button type="button" id="wl-reset" class="ghost">Reset to starter list</button>
        </form>
        <div id="wl-errors" class="error-text"></div>
        <ul id="wl-list" class="chips"></ul>
      </details>
    </section>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Steam price history</h3><span class="muted small">historical context, not a forecast</span></div>
        <label class="field">Item <select id="hist-item"></select></label>
        <div id="dash-chart" class="chart-box"></div>
        <p id="dash-chart-sim" class="small muted"></p>
      </section>
      <section class="card">
        <div class="card-head"><h3>Events</h3><span class="muted small" title="Confidence is how certain the source is about the name and dates. It is not a forecast of price impact.">confidence = source certainty ⓘ</span></div>
        <div id="ev-list" class="event-list"></div>
        <div id="ev-result" class="small" aria-live="polite"></div>
        <details class="inline"><summary>How the price change is measured</summary><p class="small muted">${escapeHtml(DELTA_METHODOLOGY)}</p></details>
        <div id="ev-rejected"></div>
      </section>
    </div>`;
  els = {
    root,
    body: root.querySelector("#scan-body"),
    table: root.querySelector("#scan-table"),
    progressSum: root.querySelector("#scan-progress-sum"),
    progressBody: root.querySelector("#scan-progress-body"),
    empty: root.querySelector("#scan-empty"),
    summary: root.querySelector("#scan-summary"),
    refresh: root.querySelector("#scan-refresh"),
    wlList: root.querySelector("#wl-list"),
    wlCount: root.querySelector("#wl-count"),
    wlErrors: root.querySelector("#wl-errors"),
    histItem: root.querySelector("#hist-item"),
    chart: root.querySelector("#dash-chart"),
    chartSim: root.querySelector("#dash-chart-sim"),
    evList: root.querySelector("#ev-list"),
    evResult: root.querySelector("#ev-result"),
    evRejected: root.querySelector("#ev-rejected"),
    segs: root.querySelectorAll("[data-scan]"),
  };
  els.refresh.addEventListener("click", () => app.actions.refreshQuotes());
  for (const b of els.segs) {
    b.addEventListener("click", () => {
      ui.showAll = b.dataset.scan === "all";
      for (const x of els.segs) x.setAttribute("aria-pressed", String(x === b));
      app.actions.render();
    });
  }
  const onRow = (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    e.preventDefault();
    if (ui.expanded.has(tr.dataset.key)) ui.expanded.delete(tr.dataset.key);
    else ui.expanded.add(tr.dataset.key);
    app.actions.render();
  };
  els.body.addEventListener("click", onRow);
  els.body.addEventListener("keydown", onRow);
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
  els.histItem.addEventListener("change", async () => {
    ui.histItem = els.histItem.value;
    els.evResult.innerHTML = "";
    await autoLoad(app);
    computeEvent(app);
    app.actions.render();
  });
  const pickEvent = (e) => {
    if (e.target.closest("a")) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const b = e.target.closest("[data-event]");
    if (!b) return;
    e.preventDefault();
    ui.event = Number(b.dataset.event);
    app.actions.render();
    computeEvent(app);
  };
  els.evList.addEventListener("click", pickEvent);
  els.evList.addEventListener("keydown", pickEvent);
}

// Loads history for the selected item once (daemon: local, cheap). No button needed.
async function autoLoad(app) {
  const item = ui.histItem;
  if (!item || app.histories.has(item) || !app.client.configured) return;
  els.chart.innerHTML = `<p class="muted">Loading…</p>`;
  await app.actions.loadHistory(item);
  computeEvent(app);
}

async function computeEvent(app) {
  const ev = app.events.events[ui.event];
  const item = ui.histItem;
  if (!ev || !item) return;
  const h = app.histories.get(item);
  if (!h) return;
  const r = eventPriceDelta(h.state === "AVAILABLE" ? h.points : [], ev.start_date, app.cfg);
  els.evResult.innerHTML =
    r.state === "OK"
      ? `<p><strong>${escapeHtml(item)}</strong> around ${escapeHtml(ev.name)}: ${formatCents(r.before_mean_cents)} average in the week before → ${formatCents(r.after_mean_cents)} in the week from the start, <strong>${formatBpsPct(r.change_bps)}</strong> (${r.days_before}/${r.days_after} days with data). Descriptive only.</p>`
      : `<p>${chip("Not enough history", "warn")} <span class="status s-INSUFFICIENT_DATA">INSUFFICIENT_DATA</span> ${escapeHtml(r.reason)}${h.state !== "AVAILABLE" ? ` (history: ${escapeHtml(h.state)}${h.reason ? `, ${escapeHtml(h.reason)}` : ""})` : ""}</p>`;
}

function rowHtml(app, r) {
  const key = `${r.item}|${r.buy_market}|${r.sell_market}`;
  const open = ui.expanded.has(key);
  const status = r.eligibility_status ?? "BELOW_FILTER";
  const depth = r.listing_depth === null || r.listing_depth === undefined ? `<span class="muted">n/a</span>` : String(r.listing_depth);
  const main = `<tr data-key="${escapeHtml(key)}" class="row-${status}${open ? " open" : ""}" tabindex="0" aria-expanded="${open}">
    <td class="item"><span class="caret">${open ? "▾" : "▸"}</span> ${escapeHtml(r.item)}</td>
    <td>${market(r.buy_market)}<div class="small muted">${r.buy_price_cents === null ? "—" : formatCents(r.buy_price_cents)}</div></td>
    <td>${market(r.sell_market)}<div class="small muted">${r.sell_price_cents === null ? "—" : formatCents(r.sell_price_cents)}</div></td>
    <td class="num">${r.net_profit_cents === null ? "—" : formatCents(r.net_profit_cents)}</td>
    <td class="num">${r.net_margin_bps === null ? "—" : formatBpsPct(r.net_margin_bps)}</td>
    <td class="num">${depth}</td>
    <td>${r.buy_age_seconds === null && r.sell_age_seconds === null ? "—" : formatAge(r.price_age_seconds)}</td>
    <td>${scanStatus(status)}</td>
  </tr>`;
  if (!open) return main;
  const sim = app.sims.get(r.item);
  const simText = !sim
    ? "Historical simulation: select this item under Steam price history to load it."
    : sim.state === "OK"
      ? `${HISTORICAL_LABEL} Median net ${formatBpsPct(sim.median_net_margin_bps)} over ${sim.samples} paired days (Steam-only).`
      : `${HISTORICAL_LABEL} INSUFFICIENT_DATA: ${sim.reason}`;
  return `${main}<tr class="trace-row"><td colspan="8">
    <p class="small">If bought now, tradable from ${escapeHtml(formatIsoUtc(r.transfer_eligible_if_bought_now))} (Valve Trade Protection, ${app.cfg.TRANSFER_HOLD_DAYS} days). Observed spread from current quotes; descriptive, not a forecast.</p>
    <p class="small muted">${escapeHtml(simText)}</p>
    <details class="inline"><summary>Calculation trace</summary><ol class="trace">${r.trace.map((t) => `<li><span class="trace-step">${escapeHtml(t.step)}</span> ${escapeHtml(t.display)}</li>`).join("")}</ol></details>
  </td></tr>`;
}

// Chart.js is optional. If it failed to load (CDN down, SRI mismatch) or throws, show a table
// instead; nothing else in the app depends on it.
export function renderPriceChart(container, points, title) {
  if (container._chart) {
    try {
      container._chart.destroy();
    } catch {
      /* ignore */
    }
    container._chart = null;
  }
  const fallback = (why) => {
    const rows = points.slice(-30).reverse();
    container.innerHTML = `<p class="muted small">Chart unavailable (${escapeHtml(why)}). Last ${rows.length} days:</p>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Date (UTC)</th><th class="num">Price</th><th class="num">Units sold</th></tr></thead><tbody>${rows
        .map((p) => `<tr><td>${escapeHtml(p.date)}</td><td class="num">${formatCents(p.price_usd_cents)}</td><td class="num">${p.volume}</td></tr>`)
        .join("")}</tbody></table></div>`;
  };
  if (typeof window.Chart !== "function") return fallback("Chart.js did not load");
  try {
    container.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", title);
    container.append(canvas);
    const css = getComputedStyle(document.documentElement);
    container._chart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels: points.map((p) => p.date),
        // Display-only conversion of integer cents to dollars.
        datasets: [{ label: title, data: points.map((p) => p.price_usd_cents / 100), borderColor: css.getPropertyValue("--accent").trim() || "#4f8cff", pointRadius: 0, borderWidth: 1.5 }],
      },
      options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => `$${v}` } } } },
    });
  } catch {
    fallback("chart rendering failed");
  }
  return undefined;
}

// Every item × source of the last refresh: failed first with the backend's exact reason.
function renderProgress(app) {
  const items = [...app.progress.items.values()];
  const n = (st) => items.filter((i) => i.state === st).length;
  els.progressSum.textContent = items.length ? `(${n("ok")} ok, ${n("failed")} unavailable, ${n("pending")} pending)` : "(no refresh yet)";
  const order = { failed: 0, pending: 1, ok: 2 };
  els.progressBody.innerHTML = items.length
    ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Item</th><th>Market</th><th>Result</th><th>Reason</th></tr></thead><tbody>${items
        .sort((a, b) => order[a.state] - order[b.state] || a.item.localeCompare(b.item))
        .map((i) => `<tr><td>${escapeHtml(i.item)}</td><td>${market(i.source)}</td><td>${i.state === "pending" ? chip("waiting", "") : i.state === "ok" ? chip(i.status, "ok") : chip(i.status ?? "failed", "warn")}${i.ms !== null ? ` <span class="small muted">${i.ms} ms</span>` : ""}</td><td class="small">${escapeHtml(i.reason ?? "")}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
}

export function update(app, d) {
  const res = d.scanResult;
  const found = res.rows.filter((r) => r.eligibility_status === ELIGIBILITY.HIGHLIGHTED);
  const rows = ui.showAll ? [...res.rows, ...res.below_threshold] : found;
  const noQuotes = app.quotes.size === 0;
  const p = app.progress;
  const waitedS = p.started_at ? Math.floor((Date.now() - p.started_at) / 1000) : 0;
  els.summary.textContent = !app.client.configured
    ? "No price source: start the app, or set a Worker URL in Settings."
    : app.refreshing
      ? `Updating prices ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ""}${p.done === 0 && waitedS >= 3 ? ` · waiting for ${app.client.local ? "the app" : "the Worker"} to answer (${waitedS}s)` : ""}…`
      : app.lastRefreshIso
        ? `${res.evaluated} pairs · updated ${ago(app.lastRefreshIso, d.nowMs)}${p.failed ? ` · ${p.failed} of ${p.total} prices unavailable (see details)` : ""}`
        : "Fetching prices…";
  renderProgress(app);
  els.refresh.disabled = app.refreshing || !app.client.configured;
  els.body.innerHTML = rows.map((r) => rowHtml(app, r)).join("");
  els.table.hidden = !rows.length;
  els.empty.innerHTML = rows.length
    ? ""
    : `<div class="empty"><strong>${noQuotes ? "Waiting for prices" : "No spreads right now"}</strong>${noQuotes ? "Prices load automatically." : `${res.evaluated} pairs checked; none clears fees and your minimums. <button type="button" class="link" data-scan-all>Show all pairs</button>`}</div>`;
  els.empty.querySelector("[data-scan-all]")?.addEventListener("click", () => [...els.segs].find((b) => b.dataset.scan === "all").click());

  els.wlCount.textContent = `${app.watchlist.length}/${app.cfg.MAX_TRACKED_ITEMS}`;
  els.wlErrors.textContent = app.watchlistErrors.join("; ");
  els.wlList.innerHTML = app.watchlist.map((i) => `<li>${escapeHtml(i)} <button type="button" class="link" data-remove="${escapeHtml(i)}" aria-label="Remove ${escapeHtml(i)}">×</button></li>`).join("");

  // Price history: default to the first watchlist item and load it without a click.
  const items = [...new Set([...app.watchlist])];
  if (!ui.histItem || !items.includes(ui.histItem)) ui.histItem = items[0] ?? null;
  if (els.histItem.options.length !== items.length || els.histItem.value !== ui.histItem) {
    els.histItem.innerHTML = items.map((i) => `<option${i === ui.histItem ? " selected" : ""}>${escapeHtml(i)}</option>`).join("");
  }
  const h = ui.histItem ? app.histories.get(ui.histItem) : null;
  if (h) {
    if (h.state === "AVAILABLE") {
      if (els.chart.dataset.item !== ui.histItem || els.chart.dataset.n !== String(h.points.length) || !els.chart.children.length) {
        renderPriceChart(els.chart, h.points, `${ui.histItem}: Steam daily price (USD)`);
        els.chart.dataset.item = ui.histItem;
        els.chart.dataset.n = String(h.points.length);
      }
    } else {
      els.chart.innerHTML = `<div class="empty"><strong>${escapeHtml(h.state === "UNAVAILABLE" ? "No history yet" : h.state)}</strong>${escapeHtml(h.reason ?? "")}</div>`;
      delete els.chart.dataset.item;
    }
    const sim = app.sims.get(ui.histItem);
    els.chartSim.textContent = sim ? (sim.state === "OK" ? `${HISTORICAL_LABEL} Median net ${formatBpsPct(sim.median_net_margin_bps)}, median 7-day change ${formatBpsPct(sim.median_gross_change_bps)}, ${sim.samples} paired days.` : `${HISTORICAL_LABEL} INSUFFICIENT_DATA: ${sim.reason}`) : "";
  } else if (!app.client.configured) {
    els.chart.innerHTML = `<div class="empty"><strong>No price source</strong>Start the app to load history.</div>`;
  } else if (ui.histItem) {
    autoLoad(app);
  }

  const { events, rejected } = app.events;
  els.evList.innerHTML = app.eventsError
    ? `<p class="error-text">static/events.json could not be loaded: ${escapeHtml(app.eventsError)}</p>`
    : events.length
      ? events
          .map(
            (e, i) => `<div class="event${i === ui.event ? " selected" : ""}" data-event="${i}" role="button" tabindex="0" aria-pressed="${i === ui.event}" title="${escapeHtml(e.methodology)}">
              <span class="event-date">${escapeHtml(e.start_date)}${e.end_date !== e.start_date ? `<br>${escapeHtml(e.end_date)}` : ""}</span>
              <span><strong>${escapeHtml(e.name)}</strong><br><span class="small muted">${escapeHtml(e.type.replace(/_/g, " "))} · <a href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer">source</a> retrieved ${escapeHtml(e.retrieval_date)}</span></span>
              ${chip(`${e.confidence} confidence`, e.confidence === "high" ? "ok" : e.confidence === "low" ? "warn" : "")}
            </div>`,
          )
          .join("")
      : `<p class="muted">No events.</p>`;
  els.evRejected.innerHTML = rejected.length
    ? `<div class="error-box"><strong>${rejected.length} event entr${rejected.length === 1 ? "y was" : "ies were"} rejected by validation:</strong><ul>${rejected
        .map((r) => `<li>${escapeHtml(r.event?.name ?? "?")}: ${escapeHtml(r.errors.join(", "))}</li>`)
        .join("")}</ul></div>`
    : "";
  if (!els.evResult.innerHTML && ui.histItem && app.histories.has(ui.histItem)) computeEvent(app);
}
