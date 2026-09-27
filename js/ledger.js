// User-recorded ledger. NOT an authoritative or verified transaction record: the user
// enters buys/sells after acting elsewhere. Nothing here initiates a transaction (P0-1).
//
// Model: FIFO, whole-lot accounting. Each buy creates exactly one lot. A sell must consume
// one or more WHOLE lots of the item in FIFO order; partial-lot sales are rejected.
// Balances are derived by replaying lots, trades and adjustments in timestamp order, and
// every replay re-validates every invariant, so an imported or edited ledger that breaks
// one is rejected rather than displayed.

import { DEFAULTS } from "../config/defaults.js";
import { CSFLOAT_PAYOUT_RAILS, MARKETS, SKINPORT_FEE_SCHEDULES } from "../config/fees.js";
import { BPS, computeSale, mulDivFloor, rateToBps, resolvePayoutFeeBps, resolveSellFee } from "./money.js";
import { evaluateCircuitBreaker } from "./tiers.js";

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_EXPORT_FORMAT = "skin-arb-terminal-ledger";
export const LEDGER_LABEL = "User-recorded, not an authoritative or verified transaction record.";

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
  return { schema_version: LEDGER_SCHEMA_VERSION, next_seq: 1, lots: [], trades: [], adjustments: [] };
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

// ---- Record schemas ---------------------------------------------------------------

const LOT_FIELDS = [
  "lot_id", "seq", "canonical_item_id", "quantity", "buy_market", "buy_price_cents", "buy_timestamp",
  "minimum_hold_until", "status", "funding_source", "recorded_at",
];
const TRADE_FIELDS = [
  "trade_id", "seq", "lot_ids", "canonical_item_id", "quantity", "sell_market", "sell_price_cents",
  "sell_timestamp", "proceeds_currency", "fee_schedule", "payout_rail", "sell_fee_model", "sell_fee_bps",
  "payout_fee_bps", "gross_sale_cents", "sell_fee_cents", "payout_fee_cents", "net_sale_proceeds_cents",
  "acquisition_cost_cents", "realized_net_profit_cents", "net_margin_bps", "hold_duration_hours",
  "deployable_capital_at_close_cents", "deployable_capital_complete", "banked_allocation_cents", "recorded_at",
];
const ADJ_FIELDS = ["adjustment_id", "seq", "kind", "amount_cents", "from_banked", "timestamp", "note", "recorded_at"];

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
  return errors.length === before;
}

function validateTradeShape(t, errors) {
  const label = `trade ${t?.trade_id ?? "?"}`;
  if (!checkExactFields(t, TRADE_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(t.trade_id)) errors.push(`${label}: trade_id required`);
  if (!isPosInt(t.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (!Array.isArray(t.lot_ids) || t.lot_ids.length === 0 || !t.lot_ids.every(isNonEmptyString)) {
    errors.push(`${label}: lot_ids must be a non-empty list`);
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
  if (typeof t.deployable_capital_complete !== "boolean") errors.push(`${label}: deployable_capital_complete must be boolean`);
  if (!isIsoUtc(t.recorded_at)) errors.push(`${label}: recorded_at must be ISO 8601 UTC`);
  return errors.length === before;
}

function validateAdjShape(a, errors) {
  const label = `adjustment ${a?.adjustment_id ?? "?"}`;
  if (!checkExactFields(a, ADJ_FIELDS, label, errors)) return false;
  const before = errors.length;
  if (!isNonEmptyString(a.adjustment_id)) errors.push(`${label}: adjustment_id required`);
  if (!isPosInt(a.seq)) errors.push(`${label}: seq must be a positive integer`);
  if (!["cash", "wallet", "bank_redeploy"].includes(a.kind)) errors.push(`${label}: kind must be cash|wallet|bank_redeploy`);
  if (!Number.isSafeInteger(a.amount_cents) || a.amount_cents === 0) errors.push(`${label}: amount_cents must be a non-zero integer`);
  if (typeof a.from_banked !== "boolean") errors.push(`${label}: from_banked must be boolean`);
  if (a.from_banked && a.kind !== "cash") errors.push(`${label}: from_banked only applies to cash withdrawals`);
  if (a.from_banked && a.amount_cents > 0) errors.push(`${label}: from_banked must be a withdrawal (negative amount)`);
  if (a.kind === "bank_redeploy" && a.amount_cents < 0) errors.push(`${label}: bank_redeploy amount must be positive`);
  if (!isIsoUtc(a.timestamp)) errors.push(`${label}: timestamp must be ISO 8601 UTC`);
  if (typeof a.note !== "string" || a.note.length > 500) errors.push(`${label}: note must be a string <= 500 chars`);
  if (!isIsoUtc(a.recorded_at)) errors.push(`${label}: recorded_at must be ISO 8601 UTC`);
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

// Open lots of an item in FIFO order.
function fifoOpenLots(openLots, itemId) {
  return [...openLots.values()]
    .filter((l) => l.canonical_item_id === itemId)
    .sort((a, b) => Date.parse(a.buy_timestamp) - Date.parse(b.buy_timestamp) || a.seq - b.seq);
}

// Whole-lot FIFO selection for `quantity` units. Returns lots or null + valid quantities.
export function selectFifoLots(fifoLots, quantity) {
  const picked = [];
  let sum = 0;
  const valid = [];
  for (const lot of fifoLots) {
    picked.push(lot);
    sum += lot.quantity;
    valid.push(sum);
    if (sum === quantity) return { lots: picked, validQuantities: valid };
    if (sum > quantity) break;
  }
  const allValid = [];
  let acc = 0;
  for (const lot of fifoLots) {
    acc += lot.quantity;
    allValid.push(acc);
  }
  return { lots: null, validQuantities: allValid };
}

function expectedBankedAllocation(trade, cfg) {
  const threshold = cfg.REINVEST_THRESHOLD_CENTS;
  if (trade.proceeds_currency !== "usd_cash") return 0; // wallet proceeds are not cash; nothing to earmark
  if (trade.realized_net_profit_cents <= 0) return 0;
  if (trade.deployable_capital_at_close_cents < threshold) return 0;
  return mulDivFloor(trade.realized_net_profit_cents, rateToBps(cfg.REINVEST_BANK_PCT), BPS);
}

function recomputeTradeMath(trade, lots) {
  const acquisition = lots.reduce((s, l) => s + l.quantity * l.buy_price_cents, 0);
  return computeSale({
    quantity: trade.quantity,
    unitSellPriceCents: trade.sell_price_cents,
    acquisitionCostCents: acquisition,
    sellFeeBps: trade.sell_fee_bps,
    payoutFeeBps: trade.payout_fee_bps,
    sellFeeModel: trade.sell_fee_model,
  });
}

// Replays the ledger, validating every invariant. With untilMs, stops after events at or
// before that instant. Returns derived balances and the open-lot set.
export function replayLedger(ledger, { untilMs = Infinity, cfg = DEFAULTS } = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== "object") return { ok: false, errors: ["ledger is not an object"] };
  if (ledger.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(`unsupported schema_version ${ledger.schema_version}`);
  for (const k of ["lots", "trades", "adjustments"]) {
    if (!Array.isArray(ledger[k])) errors.push(`${k} must be an array`);
  }
  if (!isPosInt(ledger.next_seq)) errors.push("next_seq must be a positive integer");
  if (errors.length) return { ok: false, errors };

  // Validate every record (not short-circuiting) so the user sees all problems at once.
  const shapeResults = [
    ...ledger.lots.map((l) => validateLotShape(l, errors, cfg.TRANSFER_HOLD_DAYS)),
    ...ledger.trades.map((t) => validateTradeShape(t, errors)),
    ...ledger.adjustments.map((a) => validateAdjShape(a, errors)),
  ];
  if (!shapeResults.every(Boolean)) return { ok: false, errors };

  const ids = new Set();
  const seqs = new Set();
  for (const r of [...ledger.lots, ...ledger.trades, ...ledger.adjustments]) {
    const id = r.lot_id ?? r.trade_id ?? r.adjustment_id;
    if (ids.has(id)) errors.push(`duplicate id ${id}`);
    ids.add(id);
    if (seqs.has(r.seq)) errors.push(`duplicate seq ${r.seq}`);
    seqs.add(r.seq);
    if (r.seq >= ledger.next_seq) errors.push(`seq ${r.seq} >= next_seq`);
  }
  if (errors.length) return { ok: false, errors };

  let cash = 0;
  let banked = 0;
  let wallet = 0;
  const openLots = new Map();
  const consumedBy = new Map();
  const lotById = new Map(ledger.lots.map((l) => [l.lot_id, l]));

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
          if (r.amount_cents < 0 && cash < banked) {
            errors.push(`${where}: withdrawal would spend banked profit; mark it "from banked profit" or redeploy first`);
          }
        }
        if (cash < 0) errors.push(`${where}: USD cash balance would go negative`);
      } else if (r.kind === "wallet") {
        wallet += r.amount_cents;
        if (wallet < 0) errors.push(`${where}: Steam Wallet balance would go negative`);
      } else {
        if (r.amount_cents > banked) errors.push(`${where}: redeploy exceeds banked profit`);
        banked -= r.amount_cents;
      }
    } else if (ev.kind === "buy") {
      const where = `lot ${r.lot_id} @ ${r.buy_timestamp}`;
      const cost = r.quantity * r.buy_price_cents;
      if (!Number.isSafeInteger(cost)) errors.push(`${where}: cost overflow`);
      if (r.funding_source === "usd_cash") {
        if (cost > cash - banked) {
          errors.push(`${where}: cost ${cost} exceeds free USD cash ${cash - banked} (banked profit is never spent implicitly)`);
        }
        cash -= cost;
      } else {
        if (cost > wallet) errors.push(`${where}: cost exceeds Steam Wallet balance`);
        wallet -= cost;
      }
      openLots.set(r.lot_id, r);
    } else {
      const where = `trade ${r.trade_id} @ ${r.sell_timestamp}`;
      const fifo = fifoOpenLots(openLots, r.canonical_item_id);
      const { lots, validQuantities } = selectFifoLots(fifo, r.quantity);
      if (!lots) {
        errors.push(
          `${where}: quantity ${r.quantity} does not consume whole lots in FIFO order ` +
            `(valid: ${validQuantities.join(", ") || "none open"}); partial-lot sales are not supported`,
        );
        continue;
      }
      const expectedIds = lots.map((l) => l.lot_id);
      if (JSON.stringify(expectedIds) !== JSON.stringify(r.lot_ids)) {
        errors.push(`${where}: lot_ids ${r.lot_ids.join(",")} are not the FIFO-first lots ${expectedIds.join(",")}`);
        continue;
      }
      for (const l of lots) {
        if (Date.parse(r.sell_timestamp) < Date.parse(l.minimum_hold_until)) {
          errors.push(`${where}: lot ${l.lot_id} is not transfer-eligible until ${l.minimum_hold_until}`);
        }
      }
      const m = recomputeTradeMath(r, lots);
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
      const earliestBuy = Math.min(...lots.map((l) => Date.parse(l.buy_timestamp)));
      if (r.hold_duration_hours !== Math.floor((Date.parse(r.sell_timestamp) - earliestBuy) / HOUR_MS)) {
        errors.push(`${where}: hold_duration_hours disagrees with lot timestamps`);
      }
      if (r.banked_allocation_cents !== expectedBankedAllocation(r, cfg)) {
        errors.push(`${where}: banked_allocation_cents disagrees with the reinvestment rule`);
      }
      for (const l of lots) {
        openLots.delete(l.lot_id);
        consumedBy.set(l.lot_id, r.trade_id);
      }
      if (r.proceeds_currency === "usd_cash") cash += r.net_sale_proceeds_cents;
      else wallet += r.net_sale_proceeds_cents;
      banked += r.banked_allocation_cents;
    }
  }

  if (untilMs === Infinity) {
    for (const l of ledger.trades.flatMap((t) => t.lot_ids)) {
      if (!lotById.has(l)) errors.push(`trade references unknown lot ${l}`);
    }
    for (const lot of ledger.lots) {
      const expected = consumedBy.has(lot.lot_id) ? "closed" : "open";
      if (lot.status !== expected) errors.push(`lot ${lot.lot_id}: status "${lot.status}" but replay says "${expected}"`);
    }
  }

  const openExposure = [...openLots.values()].reduce((s, l) => s + l.quantity * l.buy_price_cents, 0);
  return {
    ok: errors.length === 0,
    errors,
    usd_cash_balance_cents: cash,
    banked_profit_cents: banked,
    steam_wallet_balance_cents: wallet,
    open_lots: [...openLots.values()],
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
    const v = valuation ? valuation(lot.canonical_item_id) : { state: "INSUFFICIENT_DATA", reason: "no quotes loaded" };
    if (v && v.state === "OK" && Number.isSafeInteger(v.unit_value_cents)) {
      const value = v.unit_value_cents * lot.quantity;
      total += value;
      perLot.push({ lot_id: lot.lot_id, state: "OK", value_cents: value, unit_value_cents: v.unit_value_cents, market: v.market, listing_depth: v.listing_depth });
    } else {
      unvalued.push(lot.lot_id);
      perLot.push({ lot_id: lot.lot_id, state: "INSUFFICIENT_DATA", reason: v?.reason ?? "no valuation" });
    }
  }
  return { inventory_value_cents: total, complete: unvalued.length === 0, unvalued_lot_ids: unvalued, per_lot: perLot };
}

export function computeBalances(ledger, { valuation, cfg = DEFAULTS } = {}) {
  const r = replayLedger(ledger, { cfg });
  if (!r.ok) return { ok: false, errors: r.errors };
  const inv = valueOpenLots(r.open_lots, valuation);
  return {
    ok: true,
    errors: [],
    usd_cash_balance_cents: r.usd_cash_balance_cents,
    banked_profit_cents: r.banked_profit_cents,
    steam_wallet_balance_cents: r.steam_wallet_balance_cents,
    free_cash_cents: r.usd_cash_balance_cents - r.banked_profit_cents,
    inventory_value_cents: inv.inventory_value_cents,
    inventory_complete: inv.complete,
    unvalued_lot_ids: inv.unvalued_lot_ids,
    lot_valuations: inv.per_lot,
    // Steam Wallet is deliberately absent from this sum (P0-5).
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

export function recordAdjustment(ledger, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS } = {}) {
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
  const r = replayLedger(next, { cfg });
  errors.push(...r.errors);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], ledger: next, adjustment: rec };
}

export function recordBuy(ledger, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS } = {}) {
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
  };
  const next = withRecord(ledger, "lots", lot);
  const r = replayLedger(next, { cfg });
  return r.ok ? { ok: true, errors: [], ledger: next, lot } : { ok: false, errors: r.errors };
}

// input: { canonical_item_id, quantity, sell_market, sell_price_cents (per unit, gross),
//          sell_timestamp, fee_schedule (skinport), payout_rail (csfloat) }
// ctx.valuation values the lots still open at close (current quotes; see DECISIONS.md).
export function recordSell(ledger, input, { nowIso, newId = defaultNewId, cfg = DEFAULTS, valuation } = {}) {
  const errors = [];
  if (!isNonEmptyString(input.canonical_item_id)) errors.push("item is required");
  if (!isPosInt(input.quantity)) errors.push("quantity must be an integer >= 1");
  if (!MARKETS.includes(input.sell_market)) errors.push("sell market must be steam, csfloat or skinport");
  if (!isPosInt(input.sell_price_cents)) errors.push("sell price must be > $0.00");
  if (!isIsoUtc(input.sell_timestamp)) errors.push("sell timestamp must be ISO 8601 UTC");
  else if (isIsoUtc(nowIso) && Date.parse(input.sell_timestamp) > Date.parse(nowIso)) {
    errors.push("sell timestamp is in the future; record sales after they happen");
  }
  const schedule = input.sell_market === "skinport" ? input.fee_schedule ?? "standard" : input.sell_market;
  if (input.sell_market === "skinport" && !SKINPORT_FEE_SCHEDULES.includes(schedule)) errors.push("unknown Skinport fee schedule");
  const rail = input.sell_market === "csfloat" ? input.payout_rail ?? cfg.CSFLOAT_PAYOUT_RAIL : "none";
  if (input.sell_market === "csfloat" && !CSFLOAT_PAYOUT_RAILS.includes(rail)) errors.push("unknown CSFloat payout rail");
  if (errors.length) return { ok: false, errors };

  const sellMs = Date.parse(input.sell_timestamp);
  const before = replayLedger(ledger, { untilMs: sellMs, cfg });
  if (!before.ok) return { ok: false, errors: before.errors };

  const itemId = input.canonical_item_id.trim();
  const fifo = fifoOpenLots(new Map(before.open_lots.map((l) => [l.lot_id, l])), itemId);
  const { lots, validQuantities } = selectFifoLots(fifo, input.quantity);
  if (!lots) {
    return {
      ok: false,
      errors: [
        `Partial-lot sales are not supported in v1. Open lots of "${itemId}" at that time, FIFO: ` +
          `${fifo.map((l) => `${l.quantity}×`).join(" then ") || "none"}. Valid quantities: ${validQuantities.join(", ") || "none"}.`,
      ],
    };
  }
  for (const l of lots) {
    if (sellMs < Date.parse(l.minimum_hold_until)) {
      return { ok: false, errors: [`lot bought ${l.buy_timestamp} is not transfer-eligible until ${l.minimum_hold_until}`] };
    }
  }

  const fee = resolveSellFee({ market: input.sell_market, schedule, unitGrossCents: input.sell_price_cents });
  const payoutBps = resolvePayoutFeeBps(input.sell_market, rail);
  const acquisition = lots.reduce((s, l) => s + l.quantity * l.buy_price_cents, 0);
  const m = computeSale({
    quantity: input.quantity,
    unitSellPriceCents: input.sell_price_cents,
    acquisitionCostCents: acquisition,
    sellFeeBps: fee.bps,
    payoutFeeBps: payoutBps,
    sellFeeModel: fee.model,
  });
  if (m.state !== "OK") return { ok: false, errors: [m.reason] };

  const proceedsCurrency = proceedsCurrencyFor(input.sell_market);
  // Deployable capital at the moment of close: state just after this sale's proceeds,
  // before any banking allocation. Remaining open lots valued with current quotes.
  const consumed = new Set(lots.map((l) => l.lot_id));
  const cashAfter = before.usd_cash_balance_cents + (proceedsCurrency === "usd_cash" ? m.net_sale_proceeds_cents : 0);
  const inv = valueOpenLots(before.open_lots.filter((l) => !consumed.has(l.lot_id)), valuation);
  const deployableAtClose = cashAfter - before.banked_profit_cents + inv.inventory_value_cents;

  const earliestBuy = Math.min(...lots.map((l) => Date.parse(l.buy_timestamp)));
  const trade = {
    trade_id: newId(),
    seq: ledger.next_seq,
    lot_ids: lots.map((l) => l.lot_id),
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
  };
  trade.banked_allocation_cents = expectedBankedAllocation(trade, cfg);

  const next = {
    ...ledger,
    next_seq: ledger.next_seq + 1,
    lots: ledger.lots.map((l) => (consumed.has(l.lot_id) ? { ...l, status: "closed" } : l)),
    trades: [...ledger.trades, trade],
  };
  const full = replayLedger(next, { cfg });
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

// ---- Export / import ----------------------------------------------------------------

export function exportLedger(ledger, { nowIso, circuitBreakerTriggeredAt = null } = {}) {
  return JSON.stringify(
    {
      format: LEDGER_EXPORT_FORMAT,
      schema_version: LEDGER_SCHEMA_VERSION,
      exported_at: nowIso,
      label: LEDGER_LABEL,
      circuit_breaker_triggered_at: circuitBreakerTriggeredAt,
      ledger,
    },
    null,
    2,
  );
}

export function importLedger(jsonText, { cfg = DEFAULTS } = {}) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return { ok: false, errors: ["file is not valid JSON"] };
  }
  if (!doc || doc.format !== LEDGER_EXPORT_FORMAT) return { ok: false, errors: [`not a ${LEDGER_EXPORT_FORMAT} export`] };
  if (doc.schema_version !== LEDGER_SCHEMA_VERSION) return { ok: false, errors: [`unsupported schema_version ${doc.schema_version}`] };
  const cb = doc.circuit_breaker_triggered_at;
  if (cb !== null && cb !== undefined && !isIsoUtc(cb)) return { ok: false, errors: ["circuit_breaker_triggered_at must be ISO 8601 UTC or null"] };
  const r = replayLedger(doc.ledger, { cfg });
  if (!r.ok) return { ok: false, errors: r.errors };
  return {
    ok: true,
    errors: [],
    ledger: doc.ledger,
    circuit_breaker_triggered_at: laterIso(cb ?? null, deriveCircuitBreakerTriggeredAt(doc.ledger, cfg)),
  };
}
