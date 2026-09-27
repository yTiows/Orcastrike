import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBalances,
  emptyLedger,
  exportLedger,
  importLedger,
  isIsoUtc,
  recordAdjustment,
  recordBuy,
  recordSell,
  replayLedger,
} from "../js/ledger.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const day = 86400000;
const NOW = iso(T0 + 60 * day);

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function must(result) {
  assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result.errors)}`);
  return result;
}

function setup(depositCents) {
  const newId = ids();
  const ctx = { nowIso: NOW, newId };
  let ledger = emptyLedger();
  if (depositCents) {
    ledger = must(recordAdjustment(ledger, { kind: "cash", amount_cents: depositCents, timestamp: iso(T0) }, ctx)).ledger;
  }
  return { ledger, ctx };
}

const buy = (ledger, ctx, over = {}) =>
  recordBuy(ledger, {
    canonical_item_id: "AK-47 | Redline (Field-Tested)",
    quantity: 1,
    buy_market: "csfloat",
    buy_price_cents: 1500,
    buy_timestamp: iso(T0 + day),
    funding_source: "usd_cash",
    ...over,
  }, ctx);

const sell = (ledger, ctx, over = {}) =>
  recordSell(ledger, {
    canonical_item_id: "AK-47 | Redline (Field-Tested)",
    quantity: 1,
    sell_market: "csfloat",
    sell_price_cents: 2000,
    sell_timestamp: iso(T0 + 9 * day),
    payout_rail: "bank",
    ...over,
  }, ctx);

test("ACCEPTANCE: Steam Wallet separation (P0-5)", () => {
  const { ledger: l0, ctx } = setup(5000);
  const l1 = must(buy(l0, ctx)).ledger;

  // No quotes loaded: the open lot is unvalued (flagged), so inventory contributes 0 to
  // the lower bound — and is marked incomplete, not silently zero.
  const before = computeBalances(l1, {});
  assert.equal(before.usd_cash_balance_cents, 3500);
  assert.equal(before.deployable_capital_cents, 3500);
  assert.equal(before.deployable_capital_complete, false);
  assert.deepEqual(before.unvalued_lot_ids, ["id-2"]);
  assert.equal(before.lot_valuations[0].state, "INSUFFICIENT_DATA");

  const res = must(sell(l1, { ...ctx }, { sell_market: "steam", sell_price_cents: 2000 }));
  assert.equal(res.trade.proceeds_currency, "steam_wallet");
  assert.equal(res.trade.net_sale_proceeds_cents, 1700); // round(2000 × 0.85)
  assert.equal(res.trade.payout_fee_cents, 0);
  assert.equal(res.trade.banked_allocation_cents, 0);

  const after = computeBalances(res.ledger, {});
  assert.equal(after.steam_wallet_balance_cents, before.steam_wallet_balance_cents + 1700);
  assert.equal(after.usd_cash_balance_cents, before.usd_cash_balance_cents); // UNCHANGED
  assert.equal(after.deployable_capital_cents, before.deployable_capital_cents); // UNCHANGED
});

test("Steam sale: with the lot valued, deployable drops by the lot value and never gains wallet proceeds", () => {
  const { ledger: l0, ctx } = setup(5000);
  const l1 = must(buy(l0, ctx)).ledger;
  const valuation = () => ({ state: "OK", unit_value_cents: 1600, market: "csfloat", listing_depth: 9 });
  const before = computeBalances(l1, { valuation });
  assert.equal(before.deployable_capital_cents, 3500 + 1600);
  const after = computeBalances(must(sell(l1, ctx, { sell_market: "steam" })).ledger, { valuation });
  assert.equal(after.deployable_capital_cents, 3500);
  assert.equal(after.steam_wallet_balance_cents, 1700);
});

test("minimum_hold_until = buy + 7 days (ISO UTC); selling earlier is rejected", () => {
  const { ledger: l0, ctx } = setup(5000);
  const r = must(buy(l0, ctx));
  assert.equal(r.lot.minimum_hold_until, iso(T0 + 8 * day));
  assert.ok(isIsoUtc(r.lot.minimum_hold_until));
  const early = sell(r.ledger, ctx, { sell_timestamp: iso(T0 + 8 * day - 1000) });
  assert.equal(early.ok, false);
  assert.match(early.errors[0], /not transfer-eligible/);
  must(sell(r.ledger, ctx, { sell_timestamp: iso(T0 + 8 * day) }));
});

test("FIFO whole-lot accounting; partial-lot sales rejected", () => {
  const { ledger: l0, ctx } = setup(100000);
  let l = must(buy(l0, ctx, { quantity: 2, buy_price_cents: 1000, buy_timestamp: iso(T0 + day) })).ledger;
  l = must(buy(l, ctx, { quantity: 3, buy_price_cents: 1100, buy_timestamp: iso(T0 + 2 * day) })).ledger;

  const partial = sell(l, ctx, { quantity: 1 });
  assert.equal(partial.ok, false);
  assert.match(partial.errors[0], /Partial-lot sales are not supported/);
  assert.match(partial.errors[0], /Valid quantities: 2, 5/);
  assert.equal(sell(l, ctx, { quantity: 3 }).ok, false); // 2 + 1 of the next lot

  const first = must(sell(l, ctx, { quantity: 2, sell_price_cents: 1300 }));
  assert.deepEqual(first.trade.lot_ids, ["id-2"]); // oldest lot first
  assert.equal(first.trade.acquisition_cost_cents, 2000);

  const both = must(sell(l, ctx, { quantity: 5, sell_price_cents: 1300 }));
  assert.deepEqual(both.trade.lot_ids, ["id-2", "id-3"]);
  assert.equal(both.trade.acquisition_cost_cents, 2000 + 3300);
  assert.equal(both.trade.hold_duration_hours, 8 * 24); // from the earliest consumed lot

  const replay = replayLedger(both.ledger);
  assert.equal(replay.ok, true);
  assert.equal(replay.open_lots.length, 0);
  assert.ok(both.ledger.lots.every((x) => x.status === "closed"));
});

test("reinvestment: 0% banked below $100 deployable, floor(30%) at/above", () => {
  // Below threshold: deposit 5000, buy 1000, sell 1200 → deployable at close 5158 < 10000.
  let { ledger, ctx } = setup(5000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 1000 })).ledger;
  const low = must(sell(ledger, ctx, { sell_price_cents: 1200 }));
  assert.equal(low.trade.realized_net_profit_cents, 158);
  assert.equal(low.trade.banked_allocation_cents, 0);

  // At threshold: deposit 20000.
  ({ ledger, ctx } = setup(20000));
  ledger = must(buy(ledger, ctx, { buy_price_cents: 1000 })).ledger;
  const high = must(sell(ledger, ctx, { sell_price_cents: 1200 }));
  assert.equal(high.trade.deployable_capital_at_close_cents, 20158);
  assert.equal(high.trade.banked_allocation_cents, 47); // floor(158 × 0.30) = floor(47.4)
  const b = computeBalances(high.ledger, {});
  assert.equal(b.banked_profit_cents, 47);
  assert.equal(b.usd_cash_balance_cents, 20158);
  assert.equal(b.free_cash_cents, 20158 - 47);
  assert.equal(b.deployable_capital_cents, 20158 - 47);
});

test("realized losses never reduce banked profit; banked is never spent implicitly", () => {
  let { ledger, ctx } = setup(20000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 1000, buy_timestamp: iso(T0 + day) })).ledger;
  ledger = must(sell(ledger, ctx, { sell_price_cents: 1200, sell_timestamp: iso(T0 + 9 * day) })).ledger;
  assert.equal(computeBalances(ledger, {}).banked_profit_cents, 47);

  ledger = must(buy(ledger, ctx, { buy_price_cents: 5000, buy_timestamp: iso(T0 + 10 * day) })).ledger;
  const loss = must(sell(ledger, ctx, { sell_price_cents: 3000, sell_timestamp: iso(T0 + 18 * day) }));
  assert.ok(loss.trade.realized_net_profit_cents < 0);
  assert.equal(loss.trade.banked_allocation_cents, 0);
  const b = computeBalances(loss.ledger, {});
  assert.equal(b.banked_profit_cents, 47);
  assert.equal(b.usd_cash_balance_cents, 20158 - 5000 + loss.trade.net_sale_proceeds_cents);

  // A buy that would need banked money is rejected until an explicit redeploy.
  const free = b.free_cash_cents;
  const tooBig = buy(loss.ledger, ctx, { buy_price_cents: free + 1, buy_timestamp: iso(T0 + 19 * day) });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.errors[0], /banked profit is never spent implicitly/);
  const redeployed = must(
    recordAdjustment(loss.ledger, { kind: "bank_redeploy", amount_cents: 47, timestamp: iso(T0 + 19 * day) }, ctx),
  ).ledger;
  must(buy(redeployed, ctx, { buy_price_cents: free + 1, buy_timestamp: iso(T0 + 19 * day + 1000) }));
});

test("cash withdrawals: plain withdrawal cannot touch banked; from_banked reduces both", () => {
  let { ledger, ctx } = setup(20000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 1000 })).ledger;
  ledger = must(sell(ledger, ctx, { sell_price_cents: 1200 })).ledger; // banked 47, cash 20158
  const ts = iso(T0 + 10 * day);
  assert.equal(recordAdjustment(ledger, { kind: "cash", amount_cents: -20158, timestamp: ts }, ctx).ok, false);
  const w = must(recordAdjustment(ledger, { kind: "cash", amount_cents: -47, from_banked: true, timestamp: ts }, ctx));
  const b = computeBalances(w.ledger, {});
  assert.equal(b.banked_profit_cents, 0);
  assert.equal(b.usd_cash_balance_cents, 20111);
  assert.equal(recordAdjustment(ledger, { kind: "wallet", amount_cents: -1, timestamp: ts }, ctx).ok, false);
});

test("wallet-funded Steam buy spends wallet, not cash", () => {
  let { ledger, ctx } = setup(1000);
  ledger = must(recordAdjustment(ledger, { kind: "wallet", amount_cents: 800, timestamp: iso(T0) }, ctx)).ledger;
  assert.equal(buy(ledger, ctx, { buy_market: "csfloat", funding_source: "steam_wallet", buy_price_cents: 500 }).ok, false);
  const r = must(buy(ledger, ctx, { buy_market: "steam", funding_source: "steam_wallet", buy_price_cents: 500 }));
  const b = computeBalances(r.ledger, {});
  assert.equal(b.steam_wallet_balance_cents, 300);
  assert.equal(b.usd_cash_balance_cents, 1000);
  assert.equal(buy(ledger, ctx, { buy_market: "steam", funding_source: "steam_wallet", buy_price_cents: 900 }).ok, false);
});

test("input validation: future timestamps, non-ISO, non-integer cents, unknown market", () => {
  const { ledger, ctx } = setup(5000);
  assert.equal(buy(ledger, ctx, { buy_timestamp: iso(Date.parse(NOW) + 1000) }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_timestamp: "2026-01-02 10:00" }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_timestamp: "2026-01-02T10:00:00+02:00" }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_price_cents: 12.5 }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_price_cents: 0 }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_market: "buff" }).ok, false);
  assert.equal(buy(ledger, ctx, { quantity: 0 }).ok, false);
  assert.equal(buy(ledger, ctx, { canonical_item_id: "  " }).ok, false);
  assert.equal(buy(ledger, ctx, { buy_price_cents: 5001 }).ok, false); // exceeds cash
});

test("inventory valuation: unvalued lots are flagged, never zero-filled or cost-filled", () => {
  let { ledger, ctx } = setup(10000);
  ledger = must(buy(ledger, ctx, { canonical_item_id: "A", buy_price_cents: 1000 })).ledger;
  ledger = must(buy(ledger, ctx, { canonical_item_id: "B", buy_price_cents: 2000 })).ledger;
  const valuation = (id) =>
    id === "A"
      ? { state: "OK", unit_value_cents: 1100, market: "csfloat", listing_depth: 7 }
      : { state: "INSUFFICIENT_DATA", reason: "no market meets MIN_LISTING_DEPTH" };
  const b = computeBalances(ledger, { valuation });
  assert.equal(b.inventory_value_cents, 1100);
  assert.equal(b.inventory_complete, false);
  assert.deepEqual(b.unvalued_lot_ids, ["id-3"]);
  assert.equal(b.lot_valuations.find((v) => v.lot_id === "id-3").state, "INSUFFICIENT_DATA");
  assert.equal(b.current_open_exposure_cents, 3000);
  assert.equal(b.deployable_capital_cents, 7000 + 1100);
});

test("recordSell trips the circuit breaker on gross 24h loss >= 10% of deployable", () => {
  let { ledger, ctx } = setup(10000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 5000 })).ledger;
  const r = must(sell(ledger, ctx, { sell_price_cents: 3500 })); // net 3430 − 51 = 3379 → loss 1621
  assert.equal(r.trade.realized_net_profit_cents, -1621);
  assert.equal(r.trade.deployable_capital_at_close_cents, 5000 + 3379);
  assert.equal(r.circuit_breaker.tripped, true);
  assert.equal(r.circuit_breaker.triggered_at, r.trade.sell_timestamp);
});

test("export → import round-trips; tampered or malformed imports are rejected", () => {
  let { ledger, ctx } = setup(20000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 1000 })).ledger;
  ledger = must(sell(ledger, ctx, { sell_price_cents: 1200 })).ledger;
  const text = exportLedger(ledger, { nowIso: NOW, circuitBreakerTriggeredAt: null });
  const back = importLedger(text);
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.deepEqual(back.ledger, ledger);
  assert.equal(back.circuit_breaker_triggered_at, null);

  const doc = JSON.parse(text);
  const tamper = (fn) => {
    const d = structuredClone(doc);
    fn(d);
    return importLedger(JSON.stringify(d));
  };
  assert.equal(tamper((d) => (d.ledger.trades[0].net_sale_proceeds_cents += 100)).ok, false);
  assert.equal(tamper((d) => (d.ledger.trades[0].banked_allocation_cents = 0)).ok, false);
  assert.equal(tamper((d) => (d.ledger.lots[0].status = "open")).ok, false);
  assert.equal(tamper((d) => (d.ledger.lots[0].buy_price_cents = 10.5)).ok, false);
  assert.equal(tamper((d) => (d.ledger.lots[0].buy_timestamp = "yesterday")).ok, false);
  assert.equal(tamper((d) => (d.ledger.lots[0].extra = 1)).ok, false);
  assert.equal(tamper((d) => (d.format = "other")).ok, false);
  assert.equal(importLedger("{not json").ok, false);
});

test("import derives the circuit breaker trip from stored close snapshots", () => {
  let { ledger, ctx } = setup(10000);
  ledger = must(buy(ledger, ctx, { buy_price_cents: 5000 })).ledger;
  const r = must(sell(ledger, ctx, { sell_price_cents: 3500 }));
  const back = importLedger(exportLedger(r.ledger, { nowIso: NOW, circuitBreakerTriggeredAt: null }));
  assert.equal(back.circuit_breaker_triggered_at, r.trade.sell_timestamp);
});
