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
    version: "1.0.0",
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
            ? `Pass account="<id>" to publish_webypost_post or check_webypost_status.`
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
    "Log in to Webypost (if needed) and publish a text post as a chosen account. Provide title (optional), content (required), optional privacy, and optional account id.",
    {
      title: z
        .string()
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
      account: accountArg,
    },
    async ({ title, content, privacy, account }) => {
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
        const client = getClientForAccount(account);
        const result = await client.publishPost(
          title ?? "",
          content,
          privacy ?? config.defaultPrivacy
        );
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

  return server;
}
