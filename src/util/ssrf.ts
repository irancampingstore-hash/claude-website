import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HubError } from "./text.js";

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a, b] = [p[0] ?? 0, p[1] ?? 0];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]!) : false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * Guard for user-supplied URLs the hub will fetch (image URLs for uploads, etc.).
 * Only public http(s) hosts are allowed — never localhost, LAN or cloud-metadata addresses.
 */
export async function assertPublicUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HubError(`Invalid URL: ${raw}`, "bad_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HubError("Only http(s) URLs are allowed", "bad_url");
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new HubError("Local/internal hosts are not allowed", "ssrf_blocked");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new HubError(`Host resolves to a private address (${a.address})`, "ssrf_blocked");
  }
  return url;
}

/**
 * Fetch a user-supplied URL while re-validating every redirect hop (a public URL must not bounce us to
 * an internal address). Returns the final response.
 */
export async function fetchPublic(
  raw: string,
  opts: { method?: "GET" | "HEAD"; timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<import("undici").Response> {
  const { fetch: undiciFetch } = await import("undici");
  let url = await assertPublicUrl(raw, { allowPrivate: opts.allowPrivate });
  for (let hop = 0; hop < 4; hop++) {
    const res = await undiciFetch(url, { method: opts.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.arrayBuffer().catch(() => undefined);
      url = await assertPublicUrl(new URL(loc, url).toString(), { allowPrivate: opts.allowPrivate });
      continue;
    }
    return res;
  }
  throw new HubError("Too many redirects.", "bad_url");
}
