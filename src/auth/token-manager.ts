/** One owner for the single-use Oura refresh token in each server process. */
import { OAuthRequestError, refreshAccessToken, type OAuthConfig } from "./oauth.js";
import { isExpired, loadCredentials, saveCredentials, type OuraCredentials } from "./store.js";

export interface TokenManagerOptions {
  oauthConfig: OAuthConfig;
  seedRefreshToken?: string;
  onTokenUpdate: (accessToken: string) => void;
  refreshBufferMs?: number;
}

export class TokenManager {
  private credentials: OuraCredentials | null = null;
  private refreshTimer?: NodeJS.Timeout;
  private inFlight?: Promise<string>;
  private pendingPersistence = false;
  private stopped = false;
  private retryCount = 0;
  private terminalError?: Error;

  constructor(private readonly options: TokenManagerOptions) {}

  /** HTTP OAuth can start without tokens and acquire them through consent. */
  async initialize(allowMissing = false): Promise<string | null> {
    let stored: OuraCredentials | null;
    try {
      stored = await loadCredentials();
    } catch (error) {
      if (!allowMissing) throw error;
      // Public HTTP consent can replace a corrupt file; never fall back to a
      // stale environment seed when a persisted credential file is invalid.
      console.error(error instanceof Error ? error.message : "Cannot load Oura credentials.");
      return null;
    }
    if (stored) {
      this.credentials = stored;
      if (!isExpired(stored, this.options.refreshBufferMs ?? 5 * 60 * 1000)) {
        this.options.onTokenUpdate(stored.access_token);
        this.scheduleRefresh();
        return stored.access_token;
      }
    } else if (this.options.seedRefreshToken) {
      // Only the refresh token is used until the first exchange completes.
      this.credentials = { access_token: "", refresh_token: this.options.seedRefreshToken, token_type: "bearer", expires_at: 0 };
    } else {
      if (allowMissing) return null;
      throw new Error("No Oura credentials available. Run `oura-ring-mcp auth` or supply OURA_REFRESH_TOKEN for initial setup.");
    }
    try {
      return await this.refresh();
    } catch (error) {
      if (!this.pendingPersistence) {
        if (!allowMissing) throw error;
        console.error("Saved Oura credentials could not refresh. Reconnect the HTTP OAuth connector to authorize again.");
        return null;
      }
      // A refresh already consumed the old token. Keep the process alive so
      // saving can be retried rather than exiting with the only new pair.
      this.options.onTokenUpdate(this.credentials!.access_token);
      console.error(error instanceof Error ? error.message : "Cannot persist Oura credentials.");
      return this.credentials!.access_token;
    }
  }

  /** Adopt a complete callback response after any active refresh has finished. */
  async setCredentials(credentials: OuraCredentials): Promise<void> {
    while (this.inFlight) {
      try { await this.inFlight; } catch { /* New authorization replaces failed credentials. */ }
    }
    this.terminalError = undefined;
    this.retryCount = 0;
    this.inFlight = this.persistAndPublish(credentials);
    try { await this.inFlight; } finally { this.inFlight = undefined; }
  }

  /** Concurrent timer/API calls share a single refresh operation. */
  async refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    if (this.terminalError) throw this.terminalError;
    if (!this.credentials) throw new Error("Oura is not authenticated. Run `oura-ring-mcp auth` or complete HTTP consent.");
    this.inFlight = this.doRefresh();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }

  getAccessToken(): string | null { return this.credentials?.access_token || null; }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async persistAndPublish(credentials: OuraCredentials): Promise<string> {
    // Retain the rotated pair even if persistence fails. Never reuse its predecessor.
    this.credentials = credentials;
    this.pendingPersistence = true;
    try {
      await saveCredentials(credentials);
    } catch {
      this.scheduleRetry(true);
      throw new Error("Cannot persist Oura credentials. Fix the credentials volume permissions before restarting; the rotated tokens are retained in memory.");
    }
    this.pendingPersistence = false;
    this.retryCount = 0;
    this.options.onTokenUpdate(credentials.access_token);
    this.scheduleRefresh();
    return credentials.access_token;
  }

  private async doRefresh(): Promise<string> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pendingPersistence) return this.persistAndPublish(this.credentials!);
    let credentials: OuraCredentials;
    try {
      credentials = await refreshAccessToken(this.credentials!.refresh_token, this.options.oauthConfig);
    } catch (error) {
      if (error instanceof OAuthRequestError && error.retryable) {
        this.scheduleRetry();
      } else {
        // A dropped response may already have consumed the refresh token.
        // Avoid replaying it automatically when the outcome is unknown.
        this.terminalError = new Error("Oura refresh failed or its outcome is unknown. Re-authorize with `oura-ring-mcp auth` using the same OAuth app.");
      }
      throw this.terminalError ?? error;
    }
    return this.persistAndPublish(credentials);
  }

  private scheduleRetry(persistence = false): void {
    if (this.stopped || (!persistence && this.retryCount >= 3)) return;
    // Saving the only rotated pair must keep retrying after storage recovers.
    // Provider failures have a bounded retry count; disk retries cap the delay.
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.retryCount, 6));
    this.retryCount++;
    this.setTimer(delay);
  }

  private setTimer(delay: number, reschedule = false): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (reschedule) {
        this.scheduleRefresh();
        return;
      }
      void this.refresh().catch((error) => console.error("Background Oura refresh:", error instanceof Error ? error.message : "failed"));
    }, delay);
    this.refreshTimer.unref?.();
  }

  private scheduleRefresh(): void {
    if (this.stopped || !this.credentials) return;
    const remaining = this.credentials.expires_at - Date.now();
    const buffer = Math.min(this.options.refreshBufferMs ?? 5 * 60 * 1000, remaining / 2);
    // Node timers above 2^31-1 fire immediately. For long-lived tokens, wake
    // at the cap and reschedule instead of refreshing before the buffer window.
    const refreshIn = Math.max(1000, remaining - buffer);
    const maxDelay = 2_147_483_647;
    this.setTimer(Math.min(maxDelay, refreshIn), refreshIn > maxDelay);
  }
}
