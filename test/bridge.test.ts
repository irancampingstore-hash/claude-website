import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hub } from "../src/core/hub.js";
import type { InstagramService } from "../src/connectors/instagram-service.js";
import { makeHub } from "./helpers.js";

const TOKEN = "bridge-token-bridge-token-1234";
const seen: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
let capReached = false;
let comments: any[] = [];
let unread: any[] = [];

function mockBridge(): Server {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    seen.push({ method: req.method, path: req.path, body: req.body, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.status(401).json({ detail: "invalid bridge token" });
    next();
  });
  app.get("/health", (_q, r) => void r.json({ ok: true }));
  app.get("/accounts/main/me", (_q, r) => void r.json({ pk: "99", username: "irancamping", is_business: true, followers_count: 4321, media_count: 50 }));
  app.get("/accounts/main/media", (_q, r) => void r.json({ items: [{ pk: "1", code: "AbC", caption: "پست", media_type: 1, product_type: "feed", permalink: "https://www.instagram.com/p/AbC/", taken_at: "2026-01-01", like_count: 3, comment_count: 1 }] }));
  app.get("/accounts/main/media/1/comments", (_q, r) => void r.json({ items: comments }));
  app.get("/accounts/main/direct/threads", (_q, r) => void r.json({ items: unread }));
  app.post("/accounts/main/comments/reply", (q, r) => {
    if (capReached) return void r.status(429).json({ error: "cap_reached", message: "Daily cap for 'comment' reached (60/day)." });
    r.json({ pk: "500", text: q.body.text });
  });
  app.post("/accounts/main/publish", (_q, r) => void r.json({ pk: "77", code: "NEW", permalink: "https://www.instagram.com/p/NEW/" }));
  app.get("/pacing", (_q, r) => void r.json({ caps: { publish: 20 } }));
  return createServer(app);
}

let hub: Hub;
let ig: InstagramService;
let srv: Server;
let owner: ReturnType<Hub["users"]["byId"]>;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const def = hub.allTools().find((t) => t.name === name)!;
  const r = await hub.invoke(def, args, { user: owner!, hub });
  return { isError: r.isError, data: (() => { const t = (r.content[0] as { text: string }).text; try { return JSON.parse(t); } catch { return t; } })() };
};

beforeAll(async () => {
  srv = mockBridge();
  const port = await new Promise<number>((res) => srv.listen(0, "127.0.0.1", () => res((srv.address() as AddressInfo).port)));
  const made = makeHub({ IG_BRIDGE_URL: `http://127.0.0.1:${port}`, IG_BRIDGE_TOKEN: TOKEN, IG_POLL_MINUTES: "0" });
  made.cfg.instagram!.allowPrivateUrls = true;
  hub = made.hub;
  ig = hub.services.get("instagram") as InstagramService;
  owner = hub.users.byId(hub.users.create("owner", "owner").user.id);
});
afterAll(() => srv.close());

describe("Instagram without a Meta app (bridge provider)", () => {
  it("instagram connector is enabled by the bridge alone, and ig_connect_start explains the missing app", async () => {
    expect(hub.connector("instagram")).toBeDefined();
    const r = await call("ig_connect_start", { label: "x" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatch(/IG_APP_ID/);
  });

  it("links a bridge account and reads profile/media with the shared tools", async () => {
    const linked = await call("ig_link_bridge_account", { label: "main", bridge_account: "main" });
    expect(linked.data).toMatchObject({ linked: "main", username: "@irancamping" });
    expect((await call("ig_accounts")).data.accounts[0]).toMatchObject({ provider: "bridge (no Meta app)" });
    expect((await call("ig_profile")).data.followers_count).toBe(4321);
    const media = (await call("ig_list_media")).data;
    expect(media[0]).toMatchObject({ id: "1", comments_count: 1, permalink: "https://www.instagram.com/p/AbC/" });
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("replying needs media_id and the two-step confirmation; pacing caps surface as readable errors", async () => {
    const noMedia = await call("ig_reply_comment", { comment_id: "11", message: "ممنون", confirm_token: undefined });
    expect(noMedia.data.status).toBe("confirmation_required");
    const args = { comment_id: "11", message: "ممنون" };
    const t = (await call("ig_reply_comment", args)).data.confirm_token;
    const missing = await call("ig_reply_comment", { ...args, confirm_token: t });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatch(/media_id is required/);

    const full = { ...args, media_id: "1" };
    const t2 = (await call("ig_reply_comment", full)).data.confirm_token;
    const ok = await call("ig_reply_comment", { ...full, confirm_token: t2 });
    expect(ok.isError).toBeFalsy();
    expect(seen.find((s) => s.path.endsWith("/comments/reply"))!.body).toEqual({ media_pk: "1", comment_pk: "11", text: "ممنون" });

    capReached = true;
    const t3 = (await call("ig_reply_comment", { ...full, message: "دوباره" })).data.confirm_token;
    const capped = await call("ig_reply_comment", { ...full, message: "دوباره", confirm_token: t3 });
    expect(capped.isError).toBe(true);
    expect(capped.data).toMatch(/Daily cap/);
    capReached = false;
  });

  it("publishes a photo through the bridge (no JPEG-only restriction) after confirmation", async () => {
    const args = { image_url: "http://127.0.0.1:1/a.png", caption: "تست" };
    const first = await call("ig_publish_photo", args);
    expect(first.data.status).toBe("confirmation_required");
    const done = await call("ig_publish_photo", { ...args, confirm_token: first.data.confirm_token });
    expect(done.data).toEqual({ id: "77", permalink: "https://www.instagram.com/p/NEW/" });
    expect(seen.find((s) => s.path.endsWith("/publish"))!.body).toEqual({ kind: "photo", urls: ["http://127.0.0.1:1/a.png"], caption: "تست" });
  });

  it("official-API-only tools say so clearly for bridge accounts", async () => {
    expect((await call("ig_hide_comment", { comment_id: "1", hide: true })).data).toMatch(/not available through the bridge/);
    expect((await call("ig_subscribe_webhooks", {})).data).toMatch(/poll/);
    expect((await call("ig_refresh_token", {})).data).toMatch(/no token to refresh/);
  });

  it("polling records a baseline first, then only NEW comments and unread DMs reach the inbox", async () => {
    comments = [{ pk: "11", text: "قدیمی", username: "ali" }];
    expect(await ig.pollPrivate()).toBe(0); // baseline
    comments = [...comments, { pk: "12", text: "قیمت چنده؟", username: "sara" }, { pk: "13", text: "ممنون", username: "irancamping" }];
    unread = [{ id: "t9", updated_time: "T1", unread: true, participants: [{ username: "reza" }], last_message: "سلام" }];
    expect(await ig.pollPrivate()).toBe(2);
    expect(await ig.pollPrivate()).toBe(0); // no duplicates
    const inbox = (await call("ig_inbox_list")).data;
    expect(inbox.map((i: { kind: string }) => i.kind).sort()).toEqual(["comments", "message"]);
    expect(inbox.find((i: { kind: string }) => i.kind === "comments").data).toMatchObject({ comment_id: "12", media_id: "1", username: "sara" });
  });

  it("triage workflow works on bridge accounts and passes media_id along", async () => {
    comments = [{ pk: "12", text: "قیمت چنده؟", username: "sara" }, { pk: "13", text: "پاسخ", username: "irancamping", replied_to: "12" }];
    const r = await call("workflow_instagram_triage", {});
    expect(r.data.unanswered).toEqual([]); // already answered by us
    comments = [{ pk: "14", text: "موجود هست؟", username: "reza" }];
    const r2 = await call("workflow_instagram_triage", {});
    expect(r2.data.unanswered[0]).toMatchObject({ id: "14", media_id: "1", username: "reza" });
  });
});
