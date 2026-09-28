// Browser persistence (localStorage) and the settings overlay. DEFAULTS stay immutable;
// validated user overrides are merged into a new effective config. Every storage call is
// wrapped: storage can be missing or throw (private mode, blocked site data).

import { DEFAULTS } from "../config/defaults.js";
import { CSFLOAT_PAYOUT_RAILS } from "../config/fees.js";
import { emptyLedger, isIsoUtc, laterIso, replayLedger } from "./ledger.js";
import { pctToBps } from "./money.js";
import { validateRiskConfig } from "./tiers.js";

export const KEYS = Object.freeze({
  ledger: "sat.ledger.v1",
  settings: "sat.settings.v1",
  watchlist: "sat.watchlist.v1",
  circuitBreaker: "sat.circuit_breaker_triggered_at",
});

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function storageAvailable() {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem("sat.__probe", "1");
    s.removeItem("sat.__probe");
    return true;
  } catch {
    return false;
  }
}

function readRaw(key) {
  const s = storage();
  if (!s) return { ok: true, raw: null };
  try {
    return { ok: true, raw: s.getItem(key) };
  } catch {
    return { ok: false, raw: null };
  }
}

function readJson(key) {
  const r = readRaw(key);
  if (!r.ok) return { ok: false, value: null, error: "storage unreadable" };
  if (r.raw === null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(r.raw) };
  } catch {
    return { ok: false, value: null, error: "stored data is not valid JSON" };
  }
}

function write(key, text) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

// ---- Settings ---------------------------------------------------------------------

export function normalizeWorkerUrl(value) {
  if (value === "" || value === null || value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: "Worker URL must be text" };
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return { ok: false, error: "Worker URL is not a valid URL" };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { ok: false, error: "Worker URL must be https (http allowed only for localhost)" };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: "Worker URL must not contain credentials, query or fragment" };
  return { ok: true, value: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

// overrides: { WORKER_BASE_URL?, CSFLOAT_PAYOUT_RAIL?, risk?: {...}, filters?: {...} }
export function validateSettings(overrides = {}) {
  const errors = [];
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const risk = { ...DEFAULTS.risk, ...(o.risk ?? {}) };
  const filters = { ...DEFAULTS.filters, ...(o.filters ?? {}) };

  const url = normalizeWorkerUrl(o.WORKER_BASE_URL ?? DEFAULTS.WORKER_BASE_URL);
  if (!url.ok) errors.push(url.error);
  const rail = o.CSFLOAT_PAYOUT_RAIL ?? DEFAULTS.CSFLOAT_PAYOUT_RAIL;
  if (!CSFLOAT_PAYOUT_RAILS.includes(rail)) errors.push("CSFloat payout rail must be bank or usdc");

  const rv = validateRiskConfig(risk);
  if (!rv.ok) errors.push(...rv.errors);

  if (!Number.isSafeInteger(filters.MIN_NET_PROFIT_CENTS) || filters.MIN_NET_PROFIT_CENTS < 0) {
    errors.push("MIN_NET_PROFIT_CENTS must be an integer >= 0");
  }
  try {
    const bps = pctToBps(filters.MIN_NET_MARGIN_PCT);
    if (bps < 0) errors.push("MIN_NET_MARGIN_PCT must be >= 0");
  } catch {
    errors.push("MIN_NET_MARGIN_PCT must be a number with at most 2 decimals");
  }
  if (!Number.isSafeInteger(filters.MIN_LISTING_DEPTH) || filters.MIN_LISTING_DEPTH < 1) {
    errors.push("MIN_LISTING_DEPTH must be an integer >= 1");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    effective: Object.freeze({
      ...DEFAULTS,
      WORKER_BASE_URL: url.value,
      CSFLOAT_PAYOUT_RAIL: rail,
      risk: Object.freeze(risk),
      filters: Object.freeze(filters),
    }),
  };
}

// Invalid stored overrides are reported and ignored (defaults apply), never half-applied.
export function loadSettings() {
  const r = readJson(KEYS.settings);
  const overrides = r.ok && r.value && typeof r.value === "object" ? r.value : {};
  const v = validateSettings(overrides);
  if (v.ok) return { overrides, effective: v.effective, errors: r.ok ? [] : [r.error] };
  return { overrides: {}, effective: validateSettings({}).effective, errors: [`stored settings rejected: ${v.errors.join("; ")}`] };
}

export function saveSettings(overrides) {
  const v = validateSettings(overrides);
  if (!v.ok) return v;
  if (!write(KEYS.settings, JSON.stringify(overrides))) return { ok: false, errors: ["could not write settings to storage"] };
  return v;
}

// ---- Watchlist --------------------------------------------------------------------

export function normalizeWatchlist(list, max = DEFAULTS.MAX_TRACKED_ITEMS) {
  const items = [];
  const errors = [];
  let dropped = 0;
  if (!Array.isArray(list)) return { items, dropped, errors: ["watchlist is not a list"] };
  for (const raw of list) {
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 200) {
      errors.push(`invalid entry: ${String(raw).slice(0, 40)}`);
      continue;
    }
    const name = raw.trim();
    if (items.includes(name)) continue;
    if (items.length >= max) {
      dropped += 1;
      continue;
    }
    items.push(name);
  }
  if (dropped) errors.push(`${dropped} item(s) over the ${max}-item cap were not added`);
  return { items, dropped, errors };
}

export function loadWatchlist(starterItems) {
  const r = readJson(KEYS.watchlist);
  if (r.ok && Array.isArray(r.value)) return normalizeWatchlist(r.value);
  return { ...normalizeWatchlist(starterItems), fromStarter: true };
}

export function saveWatchlist(items) {
  const n = normalizeWatchlist(items);
  write(KEYS.watchlist, JSON.stringify(n.items));
  return n;
}

// ---- Ledger -------------------------------------------------------------------------

// Corrupt stored ledger → error and NO overwrite; the user can export raw text first.
export function loadLedger(cfg = DEFAULTS) {
  const r = readJson(KEYS.ledger);
  if (!r.ok) return { ok: false, ledger: null, errors: [r.error], raw: readRaw(KEYS.ledger).raw };
  if (r.value === null) return { ok: true, ledger: emptyLedger(), errors: [] };
  const rep = replayLedger(r.value, { cfg });
  if (!rep.ok) return { ok: false, ledger: null, errors: rep.errors, raw: readRaw(KEYS.ledger).raw };
  return { ok: true, ledger: r.value, errors: [] };
}

export function saveLedger(ledger) {
  return write(KEYS.ledger, JSON.stringify(ledger));
}

// ---- Circuit breaker (ISO timestamp, never a boolean) ------------------------------

export function loadCircuitBreakerTriggeredAt() {
  const r = readRaw(KEYS.circuitBreaker);
  return r.ok ? r.raw : "unreadable";
}

export function persistCircuitBreakerTrip(triggeredAtIso) {
  if (!isIsoUtc(triggeredAtIso)) return false;
  const current = loadCircuitBreakerTriggeredAt();
  const next = isIsoUtc(current) ? laterIso(current, triggeredAtIso) : triggeredAtIso;
  return write(KEYS.circuitBreaker, next);
}

// Only a corrupt (INVALID) stored value may be cleared by the user; an ACTIVE breaker
// cannot be switched off early.
export function clearInvalidCircuitBreaker() {
  const current = loadCircuitBreakerTriggeredAt();
  if (current === null || isIsoUtc(current)) return false;
  const s = storage();
  try {
    s?.removeItem(KEYS.circuitBreaker);
    return true;
  } catch {
    return false;
  }
}
