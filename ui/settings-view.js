// Settings: validated overrides layered over immutable defaults. Invalid combinations are
// rejected with a message, never clamped silently.

import { DEFAULTS } from "../config/defaults.js";
import { FEES } from "../config/fees.js";
import { escapeHtml, formatBpsPct, formatCents } from "../js/format.js";
import { dollarsStringToCents, MoneyError, rateToBps } from "../js/money.js";

const pct = (rate) => formatBpsPct(rateToBps(rate));

let els = {};

function numberOrNaN(text) {
  const s = String(text ?? "").trim();
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

export function mount(root, app) {
  const D = DEFAULTS;
  root.innerHTML = `
    <h2>Settings</h2>
    <form id="settings-form" class="panel form">
      <h3>Connection</h3>
      <label>Worker base URL <input name="worker" placeholder="https://skin-arb-terminal-proxy.&lt;account&gt;.workers.dev"></label>
      <h3>Risk (fractions of deployable capital)</h3>
      <label>Max per position <span class="muted">default ${D.risk.MAX_PCT_CAPITAL_PER_POSITION}</span><input name="pos" inputmode="decimal"></label>
      <label>Max aggregate open exposure <span class="muted">default ${D.risk.MAX_AGGREGATE_OPEN_EXPOSURE}</span><input name="exp" inputmode="decimal"></label>
      <label>Min free cash reserve <span class="muted">default ${D.risk.MIN_FREE_CASH_RESERVE}</span><input name="res" inputmode="decimal"></label>
      <p class="hint">Rules: 0 &lt; position ≤ 1; 0 &lt; exposure ≤ 1; 0 ≤ reserve &lt; 1; exposure + reserve ≤ 1.</p>
      <h3>Minimum viable opportunity</h3>
      <label>Min net profit, USD <span class="muted">default ${formatCents(D.filters.MIN_NET_PROFIT_CENTS)}</span><input name="minProfit" inputmode="decimal"></label>
      <label>Min net margin, % <span class="muted">default ${D.filters.MIN_NET_MARGIN_PCT}</span><input name="minMargin" inputmode="decimal"></label>
      <label>Min listing_depth <span class="muted">default ${D.filters.MIN_LISTING_DEPTH}</span><input name="minDepth" type="number" min="1" step="1"></label>
      <h3>Payout</h3>
      <label>CSFloat payout rail <select name="rail"><option value="bank">Bank (${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.bank)})</option><option value="usdc">USDC (${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.usdc)})</option></select></label>
      <div class="row-buttons"><button type="submit" class="primary">Save</button><button type="button" id="settings-reset">Reset to defaults</button></div>
      <div class="result" aria-live="polite"></div>
    </form>
    <section class="panel">
      <h3>Circuit breaker</h3>
      <p id="cb-status"></p>
      <button type="button" id="cb-clear" hidden>Clear corrupt stored value</button>
      <p class="muted">An ACTIVE breaker cannot be switched off early. Only an unreadable stored value can be cleared.</p>
    </section>
    <section class="panel">
      <h3>Fee constants (read-only, see FEES.md)</h3>
      <table class="compact"><tbody>
        <tr><td>Steam sell fee</td><td>${pct(FEES.STEAM_SELL_FEE)} of gross (model: ${escapeHtml(FEES.STEAM_FEE_MODEL)})</td></tr>
        <tr><td>CSFloat sell fee</td><td>${pct(FEES.CSFLOAT_SELL_FEE)}</td></tr>
        <tr><td>CSFloat payout</td><td>bank ${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.bank)}, USDC ${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.usdc)} (mid-range of published 0.5–2.5%)</td></tr>
        <tr><td>Skinport sell fee</td><td>${pct(FEES.SKINPORT_SELL_FEE_STANDARD)} standard, ${pct(FEES.SKINPORT_SELL_FEE_OVER_1000EUR)} for items ≥ €1,000, ${pct(FEES.SKINPORT_SELL_FEE_PRIVATE_LISTING)} private</td></tr>
        <tr><td>Skinport payout</td><td>${pct(FEES.SKINPORT_PAYOUT_FEE_RATE)} (bank/FX costs excluded)</td></tr>
      </tbody></table>
    </section>`;
  els = { form: root.querySelector("#settings-form"), cbStatus: root.querySelector("#cb-status"), cbClear: root.querySelector("#cb-clear") };
  fill(app);

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = els.form.elements;
    const out = els.form.querySelector(".result");
    let minProfit;
    try {
      minProfit = dollarsStringToCents(f.minProfit.value.replace(/^\$/, "").trim());
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
      minProfit = Number.NaN;
    }
    const overrides = {
      WORKER_BASE_URL: f.worker.value.trim(),
      CSFLOAT_PAYOUT_RAIL: f.rail.value,
      risk: {
        MAX_PCT_CAPITAL_PER_POSITION: numberOrNaN(f.pos.value),
        MAX_AGGREGATE_OPEN_EXPOSURE: numberOrNaN(f.exp.value),
        MIN_FREE_CASH_RESERVE: numberOrNaN(f.res.value),
      },
      filters: {
        MIN_NET_PROFIT_CENTS: minProfit,
        MIN_NET_MARGIN_PCT: numberOrNaN(f.minMargin.value),
        MIN_LISTING_DEPTH: Number.isInteger(Number(f.minDepth.value)) ? Number(f.minDepth.value) : Number.NaN,
      },
    };
    const r = app.actions.saveSettings(overrides);
    out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
    out.innerHTML = r.ok ? "Saved." : `<ul>${r.errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  });
  root.querySelector("#settings-reset").addEventListener("click", () => {
    if (!confirm("Reset all settings to shipped defaults?")) return;
    app.actions.saveSettings({});
    fill(app);
  });
  els.cbClear.addEventListener("click", () => app.actions.clearInvalidBreaker());
}

function fill(app) {
  const c = app.cfg;
  const f = els.form.elements;
  f.worker.value = c.WORKER_BASE_URL;
  f.pos.value = String(c.risk.MAX_PCT_CAPITAL_PER_POSITION);
  f.exp.value = String(c.risk.MAX_AGGREGATE_OPEN_EXPOSURE);
  f.res.value = String(c.risk.MIN_FREE_CASH_RESERVE);
  f.minProfit.value = formatCents(c.filters.MIN_NET_PROFIT_CENTS).replace("$", "");
  f.minMargin.value = String(c.filters.MIN_NET_MARGIN_PCT);
  f.minDepth.value = String(c.filters.MIN_LISTING_DEPTH);
  f.rail.value = c.CSFLOAT_PAYOUT_RAIL;
  if (app.settingsErrors.length) {
    const out = els.form.querySelector(".result");
    out.className = "result error-text";
    out.textContent = app.settingsErrors.join("; ");
  }
}

export function update(app, d) {
  const b = d.breaker;
  els.cbStatus.textContent =
    b.state === "INACTIVE"
      ? "Never triggered."
      : b.state === "INVALID"
        ? `Stored value is unreadable (${b.triggered_at}); treated as ACTIVE.`
        : `${b.state}: triggered ${b.triggered_at}, ${b.active ? "expires" : "expired"} ${b.expires_at}.`;
  els.cbClear.hidden = b.state !== "INVALID";
}
