import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCredentials, loadCredentials, saveCredentials } from "./store.js";

const credentials = { access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_at: Date.now() + 3600000 };
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "oura-store-test-"));
  path = join(directory, "credentials.json");
  vi.stubEnv("OURA_CREDENTIALS_PATH", path);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

describe("credential persistence", () => {
  it("loads the latest rotated pair on restart with owner-only permissions", async () => {
    expect(await loadCredentials()).toBeNull();
    await saveCredentials(credentials);
    await fs.chmod(path, 0o644);
    await saveCredentials({ ...credentials, refresh_token: "rotated" });
    expect(await loadCredentials()).toEqual({ ...credentials, refresh_token: "rotated" });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual(["credentials.json"]);
  });

  it("keeps the previous file intact and cleans temporary files when replacement fails", async () => {
    await saveCredentials(credentials);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(saveCredentials({ ...credentials, refresh_token: "rotated" })).rejects.toThrow("disk failure");
    expect(await loadCredentials()).toEqual(credentials);
    expect(await fs.readdir(directory)).toEqual(["credentials.json"]);
  });

  it.each(["{broken", JSON.stringify({ access_token: "a", refresh_token: "r" }), JSON.stringify({ ...credentials, expires_at: "tomorrow" })])("reports corrupted credentials rather than falling back to an old seed", async (content) => {
    await fs.writeFile(path, content);
    await expect(loadCredentials()).rejects.toThrow("Re-authorize");
  });

  it("reports read failures rather than treating them as missing credentials", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(loadCredentials()).rejects.toThrow("permissions");
  });
  it("does not report successful logout when deleting credentials fails", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(clearCredentials()).rejects.toThrow("Cannot clear Oura credentials");
  });

});
