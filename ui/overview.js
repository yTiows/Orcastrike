// Overview: what is happening, what (if anything) needs you, and where you stand. Every step
// the app can do by itself it does; the checklist only lists what needs a person, and each item
// ticks itself off when done.

import { escapeHtml, formatBpsPct, formatCents } from "../js/format.js";
import { rateToBps } from "../js/money.js";
import { stopLossFlag } from "../js/tiers.js";
import { ago, bindCopy, blockedSummary, cents, chip, code, copyButton, FIGURE_LABEL, market, meter, oppStatus, sourceState, stat, tag } from "./components.js";

let els = {};

export function mount(root, app) {
  root.innerHTML = `
    <div id="ov-alerts"></div>
    <div class="card hero" id="ov-hero"></div>
    <div class="grid-2">
      <section class="card" id="ov-steps-card">
        <div class="card-head"><h3>Next steps</h3><span class="muted small" id="ov-steps-count"></span></div>
        <ul class="checklist" id="ov-steps"></ul>
      </section>
      <section class="card">
        <div class="card-head"><h3>Opportunities</h3><a href="#opportunities" class="small">See all →</a></div>
        <div id="ov-opps"></div>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h3>Your money</h3><a href="#portfolio" class="small">Portfolio →</a></div>
        <div class="stats" id="ov-money"></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Profit <span class="muted small">five separate figures, never added together</span></h3></div>
        <div id="dash-figures"></div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h3>Evidence progress</h3><span class="muted small">A strategy is promoted only when every bar is full.</span></div>
      <div class="grid-2" id="ov-evidence"></div>
    </section>`;
  els = Object.fromEntries(["alerts", "hero", "steps", "steps-count", "opps", "money", "evidence"].map((k) => [k, root.querySelector(`#ov-${k}`)]));
  els.figures = root.querySelector("#dash-figures");
  bindCopy(root);
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "verify") {
      b.disabled = true;
      await app.actions.verifyNow();
    } else if (act === "add-cash") app.actions.navigate("portfolio", { form: "cash" });
    else if (act === "backup-dir") app.actions.chooseBackupDir();
    else if (act === "export") app.actions.exportLedger();
  });
}

function heroHtml(app, d) {
  const h = app.daemon.health;
  if (!app.daemon.available) {
    return `${chip("App not running", "warn")}
      <div class="hero-title">Start Orcastrike to collect market data</div>
      <p class="muted">Double-click <code>Orcastrike.cmd</code> (Windows) or run <code>npm start</code>, then open <a href="http://127.0.0.1:8790/">http://127.0.0.1:8790</a>. Your ledger below still works without it.</p>`;
  }
  if (h?.db?.degraded) {
    return `${chip("Read-only", "bad")}<div class="hero-title">The database failed its integrity check</div>
      <p class="muted">Nothing is sampled or computed until it's restored. Your ledger is separate and unaffected. See FAILURE_STATES.md, "Corrupt database".</p>`;
  }
  const cycle = currentCycle(app);
  const eligible = (cycle?.ranked ?? []).filter((o) => o.status === "ELIGIBLE").length;
  const days = historyDays(app);
  const hold = holdDays(app);
  const verified = Object.values(h?.verify?.by_source ?? {}).some((s) => s === "VERIFIED");
  let tone = "info";
  let title;
  let text;
  if (eligible > 0) {
    [tone, title, text] = ["ok", `${eligible} opportunit${eligible === 1 ? "y" : "ies"} right now`, "Each one passed every data-quality and risk check. Nothing is bought for you: act on the marketplace yourself, then record it in Portfolio."];
  } else if (h?.verify?.running) {
    [title, text] = ["Checking the live data sources…", "This takes up to a couple of minutes. Opportunities can only use data from verified sources."];
  } else if (!verified && !h?.synthetic_upstream) {
    [tone, title, text] = ["warn", "Waiting for verified market data", "No data source has passed live verification yet, so nothing can be ranked. See Next steps."];
  } else if (days !== null && days < hold) {
    [title, text] = [`Collecting price history: day ${Math.floor(days) + 1} of ${hold}`, `Rankings need ${hold} days of the app's own price history to measure how prices move while you hold an item. Keep the app running; nothing else is needed.`];
  } else {
    [title, text] = ["Watching the market: nothing worth acting on right now", "That is a normal result. Each pair's reason is on the Opportunities page."];
  }
  const sources = ["steam", "skinport", "csfloat"]
    .map((s) => {
      const [label, t] = sourceState(s, app);
      return `<span><span class="dot ${t === "ok" ? "ok" : t === "bad" ? "bad" : t === "warn" ? "warn" : ""}"></span> <strong>${market(s)}</strong> ${escapeHtml(label)}</span>`;
    })
    .join("");
  const data = h?.data;
  return `${chip(eligible > 0 ? "Opportunities" : h?.synthetic_upstream ? "Test data (SYNTHETIC)" : "Running", tone)}
    <div class="hero-title">${escapeHtml(title)}</div>
    <p class="muted">${escapeHtml(text)}</p>
    <div class="hero-facts">
      ${sources}
    </div>
    <div class="hero-facts">
      <span>Items tracked <strong>${data?.tracked_items ?? "—"}</strong></span>
      <span>Observations <strong>${(data?.observations_total ?? 0).toLocaleString("en-US")}</strong></span>
      <span>Last update <strong>${data?.last_observation_at ? ago(data.last_observation_at, d.nowMs) : "none yet"}</strong></span>
      <span>Collecting since <strong>${data?.first_observation_at ? escapeHtml(data.first_observation_at.slice(0, 10)) : "—"}</strong></span>
    </div>`;
}

function currentCycle(app) {
  const umbra = Boolean(app.research.control?.umbra?.active);
  return app.research.opportunities[umbra ? "umbra" : "standard"];
}
function holdDays(app) {
  return app.research.settings?.effective?.math?.hold_days ?? 7;
}
function historyDays(app) {
  const first = app.daemon.health?.data?.first_observation_at;
  return first ? (Date.now() - Date.parse(first)) / 86400000 : null;
}

function step(state, title, desc, action = "") {
  const icon = state === "done" ? "✓" : state === "run" ? "" : state === "attn" ? "!" : state === "off" ? "–" : "•";
  return `<li class="${state === "done" || state === "off" ? "done" : ""}"><span class="check-icon ${state}">${icon}</span>
    <div><div class="check-title">${title}</div><div class="check-desc">${desc}</div></div>
    <div class="check-action">${action}</div></li>`;
}

// The snippets come from the daemon (/api/v2/health key_setup): client files never name credentials.
function keySetupHtml(k) {
  if (!k) return " See SETUP.md, step 4.";
  const block = (label, text, after) => `<details class="inline"><summary>${label}</summary><pre class="snippet">${escapeHtml(text)}</pre>${copyButton(text)} <span class="hint">Paste it and type the key when asked (it isn't shown). ${after}</span></details>`;
  return ` ${block("How: Windows PowerShell", k.windows_powershell, "Then close the app window and start Orcastrike again.")}${block("How: macOS / Linux terminal", k.macos_linux, "This restarts the app with the key for this terminal session.")}`;
}

function stepsHtml(app) {
  const out = [];
  const h = app.daemon.health;
  if (!app.daemon.available) {
    out.push(step("attn", "Start the app", "Double-click <code>Orcastrike.cmd</code> (or <code>npm start</code>). It collects prices and verifies the data sources by itself."));
  } else {
    const v = h?.verify;
    const bySource = ["steam", "skinport", "csfloat"].map((s) => `${market(s)}: ${escapeHtml(sourceState(s, app)[0])}`).join(" · ");
    if (v?.disabled) out.push(step("off", "Data-source verification", `Off: ${escapeHtml(v.disabled)}.`));
    else if (v?.running) out.push(step("run", "Verifying live data sources…", "Calls each source once and checks its format. Takes up to a couple of minutes."));
    else {
      const all = ["steam", "skinport", "csfloat"].every((s) => v?.by_source?.[s] === "VERIFIED");
      const when = v?.report_run_at ? `Last checked ${ago(v.report_run_at)}; re-checked automatically every day.` : "Runs automatically a few seconds after the app starts.";
      out.push(step(all ? "done" : "attn", all ? "Data sources verified" : "Verify the live data sources", `${bySource}. ${when}`, all ? "" : `<button type="button" class="small" data-act="verify">Verify now</button>`));
    }
    const hasKey = h?.sources?.csfloat === "CONFIGURED";
    out.push(
      step(
        hasKey ? "done" : "todo",
        hasKey ? "CSFloat API key set" : "Add a CSFloat API key (optional)",
        hasKey
          ? "CSFloat prices and exits are available."
          : `Adds CSFloat, the main cash exit. The key is read only from your environment, never stored by the app.${keySetupHtml(h?.key_setup)}`,
      ),
    );
  }
  const hasCash = (app.ledger?.adjustments ?? []).some((a) => a.kind === "cash");
  out.push(step(hasCash ? "done" : "todo", hasCash ? "Starting cash recorded" : "Record your starting cash", hasCash ? "Position sizes and tiers use it." : "Sizing and tiers need to know what you can spend. Takes 10 seconds.", hasCash ? "" : `<button type="button" class="small primary" data-act="add-cash">Add cash</button>`));
  const b = app.backup.state?.state;
  const fsa = app.actions.fsaSupported();
  const backedUp = ["CHOSEN", "WRITTEN", "SKIPPED_TODAY"].includes(b);
  out.push(
    step(
      backedUp ? "done" : "todo",
      backedUp ? "Daily ledger backup on" : "Turn on daily ledger backup",
      backedUp ? "A checksummed copy is written once a day." : fsa ? "Pick a folder once; a checksummed copy is saved there every day." : "This browser can't write backups automatically. Export now and then instead.",
      backedUp ? "" : fsa ? `<button type="button" class="small" data-act="backup-dir">Choose folder</button>` : `<button type="button" class="small" data-act="export">Export</button>`,
    ),
  );
  if (app.daemon.available && !h?.db?.degraded) {
    const days = historyDays(app);
    const hold = holdDays(app);
    const done = days !== null && days >= hold;
    out.push(step(done ? "done" : "todo", done ? `${hold} days of price history collected` : "Collect price history", done ? "Rankings can measure price moves over your holding period." : meter("Automatic. Keep the app running.", days === null ? 0 : Math.floor(days * 10) / 10, hold, `${days === null ? 0 : Math.floor(days)} of ${hold} days`)));
  }
  return out;
}

function oppsHtml(app) {
  if (!app.daemon.available) return `<div class="empty"><strong>No live data</strong>Opportunities need the running app.</div>`;
  const cycle = currentCycle(app);
  if (!cycle?.computed_at) return `<div class="empty"><strong>First check in progress</strong>The engine evaluates every pair every 30 seconds.</div>`;
  const top = (cycle.ranked ?? []).filter((o) => o.status === "ELIGIBLE").slice(0, 3);
  if (top.length) {
    return `<ul class="plain">${top
      .map((o) => `<li><span><strong>${escapeHtml(o.item)}</strong><br><span class="muted small">${market(o.buy_source)} → ${market(o.sell_source)}</span></span><span class="num">${cents(o.math?.expected_net_profit_cents)} ${tag("ESTIMATED")}</span></li>`)
      .join("")}</ul>`;
  }
  const reasons = blockedSummary(cycle.all);
  return `<div class="empty"><strong>None right now</strong>That's the correct answer until the data supports one.</div>
    ${reasons.length ? `<p class="small muted">Why, across ${cycle.evaluated} evaluated pairs:</p><ul class="plain small">${reasons
      .slice(0, 4)
      .map((r) => `<li><span>${oppStatus(r.status)}</span><span class="num">${r.count}</span></li>`)
      .join("")}</ul>` : ""}`;
}

function moneyHtml(app, d) {
  const b = d.balances;
  if (!b.ok) return `<div class="error-box"><strong>Ledger could not be loaded.</strong> Open Portfolio to export the raw data or import a valid file.</div>`;
  const empty = !(app.ledger?.adjustments?.length || app.ledger?.lots?.length);
  if (empty) return `<div class="empty"><strong>No entries yet</strong>Record your starting cash to see your balances here.<br><br><button type="button" class="primary" data-act="add-cash">Add cash</button></div>`;
  const inv = b.inventory_complete ? "Lowest qualified cash-market ask" : `${b.unvalued_lot_ids.length} holding(s) not valued: no qualified price`;
  return [
    stat("Available cash", formatCents(b.available_cash_cents), "What a new buy may use"),
    stat("Holdings value", formatCents(b.inventory_value_cents), escapeHtml(inv)),
    stat("Total capital", formatCents(b.deployable_capital_cents), b.deployable_capital_complete ? "Cash minus banked profit, plus holdings" : "Lower bound (some holdings unvalued)", "emph"),
    stat("Steam Wallet", formatCents(b.steam_wallet_balance_cents), "Not cash; never counted in capital", "wallet"),
  ].join("");
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
  const stepFn = (now) => {
    const p = Math.min(1, (now - start) / 600);
    // Display-only interpolation between two integer-cent values; lands exactly on `to`.
    el.textContent = formatCents(p === 1 ? to : from + Math.trunc((to - from) * p));
    if (p < 1) requestAnimationFrame(stepFn);
  };
  requestAnimationFrame(stepFn);
}

function renderFigures(figures) {
  if (!els.figures.children.length) {
    els.figures.innerHTML = figures
      .map(
        (f) => `<div class="figure-row card-figure" data-fig="${f.name}">
          <div><span class="figure-name">${escapeHtml(FIGURE_LABEL[f.name] ?? f.name)}</span> ${tag(f.category)}<br>${code(f.name)}</div>
          <div class="figure-value" data-v></div><div class="figure-sub" data-n></div></div>`,
      )
      .join("");
  }
  for (const f of figures) {
    const row = els.figures.querySelector(`[data-fig="${f.name}"]`);
    const v = row.querySelector("[data-v]");
    if (Number.isSafeInteger(f.value_cents)) tick(v, shown.get(f.name) ?? null, f.value_cents);
    else v.textContent = f.state;
    shown.set(f.name, Number.isSafeInteger(f.value_cents) ? f.value_cents : null);
    row.querySelector("[data-n]").textContent = `${f.state} · ${f.basis}`;
    row.title = `Does: ${f.does}\nDoes not: ${f.does_not}`;
  }
}

function evidenceHtml(app) {
  const ev = app.research.evidence;
  if (!app.daemon.available) return `<p class="muted">Evidence is computed by the running app.</p>`;
  if (!ev) return `<p class="muted">Loading…</p>`;
  const g = ev.gates ?? {};
  const find = (gate, re) => g[gate]?.checks?.find((c) => re.test(c.name));
  const need = (c) => Number(String(c?.required ?? "").replace(/[^\d.]/g, "")) || 0;
  const paper = find("SIGNAL_EVIDENCE", /paper/);
  const days = find("SIGNAL_EVIDENCE", /days/);
  const cov = find("SIGNAL_EVIDENCE", /coverage/);
  const high = find("SIGNAL_EVIDENCE", /HIGH-severity/);
  const real = find("EXECUTION_EVIDENCE", /REAL/);
  return `<div>
      <h4>Signal evidence ${g.SIGNAL_EVIDENCE?.pass ? chip("passed", "ok") : chip("not yet", "")}</h4>
      ${paper ? meter("Closed paper trades", Number(paper.actual) || 0, need(paper)) : ""}
      ${days ? meter("Days of observation", Number(days.actual) || 0, need(days)) : ""}
      ${cov ? `<div class="meter-top small"><span>Data coverage ≥ ${escapeHtml(String(cov.required).replace(/[^\d%]/g, ""))} per source per day</span><span>${cov.pass ? chip("OK", "ok") : escapeHtml(String(cov.actual))}</span></div>` : ""}
      ${high ? `<div class="meter-top small"><span>Open serious data problems</span><span>${Number(high.actual) === 0 ? chip("none", "ok") : chip(String(high.actual), "bad")}</span></div>` : ""}
    </div>
    <div>
      <h4>Execution evidence ${g.EXECUTION_EVIDENCE?.pass ? chip("passed", "ok") : chip("not yet", "")}</h4>
      ${real ? meter("Your recorded real trades", Number(real.actual) || 0, need(real)) : ""}
      <p class="small muted">Paper trades never count here. Strategy validation needs both, under the same strategy version. Market regime coverage: ${escapeHtml(ev.market_regime_coverage?.state ?? "UNKNOWN")}.</p>
    </div>`;
}

export function update(app, d) {
  const alerts = [];
  if (d.balances.ok) {
    const thresholdBps = rateToBps(app.cfg.STOP_LOSS_FLAG_THRESHOLD);
    for (const lot of d.balances.open_lots) {
      const v = d.balances.lot_valuations.find((x) => x.lot_id === lot.lot_id);
      const qty = lot.remaining_quantity ?? lot.quantity;
      const f = stopLossFlag({ acquisitionCostCents: qty * lot.buy_price_cents, currentValueCents: v?.state === "OK" ? v.value_cents : null, thresholdBps });
      if (f.state === "FLAGGED") alerts.push(`Review ${qty}× ${lot.canonical_item_id}: down ${formatBpsPct(thresholdBps)} or more from cost (unrealized ${formatCents(f.unrealized_pnl_cents)}). Flag only; nothing is sold.`);
    }
  }
  if (d.breaker.active) alerts.push(`Daily loss limit reached: new opportunities are paused until ${d.breaker.expires_at ?? "the cooldown ends"}.`);
  if (d.breaker.state === "INVALID") alerts.push("The stored loss-limit timestamp is unreadable, so the limit is treated as active. Clear it in Settings.");
  if (d.proposals?.length) alerts.push(`${d.proposals.length} fee calibration proposal(s) are waiting for your review (Opportunities → Fee calibration).`);
  els.alerts.innerHTML = alerts.map((a) => `<div class="callout">${escapeHtml(a)}</div>`).join("");

  els.hero.innerHTML = heroHtml(app, d);
  const steps = stepsHtml(app);
  if (!els.steps.contains(document.activeElement) && !els.steps.querySelector("details[open]")) els.steps.innerHTML = steps.join("");
  const remaining = steps.filter((s) => !s.startsWith('<li class="done"')).length;
  els["steps-count"].textContent = remaining ? `${remaining} to do` : "all done";
  els.opps.innerHTML = oppsHtml(app);
  els.money.innerHTML = moneyHtml(app, d);
  renderFigures(d.figures);
  els.evidence.innerHTML = evidenceHtml(app);
}
