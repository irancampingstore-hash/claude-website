import { connect as tlsConnect } from "node:tls";
import { posix } from "node:path";
import { z } from "zod";
import type { Hub } from "../core/hub.js";
import type { Connector, ToolDef } from "../core/types.js";
import { HubError, truncate } from "../util/text.js";
import { clampInt, tool } from "./helpers.js";
import { createExecutor, shellQuote, type Executor, type ExecResult } from "./executor.js";
import { checkAdminCommand, checkReadOnlyCommand, isInsideRoots, isSensitivePath } from "./policy.js";

function fmt(r: ExecResult) {
  return {
    exit_code: r.code,
    ...(r.timedOut ? { timed_out: true } : {}),
    stdout: r.stdout,
    ...(r.stderr ? { stderr: r.stderr } : {}),
    ...(r.truncated ? { truncated: true } : {}),
  };
}

async function tlsExpiry(host: string): Promise<{ valid_to?: string; days_left?: number; issuer?: string; error?: string }> {
  return new Promise((resolve) => {
    const sock = tlsConnect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert?.valid_to) return resolve({ error: "no certificate" });
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      resolve({ valid_to: cert.valid_to, days_left: days, issuer: typeof cert.issuer?.O === "string" ? cert.issuer.O : undefined });
    });
    sock.on("error", (e) => resolve({ error: e.message }));
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ error: "timeout" });
    });
  });
}

export function createVpsConnector(hub: Hub): Connector | undefined {
  const cfg = hub.config.vps;
  if (!cfg) return undefined;
  const ex: Executor = createExecutor(cfg);

  /** Resolve a user path to a real path inside the allowed roots (blocks symlink escapes and secrets). */
  async function safePath(raw: string, mustExist = true): Promise<string> {
    if (!raw.startsWith("/")) throw new HubError("Use an absolute path.", "bad_path");
    const norm = posix.normalize(raw);
    if (!isInsideRoots(norm, cfg!.fileRoots)) throw new HubError(`Path outside allowed roots (${cfg!.fileRoots.join(", ")}).`, "forbidden_path");
    let real: string;
    if (mustExist) real = await ex.realpath(norm);
    else real = posix.join(await ex.realpath(posix.dirname(norm)), posix.basename(norm));
    if (!isInsideRoots(real, cfg!.fileRoots)) throw new HubError("Path resolves outside the allowed roots (symlink).", "forbidden_path");
    if (isSensitivePath(real) || isSensitivePath(norm)) throw new HubError("This file may contain secrets and is blocked.", "forbidden_path");
    return real;
  }

  // Non-root users restart services through a narrow sudoers rule (see docs/DEPLOY.md).
  const isRoot = cfg.mode === "local" ? process.getuid?.() === 0 : cfg.user === "root";
  const sudo = isRoot ? "" : "sudo -n ";

  const unitOk = (u: string) => {
    if (!cfg.services.includes(u)) throw new HubError(`Service "${u}" is not allow-listed. Allowed: ${cfg.services.join(", ")}`, "forbidden");
  };

  const tools: ToolDef[] = [
    tool({
      name: "vps_status",
      title: "VPS health snapshot",
      description: "Uptime, load, memory, disk usage, top processes and state of the allow-listed services on the iranoutdoor.com server.",
      connector: "vps",
      level: "read",
      input: {},
      handler: async () => {
        const svc = cfg.services.map((s) => `printf '%s: ' ${shellQuote(s)}; systemctl is-active ${shellQuote(s)} 2>&1 || true`).join("; ");
        const r = await ex.exec(
          `echo '## uptime'; uptime; echo '## memory'; free -m; echo '## disk'; df -h -x tmpfs -x devtmpfs; echo '## top by memory'; ps aux --sort=-%mem | head -6; echo '## services'; ${svc}`,
          { timeoutMs: 20_000 },
        );
        return r.stdout || fmt(r);
      },
    }),

    tool({
      name: "vps_site_check",
      title: "Check iranoutdoor.com is up",
      description: "HTTP status, response time and TLS certificate expiry for the VPS site (and optionally any other URL on the same host).",
      connector: "vps",
      level: "read",
      input: { path: z.string().optional().describe("Path to request, default /") },
      openWorld: true,
      handler: async (a) => {
        const url = new URL(a.path ?? "/", cfg.siteUrl);
        if (url.host !== new URL(cfg.siteUrl).host) throw new HubError("Only the configured VPS site can be checked.", "forbidden");
        const t0 = Date.now();
        let status: number | undefined;
        let error: string | undefined;
        try {
          const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
          status = res.status;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const tls = url.protocol === "https:" ? await tlsExpiry(url.hostname) : undefined;
        return { url: url.toString(), status, response_ms: Date.now() - t0, error, tls };
      },
    }),

    tool({
      name: "vps_run_readonly",
      title: "Run a read-only diagnostic command",
      description:
        "Run a diagnostic command from a strict allow-list (uptime, df, free, ps, ls, tail, grep, systemctl status, journalctl, docker ps/logs, nginx -t, ss …). " +
        "Pipes between allowed commands are fine; no redirects, chaining or substitution.",
      connector: "vps",
      level: "read",
      input: { command: z.string().describe("e.g. journalctl -u nginx -n 50 --no-pager") },
      handler: async (a) => {
        const v = checkReadOnlyCommand(a.command);
        if (!v.allowed) throw new HubError(`Command rejected: ${v.reason}`, "policy");
        return fmt(await ex.exec(a.command, { timeoutMs: 30_000 }));
      },
    }),

    tool({
      name: "vps_logs",
      title: "Tail a server log",
      description: `Last lines of an allow-listed log file (${cfg.logPaths.join(", ")}), optionally filtered by a fixed string.`,
      connector: "vps",
      level: "read",
      input: {
        path: z.string().describe("Absolute log path from the allow-list"),
        lines: z.number().int().min(1).max(500).optional().describe("How many lines (default 100)"),
        contains: z.string().optional().describe("Only lines containing this text (fixed string)"),
      },
      handler: async (a) => {
        if (!cfg.logPaths.includes(a.path)) throw new HubError(`Log not allow-listed. Allowed: ${cfg.logPaths.join(", ")}`, "forbidden");
        const n = clampInt(a.lines, 1, 500, 100);
        const grep = a.contains ? ` | grep -F -- ${shellQuote(a.contains)}` : "";
        const r = await ex.exec(`tail -n ${n * (a.contains ? 20 : 1)} -- ${shellQuote(a.path)}${grep} | tail -n ${n}`, { timeoutMs: 20_000 });
        return r.stdout || fmt(r);
      },
    }),

    tool({
      name: "vps_service_status",
      title: "Service status",
      description: `Status of an allow-listed service (${cfg.services.join(", ")}).`,
      connector: "vps",
      level: "read",
      input: { unit: z.string().describe("Service name, e.g. nginx") },
      handler: async (a) => {
        unitOk(a.unit);
        return fmt(await ex.exec(`systemctl status ${shellQuote(a.unit)} --no-pager -n 15`, { timeoutMs: 15_000 }));
      },
    }),

    tool({
      name: "vps_service_control",
      title: "Restart/reload a service",
      description: "Restart, reload, start or stop an allow-listed service. Needs confirmation. Restarting nginx/php affects live visitors.",
      connector: "vps",
      level: "write",
      input: {
        unit: z.string().describe("Service name from the allow-list"),
        action: z.enum(["restart", "reload", "start", "stop"]).describe("Action"),
      },
      confirm: true,
      destructive: true,
      preview: (a) => ({ will: `${a.action} ${a.unit} on ${cfg.host ?? "localhost"}`, warning: a.action === "stop" ? "Stopping a service takes it offline." : undefined }),
      handler: async (a) => {
        unitOk(a.unit);
        if (a.action === "restart" || a.action === "reload") {
          const test = a.unit === "nginx" ? await ex.exec(`${sudo}nginx -t 2>&1`, { timeoutMs: 15_000 }) : undefined;
          if (test && test.code !== 0) throw new HubError(`nginx config test failed, not touching the service:\n${test.stdout}${test.stderr}`, "config_invalid");
        }
        const r = await ex.exec(`${sudo}systemctl ${a.action} ${shellQuote(a.unit)} && systemctl is-active ${shellQuote(a.unit)}`, { timeoutMs: 60_000 });
        return fmt(r);
      },
    }),

    tool({
      name: "vps_list_dir",
      title: "List a directory",
      description: `List files in a directory under ${cfg.fileRoots.join(", ")}.`,
      connector: "vps",
      level: "read",
      input: { path: z.string().describe("Absolute directory path") },
      handler: async (a) => {
        const p = await safePath(a.path);
        const entries = await ex.listDir(p);
        return { path: p, entries: entries.sort((x, y) => x.name.localeCompare(y.name)).map((e) => ({ ...e, modified: e.modified ? new Date(e.modified).toISOString() : undefined })) };
      },
    }),

    tool({
      name: "vps_read_file",
      title: "Read a file",
      description: `Read a text file (max 200 KB) under ${cfg.fileRoots.join(", ")}. Secrets files (.env, wp-config.php, keys) are blocked.`,
      connector: "vps",
      level: "read",
      input: { path: z.string().describe("Absolute file path") },
      handler: async (a) => {
        const p = await safePath(a.path);
        const buf = await ex.readFile(p, 200_000);
        if (buf.includes(0)) throw new HubError("File looks binary.", "binary");
        return { path: p, content: truncate(buf.toString("utf8"), 200_000) };
      },
    }),

    tool({
      name: "vps_write_file",
      title: "Write a file (with backup)",
      description: "Create or overwrite a text file under the allowed roots. The old version is copied to <file>.bak-<timestamp> first. Admin only; needs confirmation.",
      connector: "vps",
      level: "admin",
      input: {
        path: z.string().describe("Absolute file path"),
        content: z.string().describe("Full new content"),
      },
      confirm: true,
      destructive: true,
      preview: async (a) => ({ path: a.path, bytes: Buffer.byteLength(a.content), first_lines: a.content.split("\n").slice(0, 8).join("\n"), note: "A timestamped backup of the old file will be kept." }),
      handler: async (a) => {
        if (Buffer.byteLength(a.content) > 1_000_000) throw new HubError("Content larger than 1 MB.", "too_large");
        const p = await safePath(a.path, false);
        const backup = await ex.backup(p, `bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        await ex.writeFile(p, Buffer.from(a.content, "utf8"));
        return { written: p, bytes: Buffer.byteLength(a.content), backup };
      },
    }),

    tool({
      name: "vps_exec",
      title: "Run any shell command (admin)",
      description:
        "Run an arbitrary shell command on the VPS. Owner/admin only, needs confirmation. Catastrophic patterns (rm -rf /, mkfs, shutdown, firewall flush…) are always blocked. Prefer the specific vps_* tools.",
      connector: "vps",
      level: "admin",
      input: {
        command: z.string().describe("Shell command"),
        timeout_seconds: z.number().int().min(1).max(300).optional().describe("Timeout (default 60)"),
      },
      confirm: true,
      destructive: true,
      preview: (a) => ({ command: a.command, host: cfg.host ?? "localhost", user: cfg.user }),
      handler: async (a) => {
        const v = checkAdminCommand(a.command);
        if (!v.allowed) throw new HubError(`Command rejected: ${v.reason}`, "policy");
        return fmt(await ex.exec(a.command, { timeoutMs: (a.timeout_seconds ?? 60) * 1000 }));
      },
    }),
  ];

  return {
    id: "vps",
    title: `VPS ${new URL(cfg.siteUrl).host} (Mihan Web)`,
    summary: "سرور مجازی جدید iranoutdoor.com روی میهن وب‌هاست — وضعیت، لاگ، سرویس‌ها و فایل‌ها",
    tools,
    async health() {
      const r = await ex.exec("uptime -p", { timeoutMs: 12_000 });
      const site = await fetch(cfg.siteUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then((x) => `site HTTP ${x.status}`, (e) => `site error: ${e.message}`);
      const pinned = cfg.mode === "ssh" && !cfg.hostKeySha256 ? " (⚠ SSH host key not pinned)" : "";
      return { ok: r.code === 0 && !site.includes("error"), detail: `${r.stdout.trim()}; ${site}${pinned}` };
    },
    stop() {
      ex.close();
    },
  };
}
