import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { attachWebSocket, createApp } from "./app.js";
import { createHub } from "./connectors/index.js";
import { assertSecret, loadConfig, loadEnvFileIfPresent } from "./core/config.js";

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const cfg = loadConfig();
  assertSecret(cfg);
  const hub = createHub(cfg);

  if (process.argv.includes("--stdio")) {
    // Local mode for Claude Desktop / Claude Code / Gemini CLI on the same machine. Logs go to stderr only.
    const name = process.env.HUB_STDIO_USER;
    const user = (name ? hub.users.list().find((u) => u.name === name) : hub.users.list().find((u) => u.role === "owner" && !u.disabled)) ?? undefined;
    if (!user) {
      console.error("No user for stdio mode. Create one first:  node dist/cli.js user add --name owner --role owner   (then set HUB_STDIO_USER)");
      process.exit(1);
    }
    await hub.start();
    const server = hub.buildServer(hub.users.byId(user.id)!, "stdio");
    await server.connect(new StdioServerTransport());
    console.error(`Iran Camping hub (stdio) ready for ${user.name} — ${hub.toolsFor(user).length} tools`);
    return;
  }

  const { app } = createApp(hub);
  const httpServer = createServer(app);
  attachWebSocket(httpServer, hub);
  await hub.start();
  httpServer.listen(cfg.port, () => {
    const users = hub.users.list().length;
    console.log(`Iran Camping hub listening on :${cfg.port}  (public: ${cfg.publicUrl})`);
    console.log(`Connectors: ${hub.connectors.map((c) => c.id).join(", ")} — ${hub.allTools().length} tools — ${users} user(s)`);
    if (!users) console.log("⚠ No users yet. Create the owner:  node dist/cli.js user add --name owner --role owner");
    if (!cfg.publicUrl.startsWith("https://") && !cfg.publicUrl.includes("localhost")) console.log("⚠ HUB_PUBLIC_URL is not https — Claude/ChatGPT connectors require HTTPS.");
  });

  const shutdown = async () => {
    httpServer.close();
    await hub.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
