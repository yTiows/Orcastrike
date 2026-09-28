// Research: evidence gates and ladder, opportunities (with source, timestamp, freshness, data
// quality, OBSERVED/ESTIMATED tags, blocked reason and trace on every row), paper vs real
// (separate), data quality, UMBRA and automation controls, fee calibration. Nothing here
// executes a trade; staging only produces external links.

import { escapeHtml, formatAge, formatBpsPct, formatCents, formatIsoUtc } from "../js/format.js";
import { dollarsStringToCents, MoneyError } from "../js/money.js";
import { METRICS, PROFIT_FIGURES } from "../js/research/semantics.js";
import { OVERRIDE_PHRASE } from "../js/research/umbra.js";

let els = {};
const ui = { expanded: new Set(), showAll: false, lastTop: [] };

const tag = (c) => `<span class="tag tag-${escapeHtml(String(c).replace(/[^A-Z_-]/gi, ""))}">${escapeHtml(c)}</span>`;
const cents = (v) => (Number.isSafeInteger(v) ? formatCents(v) : "—");

export function mount(root, app) {
  root.innerHTML = `
    <h2>Research <span class="muted">(evidence before opportunities)</span></h2>
    <div id="rs-nodaemon"></div>
    <div id="rs-body">
      <section class="panel" id="rs-controls"></section>
      <section class="panel"><h3>Evidence ladder and gates</h3><div id="rs-evidence"></div></section>
      <section class="panel">
        <h3>Opportunities <span class="muted">(Level 2+: ESTIMATED from live observations; not a forecast)</span></h3>
        <div class="toolbar"><label><input type="checkbox" id="rs-showall"> show every evaluated pair with its blocked reason</label><span id="rs-heartbeat" class="heartbeat" aria-hidden="true"></span><span id="rs-cycle" class="muted"></span></div>
        <div id="rs-universe"></div>
        <div class="table-wrap"><table class="scanner"><thead><tr>
          <th>#</th><th>Item</th><th>Buy → sell</th><th>Status</th><th>Data quality</th><th>Sources · observed · age</th>
          <th>Entry cost ${tag("OBSERVED")}</th><th>Exit ask ${tag("OBSERVED")}</th><th>hold_adverse_move ${tag("ESTIMATED")}</th>
          <th>expected_net_profit ${tag("ESTIMATED")}</th><th>rank_metric</th><th>Velocity ${tag("OBSERVED")} / exit days ${tag("ESTIMATED")}</th>
          <th>listing_supply ${tag("OBSERVED")}</th><th>reference ${tag("SIGNAL")}</th><th>Blocked reason</th>
        </tr></thead><tbody id="rs-opps"></tbody></table></div>
      </section>
      <div class="grid-2">
        <section class="panel"><h3>Forward paper trading evaluation ${tag("PAPER")}</h3><div id="rs-paper"></div></section>
        <section class="panel"><h3>Real trades ${tag("REAL")}</h3><div id="rs-real"></div></section>
      </div>
      <div class="grid-2">
        <section class="panel"><h3>Data quality</h3><div id="rs-quality"></div></section>
        <section class="panel"><h3>Snapshot coverage (last 14 complete UTC days)</h3><div id="rs-coverage"></div></section>
      </div>
      <div class="grid-2">
        <section class="panel"><h3>Staged actions (L1: links only, no submission) and notifications</h3><div id="rs-staged"></div></section>
        <section class="panel"><h3>Fee calibration</h3><div id="rs-fees"></div></section>
      </div>
    </div>
    <section class="panel"><h3>What each number does and does not mean</h3><div id="rs-glossary"></div></section>`;
  els = Object.fromEntries(["nodaemon", "body", "controls", "evidence", "opps", "universe", "cycle", "paper", "real", "quality", "coverage", "staged", "fees", "glossary", "showall", "heartbeat"].map((k) => [k, root.querySelector(`#rs-${k}`)]));
  els.showall.addEventListener("change", (e) => {
    ui.showAll = e.target.checked;
    app.actions.render();
  });
  els.opps.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    if (ui.expanded.has(tr.dataset.key)) ui.expanded.delete(tr.dataset.key);
    else ui.expanded.add(tr.dataset.key);
    app.actions.render();
  });
  els.controls.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = f.querySelector(".result");
    let r;
    if (f.id === "rs-umbra-form") {
      let bankroll;
      try {
        bankroll = dollarsStringToCents(f.elements.namedItem("bankroll").value.replace(/^\$/, "").trim());
      } catch (err) {
        if (!(err instanceof MoneyError)) throw err;
        out.className = "result error-text";
        out.textContent = "Bankroll must be dollars with at most 2 decimals";
        return;
      }
      r = await app.actions.activateUmbra(bankroll, f.elements.namedItem("phrase").value.trim() || undefined, f.elements.namedItem("thin").checked);
    }
    if (r) {
      out.className = `result ${r.ok ? "ok-text" : "error-text"}`;
      out.textContent = r.ok ? "Done." : (r.body?.errors ?? [r.error]).join("; ");
    }
  });
  els.controls.addEventListener("change", async (e) => {
    if (e.target.name === "mode") await app.actions.setMode(e.target.value);
    if (e.target.name === "level") {
      const r = await app.actions.setAutomationLevel(e.target.value);
      if (!r.ok) alert((r.body?.errors ?? [r.error]).join("; "));
    }
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
  if (!c) return "<p class=\"muted\">Loading control state…</p>";
  const modes = ["RESEARCH", "PAPER", "ASSISTED", "AUTOMATION"]
    .map((m) => `<label><input type="radio" name="mode" value="${m}"${c.mode === m ? " checked" : ""}${m === "AUTOMATION" ? " disabled" : ""}> ${m}${m === "AUTOMATION" ? " <span class=\"muted\">(requires L3: UNVERIFIED)</span>" : ""}</label>`)
    .join("");
  const levels = c.automation.levels
    .map((l) => `<label title="${escapeHtml(l.reason ?? "")}"><input type="radio" name="level" value="${l.level}"${c.automation.level === l.level ? " checked" : ""}${l.available ? "" : " disabled"}> ${l.level}${l.available ? "" : ` <span class="muted">${escapeHtml(l.reason)}</span>`}</label>`)
    .join("");
  const u = c.umbra;
  return `
    <div class="grid-2">
      <fieldset class="filters"><legend>Operating mode</legend>${modes}
        <p class="hint">RESEARCH computes and logs. PAPER logs a paper trade for every eligible alert. ASSISTED shows per-transaction approvals (execution stays external).</p></fieldset>
      <fieldset class="filters"><legend>Automation level (default OFF = L0)</legend>${levels}
        <p class="hint">L1 stages external links only. L2/L3 need a verified execution API, which doesn't exist in this build. No mode or theme grants execution.</p></fieldset>
    </div>
    <div class="umbra-box">
      <h3>UMBRA <span class="muted">ranking mode + theme only, never grants execution</span></h3>
      ${
        u.active
          ? `<p><strong>ACTIVE</strong>${u.unproven ? ' <span class="status s-BLOCKED_BY_CIRCUIT_BREAKER">UNPROVEN</span>' : ""} · bankroll ${cents(u.bankroll_cents)}${u.allow_thin ? " · THIN items allowed (labeled)" : ""}</p>
             <p class="hint">Rails always on: ${escapeHtml(u.rails.join(", "))}. Ranking changes: ${escapeHtml(u.ranking_changes.join("; "))}.</p>
             <button type="button" id="rs-umbra-off">Deactivate UMBRA</button>`
          : `<form id="rs-umbra-form" class="inline-form">
               <label>Declared bankroll, USD<input name="bankroll" inputmode="decimal" required placeholder="500.00"></label>
               <label>Override phrase <span class="muted">(only if SIGNAL_EVIDENCE hasn't passed: type "${escapeHtml(OVERRIDE_PHRASE)}")</span><input name="phrase" autocomplete="off"></label>
               <label class="check"><input type="checkbox" name="thin"> allow THIN/UNKNOWN-liquidity items (stay labeled)</label>
               <button type="submit" class="primary">Activate UMBRA</button>
               <div class="result" aria-live="polite"></div>
             </form>`
      }
    </div>`;
}

function opportunityRow(o, i, isNew) {
  const key = `${o.item}|${o.buy_source}|${o.sell_source}`;
  const open = ui.expanded.has(key);
  const m = o.math ?? {};
  const v = o.metrics?.observed_sale_velocity;
  const x = o.metrics?.estimated_exit_days;
  const ls = o.metrics?.listing_supply;
  const ref = o.metrics?.reference_price;
  const srcs = (o.contributing ?? [])
    .filter((c) => c.kind === "quote")
    .map((c) => `${escapeHtml(c.source)} ${escapeHtml(formatIsoUtc(c.observed_at))} (${escapeHtml(formatAge(c.effective_age_s))})`)
    .join("<br>");
  const row = `<tr data-key="${escapeHtml(key)}" class="row-${escapeHtml(o.status)}${isNew ? " flash-new" : ""}${open ? " open" : ""}" tabindex="0">
    <td class="num">${o.rank_eligible && i !== null ? i + 1 : "—"}</td>
    <td class="item">${open ? "▾" : "▸"} ${escapeHtml(o.item)}${o.unproven ? ' <span class="tag tag-UNPROVEN">UNPROVEN</span>' : ""}${o.synthetic ? ' <span class="tag tag-SYNTHETIC">SYNTHETIC</span>' : ""}${o.liquidity_label ? ` <span class="tag tag-THIN">${escapeHtml(o.liquidity_label)}</span>` : ""}</td>
    <td>${escapeHtml(o.buy_source)} → ${escapeHtml(o.sell_source)}</td>
    <td><span class="status s-${escapeHtml(o.status === "ELIGIBLE" ? "HIGHLIGHTED" : o.status.startsWith("BLOCKED") ? o.status : "INSUFFICIENT_DATA")}">${escapeHtml(o.status)}</span></td>
    <td>${escapeHtml(o.quality?.state ?? "—")}</td>
    <td class="small">${srcs || "—"}</td>
    <td class="num">${cents(m.entry_cost_cents)}</td>
    <td class="num">${cents(m.executable_exit_price_cents)}</td>
    <td class="num">${Number.isSafeInteger(m.hold_adverse_move_ppm) ? formatBpsPct(Math.round(m.hold_adverse_move_ppm / 100)) : "—"}</td>
    <td class="num">${cents(m.expected_net_profit_cents)}</td>
    <td class="num">${Number.isSafeInteger(m.rank_metric_ppm_per_day) ? `${formatBpsPct(Math.round(m.rank_metric_ppm_per_day / 100))}/day` : "—"}</td>
    <td>${v ? (v.state === "OBSERVED" ? `${v.sales_count}/7d` : escapeHtml(v.state)) : "—"} · ${x ? (x.state === "ESTIMATED" ? `${Math.floor(x.days_x100 / 100)}.${String(x.days_x100 % 100).padStart(2, "0")}d` : escapeHtml(x.state)) : "—"}</td>
    <td>${ls ? (ls.state === "OBSERVED" ? `${ls.value}${ls.capped ? "+" : ""}` : escapeHtml(ls.state)) : "—"}</td>
    <td>${ref ? (ref.state === "SIGNAL" ? cents(ref.value_cents) : escapeHtml(ref.state)) : "—"}</td>
    <td class="small">${escapeHtml((o.blocked_reasons ?? []).join("; ") || (o.status === "ELIGIBLE" ? "—" : ""))}</td>
  </tr>`;
  if (!open) return row;
  return `${row}<tr class="trace-row"><td colspan="15"><ol class="trace">${o.trace
    .map((t) => `<li><span class="trace-step">${escapeHtml(t.step)}</span>${t.category ? ` ${tag(t.category)}` : ""} ${escapeHtml(t.display)}</li>`)
    .join("")}</ol><p class="small muted">Versions: ${escapeHtml(JSON.stringify(o.versions))}. Contributing observations: ${escapeHtml(
    (o.contributing ?? []).map((c) => `${c.role}#${c.id} ${c.source}/${c.kind} ${c.observed_at} parser ${c.parser_version} ${c.parser_status}`).join(" | "),
  )}</p></td></tr>`;
}

function tradeTable(rows, cols) {
  if (!rows?.length) return "<p class=\"muted\">None.</p>";
  return `<div class="table-wrap"><table class="compact"><thead><tr>${cols.map(([h]) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(0, 100)
    .map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function statsTable(stats) {
  const rows = [...Object.entries(stats.by_marketplace).map(([k, s]) => ["market", k, s]), ...Object.entries(stats.by_holding_period).map(([k, s]) => ["hold", k, s])];
  if (!rows.length) return "";
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>By</th><th>Group</th><th>n</th><th>Wins</th><th>Total net</th></tr></thead><tbody>${rows
    .map(([by, k, s]) => `<tr><td>${by}</td><td>${escapeHtml(k)}</td><td>${s.n}</td><td>${s.wins}</td><td class="num">${formatCents(s.total_net_profit_cents)}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

export function update(app, d) {
  if (!app.daemon.available) {
    els.nodaemon.innerHTML = `<div class="alert-box">Research features need the local daemon. Run <code>node daemon/main.js</code> and open <code>http://127.0.0.1:8790</code>. Without it there are no observations, no evidence and no opportunities beyond the Level 1 scanner, and every figure below says UNAVAILABLE.</div>`;
    els.body.hidden = true;
    return;
  }
  els.nodaemon.innerHTML = app.daemon.health?.synthetic_upstream ? '<div class="error-box">SYNTHETIC upstream: this daemon runs against test data. Nothing shown is evidence.</div>' : "";
  els.body.hidden = false;
  if (!els.controls.contains(document.activeElement)) els.controls.innerHTML = controlsHtml(app);

  const ev = app.research.evidence;
  els.evidence.innerHTML = ev
    ? `<p class="muted">strategy_version <code>${escapeHtml(ev.strategy_version ?? "none yet")}</code> · market regime coverage: <strong>${escapeHtml(ev.market_regime_coverage.state)}</strong> (${escapeHtml(ev.market_regime_coverage.reason)})</p>
       <div class="table-wrap"><table class="compact"><thead><tr><th>Level</th><th>Name</th><th>Status</th><th>Basis (its own evidence only)</th></tr></thead><tbody>${ev.ladder
         .map((l) => `<tr><td>${l.level}</td><td>${escapeHtml(l.name)}</td><td><span class="status ${l.status === "REACHED" ? "s-HIGHLIGHTED" : "s-INSUFFICIENT_DATA"}">${l.status}</span></td><td class="small">${escapeHtml(l.basis)}</td></tr>`)
         .join("")}</tbody></table></div>
       ${Object.values(ev.gates)
         .map(
           (g) => `<h4>${escapeHtml(g.gate)} <span class="status ${g.pass ? "s-HIGHLIGHTED" : "s-INSUFFICIENT_DATA"}">${g.pass ? "PASS" : "FAIL"}</span></h4>
           <div class="table-wrap"><table class="compact"><tbody>${g.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.required)}</td><td>${escapeHtml(String(c.actual))}</td><td>${c.pass ? "✓" : "✗"}</td></tr>`).join("")}</tbody></table></div>`,
         )
         .join("")}`
    : "<p class=\"muted\">Loading…</p>";

  const umbra = Boolean(app.research.control?.umbra?.active);
  const cycle = app.research.opportunities[umbra ? "umbra" : "standard"];
  els.cycle.textContent = cycle?.computed_at ? `${cycle.mode} cycle ${formatIsoUtc(cycle.computed_at)} · ${cycle.evaluated} pairs · ${cycle.ranked.length} rank-eligible · counts ${JSON.stringify(cycle.counts)}` : "no engine cycle yet";
  els.heartbeat.classList.toggle("beat", Boolean(cycle?.computed_at));
  els.universe.innerHTML = cycle?.universe
    ? `<p class="small">UNIVERSE_SIZE ${cycle.universe.UNIVERSE_SIZE} · DISCOVERY_TIME ${escapeHtml(cycle.universe.DISCOVERY_TIME ?? "none yet")} · ITEMS_SKIPPED ${cycle.universe.ITEMS_SKIPPED} · SKIP_REASON ${escapeHtml(JSON.stringify(cycle.universe.SKIP_REASON))}</p>`
    : "";
  const list = ui.showAll ? cycle?.all ?? [] : cycle?.ranked ?? [];
  const topKeys = (cycle?.ranked ?? []).slice(0, 3).map((o) => `${o.item}|${o.buy_source}|${o.sell_source}`);
  els.opps.innerHTML = list.length
    ? list.map((o, i) => opportunityRow(o, o.rank_eligible ? i : null, umbra && topKeys.includes(`${o.item}|${o.buy_source}|${o.sell_source}`) && !ui.lastTop.includes(`${o.item}|${o.buy_source}|${o.sell_source}`))).join("")
    : `<tr><td colspan="15" class="muted">No opportunity. That is the correct output while evidence or data is insufficient. Tick "show every evaluated pair" to see why.</td></tr>`;
  ui.lastTop = topKeys;

  const p = app.research.paper;
  els.paper.innerHTML = p
    ? `<p class="small muted">${escapeHtml(p.label)}. Selection rule: ${escapeHtml(p.selection_rule)}.</p>${statsTable(p.stats)}${tradeTable(p.rows, [
        ["Item", (r) => escapeHtml(r.market_hash_name)],
        ["Pair", (r) => `${escapeHtml(r.buy_source)}→${escapeHtml(r.sell_source)}`],
        ["Status", (r) => `${escapeHtml(r.status)}${r.synthetic ? " (SYNTHETIC)" : ""}`],
        ["Opened", (r) => escapeHtml(formatIsoUtc(r.opened_at))],
        ["Entry", (r) => cents(r.entry_cost_cents)],
        ["PAPER_NET_PROFIT", (r) => cents(r.paper_net_profit_cents)],
        ["Void reason", (r) => escapeHtml(r.void_reason ?? "")],
      ])}`
    : "";
  const real = app.research.real;
  els.real.innerHTML = real
    ? `<p class="small muted">Synced from this browser's ledger${app.research.lastSyncAt ? ` at ${escapeHtml(app.research.lastSyncAt)}` : ""}${app.research.syncError ? ` · sync error: ${escapeHtml(app.research.syncError)}` : ""}. Never pooled with paper.</p>${statsTable(real.stats)}${tradeTable(real.rows, [
        ["Sold", (r) => escapeHtml(formatIsoUtc(r.sell_timestamp))],
        ["Item", (r) => escapeHtml(r.canonical_item_id)],
        ["Market", (r) => escapeHtml(r.sell_market)],
        ["REALIZED_NET_PROFIT", (r) => cents(r.realized_net_profit_cents)],
        ["Strategy", (r) => escapeHtml(r.strategy_version)],
      ])}`
    : "";

  const q = app.research.quality;
  els.quality.innerHTML = q
    ? tradeTable(q.open, [
        ["Since", (r) => escapeHtml(formatIsoUtc(r.occurred_at))],
        ["Severity", (r) => `<span class="status ${r.severity === "HIGH" ? "s-BLOCKED_BY_CIRCUIT_BREAKER" : "s-STALE"}">${escapeHtml(r.severity)}</span>`],
        ["Code", (r) => escapeHtml(r.code)],
        ["Where", (r) => escapeHtml(`${r.source ?? ""} ${r.endpoint ?? ""}`)],
        ["Detail", (r) => escapeHtml(r.detail)],
      ])
    : "";
  const cov = app.research.coverage;
  els.coverage.innerHTML = cov
    ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Day</th>${Object.keys(cov.plan).map((s) => `<th>${escapeHtml(s)}</th>`).join("")}</tr></thead><tbody>${cov.days
        .map((day) => `<tr><td>${escapeHtml(Object.values(day)[0]?.day ?? "")}</td>${Object.keys(cov.plan).map((s) => `<td class="num">${day[s]?.coverage_pct_x100 === null || day[s]?.coverage_pct_x100 === undefined ? "—" : `${(day[s].coverage_pct_x100 / 100).toFixed(1)}%`}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div><p class="small muted">Plan: ${escapeHtml(Object.entries(cov.plan).map(([s, p]) => `${s} ${p.demanded_per_day}/day demanded, ${p.capacity_per_day}/day capacity${p.feasible ? "" : " (INFEASIBLE)"}`).join(" · "))}</p>`
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
  els.fees.innerHTML = `<p class="small">Fee model in force: <code>${escapeHtml(app.feeModelCurrent)}</code>. Constants change only when you accept a proposal.</p>${
    d.proposals.length
      ? d.proposals
          .map(
            (p, i) => `<div class="alert-box"><strong>PROPOSED_CALIBRATION · ${escapeHtml(p.market)}</strong>: ${p.receipts} receipts, observed ${cents(p.observed_net_cents)} vs expected ${cents(p.expected_net_cents)} (difference ${cents(p.difference_cents)}).
             <br>Possible reasons: ${escapeHtml(p.possible_reasons.join("; "))}.<br>Proposed change: <code>${escapeHtml(JSON.stringify(p.proposed_overrides))}</code>
             ${p.proposed_overrides ? `<button type="button" data-accept="${i}">Accept</button>` : ""}</div>`,
          )
          .join("")
      : '<p class="muted">No proposals. Enter receipts (actual net received) on sales to enable calibration.</p>'
  }`;
}
