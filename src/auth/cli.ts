/** Browser consent with a loopback callback for `oura-ring-mcp auth`. */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { buildAuthorizationUrl, createPkce, exchangeCodeForTokens, getOAuthConfigFromEnv, type OAuthConfig } from "./oauth.js";
import { saveCredentials, clearCredentials, getCredentialsPath, loadCredentials, isExpired } from "./store.js";

function openBrowser(url: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer.exe" : "xdg-open";
  execFile(command, [url], (error) => {
    if (error) console.error("Could not open a browser. Open the authorization URL printed above.");
  });
}

export function validateLocalRedirect(redirectUri: string): URL {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.search || url.hash || url.username || url.password) {
    throw new Error("CLI auth requires an HTTP loopback OURA_REDIRECT_URI (for example http://localhost:3000/callback). Register that exact URI with Oura.");
  }
  return url;
}

/** onReady runs only after the listener is ready to receive the browser redirect. */
export function startCallbackServer(config: OAuthConfig, expectedState: string, verifier: string, onReady: () => void): Promise<void> {
  const redirect = validateLocalRedirect(config.redirectUri);
  return new Promise((resolve, reject) => {
    let consumed = false;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      server.close();
      if (error) reject(error); else resolve();
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirect.origin);
      if (req.method !== "GET" || url.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        res.writeHead(400).end("Invalid OAuth state.");
        return;
      }
      if (consumed) {
        res.writeHead(409).end("Authorization callback already handled.");
        return;
      }
      consumed = true;
      if (url.searchParams.has("error")) {
        res.writeHead(400).end("Authorization denied. Return to the terminal and try again.");
        finish(new Error("Oura authorization denied. Run `oura-ring-mcp auth` to try again."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400).end("Missing authorization code.");
        finish(new Error("No authorization code received."));
        return;
      }
      try {
        const credentials = await exchangeCodeForTokens(code, config, verifier);
        await saveCredentials(credentials);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Authorization successful. You can close this window and return to the terminal.");
        finish();
      } catch (error) {
        res.writeHead(500).end("Authorization could not be saved. See the terminal for details.");
        finish(error instanceof Error ? error : new Error("Authorization failed."));
      }
    });
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      finish(new Error("Authorization timed out after 5 minutes."));
    }, 5 * 60 * 1000);
    server.on("error", finish);
    const host = redirect.hostname === "[::1]" ? "::1" : redirect.hostname;
    server.listen(Number(redirect.port || 80), host, () => {
      try { onReady(); } catch (error) { finish(error instanceof Error ? error : new Error("Cannot open authorization URL.")); }
    });
  });
}

export async function runAuthFlow(): Promise<void> {
  const config = getOAuthConfigFromEnv();
  if (!config) throw new Error("Set OURA_CLIENT_ID and OURA_CLIENT_SECRET from https://cloud.ouraring.com/oauth/applications.");
  validateLocalRedirect(config.redirectUri);
  const state = randomBytes(32).toString("hex");
  const pkce = createPkce();
  const authUrl = buildAuthorizationUrl(config, state, pkce.challenge);
  await startCallbackServer(config, state, pkce.verifier, () => {
    console.log(`Authorize Oura in your browser:\n${authUrl}\n`);
    openBrowser(authUrl);
  });
  console.log(`Authorization successful. Credentials saved to ${getCredentialsPath()}.`);
  console.log("Keep OURA_CLIENT_ID and OURA_CLIENT_SECRET configured for automatic refresh.");
}

export async function runLogout(): Promise<void> {
  await clearCredentials();
  console.log("Local credentials cleared. To revoke access, remove this application in your Oura account. Stop running servers before logging out.");
}

export async function showAuthStatus(): Promise<void> {
  const credentials = await loadCredentials();
  if (!credentials) {
    console.log("Not authenticated. Run `oura-ring-mcp auth`.");
    return;
  }
  console.log(`Access token: ${isExpired(credentials) ? "expired; the server will attempt refresh on startup" : "not expired (not verified with Oura)"}`);
  console.log(`Expires: ${new Date(credentials.expires_at).toLocaleString()}`);
  console.log(`Credentials: ${getCredentialsPath()}`);
  console.log(`OAuth app configuration: ${getOAuthConfigFromEnv() ? "present" : "missing; set OURA_CLIENT_ID and OURA_CLIENT_SECRET for refresh"}`);
}
