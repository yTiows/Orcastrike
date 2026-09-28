// Snapshot grouping (pure). A cross-market computation may only use a group in which every
// contributing observation is within its maximum age AND the price-bearing observations from
// different sources were observed within the maximum cross-source skew. The group records
// exactly which observations (ids, timestamps, ages, parser versions) contributed and why the
// data is sufficient, or which rule failed.
//
// Quality states (no numeric scores): COMPLETE, PARTIAL, STALE, CONFLICTING, INSUFFICIENT, INVALID.
// Precedence when several rules fail: INVALID > INSUFFICIENT > STALE > CONFLICTING > PARTIAL > COMPLETE.

export const SNAPSHOT_CONTRACT = "snapshot_group@1";
const PRECEDENCE = ["INVALID", "INSUFFICIENT", "STALE", "CONFLICTING", "PARTIAL", "COMPLETE"];
const MAX_AGE_KEY = { quote: "max_age_quote_s", depth: "max_age_depth_s", reference: "max_age_reference_s", sales: "max_age_sales_s" };
// Only price-bearing observations must be synchronized across sources; sales aggregates and
// reference signals move slowly and have their own max ages.
const SKEW_KINDS = new Set(["quote", "depth"]);

export function upstreamCacheSeconds(source, snapshotCfg) {
  return source === "skinport" ? snapshotCfg.upstream_cache_skinport_s : 0;
}

// requirements: [{ role, source, kind, required: bool }]
// observations: { [role]: row | null } — rows from market_observations / sales_observations
// parserStatus: { [parser_version]: "VERIFIED" | "UNVERIFIED" | "BLOCKED" }
export function buildSnapshotGroup({ requirements, observations, nowMs, snapshotCfg, parserStatus }) {
  const reasons = [];
  const states = [];
  const notes = [];
  const contributing = [];
  const add = (state, reason) => {
    states.push(state);
    reasons.push(reason);
  };
  // Optional roles (signals, labels) never change the group state; their problems are notes.
  const note = (req, state, reason) => (req.required ? add(state, reason) : notes.push(`${state}: ${reason}`));

  for (const req of requirements) {
    const o = observations[req.role] ?? null;
    if (!o) {
      note(req, "INSUFFICIENT", `${req.role}: no ${req.kind} observation from ${req.source}`);
      continue;
    }
    const observedMs = Date.parse(o.observed_at);
    const cache = upstreamCacheSeconds(req.source, snapshotCfg);
    const ageS = Math.floor((nowMs - observedMs) / 1000) + cache;
    const maxAge = snapshotCfg[MAX_AGE_KEY[req.kind]];
    const pStatus = parserStatus[o.parser_version] ?? "UNVERIFIED";
    contributing.push({
      role: req.role,
      source: req.source,
      kind: req.kind,
      id: o.observation_id ?? o.sales_observation_id,
      table: o.sales_observation_id ? "sales_observations" : "market_observations",
      observed_at: o.observed_at,
      effective_age_s: ageS,
      upstream_cache_s: cache,
      max_age_s: maxAge,
      parser_version: o.parser_version,
      parser_status: pStatus,
      quality_state: o.quality_state,
      synthetic: Boolean(o.synthetic),
    });
    if (Number.isNaN(observedMs) || observedMs > nowMs + 60000) {
      note(req, "INVALID", `${req.role}: observed_at invalid or in the future`);
      continue;
    }
    if (o.quality_state === "INVALID") note(req, "INVALID", `${req.role}: observation INVALID (${o.quality_reason ?? "validator"})`);
    else if (o.quality_state === "INSUFFICIENT") note(req, "INSUFFICIENT", `${req.role}: ${o.quality_reason ?? "insufficient"}`);
    if (pStatus !== "VERIFIED") note(req, "INSUFFICIENT", `${req.role}: PARSER_UNVERIFIED ${o.parser_version} (no LIVE fixture has passed this parser)`);
    if (ageS > maxAge) note(req, "STALE", `${req.role}: effective age ${ageS}s > max ${maxAge}s${cache ? ` (incl. ${cache}s upstream cache)` : ""}`);
  }

  const requiredRoles = new Set(requirements.filter((r) => r.required).map((r) => r.role));
  const timed = contributing.filter((c) => SKEW_KINDS.has(c.kind) && requiredRoles.has(c.role));
  const sources = new Set(timed.map((c) => c.source));
  let skewS = 0;
  if (sources.size > 1) {
    const ts = timed.map((c) => Date.parse(c.observed_at));
    skewS = Math.floor((Math.max(...ts) - Math.min(...ts)) / 1000);
    if (skewS > snapshotCfg.max_cross_source_skew_s) add("CONFLICTING", `cross-source skew ${skewS}s > max ${snapshotCfg.max_cross_source_skew_s}s`);
  }

  const state = PRECEDENCE.find((s) => states.includes(s)) ?? "COMPLETE";
  const sufficiency =
    state === "COMPLETE"
      ? `all ${contributing.length} contributing observations within max age, parsers VERIFIED, cross-source skew ${skewS}s ≤ ${snapshotCfg.max_cross_source_skew_s}s`
      : null;
  return {
    contract: SNAPSHOT_CONTRACT,
    state,
    reasons: state === "COMPLETE" ? [] : reasons,
    notes,
    sufficiency,
    skew_s: skewS,
    synthetic: contributing.some((c) => c.synthetic),
    contributing,
  };
}
