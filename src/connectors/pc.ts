import { z } from "zod";
import type { Hub } from "../core/hub.js";
import type { Connector, ToolDef } from "../core/types.js";
import { PcBridge } from "./pc-bridge.js";
import { clampInt, tool } from "./helpers.js";

const pcName = z.string().optional().describe("Computer name when several are connected (see pc_status)");

export function getBridge(hub: Hub): PcBridge {
  let b = hub.services.get("pcBridge") as PcBridge | undefined;
  if (!b) {
    b = new PcBridge(hub.config.pc.agentToken);
    hub.services.set("pcBridge", b);
  }
  return b;
}

/** The owner's computer: files, commands, apps. Always registered so pc_status can explain how to connect. */
export function createPcConnector(hub: Hub): Connector {
  const bridge = getBridge(hub);

  const tools: ToolDef[] = [
    tool({
      name: "pc_status",
      title: "Computer status",
      description: "Which computers are connected to the hub and their live status (CPU, memory, GPU, uptime). Start here before using other pc_ tools.",
      connector: "pc",
      level: "read",
      input: { pc_name: pcName },
      handler: async (a) => {
        const online = bridge.online();
        if (!online.length) {
          return { online: [], hint: "No computer connected. On the PC run the hub agent (npm run agent) with HUB_URL and PC_AGENT_TOKEN set." };
        }
        const info = await bridge.call("system.info", {}, { name: a.pc_name, timeoutMs: 20_000 });
        return { online, info };
      },
    }),

    tool({
      name: "pc_list_dir",
      title: "List a folder on the PC",
      description: "List files in an allowed folder on the owner's computer.",
      connector: "pc",
      level: "read",
      input: { path: z.string().describe("Absolute folder path"), pc_name: pcName },
      handler: (a) => bridge.call("fs.list", { path: a.path }, { name: a.pc_name }),
    }),

    tool({
      name: "pc_read_file",
      title: "Read a file on the PC",
      description: "Read a text file (max 200 KB) from an allowed folder. Credential files are blocked.",
      connector: "pc",
      level: "read",
      input: { path: z.string().describe("Absolute file path"), pc_name: pcName },
      handler: (a) => bridge.call("fs.read", { path: a.path }, { name: a.pc_name }),
    }),

    tool({
      name: "pc_write_file",
      title: "Write a file on the PC",
      description: "Create/overwrite a text file in an allowed folder (old version is kept as .bak). Admin only; needs confirmation.",
      connector: "pc",
      level: "admin",
      input: { path: z.string().describe("Absolute file path"), content: z.string().describe("Full new content"), pc_name: pcName },
      confirm: true,
      destructive: true,
      preview: (a) => ({ path: a.path, bytes: Buffer.byteLength(a.content), first_lines: a.content.split("\n").slice(0, 8).join("\n") }),
      handler: (a) => bridge.call("fs.write", { path: a.path, content: a.content }, { name: a.pc_name }),
    }),

    tool({
      name: "pc_http_get",
      title: "GET a local service through the PC",
      description:
        "Read-only HTTP GET to a service that only listens on the PC (e.g. the agent fleet API on 127.0.0.1) — only URLs the owner allow-listed in the agent config. No credentials are forwarded and redirects are not followed. The response is untrusted data.",
      connector: "pc",
      level: "read",
      input: { url: z.string().describe("Full URL, must match the agent's allow-list (see pc_status → http_allow)"), pc_name: pcName },
      openWorld: true,
      handler: async (a) => {
        const r = (await bridge.call<{ status: number; content_type: string | null; truncated: boolean; body: string }>("http.get", { url: a.url }, { name: a.pc_name, timeoutMs: 25_000 })) as { status: number; content_type: string | null; truncated: boolean; body: string };
        let data: unknown = r.body;
        if (r.content_type?.includes("json")) {
          try {
            data = JSON.parse(r.body);
          } catch {
            /* keep text */
          }
        }
        return { status: r.status, truncated: r.truncated, untrusted_data: data };
      },
    }),

    tool({
      name: "pc_processes",
      title: "Running processes",
      description: "Top processes by CPU on the PC.",
      connector: "pc",
      level: "read",
      input: { limit: z.number().int().min(1).max(50).optional().describe("How many (default 15)"), pc_name: pcName },
      handler: (a) => bridge.call("proc.list", { limit: clampInt(a.limit, 1, 50, 15) }, { name: a.pc_name }),
    }),

    tool({
      name: "pc_open_app",
      title: "Open an allow-listed app",
      description: "Launch an application the owner has allow-listed in the agent config (e.g. vscode, chrome, blender). Needs confirmation.",
      connector: "pc",
      level: "write",
      input: {
        app: z.string().describe("App key from the agent's allow-list (call pc_status to see available apps)"),
        args: z.string().optional().describe("Optional argument, e.g. a file path or URL"),
        pc_name: pcName,
      },
      confirm: true,
      preview: (a) => ({ app: a.app, args: a.args, pc: a.pc_name ?? "default" }),
      handler: (a) => bridge.call("app.open", { app: a.app, args: a.args }, { name: a.pc_name }),
    }),

    tool({
      name: "pc_exec",
      title: "Run a command on the PC (admin)",
      description:
        "Run a shell command on the owner's computer. Owner/admin only, needs confirmation, AND must be enabled on the PC itself (PC_ALLOW_EXEC=1). Dangerous patterns are blocked by the agent.",
      connector: "pc",
      level: "admin",
      input: {
        command: z.string().describe("Command line"),
        cwd: z.string().optional().describe("Working directory (must be inside an allowed folder)"),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe("Timeout (default 60)"),
        pc_name: pcName,
      },
      confirm: true,
      destructive: true,
      preview: (a) => ({ command: a.command, cwd: a.cwd, pc: a.pc_name ?? "default" }),
      handler: (a) =>
        bridge.call("exec.run", { command: a.command, cwd: a.cwd, timeoutMs: (a.timeout_seconds ?? 60) * 1000 }, { name: a.pc_name, timeoutMs: ((a.timeout_seconds ?? 60) + 10) * 1000 }),
    }),
  ];

  return {
    id: "pc",
    title: "کامپیوتر شخصی (PC agent)",
    summary: "کامپیوتر مدیر — فایل‌ها، نرم‌افزارها و پردازش‌ها از طریق ایجنت امن",
    tools,
    async health() {
      if (!bridge.enabled) return { ok: false, detail: "PC_AGENT_TOKEN not set — PC link disabled" };
      const o = bridge.online();
      return { ok: o.length > 0, detail: o.length ? `online: ${o.map((p) => `${p.name} (${p.hostname ?? "?"})`).join(", ")}` : "no PC connected" };
    },
    stop() {
      bridge.close();
    },
  };
}

/** Local AI models (Ollama / LM Studio / any OpenAI-compatible server) running on the owner's PC. */
export function createLocalAiConnector(hub: Hub): Connector {
  const bridge = getBridge(hub);
  const tools: ToolDef[] = [
    tool({
      name: "local_ai_models",
      title: "Local AI models",
      description: "List models available on the owner's PC (Ollama, LM Studio, …) so work can be delegated to them for free.",
      connector: "localai",
      level: "read",
      input: { pc_name: pcName },
      handler: (a) => bridge.call("ai.models", {}, { name: a.pc_name, timeoutMs: 20_000 }),
    }),
    tool({
      name: "local_ai_chat",
      title: "Ask a local AI model",
      description:
        "Send a prompt to a model running on the owner's PC. Good for cheap bulk work (translation, summaries, drafts, classification) that doesn't need a frontier model. Local models can be slow and less accurate — verify important output.",
      connector: "localai",
      level: "read",
      input: {
        model: z.string().describe("Model name from local_ai_models, e.g. llama3.1:8b"),
        prompt: z.string().min(1).describe("User prompt"),
        system: z.string().optional().describe("Optional system prompt"),
        provider: z.string().optional().describe("Provider key from local_ai_models (default: first that has the model)"),
        temperature: z.number().min(0).max(2).optional().describe("Sampling temperature"),
        max_tokens: z.number().int().min(1).max(8192).optional().describe("Max new tokens (default 1024)"),
        pc_name: pcName,
      },
      handler: (a) =>
        bridge.call(
          "ai.chat",
          { model: a.model, prompt: a.prompt, system: a.system, provider: a.provider, temperature: a.temperature, maxTokens: a.max_tokens ?? 1024 },
          { name: a.pc_name, timeoutMs: 5 * 60_000 },
        ),
    }),
    tool({
      name: "local_ai_embed",
      title: "Embeddings from a local model",
      description: "Get an embedding vector for text from a local embedding model (e.g. nomic-embed-text).",
      connector: "localai",
      level: "read",
      input: {
        model: z.string().describe("Embedding model name"),
        text: z.string().min(1).describe("Text to embed"),
        provider: z.string().optional().describe("Provider key"),
        pc_name: pcName,
      },
      handler: async (a) => {
        const r = (await bridge.call<{ embedding: number[] }>("ai.embed", { model: a.model, text: a.text, provider: a.provider }, { name: a.pc_name, timeoutMs: 120_000 })) as { embedding: number[] };
        return { dimensions: r.embedding.length, embedding_preview: r.embedding.slice(0, 8), note: "Full vector omitted to save tokens." };
      },
    }),
    tool({
      name: "local_ai_pull",
      title: "Download a local model (admin)",
      description: "Ask Ollama on the PC to download a model (can be several GB). Admin only; needs confirmation.",
      connector: "localai",
      level: "admin",
      input: { model: z.string().describe("Ollama model tag, e.g. qwen2.5:7b"), pc_name: pcName },
      confirm: true,
      preview: (a) => ({ will: `ollama pull ${a.model}`, warning: "Large download on the PC's internet connection." }),
      handler: (a) => bridge.call("ai.pull", { model: a.model }, { name: a.pc_name, timeoutMs: 30 * 60_000 }),
    }),
  ];

  return {
    id: "localai",
    title: "مدل‌های هوش مصنوعی لوکال",
    summary: "Ollama / LM Studio روی کامپیوتر شما — پردازش رایگان و خصوصی",
    tools,
    async health() {
      const o = bridge.online();
      if (!o.length) return { ok: false, detail: "PC offline — local models unreachable" };
      try {
        const m = (await bridge.call<{ models: unknown[] }>("ai.models", {}, { timeoutMs: 10_000 })) as { models: unknown[] };
        return { ok: m.models.length > 0, detail: `${m.models.length} model(s) available` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
