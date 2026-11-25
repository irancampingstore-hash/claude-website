import { z } from "zod";
import type { Hub } from "../core/hub.js";
import type { Connector, ToolDef } from "../core/types.js";
import type { WordPressConfig } from "../core/config.js";
import { http, type HttpOptions } from "../util/http.js";
import { assertPublicUrl, fetchPublic } from "../util/ssrf.js";
import { HubError, stripHtml, truncate } from "../util/text.js";
import { clampInt, parseJsonArg, tool } from "./helpers.js";

/* ───────────── REST client ───────────── */

export class WordPressClient {
  constructor(readonly cfg: WordPressConfig) {}

  private basic(user?: string, pass?: string): Record<string, string> {
    if (!user || !pass) return {};
    return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
  }

  private secrets() {
    return [this.cfg.appPassword, this.cfg.wcKey, this.cfg.wcSecret];
  }

  get hasWp(): boolean {
    return !!(this.cfg.user && this.cfg.appPassword);
  }
  get hasWc(): boolean {
    return !!(this.cfg.wcKey && this.cfg.wcSecret);
  }

  async wp<T = any>(path: string, opts: HttpOptions = {}) {
    if (!this.hasWp) throw new HubError("WordPress credentials are not configured (WP_USER / WP_APP_PASSWORD).", "not_configured");
    return http<T>(`${this.cfg.url}/wp-json/wp/v2${path}`, {
      ...opts,
      headers: { ...this.basic(this.cfg.user, this.cfg.appPassword), ...opts.headers },
      secrets: this.secrets(),
    });
  }

  async wc<T = any>(path: string, opts: HttpOptions = {}) {
    if (!this.hasWc) throw new HubError("WooCommerce keys are not configured (WC_KEY / WC_SECRET).", "not_configured");
    return http<T>(`${this.cfg.url}/wp-json/wc/v3${path}`, {
      ...opts,
      headers: { ...this.basic(this.cfg.wcKey, this.cfg.wcSecret), ...opts.headers },
      secrets: this.secrets(),
    });
  }

  async root<T = any>() {
    return http<T>(`${this.cfg.url}/wp-json/`, { secrets: this.secrets(), timeoutMs: 15_000 });
  }

  /** Raw route access (any namespace) for admin tools. */
  async raw<T = any>(route: string, opts: HttpOptions = {}) {
    const path = route.startsWith("/") ? route : `/${route}`;
    return http<T>(`${this.cfg.url}/wp-json${path}`, {
      ...opts,
      headers: { ...this.basic(this.cfg.user, this.cfg.appPassword), ...opts.headers },
      secrets: this.secrets(),
    });
  }
}

/* ───────────── summarizers (keep model context small) ───────────── */

export const summarizePost = (p: any) => ({
  id: p.id,
  type: p.type,
  status: p.status,
  title: stripHtml(p.title?.rendered ?? p.title?.raw),
  slug: p.slug,
  date: p.date,
  modified: p.modified,
  link: p.link,
  excerpt: truncate(stripHtml(p.excerpt?.rendered), 280),
});

export const summarizeProduct = (p: any) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  type: p.type,
  sku: p.sku || undefined,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || undefined,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity,
  categories: (p.categories ?? []).map((c: any) => c.name),
  image: p.images?.[0]?.src,
  link: p.permalink,
});

export const summarizeOrder = (o: any, withCustomer: boolean) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  date: o.date_created,
  total: o.total,
  currency: o.currency,
  payment_method: o.payment_method_title,
  items: (o.line_items ?? []).map((i: any) => ({ name: i.name, qty: i.quantity, total: i.total, product_id: i.product_id })),
  city: o.shipping?.city || o.billing?.city,
  state: o.shipping?.state || o.billing?.state,
  ...(withCustomer
    ? {
        customer: {
          name: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim(),
          phone: o.billing?.phone,
          email: o.billing?.email,
          address: [o.shipping?.address_1, o.shipping?.address_2, o.shipping?.city, o.shipping?.state, o.shipping?.postcode]
            .filter(Boolean)
            .join("، "),
          note: o.customer_note || undefined,
        },
      }
    : {}),
});

const pageMeta = (headers: Headers) => ({
  total: Number(headers.get("x-wp-total") ?? NaN) || undefined,
  total_pages: Number(headers.get("x-wp-totalpages") ?? NaN) || undefined,
});

/* ───────────── connector ───────────── */

export function createWordPressConnector(hub: Hub): Connector | undefined {
  const cfg = hub.config.wordpress;
  if (!cfg) return undefined;
  const client = new WordPressClient(cfg);
  hub.services.set("wordpress", client);

  const perPage = z.number().int().min(1).max(50).optional().describe("Items per page (1-50, default 10)");
  const page = z.number().int().min(1).optional().describe("Page number (default 1)");

  const tools: ToolDef[] = [
    tool({
      name: "wp_site_info",
      title: "Site info (irancamping.com)",
      description: "Basic information about the WordPress site: name, URL, active API namespaces (e.g. whether WooCommerce is present).",
      connector: "wordpress",
      level: "read",
      input: {},
      openWorld: true,
      handler: async () => {
        const r = await client.root();
        return { name: r.json?.name, description: r.json?.description, url: r.json?.url, namespaces: r.json?.namespaces };
      },
    }),

    tool({
      name: "wp_list_posts",
      title: "List posts or pages",
      description: "List/search blog posts or pages. Includes drafts when status is set to draft/any.",
      connector: "wordpress",
      level: "read",
      input: {
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        search: z.string().optional().describe("Search text"),
        status: z.enum(["publish", "draft", "pending", "private", "future", "any"]).optional().describe("Status filter (default any)"),
        per_page: perPage,
        page,
      },
      openWorld: true,
      handler: async (a) => {
        const base = a.post_type === "page" ? "/pages" : "/posts";
        const r = await client.wp<any[]>(base, {
          query: { search: a.search, status: a.status ?? "any", per_page: clampInt(a.per_page, 1, 50, 10), page: a.page ?? 1, context: "edit" },
        });
        return { ...pageMeta(r.headers), items: (r.json ?? []).map(summarizePost) };
      },
    }),

    tool({
      name: "wp_get_post",
      title: "Read a post or page",
      description: "Get the full content of a post/page as plain text (and optionally the raw HTML/Elementor-rendered HTML).",
      connector: "wordpress",
      level: "read",
      input: {
        id: z.number().int().describe("Post/page ID"),
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        include_html: z.boolean().optional().describe("Also return the HTML (can be large)"),
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, { query: { context: "edit" } });
        const p = r.json;
        return {
          ...summarizePost(p),
          categories: p.categories,
          tags: p.tags,
          featured_media: p.featured_media,
          content_text: truncate(stripHtml(p.content?.rendered), 12_000),
          ...(a.include_html ? { content_html: truncate(p.content?.raw ?? p.content?.rendered ?? "", 20_000) } : {}),
        };
      },
    }),

    tool({
      name: "wp_create_post",
      title: "Create a draft post/page",
      description:
        "Create a post or page as a DRAFT (or pending review). Publishing is a separate step (wp_publish_post). Content may be HTML.",
      connector: "wordpress",
      level: "write",
      input: {
        title: z.string().min(1).describe("Title"),
        content: z.string().describe("Body (HTML or plain text)"),
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        excerpt: z.string().optional().describe("Short excerpt"),
        status: z.enum(["draft", "pending"]).optional().describe("draft (default) or pending"),
        categories: z.string().optional().describe("Comma-separated category IDs"),
        tags: z.string().optional().describe("Comma-separated tag IDs"),
      },
      openWorld: true,
      handler: async (a) => {
        const ids = (s?: string) => (s ? s.split(",").map((x) => Number(x.trim())).filter(Boolean) : undefined);
        const r = await client.wp<any>(a.post_type === "page" ? "/pages" : "/posts", {
          method: "POST",
          body: { title: a.title, content: a.content, excerpt: a.excerpt, status: a.status ?? "draft", categories: ids(a.categories), tags: ids(a.tags) },
        });
        return { created: summarizePost(r.json), edit_url: `${cfg.url}/wp-admin/post.php?post=${r.json.id}&action=edit` };
      },
    }),

    tool({
      name: "wp_update_post",
      title: "Edit a post/page",
      description: "Change title, content, excerpt or slug of an existing post/page. Does not change publish status.",
      connector: "wordpress",
      level: "write",
      input: {
        id: z.number().int().describe("Post/page ID"),
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New full content (replaces existing — for pages built with Elementor use the Elementor editor instead)"),
        excerpt: z.string().optional().describe("New excerpt"),
        slug: z.string().optional().describe("New URL slug"),
      },
      confirm: true,
      preview: async (a) => {
        const cur = (await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, { query: { context: "edit" } })).json;
        return {
          id: a.id,
          current_title: stripHtml(cur.title?.rendered),
          current_status: cur.status,
          changes: { title: a.title, slug: a.slug, excerpt: a.excerpt, content_chars: a.content?.length },
          warning: a.content ? "Content will be fully replaced." : undefined,
        };
      },
      openWorld: true,
      handler: async (a) => {
        const body: Record<string, unknown> = {};
        for (const k of ["title", "content", "excerpt", "slug"] as const) if (a[k] !== undefined) body[k] = a[k];
        if (!Object.keys(body).length) throw new HubError("Nothing to update.", "bad_request");
        const r = await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, { method: "POST", body });
        return { updated: summarizePost(r.json) };
      },
    }),

    tool({
      name: "wp_publish_post",
      title: "Publish or schedule a post/page",
      description: "Publish a draft now, or schedule it with a future ISO date (site timezone). Requires user confirmation.",
      connector: "wordpress",
      level: "write",
      input: {
        id: z.number().int().describe("Post/page ID"),
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        schedule_at: z.string().optional().describe("ISO 8601 date-time to schedule; omit to publish immediately"),
      },
      confirm: true,
      preview: async (a) => {
        const cur = (await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, { query: { context: "edit" } })).json;
        return { will: a.schedule_at ? `schedule for ${a.schedule_at}` : "publish immediately (public)", post: summarizePost(cur) };
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, {
          method: "POST",
          body: a.schedule_at ? { status: "future", date: a.schedule_at } : { status: "publish" },
        });
        return { post: summarizePost(r.json) };
      },
    }),

    tool({
      name: "wp_delete_post",
      title: "Trash a post/page",
      description: "Move a post/page to trash (recoverable). Set force=true to delete permanently.",
      connector: "wordpress",
      level: "admin",
      input: {
        id: z.number().int().describe("Post/page ID"),
        post_type: z.enum(["post", "page"]).optional().describe("post (default) or page"),
        force: z.boolean().optional().describe("Permanently delete instead of trashing"),
      },
      confirm: true,
      destructive: true,
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any>(`${a.post_type === "page" ? "/pages" : "/posts"}/${a.id}`, {
          method: "DELETE",
          query: { force: a.force ? "true" : undefined },
        });
        return { deleted: true, permanent: !!a.force, id: a.id, status: r.json?.status };
      },
    }),

    tool({
      name: "wp_list_terms",
      title: "List categories/tags",
      description: "List blog categories or tags (to find IDs for posts).",
      connector: "wordpress",
      level: "read",
      input: {
        taxonomy: z.enum(["categories", "tags"]).describe("categories or tags"),
        search: z.string().optional().describe("Search text"),
        per_page: perPage,
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any[]>(`/${a.taxonomy}`, { query: { search: a.search, per_page: clampInt(a.per_page, 1, 50, 20) } });
        return (r.json ?? []).map((t) => ({ id: t.id, name: t.name, slug: t.slug, count: t.count }));
      },
    }),

    tool({
      name: "wp_list_media",
      title: "List media library",
      description: "Search the media library (images/videos) and get their IDs and URLs.",
      connector: "wordpress",
      level: "read",
      input: { search: z.string().optional().describe("Search text"), per_page: perPage, page },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any[]>("/media", { query: { search: a.search, per_page: clampInt(a.per_page, 1, 50, 10), page: a.page ?? 1 } });
        return {
          ...pageMeta(r.headers),
          items: (r.json ?? []).map((m) => ({ id: m.id, title: stripHtml(m.title?.rendered), mime: m.mime_type, url: m.source_url, alt: m.alt_text })),
        };
      },
    }),

    tool({
      name: "wp_upload_media_from_url",
      title: "Upload image to media library",
      description: "Download a public image URL (max 10 MB) and add it to the WordPress media library.",
      connector: "wordpress",
      level: "write",
      input: {
        url: z.string().describe("Public https URL of the image"),
        filename: z.string().optional().describe("File name to use, e.g. tent-2024.jpg"),
        alt_text: z.string().optional().describe("Alt text (Persian is fine)"),
      },
      openWorld: true,
      handler: async (a) => {
        const src = await assertPublicUrl(a.url);
        const res = await fetchPublic(a.url);
        if (!res.ok) throw new HubError(`Could not download image: HTTP ${res.status}`, "http_error");
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 10 * 1024 * 1024) throw new HubError("Image is larger than 10 MB.", "too_large");
        const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
        if (!mime.startsWith("image/")) throw new HubError(`URL is not an image (${mime}).`, "bad_type");
        const name = (a.filename ?? src.pathname.split("/").pop() ?? "upload.jpg").replace(/[^\w.\-]/g, "_");
        const up = await client.wp<any>("/media", {
          method: "POST",
          body: buf,
          headers: { "content-type": mime, "content-disposition": `attachment; filename="${name}"` },
          timeoutMs: 60_000,
        });
        if (a.alt_text) await client.wp(`/media/${up.json.id}`, { method: "POST", body: { alt_text: a.alt_text } });
        return { id: up.json.id, url: up.json.source_url, mime };
      },
    }),

    tool({
      name: "wp_list_comments",
      title: "List comments",
      description: "List site comments (default: those awaiting moderation).",
      connector: "wordpress",
      level: "read",
      input: {
        status: z.enum(["hold", "approve", "spam", "trash", "all"]).optional().describe("Default hold (pending)"),
        per_page: perPage,
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any[]>("/comments", { query: { status: a.status ?? "hold", per_page: clampInt(a.per_page, 1, 50, 20), context: "edit" } });
        return (r.json ?? []).map((c) => ({
          id: c.id,
          post: c.post,
          author: c.author_name,
          status: c.status,
          date: c.date,
          text: truncate(stripHtml(c.content?.rendered ?? c.content?.raw), 400),
        }));
      },
    }),

    tool({
      name: "wp_moderate_comment",
      title: "Moderate a comment",
      description: "Approve, hold, mark as spam, or trash a comment.",
      connector: "wordpress",
      level: "write",
      input: {
        id: z.number().int().describe("Comment ID"),
        status: z.enum(["approved", "hold", "spam", "trash"]).describe("New status"),
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wp<any>(`/comments/${a.id}`, { method: "POST", body: { status: a.status } });
        return { id: r.json.id, status: r.json.status };
      },
    }),

    /* ── WooCommerce ── */

    tool({
      name: "wc_list_products",
      title: "List store products",
      description: "Search WooCommerce products (price, stock, status). Use for catalog questions.",
      connector: "wordpress",
      level: "read",
      input: {
        search: z.string().optional().describe("Search text (name/SKU)"),
        status: z.enum(["publish", "draft", "pending", "private", "any"]).optional().describe("Default any"),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional().describe("Stock filter"),
        category: z.number().int().optional().describe("Category ID"),
        per_page: perPage,
        page,
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wc<any[]>("/products", {
          query: { search: a.search, status: a.status ?? "any", stock_status: a.stock_status, category: a.category, per_page: clampInt(a.per_page, 1, 50, 10), page: a.page ?? 1 },
        });
        return { ...pageMeta(r.headers), items: (r.json ?? []).map(summarizeProduct) };
      },
    }),

    tool({
      name: "wc_get_product",
      title: "Get product details",
      description: "Full product details including description, attributes and variations count.",
      connector: "wordpress",
      level: "read",
      input: { id: z.number().int().describe("Product ID") },
      openWorld: true,
      handler: async (a) => {
        const p = (await client.wc<any>(`/products/${a.id}`)).json;
        return {
          ...summarizeProduct(p),
          short_description: stripHtml(p.short_description),
          description: truncate(stripHtml(p.description), 6000),
          attributes: (p.attributes ?? []).map((x: any) => ({ name: x.name, options: x.options })),
          images: (p.images ?? []).map((i: any) => i.src),
          variations: p.variations?.length ?? 0,
          weight: p.weight || undefined,
        };
      },
    }),

    tool({
      name: "wc_list_categories",
      title: "List product categories",
      description: "WooCommerce product categories with IDs.",
      connector: "wordpress",
      level: "read",
      input: { search: z.string().optional().describe("Search text"), per_page: perPage },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wc<any[]>("/products/categories", { query: { search: a.search, per_page: clampInt(a.per_page, 1, 50, 30) } });
        return (r.json ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, parent: c.parent, count: c.count }));
      },
    }),

    tool({
      name: "wc_create_product",
      title: "Create a draft product",
      description: "Create a simple product as DRAFT. Publish later with wc_update_product (status=publish).",
      connector: "wordpress",
      level: "write",
      input: {
        name: z.string().min(1).describe("Product name"),
        regular_price: z.string().describe("Price as digits only, in the store currency"),
        description: z.string().optional().describe("Long description (HTML ok)"),
        short_description: z.string().optional().describe("Short description"),
        sku: z.string().optional().describe("SKU"),
        stock_quantity: z.number().int().optional().describe("Stock quantity (enables stock management)"),
        category_ids: z.string().optional().describe("Comma-separated category IDs"),
        image_urls: z.string().optional().describe("Comma-separated public image URLs (WooCommerce downloads them)"),
      },
      openWorld: true,
      handler: async (a) => {
        const body: Record<string, unknown> = {
          name: a.name,
          type: "simple",
          status: "draft",
          regular_price: a.regular_price,
          description: a.description,
          short_description: a.short_description,
          sku: a.sku,
        };
        if (a.stock_quantity !== undefined) Object.assign(body, { manage_stock: true, stock_quantity: a.stock_quantity });
        if (a.category_ids) body.categories = a.category_ids.split(",").map((id) => ({ id: Number(id.trim()) }));
        if (a.image_urls) {
          const urls = a.image_urls.split(",").map((u) => u.trim()).filter(Boolean);
          for (const u of urls) await assertPublicUrl(u);
          body.images = urls.map((src) => ({ src }));
        }
        const p = (await client.wc<any>("/products", { method: "POST", body, timeoutMs: 60_000 })).json;
        return { created: summarizeProduct(p), edit_url: `${cfg.url}/wp-admin/post.php?post=${p.id}&action=edit` };
      },
    }),

    tool({
      name: "wc_update_product",
      title: "Update product price/stock/status",
      description:
        "Change price, sale price, stock, status or text fields of one product. Always previews the before/after and needs user confirmation.",
      connector: "wordpress",
      level: "write",
      input: {
        id: z.number().int().describe("Product ID"),
        regular_price: z.string().optional().describe("New regular price (digits)"),
        sale_price: z.string().optional().describe("New sale price (digits); empty string removes the sale"),
        stock_quantity: z.number().int().optional().describe("New stock quantity"),
        stock_status: z.enum(["instock", "outofstock", "onbackorder"]).optional().describe("Stock status"),
        status: z.enum(["publish", "draft", "private"]).optional().describe("Visibility status"),
        name: z.string().optional().describe("New name"),
        short_description: z.string().optional().describe("New short description"),
        description: z.string().optional().describe("New description"),
      },
      confirm: true,
      preview: async (a) => {
        const cur = (await client.wc<any>(`/products/${a.id}`)).json;
        const { id: _id, ...changes } = a;
        const before: Record<string, unknown> = {};
        for (const k of Object.keys(changes)) before[k] = cur[k];
        return { product: `${cur.name} (#${cur.id})`, before, after: changes };
      },
      openWorld: true,
      handler: async (a) => {
        const { id, stock_quantity, ...rest } = a;
        const body: Record<string, unknown> = { ...rest };
        if (stock_quantity !== undefined) Object.assign(body, { manage_stock: true, stock_quantity });
        const p = (await client.wc<any>(`/products/${id}`, { method: "PUT", body })).json;
        return { updated: summarizeProduct(p) };
      },
    }),

    tool({
      name: "wc_list_orders",
      title: "List orders",
      description: "List WooCommerce orders (no customer contact details). Filter by status or date range.",
      connector: "wordpress",
      level: "read",
      input: {
        status: z.enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]).optional().describe("Default any"),
        after: z.string().optional().describe("ISO date-time lower bound, e.g. 2026-11-01T00:00:00"),
        before: z.string().optional().describe("ISO date-time upper bound"),
        search: z.string().optional().describe("Search text (order number, customer name)"),
        per_page: perPage,
        page,
      },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wc<any[]>("/orders", {
          query: { status: a.status ?? "any", after: a.after, before: a.before, search: a.search, per_page: clampInt(a.per_page, 1, 50, 10), page: a.page ?? 1 },
        });
        return { ...pageMeta(r.headers), items: (r.json ?? []).map((o) => summarizeOrder(o, false)) };
      },
    }),

    tool({
      name: "wc_get_order",
      title: "Get order with customer details",
      description: "Full order including customer name, phone, email and shipping address. Contains personal data — handle with care.",
      connector: "wordpress",
      level: "write",
      input: { id: z.number().int().describe("Order ID") },
      openWorld: true,
      handler: async (a) => summarizeOrder((await client.wc<any>(`/orders/${a.id}`)).json, true),
    }),

    tool({
      name: "wc_update_order_status",
      title: "Change order status",
      description: "Set an order status (e.g. processing → completed) and optionally add a private note. Needs confirmation.",
      connector: "wordpress",
      level: "write",
      input: {
        id: z.number().int().describe("Order ID"),
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled"]).describe("New status"),
        note: z.string().optional().describe("Private note to add to the order"),
      },
      confirm: true,
      preview: async (a) => {
        const cur = (await client.wc<any>(`/orders/${a.id}`)).json;
        return { order: `#${cur.number}`, total: cur.total, from: cur.status, to: a.status, note: a.note, warning: "Status changes may email the customer." };
      },
      openWorld: true,
      handler: async (a) => {
        const o = (await client.wc<any>(`/orders/${a.id}`, { method: "PUT", body: { status: a.status } })).json;
        if (a.note) await client.wc(`/orders/${a.id}/notes`, { method: "POST", body: { note: a.note, customer_note: false } });
        return summarizeOrder(o, false);
      },
    }),

    tool({
      name: "wc_sales_report",
      title: "Sales report",
      description: "Sales totals for a date range plus top-selling products.",
      connector: "wordpress",
      level: "read",
      input: {
        date_min: z.string().describe("Start date YYYY-MM-DD"),
        date_max: z.string().describe("End date YYYY-MM-DD"),
      },
      openWorld: true,
      handler: async (a) => {
        const [sales, top] = await Promise.all([
          client.wc<any[]>("/reports/sales", { query: { date_min: a.date_min, date_max: a.date_max } }),
          client.wc<any[]>("/reports/top_sellers", { query: { date_min: a.date_min, date_max: a.date_max } }).catch(() => ({ json: [] as any[] })),
        ]);
        const s = sales.json?.[0] ?? {};
        return {
          range: `${a.date_min} → ${a.date_max}`,
          total_sales: s.total_sales,
          net_sales: s.net_sales,
          orders: s.total_orders,
          items_sold: s.total_items,
          average_sales: s.average_sales,
          total_discount: s.total_discount,
          total_shipping: s.total_shipping,
          top_sellers: (top.json ?? []).slice(0, 10).map((t: any) => ({ product_id: t.product_id, name: t.name, quantity: t.quantity })),
        };
      },
    }),

    tool({
      name: "wc_list_coupons",
      title: "List coupons",
      description: "List discount coupons.",
      connector: "wordpress",
      level: "read",
      input: { search: z.string().optional().describe("Search by code"), per_page: perPage },
      openWorld: true,
      handler: async (a) => {
        const r = await client.wc<any[]>("/coupons", { query: { search: a.search, per_page: clampInt(a.per_page, 1, 50, 20) } });
        return (r.json ?? []).map((c) => ({ id: c.id, code: c.code, type: c.discount_type, amount: c.amount, used: c.usage_count, limit: c.usage_limit, expires: c.date_expires }));
      },
    }),

    tool({
      name: "wc_create_coupon",
      title: "Create a coupon",
      description: "Create a discount coupon. Needs confirmation.",
      connector: "wordpress",
      level: "write",
      input: {
        code: z.string().min(3).describe("Coupon code"),
        discount_type: z.enum(["percent", "fixed_cart", "fixed_product"]).describe("percent, fixed_cart or fixed_product"),
        amount: z.string().describe("Discount amount (digits)"),
        expires: z.string().optional().describe("Expiry date YYYY-MM-DD"),
        usage_limit: z.number().int().optional().describe("Total usage limit"),
        minimum_amount: z.string().optional().describe("Minimum cart total"),
      },
      confirm: true,
      openWorld: true,
      handler: async (a) => {
        const c = (
          await client.wc<any>("/coupons", {
            method: "POST",
            body: { code: a.code, discount_type: a.discount_type, amount: a.amount, date_expires: a.expires ? `${a.expires}T23:59:59` : undefined, usage_limit: a.usage_limit, minimum_amount: a.minimum_amount },
          })
        ).json;
        return { id: c.id, code: c.code, type: c.discount_type, amount: c.amount };
      },
    }),

    /* ── escape hatches (admin only) ── */

    tool({
      name: "wp_rest_get",
      title: "Raw REST GET (admin)",
      description: "GET any wp-json route (e.g. /wp/v2/users, /wc/v3/customers). Admin only; may return personal data.",
      connector: "wordpress",
      level: "admin",
      input: {
        route: z.string().describe("Route starting with /, e.g. /wc/v3/customers"),
        query_json: z.string().optional().describe('Query parameters as a JSON string, e.g. {"per_page":5}'),
      },
      openWorld: true,
      handler: async (a) => {
        const q = parseJsonArg<Record<string, string>>(a.query_json, "query_json");
        const r = await client.raw(a.route, { query: q });
        return r.json ?? r.text;
      },
    }),

    tool({
      name: "wp_rest_write",
      title: "Raw REST write (admin)",
      description: "POST/PUT/DELETE against any wp-json route. Admin only; needs confirmation.",
      connector: "wordpress",
      level: "admin",
      input: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
        route: z.string().describe("Route starting with /"),
        body_json: z.string().optional().describe("Request body as a JSON string"),
      },
      confirm: true,
      destructive: true,
      openWorld: true,
      handler: async (a) => {
        const r = await client.raw(a.route, { method: a.method, body: parseJsonArg(a.body_json, "body_json") });
        return r.json ?? r.text;
      },
    }),
  ];

  return {
    id: "wordpress",
    title: "irancamping.com (WordPress + WooCommerce)",
    summary: "فروشگاه و سایت اصلی ایران کمپینگ — محتوا، محصولات، سفارش‌ها و گزارش فروش",
    tools,
    async health() {
      const r = await client.root();
      const wc = client.hasWc ? await client.wc("/products", { query: { per_page: 1 } }).then(() => "WooCommerce OK", (e) => `WooCommerce error: ${e.message}`) : "WooCommerce keys missing";
      const wp = client.hasWp ? await client.wp("/users/me").then(() => "WP auth OK", (e) => `WP auth error: ${e.message}`) : "WP credentials missing";
      const ok = !!r.json && !wc.includes("error") && !wp.includes("error");
      return { ok, detail: `${r.json?.name ?? cfg.url}; ${wp}; ${wc}` };
    },
  };
}
