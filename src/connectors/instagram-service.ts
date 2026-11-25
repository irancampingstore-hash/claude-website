import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import type { Hub } from "../core/hub.js";
import { hmac, safeEqual } from "../core/crypto.js";
import { http } from "../util/http.js";
import { HubError } from "../util/text.js";
import { assertPublicUrl, fetchPublic } from "../util/ssrf.js";
import type { InstagramConfig } from "../core/config.js";
import { BridgeClient } from "./ig-bridge-client.js";

/**
 * Instagram API with Instagram Login ("Business Login for Instagram").
 * Users sign in with their INSTAGRAM account directly — no Facebook login and no Facebook Page is involved.
 * Requires an Instagram professional (Business or Creator) account.
 */

export interface IgAccount {
  label: string;
  userId: string;
  username: string;
  accessToken: string;
  /** epoch ms when the long-lived token expires (≈60 days, refreshed automatically) */
  expiresAt: number;
  accountType?: string;
  refreshedAt: number;
  /** "graph" = official API (Meta app + OAuth); "private" = instagrapi bridge session. Default graph. */
  provider?: "graph" | "private";
  /** Account name inside the bridge (provider = private). */
  bridgeAccount?: string;
}

export const isPrivate = (a: IgAccount) => a.provider === "private";

export type PublishPayload =
  | { kind: "image"; image_url: string; caption?: string; alt_text?: string }
  | { kind: "reel"; video_url: string; caption?: string; share_to_feed?: boolean; cover_url?: string }
  | { kind: "story"; image_url?: string; video_url?: string }
  | { kind: "carousel"; media_urls: string[]; caption?: string };

const IG_AUTH = "https://www.instagram.com/oauth/authorize";
const isVideoUrl = (u: string) => /\.(mp4|mov)(\?|$)/i.test(u);

export class InstagramService {
  private timers: NodeJS.Timeout[] = [];

  readonly bridge?: BridgeClient;

  constructor(
    private readonly hub: Hub,
    readonly cfg: InstagramConfig,
  ) {
    if (cfg.bridgeUrl && cfg.bridgeToken) this.bridge = new BridgeClient(cfg.bridgeUrl, cfg.bridgeToken);
  }

  private needBridge(acc: IgAccount): { b: BridgeClient; name: string } {
    if (!this.bridge || !acc.bridgeAccount) throw new HubError("The Instagram bridge is not configured (IG_BRIDGE_URL / IG_BRIDGE_TOKEN).", "not_configured");
    return { b: this.bridge, name: acc.bridgeAccount };
  }

  private get GRAPH(): string {
    return this.cfg.graphBase;
  }

  private pub(url: string) {
    return assertPublicUrl(url, { allowPrivate: this.cfg.allowPrivateUrls });
  }

  get redirectUri(): string {
    return `${this.hub.config.publicUrl}/instagram/callback`;
  }

  /* ───────── accounts ───────── */

  private key(label: string) {
    return `ig:${label}`;
  }

  listAccounts(): IgAccount[] {
    return this.hub.db
      .listSecretKeys("ig:")
      .map((k) => this.hub.db.getSecret(k))
      .filter((v): v is string => !!v)
      .map((v) => JSON.parse(v) as IgAccount);
  }

  getAccount(label?: string): IgAccount {
    const all = this.listAccounts();
    if (!all.length) {
      throw new HubError("No Instagram account is connected yet. Use ig_connect_start (admin) and open the link while logged in to Instagram.", "not_connected");
    }
    const acc = label ? all.find((a) => a.label === label || a.username === label) : all.length === 1 ? all[0] : undefined;
    if (!acc) throw new HubError(`Specify account: ${all.map((a) => a.label).join(", ")}`, "ambiguous");
    return acc;
  }

  private save(acc: IgAccount): void {
    this.hub.db.setSecret(this.key(acc.label), JSON.stringify(acc));
  }

  removeAccount(label: string): void {
    this.hub.db.deleteSecret(this.key(label));
  }

  /* ───────── OAuth (Instagram Login, no Facebook) ───────── */

  authUrl(label: string, userId: string): string {
    if (!this.cfg.appId) throw new HubError("IG_APP_ID is not configured.", "not_configured");
    const claims = Buffer.from(JSON.stringify({ l: label, u: userId, e: Date.now() + 15 * 60_000, n: randomUUID().slice(0, 8) })).toString("base64url");
    const state = `${claims}.${hmac(this.hub.config.secret, "ig-state", claims)}`;
    const u = new URL(IG_AUTH);
    u.searchParams.set("client_id", this.cfg.appId);
    u.searchParams.set("redirect_uri", this.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", this.cfg.scopes.join(","));
    u.searchParams.set("state", state);
    u.searchParams.set("force_reauth", "true");
    return u.toString();
  }

  private parseState(state: string): { label: string; userId: string } {
    const [body, sig] = state.split(".");
    if (!body || !sig || !safeEqual(sig, hmac(this.hub.config.secret, "ig-state", body))) throw new HubError("Invalid state.", "bad_state");
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { l: string; u: string; e: number };
    if (c.e < Date.now()) throw new HubError("The connect link expired. Start again.", "expired");
    return { label: c.l, userId: c.u };
  }

  /** Complete the OAuth redirect: code → short-lived → long-lived token → stored encrypted. */
  async handleCallback(code: string, state: string): Promise<IgAccount> {
    const { label } = this.parseState(state);
    const { appId, appSecret } = this.cfg;
    if (!appId || !appSecret) throw new HubError("IG_APP_ID / IG_APP_SECRET missing.", "not_configured");
    const form = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
      code: code.replace(/#_$/, ""),
    });
    const short = await http<any>(this.cfg.tokenUrl, { method: "POST", body: form, proxy: this.cfg.proxy, secrets: [appSecret] });
    const first = short.json?.data?.[0] ?? short.json;
    if (!first?.access_token) throw new HubError("Instagram did not return an access token.", "oauth_failed");
    const long = await http<any>(`${this.GRAPH}/access_token`, {
      query: { grant_type: "ig_exchange_token", client_secret: appSecret, access_token: first.access_token },
      proxy: this.cfg.proxy,
      secrets: [appSecret, first.access_token],
    });
    const token: string = long.json?.access_token;
    if (!token) throw new HubError("Could not obtain a long-lived token.", "oauth_failed");
    const me = await http<any>(`${this.GRAPH}/${this.cfg.apiVersion}/me`, {
      query: { fields: "user_id,username,account_type", access_token: token },
      proxy: this.cfg.proxy,
      secrets: [token],
    });
    const acc: IgAccount = {
      label,
      userId: String(me.json?.user_id ?? first.user_id),
      username: me.json?.username ?? label,
      accessToken: token,
      expiresAt: Date.now() + (long.json?.expires_in ?? 5_184_000) * 1000,
      accountType: me.json?.account_type,
      refreshedAt: Date.now(),
    };
    this.save(acc);
    return acc;
  }

  async refresh(acc: IgAccount): Promise<IgAccount> {
    const r = await http<any>(`${this.GRAPH}/refresh_access_token`, {
      query: { grant_type: "ig_refresh_token", access_token: acc.accessToken },
      proxy: this.cfg.proxy,
      secrets: [acc.accessToken],
    });
    const next = { ...acc, accessToken: r.json?.access_token ?? acc.accessToken, expiresAt: Date.now() + (r.json?.expires_in ?? 5_184_000) * 1000, refreshedAt: Date.now() };
    this.save(next);
    return next;
  }

  /* ───────── Graph calls ───────── */

  async api<T = any>(
    acc: IgAccount,
    path: string,
    opts: { method?: "GET" | "POST" | "DELETE"; query?: Record<string, string | number | boolean | undefined>; json?: unknown } = {},
  ): Promise<T> {
    const url = `${this.GRAPH}/${this.cfg.apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await http<any>(url, {
      method: opts.method ?? "GET",
      query: { ...opts.query, access_token: acc.accessToken },
      body: opts.json,
      proxy: this.cfg.proxy,
      timeoutMs: 45_000,
      noThrow: true,
      secrets: [acc.accessToken, this.cfg.appSecret],
    });
    if (!res.ok) throw this.explain(res.status, res.json?.error, acc);
    return res.json as T;
  }

  private explain(status: number, err: any, acc: IgAccount): HubError {
    const code = err?.code as number | undefined;
    const msg = err?.message ?? "Unknown Instagram error";
    let hint = "";
    if (code === 190) hint = ` Token invalid/expired — reconnect "${acc.label}" with ig_connect_start.`;
    else if (code === 10 || code === 200) hint = " Missing permission — reconnect the account and approve all requested permissions.";
    else if (code === 4 || code === 17 || code === 32 || code === 613) hint = " Rate limit reached — wait and retry later.";
    else if (code === 9007) hint = " Media is still processing — wait a few seconds and publish again.";
    else if (code === 36003 || code === 36000) hint = " Image must be a public JPEG within Instagram's aspect-ratio limits (4:5 to 1.91:1).";
    return new HubError(`Instagram API error ${code ?? status}: ${msg}.${hint}`, "instagram_error", status);
  }

  /* ───────── unified operations (official API or bridge; same shapes for the tools) ───────── */

  async profile(acc: IgAccount): Promise<any> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      return b.call("GET", `/accounts/${name}/me`);
    }
    return this.api(acc, "/me", { query: { fields: "user_id,username,name,account_type,biography,followers_count,follows_count,media_count,website" } });
  }

  async listMedia(acc: IgAccount, limit: number): Promise<any[]> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      const r = await b.call<{ items: any[] }>("GET", `/accounts/${name}/media`, { query: { limit } });
      return r.items.map((m) => ({ id: m.pk, caption: m.caption, media_type: m.media_type, media_product_type: m.product_type, permalink: m.permalink, timestamp: m.taken_at, like_count: m.like_count, comments_count: m.comment_count, thumbnail_url: m.thumbnail_url }));
    }
    const r = await this.api<{ data: any[] }>(acc, "/me/media", { query: { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url", limit } });
    return r.data;
  }

  async mediaInsights(acc: IgAccount, mediaId: string, metrics?: string): Promise<any> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      return (await b.call<{ insights: unknown }>("GET", `/accounts/${name}/media/${mediaId}/insights`)).insights;
    }
    const r = await this.api<{ data: any[] }>(acc, `/${mediaId}/insights`, { query: { metric: metrics ?? "reach,likes,comments,saved,shares,total_interactions" } });
    return Object.fromEntries((r.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
  }

  async accountInsights(acc: IgAccount, days: number, metrics?: string): Promise<any> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      return (await b.call<{ insights: unknown }>("GET", `/accounts/${name}/insights`)).insights;
    }
    const until = Math.floor(Date.now() / 1000);
    const r = await this.api<{ data: any[] }>(acc, `/${acc.userId}/insights`, {
      query: { metric: metrics ?? "reach,views,profile_views,accounts_engaged,total_interactions", period: "day", metric_type: "total_value", since: until - days * 86_400, until },
    });
    return Object.fromEntries((r.data ?? []).map((m) => [m.name, m.total_value?.value]));
  }

  async listComments(acc: IgAccount, mediaId: string, limit: number): Promise<any[]> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      const r = await b.call<{ items: any[] }>("GET", `/accounts/${name}/media/${mediaId}/comments`, { query: { limit } });
      return r.items.map((c) => ({ id: c.pk, text: c.text, username: c.username, timestamp: c.created_at, like_count: c.like_count, replied_to: c.replied_to ?? undefined }));
    }
    const r = await this.api<{ data: any[] }>(acc, `/${mediaId}/comments`, { query: { fields: "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}", limit } });
    return r.data;
  }

  async replyComment(acc: IgAccount, commentId: string, text: string, mediaId?: string): Promise<any> {
    if (isPrivate(acc)) {
      if (!mediaId) throw new HubError("media_id is required to reply with a bridge account (the post the comment is on).", "bad_request");
      const { b, name } = this.needBridge(acc);
      return b.call("POST", `/accounts/${name}/comments/reply`, { json: { media_pk: mediaId, comment_pk: commentId, text } });
    }
    return this.api(acc, `/${commentId}/replies`, { method: "POST", query: { message: text } });
  }

  async hideComment(acc: IgAccount, commentId: string, hide: boolean): Promise<any> {
    if (isPrivate(acc)) throw new HubError("Hiding comments is not available through the bridge; use ig_delete_comment.", "unsupported");
    return this.api(acc, `/${commentId}`, { method: "POST", query: { hide } });
  }

  async deleteComment(acc: IgAccount, commentId: string, mediaId?: string): Promise<any> {
    if (isPrivate(acc)) {
      if (!mediaId) throw new HubError("media_id is required to delete a comment with a bridge account.", "bad_request");
      const { b, name } = this.needBridge(acc);
      return b.call("POST", `/accounts/${name}/comments/delete`, { json: { media_pk: mediaId, comment_pks: [commentId] } });
    }
    return this.api(acc, `/${commentId}`, { method: "DELETE" });
  }

  async listConversations(acc: IgAccount, limit: number, unreadOnly = false): Promise<any[]> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      const r = await b.call<{ items: any[] }>("GET", `/accounts/${name}/direct/threads`, { query: { limit, unread_only: unreadOnly } });
      return r.items.map((t) => ({ id: t.id, updated_time: t.last_activity_at, unread: t.unread, participants: t.users, last_message: t.messages?.[0]?.text }));
    }
    const r = await this.api<{ data: any[] }>(acc, "/me/conversations", { query: { platform: "instagram", fields: "id,updated_time,participants", limit } });
    return r.data;
  }

  async getConversation(acc: IgAccount, id: string, limit: number): Promise<any> {
    if (isPrivate(acc)) {
      const { b, name } = this.needBridge(acc);
      const r = await b.call<{ items: any[] }>("GET", `/accounts/${name}/direct/threads/${id}/messages`, { query: { limit } });
      return r.items.map((m) => ({ id: m.id, created_time: m.timestamp, from: m.from_me ? "me" : m.user_id, message: m.text }));
    }
    const r = await this.api<any>(acc, `/${id}`, { query: { fields: `messages.limit(${limit}){id,created_time,from,to,message}` } });
    return r.messages?.data ?? r;
  }

  async sendDm(acc: IgAccount, target: { recipientId?: string; threadId?: string }, text: string): Promise<any> {
    if (isPrivate(acc)) {
      if (!target.recipientId && !target.threadId) throw new HubError("Provide thread_id or recipient_id.", "bad_request");
      const { b, name } = this.needBridge(acc);
      return b.call("POST", `/accounts/${name}/direct/send`, { json: target.threadId ? { thread_id: target.threadId, text } : { user_id: target.recipientId, text } });
    }
    if (!target.recipientId) throw new HubError("recipient_id is required for official-API accounts.", "bad_request");
    return this.api(acc, `/${acc.userId}/messages`, { method: "POST", json: { recipient: { id: target.recipientId }, message: { text } } });
  }

  /* ───────── bridge accounts ───────── */

  /** Register a session that already exists inside the bridge (imported with the CLI / login_local.py). */
  async linkBridgeAccount(label: string, bridgeAccount: string): Promise<IgAccount> {
    if (!this.bridge) throw new HubError("Set IG_BRIDGE_URL and IG_BRIDGE_TOKEN first.", "not_configured");
    const me = await this.bridge.call<any>("GET", `/accounts/${bridgeAccount}/me`);
    const acc: IgAccount = {
      label,
      provider: "private",
      bridgeAccount,
      userId: String(me.pk),
      username: me.username,
      accessToken: "",
      expiresAt: Date.now() + 3650 * 86_400_000,
      accountType: me.is_business ? "BUSINESS" : "PERSONAL",
      refreshedAt: Date.now(),
    };
    this.save(acc);
    return acc;
  }

  private async publishPrivate(acc: IgAccount, p: PublishPayload): Promise<{ id: string; permalink?: string }> {
    const { b, name } = this.needBridge(acc);
    if ("caption" in p && p.caption && p.caption.length > 2200) throw new HubError("Caption exceeds 2200 characters.", "bad_caption");
    let body: { kind: string; urls: string[]; caption?: string };
    if (p.kind === "image") body = { kind: "photo", urls: [p.image_url], caption: p.caption };
    else if (p.kind === "reel") body = { kind: "reel", urls: [p.video_url], caption: p.caption };
    else if (p.kind === "story") {
      const u = p.image_url ?? p.video_url;
      if (!u) throw new HubError("Provide image_url or video_url for a story.", "bad_request");
      body = { kind: "story", urls: [u] };
    } else body = { kind: "carousel", urls: p.media_urls, caption: p.caption };
    for (const u of body.urls) await this.pub(u);
    const r = await b.call<{ pk: string; permalink?: string }>("POST", `/accounts/${name}/publish`, { json: body, timeoutMs: 600_000 });
    return { id: r.pk, permalink: r.permalink ?? undefined };
  }

  /** Poll bridge accounts for new comments / unread DMs and put them into the shared inbox (no webhooks exist for this route). */
  async pollPrivate(): Promise<number> {
    let added = 0;
    for (const acc of this.listAccounts().filter(isPrivate)) {
      const key = `igseen:${acc.label}`;
      const raw = this.hub.db.getSecret(key);
      const first = raw === undefined;
      const seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
      const add = (kind: string, id: string, payload: unknown) => {
        if (seen.has(id)) return;
        seen.add(id);
        if (first) return; // first run only records a baseline, it does not flood the inbox with old items
        this.hub.db.run("INSERT INTO inbox(source, kind, payload, ts) VALUES('instagram', ?, ?, ?)", kind, JSON.stringify({ account: acc.label, ...(payload as object) }), Date.now());
        added++;
      };
      try {
        for (const m of (await this.listMedia(acc, 3)).slice(0, 3)) {
          for (const c of await this.listComments(acc, m.id, 15)) {
            if (c.username !== acc.username) add("comments", `c:${c.id}`, { media_id: m.id, comment_id: c.id, username: c.username, text: c.text, post: m.permalink });
          }
        }
        for (const t of await this.listConversations(acc, 10, true)) {
          if (t.unread) add("message", `t:${t.id}:${t.updated_time}`, { thread_id: t.id, from: t.participants?.map((u: any) => u.username).join(","), last_message: t.last_message });
        }
        this.hub.db.setSecret(key, JSON.stringify([...seen].slice(-1000)));
      } catch (e) {
        this.hub.audit.record({ userId: "poller", tool: "ig_poll_private", connector: "instagram", outcome: "error", args: { account: acc.label }, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return added;
  }

  /* ───────── publishing ───────── */

  async assertImageOk(url: string): Promise<void> {
    await this.pub(url);
    const head = await fetchPublic(url, { method: "HEAD", timeoutMs: 15_000, allowPrivate: this.cfg.allowPrivateUrls }).catch(() => undefined);
    const type = head?.headers.get("content-type") ?? "";
    if (head && head.ok && type && !/image\/jpe?g/i.test(type)) {
      throw new HubError(`Instagram feed images must be JPEG; this URL is ${type}. Export/upload a .jpg version first.`, "bad_image_type");
    }
  }

  private async waitUntilReady(acc: IgAccount, containerId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const s = await this.api<{ status_code?: string; status?: string }>(acc, `/${containerId}`, { query: { fields: "status_code,status" } });
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new HubError(`Instagram could not process the media: ${s.status ?? s.status_code}`, "media_error");
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new HubError("Instagram is still processing the media (timeout). Try again shortly.", "media_timeout");
  }

  async publish(acc: IgAccount, p: PublishPayload): Promise<{ id: string; permalink?: string }> {
    if (isPrivate(acc)) return this.publishPrivate(acc, p);
    return this.publishGraph(acc, p);
  }

  private async publishGraph(acc: IgAccount, p: PublishPayload): Promise<{ id: string; permalink?: string }> {
    if ("caption" in p && p.caption && p.caption.length > 2200) throw new HubError("Caption exceeds 2200 characters.", "bad_caption");
    if ("caption" in p && p.caption && (p.caption.match(/#/g) ?? []).length > 30) throw new HubError("Instagram allows at most 30 hashtags.", "bad_caption");
    let creation: string;

    if (p.kind === "image") {
      await this.assertImageOk(p.image_url);
      creation = (await this.api<{ id: string }>(acc, `/${acc.userId}/media`, { method: "POST", query: { image_url: p.image_url, caption: p.caption, alt_text: p.alt_text } })).id;
    } else if (p.kind === "reel") {
      await this.pub(p.video_url);
      creation = (
        await this.api<{ id: string }>(acc, `/${acc.userId}/media`, {
          method: "POST",
          query: { media_type: "REELS", video_url: p.video_url, caption: p.caption, share_to_feed: p.share_to_feed ?? true, cover_url: p.cover_url },
        })
      ).id;
    } else if (p.kind === "story") {
      const url = p.image_url ?? p.video_url;
      if (!url) throw new HubError("Provide image_url or video_url for a story.", "bad_request");
      await this.pub(url);
      creation = (await this.api<{ id: string }>(acc, `/${acc.userId}/media`, { method: "POST", query: { media_type: "STORIES", ...(p.image_url ? { image_url: p.image_url } : { video_url: p.video_url }) } })).id;
    } else {
      if (p.media_urls.length < 2 || p.media_urls.length > 10) throw new HubError("A carousel needs 2–10 media URLs.", "bad_request");
      const children: string[] = [];
      for (const u of p.media_urls) {
        if (isVideoUrl(u)) await this.pub(u);
        else await this.assertImageOk(u);
        const c = await this.api<{ id: string }>(acc, `/${acc.userId}/media`, {
          method: "POST",
          query: isVideoUrl(u) ? { media_type: "VIDEO", video_url: u, is_carousel_item: true } : { image_url: u, is_carousel_item: true },
        });
        await this.waitUntilReady(acc, c.id);
        children.push(c.id);
      }
      creation = (await this.api<{ id: string }>(acc, `/${acc.userId}/media`, { method: "POST", query: { media_type: "CAROUSEL", children: children.join(","), caption: p.caption } })).id;
    }

    await this.waitUntilReady(acc, creation);
    const pub = await this.api<{ id: string }>(acc, `/${acc.userId}/media_publish`, { method: "POST", query: { creation_id: creation } });
    const info = await this.api<{ permalink?: string }>(acc, `/${pub.id}`, { query: { fields: "permalink" } }).catch(() => ({ permalink: undefined }));
    return { id: pub.id, permalink: info.permalink };
  }

  /* ───────── scheduler + refresh ───────── */

  schedule(accountLabel: string, payload: PublishPayload, runAt: number, createdBy: string): string {
    const id = randomUUID();
    this.hub.db.run(
      "INSERT INTO ig_scheduled(id, account, kind, payload, run_at, status, created_by, created_at) VALUES(?,?,?,?,?,'pending',?,?)",
      id,
      accountLabel,
      payload.kind,
      JSON.stringify(payload),
      runAt,
      createdBy,
      Date.now(),
    );
    return id;
  }

  async tick(now = Date.now()): Promise<void> {
    const due = this.hub.db.all<{ id: string; account: string; payload: string }>(
      "SELECT id, account, payload FROM ig_scheduled WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 5",
      now,
    );
    for (const job of due) {
      // claim first so overlapping ticks can't double-publish
      this.hub.db.run("UPDATE ig_scheduled SET status = 'running' WHERE id = ? AND status = 'pending'", job.id);
      try {
        const acc = this.getAccount(job.account);
        const out = await this.publish(acc, JSON.parse(job.payload) as PublishPayload);
        this.hub.db.run("UPDATE ig_scheduled SET status = 'done', result = ? WHERE id = ?", JSON.stringify(out), job.id);
        this.hub.audit.record({ userId: "scheduler", tool: "ig_scheduled_publish", connector: "instagram", outcome: "ok", args: { scheduled_id: job.id, ...out } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.hub.db.run("UPDATE ig_scheduled SET status = 'failed', result = ? WHERE id = ?", msg.slice(0, 500), job.id);
        this.hub.audit.record({ userId: "scheduler", tool: "ig_scheduled_publish", connector: "instagram", outcome: "error", args: { id: job.id }, error: msg });
      }
    }
  }

  async refreshDue(): Promise<void> {
    for (const acc of this.listAccounts()) {
      const stale = !isPrivate(acc) && Date.now() - acc.refreshedAt > 7 * 86_400_000;
      if (stale && acc.expiresAt > Date.now()) await this.refresh(acc).catch(() => undefined);
    }
  }

  start(): void {
    // anything left "running" after a crash is marked failed rather than re-published (avoids double posts)
    this.hub.db.run("UPDATE ig_scheduled SET status = 'failed', result = 'interrupted by restart — check Instagram before retrying' WHERE status = 'running'");
    this.timers.push(setInterval(() => void this.tick(), 30_000));
    this.timers.push(setInterval(() => void this.refreshDue(), 6 * 3_600_000));
    if (this.bridge && this.cfg.pollMinutes > 0) {
      this.timers.push(setInterval(() => void this.pollPrivate(), this.cfg.pollMinutes * 60_000 + Math.floor(Math.random() * 60_000)));
    }
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /* ───────── webhooks ───────── */

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    if (!this.cfg.appSecret || !header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.cfg.appSecret).update(rawBody).digest("hex");
    return safeEqual(header.slice(7), expected);
  }

  /** Store webhook events in the shared inbox so any employee/agent can triage them. */
  ingest(payload: any): number {
    let n = 0;
    for (const entry of payload?.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        this.hub.db.run("INSERT INTO inbox(source, kind, payload, ts) VALUES('instagram', ?, ?, ?)", String(ch.field ?? "change"), JSON.stringify({ account_id: entry.id, ...ch.value }), Date.now());
        n++;
      }
      for (const m of entry.messaging ?? []) {
        this.hub.db.run("INSERT INTO inbox(source, kind, payload, ts) VALUES('instagram', 'message', ?, ?)", JSON.stringify({ account_id: entry.id, ...m }), Date.now());
        n++;
      }
    }
    return n;
  }
}
