// Dashboard: balances (with Steam Wallet kept apart), tier/position, breaker, stop-loss
// flags, tier-compression evidence gate, backtest verdict, and the isolated price chart.

import { CROSS_MARKET_VERDICT, HISTORICAL_LABEL } from "../js/backtest.js";
import { escapeHtml, formatBpsPct, formatCents } from "../js/format.js";
import { rateToBps } from "../js/money.js";
import { stopLossFlag, tierCompressionStats } from "../js/tiers.js";

let els = {};

export function mount(root, app) {
  root.innerHTML = `
    <h2>Dashboard</h2>
    <div class="cards" id="dash-balances"></div>
    <section class="panel">
      <h3>Profit: five separate figures <span class="muted">(never summed or merged)</span></h3>
      <div class="cards" id="dash-figures"></div>
    </section>
    <div id="dash-alerts"></div>
    <div class="grid-2">
      <section class="panel">
        <h3>Tier compression evidence</h3>
        <p class="muted">Margin by item-price tier is shown only after ≥ 30 recorded flips in that tier.</p>
        <div id="dash-tiers"></div>
      </section>
      <section class="panel">
        <h3>Backtest verdict</h3>
        <p class="verdict">${escapeHtml(CROSS_MARKET_VERDICT)}</p>
        <p class="muted">Cross-market performance cannot be validated with free historical data. See BACKTEST_RESULTS.md.
        Per-item Steam-only history is available as labeled historical context in the scanner.</p>
      </section>
    </div>
    <section class="panel">
      <h3>Steam price history <span class="muted">(historical context, not a forecast)</span></h3>
      <form id="dash-chart-form" class="inline-form">
        <label>Item <select id="dash-chart-item"></select></label>
        <button type="submit">Load history</button>
      </form>
      <div id="dash-chart" class="chart-box"></div>
      <p id="dash-chart-sim" class="muted"></p>
    </section>`;
  els = {
    figures: root.querySelector("#dash-figures"),
    balances: root.querySelector("#dash-balances"),
    alerts: root.querySelector("#dash-alerts"),
    tiers: root.querySelector("#dash-tiers"),
    chart: root.querySelector("#dash-chart"),
    chartItem: root.querySelector("#dash-chart-item"),
    chartSim: root.querySelector("#dash-chart-sim"),
  };
  root.querySelector("#dash-chart-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = els.chartItem.value;
    if (!item) return;
    els.chart.textContent = "Loading…";
    await app.actions.loadHistory(item);
  });
}

function card(label, value, note = "", cls = "") {
  return `<div class="card ${cls}"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${value}</div>${note ? `<div class="card-note">${note}</div>` : ""}</div>`;
}

export function update(app, d) {
  const b = d.balances;
  if (!b.ok) {
    els.balances.innerHTML = `<div class="error-box"><strong>Ledger could not be loaded — balances unavailable.</strong><ul>${(b.errors ?? [])
      .slice(0, 10)
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join("")}</ul><p>See the Ledger tab to export the raw data or import a valid file.</p></div>`;
  } else {
    const lb = b.deployable_capital_complete ? "" : `<span class="flag">LOWER BOUND</span>`;
    const inv = b.inventory_complete
      ? ""
      : `<span class="flag">${b.unvalued_lot_ids.length} lot(s) INSUFFICIENT_DATA — excluded, not zero-filled</span>`;
    const cap = d.ctx.capital;
    const tier = cap?.tier;
    els.balances.innerHTML = [
      card("USD cash balance", formatCents(b.usd_cash_balance_cents), "Real cash on hand, incl. banked profit"),
      card("Banked profit (earmark)", formatCents(b.banked_profit_cents), "Part of cash; never redeployed automatically"),
      card("Free cash", formatCents(b.free_cash_cents), "Cash − banked"),
      card("Reserved cash", formatCents(b.reserved_cash_cents), "Earmarked for open orders (part of cash)"),
      card("Available cash", formatCents(b.available_cash_cents), "Cash − banked − reserved; what a buy may use"),
      card("Inventory value", `${formatCents(b.inventory_value_cents)} ${inv}`, "Lowest depth-qualified cash-market listing"),
      card("Deployable capital", `${formatCents(b.deployable_capital_cents)} ${lb}`, "Cash − banked + inventory. Drives tiers and sizing.", "primary"),
      card("Steam Wallet", formatCents(b.steam_wallet_balance_cents), "NOT cash. Never included in deployable capital.", "wallet"),
      card(
        "Tier",
        tier ? `Tier ${tier.tier}` : "None",
        tier
          ? `Item band ${formatCents(tier.band_min_cents)}–${tier.band_max_cents === null ? "∞" : formatCents(tier.band_max_cents)} (upper exclusive)`
          : `Below ${formatCents(app.cfg.TIERS[0].capital_min_cents)}: every opportunity is BLOCKED_BY_TIER`,
      ),
      card("Max position size", cap ? formatCents(cap.position.max_position_size_cents) : "—", "min(per-position %, exposure headroom, free cash above reserve)"),
      card("Open exposure", formatCents(b.current_open_exposure_cents), "Cost basis of open lots"),
      card("Circuit breaker", escapeHtml(d.breaker.state), d.breaker.active && d.breaker.expires_at ? `Active until ${escapeHtml(d.breaker.expires_at)}` : "Derived from stored trigger timestamp", d.breaker.active ? "alert" : ""),
    ].join("");
  }

  renderFigures(d.figures);

  // Stop-loss flags: informational only.
  const alerts = [];
  if (b.ok) {
    const thresholdBps = rateToBps(app.cfg.STOP_LOSS_FLAG_THRESHOLD);
    for (const lot of b.open_lots) {
      const v = b.lot_valuations.find((x) => x.lot_id === lot.lot_id);
      const qty = lot.remaining_quantity ?? lot.quantity;
      const f = stopLossFlag({ acquisitionCostCents: qty * lot.buy_price_cents, currentValueCents: v?.state === "OK" ? v.value_cents : null, thresholdBps });
      if (f.state === "FLAGGED") alerts.push(`Review: ${qty}× ${lot.canonical_item_id} is down ≥ ${formatBpsPct(thresholdBps)} vs cost (unrealized ${formatCents(f.unrealized_pnl_cents)}). Flag only — nothing is sold or listed.`);
    }
  }
  if (d.breaker.state === "INVALID") alerts.push("Stored circuit-breaker timestamp is corrupt; treated as ACTIVE. Clear it in Settings.");
  els.alerts.innerHTML = alerts.map((a) => `<div class="alert-box">${escapeHtml(a)}</div>`).join("");

  const trades = app.ledger?.trades ?? [];
  els.tiers.innerHTML = `<div class="table-wrap"><table class="compact"><thead><tr><th>Tier band</th><th>Flips</th><th>Median net margin</th></tr></thead><tbody>${tierCompressionStats(trades, app.cfg.TIER_COMPRESSION_MIN_FLIPS, app.cfg.TIERS)
    .map(
      (s) =>
        `<tr><td>Tier ${s.tier}</td><td>${s.flips}</td><td>${s.state === "OK" ? formatBpsPct(s.median_net_margin_bps) : `<span class="status s-INSUFFICIENT_DATA">INSUFFICIENT_DATA</span> (${s.flips}/${s.required})`}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;

  const current = els.chartItem.value;
  els.chartItem.innerHTML = app.watchlist.map((i) => `<option${i === current ? " selected" : ""}>${escapeHtml(i)}</option>`).join("");
  const item = els.chartItem.value;
  const h = app.histories.get(item);
  if (h) {
    if (h.state === "AVAILABLE") renderPriceChart(els.chart, h.points, `${item} — Steam daily price (USD)`);
    else els.chart.innerHTML = `<p><span class="status s-INSUFFICIENT_DATA">${escapeHtml(h.state)}</span> ${escapeHtml(h.reason ?? "")}</p>`;
    const sim = app.sims.get(item);
    els.chartSim.textContent = sim
      ? sim.state === "OK"
        ? `${HISTORICAL_LABEL} Median net ${formatBpsPct(sim.median_net_margin_bps)}, median gross 7-day change ${formatBpsPct(sim.median_gross_change_bps)}, ${sim.samples} paired days, positive in ${formatBpsPct(sim.positive_net_share_bps)} of samples.`
        : `${HISTORICAL_LABEL} INSUFFICIENT_DATA: ${sim.reason}`
      : "";
  } else if (!els.chart.textContent.startsWith("Loading")) {
    els.chart.innerHTML = `<p class="muted">No history loaded.</p>`;
    els.chartSim.textContent = "";
  }
}

// Chart.js is optional. If it failed to load (CDN down, SRI mismatch) or throws, show a
// table instead; nothing else in the app depends on it.
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
    container.innerHTML = `<p class="muted">Chart unavailable (${escapeHtml(why)}). Last ${rows.length} days:</p>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Date (UTC)</th><th>Price</th><th>Units sold</th></tr></thead><tbody>${rows
        .map((p) => `<tr><td>${escapeHtml(p.date)}</td><td>${formatCents(p.price_usd_cents)}</td><td>${p.volume}</td></tr>`)
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
        datasets: [
          {
            label: title,
            // Display-only conversion of integer cents to dollars.
            data: points.map((p) => p.price_usd_cents / 100),
            borderColor: css.getPropertyValue("--accent").trim() || "#4f8cff",
            pointRadius: 0,
            borderWidth: 1.5,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: (v) => `$${v}` } } },
      },
    });
  } catch {
    fallback("chart rendering failed");
  }
  return undefined;
}

// ---- the five profit figures (numeric tickers in UMBRA; off with prefers-reduced-motion) ----

const shown = new Map();

function tick(el, from, to) {
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || from === null || from === to || document.documentElement.dataset.mode !== "umbra") {
    el.textContent = formatCents(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 600);
    // Display-only interpolation between two integer-cent values; lands exactly on `to`.
    el.textContent = formatCents(p === 1 ? to : from + Math.trunc((to - from) * p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderFigures(figures) {
  if (!els.figures.children.length) {
    els.figures.innerHTML = figures
      .map(
        (f) => `<div class="card figure" data-fig="${f.name}"><div class="card-label"><code>${escapeHtml(f.name)}</code> <span class="tag tag-${escapeHtml(f.category)}">${escapeHtml(f.category)}</span></div>
        <div class="card-value" data-v></div><div class="card-note" data-n></div></div>`,
      )
      .join("");
  }
  for (const f of figures) {
    const card = els.figures.querySelector(`[data-fig="${f.name}"]`);
    const v = card.querySelector("[data-v]");
    if (Number.isSafeInteger(f.value_cents)) tick(v, shown.get(f.name) ?? null, f.value_cents);
    else v.textContent = f.state;
    shown.set(f.name, Number.isSafeInteger(f.value_cents) ? f.value_cents : null);
    card.querySelector("[data-n]").textContent = `${f.state} · ${f.basis}`;
    card.title = `Does: ${f.does}\nDoes not: ${f.does_not}`;
  }
}
