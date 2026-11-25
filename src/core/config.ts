import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface WordPressConfig {
  url: string;
  user?: string;
  appPassword?: string;
  wcKey?: string;
  wcSecret?: string;
}

export interface VpsConfig {
  mode: "ssh" | "local";
  host?: string;
  port: number;
  user?: string;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  /** SHA-256 host key fingerprint (hex or base64) — strongly recommended. */
  hostKeySha256?: string;
  siteUrl: string;
  services: string[];
  logPaths: string[];
  /** Directories the file tools may read/write (absolute). */
  fileRoots: string[];
}

export interface InstagramConfig {
  appId?: string;
  appSecret?: string;
  apiVersion: string;
  proxy?: string;
  webhookVerifyToken?: string;
  scopes: string[];
  /** Base URL of the Graph API; override with a reverse-proxy mirror if graph.instagram.com is unreachable. */
  graphBase: string;
  tokenUrl: string;
  /** Programmatic only (tests): skip the public-host check for media URLs. */
  allowPrivateUrls?: boolean;
  /** Instagram bridge (instagrapi sidecar, no Meta developer app needed). */
  bridgeUrl?: string;
  bridgeToken?: string;
  /** Minutes between inbox polls for bridge accounts (0 = off). */
  pollMinutes: number;
}

export interface HubConfig {
  port: number;
  publicUrl: string;
  secret: string;
  dataDir: string;
  trustProxy: boolean;
  wordpress?: WordPressConfig;
  vps?: VpsConfig;
  pc: { agentToken?: string };
  instagram?: InstagramConfig;
  agentsConfigPath: string;
  /** Require two-step confirmation for risky tools. */
  confirmMode: "token" | "off";
  rateLimitPerMinute: number;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadEnvFileIfPresent(path = ".env"): void {
  const p = resolve(path);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore malformed env file; doctor will report missing values */
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number(env.PORT ?? 8787);
  const publicUrl = (env.HUB_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const secret = env.HUB_SECRET ?? "";
  const dataDir = resolve(env.HUB_DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });

  const wpUrl = env.WP_URL?.replace(/\/+$/, "");
  const wordpress: WordPressConfig | undefined = wpUrl
    ? {
        url: wpUrl,
        user: env.WP_USER,
        appPassword: env.WP_APP_PASSWORD,
        wcKey: env.WC_KEY,
        wcSecret: env.WC_SECRET,
      }
    : undefined;

  const vpsMode = (env.VPS_MODE ?? "ssh") as "ssh" | "local";
  const vps: VpsConfig | undefined =
    env.VPS_HOST || vpsMode === "local"
      ? {
          mode: vpsMode,
          host: env.VPS_HOST,
          port: Number(env.VPS_PORT ?? 22),
          user: env.VPS_USER ?? "root",
          privateKeyPath: env.VPS_PRIVATE_KEY_PATH,
          privateKey: env.VPS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          passphrase: env.VPS_KEY_PASSPHRASE,
          password: env.VPS_PASSWORD,
          hostKeySha256: env.VPS_HOST_KEY_SHA256,
          siteUrl: (env.VPS_SITE_URL ?? "https://iranoutdoor.com").replace(/\/+$/, ""),
          services: list(env.VPS_SERVICES ?? "nginx,mysql,php8.2-fpm"),
          logPaths: list(env.VPS_LOG_PATHS ?? "/var/log/nginx/error.log,/var/log/nginx/access.log,/var/log/syslog"),
          fileRoots: list(env.VPS_FILE_ROOTS ?? "/var/www,/etc/nginx,/home"),
        }
      : undefined;

  const instagram: InstagramConfig | undefined =
    env.IG_APP_ID || env.IG_APP_SECRET || env.IG_BRIDGE_URL
      ? {
          appId: env.IG_APP_ID,
          appSecret: env.IG_APP_SECRET,
          apiVersion: env.IG_API_VERSION ?? "v23.0",
          proxy: env.IG_PROXY_URL,
          webhookVerifyToken: env.IG_WEBHOOK_VERIFY_TOKEN,
          graphBase: (env.IG_GRAPH_BASE ?? "https://graph.instagram.com").replace(/\/+$/, ""),
          tokenUrl: env.IG_TOKEN_URL ?? "https://api.instagram.com/oauth/access_token",
          bridgeUrl: env.IG_BRIDGE_URL?.replace(/\/+$/, ""),
          bridgeToken: env.IG_BRIDGE_TOKEN,
          pollMinutes: Number(env.IG_POLL_MINUTES ?? 10),
          scopes: list(
            env.IG_SCOPES ??
              "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_manage_insights",
          ),
        }
      : undefined;

  return {
    port,
    publicUrl,
    secret,
    dataDir,
    trustProxy: env.HUB_TRUST_PROXY === "1" || env.HUB_TRUST_PROXY === "true",
    wordpress,
    vps,
    pc: { agentToken: env.PC_AGENT_TOKEN },
    instagram,
    agentsConfigPath: resolve(env.AGENTS_CONFIG ?? "./agents.json"),
    confirmMode: env.HUB_CONFIRM_MODE === "off" ? "off" : "token",
    rateLimitPerMinute: Number(env.HUB_RATE_LIMIT_PER_MINUTE ?? 120),
  };
}

export function assertSecret(cfg: HubConfig): void {
  if (!cfg.secret || cfg.secret.length < 32) {
    throw new Error(
      "HUB_SECRET must be set to a random string of at least 32 characters (try: node dist/cli.js secret). " +
        "It encrypts stored Instagram tokens and signs confirmation tokens.",
    );
  }
}
