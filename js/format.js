// Display formatting only. Integer string math; no value produced here feeds a calculation.

export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) return "—";
  const neg = cents < 0;
  const abs = neg ? -cents : cents;
  const dollars = (abs - (abs % 100)) / 100;
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${rest}`;
}

// 1580 bps → "15.80%"
export function formatBpsPct(bps) {
  if (!Number.isSafeInteger(bps)) return "—";
  const neg = bps < 0;
  const abs = neg ? -bps : bps;
  const whole = (abs - (abs % 100)) / 100;
  return `${neg ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}%`;
}

// Countdown until an ISO timestamp: "4d 13h", "2h 05m", "eligible".
export function formatCountdown(untilIso, nowMs = Date.now()) {
  const until = Date.parse(untilIso);
  if (Number.isNaN(until)) return "INVALID TIMESTAMP";
  let ms = until - nowMs;
  if (ms <= 0) return "eligible";
  const d = Math.floor(ms / 86400000);
  ms -= d * 86400000;
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 0) return "future?";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function isoNow(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

// "2026-09-27T12:00:00.000Z" → "2026-09-27 12:00 UTC"
export function formatIsoUtc(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "INVALID TIMESTAMP";
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 1083400 micros → "1.083400"
export function formatMicros(micros) {
  if (!Number.isSafeInteger(micros) || micros < 0) return "—";
  return `${(micros - (micros % 1000000)) / 1000000}.${String(micros % 1000000).padStart(6, "0")}`;
}
