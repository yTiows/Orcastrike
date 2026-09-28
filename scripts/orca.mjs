#!/usr/bin/env node
// Orcastrike launcher: one entry point for installing, running and updating. Zero dependencies
// (Node ≥ 22.13 only), same behaviour on Windows, macOS and Linux. SETUP.md explains each step.
//
//   node scripts/orca.mjs start   [--port N] [--no-open] [--no-update-check]
//   node scripts/orca.mjs stop    [--port N]
//   node scripts/orca.mjs setup   [--quick]
//   node scripts/orca.mjs update  [--skip-install] [--skip-tests] [--convert] [--branch B] [--remote URL]
//   node scripts/orca.mjs doctor  [--json]
//
// Wrappers: Orcastrike.cmd (Windows, double-click = start), orcastrike.sh, npm start / npm run …
// It never reads, stores or prints secrets: CSFLOAT_API_KEY is reported only as set / not set.
// It never force-pushes, rebases, resets or deletes anything you made: updates are fast-forward
// only, refuse to run over local edits or a running daemon, and back up the database first.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NODE = [22, 13, 0]; // first 22.x with node:sqlite unflagged
export const REPO_URL = "https://github.com/yTiows/Orcastrike.git";
export const DEFAULT_BRANCH = "claude/skin-arb-terminal-spec-rtocat";
export const DAEMON_CONTRACT = "orcastrike-daemon-api@1";
const KEEP_BACKUPS = 5;
const IS_WIN = process.platform === "win32";

// ORCASTRIKE_ROOT lets the tests drive a scratch checkout; normal use never sets it.
export const ROOT = resolve(process.env.ORCASTRIKE_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const dataDir = () => resolve(process.env.ORCASTRIKE_DATA_DIR || join(ROOT, ".orcastrike-data"));
const defaultPort = () => Number(process.env.ORCASTRIKE_PORT) || 8790;

// ---- small pure helpers (exported for tests) ---------------------------------------------

export function parseArgs(argv) {
  const out = { cmd: argv[0] && !argv[0].startsWith("-") ? argv[0] : "start", open: true, updateCheck: true, quick: false, json: false, convert: false, skipInstall: false, skipTests: false };
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const val = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--port") {
      out.port = Number(val());
      if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error("--port must be 1–65535");
    } else if (a === "--no-open") out.open = false;
    else if (a === "--no-update-check") out.updateCheck = false;
    else if (a === "--quick") out.quick = true;
    else if (a === "--json") out.json = true;
    else if (a === "--convert") out.convert = true;
    else if (a === "--skip-install") out.skipInstall = true;
    else if (a === "--skip-tests") out.skipTests = true;
    else if (a === "--branch") out.branch = val();
    else if (a === "--remote") out.remote = val();
    else if (a === "--help" || a === "-h") out.cmd = "help";
    else throw new Error(`unknown option ${a}`);
  }
  if (!["start", "stop", "setup", "update", "doctor", "help"].includes(out.cmd)) throw new Error(`unknown command ${out.cmd}`);
  return out;
}

export function versionAtLeast(version, min = MIN_NODE) {
  const v = String(version).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((v[i] ?? 0) > min[i]) return true;
    if ((v[i] ?? 0) < min[i]) return false;
  }
  return true;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const lockHash = (root) => sha256(readFileSync(join(root, "package-lock.json"), "utf8").replace(/\r\n/g, "\n"));
const stampPath = (root) => join(root, "node_modules", ".orcastrike-install.json");

// Dev tools (ESLint, Wrangler) are installed only when package-lock.json changed since the last
// install. The daemon and the tests need none of them.
export function installState(root = ROOT) {
  if (!existsSync(join(root, "node_modules"))) return { needed: true, reason: "node_modules missing" };
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath(root), "utf8"));
  } catch {
    return { needed: true, reason: "no install record" };
  }
  if (stamp.lock_sha256 !== lockHash(root)) return { needed: true, reason: "package-lock.json changed" };
  if (stamp.node_major !== Number(process.versions.node.split(".")[0])) return { needed: true, reason: "Node major version changed" };
  return { needed: false, reason: "up to date" };
}

export function writeInstallStamp(root = ROOT) {
  writeFileSync(stampPath(root), `${JSON.stringify({ lock_sha256: lockHash(root), node_major: Number(process.versions.node.split(".")[0]), at: new Date().toISOString() }, null, 2)}\n`);
}

// Copies the database (plus WAL/SHM) to <data>/backups/<label>-<timestamp>/ and keeps the newest
// KEEP_BACKUPS of that label. Only call it while the daemon is stopped.
export function backupDatabase(dir, label = "pre-update", now = new Date()) {
  const db = join(dir, "orcastrike.sqlite");
  if (!existsSync(db)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, "backups", `${label}-${stamp}`);
  mkdirSync(dest, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(db + suffix)) cpSync(db + suffix, join(dest, `orcastrike.sqlite${suffix}`));
  const mine = readdirSync(join(dir, "backups"))
    .filter((n) => n.startsWith(`${label}-`))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) rmSync(join(dir, "backups", old), { recursive: true, force: true });
  return dest;
}

// ---- process / system helpers ------------------------------------------------------------

function run(cmd, args, opts = {}) {
  // npm is a .cmd shim on Windows, which Node only launches through a shell. Arguments here are
  // fixed strings from this file, never user input.
  const shell = IS_WIN && cmd === "npm";
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell, ...opts });
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function has(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", shell: IS_WIN && cmd === "npm", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function isGitCheckout() {
  if (!existsSync(join(ROOT, ".git"))) return false;
  try {
    return git(["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

export async function daemonHealth(port = defaultPort(), timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v2/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const h = await r.json();
    return h?.contract === DAEMON_CONTRACT ? h : null;
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

function openBrowser(url) {
  const [cmd, args] = IS_WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const c = spawn(cmd, args, { detached: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
  } catch {
    /* no browser launcher; the URL is printed anyway */
  }
}

const say = (msg = "") => console.log(msg);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exitCode = 1;
};

function requireNode() {
  if (versionAtLeast(process.versions.node)) return true;
  fail(`Node ${process.versions.node} is too old: ${MIN_NODE.join(".")} or newer is required (built-in SQLite).\n  Windows: winget install OpenJS.NodeJS.LTS   macOS: brew install node   or https://nodejs.org (LTS)`);
  return false;
}

function contractSummary() {
  try {
    const r = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "live", "CONTRACT_REPORT.json"), "utf8"));
    const counts = r.results.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
    return { run_at: r.run_at, counts, verified: (counts.PASS ?? 0) > 0 };
  } catch {
    return null;
  }
}

function runTests() {
  say("\n→ Running the test suite (about 10 s)…");
  const r = run(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=spec", "tests/*.test.js"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const counts = [...out.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)].map((m) => `${m[2]} ${m[1]}`).join(", ");
  if (r.status === 0) {
    say(`✔ Tests passed (${counts})`);
    return true;
  }
  const i = out.indexOf("✖ failing tests:");
  say(i >= 0 ? out.slice(i) : out.split("\n").slice(-80).join("\n"));
  return false;
}

function installDevTools({ force = false } = {}) {
  const st = installState();
  if (!force && !st.needed) {
    say(`✔ Dev tools up to date (${st.reason})`);
    return true;
  }
  if (!has("npm")) {
    say("! npm not found: skipping dev tools (ESLint, Wrangler). The app itself doesn't need them.");
    return true;
  }
  say(`→ Installing dev tools with npm ci (${st.reason})…`);
  const r = run("npm", ["ci", "--no-audit", "--no-fund"]);
  if (r.status !== 0) {
    fail("npm ci failed (see above). The app still runs without dev tools: npm start.");
    return false;
  }
  writeInstallStamp();
  return true;
}

// ---- commands ------------------------------------------------------------------------------

export async function doctor({ json = false } = {}) {
  const rows = [];
  const add = (status, check, detail) => rows.push({ status, check, detail });
  add(versionAtLeast(process.versions.node) ? "OK" : "FAIL", "Node.js", `${process.versions.node} (needs ≥ ${MIN_NODE.join(".")})`);
  const sqlite = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", "require('node:sqlite')"], { encoding: "utf8" });
  add(sqlite.status === 0 ? "OK" : "FAIL", "Built-in SQLite", sqlite.status === 0 ? "node:sqlite loads" : "node:sqlite unavailable; upgrade Node");
  const npm = has("npm");
  add(npm ? "OK" : "WARN", "npm", npm ?? "not found (only needed for dev tools: lint, Worker)");
  const gitV = has("git");
  add(gitV ? "OK" : "WARN", "git", gitV ?? "not found (needed for updates: https://git-scm.com)");
  if (isGitCheckout()) {
    let upstream = "none";
    try {
      upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      /* no upstream */
    }
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
    add(dirty ? "WARN" : "OK", "Checkout", `git ${git(["rev-parse", "--abbrev-ref", "HEAD"])} @ ${git(["rev-parse", "--short", "HEAD"])} (upstream ${upstream})${dirty ? "; local edits to tracked files: updates will refuse until you commit or stash them" : ""}`);
  } else add("WARN", "Checkout", "not a git checkout (ZIP download): `update --convert` turns it into one so updates work");
  const inst = existsSync(join(ROOT, "package-lock.json")) ? installState() : { needed: true, reason: "no package-lock.json" };
  add(inst.needed ? "INFO" : "OK", "Dev tools", inst.needed ? `not installed/stale (${inst.reason}); run setup. The app runs without them.` : "installed");
  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    const db = join(dir, "orcastrike.sqlite");
    add("OK", "Data directory", `${dir}${existsSync(db) ? ` (database ${(statSync(db).size / 1048576).toFixed(1)} MB)` : " (no database yet)"}`);
  } catch (err) {
    add("FAIL", "Data directory", `${dir} not writable (${err.code ?? err.message})`);
  }
  const port = defaultPort();
  const h = await daemonHealth(port);
  if (h) add("OK", "Daemon", `running on http://127.0.0.1:${port}/ (database ${h.db?.integrity ?? "?"}${h.db?.degraded ? ", DEGRADED" : ""})`);
  else if (await portFree(port)) add("OK", "Port", `${port} free (daemon not running)`);
  else add("FAIL", "Port", `${port} is used by another program: start with --port 8791`);
  add((process.env.CSFLOAT_API_KEY ?? "").trim() ? "OK" : "INFO", "CSFLOAT_API_KEY", (process.env.CSFLOAT_API_KEY ?? "").trim() ? "set (value not shown)" : "not set: CSFloat reports NOT_CONFIGURED (optional; SETUP.md step 4)");
  const c = contractSummary();
  add(c?.verified ? "OK" : "WARN", "Live data contract", c ? `last run ${c.run_at}: ${Object.entries(c.counts).map(([k, v]) => `${v} ${k}`).join(", ")}${c.verified ? "" : ". No parser is VERIFIED yet, so no opportunity can be ELIGIBLE: run `node scripts/contract_test.mjs`"}` : "never run: `node scripts/contract_test.mjs`");
  if (json) say(JSON.stringify(rows, null, 2));
  else {
    say("Orcastrike doctor\n");
    for (const r of rows) say(`${r.status.padEnd(5)} ${r.check.padEnd(20)} ${r.detail}`);
  }
  if (rows.some((r) => r.status === "FAIL")) process.exitCode = 1;
  return rows;
}

async function waitForHealth(port, child, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) return null;
    const h = await daemonHealth(port, 800);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function updateCheck() {
  if (!isGitCheckout()) return;
  let remote = "origin";
  let branch;
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    remote = up.split("/")[0];
    branch = up.slice(remote.length + 1);
  } catch {
    /* no upstream: origin + current branch */
  }
  if (!branch || branch === "HEAD") return;
  const c = spawn("git", ["ls-remote", "--heads", remote, branch], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  const timer = setTimeout(() => c.kill(), 8000);
  c.on("error", () => {});
  c.on("close", () => {
    clearTimeout(timer);
    const remoteSha = out.split(/\s+/)[0];
    if (!remoteSha) return;
    let head;
    try {
      head = git(["rev-parse", "HEAD"]);
    } catch {
      return;
    }
    if (remoteSha !== head) say(`\nℹ Update available on ${remote}/${branch}. Stop the app (Ctrl+C), then run: npm run update  (or Orcastrike.cmd update)\n`);
  });
  c.unref();
  c.stdout.unref?.();
}

export async function start(opts) {
  if (!requireNode()) return;
  const port = opts.port ?? defaultPort();
  const url = `http://127.0.0.1:${port}/`;
  if (await daemonHealth(port)) {
    say(`✔ Orcastrike is already running: ${url}`);
    if (opts.open) openBrowser(url);
    return;
  }
  if (!(await portFree(port))) {
    fail(`Port ${port} is used by another program. Start on another port: npm start -- --port 8791  (or Orcastrike.cmd start --port 8791)`);
    return;
  }
  say(`→ Starting Orcastrike on ${url} (data: ${dataDir()})`);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "daemon", "main.js")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ORCASTRIKE_PORT: String(port) },
  });
  // Ctrl+C reaches the daemon directly (same console); this process just waits for it to exit.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const exited = new Promise((res) => child.on("exit", (code) => res(code ?? 0)));
  const h = await waitForHealth(port, child);
  if (h) {
    const c = contractSummary();
    say(`\n✔ Orcastrike is running: ${url}`);
    say(`  CSFloat: ${h.sources?.csfloat ?? "?"} · live data contract: ${c?.verified ? "VERIFIED parsers present" : "not verified yet (no opportunity can be ELIGIBLE; see SETUP.md step 5)"}`);
    say("  Stop: Ctrl+C in this window, or `npm run stop` from another one.\n");
    if (opts.open) openBrowser(url);
    if (opts.updateCheck) updateCheck();
  } else if (child.exitCode === null) say("! The daemon hasn't answered yet; it keeps starting in this window.");
  const code = await exited;
  if (code !== 0) fail(`The daemon exited with code ${code} (message above). \`npm run doctor\` checks the usual causes.`);
}

export async function stop(opts) {
  const port = opts.port ?? defaultPort();
  if (!(await daemonHealth(port))) {
    say(`Orcastrike isn't running on port ${port}.`);
    return;
  }
  const origin = `http://127.0.0.1:${port}`;
  const r = await fetch(`${origin}/api/v2/shutdown`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ confirm: true }) }).catch(() => null);
  if (!r?.ok) {
    fail(`The daemon refused to stop (HTTP ${r?.status ?? "no response"}). Press Ctrl+C in its window instead.`);
    return;
  }
  for (let i = 0; i < 50; i += 1) {
    await new Promise((res) => setTimeout(res, 200));
    if (!(await daemonHealth(port, 500))) {
      say("✔ Orcastrike stopped.");
      return;
    }
  }
  fail("The daemon accepted the stop request but is still answering. Press Ctrl+C in its window.");
}

export async function setup(opts) {
  say("Orcastrike setup\n");
  if (!requireNode()) return;
  mkdirSync(dataDir(), { recursive: true });
  say(`✔ Node ${process.versions.node}, data directory ${dataDir()}`);
  if (!installDevTools()) return;
  if (!opts.quick && !runTests()) {
    fail("Some tests failed (output above). Please report it with the output of `npm run doctor`.");
    return;
  }
  say("\nReady. Start with:  npm start   (Windows: double-click Orcastrike.cmd)");
  const c = contractSummary();
  if (!c?.verified) say("Next, once per machine with normal internet access:  node scripts/contract_test.mjs   (SETUP.md step 5)");
}

function convertToGit(opts) {
  const remote = opts.remote ?? REPO_URL;
  const branch = opts.branch ?? DEFAULT_BRANCH;
  say(`→ Turning this folder into a git checkout of ${remote} (${branch}). Your data directory and node_modules are not touched.`);
  git(["init", "-q"]);
  git(["remote", "add", "origin", remote]);
  git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { stdio: ["ignore", "pipe", "inherit"] });
  // Files that differ from the fetched version are either older (the ZIP predates it) or your
  // own edits; git can't tell which, so every differing file is copied aside first.
  git(["read-tree", `origin/${branch}`]);
  const differing = git(["diff", "--name-only"]).split("\n").filter(Boolean);
  if (differing.length) {
    const dest = join(dataDir(), "backups", `pre-convert-${new Date().toISOString().replace(/[:.]/g, "-")}`, "files");
    for (const f of differing) {
      if (!existsSync(join(ROOT, f))) continue;
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      cpSync(join(ROOT, f), join(dest, f));
    }
    say(`  ${differing.length} file(s) differ from ${branch}; copies of your versions: ${dest}`);
  }
  git(["checkout", "-q", "-f", "-B", branch, `origin/${branch}`]);
  git(["branch", "-q", "--set-upstream-to", `origin/${branch}`]);
  say(`✔ Now a git checkout of ${branch} @ ${git(["rev-parse", "--short", "HEAD"])}`);
}

export async function update(opts) {
  if (!requireNode()) return;
  if (!has("git")) {
    fail("git is required for updates: https://git-scm.com/download (Windows: winget install Git.Git), then run this again.");
    return;
  }
  if (await daemonHealth(defaultPort())) {
    fail("Orcastrike is running. Stop it first (Ctrl+C in its window, or `npm run stop`), then run the update again.");
    return;
  }
  if (!isGitCheckout()) {
    if (!opts.convert) {
      fail(
        "This folder isn't a git checkout (it looks like a ZIP download), so it can't update itself yet.\n" +
          "  Run once:  node scripts/orca.mjs update --convert   (keeps .orcastrike-data and node_modules; copies any file that differs aside first)\n" +
          `  or clone:  git clone -b ${DEFAULT_BRANCH} ${REPO_URL}  and move your .orcastrike-data folder into it.`,
      );
      return;
    }
    const backup = backupDatabase(dataDir(), "pre-update");
    if (backup) say(`✔ Database backed up: ${backup}`);
    convertToGit(opts);
    if (!opts.skipInstall && !installDevTools()) return;
    if (!opts.skipTests && !runTests()) fail("Tests failed after the update (output above).");
    else say("\n✔ Up to date. Start with: npm start");
    return;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    fail(`You have local edits to tracked files; the update won't overwrite them:\n${dirty.replace(/^/gm, "    ")}\n  Keep them aside with \`git stash\` (restore later with \`git stash pop\`), then update again.`);
    return;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    fail("Not on a branch (detached HEAD). `git checkout <branch>` first.");
    return;
  }
  let remote = "origin";
  let remoteBranch = branch;
  try {
    const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    remote = up.split("/")[0];
    remoteBranch = up.slice(remote.length + 1);
  } catch {
    /* no upstream configured: origin/<same name> */
  }
  const before = git(["rev-parse", "HEAD"]);
  say(`→ Fetching ${remote}/${remoteBranch}…`);
  try {
    git(["fetch", "--quiet", remote, `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`], { stdio: ["ignore", "pipe", "inherit"] });
  } catch {
    fail("Couldn't reach the repository (offline, or no access). Nothing was changed.");
    return;
  }
  const target = `${remote}/${remoteBranch}`;
  const incoming = Number(git(["rev-list", "--count", `HEAD..${target}`]));
  if (incoming === 0) {
    say(`✔ Already up to date (${git(["rev-parse", "--short", "HEAD"])}).`);
    if (!opts.skipInstall) installDevTools();
    return;
  }
  try {
    git(["merge-base", "--is-ancestor", "HEAD", target]);
  } catch {
    fail(`Your branch has commits that ${target} doesn't. The update only fast-forwards and won't touch them; merge or rebase yourself.`);
    return;
  }
  const backup = backupDatabase(dataDir(), "pre-update");
  if (backup) say(`✔ Database backed up: ${backup}`);
  git(["merge", "--ff-only", "--quiet", target]);
  say(`✔ Updated ${before.slice(0, 7)} → ${git(["rev-parse", "--short", "HEAD"])} (${incoming} new commit${incoming === 1 ? "" : "s"}):`);
  say(git(["log", "--oneline", "--no-decorate", "-n", "15", `${before}..HEAD`]).replace(/^/gm, "    "));
  if (!opts.skipInstall && !installDevTools()) return;
  if (!opts.skipTests && !runTests()) {
    fail(`Tests failed after the update. To go back: git reset --keep ${before.slice(0, 12)}${backup ? `  and restore the database from ${backup}` : ""}`);
    return;
  }
  say("\n✔ Done. Start with: npm start   (database migrations run automatically on start)");
}

function help() {
  say(`Orcastrike launcher (details: SETUP.md)

  start   Start the app and open it in your browser (default command)
            --port N  --no-open  --no-update-check
  stop    Stop a running app
  setup   Check prerequisites, install dev tools if needed, run the tests   [--quick: skip tests]
  update  Fetch and apply the latest version (fast-forward only, database backed up first)
            --skip-install  --skip-tests  --convert (ZIP folder → git)  --branch B  --remote URL
  doctor  Diagnose the installation   [--json]

  Windows: Orcastrike.cmd [command]   macOS/Linux: ./orcastrike.sh [command]   npm: npm start | npm run <command>`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(`${err.message}. Run with --help.`);
    process.exit(1);
  }
  const cmds = { start, stop, setup, update, doctor, help };
  try {
    await cmds[opts.cmd](opts);
  } catch (err) {
    fail(err?.message ?? String(err));
  }
}
