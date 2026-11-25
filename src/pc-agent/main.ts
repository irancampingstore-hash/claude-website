import { hostname, platform, release } from "node:os";
import { WebSocket } from "ws";
import { loadEnvFileIfPresent } from "../core/config.js";
import { loadAgentConfig } from "./config.js";
import { AGENT_VERSION, createHandlers } from "./handlers.js";

/**
 * Iran Camping PC agent.
 * Runs on YOUR computer, dials out to the hub over wss:// and answers requests (files, apps, local AI models).
 * Nothing listens on your machine, so no port-forwarding / public IP is needed.
 */
loadEnvFileIfPresent(".env.agent");
loadEnvFileIfPresent(".env");
const cfg = loadAgentConfig();
const handlers = createHandlers(cfg);

let backoff = 1000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function connect(): void {
  const ws = new WebSocket(cfg.hubUrl, { headers: { authorization: `Bearer ${cfg.token}` }, handshakeTimeout: 15_000 });

  ws.on("open", () => {
    backoff = 1000;
    log(`connected to ${cfg.hubUrl}`);
    ws.send(
      JSON.stringify({
        type: "hello",
        name: cfg.name,
        hostname: hostname(),
        os: `${platform()} ${release()}`,
        version: AGENT_VERSION,
        capabilities: ["fs", cfg.allowExec ? "exec" : "", "apps", "ai"].filter(Boolean),
      }),
    );
  });

  ws.on("message", async (raw) => {
    let msg: { id?: string; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.id || !msg.method) return;
    const handler = handlers[msg.method];
    try {
      if (!handler) throw new Error(`Unknown method ${msg.method}`);
      const result = await handler(msg.params ?? {});
      ws.send(JSON.stringify({ id: msg.id, result }));
      log(`ok   ${msg.method}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ws.send(JSON.stringify({ id: msg.id, error: { message } }));
      log(`fail ${msg.method}: ${message}`);
    }
  });

  ws.on("close", (code, reason) => {
    log(`disconnected (${code} ${reason.toString()}) — retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.on("error", (e) => log(`socket error: ${e.message}`));
}

log(`Iran Camping PC agent v${AGENT_VERSION} — name=${cfg.name}, exec=${cfg.allowExec ? "ENABLED" : "off"}, folders=${cfg.roots.join(" | ") || "(none)"}`);
connect();
