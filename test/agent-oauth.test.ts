import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Hub } from "../src/core/hub.js";
import { makeHub } from "./helpers.js";

/** Hub B plays the OAuth-protected MCP agent (like ForgeOps Operator); hub A is the client under test. */
describe("agent sign-in with OAuth 2.0 + PKCE", () => {
  let A: Hub, B: Hub, srvA: Server, srvB: Server, portA: number, portB: number, keyB: string;
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

  beforeAll(async () => {
    srvB = createServer();
    portB = await listen(srvB);
    B = makeHub({ HUB_PUBLIC_URL: `http://127.0.0.1:${portB}`, PORT: String(portB) }).hub;
    keyB = B.users.create("operator", "owner").apiKey;
    srvB.on("request", createApp(B).app);

    srvA = createServer();
    portA = await listen(srvA);
    A = makeHub(
      { HUB_PUBLIC_URL: `http://127.0.0.1:${portA}`, PORT: String(portA) },
      JSON.stringify({ agents: [{ id: "operator", name: "Operator", description: "oauth agent", protocol: "mcp", oauth: true, baseUrl: `http://127.0.0.1:${portB}/mcp` }] }),
    ).hub;
    srvA.on("request", createApp(A).app);
  });
  afterAll(() => { srvA.close(); srvB.close(); });

  it("refuses to call until signed in; sign-in link → browser login → callback → tools work; tokens are stored encrypted", async () => {
    const owner = A.users.byId(A.users.create("owner", "owner").user.id)!;
    const run = async (n: string, a: object) => { const r = await A.invoke(A.allTools().find((t) => t.name === n)!, a, { user: owner, hub: A }); const t = (r.content[0] as { text: string }).text; return { err: r.isError, d: (() => { try { return JSON.parse(t); } catch { return t; } })() }; };

    const before = await run("agent_mcp_list_tools", { agent_id: "operator" });
    expect(before.err).toBe(true);
    expect(before.d).toMatch(/not signed in/);

    // 1) hub A asks for the link
    const start = await run("agent_oauth_start", { agent_id: "operator" });
    expect(start.d.open_this_link).toContain(`127.0.0.1:${portB}`);
    expect(start.d.redirect_uri_to_allow).toBe(`http://127.0.0.1:${portA}/agents/oauth/callback`);

    // 2) "the human": open the agent's login page, sign in with an access key, follow the redirect back to hub A
    const authUrl = new URL(start.d.open_this_link);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await fetch(authUrl)).status).toBe(200);
    const form = new URLSearchParams({ client_id: authUrl.searchParams.get("client_id")!, redirect_uri: authUrl.searchParams.get("redirect_uri")!, code_challenge: authUrl.searchParams.get("code_challenge")!, state: authUrl.searchParams.get("state")!, scope: authUrl.searchParams.get("scope") ?? "", resource: authUrl.searchParams.get("resource") ?? "", access_key: keyB });
    const login = await fetch(`http://127.0.0.1:${portB}/oauth/login`, { method: "POST", body: form, redirect: "manual" });
    expect(login.status).toBe(302);
    const back = new URL(login.headers.get("location")!);
    expect(back.pathname).toBe("/agents/oauth/callback");

    // tampered state is refused
    const bad = await fetch(`http://127.0.0.1:${portA}/agents/oauth/callback?code=x&state=${back.searchParams.get("state")}x`);
    expect(bad.status).toBe(400);

    // 3) the browser lands on hub A's callback
    const cb = await fetch(back);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("ورود انجام شد");

    // 4) now the agent's tools are reachable with the stored token
    const tools = await run("agent_mcp_list_tools", { agent_id: "operator" });
    expect(tools.err).toBeFalsy();
    expect(tools.d.length).toBeGreaterThan(30);
    expect(tools.d.map((t: { name: string }) => t.name)).toContain("hub_overview");

    // tokens live encrypted in the DB, never in plain text
    const raw = A.db.get<{ value: string }>("SELECT value FROM secrets WHERE key = ?", "agentoauth:operator:tokens")!.value;
    expect(raw.startsWith("v1.")).toBe(true);
    expect(raw).not.toContain("icmat_");

    // already signed in
    expect((await run("agent_oauth_start", { agent_id: "operator" })).d.already_signed_in).toBe(true);
  });

  it("an expired access token is refreshed automatically (refresh token rotates)", async () => {
    const owner = A.users.byId(A.users.list().find((u) => u.name === "owner")!.id)!;
    const stored = () => JSON.parse(A.db.getSecret("agentoauth:operator:tokens")!) as { access_token: string; refresh_token: string };
    const before = stored();
    B.db.run("UPDATE oauth_tokens SET expires_at = 1 WHERE kind = 'access'"); // the agent now rejects the old access token
    const r = await A.invoke(A.allTools().find((t) => t.name === "agent_mcp_list_tools")!, { agent_id: "operator" }, { user: owner, hub: A });
    expect(r.isError).toBeFalsy();
    const after = stored();
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token);
  });

  it("a revoked/expired sign-in gives an actionable error", async () => {
    const owner = A.users.byId(A.users.list().find((u) => u.name === "owner")!.id)!;
    B.db.run("DELETE FROM oauth_tokens");
    const r = await A.invoke(A.allTools().find((t) => t.name === "agent_mcp_list_tools")!, { agent_id: "operator" }, { user: owner, hub: A });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/agent_oauth_start/);
  });
});
