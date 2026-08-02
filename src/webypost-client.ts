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

export type PublishPostInput = {
  title: string;
  content: string;
  privacy?: "Public" | "Private" | "Friends";
  /**
   * Optional image URLs (https or data:image/…;base64,…).
   * Downloaded/decoded and uploaded as fileToUpload1[] (max 8, same as Webypost UI).
   */
  imageUrls?: string[];
};

/**
 * Extract image markers embedded in post body/title so clients that only
 * expose text fields (e.g. Grok frozen tool schemas) can still attach photos.
 *
 * Supported markers (one per line or inline):
 *   [[IMAGE:https://example.com/photo.jpg]]
 *   [[image:data:image/png;base64,...]]
 *   IMAGE_URL=https://...
 *   IMAGE_URL: https://...
 */
export function extractEmbeddedImages(text: string): {
  cleanText: string;
  imageUrls: string[];
} {
  const urls: string[] = [];
  let clean = text || "";

  // [[IMAGE:url]] or [[image:url]] — non-greedy for https; special case data URLs
  const bracketRe =
    /\[\[\s*image\s*:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+|https?:\/\/[^\]\s]+)\s*\]\]/gi;
  clean = clean.replace(bracketRe, (_m, url: string) => {
    const u = String(url || "").replace(/\s+/g, "").trim();
    if (u) urls.push(u.startsWith("data:") ? u : u);
    return "";
  });

  // IMAGE_URL=... or IMAGE_URL: ...
  const lineRe =
    /^\s*IMAGE_URL\s*[=:]\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+|https?:\/\/\S+)\s*$/gim;
  clean = clean.replace(lineRe, (_m, url: string) => {
    const u = String(url || "").replace(/\s+/g, "").trim();
    if (u) urls.push(u);
    return "";
  });

  clean = clean.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText: clean, imageUrls: [...new Set(urls)].slice(0, 8) };
}

export type ContentDirectives = {
  cleanText: string;
  /** status (default) or article — full editor publish */
  mode: "status" | "article";
  coverImageUrl?: string;
  category?: string;
  subcategory?: string;
  metadesc?: string;
  keywords?: string;
  tags?: string;
  imageUrls: string[];
};

/**
 * Directives for clients that only expose title/content/privacy/account
 * (e.g. Grok frozen MCP connectors that never reload new tools).
 *
 * Put these on their own lines (stripped from final body):
 *   [[MODE:article]]
 *   [[COVER:https://…]]
 *   [[CATEGORY:Tech Reviews & Gadgets]]
 *   [[SUBCATEGORY:Upcoming Tech Launches]]
 *   [[METADESC:SEO blurb]]
 *   [[KEYWORDS:ai, tech]]
 *   [[TAGS:news, ai]]
 *   [[IMAGE:https://…]]   (status photos; also ok as extra)
 *
 * Body after markers may be HTML for articles.
 */
export function extractContentDirectives(text: string): ContentDirectives {
  let clean = text || "";
  let mode: "status" | "article" = "status";
  let coverImageUrl: string | undefined;
  let category: string | undefined;
  let subcategory: string | undefined;
  let metadesc: string | undefined;
  let keywords: string | undefined;
  let tags: string | undefined;

  const take = (re: RegExp, assign: (v: string) => void) => {
    clean = clean.replace(re, (_m, v: string) => {
      const s = String(v || "").trim();
      if (s) assign(s);
      return "";
    });
  };

  take(/\[\[\s*mode\s*:\s*(article|status|post|story)\s*\]\]/gi, (v) => {
    const x = v.toLowerCase();
    mode = x === "article" ? "article" : "status";
  });
  // Also: TYPE:article / POST_TYPE=article
  take(/^\s*(?:TYPE|POST_TYPE|MODE)\s*[=:]\s*(article|status|post)\s*$/gim, (v) => {
    mode = v.toLowerCase() === "article" ? "article" : "status";
  });

  take(
    /\[\[\s*cover\s*:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+|https?:\/\/[^\]\s]+)\s*\]\]/gi,
    (v) => {
      coverImageUrl = v.replace(/\s+/g, "");
    }
  );
  take(
    /^\s*COVER(?:_URL)?\s*[=:]\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+|https?:\/\/\S+)\s*$/gim,
    (v) => {
      coverImageUrl = v.replace(/\s+/g, "");
    }
  );

  take(/\[\[\s*category\s*:\s*([^\]]+)\]\]/gi, (v) => {
    category = v;
  });
  take(/\[\[\s*subcategory\s*:\s*([^\]]+)\]\]/gi, (v) => {
    subcategory = v;
  });
  take(/\[\[\s*metadesc\s*:\s*([^\]]+)\]\]/gi, (v) => {
    metadesc = v;
  });
  take(/\[\[\s*keywords?\s*:\s*([^\]]+)\]\]/gi, (v) => {
    keywords = v;
  });
  take(/\[\[\s*tags?\s*:\s*([^\]]+)\]\]/gi, (v) => {
    tags = v;
  });

  const imgs = extractEmbeddedImages(clean);
  clean = imgs.cleanText.replace(/\n{3,}/g, "\n\n").trim();

  return {
    cleanText: clean,
    mode,
    coverImageUrl,
    category,
    subcategory,
    metadesc,
    keywords,
    tags,
    imageUrls: imgs.imageUrls,
  };
}

export type PublishArticleInput = {
  title: string;
  content: string;
  privacy?: "Public" | "Private" | "Friends";
  /** Main category (maps to department). e.g. "Tech Reviews & Gadgets" */
  category?: string;
  /** Sub-category (maps to subc) */
  subcategory?: string;
  /** Meta description for SEO */
  metadesc?: string;
  /** Comma-separated SEO keywords */
  keywords?: string;
  /** Comma-separated tags */
  tags?: string;
  /**
   * Optional cover image URL (https or data:image/…;base64,…).
   * Downloaded and uploaded as fileToUpload1.
   */
  coverImageUrl?: string;
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

  /** Ensure session is authenticated for this account. */
  private async ensureAuth(): Promise<StatusResult | null> {
    if (!this.loggedIn && !this.account.sessionCookie) {
      const auth = await this.login();
      if (!auth.ok || !auth.authenticated) {
        return auth;
      }
    } else if (!this.loggedIn && this.account.sessionCookie) {
      this.loggedIn = true;
    }
    return null;
  }

  /**
   * Publish a long-form article via editor.php (AJAX JSON, same as web editor).
   * Maps: title→title, content→teaser, category→department, subcategory→subc.
   */
  async publishArticle(input: PublishArticleInput): Promise<PublishResult> {
    const title = (input.title || "").trim();
    let body = (input.content || "").trim();
    const privacy = input.privacy ?? config.defaultPrivacy;

    if (!title) {
      return {
        ok: false,
        message: "title is required for articles.",
        account: this.account.id,
      };
    }
    if (!body) {
      return {
        ok: false,
        message: "content is required (article body HTML or plain text).",
        account: this.account.id,
      };
    }

    // Editor stores HTML; wrap plain text paragraphs lightly
    if (!/<[a-z][\s\S]*>/i.test(body)) {
      body = body
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("\n");
    }

    const authFail = await this.ensureAuth();
    if (authFail) {
      return {
        ok: false,
        message: `Login required before publishing article: ${authFail.message}`,
        account: this.account.id,
        details: authFail.details,
      };
    }

    const category =
      (input.category || "").trim() || "Tech Reviews & Gadgets";
    const subcategory =
      (input.subcategory || "").trim() || "Upcoming Tech Launches";
    const keywords =
      (input.keywords || "").trim() ||
      title
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 6)
        .join(", ");
    const tags = (input.tags || keywords).trim();
    const metadesc =
      (input.metadesc || "").trim() ||
      stripHtml(body).slice(0, 155).trim();

    const form = new FormData();
    form.set("submit", "1");
    form.set("title", title);
    form.set("teaser", body);
    form.set("metadesc", metadesc);
    form.set("keyword", keywords);
    form.set("input", tags);
    form.set("privacy", privacy);
    form.set("department", category);
    form.set("subc", subcategory);
    form.set("cropdata", "");

    // Optional cover image
    const coverUrl = (input.coverImageUrl || "").trim();
    if (coverUrl) {
      const cover = await resolveImageSource(coverUrl, "cover");
      if (cover) {
        form.set("fileToUpload1", cover.blob, cover.filename);
      }
    }

    const postUrl = absUrl("/editor.php");
    const res = await this.http.post(postUrl, form, {
      headers: {
        Accept: "application/json",
        "X-WP-Editor-Ajax": "1",
        "X-Requested-With": "XMLHttpRequest",
        Origin: config.webypostBaseUrl,
        Referer: absUrl("/editor.php"),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      // Let axios set multipart boundary for FormData
      transformRequest: [
        (data, headers) => {
          // axios + FormData: remove forced json content-type if any
          if (data instanceof FormData && headers) {
            delete (headers as Record<string, unknown>)["Content-Type"];
            delete (headers as Record<string, unknown>)["content-type"];
          }
          return data;
        },
      ],
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
      return this.publishArticle(input);
    }

    if (res.status >= 200 && res.status < 300 && data.ok === true) {
      const id = Number(data.id) || undefined;
      const slug = typeof data.slug === "string" ? data.slug : "";
      let url =
        typeof data.url === "string" && data.url
          ? data.url
          : undefined;
      if (!url && id && slug) {
        url = absUrl(`${slug}/article/${id}`);
      } else if (url && !/^https?:\/\//i.test(url)) {
        url = absUrl(url.replace(/^\//, ""));
      }

      return {
        ok: true,
        message: "Article published",
        url,
        pid: id,
        slug: slug || undefined,
        privacy,
        account: this.account.id,
        details: {
          type: "article",
          category,
          subcategory,
          httpStatus: res.status,
          email: this.lastUserHint || this.account.email || null,
        },
      };
    }

    const failMsg =
      (typeof data.error === "string" && data.error) ||
      (typeof data.message === "string" && data.message) ||
      `Article publish failed (HTTP ${res.status})`;

    return {
      ok: false,
      message: failMsg,
      account: this.account.id,
      details: {
        type: "article",
        httpStatus: res.status,
        response: data,
      },
    };
  }

  /**
   * Publish a status/feed post via poscode.php (AJAX JSON).
   * Optional imageUrls → multipart fileToUpload1[] (max 8), same as the web compose UI.
   */
  async publishPost(
    titleOrInput: string | PublishPostInput,
    content?: string,
    privacy: "Public" | "Private" | "Friends" = config.defaultPrivacy
  ): Promise<PublishResult> {
    const input: PublishPostInput =
      typeof titleOrInput === "string"
        ? {
            title: titleOrInput,
            content: content ?? "",
            privacy,
          }
        : titleOrInput;

    const embedded = extractEmbeddedImages(input.content || "");
    const embeddedTitle = extractEmbeddedImages(input.title || "");
    const body = embedded.cleanText.trim();
    const postTitle = embeddedTitle.cleanText.trim();
    const usePrivacy = input.privacy ?? config.defaultPrivacy;
    const imageUrls = [
      ...(input.imageUrls || []),
      ...embedded.imageUrls,
      ...embeddedTitle.imageUrls,
    ]
      .map((u) => String(u || "").trim())
      .filter(Boolean)
      .slice(0, 8);

    if (!body) {
      return {
        ok: false,
        message:
          "content is required (post body text). To attach an image when your client has no imageUrl field, put this on its own line in content: [[IMAGE:https://your-public-image-url.jpg]]",
        account: this.account.id,
      };
    }

    const authFail = await this.ensureAuth();
    if (authFail) {
      return {
        ok: false,
        message: `Login required before publishing: ${authFail.message}`,
        account: this.account.id,
        details: authFail.details,
      };
    }

    // Always multipart when images are present (matches browser FormData + fileToUpload1[])
    const form = new FormData();
    form.set("submit", "Post");
    form.set("wp_ajax", "1");
    form.set("name", body);
    form.set("titles", postTitle);
    form.set("privacy", usePrivacy);
    form.set("input", "");

    let imagesAttached = 0;
    const imageErrors: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const resolved = await resolveImageSource(imageUrls[i], `photo${i + 1}`);
      if (!resolved) {
        imageErrors.push(`Could not load image ${i + 1}`);
        continue;
      }
      // PHP expects fileToUpload1 or fileToUpload1[] — append as array field
      form.append("fileToUpload1[]", resolved.blob, resolved.filename);
      imagesAttached += 1;
    }

    if (imageUrls.length > 0 && imagesAttached === 0) {
      return {
        ok: false,
        message:
          "Could not download/decode any images. Pass public https image URLs (or data:image/…;base64,…) that this server can fetch. " +
          (imageErrors[0] || ""),
        account: this.account.id,
        details: { imageErrors, requested: imageUrls.length },
      };
    }

    const postUrl = absUrl("/poscode.php");
    const res = await this.http.post(postUrl, form, {
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: config.webypostBaseUrl,
        Referer: absUrl("/home"),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      transformRequest: [
        (data, headers) => {
          if (data instanceof FormData && headers) {
            delete (headers as Record<string, unknown>)["Content-Type"];
            delete (headers as Record<string, unknown>)["content-type"];
          }
          return data;
        },
      ],
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
          details: {
            httpStatus: res.status,
            email: this.lastUserHint,
            images_attached: imagesAttached,
          },
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
      return this.publishPost(input);
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
        privacy: typeof data.privacy === "string" ? data.privacy : usePrivacy,
        account: this.account.id,
        details: {
          photo_count: data.photo_count ?? imagesAttached,
          images_requested: imageUrls.length,
          images_attached: imagesAttached,
          image_warnings: imageErrors.length ? imageErrors : undefined,
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
        images_attached: imagesAttached,
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extFromMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "jpg";
}

/**
 * Load an image from https URL or data:image/…;base64,… into a Blob for multipart upload.
 */
async function resolveImageSource(
  source: string,
  baseName: string
): Promise<{ blob: Blob; filename: string } | null> {
  const src = (source || "").trim();
  if (!src) return null;

  // data URL
  const dataMatch = src.match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/
  );
  if (dataMatch) {
    try {
      const mime = dataMatch[1];
      const b64 = dataMatch[2].replace(/\s+/g, "");
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 32) return null;
      const blob = new Blob([buf], { type: mime });
      return { blob, filename: `${baseName}.${extFromMime(mime)}` };
    } catch {
      return null;
    }
  }

  if (!/^https?:\/\//i.test(src)) return null;

  try {
    const imgRes = await axios.get(src, {
      responseType: "arraybuffer",
      timeout: Math.max(config.requestTimeoutMs, 60000),
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent":
          "WebypostMcpServer/1.0 (+https://webypost.com; image fetch)",
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (imgRes.status < 200 || imgRes.status >= 300 || !imgRes.data) {
      return null;
    }
    const buf = Buffer.from(imgRes.data);
    if (buf.length < 32) return null;
    let mime = String(imgRes.headers["content-type"] || "image/jpeg")
      .split(";")[0]
      .trim();
    if (!mime.startsWith("image/")) {
      // sniff magic bytes
      if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
      else if (buf[0] === 0xff && buf[1] === 0xd8) mime = "image/jpeg";
      else if (buf[0] === 0x47 && buf[1] === 0x49) mime = "image/gif";
      else if (buf.toString("ascii", 0, 4) === "RIFF") mime = "image/webp";
      else mime = "image/jpeg";
    }
    const blob = new Blob([buf], { type: mime });
    return { blob, filename: `${baseName}.${extFromMime(mime)}` };
  } catch {
    return null;
  }
}

// silence unused in some builds
void hasCredentials;
