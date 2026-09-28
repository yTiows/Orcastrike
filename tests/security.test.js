// Security layer: the pre-deploy audit runs inside the suite, so a wording, secret or CSP
// regression fails `npm test` (regression for the P0-8 wording finding in commit a7e5bdb).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function files(dir, re) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name), re) : re.test(d.name) ? [join(dir, d.name)] : []));
}

test("secret scan passes (credentials, env files, client secrets, P0-8 wording, daemon logging)", () => {
  const r = spawnSync(process.execPath, ["scripts/secret-scan.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("CSP: no inline styles or inline scripts in shipped markup/templates; no unsafe-inline", () => {
  const shipped = ["index.html", ...files("ui", /\.js$/), ...files("js", /\.js$/)];
  for (const f of shipped) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.ok(!/\sstyle\s*=\s*["'`]/.test(text), `${f}: inline style attribute`);
    assert.ok(!/<script>(?!<\/script>)/.test(text.replace(/<script[^>]*src=[^>]*><\/script>/g, "")), `${f}: inline script`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/.test(text.replace(/\/\/.*$/gm, "")), `${f}: inline event handler`);
  }
  const headers = readFileSync(join(ROOT, "_headers"), "utf8") + readFileSync(join(ROOT, "daemon/server.js"), "utf8");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(headers));
});

test("daemon binds to loopback only", () => {
  const main = readFileSync(join(ROOT, "daemon/main.js"), "utf8");
  assert.match(main, /server\.listen\(port, "127\.0\.0\.1"/);
  assert.ok(!/listen\(port\)|0\.0\.0\.0/.test(main));
});
