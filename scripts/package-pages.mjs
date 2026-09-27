// Copies ONLY the shipped static app into dist/ so `wrangler pages deploy dist` can never
// upload .env, node_modules, tests, docs or the Worker source. No transformation happens:
// the shipped files are byte-identical to the repo (no build step for the app).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const SHIPPED = ["index.html", "styles.css", "_headers", "js", "ui", "config", "static"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const entry of SHIPPED) cpSync(join(root, entry), join(dist, entry), { recursive: true });
console.log(`dist/ ready: ${SHIPPED.join(", ")}`);
