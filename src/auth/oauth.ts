/** Oura authorization-code flow with PKCE. */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OuraCredentials } from "./store.js";

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const REVOKE_URL = "https://api.ouraring.com/oauth/revoke";

// Oura's documented scopes. Email is not needed by the MCP tools.
export const DEFAULT_SCOPES = ["personal", "daily", "heartrate", "workout", "tag", "session", "spo2"];
const SUPPORTED_SCOPES = new Set(["email", ...DEFAULT_SCOPES]);
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().positive().finite(),
});

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export class OAuthRequestError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(`${operation} failed (HTTP ${status}). ${status === 400 || status === 401
      ? "Check the OAuth app credentials and re-authorize with `oura-ring-mcp auth`."
      : "Oura could not complete the request."}`);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizationUrl(config: OAuthConfig, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri,
    scope: (config.scopes ?? DEFAULT_SCOPES).join(" "), state,
    code_challenge: challenge, code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function requestTokens(params: URLSearchParams, operation: string): Promise<OuraCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(30_000),
  });
  // Never include provider response bodies: they may contain credentials.
  if (!response.ok) throw new OAuthRequestError(response.status, operation);
  const result = tokenSchema.safeParse(await response.json());
  if (!result.success) throw new Error("Oura returned an invalid token response. Re-authorize with `oura-ring-mcp auth`.");
  const { expires_in, ...tokens } = result.data;
  const expires_at = Date.now() + expires_in * 1000;
  if (!Number.isFinite(expires_at)) throw new Error("Oura returned an invalid token expiry.");
  return { ...tokens, expires_at };
}

export async function exchangeCodeForTokens(code: string, config: OAuthConfig, verifier: string): Promise<OuraCredentials> {
  return requestTokens(new URLSearchParams({
    grant_type: "authorization_code", code, client_id: config.clientId,
    client_secret: config.clientSecret, redirect_uri: config.redirectUri, code_verifier: verifier,
  }), "Oura token exchange");
}

// Persistence belongs to the token manager so a failed disk write never loses
// the newly rotated pair in memory.
export async function refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OuraCredentials> {
  return requestTokens(new URLSearchParams({
    grant_type: "refresh_token", refresh_token: refreshToken,
    client_id: config.clientId, client_secret: config.clientSecret,
  }), "Token refresh");
}

export async function revokeToken(accessToken: string): Promise<void> {
  const url = new URL(REVOKE_URL);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new OAuthRequestError(response.status, "Token revocation");
}

export function getOAuthConfigFromEnv(): OAuthConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("Set both OURA_CLIENT_ID and OURA_CLIENT_SECRET.");
  const redirectUri = process.env.OURA_REDIRECT_URI ?? "http://localhost:3000/callback";
  const scopes = process.env.OURA_SCOPES?.trim().split(/\s+/);
  if (scopes && scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) {
    throw new Error("OURA_SCOPES must contain documented Oura scopes separated by spaces.");
  }
  return { clientId, clientSecret, redirectUri, scopes };
}
