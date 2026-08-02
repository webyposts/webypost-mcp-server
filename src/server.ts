/**
 * MCP server definition — tools only (transport wired in index.ts).
 *
 * Schemas stay simple (string/enum only) for max client compatibility (Grok).
 * Avoid z.array / complex JSON Schema features that some clients drop.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, listAccountIds, resolveAccount } from "./config.js";
import {
  getClientForAccount,
  safePublishError,
  extractContentDirectives,
} from "./webypost-client.js";

function textResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

/** Split image URLs from a single string (comma / newline / space separated). */
function parseImageUrlList(...parts: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const s = String(part).trim();
    if (!s) continue;
    // data URLs must not be split on commas (base64 contains commas)
    if (/^data:image\//i.test(s)) {
      out.push(s);
      continue;
    }
    for (const piece of s.split(/[\n\r|]+|,\s*(?=https?:|data:)/)) {
      const u = piece.trim();
      if (u) out.push(u);
    }
  }
  // de-dupe, max 8
  return [...new Set(out)].slice(0, 8);
}

const accountArg = z
  .string()
  .optional()
  .describe(
    `Webypost account id. One of: ${
      listAccountIds().join(", ") || "(none yet)"
    }. Default: ${config.defaultAccountId}.`
  );

const privacyArg = z
  .enum(["Public", "Private", "Friends"])
  .optional()
  .describe("Privacy: Public, Private, or Friends. Default Public.");

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "webypost-mcp-server",
    version: "2.0.0",
  });

  // ── Always-visible capability dump (so Grok cannot claim text-only) ──
  server.tool(
    "describe_webypost_capabilities",
    "ALWAYS call this first if unsure what Webypost tools support. Returns the full tool list including IMAGE and ARTICLE support. Webypost MCP is NOT text-only.",
    {},
    async () => {
      return textResult({
        tool: "describe_webypost_capabilities",
        ok: true,
        version: "2.0.0",
        textOnly: false,
        supportsImages: true,
        supportsArticles: true,
        mcpUrl: "https://webypost-mcp-server.onrender.com/mcp",
        accounts: listAccountIds(),
        defaultAccount: config.defaultAccountId,
        tools: {
          describe_webypost_capabilities: {
            purpose: "List what this MCP can do (including images)",
            params: [],
          },
          list_webypost_accounts: {
            purpose: "List account ids",
            params: [],
          },
          check_webypost_status: {
            purpose: "Test login for an account",
            params: ["account"],
          },
          publish_webypost_post: {
            purpose: "Status/feed post; optional image",
            params: [
              "content (required)",
              "title",
              "privacy",
              "imageUrl (https image URL or data:image/…;base64)",
              "imageUrls (extra URLs, comma/newline separated)",
              "account",
            ],
          },
          publish_webypost_with_image: {
            purpose: "Status/feed post WITH a required photo",
            params: [
              "content (required)",
              "imageUrl (required)",
              "title",
              "privacy",
              "account",
            ],
          },
          publish_webypost_article: {
            purpose: "Long-form article (/article/… URL)",
            params: [
              "title (required)",
              "content (required)",
              "coverImageUrl (optional cover image URL)",
              "category",
              "subcategory",
              "metadesc",
              "keywords",
              "tags",
              "privacy",
              "account",
            ],
          },
        },
        imageWorkflow: [
          "1. Generate image with Grok Imagine",
          "2. Get a public https URL for that image (or data:image URL)",
          "3. Call publish_webypost_with_image with content + imageUrl + account",
          "   OR publish_webypost_post with content + imageUrl",
          "   OR publish_webypost_article with title + content + coverImageUrl",
        ],
        message:
          "Images ARE supported. Use publish_webypost_with_image (imageUrl required) or publish_webypost_post (imageUrl optional) or publish_webypost_article (coverImageUrl).",
      });
    }
  );

  server.tool(
    "list_webypost_accounts",
    "List configured Webypost account ids (emails masked).",
    {},
    async () => {
      const accounts = config.accounts.map((a) => {
        const email = a.email || "";
        const masked = email.includes("@")
          ? email.replace(/(^.).*(@.*$)/, "$1***$2")
          : email
            ? "***"
            : null;
        return {
          id: a.id,
          emailMasked: masked,
          isDefault: a.id === config.defaultAccountId,
        };
      });
      return textResult({
        tool: "list_webypost_accounts",
        ok: accounts.length > 0,
        defaultAccount: config.defaultAccountId,
        accounts,
        supportsImages: true,
        imageTools: [
          "publish_webypost_with_image",
          "publish_webypost_post (imageUrl)",
          "publish_webypost_article (coverImageUrl)",
        ],
      });
    }
  );

  server.tool(
    "check_webypost_status",
    "Verify site reachability and login for an account.",
    {
      account: accountArg,
    },
    async ({ account }) => {
      try {
        if (account && !resolveAccount(account)) {
          return textResult(
            {
              tool: "check_webypost_status",
              ok: false,
              message: `Unknown account "${account}". Known: ${listAccountIds().join(", ")}`,
            },
            true
          );
        }
        const client = getClientForAccount(account);
        const status = await client.checkStatus();
        return textResult({
          tool: "check_webypost_status",
          ...status,
          supportsImages: true,
          knownAccounts: listAccountIds(),
        });
      } catch (err) {
        return textResult(
          {
            tool: "check_webypost_status",
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          },
          true
        );
      }
    }
  );

  async function publishStatus(args: {
    title?: string;
    content: string;
    privacy?: "Public" | "Private" | "Friends";
    imageUrl?: string;
    imageUrls?: string;
    account?: string;
    toolName: string;
    requireImage?: boolean;
  }) {
    if (args.account && !resolveAccount(args.account)) {
      return textResult(
        {
          tool: args.toolName,
          ok: false,
          message: `Unknown account "${args.account}". Known: ${listAccountIds().join(", ")}`,
        },
        true
      );
    }
    const urls = parseImageUrlList(args.imageUrl, args.imageUrls);
    if (args.requireImage && urls.length === 0) {
      return textResult(
        {
          tool: args.toolName,
          ok: false,
          message:
            "imageUrl is required. Generate an image (Grok Imagine), then pass its public https URL (or data:image/…;base64,…) as imageUrl.",
        },
        true
      );
    }
    const client = getClientForAccount(args.account);
    const result = await client.publishPost({
      title: args.title ?? "",
      content: args.content,
      privacy: args.privacy ?? config.defaultPrivacy,
      imageUrls: urls.length ? urls : undefined,
    });
    return textResult(
      {
        tool: args.toolName,
        ...result,
        imagesRequested: urls.length,
      },
      !result.ok
    );
  }

  /**
   * Universal publish entry — works even when the client only knows
   * publish_webypost_post with title/content/privacy/account (Grok frozen schemas).
   * Routes to article editor when mode=article or [[MODE:article]] is in content.
   */
  async function publishUniversal(args: {
    title?: string;
    content: string;
    privacy?: "Public" | "Private" | "Friends";
    account?: string;
    mode?: string;
    articleId?: string | number;
    imageUrl?: string;
    imageUrls?: string;
    coverImageUrl?: string;
    category?: string;
    subcategory?: string;
    metadesc?: string;
    keywords?: string;
    tags?: string;
    toolName: string;
  }) {
    if (args.account && !resolveAccount(args.account)) {
      return textResult(
        {
          tool: args.toolName,
          ok: false,
          message: `Unknown account "${args.account}". Known: ${listAccountIds().join(", ")}`,
        },
        true
      );
    }

    const dir = extractContentDirectives(args.content);
    const modeRaw = (args.mode || dir.mode || "status").toLowerCase();
    const articleIdNum =
      Number(args.articleId) ||
      dir.articleId ||
      0;
    const isUpdate =
      modeRaw === "update" ||
      modeRaw === "edit" ||
      modeRaw === "revise" ||
      (articleIdNum > 0 &&
        (modeRaw === "article" || modeRaw === "update" || modeRaw === "edit"));
    const isArticle =
      modeRaw === "article" ||
      modeRaw === "editor" ||
      modeRaw === "longform" ||
      isUpdate;

    const privacy = args.privacy ?? config.defaultPrivacy;
    const client = getClientForAccount(args.account);

    if (isUpdate || (isArticle && articleIdNum > 0)) {
      const title = (args.title || "").trim();
      if (!title) {
        return textResult(
          {
            tool: args.toolName,
            ok: false,
            message:
              "Article UPDATE needs title + [[MODE:update]] + [[ARTICLE_ID:123]] (or articleId param).",
          },
          true
        );
      }
      if (articleIdNum < 1) {
        return textResult(
          {
            tool: args.toolName,
            ok: false,
            message:
              "Article UPDATE needs [[ARTICLE_ID:123]] or articleId=123 (the pid from the article URL).",
          },
          true
        );
      }
      const body = dir.cleanText;
      if (!body) {
        return textResult(
          {
            tool: args.toolName,
            ok: false,
            message:
              "Article body is empty after markers. Put full HTML body after [[MODE:update]] / [[ARTICLE_ID:…]].",
          },
          true
        );
      }
      const cover =
        (args.coverImageUrl || "").trim() ||
        dir.coverImageUrl ||
        undefined;

      const result = await client.updateArticle({
        articleId: articleIdNum,
        title,
        content: body,
        privacy,
        category: args.category || dir.category,
        subcategory: args.subcategory || dir.subcategory,
        metadesc: args.metadesc || dir.metadesc,
        keywords: args.keywords || dir.keywords,
        tags: args.tags || dir.tags,
        coverImageUrl: cover,
      });
      return textResult(
        {
          tool: args.toolName,
          mode: "update",
          ...result,
          hint: result.ok
            ? "Updated existing ARTICLE via peditor. URL should still contain /article/."
            : undefined,
        },
        !result.ok
      );
    }

    if (isArticle) {
      const title = (args.title || "").trim();
      if (!title) {
        return textResult(
          {
            tool: args.toolName,
            ok: false,
            message:
              "Article mode needs a title. Pass title=… and put [[MODE:article]] in content (or mode=article).",
          },
          true
        );
      }
      const body = dir.cleanText;
      if (!body) {
        return textResult(
          {
            tool: args.toolName,
            ok: false,
            message: "Article body is empty after removing markers. Put HTML after [[MODE:article]].",
          },
          true
        );
      }
      const cover =
        (args.coverImageUrl || "").trim() ||
        dir.coverImageUrl ||
        dir.imageUrls[0] ||
        parseImageUrlList(args.imageUrl, args.imageUrls)[0];

      const result = await client.publishArticle({
        title,
        content: body,
        privacy,
        category: args.category || dir.category,
        subcategory: args.subcategory || dir.subcategory,
        metadesc: args.metadesc || dir.metadesc,
        keywords: args.keywords || dir.keywords,
        tags: args.tags || dir.tags,
        coverImageUrl: cover,
      });
      return textResult(
        {
          tool: args.toolName,
          mode: "article",
          ...result,
          hint: result.ok
            ? "Published as ARTICLE (editor). URL should contain /article/."
            : undefined,
        },
        !result.ok
      );
    }

    // Status / feed post
    const extraUrls = parseImageUrlList(args.imageUrl, args.imageUrls);
    const allImages = [...dir.imageUrls, ...extraUrls];
    const result = await client.publishPost({
      title: args.title ?? "",
      content: dir.cleanText,
      privacy,
      imageUrls: allImages.length ? allImages : undefined,
    });
    return textResult(
      {
        tool: args.toolName,
        mode: "status",
        ...result,
        imagesRequested: allImages.length,
      },
      !result.ok
    );
  }

  server.tool(
    "publish_webypost_post",
    "UNIVERSAL Webypost publisher: status post, CREATE article, or UPDATE article (peditor). STATUS: text + [[IMAGE:https://…]]. CREATE article: [[MODE:article]] + HTML + [[COVER:…]]. UPDATE article: [[MODE:update]] + [[ARTICLE_ID:231]] + full HTML body; optional new [[COVER:…]] (omit cover to keep current). Body images re-hosted. Works with frozen Grok title/content/privacy/account schemas.",
    {
      content: z
        .string()
        .min(1)
        .describe(
          "Body text OR HTML. Markers: [[MODE:article]] create; [[MODE:update]] edit via peditor; [[ARTICLE_ID:123]] required for update; [[COVER:https://…]] cover (create or replace); [[CATEGORY:]]; [[SUBCATEGORY:]]; [[FIGURE:https://…|caption]] body image (re-hosted); [[IMAGE:https://…]] status photos; [[METADESC:]]; [[KEYWORDS:]]. HTML <img src> also re-hosted on create/update (max 15)."
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Title. Required for article create and update. Optional for status posts."
        ),
      privacy: privacyArg,
      account: accountArg,
      mode: z
        .string()
        .optional()
        .describe(
          'Mode: "status" | "article" (create) | "update" (edit peditor). Prefer [[MODE:update]] + [[ARTICLE_ID:n]] in content if this field is missing.'
        ),
      articleId: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Existing article id (pid) for updates. Or use [[ARTICLE_ID:231]] in content."
        ),
      imageUrl: z
        .string()
        .optional()
        .describe("Optional status photo URL (public https)."),
      imageUrls: z
        .string()
        .optional()
        .describe("Optional extra status photo URLs (comma/newline separated)."),
      coverImageUrl: z
        .string()
        .optional()
        .describe(
          "Optional article cover URL. Or use [[COVER:https://…]] in content."
        ),
      category: z
        .string()
        .optional()
        .describe('Article category e.g. "Tech Reviews & Gadgets".'),
      subcategory: z
        .string()
        .optional()
        .describe('Article subcategory e.g. "Upcoming Tech Launches".'),
      metadesc: z.string().optional().describe("Article SEO meta description."),
      keywords: z.string().optional().describe("Article SEO keywords."),
      tags: z.string().optional().describe("Article tags."),
    },
    async (args) => {
      try {
        return await publishUniversal({
          ...args,
          toolName: "publish_webypost_post",
        });
      } catch (err) {
        return textResult(
          { tool: "publish_webypost_post", ...safePublishError(err) },
          true
        );
      }
    }
  );

  server.tool(
    "update_webypost_article",
    "Update an existing Webypost ARTICLE via peditor (title, HTML body, privacy, category, optional new cover, body images re-hosted). Requires articleId (pid from /article/URL).",
    {
      articleId: z
        .union([z.string(), z.number()])
        .describe("Existing article id / pid (e.g. 231 from …/article/231)."),
      title: z.string().min(1).describe("Updated article title."),
      content: z
        .string()
        .min(1)
        .describe(
          "Full updated HTML body. External <img> and [[FIGURE:url|cap]] are re-hosted."
        ),
      privacy: privacyArg,
      account: accountArg,
      coverImageUrl: z
        .string()
        .optional()
        .describe(
          "Optional NEW cover https URL. Omit to keep the current cover."
        ),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      metadesc: z.string().optional(),
      keywords: z.string().optional(),
      tags: z.string().optional(),
    },
    async (args) => {
      try {
        if (args.account && !resolveAccount(args.account)) {
          return textResult(
            {
              tool: "update_webypost_article",
              ok: false,
              message: `Unknown account. Known: ${listAccountIds().join(", ")}`,
            },
            true
          );
        }
        const id = Number(args.articleId);
        if (!Number.isFinite(id) || id < 1) {
          return textResult(
            {
              tool: "update_webypost_article",
              ok: false,
              message: "articleId must be a positive number.",
            },
            true
          );
        }
        const client = getClientForAccount(args.account);
        const result = await client.updateArticle({
          articleId: id,
          title: args.title,
          content: args.content,
          privacy: args.privacy ?? config.defaultPrivacy,
          coverImageUrl: args.coverImageUrl,
          category: args.category,
          subcategory: args.subcategory,
          metadesc: args.metadesc,
          keywords: args.keywords,
          tags: args.tags,
        });
        return textResult(
          { tool: "update_webypost_article", mode: "update", ...result },
          !result.ok
        );
      } catch (err) {
        return textResult(
          { tool: "update_webypost_article", ...safePublishError(err) },
          true
        );
      }
    }
  );

  server.tool(
    "publish_webypost_with_image",
    "Publish a Webypost STATUS post WITH A PHOTO. imageUrl is REQUIRED. Workflow: (1) generate image with Grok Imagine (2) pass public https image URL as imageUrl (3) call this tool with content + imageUrl + account.",
    {
      content: z
        .string()
        .min(1)
        .describe("Required post body text."),
      imageUrl: z
        .string()
        .min(1)
        .describe(
          "REQUIRED. Public https URL of the image (or data:image/…;base64,…). From Grok Imagine or any CDN."
        ),
      title: z
        .string()
        .optional()
        .describe("Optional short title."),
      privacy: privacyArg,
      account: accountArg,
    },
    async ({ content, imageUrl, title, privacy, account }) => {
      try {
        return await publishStatus({
          content,
          title,
          privacy,
          imageUrl,
          account,
          toolName: "publish_webypost_with_image",
          requireImage: true,
        });
      } catch (err) {
        return textResult(
          {
            tool: "publish_webypost_with_image",
            ...safePublishError(err),
          },
          true
        );
      }
    }
  );

  server.tool(
    "publish_webypost_article",
    "Publish a long-form Webypost ARTICLE (not a short status). Optional cover: set coverImageUrl to a public https image URL after generating with Imagine.",
    {
      title: z
        .string()
        .min(1)
        .describe("Required article headline."),
      content: z
        .string()
        .min(1)
        .describe(
          "Required article body (HTML preferred; plain text is wrapped in paragraphs)."
        ),
      coverImageUrl: z
        .string()
        .optional()
        .describe(
          "OPTIONAL cover image URL (public https or data:image/…;base64,…)."
        ),
      category: z
        .string()
        .optional()
        .describe(
          'Category e.g. "Tech Reviews & Gadgets" or "AI Tools & Automation".'
        ),
      subcategory: z
        .string()
        .optional()
        .describe('Sub-category e.g. "Upcoming Tech Launches".'),
      metadesc: z
        .string()
        .optional()
        .describe("SEO meta description (~155 chars)."),
      keywords: z
        .string()
        .optional()
        .describe("Comma-separated SEO keywords."),
      tags: z.string().optional().describe("Comma-separated tags."),
      privacy: privacyArg,
      account: accountArg,
    },
    async ({
      title,
      content,
      coverImageUrl,
      category,
      subcategory,
      metadesc,
      keywords,
      tags,
      privacy,
      account,
    }) => {
      try {
        if (account && !resolveAccount(account)) {
          return textResult(
            {
              tool: "publish_webypost_article",
              ok: false,
              message: `Unknown account "${account}". Known: ${listAccountIds().join(", ")}`,
            },
            true
          );
        }
        const client = getClientForAccount(account);
        const result = await client.publishArticle({
          title,
          content,
          privacy: privacy ?? config.defaultPrivacy,
          category,
          subcategory,
          metadesc,
          keywords,
          tags,
          coverImageUrl,
        });
        return textResult(
          { tool: "publish_webypost_article", ...result },
          !result.ok
        );
      } catch (err) {
        return textResult(
          {
            tool: "publish_webypost_article",
            ...safePublishError(err),
          },
          true
        );
      }
    }
  );

  return server;
}
