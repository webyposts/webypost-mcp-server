/**
 * MCP server definition — tools only (transport wired in index.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { WebypostClient, safePublishError } from "./webypost-client.js";

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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "webypost-mcp-server",
    version: "1.0.0",
  });

  // Shared client instance keeps cookie jar across tool calls in a process
  const client = new WebypostClient();

  server.tool(
    "check_webypost_status",
    "Verify the MCP server can reach webypost.com (or WEBYPOST_BASE_URL) and that configured credentials are valid. Returns JSON with ok, reachable, authenticated, and a human message.",
    {},
    async () => {
      try {
        const status = await client.checkStatus();
        return textResult(
          {
            tool: "check_webypost_status",
            ...status,
            configuredBaseUrl: config.webypostBaseUrl,
            credentialsConfigured: Boolean(
              config.email && config.password
            ),
          },
          !status.ok
        );
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

  server.tool(
    "publish_webypost_post",
    "Log in to Webypost (if needed) and publish a text post. Provide title (optional display title) and content (required post body). Returns the published story URL when successful.",
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
    },
    async ({ title, content, privacy }) => {
      try {
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
