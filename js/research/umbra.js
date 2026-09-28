// UMBRA: a ranking mode and a theme. It never grants execution permission (P0).
// Activation needs a declared bankroll and either a passing SIGNAL_EVIDENCE gate or the typed
// override "unproven edge", which allows ranking, L0 and L1 only and labels every screen
// UNPROVEN while active. Rails that always remain: daily circuit breaker, cash check,
// staleness exclusion, data-quality gate, fail closed.

export const OVERRIDE_PHRASE = "unproven edge";
export const MIN_BANKROLL_CENTS = 1000;

export function umbraActivation({ bankrollCents, signalEvidencePass, typedOverride }) {
  const errors = [];
  if (!Number.isSafeInteger(bankrollCents) || bankrollCents < MIN_BANKROLL_CENTS) errors.push("declare a bankroll of at least $10.00 (integer cents)");
  let unproven = false;
  if (!signalEvidencePass) {
    if (typedOverride === OVERRIDE_PHRASE) unproven = true;
    else errors.push(`SIGNAL_EVIDENCE has not passed; type "${OVERRIDE_PHRASE}" to rank anyway (ranking, L0 and L1 only; labeled UNPROVEN)`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings: { "umbra.active": true, "umbra.bankroll_cents": bankrollCents, "umbra.override_unproven": unproven } };
}

export const UMBRA_RAILS = Object.freeze(["daily circuit breaker", "cash check", "staleness exclusion", "data quality gate", "fail closed"]);

// What UMBRA changes in ranking (and nothing else).
export const UMBRA_RANKING_CHANGES = Object.freeze([
  "no v1 item price bands",
  "no tier limits",
  "no minimum margin / minimum profit filter",
  "universe = every item with a valid observation in the last completed discovery cycle, price ≥ $10, no ceiling",
  "single ranking by rank_metric",
]);
