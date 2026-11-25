import type { z } from "zod";
import type { ConnectorId, ToolContext, ToolDef } from "../core/types.js";

/**
 * Typed tool factory: keeps handler args inferred from the zod shape while storing an erased ToolDef.
 *
 * Schema rules (so schemas stay valid for Claude, ChatGPT AND Gemini function calling):
 *  - flat objects only, no unions / $ref / records
 *  - free-form JSON goes in as a JSON *string* parameter
 *  - every parameter has a .describe()
 */
export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  connector: ConnectorId;
  level: "read" | "write" | "admin";
  input: S;
  confirm?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  preview?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown> | unknown;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown> | unknown;
}): ToolDef {
  return def as unknown as ToolDef;
}

export function parseJsonArg<T = unknown>(text: string | undefined, label: string): T | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`"${label}" must be a valid JSON string`);
  }
}

export function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined || Number.isNaN(v)) return dflt;
  return Math.min(Math.max(Math.trunc(v), min), max);
}
