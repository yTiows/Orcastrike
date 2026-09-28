// Evidence engine (pure). Gates and the evidence ladder. No level inherits evidence from a
// lower level: each level is decided only from evidence of its own kind. Paper trades never
// count toward EXECUTION_EVIDENCE; paper and real distributions are never pooled.
// Market regime coverage is undefined → always reported UNKNOWN, never claimed.

export const EVIDENCE_CONTRACT = "evidence_report@1";

export const GATE_THRESHOLDS = Object.freeze({
  signal_min_paper_trades: 30,
  signal_min_days: 14,
  signal_min_coverage_pct: 80,
  execution_min_real_trades: 30,
});

const check = (name, required, actual, pass, detail) => ({ name, required, actual, pass, ...(detail ? { detail } : {}) });

// paperTrades: CLOSED, non-synthetic paper trades of this strategy_version.
// coverage: [{ day, sources: { source: coverage_pct_x100 | null } }] for the last N complete days.
export function signalEvidence({ strategyVersion, paperTrades, firstObservationAt, nowMs, coverage, contributingSources, openHighEvents, thresholds = GATE_THRESHOLDS }) {
  const completed = paperTrades.filter((p) => p.status === "CLOSED" && !p.synthetic && p.strategy_version === strategyVersion);
  const days = firstObservationAt ? Math.floor((nowMs - Date.parse(firstObservationAt)) / 86400000) : 0;
  const lastDays = coverage.slice(-thresholds.signal_min_days);
  const failingDays = [];
  for (const d of lastDays) {
    for (const s of contributingSources) {
      const pct = d.sources[s];
      if (pct === null || pct === undefined || pct < thresholds.signal_min_coverage_pct * 100) failingDays.push(`${d.day} ${s}: ${pct === null || pct === undefined ? "no data" : `${pct / 100}%`}`);
    }
  }
  const coverageOk = lastDays.length >= thresholds.signal_min_days && failingDays.length === 0;
  const checks = [
    check("completed paper trades (this strategy_version)", `≥ ${thresholds.signal_min_paper_trades}`, completed.length, completed.length >= thresholds.signal_min_paper_trades),
    check("days of observation", `≥ ${thresholds.signal_min_days}`, days, days >= thresholds.signal_min_days),
    check(`snapshot coverage per day per contributing source (last ${thresholds.signal_min_days} complete UTC days)`, `≥ ${thresholds.signal_min_coverage_pct}%`, coverageOk ? "all days pass" : `${failingDays.length} failing day/source cells`, coverageOk, failingDays.slice(0, 20)),
    check("unresolved HIGH-severity data quality events", "0", openHighEvents.length, openHighEvents.length === 0),
  ];
  return { gate: "SIGNAL_EVIDENCE", strategy_version: strategyVersion, pass: checks.every((c) => c.pass), checks };
}

// realTrades: closed REAL ledger trades (with strategy_version). Paper trades are not accepted.
export function executionEvidence({ strategyVersion, realTrades, thresholds = GATE_THRESHOLDS }) {
  if (realTrades.some((t) => t.kind === "PAPER" || "paper_trade_id" in t)) throw new Error("paper trades never count toward EXECUTION_EVIDENCE");
  const n = realTrades.filter((t) => t.strategy_version === strategyVersion).length;
  const checks = [check("completed REAL trades recorded in the ledger (this strategy_version)", `≥ ${thresholds.execution_min_real_trades}`, n, n >= thresholds.execution_min_real_trades)];
  return { gate: "EXECUTION_EVIDENCE", strategy_version: strategyVersion, pass: checks.every((c) => c.pass), checks };
}

export function holdingPeriodBucket(hours) {
  if (!Number.isFinite(hours)) return "unknown";
  const d = hours / 24;
  if (d < 7) return "<7d";
  if (d < 14) return "7–13d";
  if (d < 30) return "14–29d";
  return "≥30d";
}

// Separate statistics; never pooled. rows: [{ market, hold_hours, net_profit_cents, net_margin_bps }]
export function breakdown(rows) {
  const by = (keyFn) => {
    const m = {};
    for (const r of rows) {
      const k = keyFn(r);
      const s = (m[k] ??= { n: 0, total_net_profit_cents: 0, wins: 0 });
      s.n += 1;
      s.total_net_profit_cents += r.net_profit_cents;
      if (r.net_profit_cents > 0) s.wins += 1;
    }
    return m;
  };
  return { by_marketplace: by((r) => r.market), by_holding_period: by((r) => holdingPeriodBucket(r.hold_hours)) };
}

export function strategyValidation({ signal, execution, paperRows, realRows }) {
  const sameVersion = signal.strategy_version === execution.strategy_version;
  return {
    gate: "STRATEGY_VALIDATION",
    strategy_version: signal.strategy_version,
    pass: sameVersion && signal.pass && execution.pass,
    checks: [
      check("SIGNAL_EVIDENCE passes", "true", signal.pass, signal.pass),
      check("EXECUTION_EVIDENCE passes", "true", execution.pass, execution.pass),
      check("both under the same strategy_version", "true", sameVersion, sameVersion),
    ],
    // Reported separately by marketplace and by holding period; paper and real never pooled.
    paper: breakdown(paperRows),
    real: breakdown(realRows),
  };
}

// Each level is decided from its own evidence only.
export function evidenceLadder({ verifiedObservations, observedDiscrepancies, syncedBacktest, signal, execution, validation, automationEnabled }) {
  const lvl = (level, name, reached, basis) => ({ level, name, status: reached ? "REACHED" : "NOT_REACHED", basis });
  return [
    lvl(0, "observed data", verifiedObservations > 0, `${verifiedObservations} non-synthetic observations from VERIFIED parsers`),
    lvl(1, "observed cross-market discrepancy", observedDiscrepancies > 0, `${observedDiscrepancies} non-synthetic opportunities with a COMPLETE snapshot group and positive expected_net_profit`),
    lvl(2, "simulated or historical evaluation", Boolean(syncedBacktest?.pass), syncedBacktest?.basis ?? "no replay of synchronized historical cross-market data meets the minimum samples ('backtest' label reserved)"),
    lvl(3, "forward paper trading evaluation", signal.pass, "SIGNAL_EVIDENCE gate"),
    lvl(4, "real execution evidence", execution.pass, "EXECUTION_EVIDENCE gate (REAL ledger trades only)"),
    lvl(5, "strategy validation", validation.pass, "STRATEGY_VALIDATION gate"),
    lvl(6, "automation", Boolean(automationEnabled) && validation.pass, "L3 automation enabled under a validated strategy (L3 unavailable: no verified execution API)"),
  ];
}

export const MARKET_REGIME_COVERAGE = Object.freeze({ state: "UNKNOWN", reason: "market regime coverage is not defined; it is never claimed" });
