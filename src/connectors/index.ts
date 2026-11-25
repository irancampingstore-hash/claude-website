import type { HubConfig } from "../core/config.js";
import { Hub } from "../core/hub.js";
import { createAgentsConnector } from "./agents.js";
import { createHubConnector } from "./integration.js";
import { createInstagramConnector } from "./instagram.js";
import { createLocalAiConnector, createPcConnector } from "./pc.js";
import { createVpsConnector } from "./vps.js";
import { createWordPressConnector } from "./wordpress.js";

/** Build a hub with every configured connector. Order matters: integration tools go last (they use the others' services). */
export function createHub(config: HubConfig, opts: { db?: Hub["db"] } = {}): Hub {
  const hub = new Hub(config, opts.db);
  hub.register(createWordPressConnector(hub));
  hub.register(createVpsConnector(hub));
  hub.register(createPcConnector(hub));
  hub.register(createLocalAiConnector(hub));
  hub.register(createInstagramConnector(hub));
  hub.register(createAgentsConnector(hub));
  hub.register(createHubConnector(hub));
  return hub;
}
