/**
 * Token storage for OAuth credentials
 * Stores tokens in ~/.oura-mcp/credentials.json
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".oura-mcp", "credentials.json");

export interface OuraCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number; // Unix timestamp (ms)
}

/**
 * Resolve the credentials file path.
 * Override with OURA_CREDENTIALS_PATH (e.g. to point at a Railway volume mount).
 */
export function getCredentialsPath(): string {
  return process.env.OURA_CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_FILE;
}

async function ensureDirFor(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

/**
 * Load stored credentials.
 * Returns null if no credentials exist or file is corrupted.
 */
export async function loadCredentials(): Promise<OuraCredentials | null> {
  try {
    const data = await fs.readFile(getCredentialsPath(), "utf-8");
    const credentials = JSON.parse(data) as OuraCredentials;

    if (!credentials.access_token || !credentials.refresh_token) {
      return null;
    }

    return credentials;
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk (owner-only permissions).
 */
export async function saveCredentials(credentials: OuraCredentials): Promise<void> {
  const path = getCredentialsPath();
  await ensureDirFor(path);
  await fs.writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

/**
 * Delete stored credentials.
 */
export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(getCredentialsPath());
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Check if credentials are expired (or will expire within buffer period).
 */
export function isExpired(credentials: OuraCredentials, bufferMs = 60000): boolean {
  return Date.now() + bufferMs >= credentials.expires_at;
}
