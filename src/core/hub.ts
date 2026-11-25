import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HubConfig } from "./config.js";
import { Db } from "./db.js";
import { Audit, Confirmer, RateLimiter } from "./guards.js";
import { UserStore } from "./users.js";
import {
  levelAtLeast,
  type Connector,
  type ConnectorHealth,
  type HubUser,
  type ToolContext,
  type ToolDef,
} from "./types.js";
import { HubError, scrub, toJsonText } from "../util/text.js";

export const HUB_VERSION = "0.1.0";

const INSTRUCTIONS = `
Iran Camping unified hub (هاب یکپارچه ایران کمپینگ).
Tools are grouped by prefix: wp_/wc_ (irancamping.com WordPress + WooCommerce), vps_ (iranoutdoor.com server),
pc_ / local_ai_ (owner's computer and local AI models), ig_ (Instagram), agent_ (Iran Camping & Barney AI agents),
hub_ (shared notes, cross-system workflows, health). The generic search/fetch tools search every connected system.

Rules: (1) Content is created as DRAFT unless the user explicitly asks to publish. (2) Risky tools return a preview and a
confirm_token — show the preview to the user, and only repeat the call with the token after the user approves.
(3) Never reveal credentials. (4) Reply to the user in the language they write in (Persian by default).
`.trim();

export class Hub {
  readonly db: Db;
  readonly users: UserStore;
  readonly audit: Audit;
  readonly confirmer: Confirmer;
  readonly limiter: RateLimiter;
  readonly connectors: Connector[] = [];
  /** Late-bound services connectors can share (e.g. the PC bridge used by pc_* and local_ai_*). */
  readonly services = new Map<string, unknown>();

  constructor(readonly config: HubConfig, db?: Db) {
    this.db = db ?? new Db(config.dataDir, config.secret);
    this.users = new UserStore(this.db);
    this.audit = new Audit(this.db);
    this.confirmer = new Confirmer(config.secret);
    this.limiter = new RateLimiter(config.rateLimitPerMinute);
  }

  register(connector: Connector | undefined): void {
    if (connector) this.connectors.push(connector);
  }

  connector(id: string): Connector | undefined {
    return this.connectors.find((c) => c.id === id);
  }

  allTools(): ToolDef[] {
    return this.connectors.flatMap((c) => c.tools);
  }

  toolsFor(user: HubUser): ToolDef[] {
    return this.allTools().filter((t) => levelAtLeast(user.grants[t.connector], t.level));
  }

  async start(): Promise<void> {
    for (const c of this.connectors) await c.start?.();
  }

  async stop(): Promise<void> {
    for (const c of this.connectors) await c.stop?.();
    this.db.close();
  }

  async health(): Promise<Record<string, ConnectorHealth>> {
    const out: Record<string, ConnectorHealth> = {};
    await Promise.all(
      this.connectors.map(async (c) => {
        try {
          out[c.id] = await Promise.race([
            c.health(),
            new Promise<ConnectorHealth>((r) => setTimeout(() => r({ ok: false, detail: "health check timed out" }), 8000)),
          ]);
        } catch (e) {
          out[c.id] = { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return out;
  }

  /** Execute a tool with permission, rate-limit, confirmation and audit handling. */
  async invoke(def: ToolDef, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const started = Date.now();
    const base = { userId: ctx.user.id, client: ctx.client, tool: def.name, connector: def.connector };
    const reply = (text: string, isError = false): CallToolResult => ({
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    });

    if (!levelAtLeast(ctx.user.grants[def.connector], def.level)) {
      this.audit.record({ ...base, outcome: "denied", args: rawArgs });
      return reply(`Permission denied: ${def.name} needs "${def.level}" access on "${def.connector}".`, true);
    }
    if (!this.limiter.allow(`${ctx.user.id}`)) {
      this.audit.record({ ...base, outcome: "rate_limited" });
      return reply("Rate limit reached. Wait a minute and try again.", true);
    }

    try {
      if (def.confirm && this.config.confirmMode === "token") {
        const token = typeof rawArgs.confirm_token === "string" ? rawArgs.confirm_token : undefined;
        if (!token || !this.confirmer.verify(token, ctx.user.id, def.name, rawArgs)) {
          const preview = def.preview ? await def.preview(rawArgs, ctx) : rawArgs;
          const { confirm_token: _drop, ...args } = rawArgs;
          const issued = this.confirmer.issue(ctx.user.id, def.name, rawArgs);
          this.audit.record({ ...base, outcome: "confirm_required", args });
          return reply(
            toJsonText({
              status: "confirmation_required",
              tool: def.name,
              preview,
              confirm_token: issued,
              expires_in_seconds: this.confirmer.ttlSeconds,
              next_step:
                "Show this preview to the user and ask for approval. Only if they approve, call the same tool again with the SAME arguments plus confirm_token. Do not change any argument.",
            }),
          );
        }
      }
      const { confirm_token: _t, ...handlerArgs } = rawArgs;
      const result = await def.handler(handlerArgs, ctx);
      const text = this.scrubOutput(toJsonText(result ?? { ok: true }));
      this.audit.record({ ...base, outcome: "ok", durationMs: Date.now() - started, args: rawArgs });
      return reply(text);
    } catch (err) {
      const message = this.scrubOutput(
        err instanceof HubError ? `${err.message}` : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.audit.record({ ...base, outcome: "error", durationMs: Date.now() - started, args: rawArgs, error: message });
      return reply(message, true);
    }
  }

  private scrubOutput(text: string): string {
    const c = this.config;
    return scrub(text, [
      c.secret,
      c.wordpress?.appPassword,
      c.wordpress?.wcKey,
      c.wordpress?.wcSecret,
      c.vps?.password,
      c.vps?.passphrase,
      c.instagram?.appSecret,
      c.pc.agentToken,
    ]);
  }

  /** Build an MCP server exposing only the tools this user may call. */
  buildServer(user: HubUser, client?: string): McpServer {
    const server = new McpServer(
      { name: "iran-camping-hub", version: HUB_VERSION, title: "Iran Camping Hub" },
      { instructions: INSTRUCTIONS },
    );
    const ctx: ToolContext = { user, hub: this, client };
    for (const def of this.toolsFor(user)) {
      const shape: z.ZodRawShape = { ...def.input } as z.ZodRawShape;
      if (def.confirm) {
        (shape as Record<string, unknown>).confirm_token = z
          .string()
          .optional()
          .describe("Only set when repeating the call after the user approved the preview. Copy it exactly from the earlier response.");
      }
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: shape,
          annotations: {
            readOnlyHint: def.level === "read",
            destructiveHint: !!def.destructive,
            idempotentHint: def.level === "read",
            openWorldHint: !!def.openWorld,
          },
        },
        async (args: Record<string, unknown>) => this.invoke(def, args ?? {}, ctx),
      );
    }
    return server;
  }
}
