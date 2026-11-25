// Tiny stdio MCP server used by tests: tools echo, add, and env (shows one env var, proving config env reaches the child).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "echo-fixture", version: "1.0.0" });
s.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
s.registerTool("add", { description: "Add numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
s.registerTool("whoami", { description: "Env check", inputSchema: {} }, async () => ({ content: [{ type: "text", text: `TEST_FLAG=${process.env.TEST_FLAG ?? ""}` }] }));
await s.connect(new StdioServerTransport());
