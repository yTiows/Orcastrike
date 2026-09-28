// Endpoint descriptors + normalizers. A normalizer turns one successful raw response into
// normalized records (market / sales / listing observations) using the production parsers.
// It never invents a value: anything it can't parse becomes an INVALID or INSUFFICIENT record
// with a reason.

import { BPS } from "../js/money.js";
import { normalizeSkinportItems, parseCsfloatListings, parseFx, parseSteamHistogram, parseSteamListingPage } from "../worker/lib.js";
import { parseCsfloatListingDetails, parseSkinportSalesHistory, parseSteamPriceOverview } from "./parsers.js";

const enc = encodeURIComponent;
const SUPPLY_WINDOW_BPS = 1000; // ±10% (invariant math.listing_supply_window_pct)

function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withinWindow(price, lowest) {
  return BigInt(price) * BigInt(BPS) <= BigInt(lowest) * BigInt(BPS + SUPPLY_WINDOW_BPS);
}

export const ENDPOINTS = Object.freeze({
  frankfurter_latest: {
    source: "fx",
    rateLimit: "frankfurter",
    scope: "global",
    parser_version: "frankfurter_latest@1",
    interval: (cfg) => cfg.sampling.fx_s,
    url: () => "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD",
    normalize(text, { nowMs }) {
      const body = jsonOrNull(text);
      try {
        const fx = parseFx(body, nowMs);
        return [{ type: "market", item: null, kind: "fx", fx_rate_micros: fx.rate_micros, fx_rate_date: fx.rate_date, quality_state: fx.state === "STALE" ? "STALE" : "COMPLETE", quality_reason: fx.state === "STALE" ? "ECB rate date older than 4 days" : null, normalized: fx }];
      } catch (err) {
        return [{ type: "invalid_body", reason: String(err.message) }];
      }
    },
  },

  steam_listing_page: {
    source: "steam",
    rateLimit: "steam",
    scope: "item",
    parser_version: "steam_listing_page@1",
    interval: (cfg) => cfg.sampling.steam_listing_page_s,
    url: (item) => `https://steamcommunity.com/market/listings/730/${enc(item)}`,
    normalize(text, { item, nowMs }) {
      if (/too many requests/i.test(text)) return [{ type: "rate_limited_body" }];
      const p = parseSteamListingPage(text);
      const out = [];
      if (p.item_nameid) out.push({ type: "side_effect", steam_item_nameid: p.item_nameid, item });
      const cutoff = new Date(nowMs - 400 * 86400000).toISOString().slice(0, 10);
      const points = p.history.state === "AVAILABLE" ? p.history.points.filter((x) => x.date >= cutoff) : [];
      out.push({
        type: "market",
        item,
        kind: "history",
        quality_state: p.history.state === "AVAILABLE" ? "COMPLETE" : p.history.state === "INVALID" ? "INVALID" : "INSUFFICIENT",
        quality_reason: p.history.state === "AVAILABLE" ? null : p.history.reason,
        normalized: { basis: "daily volume-weighted mean of Steam median sale prices (USD cents)", points },
      });
      if (!p.item_nameid) out.push({ type: "invalid_body", reason: "item_nameid not found (unknown item or page format changed)", severity: "MEDIUM" });
      return out;
    },
  },

  steam_histogram: {
    source: "steam",
    rateLimit: "steam",
    scope: "item",
    requiresNameId: true,
    parser_version: "steam_histogram@1",
    interval: (cfg) => cfg.sampling.market_quote_s,
    url: (item, nameid) => `https://steamcommunity.com/market/itemordershistogram?country=US&language=english&currency=1&item_nameid=${enc(nameid)}&two_factor=0`,
    normalize(text, { item }) {
      const body = jsonOrNull(text);
      let h;
      try {
        h = parseSteamHistogram(body);
      } catch (err) {
        return [{ type: "invalid_body", reason: String(err.message) }];
      }
      if (h.state !== "AVAILABLE") return [{ type: "market", item, kind: "quote", quality_state: "INSUFFICIENT", quality_reason: h.reason, normalized: h }];
      return [
        { type: "market", item, kind: "quote", price_usd_cents: h.lowest, quality_state: "COMPLETE", normalized: { basis: "lowest sell order, buyer-pays USD" } },
        { type: "market", item, kind: "depth", price_usd_cents: h.lowest, listing_supply: h.depth, listing_supply_capped: false, quality_state: "COMPLETE", normalized: { basis: "cumulative sell orders within +10% of lowest" } },
      ];
    },
  },

  steam_priceoverview: {
    source: "steam",
    rateLimit: "steam",
    scope: "item",
    parser_version: "steam_priceoverview@1",
    interval: (cfg) => cfg.sampling.sales_history_s,
    url: (item) => `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${enc(item)}`,
    normalize(text, { item }) {
      const r = parseSteamPriceOverview(jsonOrNull(text));
      if (r.state === "INVALID") return [{ type: "invalid_body", reason: r.reason }];
      if (r.state !== "AVAILABLE" || r.volume_24h === null) return [];
      return [{ type: "sales", item, window_days: 1, sales_count: r.volume_24h, median_usd_cents: r.median_price_24h_cents, count_basis: "SOURCE_AGGREGATE", quality_state: "COMPLETE" }];
    },
  },

  skinport_items: {
    source: "skinport",
    rateLimit: "skinport",
    scope: "global",
    parser_version: "skinport_items@1",
    headers: { "accept-encoding": "br" },
    interval: (cfg) => cfg.sampling.market_quote_s,
    url: () => "https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=1",
    // ctx.tracked: Set of names stored at every fetch; ctx.universe: whether to (re)build the
    // UMBRA universe this cycle; ctx.fx: latest usable FX observation or null.
    normalize(text, { tracked, fx, universeCycle, universeFloorCents }) {
      const body = jsonOrNull(text);
      if (!Array.isArray(body)) return [{ type: "invalid_body", reason: "Skinport items body is not an array" }];
      const out = [];
      const fxOk = fx && Number.isSafeInteger(fx.fx_rate_micros) && fx.quality_state === "COMPLETE";
      if (!fxOk) {
        for (const name of tracked) {
          out.push({ type: "market", item: name, kind: "quote", quality_state: "INSUFFICIENT", quality_reason: "no fresh EUR→USD rate; EUR is never stored", normalized: {} });
        }
        out.push({ type: "quality", severity: "MEDIUM", code: "FX_UNAVAILABLE", detail: "Skinport quotes not normalized: no fresh FX observation" });
        return out;
      }
      const items = normalizeSkinportItems(body, { rate_micros: fx.fx_rate_micros });
      const universe = [];
      for (const [name, it] of Object.entries(items)) {
        const isTracked = tracked.has(name);
        const inUniverse = it.state === "AVAILABLE" && it.price_usd_cents >= universeFloorCents;
        if (universeCycle && inUniverse) universe.push(name);
        if (!isTracked && !(universeCycle && inUniverse)) continue;
        out.push({
          type: "market",
          item: name,
          kind: "quote",
          price_usd_cents: it.state === "AVAILABLE" ? it.price_usd_cents : null,
          fx_rate_micros: fx.fx_rate_micros,
          fx_rate_date: fx.fx_rate_date,
          quality_state: it.state === "AVAILABLE" ? "COMPLETE" : it.state === "INVALID" ? "INVALID" : "INSUFFICIENT",
          quality_reason: it.reason ?? null,
          normalized: { basis: "min listing price, EUR converted at ingestion", total_listings_any_price: it.total_listings ?? null, fx_observation_id: fx.observation_id },
        });
      }
      for (const name of tracked) {
        if (!items[name]) out.push({ type: "market", item: name, kind: "quote", quality_state: "INSUFFICIENT", quality_reason: "item not listed on Skinport", normalized: {} });
      }
      if (universeCycle) out.push({ type: "universe", items: universe, catalog_size: Object.keys(items).length });
      return out;
    },
  },

  skinport_sales_history: {
    source: "skinport",
    rateLimit: "skinport",
    scope: "batch",
    batchSize: 20,
    parser_version: "skinport_sales_history@1",
    headers: { "accept-encoding": "br" },
    interval: (cfg) => cfg.sampling.sales_history_s,
    url: (items) => `https://api.skinport.com/v1/sales/history?app_id=730&currency=EUR&market_hash_name=${enc(items.join(","))}`,
    normalize(text, { items, fx }) {
      const body = jsonOrNull(text);
      const fxOk = fx && Number.isSafeInteger(fx.fx_rate_micros) && fx.quality_state === "COMPLETE" ? { rate_micros: fx.fx_rate_micros } : null;
      const parsed = parseSkinportSalesHistory(body, fxOk);
      if (parsed.__body) return [{ type: "invalid_body", reason: parsed.__body.reason }];
      const out = [];
      for (const name of items) {
        const r = parsed[name];
        if (!r) continue; // no sales record → no observation (not zero)
        if (r.state !== "AVAILABLE") {
          out.push({ type: "sales", item: name, window_days: 7, sales_count: 0, count_basis: "SOURCE_AGGREGATE", quality_state: "INVALID", reason: r.reason });
          continue;
        }
        for (const [w, days] of [["24h", 1], ["7d", 7], ["30d", 30], ["90d", 90]]) {
          out.push({
            type: "sales",
            item: name,
            window_days: days,
            sales_count: r[`volume_${w}`],
            median_usd_cents: fxOk ? r[`median_${w}_usd_cents`] : null,
            count_basis: "SOURCE_AGGREGATE",
            quality_state: fxOk ? "COMPLETE" : "PARTIAL",
          });
        }
      }
      return out;
    },
  },

  csfloat_listings: {
    source: "csfloat",
    rateLimit: "csfloat",
    scope: "item",
    requiresKey: "CSFLOAT_API_KEY",
    parser_version: "csfloat_listings@1",
    interval: (cfg) => cfg.sampling.market_quote_s,
    url: (item) => `https://csfloat.com/api/v1/listings?market_hash_name=${enc(item)}&sort_by=lowest_price&limit=50&type=buy_now`,
    normalize(text, { item }) {
      const body = jsonOrNull(text);
      let summary;
      try {
        summary = parseCsfloatListings(body, item);
      } catch (err) {
        return [{ type: "invalid_body", reason: String(err.message) }];
      }
      if (summary.state !== "AVAILABLE") return [{ type: "market", item, kind: "quote", quality_state: "INSUFFICIENT", quality_reason: summary.reason, normalized: {} }];
      const details = parseCsfloatListingDetails(body, item);
      const out = [
        { type: "market", item, kind: "quote", price_usd_cents: summary.lowest, quality_state: "COMPLETE", normalized: { basis: "lowest buy-now listing, USD" } },
        {
          type: "market",
          item,
          kind: "depth",
          price_usd_cents: summary.lowest,
          listing_supply: details.listings.filter((l) => withinWindow(l.price_usd_cents, summary.lowest)).length,
          listing_supply_capped: summary.capped,
          quality_state: summary.capped ? "PARTIAL" : "COMPLETE",
          quality_reason: summary.capped ? "first page only: supply is a lower bound" : null,
          normalized: { basis: "buy-now listings within +10% of lowest (first 50)" },
        },
      ];
      const ref = details.listings[0]?.reference;
      if (ref) {
        out.push({
          type: "market",
          item,
          kind: "reference",
          reference_price_usd_cents: ref.predicted_price_cents,
          reference_sample_size: ref.quantity,
          source_timestamp: ref.last_updated,
          quality_state: "COMPLETE",
          normalized: { category: "SIGNAL", note: "CSFloat predicted price for the lowest listing; never truth, never an exit price", base_price_cents: ref.base_price_cents },
        });
      }
      for (const l of details.listings) {
        out.push({ type: "listing", item, listing_id: l.listing_id, price_usd_cents: l.price_usd_cents, float_value: l.float_value, paint_seed: l.paint_seed, paint_index: l.paint_index, stickers: l.stickers, quality_state: "COMPLETE" });
      }
      return out;
    },
  },
});
