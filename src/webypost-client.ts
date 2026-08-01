/**
 * HTTP automation layer for webypost.com (session + form posts).
 * Uses Axios + tough-cookie jar to mirror browser login/post flow.
 *
 * One WebypostClient instance = one account (own cookie jar).
 * Use getClientForAccount() for multi-account MCP tools.
 */
import axios, { type AxiosInstance, type AxiosError } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import {
  config,
  absUrl,
  hasCredentials,
  resolveAccount,
  type AccountConfig,
} from "./config.js";

export type StatusResult = {
  ok: boolean;
  reachable: boolean;
  authenticated: boolean;
  baseUrl: string;
  message: string;
  account?: string | null;
  email?: string | null;
  details?: Record<string, unknown>;
};

export type PublishResult = {
  ok: boolean;
  message: string;
  url?: string;
  pid?: number;
  slug?: string;
  privacy?: string;
  account?: string | null;
  details?: Record<string, unknown>;
};

function isJsonContentType(ct: string | undefined): boolean {
  return !!ct && ct.toLowerCase().includes("application/json");
}

function errorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const data = ax.response?.data;
    let body = "";
    if (typeof data === "string") body = data.slice(0, 300);
    else if (data && typeof data === "object") {
      try {
        body = JSON.stringify(data).slice(0, 300);
      } catch {
        body = "";
      }
    }
    if (ax.code === "ECONNREFUSED") {
      return `Connection refused to ${config.webypostBaseUrl}. Is the site (or XAMPP) running?`;
    }
    if (ax.code === "ENOTFOUND") {
      return `DNS lookup failed for ${config.webypostBaseUrl}.`;
    }
    if (ax.code === "ETIMEDOUT" || ax.code === "ECONNABORTED") {
      return `Request timed out talking to ${config.webypostBaseUrl}.`;
    }
    return [
      ax.message,
      status ? `HTTP ${status}` : "",
      body ? `body: ${body}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export class WebypostClient {
  private jar: CookieJar;
  private http: AxiosInstance;
  private loggedIn = false;
  private lastUserHint = "";
  private account: AccountConfig;

  constructor(account?: AccountConfig) {
    this.account =
      account ??
      resolveAccount(config.defaultAccountId) ?? {
        id: "default",
        email: config.email,
        password: config.password,
        sessionCookie: config.sessionCookie || undefined,
      };

    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        jar: this.jar,
        timeout: config.requestTimeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "WebypostMcpServer/1.0 (+https://webypost.com; MCP automation)",
          Accept: "application/json, text/plain, */*",
        },
      })
    );

    const seed = this.account.sessionCookie || "";
    if (seed) {
      const origin = config.webypostBaseUrl;
      for (const part of seed.split(";")) {
        const c = part.trim();
        if (c) {
          try {
            this.jar.setCookieSync(c, origin);
          } catch {
            // ignore malformed cookie segments
          }
        }
      }
    }
  }

  get accountId(): string {
    return this.account.id;
  }

  get accountEmail(): string {
    return this.account.email;
  }

  /** GET site root — establishes PHPSESSID when cookies are enabled. */
  async ping(): Promise<{ ok: boolean; status: number; message: string }> {
    const url = absUrl("/");
    const res = await this.http.get(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (res.status >= 200 && res.status < 400) {
      return {
        ok: true,
        status: res.status,
        message: `Reached ${url} (HTTP ${res.status})`,
      };
    }
    return {
      ok: false,
      status: res.status,
      message: `Site returned HTTP ${res.status} for ${url}`,
    };
  }

  /**
   * Email/password login via logcode.php (JSON body, same as the web login SPA).
   */
  async login(email?: string, password?: string): Promise<StatusResult> {
    const useEmail = (email ?? this.account.email).trim();
    const usePass = password ?? this.account.password;

    if (!useEmail || !usePass) {
      return {
        ok: false,
        reachable: true,
        authenticated: false,
        baseUrl: config.webypostBaseUrl,
        account: this.account.id,
        email: useEmail || null,
        message:
          "Missing credentials for this account. Set WEBYPOST_ACCOUNTS (or WEBYPOST_EMAIL / WEBYPOST_PASSWORD).",
      };
    }

    const ping = await this.ping();
    if (!ping.ok) {
      return {
        ok: false,
        reachable: false,
        authenticated: false,
        baseUrl: config.webypostBaseUrl,
        account: this.account.id,
        email: useEmail,
        message: ping.message,
      };
    }

    const loginUrl = absUrl("/logcode.php");
    const res = await this.http.post(
      loginUrl,
      {
        email: useEmail,
        password: usePass,
        remember_me: "1",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: config.webypostBaseUrl,
          Referer: absUrl("/login"),
        },
      }
    );

    const ct = String(res.headers["content-type"] || "");
    let data: Record<string, unknown> = {};
    if (isJsonContentType(ct) && res.data && typeof res.data === "object") {
      data = res.data as Record<string, unknown>;
    } else if (typeof res.data === "string" && res.data.trim().startsWith("{")) {
      try {
        data = JSON.parse(res.data) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }

    if (res.status >= 200 && res.status < 300 && data.success === true) {
      this.loggedIn = true;
      this.lastUserHint = useEmail;
      return {
        ok: true,
        reachable: true,
        authenticated: true,
        baseUrl: config.webypostBaseUrl,
        account: this.account.id,
        email: useEmail,
        message: `Authenticated as ${useEmail} (account: ${this.account.id})`,
        details: {
          redirect: data.redirect ?? null,
          httpStatus: res.status,
        },
      };
    }

    const errMsg =
      (typeof data.error === "string" && data.error) ||
      (typeof data.message === "string" && data.message) ||
      `Login failed (HTTP ${res.status})`;

    this.loggedIn = false;
    return {
      ok: false,
      reachable: true,
      authenticated: false,
      baseUrl: config.webypostBaseUrl,
      account: this.account.id,
      email: useEmail,
      message: errMsg,
      details: {
        httpStatus: res.status,
        response: data,
      },
    };
  }

  /**
   * Publish a text status/post via poscode.php (AJAX JSON).
   * Maps MCP `title` → titles, `content` → name (body field used by Webypost compose).
   */
  async publishPost(
    title: string,
    content: string,
    privacy: "Public" | "Private" | "Friends" = config.defaultPrivacy
  ): Promise<PublishResult> {
    const body = (content || "").trim();
    const postTitle = (title || "").trim();

    if (!body) {
      return {
        ok: false,
        message: "content is required (this is the post body text).",
        account: this.account.id,
      };
    }

    if (!this.loggedIn && !this.account.sessionCookie) {
      const auth = await this.login();
      if (!auth.ok || !auth.authenticated) {
        return {
          ok: false,
          message: `Login required before publishing: ${auth.message}`,
          account: this.account.id,
          details: auth.details,
        };
      }
    } else if (!this.loggedIn && this.account.sessionCookie) {
      this.loggedIn = true;
    }

    const form = new URLSearchParams();
    form.set("submit", "1");
    form.set("wp_ajax", "1");
    form.set("name", body);
    form.set("titles", postTitle);
    form.set("privacy", privacy);
    form.set("input", "");

    const postUrl = absUrl("/poscode.php");
    const res = await this.http.post(postUrl, form.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: config.webypostBaseUrl,
        Referer: absUrl("/home"),
      },
    });

    const ct = String(res.headers["content-type"] || "");
    let data: Record<string, unknown> = {};
    if (isJsonContentType(ct) && res.data && typeof res.data === "object") {
      data = res.data as Record<string, unknown>;
    } else if (typeof res.data === "string") {
      const text = res.data.trim();
      if (text.startsWith("{")) {
        try {
          data = JSON.parse(text) as Record<string, unknown>;
        } catch {
          data = { raw: text.slice(0, 400) };
        }
      } else if (/window\.location\.assign/i.test(text)) {
        const m = text.match(/assign\(\s*["']([^"']+)["']/i);
        const path = m?.[1] || "";
        return {
          ok: true,
          message: "Post published (legacy redirect response).",
          url: path ? absUrl(path.replace(/^\//, "")) : undefined,
          account: this.account.id,
          details: { httpStatus: res.status, email: this.lastUserHint },
        };
      } else {
        data = { raw: text.slice(0, 400) };
      }
    }

    if (res.status === 401 || data.error === "Not logged in") {
      this.loggedIn = false;
      const retryLogin = await this.login();
      if (!retryLogin.ok) {
        return {
          ok: false,
          message: `Session expired and re-login failed: ${retryLogin.message}`,
          account: this.account.id,
          details: { httpStatus: res.status, data },
        };
      }
      return this.publishPost(title, content, privacy);
    }

    if (res.status >= 200 && res.status < 300 && data.success === true) {
      const pid = Number(data.pid) || undefined;
      const slug = typeof data.slug === "string" ? data.slug : "";
      let url: string | undefined;
      if (pid && slug) {
        url = absUrl(`${slug}/story/${pid}`);
      } else if (pid) {
        url = absUrl(`post.php?news=&cid=${pid}`);
      }

      return {
        ok: true,
        message:
          typeof data.message === "string" ? data.message : "Post published",
        url,
        pid,
        slug: slug || undefined,
        privacy: typeof data.privacy === "string" ? data.privacy : privacy,
        account: this.account.id,
        details: {
          photo_count: data.photo_count ?? 0,
          httpStatus: res.status,
          email: this.lastUserHint || this.account.email || null,
        },
      };
    }

    const failMsg =
      (typeof data.error === "string" && data.error) ||
      (typeof data.message === "string" && data.message) ||
      `Publish failed (HTTP ${res.status})`;

    return {
      ok: false,
      message: failMsg,
      account: this.account.id,
      details: {
        httpStatus: res.status,
        response: data,
      },
    };
  }

  /** Combined reachability + credential check for MCP tool. */
  async checkStatus(): Promise<StatusResult> {
    try {
      const ping = await this.ping();
      if (!ping.ok) {
        return {
          ok: false,
          reachable: false,
          authenticated: false,
          baseUrl: config.webypostBaseUrl,
          account: this.account.id,
          email: this.account.email || null,
          message: ping.message,
          details: { httpStatus: ping.status },
        };
      }

      if (!this.account.email && !this.account.password && !this.account.sessionCookie) {
        return {
          ok: true,
          reachable: true,
          authenticated: false,
          baseUrl: config.webypostBaseUrl,
          account: this.account.id,
          message: `Site is reachable, but account "${this.account.id}" has no credentials.`,
        };
      }

      if (this.account.sessionCookie && !this.account.password) {
        return {
          ok: true,
          reachable: true,
          authenticated: true,
          baseUrl: config.webypostBaseUrl,
          account: this.account.id,
          message: `Site reachable. Account "${this.account.id}" using session cookie (password login skipped).`,
        };
      }

      const auth = await this.login();
      return auth;
    } catch (err) {
      return {
        ok: false,
        reachable: false,
        authenticated: false,
        baseUrl: config.webypostBaseUrl,
        account: this.account.id,
        message: errorMessage(err),
      };
    }
  }
}

/** One cookie-jar client per account id for the process lifetime */
const clientPool = new Map<string, WebypostClient>();

/**
 * Resolve account by id (or default) and return a dedicated client.
 * Throws a friendly Error if the account id is unknown.
 */
export function getClientForAccount(accountId?: string | null): WebypostClient {
  const resolved = resolveAccount(accountId);
  if (!resolved) {
    const known = config.accounts.map((a) => a.id).join(", ") || "(none)";
    throw new Error(
      accountId
        ? `Unknown account "${accountId}". Configured accounts: ${known}`
        : `No Webypost accounts configured. Set WEBYPOST_ACCOUNTS (or WEBYPOST_EMAIL + WEBYPOST_PASSWORD). Known: ${known}`
    );
  }
  let client = clientPool.get(resolved.id);
  if (!client) {
    client = new WebypostClient(resolved);
    clientPool.set(resolved.id, client);
  }
  return client;
}

export function safePublishError(err: unknown): PublishResult {
  return {
    ok: false,
    message: errorMessage(err),
  };
}

// silence unused in some builds
void hasCredentials;
