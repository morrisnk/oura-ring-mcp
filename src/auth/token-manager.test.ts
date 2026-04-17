/**
 * Tests for TokenManager
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { TokenManager } from "./token-manager.js";
import type { OAuthConfig } from "./oauth.js";

vi.mock("./store.js", async () => {
  const actual = await vi.importActual<typeof import("./store.js")>("./store.js");
  return {
    ...actual,
    loadCredentials: vi.fn(),
    saveCredentials: vi.fn(),
  };
});

const store = await import("./store.js");

const CONFIG: OAuthConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://example.com/cb",
};

function mockTokenResponse(access: string, refresh: string, expiresIn = 3600) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: expiresIn,
      }),
  };
}

describe("TokenManager", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let onTokenUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
    onTokenUpdate = vi.fn();
    vi.mocked(store.loadCredentials).mockReset();
    vi.mocked(store.saveCredentials).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the seed refresh token when no credentials are stored", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue(null);
    mockFetch.mockResolvedValueOnce(mockTokenResponse("new-access", "rotated-refresh"));

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      seedRefreshToken: "seed-refresh",
      onTokenUpdate,
    });

    const token = await mgr.initialize();

    expect(token).toBe("new-access");
    expect(onTokenUpdate).toHaveBeenCalledWith("new-access");
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("seed-refresh");
    mgr.stop();
  });

  it("uses stored credentials when not expired", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue({
      access_token: "stored-access",
      refresh_token: "stored-refresh",
      token_type: "Bearer",
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      onTokenUpdate,
    });

    const token = await mgr.initialize();

    expect(token).toBe("stored-access");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onTokenUpdate).toHaveBeenCalledWith("stored-access");
    mgr.stop();
  });

  it("refreshes stored credentials when near expiry", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      token_type: "Bearer",
      expires_at: Date.now() + 1000, // expired within buffer
    });
    mockFetch.mockResolvedValueOnce(mockTokenResponse("fresh-access", "rotated-refresh"));

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      onTokenUpdate,
    });

    const token = await mgr.initialize();

    expect(token).toBe("fresh-access");
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("stored-refresh");
    mgr.stop();
  });

  it("throws when no refresh token is available", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue(null);

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      onTokenUpdate,
    });

    await expect(mgr.initialize()).rejects.toThrow(/No Oura credentials/);
  });

  it("deduplicates concurrent refreshes", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      onTokenUpdate,
    });
    await mgr.initialize();

    let resolveFetch: (v: unknown) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const p1 = mgr.refresh();
    const p2 = mgr.refresh();

    resolveFetch!(mockTokenResponse("t2", "r2"));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("t2");
    expect(b).toBe("t2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mgr.stop();
  });

  it("rotates refresh token on refresh", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue(null);
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("a1", "r1"))
      .mockResolvedValueOnce(mockTokenResponse("a2", "r2"));

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      seedRefreshToken: "seed",
      onTokenUpdate,
    });

    await mgr.initialize();
    await mgr.refresh();

    const secondBody = mockFetch.mock.calls[1][1].body as URLSearchParams;
    expect(secondBody.get("refresh_token")).toBe("r1");
    expect(onTokenUpdate).toHaveBeenLastCalledWith("a2");
    mgr.stop();
  });
});
