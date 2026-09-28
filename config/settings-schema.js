// Configuration classification. Every value that can affect a displayed economic result is
// listed here with its class, default, bounds, validation, persistence and known dangerous
// combinations. CONFIGURATION.md is generated from this file (scripts/gen-config-doc.mjs) and
// a test asserts every leaf of config/defaults.js and RESEARCH_DEFAULTS is classified.
//
// Classes:
//   invariant          fixed by the spec or a P0 rule; not changeable at runtime
//   developer_default  changeable only by editing code (reviewed change, documented source)
//   user_setting       changeable at runtime within [min, max], validated, persisted

const S = "daemon settings table (SQLite)";
const B = "browser settings (IndexedDB/localStorage)";

export const SCHEMA = Object.freeze([
  // ---- sampling (daemon) ----
  { key: "sampling.market_quote_s", class: "user_setting", default: 60, min: 30, max: 3600, unit: "s", persistence: S, doc: "Target interval per item for quote endpoints; token buckets may lengthen it." },
  { key: "sampling.listing_depth_s", class: "user_setting", default: 120, min: 60, max: 3600, unit: "s", persistence: S, doc: "Target interval for listing-supply observations." },
  { key: "sampling.reference_price_s", class: "user_setting", default: 300, min: 120, max: 7200, unit: "s", persistence: S, doc: "Target interval for reference-price (signal) observations." },
  { key: "sampling.sales_history_s", class: "user_setting", default: 600, min: 300, max: 86400, unit: "s", persistence: S, doc: "Target interval for sales-history observations." },
  { key: "sampling.catalog_s", class: "user_setting", default: 3600, min: 900, max: 86400, unit: "s", persistence: S, doc: "Full-catalog discovery cycle (UMBRA universe)." },
  { key: "sampling.steam_listing_page_s", class: "developer_default", default: 21600, unit: "s", persistence: "code", doc: "Steam listing page (item_nameid + price history); history changes slowly and Steam's budget is small." },
  { key: "sampling.fx_s", class: "developer_default", default: 3600, unit: "s", persistence: "code", doc: "ECB rate changes once per working day." },
  // ---- snapshot synchronization ----
  { key: "snapshot.max_age_quote_s", class: "user_setting", default: 180, min: 60, max: 600, unit: "s", persistence: S, doc: "Max effective age of a quote in a snapshot group.", dangerous: "> 300 admits Skinport quotes (300s upstream cache) that may be up to max_age old; claims get less reliable." },
  { key: "snapshot.max_age_depth_s", class: "user_setting", default: 300, min: 60, max: 900, unit: "s", persistence: S, doc: "Max age of listing-supply observations." },
  { key: "snapshot.max_age_reference_s", class: "user_setting", default: 900, min: 300, max: 3600, unit: "s", persistence: S, doc: "Max age of reference-price signals." },
  { key: "snapshot.max_age_sales_s", class: "user_setting", default: 1800, min: 600, max: 7200, unit: "s", persistence: S, doc: "Max age of sales-history observations." },
  { key: "snapshot.max_cross_source_skew_s", class: "user_setting", default: 120, min: 30, max: 300, unit: "s", persistence: S, doc: "Max spread of observed_at across sources in one group; larger → CONFLICTING.", dangerous: "> 180 compares prices from materially different moments." },
  { key: "snapshot.upstream_cache_skinport_s", class: "developer_default", default: 300, unit: "s", persistence: "code", doc: "Skinport documents 5-minute response caching; added to effective age." },
  // ---- storage ----
  { key: "storage.raw_payload_retention_days", class: "user_setting", default: 30, min: 1, max: 365, unit: "days", persistence: S, doc: "Sanitized raw payloads are purged after this; hashes and normalized rows are kept forever." },
  // ---- defined math ----
  { key: "math.hold_days", class: "user_setting", default: 7, min: 7, max: 60, unit: "days", persistence: S, doc: "Planned hold H. Minimum 7 (Trade Protection) is an invariant." },
  { key: "math.hold_adverse_percentile", class: "invariant", default: 25, unit: "percentile", persistence: "code", doc: "25th percentile of H-day ask ratios (nearest-rank)." },
  { key: "math.hold_adverse_min_pairs", class: "invariant", default: 30, unit: "pairs", persistence: "code", doc: "Fewer pairs → INSUFFICIENT, item not rankable." },
  { key: "math.hold_adverse_window_days", class: "invariant", default: 30, unit: "days", persistence: "code", doc: "Trailing window for snapshot pairs." },
  { key: "math.hold_pair_tolerance_s", class: "developer_default", default: 3600, unit: "s", persistence: "code", doc: "A pair (t, t') counts as H apart when |t' − t − H| ≤ tolerance." },
  { key: "math.reversal_reserve_pct", class: "user_setting", default: 1.0, min: 0, max: 20, unit: "% of entry cost", persistence: S, doc: "USER_ASSUMPTION, not measured. Labeled wherever used.", dangerous: "0 assumes no trade reversals or scams at all." },
  { key: "math.velocity_min_sales", class: "invariant", default: 10, unit: "sales", persistence: "code", doc: "observed_sale_velocity needs ≥ 10 observed sales in the window." },
  { key: "math.velocity_window_days", class: "invariant", default: 7, unit: "days", persistence: "code", doc: "Trailing window for observed_sale_velocity." },
  { key: "math.listing_supply_window_pct", class: "invariant", default: 10, unit: "%", persistence: "code", doc: "listing_supply counts listings within ±10% of the quote." },
  // ---- sizing ----
  { key: "sizing.per_item_cap_pct", class: "invariant", default: 20, unit: "% of capital at cost", persistence: "code", doc: "capital at cost = cash + open cost basis + open order reservations." },
  { key: "sizing.velocity_share_pct", class: "user_setting", default: 10, min: 1, max: 50, unit: "% of one day's velocity", persistence: S, doc: "Order-size cap from exit-market velocity.", dangerous: "> 25 assumes you can absorb a large share of daily turnover." },
  { key: "sizing.kelly_fraction", class: "invariant", default: 0.25, unit: "fraction", persistence: "code", doc: "ADVISORY display only." },
  { key: "sizing.kelly_min_real_trades", class: "invariant", default: 30, unit: "real trades", persistence: "code", doc: "Kelly stays disabled below this under the current strategy_version." },
  // ---- stop trigger ----
  { key: "stop.drop_pct", class: "user_setting", default: 8, min: 2, max: 50, unit: "%", persistence: S, doc: "Rolling drop that, with rising listing_supply, triggers a stop alert." },
  { key: "stop.window_min", class: "user_setting", default: 15, min: 5, max: 240, unit: "min", persistence: S, doc: "Window for the rolling drop." },
  { key: "stop.floor_cents_by_item", class: "user_setting", default: {}, unit: "USD cents per item", persistence: S, doc: "Absolute per-item floor; at or below it the stop alert fires." },
  // ---- evidence gates ----
  { key: "evidence.signal_min_paper_trades", class: "invariant", default: 30, unit: "trades", persistence: "code", doc: "SIGNAL_EVIDENCE." },
  { key: "evidence.signal_min_days", class: "invariant", default: 14, unit: "days", persistence: "code", doc: "SIGNAL_EVIDENCE." },
  { key: "evidence.signal_min_coverage_pct", class: "invariant", default: 80, unit: "%", persistence: "code", doc: "Per contributing source, per day, over the last 14 complete UTC days." },
  { key: "evidence.execution_min_real_trades", class: "invariant", default: 30, unit: "trades", persistence: "code", doc: "EXECUTION_EVIDENCE; paper trades never count." },
  // ---- paper trading ----
  { key: "paper.close_grace_hours", class: "developer_default", default: 24, unit: "h", persistence: "code", doc: "Time allowed after planned close to find a fresh exit snapshot; else VOID." },
  // ---- operating mode / UMBRA / automation ----
  { key: "mode.operating", class: "user_setting", default: "RESEARCH", options: ["RESEARCH", "PAPER", "ASSISTED", "AUTOMATION"], persistence: S, doc: "AUTOMATION requires an implemented L3 (not available)." },
  { key: "umbra.active", class: "user_setting", default: false, persistence: S, doc: "Ranking mode + theme only; never grants execution." },
  { key: "umbra.bankroll_cents", class: "user_setting", default: null, min: 1000, max: 100000000, unit: "USD cents", persistence: S, doc: "Declared at activation; required." },
  { key: "umbra.override_unproven", class: "user_setting", default: false, persistence: S, doc: 'Typed "unproven edge"; allows ranking/L0/L1 without SIGNAL_EVIDENCE; labeled UNPROVEN.', dangerous: "Ranks without signal evidence." },
  { key: "umbra.allow_thin", class: "user_setting", default: false, persistence: S, doc: "Allow THIN/UNKNOWN-liquidity items in UMBRA ranking (still labeled).", dangerous: "Exit may take indefinitely long." },
  { key: "umbra.price_floor_cents", class: "invariant", default: 1000, unit: "USD cents", persistence: "code", doc: "UMBRA universe floor $10; no ceiling." },
  { key: "automation.level", class: "user_setting", default: "L0", options: ["L0", "L1", "L2", "L3"], persistence: S, doc: "L2/L3 cannot be enabled: no verified execution API." },
  { key: "automation.limits", class: "user_setting", default: null, persistence: S, doc: "Required for L3: per_item_cents, per_day_cents, total_exposure_cents, max_concurrent_orders, max_loss_cents." },
  // ---- rate limits (developer defaults, below documented/observed limits) ----
  { key: "ratelimit.steam", class: "developer_default", default: { host: "steamcommunity.com", capacity: 10, per_seconds: 60 }, persistence: "code", doc: "No documented limit; community reports ~20/min/IP (UNVERIFIED). Half of that." },
  { key: "ratelimit.skinport", class: "developer_default", default: { host: "api.skinport.com", capacity: 6, per_seconds: 300 }, persistence: "code", doc: "8 requests / 5 min per endpoint group (third-party client docs, UNVERIFIED). Headroom kept." },
  { key: "ratelimit.csfloat", class: "developer_default", default: { host: "csfloat.com", capacity: 20, per_seconds: 60 }, persistence: "code", doc: "Undocumented to us; x-ratelimit-* headers honored when present (UNVERIFIED)." },
  { key: "ratelimit.frankfurter", class: "developer_default", default: { host: "api.frankfurter.dev", capacity: 10, per_seconds: 60 }, persistence: "code", doc: "No quota; abuse limit only." },
]);

// Classification of the v1 browser defaults (config/defaults.js), by dotted path:
// [class, persistence, validation, dangerous?]. Validation is enforced in js/state.js / js/tiers.js.
export const V1_DEFAULTS_CLASSIFICATION = Object.freeze({
  WORKER_BASE_URL: ["user_setting", B, "https (http only for localhost); no credentials, query or fragment; empty = not configured"],
  "risk.MAX_PCT_CAPITAL_PER_POSITION": ["user_setting", B, "0 < value ≤ 1, ≤ 4 decimals", "> 0.25 concentrates capital in one item"],
  "risk.MAX_AGGREGATE_OPEN_EXPOSURE": ["user_setting", B, "0 < value ≤ 1; exposure + reserve ≤ 1", "> 0.8 leaves little cash for reversals"],
  "risk.MIN_FREE_CASH_RESERVE": ["user_setting", B, "0 ≤ value < 1; exposure + reserve ≤ 1", "0 keeps no cash buffer"],
  "filters.MIN_NET_PROFIT_CENTS": ["user_setting", B, "integer cents ≥ 0", "0 shows opportunities that net nothing"],
  "filters.MIN_NET_MARGIN_PCT": ["user_setting", B, "number ≥ 0, ≤ 2 decimals"],
  "filters.MIN_LISTING_DEPTH": ["user_setting", B, "integer ≥ 1", "1 treats a single listing as depth"],
  LISTING_DEPTH_WINDOW_PCT: ["invariant", "code", "fixed ±10%"],
  STOP_LOSS_FLAG_THRESHOLD: ["invariant", "code", "fixed 20% (flag only)"],
  CIRCUIT_BREAKER_LOSS_PCT: ["invariant", "code", "fixed 10%"],
  CIRCUIT_BREAKER_WINDOW_HOURS: ["invariant", "code", "fixed 24 h"],
  CIRCUIT_BREAKER_COOLDOWN_HOURS: ["invariant", "code", "fixed 24 h"],
  REINVEST_BANK_PCT: ["invariant", "code", "fixed 30%"],
  REINVEST_THRESHOLD_CENTS: ["invariant", "code", "fixed $100.00"],
  MAX_TRACKED_ITEMS: ["invariant", "code", "fixed 100"],
  QUOTE_MAX_AGE_SECONDS: ["developer_default", "code", "positive integer seconds"],
  FX_MAX_RATE_AGE_DAYS: ["developer_default", "code", "positive integer days (ECB publishes on TARGET working days)"],
  TRANSFER_HOLD_DAYS: ["invariant", "code", "fixed 7 (Valve Trade Protection)"],
  CSFLOAT_PAYOUT_RAIL: ["user_setting", B, "bank | usdc"],
  TIERS: ["invariant", "code", "fixed table; lower bound inclusive, upper exclusive (D-07)"],
  TIER_COMPRESSION_MIN_FLIPS: ["invariant", "code", "fixed 30"],
  BACKTEST_HOLD_DAYS: ["developer_default", "code", "positive integer days"],
  BACKTEST_LOOKBACK_DAYS: ["developer_default", "code", "positive integer days"],
  BACKTEST_MIN_SAMPLES: ["developer_default", "code", "positive integer"],
  EVENT_DELTA_WINDOW_DAYS: ["developer_default", "code", "positive integer days"],
  EVENT_DELTA_MIN_DAYS_PER_SIDE: ["developer_default", "code", "positive integer ≤ window"],
});

function deepFreeze(o) {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

export const RESEARCH_DEFAULTS = (() => {
  const out = {};
  for (const e of SCHEMA) setPath(out, e.key, structuredClone(e.default));
  return deepFreeze(out);
})();

function validateValue(entry, v) {
  if (entry.options) return entry.options.includes(v) ? null : `${entry.key} must be one of ${entry.options.join(", ")}`;
  if (typeof entry.default === "boolean") return typeof v === "boolean" ? null : `${entry.key} must be true/false`;
  if (entry.key === "stop.floor_cents_by_item") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return `${entry.key} must be an object`;
    for (const [k, c] of Object.entries(v)) if (!k || !Number.isSafeInteger(c) || c <= 0) return `${entry.key}: floor for "${k}" must be integer cents > 0`;
    return null;
  }
  if (entry.key === "automation.limits") {
    if (v === null) return null;
    const need = ["per_item_cents", "per_day_cents", "total_exposure_cents", "max_concurrent_orders", "max_loss_cents"];
    for (const n of need) if (!Number.isSafeInteger(v?.[n]) || v[n] <= 0) return `${entry.key}.${n} must be a positive integer`;
    return null;
  }
  if (entry.default === null && v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${entry.key} must be a number`;
  if (entry.unit === "USD cents" && !Number.isSafeInteger(v)) return `${entry.key} must be integer cents`;
  if (/^(s|days|min|trades|pairs|sales)$/.test(entry.unit ?? "") && !Number.isSafeInteger(v)) return `${entry.key} must be an integer`;
  if (entry.min !== undefined && v < entry.min) return `${entry.key} must be ≥ ${entry.min}`;
  if (entry.max !== undefined && v > entry.max) return `${entry.key} must be ≤ ${entry.max}`;
  return null;
}

// overrides: flat { "dotted.key": value } of user_setting keys only.
export function validateResearchSettings(overrides = {}) {
  const errors = [];
  const warnings = [];
  const effective = structuredClone(RESEARCH_DEFAULTS);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const entry = SCHEMA.find((e) => e.key === key);
    if (!entry) {
      errors.push(`unknown setting ${key}`);
      continue;
    }
    if (entry.class !== "user_setting") {
      errors.push(`${key} is ${entry.class} and cannot be changed at runtime`);
      continue;
    }
    const err = validateValue(entry, value);
    if (err) errors.push(err);
    else setPath(effective, key, structuredClone(value));
  }
  // Rules that are errors, not warnings.
  if (effective.mode.operating === "AUTOMATION" && effective.automation.level !== "L3") errors.push("mode AUTOMATION requires automation.level L3");
  if (["L2", "L3"].includes(effective.automation.level)) errors.push(`automation.level ${effective.automation.level} is unavailable: no verified execution API (DATA_SOURCE_MATRIX #19/#20)`);
  if (effective.umbra.active && effective.umbra.bankroll_cents === null) errors.push("UMBRA activation requires a declared bankroll");
  for (const e of SCHEMA) {
    if (!e.dangerous) continue;
    const v = getPath(effective, e.key);
    const risky =
      (e.key === "snapshot.max_age_quote_s" && v > 300) ||
      (e.key === "snapshot.max_cross_source_skew_s" && v > 180) ||
      (e.key === "math.reversal_reserve_pct" && v === 0) ||
      (e.key === "sizing.velocity_share_pct" && v > 25) ||
      (e.key === "umbra.override_unproven" && v === true) ||
      (e.key === "umbra.allow_thin" && v === true);
    if (risky) warnings.push(`${e.key}: ${e.dangerous}`);
  }
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, errors: [], warnings, effective: deepFreeze(effective) };
}
