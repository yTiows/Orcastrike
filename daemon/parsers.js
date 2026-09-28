// Parsers for endpoints not covered by worker/lib.js. Each validates the documented shape and
// fails closed (INVALID / UNAVAILABLE); none has been verified against a LIVE fixture yet
// (see DATA_SOURCE_MATRIX.md). Money leaves here as integer USD cents only.

import { MoneyError, eurCentsToUsdCents, majorUnitsToCents } from "../js/money.js";

class ParseError extends Error {}

// "$1,234.56" → 123456. Only a bare "$" prefix is accepted (currency=1 is USD); any other
// symbol, suffix or format is INVALID rather than guessed.
export function parseUsdPriceString(s) {
  if (typeof s !== "string") throw new ParseError("price is not a string");
  const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new ParseError(`price "${s}" is not a plain USD amount`);
  return majorUnitsToCents(`${m[1].replaceAll(",", "")}${m[2] ? `.${m[2]}` : ""}`);
}

function parseCount(s) {
  if (typeof s !== "string" || !/^\d{1,3}(,\d{3})*$|^\d+$/.test(s)) throw new ParseError(`count "${String(s)}" malformed`);
  return Number(s.replaceAll(",", ""));
}

// Steam /market/priceoverview (currency=1). volume = units sold in the last 24h on Steam
// (source-reported aggregate). lowest_price = lowest current listing, buyer-pays.
export function parseSteamPriceOverview(body) {
  try {
    if (!body || typeof body !== "object") throw new ParseError("body not an object");
    if (body.success !== true) return { state: "UNAVAILABLE", reason: "Steam priceoverview success != true" };
    const out = { state: "AVAILABLE" };
    if (body.lowest_price === undefined) return { state: "UNAVAILABLE", reason: "no lowest_price (no active listings)" };
    out.lowest_price_cents = parseUsdPriceString(body.lowest_price);
    out.median_price_24h_cents = body.median_price === undefined ? null : parseUsdPriceString(body.median_price);
    out.volume_24h = body.volume === undefined ? null : parseCount(body.volume);
    if (out.lowest_price_cents <= 0) throw new ParseError("lowest_price not positive");
    return out;
  } catch (err) {
    if (err instanceof ParseError || err instanceof MoneyError) return { state: "INVALID", reason: err.message };
    throw err;
  }
}

const WINDOWS = { last_24_hours: "24h", last_7_days: "7d", last_30_days: "30d", last_90_days: "90d" };

// Skinport /v1/sales/history (EUR aggregates). Volumes are source-reported sale counts per
// window. Money fields are converted to USD cents only when a live FX rate is supplied;
// otherwise they are omitted (never left in EUR).
export function parseSkinportSalesHistory(body, fx = null) {
  if (!Array.isArray(body)) return { __body: { state: "INVALID", reason: "sales history body is not an array" } };
  const out = {};
  for (const it of body) {
    if (!it || typeof it.market_hash_name !== "string") continue;
    const name = it.market_hash_name;
    try {
      if (it.currency !== "EUR") throw new ParseError("currency is not EUR");
      const row = { state: "AVAILABLE" };
      for (const [k, w] of Object.entries(WINDOWS)) {
        const win = it[k];
        if (!win || typeof win !== "object") throw new ParseError(`${k} missing`);
        if (!Number.isSafeInteger(win.volume) || win.volume < 0) throw new ParseError(`${k}.volume malformed`);
        row[`volume_${w}`] = win.volume;
        if (fx && Number.isSafeInteger(fx.rate_micros)) {
          row[`median_${w}_usd_cents`] =
            win.median === null || win.median === undefined ? null : eurCentsToUsdCents(majorUnitsToCents(win.median), fx.rate_micros);
        }
      }
      out[name] = row;
    } catch (err) {
      if (err instanceof ParseError || err instanceof MoneyError) out[name] = { state: "INVALID", reason: err.message };
      else throw err;
    }
  }
  return out;
}
