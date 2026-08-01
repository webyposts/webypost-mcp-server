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

export type AccountConfig = {
  /** Short name Grok passes as `account` (e.g. main, brand2) */
  id: string;
  email: string;
  password: string;
  /** Optional pre-seeded session cookie for this account only */
  sessionCookie?: string;
};

/**
 * Parse WEBYPOST_ACCOUNTS.
 *
 * Object form (recommended):
 *   {"main":{"email":"a@x.com","password":"secret"},"news":{"email":"b@x.com","password":"secret2"}}
 *
 * Array form:
 *   [{"id":"main","email":"a@x.com","password":"secret"}]
 *
 * Legacy single-account env vars still work if ACCOUNTS is empty:
 *   WEBYPOST_EMAIL + WEBYPOST_PASSWORD → account id "default"
 */
function parseAccounts(): AccountConfig[] {
  const raw = env("WEBYPOST_ACCOUNTS", "");
  const accounts: AccountConfig[] = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const o = item as Record<string, unknown>;
          const id = String(o.id ?? o.name ?? o.key ?? "").trim();
          const email = String(o.email ?? o.username ?? "").trim();
          const password = String(o.password ?? "").trim();
          const sessionCookie =
            typeof o.sessionCookie === "string"
              ? o.sessionCookie.trim()
              : typeof o.session_cookie === "string"
                ? o.session_cookie.trim()
                : "";
          if (id && email && password) {
            accounts.push({
              id,
              email,
              password,
              ...(sessionCookie ? { sessionCookie } : {}),
            });
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [idRaw, val] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          const id = String(idRaw).trim();
          if (!id || !val || typeof val !== "object") continue;
          const o = val as Record<string, unknown>;
          const email = String(o.email ?? o.username ?? "").trim();
          const password = String(o.password ?? "").trim();
          const sessionCookie =
            typeof o.sessionCookie === "string"
              ? o.sessionCookie.trim()
              : typeof o.session_cookie === "string"
                ? o.session_cookie.trim()
                : "";
          if (email && password) {
            accounts.push({
              id,
              email,
              password,
              ...(sessionCookie ? { sessionCookie } : {}),
            });
          }
        }
      }
    } catch (err) {
      console.error(
        "[webypost-mcp] WEBYPOST_ACCOUNTS is not valid JSON:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Legacy single-account fallback
  if (accounts.length === 0) {
    const email = env("WEBYPOST_EMAIL", env("WEBYPOST_USERNAME", ""));
    const password = env("WEBYPOST_PASSWORD", "");
    const sessionCookie = env("WEBYPOST_SESSION_COOKIE", "");
    if (email && password) {
      accounts.push({
        id: "default",
        email,
        password,
        ...(sessionCookie ? { sessionCookie } : {}),
      });
    } else if (sessionCookie) {
      // Cookie-only (no password) — rare
      accounts.push({
        id: "default",
        email: "",
        password: "",
        sessionCookie,
      });
    }
  }

  return accounts;
}

const accounts = parseAccounts();
const defaultAccountId =
  env("WEBYPOST_DEFAULT_ACCOUNT", "") || accounts[0]?.id || "default";

export const config = {
  /** MCP HTTP listen port */
  port: envInt("PORT", envInt("MCP_PORT", 8787)),
  /** Bind address — 0.0.0.0 for Render/Docker */
  host: env("HOST", "0.0.0.0"),
  /** Public site origin, e.g. https://webypost.com or http://localhost/webypost */
  webypostBaseUrl: normalizeBaseUrl(
    env("WEBYPOST_BASE_URL", "https://webypost.com")
  ),
  /** All configured Webypost accounts (multi-account) */
  accounts,
  /** Default account id when tool omits `account` */
  defaultAccountId,
  /**
   * @deprecated Prefer config.accounts — kept for older call sites
   * (first/default account email)
   */
  email:
    accounts.find((a) => a.id === defaultAccountId)?.email ||
    accounts[0]?.email ||
    "",
  /**
   * @deprecated Prefer config.accounts
   */
  password:
    accounts.find((a) => a.id === defaultAccountId)?.password ||
    accounts[0]?.password ||
    "",
  /**
   * @deprecated Prefer per-account sessionCookie
   */
  sessionCookie:
    accounts.find((a) => a.id === defaultAccountId)?.sessionCookie ||
    accounts[0]?.sessionCookie ||
    env("WEBYPOST_SESSION_COOKIE", ""),
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
  return config.accounts.some(
    (a) => (a.email && a.password) || a.sessionCookie
  );
}

export function listAccountIds(): string[] {
  return config.accounts.map((a) => a.id);
}

export function resolveAccount(
  accountId?: string | null
): AccountConfig | null {
  if (!config.accounts.length) return null;
  const want = (accountId || config.defaultAccountId || "").trim();
  if (!want) return config.accounts[0] ?? null;
  const found = config.accounts.find(
    (a) => a.id.toLowerCase() === want.toLowerCase()
  );
  return found ?? null;
}

export function absUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = config.webypostBaseUrl;
  const p = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${p}`;
}
