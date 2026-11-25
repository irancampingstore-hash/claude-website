import { hmac, safeEqual } from "./crypto.js";
import type { Db } from "./db.js";
import { redactDeep, sha256, stableStringify } from "../util/text.js";

/* ───────────── Confirmation tokens (stateless, HMAC-signed) ───────────── */

export interface ConfirmClaims {
  u: string; // user id
  t: string; // tool name
  h: string; // hash of arguments
  e: number; // expiry (ms epoch)
}

export class Confirmer {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  static argsHash(args: Record<string, unknown>): string {
    const { confirm_token: _omit, ...rest } = args;
    return sha256(stableStringify(rest));
  }

  issue(userId: string, tool: string, args: Record<string, unknown>, now = Date.now()): string {
    const claims: ConfirmClaims = { u: userId, t: tool, h: Confirmer.argsHash(args), e: now + this.ttlMs };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${hmac(this.secret, "confirm", body)}`;
  }

  verify(token: string, userId: string, tool: string, args: Record<string, unknown>, now = Date.now()): boolean {
    const [body, sig] = token.split(".");
    if (!body || !sig || !safeEqual(sig, hmac(this.secret, "confirm", body))) return false;
    let claims: ConfirmClaims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmClaims;
    } catch {
      return false;
    }
    return claims.u === userId && claims.t === tool && claims.e > now && claims.h === Confirmer.argsHash(args);
  }

  get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }
}

/* ───────────── Rate limiting (sliding window, in memory) ───────────── */

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns true if the call is allowed. */
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

/* ───────────── Audit log ───────────── */

export interface AuditEntry {
  id: number;
  ts: number;
  user_id: string | null;
  client: string | null;
  tool: string;
  connector: string | null;
  outcome: string;
  duration_ms: number | null;
  args: string | null;
  error: string | null;
}

export class Audit {
  constructor(private readonly db: Db) {}

  record(e: {
    userId: string;
    client?: string;
    tool: string;
    connector: string;
    outcome: "ok" | "error" | "denied" | "confirm_required" | "rate_limited";
    durationMs?: number;
    args?: unknown;
    error?: string;
  }): void {
    try {
      this.db.run(
        "INSERT INTO audit(ts, user_id, client, tool, connector, outcome, duration_ms, args, error) VALUES(?,?,?,?,?,?,?,?,?)",
        Date.now(),
        e.userId,
        e.client ?? null,
        e.tool,
        e.connector,
        e.outcome,
        e.durationMs ?? null,
        e.args === undefined ? null : JSON.stringify(redactDeep(e.args)).slice(0, 4000),
        e.error ? e.error.slice(0, 1000) : null,
      );
    } catch {
      /* auditing must never break a tool call */
    }
  }

  recent(limit = 50, filter: { user?: string; tool?: string; outcome?: string } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.user) {
      where.push("user_id = ?");
      params.push(filter.user);
    }
    if (filter.tool) {
      where.push("tool = ?");
      params.push(filter.tool);
    }
    if (filter.outcome) {
      where.push("outcome = ?");
      params.push(filter.outcome);
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`;
    return this.db.all<AuditEntry>(sql, ...params);
  }
}
