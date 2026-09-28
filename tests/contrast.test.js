// WCAG 2.x contrast for every text token against every background it is drawn on, in all three
// palettes (light, dark, UMBRA). AA for normal text is 4.5:1. Tokens are read from styles.css
// itself, so a palette edit that breaks legibility fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
function blockAfter(marker) {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const open = css.indexOf("{", start + marker.length - 1);
  return css.slice(open + 1, css.indexOf("}", open));
}

const light = tokens(blockAfter(":root {"));
const dark = { ...light, ...tokens(blockAfter("@media (prefers-color-scheme: dark) {\n  :root {")) };
const umbra = { ...light, ...tokens(blockAfter(':root[data-mode="umbra"] {')) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = ["text", "muted", "accent-text", "pos", "neg", "ok-text", "s-highlight", "s-blocked", "s-thin", "s-stale", "s-insufficient"];
const BACKGROUNDS = ["bg", "surface", "surface-2"];
const PAIRED = [
  ["on-accent", "accent"],
  ["on-neg", "neg"],
  ["warn-text", "warn-bg"],
  ["err-text", "err-bg"],
];

for (const [name, p] of Object.entries({ light, dark, umbra })) {
  test(`${name} palette: every text token ≥ 4.5:1 on every background`, () => {
    const failures = [];
    for (const t of TEXT) {
      assert.ok(p[t], `${name}: --${t} missing`);
      for (const b of BACKGROUNDS) {
        const c = contrast(p[t], p[b]);
        if (c < 4.5) failures.push(`--${t} ${p[t]} on --${b} ${p[b]}: ${c.toFixed(2)}`);
      }
    }
    for (const [t, b] of PAIRED) {
      const c = contrast(p[t], p[b]);
      if (c < 4.5) failures.push(`--${t} on --${b}: ${c.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test("UMBRA keeps the specified palette verbatim", () => {
  const spec = { bg: "#06060A", surface: "#0E0D14", border: "#1E1B2A", text: "#D8D4E4", accent: "#7C5CFF", pos: "#F2B84B", neg: "#FF3D5A" };
  for (const [k, v] of Object.entries(spec)) assert.equal(umbra[k].toUpperCase(), v.toUpperCase(), `--${k}`);
});

test("no hard-coded text colours: every foreground comes from a tested token", () => {
  assert.deepEqual([...css.matchAll(/(^|[;{\s])color:\s*#[0-9a-fA-F]{3,6}/gm)].map((m) => m[0].trim()), []);
});

test("accent-coloured text uses --accent-text, never --accent", () => {
  // --accent is for fills and borders; text needs --accent-text, which is tuned for contrast.
  const offenders = [...css.matchAll(/(^|[;{\s])color:\s*var\(--accent\)/gm)].map((m) => css.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\s+/g, " "));
  assert.deepEqual(offenders, []);
});
