/**
 * MCP server definition — tools only (transport wired in index.ts).
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

const accountArg = z
  .string()
  .optional()
  .describe(
    `Which Webypost account to use. Configured ids: ${
      listAccountIds().join(", ") || "(none yet)"
    }. Omit to use default "${config.defaultAccountId}".`
  );

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "webypost-mcp-server",
    // Bump when tools/params change so clients (Grok) treat this as a new schema
    version: "1.2.0",
  });

  server.tool(
    "list_webypost_accounts",
    "List configured Webypost account ids available on this MCP server (emails are masked). Use an id as the `account` argument on publish/status tools.",
    {},
    async () => {
      const accounts = config.accounts.map((a) => {
        const email = a.email || "";
        const masked =
          email.includes("@")
            ? email.replace(/(^.).*(@.*$)/, "$1***$2")
            : email
              ? "***"
              : null;
        return {
          id: a.id,
          emailMasked: masked,
          isDefault: a.id === config.defaultAccountId,
          hasPassword: Boolean(a.password),
          hasSessionCookie: Boolean(a.sessionCookie),
        };
      });
      return textResult({
        tool: "list_webypost_accounts",
        ok: accounts.length > 0,
        defaultAccount: config.defaultAccountId,
        count: accounts.length,
        accounts,
        message:
          accounts.length > 0
            ? `Pass account="<id>" to publish_webypost_post, publish_webypost_article, or check_webypost_status.`
            : "No accounts configured. Set WEBYPOST_ACCOUNTS on the server.",
      });
    }
  );

  server.tool(
    "check_webypost_status",
    "Verify the MCP server can reach webypost.com and that the selected account credentials are valid. Optional `account` id selects which login to test.",
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
              message: `Unknown account "${account}". Known: ${listAccountIds().join(", ") || "(none)"}`,
              knownAccounts: listAccountIds(),
            },
            true
          );
        }
        const client = getClientForAccount(account);
        const status = await client.checkStatus();
        return textResult(
          {
            tool: "check_webypost_status",
            ...status,
            configuredBaseUrl: config.webypostBaseUrl,
            knownAccounts: listAccountIds(),
            defaultAccount: config.defaultAccountId,
            credentialsConfigured: config.accounts.length > 0,
          },
          !status.ok
        );
      } catch (err) {
        return textResult(
          {
            tool: "check_webypost_status",
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            knownAccounts: listAccountIds(),
          },
          true
        );
      }
    }
  );

  server.tool(
    "publish_webypost_post",
    "Publish a Webypost status/feed post (with optional images). Workflow for illustrated posts: (1) generate image(s) with Grok Imagine, (2) pass the public https image URL(s) in imageUrls, (3) call this tool. Supports up to 8 images. Also accepts data:image/…;base64,… URLs.",
    {
      title: z
        .string()
        .optional()
        .default("")
        .describe(
          "Optional short title for the post (maps to Webypost titles field). Can be empty string."
        ),
      content: z
        .string()
        .min(1)
        .describe(
          "Required main post body text (maps to Webypost name/content field)."
        ),
      privacy: z
        .enum(["Public", "Private", "Friends"])
        .optional()
        .describe(
          "Optional privacy. Defaults to WEBYPOST_DEFAULT_PRIVACY or Public."
        ),
      imageUrls: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
          "Optional list of image URLs to attach (max 8). Use public https links from Grok Imagine / CDN, or data:image/png;base64,… strings. Server downloads them and uploads to Webypost as post photos."
        ),
      imageUrl: z
        .string()
        .optional()
        .describe(
          "Optional single image URL (shorthand for imageUrls with one item)."
        ),
      account: accountArg,
    },
    async ({ title, content, privacy, imageUrls, imageUrl, account }) => {
      try {
        if (account && !resolveAccount(account)) {
          return textResult(
            {
              tool: "publish_webypost_post",
              ok: false,
              message: `Unknown account "${account}". Known: ${listAccountIds().join(", ") || "(none)"}`,
              knownAccounts: listAccountIds(),
            },
            true
          );
        }
        const urls = [
          ...(imageUrls || []),
          ...(imageUrl ? [imageUrl] : []),
        ].filter(Boolean);
        const client = getClientForAccount(account);
        const result = await client.publishPost({
          title: title ?? "",
          content,
          privacy: privacy ?? config.defaultPrivacy,
          imageUrls: urls.length ? urls : undefined,
        });
        return textResult(
          {
            tool: "publish_webypost_post",
            ...result,
          },
          !result.ok
        );
      } catch (err) {
        return textResult(
          {
            tool: "publish_webypost_post",
            ...safePublishError(err),
          },
          true
        );
      }
    }
  );

  server.tool(
    "publish_webypost_article",
    "Publish a long-form Webypost ARTICLE (not a short status post). For a cover image: generate with Grok Imagine first, then pass coverImageUrl (public https or data:image/…;base64,…). Also accepts title, body HTML, category, subcategory, SEO fields, privacy, account.",
    {
      title: z
        .string()
        .min(1)
        .describe("Required article title (shown as the article headline)."),
      content: z
        .string()
        .min(1)
        .describe(
          "Required article body. HTML preferred (e.g. <p>…</p>); plain text is auto-wrapped into paragraphs."
        ),
      privacy: z
        .enum(["Public", "Private", "Friends"])
        .optional()
        .describe("Optional privacy. Defaults to Public / env default."),
      category: z
        .string()
        .optional()
        .describe(
          'Main category (department). Examples: "Tech Reviews & Gadgets", "AI Tools & Automation", "Blogging". Defaults to Tech Reviews & Gadgets.'
        ),
      subcategory: z
        .string()
        .optional()
        .describe(
          'Sub-category. Examples: "Upcoming Tech Launches", "Smartphone Reviews", "ChatGPT & LLM Guides". Defaults to Upcoming Tech Launches.'
        ),
      metadesc: z
        .string()
        .optional()
        .describe("Optional SEO meta description (~155 chars). Auto from body if omitted."),
      keywords: z
        .string()
        .optional()
        .describe("Optional comma-separated SEO keywords. Auto from title if omitted."),
      tags: z
        .string()
        .optional()
        .describe("Optional comma-separated tags. Defaults to keywords."),
      coverImageUrl: z
        .string()
        .optional()
        .describe(
          "Optional public https image URL for the featured cover. Omitted = no cover."
        ),
      account: accountArg,
    },
    async ({
      title,
      content,
      privacy,
      category,
      subcategory,
      metadesc,
      keywords,
      tags,
      coverImageUrl,
      account,
    }) => {
      try {
        if (account && !resolveAccount(account)) {
          return textResult(
            {
              tool: "publish_webypost_article",
              ok: false,
              message: `Unknown account "${account}". Known: ${listAccountIds().join(", ") || "(none)"}`,
              knownAccounts: listAccountIds(),
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
          {
            tool: "publish_webypost_article",
            ...result,
          },
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
