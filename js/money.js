// Integer-cents money math. ALL fee/margin arithmetic in the app routes through this
// module (P0-6). Amounts are safe integers in USD cents; rates are integer basis points
// (1 bps = 0.01%); FX rates are integer micros (rate × 1e6). Multiplication/division
// happens in BigInt with explicit rounding, so no float ever decides a cent.
//
// Rounding: round-half-up (toward +∞) at every fee-application step, per spec.

import { FEES } from "../config/fees.js";

export const BPS = 10000;
export const MICROS = 1000000;

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MoneyError";
  }
}

export function isCents(value) {
  return Number.isSafeInteger(value);
}

function assertInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${name} must be a safe integer, got ${String(value)}`);
}

function toSafeNumber(big, name) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`${name} overflows safe integer range`);
  }
  return Number(big);
}

// Floor division for BigInt with positive divisor (BigInt `/` truncates toward zero).
function floorDiv(n, d) {
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

// round(a × b / d), half-up. d > 0.
export function mulDivRoundHalfUp(a, b, d) {
  assertInt(a, "a");
  assertInt(b, "b");
  assertInt(d, "d");
  if (d <= 0) throw new MoneyError("divisor must be > 0");
  const D = BigInt(d);
  return toSafeNumber(floorDiv(2n * BigInt(a) * BigInt(b) + D, 2n * D), "mulDivRoundHalfUp");
}

// floor(a × b / d). d > 0.
export function mulDivFloor(a, b, d) {
  assertInt(a, "a");
  assertInt(b, "b");
  assertInt(d, "d");
  if (d <= 0) throw new MoneyError("divisor must be > 0");
  return toSafeNumber(floorDiv(BigInt(a) * BigInt(b), BigInt(d)), "mulDivFloor");
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

// Parse a decimal string into an integer scaled by 10^scale, without floats.
// round: "reject" → throw if more precision than `scale`; "half_up" → round the
// magnitude half-up (only allowed for non-negative input).
export function parseDecimal(str, scale, { round = "reject" } = {}) {
  if (typeof str !== "string") throw new MoneyError("decimal input must be a string");
  const m = DECIMAL_RE.exec(str.trim());
  if (!m) throw new MoneyError(`not a plain decimal number: "${str}"`);
  const [, neg, intPart, frac = ""] = m;
  if (neg && round !== "reject") throw new MoneyError("rounding is only defined for non-negative input");
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  const rest = frac.slice(scale);
  let value = BigInt(intPart) * 10n ** BigInt(scale) + BigInt(kept === "" ? "0" : kept);
  if (/[1-9]/.test(rest)) {
    if (round === "reject") throw new MoneyError(`more than ${scale} decimal places: "${str}"`);
    if (rest.charCodeAt(0) >= 53 /* "5" */) value += 1n;
  }
  return toSafeNumber(neg ? -value : value, "parseDecimal");
}

// JSON numbers from upstream (e.g. 12.34) → exact decimal text via shortest round-trip repr.
export function numberToDecimalString(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new MoneyError(`not a finite number: ${String(n)}`);
  const s = String(n);
  if (/e/i.test(s)) throw new MoneyError(`exponent-form number not accepted: ${s}`);
  return s;
}

// User-typed dollars ("12.34", "12") → cents. Rejects sub-cent precision.
export function dollarsStringToCents(str) {
  return parseDecimal(str, 2, { round: "reject" });
}

// Upstream price in major units (number or string) → cents, half-up at ingestion.
export function majorUnitsToCents(value) {
  const s = typeof value === "number" ? numberToDecimalString(value) : value;
  return parseDecimal(s, 2, { round: "half_up" });
}

// Decimal fraction (e.g. 0.015) → integer bps; must be exactly representable in bps.
export function rateToBps(rate, { allowOne = false } = {}) {
  const bps = parseDecimal(numberToDecimalString(rate), 4, { round: "reject" });
  if (bps < 0 || bps > BPS || (bps === BPS && !allowOne)) {
    throw new MoneyError(`rate out of range: ${String(rate)}`);
  }
  return bps;
}

// Percent number (e.g. 3.0 meaning 3%) → bps.
export function pctToBps(pct) {
  return parseDecimal(numberToDecimalString(pct), 2, { round: "reject" });
}

export function isValidFeeBps(bps) {
  return Number.isSafeInteger(bps) && bps >= 0 && bps < BPS;
}

// ---- FX -------------------------------------------------------------------------

export function parseRateMicros(value) {
  const s = typeof value === "number" ? numberToDecimalString(value) : value;
  const micros = parseDecimal(s, 6, { round: "half_up" });
  if (micros <= 0) throw new MoneyError("FX rate must be > 0");
  return micros;
}

export function eurCentsToUsdCents(eurCents, rateMicros) {
  assertInt(eurCents, "eurCents");
  if (eurCents < 0) throw new MoneyError("eurCents must be >= 0");
  if (!Number.isSafeInteger(rateMicros) || rateMicros <= 0) throw new MoneyError("rateMicros must be > 0");
  return mulDivRoundHalfUp(eurCents, rateMicros, MICROS);
}

// ---- Fee steps (canonical formula) ----------------------------------------------

// after_seller_fee_cents = round(gross × (1 − sell_fee_rate))
export function applySellFee(grossCents, sellFeeBps) {
  assertInt(grossCents, "grossCents");
  if (!isValidFeeBps(sellFeeBps)) throw new MoneyError("sell fee must satisfy 0 <= fee < 1");
  return mulDivRoundHalfUp(grossCents, BPS - sellFeeBps, BPS);
}

// payout_fee_cents = round(after_seller_fee × payout_fee_rate)
export function computePayoutFee(afterSellerFeeCents, payoutFeeBps) {
  assertInt(afterSellerFeeCents, "afterSellerFeeCents");
  if (!isValidFeeBps(payoutFeeBps)) throw new MoneyError("payout fee must satisfy 0 <= fee < 1");
  return mulDivRoundHalfUp(afterSellerFeeCents, payoutFeeBps, BPS);
}

// Margin in bps of acquisition cost (1580 bps = 15.80%). cost must be > 0.
export function marginBps(profitCents, costCents) {
  assertInt(profitCents, "profitCents");
  assertInt(costCents, "costCents");
  if (costCents <= 0) throw new MoneyError("acquisition cost must be > 0");
  return mulDivRoundHalfUp(profitCents, BPS, costCents);
}

// ---- Steam (Valve fee-on-top reference model) -----------------------------------

// Valve charges fees on top of what the seller receives: buyer pays
// r + max(floor(r×5%),1) + max(floor(r×10%),1). Integer re-implementation of
// CalculateAmountToSendForDesiredReceivedAmount.
export function steamValveBuyerPays(receivedCents) {
  assertInt(receivedCents, "receivedCents");
  const walletBps = rateToBps(FEES.STEAM_VALVE_WALLET_FEE_PCT);
  const pubBps = rateToBps(FEES.STEAM_VALVE_PUBLISHER_FEE_PCT);
  const steamFee = Math.max(mulDivFloor(receivedCents, walletBps, BPS), 1);
  const publisherFee = Math.max(mulDivFloor(receivedCents, pubBps, BPS), 1);
  return receivedCents + steamFee + publisherFee;
}

// Largest seller-received amount whose buyer price does not exceed buyerPaysCents
// (Valve assigns any leftover cent to the Steam fee). Equivalent of CalculateFeeAmount.
export function steamValveSellerReceives(buyerPaysCents) {
  assertInt(buyerPaysCents, "buyerPaysCents");
  if (buyerPaysCents < FEES.STEAM_MIN_BUYER_PRICE_CENTS) throw new MoneyError("below Steam minimum price");
  let r = mulDivFloor(buyerPaysCents, 100, 115);
  while (r > 1 && steamValveBuyerPays(r) > buyerPaysCents) r -= 1;
  while (steamValveBuyerPays(r + 1) <= buyerPaysCents) r += 1;
  return r;
}

// ---- Fee resolution per market ---------------------------------------------------

export function resolvePayoutFeeBps(market, rail) {
  if (market === "csfloat") {
    const rate = FEES.CSFLOAT_PAYOUT_FEE_RATE[rail];
    if (rate === undefined) throw new MoneyError(`unknown CSFloat payout rail: ${String(rail)}`);
    return rateToBps(rate);
  }
  if (market === "skinport") return rateToBps(FEES.SKINPORT_PAYOUT_FEE_RATE);
  if (market === "steam") return 0; // proceeds stay in Steam Wallet; no payout rail
  throw new MoneyError(`unknown market: ${String(market)}`);
}

// Skinport high-tier threshold (EUR 1,000) converted to USD cents with the same FX rate
// used at ingestion, so the comparison happens in USD (P0-6).
export function skinportHighTierThresholdUsdCents(fxRateMicros) {
  return eurCentsToUsdCents(FEES.SKINPORT_HIGH_TIER_THRESHOLD_EUR_CENTS, fxRateMicros);
}

// schedule: steam/csfloat ignore it. skinport: "standard" | "over_1000eur" | "private" | "auto".
// "auto" (scanner) picks 6% vs 8% from the unit price and needs fxRateMicros.
export function resolveSellFee({ market, schedule = "auto", unitGrossCents, fxRateMicros }) {
  if (market === "steam") {
    return { bps: rateToBps(FEES.STEAM_SELL_FEE), model: FEES.STEAM_FEE_MODEL, schedule: "steam" };
  }
  if (market === "csfloat") return { bps: rateToBps(FEES.CSFLOAT_SELL_FEE), model: "flat_on_gross", schedule: "csfloat" };
  if (market === "skinport") {
    let resolved = schedule;
    if (schedule === "auto") {
      if (!Number.isSafeInteger(fxRateMicros) || fxRateMicros <= 0) {
        throw new MoneyError("Skinport fee tier needs the FX rate used at ingestion");
      }
      resolved = unitGrossCents >= skinportHighTierThresholdUsdCents(fxRateMicros) ? "over_1000eur" : "standard";
    }
    const rate = {
      standard: FEES.SKINPORT_SELL_FEE_STANDARD,
      over_1000eur: FEES.SKINPORT_SELL_FEE_OVER_1000EUR,
      private: FEES.SKINPORT_SELL_FEE_PRIVATE_LISTING,
    }[resolved];
    if (rate === undefined) throw new MoneyError(`unknown Skinport fee schedule: ${String(schedule)}`);
    return { bps: rateToBps(rate), model: "flat_on_gross", schedule: resolved };
  }
  throw new MoneyError(`unknown market: ${String(market)}`);
}

// ---- Canonical trade calculation --------------------------------------------------

// Implements the spec's canonical formula on the total gross (quantity × unit sell price).
// Returns { state: "OK", ...intermediates } or { state: "INVALID", reason } — never NaN.
export function computeTrade({
  quantity,
  unitBuyPriceCents,
  unitSellPriceCents,
  sellFeeBps,
  payoutFeeBps,
  sellFeeModel = "flat_on_gross",
}) {
  const invalid = (reason) => ({ state: "INVALID", reason });
  if (!Number.isSafeInteger(quantity) || quantity < 1) return invalid("quantity must be an integer >= 1");
  if (!Number.isSafeInteger(unitBuyPriceCents) || unitBuyPriceCents <= 0) return invalid("buy price must be > 0 cents");
  if (!Number.isSafeInteger(unitSellPriceCents) || unitSellPriceCents <= 0) return invalid("sell price must be > 0 cents");
  if (!isValidFeeBps(sellFeeBps)) return invalid("sell fee must satisfy 0 <= fee < 1");
  if (!isValidFeeBps(payoutFeeBps)) return invalid("payout fee must satisfy 0 <= fee < 1");

  try {
    const gross = unitSellPriceCents * quantity;
    const acquisition = unitBuyPriceCents * quantity;
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(acquisition)) return invalid("amount overflow");
    if (acquisition <= 0) return invalid("acquisition cost must be > 0");

    let afterSellerFee;
    if (sellFeeModel === "valve_fee_on_top") {
      // Valve's fee is per listing (per unit).
      afterSellerFee = steamValveSellerReceives(unitSellPriceCents) * quantity;
    } else if (sellFeeModel === "flat_on_gross") {
      afterSellerFee = applySellFee(gross, sellFeeBps);
    } else {
      return invalid(`unknown sell fee model: ${String(sellFeeModel)}`);
    }
    const payoutFee = computePayoutFee(afterSellerFee, payoutFeeBps);
    const netProceeds = afterSellerFee - payoutFee;
    const netProfit = netProceeds - acquisition;
    const margin = marginBps(netProfit, acquisition);
    return {
      state: "OK",
      quantity,
      unit_buy_price_cents: unitBuyPriceCents,
      unit_sell_price_cents: unitSellPriceCents,
      gross_sale_price_cents: gross,
      sell_fee_bps: sellFeeBps,
      sell_fee_model: sellFeeModel,
      sell_fee_cents: gross - afterSellerFee,
      after_seller_fee_cents: afterSellerFee,
      payout_fee_bps: payoutFeeBps,
      payout_fee_cents: payoutFee,
      net_sale_proceeds_cents: netProceeds,
      acquisition_cost_cents: acquisition,
      net_profit_cents: netProfit,
      net_margin_bps: margin,
      // Display-only convenience; derived from integer bps, never fed back into math.
      net_margin_pct: margin / 100,
    };
  } catch (err) {
    if (err instanceof MoneyError) return invalid(err.message);
    throw err;
  }
}
