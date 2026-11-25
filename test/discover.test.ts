import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SECRET = "sk-live-ABCDEFGHIJKLMNOPQRSTUV1234567890";

describe("tools/discover-agents.mjs (read-only discovery)", () => {
  it("builds the registry with evidence, never copies secret values, never writes outside --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    const root = join(dir, "ic-agents");
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "barney"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "state", "PAUSED"), "1");
    writeFileSync(join(root, "node_modules", "x", "package.json"), "{}");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { rahim: { type: "sse", url: `https://h.example/sse?token=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } }, local: { command: "C:\\tools\\node.exe", args: ["srv.js"], env: { API_KEY: SECRET } } } }));
    writeFileSync(join(root, "agent_catalog.json"), JSON.stringify({ agents: [{ id: "barney.research", owner: "rahim", purpose: "study", runtime: "python", api_key: SECRET, tools: ["web"] }, { id: "barney.research" }] }));
    writeFileSync(join(root, "barney", "package.json"), JSON.stringify({ name: "barney-hq", version: "1.2.3", scripts: { start: "x" }, dependencies: { express: "4" } }));
    writeFileSync(join(root, "AGENTS.md"), "# Agents\nsecret " + SECRET);

    const seed = join(dir, "seed.json");
    writeFileSync(seed, JSON.stringify({ watchFiles: [join(root, "state", "PAUSED")], services: [
      { agent_id: "ollama", base_url: "http://127.0.0.1:11434", protocol: "REST", openai_compatible: true, probes: [{ path: "/api/tags" }, { path: "/v1/models" }] },
      { agent_id: "mobile", base_url: "http://127.0.0.1:17843", protocol: "REST", probes: [{ path: "/healthz" }, { path: "/api/status", expect: [200, 401] }] },
      { agent_id: "dead", base_url: "http://127.0.0.1:1234", protocol: "REST", probes: [{ path: "/v1/models" }] },
      { agent_id: "unprobed", base_url: null, protocol: null },
    ] }));

    const methods: string[] = [];
    const srv = createServer((req, res) => {
      methods.push(req.method ?? "");
      if (req.url === "/api/tags") return void res.setHeader("content-type", "application/json").end(JSON.stringify({ models: [] }));
      if (req.url === "/healthz") return void res.end("ok");
      if (req.url === "/api/status") return void res.writeHead(401).end("{}");
      res.writeHead(404).end("no");
    });
    const port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
    const out = join(dir, "out");
    const stdout = await new Promise<string>((resolve, reject) => {
      import("node:child_process").then(({ execFile }) =>
        execFile("node", ["tools/discover-agents.mjs", "--roots", root, "--out", out, "--seed", seed, "--probe-base", `http://127.0.0.1:${port}`, "--no-netstat"], (e, so) => (e ? reject(e) : resolve(so))),
      );
    });
    srv.close();

    const reg = JSON.parse(readFileSync(join(out, "AGENT_API_REGISTRY.json"), "utf8")).services as Array<{ agent_id: string; status: string; evidence: string[] }>;
    const by = Object.fromEntries(reg.map((r) => [r.agent_id, r]));
    expect(by.ollama.status).toBe("PARTIAL"); // /api/tags passes, /v1/models 404
    expect(by.mobile.status).toBe("VERIFIED"); // 401 is an expected answer for the protected endpoint
    expect(by.mobile.evidence.join()).toContain("/api/status → 401");
    expect(by.dead.status).toBe("UNREACHABLE");
    expect(by.unprobed.status).toBe("UNKNOWN");
    expect(by["mcp:rahim"]).toBeDefined();
    expect(by["mcp:local"].credential_reference).toContain("API_KEY");
    expect(by["agent:barney.research"].purpose).toBe("study");
    expect(reg.filter((r) => r.agent_id.includes("barney.research"))).toHaveLength(1); // no duplicates
    expect(stdout).toContain("services:");

    // read-only: GET only, files present, node_modules skipped, PAUSED untouched
    expect(new Set(methods)).toEqual(new Set(["GET"]));
    expect(readFileSync(join(root, "state", "PAUSED"), "utf8")).toBe("1");
    const all = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    expect(all).toContain("PAUSED: EXISTS");
    expect(all).not.toContain("node_modules");
    expect(readdirSync(out).sort()).toEqual(["AGENT_API_REGISTRY.json", "AGENT_API_REGISTRY.md", "AGENT_CONNECTION_TEST_REPORT.md", "AGENT_INTEGRATION_MATRIX.md", "discovery-details.json"]);

    // the crucial property: no secret VALUE anywhere in any output
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(all).toContain("Authorization"); // header NAME is kept
  });
});
