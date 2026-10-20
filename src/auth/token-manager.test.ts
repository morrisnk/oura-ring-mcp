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

  it("caps setTimeout delay to avoid 32-bit overflow on 30-day tokens", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    vi.mocked(store.loadCredentials).mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      // Oura issues ~30-day access tokens; raw delay would overflow setTimeout.
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const mgr = new TokenManager({
      oauthConfig: CONFIG,
      onTokenUpdate,
    });
    await mgr.initialize();

    const MAX_TIMEOUT_MS = 2_147_483_647;
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    const schedulingCalls = delays.filter((d) => d > 1000);
    expect(schedulingCalls.length).toBeGreaterThan(0);
    for (const d of schedulingCalls) {
      expect(d).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    }

    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
    expect(mockFetch).not.toHaveBeenCalled();

    mgr.stop();
    setTimeoutSpy.mockRestore();
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
  it("can wait for HTTP consent without credentials", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue(null);
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    expect(await mgr.initialize(true)).toBeNull();
    await expect(mgr.refresh()).rejects.toThrow("not authenticated");
    const credentials = { access_token: "callback-access", refresh_token: "callback-refresh", token_type: "bearer", expires_at: Date.now() + 3600000 };
    await mgr.setCredentials(credentials);
    expect(store.saveCredentials).toHaveBeenCalledWith(credentials);
    expect(onTokenUpdate).toHaveBeenCalledWith("callback-access");
    mgr.stop();
  });

  it("refreshes in the background before expiry and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: Date.now() + 600000 });
    mockFetch.mockResolvedValue(mockTokenResponse("fresh", "rotated"));
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await mgr.initialize();
    await vi.advanceTimersByTimeAsync(300000);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(onTokenUpdate).toHaveBeenLastCalledWith("fresh");
    expect(store.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: "rotated" }));
    mgr.stop();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("persists a rotated pair again after a disk failure without replaying the consumed refresh token", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: Date.now() + 3600000 });
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await mgr.initialize();
    mockFetch.mockResolvedValueOnce(mockTokenResponse("new", "rotated"));
    vi.mocked(store.saveCredentials).mockRejectedValueOnce(new Error("disk full"));
    await expect(mgr.refresh()).rejects.toThrow("retained in memory");
    expect(mgr.getAccessToken()).toBe("new");
    await expect(mgr.refresh()).resolves.toBe("new");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(store.saveCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ refresh_token: "rotated" }));
    mgr.stop();
  });

  it("bounds background retries for explicit transient failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: Date.now() + 3600000 });
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await mgr.initialize();
    await expect(mgr.refresh()).rejects.toThrow("HTTP 503");
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    mgr.stop();
  });

  it.each([400, 401, "network"])("does not replay rejected or ambiguous refreshes (%s)", async (failure) => {
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: Date.now() + 3600000 });
    if (failure === "network") mockFetch.mockRejectedValue(new TypeError("connection reset"));
    else mockFetch.mockResolvedValue({ ok: false, status: failure });
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await mgr.initialize();
    await expect(mgr.refresh()).rejects.toThrow("Re-authorize");
    await expect(mgr.refresh()).rejects.toThrow("Re-authorize");
    expect(mockFetch).toHaveBeenCalledOnce();
    mgr.stop();
  });

  it("serializes new consent with an active refresh and keeps the new authorization", async () => {
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: Date.now() + 3600000 });
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await mgr.initialize();
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const refresh = mgr.refresh();
    const credentials = { access_token: "consent", refresh_token: "consent-refresh", token_type: "bearer", expires_at: Date.now() + 3600000 };
    const consent = mgr.setCredentials(credentials);
    resolveFetch(mockTokenResponse("refreshed", "rotated"));
    await Promise.all([refresh, consent]);
    expect(store.saveCredentials).toHaveBeenLastCalledWith(credentials);
    expect(onTokenUpdate).toHaveBeenLastCalledWith("consent");
    mgr.stop();
  });

  it("keeps startup alive after rotation if storage temporarily fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.loadCredentials).mockResolvedValue(null);
    mockFetch.mockResolvedValueOnce(mockTokenResponse("fresh", "rotated"));
    vi.mocked(store.saveCredentials).mockRejectedValueOnce(new Error("read-only volume"));
    const mgr = new TokenManager({ oauthConfig: CONFIG, seedRefreshToken: "seed", onTokenUpdate });
    await expect(mgr.initialize()).resolves.toBe("fresh");
    expect(onTokenUpdate).toHaveBeenCalledWith("fresh");
    await mgr.refresh();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(store.saveCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ refresh_token: "rotated" }));
    mgr.stop();
  });

  it("keeps HTTP consent available when saved credentials have been revoked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.loadCredentials).mockResolvedValue({ access_token: "old", refresh_token: "revoked", token_type: "bearer", expires_at: Date.now() - 1000 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    const mgr = new TokenManager({ oauthConfig: CONFIG, onTokenUpdate });
    await expect(mgr.initialize(true)).resolves.toBeNull();
    expect(onTokenUpdate).not.toHaveBeenCalled();
    const credentials = { access_token: "reauthorized", refresh_token: "new-refresh", token_type: "bearer", expires_at: Date.now() + 3600000 };
    await mgr.setCredentials(credentials);
    expect(onTokenUpdate).toHaveBeenCalledWith("reauthorized");
    mgr.stop();
  });

  it("does not reuse an environment seed when a saved credentials file is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.loadCredentials).mockRejectedValue(new Error("Invalid credentials file"));
    const mgr = new TokenManager({ oauthConfig: CONFIG, seedRefreshToken: "stale-seed", onTokenUpdate });
    await expect(mgr.initialize()).rejects.toThrow("Invalid credentials");
    await expect(mgr.initialize(true)).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    mgr.stop();
  });

  it("continues saving the rotated pair until storage recovers, without another token exchange", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.loadCredentials).mockResolvedValue(null);
    mockFetch.mockResolvedValueOnce(mockTokenResponse("fresh", "rotated"));
    vi.mocked(store.saveCredentials).mockRejectedValue(new Error("volume unavailable"));
    const mgr = new TokenManager({ oauthConfig: CONFIG, seedRefreshToken: "seed", onTokenUpdate });
    await mgr.initialize();
    await vi.advanceTimersByTimeAsync(31000);
    expect(store.saveCredentials).toHaveBeenCalledTimes(6);
    vi.mocked(store.saveCredentials).mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(32000);
    expect(store.saveCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ refresh_token: "rotated" }));
    expect(onTokenUpdate).toHaveBeenLastCalledWith("fresh");
    expect(mockFetch).toHaveBeenCalledOnce();
    mgr.stop();
  });

});
