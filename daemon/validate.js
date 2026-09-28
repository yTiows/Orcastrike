// Validator stage: semantic sanity of normalized records before storage. A record that fails
// is stored as INVALID with the reason (never dropped silently, never "fixed").

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS = new Set(["quote", "depth", "reference", "fx", "history"]);
export const QUALITY_STATES = Object.freeze(["COMPLETE", "PARTIAL", "STALE", "CONFLICTING", "INSUFFICIENT", "INVALID"]);

const posIntOrNull = (v) => v === null || v === undefined || (Number.isSafeInteger(v) && v > 0);
const nonNegIntOrNull = (v) => v === null || v === undefined || (Number.isSafeInteger(v) && v >= 0);

export function isIsoUtc(s) {
  return typeof s === "string" && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// Returns the record with quality_state/quality_reason finalized.
export function validateRecord(r) {
  const bad = (reason) => ({ ...r, quality_state: "INVALID", quality_reason: reason });
  if (!QUALITY_STATES.includes(r.quality_state)) return bad(`unknown quality state ${String(r.quality_state)}`);
  if (r.type === "market") {
    if (!KINDS.has(r.kind)) return bad(`unknown kind ${r.kind}`);
    if (r.kind !== "fx" && (typeof r.item !== "string" || !r.item.trim())) return bad("canonical item id empty");
    if (!posIntOrNull(r.price_usd_cents)) return bad("price must be integer USD cents > 0");
    if (!nonNegIntOrNull(r.listing_supply)) return bad("listing_supply must be an integer >= 0");
    if (!posIntOrNull(r.reference_price_usd_cents)) return bad("reference price must be integer USD cents > 0");
    if (!nonNegIntOrNull(r.reference_sample_size)) return bad("reference sample size must be an integer >= 0");
    if (r.kind === "fx" && r.quality_state !== "INVALID" && !(Number.isSafeInteger(r.fx_rate_micros) && r.fx_rate_micros > 0)) return bad("fx rate missing");
    if (r.source_timestamp !== undefined && r.source_timestamp !== null && !isIsoUtc(r.source_timestamp)) {
      return { ...r, source_timestamp: null, quality_state: r.quality_state === "COMPLETE" ? "PARTIAL" : r.quality_state, quality_reason: "source timestamp unparseable; dropped" };
    }
    if (r.quality_state === "COMPLETE" && (r.kind === "quote" || r.kind === "depth") && !Number.isSafeInteger(r.price_usd_cents)) return bad("COMPLETE quote without price");
    if (r.quality_state === "COMPLETE" && r.kind === "depth" && !Number.isSafeInteger(r.listing_supply)) return bad("COMPLETE depth without listing_supply");
    return r;
  }
  if (r.type === "sales") {
    if (typeof r.item !== "string" || !r.item.trim()) return bad("canonical item id empty");
    if (!Number.isSafeInteger(r.window_days) || r.window_days <= 0) return bad("window_days invalid");
    if (!Number.isSafeInteger(r.sales_count) || r.sales_count < 0) return bad("sales_count invalid");
    if (!posIntOrNull(r.median_usd_cents)) return bad("median must be integer USD cents > 0");
    return r;
  }
  if (r.type === "listing") {
    if (!r.listing_id || !Number.isSafeInteger(r.price_usd_cents) || r.price_usd_cents <= 0) return bad("listing id/price invalid");
    return r;
  }
  return r;
}
