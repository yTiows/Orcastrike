# Failure states

How each component behaves when something goes wrong. The rule everywhere: **fail closed**. A missing, late, malformed, unverified or contradictory input produces an explicit state (INSUFFICIENT, STALE, CONFLICTING, INVALID, UNAVAILABLE, NOT_CONFIGURED, DEGRADED) with a reason. It is never a number, a zero, or a deal.

Each entry lists INPUT → PROCESSING → OUTPUT, the FAILURE behaviour, RECOVERY, and the TEST that proves it. Test names are the literal `test("…")` titles.

## Upstream API down (HTTP 5xx, 4xx other than 401/429)

| | |
|---|---|
| INPUT | Scheduled job (daemon) or `/api/quote` request (Worker) |
| PROCESSING | `UpstreamClient.get` (daemon) / `fetchUpstream` (Worker) |
| OUTPUT | `source_requests.outcome = HTTP_ERROR`, `http_status` kept, no observation row. Worker: quote `UNAVAILABLE` with a reason; the upstream body is never echoed. |
| FAILURE | Snapshot groups needing that source lose their input and become `INSUFFICIENT` (`no quote observation from …`) or `STALE` as the last observation ages. No opportunity can be `ELIGIBLE`. A data-quality event is recorded once per endpoint. |
| RECOVERY | Automatic. The next successful job resolves the open quality event (`resolveOnRecovery`). |
| TEST | `upstream errors never echo upstream body or auth material` (worker); `pipeline: network down, timeout, missing key and 401 each store no observation and record why` (daemon) |

## Format change (fields renamed, types changed, envelope changed)

| | |
|---|---|
| INPUT | 2xx response whose body no longer matches the parser's expectations |
| PROCESSING | Endpoint normalizer → `validateRecord`; offline, `scripts/contract_test.mjs` diffs the live shape against `EXPECTED_SHAPES` |
| OUTPUT | `outcome = PARSE_ERROR`, HIGH-severity `PARSER_FAILURE` quality event, no observation stored. Contract test: endpoint `FAIL` with a field-level shape diff. |
| FAILURE | An open HIGH event fails SIGNAL_EVIDENCE (`unresolved HIGH-severity data quality events = 0`). A parser without a passing LIVE fixture is `UNVERIFIED`, and every snapshot using it is `INSUFFICIENT (PARSER_UNVERIFIED)`. |
| RECOVERY | Update the parser, bump its version (`parser_versions` is append-only), then re-run `node scripts/contract_test.mjs` locally until the endpoint is `PASS`. Old observations keep their old parser version. |
| TEST | `pipeline: malformed body → PARSE_ERROR + HIGH quality event; recovery resolves it`; `shape diff reports missing fields and type mismatches`; `unverified parser → INSUFFICIENT (PARSER_UNVERIFIED), even with perfect data` |

## Malformed data (non-JSON, NaN prices, negative quantities, non-USD strings)

| | |
|---|---|
| INPUT | Response body or individual records |
| PROCESSING | Parsers reject anything that isn't an exact USD string or integer cents; `validateRecord` checks types, ranges and ISO-UTC timestamps |
| OUTPUT | Whole body bad → `PARSE_ERROR`. Single bad record → stored as `INVALID` with a reason, or dropped with a quality event. Worker: `INVALID`. |
| FAILURE | `INVALID` outranks every other state in a snapshot group. Timestamps in the future are `INVALID`, never "fresh". |
| RECOVERY | Automatic once the source sends valid data. |
| TEST | `Steam priceoverview parser: USD strings only, fails closed`; `CSFloat {data: [...]} envelope accepted; malformed price → INVALID`; `future timestamps are INVALID, not fresh`; `non-AVAILABLE worker states and sanity failures → INSUFFICIENT_DATA, never NaN` |

## Missing auth (CSFLOAT_API_KEY unset, or rejected)

| | |
|---|---|
| INPUT | CSFloat job or quote with no key, or with a key the API rejects |
| PROCESSING | Daemon: `runJob` checks `requiresKey` before any request. Worker: same check before `fetch`. |
| OUTPUT | Unset: `NOT_CONFIGURED`, `AUTH_MISSING` quality event, **no request made**, health reports `csfloat: NOT_CONFIGURED`. Rejected (401/403): `HTTP_ERROR`, no observation. |
| FAILURE | CSFloat legs are `INSUFFICIENT`. Steam and Skinport continue. |
| RECOVERY | Set the key in the daemon's environment (or `wrangler secret put CSFLOAT_API_KEY` for the Worker) and restart. The key is never written to disk, logs, responses or backups. |
| TEST | `pipeline: network down, timeout, missing key and 401 each store no observation and record why`; `CSFloat without key → NOT_CONFIGURED, no upstream call, health reports it`; `secrets never leave the daemon; write guards hold` |

## Timeout

| | |
|---|---|
| INPUT | Upstream that accepts the connection but doesn't answer |
| PROCESSING | 8 s `AbortController` in both the daemon and the Worker; 3 s timeout on IndexedDB open; client-side timeout in `WorkerClient` |
| OUTPUT | `outcome = TIMEOUT`, `error = "timeout after 8s"`, no observation. Worker: `UNAVAILABLE`. |
| FAILURE | Same as API down. Nothing waits indefinitely. |
| RECOVERY | Automatic on the next scheduled job. |
| TEST | `pipeline: network down, timeout, missing key and 401 each store no observation and record why`; `8s upstream timeout → UNAVAILABLE (no indefinite hang)`; `IndexedDB open that never completes times out into the fallback instead of hanging` |

## Rate limit (HTTP 429, or the local budget is exhausted)

| | |
|---|---|
| INPUT | 429 from upstream, or an empty local token bucket |
| PROCESSING | Per-host `TokenBucket` with capacities below documented or observed limits (CONFIGURATION.md `ratelimit.*`); a 429 sets exponential host backoff |
| OUTPUT | Upstream 429: `RATE_LIMITED` + quality event, **no retry**. Local bucket empty: `DEFERRED` (no request made). Worker: `RATE_LIMITED`, cached for the normal TTL so clients can't hammer it. |
| FAILURE | Observations age, so groups become `STALE`. `capacityPlan` reports demand above capacity as `INFEASIBLE` in the coverage panel instead of silently under-sampling. |
| RECOVERY | Automatic after backoff. There is no circumvention: no proxy rotation, no extra accounts. |
| TEST | `pipeline: upstream 429 → RATE_LIMITED, host backoff, no retry`; `token bucket: capacity, refill, 429 backoff`; `429 → RATE_LIMITED immediately, no retry; cached for the normal TTL`; `scheduler plan: capacity vs demand is reported, infeasible configs are visible` |

## Stale data

| | |
|---|---|
| INPUT | Observation older than its role's max age (quote 180 s, depth 300 s, reference 900 s, sales 1800 s). Skinport's documented 300 s upstream cache is added to its effective age. |
| PROCESSING | `buildSnapshotGroup` (research); `assessQuote` (v1 scanner, `QUOTE_MAX_AGE_SECONDS`) |
| OUTPUT | Group `STALE` with the role, effective age and limit in the reason. v1 scanner: `STALE` / `INSUFFICIENT_DATA`, with no partial calculation. |
| FAILURE | Never `ELIGIBLE`; no profit figure is computed from a stale input. By construction, Skinport quotes are always STALE at the 180 s default (D-40). |
| RECOVERY | Automatic when a fresh observation arrives. |
| TEST | `ACCEPTANCE 1: stale CSFloat quote → ineligible, STALE, no calculation uses it`; `ACCEPTANCE 1 (grouping part): stale CSFloat quote → STALE`; `Skinport's upstream cache is added to effective age`; `ACCEPTANCE: data freshness gating — one fresh, one stale → INSUFFICIENT_DATA, no partial calc` |

## Partial data

| | |
|---|---|
| INPUT | A group where every required role is present but an optional role (e.g. reference price, buyer-side liquidity) is missing |
| PROCESSING | `buildSnapshotGroup`: missing optional roles become notes |
| OUTPUT | `PARTIAL`, listing what is missing. Metrics that needed the missing input show `UNAVAILABLE`, `UNKNOWN` or `INSUFFICIENT`, never zero. |
| FAILURE | Only `COMPLETE` groups can be `ELIGIBLE`. A missing required role is `INSUFFICIENT`, not `PARTIAL`. |
| RECOVERY | Automatic. |
| TEST | `precedence: INVALID > INSUFFICIENT > STALE > CONFLICTING`; `five profit figures stay separate; missing inputs are UNAVAILABLE, never zero-filled`; `inventory valuation: unvalued lots are flagged, never zero-filled or cost-filled` |

## Contradictory sources

| | |
|---|---|
| INPUT | (a) Observations from different sources more than 120 s apart. (b) An item name that maps to more than one identity (Doppler phases). (c) A quote whose source or item doesn't match the request. |
| PROCESSING | Skew check across required quote/depth roles; `identityFor` / `premiumFor`; Worker response matching in `WorkerClient.quote` |
| OUTPUT | (a) `CONFLICTING` with the measured skew. (b) `IDENTITY_AMBIGUOUS`. (c) `INVALID` ("does not match the requested source/item"). |
| FAILURE | Never `ELIGIBLE`. Sources are never averaged or reconciled into one "best" number, and velocities are never pooled across markets. |
| RECOVERY | (a) Automatic when the sources are sampled closer together. (b) Only a KNOWN phase resolves it. |
| TEST | `ACCEPTANCE 2: observations 200s apart across sources → CONFLICTING`; `phase-dependent names are identity-AMBIGUOUS without a KNOWN phase`; `velocities are never pooled across markets` |

## Corrupt database (daemon)

| | |
|---|---|
| INPUT | `orcastrike.sqlite` that SQLite can't open, or that opens but fails `PRAGMA integrity_check` |
| PROCESSING | `openDb` → `integrityCheck` at start-up. A check that throws counts as failed. |
| OUTPUT | **Unreadable file:** the daemon refuses to start and exits with code 2, printing a one-line recovery message and no stack trace. The file is not modified. **Openable but damaged:** the daemon runs `DEGRADED`: health reports `integrity: CORRUPT, degraded: true`, the UI status bar shows DEGRADED, there is no sampling, no engine and no autopilot, and every POST returns 503. |
| FAILURE | Research features stop. The browser ledger, which is the only record of real trades, is separate and unaffected. |
| RECOVERY | Stop the daemon. Move the file aside (`mv orcastrike.sqlite orcastrike.sqlite.corrupt`) and restart for a fresh database, or restore a copy of the data directory. The UI re-syncs the ledger. Observation history since the last copy is lost, because the daemon keeps no second copy (LIMITATIONS.md). |
| TEST | `unreadable database file: daemon refuses to start, prints recovery, modifies nothing`; `damaged database: integrity check fails closed → DEGRADED, no sampling, writes refused`; `transactions roll back on error`; `observations are append-only: UPDATE and DELETE abort` |

## Browser storage unavailable (private mode, blocked site data, quota)

| | |
|---|---|
| INPUT | IndexedDB open fails or hangs; localStorage throws |
| PROCESSING | `openStorage`: IndexedDB → localStorage fallback (separate `sat.fallback.*` keys) → in-memory store |
| OUTPUT | `Storage: localstorage` or `Storage: memory` in the Ledger tab and status bar, with a warning. Memory mode says the ledger will be lost on reload and to export it. |
| FAILURE | A ledger that fails validation is **not loaded** and not overwritten: the Ledger tab lists the errors and offers the raw data for download. A corrupt circuit-breaker timestamp is treated as ACTIVE. |
| RECOVERY | Leave private mode or allow site data, then import the last export or backup. Imports are checksum-verified, and a tampered file is rejected. |
| TEST | `IndexedDB unavailable → localStorage fallback, with a visible warning`; `no usable storage at all → memory store; warns the ledger will be lost on reload`; `export → import round-trips; tampered or malformed imports are rejected`; `backup round trip verifies the checksum; any modification is rejected`; browser smoke `storage: *` checks |

## Daily backup unavailable

| | |
|---|---|
| INPUT | Browser without the File System Access API (Firefox, Safari), or permission revoked |
| PROCESSING | `dailyBackup` |
| OUTPUT | `UNSUPPORTED`, shown as "Daily backup: UNVERIFIED in this browser … Use Export". `PERMISSION_NEEDED` asks for one click. |
| FAILURE | No silent skip: the state is always visible in the Ledger tab. |
| RECOVERY | Use the checksummed Export, or a Chromium browser. |
| TEST | `without the File System Access API, daily backup reports UNSUPPORTED (manual export fallback)`; browser smoke `backup: UNVERIFIED label without File System Access` |

## Disconnected network / daemon not running

| | |
|---|---|
| INPUT | Machine offline; daemon stopped; Worker unreachable |
| PROCESSING | `DaemonClient.detect` (short timeout); `WorkerClient.getJson` |
| OUTPUT | Daemon: "Daemon: not connected (research features off)". The Research tab explains, and the kill switch is disabled with the text "no daemon: nothing to stop". Worker: every quote is `UNAVAILABLE` ("Worker unreachable"). The ledger keeps working offline. |
| FAILURE | Nothing is computed from cached prices past their max age. Daemon jobs record `NETWORK_ERROR` and groups go `STALE`. |
| RECOVERY | Automatic. The daemon resumes on its next job, and the UI re-detects the daemon on reload. |
| TEST | `pipeline: network down, timeout, missing key and 401 each store no observation and record why`; browser smoke (CDN blocked: `dashboard: Chart.js absent (CDN blocked)`, `dashboard: chart area never blank without Chart.js`) |

## Chart library blocked (CDN down, SRI mismatch)

| | |
|---|---|
| INPUT | `chart.umd.min.js` fails to load or fails its integrity check |
| PROCESSING | `renderPriceChart` checks `window.Chart` |
| OUTPUT | "Chart unavailable (Chart.js did not load)" followed by a table of the same data |
| FAILURE | Nothing else depends on it. |
| RECOVERY | Automatic on a later load. |
| TEST | browser smoke `dashboard: Chart.js absent (CDN blocked)` and `console: no errors, page errors or CSP violations` |

## Automation / execution faults

| | |
|---|---|
| INPUT | Unexpected API response, API failure, or stale data while an automation level is active |
| PROCESSING | `AutomationController` |
| OUTPUT | `STOP`, and the kill switch is engaged and persisted |
| FAILURE | L2/L3 can't be enabled in this build (`EXECUTION_API_VERIFIED = false`). The controller is exercised only against a SYNTHETIC mock. |
| RECOVERY | Release the kill switch in the UI. Release requires the same origin plus an explicit confirmation. |
| TEST | `ACCEPTANCE 7: unexpected API response in L3 → STOP and kill switch set`; `API failure and stale data also STOP; a well-formed response executes (mock)`; `kill switch stops UMBRA staging (still notifies); non-UMBRA cycles do nothing` |
