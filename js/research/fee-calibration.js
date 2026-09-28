// Fee calibrator (pure). Compares user-recorded sale receipts (actual net received) with the
// net computed by the fee model that was in force, and writes a PROPOSED_CALIBRATION. Nothing
// changes until the user accepts; acceptance creates a new fee_model_version (fee-model.js).

import { computeSale, resolvePayoutFeeBps, resolveSellFee, steamValveSellerReceives } from "../money.js";

export const MIN_RECEIPTS = 3;

// receipts: [{ trade_id, market, quantity, gross_sale_cents, receipt_net_cents, fee_schedule, payout_rail, computed_net_cents }]
export function calibrate(receipts, feeModel, { minReceipts = MIN_RECEIPTS } = {}) {
  const byMarket = {};
  for (const r of receipts) {
    if (!Number.isSafeInteger(r.receipt_net_cents) || !Number.isSafeInteger(r.computed_net_cents)) continue;
    (byMarket[r.market] ??= []).push(r);
  }
  const proposals = [];
  for (const [market, rows] of Object.entries(byMarket)) {
    const diffs = rows.map((r) => r.receipt_net_cents - r.computed_net_cents);
    const nonzero = diffs.filter((d) => d !== 0);
    if (rows.length < minReceipts || nonzero.length === 0) continue;
    const sameSign = nonzero.every((d) => Math.sign(d) === Math.sign(nonzero[0]));
    const observed = rows.reduce((s, r) => s + r.receipt_net_cents, 0);
    const expected = rows.reduce((s, r) => s + r.computed_net_cents, 0);
    const gross = rows.reduce((s, r) => s + r.gross_sale_cents, 0);
    const reasons = [];
    let overrides = null;
    if (market === "steam") {
      const exactTotal = rows.reduce((s, r) => s + steamValveSellerReceives(Math.floor(r.gross_sale_cents / r.quantity), feeModel.fees) * r.quantity, 0);
      if (exactTotal === observed) {
        reasons.push("receipts match Valve's exact fee-on-top method (C4)");
        overrides = { STEAM_FEE_MODEL: "valve_fee_on_top" };
      } else reasons.push("receipts match neither the conservative nor Valve's exact method; check entry");
    } else if (sameSign) {
      // Implied total fee rate (seller + payout) in bps over all receipts.
      const impliedTotalBps = Math.round(((gross - observed) * 10000) / gross);
      reasons.push(`implied total fee ${impliedTotalBps} bps vs model; possible causes: payout tier differs from the pinned mid-range, fee schedule changed, receipt entered net of bank charges`);
      if (market === "csfloat") {
        const rail = rows[0].payout_rail ?? "bank";
        const sellBps = resolveSellFee({ market, unitGrossCents: 1, fees: feeModel.fees }).bps;
        // after_seller = gross × (1 − s); net = after × (1 − p) ⇒ 1 − p = (1 − t)/(1 − s)
        const pBps = Math.round(10000 - ((10000 - impliedTotalBps) * 10000) / (10000 - sellBps));
        if (pBps >= 0 && pBps < 10000) overrides = { CSFLOAT_PAYOUT_FEE_RATE: { [rail]: pBps / 10000 } };
      }
    } else {
      reasons.push("differences have mixed signs; likely rounding or entry errors, no systematic change proposed");
    }
    proposals.push({
      kind: "PROPOSED_CALIBRATION",
      market,
      fee_model_version: feeModel.fee_model_version,
      receipts: rows.length,
      observed_net_cents: observed,
      expected_net_cents: expected,
      difference_cents: observed - expected,
      possible_reasons: reasons,
      proposed_overrides: overrides,
      trade_ids: rows.map((r) => r.trade_id),
      status: "PROPOSED",
    });
  }
  return proposals;
}

// Net the model would have computed for a recorded sale (used to fill computed_net_cents).
export function modelNet(feeModel, { market, quantity, unitSellPriceCents, feeSchedule, payoutRail }) {
  const fee = resolveSellFee({ market, schedule: market === "skinport" ? feeSchedule : "auto", unitGrossCents: unitSellPriceCents, fees: feeModel.fees });
  const payout = resolvePayoutFeeBps(market, payoutRail ?? "bank", feeModel.fees);
  const s = computeSale({ quantity, unitSellPriceCents, acquisitionCostCents: 1, sellFeeBps: fee.bps, payoutFeeBps: payout, sellFeeModel: fee.model, fees: feeModel.fees });
  return s.state === "OK" ? s.net_sale_proceeds_cents : null;
}
