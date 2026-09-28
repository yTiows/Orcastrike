// Metric semantics: what each displayed quantity DOES and DOES NOT mean. The UI renders these
// strings verbatim next to the values; docs quote them. Changing a definition here is a
// strategy-relevant change (it's part of signal_version).

export const CATEGORIES = Object.freeze({
  OBSERVED: "OBSERVED",
  OBSERVED_AGG: "OBSERVED-AGG",
  SIGNAL: "SIGNAL",
  ESTIMATED: "ESTIMATED",
  SIMULATED: "SIMULATED",
  PAPER: "PAPER",
  REAL: "REAL",
  USER_ASSUMPTION: "USER_ASSUMPTION",
});

export const METRICS = Object.freeze({
  listing_supply: {
    category: "OBSERVED",
    does: "Count of active listings on one market within ±10% of that market's quoted price, from the same response as the quote.",
    does_not: "Mean demand, buyer interest, fill probability or sales volume. A lower bound when the source returned only its first page.",
  },
  observed_sale_velocity: {
    category: "OBSERVED",
    does: "Sales per day on ONE named market over the trailing 7 days, from that market's reported sales (≥ 10 sales required, else INSUFFICIENT).",
    does_not: "Mean current executable demand, demand on any other market, or that your listing will sell at the quoted price.",
  },
  estimated_exit_days: {
    category: "ESTIMATED",
    does: "quantity ÷ observed_sale_velocity of the SAME market as the exit leg. UNKNOWN when velocity is INSUFFICIENT.",
    does_not: "Mean a promised or typical time to sell; it assumes your units take a share of turnover equal to all sales.",
  },
  buyer_side_liquidity: {
    category: "OBSERVED",
    does: "CSFloat buy orders at or above the planned exit price (count and summed quantity), only where the API verifiably provides them.",
    does_not: "Exist in this build: the endpoint is UNVERIFIED, so this is always UNVERIFIED.",
  },
  reference_price: {
    category: "SIGNAL",
    does: "CSFloat's predicted price for the lowest listing, with source, timestamp and sample size if provided.",
    does_not: "Mean truth, fair value or an exit price. It never enters profit math.",
  },
  executable_exit_price: {
    category: "OBSERVED",
    does: "The observed lowest ask on the exit market at snapshot time (cash leg). Only this feeds profit math.",
    does_not: "Mean a price you will receive; you'd have to list at or below it and wait.",
  },
  hold_adverse_move: {
    category: "ESTIMATED",
    does: "25th percentile of (ask at t+H ÷ ask at t − 1) over ≥ 30 snapshot pairs H days apart on the exit market in the trailing 30 days.",
    does_not: "Mean a worst case, a forecast, or anything about market regimes not seen in those 30 days.",
  },
  reversal_reserve: {
    category: "USER_ASSUMPTION",
    does: "A user-set percentage of entry cost held back for trade reversals/scams.",
    does_not: "Come from any measurement. Real incidents are logged for future calibration only.",
  },
  expected_net_profit: {
    category: "ESTIMATED",
    does: "pessimistic_proceeds − entry_cost − reversal_reserve for one unit, from live observations and the defined math.",
    does_not: "Mean a forecast, an average outcome or a promise. It is never computed from historical simulation.",
  },
  rank_metric: {
    category: "ESTIMATED",
    does: "expected_net_profit ÷ (entry_cost × hold_days), used only to order ELIGIBLE opportunities.",
    does_not: "Mean an annualized return or a probability.",
  },
  instant_sale_reference: {
    category: "OBSERVED",
    does: "A quoted instant-sale price with source, quantity, timestamp and expiry, where such a quote exists.",
    does_not: "Mean a floor or a guaranteed price. No verified source exists in this build, so it is always UNAVAILABLE.",
  },
});

export const PROFIT_FIGURES = Object.freeze({
  REALIZED_NET_PROFIT: { category: "REAL", does: "Sum of realized_net_profit_cents over closed REAL ledger trades.", does_not: "Include paper, simulated, estimated or unrealized amounts." },
  PAPER_NET_PROFIT: { category: "PAPER", does: "Sum of paper_net_profit_cents over CLOSED paper trades (forward paper trading, pessimistic fills).", does_not: "Mean money made, or evidence of execution." },
  HISTORICAL_SIMULATED_PROFIT: { category: "SIMULATED", does: "Sum of simulated net profit over the Steam-only 7-day historical round trips loaded in this session.", does_not: "Mean a forecast or cross-market evidence." },
  MARK_TO_MARKET_UNREALIZED_PNL: { category: "OBSERVED", does: "Open lots valued at the lowest depth-qualified cash-market ask minus cost basis (lower bound when lots are unvalued).", does_not: "Mean proceeds after fees or a sale price you could get." },
  ESTIMATED_EXIT_PROFIT: { category: "ESTIMATED", does: "For open lots: pessimistic_proceeds on the best cash exit minus cost basis minus reversal reserve.", does_not: "Mean a forecast; UNKNOWN when hold_adverse_move is INSUFFICIENT." },
});

export const EVIDENCE_LEVELS = Object.freeze([
  { level: 0, name: "observed data" },
  { level: 1, name: "observed cross-market discrepancy" },
  { level: 2, name: "simulated or historical evaluation" },
  { level: 3, name: "forward paper trading evaluation" },
  { level: 4, name: "real execution evidence" },
  { level: 5, name: "strategy validation" },
  { level: 6, name: "automation" },
]);
