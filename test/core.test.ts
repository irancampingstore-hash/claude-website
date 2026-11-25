import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Confirmer, RateLimiter } from "../src/core/guards.js";
import { decrypt, encrypt } from "../src/core/crypto.js";
import { redactDeep, scrub } from "../src/util/text.js";
import { isPrivateAddress } from "../src/util/ssrf.js";
import { levelAtLeast } from "../src/core/types.js";
import { makeHub, TEST_SECRET } from "./helpers.js";

describe("confirmation tokens", () => {
  const c = new Confirmer(TEST_SECRET, 1000);
  it("binds to user, tool and exact arguments", () => {
    const args = { id: 1, price: "100" };
    const t = c.issue("u1", "wc_update_product", args, 0);
    expect(c.verify(t, "u1", "wc_update_product", { ...args, confirm_token: t }, 500)).toBe(true);
    expect(c.verify(t, "u2", "wc_update_product", args, 500)).toBe(false);
    expect(c.verify(t, "u1", "other_tool", args, 500)).toBe(false);
    expect(c.verify(t, "u1", "wc_update_product", { id: 1, price: "1" }, 500)).toBe(false);
    expect(c.verify(t, "u1", "wc_update_product", args, 2000)).toBe(false);
    expect(c.verify(t + "x", "u1", "wc_update_product", args, 500)).toBe(false);
  });
});

describe("misc guards", () => {
  it("rate limiter", () => {
    const r = new RateLimiter(2, 1000);
    expect([r.allow("a", 0), r.allow("a", 1), r.allow("a", 2), r.allow("a", 1500)]).toEqual([true, true, false, true]);
  });
  it("encryption round-trips and detects tampering", () => {
    const e = encrypt(TEST_SECRET, "token-123");
    expect(decrypt(TEST_SECRET, e)).toBe("token-123");
    expect(() => decrypt(TEST_SECRET + "x", e)).toThrow();
  });
  it("redacts credentials", () => {
    expect(redactDeep({ a: 1, app_password: "x", nested: { Authorization: "y" } })).toEqual({ a: 1, app_password: "[redacted]", nested: { Authorization: "[redacted]" } });
    expect(scrub("pw=secret-value-1", ["secret-value-1"])).toBe("pw=[redacted]");
  });
  it("private address detection", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "93.184.216.34"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("levels", () => {
    expect(levelAtLeast("write", "read")).toBe(true);
    expect(levelAtLeast("read", "write")).toBe(false);
    expect(levelAtLeast(undefined, "read")).toBe(false);
  });
});

describe("public URL guard", () => {
  it("refuses a plain-http public URL with a clear message, accepts https and localhost", async () => {
    const { createApp } = await import("../src/app.js");
    expect(() => createApp(makeHub({ HUB_PUBLIC_URL: "http://hub.example.com" }).hub)).toThrow(/must start with https:\/\//);
    expect(() => createApp(makeHub({ HUB_PUBLIC_URL: "https://hub.example.com" }).hub)).not.toThrow();
    expect(() => createApp(makeHub({ HUB_PUBLIC_URL: "http://localhost:8787" }).hub)).not.toThrow();
  });
});

describe("users and roles", () => {
  it("API key auth, role presets and overrides", () => {
    const { hub } = makeHub();
    const { user, apiKey } = hub.users.create("Ali", "content", { vps: "read" });
    expect(hub.users.authenticateApiKey(apiKey)?.id).toBe(user.id);
    expect(hub.users.authenticateApiKey(apiKey + "x")).toBeUndefined();
    expect(user.grants.vps).toBe("read");
    expect(user.grants.wordpress).toBe("write");
    expect(user.grants.pc).toBeUndefined();
    hub.users.setDisabled("Ali", true);
    expect(hub.users.authenticateApiKey(apiKey)).toBeUndefined();
    const rotated = hub.users.rotateKey("Ali");
    hub.users.setDisabled("Ali", false);
    expect(hub.users.authenticateApiKey(apiKey)).toBeUndefined();
    expect(hub.users.authenticateApiKey(rotated.apiKey)).toBeDefined();
  });
});

describe("tool schemas stay portable (Claude + ChatGPT + Gemini)", () => {
  it("no unions, refs or free-form objects in any tool input", () => {
    const { hub } = makeHub({ WP_URL: "https://example.com", IG_APP_ID: "1", IG_APP_SECRET: "s", VPS_MODE: "local" });
    const owner = hub.users.create("o", "owner").user;
    const server = hub.buildServer(owner);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server as any)._registeredTools as Record<string, { inputSchema?: unknown }>;
    expect(Object.keys(registered).length).toBeGreaterThan(60);
    for (const t of hub.toolsFor(owner)) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
      expect(t.description.length, t.name).toBeGreaterThan(10);
      const schema = JSON.stringify(z.toJSONSchema(z.object(t.input)));
      expect(schema, t.name).not.toMatch(/"(anyOf|oneOf|allOf|\$ref|patternProperties)"/);
      expect(schema, `${t.name} additionalProperties`).not.toMatch(/"additionalProperties":\{/);
      for (const [k, v] of Object.entries(t.input)) expect((v as { description?: string }).description, `${t.name}.${k} needs .describe()`).toBeTruthy();
    }
  });

  it("tool names are unique and every tool has a connector + level", () => {
    const { hub } = makeHub({ WP_URL: "https://example.com", IG_APP_ID: "1", IG_APP_SECRET: "s", VPS_MODE: "local" });
    const names = hub.allTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
