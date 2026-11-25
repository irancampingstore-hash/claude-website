import type { z } from "zod";
import type { Hub } from "./hub.js";

export type Level = "none" | "read" | "write" | "admin";
export const LEVEL_RANK: Record<Level, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** Connector ids double as permission scopes. */
export const CONNECTOR_IDS = ["wordpress", "vps", "pc", "localai", "instagram", "agents", "hub"] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export interface HubUser {
  id: string;
  name: string;
  role: string;
  grants: Partial<Record<ConnectorId, Level>>;
}

export interface ToolContext {
  user: HubUser;
  hub: Hub;
  /** Which AI client is calling (from the MCP initialize handshake or user-agent), for the audit log. */
  client?: string;
}

export interface ToolResultObject {
  /** Human-readable result shown to the model. */
  text: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  connector: ConnectorId;
  /** Minimum permission level the caller needs on `connector`. */
  level: Exclude<Level, "none">;
  input: z.ZodRawShape;
  /** If true, the first call returns a preview + confirm_token; the action runs on the second call. */
  confirm?: boolean;
  /** Build the preview shown before confirmation (defaults to the arguments). */
  preview?: (args: any, ctx: ToolContext) => Promise<unknown> | unknown;
  destructive?: boolean;
  openWorld?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ConnectorHealth {
  ok: boolean;
  detail: string;
}

export interface Connector {
  id: ConnectorId;
  title: string;
  /** Short Persian + English summary used in hub_overview. */
  summary: string;
  tools: ToolDef[];
  health(): Promise<ConnectorHealth>;
  /** Called once when the HTTP server starts (timers, websocket servers…). */
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export function levelAtLeast(have: Level | undefined, need: Level): boolean {
  return LEVEL_RANK[have ?? "none"] >= LEVEL_RANK[need];
}
