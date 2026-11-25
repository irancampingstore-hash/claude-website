import { createHash } from "node:crypto";

export class HubError extends Error {
  constructor(
    message: string,
    public readonly code: string = "error",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|private[_-]?key|cookie|consumer/i;

/** Deep-copy a value, masking any property whose key looks like a credential. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactDeep(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** Remove known secret values from free text (error messages, command output). */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toJsonText(value: unknown, max = 30_000): string {
  if (typeof value === "string") return truncate(value, max);
  return truncate(JSON.stringify(value, null, 2) ?? "null", max);
}

/** Strip HTML tags and collapse whitespace (WordPress rendered fields). */
export function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
