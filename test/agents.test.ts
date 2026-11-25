import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { urlAllowed, createHandlers } from "../src/pc-agent/handlers.js";
import { makeHub } from "./helpers.js";

describe("queue-only agents (Agent One / Barney)", () => {
  const agentsJson = JSON.stringify({ agents: [
    { id: "barney", name: "Barney", description: "7 roles, no direct API", protocol: "queue" },
    { id: "fleet", name: "Fleet", description: "x", protocol: "http", baseUrl: "http://127.0.0.1:1" },
  ] });

  it("agent_ask explains queue-only; agent_handoff queues; listing marks the protocol", async () => {
    const { hub } = makeHub({}, agentsJson);
    const owner = hub.users.byId(hub.users.create("o", "owner").user.id)!;
    const run = async (n: string, a: object) => { const r = await hub.invoke(hub.allTools().find((t) => t.name === n)!, a, { user: owner, hub }); return { err: r.isError, text: (r.content[0] as { text: string }).text }; };
    const ask = await run("agent_ask", { agent_id: "barney", message: "hi" });
    expect(ask.err).toBe(true);
    expect(ask.text).toMatch(/queue-only[\s\S]*NOT the same as the agent executing/);
    expect((await run("agent_handoff", { agent_id: "barney", title: "Study task", details: "read X" })).err).toBeFalsy();
    expect(JSON.parse((await run("agents_list", {})).text).find((a: { id: string }) => a.id === "barney").protocol).toBe("queue");
    expect(hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox WHERE source='to:barney'")!.n).toBe(1);
    expect((await hub.connector("agents")!.health()).detail).toContain("barney: queue-only");
  });

  it("rejects a non-queue agent without baseUrl", () => {
    expect(() => makeHub({}, JSON.stringify({ agents: [{ id: "bad", name: "b", description: "d", protocol: "http" }] }))).toThrow(/baseUrl is required/);
  });
});

describe("PC read-only HTTP relay", () => {
  it("allow-list works on path boundaries and origins", () => {
    const allow = ["http://127.0.0.1:7422/fleet"];
    expect(urlAllowed("http://127.0.0.1:7422/fleet", allow)).toBe(true);
    expect(urlAllowed("http://127.0.0.1:7422/fleet/agents?x=1", allow)).toBe(true);
    expect(urlAllowed("http://127.0.0.1:7422/fleet-admin", allow)).toBe(false);
    expect(urlAllowed("http://127.0.0.1:7422/other", allow)).toBe(false);
    expect(urlAllowed("http://127.0.0.1:7423/fleet", allow)).toBe(false);
    expect(urlAllowed("http://evil.example/fleet", allow)).toBe(false);
    expect(urlAllowed("http://user:pw@127.0.0.1:7422/fleet", allow)).toBe(false);
    expect(urlAllowed("file:///etc/passwd", allow)).toBe(false);
    expect(urlAllowed("http://127.0.0.1:11434/x", ["http://127.0.0.1:11434"])).toBe(true); // origin-only entry = whole service
  });

  const srv = createServer((req, res) => {
    if (req.url === "/fleet") return void res.setHeader("content-type", "application/json").end(JSON.stringify({ agents: ["a"] }));
    if (req.url === "/big") return void res.setHeader("content-type", "application/json").end(JSON.stringify({ totals: { tasks: 254 }, queues: { Orchestrator: { counts: { pending: 23 } } }, rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, command: "x".repeat(60) })) }));
    if (req.url === "/text") return void res.end("plain");
    if (req.url === "/redir") return void res.writeHead(302, { location: "http://127.0.0.1:1/x" }).end();
    res.writeHead(404).end("no");
  });
  afterAll(() => srv.close());

  it("GETs allowed URLs, refuses redirects and anything not allow-listed", async () => {
    const port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
    const base = `http://127.0.0.1:${port}`;
    const cfg = { hubUrl: "", token: "", name: "m", roots: [], writeRoots: [], allowExec: false, apps: {}, aiProviders: {}, httpAllow: [`${base}/fleet`, `${base}/redir`, `${base}/big`, `${base}/text`] };
    const h = createHandlers(cfg);
    const ok = (await h["http.get"]!({ url: `${base}/fleet` })) as { status: number; body: string };
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ agents: ["a"] });
    const big = (await h["http.get"]!({ url: `${base}/big` })) as { truncated: boolean; body: string };
    expect(big.truncated).toBe(true); // a full 300 KB body is cut, as before
    const picked = (await h["http.get"]!({ url: `${base}/big`, pick: ["totals", "queues.Orchestrator.counts.pending", "rows[1].id", "missing.path"] })) as { body: string; full_size_bytes: number; truncated: boolean };
    expect(picked.truncated).toBe(false);
    expect(picked.full_size_bytes).toBeGreaterThan(300_000);
    expect(JSON.parse(picked.body)).toEqual({ totals: { tasks: 254 }, "queues.Orchestrator.counts.pending": 23, "rows[1].id": 1 });
    await expect(h["http.get"]!({ url: `${base}/text`, pick: ["a"] })).rejects.toThrow(/not JSON/);
    await expect(h["http.get"]!({ url: `${base}/secret` })).rejects.toThrow(/allow-list/);
    await expect(h["http.get"]!({ url: `${base}/redir` })).rejects.toThrow(/Redirects are not followed/);
    await expect(createHandlers({ ...cfg, httpAllow: [] })["http.get"]!({ url: `${base}/fleet` })).rejects.toThrow(/No local URLs are enabled/);
  });
});
