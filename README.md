# Orcastrike

A CS2 skin research terminal. It observes Steam, Skinport and CSFloat, tests cross-market hypotheses, and promotes a strategy only when evidence supports it. When evidence is insufficient, its answer is **no opportunity**.

It **never buys, sells or lists anything**. You record your own trades in its ledger.

**Status:** runs locally, and is covered by an automated test suite (`npm test`, run on Linux and Windows in CI) plus a browser smoke test. The app verifies the live data sources by itself on your machine (SETUP.md step 5). The repository ships no live-verified parser (the build environment's network blocked every source), no strategy is validated, and nothing is deployed. REQUIREMENTS.md has the status of every requirement.

## Quick start

You need **Node.js 22.13+** (and Git for updates).

**Windows (PowerShell)**

```powershell
winget install OpenJS.NodeJS.LTS; winget install Git.Git     # once, then open a new window
git clone -b claude/skin-arb-terminal-spec-rtocat https://github.com/yTiows/Orcastrike.git
cd Orcastrike
.\Orcastrike.cmd                                             # or double-click Orcastrike.cmd
```

**macOS / Linux**

```sh
git clone -b claude/skin-arb-terminal-spec-rtocat https://github.com/yTiows/Orcastrike.git
cd Orcastrike && ./orcastrike.sh                            # or: npm start
```

Your browser opens <http://127.0.0.1:8790/>. No `npm install` is needed to run it. The app verifies the live data sources and collects prices by itself; the **Overview** page lists the few steps that need you.

| Task | Windows | Any OS |
|---|---|---|
| Start / stop | `Orcastrike.cmd` / `Orcastrike.cmd stop` | `npm start` / `npm run stop` |
| Check everything and run the tests | `Orcastrike.cmd setup` | `npm run setup` |
| Update (fast-forward, database backed up first) | `Orcastrike.cmd update` | `npm run update` |
| Diagnose | `Orcastrike.cmd doctor` | `npm run doctor` |
| Re-check the live data sources now | Overview → **Verify now** (runs daily by itself) | same |

**[SETUP.md](SETUP.md)** is the full guide: prerequisites, the optional CSFloat key, what each page does, updates, and troubleshooting.

## Documentation

| | |
|---|---|
| [SETUP.md](SETUP.md) | Install, run, update, troubleshoot |
| [EVIDENCE.md](EVIDENCE.md) | Evidence ladder, gates, current status |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Every requirement with PASS / FAIL / UNVERIFIED / BLOCKED, plus the acceptance tests |
| [LIMITATIONS.md](LIMITATIONS.md) | What it can't do, and why |
| [FAILURE_STATES.md](FAILURE_STATES.md) | What happens when a source, the database or the browser storage fails |
| [CONFIGURATION.md](CONFIGURATION.md) | Every setting: class, default, bounds, dangerous combinations |
| [FEES.md](FEES.md) | Fee constants, sources, versions, calibration |
| [DATA_SOURCE_MATRIX.md](DATA_SOURCE_MATRIX.md) | Every data source and its verification status |
| [ARCHITECTURE_DELTA.md](ARCHITECTURE_DELTA.md), [PLAN.md](PLAN.md) | Architecture, runbooks (including the optional Cloudflare Worker) |
| [DECISIONS.md](DECISIONS.md), [CHANGELOG.md](CHANGELOG.md) | Why things are the way they are, and what changed |

## Safety

- Secrets are read only from the environment. Never put them in a file, the UI or a chat.
- Use a dedicated trading account that holds only the inventory being traded.
- Not financial advice.
