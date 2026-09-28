import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySellFee,
  computePayoutFee,
  computeTrade,
  dollarsStringToCents,
  eurCentsToUsdCents,
  majorUnitsToCents,
  marginBps,
  mulDivRoundHalfUp,
  parseDecimal,
  parseRateMicros,
  rateToBps,
  resolvePayoutFeeBps,
  resolveSellFee,
  skinportHighTierThresholdUsdCents,
  steamValveBuyerPays,
  steamValveSellerReceives,
} from "../js/money.js";
import { formatBpsPct, formatCents } from "../js/format.js";

test("ACCEPTANCE: CSFloat fee-adjusted margin (all intermediates)", () => {
  const sell = resolveSellFee({ market: "csfloat", unitGrossCents: 1200 });
  const payout = resolvePayoutFeeBps("csfloat", "bank");
  assert.equal(sell.bps, 200);
  assert.equal(payout, 150);

  const r = computeTrade({
    quantity: 1,
    unitBuyPriceCents: 1000,
    unitSellPriceCents: 1200,
    sellFeeBps: sell.bps,
    payoutFeeBps: payout,
  });
  assert.equal(r.state, "OK");
  assert.equal(r.after_seller_fee_cents, 1176); // round(1200 × 0.98)
  assert.equal(r.payout_fee_cents, 18); // round(1176 × 0.015) = round(17.64)
  assert.equal(r.net_sale_proceeds_cents, 1158);
  assert.equal(r.net_profit_cents, 158);
  assert.equal(r.net_margin_bps, 1580);
  assert.equal(r.net_margin_pct, 15.8);
  assert.equal(formatBpsPct(r.net_margin_bps), "15.80%");
  assert.equal(formatCents(r.net_profit_cents), "$1.58");
});

test("round-half-up at each fee step", () => {
  assert.equal(mulDivRoundHalfUp(1, 1, 2), 1); // 0.5 → 1
  assert.equal(mulDivRoundHalfUp(3, 1, 2), 2); // 1.5 → 2
  assert.equal(mulDivRoundHalfUp(-1, 1, 2), 0); // -0.5 → 0 (toward +∞)
  assert.equal(mulDivRoundHalfUp(-3, 1, 2), -1); // -1.5 → -1
  assert.equal(applySellFee(1250, 200), 1225); // 1225.0
  assert.equal(computePayoutFee(1170, 150), 18); // 17.55 → 18
  assert.equal(computePayoutFee(1130, 150), 17); // 16.95 → 17
  assert.equal(computePayoutFee(1100, 150), 17); // 16.5 → 17
});

test("float traps do not leak: values that break naive float math", () => {
  // 0.1 + 0.2 style: 1200 × 0.98 in float is 1175.9999999999998; integer path is exact.
  assert.equal(applySellFee(1200, rateToBps(0.02)), 1176);
  assert.equal(rateToBps(0.015), 150);
  assert.equal(rateToBps(0.07), 700);
  assert.equal(rateToBps(0.29), 2900);
  assert.throws(() => rateToBps(0.12345), /decimal places/);
  assert.throws(() => rateToBps(1), /out of range/);
  assert.equal(rateToBps(1, { allowOne: true }), 10000);
  assert.throws(() => rateToBps(-0.01));
  assert.throws(() => rateToBps(Number.NaN));
});

test("decimal parsing without floats", () => {
  assert.equal(dollarsStringToCents("12.34"), 1234);
  assert.equal(dollarsStringToCents("12"), 1200);
  assert.equal(dollarsStringToCents("0.5"), 50);
  assert.throws(() => dollarsStringToCents("1.234"), /decimal places/);
  assert.throws(() => dollarsStringToCents("abc"));
  assert.throws(() => dollarsStringToCents("1e3"));
  assert.equal(majorUnitsToCents(1.234), 123);
  assert.equal(majorUnitsToCents(1.235), 124);
  assert.equal(majorUnitsToCents("0.03"), 3);
  assert.equal(majorUnitsToCents(12.3), 1230);
  assert.throws(() => majorUnitsToCents(1e-7), /exponent/);
  assert.equal(parseDecimal("-5.00", 2), -500);
  assert.throws(() => parseDecimal("-5.005", 2, { round: "half_up" }));
});

test("FX conversion EUR→USD in integer micros", () => {
  const micros = parseRateMicros(1.0834);
  assert.equal(micros, 1083400);
  assert.equal(eurCentsToUsdCents(1000, micros), 1083); // 1083.4
  assert.equal(eurCentsToUsdCents(5, micros), 5); // 5.417
  assert.equal(eurCentsToUsdCents(15, 1100000), 17); // 16.5 → 17
  assert.throws(() => eurCentsToUsdCents(-1, micros));
  assert.throws(() => parseRateMicros(0));
  assert.equal(skinportHighTierThresholdUsdCents(micros), 108340);
});

test("Skinport fee tier auto-selection compares in USD", () => {
  const micros = 1100000; // 1 EUR = 1.10 USD → threshold 110000 USD cents
  assert.equal(resolveSellFee({ market: "skinport", unitGrossCents: 109999, fxRateMicros: micros }).bps, 800);
  assert.equal(resolveSellFee({ market: "skinport", unitGrossCents: 110000, fxRateMicros: micros }).bps, 600);
  assert.equal(resolveSellFee({ market: "skinport", schedule: "private", unitGrossCents: 500 }).bps, 200);
  assert.throws(() => resolveSellFee({ market: "skinport", unitGrossCents: 500 }), /FX rate/);
  assert.equal(resolvePayoutFeeBps("skinport"), 0);
  assert.equal(resolvePayoutFeeBps("csfloat", "usdc"), 100);
  assert.throws(() => resolvePayoutFeeBps("csfloat", "paypal"));
});

test("Steam canonical formula (spec) vs Valve fee-on-top reference", () => {
  const steam = resolveSellFee({ market: "steam", unitGrossCents: 2000 });
  assert.equal(steam.bps, 1500);
  assert.equal(steam.model, "flat_on_gross");
  assert.equal(applySellFee(2000, steam.bps), 1700);

  // Valve reference: buyer pays 20.00 → seller receives 17.39.
  assert.equal(steamValveSellerReceives(2000), 1739);
  assert.equal(steamValveBuyerPays(1739), 1998);
  assert.equal(steamValveBuyerPays(1740), 2001);
  assert.equal(steamValveSellerReceives(3), 1);
  assert.equal(steamValveSellerReceives(115), 100);
  assert.throws(() => steamValveSellerReceives(2));
  const valve = computeTrade({
    quantity: 1, unitBuyPriceCents: 1000, unitSellPriceCents: 2000,
    sellFeeBps: 1500, payoutFeeBps: 0, sellFeeModel: "valve_fee_on_top",
  });
  assert.equal(valve.after_seller_fee_cents, 1739);
});

test("invalid inputs → INVALID, never NaN or division by zero", () => {
  const base = { quantity: 1, unitBuyPriceCents: 1000, unitSellPriceCents: 1200, sellFeeBps: 200, payoutFeeBps: 150 };
  for (const patch of [
    { unitBuyPriceCents: 0 },
    { unitBuyPriceCents: -5 },
    { unitSellPriceCents: 0 },
    { unitBuyPriceCents: 10.5 },
    { quantity: 0 },
    { quantity: 1.5 },
    { sellFeeBps: 10000 },
    { sellFeeBps: -1 },
    { payoutFeeBps: Number.NaN },
    { sellFeeModel: "made_up" },
  ]) {
    const r = computeTrade({ ...base, ...patch });
    assert.equal(r.state, "INVALID", JSON.stringify(patch));
    assert.equal(typeof r.reason, "string");
  }
  assert.throws(() => marginBps(10, 0));
});

test("quantity > 1 applies the formula to the total gross", () => {
  const r = computeTrade({ quantity: 3, unitBuyPriceCents: 333, unitSellPriceCents: 401, sellFeeBps: 200, payoutFeeBps: 150 });
  assert.equal(r.gross_sale_price_cents, 1203);
  assert.equal(r.after_seller_fee_cents, 1179); // round(1178.94)
  assert.equal(r.payout_fee_cents, 18); // round(17.685)
  assert.equal(r.net_sale_proceeds_cents, 1161);
  assert.equal(r.acquisition_cost_cents, 999);
  assert.equal(r.net_profit_cents, 162);
  assert.equal(r.net_margin_bps, 1622); // 1621.62 → 1622
});

test("negative margin rounds deterministically", () => {
  const r = computeTrade({ quantity: 1, unitBuyPriceCents: 1000, unitSellPriceCents: 1000, sellFeeBps: 200, payoutFeeBps: 150 });
  assert.equal(r.after_seller_fee_cents, 980);
  assert.equal(r.payout_fee_cents, 15); // 14.7
  assert.equal(r.net_profit_cents, -35);
  assert.equal(r.net_margin_bps, -350);
  assert.equal(formatCents(-35), "-$0.35");
  assert.equal(formatBpsPct(-350), "-3.50%");
});
