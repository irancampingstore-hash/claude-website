import { spawn, execFile } from "node:child_process";
import { copyFile, mkdir, readdir, realpath, stat, writeFile, open } from "node:fs/promises";
import { arch, cpus, freemem, homedir, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkAdminCommand, isSensitivePath } from "../connectors/policy.js";
import type { AgentConfig } from "./config.js";

const execFileP = promisify(execFile);
export const AGENT_VERSION = "0.1.0";
const MAX_READ = 200_000;
const MAX_OUT = 100_000;

type Handler = (params: any) => Promise<unknown>;

const isWin = platform() === "win32";
const norm = (p: string) => (isWin ? p.toLowerCase() : p);

function insideAny(path: string, roots: string[]): boolean {
  const p = norm(path);
  return roots.some((r) => {
    const root = norm(resolve(r));
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/** True if `url` is http(s) and starts with an allowed prefix on a path boundary (so /fleet does not allow /fleet-admin). */
export function urlAllowed(url: string, allow: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return allow.some((raw) => {
    let a: URL;
    try {
      a = new URL(raw);
    } catch {
      return false;
    }
    if (a.origin !== u.origin) return false;
    const ap = a.pathname.replace(/\/+$/, "");
    return ap === "" || u.pathname === ap || u.pathname.startsWith(`${ap}/`);
  });
}

function pickPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<any>((cur, key) => {
    if (cur === undefined || cur === null) return undefined;
    const m = key.match(/^([^[\]]+)\[(\d+)\]$/);
    return m ? cur[m[1]!]?.[Number(m[2])] : cur[key];
  }, obj);
}

export function createHandlers(cfg: AgentConfig): Record<string, Handler> {
  async function guardPath(raw: unknown, write = false, mustExist = true): Promise<string> {
    if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("Use an absolute path.");
    const roots = write ? cfg.writeRoots : cfg.roots;
    if (!roots.length) throw new Error(write ? "No write folders are enabled on this PC (PC_WRITE_ROOTS)." : "No folders are enabled on this PC (PC_ALLOWED_ROOTS).");
    const target = resolve(raw);
    if (!insideAny(target, roots)) throw new Error("That path is outside the folders enabled on this PC.");
    const real = mustExist ? await realpath(target) : resolve(await realpath(dirname(target)), target.slice(dirname(target).length + 1));
    const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))));
    if (!insideAny(real, realRoots)) throw new Error("Path resolves outside the enabled folders (link).");
    if (isSensitivePath(real) || isSensitivePath(target)) throw new Error("This file may contain credentials and is blocked.");
    return real;
  }

  const aiBase = (provider?: string, model?: string) => ({ provider, model });

  /** Call whichever provider has the model; Ollama native API for ollama, OpenAI-compatible for others. */
  async function pickProvider(provider: string | undefined, model: string): Promise<[string, string]> {
    if (provider) {
      const url = cfg.aiProviders[provider];
      if (!url) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(cfg.aiProviders).join(", ")}`);
      return [provider, url];
    }
    for (const [key, url] of Object.entries(cfg.aiProviders)) {
      const models = await listModels(key, url).catch(() => [] as string[]);
      if (models.includes(model)) return [key, url];
    }
    const first = Object.entries(cfg.aiProviders)[0];
    if (!first) throw new Error("No AI providers configured.");
    return first;
  }

  async function listModels(key: string, url: string): Promise<string[]> {
    if (key.startsWith("ollama")) {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ((await r.json()) as { models: Array<{ name: string }> }).models.map((m) => m.name);
    }
    const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
  }

  return {
    "system.info": async () => {
      let gpu: string | undefined;
      try {
        const { stdout } = await execFileP("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader"], { timeout: 5000 });
        gpu = stdout.trim();
      } catch {
        /* no NVIDIA GPU / driver */
      }
      const ai: Record<string, string> = {};
      for (const [k, u] of Object.entries(cfg.aiProviders)) {
        ai[k] = await listModels(k, u).then((m) => `up (${m.length} models)`, () => "down");
      }
      return {
        hostname: hostname(),
        os: `${platform()} ${release()} ${arch()}`,
        uptime_hours: Math.round((uptime() / 3600) * 10) / 10,
        cpu: { model: cpus()[0]?.model, cores: cpus().length, load_1m_15m: loadavg().slice(0, 3) },
        memory_gb: { total: +(totalmem() / 2 ** 30).toFixed(1), free: +(freemem() / 2 ** 30).toFixed(1) },
        gpu,
        home: homedir(),
        enabled_folders: cfg.roots,
        writable_folders: cfg.writeRoots,
        exec_enabled: cfg.allowExec,
        http_allow: cfg.httpAllow,
        apps: Object.keys(cfg.apps),
        ai_providers: ai,
      };
    },

    "fs.list": async ({ path }) => {
      const p = await guardPath(path);
      const entries = await readdir(p, { withFileTypes: true });
      const out = [];
      for (const d of entries.slice(0, 300)) {
        const st = await stat(resolve(p, d.name)).catch(() => undefined);
        out.push({ name: d.name, type: d.isDirectory() ? "dir" : "file", size: st?.size ?? 0, modified: st ? new Date(st.mtimeMs).toISOString() : undefined });
      }
      return { path: p, entries: out };
    },

    "fs.read": async ({ path }) => {
      const p = await guardPath(path);
      const st = await stat(p);
      if (!st.isFile()) throw new Error("Not a file.");
      const fh = await open(p, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
        await fh.read(buf, 0, buf.length, 0);
        if (buf.includes(0)) throw new Error("File looks binary.");
        return { path: p, size: st.size, truncated: st.size > MAX_READ, content: buf.toString("utf8") };
      } finally {
        await fh.close();
      }
    },

    "fs.write": async ({ path, content }) => {
      if (typeof content !== "string") throw new Error("content must be a string");
      if (Buffer.byteLength(content) > 1_000_000) throw new Error("Content larger than 1 MB.");
      const p = await guardPath(path, true, false);
      let backup: string | undefined;
      try {
        backup = `${p}.bak-${Date.now()}`;
        await copyFile(p, backup);
      } catch {
        backup = undefined;
      }
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
      return { written: p, bytes: Buffer.byteLength(content), backup };
    },

    "http.get": async ({ url, pick }) => {
      if (typeof url !== "string") throw new Error("url must be a string");
      if (!cfg.httpAllow.length) throw new Error("No local URLs are enabled on this PC (PC_HTTP_ALLOW / httpAllow).");
      if (!urlAllowed(url, cfg.httpAllow)) throw new Error(`That URL is not in this PC's allow-list. Allowed: ${cfg.httpAllow.join(", ")}`);
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" } });
      if (res.status >= 300 && res.status < 400) throw new Error(`Redirects are not followed (HTTP ${res.status}).`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (Array.isArray(pick) && pick.length) {
        // Return only the requested JSON fields (dotted paths, e.g. "totals" or "queues.Orchestrator.counts") — keeps big dashboards small.
        let json: unknown;
        try {
          json = JSON.parse(buf.toString("utf8"));
        } catch {
          throw new Error("pick was given but the response is not JSON.");
        }
        const picked: Record<string, unknown> = {};
        for (const p of pick.slice(0, 20).map(String)) {
          const v = pickPath(json, p);
          const text = JSON.stringify(v) ?? "null";
          picked[p] = text.length > 50_000 ? `[too large: ${text.length} chars — pick a narrower path]` : v;
        }
        return { status: res.status, content_type: res.headers.get("content-type"), truncated: false, body: JSON.stringify(picked), full_size_bytes: buf.length };
      }
      return { status: res.status, content_type: res.headers.get("content-type"), truncated: buf.length > MAX_READ, body: buf.subarray(0, MAX_READ).toString("utf8") };
    },

    "proc.list": async ({ limit }) => {
      const n = Math.min(Math.max(Number(limit) || 15, 1), 50);
      if (isWin) {
        const { stdout } = await execFileP("tasklist", ["/fo", "csv", "/nh"], { timeout: 10_000, maxBuffer: 5_000_000 });
        return { processes: stdout.split("\n").slice(0, n).map((l) => l.trim()).filter(Boolean) };
      }
      const { stdout } = await execFileP("ps", ["-eo", "pid,pcpu,pmem,comm", "--sort=-pcpu"], { timeout: 10_000 });
      return { processes: stdout.split("\n").slice(0, n + 1) };
    },

    "app.open": async ({ app, args }) => {
      const cmd = cfg.apps[String(app)];
      if (!cmd) throw new Error(`App "${app}" is not allow-listed. Available: ${Object.keys(cfg.apps).join(", ") || "(none)"}`);
      const argv = typeof args === "string" && args ? [args] : [];
      if (argv[0] && /[;&|<>`$\n\r]/.test(argv[0])) throw new Error("Argument contains forbidden characters.");
      const child = spawn(cmd, argv, { detached: true, stdio: "ignore", shell: false });
      child.on("error", () => undefined);
      child.unref();
      return { launched: String(app), args: argv };
    },

    "exec.run": async ({ command, cwd, timeoutMs }) => {
      if (!cfg.allowExec) throw new Error("Command execution is disabled on this PC. Set PC_ALLOW_EXEC=1 in the agent environment to enable it.");
      if (typeof command !== "string") throw new Error("command must be a string");
      const v = checkAdminCommand(command);
      if (!v.allowed) throw new Error(`Command rejected: ${v.reason}`);
      const dir = cwd ? await guardPath(cwd) : cfg.roots[0] ? resolve(cfg.roots[0]) : homedir();
      return new Promise((res) => {
        const child = spawn(command, { shell: true, cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const add = (cur: string, c: Buffer) => (cur.length >= MAX_OUT ? cur : cur + c.toString("utf8").slice(0, MAX_OUT - cur.length));
        child.stdout.on("data", (c: Buffer) => (stdout = add(stdout, c)));
        child.stderr.on("data", (c: Buffer) => (stderr = add(stderr, c)));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, Math.min(Number(timeoutMs) || 60_000, 600_000));
        child.on("close", (code) => {
          clearTimeout(timer);
          res({ exit_code: code, timed_out: timedOut || undefined, cwd: dir, stdout, stderr: stderr || undefined });
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          res({ exit_code: -1, stderr: String(e) });
        });
      });
    },

    "ai.models": async () => {
      const models: Array<{ provider: string; model: string }> = [];
      const errors: Record<string, string> = {};
      for (const [key, url] of Object.entries(cfg.aiProviders)) {
        try {
          for (const m of await listModels(key, url)) models.push({ provider: key, model: m });
        } catch (e) {
          errors[key] = e instanceof Error ? e.message : String(e);
        }
      }
      return { models, unavailable_providers: errors };
    },

    "ai.chat": async ({ model, prompt, system, provider, temperature, maxTokens }) => {
      const [key, url] = await pickProvider(provider, String(model));
      const messages = [...(system ? [{ role: "system", content: String(system) }] : []), { role: "user", content: String(prompt) }];
      if (key.startsWith("ollama")) {
        const r = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages, stream: false, options: { temperature, num_predict: maxTokens } }),
          signal: AbortSignal.timeout(280_000),
        });
        if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = (await r.json()) as { message?: { content: string }; eval_count?: number; total_duration?: number };
        return { ...aiBase(key, String(model)), reply: j.message?.content ?? "", tokens: j.eval_count, seconds: j.total_duration ? +(j.total_duration / 1e9).toFixed(1) : undefined };
      }
      const r = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
        signal: AbortSignal.timeout(280_000),
      });
      if (!r.ok) throw new Error(`${key} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number } };
      return { ...aiBase(key, String(model)), reply: j.choices?.[0]?.message?.content ?? "", tokens: j.usage?.completion_tokens };
    },

    "ai.embed": async ({ model, text, provider }) => {
      const [key, url] = await pickProvider(provider, String(model));
      if (key.startsWith("ollama")) {
        const r = await fetch(`${url}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: text }), signal: AbortSignal.timeout(110_000) });
        if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
        return { embedding: ((await r.json()) as { embeddings: number[][] }).embeddings[0] ?? [] };
      }
      const r = await fetch(`${url}/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: text }), signal: AbortSignal.timeout(110_000) });
      if (!r.ok) throw new Error(`${key} HTTP ${r.status}`);
      return { embedding: ((await r.json()) as { data: Array<{ embedding: number[] }> }).data[0]?.embedding ?? [] };
    },

    "ai.pull": async ({ model }) => {
      const url = Object.entries(cfg.aiProviders).find(([k]) => k.startsWith("ollama"))?.[1];
      if (!url) throw new Error("No Ollama provider configured.");
      const r = await fetch(`${url}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(29 * 60_000) });
      if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return await r.json();
    },
  };
}
