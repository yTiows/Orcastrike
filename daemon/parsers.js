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

// CSFloat listing details (listing-level identity and the reference SIGNAL). Field names follow
// the third-party Go client csfloat_go (UNVERIFIED). Float values stay decimal strings (they are
// wear, not money). Seller data is never read.
export function parseCsfloatListingDetails(body, item) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
  if (!list) return { state: "INVALID", reason: "CSFloat listings body malformed", listings: [] };
  const listings = [];
  for (const l of list) {
    if (!l || typeof l !== "object" || !l.item || l.item.market_hash_name !== item) continue;
    if (l.type !== undefined && l.type !== "buy_now") continue;
    if (!Number.isSafeInteger(l.price) || l.price <= 0) return { state: "INVALID", reason: "listing price malformed", listings: [] };
    const it = l.item;
    listings.push({
      listing_id: typeof l.id === "string" || Number.isSafeInteger(l.id) ? String(l.id) : null,
      price_usd_cents: l.price,
      float_value: typeof it.float_value === "number" && Number.isFinite(it.float_value) ? String(it.float_value) : null,
      paint_seed: Number.isSafeInteger(it.paint_seed) ? it.paint_seed : null,
      paint_index: Number.isSafeInteger(it.paint_index) ? it.paint_index : null,
      stickers: Array.isArray(it.stickers) ? it.stickers.map((s) => (typeof s?.name === "string" ? s.name : null)).filter(Boolean) : [],
      reference:
        l.reference && Number.isSafeInteger(l.reference.predicted_price) && l.reference.predicted_price > 0
          ? {
              predicted_price_cents: l.reference.predicted_price,
              base_price_cents: Number.isSafeInteger(l.reference.base_price) ? l.reference.base_price : null,
              quantity: Number.isSafeInteger(l.reference.quantity) ? l.reference.quantity : null,
              last_updated: typeof l.reference.last_updated === "string" ? l.reference.last_updated : null,
            }
          : null,
    });
  }
  if (!listings.length) return { state: "UNAVAILABLE", reason: "no buy-now listings for this exact name", listings };
  if (listings.some((l) => !l.listing_id)) return { state: "INVALID", reason: "listing id missing", listings: [] };
  listings.sort((a, b) => a.price_usd_cents - b.price_usd_cents);
  return { state: "AVAILABLE", listings };
}
