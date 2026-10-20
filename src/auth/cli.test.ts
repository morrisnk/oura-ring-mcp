import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCallbackServer, validateLocalRedirect } from "./cli.js";
import { saveCredentials } from "./store.js";
vi.mock("node:http", () => ({ createServer: vi.fn() }));
vi.mock("./store.js", () => ({ saveCredentials: vi.fn(), clearCredentials: vi.fn(), getCredentialsPath: vi.fn(), loadCredentials: vi.fn(), isExpired: vi.fn() }));

const config = { clientId: "id", clientSecret: "secret", redirectUri: "http://127.0.0.1:3210/custom/callback" };
let handler: (req: any, res: any) => Promise<void>;
let server: { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
const response = () => {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  res.writeHead.mockReturnValue(res);
  return res;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveCredentials).mockReset();
  server = { listen: vi.fn((_port, _host, ready) => ready()), close: vi.fn(), closeAllConnections: vi.fn(), on: vi.fn() };
  vi.mocked(createServer).mockImplementation(((callback: typeof handler) => { handler = callback; return server; }) as any);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 3600 }) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CLI loopback authorization", () => {
  it("starts listening before opening the browser and honors the configured callback path", async () => {
    const ready = vi.fn(() => expect(server.listen).toHaveBeenCalled());
    const flow = startCallbackServer(config, "state", "verifier", ready);
    expect(server.listen).toHaveBeenCalledWith(3210, "127.0.0.1", expect.any(Function));
    expect(ready).toHaveBeenCalledOnce();
    const res = response();
    await handler({ method: "GET", url: "/custom/callback?code=code&state=state" }, res);
    await flow;
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(saveCredentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: "r" }));
    expect(vi.getTimerCount()).toBe(0);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("ignores requests with incorrect state, including denial callbacks", async () => {
    const flow = startCallbackServer(config, "state", "verifier", () => {});
    const res = response();
    await handler({ method: "GET", url: "/custom/callback?error=access_denied&state=wrong" }, res);
    expect(res.writeHead).toHaveBeenCalledWith(400);
    expect(server.close).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await handler({ method: "GET", url: "/custom/callback?code=code&state=state" }, response());
    await flow;
  });

  it("handles valid denial without reflecting provider HTML", async () => {
    const flow = startCallbackServer(config, "state", "verifier", () => {});
    const rejected = expect(flow).rejects.toThrow("authorization denied");
    const res = response();
    await handler({ method: "GET", url: "/custom/callback?error=%3Cscript%3E&state=state" }, res);
    await rejected;
    expect(res.end).not.toHaveBeenCalledWith(expect.stringContaining("<script>"));
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a callback once even if another arrives during token exchange", async () => {
    let finishFetch!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finishFetch = resolve; }));
    const flow = startCallbackServer(config, "state", "verifier", () => {});
    const first = handler({ method: "GET", url: "/custom/callback?code=code&state=state" }, response());
    const duplicate = response();
    await handler({ method: "GET", url: "/custom/callback?code=code&state=state" }, duplicate);
    expect(duplicate.writeHead).toHaveBeenCalledWith(409);
    finishFetch({ ok: true, json: async () => ({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 3600 }) });
    await first;
    await flow;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("closes the listener on timeout", async () => {
    const flow = startCallbackServer(config, "state", "verifier", () => {});
    const rejected = expect(flow).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(300000);
    await rejected;
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it.each(["https://example.com/callback", "http://0.0.0.0:3000/callback", "http://localhost:3000/callback?x=y"])("rejects non-loopback or ambiguous redirect URI: %s", (uri) => {
    expect(() => validateLocalRedirect(uri)).toThrow("loopback");
  });
});
