// Event tracker. confidence = certainty of the SOURCE for the event facts (dates/name),
// never a predicted market impact. Price deltas are computed live from Steam history;
// when history is missing for an item, the result is INSUFFICIENT_DATA, not omitted.

import { DEFAULTS } from "../config/defaults.js";
import { marginBps, mulDivRoundHalfUp } from "./money.js";

export const EVENT_TYPES = Object.freeze(["major", "case_release", "operation"]);
export const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);
const REQUIRED = ["type", "name", "start_date", "end_date", "source_url", "retrieval_date", "confidence", "methodology"];
const OPTIONAL = ["notes"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

export const DELTA_METHODOLOGY =
  "Mean daily Steam price (Worker history: daily volume-weighted mean of Steam median sale prices) over the 7 days " +
  "from start_date inclusive, versus the 7 days before start_date; change = (after − before) / before. " +
  "Each side needs at least 5 days with sales, otherwise INSUFFICIENT_DATA. Descriptive only; not a forecast.";

function isDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, errors: ["not an object"] };
  for (const k of REQUIRED) if (!(k in e)) errors.push(`missing ${k}`);
  for (const k of Object.keys(e)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) errors.push(`unknown field ${k}`);
  if (!EVENT_TYPES.includes(e.type)) errors.push("type must be major|case_release|operation");
  if (typeof e.name !== "string" || !e.name.trim()) errors.push("name required");
  if (!isDate(e.start_date)) errors.push("start_date must be YYYY-MM-DD");
  if (!isDate(e.end_date)) errors.push("end_date must be YYYY-MM-DD");
  if (isDate(e.start_date) && isDate(e.end_date) && e.end_date < e.start_date) errors.push("end_date before start_date");
  if (typeof e.source_url !== "string" || !/^https:\/\/[^\s]+$/.test(e.source_url)) errors.push("source_url must be an https URL");
  if (!isDate(e.retrieval_date)) errors.push("retrieval_date must be YYYY-MM-DD");
  if (!CONFIDENCE_LEVELS.includes(e.confidence)) errors.push("confidence must be high|medium|low");
  if (typeof e.methodology !== "string" || e.methodology.trim().length < 10) errors.push("methodology required");
  return { ok: errors.length === 0, errors };
}

// Invalid entries are surfaced (not silently dropped) so the UI can show them.
export function validateEventsFile(list) {
  if (!Array.isArray(list)) return { events: [], rejected: [{ event: list, errors: ["events file is not an array"] }] };
  const events = [];
  const rejected = [];
  for (const e of list) {
    const v = validateEvent(e);
    if (v.ok) events.push(e);
    else rejected.push({ event: e, errors: v.errors });
  }
  events.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  return { events, rejected };
}

function meanOfDays(byDate, startMs, days) {
  const prices = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(startMs + i * DAY_MS).toISOString().slice(0, 10);
    if (byDate.has(d)) prices.push(byDate.get(d));
  }
  if (!prices.length) return { count: 0, mean: null };
  return { count: prices.length, mean: mulDivRoundHalfUp(prices.reduce((s, p) => s + p, 0), 1, prices.length) };
}

export function eventPriceDelta(points, startDate, cfg = DEFAULTS) {
  const w = cfg.EVENT_DELTA_WINDOW_DAYS;
  const minDays = cfg.EVENT_DELTA_MIN_DAYS_PER_SIDE;
  if (!isDate(startDate)) return { state: "INSUFFICIENT_DATA", reason: "invalid start_date", methodology: DELTA_METHODOLOGY };
  if (!Array.isArray(points) || points.length === 0) {
    return { state: "INSUFFICIENT_DATA", reason: "no Steam price history for this item", methodology: DELTA_METHODOLOGY };
  }
  const byDate = new Map();
  for (const p of points) {
    if (!p || !isDate(p.date) || !Number.isSafeInteger(p.price_usd_cents) || p.price_usd_cents <= 0) {
      return { state: "INSUFFICIENT_DATA", reason: "price history contains invalid points", methodology: DELTA_METHODOLOGY };
    }
    byDate.set(p.date, p.price_usd_cents);
  }
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const before = meanOfDays(byDate, startMs - w * DAY_MS, w);
  const after = meanOfDays(byDate, startMs, w);
  if (before.count < minDays || after.count < minDays) {
    return {
      state: "INSUFFICIENT_DATA",
      reason: `days with data: ${before.count} before, ${after.count} after (need ${minDays} each)`,
      days_before: before.count,
      days_after: after.count,
      methodology: DELTA_METHODOLOGY,
    };
  }
  return {
    state: "OK",
    before_mean_cents: before.mean,
    after_mean_cents: after.mean,
    change_bps: marginBps(after.mean - before.mean, before.mean),
    days_before: before.count,
    days_after: after.count,
    methodology: DELTA_METHODOLOGY,
  };
}
