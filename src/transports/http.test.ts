import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OuraMcpOAuthProvider } from "../auth/mcp-oauth-provider.js";
import type { TokenManager } from "../auth/token-manager.js";
import { startHttpServer } from "./http.js";

// Use real Express routing and the real OAuth provider, without opening a port.
vi.mock("@modelcontextprotocol/sdk/server/auth/router.js", () => ({
  mcpAuthRouter: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(class {
    sessionId: string | undefined;
    onclose?: () => void;
    handleRequest = vi.fn();
    close = vi.fn(async () => this.onclose?.());
    constructor(options: { sessionIdGenerator?: () => string }) {
      this.sessionId = options.sessionIdGenerator?.();
    }
  }),
}));
let app: express.Application;
beforeEach(() => {
  vi.stubEnv("OURA_CLIENT_ID", "id");
  vi.stubEnv("OURA_CLIENT_SECRET", "secret");
  vi.stubEnv("MCP_AUTH_MODE", "");
  vi.stubEnv("MCP_SECRET", "");
  vi.stubEnv("BASE_URL", "https://example.com");
  vi.spyOn(express.application, "listen").mockImplementation(function (this: express.Application) {
    app = this;
    return {} as Server;
  } as any);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(mcpAuthRouter).mockClear();
  vi.mocked(StreamableHTTPServerTransport).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function beginConsent() {
  const provider = vi.mocked(mcpAuthRouter).mock.calls[0][0].provider as OuraMcpOAuthProvider;
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://client.example/callback"] });
  let url = "";
  await provider.authorize(client, { codeChallenge: "mcp-challenge", redirectUri: "https://client.example/callback" }, {
    redirect: (_status: number, value: string) => { url = value; },
  } as express.Response);
  return { provider, state: new URL(url).searchParams.get("state")! };
}
function callbackRoute() {
  return (app as any).router.stack.find((layer: any) => layer.route?.path === "/oauth/callback").route.stack[0].handle;
}
function response() {
  const res = { status: vi.fn(), type: vi.fn(), send: vi.fn(), json: vi.fn(), redirect: vi.fn() };
  res.status.mockReturnValue(res); res.type.mockReturnValue(res);
  return res;
}

describe("HTTP Oura consent", () => {
  it("awaits persistence of the complete Oura pair before redirecting to the MCP client", async () => {
    let saved!: () => void;
    const setCredentials = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    await startHttpServer(new McpServer({ name: "test", version: "1" }), { tokenManager: { setCredentials } as unknown as TokenManager });
    const { state } = await beginConsent();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 3600 }) }));
    const res = response();
    const callback = callbackRoute()({ query: { code: "code", state } }, res);
    await vi.waitFor(() => expect(setCredentials).toHaveBeenCalledOnce());
    expect(setCredentials).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: expect.any(Number) });
    expect(res.redirect).not.toHaveBeenCalled();
    saved();
    await callback;
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining("https://client.example/callback?code="));
  });

  it("does not issue an MCP code when credential persistence fails", async () => {
    const setCredentials = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    await startHttpServer(new McpServer({ name: "test", version: "1" }), { tokenManager: { setCredentials } as unknown as TokenManager });
    const { state } = await beginConsent();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 3600 }) }));
    const res = response();
    await callbackRoute()({ query: { code: "code", state } }, res);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining("storage unavailable"));
  });

  it("validates and consumes state for denied consent without reflecting HTML", async () => {
    await startHttpServer(new McpServer({ name: "test", version: "1" }));
    const { state, provider } = await beginConsent();
    const res = response();
    await callbackRoute()({ query: { state, error: "<script>", error_description: "<script>" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Oura authorization denied. Please reconnect and try again.");
    await expect(provider.handleOuraCallback("code", state)).rejects.toThrow("Invalid or expired");
  });

  it("fails closed for HTTP without client authentication", async () => {
    vi.stubEnv("OURA_CLIENT_ID", ""); vi.stubEnv("OURA_CLIENT_SECRET", "");
    await expect(startHttpServer(new McpServer({ name: "test", version: "1" }))).rejects.toThrow("requires OAuth");
    expect(express.application.listen).not.toHaveBeenCalled();
  });
  it.each([true, false])("enforces bearer authentication (static OAuth mode: %s)", async (staticMode) => {
    vi.stubEnv("MCP_SECRET", "mcp-secret");
    if (staticMode) vi.stubEnv("MCP_AUTH_MODE", "static");
    else { vi.stubEnv("OURA_CLIENT_ID", ""); vi.stubEnv("OURA_CLIENT_SECRET", ""); }
    await startHttpServer(new McpServer({ name: "test", version: "1" }));
    const auth = (app as any).router.stack.filter((layer: any) => !layer.route).at(-1).handle;
    for (const header of [undefined, "Basic mcp-secret", "Bearer wrong"]) {
      const res = response();
      const next = vi.fn();
      auth({ path: "/mcp", headers: { authorization: header } }, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
    const next = vi.fn();
    auth({ path: "/mcp", headers: { authorization: "Bearer mcp-secret" } }, response(), next);
    expect(next).toHaveBeenCalledOnce();
    const healthNext = vi.fn();
    auth({ path: "/health", headers: {} }, response(), healthNext);
    expect(healthNext).toHaveBeenCalledOnce();
    const health = (app as any).router.stack.find((layer: any) => layer.route?.path === "/health").route.stack[0].handle;
    const res = response();
    health({}, res);
    expect(res.json).toHaveBeenCalledWith({ status: "ok", service: "oura-mcp" });
  });

  it("rejects static mode without a client secret before listening", async () => {
    vi.stubEnv("MCP_AUTH_MODE", "static");
    await expect(startHttpServer(new McpServer({ name: "test", version: "1" }))).rejects.toThrow("requires MCP_SECRET");
    expect(express.application.listen).not.toHaveBeenCalled();
  });

  it.each([{ state: "s" }, { code: "c" }, { code: ["c"], state: "s" }])("rejects incomplete or malformed consent callbacks: %j", async (query) => {
    await startHttpServer(new McpServer({ name: "test", version: "1" }));
    const res = response();
    await callbackRoute()({ query }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it.each([true, false])("reuses and closes stateful MCP sessions (static mode: %s)", async (staticMode) => {
    vi.stubEnv("MCP_SECRET", "secret");
    vi.stubEnv("MCP_AUTH_MODE", staticMode ? "static" : "");
    const server = { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
    await startHttpServer(server, { stateless: false });
    const route = (method: string) => {
      const layer = (app as any).router.stack.find((layer: any) => layer.route?.path === "/mcp" && layer.route.methods[method]);
      return layer.route.stack.at(-1).handle;
    };
    const post = route("post");
    const res = response();
    await post({ headers: {}, method: "POST", path: "/mcp", body: { id: 1 } }, res);
    const transport = vi.mocked(StreamableHTTPServerTransport).mock.results[0].value;
    expect(server.connect).toHaveBeenCalledOnce();
    const headers = { "mcp-session-id": transport.sessionId };
    await post({ headers, method: "POST", path: "/mcp", body: { id: 2 } }, res);
    expect(server.connect).toHaveBeenCalledOnce();
    expect(transport.handleRequest).toHaveBeenCalledTimes(2);
    const deletion = response();
    await route("delete")({ headers }, deletion);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(deletion.status).toHaveBeenCalledWith(200);
    const missing = response();
    await route("delete")({ headers }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  it.each([true, false])("creates stateless transports and reports transport errors (static mode: %s)", async (staticMode) => {
    vi.stubEnv("MCP_SECRET", "secret");
    vi.stubEnv("MCP_AUTH_MODE", staticMode ? "static" : "");
    const connect = vi.fn().mockRejectedValueOnce(new Error("transport unavailable"));
    await startHttpServer({ connect } as unknown as McpServer);
    const post = (app as any).router.stack.find((layer: any) => layer.route?.path === "/mcp" && layer.route.methods.post).route.stack.at(-1).handle;
    const res = response();
    await post({ headers: {}, method: "POST", path: "/mcp", body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal server error" }));
    expect(vi.mocked(StreamableHTTPServerTransport).mock.calls[0][0]).toEqual({ sessionIdGenerator: undefined });
  });

});
