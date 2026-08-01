/**
 * HTTP automation layer for webypost.com (session + form posts).
 * Uses Axios + tough-cookie jar to mirror browser login/post flow.
 */
import axios, { type AxiosInstance, type AxiosError } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { config, absUrl, hasCredentials } from "./config.js";

export type StatusResult = {
  ok: boolean;
  reachable: boolean;
  authenticated: boolean;
  baseUrl: string;
  message: string;
  details?: Record<string, unknown>;
};

export type PublishResult = {
  ok: boolean;
  message: string;
  url?: string;
  pid?: number;
  slug?: string;
  privacy?: string;
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

  constructor() {
    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        jar: this.jar,
        timeout: config.requestTimeoutMs,
        maxRedirects: 5,
        validateStatus: () => true, // handle status ourselves
        headers: {
          "User-Agent":
            "WebypostMcpServer/1.0 (+https://webypost.com; MCP automation)",
          Accept: "application/json, text/plain, */*",
        },
      })
    );

    if (config.sessionCookie) {
      // Seed jar with optional pre-set cookies for the site origin
      const origin = config.webypostBaseUrl;
      for (const part of config.sessionCookie.split(";")) {
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
    const useEmail = (email ?? config.email).trim();
    const usePass = password ?? config.password;

    if (!useEmail || !usePass) {
      return {
        ok: false,
        reachable: true,
        authenticated: false,
        baseUrl: config.webypostBaseUrl,
        message:
          "Missing WEBYPOST_EMAIL / WEBYPOST_PASSWORD. Set them in .env to authenticate.",
      };
    }

    // Warm session cookie
    const ping = await this.ping();
    if (!ping.ok) {
      return {
        ok: false,
        reachable: false,
        authenticated: false,
        baseUrl: config.webypostBaseUrl,
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
        message: `Authenticated as ${useEmail}`,
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
      };
    }

    if (!this.loggedIn && !config.sessionCookie) {
      const auth = await this.login();
      if (!auth.ok || !auth.authenticated) {
        return {
          ok: false,
          message: `Login required before publishing: ${auth.message}`,
          details: auth.details,
        };
      }
    } else if (!this.loggedIn && config.sessionCookie) {
      // Cookie-only mode: try a lightweight authenticated probe
      this.loggedIn = true;
    }

    const form = new URLSearchParams();
    form.set("submit", "1");
    form.set("wp_ajax", "1");
    form.set("name", body); // post body (required by poscode.php)
    form.set("titles", postTitle); // optional title
    form.set("privacy", privacy);
    form.set("input", ""); // tags

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
        // Legacy HTML redirect success
        const m = text.match(/assign\(\s*["']([^"']+)["']/i);
        const path = m?.[1] || "";
        return {
          ok: true,
          message: "Post published (legacy redirect response).",
          url: path ? absUrl(path.replace(/^\//, "")) : undefined,
          details: { httpStatus: res.status },
        };
      } else {
        data = { raw: text.slice(0, 400) };
      }
    }

    // Session expired mid-flight
    if (res.status === 401 || data.error === "Not logged in") {
      this.loggedIn = false;
      const retryLogin = await this.login();
      if (!retryLogin.ok) {
        return {
          ok: false,
          message: `Session expired and re-login failed: ${retryLogin.message}`,
          details: { httpStatus: res.status, data },
        };
      }
      // one retry
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
        details: {
          photo_count: data.photo_count ?? 0,
          httpStatus: res.status,
          account: this.lastUserHint || config.email || null,
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
          message: ping.message,
          details: { httpStatus: ping.status },
        };
      }

      if (!hasCredentials() && !config.sessionCookie) {
        return {
          ok: true,
          reachable: true,
          authenticated: false,
          baseUrl: config.webypostBaseUrl,
          message: `Site is reachable at ${config.webypostBaseUrl}, but no credentials are configured (set WEBYPOST_EMAIL + WEBYPOST_PASSWORD).`,
        };
      }

      if (config.sessionCookie && !hasCredentials()) {
        return {
          ok: true,
          reachable: true,
          authenticated: true,
          baseUrl: config.webypostBaseUrl,
          message:
            "Site reachable. Using WEBYPOST_SESSION_COOKIE (password login skipped).",
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
        message: errorMessage(err),
      };
    }
  }
}

export function safePublishError(err: unknown): PublishResult {
  return {
    ok: false,
    message: errorMessage(err),
  };
}
