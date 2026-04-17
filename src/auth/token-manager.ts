/**
 * Background Oura OAuth token manager.
 *
 * Used in static-bearer mode where MCP clients authenticate with MCP_SECRET
 * but Oura API calls ride on a long-running OAuth token that we refresh
 * ourselves. The single-use refresh token is persisted to disk via
 * saveCredentials() so it survives process restarts (on Railway, point
 * OURA_CREDENTIALS_PATH at a mounted volume).
 */

import { refreshAccessToken, type OAuthConfig } from "./oauth.js";
import { isExpired, loadCredentials, type OuraCredentials } from "./store.js";

export interface TokenManagerOptions {
  oauthConfig: OAuthConfig;
  /** Optional seed refresh token used on first startup when no credentials are persisted. */
  seedRefreshToken?: string;
  /** Called whenever a fresh access token is obtained. */
  onTokenUpdate: (accessToken: string) => void;
  /** Refresh this many ms before the access token expires. Default: 5 min. */
  refreshBufferMs?: number;
}

export class TokenManager {
  private credentials: OuraCredentials | null = null;
  private refreshTimer?: NodeJS.Timeout;
  private inFlight?: Promise<string>;

  constructor(private readonly options: TokenManagerOptions) {}

  /**
   * Load credentials from disk (if present) or exchange the seed refresh
   * token for a fresh pair. Returns a valid access token and schedules
   * the next automatic refresh.
   */
  async initialize(): Promise<string> {
    const stored = await loadCredentials();
    const bufferMs = this.options.refreshBufferMs ?? 5 * 60 * 1000;

    if (stored && !isExpired(stored, bufferMs)) {
      this.credentials = stored;
      this.options.onTokenUpdate(stored.access_token);
      this.scheduleRefresh();
      return stored.access_token;
    }

    const refreshToken = stored?.refresh_token ?? this.options.seedRefreshToken;
    if (!refreshToken) {
      throw new Error(
        "No Oura credentials available. Set OURA_REFRESH_TOKEN or run `npx oura-ring-mcp auth`."
      );
    }

    return this.doRefresh(refreshToken);
  }

  /**
   * Force a refresh now. Deduplicates concurrent calls so a burst of 401s
   * results in a single refresh.
   */
  async refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    if (!this.credentials) {
      throw new Error("TokenManager not initialized");
    }
    return this.doRefresh(this.credentials.refresh_token);
  }

  /** Current access token, or null if not yet initialized. */
  getAccessToken(): string | null {
    return this.credentials?.access_token ?? null;
  }

  /** Stop the background refresh timer (useful for tests and shutdown). */
  stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    this.inFlight = (async () => {
      // refreshAccessToken persists rotated credentials via saveCredentials.
      const creds = await refreshAccessToken(refreshToken, this.options.oauthConfig);
      this.credentials = creds;
      this.options.onTokenUpdate(creds.access_token);
      this.scheduleRefresh();
      return creds.access_token;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.credentials) return;

    const bufferMs = this.options.refreshBufferMs ?? 5 * 60 * 1000;
    const msUntilExpiry = this.credentials.expires_at - Date.now();
    const refreshIn = Math.max(60_000, msUntilExpiry - bufferMs);
    // Node setTimeout uses a 32-bit signed int for the delay (~24.8 days).
    // Oura access tokens live 30 days, so we must cap and reschedule.
    const MAX_TIMEOUT_MS = 2_147_483_647;
    const delay = Math.min(refreshIn, MAX_TIMEOUT_MS);
    const isCapped = refreshIn > MAX_TIMEOUT_MS;

    this.refreshTimer = setTimeout(() => {
      if (isCapped) {
        // Not time to refresh yet — just reschedule with the remaining window.
        this.scheduleRefresh();
        return;
      }
      void this.refresh().catch((err) => {
        console.error("Background token refresh failed:", err);
      });
    }, delay);
    this.refreshTimer.unref?.();
  }
}
