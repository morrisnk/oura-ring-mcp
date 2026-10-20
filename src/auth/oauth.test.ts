import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizationUrl, createPkce, DEFAULT_SCOPES, exchangeCodeForTokens, getOAuthConfigFromEnv, OAuthRequestError, refreshAccessToken } from "./oauth.js";

const config = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/callback" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Oura OAuth", () => {
  it("uses a random S256 challenge and explicit documented scopes", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createPkce().verifier).not.toBe(pkce.verifier);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
    const url = new URL(buildAuthorizationUrl(config, "random-state", pkce.challenge));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("random-state");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe(DEFAULT_SCOPES.join(" "));
  });

  it("exchanges a code with its verifier, retaining expiry and the rotating token", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 }) });
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    const result = await exchangeCodeForTokens("code", config, "verifier");
    const options = fetch.mock.calls[0][1];
    expect(options.body.get("code_verifier")).toBe("verifier");
    expect(options.body.get("redirect_uri")).toBe(config.redirectUri);
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(result.expires_at).toBeGreaterThanOrEqual(now + 3600000);
    expect(result.refresh_token).toBe("refresh");
  });

  it.each([{}, { access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: -1 }])("rejects malformed token responses", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    await expect(refreshAccessToken("r", config)).rejects.toThrow("invalid token response");
  });

  it("does not expose provider response bodies in errors", async () => {
    const text = vi.fn().mockResolvedValue("secret-access-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text }));
    await expect(refreshAccessToken("r", config)).rejects.toThrow("re-authorize");
    expect(text).not.toHaveBeenCalled();
    expect(new OAuthRequestError(503, "refresh").retryable).toBe(true);
    expect(new OAuthRequestError(401, "refresh").retryable).toBe(false);
  });

  it("validates app configuration and configurable scopes", () => {
    vi.stubEnv("OURA_CLIENT_ID", "id");
    vi.stubEnv("OURA_CLIENT_SECRET", "");
    expect(getOAuthConfigFromEnv).toThrow("both");
    vi.stubEnv("OURA_CLIENT_SECRET", "secret");
    vi.stubEnv("OURA_SCOPES", "daily heartrate");
    expect(getOAuthConfigFromEnv()?.scopes).toEqual(["daily", "heartrate"]);
    vi.stubEnv("OURA_SCOPES", "ring_configuration");
    expect(getOAuthConfigFromEnv).toThrow("documented Oura scopes");
  });
});
