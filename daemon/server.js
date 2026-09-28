// Localhost HTTP server: the static UI and the JSON contract, one origin.
// - Binds to 127.0.0.1 only (main.js).
// - Host header must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding guard).
// - Every non-GET request must be application/json from exactly this origin (CSRF guard),
//   except the kill switch's "engage" direction, which is always allowed (safe direction).
// - Errors never include stack traces, upstream bodies or secret material.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { redact } from "./redact.js";

const STATIC_ALLOW = [/^\/$/, /^\/index\.html$/, /^\/styles\.css$/, /^\/(js|ui|config|static)\/[A-Za-z0-9_\-/.]+\.(js|json|css)$/];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const CSP =
  "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' https://*.workers.dev; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 5 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, extra = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

// routes: [{ method, path (string | RegExp), handler(ctx) → body | { status, body }, allowCrossOrigin? }]
export function createDaemonServer({ root, port, routes, log = () => {} }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function serveStatic(pathname, res) {
    if (!STATIC_ALLOW.some((re) => re.test(pathname)) || pathname.includes("..")) throw new HttpError(404, "not found");
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) throw new HttpError(404, "not found");
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      throw new HttpError(404, "not found");
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(421, "unexpected Host header");
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = routes.find((r) => r.method === req.method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
      if (!route) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, res);
        throw new HttpError(req.method === "GET" ? 404 : 405, req.method === "GET" ? "not found" : "method not allowed");
      }
      let body = null;
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (!route.allowCrossOrigin && !selfOrigins.has(origin ?? "")) throw new HttpError(403, "writes are accepted only from this origin");
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
        body = await readJson(req);
      }
      const out = await route.handler({ url, query: url.searchParams, body, match: typeof route.path === "string" ? null : url.pathname.match(route.path) });
      if (out && typeof out === "object" && "status" in out && "body" in out) return send(res, out.status, out.body);
      return send(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log("error", `request failed: ${redact(err?.message ?? err)}`);
      return send(res, status, { error: status === 500 ? "internal error" : redact(err.message) });
    }
  });
  return server;
}
