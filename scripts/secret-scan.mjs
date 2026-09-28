// Pre-deploy security audit (P0-9). Exits non-zero on any finding.
// 1. No .env-style files tracked.   2. Credential-shaped strings absent from tracked files
// AND full git history.   3. .env.example has no values.   4. Shipped client files carry no
// auth/cookie handling or key names.   5. Worker never logs.   6. wrangler.toml has no secrets.
// 7. Literal values of any credentials present in this shell's env are absent everywhere.
// 8. P0-8 wording: no "expected margin/return" phrasing in shipped files.
//
// Without git (a ZIP download, or git not installed) the working tree is scanned instead of the
// tracked files, honouring .gitignore, and the history check is reported as SKIPPED.
// ORCASTRIKE_SCAN_NO_GIT=1 forces that mode (used by the tests).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
const findings = [];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const lines = (text) => text.split(/\r?\n/);

function isGitCheckout() {
  if (process.env.ORCASTRIKE_SCAN_NO_GIT === "1") return false;
  try {
    return git("rev-parse", "--is-inside-work-tree").trim() === "true";
  } catch {
    return false;
  }
}

// Minimal .gitignore matcher: comments, negation, trailing-slash directories, * and **.
function ignoreMatcher(text) {
  const rules = lines(text)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const negate = l.startsWith("!");
      let pat = negate ? l.slice(1) : l;
      const dirOnly = pat.endsWith("/");
      pat = pat.replace(/\/$/, "");
      const anchored = pat.includes("/");
      const body = pat.replace(/^\//, "").split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*");
      const re = new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dirOnly ? "(/|$)" : "$"}`);
      return { negate, re, dirOnly };
    });
  return (path, isDir) => {
    let ignored = false;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}

function workingTreeFiles() {
  const ignored = ignoreMatcher(readFileSync(".gitignore", "utf8"));
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir || ".", { withFileTypes: true })) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.name === ".git" || ignored(rel, d.isDirectory())) continue;
      if (d.isDirectory()) walk(rel);
      else if (d.isFile()) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

const IS_GIT = isGitCheckout();

const PATTERNS = [
  ["generic credential assignment", /(?:api[_-]?key|secret|token|passw(?:or)?d|authorization)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["sk- style API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Cloudflare API token assignment", /CLOUDFLARE_API_TOKEN\s*=\s*\S{20,}/],
  ["CSFloat key assignment", /CSFLOAT_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{12,}/],
];
// Explicitly fake test fixtures carry the TEST_ONLY marker. The second literal is the fake
// fixture used in commit bfeb469 before the marker convention existed; it was never a key.
const ALLOW = /TEST_ONLY|csf_TEST_KEY_do_not_leak_9f8e7d/;

function scanText(label, text) {
  lines(text).forEach((line, i) => {
    if (ALLOW.test(line)) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) findings.push(`${label}:${i + 1}: ${name}`);
  });
}

// 1 + 2: tracked files (or, without git, every non-ignored file in the working tree)
const tracked = IS_GIT ? lines(git("ls-files")).filter(Boolean) : workingTreeFiles();
for (const f of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(f) && f !== ".env.example") findings.push(`${f}: env file is tracked`);
  if (/(^|\/)\.dev\.vars$/.test(f)) findings.push(`${f}: .dev.vars is tracked`);
  if (f === "package-lock.json") continue; // integrity hashes are not credentials
  scanText(f, readFileSync(f, "utf8"));
}

// 2: full history (added lines only)
const history = IS_GIT ? git("log", "-p", "--all", "--no-color", "--unified=0") : "";
let current = "history";
for (const line of lines(history)) {
  if (line.startsWith("+++ b/")) current = `history:${line.slice(6)}`;
  else if (line.startsWith("+") && !line.startsWith("+++") && !current.endsWith("package-lock.json")) scanText(current, line.slice(1));
}

// 3: .env.example values empty
for (const [i, line] of lines(readFileSync(".env.example", "utf8")).entries()) {
  const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
  if (m && m[2].trim() !== "") findings.push(`.env.example:${i + 1}: ${m[1]} has a value`);
}
if (!lines(readFileSync(".gitignore", "utf8")).map((l) => l.trim()).includes(".env")) findings.push(".gitignore does not ignore .env");

// 4 + 8: shipped client files
const shipped = tracked.filter((f) => /^(index\.html|styles\.css|_headers|js\/|ui\/|config\/|static\/)/.test(f));
for (const f of shipped) {
  const text = readFileSync(f, "utf8");
  if (/CSFLOAT_API_KEY|CLOUDFLARE_API_TOKEN/.test(text)) findings.push(`${f}: client file references a server-side credential name`);
  if (/['"]authorization['"]\s*:/i.test(text) || /setRequestHeader\(\s*['"]authorization/i.test(text)) findings.push(`${f}: client sets an Authorization header`);
  if (/document\.cookie|credentials:\s*["']include["']/.test(text)) findings.push(`${f}: client touches cookies/credentials`);
  if (/expected (net )?(margin|return|profit)/i.test(text)) findings.push(`${f}: "expected margin/return" wording (P0-8)`);
}

// 5: Worker logging
if (/console\.(log|info|warn|error|debug)/.test(readFileSync("worker/lib.js", "utf8") + readFileSync("worker/index.js", "utf8"))) findings.push("worker/: contains console logging");
// Daemon output must go through the redacting logger only.
for (const f of tracked.filter((x) => x.startsWith("daemon/"))) {
  if (/console\.(log|info|warn|error|debug)|process\.(stdout|stderr)\.write/.test(readFileSync(f, "utf8")) && f !== "daemon/redact.js") findings.push(`${f}: writes output without the redacting logger`);
}

// 6: wrangler.toml
const toml = readFileSync("wrangler.toml", "utf8");
if (/^\s*CSFLOAT_API_KEY\s*=/m.test(toml)) findings.push("wrangler.toml: CSFLOAT_API_KEY must be a secret, not a var");

// 6b: daemon databases, data directory and ledger backups must never be tracked
for (const f of tracked) {
  if (/\.(sqlite|sqlite-wal|sqlite-shm|db)$/i.test(f)) findings.push(`${f}: database file is tracked`);
  if (/(^|\/)\.orcastrike-data\//.test(f)) findings.push(`${f}: daemon data directory is tracked`);
  if (/orcastrike-ledger-.*\.json$/i.test(f)) findings.push(`${f}: ledger backup is tracked`);
}
// 6c: local daemon data (if present on this machine): database bytes and stored payloads must
// not contain credential shapes or the literal values of configured secrets.
const dataDirs = [process.env.ORCASTRIKE_DATA_DIR, ".orcastrike-data"].filter(Boolean);
for (const dir of dataDirs) {
  let files;
  try {
    files = readdirSync(dir).map((f) => join(dir, f));
  } catch {
    continue; // no local data directory on this machine
  }
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f).toString("latin1");
    } catch {
      continue;
    }
    for (const name of ["CSFLOAT_API_KEY", "CLOUDFLARE_API_TOKEN", "NTFY_TOPIC"]) {
      const v = process.env[name];
      if (v && v.length >= 8 && text.includes(v)) findings.push(`${f}: contains the literal value of $${name}`);
    }
    for (const [name, re] of PATTERNS.slice(1)) if (re.test(text)) findings.push(`${f}: ${name}`);
  }
}

// 7: literal env credential values
for (const name of ["CSFLOAT_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  const v = process.env[name];
  if (!v || v.length < 8) continue;
  for (const f of tracked) if (readFileSync(f, "utf8").includes(v)) findings.push(`${f}: contains the literal value of $${name}`);
  if (history.includes(v)) findings.push(`git history contains the literal value of $${name}`);
}

console.log(
  IS_GIT
    ? `secret-scan: ${tracked.length} tracked files, full history, ${shipped.length} shipped files checked`
    : `secret-scan: ${tracked.length} working-tree files (not a git checkout: git history SKIPPED), ${shipped.length} shipped files checked`,
);
if (findings.length) {
  console.log(`FAIL — ${findings.length} finding(s):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log("PASS — no credential-shaped strings, no tracked env files, no client-side secrets");
