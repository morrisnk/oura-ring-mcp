/**
 * Tests for MCP Server initialization
 *
 * Tests server setup, token validation, and startup behavior.
 * Note: Module-level side effects (like process.exit on missing token)
 * are tested via integration tests rather than unit tests due to
 * vitest module caching behavior.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

// Create mock class constructors
class MockMcpServer {
  static instances: MockMcpServer[] = [];
  static lastConfig: unknown;

  server: { onclose?: () => void } = {};
  connect = vi.fn().mockResolvedValue(undefined);
  registerResource = vi.fn();
  registerPrompt = vi.fn();

  constructor(config: unknown) {
    MockMcpServer.lastConfig = config;
    MockMcpServer.instances.push(this);
  }

  static reset() {
    MockMcpServer.instances = [];
    MockMcpServer.lastConfig = undefined;
  }
}

class MockStdioServerTransport {
  static instances: MockStdioServerTransport[] = [];

  constructor() {
    MockStdioServerTransport.instances.push(this);
  }

  static reset() {
    MockStdioServerTransport.instances = [];
  }
}

class MockOuraClient {
  static instances: MockOuraClient[] = [];
  static lastConfig: unknown;
  setAccessToken = vi.fn();
  setOnUnauthorized = vi.fn();

  constructor(config: unknown) {
    MockOuraClient.lastConfig = config;
    MockOuraClient.instances.push(this);
  }

  static reset() {
    MockOuraClient.instances = [];
    MockOuraClient.lastConfig = undefined;
  }
}

class MockTokenManager {
  static instances: MockTokenManager[] = [];
  initialize = vi.fn().mockImplementation(async () => {
    this.options.onTokenUpdate("managed-token");
    return "managed-token";
  });
  refresh = vi.fn();
  stop = vi.fn();

  constructor(public options: { onTokenUpdate: (token: string) => void }) {
    MockTokenManager.instances.push(this);
  }
}

const mockRegisterTools = vi.fn();
const mockRegisterResources = vi.fn();
const mockRegisterPrompts = vi.fn();

// Mock the MCP SDK modules before importing index
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: MockMcpServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));

vi.mock("./client.js", () => ({
  OuraClient: MockOuraClient,
}));

vi.mock("./tools/index.js", () => ({
  registerTools: mockRegisterTools,
}));

vi.mock("./resources/index.js", () => ({
  registerResources: mockRegisterResources,
}));

vi.mock("./prompts/index.js", () => ({
  registerPrompts: mockRegisterPrompts,
}));

// Mock auth modules
const mockLoadCredentials = vi.fn();
const mockIsExpired = vi.fn();
const mockGetOAuthConfigFromEnv = vi.fn();
const mockRefreshAccessToken = vi.fn();

vi.mock("./auth/store.js", () => ({
  loadCredentials: mockLoadCredentials,
  isExpired: mockIsExpired,
}));

vi.mock("./auth/oauth.js", () => ({
  getOAuthConfigFromEnv: mockGetOAuthConfigFromEnv,
  refreshAccessToken: mockRefreshAccessToken,
}));

vi.mock("./auth/token-manager.js", () => ({
  TokenManager: MockTokenManager,
}));

vi.mock("./transports/http.js", () => ({
  startHttpServer: vi.fn(),
}));

// Mock CLI module (for CLI command tests)
const mockRunAuthFlow = vi.fn();
const mockRunLogout = vi.fn();
const mockShowAuthStatus = vi.fn();

vi.mock("./auth/cli.js", () => ({
  runAuthFlow: mockRunAuthFlow,
  runLogout: mockRunLogout,
  showAuthStatus: mockShowAuthStatus,
}));

describe("MCP Server", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Reset modules to ensure fresh imports
    vi.resetModules();

    // Reset mock class state
    MockMcpServer.reset();
    MockStdioServerTransport.reset();
    MockOuraClient.reset();
    MockTokenManager.instances = [];
    mockRegisterTools.mockClear();
    mockRegisterResources.mockClear();
    mockRegisterPrompts.mockClear();
    mockLoadCredentials.mockClear();
    mockIsExpired.mockClear();
    mockGetOAuthConfigFromEnv.mockReset();
    mockRefreshAccessToken.mockClear();
    mockRunAuthFlow.mockClear();
    mockRunLogout.mockClear();
    mockShowAuthStatus.mockClear();

    // Default: no stored credentials
    mockLoadCredentials.mockResolvedValue(null);

    // Reset environment - always set a token for these tests
    process.env = { ...originalEnv };
    delete process.env.MCP_AUTH_MODE;
    delete process.env.OURA_PERSONAL_ACCESS_TOKEN;
    delete process.env.OURA_ACCESS_TOKEN;
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    process.argv = [...originalArgv];

    // Suppress console.error from server startup
    console.error = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    console.error = originalConsoleError;
  });

  describe("token handling", () => {
    it("should accept OURA_ACCESS_TOKEN", async () => {
      process.env.OURA_ACCESS_TOKEN = "test-token";
      delete process.env.OURA_PERSONAL_ACCESS_TOKEN;

      await import("./index.js");

      expect(MockOuraClient.lastConfig).toEqual({ accessToken: "test-token" });
    });

    it("rejects the retired personal-access-token variable with migration guidance", async () => {
      process.env.OURA_PERSONAL_ACCESS_TOKEN = "personal-token";
      await expect(import("./index.js")).rejects.toThrow("no longer supported");
    });

    it("requires OAuth configuration when no explicit override is provided", async () => {
      await expect(import("./index.js")).rejects.toThrow("OURA_CLIENT_ID");
    });
  });

  describe("server initialization", () => {
    it("should create McpServer with correct config", async () => {
      process.env.OURA_ACCESS_TOKEN = "test-token";

      await import("./index.js");

      expect(MockMcpServer.lastConfig).toEqual({
        name: "oura-mcp",
        version: pkg.version,
      });
    });

    it("should create OuraClient with access token", async () => {
      process.env.OURA_ACCESS_TOKEN = "my-oura-token";

      await import("./index.js");

      expect(MockOuraClient.instances.length).toBe(1);
      expect(MockOuraClient.lastConfig).toEqual({ accessToken: "my-oura-token" });
    });

    it("should register tools with server and client", async () => {
      process.env.OURA_ACCESS_TOKEN = "test-token";

      await import("./index.js");

      expect(mockRegisterTools).toHaveBeenCalled();
      expect(MockMcpServer.instances.length).toBe(1);
      expect(MockOuraClient.instances.length).toBe(1);
    });

    it("should create StdioServerTransport", async () => {
      process.env.OURA_ACCESS_TOKEN = "test-token";

      await import("./index.js");

      // Transport is created in main() which runs asynchronously
      // Give it a moment to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(MockStdioServerTransport.instances.length).toBe(1);
    });

    it("should connect server to transport", async () => {
      process.env.OURA_ACCESS_TOKEN = "test-token";

      await import("./index.js");

      // Wait for main() to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      const serverInstance = MockMcpServer.instances[0];
      expect(serverInstance.connect).toHaveBeenCalled();
    });
  });

  describe("OAuth lifecycle", () => {
    beforeEach(() => {
      mockGetOAuthConfigFromEnv.mockReturnValue({
        clientId: "test-client", clientSecret: "test-secret",
        redirectUri: "http://localhost:3000/callback",
      });
    });

    it("uses the manager for stdio and ignores a stale access-token override", async () => {
      process.env.OURA_ACCESS_TOKEN = "stale-override";
      await import("./index.js");
      const manager = MockTokenManager.instances[0];
      expect(manager.initialize).toHaveBeenCalledWith(false);
      expect(mockLoadCredentials).not.toHaveBeenCalled();
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      expect(MockOuraClient.instances[0].setAccessToken).toHaveBeenCalledWith("managed-token");
      const client = MockOuraClient.instances[0];
      await client.setOnUnauthorized.mock.calls[0][0]();
      expect(manager.refresh).toHaveBeenCalledOnce();
      MockMcpServer.instances[0].server.onclose?.();
      expect(manager.stop).toHaveBeenCalledOnce();
    });

    it("allows HTTP OAuth to start before the first consent", async () => {
      process.argv = [originalArgv[0], originalArgv[1], "--http"];
      await import("./index.js");
      expect(MockTokenManager.instances[0].initialize).toHaveBeenCalledWith(true);
      const { startHttpServer } = await import("./transports/http.js");
      expect(startHttpServer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        tokenManager: MockTokenManager.instances[0],
      }));
    });
  });

  describe("static bearer mode", () => {
    it("lets the token manager resolve credentials without a second startup refresh", async () => {
      process.argv = [originalArgv[0], originalArgv[1], "--http"];
      process.env.MCP_AUTH_MODE = "static";
      process.env.MCP_SECRET = "test-secret";
      delete process.env.OURA_ACCESS_TOKEN;
      delete process.env.OURA_PERSONAL_ACCESS_TOKEN;
      mockGetOAuthConfigFromEnv.mockReturnValue({
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "http://localhost:3000/callback",
      });

      await import("./index.js");

      expect(mockLoadCredentials).not.toHaveBeenCalled();
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      expect(MockTokenManager.instances).toHaveLength(1);
      expect(MockTokenManager.instances[0].initialize).toHaveBeenCalledOnce();
      expect(MockOuraClient.instances[0].setAccessToken).toHaveBeenCalledWith("managed-token");
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining("No Oura credentials found")
      );
    });
  });
});
