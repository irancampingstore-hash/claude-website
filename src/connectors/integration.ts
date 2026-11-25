import { randomUUID } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { z } from "zod";
import type { Hub } from "../core/hub.js";
import { levelAtLeast, type Connector, type ConnectorId, type Level, type ToolContext, type ToolDef } from "../core/types.js";
import { HubError, stripHtml, truncate } from "../util/text.js";
import { clampInt, tool } from "./helpers.js";
import type { WordPressClient } from "./wordpress.js";
import { summarizeProduct } from "./wordpress.js";
import type { InstagramService } from "./instagram-service.js";
import type { PcBridge } from "./pc-bridge.js";
import type { AgentDef } from "./agents.js";

function need(ctx: ToolContext, connector: ConnectorId, level: Exclude<Level, "none">): void {
  if (!levelAtLeast(ctx.user.grants[connector], level)) {
    throw new HubError(`This workflow also needs "${level}" access on "${connector}", which your account doesn't have.`, "permission");
  }
}
const can = (ctx: ToolContext, connector: ConnectorId, level: Exclude<Level, "none"> = "read") => levelAtLeast(ctx.user.grants[connector], level);

async function siteProbe(url: string): Promise<{ url: string; status?: number; ms: number; tls_days_left?: number; error?: string }> {
  const t0 = Date.now();
  let status: number | undefined;
  let error: string | undefined;
  try {
    status = (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) })).status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - t0;
  let tls_days_left: number | undefined;
  if (url.startsWith("https://")) {
    const host = new URL(url).hostname;
    tls_days_left = await new Promise<number | undefined>((resolve) => {
      const s = tlsConnect({ host, port: 443, servername: host, timeout: 8000 }, () => {
        const c = s.getPeerCertificate();
        s.end();
        resolve(c?.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : undefined);
      });
      s.on("error", () => resolve(undefined));
      s.on("timeout", () => {
        s.destroy();
        resolve(undefined);
      });
    });
  }
  return { url, status, ms, tls_days_left, error };
}

const hashtagsFor = (name: string) => ["#ایران_کمپینگ", "#کمپینگ", "#طبیعت_گردی", "#کوهنوردی", `#${name.split(/\s+/).slice(0, 2).join("_")}`].join(" ");

export function createHubConnector(hub: Hub): Connector {
  const wp = () => hub.services.get("wordpress") as WordPressClient | undefined;
  const ig = () => hub.services.get("instagram") as InstagramService | undefined;
  const bridge = () => hub.services.get("pcBridge") as PcBridge | undefined;
  const agents = () => hub.services.get("agents") as { agents: AgentDef[]; byId: (id: string) => AgentDef; ask: (a: AgentDef, m: string, c: string | undefined, x: string | undefined, u: string) => Promise<string> } | undefined;

  const tools: ToolDef[] = [
    /* ───── overview & health ───── */
    tool({
      name: "hub_overview",
      title: "Hub overview & health",
      description: "Which systems are connected and healthy (irancamping.com, VPS, PC, Instagram, agents), and what your account can do. Good first call in a new chat.",
      connector: "hub",
      level: "read",
      input: {},
      handler: async (_a, ctx) => {
        const health = await hub.health();
        return {
          you: { name: ctx.user.name, role: ctx.user.role, access: ctx.user.grants },
          systems: hub.connectors.map((c) => ({ id: c.id, title: c.title, about: c.summary, healthy: health[c.id]?.ok, status: health[c.id]?.detail, tools_you_can_use: c.tools.filter((t) => levelAtLeast(ctx.user.grants[t.connector], t.level)).length })),
        };
      },
    }),

    tool({
      name: "hub_site_health",
      title: "Check both websites",
      description: "HTTP status, response time and SSL expiry for irancamping.com and iranoutdoor.com.",
      connector: "hub",
      level: "read",
      input: {},
      openWorld: true,
      handler: async () => {
        const urls = [hub.config.wordpress?.url, hub.config.vps?.siteUrl].filter((u): u is string => !!u);
        return Promise.all(urls.map(siteProbe));
      },
    }),

    tool({
      name: "workflow_daily_digest",
      title: "Daily business digest",
      description:
        "One-shot morning report across everything your account can see: last-24h orders and revenue, Instagram stats and inbox, scheduled posts, comments awaiting moderation, server health, PC and agent status.",
      connector: "hub",
      level: "read",
      input: { hours: z.number().int().min(1).max(168).optional().describe("Look-back window (default 24)") },
      openWorld: true,
      handler: async (a, ctx) => {
        const hours = clampInt(a.hours, 1, 168, 24);
        const since = new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19);
        const sections: Record<string, Promise<unknown>> = {};

        const w = wp();
        if (w && can(ctx, "wordpress")) {
          sections.store_orders = w.wc<any[]>("/orders", { query: { after: since, per_page: 100 } }).then((r) => {
            const orders = r.json ?? [];
            const byStatus: Record<string, number> = {};
            let revenue = 0;
            for (const o of orders) {
              byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
              if (!["cancelled", "failed", "refunded", "pending"].includes(o.status)) revenue += Number(o.total) || 0;
            }
            return { window_hours: hours, orders: orders.length, by_status: byStatus, revenue_excl_cancelled: revenue, currency: orders[0]?.currency, note: orders.length >= 100 ? "100+ orders, counts are capped" : undefined };
          });
          sections.low_stock = w.wc<any[]>("/products", { query: { stock_status: "outofstock", status: "publish", per_page: 10 } }).then((r) => ({ out_of_stock_count_shown: r.json?.length ?? 0, items: (r.json ?? []).map((p) => p.name) }));
          sections.comments_awaiting_moderation = w.wp<any[]>("/comments", { query: { status: "hold", per_page: 1 } }).then((r) => Number(r.headers.get("x-wp-total") ?? r.json?.length ?? 0));
        }

        const i = ig();
        if (i && can(ctx, "instagram")) {
          sections.instagram = (async () => {
            const accs = i.listAccounts();
            const out = [];
            for (const acc of accs) {
              const [profile, insights] = await Promise.allSettled([
                i.api<any>(acc, "/me", { query: { fields: "username,followers_count,media_count" } }),
                i.api<any>(acc, `/${acc.userId}/insights`, { query: { metric: "reach,views,accounts_engaged", period: "day", metric_type: "total_value", since: Math.floor(Date.now() / 1000) - hours * 3600, until: Math.floor(Date.now() / 1000) } }),
              ]);
              out.push({
                account: `@${acc.username}`,
                followers: profile.status === "fulfilled" ? profile.value.followers_count : undefined,
                insights: insights.status === "fulfilled" ? Object.fromEntries((insights.value.data ?? []).map((m: any) => [m.name, m.total_value?.value])) : `unavailable: ${(insights as PromiseRejectedResult).reason?.message ?? "error"}`,
              });
            }
            const pending = hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM ig_scheduled WHERE status='pending'")?.n ?? 0;
            const inbox = hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox WHERE source='instagram' AND status='new'")?.n ?? 0;
            return { accounts: out, scheduled_pending: pending, inbox_new: inbox };
          })();
        }

        if (can(ctx, "vps") && hub.connector("vps")) sections.vps = hub.connector("vps")!.health();
        if (can(ctx, "pc")) sections.pc = hub.connector("pc")!.health();
        if (can(ctx, "agents")) {
          sections.agents = Promise.resolve({
            new_agent_reports: hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox WHERE source LIKE 'agent:%' AND status='new'")?.n ?? 0,
            tasks_waiting: hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox WHERE source LIKE 'to:%' AND kind='task' AND status='new'")?.n ?? 0,
          });
        }
        sections.websites = hub.connector("hub") ? Promise.all([hub.config.wordpress?.url, hub.config.vps?.siteUrl].filter((u): u is string => !!u).map(siteProbe)) : Promise.resolve([]);

        const entries = await Promise.all(
          Object.entries(sections).map(async ([k, p]) => {
            try {
              return [k, await p] as const;
            } catch (e) {
              return [k, { error: e instanceof Error ? e.message : String(e) }] as const;
            }
          }),
        );
        return { generated_at: new Date().toISOString(), ...Object.fromEntries(entries) };
      },
    }),

    /* ───── cross-system workflows ───── */
    tool({
      name: "workflow_product_to_instagram",
      title: "Post a store product on Instagram",
      description:
        "Take a WooCommerce product (name, price, photo, link) and publish it — or schedule it — as an Instagram photo post. If caption is omitted a Persian caption is generated from the product data. " +
        "Needs wordpress read + instagram write, and user confirmation.",
      connector: "instagram",
      level: "write",
      input: {
        product_id: z.number().int().describe("WooCommerce product ID"),
        caption: z.string().max(2200).optional().describe("Custom caption; omit to auto-generate"),
        schedule_at: z.string().optional().describe("Optional ISO time (Tehran if no zone) to schedule instead of posting now"),
        image_index: z.number().int().min(0).max(9).optional().describe("Which product image to use (default 0)"),
        account: z.string().optional().describe("Instagram account label"),
      },
      confirm: true,
      preview: async (a, ctx) => {
        const r = await resolveProductPost(a, ctx);
        return { account: `@${r.acc.username}`, product: r.product.name, image: r.image, caption: r.caption, when: a.schedule_at ?? "immediately", warning: "Public Instagram post." };
      },
      openWorld: true,
      handler: async (a, ctx) => {
        const r = await resolveProductPost(a, ctx);
        const svc = ig()!;
        if (a.schedule_at) {
          const { parseScheduleTime } = await import("./instagram.js");
          const at = parseScheduleTime(a.schedule_at);
          if (at < Date.now() + 60_000) throw new HubError("schedule_at must be in the future.", "bad_request");
          const id = svc.schedule(r.acc.label, { kind: "image", image_url: r.image, caption: r.caption }, at, ctx.user.id);
          return { scheduled_id: id, product: r.product.name, runs_at: new Date(at).toISOString() };
        }
        const out = await svc.publish(r.acc, { kind: "image", image_url: r.image, caption: r.caption });
        return { published: out, product: r.product.name };
      },
    }),

    tool({
      name: "workflow_instagram_triage",
      title: "Draft replies for new Instagram comments",
      description:
        "Collect recent comments on the latest posts (and new inbox events), and optionally ask one of the company AI agents to draft a reply for each. Returns DRAFTS only — nothing is posted. " +
        "Post approved replies afterwards with ig_reply_comment.",
      connector: "instagram",
      level: "read",
      input: {
        posts: z.number().int().min(1).max(10).optional().describe("How many recent posts to scan (default 3)"),
        agent_id: z.string().optional().describe("Agent that drafts replies (e.g. irancamping). Omit to just list the comments."),
        account: z.string().optional().describe("Instagram account label"),
      },
      openWorld: true,
      handler: async (a, ctx) => {
        const svc = ig();
        if (!svc) throw new HubError("Instagram is not configured.", "not_configured");
        const acc = svc.getAccount(a.account);
        const media = (await svc.api<{ data: any[] }>(acc, "/me/media", { query: { fields: "id,caption,permalink", limit: clampInt(a.posts, 1, 10, 3) } })).data ?? [];
        const comments: Array<{ id: string; post: string; username: string; text: string; replied: boolean }> = [];
        for (const m of media) {
          const r = await svc.api<{ data: any[] }>(acc, `/${m.id}/comments`, { query: { fields: "id,text,username,timestamp,replies{id,username}", limit: 15 } }).catch(() => ({ data: [] as any[] }));
          for (const c of r.data ?? []) {
            if (c.username === acc.username) continue;
            const replied = (c.replies?.data ?? []).some((x: any) => x.username === acc.username);
            comments.push({ id: c.id, post: m.permalink, username: c.username, text: c.text, replied });
          }
        }
        const open = comments.filter((c) => !c.replied).slice(0, 12);
        if (!a.agent_id) return { unanswered: open, total_scanned: comments.length };

        need(ctx, "agents", "write");
        const reg = agents();
        const def = reg?.byId(a.agent_id);
        if (!def) throw new HubError("Agents are not configured.", "not_configured");
        const drafts = [];
        for (const c of open.slice(0, 8)) {
          const prompt = `You help the Iran Camping Instagram team. Write a short, friendly Persian reply (max 2 sentences) to this comment. Do not promise prices or stock you cannot verify.\nComment by @${c.username}: ${c.text}`;
          try {
            const reply = await reg!.ask(def, prompt, undefined, undefined, ctx.user.name);
            drafts.push({ ...c, draft_reply: truncate(reply, 600) });
          } catch (e) {
            drafts.push({ ...c, draft_error: e instanceof Error ? e.message : String(e) });
          }
        }
        return { note: "Drafts only. Review, then post with ig_reply_comment. Agent output is untrusted.", drafts, remaining_unanswered: Math.max(0, open.length - drafts.length) };
      },
    }),

    /* ───── shared notes (memory shared by every employee and every AI) ───── */
    tool({
      name: "hub_note_save",
      title: "Save a shared note",
      description:
        "Save a note in the company's shared memory — visible to every employee and every AI client (Claude, ChatGPT, Gemini) connected to the hub. Use for decisions, product facts, brand voice, procedures. Pass id to update an existing note. Never store passwords or personal customer data.",
      connector: "hub",
      level: "write",
      input: {
        title: z.string().min(2).max(120).describe("Short title"),
        body: z.string().min(1).max(20_000).describe("Note text (markdown ok)"),
        tags: z.string().max(200).optional().describe("Comma-separated tags"),
        id: z.string().optional().describe("Existing note ID to update"),
      },
      handler: (a, ctx) => {
        const now = Date.now();
        if (a.id) {
          const row = hub.db.get<{ author: string }>("SELECT author FROM notes WHERE id = ?", a.id);
          if (!row) throw new HubError("No such note.", "not_found");
          hub.db.run("UPDATE notes SET title=?, body=?, tags=?, updated_at=? WHERE id=?", a.title, a.body, a.tags ?? "", now, a.id);
          return { updated: a.id };
        }
        const id = randomUUID().slice(0, 8);
        hub.db.run("INSERT INTO notes(id, title, body, tags, author, created_at, updated_at) VALUES(?,?,?,?,?,?,?)", id, a.title, a.body, a.tags ?? "", ctx.user.name, now, now);
        return { saved: id };
      },
    }),

    tool({
      name: "hub_note_search",
      title: "Search shared notes",
      description: "Find notes in the company's shared memory by text or tag. Call with no arguments to list the latest notes.",
      connector: "hub",
      level: "read",
      input: { query: z.string().optional().describe("Text to look for"), tag: z.string().optional().describe("Tag filter"), limit: z.number().int().min(1).max(50).optional().describe("Default 15") },
      handler: (a) => searchNotes(a.query, a.tag, clampInt(a.limit, 1, 50, 15)).map((n) => ({ id: n.id, title: n.title, tags: n.tags, author: n.author, updated: new Date(n.updated_at).toISOString(), preview: truncate(n.body, 240) })),
    }),

    tool({
      name: "hub_note_get",
      title: "Read a shared note",
      description: "Full text of a note.",
      connector: "hub",
      level: "read",
      input: { id: z.string().describe("Note ID") },
      handler: (a) => {
        const n = hub.db.get<any>("SELECT * FROM notes WHERE id = ?", a.id);
        if (!n) throw new HubError("No such note.", "not_found");
        return { id: n.id, title: n.title, tags: n.tags, author: n.author, updated: new Date(n.updated_at).toISOString(), body: n.body };
      },
    }),

    tool({
      name: "hub_note_delete",
      title: "Delete a shared note",
      description: "Delete a note. You can delete your own notes; admins can delete any.",
      connector: "hub",
      level: "write",
      input: { id: z.string().describe("Note ID") },
      destructive: true,
      handler: (a, ctx) => {
        const n = hub.db.get<{ author: string }>("SELECT author FROM notes WHERE id = ?", a.id);
        if (!n) throw new HubError("No such note.", "not_found");
        if (n.author !== ctx.user.name && !levelAtLeast(ctx.user.grants.hub, "admin")) throw new HubError("Only the author or an admin can delete this note.", "permission");
        hub.db.run("DELETE FROM notes WHERE id = ?", a.id);
        return { deleted: a.id };
      },
    }),

    tool({
      name: "hub_audit_log",
      title: "Audit log (admin)",
      description: "Who used which tool, when, and with what outcome. Admin only.",
      connector: "hub",
      level: "admin",
      input: {
        limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
        user_id: z.string().optional().describe("Filter by user ID"),
        tool: z.string().optional().describe("Filter by tool name"),
        outcome: z.enum(["ok", "error", "denied", "confirm_required", "rate_limited"]).optional().describe("Filter by outcome"),
      },
      handler: (a) =>
        hub.audit.recent(clampInt(a.limit, 1, 200, 30), { user: a.user_id, tool: a.tool, outcome: a.outcome }).map((e) => ({
          at: new Date(e.ts).toISOString(),
          user: e.user_id,
          client: e.client,
          tool: e.tool,
          outcome: e.outcome,
          ms: e.duration_ms,
          args: e.args ? JSON.parse(e.args) : undefined,
          error: e.error,
        })),
    }),

    /* ───── OpenAI-spec search / fetch (ChatGPT deep research & company knowledge) ───── */
    tool({
      name: "search",
      title: "Search everything",
      description: "Search the company's systems at once: shared notes, irancamping.com posts/pages and store products. Returns result ids to pass to `fetch`.",
      connector: "hub",
      level: "read",
      input: { query: z.string().min(1).describe("Search text (Persian or English)") },
      openWorld: true,
      handler: async (a, ctx) => {
        const results: Array<{ id: string; title: string; url: string }> = [];
        for (const n of searchNotes(a.query, undefined, 8)) results.push({ id: `note:${n.id}`, title: `📝 ${n.title}`, url: `hub://note/${n.id}` });
        const w = wp();
        if (w && can(ctx, "wordpress")) {
          const [posts, products] = await Promise.allSettled([
            w.wp<any[]>("/search", { query: { search: a.query, per_page: 8 } }),
            w.hasWc ? w.wc<any[]>("/products", { query: { search: a.query, per_page: 8 } }) : Promise.resolve({ json: [] as any[] }),
          ]);
          if (posts.status === "fulfilled") for (const p of posts.value.json ?? []) results.push({ id: `wp:${p.subtype ?? "post"}:${p.id}`, title: stripHtml(p.title), url: p.url });
          if (products.status === "fulfilled") for (const p of products.value.json ?? []) results.push({ id: `product:${p.id}`, title: `🛒 ${p.name}`, url: p.permalink });
        }
        return { results };
      },
    }),

    tool({
      name: "fetch",
      title: "Fetch a search result",
      description: "Get the full content of a result returned by `search` (note:<id>, wp:post:<id>, wp:page:<id>, product:<id>).",
      connector: "hub",
      level: "read",
      input: { id: z.string().describe("Result id from search") },
      openWorld: true,
      handler: async (a, ctx) => {
        const [kind, ...rest] = a.id.split(":");
        if (kind === "note") {
          const n = hub.db.get<any>("SELECT * FROM notes WHERE id = ?", rest[0] ?? "");
          if (!n) throw new HubError("No such note.", "not_found");
          return { id: a.id, title: n.title, text: n.body, url: `hub://note/${n.id}`, metadata: { tags: n.tags, author: n.author } };
        }
        const w = wp();
        if (!w || !can(ctx, "wordpress")) throw new HubError("No access to the website connector.", "permission");
        if (kind === "wp") {
          const [type, id] = rest;
          const p = (await w.wp<any>(`/${type === "page" ? "pages" : "posts"}/${id}`)).json;
          return { id: a.id, title: stripHtml(p.title?.rendered), text: truncate(stripHtml(p.content?.rendered), 20_000), url: p.link, metadata: { status: p.status, modified: p.modified } };
        }
        if (kind === "product") {
          const p = (await w.wc<any>(`/products/${rest[0]}`)).json;
          return { id: a.id, title: p.name, text: truncate(`${stripHtml(p.short_description)}\n${stripHtml(p.description)}\nقیمت: ${p.price} | موجودی: ${p.stock_status}`, 20_000), url: p.permalink, metadata: summarizeProduct(p) };
        }
        throw new HubError("Unknown id format.", "bad_request");
      },
    }),
  ];

  function searchNotes(query: string | undefined, tag: string | undefined, limit: number) {
    const where: string[] = [];
    const params: string[] = [];
    if (query) {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }
    if (tag) {
      where.push("(',' || REPLACE(tags, ' ', '') || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${tag.replace(/\s/g, "")},%`);
    }
    return hub.db.all<any>(`SELECT * FROM notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ${limit}`, ...params);
  }

  async function resolveProductPost(a: { product_id: number; caption?: string; image_index?: number; account?: string }, ctx: ToolContext) {
    need(ctx, "wordpress", "read");
    const w = wp();
    const svc = ig();
    if (!w || !svc) throw new HubError("This workflow needs both the WordPress and Instagram connectors configured.", "not_configured");
    const product = (await w.wc<any>(`/products/${a.product_id}`)).json;
    if (product.status !== "publish") throw new HubError(`Product is "${product.status}", not published — refusing to advertise it.`, "bad_state");
    if (product.stock_status === "outofstock") throw new HubError("Product is out of stock — refusing to advertise it.", "bad_state");
    const image: string | undefined = product.images?.[a.image_index ?? 0]?.src;
    if (!image) throw new HubError("Product has no image.", "bad_request");
    const acc = svc.getAccount(a.account);
    await svc.assertImageOk(image);
    const price = product.price ? `${Number(product.price).toLocaleString("fa-IR")} ${product.currency ?? "تومان"}` : undefined;
    const caption =
      a.caption ??
      [`🏕️ ${product.name}`, stripHtml(product.short_description).slice(0, 280), price ? `💰 قیمت: ${price}` : "", `🛒 سفارش و جزئیات: ${product.permalink}`, "", hashtagsFor(product.name)]
        .filter((l) => l !== "")
        .join("\n\n");
    return { product, image: image as string, caption, acc };
  }

  return {
    id: "hub",
    title: "هاب یکپارچه",
    summary: "حافظه مشترک، گزارش روزانه، جست‌وجوی سراسری و گردش‌کارهای بین‌سیستمی",
    tools,
    async health() {
      const n = hub.db.get<{ n: number }>("SELECT COUNT(*) n FROM notes")?.n ?? 0;
      const u = hub.users.list().filter((x) => !x.disabled).length;
      return { ok: u > 0, detail: `${u} active user(s), ${n} shared note(s), PC bridge ${bridge()?.online().length ?? 0} online` };
    },
  };
}
