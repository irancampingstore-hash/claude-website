import { posix } from "node:path";

/**
 * Command policy shared by the VPS connector and the PC agent.
 * Pure functions so they can be unit-tested without a server.
 */

// Characters that allow chaining, redirection or substitution. Pipes are handled separately.
const FORBIDDEN_CHARS = /[;&><`\n\r\\]|\$\(|\$\{/;

/** Read-only programs (first word of each pipeline segment). */
export const READONLY_COMMANDS = new Set([
  "uptime", "df", "du", "free", "ls", "stat", "wc", "head", "tail", "grep", "egrep", "fgrep", "sort", "uniq", "cut",
  "ps", "top", "whoami", "id", "hostname", "uname", "date", "lsb_release", "ss", "netstat", "ip", "ping", "dig", "nslookup",
  "systemctl", "journalctl", "docker", "nginx", "php", "node", "lsblk", "mount", "cat",
  "find", "which", "file", "ufw", "fail2ban-client", "certbot", "mysqladmin", "wp",
]);

/** Subcommand constraints for programs that can both read and mutate. */
const SUBCOMMAND_RULES: Record<string, (args: string[]) => string | undefined> = {
  systemctl: (a) => (["status", "is-active", "is-enabled", "list-units", "list-timers", "show"].includes(a[0] ?? "") ? undefined : "only systemctl status/is-active/list-units are allowed in read-only mode"),
  docker: (a) => (["ps", "logs", "stats", "images", "inspect", "version", "info", "compose"].includes(a[0] ?? "") && !(a[0] === "compose" && !["ps", "logs"].includes(a[1] ?? "")) ? undefined : "only docker ps/logs/stats/images/inspect are allowed"),
  nginx: (a) => (a.length === 1 && ["-t", "-T", "-v", "-V"].includes(a[0]!) ? undefined : "only nginx -t / -v are allowed"),
  php: (a) => (a.length === 1 && ["-v", "-m", "-i"].includes(a[0]!) ? undefined : "only php -v / -m are allowed"),
  node: (a) => (a.length === 1 && ["-v", "--version"].includes(a[0]!) ? undefined : "only node -v is allowed"),
  ip: (a) => (["a", "addr", "route", "r", "link", "-s"].includes(a[0] ?? "") ? undefined : "only ip addr/route/link are allowed"),
  ufw: (a) => (a[0] === "status" ? undefined : "only ufw status is allowed"),
  "fail2ban-client": (a) => (["status"].includes(a[0] ?? "") ? undefined : "only fail2ban-client status is allowed"),
  certbot: (a) => (a[0] === "certificates" ? undefined : "only certbot certificates is allowed"),
  mysqladmin: (a) => (["status", "ping", "version", "processlist"].includes(a[a.length - 1] ?? "") ? undefined : "only mysqladmin status/ping are allowed"),
  wp: (a) => (["core", "plugin", "theme", "option"].includes(a[0] ?? "") && ["version", "list", "status", "get", "check-update", "verify-checksums"].includes(a[1] ?? "") ? undefined : "only read-only wp-cli queries are allowed"),
  grep: (a) => (a.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive" || x === "--dereference-recursive") ? "recursive grep is not allowed in read-only mode (could expose secrets)" : undefined),
  egrep: (a) => SUBCOMMAND_RULES.grep!(a),
  fgrep: (a) => SUBCOMMAND_RULES.grep!(a),
  find: (a) => (a.some((x) => ["-exec", "-execdir", "-delete", "-ok", "-fprint", "-fls"].includes(x)) ? "find with -exec/-delete is not allowed" : undefined),
  mount: (a) => (a.length === 0 ? undefined : "mount takes no arguments in read-only mode"),
  top: (a) => (a.includes("-b") && a.includes("-n") ? undefined : "use: top -b -n 1"),
  ping: (a) => (a.includes("-c") ? undefined : "use ping -c 3 <host>"),
};

/** Paths that must never be read through the file tools or cat in read-only mode. */
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)wp-config\.php$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /^\/etc\/(shadow|gshadow|sudoers)/,
  /^\/root\/\.ssh/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.(bash_history|mysql_history|netrc|pgpass)$/,
  /^\/proc\/.*\/environ$/,
];

const SENSITIVE_EXTRA = [
  /(^|\/)\.(aws|kube|docker|gnupg|azure)(\/|$)/i,
  /appdata\/.*\/(login data|cookies|local state|web data)$/i,
  /(^|\/)(credentials|secrets?|service[-_]account.*)\.(json|ya?ml|txt|ini)$/i,
  /(^|\/)(id_rsa|known_hosts|authorized_keys)$/i,
  /\.(kdbx|wallet|ovpn)$/i,
];

export function isSensitivePath(path: string): boolean {
  const norm = posix.normalize(path.replace(/\\/g, "/"));
  return SENSITIVE_PATH.some((re) => re.test(norm)) || SENSITIVE_EXTRA.some((re) => re.test(norm));
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/** Validate a read-only diagnostic command (optionally with | pipes between allowed programs). */
export function checkReadOnlyCommand(command: string): PolicyVerdict {
  const cmd = command.trim();
  if (!cmd) return { allowed: false, reason: "empty command" };
  if (cmd.length > 500) return { allowed: false, reason: "command too long" };
  if (FORBIDDEN_CHARS.test(cmd)) return { allowed: false, reason: "chaining, redirection and substitution characters are not allowed (; & > < ` $( \\)" };
  const segments = cmd.split("|").map((s) => s.trim());
  for (const seg of segments) {
    if (!seg) return { allowed: false, reason: "empty pipeline segment" };
    const words = seg.split(/\s+/);
    const prog = words[0]!;
    if (prog.includes("/")) return { allowed: false, reason: `use the bare program name, not a path (${prog})` };
    if (!READONLY_COMMANDS.has(prog)) {
      return { allowed: false, reason: `"${prog}" is not in the read-only allow-list` };
    }
    const rule = SUBCOMMAND_RULES[prog];
    const why = rule?.(words.slice(1));
    if (why) return { allowed: false, reason: why };
    for (const w of words.slice(1)) {
      const clean = w.replace(/^['"]|['"]$/g, "");
      if (clean.startsWith("-")) continue;
      if (isSensitivePath(clean)) return { allowed: false, reason: `access to sensitive path ${clean} is blocked` };
      if (clean.includes("..")) return { allowed: false, reason: "path traversal (..) is not allowed" };
      if (clean.startsWith("~")) return { allowed: false, reason: "~ paths are not allowed" };
    }
  }
  return { allowed: true };
}

/** Patterns that are blocked even for admins (catastrophic / irreversible). */
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\s+(--no-preserve-root\s+)?\/(\s|$|\*)/i, "recursive delete of /"],
  [/\brm\s+.*--no-preserve-root/i, "rm --no-preserve-root"],
  [/\bmkfs(\.\w+)?\b/i, "formatting a filesystem"],
  [/\bdd\b[^|]*\bof=\/dev\/(sd|vd|nvme|xvd|hd)/i, "writing raw data to a disk device"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\b(shutdown|poweroff|halt|init\s+0)\b/i, "powering off the server"],
  [/>\s*\/dev\/(sd|vd|nvme|xvd|hd)/i, "redirecting into a disk device"],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, "chmod 777 /"],
  [/\bchown\s+-R\s+\S+\s+\/(\s|$)/, "recursive chown of /"],
  [/\bcrontab\s+-r\b/, "removing all cron jobs"],
  [/\b(userdel|deluser)\s+(-r\s+)?(root|admin)\b/, "deleting the primary admin user"],
  [/\biptables\s+(-F|--flush)\b.*\n?/, "flushing firewall rules (can lock you out of SSH)"],
  [/\bufw\s+(--force\s+)?(disable|reset)\b/, "disabling/resetting the firewall"],
  [/\bpasswd\s+root\b/, "changing the root password"],
  [/\bformat\s+[a-z]:/i, "formatting a drive"],
  [/\b(del|erase)\b[^\n]*\/[sq][^\n]*\b[a-z]:\\(\s|$)/i, "recursive delete of a drive root"],
  [/\b(rd|rmdir)\b[^\n]*\/s[^\n]*\b[a-z]:\\(\s|$)/i, "recursive delete of a drive root"],
  [/remove-item\b[^\n]*-recurse[^\n]*\b[a-z]:\\(\s|$)/i, "recursive delete of a drive root"],
  [/\bdiskpart\b/i, "diskpart"],
  [/\bshutdown\s+\/[srp]\b/i, "shutting down the computer"],
  [/\breg\s+delete\s+hk(lm|cr)\b/i, "deleting machine registry hives"],
  [/\b(vssadmin|wbadmin)\b[^\n]*delete/i, "deleting backups/shadow copies"],
  [/\bcipher\s+\/w\b/i, "wiping free space"],
  [/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, "piping a download into a shell"],
  [/\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, "piping a download into a shell"],
];

export function checkAdminCommand(command: string): PolicyVerdict {
  const cmd = command.trim();
  if (!cmd) return { allowed: false, reason: "empty command" };
  if (cmd.length > 4000) return { allowed: false, reason: "command too long" };
  for (const [re, why] of CATASTROPHIC) {
    if (re.test(cmd)) return { allowed: false, reason: `blocked: ${why}` };
  }
  return { allowed: true };
}

/** True if `path` is inside one of the `roots` (after normalisation). Callers must also realpath() first. */
export function isInsideRoots(path: string, roots: string[]): boolean {
  const p = posix.normalize(path);
  return roots.some((r) => {
    const root = posix.normalize(r).replace(/\/+$/, "") || "/";
    return p === root || p.startsWith(root === "/" ? "/" : `${root}/`);
  });
}
