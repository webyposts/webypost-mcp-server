import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from project root (parent of src/ or dist/)
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name, "");
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Normalize base URL: no trailing slash, default production. */
function normalizeBaseUrl(raw: string): string {
  let u = (raw || "https://webypost.com").trim();
  u = u.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) {
    u = "https://" + u;
  }
  return u;
}

export const config = {
  /** MCP HTTP listen port */
  port: envInt("PORT", envInt("MCP_PORT", 8787)),
  /** Bind address — 0.0.0.0 for Render/Docker */
  host: env("HOST", "0.0.0.0"),
  /** Public site origin, e.g. https://webypost.com or http://localhost/webypost */
  webypostBaseUrl: normalizeBaseUrl(env("WEBYPOST_BASE_URL", "https://webypost.com")),
  /** Account email used for logcode.php */
  email: env("WEBYPOST_EMAIL", env("WEBYPOST_USERNAME", "")),
  /** Account password */
  password: env("WEBYPOST_PASSWORD", ""),
  /**
   * Optional pre-seeded session cookie (advanced).
   * Example: PHPSESSID=abc; wyp_remember=def
   */
  sessionCookie: env("WEBYPOST_SESSION_COOKIE", ""),
  /** HTTP request timeout ms */
  requestTimeoutMs: envInt("WEBYPOST_TIMEOUT_MS", 30000),
  /** Default privacy for published posts */
  defaultPrivacy: (env("WEBYPOST_DEFAULT_PRIVACY", "Public") || "Public") as
    | "Public"
    | "Private"
    | "Friends",
  /** Node env */
  nodeEnv: env("NODE_ENV", "development"),
};

export function hasCredentials(): boolean {
  return config.email.length > 0 && config.password.length > 0;
}

export function absUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = config.webypostBaseUrl;
  const p = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  // Avoid double path when base already ends with /webypost and path starts with /webypost
  return `${base}${p}`;
}
