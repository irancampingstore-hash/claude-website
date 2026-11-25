#!/usr/bin/env node
/**
 * READ-ONLY discovery of local AI agents / APIs → AGENT_API_REGISTRY.{json,md}, AGENT_INTEGRATION_MATRIX.md,
 * AGENT_CONNECTION_TEST_REPORT.md.   Run it ON the computer where the agents live (rahim PC). Needs Node >= 18.
 *
 *   node tools/discover-agents.mjs --roots "D:\ic-agents;D:\IranCamping-Intelligence-Core;D:\xampp\htdocs\ic-agents;D:\xampp\htdocs\claude" --out ./registry
 *
 * What it does:  GET-only probes of known local endpoints, a bounded scan of the given folders for config files,
 *                reads Windows/Linux listening ports (netstat/ss), checks whether watch files (e.g. PAUSED) exist.
 * What it never does: write outside --out, start/stop anything, send credentials, call mutating endpoints,
 *                copy secret VALUES (only variable/header NAMES and structure are recorded; long token-like strings are masked).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const roots = (arg("roots", arg("root", "")) || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
const outDir = resolve(arg("out", "./registry"));
const seedFile = arg("seed", join(here, "known-services.json"));
if (!roots.length) console.warn("Note: no --roots given, so no folders will be scanned (only the known local endpoints are probed).");
const noProbe = process.argv.includes("--no-probe");
const skipNetstat = process.argv.includes("--no-netstat");
const probeBase = arg("probe-base"); // test hook: rewrite http://127.0.0.1:PORT → this base

/* ───────── redaction ───────── */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|private|cookie|credential|bearer|session/i;
const TOKENISH = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+\S{8,}|(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{32,}={0,2})/g; // long token-like strings that contain a digit (URL paths and slugs are left alone)
/** Keep scheme+host+path only: drop credentials and query strings (where tokens usually hide). */
function cleanUrl(u) {
  try {
    const x = new URL(String(u));
    return `${x.protocol}//${x.host}${x.pathname}`;
  } catch {
    return maskStr(String(u));
  }
}
const maskStr = (s) => (typeof s === "string" ? s.replace(TOKENISH, "[masked]") : s);

/** Keep structure, drop secret values; env/headers become NAME lists. */
function sanitize(v, depth = 0) {
  if (depth > 5) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (/^(env|headers|environment)$/i.test(k) && val && typeof val === "object" && !Array.isArray(val)) o[`${k}_names`] = Object.keys(val);
      else o[k] = SECRET_KEY.test(k) && typeof val !== "object" ? "[redacted]" : sanitize(val, depth + 1);
    }
    return o;
  }
  return maskStr(v);
}

/* ───────── probes (GET only) ───────── */
async function probe(url, expect = [200]) {
  const target = probeBase ? url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, probeBase) : url;
  const t0 = Date.now();
  try {
    const r = await fetch(target, { method: "GET", signal: AbortSignal.timeout(Number(arg("probe-timeout-ms", 20000))), headers: { accept: "application/json" } });
    const text = (await r.text()).slice(0, 4000);
    let keys;
    try {
      const j = JSON.parse(text);
      keys = Array.isArray(j) ? `array(${j.length})` : Object.keys(j).slice(0, 12);
    } catch { /* not JSON */ }
    return { url, status: r.status, ok: expect.includes(r.status), ms: Date.now() - t0, content_type: r.headers.get("content-type"), json_keys: keys };
  } catch (e) {
    return { url, status: null, ok: false, ms: Date.now() - t0, error: e?.cause?.code ?? e?.name ?? String(e) };
  }
}

/** MCP initialize (JSON-RPC over HTTP) — a read-only handshake, no tool calls. */
async function mcpInitialize(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "discovery", version: "1" } } }),
      signal: AbortSignal.timeout(8000),
    });
    const text = (await r.text()).slice(0, 4000);
    return { url, status: r.status, ok: r.ok && /"result"/.test(text), ms: Date.now() - t0, server: (text.match(/"serverInfo":\{[^}]*\}/) ?? [])[0] };
  } catch (e) {
    return { url, status: null, ok: false, ms: Date.now() - t0, error: e?.cause?.code ?? e?.name ?? String(e) };
  }
}

/* ───────── file scan ───────── */
const WANTED = new Set([".mcp.json", "mcp.json", "claude_desktop_config.json", "agent_catalog.json", "barney-agent-manifest.json", "barney-status.json", "openapi.json", "openapi.yaml", "openapi.yml", "package.json", "pyproject.toml", "docker-compose.yml", "compose.yaml", "docker-compose.yaml", "agents.md", "claude.md", "masterplan.md", "handoff.md", "readme.md", "remote_access_policy.json"]);
const SKIP_DIR = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build", ".next", "vendor", "site-packages", "evidence", "logs", "cache"]);

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name.toLowerCase())) yield* walk(p, depth + 1);
    } else if (WANTED.has(e.name.toLowerCase())) yield p;
  }
}

function summarize(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  const size = statSync(path).size;
  const base = { file: path, size };
  if (size > 2_000_000) return { ...base, note: "skipped (large)" };
  const raw = readFileSync(path, "utf8");
  try {
    if (name === ".mcp.json" || name === "mcp.json" || name === "claude_desktop_config.json") {
      const j = JSON.parse(raw);
      const servers = j.mcpServers ?? j.servers ?? {};
      return { ...base, kind: "mcp-config", servers: Object.entries(servers).map(([n, s]) => ({ name: n, type: s.type ?? (s.url ? "http/sse" : "stdio"), url: s.url ? cleanUrl(s.url) : undefined, command: s.command ? String(s.command).split(/[\\/]/).pop() : undefined, env_names: s.env ? Object.keys(s.env) : [], header_names: s.headers ? Object.keys(s.headers) : [] })) };
    }
    if (name === "agent_catalog.json" || name === "barney-agent-manifest.json" || name === "barney-status.json" || name === "remote_access_policy.json") {
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : (j.agents ?? j.catalog ?? j.items ?? null);
      return { ...base, kind: "catalog", top_level_keys: Array.isArray(j) ? undefined : Object.keys(j).slice(0, 30), entries: Array.isArray(arr) ? arr.slice(0, 80).map((a) => sanitize(a)) : undefined, summary: Array.isArray(arr) ? undefined : sanitize(j) };
    }
    if (name === "package.json") {
      const j = JSON.parse(raw);
      return { ...base, kind: "node-package", name: j.name, version: j.version, bin: j.bin ? Object.keys(typeof j.bin === "string" ? { [j.name]: 1 } : j.bin) : [], scripts: Object.keys(j.scripts ?? {}), has_mcp_sdk: !!(j.dependencies?.["@modelcontextprotocol/sdk"] ?? j.devDependencies?.["@modelcontextprotocol/sdk"]), deps_hint: ["express", "fastify", "hono", "ws", "openai", "@anthropic-ai/sdk"].filter((d) => j.dependencies?.[d]) };
    }
    if (name === "openapi.json") {
      const j = JSON.parse(raw);
      return { ...base, kind: "openapi", title: j.info?.title, version: j.info?.version, endpoints: Object.entries(j.paths ?? {}).flatMap(([p, ops]) => Object.keys(ops).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)).map((m) => `${m.toUpperCase()} ${p}`)).slice(0, 100), security_schemes: Object.keys(j.components?.securitySchemes ?? {}) };
    }
  } catch (e) {
    return { ...base, kind: "unparsed", note: `parse error: ${e.message}` };
  }
  if (name === "pyproject.toml") return { ...base, kind: "python-project", name: (raw.match(/^name\s*=\s*"([^"]+)"/m) ?? [])[1], version: (raw.match(/^version\s*=\s*"([^"]+)"/m) ?? [])[1], mentions: ["fastapi", "flask", "mcp", "openai", "anthropic", "uvicorn"].filter((d) => new RegExp(d, "i").test(raw)) };
  if (/compose/.test(name)) return { ...base, kind: "compose", images: [...raw.matchAll(/image:\s*(\S+)/g)].map((m) => m[1]).slice(0, 30), ports: [...raw.matchAll(/-\s*["']?(\d{2,5}:\d{2,5})["']?/g)].map((m) => m[1]).slice(0, 30) };
  if (name.endsWith(".md")) return { ...base, kind: "doc", first_heading: (raw.match(/^#\s+(.+)$/m) ?? [])[1] };
  if (name.startsWith("openapi")) return { ...base, kind: "openapi-yaml", title: (raw.match(/^\s*title:\s*(.+)$/m) ?? [])[1] };
  return base;
}

/** pid -> process image name (read-only), so open ports can be tied to a program. */
async function processNames() {
  const map = new Map();
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileP("tasklist", ["/fo", "csv", "/nh"], { timeout: 10_000, maxBuffer: 5_000_000 });
      for (const l of stdout.split(/\r?\n/)) { const m = l.match(/^"([^"]+)","(\d+)"/); if (m) map.set(m[2], m[1]); }
    } else {
      const { stdout } = await execFileP("ps", ["-eo", "pid=,comm="], { timeout: 10_000, maxBuffer: 5_000_000 });
      for (const l of stdout.split("\n")) { const m = l.trim().match(/^(\d+)\s+(.+)$/); if (m) map.set(m[1], m[2]); }
    }
  } catch { /* optional */ }
  return map;
}

async function listeningPorts() {
  if (skipNetstat) return [];
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileP("netstat", ["-ano", "-p", "TCP"], { timeout: 10_000, maxBuffer: 5_000_000 });
      return stdout.split(/\r?\n/).filter((l) => /LISTENING/i.test(l)).map((l) => l.trim().split(/\s+/)).map((c) => ({ address: c[1], pid: c[4] }));
    }
    const { stdout } = await execFileP("ss", ["-ltnH"], { timeout: 10_000 });
    return stdout.split("\n").filter(Boolean).map((l) => ({ address: l.trim().split(/\s+/)[3] }));
  } catch {
    return [];
  }
}

/* ───────── main ───────── */
const seed = JSON.parse(readFileSync(seedFile, "utf8"));
const now = new Date().toISOString();
const report = { generated_at: now, probes: [], mcp_handshakes: [], files: [], watch: [], listening: [] };

const ports = await listeningPorts();
const names = skipNetstat ? new Map() : await processNames();
report.listening = ports.filter((p) => /^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::|\*):\d+$|:\d+$/.test(p.address)).map((p) => ({ ...p, port: Number(p.address.split(":").pop()), process: p.pid ? names.get(p.pid) : undefined })).sort((a, b) => a.port - b.port).slice(0, 200);

for (const root of roots) {
  if (!existsSync(root)) { report.files.push({ file: root, note: "folder not found" }); continue; }
  for (const f of walk(root)) {
    try { report.files.push(summarize(f)); } catch (e) { report.files.push({ file: f, note: `unreadable: ${e.message}` }); }
  }
}
for (const w of seed.watchFiles ?? []) report.watch.push({ path: w, exists: existsSync(w) });

const registry = [];
for (const s of seed.services) {
  const { probes = [], mcpInitialize: doMcp, ...entry } = s;
  const evidence = [];
  let status = "UNKNOWN";
  if (!noProbe) {
    for (const p of probes) {
      const r = await probe(s.base_url + p.path, p.expect ?? [200]);
      report.probes.push({ service: s.agent_id, ...r });
      evidence.push(`${r.ok ? "PASS" : "FAIL"} GET ${p.path} → ${r.status ?? r.error}`);
    }
    if (doMcp && s.base_url) {
      const r = await mcpInitialize(s.base_url);
      report.mcp_handshakes.push({ service: s.agent_id, ...r });
      evidence.push(`${r.ok ? "PASS" : "FAIL"} MCP initialize → ${r.status ?? r.error}`);
    }
  }
  const results = evidence.filter((e) => /^(PASS|FAIL)/.test(e));
  if (results.length) status = results.every((e) => e.startsWith("PASS")) ? "VERIFIED" : results.some((e) => e.startsWith("PASS")) ? "PARTIAL" : "UNREACHABLE";
  registry.push({ ...entry, permissions: entry.permissions ?? [], dependencies: entry.dependencies ?? [], verified_at: results.length ? now : null, evidence, status });
}

// services found in config files but not in the seed
const known = new Set(registry.map((r) => r.agent_id));
for (const f of report.files) {
  if (f.kind === "mcp-config") for (const s of f.servers) {
    const id = `mcp:${s.name}`;
    if (known.has(id)) continue;
    known.add(id);
    registry.push({ agent_id: id, project_owner: null, purpose: null, base_url: s.url ?? null, protocol: "MCP", transport: s.type, authentication_type: s.header_names.length || s.env_names.length ? "credentials via env/header (names only)" : null, credential_reference: [...s.env_names, ...s.header_names].join(", ") || null, openai_compatible: null, anthropic_compatible: null, mcp_compatible: true, health_endpoint: null, capabilities: [], permissions: [], dependencies: [], verified_at: null, evidence: [`declared in ${f.file}`], status: "UNKNOWN" });
  }
  if (f.kind === "catalog" && f.entries) for (const a of f.entries) {
    const id = String(a.id ?? a.agent_id ?? a.name ?? "").trim();
    if (!id || known.has(id) || known.has(`agent:${id}`)) continue;
    known.add(`agent:${id}`);
    registry.push({ agent_id: `agent:${id}`, project_owner: a.owner ?? null, purpose: a.purpose ?? a.description ?? null, base_url: a.api ?? a.url ?? a.endpoint ?? null, protocol: a.protocol ?? null, transport: a.runtime ?? a.transport ?? null, authentication_type: a.auth ?? a.authentication ?? null, credential_reference: null, openai_compatible: null, anthropic_compatible: null, mcp_compatible: null, health_endpoint: a.health ?? null, capabilities: a.tools ?? a.capabilities ?? [], permissions: a.permissions ?? [], dependencies: a.dependencies ?? [], verified_at: null, evidence: [`listed in ${f.file}`], status: "UNKNOWN" });
  }
}

/* ───────── outputs ───────── */
mkdirSync(outDir, { recursive: true });
// Markdown is written as plain ASCII punctuation so Windows PowerShell/Notepad never shows mojibake.
const ascii = (t) => t.replace(/\u2014/g, "-").replace(/\u2192/g, "->").replace(/\u2705/g, "PASS").replace(/\u274C/g, "FAIL");
const writeMd = (name, content) => writeFileSync(join(outDir, name), ascii(content));
const yn = (v) => (v === true ? "yes" : v === false ? "no" : "UNKNOWN");
writeFileSync(join(outDir, "AGENT_API_REGISTRY.json"), JSON.stringify({ revision: "R01", generated_at: now, services: registry }, null, 2));
writeMd("AGENT_API_REGISTRY.md", `# Agent API Registry (generated ${now})\n\nSecret values are never recorded; only variable/header NAMES. Status is VERIFIED only with probe evidence.\n\n` + registry.map((r) => `## ${r.agent_id} — ${r.status}\n- purpose: ${r.purpose ?? "UNKNOWN"}\n- base_url: ${r.base_url ?? "UNKNOWN"} (${r.protocol ?? "UNKNOWN"}, ${r.transport ?? "UNKNOWN"})\n- auth: ${r.authentication_type ?? "UNKNOWN"}${r.credential_reference ? ` — ref: ${r.credential_reference}` : ""}\n- evidence: ${r.evidence.length ? r.evidence.join("; ") : "none yet"}\n`).join("\n"));
writeMd("AGENT_INTEGRATION_MATRIX.md", `# Integration matrix\n\n| service | OpenAI-compatible | Anthropic-compatible | MCP | auth | status |\n|---|---|---|---|---|---|\n` + registry.map((r) => `| ${r.agent_id} | ${yn(r.openai_compatible)} | ${yn(r.anthropic_compatible)} | ${yn(r.mcp_compatible)} | ${r.authentication_type ?? "UNKNOWN"} | ${r.status} |`).join("\n") + "\n");
writeMd("AGENT_CONNECTION_TEST_REPORT.md", `# Connection test report (${now})\n\nRead-only: GET probes and MCP initialize handshakes only.\n\n## Probes\n` + (report.probes.map((p) => `- ${p.ok ? "✅" : "❌"} ${p.service}: GET ${p.url} → ${p.status ?? p.error} (${p.ms} ms)${p.json_keys ? ` keys=${JSON.stringify(p.json_keys)}` : ""}`).join("\n") || "- (probes skipped)") + `\n\n## MCP handshakes\n` + (report.mcp_handshakes.map((p) => `- ${p.ok ? "✅" : "❌"} ${p.service}: ${p.status ?? p.error} ${p.server ?? ""}`).join("\n") || "- none") + `\n\n## Watch files\n` + (report.watch.map((w) => `- ${w.path}: ${w.exists ? "EXISTS" : "absent"} (not modified)`).join("\n") || "- none") + `\n\n## Listening TCP ports (${report.listening.length})\n` + report.listening.map((p) => `- ${p.address}${p.pid ? ` pid ${p.pid}` : ""}${p.process ? ` (${p.process})` : ""}`).join("\n") + `\n\n## Files found (${report.files.length})\n` + report.files.map((f) => `- ${f.file} — ${f.kind ?? f.note ?? ""}`).join("\n") + "\n");
writeFileSync(join(outDir, "discovery-details.json"), JSON.stringify(report, null, 2));

console.log(`Wrote registry to ${outDir}\n  services: ${registry.length}  (VERIFIED: ${registry.filter((r) => r.status === "VERIFIED").length}, UNKNOWN: ${registry.filter((r) => r.status === "UNKNOWN").length})\n  config files scanned: ${report.files.length}\nReview the files, then send me AGENT_API_REGISTRY.md + AGENT_CONNECTION_TEST_REPORT.md (they contain no secret values).`);
