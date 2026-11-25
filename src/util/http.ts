import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { HubError, scrub, truncate } from "./text.js";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Object → JSON, string → sent as-is, URLSearchParams → form-encoded */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** HTTP(S) proxy URL, e.g. http://user:pass@host:port */
  proxy?: string;
  /** Secret strings to scrub from error messages. */
  secrets?: Array<string | undefined>;
  /** Return non-2xx responses instead of throwing (caller inspects `ok`/`status`). */
  noThrow?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json: T | undefined;
}

const proxyAgents = new Map<string, Dispatcher>();
function dispatcherFor(proxy?: string): Dispatcher | undefined {
  if (!proxy) return undefined;
  let d = proxyAgents.get(proxy);
  if (!d) {
    d = new ProxyAgent(proxy);
    proxyAgents.set(proxy, d);
  }
  return d;
}

export function buildUrl(base: string, query?: HttpOptions["query"]): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Fetch with timeout, optional proxy, JSON handling and credential scrubbing. Throws HubError on non-2xx. */
export async function http<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  let body: string | URLSearchParams | Uint8Array | undefined;
  if (opts.body instanceof URLSearchParams) {
    body = opts.body;
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  } else if (opts.body instanceof Uint8Array) {
    body = opts.body;
  } else if (typeof opts.body === "string") {
    body = opts.body;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const target = buildUrl(url, opts.query);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await undiciFetch(target, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: ctl.signal,
      dispatcher: dispatcherFor(opts.proxy),
    });
    const text = await res.text();
    let json: T | undefined;
    try {
      json = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      json = undefined;
    }
    const response: HttpResponse<T> = {
      status: res.status,
      ok: res.ok,
      headers: res.headers as unknown as Headers,
      text,
      json,
    };
    if (!res.ok && !opts.noThrow) {
      const detail = scrub(truncate(text, 1500), opts.secrets ?? []);
      throw new HubError(`HTTP ${res.status} from ${new URL(target).host}: ${detail}`, "http_error", res.status);
    }
    return response;
  } catch (err) {
    if (err instanceof HubError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && (err as { cause?: { code?: string } }).cause?.code;
    const aborted = ctl.signal.aborted ? " (timeout)" : "";
    throw new HubError(
      scrub(`Request to ${new URL(target).host} failed${aborted}: ${msg}${cause ? ` [${cause}]` : ""}`, opts.secrets ?? []),
      "network_error",
    );
  } finally {
    clearTimeout(timer);
  }
}
