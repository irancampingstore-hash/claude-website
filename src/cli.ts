import { randomBytes } from "node:crypto";
import { assertSecret, loadConfig, loadEnvFileIfPresent } from "./core/config.js";
import { createHub } from "./connectors/index.js";
import { CONNECTOR_IDS, type ConnectorId, type Level } from "./core/types.js";
import { ROLE_PRESETS } from "./core/users.js";

const HELP = `
Iran Camping hub — admin CLI

  node dist/cli.js secret                         print a fresh HUB_SECRET / PC_AGENT_TOKEN value
  node dist/cli.js user add --name Ali --role content [--grant vps=read --grant localai=write]
  node dist/cli.js user list
  node dist/cli.js user role <name> <role> [--grant connector=level ...]
  node dist/cli.js user rotate <name>             issue a new access key (old one stops working)
  node dist/cli.js user disable <name> | enable <name> | remove <name>
  node dist/cli.js roles                          show role presets
  node dist/cli.js tools [--user <name>]          list tools (all, or what one user sees)
  node dist/cli.js doctor                         check configuration and connectivity

Roles: ${Object.keys(ROLE_PRESETS).join(", ")}
Connectors: ${CONNECTOR_IDS.join(", ")}    Levels: none, read, write, admin
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function flags(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
}
function parseGrants(list: string[]): Partial<Record<ConnectorId, Level>> {
  const out: Partial<Record<ConnectorId, Level>> = {};
  for (const g of list) {
    const [c, l] = g.split("=");
    if (!CONNECTOR_IDS.includes(c as ConnectorId) || !["none", "read", "write", "admin"].includes(l ?? "")) {
      throw new Error(`Bad --grant "${g}". Use connector=level, e.g. vps=read`);
    }
    out[c as ConnectorId] = l as Level;
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return void console.log(HELP);
  if (cmd === "secret") return void console.log(randomBytes(32).toString("hex"));
  if (cmd === "roles") {
    for (const [r, g] of Object.entries(ROLE_PRESETS)) console.log(`${r.padEnd(8)} ${Object.entries(g).map(([c, l]) => `${c}=${l}`).join("  ")}`);
    return;
  }

  loadEnvFileIfPresent();
  const cfg = loadConfig();
  assertSecret(cfg);
  const hub = createHub(cfg);

  try {
    if (cmd === "user") {
      const args = rest;
      switch (sub) {
        case "add": {
          const name = flag(args, "name");
          const role = flag(args, "role") ?? "content";
          if (!name) throw new Error("--name is required");
          const { user, apiKey } = hub.users.create(name, role, parseGrants(flags(args, "grant")));
          console.log(`Created ${user.name} (${user.role}).`);
          console.log(`\nACCESS KEY (shown once — give it to ${user.name} privately):\n\n  ${apiKey}\n`);
          console.log("Access:", Object.entries(user.grants).map(([c, l]) => `${c}=${l}`).join("  "));
          break;
        }
        case "list":
          for (const u of hub.users.list()) console.log(`${u.disabled ? "✗" : "✓"} ${u.name.padEnd(16)} ${u.role.padEnd(8)} ${Object.entries(u.grants).map(([c, l]) => `${c}=${l}`).join(" ")}`);
          break;
        case "role": {
          const [name, role] = args;
          if (!name || !role) throw new Error("usage: user role <name> <role> [--grant c=l]");
          const g = flags(args, "grant");
          const u = hub.users.setGrants(name, role, g.length ? parseGrants(g) : {});
          console.log(`${u.name} is now ${u.role}:`, Object.entries(u.grants).map(([c, l]) => `${c}=${l}`).join(" "));
          break;
        }
        case "rotate": {
          const { user, apiKey } = hub.users.rotateKey(args[0] ?? "");
          console.log(`New access key for ${user.name} (shown once):\n\n  ${apiKey}\n`);
          break;
        }
        case "disable":
        case "enable":
          hub.users.setDisabled(args[0] ?? "", sub === "disable");
          console.log(`${args[0]} ${sub}d`);
          break;
        case "remove":
          hub.users.remove(args[0] ?? "");
          console.log(`${args[0]} removed`);
          break;
        default:
          console.log(HELP);
      }
    } else if (cmd === "tools") {
      const who = flag([sub ?? "", ...rest], "user") ?? (sub === "--user" ? rest[0] : undefined);
      const user = who ? hub.users.list().find((u) => u.name === who) : undefined;
      const list = user ? hub.toolsFor(user) : hub.allTools();
      for (const t of list) console.log(`${t.name.padEnd(30)} ${t.connector.padEnd(10)} ${t.level.padEnd(6)} ${t.confirm ? "confirm" : ""}`);
      console.log(`\n${list.length} tools`);
    } else if (cmd === "doctor") {
      console.log(`Public URL : ${cfg.publicUrl}${cfg.publicUrl.startsWith("https://") ? "" : "   ⚠ Claude/ChatGPT need HTTPS"}`);
      console.log(`Data dir   : ${cfg.dataDir}`);
      console.log(`Users      : ${hub.users.list().filter((u) => !u.disabled).length} active`);
      console.log(`Confirm    : ${cfg.confirmMode}`);
      const missing: string[] = [];
      if (!cfg.wordpress) missing.push("WP_URL (irancamping.com)");
      if (!cfg.vps) missing.push("VPS_HOST (iranoutdoor.com server)");
      if (!cfg.pc.agentToken) missing.push("PC_AGENT_TOKEN (PC link)");
      if (!cfg.instagram) missing.push("IG_APP_ID / IG_APP_SECRET (Instagram)");
      if (missing.length) console.log(`Not configured: ${missing.join(", ")}`);
      console.log("\nChecking connectors…");
      const health = await hub.health();
      for (const c of hub.connectors) {
        const h = health[c.id];
        console.log(`${h?.ok ? "✓" : "✗"} ${c.id.padEnd(10)} ${h?.detail ?? ""}`);
      }
    } else {
      console.log(HELP);
    }
  } finally {
    await hub.stop().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
