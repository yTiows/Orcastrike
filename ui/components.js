// Shared UI pieces. Plain-language labels sit next to the exact technical status (never instead
// of it), so every screen stays traceable to the engine, the docs and the tests.

import { escapeHtml, formatAge, formatCents, formatIsoUtc } from "../js/format.js";

export const MARKET = { steam: "Steam", csfloat: "CSFloat", skinport: "Skinport", fx: "ECB rate" };
export const market = (m) => MARKET[m] ?? escapeHtml(m ?? "—");

export const cents = (v) => (Number.isSafeInteger(v) ? formatCents(v) : "—");
export const tag = (c) => `<span class="tag tag-${escapeHtml(String(c).replace(/[^A-Z_-]/gi, ""))}">${escapeHtml(c)}</span>`;
export const chip = (text, tone = "", title = "") => `<span class="chip ${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`;
export const code = (text) => `<span class="code">${escapeHtml(text)}</span>`;

export function stat(label, value, sub = "", cls = "") {
  return `<div class="stat ${cls}"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
}

// value/target progress; `display` overrides the right-hand text.
export function meter(label, value, target, display) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(value, target)) : 0;
  const done = Number.isFinite(value) && value >= target;
  return `<div class="meter"><div class="meter-top"><span>${label}</span><span>${display ?? `${Number.isFinite(value) ? value : "—"} / ${target}`}</span></div><progress class="${done ? "done" : ""}" max="${target}" value="${v}"></progress></div>`;
}

export function ago(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return `${formatAge((nowMs - t) / 1000)} ago`;
}

export const timeUtc = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(11, 16)} UTC`;
};
export { formatIsoUtc };

// Opportunity engine statuses (js/research/opportunity.js STATUS) → [plain label, tone].
export const OPP_STATUS = {
  ELIGIBLE: ["Opportunity", "ok"],
  INVALID: ["Invalid data", "bad"],
  INSUFFICIENT: ["Not enough verified data", "warn"],
  STALE: ["Price too old", "warn"],
  CONFLICTING: ["Prices from different moments", "warn"],
  IDENTITY_AMBIGUOUS: ["Item identity unclear", "warn"],
  HOLD_ADVERSE_INSUFFICIENT: ["Needs more price history", "info"],
  NON_POSITIVE: ["No profit after fees", ""],
  LIQUIDITY_THIN: ["Too few sales to exit", "warn"],
  LIQUIDITY_UNKNOWN: ["Exit liquidity unknown", "warn"],
  BELOW_MINIMUM: ["Below your minimum", ""],
  BELOW_UMBRA_FLOOR: ["Under the $10 UMBRA floor", ""],
  CAPITAL_UNKNOWN: ["Record your cash first", "info"],
  BLOCKED_BY_CIRCUIT_BREAKER: ["Paused: daily loss limit", "bad"],
  BLOCKED_BY_TIER: ["Outside your price range", ""],
  BLOCKED_BY_POSITION_SIZE: ["Too large for your limits", ""],
};
export function oppStatus(status) {
  const [label, tone] = OPP_STATUS[status] ?? [status, ""];
  return `${chip(label, tone)} ${code(status)}`;
}

// Level 1 scanner statuses (js/scanner.js ELIGIBILITY).
export const SCAN_STATUS = {
  HIGHLIGHTED: ["Spread found", "ok"],
  THIN_LIQUIDITY: ["Few listings near the price", "warn"],
  STALE: ["Price too old", "warn"],
  BLOCKED_BY_TIER: ["Outside your price range", ""],
  BLOCKED_BY_POSITION_SIZE: ["Too large for your limits", ""],
  BLOCKED_BY_CIRCUIT_BREAKER: ["Paused: daily loss limit", "bad"],
  INSUFFICIENT_DATA: ["Not enough data", "warn"],
  BELOW_FILTER: ["Below your minimum", ""],
};
export function scanStatus(status) {
  const [label, tone] = SCAN_STATUS[status] ?? [status, ""];
  return `${chip(label, tone)} <span class="status s-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export const QUALITY_TONE = { COMPLETE: "ok", PARTIAL: "info", STALE: "warn", CONFLICTING: "warn", INSUFFICIENT: "warn", INVALID: "bad" };

// The five profit figures keep their technical names; these are the plain names shown first.
export const FIGURE_LABEL = {
  REALIZED_NET_PROFIT: "Realized profit",
  PAPER_NET_PROFIT: "Paper-trading profit",
  HISTORICAL_SIMULATED_PROFIT: "Historical simulation",
  MARK_TO_MARKET_UNREALIZED_PNL: "Unrealized, at current prices",
  ESTIMATED_EXIT_PROFIT: "Estimated if sold now",
};

// Groups every non-eligible pair by status, most common first: the "why nothing?" answer.
export function blockedSummary(all) {
  const m = new Map();
  for (const o of all ?? []) if (o.status !== "ELIGIBLE") m.set(o.status, (m.get(o.status) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, count, label: OPP_STATUS[status]?.[0] ?? status }));
}

// Live-data verification per source → [plain text, tone].
export function sourceState(name, app) {
  const h = app.daemon.health;
  const verified = h?.verify?.by_source?.[name] ?? app.parserVerification?.[name];
  const recent = h?.data?.sources?.[name === "skinport" ? "skinport" : name];
  if (name === "csfloat" && h && h.sources?.csfloat !== "CONFIGURED") return ["needs API key", "info"];
  if (verified === "VERIFIED") return ["verified", "ok"];
  if (verified === "BLOCKED") return ["unreachable from this network", "bad"];
  if (verified === "FORMAT_CHANGED") return ["format changed, needs a parser update", "bad"];
  if (recent?.ok > 0) return ["reachable, not verified yet", "warn"];
  if (recent?.failed > 0) return [`failing (${String(recent.last_failure ?? "error").toLowerCase().replace(/_/g, " ")})`, "bad"];
  return ["not checked yet", ""];
}

export function copyButton(text, label = "Copy") {
  return `<button type="button" class="small" data-copy="${escapeHtml(text)}">${escapeHtml(label)}</button>`;
}

// One delegated listener per root for [data-copy] buttons.
export function bindCopy(root) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const old = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = old), 1200);
    } catch {
      /* clipboard unavailable: the text is visible to copy by hand */
    }
  });
}
