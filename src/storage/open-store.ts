import { resolveDatabasePath } from "../config/paths.js";
import { GatewayDatabase } from "./database.js";
import { CompletionEventStore } from "./event-store.js";

export function openEventStore(env: NodeJS.ProcessEnv = process.env): {
  readonly database: GatewayDatabase;
  readonly store: CompletionEventStore;
} {
  const database = new GatewayDatabase(resolveDatabasePath(env));
  return { database, store: new CompletionEventStore(database) };
}
