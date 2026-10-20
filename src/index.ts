#!/usr/bin/env node
/**
 * Oura MCP Server
 *
 * An MCP server that exposes Oura Ring data with smart analysis tools.
 * Designed to give LLMs human-readable summaries alongside raw data.
 *
 * CLI Commands:
 *   npx oura-ring-mcp          - Start the MCP server (stdio transport)
 *   npx oura-ring-mcp --http   - Start with HTTP transport (for remote deployment)
 *   npx oura-ring-mcp auth     - Authenticate with Oura via OAuth
 *   npx oura-ring-mcp logout   - Clear stored credentials
 *   npx oura-ring-mcp status   - Show authentication status
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { OuraClient } from "./client.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { getOAuthConfigFromEnv } from "./auth/oauth.js";
import { TokenManager } from "./auth/token-manager.js";

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
const VERSION: string = pkg.version;

// ─────────────────────────────────────────────────────────────
// CLI Command Handling
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const useHttpTransport = args.includes("--http") || args.includes("-H");
const useStaticBearerMode =
  useHttpTransport && (process.env.MCP_AUTH_MODE ?? "").toLowerCase() === "static";

// Handle CLI subcommands
if (["auth", "logout", "status"].includes(command)) {
  // Dynamic import to avoid loading auth modules unless needed
  const { runAuthFlow, runLogout, showAuthStatus } = await import("./auth/cli.js");

  switch (command) {
    case "auth":
      await runAuthFlow();
      break;
    case "logout":
      await runLogout();
      break;
    case "status":
      await showAuthStatus();
      break;
  }
  process.exit(0);
}

// OAuth is the default. An explicit access token is a temporary, non-refreshing
// override only when OAuth app credentials have not been configured.
const oauthConfig = getOAuthConfigFromEnv();
const overrideToken = !useStaticBearerMode && !oauthConfig ? process.env.OURA_ACCESS_TOKEN : undefined;
if (process.env.OURA_PERSONAL_ACCESS_TOKEN) {
  throw new Error("OURA_PERSONAL_ACCESS_TOKEN is no longer supported. Configure OURA_CLIENT_ID/OURA_CLIENT_SECRET and run `oura-ring-mcp auth`.");
}
if (!oauthConfig && !overrideToken) {
  throw new Error("Configure OURA_CLIENT_ID and OURA_CLIENT_SECRET, then run `oura-ring-mcp auth`.");
}
if (useHttpTransport && !process.env.MCP_SECRET && (useStaticBearerMode || !oauthConfig)) {
  throw new Error("HTTP bearer authentication requires MCP_SECRET.");
}
if (overrideToken) {
  console.error("OURA_ACCESS_TOKEN is a temporary override without automatic refresh. Migrate to OAuth with `oura-ring-mcp auth`.");
}

const server = new McpServer({
  name: "oura-mcp",
  version: VERSION,
});

const ouraClient = new OuraClient({ accessToken: overrideToken ?? "" });
let tokenManager: TokenManager | undefined;
if (oauthConfig) {
  tokenManager = new TokenManager({
    oauthConfig,
    seedRefreshToken: process.env.OURA_REFRESH_TOKEN,
    onTokenUpdate: (token) => ouraClient.setAccessToken(token),
  });
  try {
    await tokenManager.initialize(useHttpTransport && !useStaticBearerMode);
  } catch (error) {
    tokenManager.stop();
    throw new Error(`Failed to initialize Oura OAuth: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  ouraClient.setOnUnauthorized(() => tokenManager!.refresh());
  // Timers are unref'ed; stop them when the transport closes as well.
  server.server.onclose = () => tokenManager?.stop();
}

// Register all tools, resources, and prompts with the server
registerTools(server, ouraClient);
registerResources(server, ouraClient);
registerPrompts(server);

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

async function main() {
  if (useHttpTransport) {
    // HTTP transport for remote deployment
    const { startHttpServer } = await import("./transports/http.js");
    await startHttpServer(server, { tokenManager });
  } else {
    // Stdio transport for local use (Claude Desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Oura MCP server running on stdio");
  }
}

await main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
