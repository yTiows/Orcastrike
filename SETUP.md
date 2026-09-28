# Setup and running

Everything here is done by one launcher, `scripts/orca.mjs`, with thin wrappers for each platform:

| | Windows | macOS / Linux | Any OS (npm) |
|---|---|---|---|
| Start (opens the browser) | double-click **`Orcastrike.cmd`** | `./orcastrike.sh` | `npm start` |
| Stop | Ctrl+C in its window, or `.\Orcastrike.cmd stop` | Ctrl+C, or `./orcastrike.sh stop` | `npm run stop` |
| Check prerequisites, install, test | `.\Orcastrike.cmd setup` | `./orcastrike.sh setup` | `npm run setup` |
| Update to the latest version | `.\Orcastrike.cmd update` | `./orcastrike.sh update` | `npm run update` |
| Diagnose problems | `.\Orcastrike.cmd doctor` | `./orcastrike.sh doctor` | `npm run doctor` |

The app itself needs **only Node.js**: no `npm install`, no build step, no admin rights. `npm` is used only for developer tools (ESLint, and Wrangler for the optional Cloudflare Worker).

---

## Fastest path (Windows, about 2 minutes)

In **PowerShell**:

```powershell
winget install OpenJS.NodeJS.LTS                 # once
winget install Git.Git                           # once; then close and reopen PowerShell
git clone -b claude/skin-arb-terminal-spec-rtocat https://github.com/yTiows/Orcastrike.git
cd Orcastrike
.\Orcastrike.cmd                                 # or double-click Orcastrike.cmd in Explorer
```

Your browser opens <http://127.0.0.1:8790/>. That's it: the app checks the live data sources and starts collecting prices by itself, and the **Overview** page lists the few things only you can do (record your starting cash, pick a backup folder, optionally add a CSFloat key). The steps below explain each part, updating and troubleshooting.

**Already downloaded the ZIP?** It runs as is: double-click `Orcastrike.cmd` in the extracted folder. To make updates work, run `.\Orcastrike.cmd update --convert` once ([step 7](#7-update)).

---

## 1. Prerequisites

| Tool | Needed for | Version |
|---|---|---|
| **Node.js** | Everything (the app uses Node's built-in SQLite) | **22.13 or newer**; the current LTS is recommended |
| **Git** | Updates (`update`), and the full secret scan (git history) | any recent |
| npm | Developer tools only; ships with Node | — |
| A Chromium browser (Chrome, Edge, Brave) | The automatic daily ledger backup (File System Access API) | Other browsers work, but daily backup there is UNVERIFIED; use **Export** instead |

**Windows:** `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`, or the installers from <https://nodejs.org> (LTS) and <https://git-scm.com/download/win>. Open a **new** PowerShell window afterwards so the new `PATH` applies.

**macOS:** `brew install node git`.

**Linux:** distribution packages are often older than 22.13. Use <https://nodejs.org>, [nvm](https://github.com/nvm-sh/nvm) (`nvm install --lts`), or NodeSource.

Check:

```powershell
node --version    # v22.13.0 or higher
git --version
```

## 2. Get the code

**Recommended: git clone.** Updates are then one command.

```powershell
cd $HOME                     # or wherever you keep projects
git clone -b claude/skin-arb-terminal-spec-rtocat https://github.com/yTiows/Orcastrike.git
cd Orcastrike
```

If git asks you to sign in, Git for Windows opens the GitHub login (Git Credential Manager).

**ZIP download:** extract it anywhere and use the folder as is. It isn't a git checkout, so `update` asks you to convert it once (step 7).

The repository forces LF line endings on every platform (`.gitattributes`), so a Windows clone behaves exactly like a Linux one.

## 3. Setup (optional, about 30 seconds)

```powershell
.\Orcastrike.cmd setup        # or: npm run setup
```

It:

1. checks Node (≥ 22.13) and that built-in SQLite loads;
2. creates the data folder `.orcastrike-data\`;
3. installs developer tools with `npm ci`, but only when `package-lock.json` changed since the last install (it keeps a stamp in `node_modules\.orcastrike-install.json`);
4. runs the full test suite and prints a one-line result, or the failing tests.

Use `setup --quick` to skip the tests. You can skip setup entirely: `start` doesn't need it.

> **npm "allow-scripts" warning** (newer npm versions): `esbuild` and `workerd` have install scripts that npm didn't run. Both belong to Wrangler, the Cloudflare Worker tool, and are needed only for `npm run dev:worker` and deploying. The app, the tests and the launcher don't use them. If you want the Worker tooling, approve them as your npm suggests (`npm install-scripts approve esbuild workerd`) and run `npm ci` again.

## 4. CSFloat API key (optional)

Without a key, CSFloat reports `NOT_CONFIGURED`; Steam and Skinport still work. The key is read **only from the environment**. Never put it in a project file, the web UI, or a chat.

Create a key in your CSFloat account's developer/API settings. Then:

The Overview page shows these same commands with a **Copy** button while no key is set.

**Windows (PowerShell).** This stores the key in your *user* environment, outside the project. It's typed hidden:

```powershell
$s = Read-Host "CSFloat API key" -AsSecureString
$k = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
[Environment]::SetEnvironmentVariable("CSFLOAT_API_KEY", $k, "User")
Remove-Variable s, k
```

Open a **new** window, then run `.\Orcastrike.cmd doctor`. It should show `CSFLOAT_API_KEY  set (value not shown)`.

To remove the key: `[Environment]::SetEnvironmentVariable("CSFLOAT_API_KEY", $null, "User")`.

**macOS / Linux**, for the current terminal session:

```sh
read -rs CSFLOAT_API_KEY && export CSFLOAT_API_KEY
./orcastrike.sh
```

Persisting the key in a shell profile stores it in plain text. That's your call.

## 5. Live data-source verification (automatic)

Until a parser has passed against a **live** response, the system treats its data as unverified, and **no opportunity can become ELIGIBLE**. This is deliberate (DECISIONS.md D-38). You don't need to do anything for it:

- A few seconds after the app starts, it runs the live contract check if there is no report yet or the last one is more than 24 hours old, and re-checks every hour after that. Overview shows the result per source (Steam, Skinport, CSFloat) and has a **Verify now** button.
- Each check calls every source once, well within rate limits.
- Results go to the app's data folder (`.orcastrike-data\contract\`): `CONTRACT_REPORT.json` with PASS, FAIL or BLOCKED per endpoint, and **sanitized** responses (seller identities and credential-like fields removed). Tracked repo files are never touched. The newest report, local or in the repo, is the one used.
- A source that fails stays unverified. "format changed" on Overview means an upstream changed its response and the parser needs an update (the report holds the field-level diff); "unreachable" means this network blocked it.
- Turn it off with the environment variable `ORCASTRIKE_AUTO_VERIFY=0`. It is always off in SYNTHETIC test mode.

To run it by hand instead, for example to commit shared fixtures to the repo:

```powershell
node scripts/contract_test.mjs      # picks up CSFLOAT_API_KEY from the environment if set
```

It writes to `tests\fixtures\live\`. Exit code: `0` all PASS, `1` a FAIL (format changed), `2` something BLOCKED or UNVERIFIED (unreachable, or no key for CSFloat). Look through the fixtures before committing them: they are sanitized, but they are real responses.

Optionally, `node scripts/netcheck.mjs` measures reachability and latency per source from this machine. It writes a report to `reports\netcheck\`.

## 6. Run it

**Windows:** double-click `Orcastrike.cmd`, or pin a shortcut to it. From a terminal: `.\Orcastrike.cmd` or `npm start`.

A console window shows the app's log, and your browser opens <http://127.0.0.1:8790/>:

```
✔ Orcastrike is running: http://127.0.0.1:8790/
  CSFloat: no key (optional) · data sources: being verified automatically (see the Overview page)
  Stop: Ctrl+C in this window, or `npm run stop` from another one.
```

- **Stop it:** press Ctrl+C in that window (Windows asks "Terminate batch job (Y/N)?"; answer Y), or run `.\Orcastrike.cmd stop` or `npm run stop` from another window.
- **Start options:** `--port 8791` (if 8790 is taken; the URL changes to match), `--no-open` (don't open a browser), `--no-update-check`.
  - Examples: `.\Orcastrike.cmd start --port 8791` or `npm start -- --port 8791`.
- **Already running?** Starting again just opens the browser on the running instance.
- **Update notice:** on start, a git checkout checks in the background whether a newer version exists and prints a one-line notice. It never updates by itself.
- **Security:** the app listens on 127.0.0.1 only, never on your network. If Windows asks whether Node.js may use the network, you can decline.

**First time in the UI.** Five pages, and the header shows the app's state (Live, Test data, Read-only, App not running) and the kill switch on every page.

1. **Overview**: what the app is doing right now, a short **Next steps** checklist that ticks itself off, the best current opportunities, your balances, the five profit figures (never added together), and evidence progress. Start here; most items need nothing from you.
2. **Opportunities**: every pair the engine checks, with its status in plain words next to the exact code, the reason it's blocked, sources with timestamps and age, and a full calculation trace (click a row). Expect **none at first**: rankings need at least 7 days of the app's own observations, and evidence gates need 14 days and 30 closed paper trades (EVIDENCE.md). Track record, data health, ranking mode (UMBRA) and fee calibration are collapsible sections below the table.
3. **Portfolio**: after you trade elsewhere, click **Record a buy** / **Record a sale** / **Add or withdraw cash**. Only that form opens; the time defaults to now, and the current market ask is offered as a one-click fill. The app never trades. In Chromium, choose a daily backup folder once (Overview offers it too), or use **Export** regularly.
4. **Markets**: current price gaps for your watchlist (prices refresh by themselves every minute), the watchlist editor, Steam price history (loads by itself) and event windows (click an event to see the price change around it).
5. **Settings**: risk limits in percent, the operating mode and automation level, and advanced app settings (CONFIGURATION.md lists every value).

**Where your data lives:**

| Data | Location | How to back it up |
|---|---|---|
| Market observations, paper trades, evidence | `.orcastrike-data\orcastrike.sqlite` in the project folder | `update` backs it up automatically. Otherwise copy the folder while the app is stopped. |
| Your ledger (real trades, cash) | Your browser's storage (IndexedDB), per browser and profile | Portfolio → Backup: daily backup folder, or **Export** (checksummed JSON) |

## 7. Update

Stop the app, then:

```powershell
.\Orcastrike.cmd update       # or: npm run update   (not "npm update", which is an npm command)
```

What it does, in order. It stops at the first problem and changes nothing up to that point:

1. Refuses if the app is running (stop it first).
2. Refuses if you edited tracked files, and lists them. Keep your edits aside with `git stash` (and restore them later with `git stash pop`), or commit them.
3. Fetches the branch you're on (normally `claude/skin-arb-terminal-spec-rtocat`).
4. If there is nothing new: prints "Already up to date".
5. Refuses if your branch has its own commits. It only **fast-forwards**: no merge, rebase, reset or force.
6. Copies the database to `.orcastrike-data\backups\pre-update-<time>\` (keeps the newest 5).
7. Fast-forwards and lists the new commits.
8. Reinstalls dev tools only if `package-lock.json` changed.
9. Runs the tests. If they fail, it prints the exact commands to go back.

Database migrations run automatically the next time you start, and your browser picks up the new UI on reload.

- `--skip-tests` makes it faster.
- `--skip-install` skips the dev tools.

**ZIP folder → updatable checkout (once):**

```powershell
.\Orcastrike.cmd update --convert
```

- It turns the folder into a git checkout of `claude/skin-arb-terminal-spec-rtocat`. Choose another branch with `--branch main`.
- It leaves `.orcastrike-data\` and `node_modules\` untouched.
- It first copies every file whose content differs from the downloaded version to `.orcastrike-data\backups\pre-convert-<time>\files\`, so your edits are never lost.
- Alternatively, clone fresh (step 2) and move your `.orcastrike-data` folder into the new folder.

**Going back after an update:** the update prints the command, `git reset --keep <previous commit>`, plus the database backup to restore (copy it back while the app is stopped).

## 8. All commands

| What | Command |
|---|---|
| Start / stop / setup / update / doctor | see the table at the top |
| Run the daemon without the launcher | `npm run daemon` |
| Tests (about 10 s) | `npm test` |
| Lint | `npm run lint` (after setup) |
| Secret scan | `npm run audit:secrets` (without git it scans the files and says history was skipped) |
| Live contract test | `node scripts/contract_test.mjs` |
| Network measurement | `node scripts/netcheck.mjs` |
| Browser smoke test (needs Playwright + Chromium) | `npm run smoke:browser` (PLAN.md) |
| Regenerate CONFIGURATION.md after changing settings | `node scripts/gen-config-doc.mjs` |
| Cloudflare Worker (optional hosted fallback) | `npm run dev:worker`; deploy runbook in PLAN.md |

## 9. Troubleshooting

Start with **`.\Orcastrike.cmd doctor`** (or `npm run doctor`). It checks, and prints OK / WARN / FAIL for each:

- Node and SQLite
- npm and git
- whether this is a git checkout, and any local edits
- dev tools
- whether the data folder is writable
- the port, and whether the app is running
- whether the CSFloat key is set (never its value)
- the live-contract status
- one real request per data source (FX, Skinport, Steam, CSFloat): HTTP status, redirect target, time, parser result, and whether anything was stored. Through the running app if it's up; `--offline` skips it.

| Symptom | Fix |
|---|---|
| `'node' is not recognized` | Install Node (step 1), then open a **new** window. |
| "Node … is too old" | Install the current LTS: `winget install OpenJS.NodeJS.LTS`. |
| "Port 8790 is used by another program" | `.\Orcastrike.cmd start --port 8791`, then use the printed URL. |
| The browser didn't open | Open <http://127.0.0.1:8790/> yourself. |
| "Refreshing 0 of 54" never moves, price history stays on "Loading…", coverage 0.0% everywhere | Fixed in 2.2.1: with UMBRA on, the engine blocked the app. Update (`.\Orcastrike.cmd update`). Then Overview → Data sources → **Run diagnostics** shows, per source, what the upstream answered and whether it was stored. Markets → Price refresh details lists every item's result and reason. |
| Steam listing page "HTTP 302" / `STEAM_REDIRECT` | Steam redirected the page. Diagnostics (or `doctor`) shows the exact target. A sign-in or consent page is never followed and never worked around; the app retries with growing gaps. Steam price overview data keeps working; Steam order-book prices and history need the listing page. Try again later or from another network. |
| `AUTH_MISSING` for CSFloat | No CSFloat key is set (optional, step 4). CSFloat is then `NOT_CONFIGURED`; nothing is requested from it. |
| Everything is INSUFFICIENT, no opportunities | Expected until the data sources are verified (automatic, step 5) and the app has collected days of data. Overview says which; each row's blocked reason says exactly why. |
| Overview shows a source as "unreachable" or "format changed" | Unreachable: this network blocks it; try another network, then **Verify now**. Format changed: the upstream changed its response; update the app (step 7). |
| CSFloat says NOT_CONFIGURED after setting the key | Open a new window (environment variables apply to new processes), then `doctor`. |
| `npm.ps1 cannot be loaded … running scripts is disabled` | PowerShell's execution policy blocks npm's `.ps1` shim. Use `npm.cmd …` or `.\Orcastrike.cmd …`. |
| The daemon exits with code 2, "database … unreadable" | Its message has the recovery steps; FAILURE_STATES.md has details ("Corrupt database"). Your ledger is separate and unaffected. |
| Header says **Read-only: database problem** | The database failed its integrity check (DEGRADED). The app is read-only; see FAILURE_STATES.md. |
| `update` says "not a git checkout" | Run `update --convert` once (step 7). |
| Tests fail on an old Windows clone with CRLF files | Update (or re-clone). This version pins LF line endings. |

Anything else: run `doctor` and `npm test`, and report both outputs. Neither prints secrets.

## Safety notes

- The app **never buys, sells or lists anything**. Execution is OFF, and no mode or theme turns it on (REQUIREMENTS.md).
- Use a **dedicated trading account** that holds only the inventory being traded (PLAN.md).
- The launcher never reads, stores or prints secrets. It never force-pushes, rebases or deletes your data. Updates are fast-forward only, with a database backup first.
