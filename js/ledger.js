// User-recorded ledger. NOT an authoritative or verified transaction record: the user
// enters buys/sells after acting elsewhere. Nothing here initiates a transaction (P0-1).
//
// Schema v2 (v1 migrates losslessly, see migrateLedger):
// - FIFO across lots with partial-lot splitting: a sale allocates its quantity to the oldest
//   open lots first; the last lot touched may be consumed partially. Each allocation is stored.
// - Buckets: USD cash, banked profit (earmark within cash), reserved cash (earmark within cash
//   for open orders), Steam Wallet (separate, never deployable), inventory, open exposure.
// - Every lot/trade carries strategy_version / signal_version / fee_model_version /
//   parser_version so it can count as evidence only under the version it was made under.
// - Reversal incidents are logged (never auto-adjust anything).
// Balances are derived by replaying everything in timestamp order; every replay re-validates
// every invariant, so an imported or edited ledger that breaks one is rejected, not displayed.

import { DEFAULTS } from "../config/defaults.js";
import { CSFLOAT_PAYOUT_RAILS, MARKETS, SKINPORT_FEE_SCHEDULES } from "../config/fees.js";
import { BPS, computeSale, mulDivFloor, rateToBps, resolvePayoutFeeBps, resolveSellFee } from "./money.js";
import { BASE_FEE_MODEL } from "./research/fee-model.js";
import { evaluateCircuitBreaker } from "./tiers.js";

export const LEDGER_SCHEMA_VERSION = 2;
export const LEDGER_EXPORT_FORMAT = "skin-arb-terminal-ledger";
export const LEDGER_LABEL = "User-recorded, not an authoritative or verified transaction record.";
export const UNVERSIONED = "unversioned";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value) {
  return typeof value === "string" && ISO_UTC_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

export function emptyLedger() {
  return { schema_version: LEDGER_SCHEMA_VERSION, next_seq: 1, lots: [], trades: [], adjustments: [], incidents: [] };
}

function defaultNewId() {
  return globalThis.crypto.randomUUID();
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 256;
}

function isPosInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

export function minimumHoldUntil(buyTimestampIso, holdDays = DEFAULTS.TRANSFER_HOLD_DAYS) {
  return toIso(Date.parse(buyTimestampIso) + holdDays * DAY_MS);
}

export function proceedsCurrencyFor(market) {
  return market === "steam" ? "steam_wallet" : "usd_cash";
}

// ---- v1 → v2 migration (lossless) -------------------------------------------------------

export function migrateLedger(ledger) {
  if (!ledger || typeof ledger !== "object") return ledger;
  if (ledger.schema_version === LEDGER_SCHEMA_VERSION) return ledger;
  if (ledger.schema_version !== 1) return ledger; // replay reports the unsupported version
  const lotQty = new Map((ledger.lots ?? []).map((l) => [l.lot_id, l.quantity]));
  return {
    schema_version: 2,
    next_seq: ledger.next_seq,
    lots: (ledger.lots ?? []).map((l) => ({ ...l, strategy_version: UNVERSIONED })),
    trades: (ledger.trades ?? []).map((t) => {
      const { lot_ids: lotIds, ...rest } = t;
      return {
        ...rest,
        lot_allocations: (lotIds ?? []).map((id) => ({ lot_id: id, quantity: lotQty.get(id) })),
        receipt_net_cents: null,
        strategy_version: UNVERSIONED,
        signal_version: UNVERSIONED,
        fee_model_version: BASE_FEE_MODEL.fee_model_version,
        parser_version: UNVERSIONED,
      };
    }),
    adjustments: ledger.adjustments ?? [],
    incidents: [],
  };
}

// ---- Record schemas ---------------------------------------------------------------

const LOT_FIELDS = [
  "lot_id", "seq", "canonical_item_id", "quantity", "buy_market", "buy_price_cents", "buy_timestamp",
  "minimum_hold_until", "status", "funding_source", "recorded_at", "strategy_version",
];
const TRADE_FIELDS = [
  "trade_id", "seq", "lot_allocations", "canonical_item_id", "quantity", "sell_market", "sell_price_cents",
  "sell_timestamp", "proceeds_currency", "fee_schedule", "payout_rail", "sell_fee_model", "sell_fee_bps",
  "payout_fee_bps", "gross_sale_cents", "sell_fee_cents", "payout_fee_cents", "net_sale_proceeds_cents",
  "acquisition_cost_cents", "realized_net_profit_cents", "net_margin_bps", "hold_duration_hours",
  "deployable_capital_at_close_cents", "deployable_capital_complete", "banked_allocation_cents", "recorded_at",
  "receipt_net_cents", "strategy_version", "signal_version", "fee_model_version", "parser_version",
];
const ADJ_FIELDS = ["adjustment_id", "seq", "kind", "amount_cents", "from_banked", "timestamp", "note", "recorded_at"];
const ADJ_KINDS = ["cash", "wallet", "bank_redeploy", "reserve", "release"];
const INCIDENT_FIELDS = ["incident_id", "seq", "kind", "trade_id", "lot_id", "timestamp", "note", "recorded_at"];

function checkExactFields(rec, fields, label, errors) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    errors.push(`${label}: not an object`);
    return false;
  }
  const keys = Object.keys(rec);
  const missing = fields.filter((f) => !(f in rec));
  const extra = keys.filter((k) => !fields.includes(k));
  if (missing.length) errors.push(`${label}: missing field(s) ${missing.join(", ")}`);
  if (extra.length) errors.push(`${label}: unknown field(s) ${extra.join(", ")}`);
  return missing.length === 0 && extra.length === 0;
}

function validateLotShape(lot, errors, holdDays) {
  const label = `lot ${lot?.lot_id ?? "?"}`;
  if (!checkExactFields(lot, LOT_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(lot.lot_id)) errors.push(`${label}: lot_id required`);
  if (!isPosInt(lot.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (!isNonEmptyString(lot.canonical_item_id)) errors.push(`${label}: canonical_item_id required`);
  if (!isPosInt(lot.quantity)) errors.push(`${label}: quantity must be an integer >= 1`);
  if (!MARKETS.includes(lot.buy_market)) errors.push(`${label}: unknown buy_market`);
  if (!isPosInt(lot.buy_price_cents)) errors.push(`${label}: buy_price_cents must be integer cents > 0`);
  if (!isIsoUtc(lot.buy_timestamp)) errors.push(`${label}: buy_timestamp must be ISO 8601 UTC`);
  if (!isIsoUtc(lot.minimum_hold_until)) errors.push(`${label}: minimum_hold_until must be ISO 8601 UTC`);
  else if (isIsoUtc(lot.buy_timestamp) && Date.parse(lot.minimum_hold_until) !== Date.parse(lot.buy_timestamp) + holdDays * DAY_MS) {
    errors.push(`${label}: minimum_hold_until must equal buy_timestamp + ${holdDays} days`);
  }
  if (lot.status !== "open" && lot.status !== "closed") errors.push(`${label}: status must be "open" or "closed"`);
  if (lot.funding_source !== "usd_cash" && lot.funding_source !== "steam_wallet") {
    errors.push(`${label}: funding_source must be usd_cash or steam_wallet`);
  } else if (lot.funding_source === "steam_wallet" && lot.buy_market !== "steam") {
    errors.push(`${label}: steam_wallet funding is only possible for Steam Market buys`);
  }
  if (!isIsoUtc(lot.recorded_at)) errors.push(`${label}: recorded_at must be ISO 8601 UTC`);
  if (!isNonEmptyString(lot.strategy_version)) errors.push(`${label}: strategy_version required ("${UNVERSIONED}" if none)`);
  return errors.length === before;
}

function validateTradeShape(t, errors) {
  const label = `trade ${t?.trade_id ?? "?"}`;
  if (!checkExactFields(t, TRADE_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(t.trade_id)) errors.push(`${label}: trade_id required`);
  if (!isPosInt(t.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (!Array.isArray(t.lot_allocations) || t.lot_allocations.length === 0 || !t.lot_allocations.every((a) => a && isNonEmptyString(a.lot_id) && isPosInt(a.quantity))) {
    errors.push(`${label}: lot_allocations must be a non-empty list of { lot_id, quantity >= 1 }`);
  } else if (t.lot_allocations.reduce((s, a) => s + a.quantity, 0) !== t.quantity) {
    errors.push(`${label}: lot_allocations must sum to quantity`);
  }
  if (!isNonEmptyString(t.canonical_item_id)) errors.push(`${label}: canonical_item_id required`);
  if (!isPosInt(t.quantity)) errors.push(`${label}: quantity must be an integer >= 1`);
  if (!MARKETS.includes(t.sell_market)) errors.push(`${label}: unknown sell_market`);
  if (!isPosInt(t.sell_price_cents)) errors.push(`${label}: sell_price_cents must be integer cents > 0`);
  if (!isIsoUtc(t.sell_timestamp)) errors.push(`${label}: sell_timestamp must be ISO 8601 UTC`);
  if (t.proceeds_currency !== proceedsCurrencyFor(t.sell_market)) {
    errors.push(`${label}: proceeds_currency must be ${proceedsCurrencyFor(t.sell_market)} for ${t.sell_market}`);
  }
  for (const f of [
    "sell_fee_bps", "payout_fee_bps", "gross_sale_cents", "sell_fee_cents", "payout_fee_cents",
    "net_sale_proceeds_cents", "acquisition_cost_cents", "realized_net_profit_cents", "net_margin_bps",
    "hold_duration_hours", "deployable_capital_at_close_cents", "banked_allocation_cents",
  ]) {
    if (!Number.isSafeInteger(t[f])) errors.push(`${label}: ${f} must be an integer`);
  }
  if (t.receipt_net_cents !== null && !(Number.isSafeInteger(t.receipt_net_cents) && t.receipt_net_cents >= 0)) errors.push(`${label}: receipt_net_cents must be null or integer cents >= 0`);
  if (typeof t.deployable_capital_complete !== "boolean") errors.push(`${label}: deployable_capital_complete must be boolean`);
  if (!isIsoUtc(t.recorded_at)) errors.push(`${label}: recorded_at must be ISO 8601 UTC`);
  for (const f of ["strategy_version", "signal_version", "fee_model_version", "parser_version"]) if (!isNonEmptyString(t[f])) errors.push(`${label}: ${f} required`);
  return errors.length === before;
}

function validateAdjShape(a, errors) {
  const label = `adjustment ${a?.adjustment_id ?? "?"}`;
  if (!checkExactFields(a, ADJ_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(a.adjustment_id)) errors.push(`${label}: adjustment_id required`);
  if (!isPosInt(a.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (!ADJ_KINDS.includes(a.kind)) errors.push(`${label}: kind must be ${ADJ_KINDS.join("|")}`);
  if (!Number.isSafeInteger(a.amount_cents) || a.amount_cents === 0) errors.push(`${label}: amount_cents must be a non-zero integer`);
  if (typeof a.from_banked !== "boolean") errors.push(`${label}: from_banked must be boolean`);
  if (a.from_banked && a.kind !== "cash") errors.push(`${label}: from_banked only applies to cash withdrawals`);
  if (a.from_banked && a.amount_cents > 0) errors.push(`${label}: from_banked must be a withdrawal (negative amount)`);
  if (["bank_redeploy", "reserve", "release"].includes(a.kind) && a.amount_cents < 0) errors.push(`${label}: ${a.kind} amount must be positive`);
  if (!isIsoUtc(a.timestamp)) errors.push(`${label}: timestamp must be ISO 8601 UTC`);
  if (typeof a.note !== "string" || a.note.length > 500) errors.push(`${label}: note must be a string <= 500 chars`);
  if (!isIsoUtc(a.recorded_at)) errors.push(`${label}: recorded_at must be ISO 8601 UTC`);
  return errors.length === before;
}

function validateIncidentShape(i, errors) {
  const label = `incident ${i?.incident_id ?? "?"}`;
  if (!checkExactFields(i, INCIDENT_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(i.incident_id)) errors.push(`${label}: incident_id required`);
  if (!isPosInt(i.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (i.kind !== "reversal") errors.push(`${label}: kind must be "reversal"`);
  if (i.trade_id === null && i.lot_id === null) errors.push(`${label}: needs a trade_id or lot_id`);
  if (!isIsoUtc(i.timestamp) || !isIsoUtc(i.recorded_at)) errors.push(`${label}: timestamps must be ISO 8601 UTC`);
  if (typeof i.note !== "string" || i.note.length > 500) errors.push(`${label}: note must be a string <= 500 chars`);
  return errors.length === before;
}

// ---- Replay -----------------------------------------------------------------------

function sortedEvents(ledger) {
  const events = [
    ...ledger.adjustments.map((rec) => ({ ts: Date.parse(rec.timestamp), seq: rec.seq, kind: "adj", rec })),
    ...ledger.lots.map((rec) => ({ ts: Date.parse(rec.buy_timestamp), seq: rec.seq, kind: "buy", rec })),
    ...ledger.trades.map((rec) => ({ ts: Date.parse(rec.sell_timestamp), seq: rec.seq, kind: "sell", rec })),
  ];
  return events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

// Open lots of an item in FIFO order, with remaining quantities.
function fifoOpenLots(open, itemId) {
  return [...open.values()]
    .filter((l) => l.canonical_item_id === itemId)
    .sort((a, b) => Date.parse(a.buy_timestamp) - Date.parse(b.buy_timestamp) || a.seq - b.seq);
}

// FIFO allocation of `quantity` units across open lots (partial splitting of the last lot).
export function allocateFifo(fifoLots, quantity) {
  const allocations = [];
  let left = quantity;
  for (const lot of fifoLots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining_quantity);
    if (take > 0) {
      allocations.push({ lot_id: lot.lot_id, quantity: take });
      left -= take;
    }
  }
  const available = fifoLots.reduce((s, l) => s + l.remaining_quantity, 0);
  return left === 0 ? { ok: true, allocations, available } : { ok: false, allocations: null, available };
}

function expectedBankedAllocation(trade, cfg) {
  const threshold = cfg.REINVEST_THRESHOLD_CENTS;
  if (trade.proceeds_currency !== "usd_cash") return 0; // wallet proceeds are not cash; nothing to earmark
  if (trade.realized_net_profit_cents <= 0) return 0;
  if (trade.deployable_capital_at_close_cents < threshold) return 0;
  return mulDivFloor(trade.realized_net_profit_cents, rateToBps(cfg.REINVEST_BANK_PCT), BPS);
}

function acquisitionOf(allocations, lotById) {
  return allocations.reduce((s, a) => s + a.quantity * lotById.get(a.lot_id).buy_price_cents, 0);
}

function recomputeTradeMath(trade, acquisition, feeModels) {
  const model = feeModels[trade.fee_model_version] ?? BASE_FEE_MODEL;
  return computeSale({
    quantity: trade.quantity,
    unitSellPriceCents: trade.sell_price_cents,
    acquisitionCostCents: acquisition,
    sellFeeBps: trade.sell_fee_bps,
    payoutFeeBps: trade.payout_fee_bps,
    sellFeeModel: trade.sell_fee_model,
    fees: model.fees,
  });
}

// Replays the ledger, validating every invariant. With untilMs, stops after events at or
// before that instant. Returns derived balances and the open-lot set (with remaining qty).
// feeModels: { [fee_model_version]: model } for recomputing stored trades.
export function replayLedger(input, { untilMs = Infinity, cfg = DEFAULTS, feeModels = {} } = {}) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["ledger is not an object"] };
  const ledger = migrateLedger(input);
  if (ledger.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(`unsupported schema_version ${ledger.schema_version}`);
  for (const k of ["lots", "trades", "adjustments", "incidents"]) {
    if (!Array.isArray(ledger[k])) errors.push(`${k} must be an array`);
  }
  if (!isPosInt(ledger.next_seq)) errors.push("next_seq must be a positive integer");
  if (errors.length) return { ok: false, errors };

  // Validate every record (not short-circuiting) so the user sees all problems at once.
  const shapeResults = [
    ...ledger.lots.map((l) => validateLotShape(l, errors, cfg.TRANSFER_HOLD_DAYS)),
    ...ledger.trades.map((t) => validateTradeShape(t, errors)),
    ...ledger.adjustments.map((a) => validateAdjShape(a, errors)),
    ...ledger.incidents.map((i) => validateIncidentShape(i, errors)),
  ];
  if (!shapeResults.every(Boolean)) return { ok: false, errors };

  const ids = new Set();
  const seqs = new Set();
  for (const r of [...ledger.lots, ...ledger.trades, ...ledger.adjustments, ...ledger.incidents]) {
    const id = r.lot_id ?? r.trade_id ?? r.adjustment_id ?? r.incident_id;
    const key = r.incident_id ? `incident:${r.incident_id}` : id;
    if (ids.has(key)) errors.push(`duplicate id ${id}`);
    ids.add(key);
    if (seqs.has(r.seq)) errors.push(`duplicate seq ${r.seq}`);
    seqs.add(r.seq);
    if (r.seq >= ledger.next_seq) errors.push(`seq ${r.seq} >= next_seq`);
  }
  if (errors.length) return { ok: false, errors };

  let cash = 0;
  let banked = 0;
  let reserved = 0;
  let wallet = 0;
  const open = new Map(); // lot_id → { ...lot, remaining_quantity }
  const lotById = new Map(ledger.lots.map((l) => [l.lot_id, l]));
  const consumed = new Map(); // lot_id → units consumed

  for (const ev of sortedEvents(ledger)) {
    if (ev.ts > untilMs) break;
    const r = ev.rec;
    if (ev.kind === "adj") {
      const where = `adjustment ${r.adjustment_id} @ ${r.timestamp}`;
      if (r.kind === "cash") {
        if (r.from_banked) {
          if (-r.amount_cents > banked) errors.push(`${where}: withdrawal from banked exceeds banked profit`);
          banked += r.amount_cents;
          cash += r.amount_cents;
        } else {
          cash += r.amount_cents;
          if (r.amount_cents < 0 && cash < banked + reserved) {
            errors.push(`${where}: withdrawal would spend banked profit or reserved cash; mark it "from banked profit", release the reservation, or redeploy first`);
          }
        }
        if (cash < 0) errors.push(`${where}: USD cash balance would go negative`);
      } else if (r.kind === "wallet") {
        wallet += r.amount_cents;
        if (wallet < 0) errors.push(`${where}: Steam Wallet balance would go negative`);
      } else if (r.kind === "bank_redeploy") {
        if (r.amount_cents > banked) errors.push(`${where}: redeploy exceeds banked profit`);
        banked -= r.amount_cents;
      } else if (r.kind === "reserve") {
        if (r.amount_cents > cash - banked - reserved) errors.push(`${where}: reservation exceeds available cash`);
        reserved += r.amount_cents;
      } else {
        if (r.amount_cents > reserved) errors.push(`${where}: release exceeds reserved cash`);
        reserved -= r.amount_cents;
      }
    } else if (ev.kind === "buy") {
      const where = `lot ${r.lot_id} @ ${r.buy_timestamp}`;
      const cost = r.quantity * r.buy_price_cents;
      if (!Number.isSafeInteger(cost)) errors.push(`${where}: cost overflow`);
      if (r.funding_source === "usd_cash") {
        const available = cash - banked - reserved;
        if (cost > available) {
          errors.push(`${where}: cost ${cost} exceeds available USD cash ${available} (banked profit and reserved cash are never spent implicitly)`);
        }
        cash -= cost;
      } else {
        if (cost > wallet) errors.push(`${where}: cost exceeds Steam Wallet balance`);
        wallet -= cost;
      }
      open.set(r.lot_id, { ...r, remaining_quantity: r.quantity });
    } else {
      const where = `trade ${r.trade_id} @ ${r.sell_timestamp}`;
      const fifo = fifoOpenLots(open, r.canonical_item_id);
      const alloc = allocateFifo(fifo, r.quantity);
      if (!alloc.ok) {
        errors.push(`${where}: quantity ${r.quantity} exceeds the ${alloc.available} unit(s) open for this item at that time`);
        continue;
      }
      if (JSON.stringify(alloc.allocations) !== JSON.stringify(r.lot_allocations.map((a) => ({ lot_id: a.lot_id, quantity: a.quantity })))) {
        errors.push(`${where}: lot_allocations are not the FIFO allocation ${JSON.stringify(alloc.allocations)}`);
        continue;
      }
      for (const a of alloc.allocations) {
        const l = lotById.get(a.lot_id);
        if (Date.parse(r.sell_timestamp) < Date.parse(l.minimum_hold_until)) {
          errors.push(`${where}: lot ${l.lot_id} is not transfer-eligible until ${l.minimum_hold_until}`);
        }
      }
      const m = recomputeTradeMath(r, acquisitionOf(alloc.allocations, lotById), feeModels);
      if (m.state !== "OK") {
        errors.push(`${where}: ${m.reason}`);
        continue;
      }
      const mismatches = [
        ["gross_sale_cents", m.gross_sale_price_cents],
        ["sell_fee_cents", m.sell_fee_cents],
        ["payout_fee_cents", m.payout_fee_cents],
        ["net_sale_proceeds_cents", m.net_sale_proceeds_cents],
        ["acquisition_cost_cents", m.acquisition_cost_cents],
        ["realized_net_profit_cents", m.net_profit_cents],
        ["net_margin_bps", m.net_margin_bps],
      ].filter(([f, v]) => r[f] !== v);
      if (mismatches.length) errors.push(`${where}: stored ${mismatches.map(([f]) => f).join(", ")} disagree with recomputation`);
      const earliestBuy = Math.min(...alloc.allocations.map((a) => Date.parse(lotById.get(a.lot_id).buy_timestamp)));
      if (r.hold_duration_hours !== Math.floor((Date.parse(r.sell_timestamp) - earliestBuy) / HOUR_MS)) {
        errors.push(`${where}: hold_duration_hours disagrees with lot timestamps`);
      }
      if (r.banked_allocation_cents !== expectedBankedAllocation(r, cfg)) {
        errors.push(`${where}: banked_allocation_cents disagrees with the reinvestment rule`);
      }
      for (const a of alloc.allocations) {
        const l = open.get(a.lot_id);
        l.remaining_quantity -= a.quantity;
        consumed.set(a.lot_id, (consumed.get(a.lot_id) ?? 0) + a.quantity);
        if (l.remaining_quantity === 0) open.delete(a.lot_id);
      }
      if (r.proceeds_currency === "usd_cash") cash += r.net_sale_proceeds_cents;
      else wallet += r.net_sale_proceeds_cents;
      banked += r.banked_allocation_cents;
    }
  }

  if (untilMs === Infinity) {
    for (const a of ledger.trades.flatMap((t) => t.lot_allocations)) {
      if (!lotById.has(a.lot_id)) errors.push(`trade references unknown lot ${a.lot_id}`);
    }
    for (const lot of ledger.lots) {
      const expected = (consumed.get(lot.lot_id) ?? 0) === lot.quantity ? "closed" : "open";
      if (lot.status !== expected) errors.push(`lot ${lot.lot_id}: status "${lot.status}" but replay says "${expected}"`);
    }
    const tradeIds = new Set(ledger.trades.map((t) => t.trade_id));
    for (const i of ledger.incidents) {
      if (i.trade_id !== null && !tradeIds.has(i.trade_id)) errors.push(`incident ${i.incident_id}: unknown trade ${i.trade_id}`);
      if (i.lot_id !== null && !lotById.has(i.lot_id)) errors.push(`incident ${i.incident_id}: unknown lot ${i.lot_id}`);
    }
  }

  const openLots = [...open.values()];
  const openExposure = openLots.reduce((s, l) => s + l.remaining_quantity * l.buy_price_cents, 0);
  return {
    ok: errors.length === 0,
    errors,
    ledger,
    usd_cash_balance_cents: cash,
    banked_profit_cents: banked,
    reserved_cash_cents: reserved,
    steam_wallet_balance_cents: wallet,
    open_lots: openLots,
    current_open_exposure_cents: openExposure,
  };
}

// ---- Balances ---------------------------------------------------------------------

// valuation(canonical_item_id) → { state: "OK", unit_value_cents, market, listing_depth }
//                               | { state: "INSUFFICIENT_DATA", reason }
// Unvalued lots are flagged and excluded, so inventory/deployable become explicit LOWER
// BOUNDS with complete=false — never silently zero-filled or filled with cost basis.
export function valueOpenLots(openLots, valuation) {
  let total = 0;
  const perLot = [];
  const unvalued = [];
  for (const lot of openLots) {
    const qty = lot.remaining_quantity ?? lot.quantity;
    const v = valuation ? valuation(lot.canonical_item_id) : { state: "INSUFFICIENT_DATA", reason: "no quotes loaded" };
    if (v && v.state === "OK" && Number.isSafeInteger(v.unit_value_cents)) {
      const value = v.unit_value_cents * qty;
      total += value;
      perLot.push({ lot_id: lot.lot_id, state: "OK", value_cents: value, unit_value_cents: v.unit_value_cents, market: v.market, listing_depth: v.listing_depth });
    } else {
      unvalued.push(lot.lot_id);
      perLot.push({ lot_id: lot.lot_id, state: "INSUFFICIENT_DATA", reason: v?.reason ?? "no valuation" });
    }
  }
  return { inventory_value_cents: total, complete: unvalued.length === 0, unvalued_lot_ids: unvalued, per_lot: perLot };
}

export function computeBalances(ledger, { valuation, cfg = DEFAULTS, feeModels = {} } = {}) {
  const r = replayLedger(ledger, { cfg, feeModels });
  if (!r.ok) return { ok: false, errors: r.errors };
  const inv = valueOpenLots(r.open_lots, valuation);
  return {
    ok: true,
    errors: [],
    usd_cash_balance_cents: r.usd_cash_balance_cents,
    banked_profit_cents: r.banked_profit_cents,
    reserved_cash_cents: r.reserved_cash_cents,
    steam_wallet_balance_cents: r.steam_wallet_balance_cents,
    free_cash_cents: r.usd_cash_balance_cents - r.banked_profit_cents,
    available_cash_cents: r.usd_cash_balance_cents - r.banked_profit_cents - r.reserved_cash_cents,
    inventory_value_cents: inv.inventory_value_cents,
    inventory_complete: inv.complete,
    unvalued_lot_ids: inv.unvalued_lot_ids,
    lot_valuations: inv.per_lot,
    // Steam Wallet is deliberately absent from this sum (P0-5). Definition unchanged from v1.
    deployable_capital_cents: r.usd_cash_balance_cents - r.banked_profit_cents + inv.inventory_value_cents,
    deployable_capital_complete: inv.complete,
    current_open_exposure_cents: r.current_open_exposure_cents,
    open_lots: r.open_lots,
  };
}

// ---- Recording (after-the-fact, user-entered) --------------------------------------

function withRecord(ledger, key, rec) {
  return { ...ledger, next_seq: ledger.next_seq + 1, [key]: [...ledger[key], rec] };
}

export function recordAdjustment(input0, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS, feeModels = {} } = {}) {
  const ledger = migrateLedger(input0);
  const rec = {
    adjustment_id: newId(),
    seq: ledger.next_seq,
    kind: input.kind,
    amount_cents: input.amount_cents,
    from_banked: Boolean(input.from_banked),
    timestamp: input.timestamp,
    note: typeof input.note === "string" ? input.note : "",
    recorded_at: nowIso,
  };
  const errors = [];
  if (isIsoUtc(input.timestamp) && isIsoUtc(nowIso) && Date.parse(input.timestamp) > Date.parse(nowIso)) {
    errors.push("timestamp is in the future; record events after they happen");
  }
  const next = withRecord(ledger, "adjustments", rec);
  const r = replayLedger(next, { cfg, feeModels });
  errors.push(...r.errors);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], ledger: next, adjustment: rec };
}

export function recordIncident(input0, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS, feeModels = {} } = {}) {
  const ledger = migrateLedger(input0);
  const rec = {
    incident_id: newId(),
    seq: ledger.next_seq,
    kind: "reversal",
    trade_id: input.trade_id ?? null,
    lot_id: input.lot_id ?? null,
    timestamp: input.timestamp,
    note: typeof input.note === "string" ? input.note : "",
    recorded_at: nowIso,
  };
  const next = withRecord(ledger, "incidents", rec);
  const r = replayLedger(next, { cfg, feeModels });
  return r.ok ? { ok: true, errors: [], ledger: next, incident: rec } : { ok: false, errors: r.errors };
}

export function recordBuy(input0, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS, feeModels = {}, strategyVersion = UNVERSIONED } = {}) {
  const ledger = migrateLedger(input0);
  const errors = [];
  if (!isNonEmptyString(input.canonical_item_id)) errors.push("item (exact market_hash_name) is required");
  if (!isPosInt(input.quantity)) errors.push("quantity must be an integer >= 1");
  if (!MARKETS.includes(input.buy_market)) errors.push("buy market must be steam, csfloat or skinport");
  if (!isPosInt(input.buy_price_cents)) errors.push("buy price must be > $0.00");
  if (!isIsoUtc(input.buy_timestamp)) errors.push("buy timestamp must be ISO 8601 UTC");
  else if (isIsoUtc(nowIso) && Date.parse(input.buy_timestamp) > Date.parse(nowIso)) {
    errors.push("buy timestamp is in the future; record buys after they happen");
  }
  const funding = input.funding_source ?? "usd_cash";
  if (errors.length) return { ok: false, errors };

  const lot = {
    lot_id: newId(),
    seq: ledger.next_seq,
    canonical_item_id: input.canonical_item_id.trim(),
    quantity: input.quantity,
    buy_market: input.buy_market,
    buy_price_cents: input.buy_price_cents,
    buy_timestamp: input.buy_timestamp,
    minimum_hold_until: minimumHoldUntil(input.buy_timestamp, cfg.TRANSFER_HOLD_DAYS),
    status: "open",
    funding_source: funding,
    recorded_at: nowIso,
    strategy_version: isNonEmptyString(input.strategy_version) ? input.strategy_version : strategyVersion,
  };
  const next = withRecord(ledger, "lots", lot);
  const r = replayLedger(next, { cfg, feeModels });
  return r.ok ? { ok: true, errors: [], ledger: next, lot } : { ok: false, errors: r.errors };
}

// input: { canonical_item_id, quantity, sell_market, sell_price_cents (per unit, gross),
//          sell_timestamp, fee_schedule (skinport), payout_rail (csfloat), receipt_net_cents? }
// ctx.valuation values the lots still open at close (current quotes; see DECISIONS.md).
// ctx.feeModel: the accepted fee model in force (default: base). ctx.versions: signal/parser
// versions of the strategy the user acted on (default: taken from the lots / "unversioned").
export function recordSell(input0, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS, valuation, feeModel = BASE_FEE_MODEL, feeModels = {}, versions = {} } = {}) {
  const ledger = migrateLedger(input0);
  const models = { ...feeModels, [feeModel.fee_model_version]: feeModel };
  const errors = [];
  if (!isNonEmptyString(input.canonical_item_id)) errors.push("item is required");
  if (!isPosInt(input.quantity)) errors.push("quantity must be an integer >= 1");
  if (!MARKETS.includes(input.sell_market)) errors.push("sell market must be steam, csfloat or skinport");
  if (!isPosInt(input.sell_price_cents)) errors.push("sell price must be > $0.00");
  if (!isIsoUtc(input.sell_timestamp)) errors.push("sell timestamp must be ISO 8601 UTC");
  else if (isIsoUtc(nowIso) && Date.parse(input.sell_timestamp) > Date.parse(nowIso)) {
    errors.push("sell timestamp is in the future; record sales after they happen");
  }
  const receipt = input.receipt_net_cents ?? null;
  if (receipt !== null && !(Number.isSafeInteger(receipt) && receipt >= 0)) errors.push("receipt (actual net received) must be dollars ≥ 0 or empty");
  const schedule = input.sell_market === "skinport" ? input.fee_schedule ?? "standard" : input.sell_market;
  if (input.sell_market === "skinport" && !SKINPORT_FEE_SCHEDULES.includes(schedule)) errors.push("unknown Skinport fee schedule");
  const rail = input.sell_market === "csfloat" ? input.payout_rail ?? cfg.CSFLOAT_PAYOUT_RAIL : "none";
  if (input.sell_market === "csfloat" && !CSFLOAT_PAYOUT_RAILS.includes(rail)) errors.push("unknown CSFloat payout rail");
  if (errors.length) return { ok: false, errors };

  const sellMs = Date.parse(input.sell_timestamp);
  const before = replayLedger(ledger, { untilMs: sellMs, cfg, feeModels: models });
  if (!before.ok) return { ok: false, errors: before.errors };

  const itemId = input.canonical_item_id.trim();
  const fifo = fifoOpenLots(new Map(before.open_lots.map((l) => [l.lot_id, l])), itemId);
  const alloc = allocateFifo(fifo, input.quantity);
  if (!alloc.ok) {
    return { ok: false, errors: [`only ${alloc.available} unit(s) of "${itemId}" were open at that time (FIFO: ${fifo.map((l) => l.remaining_quantity).join(", ") || "none"})`] };
  }
  const lotById = new Map(before.open_lots.map((l) => [l.lot_id, l]));
  for (const a of alloc.allocations) {
    const l = lotById.get(a.lot_id);
    if (sellMs < Date.parse(l.minimum_hold_until)) return { ok: false, errors: [`lot bought ${l.buy_timestamp} is not transfer-eligible until ${l.minimum_hold_until}`] };
  }

  const fee = resolveSellFee({ market: input.sell_market, schedule, unitGrossCents: input.sell_price_cents, fees: feeModel.fees });
  const payoutBps = resolvePayoutFeeBps(input.sell_market, rail, feeModel.fees);
  const acquisition = acquisitionOf(alloc.allocations, lotById);
  const m = computeSale({
    quantity: input.quantity,
    unitSellPriceCents: input.sell_price_cents,
    acquisitionCostCents: acquisition,
    sellFeeBps: fee.bps,
    payoutFeeBps: payoutBps,
    sellFeeModel: fee.model,
    fees: feeModel.fees,
  });
  if (m.state !== "OK") return { ok: false, errors: [m.reason] };

  const proceedsCurrency = proceedsCurrencyFor(input.sell_market);
  // Deployable capital at the moment of close: state just after this sale's proceeds,
  // before any banking allocation. Remaining open units valued with current quotes.
  const remainingAfter = before.open_lots
    .map((l) => {
      const a = alloc.allocations.find((x) => x.lot_id === l.lot_id);
      return a ? { ...l, remaining_quantity: l.remaining_quantity - a.quantity } : l;
    })
    .filter((l) => l.remaining_quantity > 0);
  const cashAfter = before.usd_cash_balance_cents + (proceedsCurrency === "usd_cash" ? m.net_sale_proceeds_cents : 0);
  const inv = valueOpenLots(remainingAfter, valuation);
  const deployableAtClose = cashAfter - before.banked_profit_cents + inv.inventory_value_cents;

  const firstLot = lotById.get(alloc.allocations[0].lot_id);
  const earliestBuy = Math.min(...alloc.allocations.map((a) => Date.parse(lotById.get(a.lot_id).buy_timestamp)));
  const trade = {
    trade_id: newId(),
    seq: ledger.next_seq,
    lot_allocations: alloc.allocations,
    canonical_item_id: itemId,
    quantity: input.quantity,
    sell_market: input.sell_market,
    sell_price_cents: input.sell_price_cents,
    sell_timestamp: input.sell_timestamp,
    proceeds_currency: proceedsCurrency,
    fee_schedule: fee.schedule,
    payout_rail: rail,
    sell_fee_model: fee.model,
    sell_fee_bps: fee.bps,
    payout_fee_bps: payoutBps,
    gross_sale_cents: m.gross_sale_price_cents,
    sell_fee_cents: m.sell_fee_cents,
    payout_fee_cents: m.payout_fee_cents,
    net_sale_proceeds_cents: m.net_sale_proceeds_cents,
    acquisition_cost_cents: m.acquisition_cost_cents,
    realized_net_profit_cents: m.net_profit_cents,
    net_margin_bps: m.net_margin_bps,
    hold_duration_hours: Math.floor((sellMs - earliestBuy) / HOUR_MS),
    deployable_capital_at_close_cents: deployableAtClose,
    deployable_capital_complete: inv.complete,
    banked_allocation_cents: 0,
    recorded_at: nowIso,
    receipt_net_cents: receipt,
    // A trade counts under the strategy its (first) lot was bought under.
    strategy_version: firstLot.strategy_version,
    signal_version: versions.signal_version ?? UNVERSIONED,
    fee_model_version: feeModel.fee_model_version,
    parser_version: versions.parser_version ?? UNVERSIONED,
  };
  trade.banked_allocation_cents = expectedBankedAllocation(trade, cfg);

  const consumedNow = new Map(alloc.allocations.map((a) => [a.lot_id, a.quantity]));
  const fullyConsumed = new Set(before.open_lots.filter((l) => consumedNow.get(l.lot_id) === l.remaining_quantity).map((l) => l.lot_id));
  const next = {
    ...ledger,
    next_seq: ledger.next_seq + 1,
    lots: ledger.lots.map((l) => (fullyConsumed.has(l.lot_id) ? { ...l, status: "closed" } : l)),
    trades: [...ledger.trades, trade],
  };
  const full = replayLedger(next, { cfg, feeModels: models });
  if (!full.ok) return { ok: false, errors: full.errors };

  const breaker = evaluateCircuitBreaker({
    trades: next.trades,
    closeTimestampIso: trade.sell_timestamp,
    deployableAtCloseCents: deployableAtClose,
    lossBps: rateToBps(cfg.CIRCUIT_BREAKER_LOSS_PCT),
    windowHours: cfg.CIRCUIT_BREAKER_WINDOW_HOURS,
  });
  return {
    ok: true,
    errors: [],
    ledger: next,
    trade,
    circuit_breaker: { ...breaker, triggered_at: breaker.tripped ? trade.sell_timestamp : null },
  };
}

// Recompute the latest breaker trip from the stored per-trade close snapshots.
export function deriveCircuitBreakerTriggeredAt(ledger, cfg = DEFAULTS) {
  let latest = null;
  const lossBps = rateToBps(cfg.CIRCUIT_BREAKER_LOSS_PCT);
  for (const t of ledger.trades) {
    const r = evaluateCircuitBreaker({
      trades: ledger.trades,
      closeTimestampIso: t.sell_timestamp,
      deployableAtCloseCents: t.deployable_capital_at_close_cents,
      lossBps,
      windowHours: cfg.CIRCUIT_BREAKER_WINDOW_HOURS,
    });
    if (r.tripped && (latest === null || Date.parse(t.sell_timestamp) > Date.parse(latest))) latest = t.sell_timestamp;
  }
  return latest;
}

export function laterIso(a, b) {
  const va = isIsoUtc(a) ? Date.parse(a) : -Infinity;
  const vb = isIsoUtc(b) ? Date.parse(b) : -Infinity;
  if (va === -Infinity && vb === -Infinity) return null;
  return va >= vb ? a : b;
}

// Trades in the shape the daemon's real_trades table accepts (REAL evidence).
export function realTradesForSync(ledger) {
  const incidents = new Set((ledger.incidents ?? []).filter((i) => i.trade_id).map((i) => i.trade_id));
  return ledger.trades.map((t) => ({
    trade_id: t.trade_id,
    canonical_item_id: t.canonical_item_id,
    sell_market: t.sell_market,
    quantity: t.quantity,
    sell_timestamp: t.sell_timestamp,
    hold_duration_hours: t.hold_duration_hours,
    acquisition_cost_cents: t.acquisition_cost_cents,
    net_sale_proceeds_cents: t.net_sale_proceeds_cents,
    realized_net_profit_cents: t.realized_net_profit_cents,
    net_margin_bps: t.net_margin_bps,
    receipt_net_cents: t.receipt_net_cents,
    reversal_incident: incidents.has(t.trade_id),
    strategy_version: t.strategy_version,
    signal_version: t.signal_version,
    fee_model_version: t.fee_model_version,
    parser_version: t.parser_version,
  }));
}

// ---- Export / import ----------------------------------------------------------------

export function exportLedger(ledger, { nowIso, circuitBreakerTriggeredAt = null } = {}) {
  return JSON.stringify(
    {
      format: LEDGER_EXPORT_FORMAT,
      schema_version: LEDGER_SCHEMA_VERSION,
      exported_at: nowIso,
      label: LEDGER_LABEL,
      circuit_breaker_triggered_at: circuitBreakerTriggeredAt,
      ledger: migrateLedger(ledger),
    },
    null,
    2,
  );
}

export function importLedger(jsonText, { cfg = DEFAULTS, feeModels = {} } = {}) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return { ok: false, errors: ["file is not valid JSON"] };
  }
  if (!doc || doc.format !== LEDGER_EXPORT_FORMAT) return { ok: false, errors: [`not a ${LEDGER_EXPORT_FORMAT} export`] };
  if (doc.schema_version !== 1 && doc.schema_version !== LEDGER_SCHEMA_VERSION) return { ok: false, errors: [`unsupported schema_version ${doc.schema_version}`] };
  const cb = doc.circuit_breaker_triggered_at;
  if (cb !== null && cb !== undefined && !isIsoUtc(cb)) return { ok: false, errors: ["circuit_breaker_triggered_at must be ISO 8601 UTC or null"] };
  const r = replayLedger(doc.ledger, { cfg, feeModels });
  if (!r.ok) return { ok: false, errors: r.errors };
  return {
    ok: true,
    errors: [],
    ledger: r.ledger,
    migrated_from: doc.ledger?.schema_version === 1 ? 1 : null,
    circuit_breaker_triggered_at: laterIso(cb ?? null, deriveCircuitBreakerTriggeredAt(r.ledger, cfg)),
  };
}
