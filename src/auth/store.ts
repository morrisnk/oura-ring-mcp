/**
 * Token storage for OAuth credentials
 * Stores tokens in ~/.oura-mcp/credentials.json
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".oura-mcp", "credentials.json");

const credentialsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_at: z.number().positive().finite(),
});

export type OuraCredentials = z.infer<typeof credentialsSchema>;

/**
 * Resolve the credentials file path.
 * Override with OURA_CREDENTIALS_PATH (e.g. to point at a Railway volume mount).
 */
export function getCredentialsPath(): string {
  return process.env.OURA_CREDENTIALS_PATH ?? DEFAULT_CREDENTIALS_FILE;
}

async function ensureDirFor(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}

/**
 * Load stored credentials.
 * Returns null only when the credentials file does not exist.
 */
export async function loadCredentials(): Promise<OuraCredentials | null> {
  let data: string;
  try {
    data = await fs.readFile(getCredentialsPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read Oura credentials. Check OURA_CREDENTIALS_PATH and file permissions.");
  }
  try {
    return credentialsSchema.parse(JSON.parse(data));
  } catch {
    throw new Error("Invalid Oura credentials file. Re-authorize with `oura-ring-mcp auth`.");
  }
}

/** Replace credentials atomically, with owner-only permissions. */
export async function saveCredentials(credentials: OuraCredentials): Promise<void> {
  credentialsSchema.parse(credentials);
  const path = getCredentialsPath();
  await ensureDirFor(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(credentials, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporaryPath, path);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

/**
 * Delete stored credentials.
 */
export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(getCredentialsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Cannot clear Oura credentials. Check file permissions.");
    }
  }
}

/**
 * Check if credentials are expired (or will expire within buffer period).
 */
export function isExpired(credentials: OuraCredentials, bufferMs = 60000): boolean {
  return Date.now() + bufferMs >= credentials.expires_at;
}
