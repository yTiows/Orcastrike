// Pre-deploy security audit (P0-9). Exits non-zero on any finding.
// 1. No .env-style files tracked.   2. Credential-shaped strings absent from tracked files
// AND full git history.   3. .env.example has no values.   4. Shipped client files carry no
// auth/cookie handling or key names.   5. Worker never logs.   6. wrangler.toml has no secrets.
// 7. Literal values of any credentials present in this shell's env are absent everywhere.
// 8. P0-8 wording: no "expected margin/return" phrasing in shipped files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const findings = [];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

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
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (ALLOW.test(line)) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) findings.push(`${label}:${i + 1}: ${name}`);
  });
}

// 1 + 2: tracked files
const tracked = git("ls-files").split("\n").filter(Boolean);
for (const f of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(f) && f !== ".env.example") findings.push(`${f}: env file is tracked`);
  if (/(^|\/)\.dev\.vars$/.test(f)) findings.push(`${f}: .dev.vars is tracked`);
  if (f === "package-lock.json") continue; // integrity hashes are not credentials
  scanText(f, readFileSync(f, "utf8"));
}

// 2: full history (added lines only)
const history = git("log", "-p", "--all", "--no-color", "--unified=0");
let current = "history";
for (const line of history.split("\n")) {
  if (line.startsWith("+++ b/")) current = `history:${line.slice(6)}`;
  else if (line.startsWith("+") && !line.startsWith("+++") && !current.endsWith("package-lock.json")) scanText(current, line.slice(1));
}

// 3: .env.example values empty
for (const [i, line] of readFileSync(".env.example", "utf8").split("\n").entries()) {
  const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
  if (m && m[2].trim() !== "") findings.push(`.env.example:${i + 1}: ${m[1]} has a value`);
}
if (!readFileSync(".gitignore", "utf8").split("\n").includes(".env")) findings.push(".gitignore does not ignore .env");

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

// 6: wrangler.toml
const toml = readFileSync("wrangler.toml", "utf8");
if (/^\s*CSFLOAT_API_KEY\s*=/m.test(toml)) findings.push("wrangler.toml: CSFLOAT_API_KEY must be a secret, not a var");

// 7: literal env credential values
for (const name of ["CSFLOAT_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  const v = process.env[name];
  if (!v || v.length < 8) continue;
  for (const f of tracked) if (readFileSync(f, "utf8").includes(v)) findings.push(`${f}: contains the literal value of $${name}`);
  if (history.includes(v)) findings.push(`git history contains the literal value of $${name}`);
}

console.log(`secret-scan: ${tracked.length} tracked files, full history, ${shipped.length} shipped files checked`);
if (findings.length) {
  console.log(`FAIL — ${findings.length} finding(s):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log("PASS — no credential-shaped strings, no tracked env files, no client-side secrets");
