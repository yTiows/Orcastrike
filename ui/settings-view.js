// Settings: validated overrides layered over immutable defaults. Invalid combinations are
// rejected with a message, never clamped silently. Everyday limits first, in plain words and
// percentages; engine internals collapsed under "Advanced".

import { DEFAULTS } from "../config/defaults.js";
import { FEES } from "../config/fees.js";
import { escapeHtml, formatBpsPct, formatCents } from "../js/format.js";
import { dollarsStringToCents, MoneyError, rateToBps } from "../js/money.js";
import { chip, code } from "./components.js";

const pct = (rate) => formatBpsPct(rateToBps(rate));
let els = {};

// Fraction (0.15) ↔ percent text ("15"), via integer basis points (no float drift).
function fractionToPctText(rate) {
  const bps = rateToBps(rate);
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest ? `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}` : String(whole);
}
function pctTextToFraction(text) {
  const s = String(text ?? "").trim().replace(/%$/, "");
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return Number.NaN;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number(`${Math.trunc(bps / 10000)}.${String(bps % 10000).padStart(4, "0")}`);
}
function numberOrNaN(text) {
  const s = String(text ?? "").trim();
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

// Research engine settings (daemon): plain label + group, in display order.
const DS = [
  ["math.hold_days", "Planned holding period", "Trading math"],
  ["math.reversal_reserve_pct", "Reserve for trade reversals", "Trading math"],
  ["sizing.velocity_share_pct", "Max share of one day's sales per order", "Trading math"],
  ["stop.drop_pct", "Stop alert: price drop of at least", "Stop alerts"],
  ["stop.window_min", "Stop alert: within", "Stop alerts"],
  ["snapshot.max_age_quote_s", "Oldest usable price", "Data freshness"],
  ["snapshot.max_age_depth_s", "Oldest usable listing count", "Data freshness"],
  ["snapshot.max_age_reference_s", "Oldest usable reference price", "Data freshness"],
  ["snapshot.max_age_sales_s", "Oldest usable sales history", "Data freshness"],
  ["snapshot.max_cross_source_skew_s", "Max time gap between markets", "Data freshness"],
  ["sampling.market_quote_s", "Check prices every", "Data collection"],
  ["sampling.listing_depth_s", "Check listing counts every", "Data collection"],
  ["sampling.reference_price_s", "Check reference prices every", "Data collection"],
  ["sampling.sales_history_s", "Check sales history every", "Data collection"],
  ["sampling.catalog_s", "Refresh the full catalog every", "Data collection"],
  ["storage.raw_payload_retention_days", "Keep raw responses for", "Storage"],
];
const UNIT = { s: "seconds", days: "days", min: "minutes", "%": "%", "% of entry cost": "% of cost", "% of one day's velocity": "%" };

const MODES = [
  ["RESEARCH", "Research", "Computes and records everything; stages nothing."],
  ["PAPER", "Paper trading", "Also logs a simulated paper trade for every opportunity, to build signal evidence."],
  ["ASSISTED", "Assisted", "You approve and carry out every trade yourself on the marketplace. Behaves like Research: in-app approvals would need an execution path, which doesn't exist."],
  ["AUTOMATION", "Automation", "Needs level L3, which isn't available (no verified marketplace API)."],
];
const LEVEL_TEXT = { L0: "Alerts only (default)", L1: "Alerts plus prepared links to the listing; nothing is submitted", L2: "You approve each trade in the app", L3: "Narrow automatic trading" };

export function mount(root, app) {
  const D = DEFAULTS;
  root.innerHTML = `
    <div class="page-head"><div><h2>Settings</h2><p>The defaults are sensible; change only what you need. Everything is checked before it's saved.</p></div></div>
    <form id="settings-form" class="card form">
      <div class="card-head"><h3>Your limits</h3><span class="muted small">apply to every opportunity and position size</span></div>
      <div class="settings-group"><h4>Risk</h4><div class="form-grid">
        <label>Max in one item <span class="unit">% of capital · default ${fractionToPctText(D.risk.MAX_PCT_CAPITAL_PER_POSITION)}%</span><input name="pos" inputmode="decimal"></label>
        <label>Max in all holdings <span class="unit">% of capital · default ${fractionToPctText(D.risk.MAX_AGGREGATE_OPEN_EXPOSURE)}%</span><input name="exp" inputmode="decimal"></label>
        <label>Always keep free <span class="unit">% of capital as cash · default ${fractionToPctText(D.risk.MIN_FREE_CASH_RESERVE)}%</span><input name="res" inputmode="decimal"></label>
      </div><p class="hint">"Max in all holdings" plus "always keep free" can't exceed 100%.</p></div>
      <div class="settings-group"><h4>What counts as an opportunity</h4><div class="form-grid">
        <label>Minimum profit per trade <span class="unit">USD · default ${formatCents(D.filters.MIN_NET_PROFIT_CENTS)}</span><input name="minProfit" inputmode="decimal"></label>
        <label>Minimum margin <span class="unit">% · default ${D.filters.MIN_NET_MARGIN_PCT}</span><input name="minMargin" inputmode="decimal"></label>
        <label>Minimum listings near the price <span class="unit">default ${D.filters.MIN_LISTING_DEPTH}</span><input name="minDepth" type="number" min="1" step="1"></label>
      </div></div>
      <div class="settings-group"><h4>Payout</h4><div class="form-grid">
        <label>CSFloat payout method<select name="rail"><option value="bank">Bank (${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.bank)} fee)</option><option value="usdc">USDC (${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.usdc)} fee)</option></select></label>
      </div></div>
      <details class="inline"><summary>Hosted price proxy (optional)</summary>
        <label>Cloudflare Worker URL <span class="unit">only if you deployed the optional Worker; the local app doesn't need it</span><input name="worker" placeholder="https://skin-arb-terminal-proxy.&lt;account&gt;.workers.dev"></label>
      </details>
      <div class="row-buttons"><button type="submit" class="primary">Save</button><button type="button" id="settings-reset" class="ghost">Reset to defaults</button></div>
      <div class="result" aria-live="polite"></div>
    </form>
    <section class="card" id="automation-card">
      <div class="card-head"><h3>Mode and automation</h3><span class="muted small">no mode or theme can buy or sell</span></div>
      <div id="st-control"><p class="muted">Needs the running app.</p></div>
    </section>
    <details class="section" id="daemon-settings"><summary><span>Advanced: research engine <span class="muted">sampling, freshness and trading math</span></span></summary>
      <div class="section-body" id="ds-body"><p class="muted">Needs the running app.</p></div></details>
    <details class="section"><summary><span>Daily loss limit <span class="muted" id="cb-label"></span></span></summary>
      <div class="section-body"><p id="cb-status"></p><button type="button" id="cb-clear" hidden>Clear the unreadable stored value</button>
      <p class="hint">After a day's losses reach 10% of capital, new opportunities pause for 24 hours. An active pause can't be switched off early.</p></div></details>
    <details class="section"><summary><span>Fees <span class="muted">read-only; FEES.md has the sources</span></span></summary>
      <div class="section-body table-wrap"><table class="compact"><tbody>
        <tr><td>Steam sell fee</td><td>${pct(FEES.STEAM_SELL_FEE)} of gross (model: ${code(FEES.STEAM_FEE_MODEL)})</td></tr>
        <tr><td>CSFloat sell fee</td><td>${pct(FEES.CSFLOAT_SELL_FEE)}</td></tr>
        <tr><td>CSFloat payout</td><td>bank ${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.bank)}, USDC ${pct(FEES.CSFLOAT_PAYOUT_FEE_RATE.usdc)} (middle of the published 0.5–2.5%)</td></tr>
        <tr><td>Skinport sell fee</td><td>${pct(FEES.SKINPORT_SELL_FEE_STANDARD)} standard, ${pct(FEES.SKINPORT_SELL_FEE_OVER_1000EUR)} for items ≥ €1,000, ${pct(FEES.SKINPORT_SELL_FEE_PRIVATE_LISTING)} private</td></tr>
        <tr><td>Skinport payout</td><td>${pct(FEES.SKINPORT_PAYOUT_FEE_RATE)} (bank/FX costs not included)</td></tr>
      </tbody></table></div></details>`;
  els = { form: root.querySelector("#settings-form"), cbStatus: root.querySelector("#cb-status"), cbClear: root.querySelector("#cb-clear"), cbLabel: root.querySelector("#cb-label"), control: root.querySelector("#st-control"), ds: root.querySelector("#ds-body") };
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
        MAX_PCT_CAPITAL_PER_POSITION: pctTextToFraction(f.pos.value),
        MAX_AGGREGATE_OPEN_EXPOSURE: pctTextToFraction(f.exp.value),
        MIN_FREE_CASH_RESERVE: pctTextToFraction(f.res.value),
      },
      filters: {
        MIN_NET_PROFIT_CENTS: minProfit,
        MIN_NET_MARGIN_PCT: numberOrNaN(f.minMargin.value),
        MIN_LISTING_DEPTH: Number.isInteger(Number(f.minDepth.value)) ? Number(f.minDepth.value) : Number.NaN,
      },
    };
    const r = app.actions.saveSettings(overrides);
    out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
    out.innerHTML = r.ok ? "Saved." : `<ul>${r.errors.map((x) => `<li>${escapeHtml(x.replace(/MAX_PCT_CAPITAL_PER_POSITION/, "Max in one item").replace(/MAX_AGGREGATE_OPEN_EXPOSURE/, "Max in all holdings").replace(/MIN_FREE_CASH_RESERVE/, "Always keep free"))}</li>`).join("")}</ul>`;
  });
  root.querySelector("#settings-reset").addEventListener("click", () => {
    if (!confirm("Reset all settings to the defaults?")) return;
    app.actions.saveSettings({});
    fill(app);
  });
  els.cbClear.addEventListener("click", () => app.actions.clearInvalidBreaker());
  els.ds.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = e.target.querySelector(".result");
    const settings = {};
    for (const input of e.target.querySelectorAll("[data-key]")) {
      const raw = input.value.trim();
      if (raw === "") continue;
      settings[input.dataset.key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    const r = await app.actions.saveDaemonSettings(settings);
    out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
    out.textContent = r.ok ? `Saved.${r.body?.warnings?.length ? ` Warnings: ${r.body.warnings.join("; ")}` : ""}` : (r.body?.errors ?? [r.error]).join("; ");
  });
  els.control.addEventListener("change", async (e) => {
    const out = els.control.querySelector(".result");
    let r = null;
    if (e.target.name === "mode") r = await app.actions.setMode(e.target.value);
    if (e.target.name === "level") r = await app.actions.setAutomationLevel(e.target.value);
    if (r && out) {
      out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
      out.textContent = r.ok ? "Saved." : (r.body?.errors ?? [r.error]).join("; ");
    }
  });
}

function controlHtml(app) {
  const c = app.research.control;
  if (!c) return "<p class=\"muted\">Loading…</p>";
  const modes = MODES.map(([v, label, text]) => `<label><input type="radio" name="mode" value="${v}"${c.mode === v ? " checked" : ""}${v === "AUTOMATION" ? " disabled" : ""}> ${label} ${code(v)}<span class="hint">${escapeHtml(text)}</span></label>`).join("");
  const levels = c.automation.levels
    .map((l) => `<label title="${escapeHtml(l.reason ?? "")}"><input type="radio" name="level" value="${l.level}"${c.automation.level === l.level ? " checked" : ""}${l.available ? "" : " disabled"}> ${escapeHtml(LEVEL_TEXT[l.level] ?? l.level)} ${code(l.level)}<span class="hint">${l.available ? "" : escapeHtml(l.reason ?? "")}</span></label>`)
    .join("");
  return `<div class="grid-2"><div><h4>Operating mode</h4><div class="radio-list">${modes}</div></div>
    <div><h4>Automation level</h4><div class="radio-list">${levels}</div></div></div>
    <div class="result" aria-live="polite"></div>`;
}

function daemonSettingsHtml(app) {
  const s = app.research.settings;
  if (!s) return "<p class=\"muted\">Loading…</p>";
  const byKey = new Map(s.schema.map((e) => [e.key, e]));
  const groups = new Map();
  for (const [key, label, group] of DS) {
    const e = byKey.get(key);
    if (!e || e.class !== "user_setting" || typeof e.default !== "number") continue;
    const cur = key.split(".").reduce((o, k) => o?.[k], s.effective);
    const unit = UNIT[e.unit] ?? e.unit ?? "";
    const html = `<label>${escapeHtml(label)} <span class="unit">${escapeHtml(unit)} · ${e.min}–${e.max} · default ${e.default}</span>
        <input data-key="${escapeHtml(key)}" inputmode="decimal" value="${escapeHtml(String(cur ?? ""))}" title="${escapeHtml(`${key}: ${e.doc}`)}">
        <span class="hint">${escapeHtml(e.doc)}${e.dangerous ? ` Careful: ${escapeHtml(e.dangerous)}` : ""}</span></label>`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(html);
  }
  return `<form class="form">${[...groups.entries()].map(([g, rows]) => `<div class="settings-group"><h4>${escapeHtml(g)}</h4><div class="form-grid">${rows.join("")}</div></div>`).join("")}
    <div class="row-buttons"><button type="submit" class="primary">Save research settings</button></div><div class="result" aria-live="polite"></div></form>
    <p class="hint">Fixed rules and developer defaults are listed in CONFIGURATION.md and can't be changed here.</p>`;
}

function fill(app) {
  const c = app.cfg;
  const f = els.form.elements;
  f.worker.value = c.WORKER_BASE_URL;
  f.pos.value = fractionToPctText(c.risk.MAX_PCT_CAPITAL_PER_POSITION);
  f.exp.value = fractionToPctText(c.risk.MAX_AGGREGATE_OPEN_EXPOSURE);
  f.res.value = fractionToPctText(c.risk.MIN_FREE_CASH_RESERVE);
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
  if (app.daemon.available) {
    if (!els.ds.contains(document.activeElement)) els.ds.innerHTML = daemonSettingsHtml(app);
    if (!els.control.contains(document.activeElement)) els.control.innerHTML = controlHtml(app);
  }
  const b = d.breaker;
  els.cbStatus.textContent =
    b.state === "INACTIVE" ? "Never triggered." : b.state === "INVALID" ? `The stored value is unreadable (${b.triggered_at}), so it is treated as ACTIVE.` : `${b.state}: triggered ${b.triggered_at}, ${b.active ? "ends" : "ended"} ${b.expires_at}.`;
  els.cbLabel.innerHTML = b.active || b.state === "INVALID" ? chip("paused", "bad") : chip("not triggered", "ok");
  els.cbClear.hidden = b.state !== "INVALID";
}
