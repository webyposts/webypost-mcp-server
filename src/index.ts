/**
 * HTTP MCP server — dual transport for maximum client compatibility:
 *
 *   POST/GET/DELETE /mcp   — Streamable HTTP (MCP 2025-03 / 2025-11)  ← preferred by modern clients (Grok)
 *   GET  /sse              — Legacy SSE stream (MCP 2024-11-05)
 *   POST /messages         — Legacy SSE client messages (?sessionId=)
 *   GET  /health           — Liveness JSON
 *   GET  /                 — Human info page
 *
 * Public URL for Grok after ngrok:
 *   https://xxxx.ngrok-free.app/mcp
 *   (also works: https://xxxx.ngrok-free.app/sse for older SSE clients)
 */
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { createMcpServer } from "./server.js";

// Bind on 0.0.0.0 for ngrok/Render; do not force localhost DNS rebinding block
const app = createMcpExpressApp({
  host: config.host === "127.0.0.1" || config.host === "localhost" ? config.host : "0.0.0.0",
});

// Extra CORS for browser-based MCP frontends (Grok web)
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/** Streamable HTTP sessions (stateful) */
const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
/** Legacy SSE sessions */
const sseSessions = new Map<string, SSEServerTransport>();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "webypost-mcp-server",
    baseUrl: config.webypostBaseUrl,
    port: config.port,
    credentialsConfigured: config.accounts.length > 0,
    accounts: config.accounts.map((a) => a.id),
    defaultAccount: config.defaultAccountId,
    version: "2.0.0",
    supportsImages: true,
    supportsArticles: true,
    tools: [
      "describe_webypost_capabilities",
      "list_webypost_accounts",
      "check_webypost_status",
      "publish_webypost_post",
      "publish_webypost_with_image",
      "publish_webypost_article",
      "update_webypost_article",
    ],
    imageParams: {
      publish_webypost_post: [
        "imageUrl",
        "imageUrls",
        "[[COVER:]]",
        "[[FIGURE:]]",
        "[[MODE:update]]+[[ARTICLE_ID:]]",
      ],
      publish_webypost_with_image: ["imageUrl (required)"],
      publish_webypost_article: ["coverImageUrl"],
      update_webypost_article: ["coverImageUrl", "body img rehost"],
    },
    transports: {
      streamableHttp: "/mcp",
      legacySse: "/sse",
      legacyMessages: "/messages?sessionId=…",
    },
    grokHint:
      "MCP URL: https://webypost-mcp-server.onrender.com/mcp — NOT text-only. Use publish_webypost_with_image (required imageUrl) or publish_webypost_post (optional imageUrl). After deploy, fully remove & re-add the connector, then NEW chat. Call describe_webypost_capabilities first.",
  });
});


app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Webypost MCP Server</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.55;color:#122}
  code{background:#f2f5f3;padding:2px 6px;border-radius:4px}
  .ok{color:#056636;font-weight:700}
  pre{background:#0f1a14;color:#d7ffe8;padding:14px;border-radius:10px;overflow:auto}
</style></head><body>
  <h1>Webypost MCP Server</h1>
  <p class="ok">● Running</p>
  <h2>Connect Grok here</h2>
  <p>Use a <strong>public HTTPS</strong> URL ending in <code>/mcp</code> (recommended):</p>
  <pre>https://YOUR-SERVICE.onrender.com/mcp
https://YOUR-SUBDOMAIN.ngrok-free.app/mcp</pre>
  <p>Legacy clients may use <code>/sse</code> instead of <code>/mcp</code>.</p>
  <ul>
    <li><a href="/health"><code>/health</code></a></li>
    <li>Target site: <code>${config.webypostBaseUrl}</code></li>
    <li>Accounts: <code>${config.accounts.map((a) => a.id).join(", ") || "(none)"}</code> (default: <code>${config.defaultAccountId}</code>)</li>
    <li>Tools: <code>describe_webypost_capabilities</code>, <code>publish_webypost_post</code>, <code>publish_webypost_with_image</code>, <code>publish_webypost_article</code></li>
    <li>Images: yes — pass <code>imageUrl</code> / <code>coverImageUrl</code></li>
  </ul>
  <h2>Local only (not reachable by Grok)</h2>
  <pre>http://127.0.0.1:${config.port}/mcp
http://127.0.0.1:${config.port}/sse</pre>
  <p>Deploy on Render for a permanent URL, or use ngrok for a temporary tunnel.</p>
</body></html>`);
});

//=============================================================================
// STREAMABLE HTTP  (modern — Grok / current MCP clients)
//=============================================================================

/**
 * Stateless Streamable HTTP handler (most reliable for remote clients).
 * Each request gets a fresh server+transport; no sticky session required.
 */
async function handleStatelessMcp(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // stateless: no session ID tracking
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp streamable] error", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal server error",
        },
        id: null,
      });
    }
  }
}

/**
 * Also support stateful mode when client sends Mcp-Session-Id (optional).
 * Falls back to stateless for initialize without session.
 */
app.all("/mcp", async (req: Request, res: Response) => {
  console.log(`[mcp] ${req.method} /mcp`);

  try {
    const sessionId = String(req.headers["mcp-session-id"] || "");

    // Existing stateful session
    if (sessionId && streamableSessions.has(sessionId)) {
      const transport = streamableSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New initialize → create stateful transport if client wants sessions
    if (
      req.method === "POST" &&
      !sessionId &&
      req.body &&
      isInitializeRequest(req.body)
    ) {
      // Prefer stateless for Grok reliability; still works for initialize
      await handleStatelessMcp(req, res);
      return;
    }

    // Stateless for any other POST/GET without session
    if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
      await handleStatelessMcp(req, res);
      return;
    }

    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  } catch (err) {
    console.error("[mcp] unhandled", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal server error",
        },
        id: null,
      });
    }
  }
});

//=============================================================================
// LEGACY HTTP+SSE  (protocol 2024-11-05)
//=============================================================================

app.get("/sse", async (req: Request, res: Response) => {
  console.log("[mcp] GET /sse (legacy SSE)");
  try {
    const server = createMcpServer();
    // Absolute path for message posts — required behind reverse proxies / ngrok
    const transport = new SSEServerTransport("/messages", res);
    const sid = transport.sessionId;
    sseSessions.set(sid, transport);

    transport.onclose = () => {
      sseSessions.delete(sid);
      void server.close();
    };
    res.on("close", () => {
      sseSessions.delete(sid);
    });

    await server.connect(transport);
    console.log(`[mcp] SSE session ${sid}`);
  } catch (err) {
    console.error("[mcp] SSE error", err);
    if (!res.headersSent) {
      res.status(500).send("Error establishing SSE stream");
    }
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  console.log(`[mcp] POST /messages sessionId=${sessionId}`);
  if (!sessionId) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Missing sessionId query parameter" },
      id: null,
    });
    return;
  }
  const transport = sseSessions.get(sessionId);
  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Unknown or expired sessionId. Connect to GET /sse first.",
      },
      id: null,
    });
    return;
  }
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("[mcp] messages error", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
        id: null,
      });
    }
  }
});

// Avoid unused import warning if tree-shaken oddly
void randomUUID;

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`[webypost-mcp] listening on http://${config.host}:${config.port}`);
  console.log(`[webypost-mcp] health           → http://127.0.0.1:${config.port}/health`);
  console.log(`[webypost-mcp] Streamable HTTP → http://127.0.0.1:${config.port}/mcp   ← use this for Grok`);
  console.log(`[webypost-mcp] Legacy SSE      → http://127.0.0.1:${config.port}/sse`);
  console.log(`[webypost-mcp] target site     → ${config.webypostBaseUrl}`);
  console.log(
    `[webypost-mcp] accounts         → ${config.accounts.map((a) => a.id).join(", ") || "(none)"} (default: ${config.defaultAccountId})`
  );
  console.log("");
  console.log("Public (Grok) via ngrok:");
  console.log(`  ngrok http ${config.port}`);
  console.log(`  → paste https://XXXX.ngrok-free.app/mcp into Grok`);
});

function shutdown(signal: string) {
  console.log(`[webypost-mcp] ${signal} shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
