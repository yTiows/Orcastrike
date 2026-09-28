// SQLite storage (built-in node:sqlite; no native dependency). Observations are append-only:
// triggers abort any UPDATE/DELETE, except purging a sanitized raw payload after retention.
// Migrations are versioned and applied in order inside a transaction.
//
// node:sqlite is flagged experimental in Node 22 (prints an ExperimentalWarning). It is used
// only through this module so it can be swapped for another driver without touching callers.

import { DatabaseSync } from "node:sqlite";

const append_only = (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`;

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    description: "initial schema: observations (append-only), versions, opportunities, paper/real trades, quality events",
    sql: `
CREATE TABLE items (
  item_id INTEGER PRIMARY KEY,
  market_hash_name TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL,
  steam_item_nameid TEXT,
  in_watchlist INTEGER NOT NULL DEFAULT 0 CHECK (in_watchlist IN (0, 1)),
  in_universe INTEGER NOT NULL DEFAULT 0 CHECK (in_universe IN (0, 1))
);
CREATE TABLE parser_versions (
  parser_version TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED', 'BLOCKED')),
  verified_fixture TEXT,
  verified_at TEXT
);
CREATE TABLE fee_model_versions (
  fee_model_version TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  model_json TEXT NOT NULL,
  accepted_by_user INTEGER NOT NULL CHECK (accepted_by_user IN (0, 1))
);
CREATE TABLE strategy_versions (
  strategy_version TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  params_json TEXT NOT NULL
);
CREATE TABLE source_requests (
  request_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_params_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  received_at TEXT,
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('OK', 'RATE_LIMITED', 'TIMEOUT', 'HTTP_ERROR', 'NETWORK_ERROR', 'PARSE_ERROR', 'NOT_CONFIGURED')),
  response_hash TEXT,
  parser_version TEXT,
  raw_payload TEXT,
  raw_payload_purged_at TEXT,
  error TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE INDEX source_requests_time ON source_requests (source, endpoint, requested_at);
CREATE TRIGGER source_requests_no_delete BEFORE DELETE ON source_requests BEGIN SELECT RAISE(ABORT, 'source_requests is append-only'); END;
CREATE TRIGGER source_requests_purge_only BEFORE UPDATE ON source_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.source IS NOT OLD.source OR NEW.endpoint IS NOT OLD.endpoint
  OR NEW.request_params_json IS NOT OLD.request_params_json OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.received_at IS NOT OLD.received_at OR NEW.http_status IS NOT OLD.http_status OR NEW.outcome IS NOT OLD.outcome
  OR NEW.response_hash IS NOT OLD.response_hash OR NEW.parser_version IS NOT OLD.parser_version OR NEW.error IS NOT OLD.error
  OR NEW.synthetic IS NOT OLD.synthetic OR NEW.raw_payload IS NOT NULL OR OLD.raw_payload IS NULL
BEGIN SELECT RAISE(ABORT, 'source_requests: only purging raw_payload is allowed'); END;

CREATE TABLE market_observations (
  observation_id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES source_requests (request_id),
  item_id INTEGER REFERENCES items (item_id),
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('quote', 'depth', 'reference', 'fx', 'history')),
  request_params_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source_timestamp TEXT,
  response_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  price_usd_cents INTEGER,
  listing_supply INTEGER,
  listing_supply_capped INTEGER CHECK (listing_supply_capped IN (0, 1)),
  reference_price_usd_cents INTEGER,
  reference_sample_size INTEGER,
  fx_rate_micros INTEGER,
  fx_rate_date TEXT,
  normalized_json TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('COMPLETE', 'PARTIAL', 'STALE', 'CONFLICTING', 'INSUFFICIENT', 'INVALID')),
  quality_reason TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE INDEX market_obs_lookup ON market_observations (item_id, source, kind, observed_at);
${append_only("market_observations")}

CREATE TABLE listing_observations (
  listing_observation_id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES source_requests (request_id),
  item_id INTEGER NOT NULL REFERENCES items (item_id),
  source TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  price_usd_cents INTEGER NOT NULL,
  float_value TEXT,
  paint_seed INTEGER,
  paint_index INTEGER,
  stickers_json TEXT,
  parser_version TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
${append_only("listing_observations")}

CREATE TABLE sales_observations (
  sales_observation_id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES source_requests (request_id),
  item_id INTEGER NOT NULL REFERENCES items (item_id),
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  sales_count INTEGER NOT NULL CHECK (sales_count >= 0),
  median_usd_cents INTEGER,
  count_basis TEXT NOT NULL CHECK (count_basis IN ('SOURCE_AGGREGATE', 'INDIVIDUAL_RECORDS')),
  parser_version TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('COMPLETE', 'PARTIAL', 'STALE', 'CONFLICTING', 'INSUFFICIENT', 'INVALID')),
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE INDEX sales_obs_lookup ON sales_observations (item_id, source, window_days, observed_at);
${append_only("sales_observations")}

CREATE TABLE opportunities (
  opportunity_id INTEGER PRIMARY KEY,
  computed_at TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items (item_id),
  buy_source TEXT NOT NULL,
  sell_source TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  blocked_reasons_json TEXT NOT NULL,
  quality_state TEXT NOT NULL,
  quality_reason TEXT NOT NULL,
  entry_cost_cents INTEGER,
  executable_exit_price_cents INTEGER,
  hold_adverse_move_ppm INTEGER,
  pessimistic_proceeds_cents INTEGER,
  reversal_reserve_cents INTEGER,
  expected_net_profit_cents INTEGER,
  rank_metric_ppm_per_day INTEGER,
  hold_days INTEGER NOT NULL,
  contributing_observations_json TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  parser_versions_json TEXT NOT NULL,
  umbra INTEGER NOT NULL DEFAULT 0 CHECK (umbra IN (0, 1)),
  unproven INTEGER NOT NULL DEFAULT 0 CHECK (unproven IN (0, 1)),
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE INDEX opportunities_time ON opportunities (computed_at);
${append_only("opportunities")}

CREATE TABLE paper_trades (
  paper_trade_id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities (opportunity_id),
  item_id INTEGER NOT NULL REFERENCES items (item_id),
  buy_source TEXT NOT NULL,
  sell_source TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  opened_at TEXT NOT NULL,
  planned_close_at TEXT NOT NULL,
  hold_days INTEGER NOT NULL,
  entry_cost_cents INTEGER NOT NULL,
  entry_hold_adverse_move_ppm INTEGER NOT NULL,
  entry_reversal_reserve_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'VOID')),
  closed_at TEXT,
  exit_observation_id INTEGER,
  exit_price_cents INTEGER,
  paper_proceeds_cents INTEGER,
  paper_net_profit_cents INTEGER,
  void_reason TEXT,
  strategy_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  exit_fee_model_version TEXT,
  parser_version TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE TRIGGER paper_trades_no_delete BEFORE DELETE ON paper_trades BEGIN SELECT RAISE(ABORT, 'paper_trades is append-only'); END;
CREATE TRIGGER paper_trades_close_once BEFORE UPDATE ON paper_trades
WHEN OLD.status <> 'OPEN' OR NEW.status = 'OPEN' OR NEW.paper_trade_id IS NOT OLD.paper_trade_id
  OR NEW.opportunity_id IS NOT OLD.opportunity_id OR NEW.entry_cost_cents IS NOT OLD.entry_cost_cents
  OR NEW.opened_at IS NOT OLD.opened_at OR NEW.strategy_version IS NOT OLD.strategy_version
BEGIN SELECT RAISE(ABORT, 'paper_trades: only OPEN → CLOSED/VOID transitions are allowed'); END;

CREATE TABLE real_trades (
  trade_id TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  canonical_item_id TEXT NOT NULL,
  sell_market TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  sell_timestamp TEXT NOT NULL,
  hold_duration_hours INTEGER NOT NULL,
  acquisition_cost_cents INTEGER NOT NULL,
  net_sale_proceeds_cents INTEGER NOT NULL,
  realized_net_profit_cents INTEGER NOT NULL,
  net_margin_bps INTEGER NOT NULL,
  receipt_net_cents INTEGER,
  reversal_incident INTEGER NOT NULL DEFAULT 0 CHECK (reversal_incident IN (0, 1)),
  strategy_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  parser_version TEXT NOT NULL
);
${append_only("real_trades")}

CREATE TABLE data_quality_events (
  event_id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  source TEXT,
  endpoint TEXT,
  item_id INTEGER,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
);
CREATE TRIGGER quality_events_no_delete BEFORE DELETE ON data_quality_events BEGIN SELECT RAISE(ABORT, 'data_quality_events is append-only'); END;
CREATE TRIGGER quality_events_resolve_only BEFORE UPDATE ON data_quality_events
WHEN OLD.resolved_at IS NOT NULL OR NEW.event_id IS NOT OLD.event_id OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.severity IS NOT OLD.severity OR NEW.code IS NOT OLD.code OR NEW.detail IS NOT OLD.detail OR NEW.resolved_at IS NULL
BEGIN SELECT RAISE(ABORT, 'data_quality_events: only a single resolution is allowed'); END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE settings_history (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value_json TEXT NOT NULL, changed_at TEXT NOT NULL, origin TEXT NOT NULL);
${append_only("settings_history")}

CREATE TABLE discovery_cycles (
  cycle_id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  universe_size INTEGER,
  items_skipped_json TEXT,
  source_request_id INTEGER
);

CREATE TABLE staged_actions (
  staged_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities (opportunity_id),
  level TEXT NOT NULL CHECK (level IN ('L1')),
  action TEXT NOT NULL,
  external_url TEXT NOT NULL,
  unproven INTEGER NOT NULL DEFAULT 0 CHECK (unproven IN (0, 1))
);
${append_only("staged_actions")}

CREATE TABLE automation_events (
  event_id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
${append_only("automation_events")}

CREATE TABLE notifications (
  notification_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  opportunity_id INTEGER
);
${append_only("notifications")}

CREATE TABLE fee_calibration_proposals (
  proposal_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  market TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED')),
  decided_at TEXT,
  accepted_fee_model_version TEXT
);
`,
  },
  {
    version: 2,
    description: "index for the engine's last-opportunity lookup per item/pair/strategy (was a full-table scan per evaluation)",
    sql: "CREATE INDEX IF NOT EXISTS opportunities_pair ON opportunities (item_id, buy_source, sell_source, strategy_version, opportunity_id);",
  },
]);

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)").run(m.version, new Date().toISOString(), m.description);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v;
}

// Integrity check used at startup and by the corrupt-database failure path.
export function integrityCheck(db) {
  let rows;
  try {
    rows = db.prepare("PRAGMA integrity_check").all();
  } catch (err) {
    // A badly damaged file can make the check itself throw; that is a failed check.
    return { ok: false, detail: err?.message ?? "integrity_check failed" };
  }
  const ok = rows.length === 1 && rows[0].integrity_check === "ok";
  return { ok, detail: ok ? "ok" : rows.map((r) => r.integrity_check).slice(0, 5).join("; ") };
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- repository helpers ----------------------------------------------------------------

export function upsertItem(db, name, { watchlist, universe, nowIso }) {
  db.prepare("INSERT INTO items (market_hash_name, first_seen_at) VALUES (?, ?) ON CONFLICT (market_hash_name) DO NOTHING").run(name, nowIso);
  if (watchlist !== undefined) db.prepare("UPDATE items SET in_watchlist = ? WHERE market_hash_name = ?").run(watchlist ? 1 : 0, name);
  if (universe !== undefined) db.prepare("UPDATE items SET in_universe = ? WHERE market_hash_name = ?").run(universe ? 1 : 0, name);
  return db.prepare("SELECT item_id FROM items WHERE market_hash_name = ?").get(name).item_id;
}

export function itemByName(db, name) {
  return db.prepare("SELECT * FROM items WHERE market_hash_name = ?").get(name) ?? null;
}

export function setSteamNameId(db, itemId, nameid) {
  db.prepare("UPDATE items SET steam_item_nameid = ? WHERE item_id = ? AND (steam_item_nameid IS NULL OR steam_item_nameid <> ?)").run(nameid, itemId, nameid);
}

export function registerParser(db, { parser_version, endpoint, verification_status, verified_fixture = null, verified_at = null }, nowIso) {
  db.prepare(
    `INSERT INTO parser_versions (parser_version, endpoint, registered_at, verification_status, verified_fixture, verified_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (parser_version) DO UPDATE SET verification_status = excluded.verification_status,
       verified_fixture = excluded.verified_fixture, verified_at = excluded.verified_at`,
  ).run(parser_version, endpoint, nowIso, verification_status, verified_fixture, verified_at);
}

export function parserStatuses(db) {
  return Object.fromEntries(db.prepare("SELECT parser_version, verification_status FROM parser_versions").all().map((r) => [r.parser_version, r.verification_status]));
}

export function insertSourceRequest(db, r) {
  return Number(
    db
      .prepare(
        `INSERT INTO source_requests (source, endpoint, request_params_json, requested_at, received_at, http_status, outcome,
           response_hash, parser_version, raw_payload, error, synthetic)
         VALUES (:source, :endpoint, :params, :requested_at, :received_at, :http_status, :outcome, :response_hash, :parser_version, :raw_payload, :error, :synthetic)`,
      )
      .run({
        source: r.source,
        endpoint: r.endpoint,
        params: JSON.stringify(r.request_params ?? {}),
        requested_at: r.requested_at,
        received_at: r.received_at ?? null,
        http_status: r.http_status ?? null,
        outcome: r.outcome,
        response_hash: r.response_hash ?? null,
        parser_version: r.parser_version ?? null,
        raw_payload: r.raw_payload ?? null,
        error: r.error ?? null,
        synthetic: r.synthetic ? 1 : 0,
      }).lastInsertRowid,
  );
}

const OBS_COLS = [
  "request_id", "item_id", "source", "endpoint", "kind", "request_params_json", "observed_at", "received_at", "source_timestamp",
  "response_hash", "parser_version", "price_usd_cents", "listing_supply", "listing_supply_capped", "reference_price_usd_cents",
  "reference_sample_size", "fx_rate_micros", "fx_rate_date", "normalized_json", "quality_state", "quality_reason", "synthetic",
];

export function insertMarketObservation(db, o) {
  const row = Object.fromEntries(OBS_COLS.map((c) => [c, o[c] ?? null]));
  row.synthetic = o.synthetic ? 1 : 0;
  if (typeof row.request_params_json !== "string") row.request_params_json = JSON.stringify(o.request_params ?? {});
  if (typeof row.normalized_json !== "string") row.normalized_json = JSON.stringify(o.normalized ?? {});
  if (typeof row.listing_supply_capped === "boolean") row.listing_supply_capped = row.listing_supply_capped ? 1 : 0;
  return Number(
    db.prepare(`INSERT INTO market_observations (${OBS_COLS.join(", ")}) VALUES (${OBS_COLS.map((c) => `:${c}`).join(", ")})`).run(row).lastInsertRowid,
  );
}

// node:sqlite rejects unknown named parameters, so every insert picks exactly its columns.
function pick(o, cols, defaults) {
  return Object.fromEntries(cols.map((c) => [c, c in defaults && (o[c] === undefined || c === "synthetic") ? defaults[c] : o[c] ?? null]));
}
const SALES_COLS = ["request_id", "item_id", "source", "endpoint", "observed_at", "window_days", "sales_count", "median_usd_cents", "count_basis", "parser_version", "response_hash", "quality_state", "synthetic"];
const LISTING_COLS = ["request_id", "item_id", "source", "listing_id", "observed_at", "price_usd_cents", "float_value", "paint_seed", "paint_index", "stickers_json", "parser_version", "response_hash", "synthetic"];

export function insertSalesObservation(db, o) {
  return Number(
    db
      .prepare(
        `INSERT INTO sales_observations (request_id, item_id, source, endpoint, observed_at, window_days, sales_count, median_usd_cents,
           count_basis, parser_version, response_hash, quality_state, synthetic)
         VALUES (:request_id, :item_id, :source, :endpoint, :observed_at, :window_days, :sales_count, :median_usd_cents,
           :count_basis, :parser_version, :response_hash, :quality_state, :synthetic)`,
      )
      .run(pick(o, SALES_COLS, { median_usd_cents: null, synthetic: o.synthetic ? 1 : 0 })).lastInsertRowid,
  );
}

export function insertListingObservation(db, o) {
  return Number(
    db
      .prepare(
        `INSERT INTO listing_observations (request_id, item_id, source, listing_id, observed_at, price_usd_cents, float_value,
           paint_seed, paint_index, stickers_json, parser_version, response_hash, synthetic)
         VALUES (:request_id, :item_id, :source, :listing_id, :observed_at, :price_usd_cents, :float_value, :paint_seed,
           :paint_index, :stickers_json, :parser_version, :response_hash, :synthetic)`,
      )
      .run(pick(o, LISTING_COLS, { float_value: null, paint_seed: null, paint_index: null, stickers_json: null, synthetic: o.synthetic ? 1 : 0 })).lastInsertRowid,
  );
}

export function latestObservation(db, itemId, source, kind) {
  return (
    db
      .prepare(
        `SELECT * FROM market_observations WHERE item_id IS ? AND source = ? AND kind = ? AND quality_state <> 'INVALID'
         ORDER BY observed_at DESC, observation_id DESC LIMIT 1`,
      )
      .get(itemId, source, kind) ?? null
  );
}

export function observationsSince(db, itemId, source, kind, sinceIso) {
  return db
    .prepare(
      `SELECT observation_id, observed_at, price_usd_cents, listing_supply, synthetic FROM market_observations
       WHERE item_id = ? AND source = ? AND kind = ? AND observed_at >= ? AND quality_state IN ('COMPLETE', 'PARTIAL')
       ORDER BY observed_at`,
    )
    .all(itemId, source, kind, sinceIso);
}

export function latestSales(db, itemId, source, windowDays) {
  return (
    db
      .prepare(
        `SELECT * FROM sales_observations WHERE item_id = ? AND source = ? AND window_days = ? AND quality_state <> 'INVALID'
         ORDER BY observed_at DESC, sales_observation_id DESC LIMIT 1`,
      )
      .get(itemId, source, windowDays) ?? null
  );
}

export function recordQualityEvent(db, e) {
  return Number(
    db
      .prepare(
        `INSERT INTO data_quality_events (occurred_at, source, endpoint, item_id, severity, code, detail, synthetic)
         VALUES (:occurred_at, :source, :endpoint, :item_id, :severity, :code, :detail, :synthetic)`,
      )
      .run({ source: null, endpoint: null, item_id: null, ...e, synthetic: e.synthetic ? 1 : 0 }).lastInsertRowid,
  );
}

export function resolveQualityEvent(db, eventId, resolution, nowIso) {
  db.prepare("UPDATE data_quality_events SET resolved_at = ?, resolution = ? WHERE event_id = ? AND resolved_at IS NULL").run(nowIso, resolution, eventId);
}

export function openQualityEvents(db) {
  return db.prepare("SELECT * FROM data_quality_events WHERE resolved_at IS NULL ORDER BY occurred_at DESC").all();
}

export function purgeRawPayloads(db, retentionDays, nowMs) {
  const cutoff = new Date(nowMs - retentionDays * 86400000).toISOString();
  return Number(
    db
      .prepare("UPDATE source_requests SET raw_payload = NULL, raw_payload_purged_at = ? WHERE raw_payload IS NOT NULL AND requested_at < ?")
      .run(new Date(nowMs).toISOString(), cutoff).changes,
  );
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare("SELECT key, value_json FROM settings").all().map((r) => [r.key, JSON.parse(r.value_json)]));
}

export function putSettings(db, flat, origin, nowIso) {
  tx(db, () => {
    for (const [k, v] of Object.entries(flat)) {
      const json = JSON.stringify(v);
      db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(k, json, nowIso);
      db.prepare("INSERT INTO settings_history (key, value_json, changed_at, origin) VALUES (?, ?, ?, ?)").run(k, json, nowIso, origin);
    }
  });
}
