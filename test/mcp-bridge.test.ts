import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { attachWebSocket, createApp } from "../src/app.js";
import { loadAgentConfig } from "../src/pc-agent/config.js";
import { createHandlers } from "../src/pc-agent/handlers.js";
import type { Hub } from "../src/core/hub.js";
import { makeHub } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "fixtures/echo-mcp.mjs");
const baseCfg = { hubUrl: "", token: "", name: "main", roots: [], writeRoots: [], allowExec: false, httpAllow: [], apps: {}, aiProviders: {} };

describe("PC agent: local stdio MCP servers", () => {
  const cfg = { ...baseCfg, mcpServers: { echo: { command: process.execPath, args: [fixture], env: { TEST_FLAG: "from-config" } } } };
  const h = createHandlers(cfg);

  it("lists, introspects and calls an allow-listed server; env comes from the PC config", async () => {
    expect(await h["mcp.servers"]!({})).toEqual({ servers: ["echo"] });
    const t = (await h["mcp.tools"]!({ server: "echo" })) as { tools: Array<{ name: string }> };
    expect(t.tools.map((x) => x.name).sort()).toEqual(["add", "echo", "whoami"]);
    const r = (await h["mcp.call"]!({ server: "echo", tool: "add", args: { a: 2, b: 40 } })) as { content: Array<{ text: string }>; is_error: boolean };
    expect(r.is_error).toBe(false);
    expect(r.content[0]!.text).toBe("42");
    const env = (await h["mcp.call"]!({ server: "echo", tool: "whoami", args: {} })) as { content: Array<{ text: string }> };
    expect(env.content[0]!.text).toBe("TEST_FLAG=from-config");
  });

  it("refuses servers that are not enabled", async () => {
    await expect(h["mcp.tools"]!({ server: "notes" })).rejects.toThrow(/not enabled on this PC/);
    await expect(createHandlers({ ...baseCfg, mcpServers: {} })["mcp.call"]!({ server: "echo", tool: "echo", args: {} })).rejects.toThrow(/not enabled/);
  });

  it("from an existing .mcp.json only the allow-listed names become reachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const file = join(dir, ".mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { knowledge: { command: "node", args: ["k.js"] }, "aws-write": { command: "uvx", args: ["--allow-write"] }, secretful: { command: "x", env: { TOKEN: "t" } } } }));
    const c = loadAgentConfig({ HUB_URL: "wss://h/agent/ws", PC_AGENT_TOKEN: "t".repeat(20), PC_MCP_CONFIG: file, PC_MCP_ALLOW: "knowledge", PC_AGENT_CONFIG: join(dir, "none.json") } as NodeJS.ProcessEnv);
    expect(Object.keys(c.mcpServers)).toEqual(["knowledge"]);
    const none = loadAgentConfig({ HUB_URL: "wss://h/agent/ws", PC_AGENT_TOKEN: "t".repeat(20), PC_MCP_CONFIG: file, PC_AGENT_CONFIG: join(dir, "none.json") } as NodeJS.ProcessEnv);
    expect(Object.keys(none.mcpServers)).toEqual([]); // nothing exposed unless named
  });
});

describe("hub → PC bridge → local MCP server (end to end)", () => {
  let hub: Hub;
  let srv: Server;
  let port: number;
  let ws: WebSocket;
  beforeAll(async () => {
    srv = createServer();
    port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
    hub = makeHub({ HUB_PUBLIC_URL: `http://127.0.0.1:${port}`, PC_AGENT_TOKEN: "pc-token-pc-token-1234567890" }).hub;
    srv.on("request", createApp(hub).app);
    attachWebSocket(srv, hub);
    const handlers = createHandlers({ ...baseCfg, mcpServers: { echo: { command: process.execPath, args: [fixture] } } });
    ws = new WebSocket(`ws://127.0.0.1:${port}/agent/ws`, { headers: { authorization: "Bearer pc-token-pc-token-1234567890" } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", name: "main", hostname: "pc", capabilities: ["mcp"] }));
    ws.on("message", async (raw) => {
      const m = JSON.parse(raw.toString());
      if (!m.id) return;
      try { ws.send(JSON.stringify({ id: m.id, result: await handlers[m.method]!(m.params) })); } catch (e) { ws.send(JSON.stringify({ id: m.id, error: { message: (e as Error).message } })); }
    });
    await new Promise((r) => setTimeout(r, 100));
  });
  afterAll(async () => { ws.close(); srv.close(); await hub.stop(); });

  it("owner can discover and call it; calls need confirmation; viewer cannot see the write tool", async () => {
    const owner = hub.users.byId(hub.users.create("owner", "owner").user.id)!;
    const run = async (n: string, a: object) => { const r = await hub.invoke(hub.allTools().find((t) => t.name === n)!, a, { user: owner, hub }); const t = (r.content[0] as { text: string }).text; return { err: r.isError, d: (() => { try { return JSON.parse(t); } catch { return t; } })() }; };
    expect((await run("pc_mcp_servers", {})).d).toEqual({ servers: ["echo"] });
    expect((await run("pc_mcp_tools", { server: "echo" })).d.tools).toHaveLength(3);
    const args = { server: "echo", tool_name: "echo", arguments_json: JSON.stringify({ text: "سلام" }) };
    const first = await run("pc_mcp_call", args);
    expect(first.d.status).toBe("confirmation_required");
    const done = await run("pc_mcp_call", { ...args, confirm_token: first.d.confirm_token });
    expect(done.d.untrusted_tool_result.content[0].text).toBe("echo:سلام");
    const viewer = hub.users.byId(hub.users.create("v", "viewer").user.id)!;
    expect(hub.toolsFor(viewer).map((t) => t.name)).not.toContain("pc_mcp_call");
    expect((await run("pc_mcp_call", { server: "ghost", tool_name: "x", confirm_token: undefined })).d.status).toBe("confirmation_required");
  });
});

describe("agents with legacy SSE transport", () => {
  let srv: Server;
  afterAll(() => srv?.close());
  it("hub connects over SSE with the configured auth header and lists tools", async () => {
    const app = express();
    const seenAuth: string[] = [];
    const transports = new Map<string, SSEServerTransport>();
    const build = () => { const s = new McpServer({ name: "legacy", version: "1" }); s.registerTool("ping", { description: "p", inputSchema: { x: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "pong" }] })); return s; };
    app.get("/sse", async (req, res) => { seenAuth.push(String(req.headers["x-api-key"] ?? "")); const t = new SSEServerTransport("/messages", res); transports.set(t.sessionId, t); res.on("close", () => transports.delete(t.sessionId)); await build().connect(t); });
    app.post("/messages", express.json(), async (req, res) => { const t = transports.get(String(req.query.sessionId)); if (!t) return void res.sendStatus(404); await t.handlePostMessage(req, res, req.body); });
    srv = createServer(app);
    const port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
    process.env.LEGACY_KEY = "secret-sse-key-123";
    const { hub } = makeHub({}, JSON.stringify({ agents: [{ id: "legacy", name: "L", description: "d", protocol: "mcp", transport: "sse", baseUrl: `http://127.0.0.1:${port}/sse`, authEnv: "LEGACY_KEY", authHeader: "x-api-key", authPrefix: "" }] }));
    const owner = hub.users.byId(hub.users.create("o", "owner").user.id)!;
    const r = await hub.invoke(hub.allTools().find((t) => t.name === "agent_mcp_list_tools")!, { agent_id: "legacy" }, { user: owner, hub });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as { text: string }).text).map((t: { name: string }) => t.name)).toEqual(["ping"]);
    expect(seenAuth[0]).toBe("secret-sse-key-123");
  });
});
