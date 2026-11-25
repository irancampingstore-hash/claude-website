import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { Hub } from "./core/hub.js";
import { HubOAuthProvider } from "./auth/oauth.js";
import { agentForBusToken, loadAgents } from "./connectors/agents.js";
import type { InstagramService } from "./connectors/instagram-service.js";
import { safeEqual } from "./core/crypto.js";
import type { Server } from "node:http";
import type { PcBridge } from "./connectors/pc-bridge.js";

const page = (title: string, body: string, ok = true) =>
  `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px/1.8 Tahoma,system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:${ok ? "#1f3d24" : "#7a1d1d"}"><h2>${title}</h2><p>${body}</p></body></html>`;

export function createApp(hub: Hub): { app: express.Express; provider: HubOAuthProvider } {
  const cfg = hub.config;
  const app = express();
  app.disable("x-powered-by");
  if (cfg.trustProxy) app.set("trust proxy", 1);

  const publicUrl = new URL(cfg.publicUrl);
  const allowedHosts = new Set([publicUrl.host, publicUrl.hostname, "localhost", "127.0.0.1", `localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`]);

  // Host-header allow-list (blocks DNS-rebinding style requests)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host) && !allowedHosts.has(host.split(":")[0] ?? "")) {
      res.status(421).json({ error: "misdirected request: unknown Host header" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const provider = new HubOAuthProvider(hub.db, hub.users);
  const mcpUrl = new URL(`${cfg.publicUrl}/mcp`);

  /* ───────── OAuth endpoints (/authorize /token /register /revoke + .well-known) ───────── */
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: ["mcp"],
      resourceName: "Iran Camping Hub",
    }),
  );
  app.post("/oauth/login", express.urlencoded({ extended: false, limit: "20kb" }), (req, res) => provider.handleLogin(req, res));

  /* ───────── MCP endpoint (stateless Streamable HTTP) ───────── */
  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  app.post("/mcp", auth, express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    const userId = req.auth?.extra?.userId as string | undefined;
    const user = userId ? hub.users.byId(userId) : undefined;
    if (!user) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or disabled user" }, id: null });
      return;
    }
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 60);
    const clientInfo = (req.body as { params?: { clientInfo?: { name?: string } } })?.params?.clientInfo?.name;
    const server = hub.buildServer(user, clientInfo ?? ua ?? req.auth?.clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP request failed:", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  /* ───────── Instagram: OAuth callback + webhooks ───────── */
  app.get("/instagram/callback", async (req, res) => {
    const ig = hub.services.get("instagram") as InstagramService | undefined;
    if (!ig) return void res.status(404).send(page("غیرفعال", "اینستاگرام پیکربندی نشده است.", false));
    const { code, state, error_description: errDesc } = req.query as Record<string, string | undefined>;
    if (!code || !state) return void res.status(400).send(page("اتصال ناموفق", errDesc ?? "پاسخ اینستاگرام ناقص بود.", false));
    try {
      const acc = await ig.handleCallback(code, state);
      res.send(page("✅ اتصال انجام شد", `حساب <b>@${acc.username.replace(/[<>&"]/g, "")}</b> به هاب متصل شد. می‌توانید این صفحه را ببندید.`));
    } catch (e) {
      console.error("Instagram callback failed:", e instanceof Error ? e.message : e);
      res.status(400).send(page("اتصال ناموفق", "اتصال انجام نشد. دوباره از ابتدا شروع کنید (ig_connect_start). جزئیات در لاگ سرور ثبت شد.", false));
    }
  });

  app.get("/instagram/webhook", (req, res) => {
    const expected = hub.config.instagram?.webhookVerifyToken;
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query as Record<string, string>;
    if (expected && mode === "subscribe" && token && safeEqual(token, expected)) return void res.status(200).type("text/plain").send(String(challenge ?? ""));
    res.sendStatus(403);
  });
  app.post("/instagram/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const ig = hub.services.get("instagram") as InstagramService | undefined;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!ig || !ig.verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) return void res.sendStatus(403);
    try {
      ig.ingest(JSON.parse(raw.toString("utf8")));
    } catch {
      /* malformed payloads are acknowledged to stop retries */
    }
    res.sendStatus(200);
  });

  /* ───────── Agent bus: agents push events / pull tasks with their own bus token ───────── */
  const agents = loadAgents(cfg.agentsConfigPath);
  const busAuth = (req: Request, res: Response, next: NextFunction) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const agent = token ? agentForBusToken(agents, token) : undefined;
    if (!agent) return void res.status(401).json({ error: "invalid bus token" });
    res.locals.agent = agent;
    next();
  };
  app.post("/api/agents/events", busAuth, express.json({ limit: "512kb" }), (req, res) => {
    const agent = res.locals.agent as { id: string };
    const { kind = "event", payload = {} } = (req.body ?? {}) as { kind?: string; payload?: unknown };
    hub.db.run("INSERT INTO inbox(source, kind, payload, ts) VALUES(?,?,?,?)", `agent:${agent.id}`, String(kind).slice(0, 40), JSON.stringify(payload).slice(0, 100_000), Date.now());
    res.json({ ok: true });
  });
  app.get("/api/agents/tasks", busAuth, (_req, res) => {
    const agent = res.locals.agent as { id: string };
    const rows = hub.db.all<{ id: number; payload: string; ts: number }>("SELECT id, payload, ts FROM inbox WHERE source = ? AND kind = 'task' AND status = 'new' ORDER BY id LIMIT 20", `to:${agent.id}`);
    res.json({ tasks: rows.map((r) => ({ id: r.id, created_at: new Date(r.ts).toISOString(), ...(JSON.parse(r.payload) as object) })) });
  });
  app.post("/api/agents/tasks/:id/result", busAuth, express.json({ limit: "512kb" }), (req, res) => {
    const agent = res.locals.agent as { id: string };
    const id = Number(req.params.id);
    const owned = hub.db.get("SELECT id FROM inbox WHERE id = ? AND source = ?", id, `to:${agent.id}`);
    if (!owned) return void res.status(404).json({ error: "no such task" });
    hub.db.run("UPDATE inbox SET status = 'handled' WHERE id = ?", id);
    hub.db.run("INSERT INTO inbox(source, kind, payload, ts) VALUES(?, 'task_result', ?, ?)", `agent:${agent.id}`, JSON.stringify({ task_id: id, result: req.body }).slice(0, 100_000), Date.now());
    res.json({ ok: true });
  });

  /* ───────── misc ───────── */
  app.get("/healthz", (_req, res) => void res.json({ ok: true, name: "iran-camping-hub" }));
  app.get("/", (_req, res) => void res.type("text/plain").send("Iran Camping MCP Hub — MCP endpoint: /mcp (POST). See docs/CONNECT.md.\n"));

  return { app, provider };
}


/** Route WebSocket upgrades for the PC agent link (/agent/ws). */
export function attachWebSocket(server: Server, hub: Hub): void {
  server.on("upgrade", (req, socket, head) => {
    const bridge = hub.services.get("pcBridge") as PcBridge | undefined;
    if (bridge && new URL(req.url ?? "/", "http://x").pathname === "/agent/ws") bridge.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
}
