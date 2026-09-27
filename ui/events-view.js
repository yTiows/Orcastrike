// Event tracker: sourced event dates + descriptive 7d-before/after price deltas.
// confidence reflects source certainty only — never a market-impact prediction.

import { escapeHtml, formatBpsPct, formatCents } from "../js/format.js";
import { DELTA_METHODOLOGY, eventPriceDelta } from "../js/events.js";

let els = {};

export function mount(root, app) {
  root.innerHTML = `
    <h2>Events</h2>
    <p class="muted"><strong>Confidence</strong> = certainty of the source for the event's name and dates. It is not a forecast of price impact.</p>
    <div class="table-wrap" id="ev-table"></div>
    <div id="ev-rejected"></div>
    <section class="panel">
      <h3>Price change around an event <span class="muted">(descriptive)</span></h3>
      <form id="ev-form" class="inline-form">
        <label>Event <select id="ev-select"></select></label>
        <label>Item <select id="ev-item"></select></label>
        <button type="submit">Compute</button>
      </form>
      <div id="ev-result" aria-live="polite"></div>
      <p class="muted">Methodology: ${escapeHtml(DELTA_METHODOLOGY)}</p>
    </section>`;
  els = {
    table: root.querySelector("#ev-table"),
    rejected: root.querySelector("#ev-rejected"),
    select: root.querySelector("#ev-select"),
    item: root.querySelector("#ev-item"),
    result: root.querySelector("#ev-result"),
  };
  root.querySelector("#ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ev = app.events.events[Number(els.select.value)];
    const item = els.item.value;
    if (!ev || !item) return;
    els.result.textContent = "Loading Steam history…";
    const h = app.histories.get(item) ?? (await app.actions.loadHistory(item));
    const r = eventPriceDelta(h.state === "AVAILABLE" ? h.points : [], ev.start_date, app.cfg);
    els.result.innerHTML =
      r.state === "OK"
        ? `<p>${escapeHtml(item)} around <strong>${escapeHtml(ev.name)}</strong> (${escapeHtml(ev.start_date)}): mean ${formatCents(r.before_mean_cents)} in the 7 days before → ${formatCents(r.after_mean_cents)} in the 7 days from the start: <strong>${formatBpsPct(r.change_bps)}</strong> (${r.days_before}/${r.days_after} days with data). Descriptive only.</p>`
        : `<p><span class="status s-INSUFFICIENT_DATA">INSUFFICIENT_DATA</span> ${escapeHtml(r.reason)}${h.state !== "AVAILABLE" ? ` (history: ${escapeHtml(h.state)} — ${escapeHtml(h.reason ?? "")})` : ""}</p>`;
  });
}

export function update(app) {
  const { events, rejected } = app.events;
  els.table.innerHTML = app.eventsError
    ? `<p class="error-text">static/events.json could not be loaded: ${escapeHtml(app.eventsError)}</p>`
    : events.length
      ? `<table><thead><tr><th>Type</th><th>Name</th><th>Start</th><th>End</th><th>Confidence (source)</th><th>Source</th><th>Retrieved</th><th>Methodology</th></tr></thead><tbody>${events
          .map(
            (e) => `<tr><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.start_date)}</td><td>${escapeHtml(e.end_date)}</td>
            <td>${escapeHtml(e.confidence)}</td><td><a href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer">source</a></td>
            <td>${escapeHtml(e.retrieval_date)}</td><td class="small">${escapeHtml(e.methodology)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="muted">No events.</p>`;
  els.rejected.innerHTML = rejected.length
    ? `<div class="error-box"><strong>${rejected.length} event entr${rejected.length === 1 ? "y" : "ies"} rejected by schema validation (not shown above):</strong><ul>${rejected
        .map((r) => `<li>${escapeHtml(r.event?.name ?? "?")}: ${escapeHtml(r.errors.join(", "))}</li>`)
        .join("")}</ul></div>`
    : "";
  const selEv = els.select.value;
  els.select.innerHTML = events.map((e, i) => `<option value="${i}"${String(i) === selEv ? " selected" : ""}>${escapeHtml(e.name)} (${escapeHtml(e.start_date)})</option>`).join("");
  const selItem = els.item.value;
  els.item.innerHTML = app.watchlist.map((i) => `<option${i === selItem ? " selected" : ""}>${escapeHtml(i)}</option>`).join("");
}
