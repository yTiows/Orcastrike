// Pattern / phase tables. An entry exists only with a documented source URL and retrieval
// date. Where nothing citable exists the table is empty and every premium is UNKNOWN.

export const DOPPLER_PHASES = Object.freeze({
  applies_to: /(^|\s|\|)Doppler(\s|\(|$)/, // "Karambit | Doppler (Factory New)", not "Gamma Doppler"
  source_url: "https://www.steamanalyst.com/guides/doppler-phases",
  also_cited: "https://steamdb.com/en/articles/cs2-doppler-phases-guide",
  retrieval_date: "2026-09-28",
  retrieval_method: "web-search result summary quoting the source; page not fetched directly (build egress blocked)",
  by_paint_index: Object.freeze({ 415: "Ruby", 416: "Sapphire", 417: "Black Pearl", 418: "Phase 1", 419: "Phase 2", 420: "Phase 3", 421: "Phase 4" }),
});

// Names whose value depends on a phase/pattern that name-level quotes can't distinguish.
export const PHASE_DEPENDENT_NAME = /\b(Gamma )?Doppler\b/;

// No citable numeric premium source was retrievable; these stay empty on purpose.
export const CASE_HARDENED_SEEDS = Object.freeze({ source_url: null, retrieval_date: null, seeds: Object.freeze({}) });
export const FADE_PERCENT_SEEDS = Object.freeze({ source_url: null, retrieval_date: null, seeds: Object.freeze({}) });
export const MARBLE_FADE_SEEDS = Object.freeze({ source_url: null, retrieval_date: null, seeds: Object.freeze({}) });
