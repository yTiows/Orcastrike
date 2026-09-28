// Backtest module.
//
// (a) Single-market historical simulation: buy at Steam's daily price on day d, sell on
//     Steam at day d + hold (Trade Protection floor), Steam fee applied. This is the only
//     simulation free data supports. It is HISTORICAL CONTEXT: not a forecast (P0-8) and
//     not evidence of cross-market arbitrage performance (P0-7). Proceeds of a Steam sale
//     are Steam Wallet funds, not cash.
// (b) Cross-market backtest: needs synchronized historical listing prices on Steam, CSFloat
//     and Skinport. No free source provides that, so the verdict is fixed below.

import { DEFAULTS } from "../config/defaults.js";
import { BPS, computeTrade, marginBps, medianInt, mulDivRoundHalfUp, resolveSellFee } from "./money.js";

export const HISTORICAL_LABEL =
  "Historical simulated margin (Steam-only, 7-day hold) — historical context only. " +
  "Not a forecast and not evidence of cross-market arbitrage performance.";
export const CROSS_MARKET_VERDICT = "INSUFFICIENT DATA TO VALIDATE CROSS-MARKET STRATEGY.";

const DAY_MS = 86400000;

function dateMs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function isPoint(p) {
  return p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isSafeInteger(p.price_usd_cents) && p.price_usd_cents > 0;
}

// detail: also return per-sample net profit (cents, 1 unit) for HISTORICAL_SIMULATED_PROFIT.
export function simulateSingleMarket(points, { nowMs, cfg = DEFAULTS, detail = false } = {}) {
  const holdDays = cfg.BACKTEST_HOLD_DAYS;
  const lookbackDays = cfg.BACKTEST_LOOKBACK_DAYS;
  const minSamples = cfg.BACKTEST_MIN_SAMPLES;
  const base = {
    kind: "single_market_historical_simulation",
    market: "steam",
    label: HISTORICAL_LABEL,
    hold_days: holdDays,
    lookback_days: lookbackDays,
    required_samples: minSamples,
    proceeds_note: "Steam sale proceeds are Steam Wallet funds, not cash.",
  };
  if (!Array.isArray(points) || !points.every(isPoint)) {
    return { ...base, state: "INSUFFICIENT_DATA", samples: 0, reason: "price history missing or invalid" };
  }
  const windowStart = nowMs - lookbackDays * DAY_MS;
  const byDate = new Map(points.map((p) => [p.date, p.price_usd_cents]));
  const steamFee = resolveSellFee({ market: "steam", unitGrossCents: 1 });

  const gross = [];
  const net = [];
  const profits = [];
  for (const p of points) {
    const buyMs = dateMs(p.date);
    if (buyMs < windowStart) continue;
    const sellDate = new Date(buyMs + holdDays * DAY_MS).toISOString().slice(0, 10);
    const sell = byDate.get(sellDate);
    if (sell === undefined || dateMs(sellDate) > nowMs) continue;
    const r = computeTrade({
      quantity: 1,
      unitBuyPriceCents: p.price_usd_cents,
      unitSellPriceCents: sell,
      sellFeeBps: steamFee.bps,
      payoutFeeBps: 0,
      sellFeeModel: steamFee.model,
    });
    if (r.state !== "OK") continue;
    gross.push(marginBps(sell - p.price_usd_cents, p.price_usd_cents));
    net.push(r.net_margin_bps);
    profits.push({ net_profit_cents: r.net_profit_cents, buy_date: p.date });
  }
  const window = { window_start: new Date(windowStart).toISOString().slice(0, 10), window_end: new Date(nowMs).toISOString().slice(0, 10) };
  if (net.length < minSamples) {
    return { ...base, ...window, state: "INSUFFICIENT_DATA", samples: net.length, reason: `${net.length} paired days < ${minSamples} required` };
  }
  return {
    ...base,
    ...window,
    state: "OK",
    samples: net.length,
    median_gross_change_bps: medianInt(gross),
    median_net_margin_bps: medianInt(net),
    positive_net_share_bps: mulDivRoundHalfUp(net.filter((x) => x > 0).length, BPS, net.length),
    ...(detail ? { samples_detail: profits } : {}),
  };
}

export function crossMarketBacktest() {
  return {
    kind: "cross_market_backtest",
    state: "INSUFFICIENT_DATA",
    verdict: CROSS_MARKET_VERDICT,
    reason:
      "Requires synchronized historical listing prices and depth on Steam, CSFloat and Skinport. " +
      "Only Steam median sale history is freely available; CSFloat and Skinport expose current listings only.",
  };
}
