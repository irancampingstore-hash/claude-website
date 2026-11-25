import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomToken } from "../core/crypto.js";
import type { Db } from "../core/db.js";
import type { UserStore } from "../core/users.js";
import { sha256 } from "../util/text.js";

const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 30 * 24 * 3600; // 30 days
const CODE_TTL_MS = 5 * 60_000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function loginPage(params: Record<string, string>, clientName: string, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ورود به هاب ایران کمپینگ</title>
<style>
:root{--bg:#f4f1ea;--card:#fff;--ink:#1f2a1f;--muted:#5d6b5d;--accent:#2f6b3a;--err:#a32020}
@media (prefers-color-scheme:dark){:root{--bg:#141a14;--card:#1d261d;--ink:#e9efe6;--muted:#9fb09f;--accent:#6fbf7d;--err:#ff8a8a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.7 Tahoma,"Vazirmatn",system-ui,sans-serif;padding:16px}
main{background:var(--card);max-width:420px;width:100%;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:.3em 0 1em}
label{display:block;font-weight:700;margin-bottom:6px}
input[type=password]{width:100%;padding:12px;border:1px solid var(--muted);border-radius:10px;background:transparent;color:var(--ink);font-size:16px;direction:ltr;text-align:left}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.err{color:var(--err);font-weight:700}.small{font-size:13px}
</style></head><body><main>
<h1>🏕️ هاب یکپارچه ایران کمپینگ</h1>
<p><b>${esc(clientName)}</b> می‌خواهد به جای شما از ابزارهای شرکت استفاده کند.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/login">
${hidden}
<label for="k">کلید دسترسی شخصی شما</label>
<input id="k" name="access_key" type="password" autocomplete="current-password" placeholder="icm_..." required autofocus>
<button type="submit">تأیید و اتصال</button>
</form>
<p class="small">کلید را مدیر سیستم به شما می‌دهد. با تأیید، فقط به همان ابزارهایی که نقش شما اجازه می‌دهد دسترسی خواهد داشت و همه‌ی کارها در لاگ ثبت می‌شود.</p>
</main></body></html>`;
}

/**
 * Minimal OAuth 2.1 authorization server (PKCE, dynamic client registration) so Claude.ai, ChatGPT and any
 * spec-compliant MCP client can connect. Employees authenticate on the login page with their personal access key.
 * Static `icm_…` keys are also accepted directly as Bearer tokens (Gemini CLI, Claude Code, scripts).
 */
export class HubOAuthProvider implements OAuthServerProvider {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly db: Db,
    private readonly users: UserStore,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      getClient(clientId: string) {
        const row = db.get<{ info: string }>("SELECT info FROM oauth_clients WHERE client_id = ?", clientId);
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client) {
        const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
        db.run("INSERT INTO oauth_clients(client_id, info, created_at) VALUES(?,?,?)", full.client_id, JSON.stringify(full), Date.now());
        return full;
      },
    };
  }

  /** Step 1: show the login page. The SDK has already validated client_id / redirect_uri / PKCE presence. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(
      loginPage(
        {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          state: params.state ?? "",
          scope: (params.scopes ?? []).join(" "),
          resource: params.resource?.toString() ?? "",
        },
        client.client_name ?? "یک اپلیکیشن هوش مصنوعی",
      ),
    );
  }

  /** Step 2: POST /oauth/login — verify the employee key and redirect back with a one-time code. */
  handleLogin(req: Request, res: Response): void {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    const b = req.body as Record<string, string>;
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 8) {
      res.status(429).type("html").send(loginPage(b, "—", "تعداد تلاش‌های ناموفق زیاد است. چند دقیقه بعد دوباره امتحان کنید."));
      return;
    }
    const clientRow = this.db.get<{ info: string }>("SELECT info FROM oauth_clients WHERE client_id = ?", b.client_id ?? "");
    const client = clientRow ? (JSON.parse(clientRow.info) as OAuthClientInformationFull) : undefined;
    if (!client || !b.redirect_uri || !client.redirect_uris.map(String).includes(b.redirect_uri) || !b.code_challenge) {
      res.status(400).send("Invalid authorization request.");
      return;
    }
    const user = this.users.authenticateApiKey((b.access_key ?? "").trim());
    if (!user) {
      this.failures.set(ip, [...recent, now]);
      const { access_key: _k, ...keep } = b;
      res.status(401).type("html").send(loginPage(keep, client.client_name ?? "", "کلید دسترسی نامعتبر است."));
      return;
    }
    const code = randomToken("icmc", 24);
    this.db.run(
      "INSERT INTO oauth_codes(code, client_id, user_id, challenge, redirect_uri, scopes, resource, expires_at) VALUES(?,?,?,?,?,?,?,?)",
      sha256(code),
      client.client_id,
      user.id,
      b.code_challenge,
      b.redirect_uri,
      b.scope ?? "",
      b.resource || null,
      now + CODE_TTL_MS,
    );
    const target = new URL(b.redirect_uri);
    target.searchParams.set("code", code);
    if (b.state) target.searchParams.set("state", b.state);
    res.redirect(302, target.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.db.get<{ challenge: string; client_id: string; expires_at: number }>("SELECT challenge, client_id, expires_at FROM oauth_codes WHERE code = ?", sha256(authorizationCode));
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const h = sha256(authorizationCode);
    const row = this.db.get<{ user_id: string; client_id: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }>(
      "SELECT user_id, client_id, redirect_uri, scopes, resource, expires_at FROM oauth_codes WHERE code = ?",
      h,
    );
    this.db.run("DELETE FROM oauth_codes WHERE code = ?", h); // single use
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, row.user_id, row.scopes, row.resource ?? undefined);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const h = sha256(refreshToken);
    const row = this.db.get<{ user_id: string; client_id: string; scopes: string; resource: string | null; expires_at: number }>(
      "SELECT user_id, client_id, scopes, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'",
      h,
    );
    if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) throw new InvalidGrantError("Invalid refresh token");
    if (!this.users.byId(row.user_id)) throw new InvalidGrantError("User is disabled");
    this.db.run("DELETE FROM oauth_tokens WHERE token_hash = ?", h); // rotate
    return this.issue(client.client_id, row.user_id, row.scopes, row.resource ?? undefined);
  }

  private issue(clientId: string, userId: string, scopes: string, resource?: string): OAuthTokens {
    const access = randomToken("icmat");
    const refresh = randomToken("icmrt");
    const now = Date.now();
    this.db.run("DELETE FROM oauth_tokens WHERE expires_at < ?", now);
    this.db.run("INSERT INTO oauth_tokens(token_hash, kind, client_id, user_id, scopes, resource, expires_at) VALUES(?,?,?,?,?,?,?)", sha256(access), "access", clientId, userId, scopes, resource ?? null, now + ACCESS_TTL_S * 1000);
    this.db.run("INSERT INTO oauth_tokens(token_hash, kind, client_id, user_id, scopes, resource, expires_at) VALUES(?,?,?,?,?,?,?)", sha256(refresh), "refresh", clientId, userId, scopes, resource ?? null, now + REFRESH_TTL_S * 1000);
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes || "mcp" };
  }

  /** Accepts OAuth access tokens AND static employee API keys. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith("icm_")) {
      const user = this.users.authenticateApiKey(token);
      if (!user) throw new InvalidTokenError("Invalid API key");
      return { token, clientId: "api-key", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { userId: user.id } };
    }
    const row = this.db.get<{ user_id: string; client_id: string; scopes: string; expires_at: number }>(
      "SELECT user_id, client_id, scopes, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'",
      sha256(token),
    );
    if (!row || row.expires_at < Date.now()) throw new InvalidTokenError("Invalid or expired token");
    if (!this.users.byId(row.user_id)) throw new InvalidTokenError("User is disabled");
    return { token, clientId: row.client_id, scopes: row.scopes ? row.scopes.split(" ") : ["mcp"], expiresAt: Math.floor(row.expires_at / 1000), extra: { userId: row.user_id } };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.run("DELETE FROM oauth_tokens WHERE token_hash = ?", sha256(request.token));
  }
}
