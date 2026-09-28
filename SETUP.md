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

Your browser opens <http://127.0.0.1:8790/>. That's it. The steps below explain each part, the optional extras (CSFloat key, live verification), updating and troubleshooting.

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

## 5. Verify the live data sources (once per machine, needs internet)

Until a parser has passed against a **live** response, the system treats its data as unverified, and **no opportunity can become ELIGIBLE**. This is deliberate (DECISIONS.md D-38). To verify, run from the project folder:

```powershell
node scripts/contract_test.mjs      # picks up CSFLOAT_API_KEY from the environment if set
```

- It calls each source once, well within rate limits.
- It stores **sanitized** responses under `tests\fixtures\live\` (seller identities and credential-like fields removed).
- It writes `tests\fixtures\live\CONTRACT_REPORT.json`, with PASS, FAIL or BLOCKED per endpoint.
- Exit code: `0` all PASS, `1` a FAIL (an upstream format changed; the report shows the field-level diff), `2` something BLOCKED or UNVERIFIED (unreachable, or no key for CSFloat).
- Restart the app afterwards. `doctor` and the start banner show the new state.

Optionally, `node scripts/netcheck.mjs` measures reachability and latency per source from this machine. It writes a report to `reports\netcheck\`.

If you commit the new fixtures to share them, look through them first. They are sanitized, but they are real responses.

## 6. Run it

**Windows:** double-click `Orcastrike.cmd`, or pin a shortcut to it. From a terminal: `.\Orcastrike.cmd` or `npm start`.

A console window shows the app's log, and your browser opens <http://127.0.0.1:8790/>:

```
✔ Orcastrike is running: http://127.0.0.1:8790/
  CSFloat: NOT_CONFIGURED · live data contract: not verified yet (…)
  Stop: Ctrl+C in this window, or `npm run stop` from another one.
```

- **Stop it:** press Ctrl+C in that window (Windows asks "Terminate batch job (Y/N)?"; answer Y), or run `.\Orcastrike.cmd stop` or `npm run stop` from another window.
- **Start options:** `--port 8791` (if 8790 is taken; the URL changes to match), `--no-open` (don't open a browser), `--no-update-check`.
  - Examples: `.\Orcastrike.cmd start --port 8791` or `npm start -- --port 8791`.
- **Already running?** Starting again just opens the browser on the running instance.
- **Update notice:** on start, a git checkout checks in the background whether a newer version exists and prints a one-line notice. It never updates by itself.
- **Security:** the app listens on 127.0.0.1 only, never on your network. If Windows asks whether Node.js may use the network, you can decline.

**First time in the UI:**

1. Open the page once. The browser sends your watchlist (by default the starter list; edit it in the **Scanner** tab) to the app, which then keeps sampling it even with the browser closed.
2. **Research** shows the evidence ladder, every evaluated pair with its blocked reason and full calculation trace, paper vs real trades, data quality and coverage. Expect **no opportunities at first**. Rankings need at least 7 days of the app's own observations, and evidence gates need 14 days and 30 closed paper trades (EVIDENCE.md).
3. **Ledger:** after you trade elsewhere, record your cash, buys and sells here. The app never trades. In Chromium, choose a daily backup folder (Ledger → Backup), or use **Export** regularly.
4. **Settings:** risk limits, and the app's research settings (CONFIGURATION.md lists every value).

**Where your data lives:**

| Data | Location | How to back it up |
|---|---|---|
| Market observations, paper trades, evidence | `.orcastrike-data\orcastrike.sqlite` in the project folder | `update` backs it up automatically. Otherwise copy the folder while the app is stopped. |
| Your ledger (real trades, cash) | Your browser's storage (IndexedDB), per browser and profile | Ledger → daily backup folder, or **Export** (checksummed JSON) |

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

| Symptom | Fix |
|---|---|
| `'node' is not recognized` | Install Node (step 1), then open a **new** window. |
| "Node … is too old" | Install the current LTS: `winget install OpenJS.NodeJS.LTS`. |
| "Port 8790 is used by another program" | `.\Orcastrike.cmd start --port 8791`, then use the printed URL. |
| The browser didn't open | Open <http://127.0.0.1:8790/> yourself. |
| Everything is INSUFFICIENT, no opportunities | Expected until the live contract passes (step 5) and the app has collected days of data. Each row's blocked reason says exactly why. |
| CSFloat says NOT_CONFIGURED after setting the key | Open a new window (environment variables apply to new processes), then `doctor`. |
| `npm.ps1 cannot be loaded … running scripts is disabled` | PowerShell's execution policy blocks npm's `.ps1` shim. Use `npm.cmd …` or `.\Orcastrike.cmd …`. |
| The daemon exits with code 2, "database … unreadable" | Its message has the recovery steps; FAILURE_STATES.md has details ("Corrupt database"). Your ledger is separate and unaffected. |
| Status bar says **DEGRADED** | The database failed its integrity check. The app is read-only; see FAILURE_STATES.md. |
| `update` says "not a git checkout" | Run `update --convert` once (step 7). |
| Tests fail on an old Windows clone with CRLF files | Update (or re-clone). This version pins LF line endings. |

Anything else: run `doctor` and `npm test`, and report both outputs. Neither prints secrets.

## Safety notes

- The app **never buys, sells or lists anything**. Execution is OFF, and no mode or theme turns it on (REQUIREMENTS.md).
- Use a **dedicated trading account** that holds only the inventory being traded (PLAN.md).
- The launcher never reads, stores or prints secrets. It never force-pushes, rebases or deletes your data. Updates are fast-forward only, with a database backup first.
