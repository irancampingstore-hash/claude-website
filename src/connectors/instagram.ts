import { z } from "zod";
import type { Hub } from "../core/hub.js";
import type { Connector, ToolDef } from "../core/types.js";
import { HubError } from "../util/text.js";
import { clampInt, tool } from "./helpers.js";
import { InstagramService, type PublishPayload } from "./instagram-service.js";

const account = z.string().optional().describe("Instagram account label (omit if only one is connected; see ig_accounts)");

/** ISO date-time; if no timezone is given, assume Iran Standard Time (UTC+03:30, no DST since 2022). */
export function parseScheduleTime(input: string): number {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(input.trim());
  const t = Date.parse(hasZone ? input : `${input.trim()}+03:30`);
  if (Number.isNaN(t)) throw new HubError(`Invalid date-time: ${input}`, "bad_request");
  return t;
}

const fmtTehran = (ms: number) =>
  new Date(ms).toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "medium", timeStyle: "short" }) + " (Tehran)";

const publishFields = {
  caption: z.string().max(2200).optional().describe("Caption (max 2200 chars, ≤30 hashtags)"),
  account,
};

export function createInstagramConnector(hub: Hub): Connector | undefined {
  const cfg = hub.config.instagram;
  if (!cfg) return undefined;
  const ig = new InstagramService(hub, cfg);
  hub.services.set("instagram", ig);

  const previewOf = (a: any, extra: Record<string, unknown>) => {
    const acc = ig.getAccount(a.account);
    return { account: `@${acc.username}`, ...extra, caption: a.caption, warning: "This will be visible publicly on Instagram." };
  };

  const tools: ToolDef[] = [
    /* ── connection ── */
    tool({
      name: "ig_accounts",
      title: "Connected Instagram accounts",
      description: "List connected Instagram accounts and token expiry.",
      connector: "instagram",
      level: "read",
      input: {},
      handler: () => ({
        redirect_uri_to_register_in_meta_app: ig.redirectUri,
        accounts: ig.listAccounts().map((a) => ({ label: a.label, username: a.username, type: a.accountType, token_days_left: Math.round((a.expiresAt - Date.now()) / 86_400_000) })),
      }),
    }),

    tool({
      name: "ig_connect_start",
      title: "Connect an Instagram account (admin)",
      description:
        "Returns a one-time link. Open it in a browser where the Instagram account is logged in, approve access, and the hub stores the token. " +
        "Uses Instagram Login — no Facebook account or Facebook Page is needed. The account must be Business or Creator.",
      connector: "instagram",
      level: "admin",
      input: { label: z.string().min(2).max(30).describe("Short name for this account, e.g. irancamping") },
      handler: (a, ctx) => ({
        open_this_link: ig.authUrl(a.label, ctx.user.id),
        valid_minutes: 15,
        redirect_uri_must_be_registered: ig.redirectUri,
      }),
    }),

    tool({
      name: "ig_disconnect",
      title: "Disconnect an Instagram account (admin)",
      description: "Delete the stored token for an account (it can be reconnected later).",
      connector: "instagram",
      level: "admin",
      input: { account: z.string().describe("Account label") },
      confirm: true,
      destructive: true,
      handler: (a) => {
        ig.removeAccount(a.account);
        return { disconnected: a.account };
      },
    }),

    tool({
      name: "ig_refresh_token",
      title: "Refresh Instagram token (admin)",
      description: "Extend the 60-day token now (the hub also does this automatically).",
      connector: "instagram",
      level: "admin",
      input: { account },
      handler: async (a) => {
        const acc = await ig.refresh(ig.getAccount(a.account));
        return { account: acc.label, days_left: Math.round((acc.expiresAt - Date.now()) / 86_400_000) };
      },
    }),

    tool({
      name: "ig_subscribe_webhooks",
      title: "Subscribe account to webhooks (admin)",
      description: "Make Instagram push comments/messages/mentions to the hub inbox (webhook URL must be set in the Meta app).",
      connector: "instagram",
      level: "admin",
      input: { account, fields: z.string().optional().describe("Comma-separated, default comments,messages,mentions") },
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api(acc, `/${acc.userId}/subscribed_apps`, { method: "POST", query: { subscribed_fields: a.fields ?? "comments,messages,mentions" } });
        return { ...r, webhook_url: `${hub.config.publicUrl}/instagram/webhook`, verify_token_configured: !!cfg.webhookVerifyToken };
      },
    }),

    /* ── read ── */
    tool({
      name: "ig_profile",
      title: "Instagram profile stats",
      description: "Profile info: followers, following, media count, bio.",
      connector: "instagram",
      level: "read",
      input: { account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        return ig.api(acc, "/me", { query: { fields: "user_id,username,name,account_type,biography,followers_count,follows_count,media_count,website" } });
      },
    }),

    tool({
      name: "ig_list_media",
      title: "Recent Instagram posts",
      description: "Recent posts/reels with caption, link, likes and comments counts.",
      connector: "instagram",
      level: "read",
      input: { limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"), account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api<{ data: any[] }>(acc, "/me/media", {
          query: { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url", limit: clampInt(a.limit, 1, 50, 10) },
        });
        return r.data;
      },
    }),

    tool({
      name: "ig_media_insights",
      title: "Post insights",
      description: "Reach, likes, comments, saves, shares for one post (reels also support views).",
      connector: "instagram",
      level: "read",
      input: {
        media_id: z.string().describe("Media ID from ig_list_media"),
        metrics: z.string().optional().describe("Comma-separated, default reach,likes,comments,saved,shares,total_interactions"),
        account,
      },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api<{ data: any[] }>(acc, `/${a.media_id}/insights`, { query: { metric: a.metrics ?? "reach,likes,comments,saved,shares,total_interactions" } });
        return Object.fromEntries((r.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
      },
    }),

    tool({
      name: "ig_account_insights",
      title: "Account insights",
      description: "Account-level metrics over a date range (default last 7 days): reach, views, profile views, engaged accounts.",
      connector: "instagram",
      level: "read",
      input: {
        days: z.number().int().min(1).max(30).optional().describe("Look-back window in days (default 7)"),
        metrics: z.string().optional().describe("Comma-separated, default reach,views,profile_views,accounts_engaged,total_interactions"),
        account,
      },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const until = Math.floor(Date.now() / 1000);
        const since = until - clampInt(a.days, 1, 30, 7) * 86_400;
        const r = await ig.api<{ data: any[] }>(acc, `/${acc.userId}/insights`, {
          query: { metric: a.metrics ?? "reach,views,profile_views,accounts_engaged,total_interactions", period: "day", metric_type: "total_value", since, until },
        });
        return Object.fromEntries((r.data ?? []).map((m) => [m.name, m.total_value?.value]));
      },
    }),

    tool({
      name: "ig_publishing_limit",
      title: "Publishing quota",
      description: "How many API posts this account has used in the last 24 hours (limit is 100).",
      connector: "instagram",
      level: "read",
      input: { account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        return ig.api(acc, `/${acc.userId}/content_publishing_limit`, { query: { fields: "quota_usage,config" } });
      },
    }),

    tool({
      name: "ig_list_comments",
      title: "Comments on a post",
      description: "Comments (with replies) on a post.",
      connector: "instagram",
      level: "read",
      input: { media_id: z.string().describe("Media ID"), limit: z.number().int().min(1).max(50).optional().describe("Default 25"), account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api<{ data: any[] }>(acc, `/${a.media_id}/comments`, {
          query: { fields: "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}", limit: clampInt(a.limit, 1, 50, 25) },
        });
        return r.data;
      },
    }),

    tool({
      name: "ig_list_conversations",
      title: "Direct-message conversations",
      description: "Recent DM conversations (needs the messages permission).",
      connector: "instagram",
      level: "read",
      input: { limit: z.number().int().min(1).max(25).optional().describe("Default 10"), account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api<{ data: any[] }>(acc, "/me/conversations", { query: { platform: "instagram", fields: "id,updated_time,participants", limit: clampInt(a.limit, 1, 25, 10) } });
        return r.data;
      },
    }),

    tool({
      name: "ig_get_conversation",
      title: "Read a DM conversation",
      description: "Latest messages in one conversation. Contains customers' private messages.",
      connector: "instagram",
      level: "write",
      input: { conversation_id: z.string().describe("ID from ig_list_conversations"), limit: z.number().int().min(1).max(30).optional().describe("Default 15"), account },
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        const r = await ig.api<any>(acc, `/${a.conversation_id}`, { query: { fields: `messages.limit(${clampInt(a.limit, 1, 30, 15)}){id,created_time,from,to,message}` } });
        return r.messages?.data ?? r;
      },
    }),

    /* ── inbox (webhook events) ── */
    tool({
      name: "ig_inbox_list",
      title: "Instagram inbox (new comments/DMs/mentions)",
      description: "Events pushed by Instagram webhooks (new comments, messages, mentions) waiting for a human or agent.",
      connector: "instagram",
      level: "read",
      input: { status: z.enum(["new", "handled", "ignored", "all"]).optional().describe("Default new"), limit: z.number().int().min(1).max(100).optional().describe("Default 25") },
      handler: (a) => {
        const st = a.status ?? "new";
        const rows = hub.db.all<{ id: number; kind: string; payload: string; status: string; ts: number }>(
          `SELECT id, kind, payload, status, ts FROM inbox WHERE source='instagram' ${st === "all" ? "" : "AND status = ?"} ORDER BY id DESC LIMIT ${clampInt(a.limit, 1, 100, 25)}`,
          ...(st === "all" ? [] : [st]),
        );
        return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, at: new Date(r.ts).toISOString(), data: JSON.parse(r.payload) }));
      },
    }),

    tool({
      name: "ig_inbox_mark",
      title: "Mark inbox item",
      description: "Mark an inbox event as handled or ignored so teammates don't repeat the work.",
      connector: "instagram",
      level: "write",
      input: { id: z.number().int().describe("Inbox event ID"), status: z.enum(["handled", "ignored", "new"]).describe("New status") },
      handler: (a) => {
        hub.db.run("UPDATE inbox SET status = ? WHERE id = ? AND source = 'instagram'", a.status, a.id);
        return { id: a.id, status: a.status };
      },
    }),

    /* ── publish ── */
    tool({
      name: "ig_publish_photo",
      title: "Publish a photo post",
      description: "Publish a single-image post NOW. The image URL must be a public JPEG. Needs user confirmation.",
      connector: "instagram",
      level: "write",
      input: { image_url: z.string().describe("Public https URL of a JPEG"), alt_text: z.string().optional().describe("Alt text"), ...publishFields },
      confirm: true,
      preview: (a) => previewOf(a, { type: "photo", image_url: a.image_url }),
      openWorld: true,
      handler: (a) => ig.publish(ig.getAccount(a.account), { kind: "image", image_url: a.image_url, caption: a.caption, alt_text: a.alt_text }),
    }),

    tool({
      name: "ig_publish_reel",
      title: "Publish a reel",
      description: "Publish a Reel NOW from a public MP4/MOV URL (processing can take a minute). Needs user confirmation.",
      connector: "instagram",
      level: "write",
      input: {
        video_url: z.string().describe("Public https URL of the video"),
        cover_url: z.string().optional().describe("Optional cover image URL"),
        share_to_feed: z.boolean().optional().describe("Also show on the profile grid (default true)"),
        ...publishFields,
      },
      confirm: true,
      preview: (a) => previewOf(a, { type: "reel", video_url: a.video_url }),
      openWorld: true,
      handler: (a) => ig.publish(ig.getAccount(a.account), { kind: "reel", video_url: a.video_url, caption: a.caption, share_to_feed: a.share_to_feed, cover_url: a.cover_url }),
    }),

    tool({
      name: "ig_publish_story",
      title: "Publish a story",
      description: "Publish a Story NOW from a public image (JPEG) or video URL. Needs user confirmation.",
      connector: "instagram",
      level: "write",
      input: { image_url: z.string().optional().describe("Public JPEG URL"), video_url: z.string().optional().describe("Public video URL"), account },
      confirm: true,
      preview: (a) => previewOf(a, { type: "story", media: a.image_url ?? a.video_url }),
      openWorld: true,
      handler: (a) => ig.publish(ig.getAccount(a.account), { kind: "story", image_url: a.image_url, video_url: a.video_url }),
    }),

    tool({
      name: "ig_publish_carousel",
      title: "Publish a carousel",
      description: "Publish a 2–10 item carousel NOW. Items ending in .mp4/.mov are treated as video, others as JPEG images. Needs user confirmation.",
      connector: "instagram",
      level: "write",
      input: { media_urls: z.string().describe("Comma-separated public URLs (2–10)"), ...publishFields },
      confirm: true,
      preview: (a) => previewOf(a, { type: "carousel", items: a.media_urls.split(",").map((s: string) => s.trim()) }),
      openWorld: true,
      handler: (a) => ig.publish(ig.getAccount(a.account), { kind: "carousel", media_urls: a.media_urls.split(",").map((s: string) => s.trim()).filter(Boolean), caption: a.caption }),
    }),

    tool({
      name: "ig_schedule_post",
      title: "Schedule an Instagram post",
      description:
        "Queue a post for a future time (the hub publishes it automatically). Time is ISO 8601; if no timezone is given Tehran time (UTC+3:30) is assumed. Needs user confirmation now; the post goes out unattended later.",
      connector: "instagram",
      level: "write",
      input: {
        kind: z.enum(["photo", "reel", "story", "carousel"]).describe("Post type"),
        schedule_at: z.string().describe("e.g. 2026-12-01T19:30:00 (Tehran time)"),
        media_url: z.string().optional().describe("Image/video URL for photo, reel or story"),
        media_urls: z.string().optional().describe("Comma-separated URLs for carousel"),
        ...publishFields,
      },
      confirm: true,
      preview: (a) => {
        const at = parseScheduleTime(a.schedule_at);
        if (at < Date.now() + 60_000) throw new HubError("schedule_at must be in the future.", "bad_request");
        return previewOf(a, { type: a.kind, when: fmtTehran(at), media: a.media_url ?? a.media_urls });
      },
      openWorld: true,
      handler: async (a, ctx) => {
        const at = parseScheduleTime(a.schedule_at);
        if (at < Date.now() + 60_000) throw new HubError("schedule_at must be in the future.", "bad_request");
        const acc = ig.getAccount(a.account);
        let payload: PublishPayload;
        if (a.kind === "photo") {
          if (!a.media_url) throw new HubError("media_url is required.", "bad_request");
          await ig.assertImageOk(a.media_url);
          payload = { kind: "image", image_url: a.media_url, caption: a.caption };
        } else if (a.kind === "reel") {
          if (!a.media_url) throw new HubError("media_url is required.", "bad_request");
          payload = { kind: "reel", video_url: a.media_url, caption: a.caption };
        } else if (a.kind === "story") {
          if (!a.media_url) throw new HubError("media_url is required.", "bad_request");
          payload = /\.(mp4|mov)(\?|$)/i.test(a.media_url) ? { kind: "story", video_url: a.media_url } : { kind: "story", image_url: a.media_url };
        } else {
          const urls = (a.media_urls ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
          payload = { kind: "carousel", media_urls: urls, caption: a.caption };
        }
        const id = ig.schedule(acc.label, payload, at, ctx.user.id);
        return { scheduled_id: id, account: `@${acc.username}`, runs_at: fmtTehran(at) };
      },
    }),

    tool({
      name: "ig_list_scheduled",
      title: "Scheduled Instagram posts",
      description: "Upcoming, completed and failed scheduled posts.",
      connector: "instagram",
      level: "read",
      input: { status: z.enum(["pending", "done", "failed", "all"]).optional().describe("Default pending") },
      handler: (a) => {
        const st = a.status ?? "pending";
        const rows = hub.db.all<any>(
          `SELECT id, account, kind, payload, run_at, status, result FROM ig_scheduled ${st === "all" ? "" : "WHERE status = ?"} ORDER BY run_at DESC LIMIT 50`,
          ...(st === "all" ? [] : [st]),
        );
        return rows.map((r) => ({ id: r.id, account: r.account, kind: r.kind, when: fmtTehran(r.run_at), status: r.status, result: r.result, payload: JSON.parse(r.payload) }));
      },
    }),

    tool({
      name: "ig_cancel_scheduled",
      title: "Cancel a scheduled post",
      description: "Cancel a pending scheduled post.",
      connector: "instagram",
      level: "write",
      input: { id: z.string().describe("Scheduled post ID") },
      handler: (a) => {
        hub.db.run("UPDATE ig_scheduled SET status = 'cancelled' WHERE id = ? AND status = 'pending'", a.id);
        return { id: a.id, note: "Cancelled if it was still pending." };
      },
    }),

    /* ── engagement ── */
    tool({
      name: "ig_reply_comment",
      title: "Reply to a comment",
      description: "Post a public reply to a comment. Needs user confirmation (it is public and appears under the account's name).",
      connector: "instagram",
      level: "write",
      input: { comment_id: z.string().describe("Comment ID"), message: z.string().min(1).max(2200).describe("Reply text"), account },
      confirm: true,
      preview: (a) => ({ account: `@${ig.getAccount(a.account).username}`, replying_to_comment: a.comment_id, message: a.message }),
      openWorld: true,
      handler: async (a) => ig.api(ig.getAccount(a.account), `/${a.comment_id}/replies`, { method: "POST", query: { message: a.message } }),
    }),

    tool({
      name: "ig_hide_comment",
      title: "Hide/unhide a comment",
      description: "Hide a comment from public view (reversible).",
      connector: "instagram",
      level: "write",
      input: { comment_id: z.string().describe("Comment ID"), hide: z.boolean().describe("true to hide, false to unhide"), account },
      openWorld: true,
      handler: async (a) => ig.api(ig.getAccount(a.account), `/${a.comment_id}`, { method: "POST", query: { hide: a.hide } }),
    }),

    tool({
      name: "ig_delete_comment",
      title: "Delete a comment (admin)",
      description: "Permanently delete a comment. Admin only; needs confirmation.",
      connector: "instagram",
      level: "admin",
      input: { comment_id: z.string().describe("Comment ID"), account },
      confirm: true,
      destructive: true,
      openWorld: true,
      handler: async (a) => ig.api(ig.getAccount(a.account), `/${a.comment_id}`, { method: "DELETE" }),
    }),

    tool({
      name: "ig_send_dm",
      title: "Send a direct message",
      description:
        "Send a DM reply. Instagram only allows replies within 24 hours of the customer's last message. Needs user confirmation.",
      connector: "instagram",
      level: "write",
      input: { recipient_id: z.string().describe("Instagram-scoped user ID of the customer (from the conversation/inbox)"), text: z.string().min(1).max(1000).describe("Message text"), account },
      confirm: true,
      preview: (a) => ({ account: `@${ig.getAccount(a.account).username}`, to: a.recipient_id, text: a.text, warning: "Private message sent from the business account." }),
      openWorld: true,
      handler: async (a) => {
        const acc = ig.getAccount(a.account);
        return ig.api(acc, `/${acc.userId}/messages`, { method: "POST", json: { recipient: { id: a.recipient_id }, message: { text: a.text } } });
      },
    }),
  ];

  return {
    id: "instagram",
    title: "Instagram (Instagram Login)",
    summary: "اینستاگرام ایران کمپینگ — انتشار، زمان‌بندی، کامنت، دایرکت و آمار؛ بدون لاگین فیسبوک",
    tools,
    async health() {
      const accs = ig.listAccounts();
      if (!accs.length) return { ok: false, detail: "no account connected (use ig_connect_start)" };
      const soon = accs.filter((a) => a.expiresAt - Date.now() < 7 * 86_400_000);
      return { ok: soon.length === 0, detail: `${accs.map((a) => "@" + a.username).join(", ")}${soon.length ? ` — token expiring soon: ${soon.map((a) => a.label).join(", ")}` : ""}` };
    },
    start: () => ig.start(),
    stop: () => ig.stop(),
  };
}
