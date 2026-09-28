// Parser verification status comes only from the latest live contract report: a parser is
// VERIFIED when that report shows PASS for its endpoint with the same parser version and the
// referenced LIVE fixture exists. Everything else is UNVERIFIED (or BLOCKED if unreachable).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerParser } from "./db.js";
import { ENDPOINTS } from "./sources.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_REPORT = join(ROOT, "tests", "fixtures", "live", "CONTRACT_REPORT.json");

export function loadVerification(reportPath = DEFAULT_REPORT) {
  const status = {};
  let report = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }
  for (const [endpoint, d] of Object.entries(ENDPOINTS)) {
    const r = report?.results?.find((x) => x.endpoint === endpoint);
    const fixture = r?.fixture ? join(ROOT, r.fixture) : null;
    if (r?.status === "PASS" && r.parse?.parser_version === d.parser_version && fixture && existsSync(fixture)) {
      status[d.parser_version] = { endpoint, verification_status: "VERIFIED", verified_fixture: r.fixture, verified_at: report.run_at };
    } else {
      status[d.parser_version] = { endpoint, verification_status: r?.status === "BLOCKED" ? "BLOCKED" : "UNVERIFIED", verified_fixture: null, verified_at: null };
    }
  }
  return { report_run_at: report?.run_at ?? null, status };
}

export function syncParserVersions(db, verification, nowIso) {
  for (const [parser_version, v] of Object.entries(verification.status)) registerParser(db, { parser_version, ...v }, nowIso);
}
