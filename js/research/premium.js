// Pattern/float premium and item identity.
// Premium state is KNOWN (hardcoded table entry with source URL + retrieval date), ESTIMATED,
// or UNKNOWN. UNKNOWN never contributes to any profit figure. This build ships no numeric
// premium table, so every premium is UNKNOWN and contributes 0 by construction.
// Identity = market_hash_name + phase (+ seed bucket) only where KNOWN; otherwise name + wear.

import { CASE_HARDENED_SEEDS, DOPPLER_PHASES, FADE_PERCENT_SEEDS, MARBLE_FADE_SEEDS, PHASE_DEPENDENT_NAME } from "../../config/pattern-seeds.js";

export function premiumFor(name, listing = null) {
  const tables = [CASE_HARDENED_SEEDS, FADE_PERCENT_SEEDS, MARBLE_FADE_SEEDS];
  const seed = listing?.paint_seed;
  for (const t of tables) {
    const hit = Number.isSafeInteger(seed) ? t.seeds[seed] : undefined;
    if (hit && t.source_url && t.retrieval_date) return { state: "KNOWN", premium_cents: hit.premium_cents, source_url: t.source_url, retrieval_date: t.retrieval_date, contributes: true };
  }
  return { state: "UNKNOWN", premium_cents: null, contributes: false, reason: "no citable premium table entry" };
}

// Name-level identity. Phase-dependent names compared across markets by name alone would
// compare different phases, so they are AMBIGUOUS unless a KNOWN phase is attached.
export function identityFor(name, listing = null) {
  if (!PHASE_DEPENDENT_NAME.test(name)) return { state: "KNOWN", key: name, basis: "market_hash_name (name + wear + StatTrak/Souvenir)" };
  const isGamma = /Gamma Doppler/.test(name);
  const phase = !isGamma && Number.isSafeInteger(listing?.paint_index) ? DOPPLER_PHASES.by_paint_index[listing.paint_index] : undefined;
  if (phase) return { state: "KNOWN", key: `${name} | ${phase}`, basis: `paint index ${listing.paint_index} → ${phase} (${DOPPLER_PHASES.source_url}, retrieved ${DOPPLER_PHASES.retrieval_date})` };
  return {
    state: "AMBIGUOUS",
    key: name,
    reason: isGamma ? "Gamma Doppler phases have no cited paint-index table in this build" : "name-level quotes mix Doppler phases; no KNOWN phase attached",
  };
}

// The only way a premium may touch money: KNOWN premiums, explicitly. UNKNOWN adds nothing.
export function premiumContributionCents(premium) {
  return premium && premium.state === "KNOWN" && premium.contributes && Number.isSafeInteger(premium.premium_cents) ? premium.premium_cents : 0;
}
