// Opportunities: every buy→sell pair the engine evaluated, with source, timestamp, freshness,
// data quality, OBSERVED/ESTIMATED tags, blocked reason and full calculation trace on each row.
// Evidence, paper vs real, data health and fee calibration sit below in collapsible sections.
// Nothing here executes a trade; staging only produces external links.

import { escapeHtml, formatAge, formatBpsPct, formatIsoUtc } from "../js/format.js";
import { dollarsStringToCents, MoneyError } from "../js/money.js";
import { METRICS, PROFIT_FIGURES } from "../js/research/semantics.js";
import { OVERRIDE_PHRASE } from "../js/research/umbra.js";
import { ago, blockedSummary, cents, chip, code, market, oppStatus, QUALITY_TONE, tag, timeUtc } from "./components.js";

let els = {};
const ui = { expanded: new Set(), showAll: false, lastTop: [] };
const keyOf = (o) => `${o.item}|${o.buy_source}|${o.sell_source}`;

export function mount(root, app) {
  root.innerHTML = `
    <div class="page-head">
      <div><h2>Opportunities</h2><p>Every pair the engine checks, every 30 seconds, and the exact reason each one is or isn't worth acting on.</p></div>
      <div class="row"><span id="rs-heartbeat" class="heartbeat" aria-hidden="true"></span><span id="rs-cycle" class="muted small"></span>
        <div class="seg" role="group" aria-label="Rows to show">
          <button type="button" data-show="ranked" aria-pressed="true">Opportunities</button>
          <button type="button" data-show="all" aria-pressed="false" id="rs-showall">All pairs</button>
        </div>
      </div>
    </div>
    <div id="rs-nodaemon"></div>
    <div id="rs-body">
      <div id="rs-fee-alert"></div>
      <section class="card">
        <div id="rs-universe"></div>
        <div class="table-wrap" id="rs-table"><table class="opps"><thead><tr>
          <th>#</th><th>Item</th><th>Route</th><th>Status</th><th class="num">Est. profit ${tag("ESTIMATED")}</th><th class="num">Return / day</th><th>Data</th>
        </tr></thead><tbody id="rs-opps"></tbody></table></div>
        <div id="rs-empty"></div>
      </section>
      <details class="section" id="rs-umbra-section"><summary><span>Ranking mode <span class="muted" id="rs-mode-label"></span></span></summary><div class="section-body" id="rs-controls"></div></details>
      <details class="section"><summary><span>Track record <span class="muted">paper trades and your real trades, never pooled</span></span></summary>
        <div class="section-body grid-2"><div><h4>Forward paper trading ${tag("PAPER")}</h4><div id="rs-paper"></div></div><div><h4>Your real trades ${tag("REAL")}</h4><div id="rs-real"></div></div></div></details>
      <details class="section"><summary><span>Data health <span class="muted">open problems and daily coverage</span></span></summary>
        <div class="section-body grid-2"><div><h4>Open data problems</h4><div id="rs-quality"></div></div><div><h4>Snapshot coverage, last 14 complete UTC days</h4><div id="rs-coverage"></div></div></div></details>
      <details class="section"><summary><span>Staged links and notifications <span class="muted">L1 links only, nothing is submitted</span></span></summary>
        <div class="section-body" id="rs-staged"></div></details>
      <details class="section" id="rs-fees-section"><summary><span>Fee calibration <span class="muted" id="rs-fees-label"></span></span></summary>
        <div class="section-body" id="rs-fees"></div></details>
      <details class="section"><summary><span>How the evidence works <span class="muted">ladder, gates, and what each number means</span></span></summary>
        <div class="section-body"><div id="rs-evidence"></div><h4>What each number does and does not mean</h4><div id="rs-glossary"></div></div></details>
    </div>`;
  els = Object.fromEntries(["nodaemon", "body", "controls", "evidence", "opps", "universe", "cycle", "paper", "real", "quality", "coverage", "staged", "fees", "glossary", "heartbeat", "fee-alert", "mode-label", "fees-label", "fees-section", "table", "empty"].map((k) => [k, root.querySelector(`#rs-${k}`)]));
  els.segButtons = root.querySelectorAll("[data-show]");
  for (const b of els.segButtons) {
    b.addEventListener("click", () => {
      ui.showAll = b.dataset.show === "all";
      for (const x of els.segButtons) x.setAttribute("aria-pressed", String(x === b));
      app.actions.render();
    });
  }
  const toggle = (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-key]");
    if (!tr || e.target.closest("a")) return;
    e.preventDefault();
    if (ui.expanded.has(tr.dataset.key)) ui.expanded.delete(tr.dataset.key);
    else ui.expanded.add(tr.dataset.key);
    app.actions.render();
  };
  els.opps.addEventListener("click", toggle);
  els.opps.addEventListener("keydown", toggle);
  els.controls.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = f.querySelector(".result");
    if (f.id !== "rs-umbra-form") return;
    let bankroll;
    try {
      bankroll = dollarsStringToCents(f.elements.namedItem("bankroll").value.replace(/^\$/, "").trim());
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
      out.className = "result error-text";
      out.textContent = "Bankroll must be dollars with at most 2 decimals";
      return;
    }
    const r = await app.actions.activateUmbra(bankroll, f.elements.namedItem("phrase").value.trim() || undefined, f.elements.namedItem("thin").checked);
    out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
    out.textContent = r.ok ? "Done." : (r.body?.errors ?? [r.error]).join("; ");
  });
  els.controls.addEventListener("click", async (e) => {
    if (e.target.id === "rs-umbra-off") await app.actions.deactivateUmbra();
  });
  els.fees.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-accept]");
    if (!btn) return;
    const p = app.lastProposals?.[Number(btn.dataset.accept)];
    if (!p || !confirm(`Accept this calibration? It creates a new fee model version for ${p.market}. Existing trades keep the version they were recorded under.`)) return;
    const r = await app.actions.acceptCalibration(p);
    alert(r.ok ? `New fee model ${r.fee_model_version} in force.` : r.errors.join("; "));
  });
  els.glossary.innerHTML = `<div class="table-wrap"><table class="compact"><thead><tr><th>Metric</th><th>Category</th><th>Does mean</th><th>Does not mean</th></tr></thead><tbody>${[...Object.entries(METRICS), ...Object.entries(PROFIT_FIGURES)]
    .map(([k, m]) => `<tr><td><code>${escapeHtml(k)}</code></td><td>${tag(m.category)}</td><td>${escapeHtml(m.does)}</td><td>${escapeHtml(m.does_not)}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

function controlsHtml(app) {
  const c = app.research.control;
  if (!c) return "<p class=\"muted\">Loading…</p>";
  const u = c.umbra;
  return `<p class="muted">Standard mode ranks your watchlist inside your price range and limits. <strong>UMBRA</strong> ranks the whole market above $10 by return per day, with the safety rails still on. It changes ranking and the theme only; it never enables buying or selling.</p>
    ${
      u.active
        ? `<p><strong>UMBRA is on</strong>${u.unproven ? ` ${tag("UNPROVEN")}` : ""} · bankroll ${cents(u.bankroll_cents)}${u.allow_thin ? " · thin-liquidity items allowed (labeled)" : ""}</p>
           <p class="hint">Rails always on: ${escapeHtml(u.rails.join(", "))}. Ranking changes: ${escapeHtml(u.ranking_changes.join("; "))}.</p>
           <button type="button" id="rs-umbra-off">Switch back to standard</button>`
        : `<form id="rs-umbra-form" class="form">
             <div class="form-grid">
               <label>Bankroll you'd commit, USD<input name="bankroll" inputmode="decimal" required placeholder="500.00"></label>
               <label>Override phrase <span class="hint">Only needed while signal evidence hasn't passed. Type "${escapeHtml(OVERRIDE_PHRASE)}"; the mode is then labeled UNPROVEN everywhere.</span><input name="phrase" autocomplete="off"></label>
             </div>
             <label class="check"><input type="checkbox" name="thin"> Include items with thin or unknown liquidity (they stay labeled)</label>
             <div class="row-buttons"><button type="submit" class="primary">Turn on UMBRA</button></div>
             <div class="result" aria-live="polite"></div>
           </form>`
    }`;
}

function dataCell(o) {
  const q = o.quality?.state ?? "—";
  const srcs = (o.contributing ?? []).filter((c) => c.kind === "quote");
  return `${chip(q, QUALITY_TONE[q] ?? "")}<div class="small muted">${srcs.map((c) => `${market(c.source)} ${escapeHtml(timeUtc(c.observed_at))} · ${escapeHtml(formatAge(c.effective_age_s))}`).join("<br>") || "no quote"}</div>`;
}

function metric(label, value, category) {
  return `<div><dt>${label}${category ? ` ${tag(category)}` : ""}</dt><dd>${value}</dd></div>`;
}

function detailHtml(o) {
  const m = o.math ?? {};
  const v = o.metrics?.observed_sale_velocity;
  const x = o.metrics?.estimated_exit_days;
  const ls = o.metrics?.listing_supply;
  const ref = o.metrics?.reference_price;
  const inst = o.metrics?.instant_sale_reference;
  const bsl = o.metrics?.buyer_side_liquidity;
  return `<dl class="detail-grid">
      ${metric("Entry cost", cents(m.entry_cost_cents), "OBSERVED")}
      ${metric("Exit ask", cents(m.executable_exit_price_cents), "OBSERVED")}
      ${metric("Hold adverse move (p25)", Number.isSafeInteger(m.hold_adverse_move_ppm) ? formatBpsPct(Math.round(m.hold_adverse_move_ppm / 100)) : "—", "ESTIMATED")}
      ${metric("Reversal reserve", cents(m.reversal_reserve_cents), "USER_ASSUMPTION")}
      ${metric("Estimated net profit", cents(m.expected_net_profit_cents), "ESTIMATED")}
      ${metric("Return per day", Number.isSafeInteger(m.rank_metric_ppm_per_day) ? `${formatBpsPct(Math.round(m.rank_metric_ppm_per_day / 100))}/day` : "—", "ESTIMATED")}
      ${metric("Sales velocity (exit market)", v ? (v.state === "OBSERVED" ? `${v.sales_count} sales / 7 days` : escapeHtml(v.state)) : "—", "OBSERVED")}
      ${metric("Days to exit", x ? (x.state === "ESTIMATED" ? `${Math.floor(x.days_x100 / 100)}.${String(x.days_x100 % 100).padStart(2, "0")}` : escapeHtml(x.state)) : "—", "ESTIMATED")}
      ${metric("Listings near the price", ls ? (ls.state === "OBSERVED" ? `${ls.value}${ls.capped ? "+" : ""}` : escapeHtml(ls.state)) : "—", "OBSERVED")}
      ${metric("CSFloat reference price", ref ? (ref.state === "SIGNAL" ? cents(ref.value_cents) : escapeHtml(ref.state)) : "—", "SIGNAL")}
      ${metric("Buyer-side liquidity", bsl ? escapeHtml(bsl.state) : "—", "OBSERVED")}
      ${metric("Instant sale reference", inst ? escapeHtml(inst.state) : "—", "")}
    </dl>
    ${(o.blocked_reasons ?? []).length ? `<p><strong>Why not:</strong> ${escapeHtml(o.blocked_reasons.join("; "))}</p>` : ""}
    <p class="small"><strong>Sources:</strong> ${(o.contributing ?? []).map((c) => `${escapeHtml(c.role)} ${market(c.source)}/${escapeHtml(c.kind)} observed ${escapeHtml(formatIsoUtc(c.observed_at))} (parser ${escapeHtml(c.parser_version)}, ${escapeHtml(c.parser_status)})`).join(" · ") || "none"}</p>
    <details class="inline"><summary>Calculation trace</summary><ol class="trace">${(o.trace ?? [])
      .map((t) => `<li><span class="trace-step">${escapeHtml(t.step)}</span>${t.category ? ` ${tag(t.category)}` : ""} ${escapeHtml(t.display)}</li>`)
      .join("")}</ol><p class="small muted">Versions: ${escapeHtml(JSON.stringify(o.versions))}</p></details>`;
}

function opportunityRow(o, i, isNew) {
  const key = keyOf(o);
  const open = ui.expanded.has(key);
  const m = o.math ?? {};
  const row = `<tr data-key="${escapeHtml(key)}" data-status="${escapeHtml(o.status)}" class="row-${escapeHtml(o.status)}${isNew ? " flash-new" : ""}${open ? " open" : ""}" tabindex="0" aria-expanded="${open}">
    <td class="num">${o.rank_eligible && i !== null ? i + 1 : "—"}</td>
    <td class="item"><span class="caret">${open ? "▾" : "▸"}</span> ${escapeHtml(o.item)}${o.unproven ? ` ${tag("UNPROVEN")}` : ""}${o.synthetic ? ` ${tag("SYNTHETIC")}` : ""}${o.liquidity_label ? ` ${tag("THIN")}` : ""}</td>
    <td>${market(o.buy_source)} → ${market(o.sell_source)}</td>
    <td>${oppStatus(o.status)}${o.status !== "ELIGIBLE" && o.blocked_reasons?.[0] ? `<div class="small muted blocked-reason">${escapeHtml(o.blocked_reasons[0])}</div>` : ""}</td>
    <td class="num">${cents(m.expected_net_profit_cents)}</td>
    <td class="num">${Number.isSafeInteger(m.rank_metric_ppm_per_day) ? `${formatBpsPct(Math.round(m.rank_metric_ppm_per_day / 100))}` : "—"}</td>
    <td>${dataCell(o)}</td>
  </tr>`;
  return open ? `${row}<tr class="trace-row"><td colspan="7">${detailHtml(o)}</td></tr>` : row;
}

function tradeTable(rows, cols) {
  if (!rows?.length) return "<p class=\"muted\">None yet.</p>";
  return `<div class="table-wrap"><table class="compact"><thead><tr>${cols.map(([h]) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(0, 100)
    .map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function statsTable(stats) {
  const rows = [...Object.entries(stats.by_marketplace).map(([k, s]) => ["market", k, s]), ...Object.entries(stats.by_holding_period).map(([k, s]) => ["hold", k, s])];
  if (!rows.length) return "";
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>By</th><th>Group</th><th>n</th><th>Wins</th><th class="num">Total net</th></tr></thead><tbody>${rows
    .map(([by, k, s]) => `<tr><td>${by}</td><td>${escapeHtml(k)}</td><td>${s.n}</td><td>${s.wins}</td><td class="num">${cents(s.total_net_profit_cents)}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

function emptyHtml(cycle) {
  if (!cycle?.computed_at) return `<div class="empty"><strong>First check in progress</strong>Results appear within 30 seconds.</div>`;
  const reasons = blockedSummary(cycle.all).slice(0, 5);
  return `<div class="empty"><strong>No opportunity right now</strong>That's the correct output while the evidence or data is insufficient.
    ${reasons.length ? `<ul class="reason-list">${reasons.map((r) => `<li>${oppStatus(r.status)} <span class="muted">×${r.count}</span></li>`).join("")}</ul><button type="button" class="small" data-show-all>Show all ${cycle.evaluated} pairs and their reasons</button>` : ""}</div>`;
}

export function update(app, d) {
  if (!app.daemon.available) {
    els.nodaemon.innerHTML = `<div class="card"><div class="empty"><strong>The app isn't running</strong>Opportunities come from the local app, which collects and checks market data. Start it with <code>Orcastrike.cmd</code> or <code>npm start</code>.</div></div>`;
    els.body.hidden = true;
    return;
  }
  els.nodaemon.innerHTML = app.daemon.health?.synthetic_upstream ? '<div class="error-box">Test mode: this app runs against SYNTHETIC data. Nothing shown is evidence.</div>' : "";
  els.body.hidden = false;
  const umbra = Boolean(app.research.control?.umbra?.active);
  els["mode-label"].textContent = umbra ? "UMBRA (whole market, ranking only)" : "standard (your watchlist)";
  if (!els.controls.contains(document.activeElement)) els.controls.innerHTML = controlsHtml(app);

  const cycle = app.research.opportunities[umbra ? "umbra" : "standard"];
  els.cycle.textContent = cycle?.computed_at ? `${cycle.evaluated} pairs · updated ${ago(cycle.computed_at, d.nowMs)}` : "waiting for the first check";
  els.heartbeat.classList.toggle("beat", Boolean(cycle?.computed_at));
  els.universe.innerHTML = cycle?.universe
    ? `<p class="small muted">UMBRA universe: ${cycle.universe.UNIVERSE_SIZE} items (UNIVERSE_SIZE) · discovered ${escapeHtml(cycle.universe.DISCOVERY_TIME ?? "not yet")} (DISCOVERY_TIME) · ${cycle.universe.ITEMS_SKIPPED} skipped (ITEMS_SKIPPED) · SKIP_REASON ${escapeHtml(JSON.stringify(cycle.universe.SKIP_REASON))}</p>`
    : "";
  const list = ui.showAll ? cycle?.all ?? [] : (cycle?.ranked ?? []).filter((o) => o.status === "ELIGIBLE");
  const topKeys = (cycle?.ranked ?? []).slice(0, 3).map(keyOf);
  els.opps.innerHTML = list.map((o, i) => opportunityRow(o, o.rank_eligible ? i : null, umbra && topKeys.includes(keyOf(o)) && !ui.lastTop.includes(keyOf(o)))).join("");
  els.table.hidden = !list.length;
  els.empty.innerHTML = list.length ? "" : emptyHtml(cycle);
  const showAllBtn = els.empty.querySelector("[data-show-all]");
  if (showAllBtn) showAllBtn.addEventListener("click", () => [...els.segButtons].find((b) => b.dataset.show === "all").click());
  ui.lastTop = topKeys;

  const ev = app.research.evidence;
  els.evidence.innerHTML = ev
    ? `<p class="muted small">strategy_version ${code(ev.strategy_version ?? "none yet")} · market regime coverage: <strong>${escapeHtml(ev.market_regime_coverage.state)}</strong> (${escapeHtml(ev.market_regime_coverage.reason)})</p>
       <div class="table-wrap"><table class="compact"><thead><tr><th>Level</th><th>Name</th><th>Status</th><th>Basis (its own evidence only)</th></tr></thead><tbody>${ev.ladder
         .map((l) => `<tr><td>${l.level}</td><td>${escapeHtml(l.name)}</td><td>${chip(l.status, l.status === "REACHED" ? "ok" : "")}</td><td class="small">${escapeHtml(l.basis)}</td></tr>`)
         .join("")}</tbody></table></div>
       ${Object.values(ev.gates)
         .map((g) => `<h4>${escapeHtml(g.gate)} ${chip(g.pass ? "PASS" : "FAIL", g.pass ? "ok" : "")}</h4>
           <div class="table-wrap"><table class="compact"><tbody>${g.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.required)}</td><td>${escapeHtml(String(c.actual))}</td><td>${c.pass ? "✓" : "✗"}</td></tr>`).join("")}</tbody></table></div>`)
         .join("")}`
    : "<p class=\"muted\">Loading…</p>";

  const p = app.research.paper;
  els.paper.innerHTML = p
    ? `<p class="small muted">${escapeHtml(p.label)}. Selection rule: ${escapeHtml(p.selection_rule)}.</p>${statsTable(p.stats)}${tradeTable(p.rows, [
        ["Item", (r) => escapeHtml(r.market_hash_name)],
        ["Route", (r) => `${market(r.buy_source)} → ${market(r.sell_source)}`],
        ["Status", (r) => `${escapeHtml(r.status)}${r.synthetic ? " (SYNTHETIC)" : ""}`],
        ["Opened", (r) => escapeHtml(formatIsoUtc(r.opened_at))],
        ["Entry", (r) => cents(r.entry_cost_cents)],
        ["PAPER_NET_PROFIT", (r) => cents(r.paper_net_profit_cents)],
        ["Void reason", (r) => escapeHtml(r.void_reason ?? "")],
      ])}`
    : "";
  const real = app.research.real;
  els.real.innerHTML = real
    ? `<p class="small muted">Synced from this browser's ledger${app.research.lastSyncAt ? ` ${ago(app.research.lastSyncAt, d.nowMs)}` : ""}${app.research.syncError ? ` · sync error: ${escapeHtml(app.research.syncError)}` : ""}.</p>${statsTable(real.stats)}${tradeTable(real.rows, [
        ["Sold", (r) => escapeHtml(formatIsoUtc(r.sell_timestamp))],
        ["Item", (r) => escapeHtml(r.canonical_item_id)],
        ["Market", (r) => market(r.sell_market)],
        ["REALIZED_NET_PROFIT", (r) => cents(r.realized_net_profit_cents)],
        ["Strategy", (r) => escapeHtml(r.strategy_version)],
      ])}`
    : "";

  const q = app.research.quality;
  els.quality.innerHTML = q
    ? q.open.length
      ? tradeTable(q.open, [
          ["Since", (r) => escapeHtml(formatIsoUtc(r.occurred_at))],
          ["Severity", (r) => chip(r.severity, r.severity === "HIGH" ? "bad" : "warn")],
          ["Problem", (r) => escapeHtml(r.code)],
          ["Where", (r) => escapeHtml(`${r.source ?? ""} ${r.endpoint ?? ""}`)],
          ["Detail", (r) => escapeHtml(r.detail)],
        ])
      : `<p class="muted">${chip("none", "ok")} No open data problems.</p>`
    : "";
  const cov = app.research.coverage;
  els.coverage.innerHTML = cov
    ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Day</th>${Object.keys(cov.plan).map((s) => `<th class="num">${market(s)}</th>`).join("")}</tr></thead><tbody>${cov.days
        .map((day) => `<tr><td>${escapeHtml(Object.values(day)[0]?.day ?? "")}</td>${Object.keys(cov.plan).map((s) => `<td class="num">${day[s]?.coverage_pct_x100 === null || day[s]?.coverage_pct_x100 === undefined ? "—" : `${(day[s].coverage_pct_x100 / 100).toFixed(1)}%`}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div><p class="small muted">Plan: ${escapeHtml(Object.entries(cov.plan).map(([s, pl]) => `${s} ${pl.demanded_per_day}/day needed, ${pl.capacity_per_day}/day possible${pl.feasible ? "" : " (INFEASIBLE)"}`).join(" · "))}</p>`
    : "";

  const c = app.research.control;
  els.staged.innerHTML = c
    ? `${tradeTable(c.staged, [
        ["When", (r) => escapeHtml(formatIsoUtc(r.created_at))],
        ["Action", (r) => `${escapeHtml(r.action)}${r.unproven ? " · UNPROVEN" : ""}`],
        ["Link", (r) => `<a href="${escapeHtml(r.external_url)}" target="_blank" rel="noopener noreferrer">open (format UNVERIFIED)</a>`],
      ])}<h4>Notifications (in-app)</h4>${tradeTable(c.notifications, [
        ["When", (r) => escapeHtml(formatIsoUtc(r.created_at))],
        ["Title", (r) => escapeHtml(r.title)],
        ["Body", (r) => escapeHtml(r.body)],
      ])}<p class="small muted">Push notifications: ${escapeHtml(c.push_notifications.state)} (${escapeHtml(c.push_notifications.reason)})</p>`
    : "";

  app.lastProposals = d.proposals;
  els["fees-label"].textContent = d.proposals.length ? `${d.proposals.length} proposal(s) waiting` : "no proposals";
  els["fee-alert"].innerHTML = d.proposals.length ? `<div class="callout">${d.proposals.length} fee calibration proposal(s) are waiting for your review below.</div>` : "";
  if (d.proposals.length && !els["fees-section"].dataset.autoOpened) {
    els["fees-section"].open = true;
    els["fees-section"].dataset.autoOpened = "1";
  }
  els.fees.innerHTML = `<p class="small">Fee model in force: ${code(app.feeModelCurrent)}. Constants change only when you accept a proposal.</p>${
    d.proposals.length
      ? d.proposals
          .map(
            (pr, i) => `<div class="callout"><strong>PROPOSED_CALIBRATION · ${market(pr.market)}</strong>: ${pr.receipts} receipts, you received ${cents(pr.observed_net_cents)} vs ${cents(pr.expected_net_cents)} expected (difference ${cents(pr.difference_cents)}).
             <br>Possible reasons: ${escapeHtml(pr.possible_reasons.join("; "))}.<br>Proposed change: <code>${escapeHtml(JSON.stringify(pr.proposed_overrides))}</code>
             ${pr.proposed_overrides ? `<br><button type="button" class="small" data-accept="${i}">Accept</button>` : ""}</div>`,
          )
          .join("")
      : '<p class="muted">No proposals. Enter what you actually received when recording a sale, and the app compares it with its fee model.</p>'
  }`;
}
