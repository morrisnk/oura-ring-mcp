/**
 * HTTP Transport for Oura MCP Server
 *
 * Enables remote deployment via Streamable HTTP transport.
 * Authentication flow:
 *   1. OAuth 2.1 proxied through Oura (for Claude.ai connector)
 *   2. Static bearer token via MCP_SECRET (backward compat for Claude Desktop)
 *
 * OAuth endpoints (handled by MCP SDK's mcpAuthRouter):
 *   GET  /.well-known/oauth-authorization-server   — OAuth metadata discovery
 *   GET  /.well-known/oauth-protected-resource/mcp — Protected resource metadata
 *   POST /register                                  — Dynamic client registration
 *   GET  /authorize                                 — Redirects to Oura OAuth
 *   POST /token                                     — Token exchange
 *   POST /revoke                                    — Token revocation
 *
 * Custom route:
 *   GET  /oauth/callback — Handles Oura's redirect after user authorizes
 */
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  OuraMcpOAuthProvider,
  type OuraMcpOAuthProviderOptions,
} from "../auth/mcp-oauth-provider.js";
import { getOAuthConfigFromEnv } from "../auth/oauth.js";
import type { TokenManager } from "../auth/token-manager.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface HttpTransportOptions {
  /** Port to listen on (default: process.env.PORT || 3000) */
  port?: number;
  /** Secret for bearer token auth (backward compat with MCP_SECRET) */
  secret?: string;
  /** Disable MCP transport sessions (default: true); OAuth still requires one instance */
  stateless?: boolean;
  /** Shared owner of persisted Oura credentials. */
  tokenManager?: TokenManager;
}

// ─────────────────────────────────────────────────────────────
// Base URL Resolution
// ─────────────────────────────────────────────────────────────

function resolveBaseUrl(port: number): URL {
  if (process.env.BASE_URL) {
    return new URL(process.env.BASE_URL);
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return new URL(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }
  return new URL(`http://localhost:${port}`);
}

// ─────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────

export async function startHttpServer(
  server: McpServer,
  options: HttpTransportOptions = {}
): Promise<void> {
  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);
  const secret = options.secret ?? process.env.MCP_SECRET;
  const stateless = options.stateless ?? true;

  const baseUrl = resolveBaseUrl(port);

  // Check for Oura OAuth credentials
  const ouraClientId = process.env.OURA_CLIENT_ID;
  const ouraClientSecret = process.env.OURA_CLIENT_SECRET;
  const hasOuraOAuth = !!(ouraClientId && ouraClientSecret);

  // `static` disables the public MCP OAuth 2.1 provider — MCP clients must
  // present MCP_SECRET as a bearer token. Oura API tokens are managed
  // server-side (e.g. via TokenManager) and are not exposed to clients.
  const authMode = (process.env.MCP_AUTH_MODE ?? "").toLowerCase();
  const useStaticBearerMode = authMode === "static";

  if (useStaticBearerMode && !secret) {
    throw new Error("MCP_AUTH_MODE=static requires MCP_SECRET to be set.");
  }
  if (!useStaticBearerMode && !hasOuraOAuth && !secret) {
    throw new Error("HTTP transport requires OAuth configuration or MCP_SECRET.");
  }

  const app = express();

  // Trust Railway's load balancer (fixes X-Forwarded-For rate limit errors)
  app.set("trust proxy", 1);

  // Parse JSON bodies
  app.use(express.json());

  // CORS for remote clients
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id"
    );
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check endpoint (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "oura-mcp" });
  });

  // ── Auth Setup ───────────────────────────────────────────

  if (useStaticBearerMode) {
    // Static-bearer-only mode. No public OAuth 2.1 endpoints; MCP clients
    // authenticate with MCP_SECRET. The caller is responsible for keeping
    // `ouraClient` supplied with a valid Oura token (e.g. via TokenManager).
    app.use((req, res, next) => {
      if (req.path === "/health") return next();
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const [scheme, token] = authHeader.split(" ");
      if (scheme !== "Bearer" || !secret || token !== secret) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      next();
    });
    console.error(
      "Static bearer token authentication enabled (MCP_AUTH_MODE=static)"
    );
  } else if (!hasOuraOAuth) {
    // No Oura OAuth credentials — fall back to static MCP_SECRET only
    console.error(
      "Oura OAuth not configured (missing OURA_CLIENT_ID/OURA_CLIENT_SECRET).\n" +
        "Claude.ai connector will not work. Use MCP_SECRET for Claude Desktop."
    );

    if (secret) {
      // Simple bearer token auth (legacy)
      app.use((req, res, next) => {
        if (req.path === "/health") return next();
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          res.status(401).json({ error: "Missing Authorization header" });
          return;
        }
        const [scheme, token] = authHeader.split(" ");
        if (scheme !== "Bearer" || token !== secret) {
          res.status(401).json({ error: "Invalid credentials" });
          return;
        }
        next();
      });
      console.error("Static bearer token authentication enabled");
    }
  } else {
    // Oura OAuth configured — set up full OAuth 2.1 flow
    const providerOptions: OuraMcpOAuthProviderOptions = {
      baseUrl,
      ouraClientId: ouraClientId!,
      ouraClientSecret: ouraClientSecret!,
      staticSecret: secret,
      ouraScopes: getOAuthConfigFromEnv()?.scopes,
      onOuraTokens: async (credentials) => {
        if (!options.tokenManager) throw new Error("Oura token manager is not configured.");
        await options.tokenManager.setCredentials(credentials);
      },
    };

    const oauthProvider = new OuraMcpOAuthProvider(providerOptions);

    // Mount OAuth endpoints (metadata, authorize, token, register, revoke)
    // resourceServerUrl is set to baseUrl (root) so Claude.ai can find
    // protected resource metadata at /.well-known/oauth-protected-resource
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: baseUrl,
        baseUrl: baseUrl,
        resourceServerUrl: baseUrl,
        resourceName: "Oura MCP Server",
        scopesSupported: [],
      })
    );

    // Oura OAuth callback — handles redirect from Oura after user authorizes
    app.get("/oauth/callback", async (req: Request, res: Response) => {
      try {
        const code = typeof req.query.code === "string" ? req.query.code : undefined;
        const state = typeof req.query.state === "string" ? req.query.state : undefined;
        const error = typeof req.query.error === "string" ? req.query.error : undefined;

        if (error) {
          oauthProvider.handleOuraDenied(state ?? "");
          res.status(400).type("text").send("Oura authorization denied. Please reconnect and try again.");
          return;
        }

        if (!code || !state) {
          res.status(400).json({ error: "Missing code or state parameter" });
          return;
        }

        // Exchange Oura code and redirect to MCP client
        const redirectUrl = await oauthProvider.handleOuraCallback(code, state);
        res.redirect(302, redirectUrl);
      } catch (err) {
        console.error("OAuth callback failed:", err instanceof Error ? err.message : "unknown error");
        res.status(400).type("text").send("Oura authorization could not be completed. Please try again or check the server logs.");
      }
    });

    // Protect MCP endpoint with bearer auth
    const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

    // ── MCP Endpoint ─────────────────────────────────────────

    const transports = new Map<string, StreamableHTTPServerTransport>();

    // MCP endpoint at root (/) for Claude.ai compatibility
    // Also handle /mcp for backward compatibility with existing configs
    const mcpHandler = async (req: Request, res: Response) => {
      console.error(`[MCP] ${req.method} ${req.path} request received`);
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (stateless) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await server.connect(transport);
        } else {
          if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId)!;
          } else {
            const newSessionId = randomUUID();
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => newSessionId,
            });
            await server.connect(transport);
            transports.set(newSessionId, transport);
            transport.onclose = () => {
              transports.delete(newSessionId);
            };
          }
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("MCP request error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const mcpDeleteHandler = async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
        res.status(200).json({ message: "Session closed" });
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    };

    // Mount MCP handlers at both / and /mcp for compatibility
    app.post("/", bearerAuth, mcpHandler);
    app.get("/", bearerAuth, mcpHandler);
    app.delete("/", bearerAuth, mcpDeleteHandler);
    app.post("/mcp", bearerAuth, mcpHandler);
    app.get("/mcp", bearerAuth, mcpHandler);
    app.delete("/mcp", bearerAuth, mcpDeleteHandler);

    console.error("OAuth 2.1 authentication enabled (Oura proxy)");
    if (secret) {
      console.error("Static MCP_SECRET also accepted as bearer token");
    }
  }

  // If we're not mounting the MCP OAuth provider, register MCP endpoints
  // here. Auth (if any) is handled by app-level middleware above.
  if (useStaticBearerMode || !hasOuraOAuth) {
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const mcpHandler = async (req: Request, res: Response) => {
      console.error(`[MCP] ${req.method} ${req.path} request received`);
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (stateless) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await server.connect(transport);
        } else {
          if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId)!;
          } else {
            const newSessionId = randomUUID();
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => newSessionId,
            });
            await server.connect(transport);
            transports.set(newSessionId, transport);
            transport.onclose = () => {
              transports.delete(newSessionId);
            };
          }
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("MCP request error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const mcpDeleteHandler = async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
        res.status(200).json({ message: "Session closed" });
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    };

    // Mount MCP handlers at both / and /mcp for compatibility
    app.post("/", mcpHandler);
    app.get("/", mcpHandler);
    app.delete("/", mcpDeleteHandler);
    app.post("/mcp", mcpHandler);
    app.get("/mcp", mcpHandler);
    app.delete("/mcp", mcpDeleteHandler);
  }

  // Start listening
  app.listen(port, "0.0.0.0", () => {
    console.error(`Oura MCP server running on http://0.0.0.0:${port}`);
    console.error(`Public URL: ${baseUrl.href}`);
    console.error(`MCP endpoint: POST ${baseUrl.href} (or ${baseUrl.href}mcp)`);
    console.error(`Health check: GET /health`);
    if (hasOuraOAuth && !useStaticBearerMode) {
      console.error(
        `OAuth metadata: GET /.well-known/oauth-authorization-server`
      );
      console.error(`Oura callback: GET /oauth/callback`);
    }
  });
}
