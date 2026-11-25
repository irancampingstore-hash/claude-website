import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentConfig {
  hubUrl: string;
  token: string;
  name: string;
  /** Folders the agent may read (and write, if writeRoots is empty it falls back to none). */
  roots: string[];
  writeRoots: string[];
  allowExec: boolean;
  /** key → command line, e.g. { vscode: "code", chrome: "C:\\Program Files\\...\\chrome.exe" } */
  apps: Record<string, string>;
  /** provider key → base URL. ollama: http://127.0.0.1:11434 ; openai-compatible: http://127.0.0.1:1234/v1 */
  aiProviders: Record<string, string>;
}

const splitList = (v?: string) => (v ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  let file: Partial<AgentConfig> = {};
  const p = resolve(env.PC_AGENT_CONFIG ?? "./agent.config.json");
  if (existsSync(p)) file = JSON.parse(readFileSync(p, "utf8")) as Partial<AgentConfig>;

  const providers: Record<string, string> = { ...(file.aiProviders ?? {}) };
  for (const pair of splitList(env.AI_PROVIDERS)) {
    const i = pair.indexOf("=");
    if (i > 0) providers[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (!Object.keys(providers).length) {
    providers.ollama = "http://127.0.0.1:11434";
    providers.lmstudio = "http://127.0.0.1:1234/v1";
  }

  const cfg: AgentConfig = {
    hubUrl: file.hubUrl ?? env.HUB_URL ?? "",
    token: file.token ?? env.PC_AGENT_TOKEN ?? "",
    name: file.name ?? env.PC_NAME ?? "main",
    roots: file.roots ?? splitList(env.PC_ALLOWED_ROOTS),
    writeRoots: file.writeRoots ?? splitList(env.PC_WRITE_ROOTS),
    allowExec: file.allowExec ?? (env.PC_ALLOW_EXEC === "1" || env.PC_ALLOW_EXEC === "true"),
    apps: file.apps ?? {},
    aiProviders: providers,
  };
  if (!cfg.hubUrl) throw new Error("HUB_URL is required, e.g. wss://mcp.iranoutdoor.com/agent/ws");
  if (!cfg.token) throw new Error("PC_AGENT_TOKEN is required (same value as on the hub).");
  return cfg;
}
