import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { randomToken } from "./crypto.js";
import { CONNECTOR_IDS, type ConnectorId, type HubUser, type Level } from "./types.js";
import { sha256 } from "../util/text.js";

type Grants = Partial<Record<ConnectorId, Level>>;

/**
 * Role presets. Per-user `grants` override these, so you can e.g. give one marketer VPS read access.
 *  - owner:     everything, including shell on the VPS and PC
 *  - manager:   write on business tools, read-only on infrastructure
 *  - content:   WordPress + Instagram + AI agents (no infrastructure)
 *  - support:   read the store, handle Instagram and agents
 *  - viewer:    read-only on business tools
 */
export const ROLE_PRESETS: Record<string, Grants> = {
  owner: Object.fromEntries(CONNECTOR_IDS.map((c) => [c, "admin"])) as Grants,
  manager: { wordpress: "write", instagram: "write", agents: "write", hub: "write", vps: "read", pc: "read", localai: "write" },
  content: { wordpress: "write", instagram: "write", agents: "write", hub: "write", localai: "read" },
  support: { wordpress: "read", instagram: "write", agents: "write", hub: "write" },
  viewer: { wordpress: "read", instagram: "read", agents: "read", hub: "read" },
};

export function resolveGrants(role: string, overrides: Grants = {}): Grants {
  return { ...(ROLE_PRESETS[role] ?? {}), ...overrides };
}

interface UserRow {
  id: string;
  name: string;
  role: string;
  grants: string;
  disabled: number;
}

function toUser(row: UserRow): HubUser {
  let overrides: Grants = {};
  try {
    overrides = JSON.parse(row.grants) as Grants;
  } catch {
    /* ignore */
  }
  return { id: row.id, name: row.name, role: row.role, grants: resolveGrants(row.role, overrides) };
}

export class UserStore {
  constructor(private readonly db: Db) {}

  /** Creates a user and returns the one-time API key. Only a hash is stored. */
  create(name: string, role: string, overrides: Grants = {}): { user: HubUser; apiKey: string } {
    if (!ROLE_PRESETS[role]) throw new Error(`Unknown role "${role}". Roles: ${Object.keys(ROLE_PRESETS).join(", ")}`);
    const id = randomUUID();
    const apiKey = randomToken("icm");
    this.db.run(
      "INSERT INTO users(id, name, role, grants, api_key_hash, api_key_prefix, created_at) VALUES(?,?,?,?,?,?,?)",
      id,
      name,
      role,
      JSON.stringify(overrides),
      sha256(apiKey),
      apiKey.slice(0, 12),
      Date.now(),
    );
    return { user: { id, name, role, grants: resolveGrants(role, overrides) }, apiKey };
  }

  rotateKey(idOrName: string): { user: HubUser; apiKey: string } {
    const row = this.find(idOrName);
    if (!row) throw new Error(`No such user: ${idOrName}`);
    const apiKey = randomToken("icm");
    this.db.run("UPDATE users SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?", sha256(apiKey), apiKey.slice(0, 12), row.id);
    return { user: toUser(row), apiKey };
  }

  setDisabled(idOrName: string, disabled: boolean): void {
    const row = this.find(idOrName);
    if (!row) throw new Error(`No such user: ${idOrName}`);
    this.db.run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, row.id);
  }

  setGrants(idOrName: string, role: string | undefined, overrides: Grants | undefined): HubUser {
    const row = this.find(idOrName);
    if (!row) throw new Error(`No such user: ${idOrName}`);
    if (role && !ROLE_PRESETS[role]) throw new Error(`Unknown role "${role}"`);
    this.db.run(
      "UPDATE users SET role = ?, grants = ? WHERE id = ?",
      role ?? row.role,
      overrides ? JSON.stringify(overrides) : row.grants,
      row.id,
    );
    return toUser(this.find(row.id)!);
  }

  remove(idOrName: string): void {
    const row = this.find(idOrName);
    if (!row) throw new Error(`No such user: ${idOrName}`);
    this.db.run("DELETE FROM users WHERE id = ?", row.id);
    this.db.run("DELETE FROM oauth_tokens WHERE user_id = ?", row.id);
  }

  list(): Array<HubUser & { disabled: boolean }> {
    return this.db
      .all<UserRow>("SELECT id, name, role, grants, disabled FROM users ORDER BY created_at")
      .map((r) => ({ ...toUser(r), disabled: !!r.disabled }));
  }

  byId(id: string): HubUser | undefined {
    const row = this.db.get<UserRow>("SELECT id, name, role, grants, disabled FROM users WHERE id = ?", id);
    return row && !row.disabled ? toUser(row) : undefined;
  }

  /** Verify an `icm_…` API key. */
  authenticateApiKey(key: string): HubUser | undefined {
    if (!key.startsWith("icm_")) return undefined;
    const row = this.db.get<UserRow>(
      "SELECT id, name, role, grants, disabled FROM users WHERE api_key_hash = ?",
      sha256(key),
    );
    return row && !row.disabled ? toUser(row) : undefined;
  }

  private find(idOrName: string): UserRow | undefined {
    return (
      this.db.get<UserRow>("SELECT id, name, role, grants, disabled FROM users WHERE id = ?", idOrName) ??
      this.db.get<UserRow>("SELECT id, name, role, grants, disabled FROM users WHERE name = ?", idOrName)
    );
  }
}
