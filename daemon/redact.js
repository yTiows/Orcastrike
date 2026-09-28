// Redaction for anything the daemon logs, stores as an error, or returns to the UI.
// Secrets come only from the environment; their literal values are scrubbed wherever they
// could surface, together with generic credential shapes.

const SECRET_ENV = ["CSFLOAT_API_KEY", "CLOUDFLARE_API_TOKEN", "NTFY_TOPIC", "ORCASTRIKE_DAEMON_TOKEN"];

const PATTERNS = [
  /(authorization|api[_-]?key|token|secret|cookie|password)(["'\s:=]+)([^\s"',;]{6,})/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
];

export function redact(text, env = process.env) {
  let s = String(text ?? "");
  for (const name of SECRET_ENV) {
    const v = env[name];
    if (v && v.length >= 6) s = s.split(v).join(`[REDACTED:${name}]`);
  }
  s = s.replace(PATTERNS[0], (_m, k, sep) => `${k}${sep}[REDACTED]`);
  s = s.replace(PATTERNS[1], "Bearer [REDACTED]");
  return s;
}

// Logger that can only emit redacted strings.
export function makeLogger(stream = process.stderr, env = process.env) {
  return (level, message) => {
    stream.write(`${new Date().toISOString()} ${level} ${redact(message, env)}\n`);
  };
}
