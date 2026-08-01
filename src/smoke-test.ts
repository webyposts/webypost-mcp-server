/**
 * Smoke test without a full MCP client:
 * exercises WebypostClient + hits local /health.
 */
import { config, hasCredentials } from "./config.js";
import { WebypostClient } from "./webypost-client.js";

async function main() {
  console.log("=== Webypost MCP smoke test ===");
  console.log("Base URL:", config.webypostBaseUrl);
  console.log("Credentials configured:", hasCredentials());

  const client = new WebypostClient();
  const status = await client.checkStatus();
  console.log("\ncheck_webypost_status →");
  console.log(JSON.stringify(status, null, 2));

  if (status.ok && status.authenticated && process.env.SMOKE_PUBLISH === "1") {
    const pub = await client.publishPost(
      "MCP smoke title",
      `Automated smoke post from webypost-mcp-server at ${new Date().toISOString()}`,
      "Private"
    );
    console.log("\npublish_webypost_post →");
    console.log(JSON.stringify(pub, null, 2));
  } else if (!status.authenticated) {
    console.log(
      "\nSkipping publish (not authenticated). Set WEBYPOST_EMAIL/PASSWORD and re-run."
    );
  } else {
    console.log(
      "\nSkipping publish by default. Set SMOKE_PUBLISH=1 to post a Private test status."
    );
  }

  // Local MCP HTTP health (if server already running)
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/health`);
    const j = await r.json();
    console.log("\nGET /health →", j);
  } catch {
    console.log(
      `\n(MCP HTTP not running on port ${config.port} — start with: npm run dev)`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
