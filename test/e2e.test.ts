import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { attachWebSocket, createApp } from "../src/app.js";
import { createHandlers } from "../src/pc-agent/handlers.js";
import type { Hub } from "../src/core/hub.js";
import { makeHub } from "./helpers.js";

/* ───────── mock upstreams ───────── */
const wpCalls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
const product = { id: 7, name: "چادر ۴ نفره", status: "publish", type: "simple", regular_price: "1000", price: "1000", sale_price: "", stock_status: "instock", stock_quantity: 5, categories: [{ name: "چادر" }], images: [{ src: "http://img.test/a.jpg" }], permalink: "https://irancamping.com/p/7", short_description: "<p>سبک</p>", description: "" };

function mockWp(): Server {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    wpCalls.push({ method: req.method, url: req.originalUrl, auth: req.headers.authorization, body: req.body });
    next();
  });
  app.get("/wp-json/", (_q, r) => void r.json({ name: "Iran Camping", url: "x", namespaces: ["wp/v2", "wc/v3"] }));
  app.get("/wp-json/wp/v2/posts", (_q, r) => void r.set("X-WP-Total", "1").json([{ id: 1, type: "post", status: "draft", title: { rendered: "سلام" }, slug: "s", link: "l", excerpt: { rendered: "<p>x</p>" } }]));
  app.get("/wp-json/wc/v3/products/7", (_q, r) => void r.json(product));
  app.put("/wp-json/wc/v3/products/7", (q, r) => void r.json({ ...product, ...q.body }));
  return createServer(app);
}

function mockGraph(): Server {
  const app = express();
  app.use(express.json());
  app.get("/v23.0/me", (_q, r) => void r.json({ user_id: "99", username: "irancamping", followers_count: 1234, media_count: 10 }));
  app.post("/v23.0/99/media", (_q, r) => void r.json({ id: "container1" }));
  app.get("/v23.0/container1", (_q, r) => void r.json({ status_code: "FINISHED" }));
  app.post("/v23.0/99/media_publish", (_q, r) => void r.json({ id: "media1" }));
  app.get("/v23.0/media1", (_q, r) => void r.json({ permalink: "https://instagram.com/p/abc" }));
  app.get("/v23.0/bad/comments", (_q, r) => void r.status(400).json({ error: { code: 190, message: "expired" } }));
  return createServer(app);
}

const listen = (s: Server) => new Promise<number>((res) => s.listen(0, "127.0.0.1", () => res((s.address() as AddressInfo).port)));

/* ───────── fixture ───────── */
let hub: Hub;
let base: string;
let httpServer: Server;
let wp: Server;
let graph: Server;
let ownerKey: string;
let viewerKey: string;

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

beforeAll(async () => {
  wp = mockWp();
  graph = mockGraph();
  const [wpPort, gPort] = [await listen(wp), await listen(graph)];
  httpServer = createServer();
  const port = await listen(httpServer);
  base = `http://127.0.0.1:${port}`;

  const made = makeHub({
    HUB_PUBLIC_URL: base,
    PORT: String(port),
    WP_URL: `http://127.0.0.1:${wpPort}`,
    WP_USER: "bot",
    WP_APP_PASSWORD: "app-pass-secret-1",
    WC_KEY: "ck_test_key_123",
    WC_SECRET: "cs_test_secret_456",
    IG_APP_ID: "appid",
    IG_APP_SECRET: "appsecret-123",
    IG_GRAPH_BASE: `http://127.0.0.1:${gPort}`,
    PC_AGENT_TOKEN: "pc-token-pc-token-1234567890",
  });
  hub = made.hub;
  made.cfg.instagram!.allowPrivateUrls = true;
  ownerKey = hub.users.create("owner", "owner").apiKey;
  viewerKey = hub.users.create("viewer", "viewer").apiKey;
  hub.db.setSecret("ig:main", JSON.stringify({ label: "main", userId: "99", username: "irancamping", accessToken: "IGTOKEN-abcdef", expiresAt: Date.now() + 5e9, refreshedAt: Date.now() }));
  const { app } = createApp(hub);
  httpServer.on("request", app);
  attachWebSocket(httpServer, hub);
  await hub.start();
});

afterAll(async () => {
  await hub.stop();
  for (const s of [httpServer, wp, graph]) s.close();
});

describe("auth + RBAC", () => {
  it("rejects missing/invalid bearer tokens", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(401);
    await expect(connect("icm_wrong")).rejects.toThrow();
  });

  it("rejects unknown Host headers", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: new URL(base).port, path: "/healthz", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("viewer sees only read tools; owner sees everything", async () => {
    const v = await connect(viewerKey);
    const o = await connect(ownerKey);
    const vNames = (await v.listTools()).tools.map((t) => t.name);
    const oNames = (await o.listTools()).tools.map((t) => t.name);
    expect(oNames.length).toBeGreaterThan(vNames.length);
    expect(vNames).toContain("wc_list_products");
    expect(vNames).not.toContain("wc_update_product");
    expect(vNames).not.toContain("pc_exec");
    expect(oNames).toContain("pc_exec");
    expect(oNames).toContain("search");
    expect(oNames).toContain("fetch");
    const denied = await call(v, "wc_update_product", { id: 7, regular_price: "1" });
    expect(denied.isError).toBe(true);
    await v.close();
    await o.close();
  });
});

describe("WordPress / WooCommerce", () => {
  it("lists posts through the REST API with Basic auth, never leaking the password", async () => {
    const c = await connect(ownerKey);
    const r = await call(c, "wp_list_posts", { status: "draft" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).items[0].title).toBe("سلام");
    const sent = wpCalls.find((x) => x.url.startsWith("/wp-json/wp/v2/posts"))!;
    expect(sent.auth).toBe(`Basic ${Buffer.from("bot:app-pass-secret-1").toString("base64")}`);
    expect(text(r)).not.toContain("app-pass-secret-1");
    await c.close();
  });

  it("price change needs a confirm_token, and the token only works for identical arguments", async () => {
    const c = await connect(ownerKey);
    const args = { id: 7, regular_price: "1200" };
    const first = JSON.parse(text(await call(c, "wc_update_product", args)));
    expect(first.status).toBe("confirmation_required");
    expect(first.preview.before.regular_price).toBe("1000");
    expect(first.preview.after.regular_price).toBe("1200");
    expect(wpCalls.some((x) => x.method === "PUT")).toBe(false); // nothing written yet

    const tampered = await call(c, "wc_update_product", { id: 7, regular_price: "1", confirm_token: first.confirm_token });
    expect(JSON.parse(text(tampered)).status).toBe("confirmation_required");
    expect(wpCalls.some((x) => x.method === "PUT")).toBe(false);

    const done = await call(c, "wc_update_product", { ...args, confirm_token: first.confirm_token });
    expect(done.isError).toBeFalsy();
    expect(wpCalls.find((x) => x.method === "PUT")!.body).toMatchObject({ regular_price: "1200" });
    await c.close();
  });

  it("blocks private/internal image URLs (SSRF)", async () => {
    const c = await connect(ownerKey);
    const r = await call(c, "wp_upload_media_from_url", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/private|not allowed/i);
    await c.close();
  });
});

describe("Instagram (Instagram Login API)", () => {
  it("reads profile with the stored token", async () => {
    const c = await connect(ownerKey);
    const r = JSON.parse(text(await call(c, "ig_profile")));
    expect(r.username).toBe("irancamping");
    expect(r.followers_count).toBe(1234);
    await c.close();
  });

  it("publishing is two-step and returns the permalink", async () => {
    const c = await connect(ownerKey);
    const args = { image_url: "http://127.0.0.1:1/photo.jpg", caption: "تست" };
    const first = JSON.parse(text(await call(c, "ig_publish_photo", args)));
    expect(first.status).toBe("confirmation_required");
    expect(first.preview.account).toBe("@irancamping");
    const done = JSON.parse(text(await call(c, "ig_publish_photo", { ...args, confirm_token: first.confirm_token })));
    expect(done).toEqual({ id: "media1", permalink: "https://instagram.com/p/abc" });
    await c.close();
  });

  it("explains expired-token errors and hides the token", async () => {
    const c = await connect(ownerKey);
    const r = await call(c, "ig_list_comments", { media_id: "bad" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("reconnect");
    expect(text(r)).not.toContain("IGTOKEN-abcdef");
    await c.close();
  });

  it("schedules a post and lists it", async () => {
    const c = await connect(ownerKey);
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const args = { kind: "story", schedule_at: when, media_url: "http://127.0.0.1:1/s.jpg" };
    const first = JSON.parse(text(await call(c, "ig_schedule_post", args)));
    await call(c, "ig_schedule_post", { ...args, confirm_token: first.confirm_token });
    const list = JSON.parse(text(await call(c, "ig_list_scheduled")));
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("story");
    await c.close();
  });
});

describe("shared notes + audit", () => {
  it("notes are searchable via hub tools and the OpenAI-style search/fetch", async () => {
    const c = await connect(ownerKey);
    await call(c, "hub_note_save", { title: "لحن برند", body: "لحن ما صمیمی و محترمانه است", tags: "brand" });
    const found = JSON.parse(text(await call(c, "hub_note_search", { query: "صمیمی" })));
    expect(found).toHaveLength(1);
    const s = JSON.parse(text(await call(c, "search", { query: "صمیمی" })));
    const id = s.results.find((r: { id: string }) => r.id.startsWith("note:")).id;
    const f = JSON.parse(text(await call(c, "fetch", { id })));
    expect(f.text).toContain("صمیمی");
    await c.close();
  });

  it("every call is audited, with secrets redacted", async () => {
    const c = await connect(ownerKey);
    const log = JSON.parse(text(await call(c, "hub_audit_log", { limit: 100 })));
    expect(log.some((e: { tool: string; outcome: string }) => e.tool === "wc_update_product" && e.outcome === "confirm_required")).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/confirm_token":"[A-Za-z0-9_-]{20,}/);
    await c.close();
  });
});

describe("defense in depth", () => {
  it("invoke() itself refuses a tool the user lacks access to, and audits it", async () => {
    const viewer = hub.users.list().find((u) => u.name === "viewer")!;
    const def = hub.allTools().find((t) => t.name === "wc_update_product")!;
    const r = await hub.invoke(def, { id: 7, regular_price: "1" }, { user: hub.users.byId(viewer.id)!, hub });
    expect(r.isError).toBe(true);
    expect(hub.audit.recent(5, { outcome: "denied" })).toHaveLength(1);
  });
});

describe("PC bridge", () => {
  it("is offline until an agent connects, then relays calls", async () => {
    const c = await connect(ownerKey);
    const offline = await call(c, "pc_status");
    expect(JSON.parse(text(offline)).online).toEqual([]);

    // wrong token is refused
    await new Promise<void>((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/agent/ws`, { headers: { authorization: "Bearer nope" } });
      bad.on("unexpected-response", (_q, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      bad.on("error", () => resolve());
    });

    const cfg = { hubUrl: "", token: "", name: "main", roots: [], writeRoots: [], allowExec: false, httpAllow: [], apps: {}, aiProviders: {} };
    const handlers = createHandlers(cfg);
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/agent/ws`, { headers: { authorization: "Bearer pc-token-pc-token-1234567890" } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", name: "main", hostname: "test-pc", capabilities: ["fs"] }));
    ws.on("message", async (raw) => {
      const m = JSON.parse(raw.toString());
      if (!m.id) return;
      try {
        ws.send(JSON.stringify({ id: m.id, result: await handlers[m.method]!(m.params) }));
      } catch (e) {
        ws.send(JSON.stringify({ id: m.id, error: { message: (e as Error).message } }));
      }
    });
    await new Promise((r) => setTimeout(r, 100));

    const status = JSON.parse(text(await call(c, "pc_status")));
    expect(status.online[0].hostname).toBe("test-pc");
    expect(status.info.exec_enabled).toBe(false);

    // file access is denied when no folder is enabled
    const read = await call(c, "pc_read_file", { path: "/etc/hostname" });
    expect(read.isError).toBe(true);
    expect(text(read)).toMatch(/No folders are enabled/);

    // exec requires confirmation AND agent opt-in
    const first = JSON.parse(text(await call(c, "pc_exec", { command: "echo hi" })));
    expect(first.status).toBe("confirmation_required");
    const exec = await call(c, "pc_exec", { command: "echo hi", confirm_token: first.confirm_token });
    expect(exec.isError).toBe(true);
    expect(text(exec)).toMatch(/disabled on this PC/);

    ws.close();
    await c.close();
  });
});

describe("OAuth (what Claude.ai / ChatGPT use)", () => {
  it("dynamic registration → login page → code → token → MCP call; refresh rotates", async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.code_challenge_methods_supported).toContain("S256");
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(`${base}/mcp`);

    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
    expect(reg.client_id).toBeTruthy();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(meta.authorization_endpoint);
    Object.entries({ client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${base}/mcp` }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const page = await fetch(authUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain("کلید دسترسی");

    const form = (key: string) => new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, state: "xyz", scope: "", resource: `${base}/mcp`, access_key: key });
    const bad = await fetch(`${base}/oauth/login`, { method: "POST", body: form("icm_nope"), redirect: "manual" });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/oauth/login`, { method: "POST", body: form(ownerKey), redirect: "manual" });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;

    // wrong verifier fails
    const wrong = await fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, code, code_verifier: "x".repeat(50), redirect_uri: redirect }) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    // (code is single-use even after a failed attempt? the SDK checks PKCE before exchange, so it survives)
    const tok = await (await fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource: `${base}/mcp` }) })).json();
    expect(tok.access_token).toMatch(/^icmat_/);

    const c = await connect(tok.access_token);
    expect((await c.listTools()).tools.length).toBeGreaterThan(30);
    await c.close();

    const refreshed = await (await fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: tok.refresh_token }) })).json();
    expect(refreshed.access_token).toBeTruthy();
    const reuse = await fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: tok.refresh_token }) });
    expect(reuse.status).toBeGreaterThanOrEqual(400); // rotated refresh tokens are single-use
  });
});

describe("agent bus", () => {
  it("agents push events with their own token; handoff tasks are pulled and answered", async () => {
    const { hub: h2 } = makeHub(
      {},
      JSON.stringify({ agents: [{ id: "barney", name: "Barney", description: "d", protocol: "http", baseUrl: "http://127.0.0.1:1" }] }),
    );
    process.env.AGENT_BUS_TOKEN_BARNEY = "bus-token-bus-token-123456";
    const { app } = createApp(h2);
    const srv = createServer(app);
    const port = await listen(srv);
    const owner = h2.users.create("o", "owner").user;
    const tool = h2.allTools().find((t) => t.name === "agent_handoff")!;
    await h2.invoke(tool, { agent_id: "barney", title: "Check stock", details: "Tent 7" }, { user: owner, hub: h2 });

    const h = { authorization: "Bearer bus-token-bus-token-123456", "content-type": "application/json" };
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    expect((await fetch(url("/api/agents/tasks"), { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const tasks = await (await fetch(url("/api/agents/tasks"), { headers: h })).json();
    expect(tasks.tasks[0].title).toBe("Check stock");
    const res = await fetch(url(`/api/agents/tasks/${tasks.tasks[0].id}/result`), { method: "POST", headers: h, body: JSON.stringify({ answer: "5 in stock" }) });
    expect(res.status).toBe(200);
    expect((await (await fetch(url("/api/agents/tasks"), { headers: h })).json()).tasks).toHaveLength(0);
    await fetch(url("/api/agents/events"), { method: "POST", headers: h, body: JSON.stringify({ kind: "alert", payload: { msg: "low stock" } }) });
    const inbox = h2.db.all<{ source: string; kind: string }>("SELECT source, kind FROM inbox WHERE source LIKE 'agent:%'");
    expect(inbox.map((r) => r.kind).sort()).toEqual(["alert", "task_result"]);
    srv.close();
  });
});
