// Launcher (scripts/orca.mjs): argument parsing, install stamps, database backups, start/stop,
// and the update flows. Update tests run against a throwaway local git remote, so they need no
// network and don't depend on how this repository itself was checked out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDatabase, installState, parseArgs, versionAtLeast, writeInstallStamp } from "../scripts/orca.mjs";
import { freePort } from "./helpers/synthetic-stack.js";

const ORCA = fileURLToPath(new URL("../scripts/orca.mjs", import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();

function orca(args, env) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ORCA, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60000 });
}

test("arguments: default command is start; options are validated", () => {
  assert.deepEqual(parseArgs([]).cmd, "start");
  const o = parseArgs(["start", "--port", "8791", "--no-open", "--no-update-check"]);
  assert.deepEqual([o.cmd, o.port, o.open, o.updateCheck], ["start", 8791, false, false]);
  assert.equal(parseArgs(["update", "--convert", "--branch", "main"]).branch, "main");
  assert.throws(() => parseArgs(["start", "--port", "99999"]), /1–65535/);
  assert.throws(() => parseArgs(["launch"]), /unknown command/);
  assert.throws(() => parseArgs(["update", "--branch"]), /needs a value/);
});

test("Node version gate: 22.13+ (built-in SQLite unflagged)", () => {
  assert.equal(versionAtLeast("22.13.0"), true);
  assert.equal(versionAtLeast("v24.1.0"), true);
  assert.equal(versionAtLeast("22.12.9"), false);
  assert.equal(versionAtLeast("20.18.0"), false);
});

test("dev tools reinstall only when package-lock.json changes", () => {
  const root = mkdtempSync(join(tmpdir(), "orca-inst-"));
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.equal(installState(root).needed, true);
  mkdirSync(join(root, "node_modules"));
  assert.match(installState(root).reason, /no install record/);
  writeInstallStamp(root);
  assert.equal(installState(root).needed, false);
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\r\n');
  assert.equal(installState(root).needed, false, "CRLF-only difference is not a change");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
  assert.match(installState(root).reason, /changed/);
});

test("database backup copies the file with WAL/SHM and keeps the newest five", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-bk-"));
  assert.equal(backupDatabase(dir), null, "nothing to back up");
  writeFileSync(join(dir, "orcastrike.sqlite"), "db");
  writeFileSync(join(dir, "orcastrike.sqlite-wal"), "wal");
  let last;
  for (let i = 0; i < 7; i += 1) last = backupDatabase(dir, "pre-update", new Date(Date.UTC(2026, 8, 28, 0, 0, i)));
  assert.equal(readFileSync(join(last, "orcastrike.sqlite"), "utf8"), "db");
  assert.equal(readFileSync(join(last, "orcastrike.sqlite-wal"), "utf8"), "wal");
  const kept = readdirSync(join(dir, "backups"));
  assert.equal(kept.length, 5);
  assert.ok(!kept.some((k) => k.includes("00-00-00-000Z")), "oldest pruned");
});

test("start → running → stop: one command each, clean exit on every platform", async () => {
  const port = await freePort();
  const env = { ORCASTRIKE_DATA_DIR: mkdtempSync(join(tmpdir(), "orca-start-")) };
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ORCA, "start", "--port", String(port), "--no-open", "--no-update-check"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  try {
    for (let i = 0; i < 100 && !/is running/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Orcastrike is running: http:\/\/127\.0\.0\.1:\d+\//);
    const again = orca(["start", "--port", String(port), "--no-open"], env);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already running/);
    const stop = orca(["stop", "--port", String(port)], env);
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    assert.match(stop.stdout, /stopped/);
    assert.equal(await exited, 0, out);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

// A remote with branch main, a working clone of it, and a second clone to publish new commits.
function scratchRepos() {
  const base = mkdtempSync(join(tmpdir(), "orca-upd-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const seed = join(base, "seed");
  git(base, "init", "-q", seed);
  git(seed, "checkout", "-q", "-b", "main");
  // Same line-ending rule as the real repository, so Windows' core.autocrlf=true doesn't apply.
  writeFileSync(join(seed, ".gitattributes"), "* text=auto eol=lf\n");
  writeFileSync(join(seed, "package-lock.json"), "{}\n");
  writeFileSync(join(seed, "app.txt"), "v1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "v1");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  const work = join(base, "work");
  git(base, "clone", "-q", remote, work);
  const publish = (file, content, msg) => {
    writeFileSync(join(seed, file), content);
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", msg);
    git(seed, "push", "-q", "origin", "main");
  };
  return { base, remote, work, publish };
}

test("update: fast-forwards, backs up the database first, then reports up to date", async () => {
  const { work, publish } = scratchRepos();
  const data = join(work, ".orcastrike-data");
  mkdirSync(data);
  writeFileSync(join(data, "orcastrike.sqlite"), "db-before-update");
  publish("app.txt", "v2\n", "v2");
  const env = { ORCASTRIKE_ROOT: work, ORCASTRIKE_DATA_DIR: data, ORCASTRIKE_PORT: String(await freePort()) };
  const r = orca(["update", "--skip-install", "--skip-tests"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Updated [0-9a-f]{7} → [0-9a-f]{7} \(1 new commit\)/);
  assert.equal(readFileSync(join(work, "app.txt"), "utf8"), "v2\n");
  const [bk] = readdirSync(join(data, "backups"));
  assert.equal(readFileSync(join(data, "backups", bk, "orcastrike.sqlite"), "utf8"), "db-before-update");
  const again = orca(["update", "--skip-install", "--skip-tests"], env);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Already up to date/);
});

test("update refuses: local edits, diverged history, or a running daemon; nothing is changed", async () => {
  const { work, publish } = scratchRepos();
  const env = { ORCASTRIKE_ROOT: work, ORCASTRIKE_DATA_DIR: join(work, ".orcastrike-data"), ORCASTRIKE_PORT: String(await freePort()) };
  publish("app.txt", "v2\n", "v2");

  writeFileSync(join(work, "app.txt"), "my edit\n");
  const dirty = orca(["update", "--skip-install", "--skip-tests"], env);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /local edits.*git stash/s);
  assert.equal(readFileSync(join(work, "app.txt"), "utf8"), "my edit\n");
  git(work, "checkout", "--", "app.txt");

  writeFileSync(join(work, "mine.txt"), "local commit\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "local");
  const head = git(work, "rev-parse", "HEAD");
  const diverged = orca(["update", "--skip-install", "--skip-tests"], env);
  assert.equal(diverged.status, 1);
  assert.match(diverged.stderr, /only fast-forwards/);
  assert.equal(git(work, "rev-parse", "HEAD"), head);

  const fake = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ contract: "orcastrike-daemon-api@1" }));
  });
  await new Promise((r) => fake.listen(Number(env.ORCASTRIKE_PORT), "127.0.0.1", r));
  try {
    const running = await new Promise((resolve) => {
      const c = spawn(process.execPath, [ORCA, "update", "--skip-install", "--skip-tests"], { env: { ...process.env, ...env } });
      let err = "";
      c.stderr.on("data", (d) => (err += d));
      c.on("exit", (code) => resolve({ code, err }));
    });
    assert.equal(running.code, 1);
    assert.match(running.err, /is running\. Stop it first/);
  } finally {
    fake.close();
  }
});

test("update --convert: a ZIP-style folder becomes a git checkout; data kept, differing files copied aside", async () => {
  const { base, remote, work } = scratchRepos();
  // A ZIP download is the same files without .git: copy the tree, then edit one file.
  const zip = join(base, "zip");
  mkdirSync(zip);
  for (const f of [".gitattributes", "package-lock.json", "app.txt"]) writeFileSync(join(zip, f), readFileSync(join(work, f)));
  writeFileSync(join(zip, "app.txt"), "edited in the zip folder\n");
  mkdirSync(join(zip, ".orcastrike-data"));
  writeFileSync(join(zip, ".orcastrike-data", "keep.txt"), "mine");
  const env = { ORCASTRIKE_ROOT: zip, ORCASTRIKE_DATA_DIR: join(zip, ".orcastrike-data"), ORCASTRIKE_PORT: String(await freePort()) };

  const refused = orca(["update", "--skip-install", "--skip-tests"], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /isn't a git checkout.*--convert/s);
  assert.ok(!existsSync(join(zip, ".git")));

  const r = orca(["update", "--convert", "--remote", remote, "--branch", "main", "--skip-install", "--skip-tests"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(git(zip, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(zip, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), "origin/main");
  assert.equal(readFileSync(join(zip, "app.txt"), "utf8"), "v1\n");
  assert.equal(readFileSync(join(zip, ".orcastrike-data", "keep.txt"), "utf8"), "mine");
  const [conv] = readdirSync(join(zip, ".orcastrike-data", "backups")).filter((d) => d.startsWith("pre-convert-"));
  assert.equal(readFileSync(join(zip, ".orcastrike-data", "backups", conv, "files", "app.txt"), "utf8"), "edited in the zip folder\n");
  assert.equal(git(zip, "status", "--porcelain", "--untracked-files=no"), "");
});

test("doctor reports every check as data, never a secret value", () => {
  // --offline: the test key must never reach a marketplace, and tests make no live requests.
  const r = orca(["doctor", "--json", "--offline"], { CSFLOAT_API_KEY: "TEST_ONLY_doctor_key_123456", ORCASTRIKE_DATA_DIR: mkdtempSync(join(tmpdir(), "orca-doc-")), ORCASTRIKE_PORT: "1" });
  const rows = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
  const by = Object.fromEntries(rows.map((x) => [x.check, x]));
  assert.equal(by["Live data sources"].detail, "not checked (--offline)");
  assert.equal(by["Node.js"].status, "OK");
  assert.equal(by["Built-in SQLite"].status, "OK");
  assert.equal(by.CSFLOAT_API_KEY.detail, "set (value not shown)");
  assert.ok(!r.stdout.includes("TEST_ONLY_doctor_key_123456"));
});
