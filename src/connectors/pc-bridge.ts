import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { safeEqual } from "../core/crypto.js";
import { HubError } from "../util/text.js";

export interface PcInfo {
  name: string;
  hostname?: string;
  os?: string;
  agentVersion?: string;
  capabilities: string[];
  connectedAt: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Hub-side end of the PC link. The PC agent dials OUT to the hub (so no port-forwarding or public IP is
 * needed on the owner's computer) and the hub sends JSON-RPC style requests down the socket.
 */
export class PcBridge {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private peers = new Map<string, { ws: WebSocket; info: PcInfo; pending: Map<string, Pending> }>();

  constructor(private readonly token: string | undefined) {
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  get enabled(): boolean {
    return !!this.token;
  }

  online(): PcInfo[] {
    return [...this.peers.values()].map((p) => p.info);
  }

  /** Called from the HTTP server's `upgrade` event for path /agent/ws. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!this.token || !given || !safeEqual(given, this.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    let name: string | undefined;
    const alive = { ok: true };
    const heartbeat = setInterval(() => {
      if (!alive.ok) return ws.terminate();
      alive.ok = false;
      ws.ping();
    }, 20_000);
    ws.on("pong", () => (alive.ok = true));

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello" && typeof msg.name === "string") {
        const clean: string = msg.name.replace(/[^\w.-]/g, "").slice(0, 40) || "pc";
        name = clean;
        const existing = this.peers.get(clean);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced by a newer connection");
        this.peers.set(clean, {
          ws,
          pending: new Map(),
          info: {
            name: clean,
            hostname: msg.hostname,
            os: msg.os,
            agentVersion: msg.version,
            capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [],
            connectedAt: Date.now(),
          },
        });
        ws.send(JSON.stringify({ type: "welcome", name: clean }));
        return;
      }
      if (!name) return;
      const peer = this.peers.get(name);
      const p = peer?.pending.get(msg.id);
      if (!peer || !p) return;
      peer.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new HubError(String(msg.error.message ?? msg.error), "pc_error"));
      else p.resolve(msg.result);
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      if (!name) return;
      const peer = this.peers.get(name);
      if (peer && peer.ws === ws) {
        for (const p of peer.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new HubError("PC disconnected during the request.", "pc_offline"));
        }
        this.peers.delete(name);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  /** Call a method on a connected PC. `name` may be omitted when exactly one PC is online. */
  call<T = unknown>(method: string, params: unknown, opts: { name?: string; timeoutMs?: number } = {}): Promise<T> {
    let peer = opts.name ? this.peers.get(opts.name) : undefined;
    if (!opts.name) {
      if (this.peers.size === 1) peer = [...this.peers.values()][0];
      else if (this.peers.size > 1) throw new HubError(`Several PCs are online (${[...this.peers.keys()].join(", ")}); pass pc_name.`, "ambiguous");
    }
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
      throw new HubError(
        "The PC agent is offline. Make sure the computer is on, connected to the internet, and the agent is running (npm run agent).",
        "pc_offline",
      );
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer!.pending.delete(id);
        reject(new HubError(`PC did not answer within ${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s.`, "pc_timeout"));
      }, opts.timeoutMs ?? 60_000);
      peer!.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      peer!.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    for (const p of this.peers.values()) p.ws.close();
    this.peers.clear();
    this.wss.close();
  }
}
