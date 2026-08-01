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

  server.tool(
    "publish_webypost_post",
    "Publish a Webypost STATUS post. OPTIONAL image: set imageUrl to a public https image URL (from Grok Imagine) or data:image URL. For required photo posts use publish_webypost_with_image instead. NOT text-only — imageUrl is supported.",
    {
      content: z
        .string()
        .min(1)
        .describe("Required post body text."),
      title: z
        .string()
        .optional()
        .describe("Optional short title. Can be empty."),
      privacy: privacyArg,
      imageUrl: z
        .string()
        .optional()
        .describe(
          "OPTIONAL image URL to attach as post photo. Use public https://… link from Imagine, or data:image/png;base64,…. Server downloads and uploads to Webypost."
        ),
      imageUrls: z
        .string()
        .optional()
        .describe(
          "OPTIONAL extra image URLs as one string (comma or newline separated). Max 8 total with imageUrl."
        ),
      account: accountArg,
    },
    async ({ content, title, privacy, imageUrl, imageUrls, account }) => {
      try {
        return await publishStatus({
          content,
          title,
          privacy,
          imageUrl,
          imageUrls,
          account,
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
