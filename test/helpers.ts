import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/connectors/index.js";
import { loadConfig } from "../src/core/config.js";
import { Db } from "../src/core/db.js";

export const TEST_SECRET = "test-secret-test-secret-test-secret-123456";

export function makeHub(env: Record<string, string> = {}, agentsJson?: string) {
  const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
  const agentsPath = join(dir, "agents.json");
  if (agentsJson) {
    writeFileSync(agentsPath, agentsJson);
  }
  const cfg = loadConfig({
    HUB_SECRET: TEST_SECRET,
    HUB_DATA_DIR: dir,
    AGENTS_CONFIG: agentsPath,
    HUB_RATE_LIMIT_PER_MINUTE: "1000",
    ...env,
  } as NodeJS.ProcessEnv);
  const hub = createHub(cfg, { db: new Db(":memory:", TEST_SECRET) });
  return { hub, cfg, dir };
}
