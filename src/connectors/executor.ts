import { spawn } from "node:child_process";
import { readFile, realpath, writeFile, readdir, stat, copyFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import type { VpsConfig } from "../core/config.js";
import { HubError } from "../util/text.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  modified: number;
}

/** Abstraction so the same VPS tools work over SSH (hub elsewhere) or locally (hub runs on the VPS). */
export interface Executor {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  realpath(path: string): Promise<string>;
  backup(path: string, suffix: string): Promise<string | undefined>;
  close(): void;
}

const MAX_OUTPUT = 200_000;

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ───────────── Local (hub runs on the VPS itself) ───────────── */

export class LocalExecutor implements Executor {
  exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const cap = (cur: string, chunk: Buffer) => {
        if (cur.length + chunk.length > MAX_OUTPUT) {
          truncated = true;
          return cur + chunk.toString("utf8", 0, Math.max(0, MAX_OUTPUT - cur.length));
        }
        return cur + chunk.toString("utf8");
      };
      child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, truncated, timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String(e), truncated, timedOut });
      });
    });
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const { size } = await stat(path);
    if (size > maxBytes) {
      const fh = await (await import("node:fs/promises")).open(path, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        await fh.read(buf, 0, maxBytes, 0);
        return buf;
      } finally {
        await fh.close();
      }
    }
    return readFile(path);
  }
  writeFile(path: string, data: Buffer): Promise<void> {
    return writeFile(path, data);
  }
  async listDir(path: string): Promise<DirEntry[]> {
    const names = await readdir(path, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const d of names.slice(0, 500)) {
      const st = await stat(posix.join(path, d.name)).catch(() => undefined);
      out.push({
        name: d.name,
        type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : d.isFile() ? "file" : "other",
        size: st?.size ?? 0,
        modified: st?.mtimeMs ?? 0,
      });
    }
    return out;
  }
  realpath(path: string): Promise<string> {
    return realpath(path);
  }
  async backup(path: string, suffix: string): Promise<string | undefined> {
    const dest = `${path}.${suffix}`;
    try {
      await copyFile(path, dest);
      return dest;
    } catch {
      return undefined;
    }
  }
  close(): void {}
}

/* ───────────── SSH ───────────── */

export class SshExecutor implements Executor {
  private ready?: Promise<Client>;
  private sftpP?: Promise<SFTPWrapper>;

  constructor(private readonly cfg: VpsConfig) {}

  private connect(): Promise<Client> {
    if (this.ready) return this.ready;
    const { host, port, user, password, passphrase, hostKeySha256 } = this.cfg;
    const privateKey = this.cfg.privateKey ?? (this.cfg.privateKeyPath ? readFileSync(this.cfg.privateKeyPath) : undefined);
    if (!host) throw new HubError("VPS_HOST is not configured.", "not_configured");
    if (!privateKey && !password) throw new HubError("Set VPS_PRIVATE_KEY_PATH (recommended) or VPS_PASSWORD.", "not_configured");

    const pinned = hostKeySha256?.replace(/^SHA256:/i, "").trim();
    this.ready = new Promise<Client>((resolve, reject) => {
      const c = new Client();
      const reset = () => {
        this.ready = undefined;
        this.sftpP = undefined;
      };
      c.on("ready", () => resolve(c));
      c.on("error", (e) => {
        reset();
        reject(new HubError(`SSH connection failed: ${e.message}`, "ssh_error"));
      });
      c.on("close", reset);
      c.on("end", reset);
      c.connect({
        host,
        port,
        username: user,
        privateKey,
        passphrase,
        password,
        readyTimeout: 15_000,
        keepaliveInterval: 20_000,
        hostHash: "sha256",
        hostVerifier: (hash: string) => {
          if (!pinned) return true; // not pinned: accepted (doctor warns about this)
          const hex = Buffer.from(pinned, "base64").toString("hex");
          return hash.toLowerCase() === pinned.toLowerCase() || hash.toLowerCase() === hex;
        },
      });
    });
    return this.ready;
  }

  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpP) return this.sftpP;
    const c = await this.connect();
    this.sftpP = new Promise<SFTPWrapper>((resolve, reject) =>
      c.sftp((err, s) => {
        if (err) {
          this.sftpP = undefined;
          reject(new HubError(`SFTP failed: ${err.message}`, "ssh_error"));
        } else resolve(s);
      }),
    );
    return this.sftpP;
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const c = await this.connect();
    return new Promise<ExecResult>((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(new HubError(`SSH exec failed: ${err.message}`, "ssh_error"));
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        const add = (cur: string, chunk: Buffer) => {
          if (cur.length + chunk.length > MAX_OUTPUT) {
            truncated = true;
            return cur + chunk.toString("utf8", 0, Math.max(0, MAX_OUTPUT - cur.length));
          }
          return cur + chunk.toString("utf8");
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
        }, opts.timeoutMs ?? 30_000);
        stream.on("data", (d: Buffer) => (stdout = add(stdout, d)));
        stream.stderr.on("data", (d: Buffer) => (stderr = add(stderr, d)));
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, truncated, timedOut });
        });
      });
    });
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const s = await this.sftp();
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const rs = s.createReadStream(path, { start: 0, end: maxBytes - 1 });
      rs.on("data", (d: Buffer) => {
        chunks.push(d);
        total += d.length;
      });
      rs.on("error", (e: Error) => reject(new HubError(`Cannot read ${path}: ${e.message}`, "fs_error")));
      rs.on("end", () => resolve(Buffer.concat(chunks, total)));
    });
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      const ws = s.createWriteStream(path, { mode: 0o644 });
      ws.on("error", (e: Error) => reject(new HubError(`Cannot write ${path}: ${e.message}`, "fs_error")));
      ws.on("close", () => resolve());
      ws.end(data);
    });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const s = await this.sftp();
    return new Promise<DirEntry[]>((resolve, reject) =>
      s.readdir(path, (err, list) => {
        if (err) return reject(new HubError(`Cannot list ${path}: ${err.message}`, "fs_error"));
        resolve(
          list.slice(0, 500).map((e) => {
            const mode = e.attrs.mode ?? 0;
            const t = (mode & 0o170000) === 0o040000 ? "dir" : (mode & 0o170000) === 0o120000 ? "link" : (mode & 0o170000) === 0o100000 ? "file" : "other";
            return { name: e.filename, type: t, size: e.attrs.size, modified: e.attrs.mtime * 1000 } as DirEntry;
          }),
        );
      }),
    );
  }

  async realpath(path: string): Promise<string> {
    const s = await this.sftp();
    return new Promise<string>((resolve, reject) =>
      s.realpath(path, (err, p) => (err ? reject(new HubError(`Path not found: ${path}`, "fs_error")) : resolve(p))),
    );
  }

  async backup(path: string, suffix: string): Promise<string | undefined> {
    const dest = `${path}.${suffix}`;
    const r = await this.exec(`cp -p -- ${shellQuote(path)} ${shellQuote(dest)} 2>/dev/null && echo ok`);
    return r.stdout.trim() === "ok" ? dest : undefined;
  }

  close(): void {
    this.ready?.then((c) => c.end()).catch(() => undefined);
    this.ready = undefined;
    this.sftpP = undefined;
  }
}

export function createExecutor(cfg: VpsConfig): Executor {
  return cfg.mode === "local" ? new LocalExecutor() : new SshExecutor(cfg);
}
