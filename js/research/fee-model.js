// Fee model versions. The base version is config/fees.js as documented in FEES.md. A new
// version exists only after the user accepts a calibration proposal; it records date, source
// and the exact overrides. Buy-side fees are 0 in the base model because every entry price
// observed is the buyer-pays listing price; payment-method/deposit fees are not modeled
// (FEES.md "Not modeled").

import { FEES } from "../../config/fees.js";
import { applySellFee, computeSale, mulDivRoundHalfUp, rateToBps, resolvePayoutFeeBps, resolveSellFee, steamValveSellerReceives } from "../money.js";

export const BASE_FEE_MODEL = Object.freeze({
  fee_model_version: "fees-v1@2026-09-27",
  created_at: "2026-09-27T00:00:00.000Z",
  source: "config/fees.js (FEES.md; web-search-verified rates, CSFloat payout pinned mid-range)",
  accepted_by_user: true,
  buy_side_bps: Object.freeze({ steam: 0, csfloat: 0, skinport: 0 }),
  buy_side_note: "entry prices are buyer-pays listing prices; deposit/payment-method fees not modeled",
  fees: FEES,
});

// overrides: subset of config/fees.js keys (e.g. { CSFLOAT_SELL_FEE: 0.025 }).
export function deriveFeeModel(parent, { overrides, created_at, source }) {
  const fees = Object.freeze({ ...parent.fees, ...overrides, CSFLOAT_PAYOUT_FEE_RATE: Object.freeze({ ...parent.fees.CSFLOAT_PAYOUT_FEE_RATE, ...(overrides.CSFLOAT_PAYOUT_FEE_RATE ?? {}) }) });
  const version = `fees-${created_at.slice(0, 10)}-${Object.keys(overrides).sort().join("+").toLowerCase()}`;
  return Object.freeze({ ...parent, fee_model_version: version, parent_version: parent.fee_model_version, created_at, source, accepted_by_user: true, fees, overrides: Object.freeze({ ...overrides }) });
}

export function entryCostCents(model, market, askCents, quantity = 1) {
  const bps = model.buy_side_bps[market];
  if (!Number.isSafeInteger(bps)) throw new Error(`no buy-side fee for ${market}`);
  const gross = askCents * quantity;
  return { entry_cost_cents: gross + mulDivRoundHalfUp(gross, bps, 10000), buy_side_fee_bps: bps };
}

// Sell-side net at a given unit price (quantity 1), per model: seller fee + payout fee.
export function sellSideNet(model, market, unitPriceCents, { fxRateMicros, rail }) {
  const fee = resolveSellFee({ market, schedule: "auto", unitGrossCents: unitPriceCents, fxRateMicros, fees: model.fees });
  const payoutBps = resolvePayoutFeeBps(market, rail, model.fees);
  const sale = computeSale({ quantity: 1, unitSellPriceCents: unitPriceCents, acquisitionCostCents: 1, sellFeeBps: fee.bps, payoutFeeBps: payoutBps, sellFeeModel: fee.model, fees: model.fees });
  if (sale.state !== "OK") return { state: "INVALID", reason: sale.reason };
  return {
    state: "OK",
    schedule: fee.schedule,
    sell_fee_bps: fee.bps,
    sell_fee_cents: sale.sell_fee_cents,
    payout_fee_bps: payoutBps,
    payout_fee_cents: sale.payout_fee_cents,
    net_cents: sale.net_sale_proceeds_cents,
  };
}

// C4: the conservative spec formula and Valve's exact method, side by side (Steam sales).
export function steamFeeComparison(model, grossCents) {
  const conservative = applySellFee(grossCents, rateToBps(model.fees.STEAM_SELL_FEE));
  let exact;
  try {
    exact = steamValveSellerReceives(grossCents, model.fees);
  } catch {
    exact = null; // below Steam's minimum price
  }
  return { gross_cents: grossCents, conservative_net_cents: conservative, valve_exact_net_cents: exact, default_model: model.fees.STEAM_FEE_MODEL };
}
