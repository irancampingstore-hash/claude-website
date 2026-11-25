import { http } from "../util/http.js";
import { HubError } from "../util/text.js";

/** Client for the instagrapi sidecar in /ig-bridge (no Meta developer app required). */
export class BridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call<T = any>(method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string | number | boolean | undefined>; json?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const res = await http<any>(`${this.baseUrl}${path}`, {
      method,
      query: opts.query,
      body: opts.json,
      headers: { authorization: `Bearer ${this.token}` },
      // writes are paced inside the bridge (random 8–25 s gaps) and uploads are slow
      timeoutMs: opts.timeoutMs ?? 120_000,
      noThrow: true,
      secrets: [this.token],
    });
    if (!res.ok) {
      const code = res.json?.error ?? (res.status === 401 ? "bridge_auth" : "bridge_error");
      const msg = res.json?.message ?? res.json?.detail ?? `Bridge returned HTTP ${res.status}`;
      throw new HubError(`Instagram bridge: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, code, res.status);
    }
    return res.json as T;
  }
}
