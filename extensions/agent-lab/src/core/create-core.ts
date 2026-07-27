import type { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "./definitions/registry.ts";
import { CoreRepository } from "./storage/repository.ts";
import { EventLog } from "./events/event-log.ts";
import { NamespacedStore } from "./storage/namespaced-store.ts";
import { ControlPlane } from "./control-plane/service.ts";

export interface LabCore {
  definitions: DefinitionRegistry;
  repository: CoreRepository;
  events: EventLog;
  storage: NamespacedStore;
  controlPlane: ControlPlane;
}

export function createLabCore(
  db: DatabaseSync,
  options: { now?: () => number } = {},
): LabCore {
  const definitions = new DefinitionRegistry();
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events, options.now ?? Date.now);
  return { definitions, repository, events, storage, controlPlane };
}
